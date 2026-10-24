// Child process that hosts the built-in vendor (trunk); talks to the web server or the desktop app over IPC.
const { MockVendor } = require('./mock-vendor');
let v = null, arrivals = [], flush = null;
const send = require('./ipc-child')(async m => {
  try {
    if (m.type === 'start') {
      if (v) v.stop();
      v = new MockVendor({ ...m.opts, ui: true });
      v.on('log', x => send({ type: 'log', msg: x }));
      v.on('stats', s => send({ type: 'stats', stats: s }));
      // Arrivals (dialled number + time) are batched every 100 ms for end-to-end matching in the load engine
      v.on('arrival', a => { arrivals.push([a.user, a.at]); if (arrivals.length > 20000) arrivals.shift(); });
      clearInterval(flush); flush = setInterval(() => { if (arrivals.length) { send({ type: 'arrivals', list: arrivals }); arrivals = []; } }, 100);
      await v.start();
      send({ type: 'started', port: v.port });
    } else if (m.type === 'stop') { if (v) v.stop(); v = null; send({ type: 'stopped' }); }
  } catch (e) { send({ type: 'error', msg: e.key ? { key: e.key, p: e.p, text: e.message } : null, text: e.message }); }
});
process.on('uncaughtException', e => send({ type: 'log', msg: { text: 'Error: ' + e.message } }));
