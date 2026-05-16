/**
 * DataFetcher — fetches market data from public Binance API
 * Binance public endpoints do not require API keys
 */

const BINANCE_BASE = 'https://api.binance.com';

export class DataFetcher {
  constructor() {
    this.cache = {};
  }

  async fetchJSON(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Binance API ${resp.status}: ${resp.statusText}`);
    return resp.json();
  }

  async fetchKlines(symbol, interval = '15m', limit = 100) {
    const url = `${BINANCE_BASE}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const raw = await this.fetchJSON(url);
    return raw.map(k => ({
      time: Math.floor(k[0] / 1000),
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
  }

  async fetch24hrTicker() {
    const data = await this.fetchJSON(`${BINANCE_BASE}/api/v3/ticker/24hr`);
    return data.filter(t => t.symbol.endsWith('USDT')).map(t => ({
      symbol: t.symbol,
      price: parseFloat(t.lastPrice),
      change: parseFloat(t.priceChangePercent),
      volume: parseFloat(t.quoteVolume),
      high: parseFloat(t.highPrice),
      low: parseFloat(t.lowPrice),
    }));
  }

  async fetchTopPairs(limit = 30) {
    const tickers = await this.fetch24hrTicker();
    tickers.sort((a, b) => b.volume - a.volume);
    return tickers.slice(0, limit);
  }

  async fetchInitialData(symbol, interval = '15m', limit = 100) {
    const [klines, tickers] = await Promise.all([
      this.fetchKlines(symbol, interval, limit),
      this.fetchTopPairs(30),
    ]);
    return { klines, tickers };
  }
}
