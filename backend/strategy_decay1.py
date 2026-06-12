import datetime
import time
import threading
import os
from typing import Dict, Any, List, Optional
from supabase import create_client, Client
from delta_client import DeltaClient
import config

def safe_float(val: Any, default: float = 0.0) -> float:
    """
    Safely converts a value to float, defaulting to a fallback value if conversion fails or if input is None.
    """
    if val is None:
        return default
    try:
        return float(val)
    except (ValueError, TypeError):
        return default

def get_contract_multiplier(symbol: str) -> float:
    """
    Returns the contract size multiplier for a Delta option symbol.
    For BTC options: 0.001
    For ETH options: 0.01
    Default: 1.0
    """
    parts = symbol.split('-')
    if len(parts) >= 2:
        underlying = parts[1].upper()
        if underlying == 'BTC':
            return 0.001
        elif underlying == 'ETH':
            return 0.01
    return 1.0

def parse_options_chain(tickers: List[Dict[str, Any]], underlying: str = 'BTC') -> List[Dict[str, Any]]:
    """
    Parses public tickers to extract structured option contract details.
    """
    parsed = []
    for t in tickers:
        symbol = t.get('symbol', '')
        # Symbology pattern: C-BTC-90000-310125 or P-BTC-90000-310125
        parts = symbol.split('-')
        if len(parts) == 4 and parts[1] == underlying:
            opt_type = parts[0] # 'C' or 'P'
            if opt_type not in ['C', 'P']:
                continue
                
            try:
                strike = safe_float(parts[2])
                expiry_str = parts[3] # 'ddMMYY'
                # Parse expiry date
                expiry_date = datetime.datetime.strptime(expiry_str, "%d%m%y").date()
            except (ValueError, IndexError):
                continue
                
            parsed.append({
                'symbol': symbol,
                'product_id': int(t.get('product_id')),
                'type': opt_type,
                'strike': strike,
                'expiry_date': expiry_date,
                'spot_price': safe_float(t.get('spot_price', 0.0)),
                'mark_price': safe_float(t.get('mark_price', 0.0)),
                'best_ask': safe_float(t.get('quotes', {}).get('best_ask', 0.0)),
                'best_bid': safe_float(t.get('quotes', {}).get('best_bid', 0.0))
            })
    return parsed

def select_strangle_strikes(parsed_options: List[Dict[str, Any]], spot: float, strike_selection: str = 'otm6') -> Dict[str, Optional[Dict[str, Any]]]:
    """
    Selects the specific option contracts based on strike selection logic (e.g. OTM6) anchored to the ATM strike.
    """
    if not parsed_options:
        return {'C': None, 'P': None}
        
    # Find nearest expiry date (today's expiry)
    nearest_expiry = min(opt['expiry_date'] for opt in parsed_options)
    today_options = [opt for opt in parsed_options if opt['expiry_date'] == nearest_expiry]
    
    # Parse rank (e.g. 'otm6' -> 6)
    try:
        rank = int(strike_selection[3:])
    except (ValueError, IndexError):
        rank = 6 # fallback to OTM6
        
    # Separate Calls and Puts
    calls = [opt for opt in today_options if opt['type'] == 'C']
    puts = [opt for opt in today_options if opt['type'] == 'P']
    
    # Extract unique strikes to find the ATM strike
    all_strikes = list(set(opt['strike'] for opt in today_options))
    if not all_strikes:
        return {'C': None, 'P': None}
        
    # ATM strike is the one closest to spot
    atm_strike = min(all_strikes, key=lambda x: abs(x - spot))
    
    # Filter OTM strikes anchored to the ATM strike
    # Calls: strike > atm_strike, sorted ascending (further out)
    otm_calls = sorted([c for c in calls if c['strike'] > atm_strike], key=lambda x: x['strike'])
    # Puts: strike < atm_strike, sorted descending (further out)
    otm_puts = sorted([p for p in puts if p['strike'] < atm_strike], key=lambda x: x['strike'], reverse=True)
    
    selected_call = otm_calls[rank - 1] if len(otm_calls) >= rank else None
    selected_put = otm_puts[rank - 1] if len(otm_puts) >= rank else None
    
    return {
        'C': selected_call,
        'P': selected_put
    }


def supabase_retry(query_func, retries=3, delay=2):
    """
    Executes a Supabase query function and automatically retries if a network timeout
    or connection disconnect (e.g. RemoteProtocolError) occurs.
    """
    import time
    for i in range(retries):
        try:
            return query_func()
        except Exception as e:
            err_str = str(e)
            if "Server disconnected" in err_str or "RemoteProtocolError" in err_str or "timeout" in err_str.lower() or i == retries - 1:
                if i < retries - 1:
                    print(f"Notice: Supabase query failed ({e}). Retrying in {delay}s...")
                    time.sleep(delay)
                    continue
            raise e

def log_trade_event(supabase: Client, account_name: str, message: str, level: str = 'INFO', strategy_name: str = 'decay1'):
    """
    Pushes a real-time event log to the Supabase database.
    """
    try:
        supabase_retry(lambda: supabase.table('trade_logs').insert({
            'account_name': account_name,
            'strategy_name': strategy_name,
            'message': message,
            'log_level': level
        }).execute())
        print(f"[{level}] {account_name} ({strategy_name}): {message}")
    except Exception as e:
        print(f"Failed to write log to database: {e}")


def execute_decay1_entry(supabase: Client):
    """
    Main entry execution logic for Decay1. Called at 08:31 IST.
    """
    # 1. Fetch active accounts from Supabase
    accounts_res = supabase_retry(lambda: supabase.table('accounts').select('*').eq('is_active', True).execute())
    accounts = accounts_res.data
    
    if not accounts:
        print("No active trading accounts found in Supabase.")
        return
        
    # Fetch Decay1 strategy specs
    strategy_res = supabase_retry(lambda: supabase.table('strategies').select('*').eq('name', 'decay1').execute())
    strategy = strategy_res.data[0] if strategy_res.data else None
    
    if not strategy or not strategy.get('is_active'):
        print("Decay1 strategy is not active or not configured.")
        return
        
    underlying = strategy.get('underlying', 'BTC')
    strike_selection = strategy.get('strike_selection', 'otm6')
    sl_multiplier = safe_float(strategy.get('sl_multiplier'), 1.40)
    tgt_pct = safe_float(strategy.get('underlying_target_pct'), 0.0075)
    
    # 2. Query option tickers to choose contracts (using first client connection details)
    # Public calls don't require account authentication, so we use any environment details
    sample_key = accounts[0]['api_key']
    sample_secret = accounts[0]['api_secret']
    sample_env = accounts[0]['env']
    if sample_env == 'paper':
        sample_env = 'production'
    
    ticker_client = DeltaClient(sample_key, sample_secret, sample_env)
    try:
        tickers = ticker_client.get_tickers(contract_types='call_options,put_options', underlying=underlying)
    except Exception as e:
        print(f"Failed to fetch market data: {e}")
        return
        
    parsed = parse_options_chain(tickers, underlying)
    if not parsed:
        print("No active option contracts parsed.")
        return
        
    # Get BTC Futures price (mark price of BTCUSD perpetual)
    futures_symbol = f"{underlying}USD"
    spot = ticker_client.get_futures_price(futures_symbol)
    if spot <= 0:
        # Fallback to spot_price from options ticker if futures fetch fails
        spot = parsed[0]['spot_price']
        print(f"Warning: Futures price unavailable, falling back to spot_price: {spot}")
    print(f"Using futures price for {futures_symbol}: {spot}")
    
    # Pick Strangle contracts
    contracts = select_strangle_strikes(parsed, spot, strike_selection)
    call_contract = contracts['C']
    put_contract = contracts['P']
    
    if not call_contract or not put_contract:
        print("Failed to resolve OTM Call or Put contract.")
        return
        
    print(f"Spot: {spot} | Selected Strangle -> Call: {call_contract['symbol']} (ID: {call_contract['product_id']}) | Put: {put_contract['symbol']} (ID: {put_contract['product_id']})")
    
    # 3. Place entry orders across all accounts
    for acc in accounts:
        name = acc['name']
        is_paper = (acc['env'] == 'paper')
        client_env = 'production' if is_paper else acc['env']
        client = DeltaClient(acc['api_key'], acc['api_secret'], client_env)
        
        log_trade_event(supabase, name, f"Starting Decay1 {'Paper ' if is_paper else ''}Execution. Spot: {spot}", 'INFO')
        
        # Pre-emptively clear all active and conditional bracket orders on this account (skip for paper)
        if not is_paper:
            try:
                client.cancel_all_orders()
                log_trade_event(supabase, name, "Pre-emptively cleared all active and conditional orders on exchange account.", 'INFO')
            except Exception as cancel_err:
                print(f"Notice: Failed to clear all orders on exchange for {name}: {cancel_err}")
            
        # Fetch current active positions from Delta Exchange to reconcile and close any existing open position
        # on the target option products before placing the new ones.
        exchange_positions = []
        if not is_paper:
            try:
                exchange_positions = client.get_positions(underlying_asset_symbol=underlying)
            except Exception as e:
                print(f"Notice: Failed to fetch active positions for pre-entry cleanup: {e}")
            
        # Sizing logic: load dynamic quantity from environment (default to 1 lot)
        trade_qty_env = os.getenv("TRADE_QTY", "1")
        try:
            size = int(float(trade_qty_env))
        except Exception:
            size = 1
        
        # Execution of both legs
        for leg, contract in [('Call', call_contract), ('Put', put_contract)]:
            symbol = contract['symbol']
            prod_id = contract['product_id']
            
            # Reconcile and close any existing active position for this contract on the exchange first (skip for paper)
            if not is_paper and exchange_positions:
                for ex_pos in exchange_positions:
                    ex_symbol = ex_pos.get('symbol') or ex_pos.get('product_symbol') or (ex_pos.get('product') and ex_pos['product'].get('symbol'))
                    ex_size = int(ex_pos.get('size', 0))
                    if ex_symbol == symbol and abs(ex_size) > 0:
                        log_trade_event(supabase, name, f"Found existing active position for {symbol} on exchange (Size: {ex_size}). Squaring off to clear brackets...", 'INFO')
                        try:
                            # Buy to close if short, sell to close if long
                            close_side = 'buy' if ex_size < 0 else 'sell'
                            client.place_order(
                                product_id=prod_id,
                                size=abs(ex_size),
                                side=close_side,
                                order_type='market_order'
                            )
                            log_trade_event(supabase, name, f"Successfully squared off existing position for {symbol}.", 'INFO')
                            # Wait a moment for matching engine processing
                            time.sleep(1.5)
                            
                            # Re-run cancel all to clear the newly created closing order's brackets if any
                            try:
                                client.cancel_all_orders()
                            except Exception:
                                pass
                        except Exception as close_err:
                            log_trade_event(supabase, name, f"Failed to square off existing position for {symbol}: {close_err}", 'ERROR')
            
            # Fetch current premium for the leg (use best_bid for short strangle entry)
            entry_premium = contract['best_bid'] if contract['best_bid'] > 0 else (contract['mark_price'] if contract['mark_price'] > 0 else 50.0)
            
            # Fetch current mark price for the option at entry
            mark_price_at_entry = contract['mark_price'] if contract['mark_price'] > 0 else (contract['best_bid'] if contract['best_bid'] > 0 else 50.0)
            
            # Calculate premium SL trigger (1.4x option mark price at entry)
            sl_price_premium = round(mark_price_at_entry * sl_multiplier, 2)

            # Calculate Target Underlying Spot Price (TP: 0.75% move, SL: 1.50% move)
            # Short Call: Profit if BTC drops (TP), Loss if BTC rises (SL)
            # Short Put: Profit if BTC rises (TP), Loss if BTC drops (SL)
            if leg == 'Call':
                tp_spot = round(spot * (1 - tgt_pct), 2)
                sl_price = round(spot * (1 + 0.0150), 2) # SL on Index Price (1.5% rise)
            else:
                tp_spot = round(spot * (1 + tgt_pct), 2)
                sl_price = round(spot * (1 - 0.0150), 2) # SL on Index Price (1.5% drop)
                
            if is_paper:
                # Simulated paper execution
                try:
                    fill_price = entry_premium
                    
                    # Insert position details into Supabase
                    supabase.table('positions').insert({
                        'account_id': acc['id'],
                        'strategy_name': 'decay1',
                        'symbol': symbol,
                        'side': 'sell',
                        'product_id': prod_id,
                        'size': size,
                        'entry_price': fill_price,
                        'mark_price': fill_price,
                        'sl_price': sl_price_premium, # database stores premium SL for dashboard/code
                        'tp_price': tp_spot,  # tp_price holds target SPOT price for monitoring/display
                        'pnl': 0.00,
                        'status': 'open',
                        'entry_order_id': 999999 # Simulated mock ID
                    }).execute()
                    
                    log_trade_event(supabase, name, f"Placed Paper {leg} Short: {symbol} size {size} at {fill_price}. Stop Loss (Local): {sl_price_premium}. Spot Target: {tp_spot}", 'TRADE')
                except Exception as e:
                    log_trade_event(supabase, name, f"Failed to place Paper {leg} Short {symbol}: {e}", 'ERROR')
            else:
                # Real exchange execution
                try:
                    # Note: cancel_all_orders() already ran at account level before entry loop.
                    # No need to cancel again per-product here - it could race with a just-placed SL/TP.
                        
                    # 1. Place the main Sell Order at market (no brackets yet)
                    order = client.place_order(
                        product_id=prod_id,
                        size=size,
                        side='sell',
                        order_type='market_order',
                        client_order_id=f"decay1_{leg.lower()}_{int(time.time())}"
                    )
                    
                    # Fetch actual fill price
                    fill_price = safe_float(order.get('avg_fill_price'))
                    if fill_price <= 0.0:
                        fill_price = entry_premium

                    # 2. Attach SL (mark_price trigger) + TP (spot_price/index trigger) as separate conditional orders
                    bracket_results = client.attach_sl_tp(
                        product_id=prod_id,
                        size=size,
                        sl_price=str(sl_price_premium),
                        sl_trigger_method='mark_price',
                        tp_price=str(tp_spot) if tp_spot > 0 else None,
                        tp_trigger_method='spot_price'
                    )
                    if bracket_results.get('sl_error'):
                        log_trade_event(supabase, name, f"Warning: Failed to attach native SL for {symbol}: {bracket_results['sl_error']}", 'ERROR')
                    elif bracket_results.get('sl'):
                        sl_order_id = bracket_results['sl'].get('id', '?')
                        log_trade_event(supabase, name, f"Native SL attached for {symbol}: Stop at Mark {sl_price_premium} (Order ID: {sl_order_id})", 'INFO')
                    if bracket_results.get('tp_error'):
                        log_trade_event(supabase, name, f"Warning: Failed to attach native TP for {symbol}: {bracket_results['tp_error']}", 'ERROR')
                    elif bracket_results.get('tp'):
                        tp_order_id = bracket_results['tp'].get('id', '?')
                        log_trade_event(supabase, name, f"Native TP attached for {symbol}: Stop at Index {tp_spot} (Order ID: {tp_order_id})", 'INFO')
                    
                    # Insert position details into Supabase
                    supabase.table('positions').insert({
                        'account_id': acc['id'],
                        'strategy_name': 'decay1',
                        'symbol': symbol,
                        'side': 'sell',
                        'product_id': prod_id,
                        'size': size,
                        'entry_price': fill_price,
                        'mark_price': fill_price,
                        'sl_price': sl_price_premium, # sl_price holds target MARK price (premium) for monitoring/display
                        'tp_price': tp_spot,  # tp_price holds target SPOT price for monitoring/display
                        'pnl': 0.00,
                        'status': 'open',
                        'entry_order_id': order.get('id')
                    }).execute()
                    
                    log_trade_event(supabase, name, f"Placed {leg} Short: {symbol} size {size} at {fill_price}. Stop Loss (Exchange - Mark): {sl_price_premium}. Take Profit (Exchange - Index): {tp_spot}", 'TRADE')
                    
                except Exception as e:
                    err_str = str(e)
                    if "market_disrupted_post_only_mode" in err_str:
                        log_trade_event(supabase, name, f"Post-Only mode detected for {symbol}. Retrying with Limit Order...", 'INFO')
                        try:
                            best_ask = safe_float(contract.get('best_ask'), entry_premium)
                            if best_ask <= 0.0:
                                best_ask = entry_premium
                                
                            # 1. Place limit order (post-only mode fallback)
                            order = client.place_order(
                                product_id=prod_id,
                                size=size,
                                side='sell',
                                order_type='limit_order',
                                limit_price=str(best_ask),
                                client_order_id=f"decay1_{leg.lower()}_lim_{int(time.time())}"
                            )
                            
                            fill_price = safe_float(order.get('limit_price')) if order.get('limit_price') else best_ask

                            # 2. Attach SL (mark_price) + TP (spot_price/index) as separate conditional orders
                            bracket_results = client.attach_sl_tp(
                                product_id=prod_id,
                                size=size,
                                sl_price=str(sl_price_premium),
                                sl_trigger_method='mark_price',
                                tp_price=str(tp_spot) if tp_spot > 0 else None,
                                tp_trigger_method='spot_price'
                            )
                            if bracket_results.get('sl_error'):
                                log_trade_event(supabase, name, f"Warning: Failed to attach native SL for {symbol}: {bracket_results['sl_error']}", 'ERROR')
                            if bracket_results.get('tp_error'):
                                log_trade_event(supabase, name, f"Warning: Failed to attach native TP for {symbol}: {bracket_results['tp_error']}", 'ERROR')
                            
                            # Insert position details into Supabase
                            supabase.table('positions').insert({
                                'account_id': acc['id'],
                                'strategy_name': 'decay1',
                                'symbol': symbol,
                                'side': 'sell',
                                'product_id': prod_id,
                                'size': size,
                                'entry_price': fill_price,
                                'mark_price': fill_price,
                                'sl_price': sl_price_premium, # sl_price holds target MARK price (premium) for monitoring/display
                                'tp_price': tp_spot,
                                'pnl': 0.00,
                                'status': 'open',
                                'entry_order_id': order.get('id')
                            }).execute()
                            
                            log_trade_event(supabase, name, f"Placed Limit {leg} Short: {symbol} size {size} at {fill_price}. Stop Loss (Exchange - Mark): {sl_price_premium}. Take Profit (Exchange - Index): {tp_spot}", 'TRADE')
                        except Exception as limit_err:
                            log_trade_event(supabase, name, f"Limit order fallback also failed for {symbol}: {limit_err}", 'ERROR')
                    else:
                        log_trade_event(supabase, name, f"Failed to place {leg} Short {symbol}: {e}", 'ERROR')

def execute_decay1_exit(supabase: Client):
    """
    Emergency or Time-based Exit. Closes all remaining open positions at 12:29 IST.
    """
    open_positions_res = supabase.table('positions').select('*, accounts(name, api_key, api_secret, env)').eq('strategy_name', 'decay1').eq('status', 'open').execute()
    open_positions = open_positions_res.data
    
    if not open_positions:
        print("No active open positions to exit for Decay1.")
        return
        
    for pos in open_positions:
        acc = pos['accounts']
        is_paper = (acc['env'] == 'paper')
        client_env = 'production' if is_paper else acc['env']
        client = DeltaClient(acc['api_key'], acc['api_secret'], client_env)
        
        try:
            if is_paper:
                # Update Supabase Status directly for simulated close
                supabase.table('positions').update({
                    'status': 'closed',
                    'closed_at': datetime.datetime.now(datetime.timezone.utc).isoformat()
                }).eq('id', pos['id']).execute()
                log_trade_event(supabase, acc['name'], f"Time exit triggered (Paper). Closed Short Strangle leg: {pos['symbol']}", 'TRADE', 'decay1')
            else:
                # Place buy order at market to close the position on real exchange with reduce_only protection
                client.place_order(
                    product_id=pos['product_id'],
                    size=pos['size'],
                    side='buy',
                    order_type='market_order',
                    reduce_only=True
                )
                
                # Cancel all resting orders/brackets to avoid false orders later
                try:
                    client.cancel_all_orders(product_id=pos['product_id'])
                    log_trade_event(supabase, acc['name'], f"Time exit: Cleared resting brackets for {pos['symbol']}.", 'INFO', 'decay1')
                except Exception as cancel_err:
                    print(f"Notice: Failed to cancel resting orders for time-exited leg {pos['symbol']}: {cancel_err}")
                
                # Update Supabase Status
                supabase.table('positions').update({
                    'status': 'closed',
                    'closed_at': datetime.datetime.now(datetime.timezone.utc).isoformat()
                }).eq('id', pos['id']).execute()
                
                log_trade_event(supabase, acc['name'], f"Time exit triggered. Closed Short Strangle leg: {pos['symbol']}", 'TRADE', 'decay1')
        except Exception as e:
            log_trade_event(supabase, acc['name'], f"Failed to time-exit {pos['symbol']}: {e}", 'ERROR', 'decay1')

def monitor_positions_loop(supabase: Client):
    """
    Runs as a continuous daemon to monitor spot target (0.75% move) for Decay1,
    reconcile stop losses from Delta Exchange, and handle manual dashboard close requests.
    """
    print("Starting background position monitor for Decay1...")
    while True:
        try:
            # Fetch all open positions or manually requested closes for decay1 with account credentials
            open_pos_res = supabase.table('positions').select('*, accounts(name, api_key, api_secret, env)').eq('strategy_name', 'decay1').in_('status', ['open', 'close_requested']).execute()
            open_positions = open_pos_res.data
            
            if not open_positions:
                time.sleep(10)
                continue
                
            # Fetch current underlying spot prices
            acc0 = open_positions[0]['accounts']
            env0 = 'production' if acc0['env'] == 'paper' else acc0['env']
            client = DeltaClient(acc0['api_key'], acc0['api_secret'], env0)
            tickers = client.get_tickers(contract_types='call_options,put_options', underlying='BTC')
            
            # Map ticker by symbol for easy lookup
            ticker_map = {t['symbol']: t for t in tickers}
            # Use futures mark_price instead of spot_price
            futures_symbol = 'BTCUSD'
            spot = client.get_futures_price(futures_symbol)
            if spot <= 0:
                spot = safe_float(tickers[0]['spot_price']) if tickers else 0.0
                print(f"Warning: Futures price unavailable in monitor loop, using spot: {spot}")
            
            # Group open positions in DB by account to reconcile Stop Losses & minimize API calls
            accounts_positions = {}
            for pos in open_positions:
                acc_id = pos['account_id']
                if acc_id not in accounts_positions:
                    accounts_positions[acc_id] = []
                accounts_positions[acc_id].append(pos)
                
            for acc_id, positions_list in accounts_positions.items():
                acc = positions_list[0]['accounts']
                is_paper = (acc['env'] == 'paper')
                client_env = 'production' if is_paper else acc['env']
                trading_client = DeltaClient(acc['api_key'], acc['api_secret'], client_env)
                
                # Get underlying asset symbol dynamically
                underlying_symbol = 'BTC'
                if positions_list:
                    parts = positions_list[0]['symbol'].split('-')
                    if len(parts) >= 2:
                        underlying_symbol = parts[1]
                        
                # Fetch current active positions from Delta Exchange (skip for paper)
                exchange_positions = []
                active_symbols = set()
                if not is_paper:
                    try:
                        exchange_positions = trading_client.get_positions(underlying_asset_symbol=underlying_symbol)
                    except Exception as e:
                        print(f"Error fetching active positions from exchange for {acc['name']}: {e}")
                        exchange_positions = None
                        
                    if exchange_positions is not None:
                        for ex_pos in exchange_positions:
                            ex_symbol = ex_pos.get('symbol') or ex_pos.get('product_symbol') or (ex_pos.get('product') and ex_pos['product'].get('symbol'))
                            ex_size = abs(int(ex_pos.get('size', 0)))
                            if ex_symbol and ex_size > 0:
                                active_symbols.add(ex_symbol)
                            
                for pos in positions_list:
                    symbol = pos['symbol']
                    prod_id = pos['product_id']
                    sl_price = safe_float(pos.get('sl_price'))
                    tp_spot = safe_float(pos['tp_price']) # the underlying spot target (0.75%)
                    entry_price = safe_float(pos['entry_price'])
                    size = pos['size']
                    status = pos.get('status', 'open')
                    is_close_requested = (status == 'close_requested')
                    
                    # 1. Update current mark price and unrealized PnL based on Option Mark Price
                    ticker = ticker_map.get(symbol)
                    mark_price = entry_price
                    if ticker:
                        mark_price = safe_float(ticker.get('mark_price'), entry_price)
                        multiplier = get_contract_multiplier(symbol)
                        unrealized_pnl = (entry_price - mark_price) * size * multiplier
                        print(f"[MONITOR DEBUG] {symbol} | Entry: {entry_price} | Mark: {mark_price} | PnL: {unrealized_pnl:.4f} USDT | SL: {sl_price}")
                        
                        supabase.table('positions').update({
                            'mark_price': mark_price,
                            'pnl': round(unrealized_pnl, 6)
                        }).eq('id', pos['id']).execute()
                    
                    # 2. Reconcile if position was manually closed on Delta Exchange directly (skip for paper)
                    if not is_paper and status == 'open' and exchange_positions is not None and symbol not in active_symbols:
                        print(f"Reconciliation: option {symbol} is closed on Delta Exchange. Updating DB status.")
                        try:
                            supabase.table('positions').update({
                                'status': 'closed',
                                'closed_at': datetime.datetime.now(datetime.timezone.utc).isoformat()
                            }).eq('id', pos['id']).execute()
                            log_trade_event(supabase, acc['name'], f"Exchange reconciled manual closure of {symbol}.", 'TRADE', 'decay1')
                        except Exception as db_err:
                            print(f"Failed to update db status for closed option {symbol}: {db_err}")
                        continue
                        
                    # 3. Check Stop Loss (using Option Mark Price) and Take Profit Spot target
                    sl_hit = (mark_price >= sl_price) if (mark_price > 0 and sl_price > 0) else False
                    is_call = symbol.startswith('C-')
                    target_hit = False
                    if is_call and spot <= tp_spot:
                        target_hit = True
                    elif not is_call and spot >= tp_spot:
                            target_hit = True
                        
                    if sl_hit or target_hit or is_close_requested:
                        if sl_hit:
                            reason = f"Stop Loss Premium Hit (Mark: {mark_price} >= SL: {sl_price})"
                        elif is_close_requested:
                            reason = "Manual Square-off request"
                        else:
                            reason = f"Spot Target Hit (Spot: {spot} | Target TP: {tp_spot})"
                            
                        log_trade_event(supabase, acc['name'], f"{reason}. Closing leg {symbol} {'(Paper)' if is_paper else 'on exchange'}...", 'TRADE', 'decay1')
                        
                        if is_paper:
                            try:
                                supabase.table('positions').update({
                                    'status': 'closed',
                                    'closed_at': datetime.datetime.now(datetime.timezone.utc).isoformat()
                                }).eq('id', pos['id']).execute()
                                log_trade_event(supabase, acc['name'], f"Successfully closed {symbol} (Paper).", 'TRADE', 'decay1')
                            except Exception as e:
                                log_trade_event(supabase, acc['name'], f"Failed to execute paper close for {symbol}: {e}", 'ERROR', 'decay1')
                        else:
                            try:
                                trading_client.place_order(
                                    product_id=prod_id,
                                    size=size,
                                    side='buy',
                                    order_type='market_order',
                                    reduce_only=True
                                )
                                
                                # Cancel all resting orders/brackets to avoid false orders later
                                try:
                                    trading_client.cancel_all_orders(product_id=prod_id)
                                    log_trade_event(supabase, acc['name'], f"Decay1: Cancelled all resting brackets/orders for {symbol}.", 'INFO', 'decay1')
                                except Exception as cancel_err:
                                    print(f"Notice: Failed to cancel resting orders for {symbol}: {cancel_err}")
                                
                                supabase.table('positions').update({
                                    'status': 'closed',
                                    'closed_at': datetime.datetime.now(datetime.timezone.utc).isoformat()
                                }).eq('id', pos['id']).execute()
                                
                                log_trade_event(supabase, acc['name'], f"Successfully closed {symbol} on exchange.", 'TRADE', 'decay1')
                            except Exception as e:
                                err_str = str(e)
                                if "no_position_for_reduce_only" in err_str:
                                    log_trade_event(supabase, acc['name'], f"Position {symbol} already closed on exchange (no_position_for_reduce_only). Updating status in DB...", 'INFO', 'decay1')
                                    try:
                                        # Cancel all resting orders/brackets anyway
                                        try:
                                            trading_client.cancel_all_orders(product_id=prod_id)
                                        except Exception:
                                            pass
                                        supabase.table('positions').update({
                                            'status': 'closed',
                                            'closed_at': datetime.datetime.now(datetime.timezone.utc).isoformat()
                                        }).eq('id', pos['id']).execute()
                                    except Exception as db_err:
                                        print(f"Failed to update db status for closed option {symbol}: {db_err}")
                                else:
                                    log_trade_event(supabase, acc['name'], f"Failed to execute close for {symbol}: {e}", 'ERROR', 'decay1')
                            
        except Exception as e:
            err_msg = str(e)
            if "Server disconnected" in err_msg or "Connection to Delta Exchange failed" in err_msg or "RemoteProtocolError" in err_msg:
                print("Notice: Temporary API connection timeout (Server disconnected). Retrying in 10s...")
            else:
                print(f"Error in Decay1 position monitor loop: {e}")
            
        time.sleep(10)
