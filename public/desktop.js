import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

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
  $('session-id').textContent = data.sessionId;
  $('mobile-url').textContent = data.mobileUrl;
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
camera.position.set(0, 0.05, 2.4);
camera.lookAt(0, 0, 0);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 0, 0);
controls.minDistance = 0.6;
controls.maxDistance = 6;
controls.update();

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

const armGroup = new THREE.Group();
armGroup.position.set(0, 0, 0);
armGroup.visible = false;
scene.add(armGroup);

let armRoot = null;        // GLTF arm scene root
let armPivot = null;       // intermediate node we rotate (arm orientation)
let wristNode = null;      // bone or node where watch mounts
let watchHolder = null;    // child of wristNode that holds the watch
let watchModel = null;     // current watch instance
let watchVariants = {};    // id -> Object3D (clones)
let activeWatchId = 'chrono-01';

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
  const armScale = 1.4 / armLongest;
  armRoot.scale.setScalar(armScale);

  // Center arm at origin (by bounding box) so it sits in the frame middle.
  armRoot.updateMatrixWorld(true);
  const armBox1 = new THREE.Box3().setFromObject(armRoot);
  const armCenter1 = armBox1.getCenter(new THREE.Vector3());
  armRoot.position.sub(armCenter1);

  // Pivot we rotate to follow gyroscope
  armPivot = new THREE.Group();
  armPivot.add(armRoot);
  armGroup.add(armPivot);

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

  // Define variants by recoloring clones
  const variants = [
    { id: 'chrono-01', name: 'CHRONO 01',  metalColor: 0xb8b8c2, accent: 0xb14bff },
    { id: 'noir-02',   name: 'NOIR 02',    metalColor: 0x2a2a32, accent: 0xff3da8 },
    { id: 'argent-03', name: 'ARGENT 03',  metalColor: 0xe8e8ee, accent: 0x6efcff },
    { id: 'voltage-04',name: 'VOLTAGE 04', metalColor: 0x4a3568, accent: 0xc1ff4b },
  ];
  for (const v of variants) {
    const clone = baseWatch.clone(true);
    clone.traverse((o) => {
      if (o.isMesh && o.material && o.material.isMeshStandardMaterial) {
        const m = o.material.clone();
        // crude heuristic: by name color either case (shell) or accents (dial/markers)
        const n = (o.name + ' ' + (o.material.name || '')).toLowerCase();
        if (n.match(/screen|dial|glow|emiss|index|hand|marker|led/)) {
          m.emissive = new THREE.Color(v.accent);
          m.emissiveIntensity = 0.25;
          m.color = new THREE.Color(v.accent).multiplyScalar(0.25);
        } else {
          m.color = new THREE.Color(v.metalColor);
          m.metalness = 0.7;
          m.roughness = 0.45;
        }
        o.material = m;
      }
    });
    clone.visible = false;
    watchVariants[v.id] = clone;
    watchHolder.add(clone);
  }

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
// We rotate so that tilt forward/back maps to up/down arm pitch, and yaw stays around Y.
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
  // payload = { q: [x,y,z,w] } already in quaternion form
  const q = new THREE.Quaternion(payload.q[0], payload.q[1], payload.q[2], payload.q[3]);
  if (hasCalibration) q.premultiply(calibInv);
  // remap axes to scene frame
  q.multiply(REMAP);
  // dampen extremes
  targetQuat.copy(q);
  $('hud-quat').textContent = `q: ${q.x.toFixed(2)} ${q.y.toFixed(2)} ${q.z.toFixed(2)} ${q.w.toFixed(2)}`;
}

function enterScene() {
  armGroup.visible = true;
}

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

  // Smoothly slerp current → target (cinematic delay)
  if (armPivot) {
    const followStrength = 1 - Math.pow(0.0001, dt); // exp-style smoothing
    currentQuat.slerp(targetQuat, Math.min(0.25, followStrength * 6));
    armPivot.quaternion.copy(currentQuat);
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
  x: -0.560, y: 0.100, z: -0.080,
  rx: -1.36, ry: -0.16, rz: -0.64,
  s: 0.65,
};

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
