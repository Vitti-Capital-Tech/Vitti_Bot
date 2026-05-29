import time
import hmac
import hashlib
import json
import requests
from typing import Dict, Any, Optional, List

class DeltaClient:
    """
    Python client wrapper for Delta Exchange India API V2.
    Handles HMAC-SHA256 request signing and provides helper methods
    for public and authenticated endpoints.
    """
    def __init__(self, api_key: str, api_secret: str, env: str = 'production'):
        self.api_key = api_key
        self.api_secret = api_secret
        self.env = env.lower()
        
        # Base URLs for production and testnet environments
        if self.env == 'production':
            self.base_url = 'https://api.india.delta.exchange'
        elif self.env == 'testnet':
            self.base_url = 'https://cdn-ind.testnet.deltaex.org'
        else:
            raise ValueError(f"Invalid environment '{env}'. Use 'production' or 'testnet'.")

    def _generate_signature(self, method: str, timestamp: str, path: str, query_string: str, payload: str) -> str:
        """
        Generates HMAC-SHA256 hex digest signature required by Delta India API.
        """
        signature_data = method + timestamp + path + query_string + payload
        message = bytes(signature_data, 'utf-8')
        secret = bytes(self.api_secret, 'utf-8')
        hash_obj = hmac.new(secret, message, hashlib.sha256)
        return hash_obj.hexdigest()

    def request(self, method: str, path: str, query_params: Optional[Dict[str, Any]] = None, payload: Optional[Dict[str, Any]] = None) -> Any:
        """
        Performs authenticated HTTP requests, signing them with credentials.
        """
        url = f"{self.base_url}{path}"
        method = method.upper()
        
        # Format Query String (must start with ? if parameters exist)
        query_string = ''
        if query_params:
            # Sort keys to ensure deterministic query string generation for signing
            sorted_params = sorted(query_params.items())
            encoded_params = requests.compat.urlencode(sorted_params)
            query_string = f"?{encoded_params}"
        
        # Format Payload
        payload_str = ''
        if payload is not None:
            payload_str = json.dumps(payload, separators=(',', ':')) # compact encoding
            
        # Create Timestamp & Signature
        timestamp = str(int(time.time()))
        signature = self._generate_signature(method, timestamp, path, query_string, payload_str)
        
        headers = {
            'api-key': self.api_key,
            'timestamp': timestamp,
            'signature': signature,
            'User-Agent': 'python-rest-client',
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        }
        
        # Make the request
        try:
            if method == 'GET':
                response = requests.get(url, params=query_params, headers=headers, timeout=10)
            elif method == 'POST':
                response = requests.post(url, data=payload_str, params=query_params, headers=headers, timeout=10)
            elif method == 'PUT':
                response = requests.put(url, data=payload_str, params=query_params, headers=headers, timeout=10)
            elif method == 'DELETE':
                response = requests.delete(url, data=payload_str, params=query_params, headers=headers, timeout=10)
            else:
                raise ValueError(f"Unsupported HTTP method: {method}")
        except requests.exceptions.RequestException as e:
            raise RuntimeError(f"Connection to Delta Exchange failed: {e}")
            
        # Handle Response
        if response.status_code == 200:
            res_data = response.json()
            if res_data.get('success'):
                return res_data.get('result')
            else:
                error_msg = res_data.get('error', {})
                raise RuntimeError(f"API Error: {error_msg.get('code', 'unknown_error')} - {error_msg.get('context', '')}")
        else:
            try:
                err_data = response.json()
                raise RuntimeError(f"HTTP Error {response.status_code}: {err_data.get('error', err_data)}")
            except Exception:
                raise RuntimeError(f"HTTP Error {response.status_code}: {response.text}")

    # ==========================================
    # PUBLIC ENDPOINTS
    # ==========================================
    def get_tickers(self, contract_types: Optional[str] = None, underlying: Optional[str] = None, expiry_date: Optional[str] = None) -> List[Dict[str, Any]]:
        """
        Fetches live tickers for active trading contracts.
        To fetch option chains: contract_types='call_options,put_options'
        """
        url = f"{self.base_url}/v2/tickers"
        params = {}
        if contract_types:
            params['contract_types'] = contract_types
        if underlying:
            params['underlying_asset_symbols'] = underlying
        if expiry_date:
            params['expiry_date'] = expiry_date
            
        try:
            response = requests.get(url, params=params, timeout=10)
            if response.status_code == 200:
                res_data = response.json()
                if res_data.get('success'):
                    return res_data.get('result')
                else:
                    raise RuntimeError(f"API Error: {res_data.get('error')}")
            else:
                raise RuntimeError(f"HTTP Error {response.status_code}: {response.text}")
        except requests.exceptions.RequestException as e:
            raise RuntimeError(f"Public market data request failed: {e}")

    # ==========================================
    # PRIVATE ENDPOINTS
    # ==========================================
    def get_balances(self) -> List[Dict[str, Any]]:
        """
        Fetches account wallet balances.
        """
        return self.request('GET', '/v2/wallet/balances')

    def get_positions(self, underlying_asset_symbol: Optional[str] = None) -> List[Dict[str, Any]]:
        """
        Fetches current active margined positions.
        """
        query_params = {}
        if underlying_asset_symbol:
            query_params['underlying_asset_symbol'] = underlying_asset_symbol
        return self.request('GET', '/v2/positions', query_params=query_params)

    def place_order(self, 
                    product_id: int, 
                    size: int, 
                    side: str, 
                    order_type: str = 'market_order', 
                    limit_price: Optional[str] = None, 
                    sl_price: Optional[str] = None, 
                    tp_price: Optional[str] = None, 
                    client_order_id: Optional[str] = None) -> Dict[str, Any]:
        """
        Places a new order on Delta Exchange.
        If sl_price or tp_price are provided, it automatically attaches them as native bracket legs.
        """
        payload = {
            "product_id": int(product_id),
            "size": int(size),
            "side": side.lower(),
            "order_type": order_type,
            "reduce_only": False,
            "time_in_force": "gtc"
        }
        
        if limit_price is not None:
            payload["limit_price"] = str(limit_price)
        if client_order_id is not None:
            payload["client_order_id"] = str(client_order_id)
            
        # Add Stop Loss Bracket Condition
        if sl_price is not None:
            payload["bracket_stop_loss_price"] = str(sl_price)
            payload["bracket_stop_trigger_method"] = "last_traded_price"
            
        # Add Take Profit Bracket Condition
        if tp_price is not None:
            payload["bracket_take_profit_price"] = str(tp_price)
            payload["bracket_stop_trigger_method"] = "last_traded_price"  # trigger method matches stop trigger
            
        return self.request('POST', '/v2/orders', payload=payload)

    def cancel_order(self, product_id: int, order_id: Optional[int] = None, client_order_id: Optional[str] = None) -> Dict[str, Any]:
        """
        Cancels a pending/resting order.
        """
        payload = {
            "product_id": int(product_id)
        }
        if order_id is not None:
            payload["id"] = int(order_id)
        if client_order_id is not None:
            payload["client_order_id"] = str(client_order_id)
            
        return self.request('DELETE', '/v2/orders', payload=payload)

    def cancel_all_orders(self, product_id: Optional[int] = None) -> Dict[str, Any]:
        """
        Cancels all open orders (including conditional bracket orders).
        """
        payload = {}
        if product_id is not None:
            payload["product_id"] = int(product_id)
        return self.request('DELETE', '/v2/orders/all', payload=payload)
