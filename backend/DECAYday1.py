import polars as pl
import psycopg2
from tqdm import tqdm
from dotenv import load_dotenv
import xlsxwriter
import os

load_dotenv()

from db import get_connection, BASE_ASSET

# ── CONFIGURATION ─────────────────────────────────────────
ENTRY_HOUR         = 3        # 08:31 IST = 03:01 UTC
ENTRY_MINUTE       = 1
EXIT_HOUR          = 6        # 12:29 IST = 06:59 UTC
EXIT_MINUTE        = 59
STRIKES            = ["otm6"]
LEG_SL_MULT        = 1.40     # SL: leg premium >= entry_leg_premium * 1.40  (40% loss)
UNDERLYING_TGT_PCT = 0.0075   # Target: spot moves 0.75% favorably for that leg
                               #   Short call target: spot <= entry_spot * (1 - 0.0075)
                               #   Short put  target: spot >= entry_spot * (1 + 0.0075)


# ── DATA LOADERS ─────────────────────────────────────────
def load_entry_spots(conn) -> pl.DataFrame:
    """BTC spot price at 03:01 UTC (08:31 IST) each day."""
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
    """Options snapshot at 03:01 UTC across all yearly tables."""
    tables = [f"candles_2022",f"candles_2023", f"candles_2024", f"candles_2025", f"candles_2026"]
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


def load_all_intraday_spots(conn) -> pl.DataFrame:
    """Load all BTC spot prices between 03:01 and 06:59 UTC for the entire period."""
    print("Preloading all intraday spot prices...")
    q = f"""
        SELECT
            CAST(datetime AS TIMESTAMP) AS ts,
            open AS spot
        FROM BTC_mark_1m
        WHERE datetime >= '2022-01-01'
        AND datetime < '2027-12-31'
        AND hour(CAST(datetime AS TIMESTAMP)) >= {ENTRY_HOUR}
        AND hour(CAST(datetime AS TIMESTAMP)) <= {EXIT_HOUR}
    """
    df = pl.read_database(q, conn)
    df = df.filter(pl.col("ts").is_not_null())
    if df.is_empty():
        return df
    df = df.unique(subset=["ts"], keep="first")
    return df.with_columns(pl.col("ts").dt.date().alias("date"))


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
            SELECT ts, symbol, open, high, low
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


# ─────────────────────────────────────────
# FEE CALCULATOR
# ─────────────────────────────────────────
def calc_fee(spot: float, leg_premium: float) -> float:
    return min(spot * 0.0001, leg_premium * 0.035)


# ─────────────────────────────────────────
# SL EXIT PRICE RESOLVER
# ─────────────────────────────────────────
def resolve_sl_exit_price(candle_open: float, candle_high: float, sl_level: float) -> float:
    """
    Determine the realistic SL fill price for a short option leg:

      - Gap open (open >= sl_level): candle opened already past SL → exit at open
        (worst case, no better fill was available)
      - Normal breach (high >= sl_level > open): SL level was crossed within the
        candle → exit at sl_level (limit/stop order would have filled there)
    
    The caller should only call this when candle_high >= sl_level.
    """
    if candle_open >= sl_level:
        return round(candle_open, 6)   # gap: fill at open
    else:
        return round(sl_level, 6)      # intra-candle breach: fill at SL level


# ─────────────────────────────────────────
# DEBUG HELPER
# ─────────────────────────────────────────
def load_intraday_for_day(conn, date, call_symbol: str, put_symbol: str) -> pl.DataFrame:
    """Options minute bars (open, high, low) for the 2 leg symbols between 03:01 and 06:59 UTC."""
    table = f"candles_{date.year}"
    q = f"""
        SELECT ts, symbol, open, high, low
        FROM {table}
        WHERE ts >= '{date} 03:01:00'
        AND ts <= '{date} 06:59:00'
        AND symbol IN ('{call_symbol}', '{put_symbol}')
    """
    try:
        df = pl.read_database(q, conn)
    except Exception:
        table_g = f"candles_{date.year}_with_greeks"
        try:
            q_g = q.replace(f"{table}", f"{table_g}")
            df = pl.read_database(q_g, conn)
        except Exception:
            return pl.DataFrame()

    df = df.filter(pl.col("ts").is_not_null())
    if df.is_empty():
        return df
    df = df.unique(subset=["ts", "symbol"], keep="first")
    return df.with_columns(pl.col("ts").dt.date().alias("date"))


def debug_trade(conn, date_str: str, call_symbol: str, put_symbol: str,
                entry_call_premium: float, entry_put_premium: float):
    """
    Print minute-by-minute candle data for a specific trade date to diagnose
    unexpected SL exits. Usage: call this from __main__ before running backtest.

    Example:
        debug_trade(conn, "2022-06-17",
                    "C-BTC-21000-170622", "P-BTC-20100-170622",
                    160.0, 185.0)
    """
    import datetime
    date = datetime.date.fromisoformat(date_str)
    df = load_intraday_for_day(conn, date, call_symbol, put_symbol)
    if df.is_empty():
        print("No intraday data found.")
        return

    call_sl = round(entry_call_premium * LEG_SL_MULT, 4)
    put_sl  = round(entry_put_premium  * LEG_SL_MULT, 4)

    print(f"\n{'='*75}")
    print(f"  DEBUG: {date_str}  |  Call SL={call_sl}  Put SL={put_sl}")
    print(f"{'='*75}")
    print(f"  {'ts':<25} {'sym':<25} {'open':>10} {'high':>10} {'low':>10}  flags")
    print(f"  {'-'*25} {'-'*25} {'-'*10} {'-'*10} {'-'*10}  -----")

    for row in df.sort("ts").iter_rows(named=True):
        sym   = row["symbol"]
        o, h, l = row["open"], row["high"], row["low"]
        sl    = call_sl if sym.startswith("C-") else put_sl
        flags = []
        if o >= sl:  flags.append("GAP_PAST_SL")
        elif h >= sl: flags.append("HIT_SL_INTRACANDLE")
        print(f"  {str(row['ts']):<25} {sym:<25} {o:>10.2f} {h:>10.2f} {l:>10.2f}  {', '.join(flags)}")

    print(f"{'='*75}\n")


# ─────────────────────────────────────────
# PER-TRADE SL / TARGET ENGINE
# ─────────────────────────────────────────
def run_sl_logic(
    call_symbol: str,
    put_symbol: str,
    entry_call_premium: float,
    entry_put_premium: float,
    call_strike: float,
    put_strike: float,
    entry_spot: float,
    intraday: pl.DataFrame,
    intraday_spot: pl.DataFrame,
    date,
) -> dict:
    """
    SL detection uses candle HIGH (not just open) to catch intra-candle breaches:
      - If high >= sl_level and open < sl_level → filled at sl_level (order was resting there)
      - If open >= sl_level                     → gap open, filled at open

    Target: exit leg when underlying moves 0.75% favorably (uses spot open).
    Time exit: 06:59 UTC.
    """
    call_sl_level = entry_call_premium * LEG_SL_MULT
    put_sl_level  = entry_put_premium  * LEG_SL_MULT

    call_tgt_spot = entry_spot * (1 - UNDERLYING_TGT_PCT)
    put_tgt_spot  = entry_spot * (1 + UNDERLYING_TGT_PCT)

    # ── Build options wide frame (open + high for each leg) ──
    window = intraday.filter(
        (pl.col("date") == date) &
        (pl.col("symbol").is_in([call_symbol, put_symbol]))
    ).sort("ts")

    no_data_result = {
        "exit_call_premium": entry_call_premium,
        "exit_call_reason":  "no_data",
        "exit_call_ts":      None,
        "exit_put_premium":  entry_put_premium,
        "exit_put_reason":   "no_data",
        "exit_put_ts":       None,
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

    # ── Join intraday spot ──
    spot_df = intraday_spot.filter(pl.col("date") == date).select(["ts", "spot"])
    wide = wide.join(spot_df, on="ts", how="left")
    wide = wide.with_columns(
        pl.col("spot").forward_fill().backward_fill()
    ).drop_nulls(subset=["call_open", "put_open"])

    # ── Walk minute by minute ──
    call_exit: tuple | None = None
    put_exit:  tuple | None = None

    for row in wide.iter_rows(named=True):
        curr_ts      = row["ts"]
        curr_spot    = row.get("spot") or entry_spot
        is_exit_time = (curr_ts.hour == EXIT_HOUR and curr_ts.minute >= EXIT_MINUTE)

        # ── CALL LEG ──
        if call_exit is None:
            call_open = row.get("call_open")
            call_high = row.get("call_high")
            if call_open is not None:
                if is_exit_time:
                    call_exit = ("time_exit", round(call_open, 6), curr_ts)
                elif call_high is not None and call_high >= call_sl_level:
                    # SL breached within or at open of this candle
                    fill = resolve_sl_exit_price(call_open, call_high, call_sl_level)
                    call_exit = ("call_sl", fill, curr_ts)
                elif curr_spot <= call_tgt_spot:
                    call_exit = ("call_target", round(call_open, 6), curr_ts)

        # ── PUT LEG ──
        if put_exit is None:
            put_open = row.get("put_open")
            put_high = row.get("put_high")
            if put_open is not None:
                if is_exit_time:
                    put_exit = ("time_exit", round(put_open, 6), curr_ts)
                elif put_high is not None and put_high >= put_sl_level:
                    fill = resolve_sl_exit_price(put_open, put_high, put_sl_level)
                    put_exit = ("put_sl", fill, curr_ts)
                elif curr_spot >= put_tgt_spot:
                    put_exit = ("put_target", round(put_open, 6), curr_ts)

        if call_exit and put_exit:
            break

    # Fill any leg still open with last available bar
    last = wide[-1]
    if call_exit is None:
        call_exit = ("time_exit", round(last["call_open"][0], 6), last["ts"][0])
    if put_exit is None:
        put_exit  = ("time_exit", round(last["put_open"][0],  6), last["ts"][0])

    return {
        "exit_call_reason":  call_exit[0],
        "exit_call_premium": call_exit[1],
        "exit_call_ts":      call_exit[2],
        "exit_put_reason":   put_exit[0],
        "exit_put_premium":  put_exit[1],
        "exit_put_ts":       put_exit[2],
    }


# ─────────────────────────────────────────
# BACKTEST
# ─────────────────────────────────────────
def backtest(spots: pl.DataFrame, entry_opts: pl.DataFrame, all_spots: pl.DataFrame, all_candles: dict, strike_type: str) -> pl.DataFrame:
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
            
            if all_spots.is_empty():
                intraday_spot = pl.DataFrame()
            else:
                intraday_spot = all_spots.filter(pl.col("date") == date)

            sl_result = run_sl_logic(
                call_symbol        = ce_sell["symbol"][0],
                put_symbol         = pe_sell["symbol"][0],
                entry_call_premium = entry_call_premium,
                entry_put_premium  = entry_put_premium,
                call_strike        = ce_sell["strike"][0],
                put_strike         = pe_sell["strike"][0],
                entry_spot         = S,
                intraday           = intraday,
                intraday_spot      = intraday_spot,
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
                "exit_call_reason":   sl_result["exit_call_reason"],
                "exit_call_ts":       sl_result["exit_call_ts"],
                "exit_put_premium":   round(exit_put, 6),
                "exit_put_reason":    sl_result["exit_put_reason"],
                "exit_put_ts":        sl_result["exit_put_ts"],
                "exit_premium":       round(exit_premium, 6),
                "gross_pnl":          round(gross_pnl, 6),
                "total_fees":         round(total_fees, 6),
                "pnl":                round(net_pnl, 6),
            })

        except Exception as e:
            print(f"Error on {date}: {e}")
            continue

    if not results:
        print("⚠️  No trades generated — check entry time/date filters match your data.")
        return pl.DataFrame()

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
    print(f"  DECAY ITM1 DAY1 — SHORT STRANGLE BACKTEST RESULTS ({strike_type.upper()})")
    print(f"  Entry: 03:01 UTC | Exit: 06:59 UTC | {strike_type.upper()} | Indep. Legs")
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

    print("\n  Call exit breakdown:")
    print(res.group_by("exit_call_reason").agg(pl.len().alias("count")).sort("count", descending=True))
    print("\n  Put exit breakdown:")
    print(res.group_by("exit_put_reason").agg(pl.len().alias("count")).sort("count", descending=True))

    print("=" * 55)
    print(res.select([
        "date", "spot", "entry_premium", "exit_premium",
        "exit_call_reason", "exit_put_reason",
        "gross_pnl", "total_fees", "pnl", "cum_pnl"
    ]))
    return res


def cleanup():
    # Clean up xlsx and old default csvs
    for f in ["backtest_results_day1.xlsx", "backtest_results_day1.csv", "monthly_pnl_day1.csv"]:
        if os.path.exists(f):
            os.remove(f)
    # Clean up strike-specific csvs
    for strike in STRIKES:
        for f in [f"backtest_results_day1_{strike}.csv", f"monthly_pnl_day1_{strike}.csv"]:
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
    excel_path = "backtest_results_day1.xlsx"
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
    print(f"  Entry:    {len(entry)} option rows at 03:01 UTC")

    # Bulk Preload Data
    all_spots = load_all_intraday_spots(conn)
    req_symbols = get_required_symbols(spots, entry)
    
    all_candles = {}
    for year in sorted(req_symbols.keys()):
        all_candles[year] = load_intraday_candles_bulk(conn, year, req_symbols[year])
        
    conn.close()
    print("Closed database connection. Starting backtests in memory...")

    all_results = {}
    for strike in STRIKES:
        print(f"\nRunning backtest for strike: {strike.upper()}")
        res = backtest(spots, entry, all_spots, all_candles, strike)
        if res.is_empty():
            print(f"❌ No trades generated for strike: {strike.upper()}")
        else:
            res_summary = summarise(res, strike)
            # Write CSV files for each strike
            res_summary.write_csv(f"backtest_results_day1_{strike}.csv")
            
            monthly = (
                res_summary.with_columns(pl.col("date").dt.strftime("%Y-%m").alias("month"))
                   .group_by("month")
                   .agg(pl.col("pnl").sum().alias("monthly_pnl"))
                   .sort("month")
            )
            monthly.write_csv(f"monthly_pnl_day1_{strike}.csv")
            
            all_results[strike] = {
                "trades": res_summary,
                "monthly": monthly
            }

    if not all_results:
        print("❌ No trades generated for any strike.")
    else:
        export_all(all_results)