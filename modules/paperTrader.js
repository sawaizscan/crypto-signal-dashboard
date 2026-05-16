/**
 * PaperTrader — automated paper trading engine
 * Executes signals with virtual funds, tracks positions, P&L, and trade history
 */

const STORAGE_KEY = 'crypto_paper_portfolio';

export class PaperTrader {
  constructor(initialBalance = 10000) {
    this.initialBalance = initialBalance;
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

  load() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const data = JSON.parse(saved);
      this.cash = data.cash;
      this.positions = data.positions || {};
      this.trades = data.trades || [];
      this.initialBalance = data.initialBalance || this.initialBalance;
    } else {
      this.cash = this.initialBalance;
      this.positions = {};
      this.trades = [];
    }
  }

  save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      cash: this.cash,
      positions: this.positions,
      trades: this.trades,
      initialBalance: this.initialBalance,
    }));
  }

  reset(balance = 10000) {
    this.initialBalance = balance;
    this.cash = balance;
    this.positions = {};
    this.trades = [];
    this.save();
  }

  get equity() {
    let posValue = 0;
    for (const sym of Object.keys(this.positions)) {
      posValue += this.positions[sym].quantity * (this.positions[sym].currentPrice || this.positions[sym].entryPrice);
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

  positionSize(price) {
    const riskPerTrade = 0.33;
    const maxAmount = this.cash * riskPerTrade;
    const fixedQty = maxAmount / price;
    return Math.max(fixedQty, 0);
  }

  async executeSignal(signal) {
    if (signal.type === 'NO TRADE') return null;
    if (signal.confidence < 20) return null;

    const price = signal.entry;

    if (signal.type === 'BUY') {
      return this.buy(signal.pair, price, signal);
    } else if (signal.type === 'SELL') {
      return this.sell(signal.pair, price, signal);
    }
    return null;
  }

  async buy(symbol, price, signal = null) {
    const qty = this.positionSize(price);
    if (qty <= 0 || this.cash <= 0) return null;

    const cost = qty * price;

    if (cost > this.cash) {
      const affordableQty = (this.cash * 0.98) / price;
      if (affordableQty <= 0) return null;
      return this.buy(symbol, price, { ...signal, entry: price });
    }

    const existing = this.positions[symbol];
    if (existing) {
      const totalQty = existing.quantity + qty;
      const totalCost = existing.quantity * existing.entryPrice + cost;
      existing.quantity = totalQty;
      existing.entryPrice = totalCost / totalQty;
    } else {
      this.positions[symbol] = {
        quantity: qty,
        entryPrice: price,
        currentPrice: price,
        stopLoss: signal?.stopLoss,
        tp1: signal?.tp1,
        tp2: signal?.tp2,
      };
    }

    this.cash -= cost;
    const trade = {
      type: 'BUY',
      symbol,
      price,
      quantity: qty,
      time: new Date().toISOString(),
      pnl: null,
      confidence: signal?.confidence || 0,
      reasons: signal?.reasons || [],
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
    return { symbol, quantity: qty, price, cost, trade };
  }

  async sell(symbol, price, signal = null) {
    const position = this.positions[symbol];
    if (!position) return null;

    const qty = position.quantity;
    const proceeds = qty * price;
    const pnl = (price - position.entryPrice) * qty;

    this.cash += proceeds;
    delete this.positions[symbol];

    const trade = {
      type: 'SELL',
      symbol,
      price,
      quantity: qty,
      time: new Date().toISOString(),
      pnl,
      pnlPercent: ((price - position.entryPrice) / position.entryPrice) * 100,
      confidence: signal?.confidence || 0,
      reasons: signal?.reasons || [],
      factors: signal?.factors || [],
      orderId: null,
    };

    if (this.signalEngineRef && signal && signal.factors) {
      this.signalEngineRef.recordTradeOutcome(symbol, position.entryPrice, price, signal.factors);
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
    return { symbol, quantity: qty, price, proceeds, pnl, trade };
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
