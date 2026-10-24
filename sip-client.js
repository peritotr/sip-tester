// Interactive SIP client for the "Single test" view: OPTIONS ping, REGISTER / unregister (refreshed automatically),
// test calls one by one or in small batches, and a full message log. Runs in the main process.
const EventEmitter = require('events');
const { SipUA, Call, register, uid, statusName } = require('./sip-core');
const { RtpPool } = require('./rtp');

const fill = (s, p) => p ? s.replace(/\{(\w+)\}/g, (m, k) => p[k] !== undefined ? p[k] : m) : s;
const msg = (key, p) => ({ key, p, text: fill(key, p) });
const firstLine = t => t.slice(0, Math.max(0, t.indexOf('\r\n')));
const callIdOf = t => { const r = /\r\n(?:Call-ID|i)[ \t]*:[ \t]*([^\r\n]+)/i.exec(t); return r ? r[1].trim() : ''; };
const ms = (a, b) => a != null && b != null ? Math.round((a - b) * 10) / 10 : null;

class SipClient extends EventEmitter {
  constructor() { super(); this.state = 'disconnected'; this.calls = new Map(); this.n = 0; this.reg = { state: 'none' }; }

  _state(s, info) { this.state = s; this.emit('state', { state: s, ...(info || {}) }); }

  async connect(cfg) {
    this.disconnect(true);
    this.cfg = cfg;
    this._state('connecting');
    try {
      const ua = new SipUA({ ...cfg, connections: 1, timeout: (Number(cfg.timeout) || 32) * 1000 });
      ua.trace = (dir, text, sock, rinfo) => this.emit('log', { ts: Date.now(), dir, first: firstLine(text), callId: callIdOf(text), text,
        remote: dir === 'in' ? (rinfo ? `${rinfo.address}:${rinfo.port}` : `${ua.ip}:${ua.port}`) : `${ua.ip}:${ua.port}` });
      await ua.open();
      ua.handler = m => { const c = this.calls.get(m.callId); if (c && c.call) { c.call.onRequest(m); return true; } return false; };
      ua.on('connClosed', () => { if (this.ua === ua) { this._state('error', msg('The server closed the connection')); this.disconnect(true); } });
      this.ua = ua;
      this.pool = new RtpPool({ portStart: cfg.rtpPort });
      this.sink = await this.pool.openSink();
      this.rtpTimer = setInterval(() => this.pool && this.pool.tick(), 10);
      this.statTimer = setInterval(() => this._refreshRows(), 1000);
      this._state('ready', { local: `${ua.localIp}:${ua.socks[0].port}`, transport: ua.transport.toUpperCase() });
    } catch (e) {
      this._state('error', e.key ? msg(e.key, e.p) : { text: e.message });
      throw e;
    }
  }

  disconnect(quiet) {
    clearTimeout(this.regTimer); clearInterval(this.rtpTimer); clearInterval(this.statTimer);
    for (const c of this.calls.values()) if (c.call && c.call.state !== 'ended') { c.end = 'disconnected'; c.state = 'ended'; this._row(c); }
    if (this.ua) {
      // Best effort: unregister before closing
      if (this.reg.state === 'registered') try { register(this.ua, { user: this.cfg.user, authUser: this.cfg.authUser, password: this.cfg.password, expires: 0, callId: this.reg.callId, cseq: this.reg.cseq }, () => {}); } catch {}
      const ua = this.ua; setTimeout(() => ua.close(), 300);
    }
    if (this.pool) this.pool.close();
    this.ua = null; this.pool = null; this.batch = null;
    this.reg = { state: 'none' }; this.emit('reg', this.reg);
    if (!quiet || this.state !== 'disconnected') this._state('disconnected');
  }

  _need() { if (!this.ua) throw Object.assign(new Error('Not connected'), { key: 'Not connected' }); }

  // OPTIONS ping → { ok, status, reason, ms }
  options() {
    this._need();
    const ua = this.ua, c = this.cfg, t0 = performance.now();
    const user = c.user || 'sip-tester';
    return new Promise(resolve => ua.authRequest(0, {
      method: 'OPTIONS', uri: `sip:${ua.domain}`, from: `<sip:${encodeURIComponent(user)}@${ua.domain}>;tag=${uid()}`, to: `<sip:${ua.domain}>`,
      callId: uid() + '@sip-tester', cseq: 1, headers: 'Accept: application/sdp\r\n',
    }, c.password ? { user: c.authUser || user, password: c.password } : null, res => {
      resolve(res ? { ok: res.status < 300, status: res.status, reason: res.reason, ms: ms(performance.now(), t0) } : { ok: false, status: 0, reason: 'Timeout', ms: null });
    }));
  }

  // REGISTER (expires > 0) or unregister (expires = 0) → resolves with the registration state
  register(expires) {
    this._need();
    const c = this.cfg, exp = expires == null ? (Number(c.expires) || 300) : Number(expires);
    if (!c.user) return Promise.resolve(this._setReg({ state: 'failed', reason: msg('Username is empty') }));
    clearTimeout(this.regTimer);
    this.reg.callId = this.reg.callId || uid() + '@sip-tester'; this.reg.cseq = this.reg.cseq || 1;
    const t0 = performance.now();
    this._setReg({ ...this.reg, state: exp ? 'registering' : 'unregistering' });
    return new Promise(resolve => register(this.ua, { user: c.user, authUser: c.authUser, password: c.password, expires: exp, callId: this.reg.callId, cseq: this.reg.cseq }, (res, info) => {
      this.reg.cseq = (info.cseq || this.reg.cseq) + 1;
      const base = { callId: this.reg.callId, cseq: this.reg.cseq, ms: ms(performance.now(), t0), status: res ? res.status : 0, reason: res ? res.reason : 'Timeout' };
      if (res && res.status < 300 && exp) {
        // Granted expiry: Contact ;expires= or the Expires header
        const ct = (res.headers.contact || []).join(','), m1 = /expires=(\d+)/i.exec(ct), m2 = res.headers.expires && Number(res.headers.expires[0]);
        const granted = m1 ? Number(m1[1]) : m2 || exp;
        this.regTimer = setTimeout(() => this.register(exp).catch(() => {}), Math.max(10, granted * 0.85) * 1000);
        resolve(this._setReg({ ...base, state: 'registered', expires: granted }));
      } else if (res && res.status < 300) resolve(this._setReg({ ...base, state: 'none' }));
      else resolve(this._setReg({ ...base, state: 'failed' }));
    }));
  }
  _setReg(r) { this.reg = r; this.emit('reg', r); return r; }

  // m: { dst, duration (s, 0 = until hung up), rtp, codec, count, cps }
  call(m) {
    this._need();
    const count = Math.max(1, Math.min(10000, Number(m.count) || 1)), cps = Math.max(0.1, Math.min(1000, Number(m.cps) || 1));
    const dsts = String(m.dst || '').split(/[\s,;]+/).filter(Boolean);
    if (!dsts.length) return { ok: false, error: msg('Destination is empty') };
    if (this.batch) this.batch.stop = true;
    const b = this.batch = { left: count, i: 0 };
    const one = () => {
      if (b.stop || !this.ua || b.left <= 0) { if (this.batch === b) this.batch = null; this.emit('batch', { running: false }); return; }
      b.left--;
      let dst = dsts[b.i++ % dsts.length]; if (/[xX]/.test(dst)) dst = dst.replace(/[xX]/g, () => String((Math.random() * 10) | 0));
      this._startCall(dst, m).catch(e => this.emit('log', { ts: Date.now(), dir: 'sys', first: e.message, text: e.message }));
      if (b.left > 0) b.timer = setTimeout(one, 1000 / cps); else { if (this.batch === b) this.batch = null; this.emit('batch', { running: false }); }
    };
    this.emit('batch', { running: count > 1 });
    one();
    return { ok: true };
  }
  stopBatch() { if (this.batch) { this.batch.stop = true; clearTimeout(this.batch.timer); this.batch = null; } this.emit('batch', { running: false }); }

  async _startCall(dst, m) {
    const c = this.cfg;
    const rtp = m.rtp ? await this.pool.session(m.codec) : null;
    if (!this.ua) return;
    const row = { id: ++this.n, ts: Date.now(), dst, state: 'calling', status: null, rtpOn: !!rtp };
    const call = new Call({ ua: this.ua, sockIdx: 0, dst, user: c.user || 'sip-tester', authUser: c.authUser, password: c.password || null, displayName: c.displayName,
      sdp: { port: rtp ? rtp.port : this.sink.port, codec: m.codec }, maxRing: 120000 }, {
      onProvisional: (k, res) => { row.status = statusName(res.status, res.reason); row.state = res.status === 100 ? 'trying' : 'ringing'; row.t100 = ms(k.t100, k.t0); if (k.t18x) row.pdd = ms(k.t18x, k.t0); this._row(row); },
      onAnswer: k => {
        row.state = 'answered'; row.status = statusName(k.status); row.t100 = ms(k.t100, k.t0); row.pdd = ms(k.t18x, k.t0); row.ans = ms(k.t200, k.t0); row.answeredAt = performance.now();
        if (rtp && k.remoteSdp) rtp.start(k.remoteSdp.ip, k.remoteSdp.port, k.remoteSdp.pt);
        row.codec = k.remoteSdp && k.remoteSdp.pt === 8 ? 'PCMA' : k.remoteSdp ? 'PCMU' : '';
        if (Number(m.duration) > 0) k.holdTimer = setTimeout(() => k.hangup(), Number(m.duration) * 1000);
        this._row(row);
      },
      onRequest: (k, req) => { if (req.method !== 'BYE' && rtp && k.remoteSdp) rtp.start(k.remoteSdp.ip, k.remoteSdp.port, k.remoteSdp.pt); },
      onFail: (k, code, reason, why) => { row.status = code ? statusName(code, reason) : 'Timeout'; row.t100 = ms(k.t100, k.t0); if (k.t18x) row.pdd = ms(k.t18x, k.t0); row.why = why; },
      onEnd: (k, why) => {
        row.state = 'ended'; row.end = why;
        if (row.answeredAt) row.dur = Math.round((performance.now() - row.answeredAt) / 100) / 10;
        if (k.byeStatus) row.bye = statusName(k.byeStatus); if (k.byeMs != null) row.byeMs = Math.round(k.byeMs * 10) / 10;
        if (rtp) { row.rtp = rtp.summary(); this.pool && this.pool.release(rtp); }
        this._row(row); row.call = null;
      },
    });
    row.call = call; row.callId = call.callId;
    this.calls.set(call.callId, row);
    if (this.calls.size > 2000) { const k = this.calls.keys().next().value; const r = this.calls.get(k); if (!r.call) this.calls.delete(k); }
    this._row(row);
    call.rtp = rtp;
    call.start();
  }

  _row(r) { const { call, answeredAt, ...pub } = r; if (r.state !== 'ended' && answeredAt) pub.dur = Math.round((performance.now() - answeredAt) / 100) / 10; if (call && call.rtp && r.state !== 'ended') pub.rtp = call.rtp.summary(); this.emit('call', pub); }
  _refreshRows() { for (const r of this.calls.values()) if (r.call && r.state === 'answered') this._row(r); }

  hangup(id) { for (const r of this.calls.values()) if (r.id === id && r.call) { clearTimeout(r.call.holdTimer); r.call.hangup(); } return { ok: true }; }
  hangupAll() { this.stopBatch(); for (const r of this.calls.values()) if (r.call) { clearTimeout(r.call.holdTimer); r.call.hangup(); } return { ok: true }; }
}

module.exports = { SipClient };
