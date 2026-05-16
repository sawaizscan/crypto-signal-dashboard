/**
 * PaperTrader — automated paper trading engine with leverage support
 * Executes signals with virtual margin × leverage, tracks P&L
 */

const STORAGE_KEY = 'crypto_paper_portfolio';

export class PaperTrader {
  constructor(initialBalance = 10000) {
    this.initialBalance = initialBalance;
    this.leverage = 10;
    this.marginPerTrade = 0.30;
    this.executor = null;
    this.executionMode = 'local';
    this.lastOrderResults = [];
    this.signalEngineRef = null;
    this.load();
  }

  setSignalEngine(engine) {
    this.signalEngineRef = engine;
  }

  setExecutor(executor) {
    this.executor = executor;
    this.executionMode = executor && executor.connected ? 'testnet' : 'local';
  }

  async setLeverageOnTestnet(symbol) {
    if (this.executor && this.executor.connected && this.executor.setLeverage) {
      try {
        await this.executor.setLeverage(symbol, this.leverage);
      } catch (err) {
        console.warn(`Failed to set leverage for ${symbol}:`, err.message);
      }
    }
  }

  load() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const data = JSON.parse(saved);
        this.cash = data.cash;
        this.positions = data.positions || {};
        this.trades = data.trades || [];
        this.initialBalance = data.initialBalance || this.initialBalance;
        this.leverage = data.leverage || this.leverage;
      } catch {
        this.reset();
      }
    } else {
      this.reset(true);
    }
  }

  save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      cash: this.cash,
      positions: this.positions,
      trades: this.trades,
      initialBalance: this.initialBalance,
      leverage: this.leverage,
    }));
  }

  reset(skipSave = false) {
    this.cash = this.initialBalance;
    this.positions = {};
    this.trades = [];
    if (!skipSave) this.save();
  }

  get equity() {
    let posValue = 0;
    for (const sym of Object.keys(this.positions)) {
      const p = this.positions[sym];
      const currentVal = p.quantity * (p.currentPrice || p.entryPrice);
      const pnl = currentVal - (p.margin * p.leverage);
      posValue += p.margin + pnl;
    }
    return this.cash + posValue;
  }

  get totalPnL() {
    return this.equity - this.initialBalance;
  }

  get totalPnLPercent() {
    return this.initialBalance > 0 ? (this.totalPnL / this.initialBalance) * 100 : 0;
  }

  get openPositionsCount() {
    return Object.keys(this.positions).length;
  }

  get totalTrades() {
    return this.trades.length;
  }

  get winRate() {
    const closed = this.trades.filter(t => t.pnl !== null);
    if (closed.length === 0) return 0;
    return (closed.filter(t => t.pnl > 0).length / closed.length) * 100;
  }

  async executeSignal(signal) {
    if (signal.type === 'NO TRADE') return null;
    if (signal.confidence < 15) return null;
    const price = signal.entry;
    if (signal.type === 'BUY') {
      return this.buy(signal.pair, price, signal);
    } else if (signal.type === 'SELL') {
      return this.sell(signal.pair, price, signal);
    }
    return null;
  }

  async buy(symbol, price, signal = null) {
    if (this.cash <= 1) return null;

    const margin = this.cash * this.marginPerTrade;
    if (margin < 1) return null;

    const positionValue = margin * this.leverage;
    const qty = positionValue / price;
    if (qty <= 0) return null;

    this.cash -= margin;

    const existing = this.positions[symbol];
    if (existing) {
      const totalMargin = existing.margin + margin;
      const totalQty = existing.quantity + qty;
      existing.quantity = totalQty;
      existing.margin = totalMargin;
      existing.entryPrice = (existing.entryPrice * existing.quantity + price * qty) / totalQty;
    } else {
      this.positions[symbol] = {
        quantity: qty,
        entryPrice: price,
        currentPrice: price,
        margin,
        leverage: this.leverage,
        stopLoss: signal?.stopLoss,
        tp1: signal?.tp1,
        tp2: signal?.tp2,
      };
    }

    await this.setLeverageOnTestnet(symbol);

    const trade = {
      type: 'BUY',
      symbol,
      price,
      quantity: qty,
      margin,
      leverage: this.leverage,
      time: new Date().toISOString(),
      pnl: null,
      confidence: signal?.confidence || 0,
      reasons: signal?.reasons || [],
      factors: signal?.factors || [],
      orderId: null,
    };

    if (this.executor && this.executor.connected) {
      try {
        const orderResult = await this.executor.placeMarketOrder(symbol, 'BUY', qty);
        trade.orderId = orderResult.orderId;
        trade.executedPrice = orderResult.price;
        this.lastOrderResults.push(orderResult);
      } catch (err) {
        trade.error = err.message;
      }
    }

    this.trades.push(trade);
    this.save();
    return { symbol, quantity: qty, price, margin, leverage: this.leverage };
  }

  async sell(symbol, price, signal = null) {
    const pos = this.positions[symbol];
    if (!pos) return null;

    const qty = pos.quantity;
    const pnl = (price - pos.entryPrice) * qty;
    const grossReturn = pos.margin + pnl;
    this.cash += grossReturn;

    delete this.positions[symbol];

    const trade = {
      type: 'SELL',
      symbol,
      price,
      quantity: qty,
      margin: pos.margin,
      leverage: pos.leverage,
      time: new Date().toISOString(),
      pnl,
      pnlPercent: ((price - pos.entryPrice) / pos.entryPrice) * 100 * pos.leverage,
      confidence: signal?.confidence || 0,
      reasons: signal?.reasons || [],
      factors: signal?.factors || [],
      orderId: null,
    };

    if (this.signalEngineRef && signal && signal.factors) {
      this.signalEngineRef.recordTradeOutcome(symbol, pos.entryPrice, price, signal.factors);
    }

    if (this.executor && this.executor.connected) {
      try {
        const orderResult = await this.executor.placeMarketOrder(symbol, 'SELL', qty);
        trade.orderId = orderResult.orderId;
        trade.executedPrice = orderResult.price;
        this.lastOrderResults.push(orderResult);
      } catch (err) {
        trade.error = err.message;
      }
    }

    this.trades.push(trade);
    this.save();
    return { symbol, quantity: qty, price, pnl };
  }

  updatePrices(prices) {
    for (const [symbol, price] of Object.entries(prices)) {
      if (this.positions[symbol]) {
        this.positions[symbol].currentPrice = price;
      }
    }
  }

  async checkStopLosses(prices) {
    const toClose = [];
    for (const [symbol, pos] of Object.entries(this.positions)) {
      const currPrice = prices[symbol];
      if (!currPrice) continue;
      pos.currentPrice = currPrice;

      if (pos.stopLoss) {
        if (pos.entryPrice < pos.stopLoss && currPrice <= pos.stopLoss) {
          toClose.push({ symbol, price: currPrice, reason: 'stop_loss' });
        } else if (pos.entryPrice > pos.stopLoss && currPrice >= pos.stopLoss) {
          toClose.push({ symbol, price: currPrice, reason: 'stop_loss' });
        }
      }

      if (pos.tp1) {
        if (pos.entryPrice < pos.tp1 && currPrice >= pos.tp1) {
          toClose.push({ symbol, price: currPrice, reason: 'take_profit_1' });
        } else if (pos.entryPrice > pos.tp1 && currPrice <= pos.tp1) {
          toClose.push({ symbol, price: currPrice, reason: 'take_profit_1' });
        }
      }
    }

    for (const close of toClose) {
      await this.sell(close.symbol, close.price);
    }
    return toClose;
  }
}
