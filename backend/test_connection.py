import sys
from supabase import create_client, Client
import config
from delta_client import DeltaClient

def test_api_connection():
    print("==========================================")
    print("   Delta Exchange API Authentication Test ")
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

    # Fetch active accounts
    accounts_res = supabase.table('accounts').select('*').eq('is_active', True).execute()
    accounts = accounts_res.data

    if not accounts:
        print("Error: No active trading accounts found in Supabase.")
        sys.exit(1)

    print(f"Found {len(accounts)} active account(s) in Supabase.")

    for acc in accounts:
        name = acc['name']
        env = acc['env']
        api_key = acc['api_key']
        api_secret = acc['api_secret']
        
        print(f"\nTesting connection for Account: '{name}' | Env: {env}...")
        
        try:
            # Mask the keys for safety in logs
            masked_key = api_key[:6] + "..." + api_key[-4:] if api_key else "None"
            print(f"API Key: {masked_key}")
            
            client = DeltaClient(api_key, api_secret, env)
            
            # Fetch products or positions (a private API call that requires auth)
            print("Fetching active positions as an authentication check...")
            positions = client.get_positions(underlying_asset_symbol='BTC')
            
            print(f"SUCCESS! Connection validated for '{name}'.")
            print(f"Number of active positions returned: {len(positions)}")
            
        except Exception as e:
            print(f"FAILURE for '{name}': {e}")

if __name__ == "__main__":
    test_api_connection()
