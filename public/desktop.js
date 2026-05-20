import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// ============== Session bootstrap ==============
const $ = (id) => document.getElementById(id);

let sessionId = null;
let token = null;
let socket = null;

async function createSession() {
  const res = await fetch('/api/session', { method: 'POST' });
  const data = await res.json();
  sessionId = data.sessionId;
  token = data.token;
  $('qr').src = data.qrDataUrl;
  return data;
}

function connectSocket() {
  socket = io({ auth: { sessionId, token, role: 'desktop' } });
  socket.on('connect', () => {
    $('dot-desktop').classList.remove('off');
  });
  socket.on('connectionStatus', (s) => {
    $('dot-mobile').classList.toggle('off', !s.mobile);
    if (s.mobile) onMobileJoined();
    else onMobileLeft();
  });
  socket.on('orientationUpdate', onOrientationUpdate);
  socket.on('armPitch', onArmPitch);
  socket.on('watchSelect', (m) => setActiveWatch(m.id));
  socket.on('calibrationData', (m) => onCalibration(m));
  socket.on('controlMode', (m) => onControlMode(m));

  let pingTimer = setInterval(() => {
    if (!socket.connected) return;
    const t0 = performance.now();
    socket.emit('ping_t', t0);
    socket.once('pong_t', () => {
      const dt = performance.now() - t0;
      $('latency').textContent = `${Math.round(dt)} ms`;
    });
  }, 2000);
}

function onMobileJoined() {
  $('pair-panel').classList.add('hidden');
  $('hud').classList.remove('hidden');
  $('reconnect').classList.add('hidden');
  enterScene();
}
function onMobileLeft() {
  $('reconnect').classList.remove('hidden');
}

let previewMode = false;
$('btn-preview').addEventListener('click', () => {
  previewMode = true;
  $('pair-panel').classList.add('hidden');
  $('hud').classList.remove('hidden');
  $('hud-mode').textContent = 'PREVIEW';
  enterScene();
});

$('btn-new-session').addEventListener('click', async () => {
  if (socket) socket.disconnect();
  await createSession();
  connectSocket();
  $('reconnect').classList.add('hidden');
  $('pair-panel').classList.remove('hidden');
  $('hud').classList.add('hidden');
});

// ============== Three.js scene ==============
const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();
scene.background = null;
scene.fog = new THREE.FogExp2(0x05030a, 0.18);

const camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.05, 100);

// Initial camera + orbit target. Press M while playing to copy current values into clipboard.
const CAMERA_DEFAULTS = {
  pos: { x: 2.299, y: -0.158, z: 0.672 },
  target: { x: 0, y: 0, z: 0 },
};

camera.position.set(CAMERA_DEFAULTS.pos.x, CAMERA_DEFAULTS.pos.y, CAMERA_DEFAULTS.pos.z);
camera.lookAt(CAMERA_DEFAULTS.target.x, CAMERA_DEFAULTS.target.y, CAMERA_DEFAULTS.target.z);

// Custom single-axis mouse rotation: drag to pivot the camera around the world-space
// red X axis of the stage (stageGroup's local +X). The axis stays fixed in world space.
const cameraTarget = new THREE.Vector3(CAMERA_DEFAULTS.target.x, CAMERA_DEFAULTS.target.y, CAMERA_DEFAULTS.target.z);
camera.lookAt(cameraTarget);

function pivotCameraAroundStageX(angle) {
  if (!angle) return;
  const axis = new THREE.Vector3(1, 0, 0)
    .applyQuaternion(stageGroup.getWorldQuaternion(new THREE.Quaternion()))
    .normalize();
  const pivot = stageGroup.getWorldPosition(new THREE.Vector3());

  const offset = camera.position.clone().sub(pivot);
  offset.applyAxisAngle(axis, angle);
  camera.position.copy(pivot).add(offset);

  cameraTarget.sub(pivot).applyAxisAngle(axis, angle).add(pivot);
  camera.up.applyAxisAngle(axis, angle);
  camera.lookAt(cameraTarget);
}

(function setupSingleAxisOrbit() {
  let dragging = false;
  let lastY = 0;
  const ROT_PER_PX = 0.0055;

  renderer.domElement.addEventListener('mousedown', (e) => {
    dragging = true;
    lastY = e.clientY;
  });
  window.addEventListener('mouseup', () => { dragging = false; });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dy = e.clientY - lastY;
    lastY = e.clientY;
    pivotCameraAroundStageX(dy * ROT_PER_PX);
  });
})();

// Stub kept so existing code referencing `controls.update()` and `controls.target` stays valid.
const controls = {
  target: cameraTarget,
  update: () => {},
};

// Environment for PBR reflections
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

// ----- Lighting -----
const ambient = new THREE.AmbientLight(0x331e55, 0.35);
scene.add(ambient);

const keyLight = new THREE.DirectionalLight(0xb14bff, 4.0);
keyLight.position.set(-2.0, 2.5, 1.8);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(2048, 2048);
keyLight.shadow.camera.near = 0.1;
keyLight.shadow.camera.far = 8;
keyLight.shadow.camera.left = -2;
keyLight.shadow.camera.right = 2;
keyLight.shadow.camera.top = 2;
keyLight.shadow.camera.bottom = -2;
keyLight.shadow.bias = -0.0005;
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0x8da8c8, 0.25);
fillLight.position.set(2.5, 1.0, 1.5);
scene.add(fillLight);

const rimLight = new THREE.DirectionalLight(0x6efcff, 1.4);
rimLight.position.set(1.5, 0.8, -2.5);
scene.add(rimLight);

// Point light pulse near the watch
const watchAccent = new THREE.PointLight(0xb14bff, 0.8, 2.0, 1.6);
watchAccent.position.set(0.2, 0.1, 0.4);
scene.add(watchAccent);


// (no floor, no fog sprites, no particles — clean dark stage per user request)

// ----- Post FX -----
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.28, 0.6, 0.85);
composer.addPass(bloom);
composer.addPass(new OutputPass());

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

// ============== Models ==============
const loader = new GLTFLoader();

// Stage = arm+watch+axes container. Tune as one unit (initial scene position).
const stageGroup = new THREE.Group();
scene.add(stageGroup);

// armGroup = arm+watch only (positioned relative to the local axes/origin of stage).
const armGroup = new THREE.Group();
armGroup.visible = false;
stageGroup.add(armGroup);

// Whole arm+watch box transform — relative to stage origin (where the axes sit).
const ARM_OFFSET = {
  x: 0.180, y: -0.030, z: -0.060,
  rx: 0.24, ry: 3.84, rz: -0.08,
  s: 0.75,
};

// Stage transform — moves arm+watch+axes together.
const STAGE_OFFSET = {
  x: 0.510, y: 0.180, z: -0.360,
  rx: 0.00, ry: -1.92, rz: 0.00,
  s: 1.35,
};

let armRoot = null;        // GLTF arm scene root
let armPivot = null;       // node we rotate live from phone
let wristNode = null;
let watchHolder = null;
let watchModel = null;
let watchVariants = {};
let activeWatchId = 'chrono-01';
let axesHelper = null;     // toggled with X

function obsidianizeArm(root) {
  root.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true; o.receiveShadow = true;
      const m = o.material;
      if (m && m.isMeshStandardMaterial) {
        m.color = new THREE.Color(0x0c0c12);
        m.metalness = 0.85;
        m.roughness = 0.22;
        m.envMapIntensity = 1.2;
        if (m.map) m.map = null;
        if (m.emissiveMap) m.emissiveMap = null;
        m.emissive = new THREE.Color(0x000000);
        m.emissiveIntensity = 0.0;
        m.needsUpdate = true;
      }
    }
  });
}

function styleWatch(root) {
  root.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true; o.receiveShadow = true;
      const m = o.material;
      if (m && m.isMeshStandardMaterial) {
        m.envMapIntensity = 0.55;
        m.metalness = Math.min(0.85, (m.metalness ?? 0.5));
        m.roughness = Math.max(0.45, (m.roughness ?? 0.4) + 0.15);
        m.needsUpdate = true;
      }
    }
  });
}

function findWristNode(root) {
  // Try to find a bone/node by name first.
  const want = ['wrist', 'hand', 'mixamorig:lefthand', 'mixamorig:righthand', 'palm', 'forearm.end'];
  let best = null;
  let bestScore = -1;
  root.traverse((o) => {
    const n = (o.name || '').toLowerCase();
    let score = -1;
    if (n.includes('wrist')) score = 5;
    else if (n.includes('hand')) score = 4;
    else if (n.includes('palm')) score = 3;
    else if (n.includes('forearm')) score = 1;
    if (score > bestScore) { bestScore = score; best = o; }
  });
  return best;
}

function computeWristAttachment(root) {
  // Fallback: pick the world-space tip of the arm bbox in +X direction (assumed forward of arm).
  const box = new THREE.Box3().setFromObject(root);
  const center = box.getCenter(new THREE.Vector3());
  const tip = new THREE.Vector3(box.max.x, center.y, center.z);
  return tip;
}

async function loadModels() {
  // Load arm
  const armGltf = await loader.loadAsync('/assets/arm.glb');
  armRoot = armGltf.scene;
  obsidianizeArm(armRoot);

  // Normalize size: scale arm so its largest dimension is 1.4 units (fits frame nicely).
  armRoot.updateMatrixWorld(true);
  const armBox0 = new THREE.Box3().setFromObject(armRoot);
  const armSize0 = armBox0.getSize(new THREE.Vector3());
  const armLongest = Math.max(armSize0.x, armSize0.y, armSize0.z) || 1;
  const armScale = 1.7 / armLongest;
  armRoot.scale.setScalar(armScale);

  // Center arm at origin (by bounding box) so it sits in the frame middle.
  armRoot.updateMatrixWorld(true);
  const armBox1 = new THREE.Box3().setFromObject(armRoot);
  const armCenter1 = armBox1.getCenter(new THREE.Vector3());
  armRoot.position.sub(armCenter1);

  // Pivot we rotate to follow gyroscope (rotation around local X = arm length axis).
  armPivot = new THREE.Group();
  armPivot.add(armRoot);
  armGroup.add(armPivot);

  applyArmOffset();
  applyStageOffset();

  // Local axes helper, toggled with X. Lives on armPivot so it shows the arm's frame.
  // Built manually so colors stay readable through bloom+tonemap.
  axesHelper = new THREE.Group();
  const axisLen = 1.0;
  const mkAxis = (color, dir) => {
    const geom = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(dir.x * axisLen, dir.y * axisLen, dir.z * axisLen),
    ]);
    const mat = new THREE.LineBasicMaterial({ color, toneMapped: false, transparent: false });
    return new THREE.Line(geom, mat);
  };
  axesHelper.add(mkAxis(0xff2a2a, new THREE.Vector3(1, 0, 0))); // X red
  axesHelper.add(mkAxis(0x22ff44, new THREE.Vector3(0, 1, 0))); // Y green
  axesHelper.add(mkAxis(0x3aa0ff, new THREE.Vector3(0, 0, 1))); // Z blue
  axesHelper.visible = false;
  stageGroup.add(axesHelper); // assi figli dello stage: fermi quando muovi il braccio col tuner X, ma seguono il tuner G

  // Recompute box AFTER placement to find a wrist anchor (rightmost / "tip" along longest axis).
  armRoot.updateMatrixWorld(true);
  const armBox2 = new THREE.Box3().setFromObject(armRoot);
  const armSize2 = armBox2.getSize(new THREE.Vector3());

  // Choose the dominant axis of the arm — that's the direction it extends.
  const axes = [
    { axis: 'x', size: armSize2.x, dir: 1 },
    { axis: 'y', size: armSize2.y, dir: 1 },
    { axis: 'z', size: armSize2.z, dir: 1 },
  ];
  axes.sort((a, b) => b.size - a.size);
  const dominant = axes[0].axis;

  // Place wrist anchor near the positive end of the dominant axis.
  const tipWorld = armBox2.getCenter(new THREE.Vector3());
  if (dominant === 'x') tipWorld.x = armBox2.max.x - armSize2.x * 0.10;
  if (dominant === 'y') tipWorld.y = armBox2.max.y - armSize2.y * 0.10;
  if (dominant === 'z') tipWorld.z = armBox2.max.z - armSize2.z * 0.10;

  watchHolder = new THREE.Group();
  watchHolder.position.copy(tipWorld);
  armPivot.add(watchHolder); // sibling-of-arm under pivot, so wrist follows arm rotation

  // Load watch
  const watchGltf = await loader.loadAsync('/assets/watch.glb');
  const baseWatch = watchGltf.scene;
  styleWatch(baseWatch);

  // Scale watch relative to arm's smaller cross-section (so it sits as a band around the wrist).
  const wBox = new THREE.Box3().setFromObject(baseWatch);
  const wSize = wBox.getSize(new THREE.Vector3());
  const wLongest = Math.max(wSize.x, wSize.y, wSize.z) || 1;
  // Target watch size = ~70% of the arm's narrower dimension
  const armNarrow = Math.min(armSize2.x, armSize2.y, armSize2.z);
  const wTargetSize = armNarrow * 0.9;
  const wScale = wTargetSize / wLongest;
  baseWatch.scale.setScalar(wScale);
  const wBox2 = new THREE.Box3().setFromObject(baseWatch);
  const wCenter = wBox2.getCenter(new THREE.Vector3());
  baseWatch.position.sub(wCenter);

  // Single variant — keep the watch's own materials as-is (after styleWatch tweaks).
  watchVariants['chrono-01'] = baseWatch;
  watchHolder.add(baseWatch);

  // Remember the base scale we computed, so the tuner's "scale: 1.0" = original size.
  WATCH_OFFSET.s_base = wScale;

  setActiveWatch(activeWatchId);
  applyWatchOffset();
}

function setActiveWatch(id) {
  if (!watchVariants[id]) return;
  if (watchModel) watchModel.visible = false;
  watchModel = watchVariants[id];
  watchModel.visible = true;
  $('hud-watch').textContent = id.toUpperCase();
}

// ============== Motion ==============
// Calibration: we capture an inverse of the phone's first quaternion when calibrated,
// then apply it so that the calibrated pose corresponds to identity rotation on the arm.

const targetQuat = new THREE.Quaternion();      // raw target after calibration & remap
const currentQuat = new THREE.Quaternion();     // smoothed value applied to armPivot
const calibInv = new THREE.Quaternion();        // inverse of baseline phone quaternion
let hasCalibration = false;

// Mapping tweaks: device "screen up" frame → scene frame.
const REMAP = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0, 'XYZ'));

function onCalibration(payload) {
  const { quat } = payload;
  const q = new THREE.Quaternion(quat[0], quat[1], quat[2], quat[3]);
  calibInv.copy(q).invert();
  hasCalibration = true;
  flashAccent();
}

function onControlMode(payload) {
  $('hud-mode').textContent = (payload.mode || 'GYRO').toUpperCase();
}

function flashAccent() {
  watchAccent.intensity = 4.5;
  setTimeout(() => { watchAccent.intensity = 1.6; }, 220);
}

function onOrientationUpdate(payload) {
  // Legacy quaternion path kept for touch fallback compatibility.
  const q = new THREE.Quaternion(payload.q[0], payload.q[1], payload.q[2], payload.q[3]);
  if (hasCalibration) q.premultiply(calibInv);
  q.multiply(REMAP);
  targetQuat.copy(q);
  $('hud-quat').textContent = `q: ${q.x.toFixed(2)} ${q.y.toFixed(2)} ${q.z.toFixed(2)} ${q.w.toFixed(2)}`;
}

// Phone tilt around its X axis -> camera pivots around the stage's red X axis (world space).
// Arm + watch + axes stay fixed; the camera orbits around them.
let targetArmPitch = 0;   // radians (from phone)
let currentArmPitch = 0;  // radians (smoothed, last applied)
let lastPitchLog = 0;
function onArmPitch(payload) {
  targetArmPitch = payload.angle || 0;
  $('hud-quat').textContent = `pitch: ${(targetArmPitch * 180 / Math.PI).toFixed(1)}°`;
  const now = performance.now();
  if (now - lastPitchLog > 100) {
    lastPitchLog = now;
    console.log(`armPitch deg=${(targetArmPitch * 180 / Math.PI).toFixed(1)} rad=${targetArmPitch.toFixed(3)}`);
  }
}

function enterScene() {
  armGroup.visible = true;
  startBgm();
}

// ============== Background music (loop + fade-in) ==============
const BGM_TARGET_VOLUME = 0.5;
const BGM_FADE_MS = 3000;
let bgmStarted = false;
let bgmMuted = false;

function startBgm() {
  if (bgmStarted) return;
  const audio = $('bgm');
  if (!audio) return;
  audio.muted = false;
  audio.volume = 0;
  const playPromise = audio.play();
  const onPlaying = () => {
    bgmStarted = true;
    $('mute-btn').classList.remove('hidden');
    fadeBgmTo(BGM_TARGET_VOLUME, BGM_FADE_MS);
  };
  if (playPromise && typeof playPromise.then === 'function') {
    playPromise.then(onPlaying).catch(() => {
      // Autoplay blocked — wait for any user gesture, then start.
      const armOnGesture = () => {
        audio.muted = false;
        audio.play().then(onPlaying).catch(() => {});
        window.removeEventListener('pointerdown', armOnGesture);
        window.removeEventListener('keydown', armOnGesture);
      };
      window.addEventListener('pointerdown', armOnGesture, { once: true });
      window.addEventListener('keydown', armOnGesture, { once: true });
    });
  } else {
    onPlaying();
  }
}

// Best-effort: try to "warm" the audio element on the very first user gesture
// the page receives (even before mobile pairing) so playback is unlocked.
(function unlockAudioOnFirstGesture() {
  const armed = { done: false };
  function onGesture() {
    if (armed.done) return;
    armed.done = true;
    const audio = $('bgm');
    if (!audio) return;
    audio.muted = true;
    audio.play().then(() => {
      audio.pause();
      audio.muted = false;
    }).catch(() => {});
  }
  window.addEventListener('pointerdown', onGesture, { once: true });
  window.addEventListener('keydown', onGesture, { once: true });
})();

function fadeBgmTo(targetVol, durationMs) {
  const audio = $('bgm');
  if (!audio) return;
  const startVol = audio.volume;
  const startT = performance.now();
  function step(now) {
    const k = Math.min(1, (now - startT) / durationMs);
    audio.volume = startVol + (targetVol - startVol) * k;
    if (k < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

$('mute-btn').addEventListener('click', () => {
  const audio = $('bgm');
  if (!audio) return;
  if (bgmMuted) {
    audio.muted = false;
    if (audio.paused) audio.play().catch(() => {});
    fadeBgmTo(BGM_TARGET_VOLUME, 600);
    $('mute-btn').classList.remove('muted');
    $('mute-icon').textContent = '♪';
    bgmMuted = false;
  } else {
    audio.muted = true;
    $('mute-btn').classList.add('muted');
    $('mute-icon').textContent = '×';
    bgmMuted = true;
  }
});

// ============== Animate ==============
const clock = new THREE.Clock();
let frame = 0;
let fpsAcc = 0;
let fpsCount = 0;

function animate() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.getElapsedTime();
  frame++;

  controls.update();

  // (preview mode auto-rotation disabled — use mouse OrbitControls instead)

  // Smooth gyro angle and apply the delta as a camera pivot around the stage X axis.
  {
    const k = Math.min(0.2, 1 - Math.pow(0.0001, dt));
    const next = currentArmPitch + (targetArmPitch - currentArmPitch) * k;
    const delta = next - currentArmPitch;
    currentArmPitch = next;
    pivotCameraAroundStageX(delta);
  }

  // Watch accent pulse
  watchAccent.intensity = 0.7 + Math.sin(t * 2.4) * 0.2;

  // FPS
  fpsAcc += dt; fpsCount++;
  if (fpsAcc > 0.5) {
    $('hud-fps').textContent = `${Math.round(fpsCount / fpsAcc)} fps`;
    fpsAcc = 0; fpsCount = 0;
  }

  composer.render();
  requestAnimationFrame(animate);
}

// ============== Watch tuner (live) ==============
// Press ? to open the on-screen tuner with current offsets, copy them when happy.
//
// You can also hardcode these defaults — they apply on every reload:
const WATCH_OFFSET = {
  x: -0.600, y: 0.120, z: -0.020,
  rx: -1.36, ry: -0.32, rz: -0.72,
  s: 0.65,
};

function applyStageOffset() {
  if (!stageGroup) return;
  stageGroup.position.set(STAGE_OFFSET.x, STAGE_OFFSET.y, STAGE_OFFSET.z);
  stageGroup.rotation.set(STAGE_OFFSET.rx, STAGE_OFFSET.ry, STAGE_OFFSET.rz);
  stageGroup.scale.setScalar(STAGE_OFFSET.s);
  updateStageTunerHUD();
}

let stageTunerEl = null;
function buildStageTuner() {
  const el = document.createElement('div');
  el.id = 'stage-tuner';
  el.style.cssText = `
    position: fixed; left: 22px; top: 22px; z-index: 50;
    background: rgba(40,8,30,0.85); border: 1px solid rgba(255,180,90,0.4);
    border-radius: 10px; padding: 12px 14px;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 11px; color: #ffe6c8; min-width: 300px;
    backdrop-filter: blur(10px);
  `;
  el.innerHTML = `
    <div style="letter-spacing:0.25em; color:#ffb45a; margin-bottom:8px;">STAGE TUNER &nbsp; <span style="opacity:0.6">[G to toggle]</span></div>
    <div id="stage-tuner-vals" style="line-height:1.7;"></div>
    <div style="margin-top:10px; opacity:0.75; line-height:1.6; font-size:10px;">
      Same keys as ARM tuner — moves arm+watch+axes together
    </div>
  `;
  document.body.appendChild(el);
  return el;
}
function updateStageTunerHUD() {
  if (!stageTunerEl) return;
  const v = STAGE_OFFSET;
  stageTunerEl.querySelector('#stage-tuner-vals').innerHTML = `
    pos:&nbsp; x ${v.x.toFixed(3)} &nbsp; y ${v.y.toFixed(3)} &nbsp; z ${v.z.toFixed(3)}<br/>
    rot:&nbsp; x ${v.rx.toFixed(2)} &nbsp; y ${v.ry.toFixed(2)} &nbsp; z ${v.rz.toFixed(2)}<br/>
    scale: ${v.s.toFixed(2)}
  `;
}

function applyArmOffset() {
  if (!armGroup) return;
  armGroup.position.set(ARM_OFFSET.x, ARM_OFFSET.y, ARM_OFFSET.z);
  armGroup.rotation.set(ARM_OFFSET.rx, ARM_OFFSET.ry, ARM_OFFSET.rz);
  armGroup.scale.setScalar(ARM_OFFSET.s);
  updateArmTunerHUD();
}

let armBoxTunerEl = null;
function buildArmTuner() {
  const el = document.createElement('div');
  el.id = 'arm-tuner';
  el.style.cssText = `
    position: fixed; left: 22px; bottom: 22px; z-index: 50;
    background: rgba(8,16,40,0.85); border: 1px solid rgba(110,252,255,0.4);
    border-radius: 10px; padding: 12px 14px;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 11px; color: #d5f7ff; min-width: 300px;
    backdrop-filter: blur(10px);
  `;
  el.innerHTML = `
    <div style="letter-spacing:0.25em; color:#6efcff; margin-bottom:8px;">ARM BOX TUNER &nbsp; <span style="opacity:0.6">[X to toggle]</span></div>
    <div id="arm-tuner-vals" style="line-height:1.7;"></div>
    <div style="margin-top:10px; opacity:0.75; line-height:1.6; font-size:10px;">
      <b>← → ↑ ↓</b> move XY &nbsp; <b>Z/V</b> move Z<br/>
      <b>I/K</b> rotX &nbsp; <b>J/L</b> rotY &nbsp; <b>U/O</b> rotZ<br/>
      <b>+/-</b> scale &nbsp; <b>R</b> reset &nbsp; <b>C</b> copy &nbsp; (Shift = fine)
    </div>
  `;
  document.body.appendChild(el);
  return el;
}
function updateArmTunerHUD() {
  if (!armBoxTunerEl) return;
  const v = ARM_OFFSET;
  armBoxTunerEl.querySelector('#arm-tuner-vals').innerHTML = `
    pos:&nbsp; x ${v.x.toFixed(3)} &nbsp; y ${v.y.toFixed(3)} &nbsp; z ${v.z.toFixed(3)}<br/>
    rot:&nbsp; x ${v.rx.toFixed(2)} &nbsp; y ${v.ry.toFixed(2)} &nbsp; z ${v.rz.toFixed(2)}<br/>
    scale: ${v.s.toFixed(2)}
  `;
}

function applyWatchOffset() {
  if (!watchHolder) return;
  // We tweak the watch model itself (children of watchHolder), so the auto-placed
  // wrist anchor stays untouched as the rotation pivot.
  for (const child of watchHolder.children) {
    child.position.set(WATCH_OFFSET.x, WATCH_OFFSET.y, WATCH_OFFSET.z);
    child.rotation.set(WATCH_OFFSET.rx, WATCH_OFFSET.ry, WATCH_OFFSET.rz);
    child.scale.setScalar(WATCH_OFFSET.s_base ? WATCH_OFFSET.s_base * WATCH_OFFSET.s : WATCH_OFFSET.s);
  }
  updateTunerHUD();
}

function buildTuner() {
  const el = document.createElement('div');
  el.id = 'tuner';
  el.style.cssText = `
    position: fixed; right: 22px; bottom: 22px; z-index: 50;
    background: rgba(20,8,40,0.85); border: 1px solid rgba(177,75,255,0.4);
    border-radius: 10px; padding: 12px 14px;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 11px; color: #e9d5ff; min-width: 280px;
    backdrop-filter: blur(10px);
  `;
  el.innerHTML = `
    <div style="letter-spacing:0.25em; color:#c89dff; margin-bottom:8px;">WATCH TUNER &nbsp; <span style="opacity:0.6">[T to toggle]</span></div>
    <div id="tuner-vals" style="line-height:1.7;"></div>
    <div style="margin-top:10px; opacity:0.75; line-height:1.6; font-size:10px;">
      <b>WASD/QE</b> move &nbsp; <b>IJKL/UO</b> rotate &nbsp; <b>+/-</b> scale &nbsp; <b>R</b> reset &nbsp; <b>C</b> copy
    </div>
  `;
  document.body.appendChild(el);
  return el;
}

let tunerEl = null;
function updateTunerHUD() {
  if (!tunerEl) return;
  const v = WATCH_OFFSET;
  tunerEl.querySelector('#tuner-vals').innerHTML = `
    pos:&nbsp; x ${v.x.toFixed(3)} &nbsp; y ${v.y.toFixed(3)} &nbsp; z ${v.z.toFixed(3)}<br/>
    rot:&nbsp; x ${v.rx.toFixed(2)} &nbsp; y ${v.ry.toFixed(2)} &nbsp; z ${v.rz.toFixed(2)}<br/>
    scale: ${v.s.toFixed(2)}
  `;
}

window.addEventListener('keydown', (e) => {
  // Copy current camera pos + orbit target to clipboard, ready to paste into CAMERA_DEFAULTS.
  if (e.key === 'm' || e.key === 'M') {
    const data = {
      pos:    { x: +camera.position.x.toFixed(3), y: +camera.position.y.toFixed(3), z: +camera.position.z.toFixed(3) },
      target: { x: +controls.target.x.toFixed(3),  y: +controls.target.y.toFixed(3),  z: +controls.target.z.toFixed(3) },
    };
    const txt = JSON.stringify(data, null, 2);
    navigator.clipboard?.writeText(txt);
    console.log('Camera:', txt);
    return;
  }

  if (e.key === 'x' || e.key === 'X') {
    if (axesHelper) axesHelper.visible = !axesHelper.visible;
    if (!armBoxTunerEl) armBoxTunerEl = buildArmTuner();
    armBoxTunerEl.style.display = axesHelper && axesHelper.visible ? 'block' : 'none';
    if (stageTunerEl) stageTunerEl.style.display = 'none';
    updateArmTunerHUD();
    return;
  }

  // Toggle Stage tuner (moves arm+watch+axes together).
  if (e.key === 'g' || e.key === 'G') {
    if (!stageTunerEl) stageTunerEl = buildStageTuner();
    const showing = stageTunerEl.style.display !== 'none' && stageTunerEl.style.display !== '';
    stageTunerEl.style.display = showing ? 'none' : 'block';
    if (!showing && armBoxTunerEl) armBoxTunerEl.style.display = 'none';
    updateStageTunerHUD();
    return;
  }

  // Stage tuner (active when its panel is visible).
  if (stageTunerEl && stageTunerEl.style.display === 'block') {
    const stepP = e.shiftKey ? 0.005 : 0.03;
    const stepR = e.shiftKey ? 0.02  : 0.08;
    const stepS = e.shiftKey ? 0.01  : 0.05;
    const k = e.key.toLowerCase();
    let handled = true;
    if      (e.key === 'ArrowLeft')  STAGE_OFFSET.x -= stepP;
    else if (e.key === 'ArrowRight') STAGE_OFFSET.x += stepP;
    else if (e.key === 'ArrowUp')    STAGE_OFFSET.y += stepP;
    else if (e.key === 'ArrowDown')  STAGE_OFFSET.y -= stepP;
    else if (k === 'z')              STAGE_OFFSET.z -= stepP;
    else if (k === 'v')              STAGE_OFFSET.z += stepP;
    else if (k === 'i')              STAGE_OFFSET.rx -= stepR;
    else if (k === 'k')              STAGE_OFFSET.rx += stepR;
    else if (k === 'j')              STAGE_OFFSET.ry -= stepR;
    else if (k === 'l')              STAGE_OFFSET.ry += stepR;
    else if (k === 'u')              STAGE_OFFSET.rz -= stepR;
    else if (k === 'o')              STAGE_OFFSET.rz += stepR;
    else if (e.key === '+' || e.key === '=') STAGE_OFFSET.s += stepS;
    else if (e.key === '-' || e.key === '_') STAGE_OFFSET.s -= stepS;
    else if (k === 'r') {
      STAGE_OFFSET.x = 0.510; STAGE_OFFSET.y = 0.180; STAGE_OFFSET.z = -0.360;
      STAGE_OFFSET.rx = 0.00; STAGE_OFFSET.ry = -1.92; STAGE_OFFSET.rz = 0.00;
      STAGE_OFFSET.s = 1.35;
    } else if (k === 'c') {
      const txt = JSON.stringify(STAGE_OFFSET, null, 2);
      navigator.clipboard?.writeText(txt);
      console.log('Copied STAGE_OFFSET:', txt);
    } else handled = false;

    if (handled) {
      applyStageOffset();
      e.preventDefault();
      return;
    }
  }

  // Arm-box tuner (active only when X-axes are visible).
  if (axesHelper && axesHelper.visible) {
    const stepP = e.shiftKey ? 0.005 : 0.03;
    const stepR = e.shiftKey ? 0.02  : 0.08;
    const stepS = e.shiftKey ? 0.01  : 0.05;
    const k = e.key.toLowerCase();
    let handled = true;
    if      (e.key === 'ArrowLeft')  ARM_OFFSET.x -= stepP;
    else if (e.key === 'ArrowRight') ARM_OFFSET.x += stepP;
    else if (e.key === 'ArrowUp')    ARM_OFFSET.y += stepP;
    else if (e.key === 'ArrowDown')  ARM_OFFSET.y -= stepP;
    else if (k === 'z')              ARM_OFFSET.z -= stepP;
    else if (k === 'v')              ARM_OFFSET.z += stepP;
    else if (k === 'i')              ARM_OFFSET.rx -= stepR;
    else if (k === 'k')              ARM_OFFSET.rx += stepR;
    else if (k === 'j')              ARM_OFFSET.ry -= stepR;
    else if (k === 'l')              ARM_OFFSET.ry += stepR;
    else if (k === 'u')              ARM_OFFSET.rz -= stepR;
    else if (k === 'o')              ARM_OFFSET.rz += stepR;
    else if (e.key === '+' || e.key === '=') ARM_OFFSET.s += stepS;
    else if (e.key === '-' || e.key === '_') ARM_OFFSET.s -= stepS;
    else if (k === 'r') {
      ARM_OFFSET.x = 0.180; ARM_OFFSET.y = -0.030; ARM_OFFSET.z = -0.060;
      ARM_OFFSET.rx = 0.24; ARM_OFFSET.ry = 3.84; ARM_OFFSET.rz = -0.08;
      ARM_OFFSET.s = 0.75;
    } else if (k === 'c') {
      const txt = JSON.stringify(ARM_OFFSET, null, 2);
      navigator.clipboard?.writeText(txt);
      console.log('Copied ARM_OFFSET:', txt);
    } else handled = false;

    if (handled) {
      applyArmOffset();
      e.preventDefault();
      return;
    }
  }

  if (e.key === 't' || e.key === 'T') {
    if (!tunerEl) tunerEl = buildTuner();
    tunerEl.style.display = tunerEl.style.display === 'none' ? 'block' : 'none';
    updateTunerHUD();
    return;
  }
  if (!tunerEl || tunerEl.style.display === 'none') return;

  const stepP = e.shiftKey ? 0.005 : 0.02;   // position step (fine vs coarse)
  const stepR = e.shiftKey ? 0.02 : 0.08;    // rotation step
  const stepS = e.shiftKey ? 0.01 : 0.05;    // scale step

  const k = e.key.toLowerCase();
  if (k === 'a') WATCH_OFFSET.x -= stepP;
  else if (k === 'd') WATCH_OFFSET.x += stepP;
  else if (k === 'w') WATCH_OFFSET.y += stepP;
  else if (k === 's') WATCH_OFFSET.y -= stepP;
  else if (k === 'q') WATCH_OFFSET.z -= stepP;
  else if (k === 'e') WATCH_OFFSET.z += stepP;
  else if (k === 'i') WATCH_OFFSET.rx -= stepR;
  else if (k === 'k') WATCH_OFFSET.rx += stepR;
  else if (k === 'j') WATCH_OFFSET.ry -= stepR;
  else if (k === 'l') WATCH_OFFSET.ry += stepR;
  else if (k === 'u') WATCH_OFFSET.rz -= stepR;
  else if (k === 'o') WATCH_OFFSET.rz += stepR;
  else if (e.key === '+' || e.key === '=') WATCH_OFFSET.s += stepS;
  else if (e.key === '-' || e.key === '_') WATCH_OFFSET.s -= stepS;
  else if (k === 'r') {
    WATCH_OFFSET.x = WATCH_OFFSET.y = WATCH_OFFSET.z = 0;
    WATCH_OFFSET.rx = WATCH_OFFSET.ry = WATCH_OFFSET.rz = 0;
    WATCH_OFFSET.s = 1.0;
  } else if (k === 'c') {
    const txt = JSON.stringify(WATCH_OFFSET, null, 2);
    navigator.clipboard?.writeText(txt);
    console.log('Copied:', txt);
  } else return;

  applyWatchOffset();
});

// ============== Boot ==============
(async function boot() {
  try {
    await createSession();
    connectSocket();
    await loadModels();
    animate();
    if (new URLSearchParams(location.search).has('preview')) {
      $('btn-preview').click();
    }
  } catch (err) {
    console.error('boot error', err);
    alert('Failed to load scene: ' + err.message);
  }
})();
