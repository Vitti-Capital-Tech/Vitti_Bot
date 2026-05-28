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

    # 2. Start Background Position Monitor Thread
    # Monitors target spot prices (0.75% move) and updates mark prices/PnL
    monitor_thread = threading.Thread(
        target=monitor_positions_loop,
        args=(supabase,),
        daemon=True
    )
    monitor_thread.start()

    # 3. Configure APScheduler with India Standard Time
    tz = timezone(config.TIMEZONE)
    scheduler = BlockingScheduler(timezone=tz)
    
    # Schedule Decay1 Entry: Monday to Friday at 08:31 AM IST
    scheduler.add_job(
        func=execute_decay1_entry,
        trigger='cron',
        day_of_week='mon-fri',
        hour=8,
        minute=31,
        args=[supabase],
        name='decay1_entry'
    )
    print("Scheduled Decay1 entry job: Monday-Friday at 08:31 IST.")
    
    # Schedule Decay1 Exit: Monday to Friday at 12:29 PM IST
    scheduler.add_job(
        func=execute_decay1_exit,
        trigger='cron',
        day_of_week='mon-fri',
        hour=12,
        minute=29,
        args=[supabase],
        name='decay1_exit'
    )
    print("Scheduled Decay1 exit job: Monday-Friday at 12:29 IST.")

    # 4. Launch Scheduler
    log_trade_event(supabase, 'SYSTEM', 'All execution schedules configured. Scheduler starting...', 'INFO')
    try:
        scheduler.start()
    except (KeyboardInterrupt, SystemExit):
        log_trade_event(supabase, 'SYSTEM', 'Trading Bot daemon shutting down gracefully.', 'INFO')
        print("Daemon stopped.")

if __name__ == "__main__":
    main()
