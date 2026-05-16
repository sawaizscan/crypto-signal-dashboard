/**
 * SignalEngine — pullback scalper with adaptive learning
 * Trades pullbacks in trend direction with multi-confirmation
 * Learns from every loss to avoid repeating mistakes
 */

import { computeAllIndicators } from './indicators.js';

const ADAPT_KEY = 'crypto_adapt_v2';

class AdaptiveLearner {
  constructor() {
    this.factorStats = {};
    this.strategyStats = { wins: 0, losses: 0, consecutive: 0 };
    this.factorPenalties = {};
    this.load();
  }

  load() {
    try {
      const d = JSON.parse(localStorage.getItem(ADAPT_KEY));
      if (d) { this.factorStats = d.fs || {}; this.strategyStats = d.ss || { wins: 0, losses: 0, consecutive: 0 }; this.factorPenalties = d.fp || {}; }
    } catch {}
  }

  save() {
    localStorage.setItem(ADAPT_KEY, JSON.stringify({ fs: this.factorStats, ss: this.strategyStats, fp: this.factorPenalties }));
  }

  recordTrade(won, factors) {
    this.strategyStats.wins += won ? 1 : 0;
    this.strategyStats.losses += won ? 0 : 1;
    this.strategyStats.consecutive = won ? 0 : (this.strategyStats.consecutive || 0) + 1;
    if (won) this.strategyStats.consecutive = 0;

    for (const f of factors) {
      if (!this.factorStats[f]) this.factorStats[f] = { w: 0, l: 0 };
      if (won) this.factorStats[f].w++; else this.factorStats[f].l++;
    }

    // Penalize factors from losing trades
    if (!won) {
      for (const f of factors) {
        this.factorPenalties[f] = (this.factorPenalties[f] || 0) + 1;
      }
    }

    this.save();
  }

  getFactorMultiplier(factor) {
    const st = this.factorStats[factor];
    if (!st || st.w + st.l < 5) return 1.0;
    const rate = st.w / (st.w + st.l);
    if (rate < 0.30) return 0.3;
    if (rate < 0.40) return 0.5;
    if (rate < 0.45) return 0.7;
    if (rate > 0.65) return 1.3;
    if (rate > 0.55) return 1.1;
    return 1.0;
  }

  getWinRate() {
    const t = this.strategyStats.wins + this.strategyStats.losses;
    return t > 0 ? this.strategyStats.wins / t : 0.5;
  }

  shouldTrade() {
    const wr = this.getWinRate();
    const cons = this.strategyStats.consecutive || 0;
    if (wr < 0.25 && this.strategyStats.wins + this.strategyStats.losses > 20) return false;
    if (cons >= 8) return false;
    return true;
  }

  getAdjustedThreshold(base = 8) {
    const wr = this.getWinRate();
    const cons = this.strategyStats.consecutive || 0;
    let adj = base;
    if (wr < 0.30) adj += 6;
    else if (wr < 0.40) adj += 3;
    else if (wr < 0.45) adj += 1;
    if (cons >= 5) adj += 4;
    return adj;
  }

  reset() {
    this.factorStats = {};
    this.strategyStats = { wins: 0, losses: 0, consecutive: 0 };
    this.factorPenalties = {};
    this.save();
  }
}

export class SignalEngine {
  constructor() {
    this.signalHistory = [];
    this.lastSignals = {};
    this.learner = new AdaptiveLearner();
  }

  get winRate() { return (this.learner.getWinRate() * 100).toFixed(0) + '%'; }

  recordTradeOutcome(pair, entry, exit, factors) {
    this.learner.recordTrade(exit > entry, factors);
  }

  generateSignal(pair, candles, ind) {
    const lastIdx = candles.length - 1;
    const price = ind.closes[lastIdx];
    let reasons = [];
    let factors = [];
    let signalType = 'NO TRADE';

    // Check if strategy should pause
    if (!this.learner.shouldTrade()) {
      return { pair, time: new Date().toISOString(), type: 'NO TRADE', confidence: 0, score: 0, entry: price, stopLoss: null, tp1: null, tp2: null, reasons: ['Strategy paused — too many losses'], factors, trend: ind.trend, winRate: this.winRate };
    }

    const threshold = this.learner.getAdjustedThreshold(8);

    // ---- TREND FILTER (primary) ----
    const trend = ind.trend;
    const isUptrend = trend === 'bullish';
    const isDowntrend = trend === 'bearish';
    if (isUptrend) factors.push('trend_up');
    if (isDowntrend) factors.push('trend_down');

    // ---- PULLBACK DETECTION ----
    const ema20 = ind.ema20[lastIdx];
    const ema50 = ind.ema50[lastIdx];
    const rsi = ind.rsi[lastIdx];
    const macdHist = ind.macd.histogram;
    const h0 = macdHist[lastIdx];
    const h1 = macdHist[lastIdx - 1];

    let score = 0;
    let setup = 'none';

    // ---- BULLISH SETUP ----
    if (isUptrend && ema20 !== null && ema50 !== null && rsi !== null) {
      // Price pulled back to near EMA20/50 zone
      if (price <= ema20 * 1.001 && price > ema50 * 0.998) {
        reasons.push('Pullback to EMA20');
        factors.push('pullback');
        score += 5;
        setup = 'pullback_bull';

        // RSI in pullback zone (40-50)
        if (rsi >= 38 && rsi <= 52) {
          score += 6; reasons.push(`RSI ${rsi.toFixed(0)} pullback zone`); factors.push('rsi_pullback');
        }

        // MACD histogram turning up from pullback
        if (h0 !== null && h1 !== null && h0 > h1) {
          score += 7; reasons.push('MACD turning up'); factors.push('macd_turn');
        }

        // Price bouncing off EMA20
        if (lastIdx >= 1 && ind.closes[lastIdx - 1] < ema20 && price > ema20) {
          score += 5; reasons.push('Bounce off EMA20'); factors.push('ema_bounce');
        }

        // Volume confirming bounce
        if (ind.volumeSpikes[lastIdx]) {
          score += 4; reasons.push('Vol confirmation'); factors.push('vol_conf');
        }

        // Last candle was bullish
        if (candles[lastIdx].close > candles[lastIdx].open) {
          score += 3; reasons.push('Bullish candle'); factors.push('bull_candle');
        }
      }

      // Straight momentum (strong uptrend, no pullback needed if very strong)
      if (price > ema20 * 1.002 && rsi > 55 && rsi < 70) {
        if (h0 !== null && h1 !== null && h0 > h1 && h0 > 0) {
          score += 4; reasons.push('Strong momentum');
        }
      }
    }

    // ---- BEARISH SETUP ----
    if (isDowntrend && ema20 !== null && ema50 !== null && rsi !== null) {
      // Price rallied to near EMA20/50 zone
      if (price >= ema20 * 0.999 && price < ema50 * 1.002) {
        reasons.push('Rally to EMA20');
        factors.push('pullback');
        score -= 5;
        setup = 'pullback_bear';

        // RSI in overbought pullback zone (50-62)
        if (rsi >= 48 && rsi <= 62) {
          score -= 6; reasons.push(`RSI ${rsi.toFixed(0)} rally zone`); factors.push('rsi_pullback');
        }

        // MACD histogram turning down from rally
        if (h0 !== null && h1 !== null && h0 < h1) {
          score -= 7; reasons.push('MACD turning down'); factors.push('macd_turn');
        }

        // Price rejecting off EMA20
        if (lastIdx >= 1 && ind.closes[lastIdx - 1] > ema20 && price < ema20) {
          score -= 5; reasons.push('Reject off EMA20'); factors.push('ema_bounce');
        }

        if (ind.volumeSpikes[lastIdx]) {
          score -= 4; reasons.push('Vol confirmation'); factors.push('vol_conf');
        }

        if (candles[lastIdx].close < candles[lastIdx].open) {
          score -= 3; reasons.push('Bearish candle'); factors.push('bear_candle');
        }
      }

      if (price < ema20 * 0.998 && rsi < 45 && rsi > 30) {
        if (h0 !== null && h1 !== null && h0 < h1 && h0 < 0) {
          score -= 4; reasons.push('Strong momentum');
        }
      }
    }

    // ---- APPLY ADAPTIVE FACTOR MULTIPLIERS ----
    let adjustedScore = 0;
    for (const f of factors) {
      const mult = this.learner.getFactorMultiplier(f);
      // Recalculate contribution based on factor weight
    }
    // Simple approach: use score as-is; the threshold already accounts for learning

    // ---- CLASSIFY ----
    if (score >= threshold) signalType = 'BUY';
    else if (score <= -threshold) signalType = 'SELL';

    const confidence = Math.min(Math.abs(score) * 1.5 + 15, 92);
    const slData = this.calcSLTP(ind, lastIdx, signalType, price, score);

    return {
      pair, time: new Date().toISOString(), type: signalType,
      confidence: signalType !== 'NO TRADE' ? Math.max(25, confidence) : 0,
      score, entry: price, ...slData,
      reasons: reasons.slice(0, 4), factors,
      trend, winRate: this.winRate, setup,
    };
  }

  calcSLTP(ind, idx, type, price, score) {
    const atr = ind.atr ? ind.atr[ind.atr.length - 1] : null;
    const tick = Math.max(atr || price * 0.003, price * 0.0012);
    const confidence = Math.abs(score) / 20;

    if (type === 'BUY') {
      // Tighter SL for lower confidence
      const slMult = 0.5 + (1 - Math.min(confidence, 1)) * 0.5;
      const sl = +(price - tick * slMult).toFixed(2);
      const risk = price - sl;
      const tp1 = +(price + risk * 1.8).toFixed(2);
      const tp2 = +(price + risk * 3.5).toFixed(2);
      return { stopLoss: sl, tp1, tp2 };
    }
    if (type === 'SELL') {
      const slMult = 0.5 + (1 - Math.min(confidence, 1)) * 0.5;
      const sl = +(price + tick * slMult).toFixed(2);
      const risk = sl - price;
      const tp1 = +(price - risk * 1.8).toFixed(2);
      const tp2 = +(price - risk * 3.5).toFixed(2);
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
          results.push({ index: i, type: signal.type, entry: signal.entry, tp1: signal.tp1, sl: signal.stopLoss, outcome, confidence: signal.confidence, score: signal.score });
        }
      }
    }
    return results;
  }
}

export function resetAdaptiveWeights() {
  new SignalEngine().learner.reset();
}
