// Runs a webcam for the server. Only the laptop's own page can do this (the server refuses the
// host endpoints from anywhere else): it opens the webcam, holds a command stream open, pushes
// live view frames into the same path the USB camera's frames take, and uploads photos and video.
// Phones then see and control the webcam like any tethered camera.
import { capsToProps, toConstraints } from './webcam-props.js';

const post = (path, body, type = 'application/json') => fetch(path, {
  method: 'POST', headers: { 'Content-Type': type }, body: type === 'application/json' ? JSON.stringify(body) : body,
});
// "Integrated Camera (04f2:b6dd)" → "Integrated Camera"
const cleanLabel = l => (l || '').replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '').trim();

// This page is the frame source for every phone watching, minimised or not. In a hidden or
// minimised page timers slow to once a second and canvas.toBlob waits about a second for idle
// time that never comes; in a worker neither happens. So a worker keeps time, and encodes and
// uploads each frame and photo, which the page only grabs from the webcam.
const FRAMER = `let t, busy = false, frameUrl;
onmessage = async ({ data }) => {
  if ('every' in data) { frameUrl = data.url; clearInterval(t); if (data.every > 0) t = setInterval(() => busy || postMessage(0), data.every); return; }
  const { bmp, url = frameUrl, quality = 0.8, id } = data;
  if (!id) busy = true;
  let error = '';
  try {
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    c.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close();
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: await c.convertToBlob({ type: 'image/jpeg', quality }) });
    if (!res.ok) error = (await res.json().catch(() => ({}))).error || 'Upload failed';
  } catch (e) { error = e.message; }
  if (id) postMessage({ id, error }); else busy = false;
};`;

export class WebcamHost {
  constructor({ onReleased, onError } = {}) {
    Object.assign(this, { onReleased, onError });
    this.deviceId = null;
    this.live = { fps: 0, width: 1024 };
    this.framer = new Worker(URL.createObjectURL(new Blob([FRAMER], { type: 'text/javascript' })));
    this.photoUploads = new Map(); // photo id → settle, for photos the worker encodes and uploads
    this.framer.onmessage = ({ data }) => (data === 0 ? this.sendFrame() : this.photoUploads.get(data.id)?.(data.error));
    // Left open across a reload, Chromium's capture service stops taking settings for the webcam
    // (every change fails with "setPhotoOptions failed") until the browser restarts.
    addEventListener('pagehide', () => this.stop());
  }

  get running() { return !!this.track; }

  // The laptop's webcams. Until the page has had camera permission once, the browser hides their
  // names and ids: then there's one "Webcam" entry (id ''), which opens the default webcam and asks.
  async devices() {
    const all = (await navigator.mediaDevices?.enumerateDevices().catch(() => []) || []).filter(d => d.kind === 'videoinput');
    if (all.length && !all[0].deviceId) return [{ id: '', label: 'Webcam' }];
    return all.map((d, i) => ({ id: d.deviceId, label: cleanLabel(d.label) || `Webcam ${i + 1}` }));
  }

  async open(deviceId) {
    const video = { ...(deviceId && { deviceId: { exact: deviceId } }), width: { ideal: 1920 }, height: { ideal: 1080 } };
    // Pan, tilt and zoom only show up in the capabilities when asked for; some setups refuse that.
    try { return await navigator.mediaDevices.getUserMedia({ video: { ...video, pan: true, tilt: true, zoom: true } }); }
    catch (e) {
      if (e.name === 'NotFoundError' || e.name === 'NotReadableError') throw e;
      return navigator.mediaDevices.getUserMedia({ video });
    }
  }

  async start(deviceId) {
    this.stop();
    await this.openTrack(deviceId);
    const es = this.events = new EventSource(`/api/webcam/host?device=${encodeURIComponent(this.deviceId)}&label=${encodeURIComponent(this.label)}`);
    // Sent on every (re)connect, e.g. after the server restarts, so the server always has the device.
    es.addEventListener('hello', () => this.report());
    es.addEventListener('live', e => { this.live = JSON.parse(e.data); this.every(this.live.fps ? 1000 / this.live.fps : 0); });
    es.addEventListener('cmd', e => this.run(JSON.parse(e.data)));
    es.addEventListener('release', e => { const { reason, forget } = JSON.parse(e.data); this.stop(); this.onReleased?.(reason, forget); });
  }

  async openTrack(deviceId) {
    let stream;
    try { stream = await this.open(deviceId); }
    catch (e) {
      throw Object.assign(new Error(e.name === 'NotAllowedError' ? 'Camera permission was blocked for this page'
        : e.name === 'NotReadableError' ? 'The webcam is in use by another app' : `Couldn't open the webcam: ${e.message}`), { name: e.name });
    }
    this.stream = stream;
    this.track = stream.getVideoTracks()[0];
    this.deviceId = this.track.getSettings().deviceId || deviceId;
    this.label = cleanLabel(this.track.label) || 'Webcam';
    this.video = Object.assign(document.createElement('video'), { muted: true, playsInline: true, srcObject: stream });
    await this.video.play();
    this.track.onended = () => { if (!this.reopening) { this.stop(); this.onError?.('The webcam was unplugged or turned off'); } };
  }

  stop() {
    this.events?.close();
    this.events = null;
    this.every(0);
    this.recorder?.state === 'recording' && this.recorder.stop();
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = this.track = this.video = null;
  }

  // The properties as the server and UI know them, from what the track says it can do now.
  state() {
    const caps = this.track.getCapabilities?.() || {};
    const { props, features } = capsToProps(caps, this.track.getSettings());
    return { label: this.label, props, features };
  }
  report() { return post('/api/webcam/state', this.state()).catch(() => {}); }

  every(ms) { this.framer.postMessage({ every: ms, url: new URL('/api/webcam/frame', location.href).href }); }

  async sendFrame() {
    const v = this.video;
    if (!v || v.readyState < 2 || !this.events) return;
    const scale = Math.min(1, this.live.width / v.videoWidth);
    const bmp = await createImageBitmap(v, { resizeWidth: Math.round(v.videoWidth * scale), resizeHeight: Math.round(v.videoHeight * scale) }).catch(() => null);
    if (bmp) this.framer.postMessage({ bmp }, [bmp]);
  }

  async run({ id, cmd, ...args }) {
    try {
      const result = await this[`cmd_${cmd}`]?.(args, id);
      if (cmd !== 'shoot') await post('/api/webcam/reply', { id, result, props: this.track && this.state().props });
    } catch (e) {
      await post('/api/webcam/reply', { id, error: e.message });
    }
  }

  async apply(c) {
    const { width, height, ...rest } = c;
    // A resolution is a basic constraint; the camera controls go in an advanced set, which Chrome
    // applies without touching the resolution.
    if (width) await this.track.applyConstraints({ width: { ideal: width }, height: { ideal: height } });
    if (Object.keys(rest).length) await this.track.applyConstraints({ advanced: [rest] });
  }

  async cmd_set({ code, value }) {
    await this.apply(toConstraints(code, value, this.track.getCapabilities?.() || {}, this.track.getSettings()));
  }

  async cmd_af() {
    const modes = this.track.getCapabilities?.().focusMode || [];
    if (modes.includes('single-shot')) await this.apply({ focusMode: 'single-shot' });
    else if (modes.includes('continuous')) await this.apply({ focusMode: 'continuous' });
    else return 'This webcam has no autofocus control';
    return 'OK';
  }

  async cmd_focusPoint({ x, y, focus }) {
    await this.apply({ pointsOfInterest: [{ x, y }] });
    return focus ? this.cmd_af() : 'OK';
  }

  // Full resolution where the webcam has a photo mode, else the video frame at its native size.
  async cmd_shoot(_, id) {
    let blob = null;
    if (typeof ImageCapture !== 'undefined') {
      try {
        const ic = new ImageCapture(this.track);
        const pc = await ic.getPhotoCapabilities().catch(() => null);
        const opts = pc?.imageWidth?.max ? { imageWidth: pc.imageWidth.max, imageHeight: pc.imageHeight.max } : {};
        blob = await Promise.race([ic.takePhoto(opts), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000))]);
      } catch {}
    }
    const url = `/api/webcam/photo?id=${id}`;
    if (blob?.size > 1000 && /jpe?g/.test(blob.type)) {
      const res = await post(url, blob, 'image/jpeg');
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Upload failed');
      return;
    }
    // Some drivers hand back a PNG (Chromium on Windows does): same pixels, saved as a JPEG like a
    // camera's. Without a photo at all, the video frame at the webcam's current resolution.
    const bmp = (blob?.size > 1000 && await createImageBitmap(blob).catch(() => null)) || await createImageBitmap(this.video);
    const error = await new Promise(settle => {
      this.photoUploads.set(id, settle);
      this.framer.postMessage({ bmp, url: new URL(url, location.href).href, quality: 0.95, id }, [bmp]);
    });
    this.photoUploads.delete(id);
    if (error) throw new Error(error);
  }

  // Video with sound when a microphone is allowed; uploaded a second at a time while recording.
  async cmd_record({ on }) {
    if (!on) {
      const r = this.recorder;
      if (r?.state === 'recording') await new Promise(res => { r.onstop = res; r.stop(); });
      await this.uploads;
      this.mic?.getTracks().forEach(t => t.stop());
      this.recorder = this.mic = null;
      return {};
    }
    this.mic = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
    const tracks = [this.track, ...(this.mic?.getAudioTracks() || [])];
    const type = ['video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t));
    const r = this.recorder = new MediaRecorder(new MediaStream(tracks), { mimeType: type, videoBitsPerSecond: 8e6 });
    this.uploads = Promise.resolve();
    r.ondataavailable = e => {
      if (!e.data.size) return;
      this.uploads = this.uploads.then(() => post('/api/webcam/movie', e.data, 'application/octet-stream')).catch(() => {});
    };
    r.start(1000);
    return { ext: /mp4/.test(r.mimeType) ? 'mp4' : 'webm' };
  }

  // Reconnect: the same webcam again, keeping the command stream.
  async cmd_reopen() {
    this.reopening = true;
    try {
      this.stream?.getTracks().forEach(t => t.stop());
      await this.openTrack(this.deviceId);
    } finally { this.reopening = false; }
  }
}
