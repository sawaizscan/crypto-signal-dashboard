/**
 * App — main orchestrator for the CryptoSignal Dashboard
 * Initializes modules, runs the real-time loop, handles user interaction
 */

import { DataFetcher } from './modules/dataFetcher.js';
import { computeAllIndicators } from './modules/indicators.js';
import { SignalEngine } from './modules/signalEngine.js';
import { UIRenderer } from './modules/uiRenderer.js';
import { PaperTrader } from './modules/paperTrader.js';
import { BinanceTestnet } from './modules/binanceTestnet.js';

class App {
  constructor() {
    this.fetcher = new DataFetcher();
    this.engine = new SignalEngine();
    this.ui = new UIRenderer();
    this.trader = new PaperTrader(10000);
    this.testnet = new BinanceTestnet();
    this.autoTrade = true;

    this.trader.setSignalEngine(this.engine);

    this.currentSymbol = 'SOLUSDT';
    this.interval = '1m';
    this.allTickers = [];
    this.candles = [];
    this.signals = [];
    this.refreshTimer = null;

    this._savedApiKey = localStorage.getItem('testnet_api_key') || '1ysNwTL4RkMVrIEA1P8afA2b8b2WDZa9uscfUh2V3mMpuMTibt02EFXQ1xCLntpv';
    this._savedSecretKey = localStorage.getItem('testnet_secret_key') || 'aOTGrVdk3jr4etaPeGcOSIwJiOso0QxBiQ54ODJJuLGtGryCrUNEkpMZ4gHf2PT4';
    this.hotPairs = [];
    this.ready = false;
  }

  async init() {
    try {
      this.ui.showLoading('signalPanel', 'Initializing...');
      this.ui.showLoading('marketGrid', 'Loading markets...');

      this.ui.initChart('chartContainer');

      const { klines, tickers } = await this.fetcher.fetchInitialData(this.currentSymbol, this.interval);
      this.candles = klines;
      this.allTickers = tickers;

      if (tickers.length > 0 && !tickers.some(t => t.symbol === this.currentSymbol)) {
        this.currentSymbol = tickers[0].symbol;
      }

      this.ui.populatePairSelector(tickers, this.currentSymbol);
      this.ui.renderTickerBar(tickers, this.currentSymbol);
      this.ui.renderMarketOverview(tickers);

      await this.analyzeAndRender();
      this.detectHotPairs();

      this.ui.renderPortfolio(this.trader);
      this.ui.renderPositions(this.trader);
      this.ui.renderTradeHistory(this.trader);

      this.ready = true;
      this.startRefreshLoop();
      this.bindEvents();
      document.getElementById('autoTradeToggle').checked = true;
      this.autoConnectTestnet();
    } catch (err) {
      console.error('Init error:', err);
      this.ui.showError('signalPanel', 'Failed to load data. Check console for details.');
      try {
        this.ui.renderPortfolio(this.trader);
        this.ui.renderPositions(this.trader);
        this.ui.renderTradeHistory(this.trader);
      } catch (_) {}
      this.ready = true;
      this.bindEvents();
      setTimeout(() => this.init(), 5000);
    }
  }

  async analyzeAndRender() {
    if (!this.candles || this.candles.length < 30) {
      this.ui.showLoading('signalPanel', 'Insufficient data...');
      return;
    }

    const ind = computeAllIndicators(this.candles);
    const signal = this.engine.generateSignal(this.currentSymbol, this.candles, ind);

    const signalEntry = this.signals.find(s => s.pair === this.currentSymbol);
    if (signalEntry) {
      Object.assign(signalEntry, signal);
    } else {
      this.signals.push(signal);
    }

    if (this.engine.isNewSignal(signal)) {
      this.ui.playAlertSound();
    }

    this.ui.updateChart(this.candles, ind);
    this.ui.renderSignal(signal);

    if (this.autoTrade && signal.type !== 'NO TRADE' && !this.trader.positions[signal.pair]) {
      const priceMap = {};
      priceMap[signal.pair] = signal.entry;
      this.trader.updatePrices(priceMap);
      await this.trader.executeSignal(signal);
    }
  }

  async scanAllSignals() {
    // SOL first (highest WR in backtests), then top volume pairs
    const solTicker = this.allTickers.find(t => t.symbol === 'SOLUSDT');
    let topPairs = this.allTickers.slice(0, 10);
    if (solTicker && !topPairs.some(t => t.symbol === 'SOLUSDT')) {
      topPairs = [solTicker, ...topPairs.slice(0, 9)];
    }

    const signalPromises = topPairs.map(async (ticker) => {
      try {
        const klines = await this.fetcher.fetchKlines(ticker.symbol, this.interval, 100);
        if (klines.length < 30) return null;
        const ind = computeAllIndicators(klines);
        return this.engine.generateSignal(ticker.symbol, klines, ind);
      } catch {
        return null;
      }
    });

    const results = (await Promise.all(signalPromises)).filter(Boolean);

    results.sort((a, b) => {
      const scoreA = a.type === 'BUY' ? a.confidence : a.type === 'SELL' ? a.confidence : -a.confidence;
      const scoreB = b.type === 'BUY' ? b.confidence : b.type === 'SELL' ? b.confidence : -b.confidence;
      return scoreB - scoreA;
    });

    for (const s of results) {
      const existing = this.signals.find(x => x.pair === s.pair);
      if (existing) Object.assign(existing, s);
      else this.signals.push(s);
    }

    if (this.autoTrade) {
      for (const s of results.slice(0, 5)) {
        if (s.type !== 'NO TRADE' && s.confidence >= 15 && !this.trader.positions[s.pair]) {
          await this.trader.executeSignal(s);
        }
      }
    }

    this.ui.renderSignalsList(results.slice(0, 5));
  }

  detectHotPairs() {
    this.hotPairs = this.allTickers
      .filter(t => t.volume > 0)
      .map(t => {
        const avgVol = this.allTickers.reduce((s, x) => s + x.volume, 0) / this.allTickers.length;
        const surgeRatio = t.volume / (avgVol || 1);
        return { ...t, surgeRatio };
      })
      .filter(t => t.surgeRatio > 2.5 && Math.abs(t.change) > 3)
      .sort((a, b) => b.surgeRatio - a.surgeRatio)
      .slice(0, 6);

    this.ui.renderHotPairs(this.hotPairs);
  }

  async refreshData() {
    try {
      const tickers = await this.fetcher.fetchTopPairs(30);
      this.allTickers = tickers;

      this.ui.renderTickerBar(tickers, this.currentSymbol);
      this.ui.renderMarketOverview(tickers);

      const priceMap = {};
      for (const t of tickers) {
        priceMap[t.symbol] = t.price;
      }
      this.trader.updatePrices(priceMap);
      await this.trader.checkStopLosses(priceMap);

      const klines = await this.fetcher.fetchKlines(this.currentSymbol, this.interval, 100);
      this.candles = klines;

      await this.analyzeAndRender();
      this.detectHotPairs();
      this.scanAllSignals();

      this.ui.renderPortfolio(this.trader);
      this.ui.renderPositions(this.trader);
      this.ui.renderTradeHistory(this.trader);
    } catch (err) {
      console.error('Refresh error:', err);
    }
  }

  startRefreshLoop() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(() => this.refreshData(), 5000);
  }

  async changePair(symbol) {
    if (symbol === this.currentSymbol) return;
    this.currentSymbol = symbol;
    this.ui.showLoading('signalPanel', 'Loading pair...');

    try {
      const klines = await this.fetcher.fetchKlines(symbol, this.interval, 100);
      this.candles = klines;

      document.getElementById('pairSelector').value = symbol;
      this.ui.renderTickerBar(this.allTickers, symbol);

      await this.analyzeAndRender();
    } catch (err) {
      console.error('Pair change error:', err);
      this.ui.showError('signalPanel', 'Error loading pair data');
    }
  }

  async changeTimeframe(tf) {
    this.interval = tf;
    this.ui.showLoading('signalPanel', 'Changing timeframe...');

    try {
      const klines = await this.fetcher.fetchKlines(this.currentSymbol, tf, 100);
      this.candles = klines;
      await this.analyzeAndRender();
    } catch (err) {
      console.error('Timeframe change error:', err);
    }
  }

  async connectTestnet() {
    const apiKey = document.getElementById('testnetApiKey').value.trim();
    const secretKey = document.getElementById('testnetSecretKey').value.trim();

    if (!apiKey || !secretKey) {
      this.ui.renderTestnetStatus('disconnected', 'Please enter both API key and secret key');
      return;
    }

    this.ui.renderTestnetStatus('loading', 'Connecting to Binance Futures Testnet...');

    try {
      const success = await this.testnet.setKeys(apiKey, secretKey);
      if (success) {
        this.trader.setExecutor(this.testnet);
        localStorage.setItem('testnet_api_key', apiKey);
        localStorage.setItem('testnet_secret_key', secretKey);
        const balance = this.testnet.getBalance();
        this.ui.renderTestnetStatus('connected', `Connected. USDT Balance: $${balance.toFixed(2)}`);
        this.ui.playAlertSound();
      }
    } catch (err) {
      this.ui.renderTestnetStatus('disconnected', `Connection failed: ${err.message}`);
      this.testnet.disconnect();
      this.trader.setExecutor(null);
    }
  }

  disconnectTestnet() {
    this.testnet.disconnect();
    this.trader.setExecutor(null);
    localStorage.removeItem('testnet_api_key');
    localStorage.removeItem('testnet_secret_key');
    this.ui.renderTestnetStatus('disconnected', 'Disconnected from testnet');
  }

  async autoConnectTestnet() {
    if (this._savedApiKey && this._savedSecretKey) {
      this.ui.setTestnetKeyFields(this._savedApiKey, this._savedSecretKey);
      this.ui.renderTestnetStatus('loading', 'Auto-connecting to testnet...');
      try {
        const success = await this.testnet.setKeys(this._savedApiKey, this._savedSecretKey);
        if (success) {
          this.trader.setExecutor(this.testnet);
          localStorage.setItem('testnet_api_key', this._savedApiKey);
          localStorage.setItem('testnet_secret_key', this._savedSecretKey);
          const balance = this.testnet.getBalance();
          this.ui.renderTestnetStatus('connected', `Connected. USDT Balance: $${balance.toFixed(2)}`);
        }
      } catch {
        this.testnet.disconnect();
        this.trader.setExecutor(null);
        this.ui.renderTestnetStatus('disconnected', 'Auto-connect failed — check keys in settings');
      }
    }
  }

  bindEvents() {
    document.getElementById('pairSelector').addEventListener('change', (e) => {
      this.changePair(e.target.value);
    });

    document.getElementById('timeframeSelector').addEventListener('change', (e) => {
      this.changeTimeframe(e.target.value);
    });

    document.addEventListener('pair-change', (e) => {
      this.changePair(e.detail);
    });

    document.getElementById('backtestBtn').addEventListener('click', () => {
      if (this.candles.length < 50) return;
      const results = this.engine.runBacktest(this.candles);
      this.ui.showBacktestModal(results);
    });

    document.getElementById('exportBtn').addEventListener('click', () => {
      this.ui.exportSignalHistoryToCSV(this.engine.signalHistory);
    });

    document.getElementById('autoTradeToggle').addEventListener('change', (e) => {
      this.autoTrade = e.target.checked;
      if (this.autoTrade) {
        this.ui.playAlertSound();
      }
    });

    document.getElementById('resetPortfolioBtn').addEventListener('click', () => {
      if (confirm('Reset paper trading portfolio to $10,000? This will clear all positions and history.')) {
        this.trader.reset(10000);
        this.ui.renderPortfolio(this.trader);
        this.ui.renderPositions(this.trader);
        this.ui.renderTradeHistory(this.trader);
      }
    });

    document.getElementById('settingsToggle').addEventListener('click', () => {
      const body = document.getElementById('settingsBody');
      body.classList.toggle('hidden');
    });

    document.getElementById('connectTestnetBtn').addEventListener('click', () => {
      this.connectTestnet();
    });

    document.getElementById('disconnectTestnetBtn').addEventListener('click', () => {
      this.disconnectTestnet();
    });
  }
}

const app = new App();
app.init();
