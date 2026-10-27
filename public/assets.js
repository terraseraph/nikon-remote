// MediaPipe and its models ship with the app (public/vendor, see scripts/vendor.js) so gestures and
// pose match work offline. A phone on the Cloudflare tunnel (the only https page) has internet
// anyway, and the CDN beats pulling ~20 MB through the laptop's upload, so it uses that instead.
const CDN = location.protocol === 'https:';

export const VISION = CDN ? 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14' : '/vendor/tasks-vision';

const MODELS = {
  gesture_recognizer: 'gesture_recognizer/gesture_recognizer/float16/1',
  pose_landmarker_lite: 'pose_landmarker/pose_landmarker_lite/float16/1',
};
export const modelUrl = name => (CDN ? `https://storage.googleapis.com/mediapipe-models/${MODELS[name]}` : '/vendor/models') + `/${name}.task`;
