/**
 * SignalEngine — generates trading signals with adaptive learning
 * Tracks indicator performance and adjusts weights dynamically
 */

import { computeAllIndicators } from './indicators.js';

const ADAPT_STORAGE_KEY = 'crypto_adaptive_weights';

class AdaptiveWeights {
  constructor() {
    this.weights = {
      rsi: 15,
      emaTrend: 20,
      emaPosition: 8,
      macd: 18,
      volume: 12,
      breakout: 15,
      pinBar: 10,
      momentum: 10,
    };
    this.performance = {};
    for (const k of Object.keys(this.weights)) {
      this.performance[k] = { correct: 0, total: 0 };
    }
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
      localStorage.setItem(ADAPT_STORAGE_KEY, JSON.stringify({
        weights: this.weights,
        performance: this.performance,
      }));
    } catch {}
  }

  record(factors, won) {
    for (const factor of factors) {
      if (this.performance[factor]) {
        this.performance[factor].total++;
        if (won) this.performance[factor].correct++;
      }
    }
    this.save();
  }

  getAccuracy(factor) {
    const p = this.performance[factor];
    if (!p || p.total === 0) return 0.5;
    return p.correct / p.total;
  }

  getAdjustedWeights() {
    const result = {};
    for (const [k, base] of Object.entries(this.weights)) {
      const acc = this.getAccuracy(k);
      result[k] = Math.max(2, Math.round(base * (0.3 + 1.4 * acc)));
    }
    return result;
  }

  reset() {
    for (const k of Object.keys(this.weights)) {
      this.performance[k] = { correct: 0, total: 0 };
    }
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
    const total = this.wins + this.losses;
    return total > 0 ? (this.wins / total) * 100 : 0;
  }

  recordTradeOutcome(pair, entryPrice, exitPrice, factors) {
    const won = (exitPrice > entryPrice);
    if (won) this.wins++;
    else this.losses++;
    this.recentOutcomes.push(won);
    if (this.recentOutcomes.length > 100) this.recentOutcomes.shift();
    this.adaptive.record(factors, won);
  }

  generateSignal(pair, candles, ind) {
    const lastIdx = candles.length - 1;
    const price = ind.closes[lastIdx];
    const w = this.adaptive.getAdjustedWeights();

    let score = 0;
    let reasons = [];
    let factors = [];
    let signalType = 'NO TRADE';

    // Volatility filter — skip if ATR is too low (choppy)
    const atrVal = ind.atr ? ind.atr[ind.atr.length - 1] : null;
    if (atrVal && atrVal < price * 0.001) {
      return {
        pair, time: new Date().toISOString(), type: 'NO TRADE',
        confidence: 0, score: 0, entry: price,
        stopLoss: null, tp1: null, tp2: null,
        reasons: ['Market too quiet (low volatility)'],
        trend: ind.trend,
      };
    }

    // RSI
    const rsiVal = ind.rsi[ind.rsi.length - 1];
    if (rsiVal !== null) {
      if (rsiVal < 35) {
        score += w.rsi; reasons.push(`RSI ${rsiVal.toFixed(0)} oversold`); factors.push('rsi');
      } else if (rsiVal > 65) {
        score -= w.rsi; reasons.push(`RSI ${rsiVal.toFixed(0)} overbought`); factors.push('rsi');
      } else if (rsiVal < 45) {
        score += Math.round(w.rsi * 0.4); reasons.push('RSI bullish bias'); factors.push('rsi');
      } else if (rsiVal > 55) {
        score -= Math.round(w.rsi * 0.4); reasons.push('RSI bearish bias'); factors.push('rsi');
      }
    }

    // EMA trend alignment
    switch (ind.trend) {
      case 'bullish':
        score += w.emaTrend; reasons.push('EMA uptrend'); factors.push('emaTrend');
        break;
      case 'bearish':
        score -= w.emaTrend; reasons.push('EMA downtrend'); factors.push('emaTrend');
        break;
    }

    // Price vs EMAs
    const ema20v = ind.ema20[lastIdx];
    const ema50v = ind.ema50[lastIdx];
    let emaScore = 0;
    if (ema20v !== null) {
      if (price > ema20v) emaScore += 1; else emaScore -= 1;
    }
    if (ema50v !== null) {
      if (price > ema50v) emaScore += 1; else emaScore -= 1;
    }
    if (emaScore !== 0) {
      const contrib = Math.round(w.emaPosition * (emaScore / 2));
      score += contrib;
      if (contrib > 0) { reasons.push('Price above key EMAs'); factors.push('emaPosition'); }
      else if (contrib < 0) { reasons.push('Price below key EMAs'); factors.push('emaPosition'); }
    }

    // MACD
    const hist = ind.macd.histogram;
    const macdLine = ind.macd.macdLine;
    const signalLine = ind.macd.signalLine;
    let macdScore = 0;
    if (hist.length >= 3) {
      const h0 = hist[hist.length - 1];
      const h1 = hist[hist.length - 2];
      const h2 = hist[hist.length - 3];
      const m0 = macdLine[macdLine.length - 1];
      const s0 = signalLine[signalLine.length - 1];

      if (h0 !== null && h0 > 0) macdScore += 1;
      else if (h0 !== null) macdScore -= 1;

      if (h0 !== null && h1 !== null && h0 > h1) macdScore += 1;
      else if (h0 !== null && h1 !== null) macdScore -= 1;

      if (m0 !== null && s0 !== null && m0 > s0) macdScore += 1;
      else if (m0 !== null && s0 !== null) macdScore -= 1;

      if (h0 !== null && h1 !== null && h2 !== null && h0 > h1 && h1 > h2) macdScore += 1;

      if (macdScore !== 0) {
        const contrib = Math.round(w.macd * (macdScore / 4));
        score += contrib;
        if (contrib > 0) { reasons.push('MACD bullish'); factors.push('macd'); }
        else if (contrib < 0) { reasons.push('MACD bearish'); factors.push('macd'); }
      }
    }

    // Volume spike
    if (ind.volumeSpikes[lastIdx]) {
      score += w.volume; reasons.push('Volume spike'); factors.push('volume');
    }

    // Breakout
    const bo = ind.breakouts[lastIdx];
    if (bo.direction === 'bullish') {
      score += w.breakout; reasons.push('Bullish breakout'); factors.push('breakout');
    } else if (bo.direction === 'bearish') {
      score -= w.breakout; reasons.push('Bearish breakout'); factors.push('breakout');
    }

    // Pin bar
    const pb = ind.pinBars[lastIdx];
    if (pb.isPinBar && pb.direction === 'bullish') {
      score += w.pinBar; reasons.push('Bullish rejection'); factors.push('pinBar');
    } else if (pb.isPinBar && pb.direction === 'bearish') {
      score -= w.pinBar; reasons.push('Bearish rejection'); factors.push('pinBar');
    }

    // Momentum (HH/LL)
    if (ind.higherHighs[lastIdx]) {
      score += Math.round(w.momentum * 0.4); reasons.push('Higher high'); factors.push('momentum');
    }
    if (ind.lowerLows[lastIdx]) {
      score -= Math.round(w.momentum * 0.4); reasons.push('Lower low'); factors.push('momentum');
    }

    // Minimum confirmation check — need at least 2 bullish or bearish factors
    const bullCount = factors.filter(f => {
      const val = this.adaptive.weights[f] || 0;
      const idx = Object.keys(this.adaptive.weights).indexOf(f);
      return score > 0;
    }).length;

    const bearCount = factors.filter(f => {
      const idx = Object.keys(this.adaptive.weights).indexOf(f);
      return score < 0;
    }).length;

    // Dynamic threshold based on recent win rate
    // Dynamic threshold based on recent win rate
    let threshold = 6;
    if (this.winRate < 35 && this.wins + this.losses > 15) threshold = 10;
    else if (this.winRate < 45 && this.wins + this.losses > 15) threshold = 8;

    if (score >= threshold) signalType = 'BUY';
    else if (score <= -threshold) signalType = 'SELL';

    const confidence = Math.min(Math.abs(score), 95);

    const slData = this.calculateSLTP(ind, lastIdx, signalType, price);

    const signal = {
      pair,
      time: new Date().toISOString(),
      type: signalType,
      confidence: signalType !== 'NO TRADE' ? Math.max(18, confidence) : 0,
      score,
      entry: price,
      ...slData,
      reasons: reasons.slice(0, 5),
      factors,
      trend: ind.trend,
      winRate: this.winRate.toFixed(0) + '%',
    };

    this.signalHistory.push(signal);
    if (this.signalHistory.length > 500) this.signalHistory.shift();

    return signal;
  }

  calculateSLTP(ind, idx, signalType, price) {
    const atrVal = ind.atr ? ind.atr[ind.atr.length - 1] : null;
    const atrMultiplier = atrVal && atrVal > 0 ? atrVal : price * 0.004;

    if (signalType === 'BUY') {
      const stopLoss = +(price - atrMultiplier * 0.8).toFixed(2);
      const risk = price - stopLoss;
      const tp1 = +(price + risk * 1.2).toFixed(2);
      const tp2 = +(price + risk * 2.5).toFixed(2);
      return { stopLoss, tp1, tp2 };
    }
    if (signalType === 'SELL') {
      const stopLoss = +(price + atrMultiplier * 0.8).toFixed(2);
      const risk = stopLoss - price;
      const tp1 = +(price - risk * 1.2).toFixed(2);
      const tp2 = +(price - risk * 2.5).toFixed(2);
      return { stopLoss, tp1, tp2 };
    }
    return { stopLoss: null, tp1: null, tp2: null };
  }

  isNewSignal(signal) {
    const prev = this.lastSignals[signal.pair];
    this.lastSignals[signal.pair] = signal.type;
    return prev && prev !== signal.type;
  }

  rankPairs(pairsData) {
    return pairsData.sort((a, b) => {
      const vol = Math.log(b.volume + 1) - Math.log(a.volume + 1);
      const vola = Math.abs(b.change) - Math.abs(a.change);
      return vol * 0.6 + vola * 0.4;
    });
  }

  getAdaptiveInfo() {
    const w = this.adaptive.getAdjustedWeights();
    const info = {};
    for (const [k, v] of Object.entries(this.adaptive.weights)) {
      const p = this.adaptive.performance[k];
      info[k] = {
        baseWeight: v,
        adjustedWeight: w[k],
        accuracy: p.total > 0 ? ((p.correct / p.total) * 100).toFixed(0) + '%' : '—',
        samples: p.total,
      };
    }
    return info;
  }

  runBacktest(candles) {
    const results = [];
    for (let i = 60; i < candles.length; i++) {
      const slice = candles.slice(0, i + 1);
      const ind = computeAllIndicators(slice);
      const signal = this.generateSignal('BACKTEST', slice, ind);
      if (signal.type !== 'NO TRADE') {
        const nextCandles = candles.slice(i + 1, i + 6);
        if (nextCandles.length > 0) {
          let outcome = null;
          if (signal.type === 'BUY') {
            const maxHigh = Math.max(...nextCandles.map(c => c.high));
            outcome = maxHigh >= signal.tp1 ? 'win' : maxHigh < signal.entry ? 'loss' : 'pending';
          } else {
            const minLow = Math.min(...nextCandles.map(c => c.low));
            outcome = minLow <= signal.tp1 ? 'win' : minLow > signal.entry ? 'loss' : 'pending';
          }
          results.push({
            index: i, type: signal.type, entry: signal.entry,
            tp1: signal.tp1, sl: signal.stopLoss, outcome, confidence: signal.confidence,
          });
        }
      }
    }
    return results;
  }
}

export function resetAdaptiveWeights() {
  const eng = new SignalEngine();
  eng.adaptive.reset();
}
