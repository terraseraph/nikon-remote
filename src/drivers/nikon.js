// Nikon: live view, tap-to-focus, AF, video and events through Nikon's PTP extensions.
// Built and tested on a Z50II; other Z and DSLR bodies share the same operations.
import { Op, OK, respName, encodeValue, NikonProp, parseNikonEvents, parseLiveViewHeader } from '../ptp.js';
import { PtpDriver, PROPS, sleep } from './ptp.js';

const BUSY = new Set([0x2019]);
const INVALID_STATUS = 0xa004;

export class NikonDriver extends PtpDriver {
  brand = 'Nikon';
  experimental = false;
  features = { liveView: true, focusPoint: true, movie: true, autofocus: true };
  onlyListedProps = false;
  propMap = {}; // Nikon's units are the canonical ones

  reset() { this.pcMode = this.appMode = false; }

  async waitReady(timeoutMs = 5000) {
    const end = Date.now() + timeoutMs;
    let code;
    while (Date.now() < end) {
      code = (await this.send(Op.NikonDeviceReady)).code;
      if (!BUSY.has(code)) return code;
      await sleep(50);
    }
    return code;
  }

  // Nikon Z bodies gate some operations behind host-control modes, switched on demand:
  //  - PC camera mode (ChangeCameraMode 1): live view can refuse to start without it.
  //  - application mode (ChangeApplicationMode 1): needed before movie recording.
  // Stills work without either. Both reset when the camera is power-cycled.
  // Returns true if the mode was switched, so the caller can retry.
  async enterMode(flag, op, reason) {
    if (this[flag] || !this.info?.operations.includes(op)) return false;
    this.cam.emit('log', `Switching camera to ${flag === 'pcMode' ? 'PC control' : 'application'} mode to ${reason}`);
    const { code } = await this.send(op, [1]);
    await this.waitReady();
    this[flag] = code === OK;
    return this[flag];
  }

  // Resolves once live view runs; throws with the reason if the camera refuses.
  async startLiveView() {
    let { code } = await this.send(Op.NikonStartLiveView);
    // In photo mode PC control is enough; with the switch on video the Z50II also wants application mode.
    if (code === INVALID_STATUS && await this.enterMode('pcMode', Op.NikonChangeCameraMode, 'start live view')) {
      ({ code } = await this.send(Op.NikonStartLiveView));
    }
    if (code === INVALID_STATUS && await this.enterMode('appMode', Op.NikonChangeApplicationMode, 'start live view')) {
      ({ code } = await this.send(Op.NikonStartLiveView));
    }
    if (code !== OK && !BUSY.has(code)) throw new Error(respName(code));
    await this.waitReady();
  }

  async stopLiveView() { await this.send(Op.NikonEndLiveView); }

  // The next frame as { jpeg, af }, null if none is ready, or { stopped: true } if the camera dropped live view.
  async getFrame() {
    const res = await this.send(Op.NikonGetLiveViewImage, [], { dir: 'read' });
    if (res.code === 0xa00b) return { stopped: true };
    if (res.code !== OK || !res.data) return null;
    const soi = res.data.indexOf(Buffer.from([0xff, 0xd8]));
    if (soi < 0) return null;
    if (soi >= 32) this.lvInfo = parseLiveViewHeader(res.data);
    return { jpeg: res.data.subarray(soi), af: this.afBox() };
  }

  // Prefer the largest live view frames (1024px on the Z50II), but drop to 640px while someone
  // watches over the internet, where frame size sets the frame rate. Older bodies may not support it.
  async setFrameSize(small) {
    await this.send(Op.SetDevicePropValue, [NikonProp.LiveViewImageSize], { dir: 'write', data: encodeValue(2, small ? 2 : 3) }).catch(() => {});
  }

  // Focus box as fractions of the visible live view area, for drawing over the image.
  afBox() {
    const i = this.lvInfo;
    if (!i?.display.w || !i.af.w) return null;
    const left = i.display.x - i.display.w / 2, top = i.display.y - i.display.h / 2;
    const r = n => Math.round(n * 1e4) / 1e4;
    return {
      x: r((i.af.x - i.af.w / 2 - left) / i.display.w), y: r((i.af.y - i.af.h / 2 - top) / i.display.h),
      w: r(i.af.w / i.display.w), h: r(i.af.h / i.display.h),
    };
  }

  // Move the AF point to a spot given as fractions (0–1) of the live view.
  async setFocusPoint(fx, fy) {
    const i = this.lvInfo;
    if (!i) throw new Error('Tap-to-focus needs live view');
    const clamp = (v, lo, hi) => Math.round(Math.max(lo, Math.min(hi, v)));
    const x = clamp(i.display.x - i.display.w / 2 + fx * i.display.w, 0, i.sensor.w - 1);
    const y = clamp(i.display.y - i.display.h / 2 + fy * i.display.h, 0, i.sensor.h - 1);
    const { code } = await this.send(Op.NikonChangeAfArea, [x, y]);
    if (code !== OK) throw new Error('Focus point: ' + respName(code));
  }

  async startMovie() {
    let { code } = await this.send(Op.NikonStartMovieRecInCard);
    if (code === INVALID_STATUS && await this.enterMode('appMode', Op.NikonChangeApplicationMode, 'record video')) {
      ({ code } = await this.send(Op.NikonStartMovieRecInCard));
    }
    if (code === INVALID_STATUS) {
      // Only blame the switch once application mode has been tried: the selector property
      // isn't a dependable mirror of the physical switch on every body.
      const read = async p => { const r = await this.send(Op.GetDevicePropValue, [p], { dir: 'read' }); return r.code === OK ? r.data.readUIntLE(0, Math.min(4, r.data.length)) : null; };
      const selector = await read(NikonProp.LiveViewSelector), blocked = await read(NikonProp.MovieRecProhibitCondition);
      this.cam.emit('log', `Record refused: selector=${selector} prohibit=0x${(blocked ?? 0).toString(16)}`);
      // While the host has control the camera ignores its own lever, so a flip made after
      // connecting only registers once the camera is switched off and on again.
      if (selector === 0) throw new Error('Camera is in photo mode. Set the photo/video switch to video, then turn the camera off and on');
      throw new Error('Camera refused to record (check the card has space and isn\'t locked)');
    }
    if (code !== OK) throw new Error('Record: ' + respName(code));
  }

  async stopMovie() {
    const { code } = await this.send(Op.NikonEndMovieRec);
    if (code !== OK) throw new Error('Stop recording: ' + respName(code));
  }

  async drainEvents() {
    await this.send(Op.NikonCheckEvent, [], { dir: 'read' }).catch(() => {});
  }

  async pollEvents() {
    const res = await this.send(Op.NikonCheckEvent, [], { dir: 'read' });
    if (res.code !== OK || !res.data) return;
    for (const ev of parseNikonEvents(res.data)) {
      if (ev.code === 0x4002) await this.cam.downloadPhoto(ev.param);
      else if (ev.code === 0x4006 && PROPS[ev.param]) await this.refreshProp(ev.param);
      else if (ev.code === 0x4006 && ev.param === 0xd1a2) {} // live view status: handled by frame errors
    }
  }

  async autofocus() {
    const { code } = await this.send(Op.NikonAfDrive);
    if (code !== OK) return respName(code);
    const done = await this.waitReady(4000);
    return done === OK ? 'OK' : respName(done);
  }

  async capture({ liveView }) {
    const { code } = liveView
      ? await this.send(Op.NikonInitiateCaptureRecInMedia, [0xffffffff, 0])
      : await this.send(Op.InitiateCapture, [0, 0]);
    if (code === OK) await this.waitReady(8000);
    return code;
  }
}
