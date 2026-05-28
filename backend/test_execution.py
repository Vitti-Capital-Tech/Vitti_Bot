import sys
from supabase import create_client, Client
import config
from strategy_decay1 import execute_decay1_entry

def test_run():
    print("==========================================")
    print("  DeltaTrade Manual Execution Test Runner ")
    print("==========================================")
    
    if not config.SUPABASE_URL or not config.SUPABASE_KEY:
        print("Error: Supabase credentials not found in environment.")
        sys.exit(1)
        
    try:
        supabase: Client = create_client(config.SUPABASE_URL, config.SUPABASE_KEY)
        print("Connected to Supabase successfully.")
    except Exception as e:
        print(f"Error connecting to Supabase: {e}")
        sys.exit(1)
        
    print("\nTriggering Decay1 Strategy Entry immediately...")
    try:
        execute_decay1_entry(supabase)
        print("\nManual execution run finished. Check your Dashboard or Terminals for logs and open positions!")
    except Exception as e:
        print(f"\nExecution failed: {e}")

if __name__ == "__main__":
    test_run()
