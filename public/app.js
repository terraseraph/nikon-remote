import { fmt, LABEL } from './format.js';
import { VoiceTrigger } from './triggers/voice.js';
import { GestureTrigger, GESTURES } from './triggers/gestures.js';
import { ClapTrigger } from './triggers/clap.js';
import { LiveView } from './liveview.js';

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let state = { connected: false, props: {} };
const liveView = new LiveView($('lv'), { onFrame: () => { fitViewport(); drawFocusBox(); } });

// ---------- API ----------
async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

const events = new EventSource('/api/events');
events.addEventListener('state', e => { state = JSON.parse(e.data); render(); });
events.addEventListener('prop', e => { const p = JSON.parse(e.data); state.props[p.code] = p; renderProps(); });
events.addEventListener('photo', e => addPhoto(JSON.parse(e.data), true));
events.addEventListener('log', e => console.log('[camera]', JSON.parse(e.data)));

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

function flash() {
  const f = $('flash');
  f.classList.add('on');
  requestAnimationFrame(() => requestAnimationFrame(() => f.classList.remove('on')));
}

// ---------- shooting sequences ----------
// One sequence at a time; any new trigger while one runs is ignored, "cancel" stops it.
let seq = null;

function seqStatus(text) {
  const s = $('seqStatus');
  s.textContent = text || '';
  s.classList.toggle('hidden', !text);
}

async function countdown(secs, token) {
  const el = $('countdown');
  for (let s = secs; s > 0; s--) {
    if (token.cancelled) break;
    el.textContent = s; el.classList.remove('hidden');
    el.style.animation = 'none'; el.offsetHeight; el.style.animation = '';
    beep(s <= 3 ? 1100 : 880);
    await sleep(1000);
  }
  el.classList.add('hidden');
}

async function shootOnce() {
  beep(1600, 140);
  flash();
  try {
    clap.quiet(2500); // the shutter itself is loud enough to count as a clap
    const r = await api('/api/shoot', { af: $('afBefore').checked });
    clap.quiet(1500);
    if (!r.ok) toast(`Shot failed: ${r.code}`, true);
    else if (r.focus && r.focus !== 'OK') toast(`Shot taken (focus: ${r.focus})`);
    return r.ok;
  } catch (e) { toast(e.message, true); return false; }
}

async function runSequence({ delay = +$('delay').value, count = +$('count').value, gap = +$('gap').value, label } = {}) {
  if (seq) return toast('Already shooting — say “cancel” to stop');
  const token = (seq = { cancelled: false });
  $('shutter').classList.add('busy');
  try {
    if (delay) await countdown(delay, token);
    for (let i = 1; i <= count && !token.cancelled; i++) {
      if (count > 1) seqStatus(`${label || 'Burst'} ${i}/${count}`);
      await shootOnce();
      if (i < count && !token.cancelled) await sleep(gap * 1000);
    }
  } finally {
    seq = null; seqStatus('');
    $('shutter').classList.remove('busy');
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
  const every = +$('tlEvery').value, frames = +$('tlFrames').value || Infinity;
  const token = (timelapse = { cancelled: false });
  $('tlBtn').textContent = 'Stop time-lapse'; $('tlBtn').classList.add('active');
  for (let i = 1; i <= frames && !token.cancelled; i++) {
    const t0 = Date.now();
    seqStatus(`Time-lapse ${i}${frames === Infinity ? '' : `/${frames}`}`);
    await shootOnce();
    while (!token.cancelled && Date.now() - t0 < every * 1000) await sleep(100);
  }
  stopTimelapse();
}
function stopTimelapse() {
  if (timelapse) timelapse.cancelled = true;
  timelapse = null; seqStatus('');
  $('tlBtn').textContent = 'Start time-lapse'; $('tlBtn').classList.remove('active');
}

// ---------- actions (shared by buttons, keys, voice, gestures, clap) ----------
const PROP = { aperture: 0x5007, shutter: 0xd100, iso: 0x500f, ev: 0x5010 };

async function step(name, delta) {
  try {
    const p = await api('/api/prop/step', { code: PROP[name], delta });
    toast(`${LABEL[name]}: ${fmt(name, p.value)}`);
  } catch (e) { toast(e.message, true); }
}

export const actions = {
  shoot: () => runSequence({ delay: 0, count: 1 }),
  sequence: () => runSequence(),
  timer: n => runSequence({ delay: n, count: 1 }),
  burst: n => runSequence({ delay: 0, count: n, gap: 0.5 }),
  timerBurst: n => runSequence({ delay: 3, count: n, gap: 1 }),
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
};

// ---------- rendering ----------
function render() {
  $('connDot').classList.toggle('on', state.connected);
  const model = (state.model || state.name || '').replace(/_(\d)$/, (_, n) => 'I'.repeat(+n)); // "Z50_2" → "Z50II"
  $('camName').textContent = state.connected ? `Nikon ${model}` : (state.error || 'Camera disconnected');
  $('shutter').disabled = !state.connected;
  $('lvBtn').classList.toggle('active', state.wantLiveView);
  const showLv = state.connected && state.wantLiveView;
  $('viewport').classList.toggle('hidden', !showLv);
  $('lvPlaceholder').classList.toggle('hidden', showLv);
  $('lvPlaceholder').textContent = state.connected ? 'Live view off — press L or the Live view button' : 'Plug in the camera and switch it on';
  showLv ? liveView.start() : liveView.stop();
  renderRecording();
  renderProps();
}

const EXPOSURE_ROWS = ['aperture', 'shutter', 'iso', 'ev', 'wb', 'metering', 'focus', 'quality', 'size'];

function renderProps() {
  const props = Object.entries(state.props).map(([code, p]) => ({ code: +code, ...p }));
  const by = Object.fromEntries(props.map(p => [p.name, p]));
  $('modeBadge').textContent = by.mode ? fmt('mode', by.mode.value) : '–';
  $('batteryBadge').textContent = by.battery ? fmt('battery', by.battery.value) : '–';

  const box = $('exposure');
  box.innerHTML = '';
  for (const name of EXPOSURE_ROWS) {
    const p = by[name];
    if (!p) continue;
    const label = document.createElement('div');
    label.className = 'name'; label.textContent = LABEL[name];
    const ctl = document.createElement('div');
    ctl.className = 'stepper';
    const sel = document.createElement('select');
    const values = p.values?.length ? p.values : [p.value];
    for (const v of values) sel.add(new Option(fmt(name, v), v, false, v === p.value));
    sel.disabled = !p.writable || values.length < 2;
    sel.onchange = async () => {
      const v = typeof p.value === 'string' ? sel.value : +sel.value;
      try { await api('/api/prop', { code: p.code, value: v }); } catch (e) { toast(e.message, true); renderProps(); }
    };
    ctl.append(sel);
    if (PROP[name]) {
      for (const [txt, d] of [['−', -1], ['+', 1]]) {
        const b = document.createElement('button');
        b.textContent = txt; b.disabled = sel.disabled;
        b.onclick = () => step(name, d);
        ctl.append(b);
      }
    }
    box.append(label, ctl);
  }
  const mode = by.mode && fmt('mode', by.mode.value);
  $('modeHint').textContent = !mode ? '' :
    mode === 'M' ? 'Manual: aperture, shutter and ISO are all yours.' :
    ['P', 'A', 'S'].includes(mode) ? `Mode ${mode}: greyed-out settings are chosen by the camera. Turn the mode dial to M for full control.` :
    'Auto/scene mode: most settings are locked. Turn the mode dial to P, A, S or M to change them here.';
}

// ---------- gallery ----------
function addPhoto(p, fresh = false) {
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
  if (fresh) { b.classList.add('new'); setTimeout(() => b.classList.remove('new'), 2000); }
  $('strip').prepend(b);
}
$('viewerClose').onclick = () => $('viewer').close();
$('viewer').addEventListener('close', () => { $('viewerVideo').pause(); $('viewerVideo').removeAttribute('src'); });
$('viewer').onclick = e => { if (e.target === $('viewer')) $('viewer').close(); };
api('/api/photos').then(list => list.reverse().forEach(p => addPhoto(p)));

// ---------- controls ----------
$('shutter').onclick = () => actions.sequence();
$('afBtn').onclick = () => actions.focus();
$('cancelBtn').onclick = cancel;
$('lvBtn').onclick = () => actions.liveView(!state.wantLiveView);
$('gridBtn').onclick = () => { $('grid').classList.toggle('hidden'); $('gridBtn').classList.toggle('active'); };
$('reconnectBtn').onclick = () => api('/api/reconnect', {}).catch(e => toast(e.message, true));
$('tlBtn').onclick = () => (timelapse ? stopTimelapse() : startTimelapse());
$('recBtn').onclick = () => actions.record();
$('zoomBtn').onclick = () => actions.zoom();
$('viewport').addEventListener('click', tapToFocus);
window.addEventListener('resize', () => fitViewport(true));

// ---------- live view framing: fit, focus box, tap-to-focus, zoom ----------
let fitted = '';
function fitViewport(force = false) {
  const c = $('lv'), stage = $('stage');
  if (!c.width) return;
  const key = `${c.width}x${c.height}@${stage.clientWidth}x${stage.clientHeight}`;
  if (key === fitted && !force) return;
  fitted = key;
  const scale = Math.min(stage.clientWidth / c.width, stage.clientHeight / c.height);
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
  // getBoundingClientRect includes the zoom transform, so taps map correctly while magnified.
  const r = $('viewport').getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
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
  $('zoomBtn').textContent = `Zoom ${ZOOMS[i]}×`;
  $('zoomBtn').classList.toggle('active', i > 0);
  drawFocusBox();
}

// ---------- video recording ----------
async function setRecording(on) {
  if (seq || timelapse) return toast('Finish the current shots first', true);
  try { await api('/api/movie', { on }); toast(on ? '● Recording' : 'Recording stopped'); }
  catch (e) { toast(e.message, true); }
}

let recTimer;
function renderRecording() {
  const since = state.recordingSince;
  $('recBtn').classList.toggle('on', !!since);
  $('recLabel').textContent = since ? 'Stop recording (R)' : 'Record video (R)';
  $('recBadge').classList.toggle('hidden', !since);
  $('shutter').disabled = !state.connected || !!since;
  clearInterval(recTimer);
  if (!since) return;
  const tick = () => {
    const s = Math.floor((Date.now() - since) / 1000);
    $('recBadge').textContent = `● REC ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  tick();
  recTimer = setInterval(tick, 500);
}

// ---------- phone remote ----------
let qrLib;
async function showPhoneDialog() {
  const { urls } = await api('/api/remote');
  const list = $('qrList');
  list.innerHTML = '';
  if (!urls.length) list.textContent = 'No Wi-Fi/Ethernet network found on this laptop.';
  qrLib ??= await new Promise((resolve, reject) => {
    const sc = document.createElement('script');
    sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
    sc.onload = () => resolve(window.qrcode);
    sc.onerror = () => reject(new Error('Could not load the QR code library (offline?)'));
    document.head.append(sc);
  }).catch(e => { toast(e.message, true); return null; });
  for (const url of urls) {
    const item = document.createElement('div');
    if (qrLib) {
      const qr = qrLib(0, 'M'); qr.addData(url); qr.make();
      item.innerHTML = `<div class="qr">${qr.createImgTag(6, 0)}</div>`;
    }
    const code = document.createElement('code'); code.textContent = url;
    item.append(code);
    list.append(item);
  }
  $('phoneDialog').showModal();
}
$('phoneBtn').onclick = () => showPhoneDialog().catch(e => toast(e.message, true));
$('phoneClose').onclick = () => $('phoneDialog').close();
// Only the laptop itself may see the access key, so the button only appears there.
api('/api/remote').then(r => $('phoneBtn').classList.toggle('hidden', !r.lan)).catch(() => {});

document.addEventListener('keydown', e => {
  if (e.target.matches('input, select, textarea') || e.repeat || $('viewer').open || $('phoneDialog').open) return;
  const k = e.key.toLowerCase();
  if (k === ' ') { e.preventDefault(); actions.sequence(); }
  else if (k === 'f') actions.focus();
  else if (k === 'l') $('lvBtn').click();
  else if (k === 'g') $('gridBtn').click();
  else if (k === 'z') actions.zoom();
  else if (k === 'r') actions.record();
  else if (k === 'escape') cancel();
});

// ---------- triggers ----------
function triggerToggle(id, badgeId, trigger) {
  $(id).onchange = async () => {
    if ($(id).checked) {
      try { await trigger.start(); }
      catch (e) { $(id).checked = false; toast(e.message, true); }
    } else trigger.stop();
    $(badgeId).classList.toggle('hidden', !$(id).checked);
  };
}

const voice = new VoiceTrigger({
  actions,
  onHeard: (text, matched) => { $('heard').textContent = `“${text}”${matched ? ` → ${matched}` : ''}`; if (matched) toast(`🎙 ${matched}`); },
});
triggerToggle('voiceToggle', 'voiceBadge', voice);

const gestures = new GestureTrigger({
  actions,
  liveView,
  webcam: $('webcam'),
  getSource: () => $('gestureSource').value,
  onUpdate: (name, progress) => {
    $('gestureName').textContent = name ? `${GESTURES[name]?.emoji || ''} ${GESTURES[name]?.label || name}` : 'No hand';
    $('gestureHold').style.width = `${Math.round(progress * 100)}%`;
  },
  onFire: label => toast(`✋ ${label}`),
});
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

const clap = new ClapTrigger({
  onClap: () => { toast('👏 Clap!'); actions.sequence(); },
  onLevel: l => { $('clapMeter').style.width = `${Math.min(100, l * 100)}%`; },
  getSensitivity: () => +$('clapSens').value,
});
triggerToggle('clapToggle', 'clapBadge', clap);

if (!window.isSecureContext) {
  // Phones on plain http get no microphone/camera access: leave only live-view gestures.
  for (const id of ['voiceToggle', 'clapToggle']) $(id).disabled = true;
  $('gestureSource').querySelector('[value=webcam]').disabled = true;
  $('secureHint').classList.remove('hidden');
}
