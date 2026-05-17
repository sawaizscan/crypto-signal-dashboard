import express from 'express';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(__dirname, 'bot_data.json');

// === BINANCE FETCH (Node 18+ native) ===
const BINANCE = 'https://api.binance.com';

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function fetchKlines(symbol, interval = '1m', limit = 100) {
  const raw = await fetchJSON(`${BINANCE}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  return raw.map(k => ({
    time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2],
    low: +k[3], close: +k[4], volume: +k[5],
  }));
}

async function fetchTopPairs(limit = 30) {
  const data = await fetchJSON(`${BINANCE}/api/v3/ticker/24hr`);
  return data.filter(t => t.symbol.endsWith('USDT'))
    .map(t => ({ symbol: t.symbol, price: +t.lastPrice, change: +t.priceChangePercent, volume: +t.quoteVolume }))
    .sort((a, b) => b.volume - a.volume).slice(0, limit);
}

// === INDICATORS ===
function ema(vals, p) {
  const m = 2 / (p + 1); let e = vals[0]; const r = [e];
  for (const x of vals.slice(1)) { e = (x - e) * m + e; r.push(e); }
  return r;
}

function rsi(closes, p = 14) {
  const r = Array(closes.length).fill(null); let g = 0, l = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]; const gg = d > 0 ? d : 0; const ll = d < 0 ? -d : 0;
    if (i === 1) { g = gg; l = ll; }
    else { g = (g * (p - 1) + gg) / p; l = (l * (p - 1) + ll) / p; }
    if (i >= p) r[i] = l > 0 ? 100 - 100 / (1 + g / l) : 100;
  }
  return r;
}

function macd(closes) {
  const e12 = ema(closes, 12); const e26 = ema(closes, 26);
  const ml = e12.map((v, i) => v != null && e26[i] != null ? v - e26[i] : null);
  const sigVals = ml.filter(v => v != null); const sig = ema(sigVals, 9);
  const h = []; let si = 0;
  for (const v of ml) { h.push(v != null && si < sig.length ? v - sig[si++] : null); }
  return h;
}

function atr(candles, p = 14) {
  const r = [0]; for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close));
    r.push(i < p ? (r[i - 1] * i + tr) / (i + 1) : (r[i - 1] * (p - 1) + tr) / p);
  }
  return r;
}

function computeAllIndicators(candles) {
  const closes = candles.map(c => c.close);
  const e20 = ema(closes, 20); const e50 = ema(closes, 50);
  const rs = rsi(closes); const m = macd(closes); const at = atr(candles);
  const trend = e20[candles.length - 1] != null && e50[candles.length - 1] != null
    ? (e20[candles.length - 1] > e50[candles.length - 1] ? 'bullish' : 'bearish') : 'unknown';
  return { closes, ema20: e20, ema50: e50, rsi: rs, macd: { histogram: m }, atr: at, trend };
}

// === ADAPTIVE LEARNER (file-based for server) ===
class AdaptiveLearner {
  constructor() { this.fs = {}; this.ss = { w: 0, l: 0, cons: 0 }; this.load(); }
  load() {
    try {
      if (existsSync(DATA_FILE)) {
        const d = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
        if (d.fs) this.fs = d.fs; if (d.ss) this.ss = d.ss;
      }
    } catch {}
  }
  save() {
    try { writeFileSync(DATA_FILE, JSON.stringify({ fs: this.fs, ss: this.ss })); } catch {}
  }
  record(won, factors) {
    this.ss.w += won ? 1 : 0; this.ss.l += won ? 0 : 1;
    this.ss.cons = won ? 0 : (this.ss.cons || 0) + 1;
    for (const f of factors) {
      if (!this.fs[f]) this.fs[f] = { w: 0, l: 0 };
      if (won) this.fs[f].w++; else this.fs[f].l++;
    }
    this.save();
  }
  getWR() { const t = this.ss.w + this.ss.l; return t > 0 ? this.ss.w / t : 0.5; }
  shouldTrade() {
    if (this.getWR() < 0.20 && this.ss.w + this.ss.l > 15) return false;
    if (this.ss.cons >= 7) return false;
    return true;
  }
  getThr(base = 4) {
    const wr = this.getWR(); const cons = this.ss.cons || 0; let adj = base;
    if (wr < 0.30) adj += 4; else if (wr < 0.45) adj += 2;
    if (cons >= 4) adj += 3; return adj;
  }
}

// === SIGNAL ENGINE ===
class SignalEngine {
  constructor() { this.learner = new AdaptiveLearner(); this.lastSignals = {}; }
  get winRate() { return (this.learner.getWR() * 100).toFixed(0) + '%'; }

  generateSignal(pair, candles, ind) {
    const lastIdx = candles.length - 1;
    const price = ind.closes[lastIdx];
    if (!this.learner.shouldTrade()) return { type: 'NO TRADE', reason: 'Paused' };
    const thr = this.learner.getThr(4);
    const e20 = ind.ema20[lastIdx]; const e50 = ind.ema50[lastIdx];
    const rv = ind.rsi[lastIdx]; const h0 = ind.macd.histogram[lastIdx]; const h1 = ind.macd.histogram[lastIdx - 1];
    const atrV = ind.atr[lastIdx] || price * 0.0025;
    if (e20 == null || rv == null) return { type: 'NO TRADE', reason: 'No indicators' };

    const dev = ((price / e20) - 1) * 100;
    let score = 0, reasons = [], factors = [];

    if (dev < -0.08 && rv < 40) {
      factors.push('reversion'); score += 5;
      reasons.push(`Dev ${dev.toFixed(2)}%`);
      if (rv < 30) { score += 4; reasons.push('RSI extreme'); factors.push('rsi_extreme'); }
      else { score += 2; reasons.push('RSI oversold'); }
      if (h0 != null && h1 != null && h0 > h1) { score += 5; reasons.push('MACD up'); factors.push('macd_confirm'); }
      if (e20 != null && e50 != null && price < e20 && e20 < e50) { score += 3; reasons.push('Downtrend'); factors.push('downtrend_rev'); }
      if (candles[lastIdx].close > candles[lastIdx].open) { score += 2; reasons.push('Bullish'); factors.push('bull_candle'); }
      if (lastIdx >= 2 && candles[lastIdx].low < candles[lastIdx - 1].low && rv > ind.rsi[lastIdx - 1]) {
        score += 3; reasons.push('Divergence'); factors.push('divergence');
      }
    }
    if (dev > 0.08 && rv > 60) {
      factors.push('reversion'); score -= 5;
      reasons.push(`Dev +${dev.toFixed(2)}%`);
      if (rv > 70) { score -= 4; reasons.push('RSI extreme'); factors.push('rsi_extreme'); }
      else { score -= 2; reasons.push('RSI overbought'); }
      if (h0 != null && h1 != null && h0 < h1) { score -= 5; reasons.push('MACD down'); factors.push('macd_confirm'); }
      if (e20 != null && e50 != null && price > e20 && e20 > e50) { score -= 3; reasons.push('Uptrend'); factors.push('uptrend_rev'); }
      if (candles[lastIdx].close < candles[lastIdx].open) { score -= 2; reasons.push('Bearish'); factors.push('bear_candle'); }
      if (lastIdx >= 2 && candles[lastIdx].high > candles[lastIdx - 1].high && rv < ind.rsi[lastIdx - 1]) {
        score -= 3; reasons.push('Divergence'); factors.push('divergence');
      }
    }

    const type = score >= thr ? 'BUY' : score <= -thr ? 'SELL' : 'NO TRADE';
    const conf = type !== 'NO TRADE' ? Math.min(Math.max(Math.abs(score) * 2.5 + 20, 25), 95) : 0;
    const tp1 = type !== 'NO TRADE'
      ? (type === 'BUY' ? +(price + atrV * 0.8).toFixed(2) : +(price - atrV * 0.8).toFixed(2))
      : null;
    const sl = type !== 'NO TRADE'
      ? (type === 'BUY' ? +(price - atrV * 0.3).toFixed(2) : +(price + atrV * 0.3).toFixed(2))
      : null;

    return { pair, type, confidence: conf, score, price, sl, tp1, reasons: reasons.slice(0, 4), factors, dev: +dev.toFixed(2) };
  }
}

// === PAPER TRADER ===
class PaperTrader {
  constructor(balance = 10000) {
    this.cash = balance; this.initial = balance;
    this.positions = {}; this.trades = []; this.engine = null;
  }
  setEngine(e) { this.engine = e; }
  get equity() {
    let pv = 0;
    for (const p of Object.values(this.positions)) { pv += p.margin + (p.cp - p.ep) * p.q; }
    return this.cash + pv;
  }
  get pnl() { return +(this.equity - this.initial).toFixed(2); }
  get pnlPct() { return +((this.pnl / this.initial) * 100).toFixed(2); }
  get wr() {
    const c = this.trades.filter(t => t.pnl != null);
    return c.length ? +((c.filter(t => t.pnl > 0).length / c.length) * 100).toFixed(1) : 0;
  }

  exec(signal) {
    if (signal.type === 'NO TRADE' || signal.confidence < 15 || this.positions[signal.pair]) return null;
    const margin = this.cash * 0.30;
    if (margin < 1) return null;
    const qty = (margin * 10) / signal.price;
    if (qty <= 0) return null;

    this.cash -= margin;
    this.positions[signal.pair] = {
      q: qty, ep: signal.price, cp: signal.price, m: margin,
      sl: signal.sl, tp: signal.tp1, lev: 10, factors: signal.factors || [],
    };

    this.trades.push({
      type: signal.type, pair: signal.pair, price: signal.price, qty, margin,
      time: new Date().toISOString(), pnl: null, conf: signal.confidence,
      reasons: signal.reasons || [], factors: signal.factors || [],
    });
    return signal;
  }

  checkStops(prices) {
    const toClose = [];
    for (const [sym, pos] of Object.entries(this.positions)) {
      const p = prices[sym]; if (!p) continue;
      pos.cp = p;
      if (pos.sl && ((pos.ep < pos.sl && p <= pos.sl) || (pos.ep > pos.sl && p >= pos.sl))) toClose.push(sym);
      else if (pos.tp && ((pos.ep < pos.tp && p >= pos.tp) || (pos.ep > pos.tp && p <= pos.tp))) toClose.push(sym);
    }
    for (const sym of toClose) this.close(sym, prices[sym]);
    return toClose;
  }

  close(sym, price) {
    const pos = this.positions[sym]; if (!pos) return;
    const pnl = (price - pos.ep) * pos.q;
    this.cash += pos.m + pnl;
    const t = this.trades.filter(t => t.pnl == null && t.pair === sym).pop();
    if (t) { t.pnl = +pnl.toFixed(2); t.exitPrice = price; t.exitTime = new Date().toISOString(); }
    if (this.engine) this.engine.recordTradeOutcome(sym, pos.ep, price, pos.factors);
    delete this.positions[sym];
  }

  updatePrices(prices) {
    for (const [sym, p] of Object.entries(prices)) {
      if (this.positions[sym]) this.positions[sym].cp = p;
    }
  }
}

// === TRADE OUTCOME RECORDER (bridges SignalEngine + PaperTrader) ===
class TradeRecorder {
  constructor(engine) { this.engine = engine; }
  recordTradeOutcome(pair, entry, exit, factors) {
    this.engine.learner.record(exit > entry, factors);
  }
}

// === BOT ===
class Bot {
  constructor() {
    this.engine = new SignalEngine();
    this.trader = new PaperTrader(10000);
    this.recorder = new TradeRecorder(this.engine);
    this.trader.setEngine(this.recorder);
    this.signals = [];
    this.ticker = null;
    this.mainPair = 'SOLUSDT';
    this.running = false;
    this.cycleCount = 0;
    this.startTime = new Date().toISOString();
    this._signalsCache = [];
  }

  async start() {
    this.running = true;
    console.log(`Bot starting on ${this.mainPair} at ${this.startTime}`);
    await this.cycle();
    setInterval(() => this.cycle(), 5000);
  }

  async cycle() {
    try {
      this.cycleCount++;
      const tickers = await fetchTopPairs(30);
      this.ticker = tickers;

      const priceMap = {};
      for (const t of tickers) priceMap[t.symbol] = t.price;
      this.trader.updatePrices(priceMap);
      this.trader.checkStops(priceMap);

      // Main pair signal
      const klines = await fetchKlines(this.mainPair, '1m', 100);
      if (klines.length >= 30) {
        const ind = computeAllIndicators(klines);
        const sig = this.engine.generateSignal(this.mainPair, klines, ind);
        if (sig.type !== 'NO TRADE') {
          sig.pair = this.mainPair;
          this.trader.exec(sig);
        }
        this.signals.push({ ...sig, pair: this.mainPair, time: new Date().toISOString() });
      }

      // Scan top pairs
      const scanPromises = tickers.slice(0, 10).map(async t => {
        try {
          const k = await fetchKlines(t.symbol, '1m', 100);
          if (k.length < 30) return null;
          const ind = computeAllIndicators(k);
          const sig = this.engine.generateSignal(t.symbol, k, ind);
          if (sig.type !== 'NO TRADE') {
            sig.pair = t.symbol;
            return this.trader.exec(sig) || sig;
          }
          return sig;
        } catch { return null; }
      });
      const results = (await Promise.all(scanPromises)).filter(Boolean);
      this._signalsCache = results.filter(s => s && s.type !== 'NO TRADE').slice(0, 10);

      if (this.signals.length > 500) this.signals = this.signals.slice(-500);
    } catch (err) {
      console.error('Cycle error:', err.message);
    }
  }

  getStatus() {
    return {
      running: this.running,
      mainPair: this.mainPair,
      uptime: Math.floor((Date.now() - new Date(this.startTime).getTime()) / 1000),
      cycles: this.cycleCount,
      equity: this.trader.equity.toFixed(2),
      cash: this.trader.cash.toFixed(2),
      pnl: this.trader.pnl,
      pnlPct: this.trader.pnlPct,
      winRate: this.trader.wr,
      trades: this.trader.trades.length,
      openPositions: Object.keys(this.trader.positions).length,
      botWR: this.engine.winRate,
    };
  }

  getSignals() { return this._signalsCache; }
  getTrades() { return this.trader.trades.filter(t => t.pnl != null).reverse().slice(0, 100); }
  getPositions() {
    return Object.entries(this.trader.positions).map(([sym, p]) => ({
      symbol: sym, entry: p.ep, price: p.cp, pnl: +((p.cp - p.ep) * p.q).toFixed(2),
      margin: p.m, leverage: p.lev, sl: p.sl, tp: p.tp,
    }));
  }
}

// === EXPRESS SERVER ===
const app = express();
const PORT = process.env.PORT || 3001;

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.get('/api/status', (req, res) => res.json(bot.getStatus()));
app.get('/api/signals', (req, res) => res.json(bot.getSignals()));
app.get('/api/trades', (req, res) => res.json(bot.getTrades()));
app.get('/api/positions', (req, res) => res.json(bot.getPositions()));
app.get('/api/ticker', (req, res) => res.json(bot.ticker || []));
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

const bot = new Bot();
bot.start().then(() => {
  app.listen(PORT, () => console.log(`CryptoSignal Bot API running on port ${PORT}`));
});
