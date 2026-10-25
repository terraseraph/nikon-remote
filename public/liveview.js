// Reads the server's MJPEG stream with fetch and paints frames onto a canvas.
// More robust than <img src=mjpeg>: we see every frame, can reconnect on stalls, and
// other code (gesture recognition) can read the canvas directly.

const STALL_MS = 3000;

export class LiveView {
  constructor(canvas, { url = '/api/liveview.mjpg', onFrame } = {}) {
    this.onFrame = onFrame; // (liveView) => void, after each painted frame
    this.af = null;         // camera focus box {x, y, w, h} as fractions of the frame
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.url = url;
    this.running = false;
    this.lastFrame = 0;
    this.frames = 0;
  }

  get hasFrame() { return this.frames > 0; }

  start() {
    if (this.running) return;
    this.running = true;
    this.connect();
    this.watchdog = setInterval(() => {
      if (this.running && performance.now() - this.lastFrame > STALL_MS) this.reconnect();
    }, 1000);
  }

  stop() {
    this.running = false;
    clearInterval(this.watchdog);
    this.abort?.abort();
  }

  reconnect() {
    this.abort?.abort();
    this.lastFrame = performance.now(); // give the new connection time before the watchdog fires again
    this.connect();
  }

  async connect() {
    const abort = (this.abort = new AbortController());
    this.lastFrame = performance.now();
    try {
      const res = await fetch(`${this.url}?t=${Date.now()}`, { signal: abort.signal, cache: 'no-store' });
      const reader = res.body.getReader();
      let buf = new Uint8Array(0);
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf = concat(buf, value);
        let frame;
        while ((frame = nextFrame(buf))) {
          buf = buf.subarray(frame.end);
          if (frame.af) this.af = frame.af;
          this.paint(frame.jpeg);
        }
      }
    } catch {}
    if (this.running && this.abort === abort) setTimeout(() => this.abort === abort && this.reconnect(), 500);
  }

  async paint(jpeg) {
    this.lastFrame = performance.now();
    if (!jpeg || this.decoding) return; // drop frames rather than fall behind
    this.decoding = true;
    try {
      const bmp = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
      if (this.canvas.width !== bmp.width || this.canvas.height !== bmp.height) {
        this.canvas.width = bmp.width; this.canvas.height = bmp.height;
      }
      this.ctx.drawImage(bmp, 0, 0);
      bmp.close();
      this.frames++;
      this.onFrame?.(this);
    } catch {} finally { this.decoding = false; }
  }
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a); out.set(b, a.length);
  return out;
}

const HEADER_END = [13, 10, 13, 10];
// Parses one "--frame\r\nContent-Type…\r\nContent-Length: N\r\n\r\n<jpeg>\r\n" part.
function nextFrame(buf) {
  const h = indexOf(buf, HEADER_END);
  if (h < 0) return null;
  const header = new TextDecoder().decode(buf.subarray(0, h));
  const len = +(header.match(/Content-Length:\s*(\d+)/i)?.[1] ?? NaN);
  const start = h + 4;
  if (!Number.isFinite(len)) return { jpeg: null, end: start }; // malformed header, skip it
  if (buf.length < start + len) return null;
  const af = header.match(/X-AF:\s*([\d.]+),([\d.]+),([\d.]+),([\d.]+)/i);
  return {
    jpeg: buf.slice(start, start + len), end: start + len,
    af: af && { x: +af[1], y: +af[2], w: +af[3], h: +af[4] },
  };
}

function indexOf(buf, seq) {
  outer: for (let i = 0; i <= buf.length - seq.length; i++) {
    for (let j = 0; j < seq.length; j++) if (buf[i + j] !== seq[j]) continue outer;
    return i;
  }
  return -1;
}
