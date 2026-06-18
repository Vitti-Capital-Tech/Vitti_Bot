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
        
        # Format Query String (must start with ? if parameters exist for signature & URL)
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
        
        # Construct full URL with query string
        full_url = f"{url}{query_string}"
        
        # Make the request
        try:
            if method == 'GET':
                response = requests.get(full_url, headers=headers, timeout=10)
            elif method == 'POST':
                response = requests.post(full_url, data=payload_str, headers=headers, timeout=10)
            elif method == 'PUT':
                response = requests.put(full_url, data=payload_str, headers=headers, timeout=10)
            elif method == 'DELETE':
                response = requests.delete(full_url, data=payload_str, headers=headers, timeout=10)
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
                    client_order_id: Optional[str] = None,
                    stop_trigger_method: str = 'mark_price',
                    reduce_only: bool = False) -> Dict[str, Any]:
        """
        Places a new order on Delta Exchange.
        If sl_price or tp_price are provided, it automatically attaches them as native bracket legs.
        """
        payload = {
            "product_id": int(product_id),
            "size": int(size),
            "side": side.lower(),
            "order_type": order_type,
            "reduce_only": reduce_only,
            "time_in_force": "gtc"
        }
        
        if limit_price is not None:
            payload["limit_price"] = str(limit_price)
        if client_order_id is not None:
            payload["client_order_id"] = str(client_order_id)
            
        # Add Stop Loss Bracket Condition
        if sl_price is not None:
            payload["bracket_stop_loss_price"] = str(sl_price)
            payload["bracket_stop_trigger_method"] = stop_trigger_method
            
        # Add Take Profit Bracket Condition (only set trigger method if no SL, to avoid overwrite)
        if tp_price is not None:
            payload["bracket_take_profit_price"] = str(tp_price)
            if sl_price is None:
                payload["bracket_stop_trigger_method"] = stop_trigger_method
            
        return self.request('POST', '/v2/orders', payload=payload)

    def place_order_with_brackets(self,
                                  product_id: int,
                                  size: int,
                                  side: str,
                                  order_type: str = 'market_order',
                                  limit_price: Optional[str] = None,
                                  sl_price: Optional[str] = None,
                                  sl_trigger_method: str = 'mark_price',
                                  tp_price: Optional[str] = None,
                                  tp_trigger_method: str = 'spot_price',
                                  client_order_id: Optional[str] = None,
                                  reduce_only: bool = False) -> Dict[str, Any]:
        """
        Places a new order on Delta Exchange with separate trigger methods for SL and TP brackets.
        - sl_trigger_method: 'mark_price' for options SL (default)
        - tp_trigger_method: 'spot_price' for index-based TP (default)
        
        Uses the full bracket_orders structure allowing independent SL/TP trigger methods.
        """
        payload = {
            "product_id": int(product_id),
            "size": int(size),
            "side": side.lower(),
            "order_type": order_type,
            "reduce_only": reduce_only,
            "time_in_force": "gtc"
        }
        
        if limit_price is not None:
            payload["limit_price"] = str(limit_price)
        if client_order_id is not None:
            payload["client_order_id"] = str(client_order_id)

        # Attach Stop Loss bracket (mark_price trigger) 
        if sl_price is not None:
            payload["bracket_stop_loss_price"] = str(sl_price)
            payload["bracket_stop_trigger_method"] = sl_trigger_method

        # Attach Take Profit bracket (spot_price/index trigger)
        if tp_price is not None:
            # Only attach TP natively if trigger methods are identical or SL is not present
            if sl_price is None or sl_trigger_method == tp_trigger_method:
                payload["bracket_take_profit_price"] = str(tp_price)
                if sl_price is None:
                    payload["bracket_stop_trigger_method"] = tp_trigger_method

        result = self.request('POST', '/v2/orders', payload=payload)

        # If both SL and TP are needed with DIFFERENT trigger methods, attach TP as a separate reduce_only order.
        # SL is already attached via bracket_stop_loss_price (mark_price).
        # TP needs to be a separate conditional order using stop_price triggered on spot_price.
        if sl_price is not None and tp_price is not None and sl_trigger_method != tp_trigger_method:
            try:
                tp_payload = {
                    "product_id": int(product_id),
                    "size": int(size),
                    "side": "buy" if side.lower() == "sell" else "sell",
                    "order_type": "limit_order",
                    "limit_price": str(tp_price),
                    "stop_price": str(tp_price),
                    "stop_order_type": "take_profit_order",
                    "stop_trigger_method": tp_trigger_method,
                    "reduce_only": True
                }
                self.request('POST', '/v2/orders', payload=tp_payload)
            except Exception as tp_err:
                # TP attachment failed - monitor loop will handle it
                print(f"Notice: Failed to attach separate TP order: {tp_err}")

        return result

    def attach_sl_tp(self,
                     product_id: int,
                     size: int,
                     sl_price: Optional[str] = None,
                     sl_trigger_method: str = 'mark_price',
                     tp_price: Optional[str] = None,
                     tp_trigger_method: str = 'spot_price') -> Dict[str, Any]:
        """
        Attaches Stop Loss and/or Take Profit as separate conditional orders
        after a position has been filled. This is the only reliable way to have
        SL triggered on mark_price and TP triggered on spot_price (index) independently.

        Call this right after place_order() once the main order fills.
        """
        results = {}

        # Attach Stop Loss: triggered on mark_price
        if sl_price is not None:
            # limit_price set to 1.5x trigger to ensure fill even if market gaps past trigger
            sl_limit_price = str(round(float(sl_price) * 1.5, 2))
            sl_payload = {
                "product_id": int(product_id),
                "size": int(size),
                "side": "buy",   # closing a short position
                "order_type": "limit_order",
                "limit_price": sl_limit_price,
                "stop_price": str(sl_price),
                "stop_order_type": "stop_loss_order",
                "stop_trigger_method": sl_trigger_method,
                "reduce_only": True
            }
            try:
                results['sl'] = self.request('POST', '/v2/orders', payload=sl_payload)
            except Exception as e:
                results['sl_error'] = str(e)

        # Attach Take Profit: triggered on spot_price (index)
        if tp_price is not None:
            tp_payload = {
                "product_id": int(product_id),
                "size": int(size),
                "side": "buy",   # closing a short position
                "order_type": "limit_order",
                "limit_price": str(tp_price),
                "stop_price": str(tp_price),
                "stop_order_type": "take_profit_order",
                "stop_trigger_method": tp_trigger_method,
                "reduce_only": True
            }
            try:
                results['tp'] = self.request('POST', '/v2/orders', payload=tp_payload)
            except Exception as e:
                results['tp_error'] = str(e)

        return results

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

    def get_futures_price(self, symbol: str = 'BTCUSD') -> float:
        """
        Fetches the current futures mark price for a given symbol (e.g. 'BTCUSD' perpetual).
        Uses the public GET /v2/tickers/{symbol} endpoint — no auth required.
        Returns 0.0 if the request fails.
        """
        url = f"{self.base_url}/v2/tickers/{symbol}"
        try:
            response = requests.get(url, timeout=10)
            if response.status_code == 200:
                res_data = response.json()
                if res_data.get('success'):
                    result = res_data.get('result', {})
                    return float(result.get('mark_price', 0.0) or 0.0)
            return 0.0
        except Exception:
            return 0.0

    def cancel_all_orders(self, product_id: Optional[int] = None) -> Dict[str, Any]:
        """
        Cancels all open orders and any pending conditional/stop orders.
        """
        delete_params = {}
        if product_id is not None:
            delete_params["product_id"] = int(product_id)
        
        # 1. Cancel standard open orders
        res = {}
        try:
            res = self.request('DELETE', '/v2/orders/all', query_params=delete_params)
        except Exception as e:
            print(f"Notice: cancel_all_orders DELETE standard failed: {e}")
        
        # 2. Cancel pending stop/conditional orders (like TP and SL)
        try:
            query_params = {"states": "open,pending"}
            if product_id is not None:
                query_params["product_id"] = int(product_id)
            pending_orders = self.request('GET', '/v2/orders', query_params=query_params)
            if isinstance(pending_orders, list):
                for o in pending_orders:
                    o_id = o.get('id')
                    o_prod_id = o.get('product_id')
                    if o_id and o_prod_id:
                        # Client-side safety filter: skip orders of other products
                        if product_id is not None and int(o_prod_id) != int(product_id):
                            continue
                        try:
                            self.cancel_order(product_id=int(o_prod_id), order_id=int(o_id))
                        except Exception as e:
                            print(f"Notice: Failed to cancel individual pending order {o_id}: {e}")
        except Exception as e:
            print(f"Notice: Failed to clear pending conditional orders list: {e}")
            
        return res
