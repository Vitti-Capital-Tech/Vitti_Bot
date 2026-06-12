import sys
import time
import threading
from datetime import datetime
from pytz import timezone
from apscheduler.schedulers.blocking import BlockingScheduler
from supabase import create_client, Client
import config
from strategy_decay1 import (
    execute_decay1_entry,
    execute_decay1_exit,
    monitor_positions_loop,
    log_trade_event
)
from strategy_decay2 import (
    execute_decay2_entry,
    execute_decay2_exit,
    monitor_positions_loop_decay2
)

def balance_update_loop(supabase: Client):
    """
    Periodically fetches account balances from Delta Exchange and updates
    the 'name' column in Supabase with the format: 'BaseName|Balance'.
    """
    from delta_client import DeltaClient
    import time
    print("Starting background balance monitor thread...")
    while True:
        try:
            # Fetch all accounts (active or inactive, so we update all linked accounts)
            accounts_res = supabase.table('accounts').select('*').execute()
            if not accounts_res.data:
                time.sleep(30)
                continue
                
            for acc in accounts_res.data:
                name = acc['name']
                # Get base name by stripping any existing balance suffix
                base_name = name.split('|')[0]
                
                balance = 0.0
                is_paper = (acc['env'] == 'paper')
                
                if is_paper:
                    balance = 10000.0  # Paper starting capital
                else:
                    client_env = 'production' if acc['env'] == 'paper' else acc['env']
                    client = DeltaClient(acc['api_key'], acc['api_secret'], client_env)
                    try:
                        balances = client.get_balances()
                        # Find USD balance
                        usd_bal = None
                        for b in balances:
                            if b.get('asset_symbol') == 'USD':
                                usd_bal = float(b.get('balance', 0.0))
                                break
                        if usd_bal is not None:
                            balance = usd_bal
                        elif balances:
                            balance = float(balances[0].get('balance', 0.0))
                    except Exception as e:
                        print(f"Error fetching balance for {base_name}: {e}")
                        continue  # Skip updating if API call failed
                
                # Format new name
                new_name = f"{base_name}|{balance:.2f}"
                if new_name != name:
                    try:
                        supabase.table('accounts').update({'name': new_name}).eq('id', acc['id']).execute()
                    except Exception as e:
                        print(f"Error updating name with balance for {base_name}: {e}")
                        
        except Exception as e:
            print(f"Error in balance update loop: {e}")
            
        time.sleep(30)

def main():
    print("==========================================")
    print("  DeltaTrade Automated Execution Service  ")
    print("==========================================")
    
    # 1. Initialize Supabase Connection
    if not config.SUPABASE_URL or not config.SUPABASE_KEY:
        print("Error: Supabase credentials not found in environment.")
        sys.exit(1)
        
    try:
        supabase: Client = create_client(config.SUPABASE_URL, config.SUPABASE_KEY)
        print("Connected to Supabase successfully.")
    except Exception as e:
        print(f"Error connecting to Supabase: {e}")
        sys.exit(1)
        
    # Log starting up event
    log_trade_event(supabase, 'SYSTEM', 'Trading Bot daemon starting up...', 'INFO')

    # 2. Start Background Position Monitor Threads (Decay1 and Decay2)
    # Monitors target spot prices (0.75% move) and updates mark prices/PnL
    monitor_thread_d1 = threading.Thread(
        target=monitor_positions_loop,
        args=(supabase,),
        daemon=True
    )
    monitor_thread_d1.start()
    print("Started Decay1 position monitor thread.")

    monitor_thread_d2 = threading.Thread(
        target=monitor_positions_loop_decay2,
        args=(supabase,),
        daemon=True
    )
    monitor_thread_d2.start()
    print("Started Decay2 position monitor thread.")

    # Start Balance Update thread
    balance_thread = threading.Thread(
        target=balance_update_loop,
        args=(supabase,),
        daemon=True
    )
    balance_thread.start()
    print("Started background account balance synchronizer thread.")

    # 3. Configure APScheduler with India Standard Time
    tz = timezone(config.TIMEZONE)
    scheduler = BlockingScheduler(timezone=tz)
    
    # 4. Fetch dynamic strategy execution times from Supabase
    strategies_res = supabase.table('strategies').select('*').execute()
    strategies = {s['name']: s for s in strategies_res.data} if strategies_res.data else {}
    
    def parse_time_ist(time_str: str, default_hour: int, default_min: int):
        if not time_str:
            return default_hour, default_min
        try:
            parts = time_str.split(':')
            return int(parts[0]), int(parts[1])
        except Exception:
            return default_hour, default_min

    # --- Schedule Decay1 ---
    d1 = strategies.get('decay1', {})
    d1_entry_h, d1_entry_m = parse_time_ist(d1.get('entry_time_ist'), 8, 31)
    d1_exit_h, d1_exit_m = parse_time_ist(d1.get('exit_time_ist'), 12, 29)

    scheduler.add_job(
        func=execute_decay1_entry,
        trigger='cron',
        day_of_week='mon-fri',
        hour=d1_entry_h,
        minute=d1_entry_m,
        args=[supabase],
        name='decay1_entry'
    )
    print(f"Scheduled Decay1 entry job: Monday-Friday at {d1_entry_h:02d}:{d1_entry_m:02d} IST.")
    
    scheduler.add_job(
        func=execute_decay1_exit,
        trigger='cron',
        day_of_week='mon-fri',
        hour=d1_exit_h,
        minute=d1_exit_m,
        args=[supabase],
        name='decay1_exit'
    )
    print(f"Scheduled Decay1 exit job: Monday-Friday at {d1_exit_h:02d}:{d1_exit_m:02d} IST.")

    # --- Schedule Decay2 ---
    d2 = strategies.get('decay2', {})
    d2_entry_h, d2_entry_m = parse_time_ist(d2.get('entry_time_ist'), 13, 31)
    d2_exit_h, d2_exit_m = parse_time_ist(d2.get('exit_time_ist'), 17, 29)

    scheduler.add_job(
        func=execute_decay2_entry,
        trigger='cron',
        day_of_week='mon-fri',
        hour=d2_entry_h,
        minute=d2_entry_m,
        args=[supabase],
        name='decay2_entry'
    )
    print(f"Scheduled Decay2 entry job: Monday-Friday at {d2_entry_h:02d}:{d2_entry_m:02d} IST.")
    
    scheduler.add_job(
        func=execute_decay2_exit,
        trigger='cron',
        day_of_week='mon-fri',
        hour=d2_exit_h,
        minute=d2_exit_m,
        args=[supabase],
        name='decay2_exit'
    )
    print(f"Scheduled Decay2 exit job: Monday-Friday at {d2_exit_h:02d}:{d2_exit_m:02d} IST.")


    # 4. Launch Scheduler
    log_trade_event(supabase, 'SYSTEM', 'All execution schedules configured. Scheduler starting...', 'INFO')
    try:
        scheduler.start()
    except (KeyboardInterrupt, SystemExit):
        log_trade_event(supabase, 'SYSTEM', 'Trading Bot daemon shutting down gracefully.', 'INFO')
        print("Daemon stopped.")

if __name__ == "__main__":
    main()
