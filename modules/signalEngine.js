/**
 * SignalEngine — HFT scalping engine with adaptive learning
 * Generates high-frequency signals on 1m timeframe
 */

import { computeAllIndicators } from './indicators.js';

const ADAPT_STORAGE_KEY = 'crypto_adaptive_weights';

class AdaptiveWeights {
  constructor() {
    this.weights = { momentum: 20, ema: 18, rsi: 16, macd: 14, pa: 12, volume: 10 };
    this.performance = {};
    for (const k of Object.keys(this.weights)) this.performance[k] = { correct: 0, total: 0 };
    this.load();
  }

  load() {
    try {
      const saved = localStorage.getItem(ADAPT_STORAGE_KEY);
      if (saved) {
        const data = JSON.parse(saved);
        if (data.weights) this.weights = data.weights;
        if (data.performance) this.performance = data.performance;
      }
    } catch {}
  }

  save() {
    try {
      localStorage.setItem(ADAPT_STORAGE_KEY, JSON.stringify({ weights: this.weights, performance: this.performance }));
    } catch {}
  }

  record(factors, won) {
    for (const f of factors) {
      if (this.performance[f]) { this.performance[f].total++; if (won) this.performance[f].correct++; }
    }
    this.save();
  }

  getAdjustedWeights() {
    const r = {};
    for (const [k, base] of Object.entries(this.weights)) {
      const p = this.performance[k];
      const acc = p && p.total > 0 ? p.correct / p.total : 0.5;
      r[k] = Math.max(3, Math.round(base * (0.3 + 1.4 * acc)));
    }
    return r;
  }

  reset() {
    for (const k of Object.keys(this.weights)) this.performance[k] = { correct: 0, total: 0 };
    this.save();
  }
}

export class SignalEngine {
  constructor() {
    this.signalHistory = [];
    this.lastSignals = {};
    this.adaptive = new AdaptiveWeights();
    this.wins = 0;
    this.losses = 0;
    this.recentOutcomes = [];
  }

  get winRate() {
    const t = this.wins + this.losses;
    return t > 0 ? (this.wins / t) * 100 : 0;
  }

  recordTradeOutcome(pair, entry, exit, factors) {
    const won = exit > entry;
    if (won) this.wins++; else this.losses++;
    this.recentOutcomes.push(won);
    if (this.recentOutcomes.length > 100) this.recentOutcomes.shift();
    this.adaptive.record(factors, won);
  }

  generateSignal(pair, candles, ind) {
    const lastIdx = candles.length - 1;
    const price = ind.closes[lastIdx];
    const w = this.adaptive.getAdjustedWeights();

    let score = 0;
    const reasons = [];
    const factors = [];

    // ---- MOMENTUM (strongest weight) ----
    // Compare last 2 completed candles
    if (lastIdx >= 2) {
      const c1 = candles[lastIdx];     // current forming
      const c2 = candles[lastIdx - 1]; // last complete
      const c3 = candles[lastIdx - 2]; // prior

      const c2Bull = c2.close > c2.open;
      const c3Bull = c3.close > c3.open;
      const priceUp2 = c2.close > c3.close;

      // Consecutive bullish candles
      if (c2Bull && c3Bull) { score += Math.round(w.momentum * 0.6); reasons.push('2 green candles'); factors.push('momentum'); }
      else if (!c2Bull && !c3Bull) { score -= Math.round(w.momentum * 0.6); reasons.push('2 red candles'); factors.push('momentum'); }

      // Price rising over last 2 candles
      if (priceUp2) { score += Math.round(w.momentum * 0.4); reasons.push('Price rising'); factors.push('momentum'); }
      else { score -= Math.round(w.momentum * 0.4); reasons.push('Price falling'); factors.push('momentum'); }

      // Current candle direction (early signal)
      if (c1.close > c1.open && c2Bull) { score += Math.round(w.momentum * 0.3); }
      else if (c1.close < c1.open && !c2Bull) { score -= Math.round(w.momentum * 0.3); }
    }

    // ---- EMA POSITION ----
    const ema20 = ind.ema20[lastIdx];
    if (ema20 !== null) {
      if (price > ema20 * 1.0005) { score += Math.round(w.ema * 0.5); reasons.push('Above EMA20'); factors.push('ema'); }
      else if (price < ema20 * 0.9995) { score -= Math.round(w.ema * 0.5); reasons.push('Below EMA20'); factors.push('ema'); }
    }

    // Price vs previous close (immediate momentum)
    if (lastIdx >= 1) {
      const prevClose = ind.closes[lastIdx - 1];
      if (price > prevClose) { score += Math.round(w.ema * 0.3); reasons.push('Up tick'); }
      else { score -= Math.round(w.ema * 0.3); reasons.push('Down tick'); }
    }

    // ---- RSI ----
    const rsi = ind.rsi[lastIdx];
    if (rsi !== null) {
      if (rsi > 55 && rsi < 75) { score += Math.round(w.rsi * 0.5); reasons.push(`RSI ${rsi.toFixed(0)}`); factors.push('rsi'); }
      else if (rsi < 45 && rsi > 25) { score -= Math.round(w.rsi * 0.5); reasons.push(`RSI ${rsi.toFixed(0)}`); factors.push('rsi'); }
      else if (rsi >= 75) { score -= Math.round(w.rsi * 0.3); reasons.push('RSI overbought'); factors.push('rsi'); }
      else if (rsi <= 25) { score += Math.round(w.rsi * 0.3); reasons.push('RSI oversold'); factors.push('rsi'); }
    }

    // ---- MACD ----
    const hist = ind.macd.histogram;
    if (hist.length >= 3) {
      const h0 = hist[lastIdx]; const h1 = hist[lastIdx - 1];
      if (h0 !== null && h1 !== null && h0 > h1 && h0 > 0) { score += Math.round(w.macd * 0.5); reasons.push('MACD +'); factors.push('macd'); }
      else if (h0 !== null && h1 !== null && h0 < h1 && h0 < 0) { score -= Math.round(w.macd * 0.5); reasons.push('MACD -'); factors.push('macd'); }
    }

    // ---- PRICE ACTION ----
    const bo = ind.breakouts[lastIdx];
    if (bo.direction === 'bullish') { score += Math.round(w.pa * 0.6); reasons.push('Breakout up'); factors.push('pa'); }
    else if (bo.direction === 'bearish') { score -= Math.round(w.pa * 0.6); reasons.push('Breakout dn'); factors.push('pa'); }

    const pb = ind.pinBars[lastIdx];
    if (pb.isPinBar && pb.direction === 'bullish') { score += Math.round(w.pa * 0.5); reasons.push('Pin buy'); factors.push('pa'); }
    else if (pb.isPinBar && pb.direction === 'bearish') { score -= Math.round(w.pa * 0.5); reasons.push('Pin sell'); factors.push('pa'); }

    if (ind.higherHighs[lastIdx]) { score += Math.round(w.pa * 0.3); factors.push('pa'); }
    if (ind.lowerLows[lastIdx]) { score -= Math.round(w.pa * 0.3); factors.push('pa'); }

    // ---- VOLUME ----
    if (ind.volumeSpikes[lastIdx]) { score += Math.round(w.volume * 0.6); reasons.push('Vol spike'); factors.push('volume'); }

    // ---- CLASSIFY ----
    // Ultra-low threshold: trade on any slight edge
    let threshold = 3;
    // Tighten if win rate is very low
    if (this.winRate < 30 && this.wins + this.losses > 20) threshold = 6;
    else if (this.winRate < 40 && this.wins + this.losses > 20) threshold = 4;

    let signalType = 'NO TRADE';
    if (score >= threshold) signalType = 'BUY';
    else if (score <= -threshold) signalType = 'SELL';

    const confidence = Math.min(Math.abs(score) + 10, 90);

    // ---- SL/TP: tight scalps for 10x leverage ----
    const slData = this.calcScalpSLTP(ind, lastIdx, signalType, price);

    const signal = {
      pair, time: new Date().toISOString(), type: signalType,
      confidence: signalType !== 'NO TRADE' ? Math.max(20, confidence) : 0,
      score, entry: price, ...slData,
      reasons: reasons.slice(0, 4), factors,
      trend: ind.trend, winRate: this.winRate.toFixed(0) + '%',
    };

    this.signalHistory.push(signal);
    if (this.signalHistory.length > 500) this.signalHistory.shift();
    return signal;
  }

  calcScalpSLTP(ind, idx, type, price) {
    // For 10x leverage, very tight stops
    const atr = ind.atr ? ind.atr[ind.atr.length - 1] : null;
    const tick = Math.max(atr || price * 0.002, price * 0.0008);

    if (type === 'BUY') {
      const sl = +(price - tick * 0.6).toFixed(2);
      const risk = price - sl;
      const tp1 = +(price + risk * 1.5).toFixed(2);
      const tp2 = +(price + risk * 3).toFixed(2);
      return { stopLoss: sl, tp1, tp2 };
    }
    if (type === 'SELL') {
      const sl = +(price + tick * 0.6).toFixed(2);
      const risk = sl - price;
      const tp1 = +(price - risk * 1.5).toFixed(2);
      const tp2 = +(price - risk * 3).toFixed(2);
      return { stopLoss: sl, tp1, tp2 };
    }
    return { stopLoss: null, tp1: null, tp2: null };
  }

  isNewSignal(signal) {
    const prev = this.lastSignals[signal.pair];
    this.lastSignals[signal.pair] = signal.type;
    return prev && prev !== signal.type;
  }

  rankPairs(data) {
    return data.sort((a, b) => {
      const vol = Math.log(b.volume + 1) - Math.log(a.volume + 1);
      const vola = Math.abs(b.change) - Math.abs(a.change);
      return vol * 0.6 + vola * 0.4;
    });
  }

  runBacktest(candles) {
    const results = [];
    for (let i = 60; i < candles.length; i++) {
      const slice = candles.slice(0, i + 1);
      const ind = computeAllIndicators(slice);
      const signal = this.generateSignal('BACKTEST', slice, ind);
      if (signal.type !== 'NO TRADE') {
        const next = candles.slice(i + 1, i + 4);
        if (next.length > 0) {
          let outcome = null;
          if (signal.type === 'BUY') {
            const mh = Math.max(...next.map(c => c.high));
            outcome = mh >= signal.tp1 ? 'win' : mh < signal.entry ? 'loss' : 'pending';
          } else {
            const ml = Math.min(...next.map(c => c.low));
            outcome = ml <= signal.tp1 ? 'win' : ml > signal.entry ? 'loss' : 'pending';
          }
          results.push({ index: i, type: signal.type, entry: signal.entry, tp1: signal.tp1, sl: signal.stopLoss, outcome, confidence: signal.confidence });
        }
      }
    }
    return results;
  }
}

export function resetAdaptiveWeights() {
  new SignalEngine().adaptive.reset();
}
