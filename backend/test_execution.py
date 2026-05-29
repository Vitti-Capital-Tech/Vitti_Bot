import sys
from supabase import create_client, Client
import config
from strategy_decay1 import execute_decay1_entry
from strategy_decay2 import execute_decay2_entry

def test_run():
    strategy_name = 'decay1'
    if len(sys.argv) > 1:
        strategy_name = sys.argv[1].lower()
        
    if strategy_name not in ['decay1', 'decay2']:
        print(f"Error: Unknown strategy '{strategy_name}'. Use 'decay1' or 'decay2'.")
        sys.exit(1)

    print("==========================================")
    print(f"  DeltaTrade Manual Execution Test Runner ")
    print(f"  Strategy: {strategy_name.upper()}        ")
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
        
    print(f"\nTriggering {strategy_name.upper()} Strategy Entry immediately...")
    try:
        if strategy_name == 'decay2':
            execute_decay2_entry(supabase)
        else:
            execute_decay1_entry(supabase)
        print("\nManual execution run finished. Check your Dashboard or Terminals for logs and open positions!")
    except Exception as e:
        print(f"\nExecution failed: {e}")

if __name__ == "__main__":
    test_run()
