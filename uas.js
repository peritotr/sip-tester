// Minimal SIP server (UAS) used by the test suite and the benchmark: answers calls, registrations and OPTIONS,
// echoes RTP back, and can misbehave on purpose (503 above a rate, a slow processing queue, busy answers,
// dropped requests, hanging up calls early).
//
// opts: { port, host='127.0.0.1', tcp=false, auth: { realm, password | passwordIsUser } , authInvite=false,
//         ringMs=0, answerMs=0, maxCps=0 (503 above), capacity=0 (INVITE/REGISTER processed per second; the rest queue up),
//         busyPct=0 (486), dropPct=0 (no response), hangupAfterMs=0 (UAS sends BYE), echo=true }
const EventEmitter = require('events');
const dgram = require('dgram');
const net = require('net');
const crypto = require('crypto');
const { parse, hdr, param, uriOf, tagOf, Framer, parseSdp, makeSdp, uid } = require('./sip-core');

class TestUas extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.o = { host: '127.0.0.1', echo: true, ...opts };
    this.addr = this.o.host === '0.0.0.0' ? '127.0.0.1' : this.o.host; // address written into Contact/SDP
    this.stats = { invites: 0, answered: 0, rejected503: 0, busy: 0, dropped: 0, registers: 0, registered: 0, challenges: 0, options: 0, byes: 0, acks: 0, cancels: 0, rtpIn: 0, rtpOut: 0, retransIn: 0 };
    this.seen = new Map(); this.calls = new Map(); this.queue = []; this.secCount = 0; this.secAt = Date.now();
    this.nonce = crypto.randomBytes(8).toString('hex');
  }

  start() {
    return new Promise((resolve, reject) => {
      const o = this.o;
      if (o.tcp) {
        this.srv = net.createServer(c => {
          const f = new Framer(); c.setNoDelay(true);
          const dest = { send: t => c.write(t, 'latin1'), kind: 'tcp' };
          c.on('data', d => { for (const m of f.push(d)) this._recv(m, dest); });
          c.on('error', () => {});
        });
        this.srv.on('error', reject);
        this.srv.listen(o.port || 0, o.host, () => { this.port = this.srv.address().port; this._timers(); resolve(this); });
      } else {
        this.sock = dgram.createSocket({ type: 'udp4', recvBufferSize: 8 << 20 });
        this.sock.on('error', reject);
        this.sock.on('message', (b, r) => this._recv(b.toString('latin1'), { send: t => this.sock.send(Buffer.from(t, 'latin1'), r.port, r.address), kind: 'udp' }));
        this.sock.bind(o.port || 0, o.host, () => { this.port = this.sock.address().port; this._timers(); resolve(this); });
      }
    });
  }

  async _rtpSock() {
    if (this.rtp) return this.rtp;
    const s = dgram.createSocket({ type: 'udp4', recvBufferSize: 8 << 20, sendBufferSize: 8 << 20 });
    await new Promise(r => s.bind(0, this.o.host, r));
    // Echo: send every packet back to where it came from
    s.on('message', (b, r) => { this.stats.rtpIn++; if (this.o.echo) { s.send(b, r.port, r.address); this.stats.rtpOut++; } });
    this.rtp = { s, port: s.address().port };
    return this.rtp;
  }

  _timers() {
    this.gc = setInterval(() => { const lim = Date.now() - 32000; for (const [k, v] of this.seen) { if (v.at > lim) break; this.seen.delete(k); } }, 1000);
    // Processing queue: at most `capacity` requests per second, in 10 ms slices
    if (this.o.capacity) {
      let budget = 0, last = Date.now();
      this.qt = setInterval(() => {
        const t = Date.now(); budget = Math.min(budget + this.o.capacity * (t - last) / 1000, Math.max(1, this.o.capacity / 10)); last = t;
        while (budget >= 1 && this.queue.length) { budget--; this.queue.shift()(); }
        if (!this.queue.length) budget = Math.min(budget, 1);
      }, 10);
    }
  }

  stop() {
    clearInterval(this.gc); clearInterval(this.qt);
    for (const c of this.calls.values()) { clearTimeout(c.t1); clearTimeout(c.t2); clearTimeout(c.t3); }
    try { this.sock && this.sock.close(); } catch {} try { this.srv && this.srv.close(); } catch {} try { this.rtp && this.rtp.s.close(); } catch {}
  }

  _resp(m, status, reason, extra = '', body = '') {
    let to = hdr(m, 'to');
    if (status > 100 && !tagOf(to)) to += ';tag=' + (m.tag || (m.tag = uid()));
    let s = `SIP/2.0 ${status} ${reason}\r\n` + (m.headers.via || []).map(v => `Via: ${v}\r\n`).join('') +
      `From: ${hdr(m, 'from')}\r\nTo: ${to}\r\nCall-ID: ${m.callId}\r\nCSeq: ${hdr(m, 'cseq')}\r\n${extra}`;
    s += body ? `Content-Type: application/sdp\r\nContent-Length: ${body.length}\r\n\r\n${body}` : 'Content-Length: 0\r\n\r\n';
    return s;
  }

  _auth(m, method) {
    const a = this.o.auth; if (!a) return true;
    const h = hdr(m, 'authorization') || hdr(m, 'proxy-authorization');
    if (h) {
      const get = k => { const r = new RegExp('\\b' + k + '="?([^",]+)"?', 'i').exec(h); return r && r[1]; };
      const user = get('username'), pw = a.passwordIsUser ? user : a.password;
      const H = s => crypto.createHash('md5').update(s).digest('hex');
      const ha1 = H(`${user}:${a.realm}:${pw}`), ha2 = H(`${method}:${get('uri')}`);
      const exp = get('qop') ? H(`${ha1}:${get('nonce')}:${(/\bnc=([0-9a-f]+)/i.exec(h) || [])[1]}:${get('cnonce')}:auth:${ha2}`) : H(`${ha1}:${get('nonce')}:${ha2}`);
      if (exp === get('response') && get('nonce') === this.nonce) return true;
    }
    this.stats.challenges++;
    return false;
  }

  _recv(text, dest) {
    if (text.length < 20) return;
    const m = parse(text); if (!m || !m.isReq) return;
    const br = param(hdr(m, 'via'), 'branch');
    if (m.method === 'ACK') {
      this.stats.acks++;
      const c = this.calls.get(m.callId); if (c) { clearTimeout(c.t3); if (this.o.hangupAfterMs && !c.byeT) c.byeT = setTimeout(() => this._bye(c), this.o.hangupAfterMs); }
      return;
    }
    const key = br + m.method;
    const prev = this.seen.get(key);
    if (prev) { this.stats.retransIn++; if (prev.last) dest.send(prev.last); return; }
    const entry = { at: Date.now(), last: null }; this.seen.set(key, entry);
    const send = t => { entry.last = t; dest.send(t); };
    const o = this.o;

    if (m.method === 'OPTIONS') { this.stats.options++; return send(this._resp(m, 200, 'OK')); }
    if (m.method === 'BYE') { this.stats.byes++; const c = this.calls.get(m.callId); if (c) { clearTimeout(c.byeT); this.calls.delete(m.callId); } return send(this._resp(m, c ? 200 : 481, c ? 'OK' : 'Call/Transaction Does Not Exist')); }
    if (m.method === 'CANCEL') {
      this.stats.cancels++; send(this._resp(m, 200, 'OK'));
      const c = this.calls.get(m.callId);
      if (c && !c.answered) { clearTimeout(c.t1); clearTimeout(c.t2); this.calls.delete(m.callId); c.dest.send(this._resp(c.m, 487, 'Request Terminated')); }
      return;
    }
    if (m.method === 'REGISTER') {
      this.stats.registers++;
      const work = () => {
        if (!this._auth(m, 'REGISTER')) return send(this._resp(m, 401, 'Unauthorized', `WWW-Authenticate: Digest realm="${o.auth.realm}", nonce="${this.nonce}", algorithm=MD5, qop="auth"\r\n`));
        this.stats.registered++;
        send(this._resp(m, 200, 'OK', `Contact: ${hdr(m, 'contact')};expires=${hdr(m, 'expires') || 3600}\r\n`));
      };
      return o.capacity ? this.queue.push(work) : work();
    }
    if (m.method === 'INVITE') {
      if (tagOf(hdr(m, 'to'))) return send(this._resp(m, 200, 'OK', `Contact: <sip:uas@${this.addr}:${this.port}>\r\n`, m.body || '')); // re-INVITE
      this.stats.invites++;
      if (o.dropPct && Math.random() * 100 < o.dropPct) { this.stats.dropped++; this.seen.delete(key); return; }
      // Rate limit: 503 above maxCps (per wall-clock second)
      const nowS = Date.now(); if (nowS - this.secAt >= 1000) { this.secAt = nowS; this.secCount = 0; }
      if (o.maxCps && ++this.secCount > o.maxCps) { this.stats.rejected503++; return send(this._resp(m, 503, 'Service Unavailable', 'Retry-After: 1\r\n')); }
      if (o.authInvite && !this._auth(m, 'INVITE')) return send(this._resp(m, 407, 'Proxy Authentication Required', `Proxy-Authenticate: Digest realm="${o.auth.realm}", nonce="${this.nonce}", algorithm=MD5, qop="auth"\r\n`));
      send(this._resp(m, 100, 'Trying'));
      const work = async () => {
        if (o.busyPct && Math.random() * 100 < o.busyPct) { this.stats.busy++; return send(this._resp(m, 486, 'Busy Here')); }
        const r = await this._rtpSock();
        const c = { m, dest, answered: false };
        this.calls.set(m.callId, c);
        const tag = uid(); m.tag = tag;
        const contact = `Contact: <sip:uas@${this.addr}:${this.port}${dest.kind === 'tcp' ? ';transport=tcp' : ''}>\r\n`;
        const ring = () => { if (this.calls.get(m.callId) === c) dest.send(this._resp(m, 180, 'Ringing', contact)); };
        const answer = () => {
          if (this.calls.get(m.callId) !== c) return;
          c.answered = true; this.stats.answered++;
          const offer = parseSdp(m.body);
          const body = makeSdp({ ip: this.addr, port: r.port, id: 1, codec: offer && offer.pt === 8 ? 'PCMA' : 'PCMU' });
          const t200 = this._resp(m, 200, 'OK', contact, body); entry.last = t200;
          c.from = hdr(m, 'from'); c.to = `${hdr(m, 'to')};tag=${tag}`; c.target = uriOf(hdr(m, 'contact'));
          dest.send(t200);
          // Retransmit 200 OK until ACK (UDP)
          if (dest.kind === 'udp') { let d = 500; const rt = () => { c.t3 = setTimeout(() => { if (this.calls.get(m.callId) === c && d < 32000) { dest.send(t200); d *= 2; rt(); } }, d); }; rt(); }
        };
        if (o.ringMs) { c.t1 = setTimeout(ring, Math.min(o.ringMs, o.answerMs || o.ringMs)); } else ring();
        if (o.answerMs) c.t2 = setTimeout(answer, o.answerMs); else answer();
      };
      return o.capacity ? this.queue.push(work) : work();
    }
    send(this._resp(m, 200, 'OK'));
  }

  // UAS-initiated hang-up
  _bye(c) {
    if (!this.calls.has(c.m.callId)) return;
    this.calls.delete(c.m.callId);
    const m = c.m;
    const s = `BYE ${c.target} SIP/2.0\r\nVia: SIP/2.0/${c.dest.kind.toUpperCase()} ${this.addr}:${this.port};branch=z9hG4bK${uid()}\r\nMax-Forwards: 70\r\n` +
      `From: ${c.to}\r\nTo: ${c.from}\r\nCall-ID: ${m.callId}\r\nCSeq: 1 BYE\r\nContent-Length: 0\r\n\r\n`;
    c.dest.send(s);
  }
}

module.exports = { TestUas };

// Stand-alone: node uas.js [port] [maxCps] — handy for trying the tool without a PBX
if (require.main === module) {
  const port = Number(process.argv[2]) || 5070;
  new TestUas({ port, host: '0.0.0.0', maxCps: Number(process.argv[3]) || 0, auth: process.env.UAS_PASSWORD ? { realm: 'sip-tester', password: process.env.UAS_PASSWORD } : null })
    .start().then(u => console.log(`Test UAS listening on udp/${u.port}`));
}
