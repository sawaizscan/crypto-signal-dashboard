/**
 * Indicators — technical analysis indicator calculations
 * All functions are pure; no side effects
 */

export function calculateSMA(values, period) {
  const result = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      result.push(null);
    } else {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += values[j];
      result.push(sum / period);
    }
  }
  return result;
}

export function calculateEMA(values, period) {
  const result = [];
  const multiplier = 2 / (period + 1);
  let ema = null;
  for (let i = 0; i < values.length; i++) {
    if (i === 0) {
      ema = values[i];
      result.push(ema);
    } else {
      ema = (values[i] - ema) * multiplier + ema;
      result.push(ema);
    }
  }
  return result;
}

export function calculateRSI(closes, period = 14) {
  const rsi = [];
  let gains = 0, losses = 0;
  for (let i = 0; i < closes.length; i++) {
    if (i < 1) {
      rsi.push(null);
      continue;
    }
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    if (i === 1) {
      gains = gain;
      losses = loss;
    } else {
      gains = (gains * (period - 1) + gain) / period;
      losses = (losses * (period - 1) + loss) / period;
    }
    if (i < period) {
      rsi.push(null);
      continue;
    }
    if (losses === 0) {
      rsi.push(100);
    } else {
      const rs = gains / losses;
      rsi.push(100 - 100 / (1 + rs));
    }
  }
  return rsi;
}

export function calculateMACD(closes) {
  const ema12 = calculateEMA(closes, 12);
  const ema26 = calculateEMA(closes, 26);
  const macdLine = ema12.map((v, i) => v !== null && ema26[i] !== null ? v - ema26[i] : null);
  const signalLine = calculateEMA(macdLine.filter(v => v !== null), 9);
  let sigIdx = 0;
  const histogram = macdLine.map((v, i) => {
    if (v === null) return null;
    const sig = signalLine[sigIdx] ?? 0;
    sigIdx++;
    return v - sig;
  });
  return { macdLine, signalLine, histogram };
}

export function detectVolumeSpike(volumes, multiplier = 1.5) {
  const spikes = [];
  for (let i = 0; i < volumes.length; i++) {
    if (i < 20) {
      spikes.push(false);
      continue;
    }
    let sum = 0;
    for (let j = i - 20; j < i; j++) sum += volumes[j];
    const avg = sum / 20;
    spikes.push(volumes[i] > avg * multiplier);
  }
  return spikes;
}

export function detectHigherHighs(highs, lookback = 5) {
  const results = [];
  for (let i = 0; i < highs.length; i++) {
    if (i < lookback) {
      results.push(false);
      continue;
    }
    const recent = highs.slice(i - lookback, i);
    const prevHigh = Math.max(...recent);
    results.push(highs[i] > prevHigh);
  }
  return results;
}

export function detectLowerLows(lows, lookback = 5) {
  const results = [];
  for (let i = 0; i < lows.length; i++) {
    if (i < lookback) {
      results.push(false);
      continue;
    }
    const recent = lows.slice(i - lookback, i);
    const prevLow = Math.min(...recent);
    results.push(lows[i] < prevLow);
  }
  return results;
}

export function detectBreakout(highs, lows, closes, lookback = 10) {
  const results = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < lookback) {
      results.push({ direction: null, level: null });
      continue;
    }
    const rangeHigh = Math.max(...highs.slice(i - lookback, i));
    const rangeLow = Math.min(...lows.slice(i - lookback, i));
    if (closes[i] > rangeHigh) {
      results.push({ direction: 'bullish', level: rangeHigh });
    } else if (closes[i] < rangeLow) {
      results.push({ direction: 'bearish', level: rangeLow });
    } else {
      results.push({ direction: null, level: null });
    }
  }
  return results;
}

export function detectPinBar(candles, wickThreshold = 2.5) {
  const results = [];
  for (const c of candles) {
    const body = Math.abs(c.close - c.open);
    const upperWick = c.high - Math.max(c.open, c.close);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    const dir = c.close > c.open ? 'bullish' : 'bearish';
    if (body === 0) {
      results.push({ isPinBar: false, direction: null });
      continue;
    }
    if (dir === 'bullish' && lowerWick > body * wickThreshold && upperWick < body * 0.5) {
      results.push({ isPinBar: true, direction: 'bullish' });
    } else if (dir === 'bearish' && upperWick > body * wickThreshold && lowerWick < body * 0.5) {
      results.push({ isPinBar: true, direction: 'bearish' });
    } else {
      results.push({ isPinBar: false, direction: null });
    }
  }
  return results;
}

export function findSupportResistance(highs, lows) {
  const levels = [];
  const bins = {};
  for (let i = 0; i < highs.length; i++) {
    const rounded = Math.round(highs[i] * 100) / 100;
    bins[rounded] = (bins[rounded] || 0) + 1;
  }
  for (let i = 0; i < lows.length; i++) {
    const rounded = Math.round(lows[i] * 100) / 100;
    bins[rounded] = (bins[rounded] || 0) + 1;
  }
  const threshold = Math.max(3, Math.floor(highs.length * 0.04));
  for (const [price, count] of Object.entries(bins)) {
    if (count >= threshold) {
      levels.push(parseFloat(price));
    }
  }
  levels.sort((a, b) => a - b);
  return levels;
}

export function classifyTrend(ema20, ema50, ema200) {
  const last = (arr) => arr[arr.length - 1];
  const p20 = last(ema20), p50 = last(ema50), p200 = last(ema200);
  if (p20 == null || p50 == null || p200 == null) return 'unknown';
  if (p20 > p50 && p50 > p200) return 'bullish';
  if (p20 < p50 && p50 < p200) return 'bearish';
  return 'sideways';
}

export function computeAllIndicators(candles) {
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);

  const rsi = calculateRSI(closes);
  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);
  const ema200 = calculateEMA(closes, 200);
  const macd = calculateMACD(closes);
  const volumeSpikes = detectVolumeSpike(volumes);
  const higherHighs = detectHigherHighs(highs);
  const lowerLows = detectLowerLows(lows);
  const breakouts = detectBreakout(highs, lows, closes);
  const pinBars = detectPinBar(candles);
  const trend = classifyTrend(ema20, ema50, ema200);
  const supportResistance = findSupportResistance(highs, lows);

  return {
    closes, highs, lows, volumes,
    rsi, ema20, ema50, ema200, macd,
    volumeSpikes, higherHighs, lowerLows,
    breakouts, pinBars, trend, supportResistance,
  };
}
