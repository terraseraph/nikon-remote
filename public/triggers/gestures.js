// Hand-gesture triggers using MediaPipe's gesture recognizer, run in the browser.
// It can watch the Nikon's own live view (so the person in the photo controls the shot)
// or the laptop webcam. The model and runtime load from a CDN the first time it's enabled.

const VISION = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task';

export const GESTURES = {
  Open_Palm: { emoji: '✋', label: 'Open palm' },
  Victory: { emoji: '✌️', label: 'Peace sign' },
  Thumb_Up: { emoji: '👍', label: 'Thumbs up' },
  Thumb_Down: { emoji: '👎', label: 'Thumbs down' },
  Pointing_Up: { emoji: '☝️', label: 'Point up' },
  Closed_Fist: { emoji: '✊', label: 'Fist' },
  ILoveYou: { emoji: '🤟', label: 'Rock on' },
};

const CHOICES = {
  none: ['Nothing', null],
  shoot: ['Shoot now', a => a.shoot()],
  timer3: ['3 s timer', a => a.timer(3)],
  timer5: ['5 s timer', a => a.timer(5)],
  burst3: ['Burst ×3', a => a.burst(3)],
  timerBurst3: ['3 s timer, then 3 shots', a => a.timerBurst(3)],
  sequence: ['Shoot as the shutter is set', a => a.sequence()],
  preset1: ['Run preset 1', a => a.preset(1)],
  preset2: ['Run preset 2', a => a.preset(2)],
  preset3: ['Run preset 3', a => a.preset(3)],
  focus: ['Focus', a => a.focus()],
  record: ['Start/stop video', a => a.record()],
  cancel: ['Cancel', a => a.cancel()],
  brighter: ['Brighter', a => a.brighter()],
  darker: ['Darker', a => a.darker()],
};

const DEFAULT_MAP = {
  Open_Palm: 'timer3', Victory: 'shoot', Thumb_Up: 'timerBurst3', Closed_Fist: 'cancel',
  Pointing_Up: 'focus', Thumb_Down: 'none', ILoveYou: 'none',
};

const HOLD_MS = 700;      // gesture must be held this long
const COOLDOWN_MS = 2500; // after firing
const MIN_SCORE = 0.6;

function loadMap() {
  try { return { ...DEFAULT_MAP, ...JSON.parse(localStorage.getItem('gestureMap') || '{}') }; }
  catch { return { ...DEFAULT_MAP }; }
}

export class GestureTrigger {
  constructor({ actions, liveView, webcam, getSource, onUpdate, onFire }) {
    Object.assign(this, { actions, liveView, webcam, getSource, onUpdate, onFire });
    this.map = loadMap();
  }

  renderMap(container) {
    container.innerHTML = '';
    for (const [g, { emoji, label }] of Object.entries(GESTURES)) {
      const name = document.createElement('span');
      name.textContent = `${emoji} ${label}`;
      const sel = document.createElement('select');
      for (const [key, [text]] of Object.entries(CHOICES)) sel.add(new Option(text, key, false, this.map[g] === key));
      sel.onchange = () => {
        this.map[g] = sel.value;
        try { localStorage.setItem('gestureMap', JSON.stringify(this.map)); } catch {}
      };
      container.append(name, sel);
    }
  }

  // The gestures that currently do something, for the on-screen guide.
  legend() {
    return Object.entries(GESTURES)
      .filter(([g]) => CHOICES[this.map[g]]?.[1])
      .map(([g, { emoji, label }]) => ({ gesture: g, emoji, label, action: CHOICES[this.map[g]][0] }));
  }

  async load() {
    if (this.recognizer) return;
    this.onUpdate('Loading model…', 0);
    const { GestureRecognizer, FilesetResolver } = await import(`${VISION}/vision_bundle.mjs`);
    const fileset = await FilesetResolver.forVisionTasks(`${VISION}/wasm`);
    const opts = { baseOptions: { modelAssetPath: MODEL, delegate: 'GPU' }, runningMode: 'VIDEO', numHands: 1 };
    try { this.recognizer = await GestureRecognizer.createFromOptions(fileset, opts); }
    catch { opts.baseOptions.delegate = 'CPU'; this.recognizer = await GestureRecognizer.createFromOptions(fileset, opts); }
  }

  async start() {
    try { await this.load(); }
    catch { throw new Error('Could not load the gesture model (needs internet the first time)'); }
    this.source = this.getSource();
    if (this.source === 'webcam') {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } })
        .catch(() => { throw new Error('Webcam permission was blocked'); });
      this.webcam.srcObject = this.stream;
      await this.webcam.play();
    }
    this.active = true;
    this.current = null; this.since = 0; this.cooldownUntil = 0; this.lastFired = null;
    this.tick();
  }

  stop() {
    this.active = false;
    clearTimeout(this.timer);
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.webcam.srcObject = null;
  }

  frame() {
    if (this.source === 'webcam') return this.webcam.readyState >= 2 ? this.webcam : null;
    return this.liveView.running && this.liveView.hasFrame ? this.liveView.canvas : null;
  }

  tick() {
    if (!this.active) return;
    const src = this.frame();
    if (src) {
      let gesture = null;
      try {
        const res = this.recognizer.recognizeForVideo(src, performance.now());
        const top = res.gestures?.[0]?.[0];
        if (top && top.score >= MIN_SCORE && top.categoryName !== 'None') gesture = top.categoryName;
      } catch {}
      this.update(gesture);
    }
    this.timer = setTimeout(() => this.tick(), 100);
  }

  update(gesture) {
    const now = performance.now();
    if (gesture !== this.current) { this.current = gesture; this.since = now; }
    // The same gesture must be released before it can fire again (no repeat-fire while held).
    if (gesture !== this.lastFired) this.lastFired = null;
    const held = gesture ? now - this.since : 0;
    const choice = gesture && CHOICES[this.map[gesture]];
    const armed = choice && choice[1] && now >= this.cooldownUntil && this.lastFired !== gesture;
    this.onUpdate(gesture, armed ? Math.min(1, held / HOLD_MS) : 0);
    if (armed && held >= HOLD_MS) {
      this.lastFired = gesture;
      this.cooldownUntil = now + COOLDOWN_MS;
      this.onFire(`${GESTURES[gesture].label} → ${choice[0]}`);
      choice[1](this.actions);
    }
  }
}
