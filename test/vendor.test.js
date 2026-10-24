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
