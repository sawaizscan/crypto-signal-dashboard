#!/usr/bin/env python3
"""
CryptoSignal — Multi-Strategy 1m HFT Backtest
Tests pullback, mean reversion, and momentum breakout strategies
"""
import json, math, urllib.request, statistics, sys
from datetime import datetime

BINANCE = 'https://api.binance.com'

def fetch(symbol, interval='1m', limit=500):
    url = f'{BINANCE}/api/v3/klines?symbol={symbol}&interval={interval}&limit={limit}'
    with urllib.request.urlopen(url, timeout=10) as r:
        data = json.loads(r.read())
    return [{'time': k[0]//1000, 'open': float(k[1]), 'high': float(k[2]),
             'low': float(k[3]), 'close': float(k[4]), 'volume': float(k[5])} for k in data]

def ema(vals, p):
    r = [None]*len(vals); m = 2/(p+1); e = vals[0]
    for i,v in enumerate(vals):
        if i==0: r[i]=v; e=v
        else: e=(v-e)*m+e; r[i]=e
    return r

def rsi(c, p=14):
    r=[None]*len(c); g=l=0
    for i in range(1,len(c)):
        d=c[i]-c[i-1]; gg=d if d>0 else 0; ll=-d if d<0 else 0
        if i==1: g,l=gg,ll
        else: g=(g*(p-1)+gg)/p; l=(l*(p-1)+ll)/p
        if i>=p: r[i]=100-100/(1+g/l) if l>0 else 100
    return r

def macd(c):
    e12=ema(c,12); e26=ema(c,26)
    ml=[e12[i]-e26[i] if None not in (e12[i],e26[i]) else None for i in range(len(c))]
    sig=ema([v for v in ml if v is not None],9)
    h=[None]*len(ml); si=0
    for i,v in enumerate(ml):
        if v is not None and si<len(sig): h[i]=v-sig[si]; si+=1
    return h

def atr(c, p=14):
    r=[0.0]*len(c)
    for i in range(len(c)):
        if i==0: r[i]=c[i]['high']-c[i]['low']
        else:
            tr=max(c[i]['high']-c[i]['low'],abs(c[i]['high']-c[i-1]['close']),abs(c[i]['low']-c[i-1]['close']))
            if i<p: r[i]=(r[i-1]*i+tr)/(i+1)
            else: r[i]=(r[i-1]*(p-1)+tr)/p
    return r

class StratEngine:
    def __init__(self):
        self.wins=0; self.losses=0; self.trades=[]

    def wr(self): t=self.wins+self.losses; return (self.wins/t*100) if t>0 else 50

    def run(self, candles, strategy='pullback', thr=8, lev=10, mar=0.3):
        self.wins=0; self.losses=0; self.trades=[]
        balance=10000; pos=None; closes=[c['close'] for c in candles]
        eq_curve=[balance]

        for i in range(60, len(candles)):
            c=closes[:i+1]; slc=candles[:i+1]; price=c[-1]
            e20=ema(c,20); e50=ema(c,50); e200=ema(c,200)
            r=rsi(c); m=macd(c); at=atr(slc)

            # Check position
            if pos:
                sl,tp=pos['sl'],pos['tp1']
                ex=None; rea=None
                if pos['t']=='B':
                    if sl and price<=sl: ex,rea=sl,'SL'
                    elif tp and price>=tp: ex,rea=tp,'TP1'
                else:
                    if sl and price>=sl: ex,rea=sl,'SL'
                    elif tp and price<=tp: ex,rea=tp,'TP1'
                if ex:
                    pnl=(ex-pos['e'])*pos['q'] if pos['t']=='B' else (pos['e']-ex)*pos['q']
                    balance+=pos['m']+pnl
                    self.wins+=1 if pnl>0 else 0; self.losses+=1 if pnl<=0 else 0
                    self.trades.append({'t':pos['t'],'e':pos['e'],'x':ex,'pnl':pnl,'w':pnl>0,'r':rea})
                    pos=None

            # Generate signal based on strategy
            sig=None
            if strategy=='pullback':
                sig=self.pullback_sig(candles,slc,c,e20,e50,r,m,price,thr)
            elif strategy=='reversion':
                sig=self.reversion_sig(c,e20,r,m,price,thr)
            elif strategy=='momentum':
                sig=self.momentum_sig(candles,slc,c,e20,r,m,price,thr)

            if sig and not pos and balance>10:
                margin=balance*mar; qty=(margin*lev)/price
                if qty>0 and margin>1:
                    at_v=at[-1] if at else price*0.002
                    tick=max(at_v*0.6, price*0.001)
                    if sig['d']=='B':
                        sl=price-tick; rk=price-sl
                        pos={'t':'B','e':price,'q':qty,'m':margin,'sl':sl,'tp1':price+rk*1.5,'factors':sig.get('f',[])}
                    else:
                        sl=price+tick; rk=sl-price
                        pos={'t':'S','e':price,'q':qty,'m':margin,'sl':sl,'tp1':price-rk*1.5,'factors':sig.get('f',[])}
                    balance-=margin

            eq=balance
            if pos:
                up=pos['t']=='B'; pnl=(price-pos['e'])*pos['q'] if up else (pos['e']-price)*pos['q']
                eq=balance+pos['m']+pnl
            eq_curve.append(round(eq,2))

        if pos:
            lp=closes[-1]; pnl=(lp-pos['e'])*pos['q'] if pos['t']=='B' else (pos['e']-lp)*pos['q']
            balance+=pos['m']+pnl
            self.wins+=1 if pnl>0 else 0; self.losses+=1 if pnl<=0 else 0
            self.trades.append({'t':pos['t'],'e':pos['e'],'x':lp,'pnl':pnl,'w':pnl>0,'r':'close'})

        wins=sum(1 for t in self.trades if t['w']); losses=len(self.trades)-wins
        wr=(wins/len(self.trades)*100) if self.trades else 0
        aw=statistics.mean([t['pnl'] for t in self.trades if t['w']]) if wins>0 else 0
        al=statistics.mean([t['pnl'] for t in self.trades if not t['w']]) if losses>0 else 0

        return {'trades':len(self.trades),'wins':wins,'losses':losses,
                'win_rate':round(wr,1),'pnl':round(balance-10000,2),
                'pnl_pct':round((balance-10000)/10000*100,2),'final':round(balance,2),
                'avg_win':round(aw,2),'avg_loss':round(al,2),'strategy':strategy,'thr':thr}

    def pullback_sig(self, candles, slc, c, e20, e50, r, m, price, thr):
        last=len(c)-1; e20v=e20[-1]; e50v=e50[-1]; rv=r[-1]; h0=m[-1]; h1=m[-2] if last>0 else None
        if None in (e20v,e50v,rv): return None
        trend='unknown'
        if e20v and e50v and ema(c,200)[-1]:
            e2=e20[-1]; e5=e50[-1]; e2h=ema(c,200)[-1]
            if e2 and e5 and e2h and e2>e5>e2h: trend='up'
            elif e2 and e5 and e2h and e2<e5<e2h: trend='down'

        score=0; factors=[]
        if trend=='up' and price<=e20v*1.001 and price>e50v*0.998:
            factors.append('pullback'); score+=5
            if 38<=rv<=52: score+=6; factors.append('rsi')
            if h0 and h1 and h0>h1: score+=7; factors.append('macd')
            if last>=1 and c[last-1]<e20v and price>e20v: score+=5; factors.append('bounce')
            if candles[last]['close']>candles[last]['open']: score+=3
        if trend=='down' and price>=e20v*0.999 and price<e50v*1.002:
            factors.append('pullback'); score-=5
            if 48<=rv<=62: score-=6; factors.append('rsi')
            if h0 and h1 and h0<h1: score-=7; factors.append('macd')
            if last>=1 and c[last-1]>e20v and price<e20v: score-=5; factors.append('bounce')
            if candles[last]['close']<candles[last]['open']: score-=3
        if score>=thr: return {'d':'B','f':factors}
        if score<=-thr: return {'d':'S','f':factors}
        return None

    def reversion_sig(self, c, e20, r, m, price, thr):
        e20v=e20[-1]; rv=r[-1]; h0=m[-1]; h1=m[-2] if len(m)>1 else None
        if None in (e20v,rv): return None
        dev=((price/e20v)-1)*100; score=0; factors=[]
        # Oversold reversion
        if dev<-0.12 and rv<35:
            score+=10; factors.append('oversold')
            if h0 and h1 and h0>h1: score+=5; factors.append('macd_turn')
            if rv<30: score+=3
        # Overbought reversion
        if dev>0.12 and rv>65:
            score-=10; factors.append('overbought')
            if h0 and h1 and h0<h1: score-=5; factors.append('macd_turn')
            if rv>70: score-=3
        if score>=thr: return {'d':'B','f':factors}
        if score<=-thr: return {'d':'S','f':factors}
        return None

    def momentum_sig(self, candles, slc, c, e20, r, m, price, thr):
        last=len(c)-1; e20v=e20[-1]; rv=r[-1]; h0=m[-1]; h1=m[-2] if len(m)>1 else None
        if last<10 or e20v is None: return None
        recent_h=max(candles[last-5:last], key=lambda x:x['high'])['high']
        recent_l=min(candles[last-5:last], key=lambda x:x['low'])['low']
        score=0; factors=[]
        # Bullish momentum
        if price>recent_h and price>e20v:
            score+=8; factors.append('breakout_up')
            if rv>55: score+=4; factors.append('rsi_mom')
            if h0 and h1 and h0>h1: score+=5; factors.append('macd_mom')
        # Bearish momentum
        if price<recent_l and price<e20v:
            score-=8; factors.append('breakout_dn')
            if rv<45: score-=4; factors.append('rsi_mom')
            if h0 and h1 and h0<h1: score-=5; factors.append('macd_mom')
        if score>=thr: return {'d':'B','f':factors}
        if score<=-thr: return {'d':'S','f':factors}
        return None

def test_all(symbol, candles, label):
    print(f'\n{"="*70}')
    print(f'  {label} — {len(candles)} candles')
    print(f'  {datetime.fromtimestamp(candles[0]["time"])} → {datetime.fromtimestamp(candles[-1]["time"])}')
    print(f'{"="*70}')

    best={'wr':0,'pnl':-999}
    for strategy in ['pullback','reversion','momentum']:
        print(f'\n  📊 {strategy.upper()}:')
        print(f'  {"Thr":>4} {"WR%":>6} {"PnL%":>8} {"Trades":>7} {"W":>4} {"L":>4} {"AvgW$":>8} {"AvgL$":>8}')
        print(f'  {"-"*55}')
        for thr in [5,7,9,11]:
            e=StratEngine()
            r=e.run(candles,strategy=strategy,thr=thr)
            mark='✅' if r['win_rate']>=60 else '⚠️' if r['win_rate']>=45 else '  '
            print(f'  {mark} {thr:2d}  {r["win_rate"]:5.1f}%  {r["pnl_pct"]:+7.2f}%  {r["trades"]:5d}  {r["wins"]:3d}  {r["losses"]:3d}  ${r["avg_win"]:>7.2f}  ${r["avg_loss"]:>7.2f}')
            if r['win_rate']>best['wr'] or (r['win_rate']==best['wr'] and r['pnl_pct']>best['pnl']):
                best={'wr':r['win_rate'],'pnl':r['pnl_pct'],'strat':strategy,'thr':thr,'trades':r['trades'],'wins':r['wins'],'losses':r['losses']}

    print(f'\n  🏆 Best: {best["strat"]} thr={best["thr"]} | WR: {best["wr"]}% | PnL: {best["pnl"]:+.2f}% | Trades: {best["trades"]} | W:{best["wins"]} L:{best["losses"]}')
    return best

# Also test combined: run all 3 strategies simultaneously
def combined_run(candles, lev=10, mar=0.3):
    e=StratEngine()
    balance=10000; pos={'pullback':None,'reversion':None,'momentum':None}; closes=[c['close'] for c in candles]

    for i in range(60, len(candles)):
        c=closes[:i+1]; slc=candles[:i+1]; price=c[-1]
        e20=ema(c,20); e50=ema(c,50); r=rsi(c); m=macd(c); at=atr(slc)

        for strat in ['pullback','reversion','momentum']:
            p=pos[strat]
            if p:
                sl,tp=p['sl'],p['tp1']
                ex=None
                if p['t']=='B':
                    if sl and price<=sl: ex=sl
                    elif tp and price>=tp: ex=tp
                else:
                    if sl and price>=sl: ex=sl
                    elif tp and price<=tp: ex=tp
                if ex:
                    pnl=(ex-p['e'])*p['q'] if p['t']=='B' else (p['e']-ex)*p['q']
                    balance+=p['m']+pnl
                    e.wins+=1 if pnl>0 else 0; e.losses+=1 if pnl<=0 else 0
                    e.trades.append({'t':p['t'],'e':p['e'],'x':ex,'pnl':pnl,'w':pnl>0,'strat':strat})
                    pos[strat]=None

        for strat in ['pullback','reversion','momentum']:
            if pos[strat]: continue
            sig=None
            if strat=='pullback':
                sig=e.pullback_sig(candles,slc,c,e20,e50,r,m,price,7)
            elif strat=='reversion':
                sig=e.reversion_sig(c,e20,r,m,price,7)
            elif strat=='momentum':
                sig=e.momentum_sig(candles,slc,c,e20,r,m,price,7)
            if sig and balance>10:
                margin=balance*0.2*mar; qty=(margin*lev)/price
                if qty>0 and margin>1:
                    at_v=at[-1] if at else price*0.002
                    tick=max(at_v*0.6,price*0.001)
                    if sig['d']=='B':
                        sl=price-tick; rk=price-sl
                        pos[strat]={'t':'B','e':price,'q':qty,'m':margin,'sl':sl,'tp1':price+rk*1.5}
                    else:
                        sl=price+tick; rk=sl-price
                        pos[strat]={'t':'S','e':price,'q':qty,'m':margin,'sl':sl,'tp1':price-rk*1.5}
                    balance-=margin

    for strat,p in pos.items():
        if p:
            lp=closes[-1]; pnl=(lp-p['e'])*p['q'] if p['t']=='B' else (p['e']-lp)*p['q']
            balance+=p['m']+pnl
            e.wins+=1 if pnl>0 else 0; e.losses+=1 if pnl<=0 else 0
            e.trades.append({'t':p['t'],'e':p['e'],'x':lp,'pnl':pnl,'w':pnl>0,'strat':strat})

    wins=sum(1 for t in e.trades if t['w']); losses=len(e.trades)-wins
    wr=(wins/len(e.trades)*100) if e.trades else 0
    aw=statistics.mean([t['pnl'] for t in e.trades if t['w']]) if wins>0 else 0
    al=statistics.mean([t['pnl'] for t in e.trades if not t['w']]) if losses>0 else 0
    return {'trades':len(e.trades),'win_rate':round(wr,1),'pnl':round(balance-10000,2),
            'pnl_pct':round((balance-10000)/10000*100,2),'wins':wins,'losses':losses,
            'avg_win':round(aw,2),'avg_loss':round(al,2)}

# MAIN
pairs=[('BTCUSDT','BTC'),('ETHUSDT','ETH'),('SOLUSDT','SOL')]
all_data={}
best_overall={'wr':0,'pnl':-999}
for sym,label in pairs:
    print(f'\nFetching {sym}...')
    candles=fetch(sym,'1m',500)
    all_data[sym]=candles
    b=test_all(sym,candles,label)
    if b['wr']>best_overall['wr'] or (b['wr']==best_overall['wr'] and b['pnl']>best_overall['pnl']):
        best_overall=b
        best_overall['pair']=sym

print(f'\n{"="*70}')
print(f'  COMBINED STRATEGY (all 3 running at once)')
print(f'{"="*70}')
for sym,label in pairs:
    r=combined_run(all_data[sym])
    mark='✅' if r['win_rate']>=60 else '⚠️' if r['win_rate']>=45 else '  '
    print(f'  {mark} {label}: WR: {r["win_rate"]:5.1f}%  PnL: {r["pnl_pct"]:+7.2f}%  Trades: {r["trades"]}  W:{r["wins"]} L:{r["losses"]}  AvgW:${r["avg_win"]} AvgL:${r["avg_loss"]}')

print(f'\n{"="*70}')
print(f'  FINAL RECOMMENDATION')
print(f'{"="*70}')
print(f'  Best single strategy: {best_overall["strat"]} thr={best_overall["thr"]}')
print(f'  On pair: {best_overall["pair"]}')
print(f'  WR: {best_overall["wr"]}% | PnL: {best_overall["pnl"]:+.2f}% | Trades: {best_overall["trades"]}')

# Print best reversion params for the website
print(f'\n  Best reversion params:')
for sym,label in pairs:
    for thr in [5,7,9,11]:
        e=StratEngine()
        r=e.run(all_data[sym],strategy='reversion',thr=thr)
        if r['win_rate']>=60:
            print(f'  ✅ {label} reversion thr={thr}: WR: {r["win_rate"]}% PnL: {r["pnl_pct"]:+.2f}% Trades: {r["trades"]}')
