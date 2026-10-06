'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, net } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const IS_WIN = process.platform === 'win32';
const USER_AGENT = `Locus/${app.getVersion()} (iOS location simulator desktop app)`;
// Only these hosts can be reached through the renderer's fetch bridge.
const ALLOWED_HOSTS = new Set(['nominatim.openstreetmap.org', 'routing.openstreetmap.de']);

let win = null;
let engine = null;
let quitting = false;
let restarts = 0;

// ---------------------------------------------------------------- engine process

function engineCommand() {
  if (app.isPackaged) {
    const exe = path.join(process.resourcesPath, 'engine', IS_WIN ? 'locus-engine.exe' : 'locus-engine');
    return { cmd: exe, args: [] };
  }
  const root = path.join(__dirname, '..');
  const py =
    process.env.LOCUS_PYTHON ||
    (IS_WIN ? path.join(root, '.venv', 'Scripts', 'python.exe') : path.join(root, '.venv', 'bin', 'python'));
  return { cmd: py, args: ['-u', path.join(root, 'engine', 'engine.py')] };
}

class Engine {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.ready = false;
    this.start();
  }

  start() {
    const { cmd, args } = engineCommand();
    this.proc = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
    });
    this.proc.on('error', (err) => {
      send('engine:event', { event: 'engine', data: { state: 'failed', message: `Could not start engine: ${err.message}` } });
    });
    readline.createInterface({ input: this.proc.stdout }).on('line', (line) => this.onLine(line));
    readline.createInterface({ input: this.proc.stderr }).on('line', (line) => {
      console.log('[engine]', line);
    });
    this.proc.on('exit', (code) => {
      this.ready = false;
      for (const { reject } of this.pending.values()) reject(new Error('Engine stopped.'));
      this.pending.clear();
      if (quitting) return;
      send('engine:event', { event: 'engine', data: { state: 'crashed', message: `Engine exited (${code}).` } });
      if (restarts++ < 3) setTimeout(() => this.start(), 1000);
    });
  }

  onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return console.log('[engine:stdout]', line);
    }
    if (msg.event) {
      if (msg.event === 'ready') {
        this.ready = true;
        restarts = 0;
      }
      return send('engine:event', msg);
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve({ ok: true, result: msg.result });
    else p.resolve({ ok: false, error: msg.error, code: msg.code });
  }

  call(method, params = {}, timeoutMs = 180000) {
    return new Promise((resolve, reject) => {
      if (!this.proc || this.proc.exitCode !== null || !this.proc.stdin.writable) {
        return resolve({ ok: false, error: 'Engine is not running.', code: 'engine_down' });
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: `${method} timed out.`, code: 'timeout' });
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  async stop(clearLocation) {
    if (!this.proc || this.proc.exitCode !== null) return;
    await Promise.race([this.call('shutdown', { clear: clearLocation }, 8000), new Promise((r) => setTimeout(r, 8000))]);
    if (this.proc.exitCode === null) this.proc.kill();
  }
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------------------------------------------------------------- window

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    title: 'Locus',
    backgroundColor: '#0f1115',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.removeMenu?.();
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  // External links open in the user's browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

// ---------------------------------------------------------------- IPC

ipcMain.handle('engine:call', (_e, method, params) => engine.call(method, params));
ipcMain.handle('engine:ready', () => engine.ready);

ipcMain.handle('net:json', async (_e, url) => {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: 'Bad URL' };
  }
  if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.hostname)) {
    return { ok: false, error: 'Host not allowed' };
  }
  try {
    const res = await net.fetch(parsed.toString(), { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, data: await res.json() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('file:openGpx', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import GPX route',
    properties: ['openFile'],
    filters: [{ name: 'GPX', extensions: ['gpx'] }],
  });
  if (canceled || !filePaths[0]) return null;
  const text = await fs.promises.readFile(filePaths[0], 'utf8');
  return { name: path.basename(filePaths[0]), text };
});

ipcMain.handle('app:info', () => ({ version: app.getVersion(), platform: process.platform }));

let clearOnQuit = true;
ipcMain.on('app:clearOnQuit', (_e, value) => {
  clearOnQuit = Boolean(value);
});

// ---------------------------------------------------------------- lifecycle

app.whenReady().then(() => {
  engine = new Engine();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());

app.on('before-quit', async (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  try {
    await engine?.stop(clearOnQuit);
  } finally {
    app.exit(0);
  }
});
