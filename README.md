# local_camera_nikon

A browser remote for a USB-connected Nikon camera, built and tested on a **Nikon Z50II**.
It runs entirely on your own machine with no drivers or installs beyond Node.

- **Live view** in the browser at 1024px, showing the camera's focus box
- **Tap to focus:** tap anywhere on the live view to move the AF point there and focus
- **Zoom** 2× or 3× around the focus point, to check framing and sharpness
- **Phone remote:** scan a QR code and use your phone on the same Wi-Fi as the remote
- **Shutter** with a delay timer, bursts and autofocus-before-shot
- **Video recording:** start and stop by button, R key, voice ("action" / "cut") or gesture
- **Exposure controls:** aperture, shutter, ISO, exposure comp, white balance, metering, quality and size.
  What's writable depends on the mode dial: everything in **M**, partial in P/A/S.
- **Auto-download:** every shot, including ones taken with the camera's own button, is copied into `captures/YYYY-MM-DD/` and shown in the gallery strip
- **Voice commands:** "shoot", "timer five", "burst three", "focus", "brighter", "ISO 800", "cancel", …
- **Hand gestures:** watches the Nikon's own live view (or your webcam). ✋ palm = 3 s timer, ✌️ = shoot, 👍 = timer + 3 shots, ✊ = cancel, ☝️ = focus. Each gesture can be remapped in the app.
- **Clap to shoot**, offline, with a sensitivity slider
- **Time-lapse**, a rule-of-thirds grid, countdown beeps and keyboard shortcuts

## Run it

1. Plug the camera in over USB-C and switch it on.
2. Start the server:
   ```bash
   npm start
   ```
3. Open **http://localhost:8765/** in **Chrome or Edge**. Those are needed for voice; everything else works in any modern browser.

Close Nikon NX Tether, SnapBridge for Windows, or anything else that grabs the camera first: only one app can talk to it at a time.

### From your phone

Click **📱 Phone** in the app on the laptop and scan the QR code with a phone on the same Wi-Fi.

- The code carries a private access key. The phone keeps it as a cookie, so you only scan once.
- Requests from other devices without the key are refused. Delete `.remote-key` and restart to issue a new key and lock out every phone that has scanned before.
- The first time, Windows may ask to let Node through the firewall. Allow it on **Private** networks.
- Phones only allow microphone and camera access over https, so voice, clap and webcam gestures stay on the laptop. Gestures that watch the Nikon's own live view do work on the phone.
- Run with `LAN=0` to keep the server reachable from the laptop only.

### Video

The Z50II only records when its **photo/video switch** is on video. If it isn't, the app says so. Clips are downloaded into `captures/` like photos once you stop recording. Large clips pause live view for a few seconds while they copy.

### Keyboard

| Key | Action |
| --- | --- |
| Space | Shoot (using the delay/shots/gap settings) |
| F | Autofocus |
| L | Live view on/off |
| G | Grid overlay |
| Z | Zoom 1× → 2× → 3× |
| R | Start/stop video recording |
| Click/tap live view | Move focus point there and focus |
| Esc | Cancel countdown / burst / time-lapse |

### Privacy notes

- **Voice** uses the browser's built-in speech recognition. Chrome and Edge send the audio to Google's or Microsoft's speech service.
- **Gestures** run locally in the browser, but the first time you turn them on, the MediaPipe runtime and model download from jsDelivr and Google's model storage.
- **Clap** detection is fully local.

## How it works

```
browser  ──HTTP/SSE/MJPEG──▶  src/server.js (Node)  ──stdin/stdout JSON──▶  bridge/camera-bridge.ps1  ──WPD/PTP──▶  camera
```

- `bridge/camera-bridge.ps1` is a long-running PowerShell process. Its inline C# sends raw PTP operations through the Windows Portable Devices API (`WPD_COMMAND_MTP_EXT_*`), including data-in and data-out phases. Windows already has a driver for the camera, so nothing extra is installed.
- `src/ptp.js` holds the PTP and Nikon opcodes plus binary dataset parsing (DeviceInfo, DevicePropDesc, ObjectInfo, Nikon CheckEvent).
- `src/camera.js` handles the connection lifecycle and auto-reconnect, the live view loop (Nikon `0x9201`/`0x9203`), capture (`0x9207` in live view, otherwise `0x100E`), property get/set, and the event poll that auto-downloads new photos.
- `src/server.js` exposes the JSON API, the SSE event stream, the MJPEG live view and static files.
- `public/` holds the app: `app.js` for the UI and shooting sequences, `liveview.js` for the MJPEG-to-canvas reader, and `triggers/` for voice, gestures and clap.

`npm run probe` dumps every operation, event and property the connected camera supports, which is handy for adding new controls.

### API

| Method | Path | Body |
| --- | --- | --- |
| GET | `/api/state` | |
| GET | `/api/events` | SSE: `state`, `prop`, `photo`, `shot`, `log` |
| GET | `/api/liveview.mjpg` | |
| GET | `/api/photos` | |
| POST | `/api/shoot` | `{ "af": true }` |
| POST | `/api/af` | |
| POST | `/api/focus-point` | `{ "x": 0.3, "y": 0.5, "focus": true }` (fractions of the frame) |
| POST | `/api/movie` | `{ "on": true }` |
| GET | `/api/remote` | Phone QR URLs (laptop only) |
| POST | `/api/liveview` | `{ "on": true }` |
| POST | `/api/prop` | `{ "code": 20495, "value": 800 }` |
| POST | `/api/prop/step` | `{ "code": 20495, "delta": 1 }` |
| POST | `/api/reconnect` | |

Environment variables: `PORT` (default 8765), `CAPTURES_DIR` (default `./captures`) and `LAN` (set to `0` for laptop-only access).

## Known limits

- Windows only, since the bridge uses WPD. Other Nikon Z / DSLR bodies will probably work because they share the same PTP extensions, but only the Z50II has been tested.
- Image-quality labels follow Nikon's usual numbering. Codes the app doesn't recognise show as "Quality N".
- Live view keeps the camera's sensor running, so it uses more battery. Turn it off (L) when you don't need it.
- Zoom is a digital magnifier on the 1024px live feed. The Z50II doesn't expose its in-camera magnification over USB, so this isn't a true 100% pixel view.
