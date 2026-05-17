const STORAGE_KEY = 'apex_evals_v1';

export class Evaluator {
  constructor() {
    this.snapshots = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    this.startTime = Date.now();
    this.startTrades = 0;
    this._lastSnapshot = null;
  }

  snapshot(trader, signals, engine) {
    const s = {
      t: Date.now(),
      eq: trader.equity,
      pnl: trader.totalPnL,
      tc: trader.totalTrades,
      wr: trader.winRate,
      op: trader.openPositionsCount,
      lev: trader.leverage,
    };
    if (this.snapshots.length === 0) this.startTrades = s.tc;
    this.snapshots.push(s);
    if (this.snapshots.length > 48) this.snapshots.shift();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.snapshots));
    this._lastSnapshot = s;
    return this.analyze(trader, engine, signals);
  }

  analyze(trader, engine, signals) {
    const snaps = this.snapshots;
    if (snaps.length < 2) return null;

    const first = snaps[0];
    const last = snaps[snaps.length - 1];
    const elapsedH = (last.t - first.t) / 3600000;

    const newTrades = last.tc - this.startTrades;
    const trades = trader.trades || [];
    const recentTrades = trades.slice(-Math.max(newTrades, trades.length));

    const wins = recentTrades.filter(t => t.pnl > 0).length;
    const losses = recentTrades.filter(t => t.pnl !== null && t.pnl < 0).length;
    const liveWr = (wins + losses) > 0 ? (wins / (wins + losses)) * 100 : 0;

    const grossWin = recentTrades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(recentTrades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0)) || 1;
    const pf = grossWin / grossLoss;

    let consLoss = 0, maxConsLoss = 0;
    for (const t of recentTrades) {
      if (t.pnl !== null && t.pnl < 0) { consLoss++; maxConsLoss = Math.max(maxConsLoss, consLoss); }
      else consLoss = 0;
    }

    const avgWin = wins > 0 ? grossWin / wins : 0;
    const avgLoss = losses > 0 ? grossLoss / losses : 0;

    const pairWr = {};
    for (const pair of ['SOLUSDT', 'BTCUSDT', 'ETHUSDT']) {
      const pt = recentTrades.filter(t => t.symbol === pair);
      const pw = pt.filter(t => t.pnl > 0).length;
      const pl = pt.filter(t => t.pnl !== null && t.pnl < 0).length;
      pairWr[pair] = (pw + pl) > 0 ? (pw / (pw + pl)) * 100 : -1;
    }

    const pnlPerH = elapsedH > 0 ? last.pnl / elapsedH : 0;

    const report = {
      elapsedH: Math.round(elapsedH * 10) / 10,
      totalTrades: last.tc,
      newTrades,
      wr: Math.round(last.wr),
      liveWr: Math.round(liveWr),
      pf: Math.round(pf * 100) / 100,
      pnl: Math.round(last.pnl * 100) / 100,
      pnlPerH: Math.round(pnlPerH * 100) / 100,
      equity: Math.round(last.eq * 100) / 100,
      openPositions: last.op,
      maxConsLoss,
      avgWin: Math.round(avgWin * 100) / 100,
      avgLoss: Math.round(Math.abs(avgLoss) * 100) / 100,
      pairWr: Object.fromEntries(Object.entries(pairWr).map(([k, v]) => [k, v < 0 ? -1 : Math.round(v)])),
    };

    report.suggestions = this._suggest(report, engine);
    report.scores = this._score(report);
    return report;
  }

  _suggest(report, engine) {
    const s = [];

    if (report.newTrades < 3 && report.elapsedH > 0.5) {
      s.push('Very few trades — lower thr from 4 to 3 or widen RSI bands to 35-65');
    }

    if (report.liveWr < 50 && report.newTrades >= 5) {
      s.push(`Live WR ${report.liveWr}% < 50% — raise thr to 6 to filter low-confidence trades`);
    }

    if (report.liveWr >= 65 && report.newTrades >= 5) {
      s.push(`Strong WR ${report.liveWr}% — consider boosting margin per trade from 30% to 40%`);
    }

    if (report.pf < 1.5 && report.newTrades >= 5) {
      s.push(`Profit factor ${report.pf} < 1.5 — widen TP ratio from 0.8 to 1.2 ATR`);
    }

    if (report.maxConsLoss >= 4) {
      s.push(`${report.maxConsLoss} consecutive losses — tighten SL from 0.3 to 0.2 ATR or pause until WR recovers`);
    }

    if (report.avgWin && report.avgLoss && report.avgWin / report.avgLoss < 0.8) {
      s.push(`Avg win ($${report.avgWin}) < avg loss ($${report.avgLoss}) — increase TP ratio to 1.0 ATR`);
    }

    if (report.pnlPerH < -5) {
      s.push(`Losing $${Math.abs(report.pnlPerH)}/hr — reduce leverage from 10x to 5x`);
    }

    if (report.pnlPerH > 0 && report.pnlPerH < 2 && report.liveWr > 55) {
      s.push(`Profitable but low $/hr — consider increasing trade size or widening dev band`);
    }

    for (const [pair, wr] of Object.entries(report.pairWr)) {
      if (wr >= 0 && wr < 40) {
        s.push(`${pair.replace('USDT', '')} WR ${wr}% underperforms — try dev=0.12 for this pair only`);
      }
    }

    if (s.length === 0) s.push('No adjustments needed — strategy is performing within expected range');
    return s.slice(0, 5);
  }

  _score(report) {
    let score = 50;
    if (report.liveWr >= 60) score += 15;
    else if (report.liveWr >= 50) score += 5;
    else score -= 10;
    if (report.pf >= 3) score += 10;
    else if (report.pf >= 2) score += 5;
    else if (report.pf < 1) score -= 15;
    if (report.maxConsLoss <= 2) score += 5;
    else if (report.maxConsLoss >= 5) score -= 10;
    if (report.pnl > 0) score += 10;
    else score -= 15;
    if (report.newTrades >= 10) score += 5;
    else if (report.newTrades < 3) score -= 5;
    return Math.max(0, Math.min(100, score));
  }

  reset() {
    this.snapshots = [];
    this.startTime = Date.now();
    this.startTrades = 0;
    localStorage.removeItem(STORAGE_KEY);
  }
}
