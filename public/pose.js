// Pose match: finds the body in a pinned reference photo and in the Nikon's live view with
// MediaPipe's pose landmarker (in the browser), draws the reference pose as a ghost lined up on
// the person in frame, and scores how close they are with a hint on what to change.
// The reference may be matched as shown or mirrored, whichever is closer.
import { VISION, modelUrl } from './assets.js';

const MODEL = modelUrl('pose_landmarker_lite');

const MIN_VIS = 0.5;
const TICK_MS = 80;
// Landmark indices: 0 nose, 11/12 shoulders, 13/14 elbows, 15/16 wrists, 23/24 hips, 25/26 knees, 27/28 ankles.
const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]];
const SWAP = { 11: 12, 12: 11, 13: 14, 14: 13, 15: 16, 16: 15, 23: 24, 24: 23, 25: 26, 26: 25, 27: 28, 28: 27 };
// Segments compared for the score; `end` is the joint the hint talks about.
const SEGMENTS = [
  { a: 11, b: 13, part: 'arm', end: 13 }, { a: 13, b: 15, part: 'hand', end: 15 },
  { a: 12, b: 14, part: 'arm', end: 14 }, { a: 14, b: 16, part: 'hand', end: 16 },
  { a: 23, b: 25, part: 'leg', end: 25 }, { a: 25, b: 27, part: 'foot', end: 27 },
  { a: 24, b: 26, part: 'leg', end: 26 }, { a: 26, b: 28, part: 'foot', end: 28 },
  { a: 'hip', b: 'sho', part: 'torso' }, { a: 'sho', b: 0, part: 'head' }, { a: 11, b: 12, part: 'shoulders' },
];

const mid = (p, q) => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, v: Math.min(p.v, q.v) });

// Landmarks in pixels of their own image, plus the torso centre/size used to line poses up.
function toPose(lms, w, h) {
  if (!lms) return null;
  // The model guesses joints past the edge of a cropped photo (legs below a waist-up shot); ignore those.
  const inside = l => l.x >= 0 && l.x <= 1 && l.y >= 0 && l.y <= 1;
  const pts = lms.map(l => ({ x: l.x * w, y: l.y * h, v: inside(l) ? l.visibility ?? 1 : 0 }));
  const sho = mid(pts[11], pts[12]), hip = mid(pts[23], pts[24]);
  if (sho.v < MIN_VIS) return null; // need at least the shoulders to place anything
  // Torso length, or shoulder width for head-and-shoulders crops.
  const size = hip.v >= MIN_VIS ? Math.hypot(sho.x - hip.x, sho.y - hip.y) : 1.4 * Math.hypot(pts[11].x - pts[12].x, pts[11].y - pts[12].y);
  return { pts, sho, hip, size: Math.max(size, 1), center: hip.v >= MIN_VIS ? mid(sho, hip) : sho };
}

const point = (pose, k) => (k === 'sho' ? pose.sho : k === 'hip' ? pose.hip : pose.pts[k]);

function mirrored(pose) {
  const pts = pose.pts.map((_, i) => {
    const p = pose.pts[SWAP[i] ?? i];
    return { x: 2 * pose.center.x - p.x, y: p.y, v: p.v };
  });
  const flip = p => ({ ...p, x: 2 * pose.center.x - p.x });
  return { ...pose, pts, sho: flip(pose.sho), hip: flip(pose.hip) };
}

// Moves a reference pose so its torso sits on the live person's torso, at the same size.
function align(ref, live) {
  const k = live.size / ref.size;
  const map = p => ({ x: live.center.x + (p.x - ref.center.x) * k, y: live.center.y + (p.y - ref.center.y) * k, v: p.v });
  return { ...ref, pts: ref.pts.map(map), sho: map(ref.sho), hip: map(ref.hip), center: live.center, size: live.size };
}

const angle = (pose, s) => {
  const a = point(pose, s.a), b = point(pose, s.b);
  return a.v < MIN_VIS || b.v < MIN_VIS ? null : Math.atan2(b.y - a.y, b.x - a.x);
};
const diff = (x, y) => { const d = Math.abs(x - y) % (2 * Math.PI); return d > Math.PI ? 2 * Math.PI - d : d; };

function compare(ref, live) {
  let total = 0, n = 0;
  const misses = [];
  for (const s of SEGMENTS) {
    const r = angle(ref, s), l = angle(live, s);
    if (r == null || l == null) continue;
    const d = diff(r, l);
    total += Math.max(0, 1 - d / (Math.PI / 2)); n++;
    if (d > (25 * Math.PI) / 180) misses.push({ s, d });
  }
  return { score: n >= 3 ? total / n : null, misses: misses.sort((a, b) => b.d - a.d) };
}

// One directing line for the worst-off segment, in frame terms ("on the left of frame") because
// the photographer and the subject see the scene from opposite sides.
function hint(miss, ref, live) {
  if (!miss) return 'Hold that — it matches';
  const { s } = miss;
  const side = j => (point(live, j).x < live.center.x ? 'left' : 'right');
  if (s.part === 'torso' || s.part === 'head') {
    // Both segments point up (about −90°); a smaller angle leans toward frame left.
    const dir = angle(ref, s) < angle(live, s) ? 'left' : 'right';
    return s.part === 'torso' ? `Lean toward frame ${dir}` : `Tilt head toward frame ${dir}`;
  }
  if (s.part === 'shoulders') {
    // How much lower the frame-left shoulder sits than the frame-right one.
    const tilt = p => { const [l, r] = p.pts[11].x < p.pts[12].x ? [11, 12] : [12, 11]; return p.pts[l].y - p.pts[r].y; };
    return `Drop the shoulder on frame ${tilt(ref) > tilt(live) ? 'left' : 'right'}`;
  }
  const want = point(ref, s.b), got = point(live, s.b);
  const where = `on frame ${side(s.a)}`;
  if (Math.abs(want.y - got.y) >= Math.abs(want.x - got.x)) return `${want.y < got.y ? 'Raise' : 'Lower'} the ${s.part} ${where}`;
  const out = Math.abs(want.x - live.center.x) > Math.abs(got.x - live.center.x);
  return `Move the ${s.part} ${where} ${out ? 'out' : 'in'}`;
}

export class PoseMatch {
  constructor({ liveView, overlay, onUpdate }) {
    Object.assign(this, { liveView, overlay, onUpdate });
    this.ctx = overlay.getContext('2d');
    this.ref = null;
    this.shown = null; // smoothed score for display
  }

  async load() {
    if (this.video) return;
    this.loading ??= (async () => {
      const { PoseLandmarker, FilesetResolver } = await import(`${VISION}/vision_bundle.mjs`);
      const fileset = await FilesetResolver.forVisionTasks(`${VISION}/wasm`);
      const make = async (runningMode) => {
        const opts = { baseOptions: { modelAssetPath: MODEL, delegate: 'GPU' }, runningMode, numPoses: 1 };
        try { return await PoseLandmarker.createFromOptions(fileset, opts); }
        catch { opts.baseOptions.delegate = 'CPU'; return PoseLandmarker.createFromOptions(fileset, opts); }
      };
      this.image = await make('IMAGE');
      this.video = await make('VIDEO');
    })().catch(e => { this.loading = null; throw e; });
    return this.loading;
  }

  // Finds the pose in a (CORS-readable, fully loaded) image and starts matching against it.
  async pin(img) {
    try { await this.load(); }
    catch { throw new Error('Could not load the pose model'); }
    const res = this.image.detect(img);
    const ref = toPose(res.landmarks?.[0], img.naturalWidth, img.naturalHeight);
    if (!ref) throw new Error('No clear person in that photo — try another one');
    this.ref = { pose: ref, flip: mirrored(ref), w: img.naturalWidth, h: img.naturalHeight };
    this.shown = null;
    if (!this.active) { this.active = true; this.lastTs = 0; this.tick(); }
  }

  unpin() {
    this.active = false;
    this.ref = null;
    clearTimeout(this.timer);
    this.ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
  }

  tick() {
    if (!this.active) return;
    const lv = this.liveView;
    if (lv.running && lv.hasFrame) {
      // VIDEO mode needs strictly increasing timestamps.
      const ts = Math.max(performance.now(), this.lastTs + 1);
      this.lastTs = ts;
      let live = null;
      try { live = toPose(this.video.detectForVideo(lv.canvas, ts).landmarks?.[0], lv.canvas.width, lv.canvas.height); } catch {}
      this.frame(live);
    } else {
      this.draw(null, null, null);
      this.onUpdate({ score: null, hint: 'Turn on live view to match the pose' });
    }
    this.timer = setTimeout(() => this.tick(), TICK_MS);
  }

  frame(live) {
    const { width: W, height: H } = this.liveView.canvas;
    if (!live) {
      // Nobody in frame: show the ghost where it sits in the reference photo, so they can step into it.
      const k = Math.min(W / this.ref.w, H / this.ref.h);
      const ox = (W - this.ref.w * k) / 2, oy = (H - this.ref.h * k) / 2;
      const map = p => ({ x: ox + p.x * k, y: oy + p.y * k, v: p.v });
      const r = this.ref.pose;
      this.draw({ ...r, pts: r.pts.map(map), sho: map(r.sho), hip: map(r.hip) }, null, null);
      this.shown = null;
      return this.onUpdate({ score: null, hint: 'Step into the outline' });
    }
    const a = align(this.ref.pose, live), b = align(this.ref.flip, live);
    const ca = compare(a, live), cb = compare(b, live);
    const [ref, c] = (cb.score ?? -1) > (ca.score ?? -1) + 0.03 ? [b, cb] : [a, ca];
    if (c.score != null) this.shown = this.shown == null ? c.score : this.shown * 0.6 + c.score * 0.4;
    this.draw(ref, live, c.misses);
    this.onUpdate({ score: this.shown, hint: c.score == null ? 'Get more of the body in frame' : hint(c.misses[0], ref, live) });
  }

  draw(ref, live, misses) {
    const c = this.overlay, lv = this.liveView.canvas;
    const r = c.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);
    if (!ref || !lv.width) return;
    // Overlay pixels per live view pixel (the overlay is the viewport's CSS size, not the frame's).
    const k = w / lv.width, lw = Math.max(2, 3 * dpr);
    const P = p => [p.x * k, p.y * k];
    const bones = (pose, style, width, dash = []) => {
      ctx.strokeStyle = style; ctx.lineWidth = width; ctx.setLineDash(dash); ctx.lineCap = 'round';
      ctx.beginPath();
      for (const [i, j] of BONES) {
        const a = pose.pts[i], b = pose.pts[j];
        if (a.v < MIN_VIS || b.v < MIN_VIS) continue;
        ctx.moveTo(...P(a)); ctx.lineTo(...P(b));
      }
      ctx.stroke();
      const head = pose.pts[0];
      if (head.v >= MIN_VIS) {
        ctx.beginPath(); ctx.arc(...P(head), pose.size * k * 0.22, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.setLineDash([]);
    };
    // Ghost: wide soft stroke with a crisp dashed line on top so it reads on any background.
    bones(ref, 'rgba(0,0,0,.45)', lw * 3.2);
    bones(ref, 'rgba(245,196,0,.9)', lw * 1.3, [lw * 3, lw * 2]);
    if (!live) return;
    bones(live, 'rgba(255,255,255,.55)', lw);
    // Arrows from where the worst joints are to where the reference wants them.
    ctx.strokeStyle = ctx.fillStyle = '#ff9f1c'; ctx.lineWidth = lw;
    for (const { s } of (misses || []).slice(0, 2)) {
      if (s.end == null) continue;
      const [x1, y1] = P(live.pts[s.end]), [x2, y2] = P(ref.pts[s.end]);
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (len < 12 * dpr) continue;
      const ux = (x2 - x1) / len, uy = (y2 - y1) / len, hd = 9 * dpr;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2 - ux * hd, y2 - uy * hd); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - ux * hd * 1.6 - uy * hd, y2 - uy * hd * 1.6 + ux * hd);
      ctx.lineTo(x2 - ux * hd * 1.6 + uy * hd, y2 - uy * hd * 1.6 - ux * hd);
      ctx.fill();
    }
  }
}
