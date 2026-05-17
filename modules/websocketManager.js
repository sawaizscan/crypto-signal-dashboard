const FSTREAM = 'wss://fstream.binance.com';
const DEMO_FAPI = 'https://demo-fapi.binance.com';

export class WebSocketManager {
  constructor() {
    this.marketWs = null;
    this.userWs = null;
    this.listenKey = null;
    this._refreshTimer = null;
    this._reconnectTimer = null;
    this._marketHandlers = [];
    this._userHandlers = [];
    this._statusHandlers = [];
    this.state = { market: 'disconnected', user: 'disconnected' };
    this._reconnectDelay = 1000;
    this._intentionalClose = false;
  }

  onMarketUpdate(handler) {
    this._marketHandlers.push(handler);
  }

  onUserUpdate(handler) {
    this._userHandlers.push(handler);
  }

  onStatusChange(handler) {
    this._statusHandlers.push(handler);
  }

  _emitStatus(type, status) {
    this.state[type] = status;
    this._statusHandlers.forEach(h => h(type, status));
  }

  connectMarket(pairs) {
    if (this.marketWs) {
      this._intentionalClose = true;
      this.marketWs.close();
    }
    this._intentionalClose = false;

    const streams = pairs.map(p => `${p.toLowerCase()}@kline_1m`).join('/');
    const url = `${FSTREAM}/stream?streams=${streams}`;

    try {
      this.marketWs = new WebSocket(url);
    } catch {
      this._emitStatus('market', 'error');
      this._scheduleReconnect('market', pairs);
      return;
    }

    this.marketWs.onopen = () => {
      this._emitStatus('market', 'connected');
      this._reconnectDelay = 1000;
    };

    this.marketWs.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.data && msg.data.e === 'kline' && msg.data.k && msg.data.k.x === true) {
          const k = msg.data.k;
          const candle = {
            time: Math.floor(k.t / 1000),
            open: parseFloat(k.o),
            high: parseFloat(k.h),
            low: parseFloat(k.l),
            close: parseFloat(k.c),
            volume: parseFloat(k.v),
          };
          this._marketHandlers.forEach(h => h(msg.data.s, candle));
        }
      } catch {}
    };

    this.marketWs.onclose = () => {
      this._emitStatus('market', 'disconnected');
      if (!this._intentionalClose) this._scheduleReconnect('market', pairs);
    };

    this.marketWs.onerror = () => {
      this._emitStatus('market', 'error');
    };
  }

  async connectUser(apiKey, secretKey) {
    this.disconnectUser();

    try {
      const resp = await fetch(`${DEMO_FAPI}/fapi/v1/listenKey`, {
        method: 'POST',
        headers: { 'X-MBX-APIKEY': apiKey },
      });
      if (!resp.ok) throw new Error(`listenKey: ${resp.status}`);
      const data = await resp.json();
      this.listenKey = data.listenKey;
    } catch {
      this._emitStatus('user', 'error');
      return;
    }

    try {
      this.userWs = new WebSocket(`wss://demo-fapi.binance.com/ws/${this.listenKey}`);
    } catch {
      this._emitStatus('user', 'error');
      return;
    }

    this.userWs.onopen = () => {
      this._emitStatus('user', 'connected');
    };

    this.userWs.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.e === 'ACCOUNT_UPDATE') {
          this._userHandlers.forEach(h => h(msg));
        }
      } catch {}
    };

    this.userWs.onclose = () => {
      this._emitStatus('user', 'disconnected');
      if (!this._intentionalClose) {
        setTimeout(() => {
          if (apiKey) this.connectUser(apiKey, secretKey);
        }, 5000);
      }
    };

    this.userWs.onerror = () => {
      this._emitStatus('user', 'error');
    };

    this._refreshTimer = setInterval(async () => {
      try {
        await fetch(`${DEMO_FAPI}/fapi/v1/listenKey`, {
          method: 'PUT',
          headers: { 'X-MBX-APIKEY': apiKey },
        });
      } catch {}
    }, 30 * 60 * 1000);
  }

  _scheduleReconnect(type, ...args) {
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      if (type === 'market') this.connectMarket(...args);
      this._reconnectDelay = Math.min(this._reconnectDelay * 2, 30000);
    }, this._reconnectDelay);
  }

  disconnectUser() {
    this._intentionalClose = true;
    if (this.userWs) { this.userWs.close(); this.userWs = null; }
    if (this._refreshTimer) { clearInterval(this._refreshTimer); this._refreshTimer = null; }
    this.listenKey = null;
    this._emitStatus('user', 'disconnected');
  }

  disconnect() {
    this._intentionalClose = true;
    if (this.marketWs) { this.marketWs.close(); this.marketWs = null; }
    this.disconnectUser();
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this._emitStatus('market', 'disconnected');
  }
}
