// SIP core: message parsing and building, digest authentication, SDP, and a small user agent
// (transports + client transactions with RFC 3261 retransmission timers). Shared by the
// interactive client (sip-client.js) and the load engine (load-engine.js).
//
// Scope: what a load tester needs as a UAC — INVITE/ACK/BYE/CANCEL, REGISTER, OPTIONS — over UDP or TCP.
const EventEmitter = require('events');
const dgram = require('dgram');
const net = require('net');
const dns = require('dns');
const crypto = require('crypto');

const fill = (s, p) => p ? s.replace(/\{(\w+)\}/g, (m, k) => p[k] !== undefined ? p[k] : m) : s;
const err = (key, p) => Object.assign(new Error(fill(key, p)), { key, p });

// ---------- Parsing ----------
const COMPACT = { v: 'via', f: 'from', t: 'to', i: 'call-id', m: 'contact', l: 'content-length', c: 'content-type', k: 'supported', e: 'content-encoding', s: 'subject', o: 'event', r: 'refer-to', u: 'allow-events', x: 'session-expires' };

// Parses one SIP message (string). Headers are stored lower-case; each maps to an array of raw values.
function parse(str) {
  const he = str.indexOf('\r\n\r\n');
  const head = he < 0 ? str : str.slice(0, he);
  const body = he < 0 ? '' : str.slice(he + 4);
  const lines = head.split('\r\n');
  const first = lines[0];
  const m = { headers: Object.create(null), body };
  if (first.startsWith('SIP/2.0 ')) {
    m.isReq = false; m.status = parseInt(first.slice(8, 11), 10); m.reason = first.slice(12);
    if (!(m.status >= 100 && m.status < 700)) return null;
  } else {
    const a = first.indexOf(' '), b = first.lastIndexOf(' ');
    if (a < 1 || b <= a || first.slice(b + 1) !== 'SIP/2.0') return null;
    m.isReq = true; m.method = first.slice(0, a); m.uri = first.slice(a + 1, b);
  }
  let last = null;
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    if ((l[0] === ' ' || l[0] === '\t') && last) { last.arr[last.arr.length - 1] += ' ' + l.trim(); continue; }
    const c = l.indexOf(':'); if (c < 1) continue;
    let name = l.slice(0, c).trim().toLowerCase();
    if (name.length === 1 && COMPACT[name]) name = COMPACT[name];
    const v = l.slice(c + 1).trim();
    const arr = m.headers[name] || (m.headers[name] = []);
    arr.push(v); last = { arr };
  }
  m.callId = hdr(m, 'call-id');
  const cs = hdr(m, 'cseq');
  if (cs) { const sp = cs.indexOf(' '); m.cseq = parseInt(cs, 10); m.cseqMethod = cs.slice(sp + 1).trim(); }
  return m;
}
const hdr = (m, name) => { const a = m.headers[name]; return a ? a[0] : undefined; };
const hdrAll = (m, name) => { const a = m.headers[name]; if (!a) return []; const out = []; for (const v of a) out.push(...splitList(v)); return out; };

// Splits a comma-separated header value, ignoring commas inside quotes and <…>
function splitList(v) {
  const out = []; let depth = 0, q = false, start = 0;
  for (let i = 0; i < v.length; i++) {
    const ch = v[i];
    if (ch === '"' && v[i - 1] !== '\\') q = !q;
    else if (!q && ch === '<') depth++;
    else if (!q && ch === '>') depth--;
    else if (!q && depth === 0 && ch === ',') { out.push(v.slice(start, i).trim()); start = i + 1; }
  }
  const last = v.slice(start).trim(); if (last) out.push(last);
  return out;
}
// ;name=value parameter of a header value (outside <…>)
function param(v, name) {
  if (!v) return undefined;
  const gt = v.lastIndexOf('>');
  const tail = gt >= 0 ? v.slice(gt) : v;
  const re = new RegExp(';\\s*' + name + '(?:=("[^"]*"|[^;,\\s]*))?', 'i');
  const r = re.exec(tail); if (!r) return undefined;
  return r[1] === undefined ? '' : r[1].replace(/^"|"$/g, '');
}
// URI inside a name-addr (<sip:…>) or an addr-spec
function uriOf(v) {
  if (!v) return undefined;
  const a = v.indexOf('<');
  if (a >= 0) return v.slice(a + 1, v.indexOf('>', a));
  const s = v.indexOf(';'); return (s >= 0 ? v.slice(0, s) : v).trim();
}
const tagOf = v => param(v, 'tag');
const userOf = uri => { const r = /^sips?:([^@;>]+)@/i.exec(uri || ''); return r ? decodeURIComponent(r[1]) : ''; };

// ---------- Stream framing (TCP) ----------
// Collects bytes and returns complete messages using Content-Length. Skips CRLF keep-alives.
class Framer {
  constructor() { this.buf = ''; }
  push(chunk) {
    this.buf += chunk.toString('latin1');
    const out = [];
    for (;;) {
      while (this.buf.startsWith('\r\n')) this.buf = this.buf.slice(2);
      const he = this.buf.indexOf('\r\n\r\n'); if (he < 0) break;
      const head = this.buf.slice(0, he);
      const r = /(?:^|\r\n)(?:content-length|l)[ \t]*:[ \t]*(\d+)/i.exec(head);
      const len = r ? parseInt(r[1], 10) : 0;
      if (this.buf.length < he + 4 + len) break;
      out.push(this.buf.slice(0, he + 4 + len));
      this.buf = this.buf.slice(he + 4 + len);
    }
    if (this.buf.length > 1 << 20) this.buf = ''; // garbage protection
    return out;
  }
}

// ---------- Digest authentication (RFC 2617 / 7616) ----------
function parseChallenge(v) {
  if (!v) return null;
  const sp = v.indexOf(' ');
  const scheme = (sp > 0 ? v.slice(0, sp) : v).trim();
  if (!/^digest$/i.test(scheme)) return null;
  const ch = { scheme: 'Digest' };
  const re = /([a-zA-Z0-9_-]+)\s*=\s*("([^"]*)"|[^,\s]+)/g; let r;
  while ((r = re.exec(v.slice(sp + 1)))) ch[r[1].toLowerCase()] = r[3] !== undefined ? r[3] : r[2];
  ch.algorithm = ch.algorithm || 'MD5';
  if (ch.qop) { const q = ch.qop.split(',').map(s => s.trim().toLowerCase()); ch.qop = q.includes('auth') ? 'auth' : q[0]; }
  ch.stale = String(ch.stale || '').toLowerCase() === 'true';
  ch.nc = 0;
  return ch;
}
const H = (alg, s) => crypto.createHash(/sha-?256/i.test(alg) ? 'sha256' : 'md5').update(s).digest('hex');
// Builds the Authorization / Proxy-Authorization value. ch.nc is advanced (nonce reuse).
function digest(ch, { user, password, method, uri }) {
  const alg = ch.algorithm || 'MD5';
  const cnonce = crypto.randomBytes(8).toString('hex');
  const nc = (++ch.nc).toString(16).padStart(8, '0');
  let ha1 = H(alg, `${user}:${ch.realm || ''}:${password}`);
  if (/-sess$/i.test(alg)) ha1 = H(alg, `${ha1}:${ch.nonce}:${cnonce}`);
  const ha2 = H(alg, `${method}:${uri}`);
  const resp = ch.qop ? H(alg, `${ha1}:${ch.nonce}:${nc}:${cnonce}:${ch.qop}:${ha2}`) : H(alg, `${ha1}:${ch.nonce}:${ha2}`);
  let s = `Digest username="${user}", realm="${ch.realm || ''}", nonce="${ch.nonce}", uri="${uri}", response="${resp}", algorithm=${alg}`;
  if (ch.qop) s += `, qop=${ch.qop}, nc=${nc}, cnonce="${cnonce}"`;
  if (ch.opaque !== undefined) s += `, opaque="${ch.opaque}"`;
  return s;
}

// ---------- SDP ----------
const CODECS = { PCMU: { pt: 0, name: 'PCMU/8000', silence: 0xff }, PCMA: { pt: 8, name: 'PCMA/8000', silence: 0xd5 } };
function makeSdp({ ip, port, id, codec }) {
  const first = CODECS[codec] ? codec : 'PCMU', second = first === 'PCMU' ? 'PCMA' : 'PCMU';
  const a = CODECS[first], b = CODECS[second];
  return `v=0\r\no=- ${id} ${id} IN IP4 ${ip}\r\ns=sip-tester\r\nc=IN IP4 ${ip}\r\nt=0 0\r\n` +
    `m=audio ${port} RTP/AVP ${a.pt} ${b.pt} 101\r\na=rtpmap:${a.pt} ${a.name}\r\na=rtpmap:${b.pt} ${b.name}\r\n` +
    `a=rtpmap:101 telephone-event/8000\r\na=fmtp:101 0-16\r\na=ptime:20\r\na=sendrecv\r\n`;
}
function parseSdp(body) {
  if (!body || body.indexOf('m=audio') < 0) return null;
  const out = { ip: null, port: 0, pts: [] };
  let mediaC = null;
  for (const l of body.split(/\r?\n/)) {
    if (l.startsWith('c=')) { const ip = l.split(' ')[2]; if (out.port) mediaC = ip; else out.ip = ip; }
    else if (l.startsWith('m=audio')) { const p = l.split(' '); out.port = parseInt(p[1], 10); out.pts = p.slice(3).map(Number); }
  }
  if (mediaC) out.ip = mediaC;
  out.pt = out.pts.find(p => p === 0 || p === 8);
  return out;
}

// ---------- Helpers ----------
const rand = n => crypto.randomBytes(n).toString('hex');
let ctr = 0;
const uid = () => (++ctr).toString(36) + rand(4);

function localIpFor(host) {
  return new Promise(resolve => {
    if (/^127\./.test(host) || host === 'localhost') return resolve('127.0.0.1');
    const s = dgram.createSocket('udp4');
    s.on('error', () => { try { s.close(); } catch {} resolve('127.0.0.1'); });
    s.connect(9, host, () => { let a = '127.0.0.1'; try { a = s.address().address; } catch {} s.close(); resolve(a); });
  });
}
function resolveHost(host) {
  return new Promise((resolve, reject) => {
    if (net.isIP(host)) return resolve(host);
    dns.lookup(host, { family: 4 }, (e, a) => e ? reject(err('Could not resolve {host}: {msg}', { host, msg: e.code || e.message })) : resolve(a));
  });
}

// ---------- User agent ----------
// cfg: host, port, transport ('udp'|'tcp'), localPort, connections, domain, user, authUser, password,
//      displayName, contactIp, t1 (ms), timeout (ms, transaction timeout = Timer B/F)
class SipUA extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.transport = cfg.transport === 'tcp' ? 'tcp' : 'udp';
    this.T1 = Math.max(50, Number(cfg.t1) || 500);
    this.T2 = 4000;
    this.timeout = Math.max(1000, Number(cfg.timeout) || 64 * this.T1);
    this.txns = new Map();     // client transactions by branch(+method)
    this.served = new Map();   // server-side responses kept for retransmitted requests (UDP)
    this.socks = [];
    this.retrans = 0;          // retransmissions sent (counter)
    this.trace = null;         // optional fn(dir, text, sock) for message logs
    this.closed = false;
  }

  get domain() {
    const c = this.cfg; if (c.domain) return String(c.domain).trim();
    const p = Number(c.port) || 5060; return p === 5060 ? this.host : `${this.host}:${p}`;
  }

  async open() {
    const c = this.cfg;
    this.host = String(c.host || '').trim();
    if (!this.host) throw err('Host is empty');
    this.port = Number(c.port) || 5060;
    this.ip = await resolveHost(this.host);
    this.localIp = String(c.contactIp || '').trim() || await localIpFor(this.ip);
    const n = Math.max(1, Math.min(64, Number(c.connections) || 1));
    const basePort = Number(c.localPort) || 0;
    for (let i = 0; i < n; i++) this.socks.push(await (this.transport === 'tcp' ? this._openTcp(i) : this._openUdp(i, basePort ? basePort + i : 0)));
    this.gc = setInterval(() => this._gc(), 1000);
    return this;
  }

  _openUdp(i, port) {
    return new Promise((resolve, reject) => {
      const s = dgram.createSocket({ type: 'udp4', recvBufferSize: 8 << 20, sendBufferSize: 8 << 20 });
      const sock = { i, s, kind: 'udp', up: true, port: 0 };
      s.on('error', e => { if (!sock.port) reject(err(e.code === 'EADDRINUSE' ? 'Local port {port} is already in use' : 'Socket error: {msg}', { port, msg: e.message })); else this.emit('log', { key: 'Socket error: {msg}', p: { msg: e.message } }); });
      s.on('message', (b, r) => this._recv(b.toString('latin1'), sock, r));
      s.bind(port, () => {
        sock.port = s.address().port;
        try { s.setRecvBufferSize(8 << 20); s.setSendBufferSize(8 << 20); } catch {}
        resolve(sock);
      });
    });
  }

  _openTcp(i) {
    return new Promise((resolve, reject) => {
      const s = net.connect({ host: this.ip, port: this.port });
      const sock = { i, s, kind: 'tcp', up: false, port: 0, framer: new Framer() };
      const timer = setTimeout(() => { s.destroy(); reject(err('Connection {n}: connect timed out', { n: i + 1 })); }, 10000);
      s.setNoDelay(true);
      s.on('connect', () => { clearTimeout(timer); sock.up = true; sock.port = s.localPort; resolve(sock); });
      s.on('data', d => { for (const m of sock.framer.push(d)) this._recv(m, sock); });
      s.on('error', e => { clearTimeout(timer); if (!sock.up) reject(err('Connection {n}: {msg}', { n: i + 1, msg: e.code || e.message })); });
      s.on('close', () => { const was = sock.up; sock.up = false; if (was && !this.closed) this.emit('connClosed', sock); });
    });
  }

  close() {
    this.closed = true;
    clearInterval(this.gc);
    for (const t of this.txns.values()) { clearTimeout(t.rt); clearTimeout(t.to); clearTimeout(t.kill); }
    this.txns.clear();
    for (const k of this.socks) { try { k.kind === 'udp' ? k.s.close() : k.s.destroy(); } catch {} }
    this.socks = [];
  }

  sock(i) { return this.socks[(i || 0) % this.socks.length]; }
  upCount() { return this.socks.filter(s => s.up).length; }

  _write(sock, text) {
    if (this.trace) this.trace('out', text, sock);
    if (sock.kind === 'udp') { if (sock.up) sock.s.send(Buffer.from(text, 'latin1'), this.port, this.ip); }
    else if (sock.up) sock.s.write(text, 'latin1');
  }

  // Common request header block. o: method, uri, branch, from, to, callId, cseq, contact?, routes?, headers?, body?, ctype?
  via(sock, branch) {
    return `SIP/2.0/${this.transport.toUpperCase()} ${this.localIp}:${sock.port};branch=${branch};rport`;
  }
  contact(sock, user) {
    return `<sip:${user ? encodeURIComponent(user) + '@' : ''}${this.localIp}:${sock.port}${this.transport === 'tcp' ? ';transport=tcp' : ''}>`;
  }
  build(sock, o) {
    let s = `${o.method} ${o.uri} SIP/2.0\r\nVia: ${this.via(sock, o.branch)}\r\nMax-Forwards: 70\r\n`;
    if (o.routes) for (const r of o.routes) s += `Route: ${r}\r\n`;
    s += `From: ${o.from}\r\nTo: ${o.to}\r\nCall-ID: ${o.callId}\r\nCSeq: ${o.cseq} ${o.cseqMethod || o.method}\r\n`;
    if (o.contact) s += `Contact: ${o.contact}\r\n`;
    if (o.headers) s += o.headers;
    s += `User-Agent: SIP Tester\r\n`;
    if (o.body) s += `Content-Type: ${o.ctype || 'application/sdp'}\r\nContent-Length: ${Buffer.byteLength(o.body, 'latin1')}\r\n\r\n${o.body}`;
    else s += 'Content-Length: 0\r\n\r\n';
    return s;
  }

  // Client transaction: retransmits over UDP, times out after this.timeout.
  // h: { onResponse(res, txn), onTimeout(txn) }. Returns the transaction.
  request(sockIdx, o, h) {
    const sock = this.sock(sockIdx);
    o.branch = o.branch || 'z9hG4bK' + uid();
    const text = this.build(sock, o);
    const key = o.method === 'CANCEL' ? o.branch + ':C' : o.branch;
    const t = { key, branch: o.branch, method: o.method, o, sock, text, h, t0: performance.now(), state: 'trying', n: 0, rtx: 0, final: null };
    this.txns.set(key, t);
    this._write(sock, text);
    if (sock.kind === 'udp') this._arm(t, this.T1);
    t.to = setTimeout(() => this._timeout(t), this.timeout);
    return t;
  }
  _arm(t, d) {
    t.rt = setTimeout(() => {
      if (t.final || this.closed) return;
      if (t.method === 'INVITE' && t.state !== 'trying') return; // INVITE: retransmit only until a provisional arrives
      t.rtx++; this.retrans++; this._write(t.sock, t.text);
      this._arm(t, t.method === 'INVITE' ? d * 2 : (t.state === 'trying' ? Math.min(d * 2, this.T2) : this.T2));
    }, d);
  }
  _timeout(t) {
    if (t.final || !this.txns.has(t.key)) return;
    clearTimeout(t.rt); this.txns.delete(t.key);
    t.state = 'timeout';
    t.h && t.h.onTimeout && t.h.onTimeout(t);
  }
  // Removes a transaction without waiting for its response (e.g. a call that is being abandoned)
  forget(t) { if (!t) return; clearTimeout(t.rt); clearTimeout(t.to); clearTimeout(t.kill); this.txns.delete(t.key); }

  // ACK for a non-2xx final response: part of the INVITE transaction (same branch, To from the response)
  _ackNon2xx(t, res) {
    const o = t.o;
    const s = `ACK ${o.uri} SIP/2.0\r\nVia: ${this.via(t.sock, o.branch)}\r\nMax-Forwards: 70\r\n` + (o.routes ? o.routes.map(r => `Route: ${r}\r\n`).join('') : '') +
      `From: ${o.from}\r\nTo: ${hdr(res, 'to')}\r\nCall-ID: ${o.callId}\r\nCSeq: ${o.cseq} ACK\r\nContent-Length: 0\r\n\r\n`;
    this._write(t.sock, s);
  }

  // Sends a request outside any transaction (ACK for 2xx)
  sendRaw(sockIdx, o) { const sock = this.sock(sockIdx); o.branch = o.branch || 'z9hG4bK' + uid(); this._write(sock, this.build(sock, o)); }

  _recv(text, sock, rinfo) {
    if (text === '\r\n\r\n' || text === '\r\n') return; // keep-alive
    if (this.trace) this.trace('in', text, sock, rinfo);
    const m = parse(text); if (!m) return;
    m.sock = sock; m.rinfo = rinfo;
    if (m.isReq) return this._onRequest(m, sock, rinfo);
    const via = hdr(m, 'via'); const branch = param(via, 'branch');
    if (!branch) return;
    const t = this.txns.get(m.cseqMethod === 'CANCEL' ? branch + ':C' : branch);
    if (!t) { this.emit('strayResponse', m); return; }
    if (m.status < 200) {
      if (t.final) return;
      if (t.state === 'trying') {
        t.state = 'proceeding';
        if (t.method === 'INVITE') clearTimeout(t.to); // Timer B only runs until a provisional arrives; ring time is the caller's limit
        else if (t.sock.kind === 'udp') { clearTimeout(t.rt); this._arm(t, this.T2); }
      }
      t.h && t.h.onResponse && t.h.onResponse(m, t);
      return;
    }
    if (t.final) {
      // Retransmitted final response: re-ACK non-2xx; hand 2xx back to the dialog so it re-sends its ACK
      if (t.method === 'INVITE') { if (m.status >= 300) this._ackNon2xx(t, m); else t.h && t.h.onRetransmit2xx && t.h.onRetransmit2xx(m, t); }
      return;
    }
    t.final = m; t.state = 'completed';
    clearTimeout(t.rt); clearTimeout(t.to);
    if (t.method === 'INVITE') {
      if (m.status >= 300) this._ackNon2xx(t, m);
      // Keep INVITE transactions a while to absorb retransmitted final responses (Timer D / 2xx retransmits)
      t.kill = setTimeout(() => this.txns.delete(t.key), t.sock.kind === 'udp' ? 32000 : 4000);
    } else this.txns.delete(t.key);
    t.h && t.h.onResponse && t.h.onResponse(m, t);
  }

  _onRequest(m, sock, rinfo) {
    const branch = param(hdr(m, 'via'), 'branch');
    if (m.method === 'ACK') { this.emit('ack', m); return; }
    const key = (branch || m.callId + '/' + m.cseq) + ':' + m.method;
    const prev = this.served.get(key);
    if (prev) { if (prev.text) this._write(sock, prev.text); return; } // retransmitted request
    this.served.set(key, { at: Date.now(), text: null });
    m.respond = (status, reason, extra, body) => {
      const text = this.response(m, status, reason, extra, body);
      const e = this.served.get(key); if (e && status >= 200) e.text = text;
      this._write(sock, text);
    };
    // this.handler(m) returns true when it answered the request (in-dialog requests for a known call)
    if (this.handler && this.handler(m)) return;
    if (m.method === 'OPTIONS' || m.method === 'NOTIFY' || m.method === 'MESSAGE') m.respond(200, 'OK');
    else if (m.method === 'INVITE') m.respond(480, 'Temporarily Unavailable');
    else m.respond(481, 'Call/Transaction Does Not Exist');
  }

  // Builds a response to request m (To tag is added when missing)
  response(m, status, reason, extra, body) {
    let to = hdr(m, 'to') || '';
    if (status > 100 && !tagOf(to)) to += ';tag=' + (m.toTag || (m.toTag = uid()));
    let s = `SIP/2.0 ${status} ${reason}\r\n`;
    for (const v of m.headers.via || []) s += `Via: ${v}\r\n`;
    for (const v of m.headers['record-route'] || []) s += `Record-Route: ${v}\r\n`;
    s += `From: ${hdr(m, 'from')}\r\nTo: ${to}\r\nCall-ID: ${m.callId}\r\nCSeq: ${hdr(m, 'cseq')}\r\n`;
    if (extra) s += extra;
    s += 'User-Agent: SIP Tester\r\n';
    if (body) s += `Content-Type: application/sdp\r\nContent-Length: ${Buffer.byteLength(body, 'latin1')}\r\n\r\n${body}`;
    else s += 'Content-Length: 0\r\n\r\n';
    return s;
  }

  _gc() {
    const lim = Date.now() - 32000;
    for (const [k, v] of this.served) { if (v.at > lim) break; this.served.delete(k); }
  }

  // ---------- Higher-level helpers ----------
  // Sends a request and answers 401/407 challenges once (twice if the nonce was stale).
  // a: { user, password } for digest; cache: optional object to store/reuse the last challenge (nonce reuse).
  // done(res | null, info) — res null on timeout; info: { t0, challenges, rtx }
  authRequest(sockIdx, o, a, done, cache) {
    const info = { t0: performance.now(), challenges: 0, rtx: 0 };
    let cseq = o.cseq;
    const send = auth => {
      const req = { ...o, cseq, branch: undefined, headers: (o.headers || '') + (auth || '') };
      return this.request(sockIdx, req, {
        onResponse: (res, t) => {
          if (res.status < 200) { o.onProvisional && o.onProvisional(res, t); return; }
          info.rtx += t.rtx;
          if ((res.status === 401 || res.status === 407) && a && a.password != null && info.challenges < 2) {
            const ch = parseChallenge(hdr(res, res.status === 401 ? 'www-authenticate' : 'proxy-authenticate'));
            if (ch && (info.challenges === 0 || ch.stale)) {
              info.challenges++;
              if (cache) { cache.ch = ch; cache.status = res.status; }
              cseq++; o.cseqNow = cseq;
              info.txn = send(`${res.status === 401 ? 'Authorization' : 'Proxy-Authorization'}: ${digest(ch, { user: a.user, password: a.password, method: o.method, uri: o.uri })}\r\n`);
              return;
            }
          }
          o.cseqNow = cseq;
          done(res, info, t);
        },
        onTimeout: t => { info.rtx += t.rtx; o.cseqNow = cseq; done(null, info, t); },
        onRetransmit2xx: o.onRetransmit2xx,
      });
    };
    let pre = '';
    if (cache && cache.ch && a && a.password != null) pre = `${cache.status === 407 ? 'Proxy-Authorization' : 'Authorization'}: ${digest(cache.ch, { user: a.user, password: a.password, method: o.method, uri: o.uri })}\r\n`;
    info.txn = send(pre);
    return info;
  }
}

// ---------- Registration ----------
// r: { sockIdx, user, authUser, password, expires, callId?, cseq?, cache? } → done(res|null, info)
function register(ua, r, done) {
  const sock = ua.sock(r.sockIdx);
  const domain = ua.domain;
  const aor = `<sip:${encodeURIComponent(r.user)}@${domain}>`;
  const o = {
    method: 'REGISTER', uri: `sip:${domain}`, from: `${aor};tag=${uid()}`, to: aor,
    callId: r.callId || uid() + '@sip-tester', cseq: r.cseq || 1,
    contact: ua.contact(sock, r.user),
    headers: `Expires: ${r.expires}\r\nAllow: INVITE, ACK, CANCEL, BYE, OPTIONS, NOTIFY, MESSAGE\r\n`,
  };
  return ua.authRequest(r.sockIdx, o, { user: r.authUser || r.user, password: r.password }, (res, info) => { info.cseq = o.cseqNow; done(res, info); }, r.cache);
}

// ---------- Outgoing call (UAC dialog) ----------
// opts: { ua, sockIdx, dst, user, authUser, password, displayName, sdp: {ip, port, codec}, maxRing (ms) }
// hooks: onProvisional(call, res) · onAnswer(call, res) · onFail(call, status, reason) · onEnd(call, why) · onRequest(call, req)
// Times on the call (performance.now()): t0, t100, t18x, t200, tEnd
class Call {
  constructor(opts, hooks) {
    this.o = opts; this.h = hooks || {};
    const ua = opts.ua;
    this.ua = ua; this.sockIdx = opts.sockIdx || 0;
    this.callId = uid() + '@sip-tester';
    this.localTag = uid();
    this.domain = ua.domain;
    this.ruri = /^sips?:/i.test(opts.dst) ? opts.dst : `sip:${opts.dst}@${this.domain}`;
    const fromUser = opts.user || 'sip-tester';
    this.from = `${opts.displayName ? `"${opts.displayName}" ` : ''}<sip:${encodeURIComponent(fromUser)}@${this.domain}>;tag=${this.localTag}`;
    this.to = `<${this.ruri}>`;
    this.cseq = 1; this.state = 'calling';
    this.remoteTarget = this.ruri; this.routes = null; this.remoteTo = null;
    this.challenges = 0;
  }

  start() {
    const ua = this.ua, sock = ua.sock(this.sockIdx), o = this.o;
    this.t0 = performance.now();
    this.sdpOffer = o.sdp ? makeSdp({ ip: ua.localIp, port: o.sdp.port, id: Date.now() % 1e9, codec: o.sdp.codec }) : null;
    const req = {
      method: 'INVITE', uri: this.ruri, from: this.from, to: this.to, callId: this.callId, cseq: this.cseq,
      contact: ua.contact(sock, o.user), body: this.sdpOffer,
      headers: 'Allow: INVITE, ACK, CANCEL, BYE, OPTIONS\r\nSupported: replaces\r\n' + (o.headers || ''),
      onProvisional: (res, t) => this._provisional(res, t),
      onRetransmit2xx: res => this._ack(res),
    };
    this.req = req;
    this.info = ua.authRequest(this.sockIdx, req, o.password != null ? { user: o.authUser || o.user, password: o.password } : null, (res, info, t) => this._final(res, info, t), o.authCache);
    if (o.maxRing) this.ringTimer = setTimeout(() => { if (this.state === 'calling' || this.state === 'early') { this.why = 'noanswer'; this.cancel(); } }, o.maxRing);
  }

  _provisional(res, t) {
    this.txn = t;
    if (res.status === 100) { if (this.t100 == null) this.t100 = performance.now(); }
    else {
      if (this.t18x == null) this.t18x = performance.now();
      this.state = 'early';
    }
    if (this.t100 == null && res.status > 100) this.t100 = performance.now();
    if (this.cancelPending) this._sendCancel();
    this.h.onProvisional && this.h.onProvisional(this, res);
  }

  _final(res, info, t) {
    clearTimeout(this.ringTimer);
    this.challenges = info.challenges; this.rtx = info.rtx; this.txn = t;
    if (!res) { this.state = 'ended'; this.endStatus = 'timeout'; this.tEnd = performance.now(); this.h.onFail && this.h.onFail(this, 0, 'Timeout'); this.h.onEnd && this.h.onEnd(this, 'timeout'); return; }
    if (this.t100 == null) this.t100 = performance.now();
    if (res.status >= 300) {
      this.state = 'ended'; this.status = res.status; this.reason = res.reason; this.tEnd = performance.now();
      this.cseq = this.req.cseqNow || this.cseq;
      const why = this.cancelled && res.status === 487 ? (this.why || 'cancelled') : 'failed';
      this.h.onFail && this.h.onFail(this, res.status, res.reason, why);
      this.h.onEnd && this.h.onEnd(this, why);
      return;
    }
    // 2xx: dialog established
    this.t200 = performance.now(); if (this.t18x == null) this.t18x = this.t200;
    this.cseq = this.req.cseqNow || this.cseq;
    this.status = res.status;
    this.remoteTo = hdr(res, 'to');
    const ct = uriOf(hdr(res, 'contact')); if (ct) this.remoteTarget = ct;
    const rr = hdrAll(res, 'record-route'); this.routes = rr.length ? rr.reverse() : null;
    this.remoteSdp = parseSdp(res.body);
    this._ack(res);
    if (this.cancelled || this.state === 'ending') { this.state = 'confirmed'; this.hangup(); return; }
    this.state = 'confirmed';
    this.h.onAnswer && this.h.onAnswer(this, res);
  }

  _ack(res) {
    this.ua.sendRaw(this.sockIdx, { method: 'ACK', uri: this.remoteTarget, from: this.from, to: this.remoteTo || hdr(res, 'to'), callId: this.callId, cseq: this.cseq, routes: this.routes });
  }

  _sendCancel() {
    if (this.cancelSent || !this.txn || !this.txn.branch) return;
    this.cancelSent = true; this.cancelPending = false;
    const r = this.req;
    // CANCEL reuses the INVITE's branch, Request-URI, From, To (no tag) and CSeq number
    this.ua.request(this.sockIdx, { method: 'CANCEL', uri: r.uri, from: r.from, to: r.to, callId: this.callId, cseq: r.cseqNow || 1, branch: this.txn.branch, routes: r.routes }, {
      onResponse: () => {}, onTimeout: () => { if (this.state !== 'ended') { this.ua.forget(this.txn); this._end('cancelTimeout'); } },
    });
  }

  cancel() {
    if (this.state === 'ended') return;
    this.cancelled = true;
    if (this.state === 'confirmed') return this.hangup();
    if (this.txn && this.txn.state !== 'trying') this._sendCancel();
    else this.cancelPending = true; // RFC 3261: CANCEL only after a provisional response
  }

  hangup(done) {
    if (this.state === 'ended' || this.state === 'terminating') return;
    if (this.state !== 'confirmed') { this.state === 'calling' || this.state === 'early' ? this.cancel() : null; return; }
    clearTimeout(this.holdTimer);
    this.state = 'terminating'; this.tBye = performance.now();
    this.cseq++;
    const o = { method: 'BYE', uri: this.remoteTarget, from: this.from, to: this.remoteTo, callId: this.callId, cseq: this.cseq, routes: this.routes };
    this.ua.authRequest(this.sockIdx, o, this.o.password != null ? { user: this.o.authUser || this.o.user, password: this.o.password } : null, res => {
      this.byeStatus = res ? res.status : 0; this.byeMs = performance.now() - this.tBye;
      done && done(res);
      this._end(res ? (res.status < 300 ? 'bye' : 'byeFailed') : 'byeTimeout');
    }, this.o.authCache);
  }

  _end(why) {
    if (this.state === 'ended') return;
    clearTimeout(this.holdTimer); clearTimeout(this.ringTimer);
    this.state = 'ended'; this.tEnd = performance.now(); this.endWhy = why;
    this.h.onEnd && this.h.onEnd(this, why);
  }

  // In-dialog request from the far end (BYE, re-INVITE, INFO, UPDATE, OPTIONS)
  onRequest(m) {
    if (m.method === 'BYE') {
      m.respond(200, 'OK');
      this.remoteBye = true; this.h.onRequest && this.h.onRequest(this, m);
      this._end('remoteBye');
    } else if (m.method === 'INVITE' || m.method === 'UPDATE') {
      const ct = uriOf(hdr(m, 'contact')); if (ct) this.remoteTarget = ct;
      const sdp = m.body ? parseSdp(m.body) : null; if (sdp) { this.remoteSdp = sdp; this.h.onRequest && this.h.onRequest(this, m); }
      const sock = this.ua.sock(this.sockIdx);
      m.toTag = this.localTag;
      m.respond(200, 'OK', `Contact: ${this.ua.contact(sock, this.o.user)}\r\n`, this.sdpOffer);
    } else if (m.method === 'CANCEL') m.respond(200, 'OK');
    else m.respond(200, 'OK');
  }
}

// Status code → short name
const REASONS = { 100: 'Trying', 180: 'Ringing', 181: 'Call Is Being Forwarded', 182: 'Queued', 183: 'Session Progress', 200: 'OK', 202: 'Accepted',
  300: 'Multiple Choices', 301: 'Moved Permanently', 302: 'Moved Temporarily', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 406: 'Not Acceptable', 407: 'Proxy Authentication Required', 408: 'Request Timeout', 410: 'Gone', 413: 'Request Entity Too Large',
  415: 'Unsupported Media Type', 416: 'Unsupported URI Scheme', 420: 'Bad Extension', 421: 'Extension Required', 422: 'Session Interval Too Small', 423: 'Interval Too Brief',
  480: 'Temporarily Unavailable', 481: 'Call/Transaction Does Not Exist', 482: 'Loop Detected', 483: 'Too Many Hops', 484: 'Address Incomplete', 485: 'Ambiguous',
  486: 'Busy Here', 487: 'Request Terminated', 488: 'Not Acceptable Here', 491: 'Request Pending', 493: 'Undecipherable', 500: 'Server Internal Error',
  501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Server Time-out', 505: 'Version Not Supported', 513: 'Message Too Large',
  600: 'Busy Everywhere', 603: 'Decline', 604: 'Does Not Exist Anywhere', 606: 'Not Acceptable' };
const statusName = (code, reason) => `${code} ${REASONS[code] || reason || ''}`.trim();

module.exports = { parse, hdr, hdrAll, param, uriOf, tagOf, userOf, splitList, Framer, parseChallenge, digest, makeSdp, parseSdp, CODECS, SipUA, Call, register, uid, REASONS, statusName, localIpFor, resolveHost };
