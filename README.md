# Obsidian — Cyberpunk Watch Pairing

Real-time desktop ↔ mobile pairing via QR. Phone gyroscope drives a 3D cyberpunk arm + watch on the desktop screen.

## Stack
- **Backend**: Node.js, Express, Socket.IO
- **3D**: Three.js (GLTFLoader, UnrealBloom, OrbitControls)
- **QR**: dynamic per session, encodes session id + secure token

## Run locally

```bash
npm install
npm start
```

Open the printed LAN URL on the desktop, scan the QR with a phone on the same Wi-Fi.

### Preview without a phone
- Open `http://localhost:3000/?preview=1` to skip pairing and inspect the 3D scene.
- Press `T` for the watch tuner; `WASD/QE` move, `IJKL/UO` rotate, `+/-` scale, `R` reset, `C` copy values.

### Public tunnel (for iOS gyroscope, requires HTTPS)
```bash
cloudflared tunnel --url http://localhost:3000
# then restart with the printed URL:
PUBLIC_BASE_URL=https://xxx.trycloudflare.com npm start
```

## Deploy to Render
1. Push this repo to GitHub.
2. On render.com → **New → Web Service** → connect the repo.
3. Build: `npm install` &nbsp; Start: `npm start`
4. Render auto-assigns `PORT` and gives you HTTPS — gyroscope works on iOS.

Vercel is **not supported** (serverless ≠ persistent WebSocket).

## File layout
```
arm.glb              - obsidian arm model
watch.glb            - luxury watch model
server.js            - Express + Socket.IO + QR
public/
  index.html         - desktop scene
  desktop.js         - Three.js scene, motion handling, watch tuner
  m.html             - mobile controller
  mobile.js          - permissions, gyroscope, calibration, touch fallback
  styles.css         - shared cyberpunk styling
```

## Events (WebSocket)
- `orientationUpdate { q: [x,y,z,w] }`  — phone → desktop, ~60Hz
- `calibrationData { quat: [x,y,z,w] }` — phone → desktop, when locked
- `watchSelect { id }`                  — phone → desktop
- `controlMode { mode }`                — phone → desktop ('gyro' | 'touch')
- `connectionStatus { desktop, mobile, role, event }` — server → both
