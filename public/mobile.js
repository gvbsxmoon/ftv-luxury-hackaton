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

  $('btn-continue-1').addEventListener('click', () => goto('select'));

  // ---------------- watches (single model for now) ----------------
  const watches = [
    { id: 'chrono-01', name: 'CHRONO 01', meta: 'Obsidian — luxury edition' },
  ];
  const watchesEl = $('watches');
  let activeWatch = 'chrono-01';
  watches.forEach((w) => {
    const el = document.createElement('div');
    el.className = 'watch' + (w.id === activeWatch ? ' selected' : '');
    el.dataset.id = w.id;
    el.innerHTML = `<div class="swatch"></div><div class="name">${w.name}</div><div class="meta">${w.meta}</div>`;
    el.addEventListener('click', () => {
      activeWatch = w.id;
      document.querySelectorAll('.watch').forEach((x) => x.classList.toggle('selected', x.dataset.id === w.id));
      socket.emit('watchSelect', { id: w.id });
      haptic(10);
    });
    watchesEl.appendChild(el);
  });

  $('btn-continue-2').addEventListener('click', () => goto('perm'));

  // ---------------- permissions ----------------
  let useTouchFallback = false;

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
      showToast('Motion denied — using touch');
      enableTouchFallback();
    }
  });

  $('btn-skip-perm').addEventListener('click', () => enableTouchFallback());

  function enableTouchFallback() {
    useTouchFallback = true;
    socket.emit('controlMode', { mode: 'touch' });
    goto('active');
    $('touchpad-wrap').classList.remove('hidden');
    $('active-title').textContent = 'Touch controller live.';
    setupTouchpad();
  }

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
  let levelSince = null;     // timestamp when we first became "level" continuously
  let zeroBeta = null;       // baseline beta (set when leveled)
  let isCalibrated = false;

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
          // LOCK: this is our zero.
          zeroBeta = lastBeta;
          isCalibrated = true;
          haptic([20, 40, 80]);
          showToast('Calibrated — pick up the phone');
          socket.emit('calibrationData', { zeroBeta });
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

    // Calibrated: stream relative beta as the arm-X-axis angle.
    const now = performance.now();
    if (now - lastSent < 1000 / SEND_HZ) return;
    lastSent = now;

    // Relative angle since calibration zero.
    let delta = lastBeta - zeroBeta;
    const rawDelta = delta;
    // Clamp to +/-90° so the arm cannot flip
    delta = clamp(delta, -90, 90);
    const angleRad = delta * Math.PI / 180;
    socket.emit('armPitch', { angle: angleRad });
    pulseBars();

    // Throttled debug log: alpha/beta/gamma raw, zeroBeta, raw delta, clamped delta.
    if (now - lastLog > 100) {
      lastLog = now;
      const a = (e.alpha == null ? 'null' : e.alpha.toFixed(1));
      console.log(
        `gyro a=${a} b=${lastBeta.toFixed(1)} g=${lastGamma.toFixed(1)} ` +
        `zeroB=${zeroBeta.toFixed(1)} rawDelta=${rawDelta.toFixed(1)} clamped=${delta.toFixed(1)}`
      );
    }
  }
  let lastLog = 0;

  function startGyro() {
    window.addEventListener('deviceorientation', onDeviceOrientation, true);
  }

  $('btn-recalib-2').addEventListener('click', () => {
    if (useTouchFallback) {
      tpX = 0; sendTouchpad();
      showToast('Touch centered');
      return;
    }
    isCalibrated = false;
    zeroBeta = null;
    levelSince = null;
    showToast('Place phone flat to recalibrate');
    goto('calib');
  });

  $('btn-back-watch').addEventListener('click', () => goto('select'));

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

  // ---------------- touch fallback ----------------
  let tpX = 0;
  function setupTouchpad() {
    const pad = $('touchpad'), dot = $('tp-dot');
    let dragging = false, rect = null;

    function onStart(e) {
      dragging = true;
      rect = pad.getBoundingClientRect();
      onMove(e);
    }
    function onMove(e) {
      if (!dragging) return;
      const t = (e.touches && e.touches[0]) || e;
      const cx = t.clientX - rect.left - rect.width / 2;
      const cy = t.clientY - rect.top - rect.height / 2;
      const ny = clamp(cy / (rect.height / 2), -1, 1);
      tpX = ny;
      dot.style.transform = `translate(-50%, calc(-50% + ${cy}px))`;
      sendTouchpad();
    }
    function onEnd() {
      dragging = false;
      const start = performance.now();
      const sy = tpX;
      function step(t) {
        const k = Math.min(1, (t - start) / 600);
        const eo = 1 - Math.pow(1 - k, 3);
        tpX = sy * (1 - eo);
        dot.style.transform = `translate(-50%, calc(-50% + ${tpX * rect.height / 2}px))`;
        sendTouchpad();
        if (k < 1) requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    }
    pad.addEventListener('touchstart', onStart, { passive: true });
    pad.addEventListener('touchmove', onMove, { passive: true });
    pad.addEventListener('touchend', onEnd);
    pad.addEventListener('mousedown', onStart);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onEnd);
  }

  function sendTouchpad() {
    const angle = -tpX * (Math.PI / 3);
    socket.emit('armPitch', { angle });
    pulseBars();
  }

  // initial step
  goto('paired');
})();
