// Optional public HTTPS access through a Cloudflare Tunnel (cloudflared), started from the app.
// With CF_TUNNEL set it runs that named tunnel (stable hostname, CF_TUNNEL_URL); otherwise it
// starts a throwaway "quick tunnel" on a random trycloudflare.com address.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';

// winget puts cloudflared here, and a server started before the install won't see the new PATH.
const KNOWN_PATHS = ['C:\\Program Files (x86)\\cloudflared\\cloudflared.exe', 'C:\\Program Files\\cloudflared\\cloudflared.exe'];
const binary = () => process.env.CLOUDFLARED || KNOWN_PATHS.find(p => existsSync(p)) || 'cloudflared';

export class Tunnel extends EventEmitter {
  constructor({ port }) {
    super();
    this.port = port;
    this.name = process.env.CF_TUNNEL || '';
    this.publicUrl = (process.env.CF_TUNNEL_URL || '').replace(/\/$/, '');
    this.proc = null;
    this.status = 'off'; // off | starting | on | error
    this.url = '';
    this.error = '';
  }

  state() {
    return { mode: this.name ? 'named' : 'quick', status: this.status, url: this.url, error: this.error };
  }

  set(fields) {
    Object.assign(this, fields);
    this.emit('state', this.state());
  }

  start() {
    if (this.proc) return;
    // 127.0.0.1, not localhost: the server may be bound to IPv4 only.
    const origin = `http://127.0.0.1:${this.port}`;
    const args = this.name
      ? ['tunnel', '--no-autoupdate', 'run', '--url', origin, this.name]
      : ['tunnel', '--no-autoupdate', '--url', origin];
    this.set({ status: 'starting', url: this.name ? this.publicUrl : '', error: '' });
    const proc = (this.proc = spawn(binary(), args, { windowsHide: true }));
    let tail = '';
    const onOutput = chunk => {
      const text = chunk.toString();
      tail = (tail + text).slice(-2000);
      const quick = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(text);
      if (quick && !this.name) this.set({ url: quick[0] });
      if (/Registered tunnel connection/.test(text) && this.status === 'starting') this.set({ status: 'on' });
    };
    proc.stdout.on('data', onOutput);
    proc.stderr.on('data', onOutput);
    proc.on('error', e => {
      this.proc = null;
      this.set({ status: 'error', url: '', error: e.code === 'ENOENT' ? 'cloudflared isn\'t installed. Run: winget install Cloudflare.cloudflared' : e.message });
    });
    proc.on('exit', code => {
      if (this.proc !== proc) return;
      this.proc = null;
      if (this.status === 'off') return;
      const last = tail.trim().split('\n').filter(l => /ERR|error/i.test(l)).pop() || `cloudflared exited (code ${code})`;
      this.set({ status: 'error', url: '', error: last.replace(/^\S+\s+ERR\s+/, '').slice(0, 300) });
    });
  }

  stop() {
    const proc = this.proc;
    this.proc = null;
    this.set({ status: 'off', url: '', error: '' });
    proc?.kill();
  }
}
