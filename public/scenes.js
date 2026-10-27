// Scene presets for shot assist: generic starting settings for each scene tag and condition,
// worked out in the browser with no AI and no frame. Every driver reports settings in the same
// canonical units (Nikon's: f-number × 100, shutter as num << 16 | den, ISO with 0xffff for Auto,
// EV in thousandths, PTP codes for WB, metering and focus), so one set of rules covers Nikon,
// Canon, Sony and plain PTP. Each target becomes the closest value the camera actually offers.
import { fmt, LABEL } from './format.js';

export const SCENES = [['boudoir', 'Low-light boudoir'], ['portrait', 'Portrait'], ['action', 'Action'], ['landscape', 'Landscape'],
  ['street', 'Street'], ['event', 'Indoor event'], ['night', 'Night'], ['product', 'Product']];
export const CONDITIONS = ['Handheld', 'Tripod', 'No flash', 'Moody', 'Bright and airy', 'Freeze motion', 'Motion blur'];

// What each mode leaves to you; shown with the recommendation, since the dial can't be set remotely.
export const MODE_INFO = {
  M: 'manual: you set aperture, shutter and ISO yourself',
  A: 'aperture priority: you choose the aperture, the camera matches the shutter speed',
  S: 'shutter priority: you choose the shutter speed, the camera matches the aperture',
  P: 'program: the camera picks aperture and shutter',
};

const AUTO_ISO = 0xffff;
const WB = { auto: 2, daylight: 4 };
const METERING = { matrix: 3, centre: 2 };
const FOCUS = { single: 0x8010, continuous: 0x8011 };

const WHY = {
  matrix: 'Matrix (evaluative) metering reads the whole frame, a dependable default for most light.',
  centre: 'Centre-weighted metering favours the middle of the frame, where the face usually is, so a bright window behind doesn\'t darken it.',
  single: 'Single AF locks focus once and holds it, right for subjects that keep still.',
  continuous: 'Continuous AF keeps adjusting focus while the subject moves, as long as you half-press.',
  autoWb: 'Auto white balance cancels the colour cast of the light so skin and whites look natural.',
  zeroEv: 'Zero compensation trusts the meter, so an old adjustment doesn\'t skew this scene.',
  base: 'The lowest ISO gives the cleanest, most detailed image, and there is enough light for it.',
  tripod: 'On a tripod the shutter can stay open longer, so the lowest ISO gives the cleanest image.',
  autoIso: 'Auto ISO raises sensitivity only as far as the light needs, keeping the shutter fast enough to hand-hold.',
};

// Per scene: the mode to recommend and a target for each setting that mode lets you choose.
// `tripod` scenes assume one unless Handheld is picked, and `handheld` then replaces those targets.
const PRESETS = {
  boudoir: {
    mode: 'A', low: true, indoor: true,
    intent: 'Wide open and ISO lifted for soft, low window light',
    scene: 'Assumes dim window or lamp light indoors and a subject who holds still.',
    aperture: { f: 2, why: 'A wide opening gathers the low light and melts the background into a soft blur.' },
    iso: { auto: true, n: 1600 },
    ev: { ev: -0.3, why: 'A touch darker keeps highlights on skin from burning out and holds the intimate mood.' },
    wb: { code: WB.auto, why: WHY.autoWb },
    metering: { code: METERING.centre, why: WHY.centre },
    focus: { code: FOCUS.single, why: 'Single AF locks on the nearest eye and holds it while you recompose.' },
    tips: ['Turn the subject toward the window: side light flatters skin and shapes the body.', 'Focus on the nearest eye; at f/2 the depth of field is only a few centimetres.', 'Switch off the camera\'s flash and AF-assist lamp to keep the light natural.'],
  },
  portrait: {
    mode: 'A',
    intent: 'Wide aperture to separate the subject from the background',
    scene: 'Assumes outdoor daylight and a person a few metres away.',
    aperture: { f: 2, why: 'A wide opening blurs the background so the subject stands out.' },
    iso: { n: 100, why: WHY.base },
    ev: { ev: 0, why: WHY.zeroEv },
    wb: { code: WB.auto, why: WHY.autoWb },
    metering: { code: METERING.centre, why: WHY.centre },
    focus: { code: FOCUS.single, why: 'Single AF locks on the eye and holds it while you recompose.' },
    tips: ['Put the sun behind or beside the subject, or find open shade, to avoid squinting and harsh shadows.', 'Step back and zoom in (85mm or more) to blur the background further.', 'Focus on the nearest eye.'],
  },
  action: {
    mode: 'S',
    intent: 'Fast shutter and tracking focus to freeze the moment',
    scene: 'Assumes a moving subject such as sport, running children or animals, in reasonable light.',
    shutter: { floor: 1 / 1000, why: 'A shutter of 1/1000 or faster freezes running people, sport and animals mid-motion.' },
    iso: { auto: true, n: 800 },
    ev: { ev: 0, why: WHY.zeroEv },
    wb: { code: WB.auto, why: WHY.autoWb },
    metering: { code: METERING.matrix, why: WHY.matrix },
    focus: { code: FOCUS.continuous, why: WHY.continuous },
    tips: ['Use burst drive and pick the best frame afterwards.', 'Pre-focus where the action will be and follow the subject before you press.', 'If the camera can\'t reach 1/1000 without heavy noise, 1/500 still freezes most people.'],
  },
  landscape: {
    mode: 'A',
    intent: 'Narrow aperture and base ISO for sharpness front to back',
    scene: 'Assumes an outdoor view with near and far detail, in daylight.',
    aperture: { f: 8, why: 'A small opening keeps everything from the foreground to the horizon sharp; f/8 to f/11 is where most lenses are sharpest.' },
    iso: { n: 100, why: WHY.base },
    ev: { ev: 0, why: WHY.zeroEv },
    wb: { code: WB.daylight, why: 'Daylight white balance keeps the warm colour of sunrise and sunset that Auto would cancel out.' },
    metering: { code: METERING.matrix, why: WHY.matrix },
    focus: { code: FOCUS.single, why: 'Single AF locks focus on a still scene; focus about a third of the way in.' },
    tips: ['Focus about a third of the way into the scene to keep both near and far sharp.', 'Shoot in the hour after sunrise or before sunset for softer, warmer light.', 'If the sky is blown out, try −0.7 EV and lift the shadows later.'],
  },
  street: {
    mode: 'A',
    intent: 'Middle aperture and flexible ISO for quick, candid shots',
    scene: 'Assumes handheld shooting outdoors with people moving through the frame.',
    aperture: { f: 5.6, why: 'A middle aperture keeps enough in focus to forgive a slightly missed focus point.' },
    iso: { auto: true, n: 400 },
    ev: { ev: 0, why: WHY.zeroEv },
    wb: { code: WB.auto, why: WHY.autoWb },
    metering: { code: METERING.matrix, why: WHY.matrix },
    focus: { code: FOCUS.continuous, why: WHY.continuous },
    tips: ['Watch that the shutter stays at 1/250 or faster for walking people; raise ISO if it drops.', 'Find good light or a background first, then wait for someone to walk into it.'],
  },
  event: {
    mode: 'A', low: true, indoor: true,
    intent: 'Wide aperture and high ISO for people in dim rooms',
    scene: 'Assumes mixed indoor lighting, people moving, and no tripod.',
    aperture: { f: 2.8, why: 'A wide opening gathers the room\'s dim light while keeping a face or two in focus.' },
    iso: { auto: true, n: 1600 },
    ev: { ev: 0, why: WHY.zeroEv },
    wb: { code: WB.auto, why: 'Auto white balance copes best with mixed lamps, daylight and LEDs.' },
    metering: { code: METERING.matrix, why: WHY.matrix },
    focus: { code: FOCUS.continuous, why: 'Continuous AF keeps people sharp as they turn and move.' },
    tips: ['Keep the shutter at 1/125 or faster so people moving don\'t blur.', 'Get close to the people near the brightest light rather than shooting across the room.'],
  },
  night: {
    mode: 'A', low: true, indoor: true, tripod: true,
    intent: 'Tripod, base ISO and a long exposure for clean night scenes',
    scene: 'Assumes a city or lit scene after dark, with the camera on a tripod.',
    aperture: { f: 8, why: 'On a tripod a smaller opening keeps the scene sharp and turns street lights into stars; the camera exposes longer to make up.' },
    iso: { n: 100, why: WHY.tripod },
    ev: { ev: -0.7, why: 'Meters try to make night look like day; pulling exposure down keeps the sky dark and lights from burning out.' },
    wb: { code: WB.auto, why: WHY.autoWb },
    metering: { code: METERING.matrix, why: WHY.matrix },
    focus: { code: FOCUS.single, why: 'Single AF on a bright light or edge, then leave it; AF struggles in the dark.' },
    handheld: {
      intent: 'Wide open and high ISO to hand-hold after dark',
      aperture: { f: 2.8, why: 'Without a tripod, a wide opening gathers as much light as possible so the shutter can stay fast.' },
      iso: { auto: true, n: 3200 },
    },
    tips: ['Use the app\'s shutter or a 2-second timer so pressing the button doesn\'t shake the camera.', 'Turn off lens stabilisation (VR/IS/OSS) on a tripod.', 'For stars, switch to M: widest aperture, about 15″ and ISO 3200 is the usual starting point.'],
  },
  product: {
    mode: 'A', indoor: true, tripod: true,
    intent: 'Small aperture and base ISO for maximum detail on a tripod',
    scene: 'Assumes a still object under steady, controlled light, with the camera on a tripod.',
    aperture: { f: 11, why: 'A small opening gives enough depth of field to keep a close object sharp from front to back.' },
    iso: { n: 100, why: WHY.tripod },
    ev: { ev: 0, why: WHY.zeroEv },
    wb: { code: WB.auto, why: WHY.autoWb },
    metering: { code: METERING.matrix, why: WHY.matrix },
    focus: { code: FOCUS.single, why: WHY.single },
    handheld: { intent: 'Small aperture and higher ISO for detail without a tripod', iso: { auto: true, n: 800 } },
    tips: ['Use one large, soft light from the side and a white card opposite to fill the shadows.', 'Use the app\'s shutter or a 2-second timer so nothing shakes.', 'Take a test shot with a grey or white card to check the colour.'],
  },
};

// The targets for a scene and its conditions, before looking at what the camera offers.
export function presetPlan(sceneId, mods = []) {
  const s = PRESETS[sceneId];
  if (!s) return null;
  const has = m => mods.includes(m);
  const tripod = has('Tripod') || (s.tripod && !has('Handheld'));
  const t = { aperture: s.aperture, shutter: s.shutter, iso: s.iso, ev: s.ev, wb: s.wb, metering: s.metering, focus: s.focus };
  let { mode, intent } = s;
  if (s.tripod && !tripod) {
    const { intent: handIntent, ...targets } = s.handheld;
    Object.assign(t, targets);
    intent = handIntent;
  }
  const tips = [];

  if (has('Freeze motion')) {
    mode = 'S'; delete t.aperture;
    t.shutter = { floor: 1 / 1000, why: 'A shutter of 1/1000 or faster freezes movement, even splashes and running feet.' };
    t.iso = { auto: true, n: s.low ? 3200 : 800 };
    t.focus = { code: FOCUS.continuous, why: WHY.continuous };
    intent = 'Shutter priority at 1/1000 to freeze the movement';
  } else if (has('Motion blur')) {
    // Handheld can't hold 1/15 still, so it gets a slightly quicker drag.
    mode = 'S'; delete t.aperture;
    t.shutter = { about: tripod ? 1 / 15 : 1 / 30, why: 'A slow shutter lets moving things streak while still parts stay sharp.' };
    t.iso = { n: 100, why: 'A slow shutter lets in plenty of light, so the lowest ISO avoids overexposure and noise.' };
    intent = 'Slow shutter so movement streaks and still parts stay sharp';
    tips.push('In bright sun a slow shutter may still overexpose at base ISO: an ND filter fixes that.');
  }
  const freezing = t.shutter?.floor <= 1 / 500;
  if (tripod && !freezing && !(t.iso.n === 100 && !t.iso.auto)) {
    t.iso = { n: 100, why: WHY.tripod };
    if (mode === 'A') intent = 'Tripod and base ISO: a longer exposure instead of noise';
  }
  if (has('Tripod') && !s.tripod) tips.push('Use the app\'s shutter or a 2-second timer, and turn lens stabilisation off on the tripod.');
  if (!tripod && mode === 'A' && (s.low || has('Handheld'))) tips.push('Handheld, keep an eye on the shutter: about 1/125 or faster stays sharp; raise ISO if the camera goes slower.');
  if (has('No flash') && !tripod && s.indoor && !t.iso.auto) t.iso = { auto: true, n: 1600 };
  if (has('No flash')) tips.push('Without flash, move the subject toward the window or brightest lamp: it does more than any setting.');
  const shift = (has('Bright and airy') ? 0.7 : 0) - (has('Moody') ? 0.7 : 0);
  if (shift) {
    t.ev = { ev: t.ev.ev + shift, why: shift < 0
      ? 'Negative compensation darkens the whole image so shadows stay deep and moody.'
      : 'Positive compensation brightens the whole image for a light, airy look; watch whites for lost detail.' };
  }
  return { mode, intent, scene: s.scene, tips: [...s.tips.slice(0, Math.max(2, 4 - tips.length)), ...tips].slice(0, 4), targets: t };
}

// ---------- matching targets to the camera's values ----------
const seconds = v => { if (v >= 0xfffffffd) return null; const n = v >>> 16, d = v & 0xffff; return d ? n / d : null; };
const stopsApart = (a, b) => Math.abs(Math.log2(a / b));
const nearestBy = (values, metric, target) => {
  let best, bestD = Infinity;
  for (const v of values) { const m = metric(v); if (m == null || !(m > 0)) continue; const d = stopsApart(m, target); if (d < bestD) { best = v; bestD = d; } }
  return best;
};
const shutterLabel = s => (s >= 1 ? `${s}″` : `1/${Math.round(1 / s)}`);

// → { value, why } or undefined when the camera offers nothing suitable.
const PICK = {
  aperture(values, t) {
    const v = nearestBy(values, v => v / 100, t.f);
    if (v === undefined) return;
    // f-numbers double every two stops.
    const off = 2 * stopsApart(v / 100, t.f) > 0.5 ? ` The closest the lens offers to f/${t.f}.` : '';
    return { value: v, why: t.why + off };
  },
  shutter(values, t) {
    let v;
    if (t.floor) {
      // The slowest speed that is still fast enough keeps the most light; else the fastest there is.
      const fast = values.filter(x => seconds(x) && seconds(x) <= t.floor * 1.05);
      const timed = values.filter(seconds);
      if (fast.length) v = fast.reduce((a, b) => (seconds(b) > seconds(a) ? b : a));
      else if (timed.length) v = timed.reduce((a, b) => (seconds(b) < seconds(a) ? b : a));
    } else v = nearestBy(values, seconds, t.about);
    if (v === undefined) return;
    const target = t.floor || t.about;
    return { value: v, why: t.why + (stopsApart(seconds(v), target) > 0.5 ? ` The closest the camera offers to ${shutterLabel(target)}.` : '') };
  },
  iso(values, t) {
    if (t.auto && values.includes(AUTO_ISO)) return { value: AUTO_ISO, why: WHY.autoIso };
    const v = nearestBy(values.filter(x => x !== AUTO_ISO), x => x, t.n);
    if (v === undefined) return;
    const why = t.why || (t.n >= 1600
      ? 'A higher ISO brightens the image in dim light so the shutter stays fast; a little grain beats a blurred shot.'
      : 'A moderate ISO leaves room for a quick shutter as the light changes, with little noise.');
    return { value: v, why };
  },
  ev(values, t) {
    let best, bestD = Infinity;
    for (const v of values) { const d = Math.abs(v - t.ev * 1000); if (d < bestD) { best = v; bestD = d; } }
    return best === undefined ? undefined : { value: best, why: t.why };
  },
};
const pickCode = (values, t) => (values.includes(t.code) ? { value: t.code, why: t.why } : undefined);

const ORDER = ['aperture', 'shutter', 'iso', 'ev', 'wb', 'metering', 'focus'];

// The same advice object the AI path returns, so the chips, Apply and the dial queue treat both alike.
// `props` is the camera's property list keyed by code: { name, value, values, writable }.
export function presetAdvice(props, sceneId, mods = []) {
  const plan = presetPlan(sceneId, mods);
  if (!plan) return null;
  const settings = [];
  for (const name of ORDER) {
    const t = plan.targets[name];
    const entry = Object.entries(props).find(([, p]) => p.name === name);
    if (!t || !entry) continue;
    const [code, p] = entry;
    if (!p.values?.length) continue; // nothing the camera lets us choose
    const pick = (PICK[name] || pickCode)(p.values, t);
    if (!pick) continue;
    settings.push({
      code: +code, name, label: LABEL[name] || name, value: pick.value, display: fmt(name, pick.value),
      current: fmt(name, p.value), same: pick.value === p.value, writable: !!p.writable, reason: pick.why,
    });
  }
  return { source: 'preset', model: null, intent: plan.intent, scene: plan.scene, mode: plan.mode, tips: plan.tips, settings };
}

// One line for the AI prompt, so it starts from the preset and adjusts for what it sees.
export const presetSummary = a => `Generic preset for this scene: mode ${a.mode}; ${a.settings.map(s => `${s.name} ${s.display}`).join(', ')}. Adjust for what you see.`;
