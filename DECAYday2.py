import polars as pl
import psycopg2
from tqdm import tqdm
from dotenv import load_dotenv
import xlsxwriter
import os

load_dotenv()

from db import get_connection, BASE_ASSET

# ── CONFIGURATION ─────────────────────────────────────────
ENTRY_HOUR     = 8      # 13:31 IST = 08:01 UTC
ENTRY_MINUTE   = 1
EXIT_HOUR      = 11      # 17:29 IST = 11:59 UTC
EXIT_MINUTE    = 59
STRIKES        = ["otm6"]
LEG_SL_MULT    = 2.0     # SL: leg premium >= entry_leg_premium * 2.0  (100% loss)
LEG_TGT_MULT   = 0.20    # Target: leg premium <= entry_leg_premium * 0.20 (80% profit)


# ── DATA LOADERS ─────────────────────────────────────────
def load_entry_spots(conn) -> pl.DataFrame:
    """BTC spot price at 13:31 each day."""
    q = f"""
        SELECT
            CAST(datetime AS TIMESTAMP) AS ts,
            open AS spot
        FROM BTC_mark_1m
        WHERE datetime >= '2022-01-01'
        AND datetime < '2027-12-31'
        AND hour(CAST(datetime AS TIMESTAMP)) = {ENTRY_HOUR}
        AND minute(CAST(datetime AS TIMESTAMP)) = {ENTRY_MINUTE}
    """
    df = pl.read_database(q, conn)
    df = df.filter(pl.col("ts").is_not_null())
    
    df = df.with_columns(pl.col("ts").dt.date().alias("date"))
    df = df.sort("ts").group_by("date").agg(pl.all().first())
    df = df.filter(pl.col("ts").dt.weekday() <= 5)
    return df.sort("date")


def load_entry_options(conn) -> pl.DataFrame:
    """Options snapshot at 13:31 across all yearly tables."""
    tables = [f"candles_2022",f"candles_2023",f"candles_2024", f"candles_2025", f"candles_2026"]
    dfs = []
    for table in tables:
        q = f"""
            SELECT ts, symbol, open
            FROM {table}
            WHERE ts >= '2022-01-01'
            AND ts < '2027-12-31'
            AND hour(ts) = {ENTRY_HOUR}
            AND minute(ts) = {ENTRY_MINUTE}
            AND symbol LIKE '%-{BASE_ASSET}-%'
        """
        try:
            dfs.append(pl.read_database(q, conn))
        except Exception as e:
            print(f"  Warning: Could not load from {table}: {e}")

    if not dfs:
        return pl.DataFrame()

    df = pl.concat(dfs)
    df = df.filter(pl.col("ts").is_not_null()).with_columns([
        pl.col("ts").dt.date().alias("date"),
        pl.col("symbol").str.split("-").list.get(0).alias("type"),
        pl.col("symbol").str.split("-").list.get(1).alias("base"),
        pl.col("symbol").str.split("-").list.get(2).cast(pl.Float64).alias("strike"),
        pl.col("symbol").str.split("-").list.get(3).alias("expiry_str"),
    ])

    df = df.sort("ts").group_by(["date", "symbol"]).agg(pl.all().first())

    df = df.with_columns([
        pl.col("expiry_str").str.strptime(pl.Date, "%d%m%y").alias("expiry_date")
    ]).drop(["expiry_str", "base"])

    return df


def get_required_symbols(spots: pl.DataFrame, entry_opts: pl.DataFrame) -> dict:
    """Determine the exact option symbols entered across all strikes and dates."""
    print("Analyzing required option symbols...")
    req_symbols = {y: set() for y in range(2022, 2027)}
    
    for (date,), spot_row in spots.group_by("date"):
        S = spot_row["spot"][0]
        day_opts = entry_opts.filter(pl.col("date") == date)
        if day_opts.is_empty():
            continue
            
        for strike in STRIKES:
            ce = pick_strike(day_opts, S, "C", date, strike)
            pe = pick_strike(day_opts, S, "P", date, strike)
            if not ce.is_empty():
                req_symbols[date.year].add(ce["symbol"][0])
            if not pe.is_empty():
                req_symbols[date.year].add(pe["symbol"][0])
    return req_symbols


def load_intraday_candles_bulk(conn, year: int, symbols: list) -> pl.DataFrame:
    """Load all intraday candles for a list of symbols in a specific year in batches of 500."""
    if not symbols:
        return pl.DataFrame()
        
    print(f"Preloading bulk candles for {year} ({len(symbols)} symbols)...")
    
    # We query in batches of 500 to protect against SQL length limits
    batch_size = 500
    symbols_list = list(symbols)
    dfs = []
    
    table = f"candles_{year}"
    for i in range(0, len(symbols_list), batch_size):
        batch = symbols_list[i:i + batch_size]
        sym_list = ", ".join(f"'{s}'" for s in batch)
        
        q = f"""
            SELECT ts, symbol, open, high
            FROM {table}
            WHERE ts >= '{year}-01-01 00:00:00'
            AND ts <= '{year}-12-31 23:59:00'
            AND hour(ts) >= {ENTRY_HOUR}
            AND hour(ts) <= {EXIT_HOUR}
            AND symbol IN ({sym_list})
        """
        try:
            dfs.append(pl.read_database(q, conn))
        except Exception:
            table_g = f"candles_{year}_with_greeks"
            try:
                q_g = q.replace(f"{table}", f"{table_g}")
                dfs.append(pl.read_database(q_g, conn))
            except Exception as e:
                print(f"  Warning: Could not bulk load batch from {table} or {table_g}: {e}")
                
    if not dfs:
        return pl.DataFrame()
        
    df = pl.concat(dfs)
    df = df.filter(pl.col("ts").is_not_null())
    if df.is_empty():
        return df
    df = df.unique(subset=["ts", "symbol"], keep="first")
    return df.with_columns(pl.col("ts").dt.date().alias("date"))


# ─────────────────────────────────────────
# STRIKE SELECTOR
# ─────────────────────────────────────────
def pick_strike(df: pl.DataFrame, spot: float, option_type: str, trade_date, strike_type: str) -> pl.DataFrame:
    filtered = df.filter(
        (pl.col("type") == option_type) &
        (pl.col("expiry_date") == trade_date)
    )
    if filtered.is_empty():
        return pl.DataFrame()

    nearest_expiry = filtered["expiry_date"].min()
    filtered = filtered.filter(pl.col("expiry_date") == nearest_expiry)

    if strike_type == "atm":
        return filtered.sort((pl.col("strike") - spot).abs(), descending=False).slice(0, 1)

    try:
        rank = int(strike_type[3:])
    except (ValueError, IndexError):
        raise ValueError(f"Invalid strike type: {strike_type}")

    if option_type == "C":
        otm = filtered.filter(pl.col("strike") > spot).sort("strike", descending=False)
    else:
        otm = filtered.filter(pl.col("strike") < spot).sort("strike", descending=True)

    if len(otm) < rank:
        return pl.DataFrame()

    return otm.slice(rank - 1, 1)


def calc_fee(spot: float, leg_premium: float) -> float:
    return min(spot * 0.0001, leg_premium * 0.035)


# ─────────────────────────────────────────
# SL EXIT PRICE RESOLVER
# ─────────────────────────────────────────
def resolve_sl_exit_price(candle_open: float, candle_high: float, sl_level: float) -> float:
    """
    Determine the realistic SL fill price for the triggering leg:
      - Gap open (open >= sl_level): candle opened past SL → fill at open
      - Normal breach (high >= sl_level > open): SL crossed intra-candle → fill at sl_level
    """
    if candle_open >= sl_level:
        return round(candle_open, 6)
    else:
        return round(sl_level, 6)


# ─────────────────────────────────────────
# PER-TRADE SL / TARGET ENGINE
# ─────────────────────────────────────────
def run_sl_logic(
    call_symbol: str,
    put_symbol: str,
    entry_call_premium: float,
    entry_put_premium: float,
    intraday: pl.DataFrame,
    date,
) -> dict:
    """
    SquareOffAllLegs=True: exit ALL legs when ANY leg hits SL or target.

    SL detection uses candle HIGH to catch intra-candle breaches:
      - Triggering leg: fill at sl_level (or open if gapped)
      - Other leg:      fill at its open (squared off at market)

    Target uses candle OPEN only (no intra-candle detection needed,
    since hitting target early is fine to take at open of that bar).
    """
    call_sl_level  = entry_call_premium * LEG_SL_MULT
    call_tgt_level = entry_call_premium * LEG_TGT_MULT
    put_sl_level   = entry_put_premium  * LEG_SL_MULT
    put_tgt_level  = entry_put_premium  * LEG_TGT_MULT

    window = intraday.filter(
        (pl.col("date") == date) &
        (pl.col("symbol").is_in([call_symbol, put_symbol])) &
        (
            (pl.col("ts").dt.hour() > ENTRY_HOUR) |
            ((pl.col("ts").dt.hour() == ENTRY_HOUR) & (pl.col("ts").dt.minute() >= ENTRY_MINUTE))
        ) &
        (
            (pl.col("ts").dt.hour() < EXIT_HOUR) |
            ((pl.col("ts").dt.hour() == EXIT_HOUR) & (pl.col("ts").dt.minute() <= EXIT_MINUTE))
        )
    ).sort("ts")

    no_data_result = {
        "exit_reason":       "no_data",
        "exit_call_premium": entry_call_premium,
        "exit_put_premium":  entry_put_premium,
        "exit_ts":           None,
    }

    if window.is_empty():
        return no_data_result

    # Pivot open and high separately, then join
    open_wide = (
        window.select(["ts", "symbol", "open"])
        .pivot(index="ts", on="symbol", values="open")
        .rename({call_symbol: "call_open", put_symbol: "put_open"})
    )
    high_wide = (
        window.select(["ts", "symbol", "high"])
        .pivot(index="ts", on="symbol", values="high")
        .rename({call_symbol: "call_high", put_symbol: "put_high"})
    )

    wide = open_wide.join(high_wide, on="ts", how="left")

    required = ["call_open", "put_open", "call_high", "put_high"]
    if any(c not in wide.columns for c in required):
        return no_data_result

    wide = wide.drop_nulls()

    for row in wide.iter_rows(named=True):
        call_open = row["call_open"]
        put_open  = row["put_open"]
        call_high = row["call_high"]
        put_high  = row["put_high"]
        curr_ts   = row["ts"]
        is_exit_time = (curr_ts.hour == EXIT_HOUR and curr_ts.minute >= EXIT_MINUTE)

        # Time exit — both legs at their open
        if is_exit_time:
            return {
                "exit_reason":       "time_exit",
                "exit_call_premium": round(call_open, 6),
                "exit_put_premium":  round(put_open, 6),
                "exit_ts":           curr_ts,
            }

        # Call SL — detected via high; triggering leg uses resolved fill, other leg at open
        if call_high is not None and call_high >= call_sl_level:
            return {
                "exit_reason":       "call_sl",
                "exit_call_premium": resolve_sl_exit_price(call_open, call_high, call_sl_level),
                "exit_put_premium":  round(put_open, 6),   # squared off at market
                "exit_ts":           curr_ts,
            }

        # Put SL — same logic
        if put_high is not None and put_high >= put_sl_level:
            return {
                "exit_reason":       "put_sl",
                "exit_call_premium": round(call_open, 6),  # squared off at market
                "exit_put_premium":  resolve_sl_exit_price(put_open, put_high, put_sl_level),
                "exit_ts":           curr_ts,
            }

        # Call target — open is sufficient (taking profit, no urgency about exact fill)
        if call_open <= call_tgt_level:
            return {
                "exit_reason":       "call_target",
                "exit_call_premium": round(call_open, 6),
                "exit_put_premium":  round(put_open, 6),
                "exit_ts":           curr_ts,
            }

        # Put target
        if put_open <= put_tgt_level:
            return {
                "exit_reason":       "put_target",
                "exit_call_premium": round(call_open, 6),
                "exit_put_premium":  round(put_open, 6),
                "exit_ts":           curr_ts,
            }

    # Data gap — use last available bar
    last = wide[-1]
    return {
        "exit_reason":       "time_exit",
        "exit_call_premium": round(last["call_open"][0], 6),
        "exit_put_premium":  round(last["put_open"][0], 6),
        "exit_ts":           last["ts"][0],
    }


# ─────────────────────────────────────────
# BACKTEST
# ─────────────────────────────────────────
def backtest(spots: pl.DataFrame, entry_opts: pl.DataFrame, all_candles: dict, strike_type: str) -> pl.DataFrame:
    results = []

    for (date,), spot_row in tqdm(spots.group_by("date"), desc=f"Backtesting {strike_type.upper()}"):
        try:
            S = spot_row["spot"][0]

            day_opts = entry_opts.filter(pl.col("date") == date)
            if day_opts.is_empty():
                continue

            ce_sell = pick_strike(day_opts, S, "C", date, strike_type)
            pe_sell = pick_strike(day_opts, S, "P", date, strike_type)

            if ce_sell.is_empty() or pe_sell.is_empty():
                continue

            entry_call_premium = ce_sell["open"][0]
            entry_put_premium  = pe_sell["open"][0]
            entry_premium      = entry_call_premium + entry_put_premium

            if entry_premium == 0:
                continue

            # In-memory filter instead of DB load
            year_candles = all_candles.get(date.year)
            if year_candles is None or year_candles.is_empty():
                intraday = pl.DataFrame()
            else:
                intraday = year_candles.filter(
                    (pl.col("date") == date) &
                    (pl.col("symbol").is_in([ce_sell["symbol"][0], pe_sell["symbol"][0]]))
                )

            sl_result = run_sl_logic(
                call_symbol        = ce_sell["symbol"][0],
                put_symbol         = pe_sell["symbol"][0],
                entry_call_premium = entry_call_premium,
                entry_put_premium  = entry_put_premium,
                intraday           = intraday,
                date               = date,
            )

            exit_call    = sl_result["exit_call_premium"]
            exit_put     = sl_result["exit_put_premium"]
            exit_premium = exit_call + exit_put
            gross_pnl    = entry_premium - exit_premium

            fee_call_entry = calc_fee(S, entry_call_premium)
            fee_put_entry  = calc_fee(S, entry_put_premium)
            fee_call_exit  = calc_fee(S, exit_call)
            fee_put_exit   = calc_fee(S, exit_put)
            total_fees     = fee_call_entry + fee_put_entry + fee_call_exit + fee_put_exit
            net_pnl        = gross_pnl - total_fees

            results.append({
                "date":               date,
                "spot":               round(S, 2),
                "call_symbol":        ce_sell["symbol"][0],
                "call_strike":        ce_sell["strike"][0],
                "put_symbol":         pe_sell["symbol"][0],
                "put_strike":         pe_sell["strike"][0],
                "entry_call_premium": round(entry_call_premium, 6),
                "entry_put_premium":  round(entry_put_premium, 6),
                "entry_premium":      round(entry_premium, 6),
                "exit_call_premium":  round(exit_call, 6),
                "exit_put_premium":   round(exit_put, 6),
                "exit_premium":       round(exit_premium, 6),
                "exit_reason":        sl_result["exit_reason"],
                "exit_ts":            sl_result["exit_ts"],
                "gross_pnl":          round(gross_pnl, 6),
                "total_fees":         round(total_fees, 6),
                "pnl":                round(net_pnl, 6),
            })

        except Exception as e:
            print(f"Error on {date}: {e}")
            continue

    return pl.DataFrame(results).sort("date")


# ─────────────────────────────────────────
# SUMMARY + EXPORT
# ─────────────────────────────────────────
def summarise(res: pl.DataFrame, strike_type: str):
    if res.is_empty():
        return res
        
    res = res.with_columns([
        pl.col("pnl").cum_sum().alias("cum_pnl"),
        pl.col("pnl").cum_sum().cum_max().alias("cum_max")
    ])
    
    res = res.with_columns(
        (pl.col("cum_pnl") - pl.col("cum_max")).alias("drawdown")
    )
    
    underwater = (res["cum_pnl"] < res["cum_max"]).to_list()
    dd_durations = []
    curr_dur = 0
    for is_under in underwater:
        if is_under:
            curr_dur += 1
        else:
            curr_dur = 0
        dd_durations.append(curr_dur)
    
    res = res.with_columns(pl.Series("dd_duration", dd_durations))
    
    total  = len(res)
    wins   = res.filter(pl.col("pnl") > 0)
    losses = res.filter(pl.col("pnl") <= 0)
    max_dd = res["drawdown"].min()
    max_dd_duration = res["dd_duration"].max()

    print("\n" + "=" * 60)
    print(f"  SHORT STRANGLE BACKTEST RESULTS  ({strike_type.upper()})")
    print("  Entry: 08:01 UTC | Exit: 11:59 UTC | SquareOffAllLegs=True")
    print("=" * 60)
    print(f"  Total trades        : {total}")
    print(f"  Win Rate            : {len(wins)/total*100:6.1f}%  ({len(wins)} trades)")
    print(f"  Loss Rate           : {len(losses)/total*100:6.1f}%  ({len(losses)} trades)")
    print("-" * 60)
    print(f"  Avg Net PnL         : {res['pnl'].mean():10.6f}")
    print(f"  Max Profit          : {res['pnl'].max():10.6f}")
    print(f"  Max Loss            : {res['pnl'].min():10.6f}")
    print("-" * 60)
    print(f"  Total Net PnL       : {res['pnl'].sum():10.6f}")
    print(f"  Max Drawdown        : {max_dd:10.6f}")
    print(f"  Max DD Duration     : {max_dd_duration:4} days")
    print(f"  Avg Fees per trade  : {res['total_fees'].mean():10.6f}")
    print(f"  Total Fees Paid     : {res['total_fees'].sum():10.6f}")
    print("\n  Exit breakdown:")
    print(res.group_by("exit_reason").agg(pl.len().alias("count")))
    print("=" * 50)
    print(res.select(["date", "spot", "entry_premium", "exit_premium", "gross_pnl", "total_fees", "pnl", "cum_pnl"]))
    return res


def cleanup():
    # Clean up xlsx and old default csvs
    for f in ["backtest_results2_4.xlsx", "backtest_results.csv", "monthly_pnl.csv"]:
        if os.path.exists(f):
            os.remove(f)
    # Clean up strike-specific csvs
    for strike in STRIKES:
        for f in [f"backtest_results_{strike}.csv", f"monthly_pnl_{strike}.csv"]:
            if os.path.exists(f):
                os.remove(f)
    print("🧹 Cleaned up old output files.")


def export_all(all_results: dict):
    # 1. Create the side-by-side Summary DataFrame
    metrics = [
        "Total Trades", "Win Rate %", "Loss Rate %",
        "Total Net PnL", "Avg Net PnL",
        "Max Profit", "Max Loss", "Max Drawdown",
        "Max DD Duration (Days)"
    ]
    summary_dict = {"Metric": metrics}

    for strike in STRIKES:
        if strike in all_results:
            res = all_results[strike]["trades"]
            total = len(res)
            if total == 0:
                summary_dict[strike.upper()] = ["0", "0.00%", "0.00%", "0.000000", "0.000000", "0.000000", "0.000000", "0.000000", "0"]
                continue
            win_rate = len(res.filter(pl.col("pnl") > 0)) / total
            drawdown = res["cum_pnl"] - res["cum_max"]
            underwater = (res["cum_pnl"] < res["cum_max"]).to_list()
            max_dd_duration = 0
            curr_dd = 0
            for is_under in underwater:
                if is_under:
                    curr_dd += 1
                    max_dd_duration = max(max_dd_duration, curr_dd)
                else:
                    curr_dd = 0

            summary_dict[strike.upper()] = [
                str(total),
                f"{win_rate*100:.2f}%",
                f"{(1-win_rate)*100:.2f}%",
                f"{res['pnl'].sum():.6f}",
                f"{res['pnl'].mean():.6f}",
                f"{res['pnl'].max():.6f}",
                f"{res['pnl'].min():.6f}",
                f"{drawdown.min():.6f}",
                str(max_dd_duration)
            ]

    summary_df = pl.DataFrame(summary_dict)

    # 2. Write to the combined Excel file
    excel_path = "backtest_results2_4.xlsx"
    wb = xlsxwriter.Workbook(excel_path)
    
    # Write summary sheet first
    summary_df.write_excel(workbook=wb, worksheet="Summary")
    
    # Write individual sheets for each strike
    for strike in STRIKES:
        if strike in all_results:
            trades_df = all_results[strike]["trades"]
            monthly_df = all_results[strike]["monthly"]
            # Sheets are named like Trades_atm, Monthly_atm
            trades_df.write_excel(workbook=wb, worksheet=f"Trades_{strike}")
            monthly_df.write_excel(workbook=wb, worksheet=f"Monthly_{strike}")
            
    wb.close()
    print(f"\n✅ Saved combined Excel file: {excel_path}")


# ─────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────
if __name__ == "__main__":
    cleanup()
    print("Connecting to QuestDB...")
    conn = get_connection()

    print("Loading data...")
    spots = load_entry_spots(conn)
    entry = load_entry_options(conn)

    print(f"  Spots:    {len(spots)} days")
    print(f"  Entry:    {len(entry)} option rows at 13:31")

    # Bulk Preload Option Candles
    req_symbols = get_required_symbols(spots, entry)
    
    all_candles = {}
    for year in sorted(req_symbols.keys()):
        all_candles[year] = load_intraday_candles_bulk(conn, year, req_symbols[year])
        
    conn.close()
    print("Closed database connection. Starting backtests in memory...")

    all_results = {}
    for strike in STRIKES:
        print(f"\nRunning backtest for strike: {strike.upper()}")
        res = backtest(spots, entry, all_candles, strike)
        if res.is_empty():
            print(f"❌ No trades generated for strike: {strike.upper()}")
        else:
            res_summary = summarise(res, strike)
            # Write CSV files for each strike
            res_summary.write_csv(f"backtest_results_{strike}.csv")
            
            monthly = (
                res_summary.with_columns(pl.col("date").dt.strftime("%Y-%m").alias("month"))
                   .group_by("month")
                   .agg(pl.col("pnl").sum().alias("monthly_pnl"))
                   .sort("month")
            )
            monthly.write_csv(f"monthly_pnl_{strike}.csv")
            
            all_results[strike] = {
                "trades": res_summary,
                "monthly": monthly
            }

    if not all_results:
        print("❌ No trades generated for any strike.")
    else:
        export_all(all_results)