// Clap-to-shoot: watches the microphone for a sharp loud transient. Runs fully offline.

const COOLDOWN_MS = 1500;

export class ClapTrigger {
  constructor({ onClap, onLevel, getSensitivity }) {
    Object.assign(this, { onClap, onLevel, getSensitivity });
    this.quietUntil = 0;
  }

  // Ignore the mic for a while, e.g. while our own beeps or the camera's shutter make noise.
  quiet(ms) { this.quietUntil = Math.max(this.quietUntil, performance.now() + ms); }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
      .catch(() => { throw new Error('Microphone permission was blocked'); });
    this.ctx = new AudioContext();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.ctx.createMediaStreamSource(this.stream).connect(this.analyser);
    this.buf = new Float32Array(this.analyser.fftSize);
    this.background = 0.01;
    this.active = true;
    this.loop();
  }

  stop() {
    this.active = false;
    this.stream?.getTracks().forEach(t => t.stop());
    this.ctx?.close();
    this.onLevel(0);
  }

  loop() {
    if (!this.active) return;
    this.analyser.getFloatTimeDomainData(this.buf);
    let peak = 0, sum = 0;
    for (const v of this.buf) { const a = Math.abs(v); if (a > peak) peak = a; sum += v * v; }
    const rms = Math.sqrt(sum / this.buf.length);
    this.onLevel(peak);

    const s = this.getSensitivity();              // 1 (hard) … 10 (easy)
    const threshold = 0.9 - s * 0.07;              // absolute peak needed
    const now = performance.now();
    // A clap is loud and much sharper than the room's background level.
    if (now > this.quietUntil && peak > threshold && peak > this.background * 8) {
      this.quietUntil = now + COOLDOWN_MS;
      this.onClap();
    }
    this.background = this.background * 0.95 + rms * 0.05;
    requestAnimationFrame(() => this.loop());
  }
}
