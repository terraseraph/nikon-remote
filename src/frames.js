// Live view plumbing shared by every camera source (the tethered camera and a webcam): the newest
// frame, viewers on the pushed MJPEG stream, and viewers that pull one frame at a time. Whatever
// feeds frames in, phones, shot assist and gestures read them the same way.
import { EventEmitter } from 'node:events';

export class FrameSource extends EventEmitter {
  constructor() {
    super();
    this.viewers = new Set();  // MJPEG responses
    this.frame = null;
    this.frameMeta = null;     // camera focus box, when the source reports one
    this.frameSeq = 0;         // counts frames, so pulling viewers can ask for the next new one
    this.lastPull = 0;         // when a viewer last pulled a single frame
    this.pullWaiters = [];     // pending pulls, released one per new frame
  }

  // Someone is watching over a slow link (the tunnel), where frame size sets the frame rate.
  get pulling() { return Date.now() - this.lastPull < 3000; }

  pushFrame(jpeg, af = null) {
    this.frame = jpeg;
    this.frameMeta = af;
    this.frameSeq++;
    for (const viewer of this.viewers) writeFrame(viewer, jpeg, af);
    this.pullWaiters[0]?.();
  }

  // For viewers on slow links: the newest frame after `after`, waiting briefly for one.
  // Pulling one frame at a time means frames can never pile up in a buffer between here
  // and the viewer, which is what makes a pushed MJPEG stream fall seconds behind.
  async pullFrame(after, timeoutMs = 2000) {
    this.lastPull = Date.now();
    if (!this.frame || this.frameSeq <= after) {
      // One waiter per new frame, so a viewer with two requests in flight gets two different frames.
      await new Promise(resolve => {
        const done = () => { clearTimeout(timer); this.pullWaiters = this.pullWaiters.filter(w => w !== done); resolve(); };
        const timer = setTimeout(done, timeoutMs);
        this.pullWaiters.push(done);
      });
    }
    return this.frame && this.frameSeq > after ? { jpeg: this.frame, seq: this.frameSeq, af: this.frameMeta } : null;
  }

  addViewer(res) {
    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-store', Connection: 'close',
    });
    this.viewers.add(res);
    if (this.frame) writeFrame(res, this.frame, this.frameMeta);
    res.on('close', () => this.viewers.delete(res));
  }
}

function writeFrame(res, jpeg, meta) {
  const af = meta ? `X-AF: ${meta.x},${meta.y},${meta.w},${meta.h}\r\n` : '';
  res.write(`--frame\r\nContent-Type: image/jpeg\r\n${af}Content-Length: ${jpeg.length}\r\n\r\n`);
  res.write(jpeg);
  res.write('\r\n');
}
