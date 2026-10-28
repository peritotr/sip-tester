// Built-in vendor (trunk): a SIP server your PBX sends calls to. It answers calls, echoes RTP back and can
// behave like a slow or full carrier on purpose. Every new INVITE is reported as an "arrival" with the dialled
// number, which the load engine uses for end-to-end measurement (client → PBX → vendor).
// Runs in its own process in the apps (mock-worker.js); the test suite and `npm run uas` use it directly.
//
// opts: host ('127.0.0.1' | '0.0.0.0'), port, transports (['udp','tcp']), ip (address written into Contact/SDP; auto if empty),
//       user / password (digest auth required from the PBX when password is set; user empty = any username),
//       ringMs (180 after), answerMs (200 after), hangupAfterMs (vendor sends BYE; 0 = never),
//       maxCps (503 above), maxChannels (503 when that many calls are up), capacity (requests processed per second; the rest queue up),
//       busyPct (486), failPct + failCode, dropPct (no response at all), echo (RTP back, default true),
//       trunk (index reported with arrivals when several trunks run side by side; see mock-worker.js)
// Legacy test options still accepted: tcp (→ transports ['tcp']), auth { realm, password | passwordIsUser }, authInvite.
const EventEmitter = require('events');
const dgram = require('dgram');
const net = require('net');
const crypto = require('crypto');
const { parse, hdr, param, uriOf, tagOf, userOf, Framer, parseSdp, makeSdp, uid, localIpFor, REASONS } = require('./sip-core');

const fill = (s, p) => p ? s.replace(/\{(\w+)\}/g, (m, k) => p[k] !== undefined ? p[k] : m) : s;
const msg = (key, p) => ({ key, p, text: fill(key, p) });
const epoch = () => performance.timeOrigin + performance.now(); // comparable across processes on one machine
const num = (v, d = 0) => { const n = Number(v); return isFinite(n) && v !== '' && v != null ? n : d; };

class MockVendor extends EventEmitter {
  constructor(opts = {}) {
    super();
    const o = { host: '127.0.0.1', echo: true, ...opts };
    if (!o.transports) o.transports = o.tcp ? ['tcp'] : ['udp', 'tcp'];
    if (o.auth) { o.realm = o.auth.realm; o.password = o.auth.password; o.passwordIsUser = o.auth.passwordIsUser; if (o.authInvite == null) o.authInvite = false; }
    else if (o.password && o.authInvite == null) o.authInvite = true;
    o.realm = o.realm || 'sip-tester';
    for (const k of ['ringMs', 'answerMs', 'hangupAfterMs', 'maxCps', 'maxChannels', 'capacity', 'busyPct', 'failPct', 'dropPct']) o[k] = Math.max(0, num(o[k]));
    o.failCode = num(o.failCode, 480) || 480;
    this.o = o;
    this.stats = { invites: 0, answered: 0, rejected503: 0, full: 0, busy: 0, failed: 0, dropped: 0, registers: 0, registered: 0, challenges: 0, options: 0,
      byes: 0, byesSent: 0, acks: 0, cancels: 0, rtpIn: 0, rtpOut: 0, retransIn: 0, maxActive: 0 };
    this.sec = { inv: 0, ans: 0, rej: 0, rtp: 0 };
    this.seen = new Map(); this.calls = new Map(); this.queue = []; this.secCount = 0; this.secAt = Date.now();
    this.ips = new Map(); this.tcpConns = new Set();
    this.nonce = crypto.randomBytes(8).toString('hex');
  }

  get active() { let n = 0; for (const c of this.calls.values()) if (c.answered) n++; return n; }
  log(key, p) { this.emit('log', msg(key, p)); }

  async start() {
    const o = this.o;
    try {
      // Bind the first transport (port 0 picks a free one), then the others on the same port
      for (const tr of o.transports) await (tr === 'tcp' ? this._listenTcp(this.port ?? o.port ?? 0) : this._listenUdp(this.port ?? o.port ?? 0));
      this.rtp = await Promise.all(Array.from({ length: 8 }, () => this._rtpSock()));
    } catch (e) { this.stop(); throw e; }
    this.gc = setInterval(() => { const lim = Date.now() - 32000; for (const [k, v] of this.seen) { if (v.at > lim) break; this.seen.delete(k); } }, 1000);
    if (o.capacity) {
      let budget = 0, last = Date.now();
      this.qt = setInterval(() => {
        const t = Date.now(); budget = Math.min(budget + this.o.capacity * (t - last) / 1000, Math.max(1, this.o.capacity / 10)); last = t;
        while (budget >= 1 && this.queue.length) { budget--; this.queue.shift()(); }
        if (!this.queue.length) budget = Math.min(budget, 1);
      }, 10);
    }
    this.statT = setInterval(() => this._stats(), 1000);
    return this;
  }

  _err(e) {
    const port = this.port ?? this.o.port;
    if (e.code === 'EADDRINUSE') return Object.assign(new Error(`Port ${port} is already in use`), { key: 'Port {port} is already in use', p: { port } });
    if (e.code === 'EACCES') return Object.assign(new Error(`No permission for port ${port}`), { key: 'No permission for port {port} (choose a port above 1024)', p: { port } });
    return e;
  }

  _listenUdp(port) {
    return new Promise((resolve, reject) => {
      const s = this.udp = dgram.createSocket({ type: 'udp4', recvBufferSize: 8 << 20, sendBufferSize: 8 << 20 });
      s.once('error', e => reject(this._err(e)));
      s.on('message', (b, r) => this._recv(b.toString('latin1'), { kind: 'udp', addr: r.address, port: r.port, send: t => s.send(Buffer.from(t, 'latin1'), r.port, r.address) }));
      s.bind(port, this.o.host, () => { s.removeAllListeners('error'); s.on('error', () => {}); this.port = s.address().port; resolve(); });
    });
  }

  _listenTcp(port) {
    return new Promise((resolve, reject) => {
      this.srv = net.createServer(c => {
        const f = new Framer(); c.setNoDelay(true); this.tcpConns.add(c);
        const dest = { kind: 'tcp', addr: c.remoteAddress && c.remoteAddress.replace(/^::ffff:/, ''), port: c.remotePort, send: t => { if (!c.destroyed) c.write(t, 'latin1'); } };
        c.on('data', d => { for (const m of f.push(d)) this._recv(m, dest); });
        c.on('error', () => {}); c.on('close', () => this.tcpConns.delete(c));
      });
      this.srv.once('error', e => reject(this._err(e)));
      this.srv.listen(port, this.o.host, () => { this.port = this.srv.address().port; resolve(); });
    });
  }

  _rtpSock() {
    return new Promise((resolve, reject) => {
      const s = dgram.createSocket({ type: 'udp4', recvBufferSize: 8 << 20, sendBufferSize: 8 << 20 });
      s.once('error', reject);
      s.on('message', (b, r) => { this.stats.rtpIn++; this.sec.rtp++; if (this.o.echo) { s.send(b, r.port, r.address); this.stats.rtpOut++; } });
      s.bind(0, this.o.host, () => { s.removeAllListeners('error'); s.on('error', () => {}); resolve({ s, port: s.address().port }); });
    });
  }

  stop() {
    clearInterval(this.gc); clearInterval(this.qt); clearInterval(this.statT);
    for (const c of this.calls.values()) { clearTimeout(c.t1); clearTimeout(c.t2); clearTimeout(c.t3); clearTimeout(c.byeT); }
    this.calls.clear();
    try { this.udp && this.udp.close(); } catch {} try { this.srv && this.srv.close(); } catch {}
    for (const c of this.tcpConns) try { c.destroy(); } catch {}
    for (const r of this.rtp || []) try { r.s.close(); } catch {}
  }

  _stats() {
    const s = this.sec; this.sec = { inv: 0, ans: 0, rej: 0, rtp: 0 };
    const active = this.active; if (active > this.stats.maxActive) this.stats.maxActive = active;
    this.emit('stats', { ...this.stats, active, invPs: s.inv, ansPs: s.ans, rejPs: s.rej, rtpPps: s.rtp, queue: this.queue.length, conns: this.tcpConns.size });
  }

  // Address written into Contact/SDP: the configured IP, the bind address, or the local address that routes to the PBX
  _ip(dest) {
    if (this.o.ip) return this.o.ip;
    if (this.o.host !== '0.0.0.0') return this.o.host;
    const k = dest.addr; if (this.ips.has(k)) return this.ips.get(k);
    const pr = localIpFor(k).then(ip => { this.ips.set(k, ip); return ip; });
    this.ips.set(k, pr); return pr;
  }

  _resp(m, status, reason, extra = '', body = '') {
    let to = hdr(m, 'to');
    if (status > 100 && !tagOf(to)) to += ';tag=' + (m.tag || (m.tag = uid()));
    let s = `SIP/2.0 ${status} ${reason || REASONS[status] || ''}\r\n` + (m.headers.via || []).map(v => `Via: ${v}\r\n`).join('') +
      (m.headers['record-route'] || []).map(v => `Record-Route: ${v}\r\n`).join('') +
      `From: ${hdr(m, 'from')}\r\nTo: ${to}\r\nCall-ID: ${m.callId}\r\nCSeq: ${hdr(m, 'cseq')}\r\n${extra}Server: SIP Tester vendor\r\n`;
    s += body ? `Content-Type: application/sdp\r\nContent-Length: ${body.length}\r\n\r\n${body}` : 'Content-Length: 0\r\n\r\n';
    return s;
  }

  _authOk(m, method) {
    const o = this.o; if (!o.password && !o.passwordIsUser) return true;
    const h = hdr(m, 'authorization') || hdr(m, 'proxy-authorization');
    if (h) {
      const get = k => { const r = new RegExp('\\b' + k + '="?([^",]+)"?', 'i').exec(h); return r && r[1]; };
      const user = get('username'), pw = o.passwordIsUser ? user : o.password;
      if (!o.user || o.passwordIsUser || user === o.user) {
        const alg = /sha-?256/i.test(get('algorithm') || '') ? 'sha256' : 'md5';
        const H = s => crypto.createHash(alg).update(s).digest('hex');
        const ha1 = H(`${user}:${get('realm') || o.realm}:${pw}`), ha2 = H(`${method}:${get('uri')}`);
        const exp = get('qop') ? H(`${ha1}:${get('nonce')}:${(/\bnc=([0-9a-f]+)/i.exec(h) || [])[1]}:${get('cnonce')}:auth:${ha2}`) : H(`${ha1}:${get('nonce')}:${ha2}`);
        if (exp === get('response') && get('nonce') === this.nonce) return true;
      }
    }
    this.stats.challenges++;
    return false;
  }
  _challenge(m, code) {
    return this._resp(m, code, null, `${code === 401 ? 'WWW-Authenticate' : 'Proxy-Authenticate'}: Digest realm="${this.o.realm}", nonce="${this.nonce}", algorithm=MD5, qop="auth"\r\n`);
  }

  _recv(text, dest) {
    if (text.length < 20) return; // keep-alive
    const m = parse(text); if (!m) return;
    if (!m.isReq) { if (m.cseqMethod === 'BYE') return; return; } // responses to our BYE
    const ip = this._ip(dest);
    if (ip && typeof ip.then === 'function') return ip.then(a => this._handle(m, dest, a));
    this._handle(m, dest, ip);
  }

  _handle(m, dest, ip) {
    const o = this.o;
    const br = param(hdr(m, 'via'), 'branch');
    if (m.method === 'ACK') {
      this.stats.acks++;
      const c = this.calls.get(m.callId);
      if (c) { clearTimeout(c.t3); if (o.hangupAfterMs && c.answered && !c.byeT) c.byeT = setTimeout(() => this._bye(c), o.hangupAfterMs); }
      return;
    }
    const key = (br || m.callId + m.cseq) + m.method;
    const prev = this.seen.get(key);
    if (prev) { this.stats.retransIn++; if (prev.last) dest.send(prev.last); return; }
    const entry = { at: Date.now(), last: null }; this.seen.set(key, entry);
    const send = t => { entry.last = t; dest.send(t); };

    if (m.method === 'OPTIONS') { this.stats.options++; return send(this._resp(m, 200, 'OK', 'Allow: INVITE, ACK, CANCEL, BYE, OPTIONS, UPDATE\r\n')); }
    if (m.method === 'BYE') {
      this.stats.byes++; const c = this.calls.get(m.callId);
      if (c) { clearTimeout(c.byeT); clearTimeout(c.t3); this.calls.delete(m.callId); }
      return send(this._resp(m, c ? 200 : 481));
    }
    if (m.method === 'CANCEL') {
      this.stats.cancels++; send(this._resp(m, 200));
      const c = this.calls.get(m.callId);
      if (c && !c.answered) { clearTimeout(c.t1); clearTimeout(c.t2); this.calls.delete(m.callId); c.dest.send(this._resp(c.m, 487)); }
      return;
    }
    if (m.method === 'REGISTER') {
      this.stats.registers++;
      const work = () => {
        if (!this._authOk(m, 'REGISTER')) return send(this._challenge(m, 401));
        this.stats.registered++;
        send(this._resp(m, 200, 'OK', `Contact: ${hdr(m, 'contact')};expires=${hdr(m, 'expires') || 3600}\r\n`));
      };
      return o.capacity ? this.queue.push(work) : work();
    }
    if (m.method === 'INVITE') {
      if (tagOf(hdr(m, 'to'))) { // re-INVITE / session refresh inside a call
        const c = this.calls.get(m.callId);
        return send(this._resp(m, c ? 200 : 481, null, c ? `Contact: <sip:vendor@${ip}:${this.port}${dest.kind === 'tcp' ? ';transport=tcp' : ''}>\r\n` : '', c && c.sdp ? c.sdp : ''));
      }
      this.stats.invites++; this.sec.inv++;
      if (o.dropPct && Math.random() * 100 < o.dropPct) { this.stats.dropped++; this.seen.delete(key); return; }
      if (o.authInvite && !this._authOk(m, 'INVITE')) return send(this._challenge(m, 407));
      // Every authenticated new call is an arrival (end-to-end tracking). It is reported once the vendor has decided
      // what to do with it: code 0 = taken (rings / answers), otherwise the rejection code. The time is when it arrived.
      const user = userOf(m.uri) || userOf(uriOf(hdr(m, 'to'))), at = epoch();
      const arrive = code => this.emit('arrival', { user, at, callId: m.callId, code, trunk: o.trunk || 0 });
      const nowS = Date.now(); if (nowS - this.secAt >= 1000) { this.secAt = nowS; this.secCount = 0; }
      if (o.maxCps && ++this.secCount > o.maxCps) { this.stats.rejected503++; this.sec.rej++; arrive(503); return send(this._resp(m, 503, 'Service Unavailable', 'Retry-After: 1\r\n')); }
      send(this._resp(m, 100, 'Trying'));
      const work = () => {
        if (o.maxChannels && this.calls.size >= o.maxChannels) { this.stats.full++; this.sec.rej++; arrive(503); return send(this._resp(m, 503, 'Service Unavailable', 'Reason: Q.850;cause=34;text="No circuit/channel available"\r\n')); }
        if (o.busyPct && Math.random() * 100 < o.busyPct) { this.stats.busy++; this.sec.rej++; arrive(486); return send(this._resp(m, 486)); }
        if (o.failPct && Math.random() * 100 < o.failPct) { this.stats.failed++; this.sec.rej++; arrive(o.failCode); return send(this._resp(m, o.failCode)); }
        arrive(0);
        const r = this.rtp[(this.rr = ((this.rr || 0) + 1) % this.rtp.length)];
        const c = { m, dest, answered: false };
        this.calls.set(m.callId, c);
        const tag = uid(); m.tag = tag;
        const contact = `Contact: <sip:vendor@${ip}:${this.port}${dest.kind === 'tcp' ? ';transport=tcp' : ''}>\r\n`;
        const ring = () => { if (this.calls.get(m.callId) === c) dest.send(this._resp(m, 180, 'Ringing', contact)); };
        const answer = () => {
          if (this.calls.get(m.callId) !== c) return;
          c.answered = true; this.stats.answered++; this.sec.ans++;
          const offer = parseSdp(m.body);
          c.sdp = makeSdp({ ip, port: r.port, id: 1, codec: offer && offer.pt === 8 ? 'PCMA' : 'PCMU' });
          const t200 = this._resp(m, 200, 'OK', contact + 'Allow: INVITE, ACK, CANCEL, BYE, OPTIONS, UPDATE\r\n', c.sdp); entry.last = t200;
          c.from = hdr(m, 'from'); c.to = `${hdr(m, 'to')};tag=${tag}`; c.target = uriOf(hdr(m, 'contact')) || `sip:${dest.addr}:${dest.port}`;
          c.routes = (m.headers['record-route'] || []).slice();
          dest.send(t200);
          if (dest.kind === 'udp') { let d = 500; const rt = () => { c.t3 = setTimeout(() => { if (this.calls.get(m.callId) === c && d < 32000) { dest.send(t200); d *= 2; rt(); } }, d); }; rt(); }
          else if (o.hangupAfterMs) c.byeT = setTimeout(() => this._bye(c), o.hangupAfterMs);
        };
        if (o.ringMs || o.answerMs) c.t1 = setTimeout(ring, Math.min(o.ringMs || o.answerMs, o.answerMs || o.ringMs)); else ring();
        if (o.answerMs) c.t2 = setTimeout(answer, o.answerMs); else answer();
      };
      return o.capacity ? this.queue.push(work) : work();
    }
    send(this._resp(m, 200, 'OK')); // UPDATE, INFO, NOTIFY, MESSAGE …
  }

  // Vendor-side hang-up: BYE goes back over the same connection / to the address the INVITE came from
  _bye(c) {
    if (!this.calls.has(c.m.callId)) return;
    this.calls.delete(c.m.callId); this.stats.byesSent++;
    const m = c.m;
    const routes = c.routes && c.routes.length ? c.routes.map(r => `Route: ${r}\r\n`).join('') : '';
    const s = `BYE ${c.target} SIP/2.0\r\nVia: SIP/2.0/${c.dest.kind.toUpperCase()} ${this.o.ip || (this.o.host === '0.0.0.0' ? (this.ips.get(c.dest.addr) || '127.0.0.1') : this.o.host)}:${this.port};branch=z9hG4bK${uid()};rport\r\nMax-Forwards: 70\r\n${routes}` +
      `From: ${c.to}\r\nTo: ${c.from}\r\nCall-ID: ${m.callId}\r\nCSeq: 1 BYE\r\nContent-Length: 0\r\n\r\n`;
    c.dest.send(s);
  }
}

module.exports = { MockVendor };
