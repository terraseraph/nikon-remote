// Offline voice engines. PhraseListener cuts the microphone into spoken phrases (16 kHz mono);
// each engine turns a phrase into text guesses, best first:
//   whisper, windows: posted to the laptop (src/voice.js), so a phone on the tunnel can use them too
//   vosk: runs in this page as WebAssembly, listening for the fixed phrase list
import { voicePhrases, FREE_TEXT } from './phrases.js';

const RATE = 16000;
const FRAME = 1024;                         // 64 ms at 16 kHz
const START_FRAMES = 2;                     // this many loud frames in a row start a phrase
const END_FRAMES = 10;                      // 640 ms of quiet ends it
const PRE_ROLL = 5;                         // keep 320 ms from before it started, for soft first sounds
const MIN_FRAMES = 4;                       // shorter than 256 ms is a knock, not a word
const MAX_FRAMES = Math.floor(12 * RATE / FRAME); // Whisper listens to 15 s at most

export class PhraseListener {
  constructor({ onPhrase, onLevel = () => {} }) {
    Object.assign(this, { onPhrase, onLevel });
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true } })
      .catch(() => { throw new Error('Microphone permission was blocked for this page'); });
    // The browser resamples the mic to 16 kHz, the rate every engine wants.
    this.ctx = new AudioContext({ sampleRate: RATE });
    const src = this.ctx.createMediaStreamSource(this.stream);
    // ScriptProcessor is deprecated but works everywhere this runs, without a separate worklet file.
    this.proc = this.ctx.createScriptProcessor(FRAME, 1, 1);
    this.proc.onaudioprocess = e => this.frame(new Float32Array(e.inputBuffer.getChannelData(0)));
    src.connect(this.proc);
    this.proc.connect(this.ctx.destination); // outputs silence; it only runs while connected
    this.floor = 0.005; this.loud = 0; this.quiet = 0; this.recent = []; this.phrase = null;
  }

  stop() {
    this.proc?.disconnect();
    this.stream?.getTracks().forEach(t => t.stop());
    this.ctx?.close();
    this.proc = this.stream = this.ctx = this.phrase = null;
    this.onLevel(0);
  }

  frame(f) {
    let sum = 0;
    for (const v of f) sum += v * v;
    const rms = Math.sqrt(sum / f.length);
    this.onLevel(rms);
    // Speech is well above the room's background, which is tracked while nobody is talking.
    const speaking = rms > Math.max(this.floor * 3, 0.01);
    if (!this.phrase) {
      this.recent.push(f);
      if (this.recent.length > PRE_ROLL + START_FRAMES) this.recent.shift();
      this.loud = speaking ? this.loud + 1 : 0;
      if (!speaking) this.floor = this.floor * 0.95 + rms * 0.05;
      if (this.loud >= START_FRAMES) { this.phrase = this.recent; this.recent = []; this.quiet = 0; }
      return;
    }
    this.phrase.push(f);
    this.quiet = rms > Math.max(this.floor * 2, 0.008) ? 0 : this.quiet + 1;
    if (this.quiet >= END_FRAMES || this.phrase.length >= MAX_FRAMES) {
      const frames = this.phrase;
      this.phrase = null; this.loud = 0;
      if (frames.length - PRE_ROLL - this.quiet >= MIN_FRAMES) this.onPhrase(join(frames));
    }
  }
}

function join(frames) {
  const out = new Float32Array(frames.length * FRAME);
  frames.forEach((f, i) => out.set(f, i * FRAME));
  return out;
}

// 16-bit PCM WAV, what whisper-server and Windows' recogniser read.
export function wav(samples) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true));
  return new Blob([buf], { type: 'audio/wav' });
}

// Whisper or Windows, on the laptop.
export const laptopEngine = engine => ({
  async load() {
    const r = await fetch('/api/voice').then(r => r.json()).catch(() => ({}));
    if (!r[engine]) throw new Error(engine === 'whisper' ? 'Whisper isn’t installed on the laptop' : 'Windows speech needs the app running on Windows');
    // Half a second of silence starts the engine now, rather than on the first command.
    await this.transcribe(new Float32Array(RATE / 2));
  },
  async transcribe(samples) {
    const res = await fetch(`/api/voice/transcribe?engine=${engine}`, { method: 'POST', body: wav(samples) });
    const r = await res.json();
    if (r.error) throw new Error(r.error);
    return r.texts;
  },
});

const VOSK_MODEL = '/vendor/vosk/vosk-model-small-en-us-0.15.tar.gz';
let voskModel;

// Vosk in the page. One recogniser knows only the command phrases, which makes it much harder to
// mishear; a second, free one catches "inspo …" requests.
export const voskEngine = () => ({
  async load() {
    voskModel ??= (async () => {
      if (!window.Vosk) await new Promise((resolve, reject) => {
        const sc = Object.assign(document.createElement('script'), { src: '/vendor/vosk/vosk.js', onload: resolve });
        sc.onerror = () => reject(new Error('Vosk isn’t installed'));
        document.head.append(sc);
      });
      return window.Vosk.createModel(VOSK_MODEL);
    })().catch(e => { voskModel = null; throw e; });
    this.model = await voskModel;
    this.means = new Map(voicePhrases().map(p => [p.say, p.means]));
  },
  async transcribe(samples) {
    const [cmd, heard] = await Promise.all([
      voskText(this.model, samples, JSON.stringify([...this.means.keys(), '[unk]'])),
      voskText(this.model, samples),
    ]);
    // The small model has no "inspo": it hears "in spell", "in spa"…
    const free = heard.replace(/^in ?sp\w*/, 'inspo');
    if (FREE_TEXT.some(w => free.startsWith(`${w} `))) return [free];
    // The command recogniser only says listed phrases, or a piece of one when it's unsure.
    return [this.means.get(cmd), free].filter(Boolean);
  },
});

// One phrase through a fresh recogniser. Vosk may split it at a pause, so the text is every result
// it gives up to the final one, which comes last.
function voskText(model, samples, grammar) {
  const rec = grammar ? new model.KaldiRecognizer(RATE, grammar) : new model.KaldiRecognizer(RATE);
  return new Promise(resolve => {
    const parts = [];
    let settle;
    const done = () => { rec.remove(); resolve(parts.join(' ').replace(/\[unk\]/g, '').trim()); };
    rec.on('result', m => {
      if (m.result.text) parts.push(m.result.text);
      clearTimeout(settle);
      settle = setTimeout(done, 150);
    });
    rec.acceptWaveformFloat(samples, RATE);
    rec.retrieveFinalResult();
    settle = setTimeout(done, 5000);
  });
}
