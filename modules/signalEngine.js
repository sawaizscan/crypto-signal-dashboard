/**
 * SignalEngine — generates trading signals from indicator data
 * Rule-based analysis; never financial advice
 */

import { computeAllIndicators } from './indicators.js';

export class SignalEngine {
  constructor() {
    this.signalHistory = [];
    this.lastSignals = {};
  }

  generateSignal(pair, candles, ind) {
    const lastIdx = candles.length - 1;
    const price = ind.closes[lastIdx];

    let score = 0;
    const reasons = [];
    let signalType = 'NO TRADE';

    // RSI
    const rsiVal = ind.rsi[ind.rsi.length - 1];
    if (rsiVal !== null) {
      if (rsiVal < 30) {
        score += 20;
        reasons.push('RSI oversold');
      } else if (rsiVal > 70) {
        score -= 20;
        reasons.push('RSI overbought');
      } else if (rsiVal < 40) {
        score += 8;
        reasons.push('RSI bullish bias');
      } else if (rsiVal > 60) {
        score -= 8;
        reasons.push('RSI bearish bias');
      }
    }

    // EMA trend
    switch (ind.trend) {
      case 'bullish':
        score += 18;
        reasons.push('EMA bullish alignment (20>50>200)');
        break;
      case 'bearish':
        score -= 18;
        reasons.push('EMA bearish alignment (20<50<200)');
        break;
      default:
        reasons.push('EMA mixed / sideways');
    }

    // EMA price position
    const ema20v = ind.ema20[lastIdx];
    const ema50v = ind.ema50[lastIdx];
    if (ema20v !== null && price > ema20v) {
      score += 6; reasons.push('Price above EMA20');
    } else if (ema20v !== null) {
      score -= 6; reasons.push('Price below EMA20');
    }
    if (ema50v !== null && price > ema50v) {
      score += 4; reasons.push('Price above EMA50');
    } else if (ema50v !== null) {
      score -= 4; reasons.push('Price below EMA50');
    }

    // MACD
    const hist = ind.macd.histogram;
    const macdLine = ind.macd.macdLine;
    const signalLine = ind.macd.signalLine;
    if (hist.length >= 2) {
      const hCurr = hist[hist.length - 1];
      const hPrev = hist[hist.length - 2];
      const mCurr = macdLine[macdLine.length - 1];
      const sCurr = signalLine[signalLine.length - 1];

      if (hCurr !== null && hCurr > 0) {
        score += 8; reasons.push('MACD histogram positive');
      } else if (hCurr !== null) {
        score -= 8; reasons.push('MACD histogram negative');
      }
      if (hCurr !== null && hPrev !== null && hCurr > hPrev) {
        score += 6; reasons.push('MACD momentum rising');
      } else if (hCurr !== null && hPrev !== null) {
        score -= 3;
      }
      if (mCurr !== null && sCurr !== null && mCurr > sCurr) {
        score += 7; reasons.push('MACD line above signal');
      } else if (mCurr !== null && sCurr !== null) {
        score -= 7; reasons.push('MACD line below signal');
      }
    }

    // Volume spike
    const volSpike = ind.volumeSpikes[lastIdx];
    if (volSpike) {
      score += 10; reasons.push('Volume spike detected');
    }

    // Price action – breakout
    const bo = ind.breakouts[lastIdx];
    if (bo.direction === 'bullish') {
      score += 15; reasons.push('Bullish breakout');
    } else if (bo.direction === 'bearish') {
      score -= 15; reasons.push('Bearish breakout');
    }

    // Price action – pin bar
    const pb = ind.pinBars[lastIdx];
    if (pb.isPinBar && pb.direction === 'bullish') {
      score += 10; reasons.push('Bullish pin bar rejection');
    } else if (pb.isPinBar && pb.direction === 'bearish') {
      score -= 10; reasons.push('Bearish pin bar rejection');
    }

    // Higher highs / lower lows
    const hh = ind.higherHighs[lastIdx];
    const ll = ind.lowerLows[lastIdx];
    if (hh) { score += 5; reasons.push('Higher high formed'); }
    if (ll) { score -= 5; reasons.push('Lower low formed'); }

    // Classify (low thresholds for high-frequency trading)
    if (score >= 12) signalType = 'BUY';
    else if (score <= -12) signalType = 'SELL';

    const confidence = Math.min(Math.abs(score), 100);

    // Stop loss & take profit
    const slData = this.calculateSLTP(ind.highs, ind.lows, lastIdx, signalType, price);

    const signal = {
      pair,
      time: new Date().toISOString(),
      type: signalType,
      confidence,
      score,
      entry: price,
      ...slData,
      reasons: reasons.slice(0, 5),
      trend: ind.trend,
    };

    this.signalHistory.push(signal);
    if (this.signalHistory.length > 500) this.signalHistory.shift();

    return signal;
  }

  calculateSLTP(highs, lows, idx, signalType, price) {
    if (signalType === 'BUY') {
      const recentLows = lows.slice(Math.max(0, idx - 14), idx);
      const swingLow = Math.min(...recentLows.filter(v => v > 0));
      const stopLoss = swingLow * 0.995;
      const risk = price - stopLoss;
      const tp1 = price + risk * 1.5;
      const tp2 = price + risk * 3;
      return { stopLoss: +stopLoss.toFixed(2), tp1: +tp1.toFixed(2), tp2: +tp2.toFixed(2) };
    }
    if (signalType === 'SELL') {
      const recentHighs = highs.slice(Math.max(0, idx - 14), idx);
      const swingHigh = Math.max(...recentHighs);
      const stopLoss = swingHigh * 1.005;
      const risk = stopLoss - price;
      const tp1 = price - risk * 1.5;
      const tp2 = price - risk * 3;
      return { stopLoss: +stopLoss.toFixed(2), tp1: +tp1.toFixed(2), tp2: +tp2.toFixed(2) };
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

  runBacktest(candles) {
    const results = [];
    for (let i = 50; i < candles.length; i++) {
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
            index: i,
            type: signal.type,
            entry: signal.entry,
            tp1: signal.tp1,
            sl: signal.stopLoss,
            outcome,
            confidence: signal.confidence,
          });
        }
      }
    }
    return results;
  }
}
