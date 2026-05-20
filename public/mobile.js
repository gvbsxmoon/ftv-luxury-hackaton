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

  // Quaternion-based: store inverse of the calibration quaternion, then per-frame
  // compute (qZeroInv * qNow) and extract the twist around the device's X axis.
  const qZeroInv = [1, 0, 0, 0]; // [w, x, y, z]
  let lastUnwrapped = 0;          // continuous twist angle (rad), unwrapped from -PI..PI

  let lastSent = 0;
  const SEND_HZ = 60;

  // ---- quaternion helpers (inline, no THREE on mobile) ----
  function eulerToQuat(alphaDeg, betaDeg, gammaDeg) {
    // Browser device-orientation convention: ZXY intrinsic.
    const a = (alphaDeg || 0) * Math.PI / 180;
    const b = (betaDeg  || 0) * Math.PI / 180;
    const g = (gammaDeg || 0) * Math.PI / 180;
    const cZ = Math.cos(a / 2), sZ = Math.sin(a / 2);
    const cX = Math.cos(b / 2), sX = Math.sin(b / 2);
    const cY = Math.cos(g / 2), sY = Math.sin(g / 2);
    // q = qZ * qX * qY
    // First qZX = qZ * qX
    const w1 = cZ * cX, x1 = cZ * sX, y1 = sZ * sX, z1 = sZ * cX;
    // Then qZX * qY
    const w = w1 * cY - y1 * sY;
    const x = x1 * cY + z1 * sY;
    const y = y1 * cY + w1 * sY;
    const z = z1 * cY - x1 * sY;
    return [w, x, y, z];
  }
  function quatMul(q1, q2) {
    const [w1, x1, y1, z1] = q1;
    const [w2, x2, y2, z2] = q2;
    return [
      w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
      w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
      w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
      w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
    ];
  }
  function quatInv(q) {
    return [q[0], -q[1], -q[2], -q[3]];
  }
  // Twist around the local X axis (returns angle in rad in [-PI, PI]).
  function twistAroundX(q) {
    // Project onto the X-twist component: t = (w, x, 0, 0) normalized.
    const w = q[0], x = q[1];
    const len = Math.hypot(w, x) || 1;
    const tw = w / len, tx = x / len;
    let angle = 2 * Math.atan2(tx, tw);
    if (angle >  Math.PI) angle -= 2 * Math.PI;
    if (angle < -Math.PI) angle += 2 * Math.PI;
    return angle;
  }
  // Continuous unwrap: returns prev + shortest-path delta to `current`.
  function unwrap(prev, current) {
    let d = current - prev;
    while (d >  Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return prev + d;
  }

  function onDeviceOrientation(e) {
    lastBeta  = e.beta  || 0;
    lastGamma = e.gamma || 0;
    const qNow = eulerToQuat(e.alpha, e.beta, e.gamma);

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
          // LOCK: capture the inverse of the current quaternion as our zero.
          const inv = quatInv(qNow);
          qZeroInv[0] = inv[0]; qZeroInv[1] = inv[1]; qZeroInv[2] = inv[2]; qZeroInv[3] = inv[3];
          lastUnwrapped = 0;
          isCalibrated = true;
          haptic([20, 40, 80]);
          showToast('Calibrated — pick up the phone');
          socket.emit('calibrationData', { ok: true });
          goto('active');
          $('active-title').textContent = 'Controller live.';
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

    // Calibrated: extract the twist around the device's X axis from the relative quaternion.
    const now = performance.now();
    if (now - lastSent < 1000 / SEND_HZ) return;
    lastSent = now;

    const qRel = quatMul(qZeroInv, qNow);
    const raw = twistAroundX(qRel);              // [-PI, PI]
    lastUnwrapped = unwrap(lastUnwrapped, raw);  // continuous angle (rad), no flips
    const angleRad = lastUnwrapped;
    socket.emit('armPitch', { angle: angleRad });
    pulseBars();

    // Throttled debug log
    if (now - lastLog > 100) {
      lastLog = now;
      const a = (e.alpha == null ? 'null' : e.alpha.toFixed(1));
      console.log(
        `gyro a=${a} b=${lastBeta.toFixed(1)} g=${lastGamma.toFixed(1)} ` +
        `twistRaw=${(raw * 180 / Math.PI).toFixed(1)} unwrap=${(lastUnwrapped * 180 / Math.PI).toFixed(1)}`
      );
    }
  }
  let lastLog = 0;

  function startGyro() {
    window.addEventListener('deviceorientation', onDeviceOrientation, true);
  }

  $('btn-recalib-2').addEventListener('click', () => {
    isCalibrated = false;
    zeroBeta = null;
    levelSince = null;
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
