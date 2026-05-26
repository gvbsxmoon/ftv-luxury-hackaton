(function () {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const sessionId = params.get('s');
  const token = params.get('t');

  if (!sessionId || !token) {
    document.body.innerHTML = '<div style="padding:40px;color:#c89dff;font-family:system-ui">Missing session. Re-scan the desktop QR.</div>';
    return;
  }

  $('m-sess').textContent = sessionId;

  // ---------------- socket ----------------
  const socket = io({ auth: { sessionId, token, role: 'mobile' } });

  socket.on('connect', () => {
    $('m-state').textContent = 'linked';
    $('m-dot').classList.remove('off');
    haptic([15, 30, 15]);
    showToast('Linked to desktop');
  });
  socket.on('disconnect', () => {
    $('m-state').textContent = 'reconnecting…';
    $('m-dot').classList.add('off');
  });
  socket.on('connect_error', () => {
    $('m-state').textContent = 'session error';
  });

  function haptic(pat) { if (navigator.vibrate) navigator.vibrate(pat); }

  // Continuous-feeling haptic while rotating: short pulses at a cadence
  // proportional to angular speed. Stops when nearly still.
  let lastHapticAngle = 0;
  let lastHapticTime = 0;
  function rotationHaptic(angle, now) {
    if (!navigator.vibrate) return;
    const dAngle = Math.abs(angle - lastHapticAngle);
    if (dAngle < 0.012) return; // ~0.7° dead zone
    const dt = now - lastHapticTime;
    const minGap = 55;          // base pulse rate ~18Hz
    if (dt < minGap) return;
    lastHapticTime = now;
    lastHapticAngle = angle;
    navigator.vibrate(8);       // ultra-short tick
  }
  function showToast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 1400);
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  // ---------------- step navigation ----------------
  function goto(stepName) {
    document.querySelectorAll('.m-step').forEach((el) => {
      el.classList.toggle('active', el.dataset.step === stepName);
    });
  }

  $('btn-continue-1').addEventListener('click', () => goto('perm'));

  // ---------------- permissions ----------------
  $('btn-perm').addEventListener('click', async () => {
    let okOrient = true;
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        const r = await DeviceOrientationEvent.requestPermission();
        okOrient = r === 'granted';
      }
      if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
        await DeviceMotionEvent.requestPermission().catch(() => {});
      }
    } catch (e) {
      okOrient = false;
    }

    if (okOrient) {
      socket.emit('controlMode', { mode: 'gyro' });
      startGyro();
      goto('calib');
    } else {
      showToast('Motion denied — please enable in browser settings');
    }
  });

  // ---------------- gyroscope: surface-level detection + beta streaming ----------------
  // The phone is laid face-up on a flat surface when:
  //   - |beta|  small  (phone not tilted forward/back)
  //   - |gamma| small  (phone not tilted sideways)
  // beta and gamma are in degrees (DeviceOrientationEvent).
  // We tolerate up to LEVEL_TOL degrees on each, and require LEVEL_HOLD_MS
  // of continuous "level" before we lock the zero (auto-calibration).

  const LEVEL_TOL = 15;      // degrees of tolerance for "flat"
  const LEVEL_HOLD_MS = 800; // must stay level this long

  let lastBeta = 0;
  let lastGamma = 0;
  let levelSince = null;
  let isCalibrated = false;

  // Gyroscope-rate integration: avoids the Euler singularity at beta=±90°.
  // After calibration, we listen to DeviceMotionEvent.rotationRate (deg/s) and
  // integrate rotationRate.beta over dt to get a clean angle in radians.
  let integratedAngle = 0;        // radians, accumulator from gyro rate
  let smoothed = 0;               // exponentially-smoothed angle sent to desktop
  const SMOOTH_ALPHA = 0.35;
  const RATE_DEAD_ZONE = 0.5;     // deg/s — ignore tiny noise so the angle doesn't drift
  let lastMotionT = 0;

  let lastSent = 0;
  const SEND_HZ = 60;

  function onDeviceOrientation(e) {
    lastBeta  = e.beta  || 0;
    lastGamma = e.gamma || 0;

    if (!isCalibrated) {
      // Surface-level detection
      const flat = Math.abs(lastBeta) <= LEVEL_TOL && Math.abs(lastGamma) <= LEVEL_TOL;
      const now = performance.now();

      if (flat) {
        if (levelSince === null) levelSince = now;
        const heldMs = now - levelSince;

        // visualize: dot moves with tilt, target ring is the goal
        const dot = $('calib-dot');
        if (dot) {
          const px = clamp(lastGamma / LEVEL_TOL, -1, 1) * 18;
          const py = clamp(lastBeta  / LEVEL_TOL, -1, 1) * 18;
          dot.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px))`;
          dot.style.background = '#6efcff';
          dot.style.boxShadow  = '0 0 18px #6efcff';
        }

        const status = $('calib-status');
        if (status) {
          const pct = Math.min(1, heldMs / LEVEL_HOLD_MS);
          status.textContent = `Locking… ${Math.round(pct * 100)}%`;
        }

        if (heldMs >= LEVEL_HOLD_MS) {
          // LOCK: zero the gyro-rate integrator. From here on, angle is built up
          // by integrating rotationRate.beta (deg/s) — no Euler, no singularity.
          integratedAngle = 0;
          smoothed = 0;
          lastMotionT = 0;
          isCalibrated = true;
          haptic([20, 40, 80]);
          showToast('Calibrated');
          socket.emit('calibrationData', { ok: true });
          goto('active');
          $('active-title').textContent = 'Hold the phone tight in your hands';
          $('active-sub').textContent  = 'Rotate your wrist — watch the obsidian arm follow.';
        }
      } else {
        // not level: reset the timer
        levelSince = null;
        const dot = $('calib-dot');
        if (dot) {
          const px = clamp(lastGamma / 60, -1, 1) * 70;
          const py = clamp(lastBeta  / 60, -1, 1) * 70;
          dot.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px))`;
          dot.style.background = '#b14bff';
          dot.style.boxShadow  = '0 0 18px #b14bff';
        }
        const status = $('calib-status');
        if (status) status.textContent = 'Waiting for level surface…';
      }
      return;
    }
    // Calibrated: nothing to do here — the angle is driven by devicemotion below.
  }

  // Soft zoom: integrate device acceleration on Z (toward/away from face) into a
  // velocity with strong decay; map velocity to a small zoom offset that auto-recenters.
  let zoomVel = 0;            // m/s along device Z (decays to 0)
  let zoomOffset = 0;         // unitless, kept in [-1, 1] before mapping
  const ZOOM_GAIN = 0.55;     // how much accel becomes velocity contribution
  const ZOOM_DECAY = 3.2;     // higher = velocity dies faster (s^-1)
  const ZOOM_DEAD = 0.25;     // m/s^2, accelerometer noise floor
  const ZOOM_RANGE = 0.10;    // ±10% camera dolly (very soft)

  function onDeviceMotion(e) {
    if (!isCalibrated) return;
    const rate = e.rotationRate;
    if (!rate) return;

    const now = performance.now();
    if (lastMotionT === 0) { lastMotionT = now; return; }
    const dt = Math.min(0.1, (now - lastMotionT) / 1000);
    lastMotionT = now;

    // ---- twist (existing) ----
    let rateAxis = rate.alpha || 0;
    if (Math.abs(rateAxis) < RATE_DEAD_ZONE) rateAxis = 0;
    integratedAngle += (rateAxis * Math.PI / 180) * dt;

    // ---- soft zoom: device Z acceleration without gravity ----
    const accZ = (e.acceleration && e.acceleration.z != null)
      ? e.acceleration.z
      : 0;
    let aZ = accZ;
    if (Math.abs(aZ) < ZOOM_DEAD) aZ = 0;
    // Phone faces user → bringing wrist closer pushes screen toward face = +Z (negative depending on device frame).
    // We feed accel into velocity with strong decay so it always returns to 0 (no drift).
    zoomVel = zoomVel * Math.exp(-ZOOM_DECAY * dt) + aZ * ZOOM_GAIN * dt;
    // Soft accumulator that also decays back to 0.
    zoomOffset = zoomOffset * Math.exp(-ZOOM_DECAY * 0.5 * dt) + zoomVel * dt * 4;
    if (zoomOffset >  1) zoomOffset =  1;
    if (zoomOffset < -1) zoomOffset = -1;

    if (now - lastSent < 1000 / SEND_HZ) return;
    lastSent = now;

    smoothed += (integratedAngle - smoothed) * SMOOTH_ALPHA;
    socket.emit('armPitch', { angle: smoothed });
    socket.emit('armZoom',  { z: zoomOffset * ZOOM_RANGE });
    pulseBars();
    rotationHaptic(smoothed, now);

    if (now - lastLog > 100) {
      lastLog = now;
      console.log(
        `motion rateAlpha=${(rate.alpha || 0).toFixed(1)} ` +
        `integ=${(integratedAngle * 180 / Math.PI).toFixed(1)} ` +
        `smooth=${(smoothed * 180 / Math.PI).toFixed(1)} ` +
        `accZ=${accZ.toFixed(2)} zVel=${zoomVel.toFixed(2)} zOff=${zoomOffset.toFixed(2)}`
      );
    }
  }
  let lastLog = 0;

  function startGyro() {
    window.addEventListener('deviceorientation', onDeviceOrientation, true);
    window.addEventListener('devicemotion', onDeviceMotion, true);
  }

  $('btn-recalib-2').addEventListener('click', () => {
    isCalibrated = false;
    levelSince = null;
    integratedAngle = 0;
    smoothed = 0;
    lastMotionT = 0;
    showToast('Place phone flat to recalibrate');
    goto('calib');
  });

  // ---------------- bars (signal viz) ----------------
  const bars = $('bars');
  for (let i = 0; i < 16; i++) {
    const b = document.createElement('div');
    b.className = 'bar';
    b.style.height = (4 + Math.random() * 12) + 'px';
    bars.appendChild(b);
  }
  let pulseIdx = 0;
  function pulseBars() {
    const el = bars.children[pulseIdx];
    if (el) {
      el.classList.add('on');
      setTimeout(() => el.classList.remove('on'), 280);
    }
    pulseIdx = (pulseIdx + 1) % bars.children.length;
  }

  // initial step
  goto('paired');
})();
