/**
 * BinanceTestnet — signed order execution on Binance Futures Testnet
 * Uses Web Crypto API for HMAC-SHA256 signing (no external crypto libs needed)
 * Testnet: https://demo-fapi.binance.com
 * Register keys at: https://testnet.binancefuture.com/
 */

const TESTNET_BASE = 'https://demo-fapi.binance.com';

export class BinanceTestnet {
  constructor() {
    this.apiKey = '';
    this.secretKey = '';
    this.connected = false;
    this.account = null;
  }

  isConfigured() {
    return this.apiKey.length > 0 && this.secretKey.length > 0;
  }

  async importKey() {
    const encoder = new TextEncoder();
    return crypto.subtle.importKey(
      'raw',
      encoder.encode(this.secretKey),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
  }

  async sign(queryString) {
    const key = await this.importKey();
    const encoder = new TextEncoder();
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(queryString));
    return Array.from(new Uint8Array(signature))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  async signedRequest(method, path, params = {}) {
    params.timestamp = Date.now();
    params.recvWindow = 10000;

    const queryString = Object.entries(params)
      .map(([k, v]) => `${k}=${v}`)
      .join('&');

    const signature = await this.sign(queryString);
    const fullUrl = `${TESTNET_BASE}${path}?${queryString}&signature=${signature}`;

    const resp = await fetch(fullUrl, {
      method,
      headers: {
        'X-MBX-APIKEY': this.apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    if (!resp.ok) {
      const errorBody = await resp.text();
      throw new Error(`Testnet API ${resp.status}: ${errorBody}`);
    }

    return resp.json();
  }

  async setKeys(apiKey, secretKey) {
    this.apiKey = apiKey.trim();
    this.secretKey = secretKey.trim();
    this.connected = false;
    this.account = null;

    if (!this.isConfigured()) return false;

    try {
      const info = await this.signedRequest('GET', '/fapi/v2/account');
      this.account = info;
      this.connected = true;
      return true;
    } catch (err) {
      this.connected = false;
      this.account = null;
      throw err;
    }
  }

  disconnect() {
    this.apiKey = '';
    this.secretKey = '';
    this.connected = false;
    this.account = null;
  }

  getBalance() {
    if (!this.account || !this.account.assets) return 0;
    const usdt = this.account.assets.find(a => a.asset === 'USDT');
    return usdt ? parseFloat(usdt.walletBalance) : 0;
  }

  async placeMarketOrder(symbol, side, quantity) {
    if (!this.connected) throw new Error('Testnet not connected');

    const result = await this.signedRequest('POST', '/fapi/v1/order', {
      symbol,
      side,
      type: 'MARKET',
      quantity: quantity.toFixed(4),
    });

    return {
      orderId: result.orderId,
      symbol: result.symbol,
      side: result.side,
      executedQty: parseFloat(result.executedQty || result.origQty),
      price: parseFloat(result.avgPrice || 0),
      status: result.status,
    };
  }

  async setLeverage(symbol, leverage) {
    if (!this.connected) throw new Error('Testnet not connected');
    return this.signedRequest('POST', '/fapi/v1/leverage', {
      symbol,
      leverage,
    });
  }

  async fetchTestnetKlines(symbol, interval = '15m', limit = 100) {
    const url = `${TESTNET_BASE}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Testnet klines ${resp.status}`);
    const raw = await resp.json();
    return raw.map(k => ({
      time: Math.floor(k[0] / 1000),
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
  }
}
