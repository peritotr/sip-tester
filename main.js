// SIP Tester — desktop (Electron) edition: main process.
const { app, BrowserWindow, ipcMain, dialog, safeStorage, utilityProcess } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { SipClient } = require('./sip-client');
const { ReportStore, assembleReport } = require('./reports');
let reports = null;
const getReports = () => reports || (reports = new ReportStore(path.join(app.getPath('userData'), 'reports')));

let win;
const client = new SipClient();
const profilesFile = () => path.join(app.getPath('userData'), 'profiles.json');
function send(ch, data) { if (win && !win.isDestroyed()) win.webContents.send(ch, data); }

// Interactive client events → UI (the message log is batched every 50 ms)
let logBuf = [];
setInterval(() => { if (logBuf.length) { send('sip:log', logBuf); logBuf = []; } }, 50);
client.on('log', e => { logBuf.push(e); if (logBuf.length > 3000) logBuf.shift(); });
for (const ev of ['state', 'reg', 'call', 'batch']) client.on(ev, d => send('sip:' + ev, d));
const errOf = e => ({ ok: false, error: e.key ? { key: e.key, p: e.p, text: e.message } : e.message });

// ---------- Load engine in its own process (own CPU core; the UI can't slow the measurement down) ----------
let loadProc = null, loadSeries = [], loadReq = null;
function getLoad() {
  if (loadProc) return loadProc;
  loadProc = utilityProcess.fork(path.join(__dirname, 'load-worker.js'), [], { serviceName: 'load-worker', stdio: 'ignore' });
  loadProc.on('message', m => {
    if (m.type === 'tick' && m.row) { loadSeries.push(m.row); if (loadSeries.length > 86400) loadSeries.shift(); }
    if (m.type === 'done' || (m.type === 'phase' && m.phase === 'error')) e2eActive = false;
    send('load:' + m.type, m);
    if (m.type === 'done') {
      try { send('report:saved', getReports().save(assembleReport({ done: m, req: loadReq, series: loadSeries, vendor: loadVendor, app: 'sip-tester-desktop' }))); }
      catch (e) { send('load:log', { text: 'Could not save the report: ' + e.message }); }
    }
  });
  loadProc.on('exit', () => { loadProc = null; send('load:phase', { phase: 'error', text: 'The load engine process exited', key: 'The load engine process exited' }); });
  return loadProc;
}

// ---------- Built-in vendor (trunk) in its own process ----------
let mockProc = null, mockOpts = null, e2eActive = false, loadVendor = null;
function startMock(opts) {
  return new Promise(resolve => {
    if (mockProc) mockProc.kill();
    const p = mockProc = utilityProcess.fork(path.join(__dirname, 'mock-worker.js'), [], { serviceName: 'mock-worker', stdio: 'ignore' });
    p.on('message', m => {
      if (m.type === 'log') send('mock:log', m.msg);
      else if (m.type === 'stats') send('mock:stats', m.stats);
      else if (m.type === 'arrivals') { if (e2eActive && loadProc) loadProc.postMessage({ type: 'arrivals', list: m.list }); }
      else if (m.type === 'started') { p.started = true; mockOpts = { ...opts, password: undefined, port: m.port }; send('mock:state', { on: true, opts: mockOpts }); resolve({ ok: true }); }
      else if (m.type === 'error') { if (!p.started) { p.kill(); if (mockProc === p) mockProc = null; resolve({ ok: false, error: m.msg || m.text }); } else send('mock:log', m.msg || { text: m.text }); }
    });
    p.on('exit', () => { if (mockProc === p) { mockProc = null; mockOpts = null; send('mock:state', { on: false }); } });
    p.on('spawn', () => p.postMessage({ type: 'start', opts }));
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 920, minWidth: 1080, minHeight: 680, title: 'SIP Tester',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default', backgroundColor: '#0f1115',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
}

ipcMain.handle('sip:connect', async (_, cfg) => { try { await client.connect(cfg); return { ok: true }; } catch (e) { return errOf(e); } });
ipcMain.handle('sip:disconnect', () => { client.disconnect(); return { ok: true }; });
ipcMain.handle('sip:options', async () => { try { return await client.options(); } catch (e) { return errOf(e); } });
ipcMain.handle('sip:register', async (_, exp) => { try { return await client.register(exp); } catch (e) { return errOf(e); } });
ipcMain.handle('sip:call', (_, m) => { try { return client.call(m); } catch (e) { return errOf(e); } });
ipcMain.handle('sip:hangup', (_, id) => client.hangup(id));
ipcMain.handle('sip:hangupAll', () => client.hangupAll());

ipcMain.handle('load:start', (_, cfg, test) => {
  loadSeries = []; loadReq = { cfg: { ...cfg, password: undefined }, test: { ...test, passTpl: undefined } };
  e2eActive = !!(test && test.e2e && mockProc); loadVendor = mockOpts ? { ...mockOpts } : null;
  getLoad().postMessage({ type: 'start', cfg, test }); return { ok: true };
});
ipcMain.handle('load:stop', () => { if (loadProc) loadProc.postMessage({ type: 'stop' }); return { ok: true }; });
ipcMain.handle('load:kill', () => { if (loadProc) loadProc.kill(); return { ok: true }; });

ipcMain.handle('mock:start', (_, o) => startMock(o || {}));
ipcMain.handle('mock:stop', () => { if (mockProc) { mockProc.kill(); mockProc = null; mockOpts = null; send('mock:state', { on: false }); send('mock:log', { key: 'Vendor stopped', text: 'Vendor stopped' }); } return { ok: true }; });
ipcMain.handle('sys:ips', () => Object.entries(os.networkInterfaces()).flatMap(([name, list]) =>
  (list || []).filter(i => i.family === 'IPv4' && !i.internal).map(i => ({ name, address: i.address }))));
ipcMain.handle('reports:list', () => getReports().list());
ipcMain.handle('reports:get', (_, id) => getReports().get(id));
ipcMain.handle('reports:delete', (_, id) => getReports().remove(id));
ipcMain.handle('reports:rename', (_, id, name) => getReports().rename(id, name));
ipcMain.handle('report:open', (_, id) => {
  const w = new BrowserWindow({ width: 1180, height: 900, title: 'Test report', backgroundColor: '#ffffff',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  w.loadFile(path.join(__dirname, 'ui', 'report.html'), { query: { id: String(id) } });
  return true;
});
ipcMain.handle('report:pdf', async (e, name) => {
  const wc = e.sender, w2 = BrowserWindow.fromWebContents(wc);
  const r = await dialog.showSaveDialog(w2, { defaultPath: name || 'sip-test-report.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  if (r.canceled || !r.filePath) return false;
  const pdf = await wc.printToPDF({ printBackground: true, pageSize: 'A4', margins: { marginType: 'default' } });
  fs.writeFileSync(r.filePath, pdf); return r.filePath;
});

// Profiles live in userData/profiles.json; passwords are encrypted with the OS keychain (safeStorage)
const canEnc = () => { try { return safeStorage.isEncryptionAvailable(); } catch { return false; } };
ipcMain.handle('profiles:load', () => {
  try {
    return JSON.parse(fs.readFileSync(profilesFile(), 'utf8')).map(p => {
      if (p.passwordEnc && canEnc()) { try { p.password = safeStorage.decryptString(Buffer.from(p.passwordEnc, 'base64')); } catch { p.password = ''; } }
      delete p.passwordEnc; return p;
    });
  } catch { return []; }
});
ipcMain.handle('profiles:save', (_, list) => {
  const out = list.map(p => { const q = { ...p }; if (q.password && canEnc()) { q.passwordEnc = safeStorage.encryptString(q.password).toString('base64'); delete q.password; } return q; });
  fs.writeFileSync(profilesFile(), JSON.stringify(out, null, 2)); return true;
});
ipcMain.handle('file:save', async (_, text, name) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: name });
  if (r.canceled || !r.filePath) return false;
  fs.writeFileSync(r.filePath, text); return r.filePath;
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { client.disconnect(); if (loadProc) loadProc.kill(); if (mockProc) mockProc.kill(); setTimeout(() => app.quit(), 400); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
