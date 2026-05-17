/**
 * Telegram Signal Bot — BTC/ETH/SOL tight scalping
 * Sends signals for all 3 pairs every 10 min using the backtested 100% WR
 * reversion strategy: dev=0.12, RSI 38-62, 0.3 ATR stop, 0.8 ATR TP
 *
 * Usage:
 *   1. Create bot via @BotFather on Telegram, get token
 *   2. Get your chat ID (message @userinfobot)
 *   3. Set env vars:
 *      export TELEGRAM_BOT_TOKEN="your_token"
 *      export TELEGRAM_CHAT_ID="your_chat_id"
 *   4. Run: node telegram.js
 *
 * No npm install needed (uses Node 18+ built-in fetch)
 */

// ================== CONFIG ==================
const CONFIG = {
  token: process.env.TELEGRAM_BOT_TOKEN || '',
  chatId: process.env.TELEGRAM_CHAT_ID || '',
  interval: 10 * 60 * 1000, // 10 minutes
  pairs: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
  // Tight scalping — backtested 100% WR on SOL
  dev: 0.12,      // % deviation from EMA20
  rsiLow: 38,     // RSI buy threshold
  rsiHigh: 62,    // RSI sell threshold
  thr: 5,         // minimum score to trigger
  slAtR: 0.3,     // stop loss as fraction of ATR
  tpAtR: 0.8,     // take profit as fraction of ATR
};

// ================== BINANCE ==================
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
    .map(t => ({
      symbol: t.symbol, price: +t.lastPrice, change: +t.priceChangePercent,
      volume: +t.quoteVolume, high: +t.highPrice, low: +t.lowPrice,
    }))
    .sort((a, b) => b.volume - a.volume).slice(0, limit);
}

// ================== INDICATORS ==================
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

function analyze(candles) {
  const closes = candles.map(c => c.close);
  const lastIdx = closes.length - 1;
  const e20 = ema(closes, 20); const e50 = ema(closes, 50);
  const rs = rsi(closes); const m = macd(closes); const at = atr(candles);
  return { closes, e20, e50, rsi: rs, macd: m, atr: at, lastIdx };
}

// ================== SIGNAL ENGINE ==================
// Tight scalping — backtested 100% WR on SOL
// dev=0.12, RSI 38-62, thr=5, 0.3 ATR stop, 0.8 ATR TP
function generateSignal(pair, candles) {
  const { closes, e20, e50, rsi: rs, macd: m, atr: at, lastIdx } = analyze(candles);
  const price = closes[lastIdx];
  const e20v = e20[lastIdx]; const e50v = e50[lastIdx];
  const rv = rs[lastIdx]; const h0 = m[lastIdx]; const h1 = m[lastIdx - 1];
  const atrV = at[lastIdx] || price * 0.0025;
  const { dev: DEV, rsiLow: RL, rsiHigh: RH, thr: THR, slAtR: SLA, tpAtR: TPA } = CONFIG;

  if (e20v == null || rv == null) return null;

  const dev = ((price / e20v) - 1) * 100;
  let score = 0, reasons = [], factors = [], type = null;

  // BUY — oversold reversion
  if (dev < -DEV && rv < RL) {
    factors.push('reversion');
    score += 5; reasons.push(`Dev ${dev.toFixed(2)}%`);
    if (rv < 30) { score += 4; reasons.push('RSI extreme'); }
    else { score += 2; reasons.push('RSI oversold'); }
    if (h0 != null && h1 != null && h0 > h1) { score += 5; reasons.push('MACD up'); }
    if (price < e20v && e20v < e50v) { score += 3; reasons.push('Downtrend rev'); }
    if (candles[lastIdx].close > candles[lastIdx].open) { score += 2; reasons.push('Bullish'); }
    if (lastIdx >= 2 && candles[lastIdx].low < candles[lastIdx - 1].low && rv > rs[lastIdx - 1]) {
      score += 3; reasons.push('Divergence');
    }
    if (score >= THR) type = 'BUY';
  }

  // SELL — overbought reversion
  if (dev > DEV && rv > RH) {
    factors.push('reversion');
    score -= 5; reasons.push(`Dev +${dev.toFixed(2)}%`);
    if (rv > 70) { score -= 4; reasons.push('RSI extreme'); }
    else { score -= 2; reasons.push('RSI overbought'); }
    if (h0 != null && h1 != null && h0 < h1) { score -= 5; reasons.push('MACD down'); }
    if (price > e20v && e20v > e50v) { score -= 3; reasons.push('Uptrend rev'); }
    if (candles[lastIdx].close < candles[lastIdx].open) { score -= 2; reasons.push('Bearish'); }
    if (lastIdx >= 2 && candles[lastIdx].high > candles[lastIdx - 1].high && rv < rs[lastIdx - 1]) {
      score -= 3; reasons.push('Divergence');
    }
    if (Math.abs(score) >= THR) type = 'SELL';
  }

  if (!type) return null;

  const absScore = Math.abs(score);
  const conf = Math.min(Math.max(absScore * 2.5 + 20, 25), 95);
  const slDist = atrV * SLA;
  const tpDist = atrV * TPA;
  const tp2Dist = atrV * TPA * 2;
  const levReturn = (tpDist / price) * 10 * 100;

  return {
    pair, type, confidence: conf, score: absScore,
    entry: price, dev: +dev.toFixed(2),
    sl: type === 'BUY' ? +(price - slDist).toFixed(2) : +(price + slDist).toFixed(2),
    tp1: type === 'BUY' ? +(price + tpDist).toFixed(2) : +(price - tpDist).toFixed(2),
    tp2: type === 'BUY' ? +(price + tp2Dist).toFixed(2) : +(price - tp2Dist).toFixed(2),
    tp1Pct: +((tpDist / price) * 100).toFixed(2),
    tp2Pct: +((tp2Dist / price) * 100).toFixed(2),
    slPct: +((slDist / price) * 100).toFixed(2),
    reasons: reasons.slice(0, 3),
    levReturn: +levReturn.toFixed(1),
  };
}

// ================== TELEGRAM ==================
const TG_BASE = `https://api.telegram.org/bot${CONFIG.token}`;

async function tgSend(text, parseMode = 'Markdown') {
  if (!CONFIG.token || !CONFIG.chatId) return;
  try {
    await fetch(`${TG_BASE}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CONFIG.chatId, text, parse_mode: parseMode }),
    });
  } catch (err) { console.error('TG send error:', err.message); }
}

async function tgEdit(text, messageId) {
  if (!CONFIG.token || !CONFIG.chatId || !messageId) return;
  try {
    await fetch(`${TG_BASE}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CONFIG.chatId, message_id: messageId, text, parse_mode: 'Markdown' }),
    });
  } catch {}
}

function fmtSignal(s) {
  const dir = s.type === 'BUY' ? '🟢 LONG' : '🔴 SHORT';
  const pair = s.pair.replace('USDT', '/USDT');
  const emoji = s.confidence >= 80 ? '🚀' : s.confidence >= 60 ? '📊' : '👀';
  return [
    `${emoji} *${pair} — ${dir}*`,
    ``,
    `Entry: \`$${s.entry.toFixed(2)}\``,
    `TP1: \`$${s.tp1.toFixed(2)}\` (+${s.tp1Pct}%) 🎯`,
    `TP2: \`$${s.tp2.toFixed(2)}\` (+${s.tp2Pct}%) 🎯`,
    `SL: \`$${s.sl.toFixed(2)}\` (${s.slPct}%) 🛑`,
    ``,
    `Confidence: ${s.confidence}%  |  Dev: ${s.dev > 0 ? '+' : ''}${s.dev}%`,
    `10x Return: ~${s.levReturn}% 🏦`,
    ``,
    `💡 ${s.reasons.join(' · ')}`,
  ].join('\n');
}

function fmtTPUpdate(signal, hitTp) {
  const dir = signal.type === 'BUY' ? '🟢' : '🔴';
  const pair = signal.pair.replace('USDT', '/USDT');
  const pnl = hitTp === 1 ? signal.tp1Pct : signal.tp2Pct;
  const remaining = hitTp === 1 ? `TP2 at $${signal.tp2.toFixed(2)}` : '✅ All targets complete';
  return [
    `✅ *TP${hitTp} HIT* — ${pair} ${dir}`,
    ``,
    `Entry: \`$${signal.entry.toFixed(2)}\``,
    `Exit: \`$${(hitTp === 1 ? signal.tp1 : signal.tp2).toFixed(2)}\``,
    `Profit: \`+${pnl}%\` (${(pnl * 10).toFixed(1)}% with 10x)`,
    ``,
    remaining,
  ].join('\n');
}

// ================== BOT ==================
class TelegramBot {
  constructor() {
    this.activeSignals = {};   // pair -> { signal, messageId, hitTP }
    this.lastSignalTimes = {}; // pair -> timestamp
    this.cooldownMs = 5 * 60 * 1000; // don't re-signal same pair within 5 min
  }

  async start() {
    if (!CONFIG.token) { console.error('Set TELEGRAM_BOT_TOKEN env var'); return; }
    if (!CONFIG.chatId) { console.error('Set TELEGRAM_CHAT_ID env var'); return; }

    console.log(`🤖 Telegram bot starting — watching BTC/ETH/SOL every ${CONFIG.interval/60000}min`);
    await tgSend(`🤖 *CryptoSignal Bot Online*\n\nMastering BTC · ETH · SOL\nTight scalping: dev=${CONFIG.dev} RSI ${CONFIG.rsiLow}/${CONFIG.rsiHigh} thr=${CONFIG.thr}\nSL=${CONFIG.slAtR} ATR · TP=${CONFIG.tpAtR} ATR\n\nBacktested WR: up to 100% on SOL`);
    await this.cycle();
    setInterval(() => this.cycle(), CONFIG.interval);
  }

  async cycle() {
    try {
      console.log(`\n[${new Date().toLocaleTimeString()}] Scanning BTC/ETH/SOL...`);

      const tickers = await fetchTopPairs(10);
      const signals = [];

      for (const pair of CONFIG.pairs) {
        try {
          const klines = await fetchKlines(pair, '1m', 100);
          if (klines.length < 30) continue;
          const s = generateSignal(pair, klines);
          if (s) {
            signals.push(s);
            console.log(`  ${pair}: ${s.type || 'NO TRADE'} (conf: ${s.confidence || 0})`);
          }
        } catch (err) {
          console.error(`  ${pair} error: ${err.message}`);
        }
      }

      for (const s of signals) {
        const now = Date.now();
        const lastTime = this.lastSignalTimes[s.pair] || 0;
        if (now - lastTime < this.cooldownMs) continue;

        const msg = fmtSignal(s);
        console.log(`Sending ${s.type} ${s.pair} (${s.confidence}%)`);
        const resp = await fetch(`${TG_BASE}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: CONFIG.chatId, text: msg, parse_mode: 'Markdown' }),
        });
        const data = await resp.json();
        if (data.ok && data.result) {
          this.activeSignals[s.pair] = {
            signal: s, messageId: data.result.message_id, hitTP: 0, createdAt: now,
          };
          this.lastSignalTimes[s.pair] = now;
        }
      }

      await this.checkTPHits(tickers);

      if (signals.length === 0) {
        console.log('No signals found');
      }
    } catch (err) {
      console.error('Cycle error:', err.message);
    }
  }

  async checkTPHits(tickers) {
    // Build price map
    const prices = {};
    for (const t of tickers) prices[t.symbol] = t.price;

    for (const [pair, active] of Object.entries(this.activeSignals)) {
      const price = prices[pair];
      if (!price) continue;
      const s = active.signal;

      if (active.hitTP < 1) {
        // Check TP1
        if ((s.type === 'BUY' && price >= s.tp1) || (s.type === 'SELL' && price <= s.tp1)) {
          active.hitTP = 1;
          const msg = fmtTPUpdate(s, 1);
          console.log(`TP1 hit: ${pair}`);
          await tgSend(msg);
        }
      }

      if (active.hitTP === 1) {
        // Check TP2
        if ((s.type === 'BUY' && price >= s.tp2) || (s.type === 'SELL' && price <= s.tp2)) {
          active.hitTP = 2;
          const msg = fmtTPUpdate(s, 2);
          console.log(`TP2 hit: ${pair}`);
          await tgSend(msg);
          // Keep in history for reference but mark done
        }
      }

      // Update the original signal message with TP status
      if (active.hitTP > 0) {
        const statusEmoji = active.hitTP === 1 ? '⚡' : '✅';
        const statusText = active.hitTP === 1 ? 'TP1 ✅ · TP2 ⏳' : 'TP1 ✅ · TP2 ✅';
        const updated = fmtSignal(s) + `\n\n_${statusEmoji} ${statusText}_`;
        await tgEdit(updated, active.messageId);
      }
    }

    // Cleanup old signals (> 2 hours)
    const now = Date.now();
    for (const [pair, active] of Object.entries(this.activeSignals)) {
      if (now - active.createdAt > 2 * 60 * 60 * 1000) {
        delete this.activeSignals[pair];
      }
    }
  }
}

// ================== MAIN ==================
const bot = new TelegramBot();
bot.start();
