// Child process that hosts the built-in vendor (trunk); talks to the web server or the desktop app over IPC.
// One vendor can run several trunks side by side (A, B, …), each on its own port with its own behaviour, so a PBX
// can be tested with a primary and a backup carrier. opts.trunks = [{ port, maxChannels, … }, …]; without it,
// opts itself is the single trunk.
const { MockVendor } = require('./mock-vendor');
const NAMES = 'ABCD';
let vs = [], arrivals = [], flush = null, statT = null, last = [];

const SUM = ['invites', 'answered', 'rejected503', 'full', 'busy', 'failed', 'dropped', 'registers', 'registered', 'challenges', 'options',
  'byes', 'byesSent', 'acks', 'cancels', 'rtpIn', 'rtpOut', 'retransIn', 'active', 'invPs', 'ansPs', 'rejPs', 'rtpPps', 'queue', 'conns'];

function stopAll() {
  for (const v of vs) try { v.stop(); } catch {}
  vs = []; last = [];
  clearInterval(flush); clearInterval(statT);
}

const send = require('./ipc-child')(async m => {
  try {
    if (m.type === 'start') {
      stopAll();
      const { trunks, ...base } = m.opts || {};
      const list = Array.isArray(trunks) && trunks.length ? trunks.slice(0, NAMES.length) : [base];
      let maxActive = 0;
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        // Shared: listen address, advertised IP and transports. A trunk without a port takes the next one up.
        const port = Number(t.port) || (i && vs[i - 1].port + 1) || base.port || 0;
        const v = new MockVendor({ ...t, host: base.host, ip: base.ip, transports: base.transports, port, trunk: i, ui: true });
        v.on('log', x => send({ type: 'log', msg: list.length > 1 ? { ...x, trunk: NAMES[i] } : x }));
        v.on('stats', s => { last[i] = s; });
        // Arrivals (dialled number, time, trunk, outcome) are batched every 100 ms for end-to-end matching in the load engine
        v.on('arrival', a => { arrivals.push([a.user, a.at, i, a.code]); if (arrivals.length > 20000) arrivals.shift(); });
        try { await v.start(); }
        catch (e) { if (list.length > 1) { e.trunk = NAMES[i]; e.message = `${NAMES[i]}: ${e.message}`; } throw e; }
        vs.push(v);
      }
      flush = setInterval(() => { if (arrivals.length) { send({ type: 'arrivals', list: arrivals }); arrivals = []; } }, 100);
      // One stats message a second: the sum over all trunks, plus each trunk on its own
      statT = setInterval(() => {
        if (!last.length) return;
        const tot = {}; for (const k of SUM) tot[k] = last.reduce((a, s) => a + ((s && s[k]) || 0), 0);
        if (tot.active > maxActive) maxActive = tot.active;
        tot.maxActive = maxActive;
        if (vs.length > 1) tot.trunks = last.map((s, i) => ({ name: NAMES[i], port: vs[i].port, ...s }));
        send({ type: 'stats', stats: tot });
      }, 1000);
      send({ type: 'started', port: vs[0].port, ports: vs.map(v => v.port) });
    } else if (m.type === 'stop') { stopAll(); send({ type: 'stopped' }); }
  } catch (e) {
    stopAll();
    send({ type: 'error', msg: e.key ? { key: e.key, p: e.p, text: e.message, trunk: e.trunk } : null, text: e.message });
  }
});
process.on('uncaughtException', e => send({ type: 'log', msg: { text: 'Error: ' + e.message } }));
