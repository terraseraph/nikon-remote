// Offline speech-to-text for voice commands. The page records each spoken phrase and posts it here
// as 16 kHz mono WAV; Whisper (whisper.cpp's server) or Windows' own recogniser turns it into text.
// Either one starts on first use and stays running.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { availableParallelism } from 'node:os';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { voicePhrases, FREE_TEXT } from '../public/triggers/phrases.js';

// In the packaged desktop app these sit beside app.asar, where they can be run and read.
const unpacked = rel => fileURLToPath(new URL(rel, import.meta.url)).replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
const WHISPER = unpacked('../engines/whisper/whisper-server.exe');
const WHISPER_MODEL = unpacked('../engines/whisper/ggml-base.en-q5_1.bin');
const WINDOWS = unpacked('../bridge/speech.ps1');
// Words Whisper should expect. It steers spelling ("Inspo", "ISO 800") without limiting what it hears.
const PROMPT = 'Shoot. Focus. Timer five. Burst three. ISO 800. Preset two. Brighter. Darker. Cancel. Inspo moody couple.';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export const voiceEngines = () => ({ whisper: existsSync(WHISPER) && existsSync(WHISPER_MODEL), windows: process.platform === 'win32' });

const freePort = () => new Promise((resolve, reject) => {
  const s = createServer().once('error', reject).listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

let whisper = null; // promise of { port, proc }
function startWhisper() {
  if (!voiceEngines().whisper) return Promise.reject(new Error('Whisper isn’t installed: run npm run vendor'));
  whisper ??= (async () => {
    const port = await freePort();
    const threads = Math.max(1, Math.min(8, availableParallelism() - 2));
    // A 768-frame audio window (15 s) instead of Whisper's 30 s: commands come back about 2.5× sooner,
    // and a phrase never runs longer (the page cuts them at 12 s). -sns drops "(music)"-style tokens.
    const proc = spawn(WHISPER, ['-m', WHISPER_MODEL, '--port', String(port), '-t', String(threads), '-ac', '768', '-nt', '-sns'],
      { stdio: 'ignore', windowsHide: true });
    let exited = false;
    proc.once('exit', () => { exited = true; whisper = null; });
    for (let i = 0; i < 150 && !exited; i++) {
      try { await fetch(`http://127.0.0.1:${port}/`); return { port, proc }; } catch { await sleep(200); }
    }
    proc.kill();
    throw new Error('Whisper didn’t start');
  })().catch(e => { whisper = null; throw e; });
  return whisper;
}

async function whisperText(wav) {
  const { port } = await startWhisper();
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'phrase.wav');
  form.append('response_format', 'json');
  form.append('temperature', '0');
  form.append('prompt', PROMPT);
  const res = await fetch(`http://127.0.0.1:${port}/inference`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Whisper: HTTP ${res.status}`);
  const { text = '' } = await res.json();
  // Non-speech comes back as a label ("[BLANK_AUDIO]", "(wind blowing)") rather than nothing.
  const t = text.replace(/\[[^\]]*\]|\([^)]*\)/g, '').trim();
  return t ? [t] : [];
}

let windows = null; // { proc, pending: Map(id → resolve), next }
function startWindows() {
  if (windows) return windows;
  const proc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WINDOWS], { windowsHide: true });
  const pending = new Map();
  createInterface({ input: proc.stdout }).on('line', line => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    pending.get(m.id)?.(m);
    pending.delete(m.id);
  });
  let err = '';
  proc.stderr.on('data', d => { err += d; });
  proc.once('exit', () => {
    windows = null;
    const error = err.trim().split('\n')[0] || 'Windows speech recognition stopped';
    for (const done of pending.values()) done({ error });
  });
  // The script's first line in: the phrases to listen for.
  proc.stdin.write(JSON.stringify({ phrases: voicePhrases(), freeText: FREE_TEXT }) + '\n');
  return (windows = { proc, pending, next: 1 });
}

async function windowsText(wav) {
  const w = startWindows();
  const id = w.next++;
  const m = await new Promise(resolve => {
    w.pending.set(id, resolve);
    w.proc.stdin.write(JSON.stringify({ id, wav: wav.toString('base64') }) + '\n');
  });
  if (m.error) throw new Error(m.error);
  return m.texts;
}

// Text guesses for one phrase, best first; empty when nothing was said.
export function transcribe(engine, wav) {
  if (engine === 'whisper') return whisperText(wav);
  if (engine === 'windows') return windowsText(wav);
  return Promise.reject(new Error(`Unknown voice engine: ${engine}`));
}

export function stopVoice() {
  whisper?.then(w => w.proc.kill(), () => {});
  windows?.proc.kill();
}
