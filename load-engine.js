// Load test engine: calls (INVITE → answer → hold → BYE), registrations or OPTIONS at a target rate,
// with a concurrency limit, step tests, back-off on 503, light RTP and latency histograms.
// Runs in its own process (load-worker.js).
//
// User-facing messages are English templates ({key, p}) so the UI can translate them.
const EventEmitter = require('events');
const { SipUA, Call, register, uid, statusName } = require('./sip-core');
const { RtpPool } = require('./rtp');
const { Hist } = require('./hist');

const now = () => performance.now();
const epoch = () => performance.timeOrigin + performance.now(); // comparable with the vendor process on the same machine
const fill = (s, p) => p ? s.replace(/\{(\w+)\}/g, (m, k) => p[k] !== undefined ? p[k] : m) : s;
const msg = (key, p) => ({ key, p, text: fill(key, p) });
const err = (key, p) => Object.assign(new Error(fill(key, p)), { key, p });
const clamp = (v, lo, hi, d) => { const n = Number(v); return Math.max(lo, Math.min(hi, isFinite(n) && v !== '' && v != null ? n : d)); };

// "1000-1099, alice, 2000-2004" → list of users (at most 100 000)
function parseUsers(s) {
  const out = [];
  for (const part of String(s || '').split(/[\s,;]+/).filter(Boolean)) {
    const r = /^(\d+)-(\d+)$/.exec(part);
    if (r) {
      const a = Number(r[1]), b = Number(r[2]), w = r[1].length;
      for (let i = a; i <= b && out.length < 100000; i++) out.push(String(i).padStart(w, '0'));
    } else out.push(part);
    if (out.length >= 100000) break;
  }
  return out;
}

class LoadEngine extends EventEmitter {
  constructor() { super(); this.running = false; }

  async start(cfg, t) {
    if (this.running) throw err('A test is already running');
    this.running = true; this.stopping = false; this.aborted = false;
    this.cfg = cfg;
    const scenario = ['call', 'register', 'options'].includes(t.scenario) ? t.scenario : 'call';
    const holdMin = clamp(t.holdMin, 0, 86400, 10), holdMax = Math.max(holdMin, clamp(t.holdMax, 0, 86400, holdMin));
    this.t = {
      scenario,
      rate: clamp(t.rate, 0.1, 50000, 10),
      concurrent: clamp(t.concurrent, 1, 200000, scenario === 'call' ? 1000 : 500),
      connections: clamp(t.connections, 1, 64, 1),
      total: clamp(t.total, 0, 1e9, 0),
      duration: clamp(t.duration, 0, 7 * 86400, 0),
      ramp: clamp(t.ramp, 0, 3600, 0),
      respTimeout: clamp(t.respTimeout, 1, 300, 32) * 1000,
      maxRing: clamp(t.maxRing, 1, 600, 60) * 1000,
      holdMin: holdMin * 1000, holdMax: holdMax * 1000,
      dst: String(t.dst || ''),
      users: parseUsers(t.users),
      passTpl: t.passTpl || '',
      expires: clamp(t.expires, 0, 86400, 300),
      reuseNonce: !!t.reuseNonce,
      rtp: scenario === 'call' && !!t.rtp,
      rtpMax: clamp(t.rtpMax, 1, 5000, 100),
      codec: t.codec === 'PCMA' ? 'PCMA' : 'PCMU',
      backoff503: t.backoff503 !== false,
      e2e: scenario === 'call' && !!t.e2e,
      criteria: t.criteria || {},
      name: t.name || '',
    };
    const T = this.t;
    // Step test: from the start rate to the target rate, fixed duration per step
    const st = t.steps;
    if (st && Number(st.inc) > 0 && Number(st.dur) > 0) {
      const start = Math.max(0.1, Number(st.start) || Number(st.inc)), inc = Number(st.inc), max = T.rate, dur = Number(st.dur);
      T.steps = [];
      for (let v = start; v < max + inc * 0.001 && T.steps.length < 100; v += inc) T.steps.push(Math.min(v, max));
      if (T.steps.at(-1) < max) T.steps.push(max);
      T.stepDur = dur; T.duration = T.steps.length * dur; T.total = 0;
    } else T.steps = null;
    if (!T.total && !T.duration) T.duration = 60;

    this.e2e = null;
    if (scenario === 'call') {
      this.dsts = T.dst.split(/[\s,;]+/).filter(Boolean);
      if (!this.dsts.length) throw err('Destination is empty');
      // End-to-end: the trailing X's of the destination carry a call counter that the vendor reads back
      this.e2e = null;
      if (T.e2e) {
        const ks = this.dsts.map(d => (/[xX]+$/.exec(d) || [''])[0].length);
        if (ks.some(k => k < 4)) throw err('End-to-end measurement needs at least 4 X at the end of the destination (e.g. 8XXXXXXX)');
        if (new Set(ks).size > 1) throw err('End-to-end measurement: every destination needs the same number of trailing X');
        const k = ks[0];
        this.e2e = { k, mod: 10 ** k, seq: 0, pend: new Map(), sent: 0, reached: 0, dup: 0, unmatched: 0, trunks: [], fo: 0, foOk: 0, allRej: 0 };
        this.dsts = this.dsts.map(d => d.slice(0, d.length - k));
      }
    }
    if (scenario === 'register' && !T.users.length && !cfg.user) throw err('Enter the users to register');
    // Accounts used by the test (rotated): the user list, or the single account from the connection settings
    const pw = u => T.passTpl ? T.passTpl.replace(/\{user\}/g, u) : (cfg.password || '');
    this.accounts = (T.users.length ? T.users : [cfg.user || 'sip-tester']).map(u => ({
      user: u, authUser: T.users.length ? u : (cfg.authUser || u), password: (T.users.length || cfg.password) ? pw(u) : null,
      busy: false, callId: uid() + '@sip-tester', cseq: 1, cache: T.reuseNonce ? {} : null,
    }));
    this.acc = 0; this.di = 0; this.rr = 0; this.lastWf = 0; this.lastDec = 0; this.forceEnd = false; this.drainUntil = null; this.sendEnd = null;

    this.events = []; this.flags = {};
    this.G = { sent: 0, ok: 0, err: 0, timeouts: 0, throttled: 0, retrans: 0, challenges: 0, errs: {},
      completed: 0, dropped: 0, byeFail: 0, byeTimeout: 0, noAnswer: 0, maxActive: 0, windowFullMs: 0,
      rtpCalls: 0, rtpTx: 0, rtpRx: 0, rtpExpected: 0, rtpLost: 0, noMedia: 0 };
    this.S = this._emptySec();
    this.e2eAll = new Hist(); this.foAll = new Hist();
    this.latAll = new Hist(); this.ansAll = new Hist(); this.t100All = new Hist(); this.byeAll = new Hist(); this.jitAll = new Hist(); this.rttAll = new Hist();
    this.calls = new Map(); this.active = 0; this.rateFactor = 1; this.series = [];
    this.hooks = this._callHooks(); // fresh per test: the hooks capture this test's counters

    this.emit('phase', { phase: 'connecting', ...msg(T.connections > 1 ? 'Opening {n} connections…' : 'Opening the connection…', { n: T.connections }) });
    this.binding = true;
    try {
      this.ua = new SipUA({ ...cfg, connections: T.connections, timeout: T.respTimeout });
      await this.ua.open();
      if (scenario === 'call') {
        this.pool = new RtpPool({ portStart: cfg.rtpPort });
        this.sink = await this.pool.openSink();
        if (T.rtp) await this.pool.prealloc(T.rtpMax + Math.max(20, Math.ceil(T.rtpMax / 2))); // spare sockets cover the reuse cool-down
      }
    } catch (e) {
      this._cleanup(); this.running = false; this.binding = false;
      this.emit('phase', { phase: 'error', ...(e.key ? msg(e.key, e.p) : { text: e.message }) }); return;
    }
    this.binding = false;
    if (this.aborted) { this._cleanup(); this.running = false; return; }
    this.ua.handler = m => { const c = this.calls.get(m.callId); if (c) { c.onRequest(m); return true; } return false; };
    this.ua.on('connClosed', s => { if (this.running && !this.stopping) this._event('session', 'Connection {n} closed by the server', { n: s.i + 1 }); });
    this.ua.on('log', m => this.emit('log', m));

    this.emit('phase', { phase: 'running', ...msg('Running') });
    this.startedAt = Date.now();
    this.t0 = now(); this.curStep = -1;
    this._event('start', '{transport} · local {ip} · test started', { transport: this.ua.transport.toUpperCase(), ip: this.ua.localIp });
    this.lastTick = this.t0; this.allow = 0; this.secT = this.t0; this.lastRetrans = 0;
    this.tick = setInterval(() => this._pump(), 2);
    this.secTimer = setInterval(() => this._second(), 1000);
    if (T.rtp) this.rtpTimer = setInterval(() => this.pool.tick(), 10);
  }

  _emptySec() {
    return { sent: 0, ok: 0, err: 0, thr: 0, to: 0, bye: 0, drop: 0, ch: 0, e2eRx: 0, e2eFo: 0, e2eTr: [], lat: new Hist(), ans: new Hist(), t100: new Hist(), byeLat: new Hist(), e2e: new Hist() };
  }

  // Token bucket: permits accrue every 2 ms; a call/request starts while the concurrency limit has room
  _pump() {
    if (this.stopping || this.sendEnd) return;
    const t = now(); const el = t - this.lastTick; this.lastTick = t;
    const elapsed = t - this.t0;
    const rampF = this.t.ramp ? Math.min(1, Math.max(0.02, elapsed / (this.t.ramp * 1000))) : 1;
    if (this.rateFactor < 1) this.rateFactor = Math.min(1, this.rateFactor + el / 3000);
    const rate = this._target(elapsed) * rampF * this.rateFactor;
    // Burst cap: up to 250 ms worth of permits, so short event-loop stalls don't lose rate (low rates included)
    this.allow = Math.min(this.allow + rate * el / 1000, Math.max(2, rate * 0.25));
    if ((this.t.total && this.G.sent >= this.t.total) || (this.t.duration && elapsed >= this.t.duration * 1000)) return this._finishSending();
    let blocked = false;
    while (this.allow >= 1) {
      if (this.active >= this.t.concurrent) { blocked = true; break; }
      if (this.t.total && this.G.sent >= this.t.total) break;
      const ok = this.t.scenario === 'call' ? this._startCall() : this.t.scenario === 'register' ? this._startRegister() : this._startOptions();
      if (!ok) { blocked = true; break; }
      this.allow--;
    }
    if (blocked) this.G.windowFullMs += el;
  }

  _target(elapsedMs, quiet) {
    if (!this.t.steps) return this.t.rate;
    const i = Math.min(this.t.steps.length - 1, Math.floor(elapsedMs / 1000 / this.t.stepDur));
    if (quiet) return this.t.steps[i];
    if (i !== this.curStep) { this.curStep = i; this._event('step', 'Step {i}/{n}: {rate}/s', { i: i + 1, n: this.t.steps.length, rate: this.t.steps[i] }); }
    return this.t.steps[i];
  }

  _event(type, key, p) {
    const t = this.t0 ? (now() - this.t0) / 1000 : 0;
    const m = msg(key, p);
    this.events.push({ t: Math.round(t * 10) / 10, type, ...m });
    if (this.events.length > 2000) this.events.splice(1000, 1);
    this.emit('log', m);
  }

  _nextAccount() {
    const n = this.accounts.length;
    for (let k = 0; k < n; k++) { const a = this.accounts[this.acc]; this.acc = (this.acc + 1) % n; if (!a.busy || this.t.scenario === 'call') return a; }
    return null;
  }
  _sockIdx() { this.rr = ((this.rr || 0) + 1) % this.ua.socks.length; return this.rr; }

  // Failure bookkeeping shared by all scenarios. code 0 = no response (timeout).
  _fail(code, reason, prefix) {
    const G = this.G, S = this.S;
    if (code === 0) {
      G.timeouts++; S.to++; G.err++; S.err++; G.errs.TIMEOUT = (G.errs.TIMEOUT || 0) + 1;
      if (!this.flags.to) { this.flags.to = true; this._event('timeout', 'First timeout (no final response)'); }
      return;
    }
    const name = (prefix || '') + statusName(code, reason);
    G.err++; S.err++; G.errs[name] = (G.errs[name] || 0) + 1;
    if (code === 503) {
      G.throttled++; S.thr++;
      if (!this.flags.thr) { this.flags.thr = true; this._event('throttle', 'First 503 Service Unavailable (overload)'); }
      if (this.t.backoff503) { const tn = now(); if (!this.lastDec || tn - this.lastDec > 200) { this.lastDec = tn; this.rateFactor = Math.max(0.1, this.rateFactor * 0.85); } }
    } else if (!this.flags['e' + name]) { this.flags['e' + name] = true; this._event('error', 'First {status}', { status: name }); }
  }

  // ---------- Calls ----------
  _startCall() {
    const T = this.t;
    const a = this._nextAccount();
    let dst = this.dsts[this.di = ((this.di || 0) + 1) % this.dsts.length];
    if (this.e2e) {
      const E = this.e2e, id = String(E.seq++ % E.mod).padStart(E.k, '0');
      dst = dst.replace(/[xX]/g, () => String((Math.random() * 10) | 0)) + id;
      E.pend.set(id, { t0: epoch(), n: 0 }); E.sent++;
    } else if (/[xX]/.test(dst)) dst = dst.replace(/[xX]/g, () => String((Math.random() * 10) | 0));
    let rtp = null;
    if (T.rtp && this.pool.sessions.size < T.rtpMax) rtp = this.pool.take(T.codec);
    const call = new Call({
      ua: this.ua, sockIdx: this._sockIdx(), dst, user: a.user, authUser: a.authUser, password: a.password, displayName: this.cfg.displayName,
      sdp: { port: rtp ? rtp.port : this.sink.port, codec: T.codec }, maxRing: T.maxRing, authCache: a.cache,
    }, this.hooks);
    call.rtp = rtp;
    this.calls.set(call.callId, call);
    this.active++; if (this.active > this.G.maxActive) this.G.maxActive = this.active;
    this.G.sent++; this.S.sent++;
    call.start();
    return true;
  }

  _callHooks() {
    const G = this.G;
    return {
      onProvisional: (c, res) => {
        if (res.status === 100 || !c.seen100) { if (!c.seen100) { c.seen100 = true; const l = c.t100 - c.t0; this.S.t100.add(l); this.t100All.add(l); } }
        if (res.status > 100 && !c.pddDone) { c.pddDone = true; const l = c.t18x - c.t0; this.S.lat.add(l); this.latAll.add(l); }
      },
      onAnswer: c => {
        const S = this.S;
        if (!c.seen100) { c.seen100 = true; const l = c.t100 - c.t0; S.t100.add(l); this.t100All.add(l); }
        if (!c.pddDone) { c.pddDone = true; const l = c.t200 - c.t0; S.lat.add(l); this.latAll.add(l); }
        const l = c.t200 - c.t0; S.ans.add(l); this.ansAll.add(l);
        G.ok++; S.ok++; G.challenges += c.challenges; S.ch += c.challenges;
        if (c.rtp) {
          G.rtpCalls++;
          if (c.remoteSdp) c.rtp.start(c.remoteSdp.ip, c.remoteSdp.port, c.remoteSdp.pt);
        }
        if (this.forceEnd) return c.hangup();
        const hold = this.t.holdMin + Math.random() * (this.t.holdMax - this.t.holdMin);
        c.holdUntil = now() + hold;
        c.holdTimer = setTimeout(() => c.hangup(), hold);
      },
      onRequest: (c, m) => {
        // re-INVITE with new media: follow it
        if (m.method !== 'BYE' && c.rtp && c.remoteSdp) c.rtp.start(c.remoteSdp.ip, c.remoteSdp.port, c.remoteSdp.pt);
      },
      onFail: (c, code, reason, why) => {
        G.challenges += c.challenges || 0;
        if (why === 'noanswer') {
          G.noAnswer++; G.err++; this.S.err++; G.errs['NO ANSWER (CANCEL)'] = (G.errs['NO ANSWER (CANCEL)'] || 0) + 1;
          if (!this.flags.na) { this.flags.na = true; this._event('error', 'First unanswered call (cancelled after {s} s of ringing)', { s: this.t.maxRing / 1000 }); }
          return;
        }
        if (why === 'cancelled') return; // cancelled by the test itself when stopping
        this._fail(code, reason);
      },
      onEnd: (c, why) => {
        this.active--; this.calls.delete(c.callId);
        const S = this.S;
        if (why === 'bye') { G.completed++; S.bye++; this.byeAll.add(c.byeMs); S.byeLat.add(c.byeMs); }
        else if (why === 'byeFailed') { G.byeFail++; const n = 'BYE ' + statusName(c.byeStatus); G.errs[n] = (G.errs[n] || 0) + 1; if (!this.flags['e' + n]) { this.flags['e' + n] = true; this._event('error', 'First {status}', { status: n }); } }
        else if (why === 'byeTimeout') { G.byeTimeout++; G.errs['BYE TIMEOUT'] = (G.errs['BYE TIMEOUT'] || 0) + 1; }
        else if (why === 'remoteBye' && c.t200 != null) {
          // The far end hung up before the hold time was over: a dropped call
          if (!this.forceEnd && c.holdUntil && now() < c.holdUntil - 500) {
            G.dropped++; S.drop++;
            if (!this.flags.drop) { this.flags.drop = true; this._event('drop', 'First call hung up by the server before the hold time ended'); }
          } else { G.completed++; S.bye++; }
        }
        if (c.rtp) {
          const r = c.rtp;
          if (c.t200 != null) {
            G.rtpTx += r.tx; G.rtpRx += r.rx; G.rtpExpected += r.expected(); G.rtpLost += r.lost();
            if (r.rx === 0 && c.tEnd - c.t200 > 2000) G.noMedia++;
            if (r.rx > 10) this.jitAll.add(r.jitterMs());
            if (r.rttN) this.rttAll.add(r.rttSum / r.rttN);
          }
          this.pool.release(r); c.rtp = null;
        }
      },
    };
  }

  // ---------- Registrations ----------
  _startRegister() {
    const a = this._nextAccount(); if (!a) return false;
    a.busy = true; this.active++; if (this.active > this.G.maxActive) this.G.maxActive = this.active;
    this.G.sent++; this.S.sent++;
    const t0 = now();
    register(this.ua, { sockIdx: this._sockIdx(), user: a.user, authUser: a.authUser, password: a.password, expires: this.t.expires, callId: a.callId, cseq: a.cseq, cache: a.cache }, (res, info) => {
      a.busy = false; this.active--; a.cseq = (info.cseq || a.cseq) + 1;
      this.G.challenges += info.challenges; this.S.ch += info.challenges;
      if (res && res.status < 300) { const l = now() - t0; this.G.ok++; this.S.ok++; this.S.lat.add(l); this.latAll.add(l); a.registered = true; }
      else this._fail(res ? res.status : 0, res && res.reason);
    });
    return true;
  }

  // ---------- OPTIONS ----------
  _startOptions() {
    const a = this._nextAccount();
    this.active++; if (this.active > this.G.maxActive) this.G.maxActive = this.active;
    this.G.sent++; this.S.sent++;
    const ua = this.ua, t0 = now();
    const o = { method: 'OPTIONS', uri: `sip:${ua.domain}`, from: `<sip:${encodeURIComponent(a.user)}@${ua.domain}>;tag=${uid()}`, to: `<sip:${ua.domain}>`, callId: uid() + '@sip-tester', cseq: 1, headers: 'Accept: application/sdp\r\n' };
    ua.authRequest(this._sockIdx(), o, a.password != null ? { user: a.authUser, password: a.password } : null, (res, info) => {
      this.active--; this.G.challenges += info.challenges;
      if (res && res.status < 300) { const l = now() - t0; this.G.ok++; this.S.ok++; this.S.lat.add(l); this.latAll.add(l); }
      else this._fail(res ? res.status : 0, res && res.reason);
    }, a.cache);
    return true;
  }

  // ---------- End-to-end: calls arriving at the built-in vendor ----------
  // list: [[dialled user, epoch ms, trunk, code], …] forwarded from the vendor process. code 0 = the trunk took the call,
  // otherwise the trunk rejected it (503, 486, …). With several trunks one call can arrive more than once: a rejection on
  // trunk A followed by an attempt on trunk B is a failover, not a duplicate. A duplicate is a call taken twice.
  addArrivals(list) {
    const E = this.e2e; if (!E || !this.running) return;
    for (const [user, at, trunk = 0, code = 0] of list) {
      const digits = String(user || '').replace(/\D/g, '');
      const e = digits.length >= E.k ? E.pend.get(digits.slice(-E.k)) : undefined;
      if (!e) { E.unmatched++; continue; }
      const tr = E.trunks[trunk] || (E.trunks[trunk] = { att: 0, acc: 0, rej: 0 });
      tr.att++;
      if (!e.n) { // first time the call shows up anywhere: PBX routing delay
        e.n = 0; e.at = at; E.reached++; this.S.e2eRx++;
        const l = Math.max(0, at - e.t0); this.S.e2e.add(l); this.e2eAll.add(l);
      }
      e.n++;
      if (code) {
        tr.rej++;
        if (!e.acc && !e.allRej) { e.allRej = true; E.allRej++; } // rejected so far by every trunk it tried
        continue;
      }
      tr.acc++; this.S.e2eTr[trunk] = (this.S.e2eTr[trunk] || 0) + 1;
      if (e.acc) { E.dup++; if (!this.flags.dup) { this.flags.dup = true; this._event('error', 'First call that reached the vendor twice'); } continue; }
      e.acc = true;
      if (e.allRej) { e.allRej = false; E.allRej--; }
      if (e.n > 1) { // taken only after one or more rejections: a failover (or a retry on the same trunk)
        E.fo++; this.S.e2eFo++;
        const d = Math.max(0, at - e.at); this.foAll.add(d);
        if (!this.flags.fo) { this.flags.fo = true; this._event('throttle', 'First call that failed over to another trunk'); }
      }
    }
  }

  // ---------- Per-second statistics ----------
  _second() {
    const t = now();
    const dt = (t - this.secT) / 1000; this.secT = t;
    const S = this.S, l = S.lat.summary(), an = S.ans.summary(), t1 = S.t100.summary(), by = S.byeLat.summary();
    const el = t - this.t0;
    const wf = Math.min(1, (this.G.windowFullMs - (this.lastWf || 0)) / (dt * 1000)); this.lastWf = this.G.windowFullMs;
    const rt = this.ua ? this.ua.retrans : 0; const retr = rt - this.lastRetrans; this.lastRetrans = rt; this.G.retrans = rt;
    const mid = Math.max(0, el - dt * 500);
    const row = {
      target: this.tick ? Math.round(this._target(mid, true) * (this.t.ramp ? Math.min(1, mid / (this.t.ramp * 1000)) : 1) * 100) / 100 : 0,
      step: this.t.steps && this.tick ? Math.min(this.t.steps.length, Math.floor(mid / 1000 / this.t.stepDur) + 1) : null,
      bound: this.ua ? this.ua.upCount() : 0, windowFull: Math.round(wf * 100) / 100,
      t: Math.round(el / 1000), sentTps: S.sent / dt, okTps: S.ok / dt, errTps: S.err / dt, thrTps: S.thr / dt, toTps: S.to / dt, retrTps: retr / dt, chTps: S.ch / dt,
      inflight: this.active, rate: this.rateFactor,
      p50: l.p50, p95: l.p95, p99: l.p99, max: l.max,
    };
    if (this.t.scenario === 'call') {
      Object.assign(row, { ansP50: an.p50, ansP95: an.p95, t100P95: t1.p95, byeTps: S.bye / dt, dropTps: S.drop / dt, byeP95: by.p95 });
      if (this.e2e) {
        const e = S.e2e.summary(); Object.assign(row, { e2eRxTps: S.e2eRx / dt, e2eP50: e.p50, e2eP95: e.p95, e2eP99: e.p99 });
        // Several trunks: calls taken per second on each, and failovers per second
        if (this.e2e.trunks.length > 1) Object.assign(row, { e2eFoTps: S.e2eFo / dt, e2eTr: this.e2e.trunks.map((_, i) => (S.e2eTr[i] || 0) / dt) });
      }
      if (this.t.rtp && this.pool) {
        // Media over the last second across live media calls
        let rx = 0, exp = 0, jit = 0, jn = 0, n = 0; const rtt = new Hist();
        for (const r of this.pool.sessions) {
          if (!r.sending) continue; n++;
          const e = r.expected();
          rx += r.rx - (r.pRx || 0); exp += e - (r.pExp || 0); r.pRx = r.rx; r.pExp = e;
          if (r.rx > 10) { jit += r.jitterMs(); jn++; }
          if (r.lastRtt != null) { rtt.add(r.lastRtt); r.lastRtt = null; }
        }
        Object.assign(row, { rtpCalls: n, rtpRxPps: rx / dt, rtpLoss: exp > 0 ? Math.max(0, (exp - rx) / exp * 100) : null, jitter: jn ? jit / jn : null, rttP95: rtt.n ? rtt.pct(0.95) : null });
      }
    }
    this.series.push(row);
    this.S = this._emptySec();
    this.emit('tick', { row, totals: this._totals() });
    if (this.drainUntil && (t >= this.drainUntil || this.active === 0)) this._finish();
  }

  _totals() {
    const secs = ((this.sendEnd || now()) - this.t0) / 1000;
    const T = { ...this.G, scenario: this.t.scenario, bound: this.ua ? this.ua.upCount() : 0, secs, avgTps: this.G.sent / Math.max(secs, 0.001), active: this.active,
      lat: this.latAll.summary(), errs: { ...this.G.errs } };
    if (this.t.scenario === 'call') Object.assign(T, { ans: this.ansAll.summary(), t100: this.t100All.summary(), bye: this.byeAll.summary(), jitter: this.jitAll.summary(), rtt: this.rttAll.summary(),
      rtpLossPct: this.G.rtpExpected ? this.G.rtpLost / this.G.rtpExpected * 100 : null, asr: this.G.sent ? this.G.ok / this.G.sent * 100 : null });
    if (this.e2e) { const E = this.e2e; T.e2e = { sent: E.sent, reached: E.reached, missing: Math.max(0, E.sent - E.reached), dup: E.dup, unmatched: E.unmatched, lat: this.e2eAll.summary(), digits: E.k,
      trunks: E.trunks.map(x => x ? { ...x } : { att: 0, acc: 0, rej: 0 }), failover: E.fo, allRejected: E.allRej, foLat: this.foAll.summary() }; }
    return T;
  }

  _finishSending() {
    if (this.drainUntil) return;
    this._event('sendEnd', this.t.scenario === 'call' ? 'No new calls; waiting for active calls to finish' : 'Sending finished, waiting for responses');
    this.sendEnd = now();
    clearInterval(this.tick); this.tick = null;
    const T = this.t;
    this.drainUntil = now() + (T.scenario === 'call' ? T.maxRing + T.holdMax + T.respTimeout + 2000 : T.respTimeout + 1000);
    this.emit('phase', { phase: 'draining', ...msg(T.scenario === 'call' ? 'Waiting for {n} active calls to finish…' : 'Waiting for responses…', { n: this.active }) });
  }

  // Hang up every active call now (second press of Stop)
  _hangupAll() {
    this.forceEnd = true;
    this._event('hangupAll', 'Hanging up {n} active calls', { n: this.active });
    for (const c of this.calls.values()) { clearTimeout(c.holdTimer); c.hangup(); }
    this.drainUntil = Math.min(this.drainUntil, now() + this.t.respTimeout + 1000);
    this.emit('phase', { phase: 'draining', ...msg('Hanging up {n} active calls…', { n: this.active }) });
  }

  _finish() {
    clearInterval(this.secTimer); this.secTimer = null;
    const totals = this._totals();
    this._event('done', 'Test finished');
    this._cleanup();
    this.running = false; this.drainUntil = null; this.sendEnd = null; this.forceEnd = false;
    const T = this.t;
    this.emit('done', { totals, series: this.series, events: this.events, startedAt: this.startedAt, endedAt: Date.now(),
      test: { ...T, users: T.users.length ? `${T.users[0]}…${T.users.at(-1)} (${T.users.length})` : '', respTimeout: T.respTimeout / 1000, maxRing: T.maxRing / 1000, holdMin: T.holdMin / 1000, holdMax: T.holdMax / 1000, tps: T.rate } });
    this.emit('phase', { phase: 'done', ...msg('Done') });
  }

  stop() {
    if (!this.running) return;
    if (this.binding) { this.aborted = true; this.emit('phase', { phase: 'error', ...msg('Stopped while connecting') }); return; }
    if (this.tick) this._finishSending();
    else if (this.t.scenario === 'call' && !this.forceEnd && this.active) this._hangupAll();
    else this.drainUntil = now();
  }

  _cleanup() {
    this.stopping = true;
    clearInterval(this.tick); clearInterval(this.rtpTimer); this.tick = null;
    for (const c of (this.calls || new Map()).values()) { clearTimeout(c.holdTimer); clearTimeout(c.ringTimer); }
    this.calls = new Map();
    try { this.ua && this.ua.close(); } catch {}
    try { this.pool && this.pool.close(); } catch {}
    this.ua = null; this.pool = null; this.stopping = false;
  }
}

module.exports = { LoadEngine, parseUsers };
