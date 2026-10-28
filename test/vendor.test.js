// Built-in vendor (trunk) and end-to-end tracking. Without a PBX in between, the client calls the vendor directly
// and the vendor's arrivals are fed back to the engine, exactly as the apps do through the main process.
const test = require('node:test');
const assert = require('node:assert');
const { fork } = require('child_process');
const path = require('path');
const { MockVendor } = require('../mock-vendor');
const { SipUA, Call } = require('../sip-core');
const { analyze } = require('../ui/analysis');
const root = path.join(__dirname, '..');

// Vendor and load engine in their own processes, arrivals forwarded like main.js / server.js do
function runE2e(vopts, test, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const v = fork(path.join(root, 'mock-worker.js'), [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    let w, stats = null;
    const timer = setTimeout(() => { v.kill(); w && w.kill(); reject(new Error('timed out')); }, timeoutMs);
    v.on('message', m => {
      if (m.type === 'stats') stats = m.stats;
      else if (m.type === 'arrivals' && w) w.send({ type: 'arrivals', list: m.list });
      else if (m.type === 'error') { clearTimeout(timer); v.kill(); reject(new Error(m.text)); }
      else if (m.type === 'started') {
        w = fork(path.join(root, 'load-worker.js'), [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
        w.on('message', x => {
          if (x.type === 'phase' && x.phase === 'error') { clearTimeout(timer); v.kill(); w.kill(); resolve({ error: x }); }
          if (x.type === 'done') { clearTimeout(timer); setTimeout(() => { v.kill(); w.kill(); resolve({ done: x, stats }); }, 300); }
        });
        w.send({ type: 'start', cfg: { host: '127.0.0.1', port: m.port }, test });
      }
    });
    v.send({ type: 'start', opts: { host: '127.0.0.1', port: 0, transports: ['udp'], ...vopts } });
  });
}

test('end to end: every call reaches the vendor, routing latency measured', async () => {
  const r = await runE2e({ answerMs: 20 }, { scenario: 'call', rate: 50, duration: 3, holdMin: 0.3, holdMax: 0.3, dst: '8XXXXXX', e2e: true, ramp: 0 });
  const E = r.done.totals.e2e;
  assert.ok(E.sent >= 140, `sent ${E.sent}`);
  assert.equal(E.reached, E.sent); assert.equal(E.missing, 0); assert.equal(E.dup, 0); assert.equal(E.unmatched, 0);
  assert.ok(E.lat.n === E.sent && E.lat.p95 < 50, `routing p95 ${E.lat.p95}`);
  assert.ok(r.done.series.some(row => row.e2eP95 != null));
  const a = analyze({ test: r.done.test, totals: r.done.totals, series: r.done.series, events: r.done.events });
  assert.ok(a.findings.some(f => /All \d+ calls reached the vendor/.test(f.text)));
});

test('end to end: calls the vendor never sees are counted as not reached', async () => {
  const r = await runE2e({ dropPct: 100 }, { scenario: 'call', rate: 10, duration: 1, dst: '8XXXXXX', e2e: true, respTimeout: 2, ramp: 0 });
  const E = r.done.totals.e2e;
  assert.ok(E.sent >= 8); assert.equal(E.reached, 0); assert.equal(E.missing, E.sent);
});

test('end to end: destination needs trailing X', async () => {
  const r = await runE2e({}, { scenario: 'call', rate: 1, duration: 1, dst: '8123', e2e: true });
  assert.match(r.error.text, /at least 4 X/);
});

test('vendor: trunk digest auth, channel limit and its own BYE', async () => {
  const v = await new MockVendor({ port: 0, transports: ['udp'], user: 'trunk', password: 'pw', maxChannels: 1, hangupAfterMs: 300 }).start();
  const ua = await new SipUA({ host: '127.0.0.1', port: v.port }).open();
  const calls = new Map(); ua.handler = m => { const c = calls.get(m.callId); if (c) { c.onRequest(m); return true; } };
  const call = (password, user = 'trunk') => new Promise(r => { const c = new Call({ ua, dst: '81234567', user, password }, { onAnswer: () => r.answered = true, onEnd: (k, why) => r({ why, status: k.status, k }) }); calls.set(c.callId, c); c.start(); });
  try {
    const bad = await call('wrong');
    assert.equal(bad.status, 407, 'wrong password is challenged again and fails');
    const [a, b] = await Promise.all([call('pw'), new Promise(r => setTimeout(r, 80)).then(() => call('pw'))]);
    assert.equal(a.why, 'remoteBye', 'vendor hung up after 300 ms');
    assert.equal(b.status, 503, 'second call hit the 1-channel limit');
    assert.equal(v.stats.full, 1); assert.equal(v.stats.byesSent, 1);
  } finally { ua.close(); v.stop(); }
});

test('vendor: port already in use is reported', async () => {
  const a = await new MockVendor({ port: 0, transports: ['udp'] }).start();
  await assert.rejects(new MockVendor({ port: a.port, transports: ['udp'] }).start(), e => e.key === 'Port {port} is already in use');
  a.stop();
});

test('end to end: several trunks, failover and duplicates are told apart', () => {
  const { LoadEngine } = require('../load-engine');
  const { Hist } = require('../hist');
  const e = new LoadEngine();
  Object.assign(e, { running: true, flags: {}, events: [], e2eAll: new Hist(), foAll: new Hist(), S: e._emptySec() });
  e.e2e = { k: 4, mod: 1e4, seq: 0, pend: new Map(), sent: 0, reached: 0, dup: 0, unmatched: 0, trunks: [], fo: 0, foOk: 0, allRej: 0 };
  const t0 = 1000;
  for (const id of ['0001', '0002', '0003', '0004']) { e.e2e.pend.set(id, { t0, n: 0 }); e.e2e.sent++; }
  e.addArrivals([
    ['80001', t0 + 10, 0, 0],                             // taken by A
    ['80002', t0 + 12, 0, 503], ['80002', t0 + 40, 1, 0], // A full → B took it: failover, 28 ms
    ['80003', t0 + 15, 0, 503], ['80003', t0 + 30, 1, 486], // rejected everywhere
    ['80004', t0 + 11, 0, 0], ['80004', t0 + 50, 1, 0],   // taken twice: a real duplicate
    ['89999', t0 + 5, 0, 0],                              // not ours
  ]);
  const E = e.e2e;
  assert.equal(E.reached, 4); assert.equal(E.fo, 1); assert.equal(E.dup, 1); assert.equal(E.allRej, 1); assert.equal(E.unmatched, 1);
  assert.deepEqual(E.trunks, [{ att: 4, acc: 2, rej: 2 }, { att: 3, acc: 2, rej: 1 }]);
  assert.equal(e.foAll.summary().p50 | 0, 28);
  assert.equal(e.e2eAll.summary().n, 4, 'routing delay is measured once per call, on its first arrival');
});

test('vendor worker: two trunks on their own ports, arrivals carry trunk and outcome', async () => {
  const v = fork(path.join(root, 'mock-worker.js'), [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const got = []; let stats = null;
  const started = await new Promise((res, rej) => {
    v.on('message', m => { if (m.type === 'started') res(m); else if (m.type === 'error') rej(new Error(m.text)); else if (m.type === 'arrivals') got.push(...m.list); else if (m.type === 'stats') stats = m.stats; });
    v.send({ type: 'start', opts: { host: '127.0.0.1', transports: ['udp'], trunks: [{ port: 0, maxChannels: 1, answerMs: 0 }, { port: 0, answerMs: 0 }] } });
  });
  const uas = await Promise.all(started.ports.map(port => new SipUA({ host: '127.0.0.1', port }).open())); // one per trunk, like a PBX with two trunks
  const calls = new Map(); for (const ua of uas) ua.handler = m => { const c = calls.get(m.callId); if (c) { c.onRequest(m); return true; } };
  const call = (i, dst) => new Promise(r => { const c = new Call({ ua: uas[i], dst, user: 'u' }, { onEnd: k => r(k.status) }); calls.set(c.callId, c); c.start(); });
  try {
    assert.equal(started.ports.length, 2); assert.notEqual(started.ports[0], started.ports[1]);
    call(0, '80001');                            // A takes it and keeps its only channel
    await new Promise(r => setTimeout(r, 100));
    assert.equal(await call(0, '80002'), 503);   // A is full
    call(1, '80002');                            // the "PBX" fails over to B
    await new Promise(r => setTimeout(r, 1300));
    const mine = got.map(([u, , tr, code]) => [u, tr, code]);
    assert.deepEqual(mine, [['80001', 0, 0], ['80002', 0, 503], ['80002', 1, 0]]);
    assert.ok(stats && stats.trunks && stats.trunks.length === 2, 'stats per trunk');
  } finally { uas.forEach(u => u.close()); v.kill(); }
});
