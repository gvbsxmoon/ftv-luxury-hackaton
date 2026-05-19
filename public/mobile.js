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

  function haptic(pat) {
    if (navigator.vibrate) navigator.vibrate(pat);
  }
  function showToast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 1400);
  }

  // ---------------- step navigation ----------------
  function goto(stepName) {
    document.querySelectorAll('.m-step').forEach((el) => {
      el.classList.toggle('active', el.dataset.step === stepName);
    });
  }

  $('btn-continue-1').addEventListener('click', () => goto('select'));

  // ---------------- watches ----------------
  const watches = [
    { id: 'chrono-01',  name: 'CHRONO 01',  meta: 'Matte chrome × neon violet' },
    { id: 'noir-02',    name: 'NOIR 02',    meta: 'Stealth obsidian × magenta' },
    { id: 'argent-03',  name: 'ARGENT 03',  meta: 'Polished silver × cyan' },
    { id: 'voltage-04', name: 'VOLTAGE 04', meta: 'Indigo × electric lime' },
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
    let okOrient = true, okMotion = true;
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        const r = await DeviceOrientationEvent.requestPermission();
        okOrient = r === 'granted';
      }
      if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
        const r = await DeviceMotionEvent.requestPermission();
        okMotion = r === 'granted';
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

  // ---------------- gyroscope ----------------
  // We build a quaternion from device orientation (alpha, beta, gamma + screen orientation),
  // following the canonical formulation used by Three.js DeviceOrientationControls.
  function quatFromAxisAngle(ax, ang) {
    const half = ang / 2, s = Math.sin(half);
    return [ax[0] * s, ax[1] * s, ax[2] * s, Math.cos(half)];
  }
  function quatYXZ(x, y, z) {
    const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
    const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
    return [
      s1 * c2 * c3 + c1 * s2 * s3, // x
      c1 * s2 * c3 - s1 * c2 * s3, // y
      c1 * c2 * s3 - s1 * s2 * c3, // z
      c1 * c2 * c3 + s1 * s2 * s3, // w
    ];
  }
  function quatMul(a, b, out) {
    const ax = a[0], ay = a[1], az = a[2], aw = a[3];
    const bx = b[0], by = b[1], bz = b[2], bw = b[3];
    out[0] = ax * bw + aw * bx + ay * bz - az * by;
    out[1] = ay * bw + aw * by + az * bx - ax * bz;
    out[2] = az * bw + aw * bz + ax * by - ay * bx;
    out[3] = aw * bw - ax * bx - ay * by - az * bz;
    return out;
  }

  function buildOrientationQuat(alpha, beta, gamma, screenOrient) {
    const x = (beta || 0) * Math.PI / 180;
    const y = (alpha || 0) * Math.PI / 180;
    const z = -((gamma || 0) * Math.PI / 180);
    const o = (screenOrient || 0) * Math.PI / 180;

    const q = quatYXZ(x, y, z);
    const qHalf = quatFromAxisAngle([1, 0, 0], -Math.PI / 2);
    quatMul(q, qHalf, q);
    const qScreen = quatFromAxisAngle([0, 0, 1], -o);
    quatMul(q, qScreen, q);
    return q;
  }

  let lastSent = 0;
  let lastQuat = [0, 0, 0, 1];
  let baselineQuat = null;

  function getScreenOrient() {
    if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
    return window.orientation || 0;
  }

  function onDeviceOrientation(e) {
    const q = buildOrientationQuat(e.alpha, e.beta, e.gamma, getScreenOrient());
    lastQuat = q;

    // visualize on calibration step
    const dot = $('calib-dot');
    if (dot && document.querySelector('.m-step.active')?.dataset.step === 'calib') {
      // beta -90..90 -> y, gamma -90..90 -> x
      const px = clamp((e.gamma || 0) / 60, -1, 1) * 70;
      const py = clamp(((e.beta || 0) - 60) / 60, -1, 1) * 70; // assume 60° hold
      dot.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px))`;
    }

    const now = performance.now();
    if (now - lastSent > 1000 / 60) {
      lastSent = now;
      socket.emit('orientationUpdate', { q });
      pulseBars();
    }
  }

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function startGyro() {
    window.addEventListener('deviceorientation', onDeviceOrientation, true);
  }

  $('btn-lock').addEventListener('click', () => {
    baselineQuat = lastQuat.slice();
    socket.emit('calibrationData', { quat: baselineQuat });
    haptic([20, 40, 80]);
    showToast('Calibration locked.');
    goto('active');
    $('active-title').textContent = 'Controller live.';
  });
  $('btn-recalib').addEventListener('click', () => {
    haptic(15);
    showToast('Hold steady…');
  });
  $('btn-recalib-2').addEventListener('click', () => {
    if (useTouchFallback) {
      tpX = 0; tpY = 0; sendTouchpad();
      showToast('Touch centered');
      return;
    }
    baselineQuat = lastQuat.slice();
    socket.emit('calibrationData', { quat: baselineQuat });
    showToast('Recentered.');
    haptic(20);
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
  let tpX = 0, tpY = 0;
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
      const nx = clamp(cx / (rect.width / 2), -1, 1);
      const ny = clamp(cy / (rect.height / 2), -1, 1);
      tpX = nx; tpY = ny;
      dot.style.transform = `translate(calc(-50% + ${cx}px), calc(-50% + ${cy}px))`;
      sendTouchpad();
    }
    function onEnd() {
      dragging = false;
      // drift back to center
      const start = performance.now();
      const sx = tpX, sy = tpY;
      function step(t) {
        const k = Math.min(1, (t - start) / 600);
        const e = 1 - Math.pow(1 - k, 3);
        tpX = sx * (1 - e); tpY = sy * (1 - e);
        dot.style.transform = `translate(calc(-50% + ${tpX * rect.width / 2}px), calc(-50% + ${tpY * rect.height / 2}px))`;
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
    // tpX maps yaw, tpY maps pitch
    const yaw = -tpX * (Math.PI / 3);
    const pitch = -tpY * (Math.PI / 3);
    // build quaternion ZYX
    const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2);
    const cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
    // y-axis (yaw) then x-axis (pitch): q = qy * qx
    const qy = [0, sy, 0, cy];
    const qx = [sp, 0, 0, cp];
    const q = [0, 0, 0, 1];
    quatMul(qy, qx, q);
    socket.emit('orientationUpdate', { q });
    pulseBars();
  }

  // initial: show "paired" step right away (we are in this page only after scan succeeded)
  goto('paired');
})();
