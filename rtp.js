// Light RTP: one UDP socket per media-enabled call, 20 ms G.711 packets, RFC 3550 receive statistics.
// Every outgoing payload starts with a marker and the send time, so audio echoed back by the far end
// (an echo test extension) yields a round-trip time.
const dgram = require('dgram');

const MAGIC = 0x53495054; // 'SIPT'
const now = () => performance.now();

class RtpPool {
  // opts: { portStart (0 = any free port), ip (bind address) }
  constructor(opts = {}) { this.portStart = Number(opts.portStart) || 0; this.next = this.portStart; this.free = []; this.sessions = new Set(); this.sink = null; }

  // Shared socket advertised by calls that don't send media; incoming packets are only counted
  async openSink() {
    if (this.sink) return this.sink;
    this.sink = await this._bind(0);
    this.sink.rx = 0; this.sink.s.on('message', () => { this.sink.rx++; });
    return this.sink;
  }

  _bind(port) {
    return new Promise((resolve, reject) => {
      const s = dgram.createSocket('udp4');
      s.once('error', reject);
      s.bind(port, () => { s.removeListener('error', reject); s.on('error', () => {}); resolve({ s, port: s.address().port }); });
    });
  }

  async _socket() {
    if (this.free.length && !(this.free[0].freedAt && now() - this.free[0].freedAt < 2000)) return this.free.shift();
    return this._newSocket();
  }

  async _newSocket() {
    if (!this.portStart) return this._bind(0);
    for (let tries = 0; tries < 200; tries++) {
      const p = this.next; this.next += 2; if (this.next > 65000) this.next = this.portStart;
      try { return await this._bind(p); } catch {}
    }
    return this._bind(0);
  }

  // Creates a session bound to its own port (the SDP offer advertises it)
  async session(codec) {
    const k = await this._socket();
    const r = new RtpSession(k, codec, this);
    this.sessions.add(r);
    return r;
  }

  // Binds n sockets up front so calls can take one synchronously
  async prealloc(n) { while (this.free.length < n) this.free.push(await this._newSocket()); }
  // A released socket rests 2 s before reuse, so late packets of the previous call can't pollute the next one
  take(codec) {
    const k = this.free[0]; if (!k || (k.freedAt && now() - k.freedAt < 2000)) return null;
    this.free.shift();
    const r = new RtpSession(k, codec, this); this.sessions.add(r); return r;
  }

  release(r) {
    if (!this.sessions.delete(r)) return;
    r.sock.s.removeAllListeners('message');
    // Reuse the socket for a later call (avoids churning ports at high call rates)
    if (this.free.length < 6000) { r.sock.freedAt = now(); this.free.push(r.sock); }
    else try { r.sock.s.close(); } catch {}
  }

  // Sends one 20 ms packet on every started session; call this every 20 ms
  // Paced by each session's own clock; catches up at most 3 packets after an event-loop stall
  tick() {
    const t = now();
    for (const r of this.sessions) {
      if (!r.remote || !r.sending) continue;
      if (r.next == null || t - r.next > 60) r.next = t;
      while (r.next <= t) { r.send(t); r.next += 20; }
    }
  }

  close() {
    for (const r of this.sessions) try { r.sock.s.close(); } catch {}
    for (const k of this.free) try { k.s.close(); } catch {}
    if (this.sink) try { this.sink.s.close(); } catch {}
    this.sessions.clear(); this.free = []; this.sink = null;
  }
}

class RtpSession {
  constructor(sock, codec, pool) {
    this.sock = sock; this.port = sock.port; this.pool = pool;
    this.pt = codec === 'PCMA' ? 8 : 0;
    this.ssrc = (Math.random() * 0xffffffff) >>> 0;
    this.seq = (Math.random() * 0xffff) | 0; this.ts = (Math.random() * 0xffffffff) >>> 0;
    this.pkt = Buffer.alloc(12 + 160, this.pt === 8 ? 0xd5 : 0xff);
    this.pkt[0] = 0x80; this.pkt.writeUInt32BE(this.ssrc, 8);
    this.pkt.writeUInt32BE(MAGIC, 12);
    this.tx = 0; this.remote = null; this.sending = false;
    // Receive statistics (RFC 3550 A.1 / A.8)
    this.rx = 0; this.base = -1; this.maxSeq = 0; this.cycles = 0; this.jitter = 0; this.transit = null; this.dups = 0;
    this.rttN = 0; this.rttSum = 0; this.rttMax = 0; this.firstRx = null; this.lastRx = null; this.maxGap = 0;
    this.secRx = 0; this.secLost = 0; this.secExp = 0;
    sock.s.on('message', (b, ri) => this._recv(b, ri));
  }

  start(ip, port, pt) {
    if (!ip || !port || ip === '0.0.0.0') return;
    this.remote = { ip, port }; if (pt === 0 || pt === 8) { this.pt = pt; this.pkt.fill(pt === 8 ? 0xd5 : 0xff, 20); }
    this.sending = true;
  }
  stop() { this.sending = false; }

  send(t) {
    const p = this.pkt;
    p[1] = this.pt | (this.tx === 0 ? 0x80 : 0);
    p.writeUInt16BE(this.seq, 2); this.seq = (this.seq + 1) & 0xffff;
    p.writeUInt32BE(this.ts >>> 0, 4); this.ts = (this.ts + 160) >>> 0;
    p.writeDoubleBE(t, 16);
    this.sock.s.send(p, this.remote.port, this.remote.ip);
    this.tx++;
  }

  _recv(b, ri) {
    if (!this.sending || b.length < 12 || (b[0] & 0xc0) !== 0x80) return;
    const pt = b[1] & 0x7f; if (pt >= 72 && pt <= 76) return; // RTCP on the same port
    const t = now();
    const seq = b.readUInt16BE(2), ts = b.readUInt32BE(4);
    if (this.base < 0) { this.base = seq; this.maxSeq = seq; this.firstRx = t; if (!this.remote && ri) this.remote = { ip: ri.address, port: ri.port }; }
    else {
      const d = (seq - this.maxSeq + 0x10000) & 0xffff;
      if (d === 0) { this.dups++; return; }
      if (d < 0x8000) { if (seq < this.maxSeq) this.cycles += 0x10000; this.maxSeq = seq; }
      if (this.lastRx != null) { const g = t - this.lastRx; if (g > this.maxGap) this.maxGap = g; }
    }
    this.lastRx = t;
    this.rx++; this.secRx++;
    // Interarrival jitter in timestamp units (8 kHz)
    const arrival = t * 8, tr = arrival - ts;
    if (this.transit != null) { let dd = tr - this.transit; if (dd < 0) dd = -dd; if (dd < 8000 * 2) this.jitter += (dd - this.jitter) / 16; }
    this.transit = tr;
    // Echoed packet of ours: round-trip time
    if (b.length >= 24 && b.readUInt32BE(12) === MAGIC) {
      const sent = b.readDoubleBE(16), rtt = t - sent;
      if (rtt >= 0 && rtt < 10000) { this.rttN++; this.rttSum += rtt; if (rtt > this.rttMax) this.rttMax = rtt; this.lastRtt = rtt; }
    }
  }

  expected() { return this.base < 0 ? 0 : this.cycles + this.maxSeq - this.base + 1; }
  lost() { return Math.max(0, this.expected() - this.rx); }
  jitterMs() { return this.jitter / 8; }
  summary() {
    return { tx: this.tx, rx: this.rx, expected: this.expected(), lost: this.lost(), lossPct: this.expected() ? this.lost() / this.expected() * 100 : null,
      jitter: this.jitterMs(), maxGap: this.maxGap, rtt: this.rttN ? this.rttSum / this.rttN : null, rttMax: this.rttN ? this.rttMax : null };
  }
}

module.exports = { RtpPool, RtpSession };
