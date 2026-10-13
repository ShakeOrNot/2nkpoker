/**
 * 远端协议客户端（Node 版，零依赖）
 * 用原生 WebSocket 直连 Socket.IO 服务器，供联调脚本驱动"另一个玩家"。
 * 只实现联调需要的部分；产品代码请用浏览器版的 net/remote-protocol.js。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class RemotePlayer {
  /**
   * @param {{ baseUrl: string, roomId: string, name: string }} cfg
   */
  constructor(cfg) {
    this.baseUrl = String(cfg.baseUrl).replace(/\/+$/, '');
    this.roomId = cfg.roomId;
    this.name = cfg.name;
    this.seat = null;
    this.hand = [];
    this.state = null;
    this.showdown = null;
    this.errors = [];
    this.timeline = [];
  }

  /**
   * 连接 → 加入房间 → 准备
   * @returns {Promise<void>}
   */
  async start({ ready = true } = {}) {
    const wsUrl = `${this.baseUrl.replace(/^http/, 'ws')}/socket.io/?EIO=4&transport=websocket`;
    this.ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => {
        this.ws.send('40');
        resolve();
      }, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });

    this.ws.addEventListener('message', (ev) => {
      for (const packet of String(ev.data).split('\u001e')) {
        if (!packet) continue;
        if (packet[0] === '2') { this.ws.send('3'); continue; }
        if (packet[0] !== '4') continue;
        const sio = packet.slice(1);
        if (sio.startsWith('0')) continue;
        const m = /^(\d*)\["?([A-Za-z_]+)"?,?(.*)\]$/s.exec(sio);
        if (!m) continue;
        let payload = null;
        try { payload = JSON.parse(`[${m[3]}]`)[0]; } catch { payload = m[3]; }
        this.onEvent(m[2], payload);
      }
    });

    await sleep(300);
    this.emit('joinRoom', { roomId: this.roomId, playerName: this.name });
    await this.waitFor(() => this.seat != null, 6000);
    if (ready) {
      this.emit('playerReady', { roomId: this.roomId });
    }
  }

  /**
   * @param {string} event
   * @param {any} payload
   */
  emit(event, payload) {
    this.ws.send(`42${JSON.stringify([event, payload])}`);
  }

  /**
   * @param {string} event
   * @param {any} payload
   */
  onEvent(event, payload) {
    this.timeline.push({ at: Date.now(), event });
    if (event === 'joinSuccess') this.seat = payload?.seat ?? null;
    if (event === 'myHand') this.hand = Array.isArray(payload) ? payload : [];
    if (event === 'gameState') this.state = payload;
    if (event === 'showdownResult') this.showdown = payload;
    if (event === 'joinFailed' || event === 'errorMsg') this.errors.push(String(payload));
  }

  /**
   * @param {() => boolean} predicate
   * @param {number} timeout
   */
  async waitFor(predicate, timeout = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (predicate()) return true;
      await sleep(50);
    }
    return false;
  }

  /**
   * 简单策略：能过牌就过牌，需要跟注就跟注（太贵就弃牌）
   * @returns {Promise<boolean>} 是否出手了
   */
  async actIfMyTurn() {
    const state = this.state;
    if (!state?.started || state.currentTurn !== this.seat) return false;
    const me = state.players.find((p) => p.seat === this.seat);
    if (!me) return false;
    const toCall = Math.max(0, (state.currentBet ?? 0) - (me.currentBet ?? 0));
    const action = toCall === 0 ? 'check' : toCall <= 60 ? 'call' : 'fold';
    this.emit('playerAction', { roomId: this.roomId, action });
    await sleep(250);
    return true;
  }

  /**
   * 一直陪打到摊牌
   * @param {number} maxMs
   */
  async autoPlay(maxMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      if (this.showdown) return true;
      await this.actIfMyTurn();
      await sleep(200);
    }
    return Boolean(this.showdown);
  }

  close() {
    try { this.ws?.close(); } catch { /* 忽略 */ }
  }
}

export { sleep };
