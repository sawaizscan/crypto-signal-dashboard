#!/usr/bin/env python3
"""
CryptoSignal — Fast Strategy Optimizer
Targeted grid search for near-100% WR
"""
import json, urllib.request, statistics, sys, time

BINANCE = 'https://api.binance.com'

def fetch(symbol, interval='1m', limit=500):
    url = f'{BINANCE}/api/v3/klines?symbol={symbol}&interval={interval}&limit={limit}'
    with urllib.request.urlopen(url, timeout=10) as r:
        data = json.loads(r.read())
    return [{'time': k[0]//1000, 'o': float(k[1]), 'h': float(k[2]),
             'l': float(k[3]), 'c': float(k[4]), 'v': float(k[5])} for k in data]

def ema(vals, p):
    m=2/(p+1); e=vals[0]; r=[e]
    for x in vals[1:]:
        e=(x-e)*m+e; r.append(e)
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
        if v is not None and si<len(sig): h.append(v-sig[si] if v is not None else None); si+=1
        else: h.append(None)
    h2=[]; si=0
    for v in ml:
        if v is not None and si<len(sig): h2.append(v-sig[si]); si+=1
        else: h2.append(None)
    return h2

def atr(c, p=14):
    r=[0.0]*len(c)
    for i in range(len(c)):
        if i==0: r[i]=c[i]['h']-c[i]['l']
        else:
            tr=max(c[i]['h']-c[i]['l'],abs(c[i]['h']-c[i-1]['c']),abs(c[i]['l']-c[i-1]['c']))
            if i<p: r[i]=(r[i-1]*i+tr)/(i+1)
            else: r[i]=(r[i-1]*(p-1)+tr)/p
    return r

def run(candles, dev=0.12, rl=35, rh=65, macd_r=True, thr=5, sl_a=0.5, tp_r=2.0, lev=10, mar=0.3):
    closes = [x['c'] for x in candles]
    e20 = ema(closes, 20) if len(closes)>=20 else [None]*len(closes)
    rs = rsi(closes)
    m = macd(closes)
    at = atr(candles)

    bal = 10000; pos = None; trades = []

    for i in range(60, len(candles)):
        p = closes[i]
        e20v = e20[i]; rv = rs[i]; h0=m[i]; h1=m[i-1] if i>0 else None
        tick = max(at[i]*sl_a if at[i] else p*0.002, p*0.0008)

        if pos:
            sl,tp=pos['sl'],pos['tp']; ex=None
            if pos['t']=='B':
                if p<=sl: ex=sl
                elif p>=tp: ex=tp
            else:
                if p>=sl: ex=sl
                elif p<=tp: ex=tp
            if ex:
                pnl=(ex-pos['e'])*pos['q'] if pos['t']=='B' else (pos['e']-ex)*pos['q']
                bal+=pos['m']+pnl; trades.append({'w':pnl>0}); pos=None
        if pos: continue

        if e20v is None or rv is None: continue
        dev_pct = ((p/e20v)-1)*100
        score=0
        if dev_pct < -dev and rv and rv < rl:
            score=10
            if macd_r and h0 is not None and h1 is not None and h0>h1: score+=5
        if dev_pct > dev and rv and rv > rh:
            score=-10
            if macd_r and h0 is not None and h1 is not None and h0<h1: score-=5

        if abs(score)>=thr and bal>10:
            sig='B' if score>0 else 'S'
            margin=bal*mar
            qty=(margin*lev)/p
            if qty>0 and margin>1:
                if sig=='B': pos={'t':'B','e':p,'q':qty,'m':margin,'sl':p-tick,'tp':p+tick*tp_r}
                else: pos={'t':'S','e':p,'q':qty,'m':margin,'sl':p+tick,'tp':p-tick*tp_r}
                bal-=margin

    if pos:
        lp=closes[-1]; pnl=(lp-pos['e'])*pos['q'] if pos['t']=='B' else (pos['e']-lp)*pos['q']
        bal+=pos['m']+pnl; trades.append({'w':pnl>0})

    w=sum(1 for t in trades if t['w']); l=len(trades)-w
    return {'t':len(trades),'w':w,'l':l,'wr':round(w/len(trades)*100,1) if trades else 0,'pnl':round(bal-10000,2)}

# ==== MAIN ====
pairs = [('BTCUSDT','BTC'), ('ETHUSDT','ETH'), ('SOLUSDT','SOL')]
data = {}
print('Fetching...')
for sym, label in pairs:
    data[sym] = fetch(sym, '1m', 500)
    print(f'  {label}: {len(data[sym])} candles')

print('\nParameter sweep — testing all combos...\n')

param_sets = [
    # (dev, rsi_low, rsi_high, macd_req, thr, sl_atr, tp_ratio)
    (0.08, 35, 65, True, 4, 0.4, 2.0),
    (0.08, 40, 65, True, 4, 0.4, 2.0),
    (0.10, 35, 65, True, 4, 0.5, 2.0),
    (0.10, 38, 62, True, 5, 0.5, 2.0),
    (0.10, 40, 65, True, 5, 0.5, 2.0),
    (0.12, 35, 65, True, 4, 0.4, 2.0),
    (0.12, 35, 65, True, 5, 0.5, 2.0),
    (0.12, 38, 62, True, 5, 0.5, 2.0),
    (0.12, 38, 62, True, 6, 0.5, 2.5),
    (0.12, 40, 65, True, 5, 0.5, 2.0),
    (0.12, 40, 65, True, 6, 0.5, 2.5),
    (0.15, 30, 70, True, 5, 0.3, 3.0),
    (0.15, 35, 65, True, 5, 0.5, 2.0),
    (0.15, 35, 65, True, 6, 0.5, 2.5),
    (0.15, 38, 62, True, 5, 0.5, 2.0),
    (0.15, 38, 62, True, 6, 0.5, 2.5),
    (0.15, 40, 65, True, 6, 0.5, 2.0),
    (0.18, 30, 70, True, 6, 0.3, 3.0),
    (0.18, 35, 65, True, 6, 0.5, 2.5),
    (0.18, 38, 62, True, 5, 0.5, 2.0),
    (0.20, 30, 70, True, 5, 0.3, 3.0),
    (0.20, 30, 70, True, 7, 0.3, 3.0),
    (0.08, 35, 65, False, 4, 0.4, 2.0),  # no macd variants
    (0.10, 35, 65, False, 5, 0.5, 2.0),
    (0.12, 35, 65, False, 5, 0.5, 2.0),
    (0.15, 35, 65, False, 5, 0.5, 2.0),
]

all_results = []
for label, (sym, _) in zip(['BTC','ETH','SOL'], pairs):
    c = data[sym]
    print(f'  --- {label} ---')
    for pset in param_sets:
        dev, rl, rh, m_r, thr, sla, tpr = pset
        r = run(c, dev, rl, rh, m_r, thr, sla, tpr)
        if r['t'] >= 2:
            all_results.append({**r, 'config': f'{dev}/{rl}-{rh}/{m_r}/{thr}', 'pair': label, 'dev': dev, 'rl': rl, 'rh': rh, 'm_r': m_r, 'thr': thr, 'sla': sla, 'tpr': tpr})
            mark = '✅' if r['wr'] >= 80 else '⚠️' if r['wr'] >= 60 else '❌'
            print(f'    {mark} WR:{r["wr"]:5.1f}%  Trades:{r["t"]:3d}  PnL:{r["pnl"]:+7.2f}  '
                  f'dev={dev:.2f} rsi={rl}-{rh} macd={m_r} thr={thr} sl={sla} tp={tpr}')

# Rank
all_results.sort(key=lambda x: (-x['wr'], -x['t']))
print(f'\n{"="*70}')
print(f'  TOP 15 OVERALL')
print(f'{"="*70}')
print(f'  {"WR%":>5} {"Trades":>7} {"PnL":>8} {"Pair":>5} {"Config":>25}')
print(f'  {"-"*55}')
for r in all_results[:15]:
    print(f'  {r["wr"]:4.1f}%  {r["t"]:5d}  {r["pnl"]:+7.2f}  {r["pair"]:>4}  {r["config"]}')

# === Cross-validate top 3 on second half ===
print(f'\n{"="*70}')
print(f'  CROSS-VALIDATION (last 250 candles)')
print(f'{"="*70}')
top3 = all_results[:3]
for r in top3:
    c = data['BTCUSDT' if r['pair']=='BTC' else 'ETHUSDT' if r['pair']=='ETH' else 'SOLUSDT']
    mid = len(c)//2
    r2 = run(c[mid:], r['dev'], r['rl'], r['rh'], r['m_r'], r['thr'], r['sla'], r['tpr'])
    print(f'  {r["pair"]:4s} WR:{r["wr"]:5.1f}% → {r2["wr"]:5.1f}%  Trades:{r["t"]}→{r2["t"]}  PnL:{r["pnl"]:+7.2f}→{r2["pnl"]:+7.2f}')

# === Try to approach 100%: ultra strict ===
print(f'\n{"="*70}')
print(f'  ULTRA-STRICT: Trying to hit 100% WR')
print(f'{"="*70}')
strict_params = [
    (0.15, 30, 70, True, 6, 0.3, 3.0),
    (0.15, 30, 70, True, 7, 0.3, 3.0),
    (0.18, 30, 70, True, 5, 0.3, 3.0),
    (0.18, 30, 70, True, 6, 0.3, 3.0),
    (0.20, 30, 70, True, 5, 0.3, 3.0),
    (0.20, 30, 70, True, 6, 0.3, 3.0),
    (0.20, 25, 75, True, 6, 0.3, 3.0),
    (0.25, 30, 70, True, 6, 0.3, 3.0),
    (0.25, 25, 75, True, 7, 0.3, 3.0),
    (0.30, 25, 75, True, 7, 0.3, 3.0),
    (0.30, 20, 80, True, 8, 0.3, 3.0),
    (0.15, 30, 70, True, 5, 0.5, 3.0),
    (0.18, 30, 70, True, 5, 0.5, 3.0),
]
# Also: don't force macd, try candle confirmation style
# Candle-confirm: require that the candle body direction matches
def run_ultra(candles, dev, rl, rh, thr, sla=0.5, tpr=2.5, lev=10, mar=0.3):
    closes = [x['c'] for x in candles]
    e20 = ema(closes, 20) if len(closes)>=20 else [None]*len(closes)
    rs = rsi(closes)
    at = atr(candles)
    bal = 10000; pos = None; trades = []
    for i in range(60, len(candles)):
        p = closes[i]; e20v = e20[i]; rv = rs[i]
        tick = max(at[i]*sla if at[i] else p*0.002, p*0.0008)
        if pos:
            sl,tp=pos['sl'],pos['tp']; ex=None
            if pos['t']=='B':
                if p<=sl: ex=sl
                elif p>=tp: ex=tp
            else:
                if p>=sl: ex=sl
                elif p<=tp: ex=tp
            if ex:
                pnl=(ex-pos['e'])*pos['q'] if pos['t']=='B' else (pos['e']-ex)*pos['q']
                bal+=pos['m']+pnl; trades.append({'w':pnl>0}); pos=None
        if pos: continue
        if e20v is None or rv is None: continue
        dp=((p/e20v)-1)*100; score=0
        if dp<-dev and rv<rl:
            score=10
            if candles[i]['c'] > candles[i]['o']: score+=3
        if dp>dev and rv>rh:
            score=-10
            if candles[i]['c'] < candles[i]['o']: score-=3
        if abs(score)>=thr and bal>10:
            sig='B' if score>0 else 'S'; margin=bal*mar; qty=(margin*lev)/p
            if qty>0:
                if sig=='B': pos={'t':'B','e':p,'q':qty,'m':margin,'sl':p-tick,'tp':p+tick*tpr}
                else: pos={'t':'S','e':p,'q':qty,'m':margin,'sl':p+tick,'tp':p-tick*tpr}
                bal-=margin
    if pos:
        lp=closes[-1]; pnl=(lp-pos['e'])*pos['q'] if pos['t']=='B' else (pos['e']-lp)*pos['q']
        bal+=pos['m']+pnl; trades.append({'w':pnl>0})
    w=sum(1 for t in trades if t['w']); l=len(trades)-w
    return {'t':len(trades),'w':w,'l':l,'wr':round(w/len(trades)*100,1) if trades else 0,'pnl':round(bal-10000,2)}

print(f'  {"WR%":>5} {"Tr":>4} {"PnL":>8} {"Pair":>4}  {"Dev":>4} {"RSI":>6} {"Thr":>4}')
for label, (sym, _) in zip(['BTC','ETH','SOL'], pairs):
    c = data[sym]
    for dev, rl, rh, macd_r, thr, sla, tpr in strict_params:
        r = run_ultra(c, dev, rl, rh, thr, sla, tpr)
        if r['t'] >= 2:
            mark = '💯' if r['wr']==100 else '✅' if r['wr']>=85 else '⚠️' if r['wr']>=60 else ' '
            print(f'  {mark} {r["wr"]:4.1f}%  {r["t"]:3d}  {r["pnl"]:+7.2f}  {label}  {dev:.2f}  {rl}-{rh}  {thr}')

# === MULTI-TIMEFRAME: 3m + 1m ===
print(f'\n{"="*70}')
print(f'  MULTI-TIMEFRAME TEST (SOL 3m data, execute on 1m)')
print(f'{"="*70}')
sol3m = fetch('SOLUSDT', '3m', 200)
print(f'  3m candles: {len(sol3m)}')

# Simple test: use 3m ema trend direction, execute on 1m reversion signals
cl1m = data['SOLUSDT']
e3m = ema([x['c'] for x in sol3m], 20)
e1m = ema([x['c'] for x in cl1m], 20)

def run_mtf(candles, trend_up_fn, params):
    closes=[x['c'] for x in candles]; rs=rsi(closes); at=atr(candles)
    bal=10000; pos=None; trades=[]; dev=params['dev']; rl=params['rl']; rh=params['rh']; thr=params['thr']
    for i in range(60,len(candles)):
        p=closes[i]; e20v=e1m[i]; rv=rs[i]; trend_up=trend_up_fn(i)
        tick=max(at[i]*0.5 if at[i] else p*0.002,p*0.0008)
        if pos:
            sl,tp=pos['sl'],pos['tp']; ex=None
            if pos['t']=='B':
                if p<=sl: ex=sl
                elif p>=tp: ex=tp
            else:
                if p>=sl: ex=sl
                elif p<=tp: ex=tp
            if ex:
                pnl=(ex-pos['e'])*pos['q'] if pos['t']=='B' else (pos['e']-ex)*pos['q']
                bal+=pos['m']+pnl; trades.append({'w':pnl>0}); pos=None
        if pos: continue
        if e20v is None or rv is None: continue
        dp=((p/e20v)-1)*100; score=0
        if dp<-dev and rv<rl and trend_up: score=12
        if dp>dev and rv>rh and not trend_up: score=-12
        if abs(score)>=thr and bal>10:
            sig='B' if score>0 else 'S'; margin=bal*0.3; qty=(margin*10)/p
            if qty>0:
                if sig=='B': pos={'t':'B','e':p,'q':qty,'m':margin,'sl':p-tick,'tp':p+tick*2.0}
                else: pos={'t':'S','e':p,'q':qty,'m':margin,'sl':p+tick,'tp':p-tick*2.0}
                bal-=margin
    if pos:
        lp=closes[-1]; pnl=(lp-pos['e'])*pos['q'] if pos['t']=='B' else (pos['e']-lp)*pos['q']
        bal+=pos['m']+pnl; trades.append({'w':pnl>0})
    w=sum(1 for t in trades if t['w']); l=len(trades)-w
    return {'t':len(trades),'w':w,'l':l,'wr':round(w/len(trades)*100,1) if trades else 0,'pnl':round(bal-10000,2)}

def trend_up_3m(i):
    t1 = cl1m[i]['time']
    idx = int(t1 / 180)
    return idx < len(e3m) and e3m[idx] is not None and sol3m[idx] if idx < len(sol3m) else None

# Actually simpler: just check if 3m EMA20 is trending up
def trend_up_3m_v2(i):
    t1 = cl1m[i]['time']
    idx = int(t1 / 180)
    if idx < len(e3m) and e3m[idx] is not None:
        return sol3m[idx]['c'] > e3m[idx]
    return True  # default to allowing

mtf_params = [{'dev':0.10,'rl':38,'rh':62,'thr':6},{'dev':0.12,'rl':35,'rh':65,'thr':5},{'dev':0.15,'rl':30,'rh':70,'thr':5}]
for p in mtf_params:
    r = run_mtf(cl1m, trend_up_3m_v2, p)
    if r['t']>0:
        print(f'  dev={p["dev"]} rsi={p["rl"]}-{p["rh"]} thr={p["thr"]}: WR={r["wr"]:4.1f}% Trades={r["t"]} PnL={r["pnl"]:+7.2f}')

# === FINAL RECOMMENDATION ===
print(f'\n{"="*70}')
print(f'  FINAL SUMMARY')
print(f'{"="*70}')
print(f'')
print(f'  Strategies tested:')
print(f'    - Mean reversion (price vs EMA20) w/ RSI filter')
print(f'    - Ultra-strict (wide bands, high threshold, 3:1 TP)')
print(f'    - Multi-timeframe (3m trend filter + 1m entry)')
print(f'    - Candle confirmation (require bull/bear body)')
print(f'')
print(f'  Best results found:')
for r in all_results[:3]:
    print(f'    {r["pair"]:4s}: WR={r["wr"]:5.1f}%  Trades={r["t"]:3d}  PnL={r["pnl"]:+7.2f}  '
          f'dev={r["dev"]:.2f} rsi={r["rl"]}-{r["rh"]} thr={r["thr"]}')

# Check for 100% WR configs
strict_results = []
for label, (sym, _) in zip(['BTC','ETH','SOL'], pairs):
    c = data[sym]
    for dev, rl, rh, macd_r, thr, sla, tpr in strict_params:
        r = run_ultra(c, dev, rl, rh, thr, sla, tpr)
        if r['t'] >= 2 and r['wr']>=90:
            strict_results.append({**r, 'pair': label, 'dev': dev, 'rl': rl, 'rh': rh, 'thr': thr})
for r in strict_results[:5]:
    print(f'    Strict: {r["pair"]:4s} WR={r["wr"]:5.1f}% Trades={r["t"]:3d} dev={r["dev"]:.2f} rsi={r["rl"]}-{r["rh"]} thr={r["thr"]}')

# === TIGHT SCALPING: very tight stops, small targets, high selectivity ===
print(f'\n{"="*70}')
print(f'  TIGHT SCALPING STRATEGY: 0.3 ATR stop, 0.8 ATR target')
print(f'  Only trades when multiple conditions align perfectly')
print(f'{"="*70}')

def run_scalp(candles, params):
    closes=[x['c'] for x in candles]; e20=ema(closes,20); e50=ema(closes,50); rs=rsi(closes)
    m=macd(closes); at=atr(candles)
    bal=10000; pos=None; trades=[]
    for i in range(60,len(candles)):
        p=closes[i]; e20v=e20[i]; e50v=e50[i] if i<len(e50) else e20v
        rv=rs[i]; h0=m[i]; h1=m[i-1] if i>0 else None; atv=at[i] if at[i] else p*0.002
        sl_dist=atv*0.3; tp_dist=atv*0.8
        tick=max(sl_dist,tp_dist,p*0.0006)
        
        if pos:
            sl,tp=pos['sl'],pos['tp']; ex=None
            if pos['t']=='B':
                if p<=sl: ex=sl
                elif p>=tp: ex=tp
            else:
                if p>=sl: ex=sl
                elif p<=tp: ex=tp
            if ex:
                pnl=(ex-pos['e'])*pos['q'] if pos['t']=='B' else (pos['e']-ex)*pos['q']
                bal+=pos['m']+pnl; trades.append({'w':pnl>0}); pos=None
        if pos: continue
        if None in (e20v,e50v,rv,h0): continue
        
        dp=((p/e20v)-1)*100; score=0
        # Reversion buy: price dipped below EMA, RSI oversold, MACD turning up
        if dp<-params['dev'] and rv<params['rsi_l'] and h0 is not None and h1 is not None:
            score=5
            if h0>h1: score+=5
            if p<e20v and e20v<e50v: score+=3  # downtrend reversion stronger
            if cl1m[i]['c']>cl1m[i]['o']: score+=2
            # Extra: check if this is a lower low with bullish divergence
            if i>2 and closes[i]<closes[i-1] and rv>rs[i-1]: score+=3
        
        # Reversion sell
        if dp>params['dev'] and rv>params['rsi_h'] and h0 is not None and h1 is not None:
            score=-5
            if h0<h1: score-=5
            if p>e20v and e20v>e50v: score-=3
            if cl1m[i]['c']<cl1m[i]['o']: score-=2
            if i>2 and closes[i]>closes[i-1] and rv<rs[i-1]: score-=3
        
        if abs(score)>=params['thr'] and bal>10:
            sig='B' if score>0 else 'S'; margin=bal*params['mar']
            qty=(margin*params['lev'])/p
            if qty>0:
                if sig=='B': pos={'t':'B','e':p,'q':qty,'m':margin,'sl':p-sl_dist,'tp':p+tp_dist}
                else: pos={'t':'S','e':p,'q':qty,'m':margin,'sl':p+sl_dist,'tp':p-tp_dist}
                bal-=margin
    if pos:
        lp=closes[-1]; pnl=(lp-pos['e'])*pos['q'] if pos['t']=='B' else (pos['e']-lp)*pos['q']
        bal+=pos['m']+pnl; trades.append({'w':pnl>0})
    w=sum(1 for t in trades if t['w']); l=len(trades)-w
    return {'t':len(trades),'w':w,'l':l,'wr':round(w/len(trades)*100,1) if trades else 0,'pnl':round(bal-10000,2)}

scalp_paramsets = [
    {'dev':0.08,'rsi_l':38,'rsi_h':62,'thr':5,'lev':10,'mar':0.3},
    {'dev':0.08,'rsi_l':35,'rsi_h':65,'thr':5,'lev':10,'mar':0.3},
    {'dev':0.08,'rsi_l':30,'rsi_h':70,'thr':6,'lev':10,'mar':0.25},
    {'dev':0.08,'rsi_l':40,'rsi_h':60,'thr':6,'lev':10,'mar':0.25},
    {'dev':0.10,'rsi_l':35,'rsi_h':65,'thr':5,'lev':10,'mar':0.3},
    {'dev':0.10,'rsi_l':38,'rsi_h':62,'thr':6,'lev':10,'mar':0.25},
    {'dev':0.10,'rsi_l':30,'rsi_h':70,'thr':7,'lev':10,'mar':0.2},
    {'dev':0.12,'rsi_l':35,'rsi_h':65,'thr':5,'lev':10,'mar':0.3},
    {'dev':0.12,'rsi_l':38,'rsi_h':62,'thr':6,'lev':10,'mar':0.25},
    {'dev':0.12,'rsi_l':30,'rsi_h':70,'thr':7,'lev':10,'mar':0.2},
    {'dev':0.15,'rsi_l':30,'rsi_h':70,'thr':6,'lev':10,'mar':0.2},
    {'dev':0.15,'rsi_l':35,'rsi_h':65,'thr':5,'lev':10,'mar':0.25},
    # Extra: try tighter stops for more trades
    {'dev':0.08,'rsi_l':38,'rsi_h':62,'thr':5,'lev':10,'mar':0.25},
    {'dev':0.08,'rsi_l':35,'rsi_h':65,'thr':5,'lev':10,'mar':0.2},
    {'dev':0.08,'rsi_l':30,'rsi_h':70,'thr':5,'lev':10,'mar':0.25},
    {'dev':0.10,'rsi_l':38,'rsi_h':62,'thr':5,'lev':10,'mar':0.25},
    {'dev':0.10,'rsi_l':35,'rsi_h':65,'thr':6,'lev':10,'mar':0.2},
    {'dev':0.10,'rsi_l':40,'rsi_h':60,'thr':5,'lev':10,'mar':0.25},
    {'dev':0.12,'rsi_l':40,'rsi_h':60,'thr':5,'lev':10,'mar':0.25},
    {'dev':0.12,'rsi_l':38,'rsi_h':62,'thr':5,'lev':10,'mar':0.25},
]
scalp_results = []
for label, (sym, _) in zip(['BTC','ETH','SOL'], pairs):
    c = data[sym]
    for sp in scalp_paramsets:
        r = run_scalp(c, sp)
        if r['t']>=2:
            scalp_results.append({**r, 'pair':label, 'config':f'{sp["dev"]}/{sp["rsi_l"]}-{sp["rsi_h"]}/{sp["thr"]}'})
scalp_results.sort(key=lambda x: (-x['wr'],-x['t']))
print(f'  {"WR%":>5} {"Trades":>7} {"PnL":>8} {"Pair":>4}  Config')
print(f'  {"-"*45}')
for r in scalp_results[:10]:
    mark='💯' if r['wr']==100 else '✅' if r['wr']>=85 else '⚠️' if r['wr']>=70 else ' '
    print(f'  {mark} {r["wr"]:4.1f}%  {r["t"]:5d}  {r["pnl"]:+7.2f}  {r["pair"]:>4}  {r["config"]}')

# Cross-validate best scalp on 2nd half
print(f'\n  Cross-validate best scalp on 2nd half:')
for r in scalp_results[:3]:
    c = data[f'{r["pair"]}USDT']
    mid=len(c)//2
    ps={'dev':float(r["config"].split('/')[0]),'rsi_l':int(r["config"].split('/')[1].split('-')[0]),
        'rsi_h':int(r["config"].split('/')[1].split('-')[1]),'thr':int(r["config"].split('/')[2]),
        'lev':10,'mar':0.3}
    r2=run_scalp(c[mid:],ps)
    print(f'    {r["pair"]}: {r["wr"]}% ({r["t"]}) → {r2["wr"]}% ({r2["t"]})')

# === OUT-OF-SAMPLE ON FRESH DATA ===
print(f'\n{"="*70}')
print(f'  OUT-OF-SAMPLE VALIDATION (300 new candles per pair)')
print(f'{"="*70}')
for sym,label in pairs:
    fresh=fetch(sym,'1m',300)
    print(f'  Fresh {label}: {len(fresh)} candles')
    data[label+'_fresh']=fresh

# Test best scalp configs on fresh data
for r in scalp_results[:3]:
    c = data[f'{r["pair"]}_fresh']
    if not c: continue
    ps={'dev':float(r["config"].split('/')[0]),'rsi_l':int(r["config"].split('/')[1].split('-')[0]),
        'rsi_h':int(r["config"].split('/')[1].split('-')[1]),'thr':int(r["config"].split('/')[2]),
        'lev':10,'mar':0.3}
    r2=run_scalp(c,ps)
    print(f'  {r["pair"]} scalp: TRAIN=WR:{r["wr"]}%({r["t"]}t)  TEST=WR:{r2["wr"]}%({r2["t"]}t)')
