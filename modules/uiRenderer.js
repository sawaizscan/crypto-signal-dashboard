export class UIRenderer {
  constructor() {
    this.chart = null;
    this.candleSeries = null;
    this.volumeSeries = null;
    this.ema20Line = null;
    this.ema50Line = null;
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

  initChart(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return false;
    this.chart = LightweightCharts.createChart(container, {
      layout: {
        background: { color: '#0d1520' },
        textColor: '#6a7a9a',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: '#141e2d' },
        horzLines: { color: '#141e2d' },
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
        vertLine: { color: '#2a3a5a', width: 1, style: LightweightCharts.LineStyle.Dashed },
        horzLine: { color: '#2a3a5a', width: 1, style: LightweightCharts.LineStyle.Dashed },
      },
      timeScale: {
        borderColor: '#1a2535',
        timeVisible: true,
        secondsVisible: false,
      },
      rightPriceScale: {
        borderColor: '#1a2535',
      },
    });
    this.candleSeries = this.chart.addCandlestickSeries({
      upColor: '#00f58c',
      downColor: '#ff3b6f',
      borderDownColor: '#ff3b6f',
      borderUpColor: '#00f58c',
      wickDownColor: '#ff3b6f',
      wickUpColor: '#00f58c',
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
      time: c.time, open: c.open, high: c.high, low: c.low, close: c.close,
    }));
    this.candleSeries.setData(candleData);
    const volData = candles.map((c, i) => ({
      time: c.time, value: c.volume,
      color: c.close >= c.open ? 'rgba(0,245,140,0.2)' : 'rgba(255,59,111,0.2)',
    }));
    this.volumeSeries.setData(volData);
    const ema20Data = [];
    const ema50Data = [];
    candles.forEach((c, i) => {
      if (ind.ema20[i] !== null) ema20Data.push({ time: c.time, value: ind.ema20[i] });
      if (ind.ema50[i] !== null) ema50Data.push({ time: c.time, value: ind.ema50[i] });
    });
    this.ema20Line.setData(ema20Data);
    this.ema50Line.setData(ema50Data);
    this.chart.timeScale().fitContent();
  }

  updateChartTitle(pair) {
    const el = document.getElementById('chartTitle');
    if (el) el.textContent = pair.replace('USDT', '/USDT');
  }

  updateSentiment(daily, short) {
    const dFill = document.getElementById('dailyFill');
    const dBear = document.getElementById('dailyBear');
    const dBull = document.getElementById('dailyBull');
    const dEmoji = document.querySelector('#dailySentiment .sentiment-emoji');
    if (dFill) dFill.style.width = `${daily.bull}%`;
    if (dBear) dBear.textContent = `Bear ${Math.round(daily.bear)}%`;
    if (dBull) dBull.textContent = `Bull ${Math.round(daily.bull)}%`;
    if (dEmoji) dEmoji.textContent = daily.emoji;

    const sFill = document.getElementById('shortFill');
    const sBear = document.getElementById('shortBear');
    const sBull = document.getElementById('shortBull');
    const sEmoji = document.querySelector('#shortSentiment .sentiment-emoji');
    if (sFill) sFill.style.width = `${short.bull}%`;
    if (sBear) sBear.textContent = `Bear ${Math.round(short.bear)}%`;
    if (sBull) sBull.textContent = `Bull ${Math.round(short.bull)}%`;
    if (sEmoji) sEmoji.textContent = short.emoji;
  }

  updatePortfolioMini(equity, pnl, trades, wr) {
    const eqEl = document.getElementById('pmEquity');
    const pnlEl = document.getElementById('pmPnl');
    const trEl = document.getElementById('pmTrades');
    const wrEl = document.getElementById('pmWr');
    if (eqEl) eqEl.textContent = `$${this.fmtPriceShort(equity)}`;
    if (pnlEl) {
      const sign = pnl >= 0 ? '+' : '';
      pnlEl.textContent = `${sign}$${this.fmtPriceShort(Math.abs(pnl))}`;
      pnlEl.style.color = pnl >= 0 ? '#00f58c' : '#ff3b6f';
    }
    if (trEl) trEl.textContent = trades;
    if (wrEl) wrEl.textContent = `${wr.toFixed(0)}%`;
  }

  updateSignalCard(pair, signal) {
    const card = document.querySelector(`.signal-card[data-pair="${pair}"]`);
    if (!card) return;

    const typeClass = signal.type === 'BUY' ? 'long' : signal.type === 'SELL' ? 'short' : '';
    card.className = `signal-card ${typeClass}`;

    const typeEl = document.getElementById(`scType-${pair}`);
    if (typeEl) {
      let label = signal.type === 'BUY' ? 'LONG' : signal.type === 'SELL' ? 'SHORT' : 'NO TRADE';
      let cls = signal.type === 'BUY' ? 'buy' : signal.type === 'SELL' ? 'sell' : 'no-trade';
      typeEl.textContent = label;
      typeEl.className = `sc-type ${cls}`;
    }

    const priceEl = document.getElementById(`scPrice-${pair}`);
    if (priceEl) priceEl.textContent = `$${this.fmtPriceShort(signal.entry || 0)}`;

    const confFill = document.getElementById(`scConf-${pair}`);
    const confText = document.getElementById(`scConfText-${pair}`);
    const confVal = signal.confidence || 0;
    if (confFill) confFill.style.width = `${confVal}%`;
    if (confText) confText.textContent = `${Math.round(confVal)}%`;

    const slEl = document.getElementById(`scSl-${pair}`);
    const tp1El = document.getElementById(`scTp1-${pair}`);
    const tp2El = document.getElementById(`scTp2-${pair}`);
    if (slEl) slEl.textContent = signal.stopLoss ? `$${this.fmtPriceShort(signal.stopLoss)}` : '—';
    if (tp1El) tp1El.textContent = signal.tp1 ? `$${this.fmtPriceShort(signal.tp1)}` : '—';
    if (tp2El) tp2El.textContent = signal.tp2 ? `$${this.fmtPriceShort(signal.tp2)}` : '—';

    const reasonsEl = document.getElementById(`scReasons-${pair}`);
    if (reasonsEl) {
      if (signal.reasons && signal.reasons.length > 0) {
        reasonsEl.innerHTML = signal.reasons.slice(0, 3).map(r =>
          `<span class="sc-reason-tag">${r}</span>`
        ).join('');
      } else {
        reasonsEl.innerHTML = '';
      }
    }

    const trendEl = document.getElementById(`scTrend-${pair}`);
    if (trendEl) {
      trendEl.textContent = `Trend: ${signal.trend || '—'}`;
    }
  }

  setActivePair(pair) {
    document.querySelectorAll('.pair-pill').forEach(el => {
      el.classList.toggle('active', el.dataset.pair === pair);
    });
  }

  updateTime() {
    const el = document.getElementById('headerTime');
    if (el) el.textContent = new Date().toLocaleTimeString();
  }

  renderPortfolio(portfolio) {
    const el = document.getElementById('portfolioSummary');
    if (!el) return;
    const pnlCls = portfolio.totalPnL >= 0 ? 'pos' : 'neg';
    const sign = portfolio.totalPnL >= 0 ? '+' : '';
    const mode = portfolio.useTestnetPortfolio ? 'Testnet' : 'Paper';
    el.innerHTML = `
      <div class="stat-card"><div class="stat-label">Balance <span class="mode-badge">${mode}</span></div><div class="stat-value neutral">$${this.fmtPriceShort(portfolio.equity)}</div></div>
      <div class="stat-card"><div class="stat-label">P&L</div><div class="stat-value ${pnlCls}">${sign}$${this.fmtPriceShort(Math.abs(portfolio.totalPnL))}</div></div>
      <div class="stat-card"><div class="stat-label">Return</div><div class="stat-value ${pnlCls}">${sign}${portfolio.totalPnLPercent.toFixed(2)}%</div></div>
      <div class="stat-card"><div class="stat-label">Open</div><div class="stat-value neutral">${portfolio.openPositionsCount}</div></div>
      <div class="stat-card"><div class="stat-label">Trades</div><div class="stat-value neutral">${portfolio.totalTrades}</div></div>
      <div class="stat-card"><div class="stat-label">Win Rate</div><div class="stat-value neutral">${portfolio.winRate.toFixed(0)}%</div></div>
      <div class="stat-card"><div class="stat-label">Leverage</div><div class="stat-value neutral">${portfolio.leverage}x</div></div>`;
  }

  renderPositions(portfolio) {
    const el = document.getElementById('positionsPanel');
    if (!el) return;
    const tnPositions = portfolio.getTestnetPositions ? portfolio.getTestnetPositions() : [];
    if (portfolio.useTestnetPortfolio && tnPositions.length > 0) {
      el.innerHTML = `<div class="pos-badge">Testnet Positions</div><div class="positions-header"><span>Pair</span><span>Size</span><span>Entry</span><span>Mark</span><span>Lev</span><span>UPnL</span></div>${tnPositions.map(p => {
        const pnl = p.unrealizedProfit; const cls = pnl >= 0 ? 'pos' : 'neg'; const sign = pnl >= 0 ? '+' : '';
        return `<div class="position-row"><span class="sym">${p.symbol.replace('USDT', '/USDT')}</span><span>${p.positionAmt.toFixed(4)}</span><span>$${this.fmtPrice(p.entryPrice)}</span><span>$${this.fmtPrice(p.markPrice)}</span><span>${p.leverage}x</span><span class="${cls}">${sign}$${this.fmtPriceShort(Math.abs(pnl))}</span></div>`;
      }).join('')}`;
      return;
    }
    const syms = Object.keys(portfolio.positions);
    if (syms.length === 0) { el.innerHTML = `<div class="no-positions">No open positions</div>`; return; }
    el.innerHTML = `<div class="positions-header"><span>Pair</span><span>Qty</span><span>Entry</span><span>Lev</span><span>P&L</span><span>Return</span></div>${syms.map(sym => {
      const pos = portfolio.positions[sym]; const pnl = (pos.currentPrice - pos.entryPrice) * pos.quantity;
      const pnlPct = ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100 * (pos.leverage || 1);
      const cls = pnl >= 0 ? 'pos' : 'neg'; const sign = pnl >= 0 ? '+' : '';
      return `<div class="position-row"><span class="sym">${sym.replace('USDT', '/USDT')}</span><span>${pos.quantity.toFixed(4)}</span><span>$${this.fmtPrice(pos.entryPrice)}</span><span>${pos.leverage || 1}x</span><span class="${cls}">${sign}$${this.fmtPriceShort(Math.abs(pnl))}</span><span class="${cls}">${sign}${pnlPct.toFixed(2)}%</span></div>`;
    }).join('')}`;
  }

  renderTradeHistory(portfolio) {
    const el = document.getElementById('tradeHistory');
    if (!el) return;
    const recent = portfolio.trades?.slice(-20).reverse() || [];
    if (recent.length === 0) { el.innerHTML = '<div class="empty-state">No trades yet</div>'; return; }
    el.innerHTML = recent.map(t => {
      const sideCls = t.type === 'BUY' ? 'buy' : 'sell';
      const pnlDisplay = t.pnl !== null
        ? `<span class="te-pnl" style="color:${t.pnl >= 0 ? '#00f58c' : '#ff3b6f'}">${t.pnl >= 0 ? '+' : ''}$${this.fmtPriceShort(Math.abs(t.pnl))}</span>`
        : `<span style="color:var(--text-muted)">—</span>`;
      const timeStr = new Date(t.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const winClass = t.pnl !== null ? (t.pnl >= 0 ? 'win' : 'loss') : '';
      return `<div class="trade-entry ${winClass}"><span class="te-pair">${t.symbol.replace('USDT', '/USDT')}</span><span class="te-side ${sideCls}">${t.type === 'BUY' ? 'L' : 'S'}</span><span class="te-price">$${this.fmtPriceShort(t.price)}</span>${pnlDisplay}<span class="te-time">${timeStr}</span></div>`;
    }).join('');
  }

  renderEvaluation(report, snapshotCount, nextCheckMin) {
    const badge = document.getElementById('evalBadge');
    const metrics = document.getElementById('evalMetrics');
    const pairBreakdown = document.getElementById('evalPairBreakdown');
    const suggestions = document.getElementById('evalSuggestions');
    const count = document.getElementById('evalCount');
    const next = document.getElementById('evalNext');

    if (!report) {
      if (badge) { badge.textContent = 'Collecting...'; badge.className = 'eval-badge'; }
      return;
    }

    const sc = report.scores;
    if (badge) {
      badge.textContent = sc >= 70 ? '● Healthy' : sc >= 50 ? '● Watching' : '● Needs Tuning';
      badge.className = 'eval-badge ' + (sc >= 70 ? 'good' : sc >= 50 ? 'ok' : 'bad');
    }

    if (metrics) {
      metrics.innerHTML = `
        <div class="eval-metric"><div class="eval-metric-label">Live WR</div><div class="eval-metric-value ${report.liveWr >= 60 ? 'good' : report.liveWr >= 50 ? 'ok' : 'bad'}">${report.liveWr}%</div></div>
        <div class="eval-metric"><div class="eval-metric-label">Profit Factor</div><div class="eval-metric-value ${report.pf >= 2 ? 'good' : report.pf >= 1.5 ? 'ok' : 'bad'}">${report.pf}</div></div>
        <div class="eval-metric"><div class="eval-metric-label">PnL/hr</div><div class="eval-metric-value ${report.pnlPerH > 0 ? 'good' : 'bad'}">${report.pnlPerH > 0 ? '+' : ''}$${Math.abs(report.pnlPerH).toFixed(2)}</div></div>
        <div class="eval-metric"><div class="eval-metric-label">Score</div><div class="eval-metric-value ${sc >= 70 ? 'good' : sc >= 50 ? 'ok' : 'bad'}">${sc}/100</div></div>`;
    }

    if (pairBreakdown) {
      const pairs = Object.entries(report.pairWr || {});
      if (pairs.length > 0) {
        pairBreakdown.innerHTML = pairs.map(([pair, wr]) => {
          const label = pair.replace('USDT', '');
          const cls = wr >= 60 ? 'good' : wr >= 0 ? 'ok' : 'bad';
          const meta = wr < 0 ? 'No data' : `${wr}% WR`;
          return `<div class="eval-pair-card"><div class="eval-pair-label">${label}</div><div class="eval-pair-wr ${cls}">${wr < 0 ? '—' : wr + '%'}</div><div class="eval-pair-meta">${meta}</div></div>`;
        }).join('');
      } else {
        pairBreakdown.innerHTML = '<div class="eval-pair-card"><div class="eval-pair-label">—</div><div class="eval-pair-meta">No trades yet</div></div>';
      }
    }

    if (suggestions) {
      if (report.suggestions && report.suggestions.length > 0) {
        suggestions.innerHTML = report.suggestions.map(s => `<div class="eval-suggestion">${s}</div>`).join('');
      } else {
        suggestions.innerHTML = '<div class="eval-suggestion" style="color:var(--text-muted)">No adjustments needed</div>';
      }
    }

    if (count) count.textContent = `${snapshotCount} snapshots`;
    if (next) next.textContent = `Next check: ~${nextCheckMin} min`;
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
    } catch {}
  }
}
