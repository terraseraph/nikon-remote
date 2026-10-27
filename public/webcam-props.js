// Webcam controls as camera properties. A webcam's MediaStreamTrack reports what it can do
// (getCapabilities: ranges and mode lists) and its current settings; this turns them into the same
// property model the tethered cameras use — { name, value, values, writable } under a code — so the
// chips, exposure tiles, voice steps, scene presets and AI advisor work on a webcam unchanged.
// Where a control means the same thing as a camera setting it reuses that setting's code and
// canonical units (shutter as num << 16 | den, EV in thousandths, PTP codes for WB and focus);
// the rest get codes above 0xffff, which no PTP property can have. Pure, so tests run it in Node.

export const CODES = {
  mode: 0x500e, shutter: 0xd100, iso: 0x500f, ev: 0x5010, wb: 0x5005, focus: 0x500a, size: 0x5003,
  kelvin: 0x1f001, focusDist: 0x1f002, brightness: 0x1f003, contrast: 0x1f004, saturation: 0x1f005,
  sharpness: 0x1f006, zoom: 0x1f007, pan: 0x1f008, tilt: 0x1f009, torch: 0x1f00a,
};

// Exposure "mode": P lets the webcam expose itself, M holds the shutter and ISO you set.
const MODE = { continuous: 2, manual: 1 };
const FOCUS = { continuous: 0x8011, 'single-shot': 0x8010, manual: 1 };
// White balance presets as colour temperatures; Auto (2) is the webcam's own continuous mode.
const WB_K = [[6, 3000], [5, 4000], [4, 5500], [0x8010, 6500], [0x8011, 7500]];
const ISOS = [50, 64, 80, 100, 125, 160, 200, 250, 320, 400, 500, 640, 800, 1000, 1250, 1600, 2000, 2500, 3200, 4000, 5000, 6400, 8000, 10000, 12800];
const SHUTTER_DENS = [8000, 6400, 5000, 4000, 3200, 2500, 2000, 1600, 1250, 1000, 800, 640, 500, 400, 320, 250, 200, 160, 125, 100, 80, 60, 50, 40, 30, 25, 20, 15, 13, 10, 8, 6, 5, 4, 3];
const SHUTTER_SECS = [0.3, 0.4, 0.5, 0.6, 0.8, 1, 1.3, 1.6, 2, 2.5, 3.2, 4, 5, 6, 8, 10, 13, 15, 20, 25, 30];
const SIZES = [[640, 480], [800, 600], [1024, 576], [1280, 720], [1280, 960], [1600, 1200], [1920, 1080], [2560, 1440], [2592, 1944], [3840, 2160]];
// The plain sliders, in the order the exposure tiles show them.
const RANGES = ['brightness', 'contrast', 'saturation', 'sharpness', 'zoom', 'pan', 'tilt'];

// Canonical shutter value ↔ seconds. The browser's exposureTime is in units of 100 µs.
export const shutterValue = s => (s >= 0.28 ? (Math.round(s * 10) << 16 | 10) >>> 0 : (1 << 16 | Math.round(1 / s)) >>> 0);
export const shutterSeconds = v => (v >>> 16) / (v & 0xffff);
const SHUTTERS = [...SHUTTER_DENS.map(d => (1 << 16 | d) >>> 0), ...SHUTTER_SECS.map(shutterValue)];

const snap = (v, r) => {
  const s = r.step > 0 ? r.min + Math.round((v - r.min) / r.step) * r.step : v;
  return Math.min(r.max, Math.max(r.min, +s.toFixed(6)));
};
const isRange = r => r && typeof r.min === 'number' && typeof r.max === 'number' && r.max > r.min;
const closest = (list, v, by = x => x) => list.reduce((a, b) => (Math.abs(by(b) - v) < Math.abs(by(a) - v) ? b : a));
const logClosest = (list, v, by = x => x) => closest(list, Math.log(v), x => Math.log(by(x)));

// A continuous range as a short list of values the controls can step through: every step when
// there are few, else about `count` evenly spaced ones, always with both ends and the current value.
export function stepped(r, current, count = 21) {
  const n = r.step > 0 ? Math.floor((r.max - r.min) / r.step + 1e-9) : Infinity;
  const out = new Set();
  if (n < count) for (let i = 0; i <= n; i++) out.add(snap(r.min + i * r.step, r));
  else for (let i = 0; i < count; i++) out.add(snap(r.min + (r.max - r.min) * i / (count - 1), r));
  out.add(r.max);
  if (Number.isFinite(current)) out.add(snap(current, r));
  return [...out].sort((a, b) => a - b);
}

// → { props: { [code]: { name, value, values, writable } }, features }
export function capsToProps(caps = {}, settings = {}) {
  const props = {};
  const add = (name, value, values) => {
    if (value === undefined || !values?.length) return;
    props[CODES[name]] = { name, value, values, writable: values.length > 1 };
  };
  const has = (list, x) => Array.isArray(list) && list.includes(x);

  const modes = (caps.exposureMode || []).filter(m => MODE[m]);
  if (modes.length) add('mode', MODE[settings.exposureMode] ?? MODE[modes[0]], modes.map(m => MODE[m]));
  if (isRange(caps.exposureTime)) {
    const r = caps.exposureTime;
    const values = SHUTTERS.filter(v => shutterSeconds(v) * 1e4 >= r.min * 0.97 && shutterSeconds(v) * 1e4 <= r.max * 1.03)
      .sort((a, b) => shutterSeconds(a) - shutterSeconds(b));
    const now = settings.exposureTime > 0 ? settings.exposureTime / 1e4 : null;
    if (values.length) add('shutter', now ? logClosest(values, now, shutterSeconds) : values[0], values);
  }
  if (isRange(caps.iso)) {
    const r = caps.iso;
    let values = ISOS.filter(v => v >= r.min && v <= r.max);
    if (values.length < 3) values = stepped(r, settings.iso, 9); // a webcam with its own ISO scale
    if (values.length) add('iso', settings.iso > 0 ? logClosest(values, settings.iso) : values[0], values);
  }
  if (isRange(caps.exposureCompensation)) {
    const r = caps.exposureCompensation;
    const step = Math.max(r.step || 0, 1 / 3);
    const values = [];
    for (let k = Math.ceil(r.min / step - 1e-9); k <= Math.floor(r.max / step + 1e-9); k++) values.push(Math.round(k * step * 1000));
    if (values.length) add('ev', closest(values, (settings.exposureCompensation || 0) * 1000), values);
  }

  const wbModes = caps.whiteBalanceMode || [];
  const kRange = isRange(caps.colorTemperature) ? caps.colorTemperature : null;
  if (has(wbModes, 'continuous') || kRange) {
    const presets = kRange ? WB_K.filter(([, k]) => k >= kRange.min && k <= kRange.max) : [];
    const values = [...(has(wbModes, 'continuous') ? [2] : []), ...presets.map(([c]) => c)];
    const auto = settings.whiteBalanceMode !== 'manual' && values[0] === 2;
    const value = auto || !presets.length ? values[0] : closest(presets, settings.colorTemperature || 5500, ([, k]) => k)[0];
    add('wb', value, values);
  }
  if (kRange) add('kelvin', settings.colorTemperature ? snap(settings.colorTemperature, kRange) : kRange.min, stepped(kRange, settings.colorTemperature));

  const focusModes = (caps.focusMode || []).filter(m => FOCUS[m]);
  if (focusModes.length) add('focus', FOCUS[settings.focusMode] ?? FOCUS[focusModes[0]], focusModes.map(m => FOCUS[m]));
  if (isRange(caps.focusDistance)) add('focusDist', snap(settings.focusDistance ?? caps.focusDistance.min, caps.focusDistance), stepped(caps.focusDistance, settings.focusDistance));

  for (const name of RANGES) {
    const r = caps[name];
    if (isRange(r)) add(name, snap(settings[name] ?? r.min, r), stepped(r, settings[name]));
  }
  if (caps.torch === true || (Array.isArray(caps.torch) && caps.torch.includes(true))) add('torch', settings.torch ? 1 : 0, [0, 1]);

  if (isRange(caps.width) && isRange(caps.height)) {
    const sizes = SIZES.filter(([w, h]) => w >= caps.width.min && w <= caps.width.max && h >= caps.height.min && h <= caps.height.max).map(([w, h]) => `${w}x${h}`);
    const now = settings.width && `${settings.width}x${settings.height}`;
    if (now && !sizes.includes(now)) sizes.push(now);
    sizes.sort((a, b) => parseInt(a) - parseInt(b) || a.split('x')[1] - b.split('x')[1]);
    add('size', now || sizes.at(-1), sizes);
  }

  const features = {
    liveView: true, movie: typeof MediaRecorder !== 'undefined',
    autofocus: focusModes.includes('single-shot') || focusModes.includes('continuous'),
    focusPoint: 'pointsOfInterest' in settings,
  };
  return { props, features };
}

// The constraints that set property `code` to canonical `value`. Shutter and ISO need manual
// exposure and a colour temperature needs manual white balance, so those switch mode with them.
// Manual exposure on its own is ignored by some drivers, so M holds the exposure time it has now.
export function toConstraints(code, value, caps = {}, settings = {}) {
  const name = Object.keys(CODES).find(n => CODES[n] === +code);
  const v = +value;
  switch (name) {
    case 'mode': return v === MODE.manual ? { exposureMode: 'manual', ...(settings.exposureTime > 0 && { exposureTime: settings.exposureTime }) } : { exposureMode: 'continuous' };
    case 'shutter': return { exposureMode: 'manual', exposureTime: snap(shutterSeconds(v) * 1e4, caps.exposureTime || { min: 0, max: Infinity }) };
    case 'iso': return { exposureMode: 'manual', iso: v };
    case 'ev': return { exposureCompensation: snap(v / 1000, caps.exposureCompensation || { min: -Infinity, max: Infinity }) };
    case 'wb': {
      const k = WB_K.find(([c]) => c === v)?.[1];
      return k ? { whiteBalanceMode: 'manual', colorTemperature: k } : { whiteBalanceMode: 'continuous' };
    }
    case 'kelvin': return { whiteBalanceMode: 'manual', colorTemperature: v };
    case 'focus': return { focusMode: Object.keys(FOCUS).find(m => FOCUS[m] === v) || 'continuous' };
    case 'focusDist': return { focusMode: 'manual', focusDistance: v };
    case 'torch': return { torch: !!v };
    case 'size': { const [w, h] = String(value).split('x').map(Number); return { width: w, height: h }; }
    default: if (RANGES.includes(name)) return { [name]: v };
  }
  throw new Error('Unknown webcam setting');
}
