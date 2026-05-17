import { DataFetcher } from './modules/dataFetcher.js';
import { computeAllIndicators } from './modules/indicators.js';
import { SignalEngine } from './modules/signalEngine.js';
import { UIRenderer } from './modules/uiRenderer.js';
import { PaperTrader } from './modules/paperTrader.js';
import { BinanceTestnet } from './modules/binanceTestnet.js';
import { Evaluator } from './modules/evaluator.js';

const PAIRS = ['SOLUSDT', 'BTCUSDT', 'ETHUSDT'];

class App {
  constructor() {
    this.fetcher = new DataFetcher();
    this.engine = new SignalEngine();
    this.ui = new UIRenderer();
    this.trader = new PaperTrader(10000);
    this.testnet = new BinanceTestnet();
    this.autoTrade = true;
    this.activePair = 'SOLUSDT';
    this.interval = '1m';
    this.candles = {};
    this.allTickers = [];
    this.signals = {};
    this.refreshTimer = null;
    this._savedApiKey = localStorage.getItem('testnet_api_key') || '1ysNwTL4RkMVrIEA1P8afA2b8b2WDZa9uscfUh2V3mMpuMTibt02EFXQ1xCLntpv';
    this._savedSecretKey = localStorage.getItem('testnet_secret_key') || 'aOTGrVdk3jr4etaPeGcOSIwJiOso0QxBiQ54ODJJuLGtGryCrUNEkpMZ4gHf2PT4';
    this.serverUrl = localStorage.getItem('bot_server_url') || '';
    this.serverMode = false;
    this._serverTrades = [];
    this._serverPositions = [];
    this.tradeLog = [];
    this.evaluator = new Evaluator();
    this._evalTimer = null;
    this._evalIntervalMin = 15;
  }

  async init() {
    try {
      this.ui.initChart('chartContainer');
      const tickers = await this.fetcher.fetchTopPairs(30);
      this.allTickers = tickers;

      await this.fetchAllPairCandles();
      await this.runAllAnalysis();

      this.ui.renderPortfolio(this.trader);
      this.ui.renderPositions(this.trader);
      this.ui.renderTradeHistory(this.trader);

      this.startRefreshLoop();
      this.startEvaluationLoop();
      this.bindEvents();
      this.autoConnectTestnet();
      this.tryConnectServer();
    } catch (err) {
      console.error('Init error:', err);
      this.bindEvents();
      setTimeout(() => this.init(), 5000);
    }
  }

  async tryConnectServer() {
    const urls = [];
    if (this.serverUrl) urls.push(this.serverUrl);
    urls.push('http://localhost:3001');
    for (const url of urls) {
      try {
        const resp = await fetch(`${url}/api/health`);
        if (resp.ok) {
          this.serverUrl = url;
          this.serverMode = true;
          localStorage.setItem('bot_server_url', url);
          return;
        }
      } catch {}
    }
    this.serverMode = false;
  }

  async fetchAllPairCandles() {
    const results = await Promise.all(
      PAIRS.map(async (pair) => {
        try {
          const klines = await this.fetcher.fetchKlines(pair, this.interval, 100);
          return { pair, klines };
        } catch {
          return { pair, klines: [] };
        }
      })
    );
    for (const r of results) {
      this.candles[r.pair] = r.klines;
    }
  }

  async runAllAnalysis() {
    for (const pair of PAIRS) {
      const klines = this.candles[pair];
      if (!klines || klines.length < 30) continue;
      const ind = computeAllIndicators(klines);
      const signal = this.engine.generateSignal(pair, klines, ind);
      this.signals[pair] = signal;
      this.ui.updateSignalCard(pair, signal);
      if (this.engine.isNewSignal(signal)) {
        this.ui.playAlertSound();
      }
    }

    await this.computeSentiment();
  }

  async computeSentiment() {
    const dailySentiment = await this._computeDailySentiment();
    const shortSentiment = this._computeShortSentiment();

    const bearPct = (1 - shortSentiment.bullScore) * 100;
    this.ui.updateSentiment(
      { bull: dailySentiment.bullScore * 100, bear: (1 - dailySentiment.bullScore) * 100, emoji: dailySentiment.emoji },
      { bull: shortSentiment.bullScore * 100, bear: bearPct, emoji: shortSentiment.emoji }
    );
  }

  async _computeDailySentiment() {
    let bullCount = 0;
    let totalPairs = 0;
    for (const pair of PAIRS) {
      try {
        const klines = await this.fetcher.fetchKlines(pair, '1d', 100);
        if (klines.length < 50) continue;
        const closes = klines.map(c => c.close);
        const { ema20, ema50, ema200, rsi } = computeAllIndicators(klines);
        const lastIdx = klines.length - 1;
        const price = closes[lastIdx];
        const p20 = ema20[lastIdx];
        const p50 = ema50[lastIdx];
        const p200 = ema200[lastIdx];
        const r = rsi[lastIdx];
        let score = 0;
        if (price > p20) score++;
        if (p20 > p50) score++;
        if (p50 > p200) score++;
        if (r > 50) score++;
        if (r > 60) score++;
        if (closes[lastIdx] > closes[lastIdx - 1]) score++;
        if (closes[lastIdx - 1] > closes[lastIdx - 2]) score++;
        bullCount += score / 7;
        totalPairs++;
      } catch {}
    }
    const avgBullScore = totalPairs > 0 ? bullCount / totalPairs : 0.5;
    let emoji = avgBullScore > 0.6 ? '🟢' : avgBullScore > 0.4 ? '🟡' : '🔴';
    return { bullScore: avgBullScore, emoji };
  }

  _computeShortSentiment() {
    let bullCount = 0;
    let totalPairs = 0;
    for (const pair of PAIRS) {
      const klines = this.candles[pair];
      if (!klines || klines.length < 30) continue;
      const ind = computeAllIndicators(klines);
      const lastIdx = klines.length - 1;
      const price = ind.closes[lastIdx];
      const p20 = ind.ema20[lastIdx];
      const p50 = ind.ema50[lastIdx];
      const r = ind.rsi[lastIdx];
      let score = 0;
      if (price > p20) score++;
      if (p20 > p50) score++;
      if (r > 50) score++;
      if (ind.macd.histogram[lastIdx] > 0) score++;
      if (ind.breakouts[lastIdx]?.direction === 'bullish') score++;
      if (ind.trend === 'bullish') score++;
      if (klines[lastIdx].close > klines[lastIdx].open) score++;
      bullCount += score / 7;
      totalPairs++;
    }
    const avgBullScore = totalPairs > 0 ? bullCount / totalPairs : 0.5;
    let emoji = avgBullScore > 0.55 ? '🟢' : avgBullScore > 0.45 ? '🟡' : '🔴';
    return { bullScore: avgBullScore, emoji };
  }

  async refreshData() {
    try {
      const tickers = await this.fetcher.fetchTopPairs(30);
      this.allTickers = tickers;

      const priceMap = {};
      for (const t of tickers) {
        if (PAIRS.includes(t.symbol)) priceMap[t.symbol] = t.price;
      }
      this.trader.updatePrices(priceMap);
      await this.trader.checkStopLosses(priceMap);

      await this.fetchAllPairCandles();
      await this.runAllAnalysis();

      if (this.activePair && this.candles[this.activePair]?.length > 0) {
        const ind = computeAllIndicators(this.candles[this.activePair]);
        this.ui.updateChart(this.candles[this.activePair], ind);
      }

      if (this.autoTrade) {
        for (const pair of PAIRS) {
          const s = this.signals[pair];
          if (s && s.type !== 'NO TRADE' && s.confidence >= 15 && !this.trader.positions[pair]) {
            await this.trader.executeSignal(s);
          }
        }
      }

      this.ui.renderPortfolio(this.trader);
      this.ui.renderPositions(this.trader);
      this.ui.renderTradeHistory(this.trader);

      const miniPnl = this.trader.totalPnL;
      this.ui.updatePortfolioMini(this.trader.equity, miniPnl, this.trader.totalTrades, this.trader.winRate);

      this.ui.updateTime();

      if (this.testnet.connected) {
        await this.trader.syncFromTestnet();
      }
    } catch (err) {
      console.error('Refresh error:', err);
    }
  }

  startRefreshLoop() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(() => this.refreshData(), 5000);
  }

  startEvaluationLoop() {
    const ms = this._evalIntervalMin * 60 * 1000;
    const run = () => {
      const report = this.evaluator.snapshot(this.trader, this.signals, this.engine);
      const nextMin = this._evalIntervalMin;
      this.ui.renderEvaluation(report, this.evaluator.snapshots.length, nextMin);
    };
    setTimeout(run, 60 * 1000); // first run in 1 min
    this._evalTimer = setInterval(run, ms);
  }

  changeInterval(tf) {
    this.interval = tf;
    this.fetchAllPairCandles().then(() => {
      this.runAllAnalysis();
      if (this.activePair && this.candles[this.activePair]?.length > 0) {
        const ind = computeAllIndicators(this.candles[this.activePair]);
        this.ui.updateChart(this.candles[this.activePair], ind);
      }
    });
  }

  setActivePair(pair) {
    this.activePair = pair;
    this.ui.setActivePair(pair);
    if (this.candles[pair]?.length > 0) {
      const ind = computeAllIndicators(this.candles[pair]);
      this.ui.updateChart(this.candles[pair], ind);
      this.ui.updateChartTitle(pair);
    }
  }

  async connectTestnet() {
    const apiKey = document.getElementById('testnetApiKey')?.value.trim();
    const secretKey = document.getElementById('testnetSecretKey')?.value.trim();
    if (!apiKey || !secretKey) return;
    try {
      const success = await this.testnet.setKeys(apiKey, secretKey);
      if (success) {
        this.trader.setExecutor(this.testnet);
        this.trader.enableTestnetPortfolio();
        localStorage.setItem('testnet_api_key', apiKey);
        localStorage.setItem('testnet_secret_key', secretKey);
        await this.trader.syncFromTestnet();
      }
    } catch {
      this.testnet.disconnect();
      this.trader.setExecutor(null);
    }
  }

  disconnectTestnet() {
    this.testnet.disconnect();
    this.trader.setExecutor(null);
    this.trader.disableTestnetPortfolio();
    localStorage.removeItem('testnet_api_key');
    localStorage.removeItem('testnet_secret_key');
  }

  async autoConnectTestnet() {
    if (this._savedApiKey && this._savedSecretKey) {
      try {
        const success = await this.testnet.setKeys(this._savedApiKey, this._savedSecretKey);
        if (success) {
          this.trader.setExecutor(this.testnet);
          this.trader.enableTestnetPortfolio();
          await this.trader.syncFromTestnet();
        }
      } catch {
        this.testnet.disconnect();
        this.trader.setExecutor(null);
      }
    }
  }

  bindEvents() {
    document.querySelectorAll('.pair-pill').forEach(el => {
      el.addEventListener('click', () => {
        const pair = el.dataset.pair;
        this.setActivePair(pair);
      });
    });

    document.querySelectorAll('.chart-btn').forEach(el => {
      el.addEventListener('click', () => {
        document.querySelectorAll('.chart-btn').forEach(b => b.classList.remove('active'));
        el.classList.add('active');
        this.changeInterval(el.dataset.tf);
      });
    });

    document.getElementById('autoTradeToggle')?.addEventListener('change', (e) => {
      this.autoTrade = e.target.checked;
    });

    document.getElementById('resetPortfolioBtn')?.addEventListener('click', () => {
      if (this.trader.useTestnetPortfolio) {
        this.trader.syncFromTestnet();
      } else {
        if (confirm('Reset paper trading portfolio to $10,000?')) {
          this.trader.reset(10000);
        }
      }
      this.ui.renderPortfolio(this.trader);
      this.ui.renderPositions(this.trader);
      this.ui.renderTradeHistory(this.trader);
    });

    document.getElementById('settingsToggle')?.addEventListener('click', () => {
      document.getElementById('settingsModal')?.classList.toggle('hidden');
    });

    document.getElementById('settingsClose')?.addEventListener('click', () => {
      document.getElementById('settingsModal')?.classList.add('hidden');
    });

    document.getElementById('connectTestnetBtn')?.addEventListener('click', () => this.connectTestnet());
    document.getElementById('disconnectTestnetBtn')?.addEventListener('click', () => this.disconnectTestnet());

    document.getElementById('connectServerBtn')?.addEventListener('click', async () => {
      const url = document.getElementById('serverUrl')?.value.trim();
      if (!url) return;
      try {
        const resp = await fetch(`${url}/api/health`);
        if (resp.ok) {
          this.serverUrl = url;
          this.serverMode = true;
          localStorage.setItem('bot_server_url', url);
        }
      } catch {}
    });

    document.getElementById('evalToggle')?.addEventListener('click', () => {
      document.getElementById('evalBody')?.classList.toggle('hidden');
      document.getElementById('evalToggle')?.classList.toggle('active');
    });

    document.getElementById('evalResetBtn')?.addEventListener('click', () => {
      if (confirm('Reset evaluation data? This will clear all snapshots.')) {
        this.evaluator.reset();
        const badge = document.getElementById('evalBadge');
        if (badge) { badge.textContent = 'Collecting...'; badge.className = 'eval-badge'; }
        document.getElementById('evalBody')?.classList.add('hidden');
        document.getElementById('evalToggle')?.classList.remove('active');
      }
    });
  }
}

const app = new App();
app.init();
