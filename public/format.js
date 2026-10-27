// Human-readable labels for Nikon/PTP property values, and for webcam controls (webcam-props.js).

const MODE = { 1: 'M', 2: 'P', 3: 'A', 4: 'S', 0x8010: 'AUTO', 0x8011: 'Portrait', 0x8012: 'Landscape', 0x8013: 'Close-up', 0x8014: 'Sports' };
const WB = { 2: 'Auto', 4: 'Daylight', 5: 'Fluorescent', 6: 'Incandescent', 7: 'Flash', 0x8010: 'Cloudy', 0x8011: 'Shade', 0x8012: 'Kelvin', 0x8013: 'Preset', 0x8016: 'Natural light auto' };
const METERING = { 2: 'Centre-weighted', 3: 'Matrix', 4: 'Spot', 0x8010: 'Highlight-weighted' };
const FOCUS = { 1: 'Manual', 0x8010: 'AF-S', 0x8011: 'AF-C', 0x8012: 'AF-A', 0x8013: 'AF-F' };
// Best guess from Nikon's usual numbering; unknown codes fall back to the raw value.
const QUALITY = { 0: 'JPEG Basic', 1: 'JPEG Normal', 2: 'JPEG Fine', 4: 'RAW', 5: 'RAW + Basic', 6: 'RAW + Normal', 7: 'RAW + Fine' };

function shutter(v) {
  if (v === 0xffffffff) return 'Bulb';
  if (v === 0xfffffffd) return 'Time';
  const num = v >>> 16, den = v & 0xffff;
  if (!den) return String(v);
  if (num === 1 && den > 1) return `1/${den}`;
  if (num >= den) return `${+(num / den).toFixed(1)}″`;
  return `${num}/${den}`;
}

// Webcam sliders come in each device's own units, so they show as plain numbers.
const num = v => String(+(+v).toFixed(2));

const signed = n => (n > 0 ? '+' : n < 0 ? '−' : '±') + Math.abs(n).toFixed(1);

export const FORMAT = {
  mode: v => MODE[v] ?? 'Scene',
  aperture: v => `f/${+(v / 100).toFixed(1)}`,
  shutter,
  iso: v => (v === 0xffff ? 'Auto' : `ISO ${v}`),
  ev: v => `${signed(v / 1000)} EV`,
  wb: v => WB[v] ?? `WB ${v}`,
  metering: v => METERING[v] ?? `Mode ${v}`,
  focus: v => FOCUS[v] ?? `Mode ${v}`,
  quality: v => QUALITY[v] ?? `Quality ${v}`,
  size: v => String(v).replace('x', ' × '),
  battery: v => `🔋 ${v}%`,
  kelvin: v => `${v} K`,
  focusDist: num, brightness: num, contrast: num, saturation: num, sharpness: num,
  zoom: num,
  pan: v => `${+(v / 3600).toFixed(1)}°`, // the browser gives pan and tilt in arc-seconds
  tilt: v => `${+(v / 3600).toFixed(1)}°`,
  torch: v => (v ? 'On' : 'Off'),
};

export const LABEL = {
  aperture: 'Aperture', shutter: 'Shutter', iso: 'ISO', ev: 'Exp. comp', wb: 'White bal.',
  metering: 'Metering', focus: 'Focus', quality: 'Quality', size: 'Image size', mode: 'Exposure',
  kelvin: 'Colour temp.', focusDist: 'Focus distance', brightness: 'Brightness', contrast: 'Contrast',
  saturation: 'Saturation', sharpness: 'Sharpness', zoom: 'Zoom', pan: 'Pan', tilt: 'Tilt', torch: 'Light',
};

export const fmt = (name, v) => (FORMAT[name] ? FORMAT[name](v) : String(v));
