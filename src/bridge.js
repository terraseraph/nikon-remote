// Spawns the PowerShell camera bridge and exposes a promise-based PTP transport.
// Requests are serialised: the camera only handles one PTP transaction at a time.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

// In the packaged desktop app the script is unpacked beside app.asar, where PowerShell can read it.
const SCRIPT = fileURLToPath(new URL('../bridge/camera-bridge.ps1', import.meta.url)).replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');

export class Bridge extends EventEmitter {
  constructor() {
    super();
    this.nextId = 1;
    this.pending = new Map();
    this.queue = Promise.resolve();
    this.ready = null; // resolves to {ready, name, error}
    this.start();
  }

  start() {
    this.proc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let resolveReady;
    this.ready = new Promise(r => (resolveReady = r));
    createInterface({ input: this.proc.stdout }).on('line', line => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if ('ready' in msg) return resolveReady(msg);
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg);
    });
    this.proc.stderr.on('data', d => this.emit('log', d.toString().trim()));
    this.proc.on('exit', code => {
      resolveReady({ ready: false, error: `bridge exited (${code})` });
      for (const p of this.pending.values()) p.reject(new Error('bridge exited'));
      this.pending.clear();
      this.emit('exit', code);
    });
  }

  restart() {
    this.proc.removeAllListeners('exit');
    this.proc.kill();
    this.start();
    return this.ready;
  }

  // Low-level: send one PTP operation. dir: 'none' | 'read' | 'write'.
  send(op, params = [], { dir = 'none', data, file } = {}) {
    const run = () => new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      const req = { id, op, params, dir };
      if (data) req.data = Buffer.from(data).toString('base64');
      if (file) req.file = file;
      this.proc.stdin.write(JSON.stringify(req) + '\n');
    }).then(msg => ({ code: msg.code, data: msg.data ? Buffer.from(msg.data, 'base64') : null }));
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  stop() { this.proc.stdin.end(); }
}
