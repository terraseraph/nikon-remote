import { fmt, LABEL } from './format.js';
import { VoiceTrigger, VOICE_HELP } from './triggers/voice.js';
import { GestureTrigger, GESTURES } from './triggers/gestures.js';
import { ClapTrigger } from './triggers/clap.js';
import { LiveView } from './liveview.js';
import { Inspo } from './inspo.js';
import { PoseMatch } from './pose.js';

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let state = { connected: false, props: {} };
// https means the page came through the internet tunnel (LAN and localhost are plain http).
const liveView = new LiveView($('lv'), { pull: location.protocol === 'https:', onFrame:() => { fitViewport(); drawFocusBox(); } });

// ---------- API ----------
async function api(path, body, { signal } = {}) {
  const res = await fetch(path, body === undefined ? { signal } : {
    signal, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// Live updates arrive as server-sent events. Some proxies (Cloudflare quick tunnels) hold the
// stream back entirely, so if the server's opening message never shows up, poll instead.
const events = new EventSource('/api/events');
let pollTimer = setTimeout(startPolling, 5000);
events.addEventListener('state', e => { clearTimeout(pollTimer); pollTimer = null; state = JSON.parse(e.data); render(); });
events.addEventListener('prop', e => { const p = JSON.parse(e.data); state.props[p.code] = p; renderProps(); });
events.addEventListener('photo', e => addPhoto(JSON.parse(e.data), true));
events.addEventListener('log', e => console.log('[camera]', JSON.parse(e.data)));

function startPolling() {
  console.log('Live event stream blocked by the connection; polling instead');
  let last = '', tick = 0;
  const poll = async () => {
    try {
      const text = JSON.stringify(await api('/api/state'));
      // Only re-render on change, or an open dropdown would be rebuilt under the user every second.
      if (text !== last) { last = text; state = JSON.parse(text); render(); }
      if (tick++ % 3 === 0) (await api('/api/photos')).reverse().forEach(p => addPhoto(p, true));
    } catch {}
    if (pollTimer) pollTimer = setTimeout(poll, 1000);
  };
  poll();
}

// ---------- feedback ----------
let toastTimer;
function toast(msg, bad = false) {
  const t = $('toast');
  t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2500);
}

let audio;
function beep(freq = 880, ms = 90) {
  clap.quiet(ms + 400);
  if (!$('beeps').checked) return;
  audio ??= new AudioContext();
  const o = audio.createOscillator(), g = audio.createGain();
  o.frequency.value = freq; o.connect(g); g.connect(audio.destination);
  g.gain.setValueAtTime(0.15, audio.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + ms / 1000);
  o.start(); o.stop(audio.currentTime + ms / 1000);
}

// A two-note "ready" chime just before the shutter, so people in the shot know when to hold still.
function chime() {
  clap.quiet(1500);
  if (!$('chime').checked) return;
  audio ??= new AudioContext();
  audio.resume?.();
  const t = audio.currentTime;
  for (const [freq, at] of [[1046.5, 0], [1568, 0.16]]) {
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = freq; o.connect(g); g.connect(audio.destination);
    g.gain.setValueAtTime(0.0001, t + at);
    g.gain.exponentialRampToValueAtTime(0.22, t + at + 0.015);
    g.gain.exponentialRampToValueAtTime(0.001, t + at + 0.6);
    o.start(t + at); o.stop(t + at + 0.62);
  }
}

function flash() {
  const f = $('flash');
  f.classList.add('on');
  requestAnimationFrame(() => requestAnimationFrame(() => f.classList.remove('on')));
}

// ---------- capture mode + drive ----------
// The shutter does what the mode says: photo runs the drive sequence, video toggles recording,
// lapse toggles the time-lapse. Drive numbers live in the advanced Capture tab.
let captureMode = 'photo';
const drive = { mode: 'single', burst: 3, gap: 1, timer: 3, timerBurst: false, tlEvery: 5, tlFrames: 30, preset: 0 };
try { Object.assign(drive, JSON.parse(localStorage.drive || '{}')); } catch {}
const saveDrive = () => { try { localStorage.drive = JSON.stringify(drive); } catch {} };
const BURSTS = [2, 3, 5, 10], TIMERS = [2, 3, 5, 10];
let presets = []; // shared with every device through the server; see "presets" below

// Every way of shooting is a list of steps, "wait, then take N shots this far apart", run
// `repeat` times (0 = until cancelled). The drive modes are one-step versions of a preset.
function driveSequence() {
  if (drive.mode === 'preset' && presets[drive.preset]) return presetSequence(presets[drive.preset]);
  const timed = drive.mode === 'timer';
  const shots = drive.mode === 'burst' || (timed && drive.timerBurst) ? drive.burst : 1;
  return { steps: [{ wait: timed ? drive.timer : 0, shots, gap: drive.gap }] };
}

function primaryAction() {
  if (captureMode === 'video') return actions.record();
  if (captureMode === 'lapse') return timelapse ? stopTimelapse() : startTimelapse();
  return actions.sequence();
}

function setMode(m, force = false) {
  if (!force && (seq || timelapse || state.recordingSince)) return toast('Finish the current shots first', true);
  captureMode = m;
  const seg = $('modeSeg');
  pickSeg(seg, seg.querySelector(`[data-mode="${m}"]`));
  renderShutter();
}

// Moves a segmented control's sliding highlight to `btn`.
function pickSeg(seg, btn) {
  const buttons = [...seg.querySelectorAll('button')];
  buttons.forEach(b => b.classList.toggle('on', b === btn));
  seg.style.setProperty('--i', buttons.indexOf(btn));
}

function renderDrive() {
  pickSeg($('driveSeg'), $('driveSeg').querySelector(`[data-drive="${drive.mode}"]`));
  $('burstSub').textContent = `×${drive.burst}`;
  $('timerSub').textContent = `${drive.timer}s`;
  $('presetSub').textContent = `P${drive.preset + 1}`;
  for (const seg of document.querySelectorAll('.seg[data-opt]')) {
    const btn = [...seg.querySelectorAll('button')].find(b => +b.dataset.v === drive[seg.dataset.opt]);
    if (btn) pickSeg(seg, btn);
  }
  $('timerBurst').checked = drive.timerBurst;
  renderShutter();
}

function renderShutter() {
  const rec = !!state.recordingSince, s = $('shutter');
  s.classList.remove('photo', 'video', 'lapse');
  s.classList.add(captureMode);
  s.classList.toggle('rec', rec);
  s.classList.toggle('run', !!timelapse);
  s.classList.toggle('busy', !!seq);
  s.disabled = !state.connected || (rec && captureMode !== 'video');
  const label =
    captureMode === 'video' ? (rec ? 'Stop' : 'Record') :
    captureMode === 'lapse' ? (timelapse ? 'Stop lapse' : 'Start lapse') :
    drive.mode === 'burst' ? `Burst ×${drive.burst}` :
    drive.mode === 'timer' ? `Timer ${drive.timer}s${drive.timerBurst ? ` ×${drive.burst}` : ''}` :
    drive.mode === 'preset' ? presets[drive.preset]?.name || 'Preset' : 'Shoot';
  $('shutterLabel').textContent = label;
  s.setAttribute('aria-label', label);
  s.title = `${label} (Space)`;
  $('cancelBtn').classList.toggle('hidden', !seq && !timelapse);
  $('modeSeg').classList.toggle('locked', !!(seq || timelapse || rec));
  $('driveSeg').classList.toggle('off', captureMode !== 'photo');
}

// ---------- shooting sequences ----------
// One sequence at a time; any new trigger while one runs is ignored, "cancel" stops it.
let seq = null;

function seqStatus(text) {
  const s = $('seqStatus');
  s.textContent = text || '';
  s.classList.toggle('hidden', !text);
}

// Waits `secs` before a shot: waits of 2 s or more count down on screen with a beep a second,
// and with `ring` the ready chime plays at the end. The chime comes out of the wait rather than
// adding to it, so "every 3 seconds" stays every 3 seconds.
const CHIME_LEAD = 0.7;
async function countdown(secs, token, ring = false) {
  const el = $('countdown');
  ring &&= $('chime').checked;
  const end = performance.now() + Math.max(secs, ring ? CHIME_LEAD : 0) * 1000;
  let shown = 0, chimed = !ring;
  while (!token.cancelled) {
    const left = (end - performance.now()) / 1000;
    if (left <= 0) break;
    if (!chimed && left <= CHIME_LEAD) { chimed = true; chime(); }
    const s = Math.ceil(left);
    if (secs >= 2 && s !== shown) {
      shown = s;
      el.textContent = s; el.classList.remove('hidden');
      el.style.animation = 'none'; el.offsetHeight; el.style.animation = '';
      if (!(ring && s === 1)) beep(s <= 3 ? 1100 : 880); // the chime stands in for the last beep
    }
    await sleep(Math.min(50, left * 1000));
  }
  el.classList.add('hidden');
}

async function shootOnce() {
  beep(1600, 140);
  flash();
  $('shutter').classList.add('firing');
  setTimeout(() => $('shutter').classList.remove('firing'), 170);
  try {
    clap.quiet(2500); // the shutter itself is loud enough to count as a clap
    const r = await api('/api/shoot', { af: $('afBefore').checked });
    clap.quiet(1500);
    if (!r.ok) toast(`Shot failed: ${r.code}`, true);
    else if (r.focus && r.focus !== 'OK') toast(`Shot taken (focus: ${r.focus})`);
    return r.ok;
  } catch (e) { toast(e.message, true); return false; }
}

async function runSequence({ steps, repeat = 1, label = 'Burst' } = driveSequence()) {
  if (seq) return toast('Already shooting — say “cancel” to stop');
  const token = (seq = { cancelled: false });
  renderShutter();
  const total = repeat ? repeat * steps.reduce((n, s) => n + s.shots, 0) : 0;
  let taken = 0;
  try {
    for (let round = 1; (!repeat || round <= repeat) && !token.cancelled; round++) {
      for (const s of steps) {
        for (let i = 1; i <= s.shots && !token.cancelled; i++) {
          // Chime before each step's first shot, and before every shot unless it's a quick burst.
          await countdown(i === 1 ? s.wait : s.gap, token, i === 1 || s.gap >= 1);
          if (token.cancelled) break;
          taken++;
          if (total !== 1) seqStatus(`${label} ${taken}${total ? `/${total}` : ''}`);
          await shootOnce();
        }
      }
    }
  } finally {
    seq = null; seqStatus('');
    renderShutter();
  }
}

function cancel() {
  if (seq) { seq.cancelled = true; toast('Cancelled'); }
  if (timelapse) stopTimelapse();
}

// ---------- time-lapse ----------
let timelapse = null;
async function startTimelapse() {
  if (timelapse || seq) return;
  const every = drive.tlEvery, frames = drive.tlFrames || Infinity;
  const token = (timelapse = { cancelled: false });
  if (captureMode !== 'lapse') setMode('lapse', true);
  renderShutter();
  for (let i = 1; i <= frames && !token.cancelled; i++) {
    const t0 = Date.now();
    seqStatus(`Time-lapse ${i}${frames === Infinity ? '' : `/${frames}`}`);
    if ($('chime').checked && every >= 2) { chime(); await sleep(CHIME_LEAD * 1000); }
    if (token.cancelled) break;
    await shootOnce();
    while (!token.cancelled && Date.now() - t0 < every * 1000) await sleep(100);
  }
  stopTimelapse();
}
function stopTimelapse() {
  if (timelapse) timelapse.cancelled = true;
  timelapse = null; seqStatus('');
  renderShutter();
}

// ---------- presets ----------
// Numbered shooting routines ("preset two" by voice). Edits save to the server after a pause
// and come back to every open device as a 'presets' event.
const presetSequence = p => ({ steps: p.steps, repeat: p.repeat, label: p.name });
const secs = s => (s >= 60 && s % 60 === 0 ? `${s / 60} min` : `${s} s`);
function describePreset(p) {
  const steps = p.steps.map(s => {
    const shots = s.shots === 1 ? '1 shot' : `${s.shots} shots ${secs(s.gap)} apart`;
    return s.wait ? `wait ${secs(s.wait)}, ${shots}` : shots;
  }).join(' → ');
  return `${steps}${p.repeat === 0 ? ', repeat until cancelled' : p.repeat > 1 ? `, ×${p.repeat}` : ''}`;
}

function pickPreset(i) {
  if (seq || timelapse) return toast('Finish the current shots first', true);
  drive.preset = i; drive.mode = 'preset';
  if (captureMode !== 'photo') setMode('photo');
  saveDrive(); renderDrive(); renderPresets();
  toast(`Preset ${i + 1}: ${presets[i].name}`);
}

let presetSave;
function savePresets() {
  clearTimeout(presetSave);
  presetSave = setTimeout(() => api('/api/presets', { presets }).catch(e => toast(e.message, true)), 500);
}
function setPresets(list) {
  presets = list;
  if (drive.preset >= presets.length) drive.preset = 0;
  renderDrive();
  // Don't rebuild the editor under someone typing in it.
  if (!$('presetList').contains(document.activeElement)) renderPresets();
}

const REPEATS = [[1, 'Once'], [2, '×2'], [3, '×3'], [5, '×5'], [10, '×10'], [0, 'Until cancelled']];
function numInput(value, { min = 0, max, step = 1, label, onset }) {
  const i = document.createElement('input');
  Object.assign(i, { type: 'number', className: 'num mono', min, step, value, inputMode: 'decimal' });
  if (max != null) i.max = max;
  i.setAttribute('aria-label', label);
  i.onchange = () => { const v = Math.max(min, Math.min(max ?? Infinity, +i.value || 0)); i.value = v; onset(v); };
  return i;
}
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

function renderPresets() {
  $('presetAdd').disabled = presets.length >= 9;
  $('presetList').replaceChildren(...presets.map((p, pi) => {
    const changed = () => { sum.textContent = describePreset(p); savePresets(); renderShutter(); };
    const card = el('div', 'preset');
    card.classList.toggle('on', drive.mode === 'preset' && drive.preset === pi);

    const head = el('div', 'phead');
    const pick = el('button', 'pnum mono', pi + 1);
    pick.title = `Use for the shutter, “shoot” and clap (or say “use preset ${pi + 1}”)`;
    pick.onclick = () => pickPreset(pi);
    const name = el('input', 'pname');
    name.value = p.name; name.maxLength = 40; name.setAttribute('aria-label', `Preset ${pi + 1} name`);
    name.oninput = () => { p.name = name.value || `Preset ${pi + 1}`; changed(); };
    const run = el('button', 'pbtn run');
    run.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10-6.5z"/></svg>';
    run.title = `Run now (say “preset ${pi + 1}”)`; run.setAttribute('aria-label', `Run preset ${pi + 1}`);
    run.onclick = () => actions.preset(pi + 1);
    const del = el('button', 'pbtn');
    del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>';
    del.title = 'Delete preset'; del.setAttribute('aria-label', `Delete preset ${pi + 1}`);
    del.onclick = () => {
      presets.splice(pi, 1);
      if (drive.preset >= pi && drive.preset > 0) drive.preset--;
      saveDrive(); savePresets(); renderDrive(); renderPresets();
    };
    head.append(pick, name, run, del);

    const steps = el('ol', 'psteps');
    p.steps.forEach((s, si) => {
      const row = el('li', 'pstep');
      const gap = el('span', 'pgap');
      const showGap = () => gap.classList.toggle('hidden', s.shots < 2);
      gap.append(numInput(s.gap, { step: 0.5, max: 600, label: 'Seconds between shots', onset: v => { s.gap = v; changed(); } }), el('span', null, 's apart'));
      row.append(
        el('span', null, si ? 'then wait' : 'Wait'),
        numInput(s.wait, { step: 0.5, max: 3600, label: 'Seconds to wait', onset: v => { s.wait = v; changed(); } }),
        el('span', null, 's, take'),
        numInput(s.shots, { min: 1, max: 50, label: 'Shots', onset: v => { s.shots = v; showGap(); changed(); } }),
        gap,
      );
      showGap();
      if (p.steps.length > 1) {
        const rm = el('button', 'pbtn sm');
        rm.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>';
        rm.setAttribute('aria-label', `Remove step ${si + 1}`);
        rm.onclick = () => { p.steps.splice(si, 1); savePresets(); renderPresets(); };
        row.append(rm);
      }
      steps.append(row);
    });

    const foot = el('div', 'pfoot');
    const add = el('button', 'pbtn text', '+ Step');
    add.disabled = p.steps.length >= 12;
    add.onclick = () => { p.steps.push({ wait: 3, shots: 1, gap: 1 }); savePresets(); renderPresets(); };
    const rep = document.createElement('select');
    rep.setAttribute('aria-label', 'Repeat');
    rep.append(...REPEATS.map(([v, t]) => new Option(t, v)));
    if (!REPEATS.some(([v]) => v === p.repeat)) rep.add(new Option(`×${p.repeat}`, p.repeat));
    rep.value = p.repeat;
    rep.onchange = () => { p.repeat = +rep.value; changed(); };
    const repLabel = el('label', 'prep', 'Repeat ');
    repLabel.append(rep);
    foot.append(add, repLabel);

    const sum = el('p', 'psum', describePreset(p));
    card.append(head, steps, foot, sum);
    return card;
  }));
}

$('presetAdd').onclick = () => {
  presets.push({ name: `Preset ${presets.length + 1}`, repeat: 1, steps: [{ wait: 0, shots: 1, gap: 1 }] });
  savePresets(); renderPresets();
  $('presetList').lastElementChild?.querySelector('.pname').select();
};
events.addEventListener('presets', e => setPresets(JSON.parse(e.data)));
api('/api/presets').then(setPresets).catch(() => {});

// ---------- actions (shared by buttons, keys, voice, gestures, clap) ----------
const PROP = { aperture: 0x5007, shutter: 0xd100, iso: 0x500f, ev: 0x5010 };

async function step(name, delta) {
  try {
    const p = await api('/api/prop/step', { code: PROP[name], delta });
    toast(`${LABEL[name]}: ${fmt(name, p.value)}`);
  } catch (e) { toast(e.message, true); }
}

export const actions = {
  shoot: () => runSequence({ steps: [{ wait: 0, shots: 1 }] }),
  sequence: () => runSequence(),
  timer: n => runSequence({ steps: [{ wait: n, shots: 1 }] }),
  burst: n => runSequence({ steps: [{ wait: 0, shots: n, gap: 0.5 }] }),
  timerBurst: n => runSequence({ steps: [{ wait: 3, shots: n, gap: 1 }] }),
  preset: n => (presets[n - 1] ? runSequence(presetSequence(presets[n - 1])) : toast(`There is no preset ${n}`, true)),
  pickPreset: n => (presets[n - 1] ? pickPreset(n - 1) : toast(`There is no preset ${n}`, true)),
  focus: async () => { try { const r = await api('/api/af', {}); toast(r.result === 'OK' ? 'Focused' : `Focus: ${r.result}`, r.result !== 'OK'); } catch (e) { toast(e.message, true); } },
  cancel,
  brighter: () => step('ev', +1),
  darker: () => step('ev', -1),
  isoUp: () => step('iso', +1),
  isoDown: () => step('iso', -1),
  iso: async v => {
    const p = state.props[PROP.iso];
    if (!p?.values?.includes(v)) return toast(`ISO ${v} not available`, true);
    try { await api('/api/prop', { code: PROP.iso, value: v }); toast(`ISO ${v}`); } catch (e) { toast(e.message, true); }
  },
  liveView: on => api('/api/liveview', { on }),
  record: on => setRecording(on ?? !state.recordingSince),
  zoom: dir => setZoom(dir === 'in' ? Math.min(ZOOMS.length - 1, zoomIndex + 1) : dir === 'out' ? Math.max(0, zoomIndex - 1) : (zoomIndex + 1) % ZOOMS.length),
  timelapse: on => (on ? startTimelapse() : stopTimelapse()),
  advise: () => suggestSettings(),
  applyAdvice: () => applyAdvice(),
  inspo: text => inspo.find(text),
  inspoStep: d => (inspo.photos.length ? (inspo.open(), inspo.step(d)) : toast('Say “inspo” and what you’re after first', true)),
  inspoSize: big => inspo.size(big),
  pinPose: () => inspo.pin(),
  unpinPose: () => inspo.unpin(),
  closeInspo: () => inspo.close(),
};

// ---------- rendering ----------
function render() {
  $('connDot').classList.toggle('on', state.connected);
  const model = (state.model || state.name || '').replace(/_(\d)$/, (_, n) => 'I'.repeat(+n)); // "Z50_2" → "Z50II"
  // Some brands repeat their name in the model ("Canon EOS R6"), so it's only added when missing.
  const brand = state.brand && !model.toLowerCase().startsWith(state.brand.toLowerCase()) ? `${state.brand} ` : '';
  $('camName').textContent = state.connected ? `${brand}${model}${state.experimental ? ' (experimental)' : ''}` : (state.error || 'Camera disconnected');
  $('lvBtn').classList.toggle('active', !!state.wantLiveView);
  $('lvBtn').setAttribute('aria-pressed', !!state.wantLiveView);
  const showLv = state.connected && state.wantLiveView;
  $('viewport').classList.toggle('hidden', !showLv);
  $('lvPlaceholder').classList.toggle('hidden', showLv);
  $('lvPlaceholder').textContent = state.connected ? 'Live view off — press L or the Live view button' : 'Plug in the camera and switch it on';
  showLv ? liveView.start() : liveView.stop();
  renderRecording();
  renderProps();
}

const EXPOSURE_ROWS = ['aperture', 'shutter', 'iso', 'ev', 'wb', 'metering', 'focus', 'quality', 'size'];
const CHIP_ROWS = ['aperture', 'shutter', 'iso', 'ev', 'wb', 'focus'];
const MINUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12"/></svg>';
const PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6v12M6 12h12"/></svg>';

function propsByName() {
  const by = {};
  for (const [code, p] of Object.entries(state.props)) { p.code = +code; by[p.name] = p; }
  return by;
}
const editable = p => !!p?.writable && p.values?.length > 1;
function bump(el) { el.classList.remove('bump'); el.offsetWidth; el.classList.add('bump'); }
function setText(el, text) { if (el.textContent !== text) { const had = el.textContent; el.textContent = text; if (had) bump(el); } }

// Sets a property, showing the new value straight away so the ruler and tiles move with the
// click; the camera's own event confirms it (or the old value comes back with an error).
async function setProp(name, v) {
  const p = propsByName()[name];
  if (!p) return;
  const prev = p.value;
  p.value = v; renderProps();
  try { await api('/api/prop', { code: p.code, value: v }); }
  catch (e) { p.value = prev; renderProps(); toast(e.message, true); }
}
function nudge(name, d) {
  const p = propsByName()[name];
  if (!editable(p)) return PROP[name] && step(name, d);
  const i = p.values.indexOf(p.value) + d;
  if (i >= 0 && i < p.values.length) setProp(name, p.values[i]);
}

// Chips and tiles are built once and updated in place, so values can animate when they change.
for (const name of CHIP_ROWS) {
  const chip = document.createElement('button');
  chip.className = 'chip hidden'; chip.dataset.name = name;
  chip.innerHTML = '<span class="l"></span><span class="vs"><span class="v mono"></span><span class="n mono"></span></span>';
  chip.querySelector('.l').textContent = LABEL[name];
  chip.onclick = () => { openChip = openChip === name ? null : name; if (openChip) toggleAssist(false); renderProps(); };
  $('chips').append(chip);
}
for (const name of EXPOSURE_ROWS) {
  const tile = document.createElement('div');
  tile.className = 'tile hidden'; tile.dataset.name = name;
  tile.innerHTML = `<span class="l"></span><div class="row"><select class="mono"></select>
    <button class="mini" aria-label="Decrease">${MINUS}</button><button class="mini" aria-label="Increase">${PLUS}</button></div>`;
  tile.querySelector('.l').textContent = LABEL[name];
  const sel = tile.querySelector('select');
  sel.setAttribute('aria-label', LABEL[name]);
  sel.onchange = () => {
    const p = propsByName()[name];
    setProp(name, typeof p.value === 'string' ? sel.value : +sel.value);
  };
  const [down, up] = tile.querySelectorAll('.mini');
  down.onclick = () => nudge(name, -1);
  up.onclick = () => nudge(name, +1);
  $('exposure').append(tile);
}

let openChip = null, rulerKey = '';
function renderRuler(by) {
  const p = openChip && by[openChip];
  $('ruler').classList.toggle('hidden', !p);
  if (!p) { rulerKey = ''; return; }
  const track = $('rtrack'), key = `${p.name}:${p.values.join()}`;
  const rebuilt = key !== rulerKey;
  if (rebuilt) {
    rulerKey = key;
    track.style.transition = 'none';
    track.replaceChildren(...p.values.map(v => {
      const b = document.createElement('button');
      b.className = 'tick'; b.textContent = fmt(p.name, v);
      b.onclick = () => setProp(p.name, v);
      return b;
    }));
  }
  const i = Math.max(0, p.values.indexOf(p.value));
  [...track.children].forEach((b, j) => b.classList.toggle('on', j === i));
  track.style.transform = `translateX(${-(i * 80 + 40)}px)`;
  if (rebuilt) { track.offsetWidth; track.style.transition = ''; }
}

function renderProps() {
  const by = propsByName();
  $('modeBadge').textContent = by.mode ? fmt('mode', by.mode.value) : '–';
  $('batteryBadge').textContent = by.battery ? `${by.battery.value}%` : '–';

  if (openChip && !editable(by[openChip])) openChip = null;
  syncAdvice(by);
  for (const chip of $('chips').children) {
    const p = by[chip.dataset.name];
    chip.classList.toggle('hidden', !p);
    if (!p) continue;
    setText(chip.querySelector('.v'), fmt(p.name, p.value));
    chip.disabled = !editable(p);
    chip.classList.toggle('on', openChip === p.name);
    chip.setAttribute('aria-expanded', openChip === p.name);
    renderChipSuggestion(chip, p);
  }
  renderRuler(by);

  for (const tile of $('exposure').children) {
    const p = by[tile.dataset.name];
    tile.classList.toggle('hidden', !p);
    if (!p) continue;
    const sel = tile.querySelector('select'), values = p.values?.length ? p.values : [p.value];
    const sig = values.join();
    // Leave an open dropdown alone rather than rebuilding it under the user.
    if (sel.dataset.sig !== sig && document.activeElement !== sel) {
      sel.dataset.sig = sig;
      sel.replaceChildren(...values.map(v => new Option(fmt(p.name, v), v)));
    }
    if (sel.value !== String(p.value)) { sel.value = p.value; bump(sel); }
    const locked = !editable(p);
    sel.disabled = locked;
    tile.classList.toggle('locked', locked);
    tile.querySelectorAll('.mini').forEach(b => { b.disabled = locked; });
  }
  const mode = by.mode && fmt('mode', by.mode.value);
  $('modeHint').textContent = !mode ? '' :
    mode === 'M' ? 'Manual: aperture, shutter and ISO are all yours.' :
    ['P', 'A', 'S'].includes(mode) ? `Mode ${mode}: greyed-out settings are chosen by the camera. Turn the mode dial to M for full control.` :
    'Auto/scene mode: most settings are locked. Turn the mode dial to P, A, S or M to change them here.';
}

// ---------- gallery ----------
const shownPhotos = new Set();
function addPhoto(p, fresh = false) {
  if (shownPhotos.has(p.url)) return;
  shownPhotos.add(p.url);
  const b = document.createElement('button');
  b.title = p.name;
  const img = new Image();
  img.src = p.thumb; img.alt = p.name; img.loading = 'lazy';
  img.onerror = () => { img.onerror = null; img.src = p.preview; };
  b.append(img);
  if (p.video) b.insertAdjacentHTML('beforeend', '<span class="play">▶</span>');
  b.onclick = () => {
    $('viewerImg').classList.toggle('hidden', !!p.video);
    $('viewerVideo').classList.toggle('hidden', !p.video);
    if (p.video) $('viewerVideo').src = p.url; else $('viewerImg').src = p.preview;
    $('viewerName').textContent = `${p.day} · ${p.name} · ${(p.size / 1e6).toFixed(1)} MB`;
    $('viewerDownload').href = p.url; $('viewerDownload').download = p.name;
    $('viewer').showModal();
  };
  b.dataset.thumb = p.thumb;
  if (fresh) { b.classList.add('new'); setTimeout(() => b.classList.remove('new'), 2000); }
  $('strip').prepend(b);
  renderStack(fresh);
}

// The pile of the three latest shots under the controls; tapping it opens the shots drawer.
function renderStack(fresh) {
  const latest = [...$('strip').children].slice(0, 3);
  ['s0', 's1', 's2'].forEach((cls, i) => {
    $('stack').querySelector(`.${cls}`).style.backgroundImage = latest[i] ? `url("${latest[i].dataset.thumb}")` : '';
  });
  $('shotCount').textContent = $('strip').children.length;
  if (fresh) bump($('stack'));
}
function toggleFilm(open = !$('film').classList.contains('open')) {
  $('film').classList.toggle('open', open);
  $('stage').classList.toggle('film-open', open);
  $('stackBtn').setAttribute('aria-expanded', open);
}
$('stackBtn').onclick = () => toggleFilm();
$('viewerClose').onclick = () => $('viewer').close();
$('viewer').addEventListener('close', () => { $('viewerVideo').pause(); $('viewerVideo').removeAttribute('src'); });
$('viewer').onclick = e => { if (e.target === $('viewer')) $('viewer').close(); };
api('/api/photos').then(list => list.reverse().forEach(p => addPhoto(p)));

// ---------- controls ----------
$('shutter').onclick = primaryAction;
$('afBtn').onclick = () => actions.focus();
$('cancelBtn').onclick = cancel;
$('lvBtn').onclick = () => actions.liveView(!state.wantLiveView);
$('gridBtn').onclick = () => {
  const on = $('grid').classList.toggle('on');
  $('gridBtn').classList.toggle('active', on);
  $('gridBtn').setAttribute('aria-pressed', on);
};
$('reconnectBtn').onclick = () => api('/api/reconnect', {}).catch(e => toast(e.message, true));
$('zoomBtn').onclick = () => actions.zoom();
$('rotateBtn').onclick = () => setOrient({ rotate: (orient.rotate + 90) % 360 });
$('flipBtn').onclick = () => setOrient({ flip: !orient.flip });
$('viewport').addEventListener('click', tapToFocus);
// The stage resizes when the advanced drawer slides open, not only with the window.
new ResizeObserver(() => fitViewport(true)).observe($('stage'));

for (const b of $('modeSeg').querySelectorAll('button')) b.onclick = () => setMode(b.dataset.mode);
for (const b of $('driveSeg').querySelectorAll('button')) {
  b.onclick = () => {
    const m = b.dataset.drive;
    // Tapping the active Burst/Timer again steps through its counts, like a camera's drive dial.
    if (drive.mode === m && m === 'burst') drive.burst = BURSTS[(BURSTS.indexOf(drive.burst) + 1) % BURSTS.length];
    else if (drive.mode === m && m === 'timer') drive.timer = TIMERS[(TIMERS.indexOf(drive.timer) + 1) % TIMERS.length];
    else if (drive.mode === m && m === 'preset' && presets.length) drive.preset = (drive.preset + 1) % presets.length;
    drive.mode = m;
    saveDrive(); renderDrive(); renderPresets();
    if (m === 'preset' && presets[drive.preset]) toast(`P${drive.preset + 1} ${presets[drive.preset].name}: ${describePreset(presets[drive.preset])}`);
  };
}
for (const seg of document.querySelectorAll('.seg[data-opt]')) {
  for (const b of seg.querySelectorAll('button')) {
    b.onclick = () => { drive[seg.dataset.opt] = +b.dataset.v; saveDrive(); renderDrive(); };
  }
}
$('timerBurst').onchange = () => { drive.timerBurst = $('timerBurst').checked; saveDrive(); renderShutter(); };
renderDrive();

// ---------- exposure ruler ----------
$('rulerDown').onclick = () => openChip && nudge(openChip, -1);
$('rulerUp').onclick = () => openChip && nudge(openChip, +1);
$('ruler').addEventListener('wheel', e => {
  if (!openChip) return;
  e.preventDefault();
  nudge(openChip, Math.sign(e.deltaY || e.deltaX));
}, { passive: false });

// ---------- advanced drawer ----------
const TABS = ['capture', 'exposure', 'triggers', 'advisor'];
let tab = 'capture';
function showTab(name) {
  const dir = TABS.indexOf(name) >= TABS.indexOf(tab) ? 1 : -1;
  tab = name;
  pickSeg($('tabs'), $('tabs').querySelector(`[data-tab="${name}"]`));
  for (const b of $('tabs').querySelectorAll('button')) b.setAttribute('aria-selected', b.dataset.tab === name);
  for (const pane of document.querySelectorAll('.pane')) {
    const on = pane.dataset.pane === name;
    pane.classList.toggle('hidden', !on);
    if (on) pane.style.setProperty('--dir', `${dir * 24}px`);
  }
  $('expoMore').classList.toggle('active', advOpen && name === 'exposure');
}
let advOpen = false;
function toggleAdv(open = !advOpen, name) {
  advOpen = open;
  if (name) showTab(name);
  $('app').classList.toggle('adv-open', open);
  $('adv').inert = !open;
  $('advToggle').setAttribute('aria-expanded', open);
  $('expoMore').classList.toggle('active', open && tab === 'exposure');
}
for (const b of $('tabs').querySelectorAll('button')) b.onclick = () => showTab(b.dataset.tab);
$('advToggle').onclick = () => toggleAdv();
$('advClose').onclick = () => toggleAdv(false);
$('expoMore').onclick = () => (advOpen && tab === 'exposure' ? toggleAdv(false) : toggleAdv(true, 'exposure'));
$('scrim').onclick = () => { toggleAdv(false); toggleAssist(false); };

// On a phone in portrait the drawer is a bottom sheet: drag its header down to dismiss it.
const sheetMode = matchMedia('(max-width: 820px) and (min-height: 501px)');
let drag = null;
$('adv').querySelector('.adv-head').addEventListener('pointerdown', e => {
  if (!sheetMode.matches || e.target.closest('button')) return;
  drag = { y: e.clientY, t: performance.now(), dy: 0 };
  e.currentTarget.setPointerCapture(e.pointerId);
  $('adv').classList.add('dragging');
});
$('adv').querySelector('.adv-head').addEventListener('pointermove', e => {
  if (!drag) return;
  drag.dy = Math.max(0, e.clientY - drag.y);
  $('adv').style.setProperty('--drag', `${drag.dy}px`);
});
const endDrag = () => {
  if (!drag) return;
  const fling = drag.dy / (performance.now() - drag.t) > 0.5;
  $('adv').classList.remove('dragging');
  $('adv').style.removeProperty('--drag');
  if (drag.dy > 90 || (fling && drag.dy > 20)) toggleAdv(false);
  drag = null;
};
$('adv').querySelector('.adv-head').addEventListener('pointerup', endDrag);
$('adv').querySelector('.adv-head').addEventListener('pointercancel', endDrag);

// ---------- live view framing: fit, focus box, tap-to-focus, zoom ----------
let fitted = '';
function fitViewport(force = false) {
  const c = $('lv'), stage = $('stage');
  if (!c.width) return;
  const key = `${c.width}x${c.height}@${stage.clientWidth}x${stage.clientHeight}r${orient.rotate}`;
  if (key === fitted && !force) return;
  fitted = key;
  // Turned sideways, the frame's width runs up the stage, so fit it against swapped sides.
  const [w, h] = orient.rotate % 180 ? [c.height, c.width] : [c.width, c.height];
  const scale = Math.min(stage.clientWidth / w, stage.clientHeight / h);
  $('viewport').style.width = `${Math.floor(c.width * scale)}px`;
  $('viewport').style.height = `${Math.floor(c.height * scale)}px`;
}

function drawFocusBox() {
  const af = liveView.af, box = $('focusBox');
  box.classList.toggle('hidden', !af);
  if (!af) return;
  Object.assign(box.style, { left: `${af.x * 100}%`, top: `${af.y * 100}%`, width: `${af.w * 100}%`, height: `${af.h * 100}%` });
  if (zoomIndex) $('viewport').style.transformOrigin = `${(af.x + af.w / 2) * 100}% ${(af.y + af.h / 2) * 100}%`;
}

async function tapToFocus(e) {
  // getBoundingClientRect includes the zoom and orientation transforms. Undo the rotation and
  // mirror around the box centre so the tap lands on the same spot of the camera's frame.
  const r = $('viewport').getBoundingClientRect();
  const a = -orient.rotate * Math.PI / 180, dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
  const ux = Math.round(Math.cos(a)) * dx - Math.round(Math.sin(a)) * dy, uy = Math.round(Math.sin(a)) * dx + Math.round(Math.cos(a)) * dy;
  const [bw, bh] = orient.rotate % 180 ? [r.height, r.width] : [r.width, r.height];
  const x = 0.5 + (orient.flip ? -ux : ux) / bw, y = 0.5 + uy / bh;
  const ring = $('tapRing');
  ring.style.left = `${x * 100}%`; ring.style.top = `${y * 100}%`;
  ring.classList.remove('hidden'); ring.style.animation = 'none'; ring.offsetHeight; ring.style.animation = '';
  const box = $('focusBox');
  box.classList.remove('ok', 'bad');
  try {
    const { focus } = await api('/api/focus-point', { x, y });
    box.classList.add(focus === 'OK' ? 'ok' : 'bad');
    if (focus !== 'OK') toast(`Focus: ${focus}`, true);
  } catch (err) { box.classList.add('bad'); toast(err.message, true); }
  setTimeout(() => box.classList.remove('ok', 'bad'), 1500);
}

const ZOOMS = [1, 2, 3];
let zoomIndex = 0;
function setZoom(i) {
  zoomIndex = i;
  $('viewport').style.transform = ZOOMS[i] === 1 ? '' : `scale(${ZOOMS[i]})`;
  $('zoomLabel').textContent = `${ZOOMS[i]}×`;
  $('zoomBtn').classList.toggle('active', i > 0);
  drawFocusBox();
}

// Preview only: the camera's frame, captures and gesture input are untouched.
const orient = { rotate: 0, flip: false };
try { Object.assign(orient, JSON.parse(localStorage.orient || '{}')); } catch {}
function setOrient(next) {
  Object.assign(orient, next);
  try { localStorage.orient = JSON.stringify(orient); } catch {}
  $('orient').style.transform = `rotate(${orient.rotate}deg)${orient.flip ? ' scaleX(-1)' : ''}`;
  $('rotateLabel').textContent = `${orient.rotate}°`;
  $('rotateBtn').classList.toggle('active', orient.rotate > 0);
  $('flipBtn').classList.toggle('active', orient.flip);
  $('flipBtn').setAttribute('aria-pressed', orient.flip);
  fitViewport(true);
}
setOrient({});

// ---------- video recording ----------
async function setRecording(on) {
  if (seq || timelapse) return toast('Finish the current shots first', true);
  try { await api('/api/movie', { on }); toast(on ? '● Recording' : 'Recording stopped'); }
  catch (e) { toast(e.message, true); }
}

let recTimer;
function renderRecording() {
  const since = state.recordingSince;
  $('recBadge').classList.toggle('hidden', !since);
  // Recording started some other way (R, voice) still shows the stop button.
  if (since && captureMode !== 'video') setMode('video', true);
  renderShutter();
  clearInterval(recTimer);
  if (!since) return;
  const tick = () => {
    const s = Math.floor((Date.now() - since) / 1000);
    $('recBadge').textContent = `REC ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  tick();
  recTimer = setInterval(tick, 500);
}

// ---------- shot assist ----------
// Lives in the exposure bar: pick a scene (and conditions) or describe it, and the suggested
// values show on the exposure chips with one Apply. On a phone in portrait it is a bottom sheet
// that lists the changes itself, since the chips are too narrow to show them. Settings the mode
// dial locks are queued and set as soon as the camera reports them writable again.
const SCENES = [['boudoir', 'Low-light boudoir'], ['portrait', 'Portrait'], ['action', 'Action'], ['landscape', 'Landscape'],
  ['street', 'Street'], ['event', 'Indoor event'], ['night', 'Night'], ['product', 'Product']];
const CONDITIONS = ['Handheld', 'Tripod', 'No flash', 'Moody', 'Bright and airy', 'Freeze motion', 'Motion blur'];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const assist = (() => {
  try { return { scene: 'boudoir', mods: [], notes: '', ...JSON.parse(localStorage.assist || '{}') }; }
  catch { return { scene: 'boudoir', mods: [], notes: '' }; }
})();
const saveAssist = () => { try { localStorage.assist = JSON.stringify(assist); } catch {} };
let advice = null;         // { intent, scene, mode, tips, model, settings: [{ name, code, value, display, reason, status }] }
let assistOpen = false, assistReady = true;
let asking = null;         // AbortController while a request is out
let formOpen = true;       // scene inputs shown; folded into a one-line recap once results arrive

// status: 'pending' = suggested, not applied yet; 'queued' = accepted but locked by the dial; 'done'.
const openSuggestion = name => advice?.settings.find(s => s.name === name && s.status !== 'done');
const openSuggestions = () => advice?.settings.filter(s => s.status !== 'done') || [];
const isLocked = s => !propsByName()[s.name]?.writable;
const modeName = () => { const m = propsByName().mode; return m ? fmt('mode', m.value) : 'this'; };
const sceneLabel = () => SCENES.find(([id]) => id === assist.scene)?.[1] || '';
const modelLabel = () => $('advModel').selectedOptions[0]?.textContent || 'the model';
const LOCK = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

function renderChipSuggestion(chip, p) {
  const s = openSuggestion(p.name);
  const locked = !!s && !p.writable;
  chip.classList.toggle('sug', !!s);
  chip.classList.toggle('lk', locked);
  chip.querySelector('.n').textContent = s ? s.display : '';
  const why = s?.reason ? ` (${s.reason})` : '';
  chip.title = !s ? '' : locked
    ? `Suggested ${s.display}, but ${LABEL[p.name].toLowerCase()} is locked in ${modeName()} mode${why}`
    : `Suggested ${s.display}${why}`;
  chip.setAttribute('aria-label', `${LABEL[p.name]} ${fmt(p.name, p.value)}${s ? `, suggested ${s.display}${locked ? ', locked by the mode dial' : ''}` : ''}`);
}

// Called on every property update: retire suggestions the camera now matches, and set queued
// ones as soon as the dial unlocks them.
function syncAdvice(by) {
  if (advice) {
    for (const s of advice.settings) {
      const p = by[s.name];
      if (!p || s.status === 'done' || s.applying) continue;
      if (p.value === s.value) { s.status = 'done'; continue; }
      if (s.status === 'queued' && p.writable) {
        s.applying = true;
        api('/api/prop', { code: p.code, value: s.value })
          .then(() => { s.status = 'done'; toast(`${LABEL[s.name]} set to ${s.display}: the dial unlocked it`); })
          .catch(e => toast(`${LABEL[s.name]}: ${e.message}`, true))
          .finally(() => { s.applying = false; renderProps(); });
      }
    }
  }
  renderApply();
  if (assistOpen) renderAssistOut();
}

// The same Apply appears in the bar (desktop) and in the panel (phone).
function renderApply() {
  const open = openSuggestions();
  const pending = open.filter(s => s.status === 'pending');
  const now = pending.filter(s => !isLocked(s)).length, later = open.length - now;
  const html = now
    ? `${CHECK}Apply ${now}${later ? `<span class="later">+${later} locked</span>` : ''}`
    : `${LOCK}${pending.length ? 'Apply when unlocked' : `${later} waiting for the dial`}`;
  const title = later ? `Locked in ${modeName()} mode: ${open.filter(isLocked).map(s => LABEL[s.name]).join(', ')}` : '';
  for (const btn of [$('asApply'), $('asApplyPanel')]) {
    if (btn.dataset.html !== html) { btn.dataset.html = html; btn.innerHTML = html; }
    btn.classList.toggle('waiting', !now);
    btn.disabled = !pending.length;
    btn.title = title;
  }
  $('asBar').classList.toggle('hidden', !open.length);
  $('asActions').classList.toggle('hidden', !open.length || !!asking);
  $('asDot').classList.toggle('hidden', !open.length || assistOpen);
}

function renderAssistTags() {
  $('asScenes').replaceChildren(...SCENES.map(([id, label]) => {
    const b = document.createElement('button');
    b.className = 'tag'; b.textContent = label; b.setAttribute('aria-pressed', assist.scene === id);
    b.onclick = () => { assist.scene = assist.scene === id ? '' : id; saveAssist(); renderAssistTags(); };
    return b;
  }));
  $('asMods').replaceChildren(...CONDITIONS.map(m => {
    const b = document.createElement('button');
    b.className = 'tag sm'; b.textContent = m; b.setAttribute('aria-pressed', assist.mods.includes(m));
    b.onclick = () => {
      assist.mods = assist.mods.includes(m) ? assist.mods.filter(x => x !== m) : [...assist.mods, m];
      saveAssist(); renderAssistTags();
    };
    return b;
  }));
}

// With results showing, the inputs fold into one row ("Low-light boudoir · Handheld ✎").
function renderForm() {
  const folded = (!!advice || !!asking) && !formOpen;
  $('asForm').classList.toggle('hidden', folded);
  $('asRecap').classList.toggle('hidden', !folded);
  $('asRecap').setAttribute('aria-expanded', !folded);
  const notes = $('asNotes').value.trim();
  $('asRecapText').textContent = [sceneLabel() || 'Any scene', ...assist.mods, notes && `“${notes}”`].filter(Boolean).join(' · ');
  $('assist').classList.toggle('has-out', !!advice || !!asking);
}

function renderAssistOut() {
  const out = $('asOut');
  out.classList.toggle('hidden', !advice || !!asking);
  if (!advice) { out.dataset.html = ''; return; }
  const open = openSuggestions();
  const locked = open.filter(isLocked);
  const by = propsByName();
  // Lead with the changes. The list is what phones show; on wider screens the chips carry them.
  const rows = open.map(s => {
    const lk = isLocked(s), cur = by[s.name] ? fmt(s.name, by[s.name].value) : s.current;
    return `<li class="${lk ? 'lk' : ''}"><span class="nm">${lk ? LOCK : ''}${esc(LABEL[s.name] || s.name)}</span>
      <span class="ch"><span class="was">${esc(cur)}</span> → <b>${esc(s.display)}</b></span>
      ${lk || s.reason ? `<span class="why">${lk ? `After you turn the dial to ${esc(advice.mode || 'M')}${s.reason ? ' · ' : ''}` : ''}${esc(s.reason || '')}</span>` : ''}</li>`;
  }).join('');
  const offChip = open.filter(s => !CHIP_ROWS.includes(s.name));
  const they = locked.length > 1 ? 'they will' : 'it will';
  const tips = advice.tips.length + (advice.scene ? 1 : 0);
  const html = `
    ${rows ? `<ul class="as-list">${rows}</ul>` : ''}
    ${advice.intent ? `<p class="as-sum">${esc(advice.intent)}</p>` : ''}
    ${offChip.length ? `<p class="as-also">Also: ${offChip.map(s => `${esc(LABEL[s.name] || s.name)} → <b>${esc(s.display)}</b>`).join(' · ')}</p>` : ''}
    ${locked.length ? `<p class="as-warn">${LOCK}<span>${locked.map(s => `${esc(LABEL[s.name])} ${esc(s.display)}`).join(', ')}
      can't be set in ${esc(modeName())} mode. Turn the dial to ${esc(advice.mode || 'M')} and ${they} be set${locked.every(s => s.status === 'queued') ? '' : ' after you press Apply'}.</span></p>` : ''}
    ${!open.length ? '<p class="as-also">The camera matches these suggestions.</p>' : ''}
    ${tips ? `<details class="as-tips"><summary>${advice.scene ? 'About the scene' : ''}${advice.scene && advice.tips.length ? ' and ' : ''}${advice.tips.length ? `${advice.tips.length} tip${advice.tips.length > 1 ? 's' : ''}` : ''}</summary>
      ${advice.scene ? `<p>${esc(advice.scene)}</p>` : ''}${advice.tips.length ? `<ul>${advice.tips.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}</details>` : ''}`;
  // Property events re-render often; only rebuild when the text changes, so open tips stay open.
  if (html === out.dataset.html) return;
  const tipsOpen = out.querySelector('.as-tips')?.open;
  out.dataset.html = html;
  out.innerHTML = html;
  if (tipsOpen) out.querySelector('.as-tips')?.setAttribute('open', '');
}

function renderAssist() { renderForm(); renderAssistOut(); renderApply(); }

function toggleAssist(open = !assistOpen) {
  if (open === assistOpen) return;
  assistOpen = open;
  $('assist').classList.toggle('hidden', !open);
  $('app').classList.toggle('as-open', open);
  $('assistBtn').classList.toggle('active', open);
  $('assistBtn').setAttribute('aria-expanded', open);
  if (open && openChip) { openChip = null; renderProps(); }
  if (open && advOpen && sheetMode.matches) toggleAdv(false);
  if (open) { renderAssistTags(); renderAssist(); }
  renderApply();
}

// The API reports no progress, so the steps follow the usual timing: the frame goes out at
// once, the model takes a few seconds, and reading the answer is quick.
function setStep(text) { $('asStep').textContent = text; }

async function suggestSettings() {
  toggleAssist(true);
  if (asking) return;
  if (!assistReady) return toast('Add OPENROUTER_API_KEY to .env and restart to use shot assist', true);
  const ctl = asking = new AbortController();
  formOpen = false;
  $('assist').classList.add('busy'); $('assistBtn').classList.add('busy');
  $('asBusy').classList.remove('hidden');
  setStep('Capturing frame…');
  $('viewport').classList.remove('sending'); $('viewport').offsetWidth; $('viewport').classList.add('sending');
  renderAssist();
  const timer = setTimeout(() => setStep(`Asking ${modelLabel()}…`), 700);
  try {
    const notes = [...assist.mods, $('asNotes').value.trim()].filter(Boolean).join('; ');
    const r = await api('/api/advise', { scene: assist.scene, notes, model: $('advModel').value }, { signal: ctl.signal });
    clearTimeout(timer);
    setStep('Reading settings…');
    await sleep(350);
    if (ctl.signal.aborted) return;
    advice = { ...r, settings: r.settings.map(s => ({ ...s, status: s.same ? 'done' : 'pending' })) };
  } catch (e) {
    if (e.name === 'AbortError') toast('Cancelled');
    else toast(e.message, true);
    if (!advice) formOpen = true;
  } finally {
    clearTimeout(timer);
    if (asking === ctl) asking = null;
    $('assist').classList.remove('busy'); $('assistBtn').classList.remove('busy');
    $('asBusy').classList.add('hidden');
    renderProps();
    renderAssist();
  }
}

// One tap: set everything the dial allows now, queue the rest.
async function applyAdvice() {
  const pending = advice?.settings.filter(s => s.status === 'pending') || [];
  if (!pending.length) return toast(advice ? 'Nothing left to apply' : 'Ask shot assist for suggestions first', !advice);
  const failed = [], queued = [];
  for (const s of pending) {
    if (isLocked(s)) { s.status = 'queued'; queued.push(LABEL[s.name]); continue; }
    try { await setPropValue(s.name, s.value); s.status = 'done'; }
    catch (e) { failed.push(`${LABEL[s.name]}: ${e.message}`); }
  }
  renderProps();
  if (failed.length) toast(failed.join(' · '), true);
  else toast(queued.length ? `Applied. ${queued.join(', ')} will be set when you turn the dial to ${advice.mode || 'M'}` : 'Settings applied');
  if (!queued.length && !failed.length) toggleAssist(false);
}

function discardAdvice() { advice = null; formOpen = true; renderProps(); renderAssist(); }

// Like setProp, but throws so Apply can report each setting.
async function setPropValue(name, v) {
  const p = propsByName()[name];
  const prev = p.value;
  p.value = v; renderProps();
  try { await api('/api/prop', { code: p.code, value: v }); }
  catch (e) { p.value = prev; renderProps(); throw e; }
}

$('assistBtn').onclick = () => toggleAssist();
$('asClose').onclick = () => toggleAssist(false);
$('asGo').onclick = suggestSettings;
$('asCancel').onclick = () => asking?.abort();
$('asApply').onclick = $('asApplyPanel').onclick = applyAdvice;
$('asDiscard').onclick = $('asDiscardPanel').onclick = discardAdvice;
$('asRecap').onclick = () => { formOpen = true; renderAssistTags(); renderForm(); $('asNotes').focus({ preventScroll: true }); };
$('asModel').onclick = () => { toggleAssist(false); toggleAdv(true, 'advisor'); };
$('asNotes').value = assist.notes;
$('asNotes').oninput = () => { assist.notes = $('asNotes').value; saveAssist(); };
$('asNotes').onkeydown = e => { if (e.key === 'Enter') suggestSettings(); else if (e.key === 'Escape') toggleAssist(false); };
$('viewport').addEventListener('animationend', e => { if (e.animationName === 'sendFrame') $('viewport').classList.remove('sending'); });
const showModel = () => { $('asModel').textContent = `Model: ${modelLabel()}`; };
$('advModel').onchange = () => { try { localStorage.advModel = $('advModel').value; } catch {} showModel(); };
api('/api/advisor').then(c => {
  for (const m of c.models) $('advModel').add(new Option(m.label, m.id));
  try { if (c.models.some(m => m.id === localStorage.advModel)) $('advModel').value = localStorage.advModel; } catch {}
  showModel();
  if (c.provider) return;
  assistReady = false;
  $('advModel').disabled = true;
  $('asGo').disabled = true;
  $('asModel').textContent = 'Not set up: add an API key';
  $('advHint').textContent = 'Add OPENROUTER_API_KEY=… to a .env file next to package.json and restart to enable shot assist.';
}).catch(() => {});

// On a phone in portrait the panel is a bottom sheet like the advanced one: drag it down to close.
let asDrag = null;
const asHead = $('assist').querySelector('.as-head');
asHead.addEventListener('pointerdown', e => {
  if (!sheetMode.matches || e.target.closest('button')) return;
  asDrag = { y: e.clientY, t: performance.now(), dy: 0 };
  asHead.setPointerCapture(e.pointerId);
  $('assist').classList.add('dragging');
});
asHead.addEventListener('pointermove', e => {
  if (!asDrag) return;
  asDrag.dy = Math.max(0, e.clientY - asDrag.y);
  $('assist').style.setProperty('--drag', `${asDrag.dy}px`);
});
const endAsDrag = () => {
  if (!asDrag) return;
  const fling = asDrag.dy / (performance.now() - asDrag.t) > 0.5;
  $('assist').classList.remove('dragging');
  $('assist').style.removeProperty('--drag');
  if (asDrag.dy > 80 || (fling && asDrag.dy > 20)) toggleAssist(false);
  asDrag = null;
};
asHead.addEventListener('pointerup', endAsDrag);
asHead.addEventListener('pointercancel', endAsDrag);

// ---------- phone remote ----------
let qrLib;
async function loadQrLib() {
  qrLib ??= await new Promise((resolve, reject) => {
    const sc = document.createElement('script');
    sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
    sc.onload = () => resolve(window.qrcode);
    sc.onerror = () => reject(new Error('Could not load the QR code library (offline?)'));
    document.head.append(sc);
  }).catch(e => { toast(e.message, true); return null; });
}

function qrItem(url) {
  const item = document.createElement('div');
  if (qrLib) {
    const qr = qrLib(0, 'M'); qr.addData(url); qr.make();
    item.innerHTML = `<div class="qr">${qr.createImgTag(6, 0)}</div>`;
  }
  const code = document.createElement('code'); code.textContent = url;
  item.append(code);
  return item;
}

let tunnelPoll;
function renderTunnel(t) {
  const status = $('tunnelStatus');
  $('tunnelToggle').checked = t.status === 'starting' || t.status === 'on';
  status.classList.toggle('bad', t.status === 'error');
  status.textContent =
    t.status === 'starting' ? 'Starting Cloudflare tunnel…' :
    t.status === 'error' ? t.error :
    t.status === 'on' && !t.link ? 'Tunnel connected. Set CF_TUNNEL_URL to your tunnel\'s hostname to get a link here.' :
    t.status === 'on' ? (t.mode === 'quick' ? 'Live at a temporary address (changes every time). Scan from any network:' : 'Live. Scan from any network:') :
    'Works from any network, including mobile data, over https — so voice and clap work on the phone too.';
  $('tunnelQr').replaceChildren(...(t.link ? [qrItem(t.link)] : []));
  // cloudflared takes a few seconds to connect; check back until it settles.
  clearTimeout(tunnelPoll);
  if (t.status === 'starting' && $('phoneDialog').open) {
    tunnelPoll = setTimeout(() => api('/api/remote').then(r => renderTunnel(r.tunnel)).catch(() => {}), 1000);
  }
}

async function showPhoneDialog() {
  const { lan, urls, tunnel } = await api('/api/remote');
  await loadQrLib();
  const list = $('qrList');
  $('lanSection').classList.toggle('hidden', !lan);
  list.replaceChildren(...urls.map(qrItem));
  if (!urls.length) list.textContent = 'No Wi-Fi/Ethernet network found on this laptop.';
  $('phoneDialog').showModal();
  renderTunnel(tunnel);
}
$('tunnelToggle').onchange = () =>
  api('/api/tunnel', { on: $('tunnelToggle').checked }).then(renderTunnel).catch(e => toast(e.message, true));
$('phoneBtn').onclick = () => showPhoneDialog().catch(e => toast(e.message, true));
$('phoneClose').onclick = () => $('phoneDialog').close();
$('phoneDialog').addEventListener('close', () => clearTimeout(tunnelPoll));
// Only the laptop itself may see the access key, so the button only appears there.
api('/api/remote').then(() => $('phoneBtn').classList.remove('hidden')).catch(() => {});

document.addEventListener('keydown', e => {
  if (e.target.matches('input, select, textarea') || e.repeat || $('viewer').open || $('phoneDialog').open) return;
  const k = e.key.toLowerCase();
  if (k === ' ') { e.preventDefault(); primaryAction(); }
  else if (k === 'f') actions.focus();
  else if (k === 'l') $('lvBtn').click();
  else if (k === 'g') $('gridBtn').click();
  else if (k === 'z') actions.zoom();
  else if (k === 'o') $('rotateBtn').click();
  else if (k === 'h') $('flipBtn').click();
  else if (k === 'r') actions.record();
  else if (k === 'a') actions.advise();
  else if (k === 'i') { e.preventDefault(); inspo.toggle(); }
  else if ((k === '[' || k === ']') && inspo.isOpen) inspo.step(k === ']' ? 1 : -1);
  else if (k === 'm') toggleAdv();
  else if (k === 'escape') {
    if (openChip) { openChip = null; renderProps(); }
    toggleAssist(false);
    toggleFilm(false);
    cancel();
  }
});

// ---------- inspo + pose match ----------
const pose = new PoseMatch({
  liveView,
  overlay: $('poseOverlay'),
  onUpdate: ({ score, hint }) => {
    const pct = score == null ? null : Math.round(score * 100);
    $('poseScore').textContent = pct == null ? '–' : `${pct}%`;
    $('poseHint').textContent = hint;
    $('poseHud').classList.toggle('good', pct >= 85);
    $('poseHud').classList.toggle('close', pct >= 65 && pct < 85);
  },
});
const inspo = new Inspo({ api, pose, toast, getModel: () => $('advModel').value });
$('inspoBtn').onclick = () => inspo.toggle();

// ---------- triggers ----------
function triggerToggle(id, badgeId, trigger) {
  $(id).onchange = async () => {
    if ($(id).checked) {
      try { await trigger.start(); }
      catch (e) { $(id).checked = false; toast(e.message, true); }
    } else trigger.stop();
    const on = $(id).checked;
    $(badgeId).classList.toggle('hidden', !on);
    const rail = document.querySelector(`.trig[data-toggle="${id}"]`);
    rail.classList.toggle('on', on);
    rail.setAttribute('aria-pressed', on);
    document.querySelector(`.tcard[data-card="${id}"]`).classList.toggle('on', on);
    renderGuide();
  };
}

// ---------- hands-free guide: what to say / which gesture does what, over the live view ----------
function renderVoiceHelp() {
  $('voiceHelp').replaceChildren(...VOICE_HELP.map(c => {
    const row = document.createElement('div');
    row.className = 'cmd';
    const say = document.createElement('b'), does = document.createElement('em');
    say.textContent = `“${c.say}”`; does.textContent = c.does;
    row.append(say, does);
    if (c.also) {
      const also = document.createElement('span');
      also.textContent = `or ${c.also.map(a => `“${a}”`).join(', ')}`;
      row.append(also);
    }
    return row;
  }));
  $('guidePhrases').replaceChildren(...VOICE_HELP.filter(c => c.key).map(c => {
    const p = document.createElement('span');
    p.className = 'phrase'; p.textContent = `“${c.say}”`; p.title = c.does;
    return p;
  }));
}

function renderGestureGuide() {
  const legend = gestures.legend();
  $('guideTiles').replaceChildren(...legend.map(g => {
    const t = document.createElement('div');
    t.className = 'gtile'; t.dataset.g = g.gesture; t.title = g.label;
    t.innerHTML = '<span class="em"></span><span class="act"></span>';
    t.querySelector('.em').textContent = g.emoji;
    t.querySelector('.act').textContent = g.action;
    return t;
  }));
  if (!legend.length) $('guideTiles').textContent = 'No gestures are set to do anything. Pick actions under All commands.';
}

function renderGuide() {
  const v = $('voiceToggle').checked, g = $('gestureToggle').checked, c = $('clapToggle').checked;
  $('guide').classList.toggle('hidden', !v && !g && !c);
  $('guideVoice').classList.toggle('hidden', !v);
  $('guideGest').classList.toggle('hidden', !g);
  $('guideClap').classList.toggle('hidden', !c);
}

function foldGuide(folded) {
  $('guide').classList.toggle('folded', folded);
  $('guideFold').setAttribute('aria-expanded', !folded);
  $('guideFold').setAttribute('aria-label', folded ? 'Show the guide' : 'Hide the guide');
  try { localStorage.guideFolded = folded ? '1' : ''; } catch {}
}
$('guideFold').onclick = () => foldGuide(!$('guide').classList.contains('folded'));
$('guideAll').onclick = () => toggleAdv(true, 'triggers');
try { foldGuide(!!localStorage.guideFolded); } catch {}

function showHeard(text, matched) {
  const el = $('guideHeard');
  el.replaceChildren();
  const quote = document.createElement('span');
  quote.textContent = `“${text}”`;
  const result = document.createElement('b');
  result.textContent = matched ? `→ ${matched}` : '→ not a command';
  el.append(quote, ' ', result);
  el.classList.toggle('hit', !!matched);
  el.classList.toggle('miss', !matched);
  bump(el);
}
// The rail buttons flip the same checkboxes as the cards in the Triggers tab.
for (const b of document.querySelectorAll('.trig[data-toggle]')) {
  b.onclick = () => {
    const cb = $(b.dataset.toggle);
    if (cb.disabled) return toggleAdv(true, 'triggers'); // shows why it's unavailable
    cb.checked = !cb.checked;
    cb.dispatchEvent(new Event('change'));
  };
}

const voice = new VoiceTrigger({
  actions,
  onHeard: (text, matched) => {
    $('heard').textContent = `“${text}”${matched ? ` → ${matched}` : ''}`;
    showHeard(text, matched);
    if (matched) toast(`🎙 ${matched}`);
  },
});
triggerToggle('voiceToggle', 'voiceBadge', voice);
renderVoiceHelp();

const gestures = new GestureTrigger({
  actions,
  liveView,
  webcam: $('webcam'),
  getSource: () => $('gestureSource').value,
  onUpdate: (name, progress) => {
    const g = GESTURES[name];
    const tile = $('guideTiles').querySelector(`[data-g="${name}"]`);
    $('gestureName').textContent = !name ? 'Looking for a hand…' : !g ? name :
      `${g.emoji} ${g.label}${tile ? '' : ' — does nothing'}`;
    $('gestureHold').style.width = `${Math.round(progress * 100)}%`;
    // The tile for the gesture being held lights up and fills as the hold completes.
    for (const t of $('guideTiles').children) {
      t.classList.toggle('live', t === tile);
      t.style.setProperty('--p', t === tile ? progress : 0);
    }
    lastGesture = name;
  },
  onFire: label => {
    const tile = $('guideTiles').querySelector(`[data-g="${lastGesture}"]`);
    if (tile) { tile.classList.remove('fired'); tile.offsetWidth; tile.classList.add('fired'); }
    toast(`✋ ${label}`);
  },
});
let lastGesture = null;
triggerToggle('gestureToggle', 'gestureBadge', gestures);
$('gestureToggle').addEventListener('change', () => {
  $('gestureHud').classList.toggle('hidden', !$('gestureToggle').checked);
  $('gestureHud').classList.toggle('webcam', $('gestureSource').value === 'webcam');
});
$('gestureSource').onchange = async () => {
  $('gestureHud').classList.toggle('webcam', $('gestureSource').value === 'webcam');
  if ($('gestureToggle').checked) { gestures.stop(); await gestures.start().catch(e => toast(e.message, true)); }
};
gestures.renderMap($('gestureMap'));
renderGestureGuide();
// The map's selects save themselves; the guide just follows along.
$('gestureMap').addEventListener('change', renderGestureGuide);

const clap = new ClapTrigger({
  onClap: () => { toast('👏 Clap!'); actions.sequence(); },
  onLevel: l => {
    const w = `${Math.min(100, l * 100)}%`;
    $('clapMeter').style.width = w;
    $('guideClapMeter').style.width = w;
  },
  getSensitivity: () => +$('clapSens').value,
});
triggerToggle('clapToggle', 'clapBadge', clap);

if (!window.isSecureContext) {
  // Phones on plain http get no microphone/camera access: leave only live-view gestures.
  for (const id of ['voiceToggle', 'clapToggle']) $(id).disabled = true;
  $('gestureSource').querySelector('[value=webcam]').disabled = true;
  $('secureHint').classList.remove('hidden');
}
