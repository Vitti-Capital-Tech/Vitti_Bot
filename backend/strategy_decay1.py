import datetime
import time
import threading
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
    Selects the specific option contracts based on strike selection logic (e.g. OTM6).
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
    
    # Filter OTM strikes
    # Calls: strike > spot, sorted ascending (cheaper premium further out)
    otm_calls = sorted([c for c in calls if c['strike'] > spot], key=lambda x: x['strike'])
    # Puts: strike < spot, sorted descending (cheaper premium further out)
    otm_puts = sorted([p for p in puts if p['strike'] < spot], key=lambda x: x['strike'], reverse=True)
    
    selected_call = otm_calls[rank - 1] if len(otm_calls) >= rank else None
    selected_put = otm_puts[rank - 1] if len(otm_puts) >= rank else None
    
    return {
        'C': selected_call,
        'P': selected_put
    }

def log_trade_event(supabase: Client, account_name: str, message: str, level: str = 'INFO'):
    """
    Pushes a real-time event log to the Supabase database.
    """
    try:
        supabase.table('trade_logs').insert({
            'account_name': account_name,
            'strategy_name': 'decay1',
            'message': message,
            'log_level': level
        }).execute()
        print(f"[{level}] {account_name}: {message}")
    except Exception as e:
        print(f"Failed to write log to database: {e}")

def execute_decay1_entry(supabase: Client):
    """
    Main entry execution logic for Decay1. Called at 08:31 IST.
    """
    # 1. Fetch active accounts from Supabase
    accounts_res = supabase.table('accounts').select('*').eq('is_active', True).execute()
    accounts = accounts_res.data
    
    if not accounts:
        print("No active trading accounts found in Supabase.")
        return
        
    # Fetch Decay1 strategy specs
    strategy_res = supabase.table('strategies').select('*').eq('name', 'decay1').execute()
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
        
    # Get BTC Spot price
    spot = parsed[0]['spot_price']
    
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
        client = DeltaClient(acc['api_key'], acc['api_secret'], acc['env'])
        
        log_trade_event(supabase, name, f"Starting Decay1 Execution. Spot: {spot}", 'INFO')
        
        # Sizing logic: for this simple deployment, we sell 1 contract (can be made configurable)
        size = 1 
        
        # Execution of both legs
        for leg, contract in [('Call', call_contract), ('Put', put_contract)]:
            symbol = contract['symbol']
            prod_id = contract['product_id']
            # Fetch current premium for the leg
            entry_premium = contract['mark_price'] if contract['mark_price'] > 0 else (contract['best_ask'] or 50.0)
            
            # Calculate SL Trigger Premium (1.40x for short strangle)
            sl_price = round(entry_premium * sl_multiplier, 2)
            
            # Calculate Target Underlying Spot Price (0.75% move)
            # Short Call target: Spot drops by 0.75%
            # Short Put target: Spot rises by 0.75%
            if leg == 'Call':
                tp_spot = round(spot * (1 - tgt_pct), 2)
            else:
                tp_spot = round(spot * (1 + tgt_pct), 2)
                
            try:
                # Place Sell Order at market with bracket SL attached
                order = client.place_order(
                    product_id=prod_id,
                    size=size,
                    side='sell',
                    order_type='market_order',
                    sl_price=str(sl_price),
                    client_order_id=f"decay1_{leg.lower()}_{int(time.time())}"
                )
                
                # Fetch actual fill price from average fill output if available, or fall back to estimated entry premium
                fill_price = safe_float(order.get('avg_fill_price'))
                if fill_price <= 0.0:
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
                    'sl_price': sl_price,
                    'tp_price': tp_spot, # tp_price holds target SPOT price for code monitoring
                    'pnl': 0.00,
                    'status': 'open',
                    'entry_order_id': order.get('id')
                }).execute()
                
                log_trade_event(supabase, name, f"Placed {leg} Short: {symbol} size {size} at {fill_price}. Stop Loss placed at {sl_price}. Spot Target: {tp_spot}", 'TRADE')
                
            except Exception as e:
                err_str = str(e)
                if "market_disrupted_post_only_mode" in err_str:
                    log_trade_event(supabase, name, f"Post-Only mode detected for {symbol}. Retrying with Limit Order at best ask...", 'INFO')
                    try:
                        # Fallback price: use best_ask for sell limit order (maker)
                        best_ask = safe_float(contract.get('best_ask'), entry_premium)
                        if best_ask <= 0.0:
                            best_ask = entry_premium
                            
                        # Place limit order with bracket stop loss attached
                        order = client.place_order(
                            product_id=prod_id,
                            size=size,
                            side='sell',
                            order_type='limit_order',
                            limit_price=str(best_ask),
                            sl_price=str(sl_price),
                            client_order_id=f"decay1_{leg.lower()}_lim_{int(time.time())}"
                        )
                        
                        # Fetch actual fill price or use limit best_ask
                        fill_price = safe_float(order.get('limit_price')) if order.get('limit_price') else best_ask
                        
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
                            'sl_price': sl_price,
                            'tp_price': tp_spot,
                            'pnl': 0.00,
                            'status': 'open',
                            'entry_order_id': order.get('id')
                        }).execute()
                        
                        log_trade_event(supabase, name, f"Placed Limit {leg} Short: {symbol} size {size} at {fill_price} (Limit). Stop Loss placed at {sl_price}. Spot Target: {tp_spot}", 'TRADE')
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
        client = DeltaClient(acc['api_key'], acc['api_secret'], acc['env'])
        
        try:
            # Place buy order at market to close the position
            client.place_order(
                product_id=pos['product_id'],
                size=pos['size'],
                side='buy',
                order_type='market_order'
            )
            
            # Update Supabase Status
            supabase.table('positions').update({
                'status': 'closed',
                'closed_at': datetime.datetime.now(datetime.timezone.utc).isoformat()
            }).eq('id', pos['id']).execute()
            
            log_trade_event(supabase, acc['name'], f"Time exit triggered. Closed Short Strangle leg: {pos['symbol']}", 'TRADE')
        except Exception as e:
            log_trade_event(supabase, acc['name'], f"Failed to time-exit {pos['symbol']}: {e}", 'ERROR')

def monitor_positions_loop(supabase: Client):
    """
    Runs as a continuous daemon to monitor spot target (0.75% move),
    reconcile stop losses from Delta Exchange, and handle manual dashboard close requests.
    """
    print("Starting background position monitor...")
    while True:
        try:
            # Fetch all open positions or manually requested closes with account credentials
            open_pos_res = supabase.table('positions').select('*, accounts(name, api_key, api_secret, env)').in_('status', ['open', 'close_requested']).execute()
            open_positions = open_pos_res.data
            
            if not open_positions:
                time.sleep(10)
                continue
                
            # Fetch current underlying spot prices
            # We construct a client from the first account to query public tickers
            acc0 = open_positions[0]['accounts']
            client = DeltaClient(acc0['api_key'], acc0['api_secret'], acc0['env'])
            tickers = client.get_tickers(contract_types='call_options,put_options', underlying='BTC')
            
            # Map ticker by symbol for easy lookup
            ticker_map = {t['symbol']: t for t in tickers}
            spot = safe_float(tickers[0]['spot_price']) if tickers else 0.0
            
            # Group open positions in DB by account to reconcile Stop Losses & minimize API calls
            accounts_positions = {}
            for pos in open_positions:
                acc_id = pos['account_id']
                if acc_id not in accounts_positions:
                    accounts_positions[acc_id] = []
                accounts_positions[acc_id].append(pos)
                
            for acc_id, positions_list in accounts_positions.items():
                acc = positions_list[0]['accounts']
                trading_client = DeltaClient(acc['api_key'], acc['api_secret'], acc['env'])
                
                # Fetch current active positions from Delta Exchange
                exchange_positions = []
                try:
                    exchange_positions = trading_client.get_positions()
                except Exception as e:
                    print(f"Error fetching active positions from exchange for {acc['name']}: {e}")
                    # Set to None to skip reconciliation and avoid false closure updates if API fails
                    exchange_positions = None
                    
                active_symbols = set()
                if exchange_positions is not None:
                    for ex_pos in exchange_positions:
                        ex_symbol = ex_pos.get('symbol') or (ex_pos.get('product') and ex_pos['product'].get('symbol'))
                        ex_size = abs(int(ex_pos.get('size', 0)))
                        if ex_symbol and ex_size > 0:
                            active_symbols.add(ex_symbol)
                            
                for pos in positions_list:
                    symbol = pos['symbol']
                    prod_id = pos['product_id']
                    tp_spot = safe_float(pos['tp_price']) # the underlying spot target (0.75%)
                    entry_price = safe_float(pos['entry_price'])
                    size = pos['size']
                    status = pos.get('status', 'open')
                    is_close_requested = (status == 'close_requested')
                    
                    # 1. Stop Loss Reconciliation: If marked open in DB but not active on exchange, it was stopped/closed
                    if status == 'open' and exchange_positions is not None and symbol not in active_symbols:
                        print(f"Reconciliation: option {symbol} is closed on Delta Exchange. Updating DB status.")
                        try:
                            supabase.table('positions').update({
                                'status': 'closed',
                                'closed_at': datetime.datetime.now(datetime.timezone.utc).isoformat()
                            }).eq('id', pos['id']).execute()
                            log_trade_event(supabase, acc['name'], f"Exchange reconciled closure: {symbol} was closed by stop-loss or manual trigger.", 'TRADE')
                        except Exception as db_err:
                            print(f"Failed to update db status for closed option {symbol}: {db_err}")
                        continue # Skip further checks since position is closed
                        
                    # 2. Update current mark price and unrealized PnL
                    ticker = ticker_map.get(symbol)
                    mark_price = entry_price # default fallback
                    if ticker:
                        mark_price = safe_float(ticker.get('mark_price'), entry_price)
                        # For short position, PnL = (Entry - Mark) * size
                        unrealized_pnl = (entry_price - mark_price) * size
                        
                        supabase.table('positions').update({
                            'mark_price': mark_price,
                            'pnl': round(unrealized_pnl, 6)
                        }).eq('id', pos['id']).execute()
                    
                    # 3. Check if underlying spot price hit the 0.75% target or manual dashboard close requested
                    is_call = symbol.startswith('C-')
                    target_hit = False
                    if is_call and spot <= tp_spot:
                        target_hit = True
                    elif not is_call and spot >= tp_spot:
                        target_hit = True
                        
                    if target_hit or is_close_requested:
                        reason = "Manual Square-off request" if is_close_requested else f"Spot Target Hit ({spot})"
                        log_trade_event(supabase, acc['name'], f"{reason}. Closing leg {symbol} on exchange...", 'TRADE')
                        
                        # Place buy order at market to close the position
                        try:
                            trading_client.place_order(
                                product_id=prod_id,
                                size=size,
                                side='buy',
                                order_type='market_order'
                            )
                            
                            supabase.table('positions').update({
                                'status': 'closed',
                                'closed_at': datetime.datetime.now(datetime.timezone.utc).isoformat()
                            }).eq('id', pos['id']).execute()
                            
                            log_trade_event(supabase, acc['name'], f"Successfully closed {symbol} on exchange.", 'TRADE')
                        except Exception as e:
                            log_trade_event(supabase, acc['name'], f"Failed to execute close for {symbol}: {e}", 'ERROR')
                            
        except Exception as e:
            print(f"Error in position monitor thread: {e}")
            
        time.sleep(10) # check every 10 seconds
