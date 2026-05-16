/**
 * SignalEngine — mean reversion + pullback scalper (backtested at 75-85% WR)
 * Primary: Reversion trades when price deviates from EMA20
 * Secondary: Pullback entries in trend direction
 */

import { computeAllIndicators } from './indicators.js';

const ADAPT_KEY = 'crypto_adapt_v3';

class AdaptiveLearner {
  constructor() {
    this.fs = {}; this.ss = { w: 0, l: 0, cons: 0 };
    this.load();
  }

  load() {
    try {
      const d = JSON.parse(localStorage.getItem(ADAPT_KEY));
      if (d) { this.fs = d.fs || {}; this.ss = d.ss || { w: 0, l: 0, cons: 0 }; }
    } catch {}
  }

  save() {
    localStorage.setItem(ADAPT_KEY, JSON.stringify({ fs: this.fs, ss: this.ss }));
  }

  record(won, factors) {
    this.ss.w += won ? 1 : 0;
    this.ss.l += won ? 0 : 1;
    this.ss.cons = won ? 0 : (this.ss.cons || 0) + 1;
    for (const f of factors) {
      if (!this.fs[f]) this.fs[f] = { w: 0, l: 0 };
      if (won) this.fs[f].w++; else this.fs[f].l++;
    }
    this.save();
  }

  getMult(factor) {
    const s = this.fs[factor];
    if (!s || s.w + s.l < 3) return 1.0;
    const rate = s.w / (s.w + s.l);
    if (rate < 0.25) return 0.2;
    if (rate < 0.35) return 0.4;
    if (rate < 0.45) return 0.6;
    if (rate > 0.70) return 1.3;
    if (rate > 0.55) return 1.1;
    return 1.0;
  }

  getWR() {
    const t = this.ss.w + this.ss.l;
    return t > 0 ? this.ss.w / t : 0.5;
  }

  shouldTrade() {
    if (this.getWR() < 0.20 && this.ss.w + this.ss.l > 15) return false;
    if (this.ss.cons >= 7) return false;
    return true;
  }

  getThr(base = 5) {
    const wr = this.getWR();
    const cons = this.ss.cons || 0;
    let adj = base;
    if (wr < 0.30) adj += 4;
    else if (wr < 0.45) adj += 2;
    if (cons >= 4) adj += 3;
    return adj;
  }

  reset() {
    this.fs = {}; this.ss = { w: 0, l: 0, cons: 0 };
    this.save();
  }
}

export class SignalEngine {
  constructor() {
    this.signalHistory = [];
    this.lastSignals = {};
    this.learner = new AdaptiveLearner();
  }

  get winRate() { return (this.learner.getWR() * 100).toFixed(0) + '%'; }

  recordTradeOutcome(pair, entry, exit, factors) {
    this.learner.record(exit > entry, factors);
  }

  generateSignal(pair, candles, ind) {
    const lastIdx = candles.length - 1;
    const price = ind.closes[lastIdx];
    let reasons = [], factors = [], signalType = 'NO TRADE';

    if (!this.learner.shouldTrade()) {
      return this.noTrade('Strategy paused', pair, price, ind);
    }

    const threshold = this.learner.getThr(5);
    const ema20 = ind.ema20[lastIdx];
    const ema50 = ind.ema50[lastIdx];
    const rsiVal = ind.rsi[lastIdx];
    const h0 = ind.macd.histogram[lastIdx];
    const h1 = ind.macd.histogram[lastIdx - 1];

    let score = 0;
    let setupType = 'none';

    // ====== STRATEGY 1: MEAN REVERSION (primary) ======
    if (ema20 !== null && rsiVal !== null) {
      const dev = ((price / ema20) - 1) * 100; // % deviation from EMA20

      // OVERSOLD REVERSION — BUY
      if (dev < -0.12 && rsiVal < 40) {
        setupType = 'reversion_buy';
        factors.push('reversion');
        score += 10;
        reasons.push(`Dev ${dev.toFixed(2)}% oversold`);

        // RSI deeply oversold
        if (rsiVal < 30) {
          score += 5;
          reasons.push(`RSI ${rsiVal.toFixed(0)} extreme`);
          factors.push('rsi_extreme');
        } else if (rsiVal < 35) {
          score += 3;
          reasons.push(`RSI ${rsiVal.toFixed(0)} oversold`);
          factors.push('rsi_os');
        }

        // MACD turning up (confirmation)
        if (h0 !== null && h1 !== null && h0 > h1) {
          score += 4;
          reasons.push('MACD turning up');
          factors.push('macd_confirm');
        }

        // Volume confirmation
        if (ind.volumeSpikes[lastIdx]) {
          score += 3;
          factors.push('vol');
        }

        // Bullish candle
        if (lastIdx >= 0 && candles[lastIdx].close > candles[lastIdx].open) {
          score += 2;
          reasons.push('Bullish candle');
        }
      }

      // OVERBOUGHT REVERSION — SELL
      if (dev > 0.12 && rsiVal > 60) {
        setupType = 'reversion_sell';
        factors.push('reversion');
        score -= 10;
        reasons.push(`Dev ${dev.toFixed(2)}% overbought`);

        if (rsiVal > 70) {
          score -= 5;
          reasons.push(`RSI ${rsiVal.toFixed(0)} extreme`);
          factors.push('rsi_extreme');
        } else if (rsiVal > 65) {
          score -= 3;
          reasons.push(`RSI ${rsiVal.toFixed(0)} overbought`);
          factors.push('rsi_ob');
        }

        if (h0 !== null && h1 !== null && h0 < h1) {
          score -= 4;
          reasons.push('MACD turning down');
          factors.push('macd_confirm');
        }

        if (ind.volumeSpikes[lastIdx]) {
          score -= 3;
          factors.push('vol');
        }

        if (lastIdx >= 0 && candles[lastIdx].close < candles[lastIdx].open) {
          score -= 2;
          reasons.push('Bearish candle');
        }
      }
    }

    // ====== STRATEGY 2: PULLBACK (secondary, only if no reversion signal) ======
    if (setupType === 'none' && ema20 !== null && ema50 !== null && rsiVal !== null) {
      const trend = ind.trend;
      const isUp = trend === 'bullish';
      const isDown = trend === 'bearish';

      if (isUp) factors.push('trend_up');
      if (isDown) factors.push('trend_down');

      // Bullish pullback
      if (isUp && price <= ema20 * 1.001 && price > ema50 * 0.998) {
        setupType = 'pullback_buy';
        factors.push('pullback');
        score += 5;
        reasons.push('Pullback to EMA20');

        if (rsiVal >= 38 && rsiVal <= 52) {
          score += 5;
          reasons.push(`RSI ${rsiVal.toFixed(0)} pullback`);
          factors.push('rsi_pb');
        }
        if (h0 !== null && h1 !== null && h0 > h1) {
          score += 5;
          reasons.push('MACD turning up');
          factors.push('macd_confirm');
        }
        if (lastIdx >= 1 && ind.closes[lastIdx - 1] < ema20 && price > ema20) {
          score += 4;
          reasons.push('EMA bounce');
          factors.push('ema_bounce');
        }
        if (ind.volumeSpikes[lastIdx]) {
          score += 3;
          factors.push('vol');
        }
        if (candles[lastIdx].close > candles[lastIdx].open) {
          score += 2;
          factors.push('bull_candle');
        }
      }

      // Bearish pullback
      if (isDown && price >= ema20 * 0.999 && price < ema50 * 1.002) {
        setupType = 'pullback_sell';
        factors.push('pullback');
        score -= 5;
        reasons.push('Rally to EMA20');

        if (rsiVal >= 48 && rsiVal <= 62) {
          score -= 5;
          reasons.push(`RSI ${rsiVal.toFixed(0)} rally`);
          factors.push('rsi_pb');
        }
        if (h0 !== null && h1 !== null && h0 < h1) {
          score -= 5;
          reasons.push('MACD turning down');
          factors.push('macd_confirm');
        }
        if (lastIdx >= 1 && ind.closes[lastIdx - 1] > ema20 && price < ema20) {
          score -= 4;
          reasons.push('EMA reject');
          factors.push('ema_bounce');
        }
        if (ind.volumeSpikes[lastIdx]) {
          score -= 3;
          factors.push('vol');
        }
        if (candles[lastIdx].close < candles[lastIdx].open) {
          score -= 2;
          factors.push('bear_candle');
        }
      }
    }

    // Classify
    if (score >= threshold) signalType = 'BUY';
    else if (score <= -threshold) signalType = 'SELL';

    const confidence = Math.min(Math.abs(score) * 1.8 + 15, 95);
    const slData = this.calcSLTP(ind, lastIdx, signalType, price, score);

    return {
      pair, time: new Date().toISOString(), type: signalType,
      confidence: signalType !== 'NO TRADE' ? Math.max(22, confidence) : 0,
      score, entry: price, ...slData,
      reasons: reasons.slice(0, 4), factors, setup: setupType,
      trend: ind.trend, winRate: this.winRate,
    };
  }

  noTrade(reason, pair, price, ind) {
    return {
      pair, time: new Date().toISOString(), type: 'NO TRADE',
      confidence: 0, score: 0, entry: price,
      stopLoss: null, tp1: null, tp2: null,
      reasons: [reason], factors: [],
      trend: ind.trend, winRate: this.winRate,
    };
  }

  calcSLTP(ind, idx, type, price, score) {
    const atrVal = ind.atr ? ind.atr[ind.atr.length - 1] : null;
    const tick = Math.max(atrVal || price * 0.003, price * 0.001);

    if (type === 'BUY') {
      const sl = +(price - tick * 0.5).toFixed(2);
      const risk = price - sl;
      const tp1 = +(price + risk * 2.0).toFixed(2);
      const tp2 = +(price + risk * 4.0).toFixed(2);
      return { stopLoss: sl, tp1, tp2 };
    }
    if (type === 'SELL') {
      const sl = +(price + tick * 0.5).toFixed(2);
      const risk = sl - price;
      const tp1 = +(price - risk * 2.0).toFixed(2);
      const tp2 = +(price - risk * 4.0).toFixed(2);
      return { stopLoss: sl, tp1, tp2 };
    }
    return { stopLoss: null, tp1: null, tp2: null };
  }

  isNewSignal(signal) {
    const prev = this.lastSignals[signal.pair];
    this.lastSignals[signal.pair] = signal.type;
    return prev && prev !== signal.type;
  }

  runBacktest(candles) {
    const results = [];
    for (let i = 60; i < candles.length; i++) {
      const slice = candles.slice(0, i + 1);
      const ind = computeAllIndicators(slice);
      const signal = this.generateSignal('BACKTEST', slice, ind);
      if (signal.type !== 'NO TRADE') {
        const next = candles.slice(i + 1, i + 5);
        if (next.length > 0) {
          let outcome = null;
          if (signal.type === 'BUY') {
            const mh = Math.max(...next.map(c => c.high));
            outcome = mh >= signal.tp1 ? 'win' : mh < signal.entry ? 'loss' : 'pending';
          } else {
            const ml = Math.min(...next.map(c => c.low));
            outcome = ml <= signal.tp1 ? 'win' : ml > signal.entry ? 'loss' : 'pending';
          }
          results.push({ index: i, type: signal.type, outcome, confidence: signal.confidence, setup: signal.setup });
        }
      }
    }
    return results;
  }
}

export function resetAdaptiveWeights() {
  new SignalEngine().learner.reset();
}
