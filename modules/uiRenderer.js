/**
 * UIRenderer — all DOM manipulation and chart rendering
 * Requires Lightweight Charts on window.LightweightCharts
 */

export class UIRenderer {
  constructor() {
    this.chart = null;
    this.candleSeries = null;
    this.volumeSeries = null;
    this.ema20Line = null;
    this.ema50Line = null;
    this.lineSeriesMap = {};
    this.currentPair = null;
  }

  fmtPrice(v) {
    if (v == null || isNaN(v)) return '—';
    if (v >= 1000) return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (v >= 1) return v.toFixed(4);
    return v.toFixed(6);
  }

  fmtPriceShort(v) {
    if (v == null || isNaN(v)) return '—';
    if (v >= 1000) return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (v >= 1) return v.toFixed(2);
    return v.toFixed(4);
  }

  fmtVolume(v) {
    if (v == null || isNaN(v)) return '—';
    if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(2) + 'K';
    return v.toFixed(0);
  }

  initChart(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return false;

    this.chart = LightweightCharts.createChart(container, {
      layout: {
        background: { color: '#111827' },
        textColor: '#8899bb',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: '#1a2332' },
        horzLines: { color: '#1a2332' },
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
        vertLine: { color: '#3a4a6a', width: 1, style: LightweightCharts.LineStyle.Dashed },
        horzLine: { color: '#3a4a6a', width: 1, style: LightweightCharts.LineStyle.Dashed },
      },
      timeScale: {
        borderColor: '#253040',
        timeVisible: true,
        secondsVisible: false,
      },
      rightPriceScale: {
        borderColor: '#253040',
      },
    });

    this.candleSeries = this.chart.addCandlestickSeries({
      upColor: '#00c853',
      downColor: '#ff1744',
      borderDownColor: '#ff1744',
      borderUpColor: '#00c853',
      wickDownColor: '#ff1744',
      wickUpColor: '#00c853',
    });

    this.volumeSeries = this.chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    });

    this.chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });

    this.ema20Line = this.chart.addLineSeries({
      color: '#2979ff',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    this.ema50Line = this.chart.addLineSeries({
      color: '#ff9100',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    this.chart.timeScale().fitContent();
    return true;
  }

  updateChart(candles, ind) {
    if (!this.chart || !this.candleSeries) return;

    const candleData = candles.map(c => ({
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
    this.candleSeries.setData(candleData);

    const volData = candles.map((c, i) => {
      const isUp = c.close >= c.open;
      return {
        time: c.time,
        value: c.volume,
        color: isUp ? 'rgba(0,200,83,0.3)' : 'rgba(255,23,68,0.3)',
      };
    });
    this.volumeSeries.setData(volData);

    const ema20Data = [];
    const ema50Data = [];
    candles.forEach((c, i) => {
      const v20 = ind.ema20[i];
      const v50 = ind.ema50[i];
      if (v20 !== null) ema20Data.push({ time: c.time, value: v20 });
      if (v50 !== null) ema50Data.push({ time: c.time, value: v50 });
    });
    this.ema20Line.setData(ema20Data);
    this.ema50Line.setData(ema50Data);

    this.chart.timeScale().fitContent();
  }

  renderTickerBar(tickers, activeSymbol) {
    const bar = document.getElementById('tickerBar');
    if (!bar) return;
    bar.innerHTML = tickers.map(t => {
      const cls = t.symbol === activeSymbol ? 'ticker-item active' : 'ticker-item';
      const chgCls = t.change >= 0 ? 'pos' : 'neg';
      const chgSign = t.change >= 0 ? '+' : '';
      return `<div class="${cls}" data-symbol="${t.symbol}">
        <span class="ticker-symbol">${t.symbol.replace('USDT', '')}</span>
        <span class="ticker-price">${this.fmtPriceShort(t.price)}</span>
        <span class="ticker-change ${chgCls}">${chgSign}${t.change.toFixed(2)}%</span>
      </div>`;
    }).join('');

    bar.querySelectorAll('.ticker-item').forEach(el => {
      el.addEventListener('click', () => {
        const evt = new CustomEvent('pair-change', { detail: el.dataset.symbol });
        document.dispatchEvent(evt);
      });
    });
  }

  renderMarketOverview(tickers) {
    const grid = document.getElementById('marketGrid');
    if (!grid) return;
    grid.innerHTML = tickers.slice(0, 12).map(t => {
      const cls = t.change >= 0 ? 'pos' : 'neg';
      const sign = t.change >= 0 ? '+' : '';
      return `<div class="market-card" data-symbol="${t.symbol}">
        <div class="pair">${t.symbol.replace('USDT', '/USDT')}</div>
        <div class="price">$${this.fmtPriceShort(t.price)}</div>
        <div class="change ${cls}">${sign}${t.change.toFixed(2)}%</div>
        <div class="volume">Vol: ${this.fmtVolume(t.volume)}</div>
      </div>`;
    }).join('');

    grid.querySelectorAll('.market-card').forEach(el => {
      el.addEventListener('click', () => {
        const evt = new CustomEvent('pair-change', { detail: el.dataset.symbol });
        document.dispatchEvent(evt);
      });
    });
  }

  renderSignal(signal) {
    const panel = document.getElementById('signalPanel');
    if (!panel) return;

    const typeClass = signal.type === 'BUY' ? 'buy' : signal.type === 'SELL' ? 'sell' : 'no-trade';

    const html = `<div class="signal-card ${typeClass}">
      <div class="signal-header">
        <span class="signal-pair">${signal.pair.replace('USDT', '/USDT')}</span>
        <span class="signal-badge">${signal.type === 'NO TRADE' ? 'No Trade' : signal.type}</span>
      </div>
      <div class="signal-confidence">
        <span>${signal.confidence}%</span>
        <div class="confidence-bar"><div class="confidence-fill" style="width:${signal.confidence}%"></div></div>
      </div>
      <div class="signal-details">
        ${signal.entry ? `<div><span class="label">Entry:</span> $${this.fmtPrice(signal.entry)}</div>` : ''}
        ${signal.stopLoss ? `<div><span class="label">SL:</span> $${this.fmtPrice(signal.stopLoss)}</div>` : ''}
        ${signal.tp1 ? `<div><span class="label">TP1:</span> $${this.fmtPrice(signal.tp1)}</div>` : ''}
        ${signal.tp2 ? `<div><span class="label">TP2:</span> $${this.fmtPrice(signal.tp2)}</div>` : ''}
        ${signal.trend ? `<div><span class="label">Trend:</span> ${signal.trend}</div>` : ''}
        ${signal.winRate ? `<div><span class="label">Bot Win Rate:</span> ${signal.winRate}</div>` : ''}
      </div>
      <div class="signal-reasons">
        ${signal.reasons.map(r => `<span class="reason-tag">${r}</span>`).join('')}
      </div>
    </div>`;

    panel.innerHTML = html;
  }

  renderSignalsList(signals) {
    const panel = document.getElementById('signalPanel');
    if (!panel) return;

    if (!signals || signals.length === 0) {
      panel.innerHTML = `<div class="no-signals">No active signals — scanning market...</div>`;
      return;
    }

    panel.innerHTML = signals.map(signal => {
      const typeClass = signal.type === 'BUY' ? 'buy' : signal.type === 'SELL' ? 'sell' : 'no-trade';
      return `<div class="signal-card ${typeClass}">
        <div class="signal-header">
          <span class="signal-pair">${signal.pair.replace('USDT', '/USDT')}</span>
          <span class="signal-badge">${signal.type === 'NO TRADE' ? 'No Trade' : signal.type}</span>
        </div>
        <div class="signal-confidence">
          <span>${signal.confidence}%</span>
          <div class="confidence-bar"><div class="confidence-fill" style="width:${signal.confidence}%"></div></div>
        </div>
        <div class="signal-details">
          ${signal.entry ? `<div><span class="label">Entry:</span> $${this.fmtPrice(signal.entry)}</div>` : ''}
          ${signal.tp1 ? `<div><span class="label">TP1:</span> $${this.fmtPrice(signal.tp1)}</div>` : ''}
          ${signal.trend ? `<div><span class="label">Trend:</span> ${signal.trend}</div>` : ''}
          ${signal.winRate ? `<div><span class="label">Bot WR:</span> ${signal.winRate}</div>` : ''}
        </div>
        <div class="signal-reasons">
          ${signal.reasons.map(r => `<span class="reason-tag">${r}</span>`).join('')}
        </div>
      </div>`;
    }).join('');
  }

  renderHotPairs(hotPairs) {
    const section = document.getElementById('hotPairsSection');
    const grid = document.getElementById('hotPairsGrid');
    if (!grid || !section) return;

    if (!hotPairs || hotPairs.length === 0) {
      section.style.display = 'none';
      return;
    }

    section.style.display = 'block';
    grid.innerHTML = hotPairs.map(p => `
      <div class="hot-pair-card" data-symbol="${p.symbol}">
        <div><span class="pair">${p.symbol.replace('USDT', '/USDT')}</span><span class="hot-label">&#x26a1; Hot</span></div>
        <div class="volume-surge">Volume: ${this.fmtVolume(p.volume)}</div>
        <div style="font-size:0.75rem;color:var(--text-secondary)">${p.change >= 0 ? '+' : ''}${p.change.toFixed(2)}%</div>
      </div>
    `).join('');

    grid.querySelectorAll('.hot-pair-card').forEach(el => {
      el.addEventListener('click', () => {
        const evt = new CustomEvent('pair-change', { detail: el.dataset.symbol });
        document.dispatchEvent(evt);
      });
    });
  }

  showLoading(panelId, msg = 'Loading market data...') {
    const el = document.getElementById(panelId);
    if (el) el.innerHTML = `<div class="loading">${msg}</div>`;
  }

  showError(panelId, msg = 'Error loading data') {
    const el = document.getElementById(panelId);
    if (el) el.innerHTML = `<div class="loading" style="color:var(--red)">${msg}</div>`;
  }

  populatePairSelector(pairs, currentSymbol) {
    const sel = document.getElementById('pairSelector');
    if (!sel) return;
    const current = currentSymbol || (pairs.length > 0 ? pairs[0].symbol : 'BTCUSDT');
    sel.innerHTML = pairs.map(p =>
      `<option value="${p.symbol}" ${p.symbol === current ? 'selected' : ''}>${p.symbol.replace('USDT', '/USDT')}</option>`
    ).join('');
  }

  disposeChart() {
    if (this.chart) {
      this.chart.remove();
      this.chart = null;
    }
  }

  showBacktestModal(results) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <h3>&#x1f9ee; Quick Backtest Results (last 50 candles)</h3>
        ${results.length === 0 ? '<p>No trades triggered in this window.</p>' : `
          <table class="backtest-table">
            <tr><th>#</th><th>Signal</th><th>Entry</th><th>TP1</th><th>SL</th><th>Outcome</th><th>Conf</th></tr>
            ${results.map((r, i) => `
              <tr>
                <td>${i + 1}</td>
                <td>${r.type}</td>
                <td>$${this.fmtPrice(r.entry)}</td>
                <td>$${this.fmtPrice(r.tp1)}</td>
                <td>$${this.fmtPrice(r.sl)}</td>
                <td class="${r.outcome === 'win' ? 'win' : 'loss'}">${r.outcome}</td>
                <td>${r.confidence}%</td>
              </tr>
            `).join('')}
          </table>
          <p style="margin-top:12px;font-size:0.8rem;color:var(--text-muted)">
            Wins: ${results.filter(r => r.outcome === 'win').length} |
            Losses: ${results.filter(r => r.outcome === 'loss').length} |
            Pending: ${results.filter(r => r.outcome === 'pending').length}
          </p>
        `}
        <button class="btn-icon" style="margin-top:12px;padding:8px 20px" id="closeModalBtn">Close</button>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector('#closeModalBtn').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  }

  exportSignalHistoryToCSV(history) {
    if (!history || history.length === 0) return;
    const headers = ['timestamp', 'pair', 'type', 'confidence', 'entry', 'stopLoss', 'tp1', 'tp2', 'trend', 'reasons'];
    const rows = history.map(s => [
      s.time,
      s.pair,
      s.type,
      s.confidence,
      s.entry,
      s.stopLoss || '',
      s.tp1 || '',
      s.tp2 || '',
      s.trend || '',
      (s.reasons || []).join('; '),
    ].join(','));

    const csv = headers.join(',') + '\n' + rows.join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `crypto-signals-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  playAlertSound() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.value = 0.15;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      osc.stop(ctx.currentTime + 0.3);
    } catch (e) {
      // Audio not available
    }
  }

  renderPortfolio(portfolio) {
    const el = document.getElementById('portfolioSummary');
    if (!el) return;

    const pnlCls = portfolio.totalPnL >= 0 ? 'pos' : 'neg';
    const eqCls = portfolio.totalPnLPercent >= 0 ? 'pos' : 'neg';
    const sign = portfolio.totalPnL >= 0 ? '+' : '';

    el.innerHTML = `
      <div class="stat-card">
        <div class="stat-label">Balance</div>
        <div class="stat-value neutral">$${this.fmtPriceShort(portfolio.equity)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">P&amp;L</div>
        <div class="stat-value ${pnlCls}">${sign}$${this.fmtPriceShort(Math.abs(portfolio.totalPnL))}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Return</div>
        <div class="stat-value ${eqCls}">${sign}${portfolio.totalPnLPercent.toFixed(2)}%</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Open Positions</div>
        <div class="stat-value neutral">${portfolio.openPositionsCount}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Trades</div>
        <div class="stat-value neutral">${portfolio.totalTrades}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Win Rate</div>
        <div class="stat-value neutral">${portfolio.winRate.toFixed(0)}%</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Leverage</div>
        <div class="stat-value neutral">${portfolio.leverage}x</div>
      </div>
    `;
  }

  renderPositions(portfolio) {
    const el = document.getElementById('positionsPanel');
    if (!el) return;

    const syms = Object.keys(portfolio.positions);
    if (syms.length === 0) {
      el.innerHTML = `<div class="no-positions">No open positions</div>`;
      return;
    }

    el.innerHTML = `
      <div class="positions-header">
        <span>Symbol</span><span>Qty</span><span>Entry</span><span>Lev</span><span>P&amp;L</span><span>Return</span>
      </div>
      ${syms.map(sym => {
        const pos = portfolio.positions[sym];
        const pnl = (pos.currentPrice - pos.entryPrice) * pos.quantity;
        const pnlPct = ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100 * (pos.leverage || 1);
        const pnlCls = pnl >= 0 ? 'pos' : 'neg';
        const sign = pnl >= 0 ? '+' : '';
        return `<div class="position-row">
          <span class="sym">${sym.replace('USDT', '/USDT')}</span>
          <span>${pos.quantity.toFixed(4)}</span>
          <span>$${this.fmtPrice(pos.entryPrice)}</span>
          <span>${pos.leverage || 1}x</span>
          <span class="${pnlCls}">${sign}$${this.fmtPriceShort(Math.abs(pnl))}</span>
          <span class="${pnlCls}">${sign}${pnlPct.toFixed(2)}%</span>
        </div>`;
      }).join('')}
    `;
  }

  renderTradeHistory(portfolio) {
    const el = document.getElementById('tradeHistory');
    if (!el) return;

    const recent = portfolio.trades.slice(-20).reverse();
    if (recent.length === 0) {
      el.innerHTML = `<div class="no-trades">No trade history yet</div>`;
      return;
    }

    el.innerHTML = `
      <div class="trade-header">
        <span>Type</span><span>Symbol</span><span>Price</span><span>Qty</span><span>Time</span><span>P&amp;L</span>
      </div>
      ${recent.map(t => {
        const typeCls = t.type === 'BUY' ? 'type-buy' : 'type-sell';
        const pnlDisplay = t.pnl !== null
          ? `<span class="${t.pnl >= 0 ? 'pnl-win' : 'pnl-loss'}">${t.pnl >= 0 ? '+' : ''}$${this.fmtPriceShort(Math.abs(t.pnl))}</span>`
          : `<span style="color:var(--text-muted)">—</span>`;
        const timeStr = new Date(t.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return `<div class="trade-row">
          <span class="${typeCls}">${t.type}</span>
          <span>${t.symbol.replace('USDT', '/USDT')}</span>
          <span>$${this.fmtPrice(t.price)}</span>
          <span>${t.quantity.toFixed(4)}</span>
          <span>${timeStr}</span>
          ${pnlDisplay}
        </div>`;
      }).join('')}
    `;
  }

  renderTestnetStatus(status, message) {
    const el = document.getElementById('testnetStatus');
    const badge = document.getElementById('execModeBadge');
    if (!el) return;

    el.className = `settings-status ${status}`;
    el.textContent = message;

    if (badge) {
      if (status === 'connected') {
        badge.className = 'exec-mode-badge testnet';
        badge.textContent = 'Testnet';
      } else {
        badge.className = 'exec-mode-badge local';
        badge.textContent = 'Local';
      }
    }
  }

  setTestnetKeyFields(apiKey, secretKey) {
    const keyEl = document.getElementById('testnetApiKey');
    const secretEl = document.getElementById('testnetSecretKey');
    if (keyEl) keyEl.value = apiKey || '';
    if (secretEl) secretEl.value = secretKey || '';
  }
}
