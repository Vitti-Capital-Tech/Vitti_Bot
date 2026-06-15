import datetime
import time
from typing import Dict, Any, List, Optional
from supabase import create_client, Client
from delta_client import DeltaClient
import config
from strategy_decay1 import (
    safe_float,
    parse_options_chain,
    select_strangle_strikes,
    log_trade_event,
    supabase_retry,
    get_contract_multiplier
)

def execute_decay2_entry(supabase: Client):
    """
    Main entry execution logic for Decay2 (decay day2). Called at 13:31 IST.
    """
    # 1. Fetch active accounts from Supabase
    accounts_res = supabase_retry(lambda: supabase.table('accounts').select('*').eq('is_active', True).execute())
    accounts = accounts_res.data
    
    if not accounts:
        print("No active trading accounts found in Supabase.")
        return
        
    # Fetch Decay2 strategy specs
    strategy_res = supabase_retry(lambda: supabase.table('strategies').select('*').eq('name', 'decay2').execute())
    strategy = strategy_res.data[0] if strategy_res.data else None
    
    if not strategy or not strategy.get('is_active'):
        print("Decay2 strategy is not active or not configured.")
        return
        
    underlying = strategy.get('underlying', 'BTC')
    strike_selection = strategy.get('strike_selection', 'otm6')
    sl_multiplier = safe_float(strategy.get('sl_multiplier'), 2.00)
    tgt_mult = safe_float(strategy.get('underlying_target_pct'), 0.20)
    
    # 2. Query option tickers to choose contracts (using first client connection details)
    sample_key = accounts[0]['api_key']
    sample_secret = accounts[0]['api_secret']
    sample_env = accounts[0]['env']
    if sample_env == 'paper':
        sample_env = 'production'
    
    ticker_client = DeltaClient(sample_key, sample_secret, sample_env)
    try:
        tickers = ticker_client.get_tickers(contract_types='call_options,put_options', underlying=underlying)
    except Exception as e:
        print(f"Failed to fetch market data for Decay2: {e}")
        return
        
    parsed = parse_options_chain(tickers, underlying)
    if not parsed:
        print("No active option contracts parsed for Decay2.")
        return
        
    # Get BTC Futures price (mark price of BTCUSD perpetual)
    futures_symbol = f"{underlying}USD"
    spot = ticker_client.get_futures_price(futures_symbol)
    if spot <= 0:
        # Fallback to spot_price from options ticker if futures fetch fails
        spot = parsed[0]['spot_price']
        print(f"Warning: Futures price unavailable for Decay2, falling back to spot_price: {spot}")
    print(f"Decay2 using futures price for {futures_symbol}: {spot}")
    
    # Pick Strangle contracts
    contracts = select_strangle_strikes(parsed, spot, strike_selection)
    call_contract = contracts['C']
    put_contract = contracts['P']
    
    if not call_contract or not put_contract:
        print("Failed to resolve Decay2 OTM Call or Put contract.")
        return
        
    print(f"Decay2 Spot: {spot} | Selected Strangle -> Call: {call_contract['symbol']} (ID: {call_contract['product_id']}) | Put: {put_contract['symbol']} (ID: {put_contract['product_id']})")
    
    # 3. Place entry orders across all accounts
    for acc in accounts:
        name = acc['name']
        is_paper = (acc['env'] == 'paper')
        client_env = 'production' if is_paper else acc['env']
        client = DeltaClient(acc['api_key'], acc['api_secret'], client_env)
        
        log_trade_event(supabase, name, f"Starting Decay2 {'Paper ' if is_paper else ''}Execution. Spot: {spot}", 'INFO', 'decay2')
        
        # Pre-emptively clear all active and conditional orders on this account to avoid bracket blocks (skip for paper)
        if not is_paper:
            try:
                client.cancel_all_orders()
                log_trade_event(supabase, name, "Pre-emptively cleared all active and conditional orders on exchange account.", 'INFO', 'decay2')
            except Exception as cancel_err:
                print(f"Notice: Failed to clear all orders on exchange for {name}: {cancel_err}")
            
        exchange_positions = []
        if not is_paper:
            try:
                exchange_positions = client.get_positions(underlying_asset_symbol=underlying)
            except Exception as e:
                print(f"Notice: Failed to fetch active positions for Decay2 pre-entry cleanup: {e}")
            
        # Sizing logic: load dynamic quantity from account's 'lots' field, fallback to environment, then default to 1
        try:
            size = int(acc.get('lots') or os.getenv("TRADE_QTY", "1"))
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
                        log_trade_event(supabase, name, f"Found existing active position for {symbol} on exchange (Size: {ex_size}). Squaring off to clear brackets...", 'INFO', 'decay2')
                        try:
                            close_side = 'buy' if ex_size < 0 else 'sell'
                            client.place_order(
                                product_id=prod_id,
                                size=abs(ex_size),
                                side=close_side,
                                order_type='market_order'
                            )
                            log_trade_event(supabase, name, f"Successfully squared off existing position for {symbol}.", 'INFO', 'decay2')
                            time.sleep(1.5)
                            try:
                                client.cancel_all_orders()
                            except Exception:
                                pass
                        except Exception as close_err:
                            log_trade_event(supabase, name, f"Failed to square off existing position for {symbol}: {close_err}", 'ERROR', 'decay2')
            
            # Fetch current premium for the leg (use best_bid for short strangle entry)
            entry_premium = contract['best_bid'] if contract['best_bid'] > 0 else (contract['mark_price'] if contract['mark_price'] > 0 else 50.0)
            
            # Fetch current mark price for the option at entry
            mark_price_at_entry = contract['mark_price'] if contract['mark_price'] > 0 else (contract['best_bid'] if contract['best_bid'] > 0 else 50.0)
            
            # Calculate SL Trigger Premium (2.0x for short strangle decay2) using entry_premium as a baseline
            sl_price = round(entry_premium * sl_multiplier, 2)
            
            # Calculate TP Trigger Premium (0.20x for short strangle decay2) using entry_premium as a baseline
            tp_premium = round(entry_premium * tgt_mult, 2)
            
            if is_paper:
                # Simulated paper execution for Decay2
                try:
                    fill_price = entry_premium
                    
                    # Insert position details into Supabase
                    supabase.table('positions').insert({
                        'account_id': acc['id'],
                        'strategy_name': 'decay2',
                        'symbol': symbol,
                        'side': 'sell',
                        'product_id': prod_id,
                        'size': size,
                        'entry_price': fill_price,
                        'mark_price': fill_price,
                        'sl_price': sl_price,
                        'tp_price': tp_premium, 
                        'pnl': 0.00,
                        'status': 'open',
                        'entry_order_id': 999999 # Simulated mock ID
                    }).execute()
                    
                    log_trade_event(supabase, name, f"Placed Paper {leg} Short: {symbol} size {size} at {fill_price}. Stop Loss (Local): {sl_price}. Take Profit (Local): {tp_premium}", 'TRADE', 'decay2')
                except Exception as e:
                    log_trade_event(supabase, name, f"Failed to place Paper {leg} Short {symbol} for Decay2: {e}", 'ERROR', 'decay2')
            else:
                # Real exchange execution
                try:
                    try:
                        client.cancel_order(product_id=prod_id)
                    except Exception:
                        pass
                        
                    # 1. Place the Entry Sell Order at market (no brackets attached)
                    order = client.place_order(
                        product_id=prod_id,
                        size=size,
                        side='sell',
                        order_type='market_order',
                        client_order_id=f"decay2_{leg.lower()}_{int(time.time())}"
                    )
                    
                    fill_price = safe_float(order.get('avg_fill_price'))
                    if fill_price <= 0.0:
                        fill_price = entry_premium
                    
                    # Wait for position to register on exchange
                    time.sleep(1.5)
                    
                    # Fetch actual position entry price from Delta (more accurate than avg_fill_price)
                    try:
                        positions_resp = client.request('GET', '/v2/positions', query_params={'product_id': int(prod_id)})
                        # Response is a direct dict: {'size': -1, 'entry_price': '45.0'}
                        if isinstance(positions_resp, dict) and positions_resp.get('entry_price'):
                            pos_entry = safe_float(positions_resp.get('entry_price'))
                        else:
                            # Try list/result format as fallback
                            pos_list = positions_resp if isinstance(positions_resp, list) else positions_resp.get('result', [])
                            pos_entry = next((safe_float(p.get('entry_price')) for p in pos_list if safe_float(p.get('size', 0)) != 0), 0.0)
                        if pos_entry > 0:
                            log_trade_event(supabase, name, f"Using position entry price {pos_entry} (was avg_fill {fill_price}) for {symbol} SL/TP calc", 'INFO', 'decay2')
                            fill_price = pos_entry
                        else:
                            log_trade_event(supabase, name, f"Position entry price not found, using avg_fill {fill_price} for {symbol}", 'INFO', 'decay2')
                    except Exception as pos_err:
                        log_trade_event(supabase, name, f"Could not fetch position entry price for {symbol}, using avg_fill {fill_price}: {pos_err}", 'INFO', 'decay2')
                    
                    # Recalculate SL & TP targets based on actual position entry price
                    sl_price = round(fill_price * sl_multiplier, 2)
                    tp_premium = round(fill_price * tgt_mult, 2)
                    
                    # 2. Attach separate SL + TP orders on exchange
                    bracket_results = {}
                    if sl_price is not None:
                        # limit_price set to 1.5x trigger to ensure fill even if market gaps past trigger
                        sl_payload = {
                            "product_id": int(prod_id),
                            "size": int(size),
                            "side": "buy",
                            "order_type": "limit_order",
                            "limit_price": str(round(sl_price * 1.5, 2)),
                            "stop_price": str(sl_price),
                            "stop_order_type": "stop_loss_order",
                            "stop_trigger_method": "mark_price",
                            "reduce_only": True
                        }
                        try:
                            bracket_results['sl'] = client.request('POST', '/v2/orders', payload=sl_payload)
                        except Exception as sl_err:
                            bracket_results['sl_error'] = str(sl_err)
                            
                    if tp_premium is not None and tp_premium > 0:
                        tp_payload = {
                            "product_id": int(prod_id),
                            "size": int(size),
                            "side": "buy",
                            "order_type": "limit_order",
                            "limit_price": str(tp_premium),
                            "reduce_only": True
                        }
                        try:
                            bracket_results['tp'] = client.request('POST', '/v2/orders', payload=tp_payload)
                        except Exception as tp_err:
                            bracket_results['tp_error'] = str(tp_err)

                    if bracket_results.get('sl_error'):
                        log_trade_event(supabase, name, f"Warning: Failed to attach native SL for {symbol}: {bracket_results['sl_error']}", 'ERROR', 'decay2')
                    elif bracket_results.get('sl'):
                        sl_order_id = bracket_results['sl'].get('id', '?')
                        log_trade_event(supabase, name, f"Native SL attached for {symbol}: Stop at Mark {sl_price} (Order ID: {sl_order_id})", 'INFO', 'decay2')
                    if bracket_results.get('tp_error'):
                        log_trade_event(supabase, name, f"Warning: Failed to place TP limit order for {symbol}: {bracket_results['tp_error']}", 'ERROR', 'decay2')
                    elif bracket_results.get('tp'):
                        tp_order_id = bracket_results['tp'].get('id', '?')
                        log_trade_event(supabase, name, f"TP limit order placed in book for {symbol}: Limit at {tp_premium} (Order ID: {tp_order_id})", 'INFO', 'decay2')

                    # Insert position details into Supabase
                    supabase.table('positions').insert({
                        'account_id': acc['id'],
                        'strategy_name': 'decay2',
                        'symbol': symbol,
                        'side': 'sell',
                        'product_id': prod_id,
                        'size': size,
                        'entry_price': fill_price,
                        'mark_price': fill_price,
                        'sl_price': sl_price,
                        'tp_price': tp_premium, 
                        'pnl': 0.00,
                        'status': 'open',
                        'entry_order_id': order.get('id')
                    }).execute()
                    
                    log_trade_event(supabase, name, f"Placed {leg} Short: {symbol} size {size} at {fill_price}. Stop Loss (Exchange - Mark): {sl_price}. Take Profit (Exchange - Mark): {tp_premium}", 'TRADE', 'decay2')
                    
                except Exception as e:
                    err_str = str(e)
                    if "market_disrupted_post_only_mode" in err_str:
                        log_trade_event(supabase, name, f"Decay2: Post-Only mode detected for {symbol}. Retrying with Limit Order at best ask...", 'INFO', 'decay2')
                        try:
                            best_ask = safe_float(contract.get('best_ask'), entry_premium)
                            if best_ask <= 0.0:
                                best_ask = entry_premium
                                
                            # Place limit order
                            order = client.place_order(
                                product_id=prod_id,
                                size=size,
                                side='sell',
                                order_type='limit_order',
                                limit_price=str(best_ask),
                                client_order_id=f"decay2_{leg.lower()}_lim_{int(time.time())}"
                            )
                            
                            fill_price = safe_float(order.get('limit_price')) if order.get('limit_price') else best_ask
                            
                            # Wait for position to register on exchange
                            time.sleep(1.5)
                            
                            # Fetch actual position entry price from Delta (more accurate than order price)
                            try:
                                positions_resp = client.request('GET', '/v2/positions', query_params={'product_id': int(prod_id)})
                                # Response is a direct dict: {'size': -1, 'entry_price': '45.0'}
                                if isinstance(positions_resp, dict) and positions_resp.get('entry_price'):
                                    pos_entry = safe_float(positions_resp.get('entry_price'))
                                else:
                                    pos_list = positions_resp if isinstance(positions_resp, list) else positions_resp.get('result', [])
                                    pos_entry = next((safe_float(p.get('entry_price')) for p in pos_list if safe_float(p.get('size', 0)) != 0), 0.0)
                                if pos_entry > 0:
                                    log_trade_event(supabase, name, f"Using position entry price {pos_entry} (was limit {fill_price}) for {symbol} SL/TP calc", 'INFO', 'decay2')
                                    fill_price = pos_entry
                                else:
                                    log_trade_event(supabase, name, f"Position entry price not found, using limit_price {fill_price} for {symbol}", 'INFO', 'decay2')
                            except Exception as pos_err:
                                log_trade_event(supabase, name, f"Could not fetch position entry price for {symbol}, using limit_price {fill_price}: {pos_err}", 'INFO', 'decay2')
                            
                            # Recalculate SL & TP targets based on actual position entry price
                            sl_price = round(fill_price * sl_multiplier, 2)
                            tp_premium = round(fill_price * tgt_mult, 2)
                            
                            # 2. Attach separate SL + TP orders on exchange
                            bracket_results = {}
                            if sl_price is not None:
                                # limit_price set to 1.5x trigger to ensure fill even if market gaps past trigger
                                sl_payload = {
                                    "product_id": int(prod_id),
                                    "size": int(size),
                                    "side": "buy",
                                    "order_type": "limit_order",
                                    "limit_price": str(round(sl_price * 1.5, 2)),
                                    "stop_price": str(sl_price),
                                    "stop_order_type": "stop_loss_order",
                                    "stop_trigger_method": "mark_price",
                                    "reduce_only": True
                                }
                                try:
                                    bracket_results['sl'] = client.request('POST', '/v2/orders', payload=sl_payload)
                                except Exception as sl_err:
                                    bracket_results['sl_error'] = str(sl_err)
                                    
                            if tp_premium is not None and tp_premium > 0:
                                tp_payload = {
                                    "product_id": int(prod_id),
                                    "size": int(size),
                                    "side": "buy",
                                    "order_type": "limit_order",
                                    "limit_price": str(tp_premium),
                                    "reduce_only": True
                                }
                                try:
                                    bracket_results['tp'] = client.request('POST', '/v2/orders', payload=tp_payload)
                                except Exception as tp_err:
                                    bracket_results['tp_error'] = str(tp_err)

                            if bracket_results.get('sl_error'):
                                log_trade_event(supabase, name, f"Warning: Failed to attach native SL for {symbol}: {bracket_results['sl_error']}", 'ERROR', 'decay2')
                            if bracket_results.get('tp_error'):
                                log_trade_event(supabase, name, f"Warning: Failed to place TP limit order for {symbol}: {bracket_results['tp_error']}", 'ERROR', 'decay2')

                            supabase.table('positions').insert({
                                'account_id': acc['id'],
                                'strategy_name': 'decay2',
                                'symbol': symbol,
                                'side': 'sell',
                                'product_id': prod_id,
                                'size': size,
                                'entry_price': fill_price,
                                'mark_price': fill_price,
                                'sl_price': sl_price,
                                'tp_price': tp_premium,
                                'pnl': 0.00,
                                'status': 'open',
                                'entry_order_id': order.get('id')
                            }).execute()
                            
                            log_trade_event(supabase, name, f"Placed Limit {leg} Short: {symbol} size {size} at {fill_price} (Limit). Stop Loss (Exchange - Mark): {sl_price}. Take Profit (Exchange - Mark): {tp_premium}", 'TRADE', 'decay2')
                        except Exception as limit_err:
                            log_trade_event(supabase, name, f"Limit order fallback also failed for {symbol}: {limit_err}", 'ERROR', 'decay2')
                    else:
                        log_trade_event(supabase, name, f"Failed to place {leg} Short {symbol} for Decay2: {e}", 'ERROR', 'decay2')

def execute_decay2_exit(supabase: Client):
    """
    Emergency or Time-based Exit. Closes all remaining open positions at 17:29 IST.
    """
    open_positions_res = supabase.table('positions').select('*, accounts(name, api_key, api_secret, env)').eq('strategy_name', 'decay2').eq('status', 'open').execute()
    open_positions = open_positions_res.data
    
    if not open_positions:
        print("No active open positions to exit for Decay2.")
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
                log_trade_event(supabase, acc['name'], f"Time exit triggered (Paper). Closed Short Strangle leg: {pos['symbol']}", 'TRADE', 'decay2')
            else:
                # Place buy order at market to close the position with reduce_only protection
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
                    log_trade_event(supabase, acc['name'], f"Time exit: Cleared resting brackets for {pos['symbol']}.", 'INFO', 'decay2')
                except Exception as cancel_err:
                    print(f"Notice: Failed to cancel resting orders for time-exited leg {pos['symbol']}: {cancel_err}")
                
                # Update Supabase Status
                supabase.table('positions').update({
                    'status': 'closed',
                    'closed_at': datetime.datetime.now(datetime.timezone.utc).isoformat()
                }).eq('id', pos['id']).execute()
                
                log_trade_event(supabase, acc['name'], f"Time exit triggered. Closed Short Strangle leg: {pos['symbol']}", 'TRADE', 'decay2')
        except Exception as e:
            log_trade_event(supabase, acc['name'], f"Failed to time-exit {pos['symbol']}: {e}", 'ERROR', 'decay2')

def monitor_positions_loop_decay2(supabase: Client):
    """
    Continuous daemon to reconcile and monitor Decay2 open options.
    Exits both strangle legs simultaneously (SquareOffAllLegs=True) if SL or TP native brackets trigger.
    """
    print("Starting background position monitor for Decay2...")
    while True:
        try:
            open_pos_res = supabase.table('positions').select('*, accounts(name, api_key, api_secret, env)').eq('strategy_name', 'decay2').in_('status', ['open', 'close_requested']).execute()
            open_positions = open_pos_res.data
            
            if not open_positions:
                time.sleep(10)
                continue
                
            # Fetch current underlying spot prices to map quotes
            acc0 = open_positions[0]['accounts']
            env0 = 'production' if acc0['env'] == 'paper' else acc0['env']
            client = DeltaClient(acc0['api_key'], acc0['api_secret'], env0)
            tickers = client.get_tickers(contract_types='call_options,put_options', underlying='BTC')
            ticker_map = {t['symbol']: t for t in tickers}
            
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
                
                underlying_symbol = 'BTC'
                parts = positions_list[0]['symbol'].split('-')
                if len(parts) >= 2:
                    underlying_symbol = parts[1]
                    
                exchange_positions = []
                active_symbols = set()
                if not is_paper:
                    try:
                        exchange_positions = trading_client.get_positions(underlying_asset_symbol=underlying_symbol)
                    except Exception as e:
                        print(f"Error fetching active positions for Decay2 reconciliation: {e}")
                        exchange_positions = None
                        
                    if exchange_positions is not None:
                        for ex_pos in exchange_positions:
                            ex_symbol = ex_pos.get('symbol') or ex_pos.get('product_symbol') or (ex_pos.get('product') and ex_pos['product'].get('symbol'))
                            ex_size = abs(int(ex_pos.get('size', 0)))
                            if ex_symbol and ex_size > 0:
                                active_symbols.add(ex_symbol)
                            
                has_closure_trigger = False
                trigger_reason = ""
                
                # Check for triggers (manual close requests or python-reconciled SL/TP hits)
                for pos in positions_list:
                    symbol = pos['symbol']
                    status = pos.get('status', 'open')
                    sl_price = safe_float(pos.get('sl_price'))
                    tp_price = safe_float(pos.get('tp_price'))
                    
                    ticker = ticker_map.get(symbol)
                    mark_price = 0.0
                    if ticker:
                        mark_price = safe_float(ticker.get('mark_price'))
                    
                    if status == 'close_requested':
                        has_closure_trigger = True
                        trigger_reason = "Manual Strangle Square-off requested from dashboard."
                        break
                    elif not is_paper and status == 'open' and exchange_positions is not None and symbol not in active_symbols:
                        has_closure_trigger = True
                        trigger_reason = f"Leg {symbol} was manually closed on Delta Exchange."
                        break
                    elif status == 'open' and mark_price > 0 and is_paper:
                        # Monitor Stop Loss
                        if sl_price > 0 and mark_price >= sl_price:
                            has_closure_trigger = True
                            trigger_reason = f"Leg {symbol} hit Stop Loss (Mark: {mark_price} >= SL: {sl_price}) (Paper)."
                            break
                        # Monitor Take Profit
                        if tp_price > 0 and mark_price <= tp_price:
                            has_closure_trigger = True
                            trigger_reason = f"Leg {symbol} hit Take Profit (Mark: {mark_price} <= TP: {tp_price}) (Paper)."
                            break
                        
                if has_closure_trigger:
                    log_trade_event(supabase, acc['name'], f"Decay2: Joint exit triggered -> {trigger_reason}", 'TRADE', 'decay2')
                    for pos in positions_list:
                        symbol = pos['symbol']
                        prod_id = pos['product_id']
                        size = pos['size']
                        
                        if is_paper:
                            try:
                                supabase.table('positions').update({
                                        'status': 'closed',
                                        'closed_at': datetime.datetime.now(datetime.timezone.utc).isoformat()
                                }).eq('id', pos['id']).execute()
                                log_trade_event(supabase, acc['name'], f"Decay2: Successfully closed simulated leg {symbol} (Paper).", 'TRADE', 'decay2')
                            except Exception as db_err:
                                print(f"Failed to update db status for simulated Decay2 leg {symbol}: {db_err}")
                        else:
                            if exchange_positions is not None and symbol in active_symbols:
                                try:
                                    trading_client.place_order(
                                        product_id=prod_id,
                                        size=size,
                                        side='buy',
                                        order_type='market_order',
                                        reduce_only=True
                                    )
                                    log_trade_event(supabase, acc['name'], f"Decay2: Successfully squared off remaining leg {symbol}.", 'TRADE', 'decay2')
                                except Exception as e:
                                    log_trade_event(supabase, acc['name'], f"Decay2: Failed to square off leg {symbol}: {e}", 'ERROR', 'decay2')
                            
                            # Pre-emptively clear any remaining bracket orders (SL/TP) on exchange for this contract to prevent false triggers
                            try:
                                trading_client.cancel_all_orders(product_id=prod_id)
                                log_trade_event(supabase, acc['name'], f"Decay2: Cancelled all resting brackets/orders for {symbol}.", 'INFO', 'decay2')
                            except Exception as cancel_err:
                                print(f"Notice: Failed to cancel resting orders for {symbol}: {cancel_err}")
                                    
                            try:
                                supabase.table('positions').update({
                                        'status': 'closed',
                                        'closed_at': datetime.datetime.now(datetime.timezone.utc).isoformat()
                                }).eq('id', pos['id']).execute()
                            except Exception as db_err:
                                print(f"Failed to update db status for Decay2 leg {symbol}: {db_err}")
                else:
                    # Update active marks and unrealized PnL based on Option Mark Price
                    for pos in positions_list:
                        symbol = pos['symbol']
                        entry_price = safe_float(pos['entry_price'])
                        size = pos['size']
                        
                        ticker = ticker_map.get(symbol)
                        if ticker:
                            mark_price = safe_float(ticker.get('mark_price'), entry_price)
                            multiplier = get_contract_multiplier(symbol)
                            unrealized_pnl = (entry_price - mark_price) * size * multiplier
                            
                            try:
                                supabase.table('positions').update({
                                    'mark_price': mark_price,
                                    'pnl': round(unrealized_pnl, 6)
                                }).eq('id', pos['id']).execute()
                            except Exception:
                                pass
                                
        except Exception as e:
            err_msg = str(e)
            if "Server disconnected" in err_msg or "Connection to Delta Exchange failed" in err_msg or "RemoteProtocolError" in err_msg:
                print("Notice: Temporary API connection timeout (Server disconnected). Retrying in 10s...")
            else:
                print(f"Error in Decay2 position monitor loop: {e}")
            
        time.sleep(10)
