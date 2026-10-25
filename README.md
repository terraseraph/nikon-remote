# local_camera_nikon

A browser remote for a USB-connected Nikon camera, built and tested on a **Nikon Z50II**.
It runs entirely on your own machine with no drivers or installs beyond Node.

- **Live view** in the browser at about 19 fps
- **Shutter** with a delay timer, bursts and autofocus-before-shot
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

### Keyboard

| Key | Action |
| --- | --- |
| Space | Shoot (using the delay/shots/gap settings) |
| F | Autofocus |
| L | Live view on/off |
| G | Grid overlay |
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
| POST | `/api/liveview` | `{ "on": true }` |
| POST | `/api/prop` | `{ "code": 20495, "value": 800 }` |
| POST | `/api/prop/step` | `{ "code": 20495, "delta": 1 }` |
| POST | `/api/reconnect` | |

Environment variables: `PORT` (default 8765) and `CAPTURES_DIR` (default `./captures`).

## Known limits

- Windows only, since the bridge uses WPD. Other Nikon Z / DSLR bodies will probably work because they share the same PTP extensions, but only the Z50II has been tested.
- Image-quality labels follow Nikon's usual numbering. Codes the app doesn't recognise show as "Quality N".
- Live view keeps the camera's sensor running, so it uses more battery. Turn it off (L) when you don't need it.
