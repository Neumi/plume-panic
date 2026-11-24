// Plume Panic: an endless runner. A work-class ROV flies along a seafloor generated at random
// for every run (a kind of seafloor, a seed). High scores and stats stay in this browser
// (local.js); nothing is sent anywhere.
// A plain script (no modules), so it also runs from a double-click on index.html; needs
// vendor/three/three.min.js, js/local.js and js/rov.js loaded before it.
(() => {
"use strict";
const THREE = window.THREE;
const { buildRov } = window.DeepRun;
const { addScore, nameLastRun, recordRun, topScores } = window.DeepRun.local;
const N = window.DeepRun.NAMES; // ROV, institute, vehicles, fleet: js/names.js (public) or names-crew.js
for (const el of document.querySelectorAll(".rov-name")) el.textContent = N.rov;

// ---------- tuning ----------
const LANES = [-4, 0, 4];
const CHUNK = 40, CHUNKS = 8, WIDTH = 84, SEG_X = 42, SEG_Z = 20; // terrain pieces (m)
const COL_STEP = 4, COL_MAX = 42; // terrain samples across the track (m)
const ALT = 2.4, ALT_UP = 6.8, ALT_DOWN = 0.85, MOVE_TIME = 0.62; // ROV above the seafloor (m), s
const V0 = 26, VMAX = 58, ACCEL = 0.006; // m/s, and m/s more per metre run
const AHEAD = 260; // things are placed this far ahead (m)
const MAGNET_S = 9, MAGNET_RANGE = 16, TURBO_S = 4.5, TURBO_X = 1.55;
const SAMPLE_CHANCE = 0.12, POWER_CHANCE = 0.07;
const DARK_AT = 3000, WRECK_AT = 12000, WRECK_EVERY = 30000; // points: the midnight zone, a wreck
const WRECK_L = 26, WRECK_H = 17; // a wreck lies across the track (m): width (flown through), deck height
// The research fleet, one of them lies on the seafloor in each wreck (js/names.js).
const FLEET = N.fleet;
const COMBO_TIME = 1.6; // s without a pickup ends a combo
// Sediment plumes (the cloud a nodule collector leaves behind): small piles in a lane; flown
// into, the water turns murky for PLUME_T s and clears over about a second after.
const PLUME_T = 2.6, PLUME_EVERY = [450, 850], PLUME_FIRST = [300, 550]; // s, m, m
const PLUME_C = new THREE.Color(0x5b4a33);
const DEV_AT = [2500, 3700]; // m: the developer runs by once, somewhere in here (as rare as Bergfest)
const EGG_AT = [1200, 2300]; // m: the egg sculpture falls once a run, somewhere in here
const RELIEF = 3.2; // typical height of the seafloor's bumps after scaling (m)
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
const $ = (id) => document.getElementById(id);
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const wall = (x) => Math.max(0, Math.abs(x) - 11) ** 1.3 * 0.28; // canyon sides frame the lanes

// ---------- seafloor: rows of heights along the track ----------
// Generated at random for each run: value noise (smooth random bumps on a grid) summed over
// a few scales, shaped by the kind of seafloor picked for the run, with a random seed. The
// relief is scaled so that its bumps are about RELIEF high, whatever the kind.
const NCOL = Math.round((2 * COL_MAX) / COL_STEP) + 1;
const KINDS = [ // scale: size of the big bumps (m); oct, rough: finer detail; ridge: sharp crests;
  // stretch: drawn out along the track; waves: sand-wave ripples; mounds: scattered hills
  { name: "Abyssal plain", scale: 95, oct: 3, rough: 0.45, ridge: 0, stretch: 1, mounds: 0.22 },
  { name: "Seamount flank", scale: 60, oct: 4, rough: 0.55, ridge: 0.6, stretch: 1 },
  { name: "Rift valley", scale: 45, oct: 4, rough: 0.5, ridge: 1, stretch: 3 },
  { name: "Sediment waves", scale: 75, oct: 3, rough: 0.4, ridge: 0, stretch: 1, waves: 1 },
  { name: "Hydrothermal field", scale: 35, oct: 5, rough: 0.6, ridge: 0.3, stretch: 1, mounds: 0.45 },
  { name: "Manganese nodule field", scale: 110, oct: 3, rough: 0.5, ridge: 0, stretch: 1.6, mounds: 0.12 },
  { name: "Canyon floor", scale: 55, oct: 4, rough: 0.5, ridge: 0.45, stretch: 2.2, waves: 0.4 },
];

/** Smooth 2D value noise in −1…1 for one seed. */
function valueNoise(seed) {
  const h = (i, j) => {
    let n = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(seed, 1597334677);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  return (x, y) => {
    const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    const a = h(i, j), b = h(i + 1, j), c = h(i, j + 1), d = h(i + 1, j + 1);
    return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 2 - 1;
  };
}

class Seafloor {
  constructor() {
    this.flat = null; // {a, b, y, ramp}: flat ground for the wreck
    this.rows = []; // rows[s - first]: Float32Array of NCOL heights (m), one row per metre
    this.first = 0;
    this.kind = pick(KINDS);
    this.seed = Math.floor(Math.random() * 2 ** 31);
    this.noise = valueNoise(this.seed);
    this.name = this.kind.name;
    this.base = 0;
    this.V = 1;
  }

  /** A new random seafloor: the relief measured along the track, scaled to RELIEF. */
  async load() {
    let sum = 0, sq = 0, n = 0;
    for (let s = 0; s < 3000; s += 2) {
      for (const x of [-8, 0, 8]) { const y = this.raw(s, x); sum += y; sq += y * y; n++; }
    }
    this.base = sum / n;
    const std = Math.sqrt(Math.max(1e-6, sq / n - this.base ** 2));
    this.V = RELIEF / std;
  }

  /** Unscaled height at distance s along the track and x across it. */
  raw(s, x) {
    const k = this.kind, nz = this.noise;
    let sum = 0, amp = 1, norm = 0, f = 1 / k.scale;
    for (let o = 0; o < k.oct; o++) {
      let v = nz((s * f) / k.stretch + o * 17.3, x * f + o * 31.7);
      if (k.ridge) v = (1 - k.ridge) * v + k.ridge * (1 - 2 * Math.abs(v));
      sum += v * amp; norm += amp;
      amp *= k.rough; f *= 2.03;
    }
    let y = sum / norm;
    if (k.waves) y += 0.45 * k.waves * Math.sin((s / k.scale) * 9 + x * 0.03 + 2.5 * nz(s / 300 + 50, x / 300));
    if (k.mounds) {
      const m = nz(s / 13 + 100, x / 13 + 100) * 0.5 + 0.5;
      if (m > 1 - k.mounds) y += ((m - (1 - k.mounds)) / k.mounds) ** 2 * 1.4;
    }
    return y * (0.7 + 0.3 * (nz(s / 700 + 300, 7.5) + 1)); // calmer and rougher stretches
  }

  row(s) {
    const out = new Float32Array(NCOL);
    for (let i = 0; i < NCOL; i++) {
      const x = -COL_MAX + i * COL_STEP;
      out[i] = (this.raw(s, x) - this.base) * this.V + wall(x);
    }
    return out;
  }

  ensure(s) {
    while (this.first + this.rows.length <= s) this.rows.push(this.row(this.first + this.rows.length));
  }

  trim(s) {
    const drop = Math.floor(s) - 120 - this.first;
    if (drop > 200) { this.rows.splice(0, drop); this.first += drop; }
  }

  /** Height (m) at distance s along the track and x across it. */
  h(s, x) {
    s = Math.max(this.first, s);
    this.ensure(Math.ceil(s) + 1);
    const i = s - this.first, i0 = Math.floor(i), fi = i - i0;
    const cx = clamp((x + COL_MAX) / COL_STEP, 0, NCOL - 1.001), c0 = Math.floor(cx), fc = cx - c0;
    const a = this.rows[i0], b = this.rows[i0 + 1] || a;
    const ra = a[c0] + (a[c0 + 1] - a[c0]) * fc, rb = b[c0] + (b[c0 + 1] - b[c0]) * fc;
    const v = ra + (rb - ra) * fi, f = this.flat;
    if (!f || s < f.a - f.ramp || s > f.b + f.ramp) return v;
    // flat under the wreck (startWreck), blending into the terrain around it
    const along = s < f.a ? 1 - (f.a - s) / f.ramp : s > f.b ? 1 - (s - f.b) / f.ramp : 1;
    const w = along * along * (3 - 2 * along);
    return v + (f.y - v) * w;
  }
}

// ---------- scene ----------
const canvas = $("view");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
// Phones drop the 3D graphics under memory pressure (other tabs, back from the background):
// pause, and let the browser give them back (three.js rebuilds everything then).
canvas.addEventListener("webglcontextlost", (e) => {
  e.preventDefault();
  setPaused(true);
  $("paused-hint").textContent = "The phone reset the 3D graphics. If the picture stays black, reload the page.";
});
canvas.addEventListener("webglcontextrestored", () => { $("paused-hint").textContent = "P / Space / tap"; });
const scene = new THREE.Scene();
const WATER = 0x05293a;
scene.background = new THREE.Color(WATER);
scene.fog = new THREE.FogExp2(WATER, 0.0095);
const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 400);
const hemi = new THREE.HemisphereLight(0x6fc3ff, 0x1a120a, 1.1);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0x9fd8ff, 0.9); // light from the surface, far above
sun.position.set(-20, 60, 10);
scene.add(sun, sun.target);

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.fov = w < h ? 75 : 62; // phones upright: see more of the lanes
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

// terrain pieces, moved ahead as the ROV passes
const terrainMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1 });
const LOW = new THREE.Color(0x24363d), HIGH = new THREE.Color(0xa8946a), SIDE = new THREE.Color(0x3a3a34);
const chunks = [];
for (let k = 0; k < CHUNKS; k++) {
  const geom = new THREE.PlaneGeometry(WIDTH, CHUNK, SEG_X, SEG_Z).rotateX(-Math.PI / 2).translate(0, 0, -CHUNK / 2);
  geom.setAttribute("color", new THREE.BufferAttribute(new Float32Array(geom.attributes.position.count * 3), 3));
  const mesh = new THREE.Mesh(geom, terrainMat);
  scene.add(mesh);
  chunks.push({ mesh, start: 0 });
}
const hash = (a, b) => { const v = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return v - Math.floor(v); };
function buildChunk(ch, floor) {
  const pos = ch.mesh.geometry.attributes.position, col = ch.mesh.geometry.attributes.color;
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), s = ch.start - pos.getZ(i);
    const y = floor.h(s, x);
    pos.setY(i, y);
    const t = clamp((y - wall(x) + RELIEF * 1.5) / (RELIEF * 3), 0, 1);
    c.copy(LOW).lerp(HIGH, t).lerp(SIDE, clamp(wall(x) / 12, 0, 0.7));
    c.multiplyScalar(0.82 + 0.3 * hash(Math.round(x), Math.round(s)));
    col.setXYZ(i, c.r, c.g, c.b);
  }
  ch.mesh.position.z = -ch.start;
  pos.needsUpdate = true; col.needsUpdate = true;
  ch.mesh.geometry.computeVertexNormals();
  ch.mesh.geometry.computeBoundingSphere();
}

// the ROV, with its lights; a shield bubble around it when there is one
const rov = buildRov();
rov.scale.setScalar(0.72);
scene.add(rov);
const shieldMesh = new THREE.Mesh(new THREE.SphereGeometry(2.3, 24, 16),
  new THREE.MeshBasicMaterial({ color: 0x4fe3ff, transparent: true, opacity: 0.18, depthWrite: false }));
rov.add(shieldMesh);
// For the midnight zone: a long-range headlamp and a glow around the ROV, off until then. They
// are in the scene from the start: adding lights later recompiles every material (a stutter).
const headlamp = new THREE.SpotLight(0xfff1c0, 0, 120, 0.5, 0.55, 1);
headlamp.position.set(0, 0.6, -1.6);
headlamp.target.position.set(0, -6, -40);
const glowLight = new THREE.PointLight(0xbfe8ff, 0, 24, 1.2);
glowLight.position.set(0, 1.6, 0);
rov.add(headlamp, headlamp.target, glowLight);
const beamMats = new Set();
rov.traverse((o) => { if (o.material?.blending === THREE.AdditiveBlending) beamMats.add(o.material); });

// marine snow: drifting specks, for the sense of speed
const SNOW = 1400;
const snowPos = new Float32Array(SNOW * 3);
for (let i = 0; i < SNOW; i++) snowPos.set([rand(-40, 40), rand(-5, 30), rand(-120, 20)], i * 3);
const snowGeom = new THREE.BufferGeometry();
snowGeom.setAttribute("position", new THREE.BufferAttribute(snowPos, 3));
const snow = new THREE.Points(snowGeom, new THREE.PointsMaterial({ color: 0xcfe9ff, size: 0.12, transparent: true, opacity: 0.7 }));
scene.add(snow);

// bubbles from the thrusters
const BUB = 70;
const bubPos = new Float32Array(BUB * 3), bubLife = new Float32Array(BUB);
const bubGeom = new THREE.BufferGeometry();
bubGeom.setAttribute("position", new THREE.BufferAttribute(bubPos, 3));
const bubbles = new THREE.Points(bubGeom, new THREE.PointsMaterial({ color: 0xe8fbff, size: 0.28, transparent: true, opacity: 0.8 }));
scene.add(bubbles);
let bubNext = 0;

// ---------- things on the track ----------
const M = {
  nodule: new THREE.MeshStandardMaterial({ color: 0xffb13b, emissive: 0xff7a00, emissiveIntensity: 0.9, flatShading: true }),
  tube: new THREE.MeshStandardMaterial({ color: 0x9ff3ff, emissive: 0x18b8e0, emissiveIntensity: 1, roughness: 0.2 }),
  cap: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x666666 }),
  magnet: new THREE.MeshStandardMaterial({ color: 0xd38cff, emissive: 0x8a2be2, emissiveIntensity: 1 }),
  shield: new THREE.MeshStandardMaterial({ color: 0x4fe3ff, emissive: 0x1aa0ff, emissiveIntensity: 1, transparent: true, opacity: 0.75 }),
  turbo: new THREE.MeshStandardMaterial({ color: 0xff5a1f, emissive: 0xff3300, emissiveIntensity: 1.3 }),
  rock: new THREE.MeshStandardMaterial({ color: 0xa39478, emissive: 0x2a2418, flatShading: true, roughness: 1 }),
  chimney: new THREE.MeshStandardMaterial({ color: 0x2a2522, flatShading: true, roughness: 1 }),
  vent: new THREE.MeshStandardMaterial({ color: 0xff5a1f, emissive: 0xff3300, emissiveIntensity: 1.5 }),
  smoke: new THREE.MeshBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.55, depthWrite: false }),
  float: new THREE.MeshStandardMaterial({ color: 0xff7a1a, emissive: 0xff5a00, emissiveIntensity: 0.6 }),
  rope: new THREE.MeshStandardMaterial({ color: 0xe8dcb0, emissive: 0x4a4430 }),
  hazard: new THREE.MeshBasicMaterial({ color: 0xff2020 }),
};
// A ghost net: thick bright meshes on a tinted, mostly opaque fill. Thin lines on a clear
// background vanished at a distance (the texture's smaller mipmaps average them away).
function netTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const x = c.getContext("2d");
  x.fillStyle = "rgba(90,150,130,0.55)";
  x.fillRect(0, 0, 64, 64);
  x.strokeStyle = "rgba(235,255,240,1)";
  x.lineWidth = 7;
  for (const i of [0, 32, 64]) {
    x.beginPath(); x.moveTo(i, 0); x.lineTo(i, 64); x.stroke();
    x.beginPath(); x.moveTo(0, i); x.lineTo(64, i); x.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 6);
  t.anisotropy = 4;
  return t;
}
const netMap = netTexture();
M.net = new THREE.MeshStandardMaterial({ map: netMap, emissiveMap: netMap, emissive: 0x6fb8a0, emissiveIntensity: 0.7,
  transparent: true, side: THREE.DoubleSide, depthWrite: false });

const NET_LOW = 1.7, NET_HIGH = 9.5; // a ghost net hangs between these heights above the seafloor
const MAKE = {
  nodule: () => new THREE.Mesh(new THREE.IcosahedronGeometry(0.42, 0), M.nodule),
  tube: () => {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 1.1, 14), M.tube);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.22, 14), M.cap);
    cap.position.y = 0.62;
    g.add(body, cap);
    g.rotation.z = 0.5;
    return g;
  },
  cucumber: () => { // a swimming sea cucumber: a bumpy green sausage with a crown of feeding tentacles
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x6fbf3a, emissive: 0x2f6a10, emissiveIntensity: 0.9, roughness: 0.6, flatShading: true });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.27, 0.95, 4, 10), mat);
    body.rotation.z = Math.PI / 2;
    g.add(body);
    const wart = new THREE.MeshStandardMaterial({ color: 0x9be05a, emissive: 0x3f8a18, emissiveIntensity: 0.9 });
    for (let k = 0; k < 14; k++) { // warts all over
      const a = rand(0, Math.PI * 2), x = rand(-0.55, 0.55);
      const w = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 4), wart);
      w.position.set(x, Math.cos(a) * 0.27, Math.sin(a) * 0.27);
      g.add(w);
    }
    for (let k = 0; k < 6; k++) { // the tentacle crown at the front
      const a = (k / 6) * Math.PI * 2;
      g.add(tube3([0.72, 0, 0], [0.92, Math.cos(a) * 0.16, Math.sin(a) * 0.16], 0.025, wart));
    }
    eyes(g, 0.08, 0.2, 0.05, 0.14); // it's a game: it gets eyes
    g.children.slice(-4).forEach((e) => { e.position.x += 0.45; });
    return g;
  },
  jar: () => { // the pickle jar for the dive report: glass, lid, seven sea cucumbers inside
    const g = new THREE.Group();
    const glass = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 2.2, 24, 1, true), new THREE.MeshStandardMaterial({ color: 0xd8fff0, emissive: 0x204a3a, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }));
    const brine = new THREE.Mesh(new THREE.CylinderGeometry(0.86, 0.86, 1.7, 24), new THREE.MeshStandardMaterial({ color: 0xc9e86a, emissive: 0x3a5010, transparent: true, opacity: 0.35, depthWrite: false }));
    brine.position.y = -0.22;
    const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.95, 0.28, 24), pmat(0xd8402a));
    lid.position.y = 1.22;
    g.add(glass, brine, lid);
    for (let k = 0; k < 7; k++) {
      const c = MAKE.cucumber();
      c.scale.setScalar(0.62);
      c.rotation.set(rand(-0.3, 0.3), (k / 7) * Math.PI * 2, Math.PI / 2 + rand(-0.25, 0.25));
      c.position.set(Math.cos(k * 2.1) * 0.45, -0.3 + (k % 2) * 0.35, Math.sin(k * 2.1) * 0.45);
      g.add(c);
    }
    return g;
  },
  magnet: () => new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.2, 10, 20, Math.PI * 1.4), M.magnet),
  shield: () => new THREE.Mesh(new THREE.IcosahedronGeometry(0.6, 1), M.shield),
  turbo: () => { // two chevrons
    const g = new THREE.Group();
    for (const z of [-0.3, 0.3]) {
      const c = new THREE.Mesh(new THREE.ConeGeometry(0.55, 0.7, 3), M.turbo);
      c.rotation.x = -Math.PI / 2;
      c.position.z = z;
      g.add(c);
    }
    return g;
  },
  rock: () => {
    const g = new THREE.Group();
    const big = new THREE.Mesh(new THREE.DodecahedronGeometry(1.3, 0), M.rock);
    big.scale.set(1.25, 0.95, 1);
    big.position.y = 0.9;
    const small = new THREE.Mesh(new THREE.DodecahedronGeometry(0.7, 0), M.rock);
    small.position.set(0.9, 0.4, 0.5);
    g.add(big, small);
    return g;
  },
  net: () => {
    const g = new THREE.Group();
    const H = NET_HIGH - NET_LOW;
    const net = new THREE.Mesh(new THREE.PlaneGeometry(3.8, H), M.net);
    net.position.y = NET_LOW + H / 2;
    g.add(net);
    const rope = (a, b) => g.add(tube3(a, b, 0.09, M.rope));
    rope([-1.9, NET_LOW, 0], [1.9, NET_LOW, 0]); // frame: the net reads as a solid barrier
    rope([-1.9, NET_HIGH, 0], [1.9, NET_HIGH, 0]);
    rope([-1.9, NET_LOW, 0], [-1.9, NET_HIGH, 0]);
    rope([1.9, NET_LOW, 0], [1.9, NET_HIGH, 0]);
    g.userData.lights = [];
    for (const x of [-1.6, -0.5, 0.6, 1.6]) {
      const f = new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 8), M.float);
      f.position.set(x, NET_HIGH + 0.25, 0);
      g.add(f);
    }
    for (const x of [-1.9, 1.9]) { // blinking hazard lights at the lower corners: seen from far away
      const l = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), M.hazard);
      l.position.set(x, NET_LOW, 0.1);
      g.add(l);
      g.userData.lights.push(l);
    }
    return g;
  },
  chimney: () => {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 1.5, 9, 9, 3), M.chimney);
    body.position.y = 4.5;
    const glow = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.12, 6, 12), M.vent);
    glow.rotation.x = Math.PI / 2;
    glow.position.y = 9;
    g.add(body, glow);
    g.userData.puffs = [];
    for (let i = 0; i < 5; i++) {
      const p = new THREE.Mesh(new THREE.SphereGeometry(0.8, 8, 6), M.smoke);
      p.userData.t = i / 5;
      g.add(p);
      g.userData.puffs.push(p);
    }
    return g;
  },
};
function tube3(a, b, r, mat) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, A.distanceTo(B), 6), mat);
  m.position.copy(A).add(B).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
  return m;
}
// ---------- science on the seafloor, the OFOS, the wreck ----------
function textTexture(w, h, draw) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 4;
  return t;
}
Object.assign(M, {
  frame: new THREE.MeshStandardMaterial({ color: 0xffc928, emissive: 0x3a2a00, roughness: 0.6 }),
  steel: new THREE.MeshStandardMaterial({ color: 0x9aa4ab, emissive: 0x15191c, metalness: 0.4, roughness: 0.5 }),
  yellow: new THREE.MeshStandardMaterial({ color: 0xffe14a, emissive: 0x6a5200, emissiveIntensity: 0.8 }),
  clear: new THREE.MeshStandardMaterial({ color: 0xd8f4ff, emissive: 0x1d3540, transparent: true, opacity: 0.55 }),
  red: new THREE.MeshStandardMaterial({ color: 0xff3b2f, emissive: 0x801010 }),
  flagMat: new THREE.MeshStandardMaterial({ color: 0xff6a00, emissive: 0x802800, side: THREE.DoubleSide }),
  strobe: new THREE.MeshBasicMaterial({ color: 0xffffff }),
  strobeOff: new THREE.MeshBasicMaterial({ color: 0x334048 }),
  wire: new THREE.MeshBasicMaterial({ color: 0x8fa3ad }),
  egg: new THREE.MeshStandardMaterial({ color: 0xfff8ea, emissive: 0x9a8f7c, metalness: 0.05, roughness: 0.15 }), // polished white sculpture, bright even down here
  eggCrack: new THREE.MeshBasicMaterial({ color: 0x120d08 }),
  porcelain: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x6a6a6a, roughness: 0.15, metalness: 0.05 }),
  niskin: new THREE.MeshStandardMaterial({ color: 0x8a9096, emissive: 0x1e2226, roughness: 0.5 }),
  pole: new THREE.MeshStandardMaterial({ color: 0xc8c8c8, emissive: 0x303030, metalness: 0.5, roughness: 0.4 }),
  labSign: new THREE.MeshBasicMaterial({ map: textTexture(512, 128, (x, w, h) => {
    x.fillStyle = "#ffffff"; x.fillRect(0, 0, w, h);
    x.fillStyle = "#173f8a"; x.font = "bold 64px system-ui, sans-serif"; x.textAlign = "center"; x.textBaseline = "middle";
    x.fillText("DEEP-SEA LAB", w / 2, h / 2 + 4);
  }) }),
  boiSign: new THREE.MeshBasicMaterial({ map: textTexture(512, 92, (x, w, h) => {
    x.fillStyle = "#ffc928"; x.fillRect(0, 0, w, h);
    x.fillStyle = "#111"; x.font = "900 60px system-ui, sans-serif"; x.textAlign = "center"; x.textBaseline = "middle";
    x.fillText("ELEVATOR BOI", w / 2, h / 2 + 3);
  }) }),
  eggShadow: new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.5, depthWrite: false }),
  amber: new THREE.MeshBasicMaterial({ color: 0xffa020 }),
  rust: new THREE.MeshStandardMaterial({ color: 0x7a4a2c, emissive: 0x1a0d06, flatShading: true, roughness: 1, side: THREE.DoubleSide }),
  hull: new THREE.MeshStandardMaterial({ color: 0x1b1b1d, emissive: 0x060607, flatShading: true, roughness: 0.8, side: THREE.DoubleSide }),
  shipRed: new THREE.MeshStandardMaterial({ color: 0xb8221a, emissive: 0x2a0604, flatShading: true, roughness: 0.8 }),
  auv: new THREE.MeshStandardMaterial({ color: 0xffc81a, emissive: 0x5a3c00, roughness: 0.4 }),
  white: new THREE.MeshStandardMaterial({ color: 0xb9b6a8, emissive: 0x16150f, flatShading: true, roughness: 0.9 }),
  container: new THREE.MeshStandardMaterial({ color: 0x2f6fb0, emissive: 0x0a1a2c, flatShading: true }),
  container2: new THREE.MeshStandardMaterial({ color: 0xb8402a, emissive: 0x2a0d08, flatShading: true }),
  gold: new THREE.MeshStandardMaterial({ color: 0xffd34d, emissive: 0xc08a00, emissiveIntensity: 1, metalness: 0.6, roughness: 0.25 }),
  bio: new THREE.MeshBasicMaterial({ color: 0x2affa0, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }),
  window: new THREE.MeshBasicMaterial({ color: 0xffd98a }),
});
const signMap = textTexture(256, 128, (x, w, h) => {
  x.fillStyle = "#ffd400"; x.fillRect(0, 0, w, h);
  x.fillStyle = "#111"; x.fillRect(6, 6, w - 12, h - 12);
  x.fillStyle = "#ffd400"; x.textAlign = "center";
  x.font = "bold 30px sans-serif"; x.fillText("⚠ EXPERIMENT", w / 2, 48);
  x.font = "bold 22px sans-serif"; x.fillText("DO NOT DISTURB", w / 2, 82);
  x.font = "16px sans-serif"; x.fillText("(yes, this means you)", w / 2, 108);
});
M.sign = new THREE.MeshBasicMaterial({ map: signMap });
// A ship's side, painted: hull colour, big lettering, the German flag, her name and home port.
// Mapped by the side wall's own coordinates (m): x along the ship, y up from the seafloor.
function sideMaterial(ship) {
  const L = ship.len;
  const map = textTexture(2048, 360, (x, w, h) => {
    const X = (m) => (m / L + 0.5) * w, Y = (m) => (1 - (m + 3) / (WRECK_H + 3)) * h;
    x.fillStyle = `#${new THREE.Color(ship.hull).getHexString()}`; x.fillRect(0, 0, w, h);
    x.fillStyle = "#e8e4d8"; x.fillRect(0, Y(WRECK_H - 0.4), w, 4); // the line below the deck
    for (let k = 0; k < 90; k++) { // rust streaks
      x.fillStyle = `rgba(${120 + Math.random() * 40},${50 + Math.random() * 20},20,${0.15 + Math.random() * 0.3})`;
      x.fillRect(Math.random() * w, Y(WRECK_H - Math.random() * 6), 2 + Math.random() * 5, 20 + Math.random() * 110);
    }
    for (let m = -L / 2 + 3; m < L / 2 - 3; m += 3.2) { // a row of portholes
      x.fillStyle = "#e8e4d8"; x.beginPath(); x.arc(X(m), Y(15), 9, 0, Math.PI * 2); x.fill();
      x.fillStyle = Math.random() < 0.25 ? "#ffd98a" : "#20262c"; x.beginPath(); x.arc(X(m), Y(15), 6, 0, Math.PI * 2); x.fill();
    }
    x.fillStyle = "#f4f1e6"; x.textAlign = "center";
    x.font = "900 150px sans-serif";
    x.fillText(ship.big || ship.name, X(-0.29 * L), Y(4.5), X(-0.1 * L) - X(-0.47 * L));
    const fx = X(0.11 * L), fw = X(0.26 * L) - fx, fy = Y(13.5), fh = Y(6.5) - fy; // the flag: black, red, gold
    x.fillStyle = "#f4f1e6"; x.fillRect(fx - 4, fy - 4, fw + 8, fh + 8);
    [["#000000", 0], ["#dd0000", 1], ["#ffce00", 2]].forEach(([c, i]) => { x.fillStyle = c; x.fillRect(fx, fy + (i * fh) / 3, fw, fh / 3 + 1); });
    x.fillStyle = "#f4f1e6";
    if (ship.big) { x.font = "900 70px sans-serif"; x.fillText(ship.name, X(0.39 * L), Y(11.5), X(0.48 * L) - X(0.29 * L)); }
    x.font = "bold 34px sans-serif";
    x.fillText(ship.port, X(0.39 * L), Y(8.6));
  });
  map.repeat.set(1 / L, 1 / (WRECK_H + 3));
  map.offset.set(0.5, 3 / (WRECK_H + 3));
  return new THREE.MeshStandardMaterial({ map, emissiveMap: map, emissive: 0xffffff, emissiveIntensity: 0.3, roughness: 0.8, side: THREE.DoubleSide });
}

// People riding along (real size, m): seated, facing +z, hips at the origin. `pose`: "sit" (legs
// over an edge, one arm waving: userData.wave) or "ride" (astride, hands on the hull in front).
const PM = {};
const pmat = (hex) => (PM[hex] ||= new THREE.MeshStandardMaterial({ color: hex, emissive: new THREE.Color(hex).multiplyScalar(0.25), roughness: 0.8 }));
function limb(g, a, b, r, hex) { g.add(tube3(a, b, r, pmat(hex))); }
// pose: "sit" (on something, waving), "ride" (astride), "stand" (hip at y 0, feet at -0.9);
// arms: null (sit: one waves), "hold" (both forward: a pole), "camera" (one on the shoulder camera, one on the lens)
function makePerson({ shirt, pants, hair = null, cap = null, hardhat = null, glasses = false, shoes = 0x222222, laces = null, pose = "sit", hull = 0.4,
  longHair = false, spikes = true, beard = null, arms = null }) {
  const g = new THREE.Group();
  const SKIN = 0xf0c8a0;
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.58, 0.24), pmat(shirt));
  torso.position.y = 0.33;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 14, 10), pmat(SKIN));
  head.position.y = 0.8;
  g.add(torso, head);
  if (hair) { // a bright tuft, a bit messy
    const h = new THREE.Mesh(new THREE.SphereGeometry(0.15, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), pmat(hair));
    h.position.set(0, 0.83, -0.015);
    h.scale.set(1.05, 1.15, 1.1);
    g.add(h);
    if (longHair) { // down to the shoulders at the back
      const back = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.44, 0.1), pmat(hair));
      back.position.set(0, 0.66, -0.1);
      g.add(back);
      for (const sx of [-1, 1]) {
        const side = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.3, 0.16), pmat(hair));
        side.position.set(sx * 0.13, 0.72, -0.02);
        g.add(side);
      }
    }
    if (spikes) for (const [x, z] of [[-0.07, 0.03], [0.05, -0.05], [0, 0.07]]) {
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.12, 6), pmat(hair));
      spike.position.set(x, 0.99, z);
      spike.rotation.set(z * 4, 0, -x * 4);
      g.add(spike);
    }
  }
  if (cap) {
    const c = new THREE.Mesh(new THREE.SphereGeometry(0.142, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), pmat(cap));
    c.position.y = 0.83;
    const brim = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.02, 0.16), pmat(cap));
    brim.position.set(0, 0.84, 0.18);
    g.add(c, brim);
  }
  if (hardhat) { // a safety helmet: a dome over the hair, a ridge on top, a brim all round
    const m = pmat(hardhat);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.165, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), m);
    dome.position.y = 0.86;
    dome.scale.set(1.05, 0.95, 1.12);
    const ridge = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.04, 0.3), m);
    ridge.position.y = 1.01;
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.205, 0.205, 0.022, 20), m);
    brim.position.set(0, 0.865, 0.02);
    brim.scale.z = 1.12;
    g.add(dome, ridge, brim);
  }
  if (beard) {
    const b = new THREE.Mesh(new THREE.SphereGeometry(0.125, 12, 8, 0, Math.PI * 2, Math.PI * 0.55, Math.PI * 0.45), pmat(beard));
    b.position.set(0, 0.79, 0.025);
    g.add(b);
  }
  if (glasses) {
    const fm = pmat(0x111111);
    for (const x of [-0.055, 0.055]) {
      const r = new THREE.Mesh(new THREE.TorusGeometry(0.038, 0.009, 6, 14), fm);
      r.position.set(x, 0.8, 0.125);
      g.add(r);
    }
    limb(g, [-0.018, 0.8, 0.128], [0.018, 0.8, 0.128], 0.007, 0x111111);
    for (const x of [-0.093, 0.093]) limb(g, [x, 0.8, 0.125], [x * 1.35, 0.81, 0.02], 0.007, 0x111111);
  }
  // legs and shoes
  for (const sx of [-1, 1]) {
    const hip = [sx * 0.11, 0.02, 0];
    // astride: legs around a hull of radius `hull` (in the person's metres), shoes showing below
    const knee = pose === "ride" ? [sx * (hull + 0.08), -0.3, 0.2] : pose === "stand" ? [sx * 0.11, -0.43, 0.03] : [sx * 0.11, 0.02, 0.42];
    const foot = pose === "ride" ? [sx * (hull + 0.1), -0.78, 0.14] : pose === "stand" ? [sx * 0.11, -0.86, 0] : [sx * 0.12, -0.42, 0.48];
    limb(g, hip, knee, 0.075, pants);
    limb(g, knee, foot, 0.065, pants);
    const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.09, 0.26), pmat(shoes));
    shoe.position.set(foot[0], foot[1] - 0.04, foot[2] + 0.07);
    g.add(shoe);
    if (laces) {
      const l = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.02, 0.13), pmat(laces));
      l.position.set(foot[0], foot[1] + 0.01, foot[2] + 0.1);
      const bow = new THREE.Mesh(new THREE.TorusGeometry(0.025, 0.009, 4, 8), pmat(laces));
      bow.position.set(foot[0], foot[1] + 0.025, foot[2] + 0.06);
      g.add(l, bow);
    }
  }
  // arms: pivots at the shoulders
  for (const sx of [-1, 1]) {
    const arm = new THREE.Group();
    arm.position.set(sx * 0.25, 0.56, 0);
    const wave = pose === "sit" && !arms && sx > 0;
    let elbow = wave ? [0.12, 0.22, 0.02] : pose === "ride" ? [sx * 0.02, -0.22, 0.2] : [sx * 0.03, -0.28, 0.05];
    let hand = wave ? [0.1, 0.48, 0.05] : pose === "ride" ? [-sx * 0.08, -0.42, 0.42] : [sx * 0.02, -0.4, 0.3];
    if (arms === "hold") { elbow = [sx * 0.04, -0.2, 0.2]; hand = [-sx * 0.12, -0.1, 0.45]; }
    if (arms === "camera") { elbow = sx > 0 ? [0.04, -0.12, 0.18] : [0.02, -0.2, 0.22]; hand = sx > 0 ? [-0.06, 0.12, 0.2] : [0.12, 0.08, 0.42]; }
    limb(arm, [0, 0, 0], elbow, 0.05, shirt);
    limb(arm, elbow, hand, 0.045, SKIN);
    g.add(arm);
    if (wave) g.userData.wave = arm;
  }
  return g;
}
const waveArm = (obj, now) => { if (obj.userData.wave) obj.userData.wave.rotation.z = -0.25 + Math.sin(now / 140) * 0.45; };

const blinkers = (g, list) => { g.userData.lights = list; return g; };
// Who rides the corer down (sometimes): a deck hand with a helmet and a beard, or a scientist with long hair.
function corerRiders(g, top) {
  const man = makePerson({ shirt: 0xff7a1a, pants: 0x2a3550, hair: 0x4a3020, spikes: false, beard: 0x4a3020, cap: 0xf2f2f2 });
  const woman = makePerson({ shirt: 0x2a9d8f, pants: 0x30343c, hair: 0xb5651d, spikes: false, longHair: true, glasses: true });
  for (const p of [man, woman]) {
    p.scale.setScalar(1.35);
    p.position.set(0, top + 0.06, 0.1);
    p.visible = false;
    g.add(p);
  }
  g.userData.riders = [man, woman];
  return g;
}
function standing(p, scale) { // a standing person on the seafloor: the hip lifted by the leg length
  p.scale.setScalar(scale);
  p.position.y = 0.92 * scale;
  return p;
}
Object.assign(MAKE, {
  lander: () => { // benthic lander: a tripod with floats on top and instruments inside
    const g = new THREE.Group();
    const top = [0, 4.6, 0];
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2 + 0.5;
      g.add(tube3([Math.cos(a) * 1.7, 0, Math.sin(a) * 1.7], top, 0.09, M.frame));
    }
    const inst = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 1.6, 12), M.steel);
    inst.position.y = 2.2;
    g.add(inst);
    for (const [x, y, z] of [[0, 5, 0], [-0.55, 4.8, 0.3], [0.55, 4.8, 0.3], [0, 4.8, -0.55], [0, 5.6, 0]]) {
      const f = new THREE.Mesh(new THREE.SphereGeometry(0.42, 12, 10), M.float);
      f.position.set(x, y, z);
      g.add(f);
    }
    const l = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 6), M.amber);
    l.position.set(0, 6.15, 0);
    g.add(l);
    return blinkers(g, [l]);
  },
  mooring: () => { // anchor, line, instruments and a big yellow float high above
    const g = new THREE.Group();
    const anchor = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.7, 1.4), M.steel);
    anchor.position.y = 0.35;
    g.add(anchor, tube3([0, 0.7, 0], [0, 17, 0], 0.07, M.rope));
    const adcp = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.9, 12), M.yellow);
    adcp.position.y = 4;
    g.add(adcp);
    for (const y of [7.5, 10.5]) {
      const f = new THREE.Mesh(new THREE.SphereGeometry(0.4, 12, 10), M.yellow);
      f.position.y = y;
      g.add(f);
    }
    const big = new THREE.Mesh(new THREE.SphereGeometry(1.2, 16, 12), M.yellow);
    big.position.y = 17.6;
    const l = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 6), M.amber);
    l.position.set(0, 4.6, 0.36);
    g.add(big, l);
    return blinkers(g, [l]);
  },
  corer: () => { // push-core site: clear tubes with red caps in a taped-off square, a little flag
    const g = new THREE.Group();
    for (const [a, b] of [[[-1.4, 0.3, -1.4], [1.4, 0.3, -1.4]], [[1.4, 0.3, -1.4], [1.4, 0.3, 1.4]], [[1.4, 0.3, 1.4], [-1.4, 0.3, 1.4]], [[-1.4, 0.3, 1.4], [-1.4, 0.3, -1.4]]]) {
      g.add(tube3(a, b, 0.05, M.flagMat));
    }
    for (let k = 0; k < 6; k++) {
      const c = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 1.2, 10), M.clear);
      c.position.set(-0.8 + (k % 3) * 0.8, 0.6, k < 3 ? -0.5 : 0.5);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.16, 10), M.red);
      cap.position.set(c.position.x, 1.25, c.position.z);
      g.add(c, cap);
    }
    g.add(tube3([1.4, 0, 1.4], [1.4, 2.2, 1.4], 0.04, M.steel));
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.5), M.flagMat);
    flag.position.set(1.8, 1.95, 1.4);
    g.add(flag);
    return g;
  },
  chamber: () => { // benthic incubation chamber: a lid with a stirrer, in a small frame
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 0.9, 18), M.clear);
    body.position.y = 0.45;
    const lid = new THREE.Mesh(new THREE.SphereGeometry(1.1, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2), M.steel);
    lid.position.y = 0.9;
    lid.scale.y = 0.5;
    g.add(body, lid, tube3([0, 1.4, 0], [0, 2.1, 0], 0.12, M.yellow));
    for (const x of [-1.5, 1.5]) g.add(tube3([x, 0, -1.3], [x, 1.6, 0], 0.07, M.frame), tube3([x, 0, 1.3], [x, 1.6, 0], 0.07, M.frame));
    g.add(tube3([-1.5, 1.6, 0], [1.5, 1.6, 0], 0.07, M.frame));
    return g;
  },
  ctd: () => { // a CTD rosette on its wire: a steel cage, 24 grey Niskin bottles, the CTD in the middle
    const g = new THREE.Group();
    const R = 1.25, Y0 = 0.2, Y1 = 2.6;
    for (const y of [Y0, Y0 + 0.5, Y1 - 0.4, Y1]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(R, 0.05, 6, 28), M.steel);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = y;
      g.add(ring);
    }
    for (let k = 0; k < 6; k++) { // the cage's posts, bent in to the lifting point
      const a = (k / 6) * Math.PI * 2;
      g.add(tube3([Math.cos(a) * R, Y0, Math.sin(a) * R], [Math.cos(a) * R, Y1, Math.sin(a) * R], 0.05, M.steel));
      g.add(tube3([Math.cos(a) * R, Y1, Math.sin(a) * R], [0, Y1 + 0.9, 0], 0.04, M.steel));
    }
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 1.25, 8), M.niskin);
      b.position.set(Math.cos(a) * 1.0, 1.45, Math.sin(a) * 1.0);
      g.add(b);
      for (const y of [0.8, 2.1]) {
        const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.06, 8), pmat(0x1a1a1a));
        cap.position.set(b.position.x, y, b.position.z);
        g.add(cap);
      }
    }
    const ctd = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 1.2, 12), M.yellow);
    ctd.position.y = 0.95;
    const pump = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.5, 10), pmat(0x2a6fdb));
    pump.position.set(0.32, 0.8, 0);
    const pylon = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.35, 12), pmat(0x30343c));
    pylon.position.y = Y1 - 0.15;
    g.add(ctd, pump, pylon, tube3([0, Y1 + 0.9, 0], [0, 90, 0], 0.05, M.wire));
    return g;
  },
  flag: () => {
    const g = new THREE.Group();
    g.add(tube3([0, 0, 0], [0, 3, 0], 0.05, M.steel));
    const f = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.7), M.flagMat);
    f.position.set(0.58, 2.6, 0);
    g.add(f);
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.4, 0.3, 8), M.steel); // weight
    w.position.y = 0.15;
    g.add(w);
    return g;
  },
  sign: () => {
    const g = new THREE.Group();
    g.add(tube3([0, 0, 0], [0, 2.4, 0], 0.07, M.steel));
    const p = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.2), M.sign);
    p.position.y = 2.6;
    g.add(p);
    return g;
  },
  ofos: () => { // Ocean Floor Observation System: a camera sled on its tow wire, strobe and all
    const g = new THREE.Group();
    const W = 1.1, H = 2.6, D = 1.4;
    for (const x of [-W, W]) for (const z of [-D, D]) g.add(tube3([x, 0, z], [x, H, z], 0.07, M.frame));
    for (const y of [0, H]) {
      g.add(tube3([-W, y, -D], [W, y, -D], 0.07, M.frame), tube3([-W, y, D], [W, y, D], 0.07, M.frame));
      g.add(tube3([-W, y, -D], [-W, y, D], 0.07, M.frame), tube3([W, y, -D], [W, y, D], 0.07, M.frame));
    }
    const cam = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 1.1, 12), M.steel);
    cam.rotation.x = Math.PI / 2;
    cam.position.set(0, 0.9, 0);
    g.add(cam);
    for (const x of [-0.6, 0, 0.6]) {
      const f = new THREE.Mesh(new THREE.SphereGeometry(0.36, 12, 10), M.yellow);
      f.position.set(x, H + 0.3, 0);
      g.add(f);
    }
    const strobe = new THREE.Mesh(new THREE.SphereGeometry(0.26, 10, 8), M.strobeOff);
    strobe.position.set(0.7, 1.6, D);
    const lamps = [];
    for (const x of [-0.6, 0.6]) {
      const l = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), M.window);
      l.position.set(x, 0.5, D);
      g.add(l);
      lamps.push(l);
    }
    g.add(strobe, tube3([0, H + 0.6, 0], [0, 120, 8], 0.07, M.wire));
    g.userData.strobe = strobe;
    const rider = makePerson({ shirt: 0x2f6b3a, pants: 0x30343c, hair: 0x2a7dff }); // sitting on top, waving
    rider.position.set(0.45, H + 0.1, D - 0.15);
    rider.scale.setScalar(1.25);
    g.add(rider);
    g.userData.wave = rider.userData.wave;
    return g;
  },
  container: () => { // three containers stacked: no way over
    const g = new THREE.Group();
    for (let k = 0; k < 3; k++) {
      const c = new THREE.Mesh(new THREE.BoxGeometry(2.6, 2.6, 6), k % 2 ? M.container2 : M.container);
      c.position.set(rand(-0.2, 0.2), 1.3 + k * 2.6, 0);
      c.rotation.y = rand(-0.12, 0.12);
      g.add(c);
    }
    return g;
  },
  crate: () => { // cargo spilled in the hold: climb over it
    const g = new THREE.Group();
    for (const [x, y, z, sx] of [[-0.8, 0.5, 0, 1.4], [0.8, 0.5, 0.2, 1.4], [0, 1.4, 0, 1.2]]) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(sx, 0.9, 1.2), M.rust);
      b.position.set(x, y, z);
      g.add(b);
    }
    return g;
  },
  girder: () => { // a fallen deck girder with a hanging plate: dive under it
    const g = new THREE.Group();
    const beam = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.9, 0.6), M.rust);
    beam.position.y = NET_LOW + 0.45;
    beam.rotation.z = 0.06;
    const plate = new THREE.Mesh(new THREE.BoxGeometry(3.8, WRECK_H - NET_LOW - 1, 0.2), M.rust);
    plate.position.y = NET_LOW + 0.9 + (WRECK_H - NET_LOW - 1) / 2;
    const l = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 6), M.hazard);
    l.position.set(0, NET_LOW + 0.2, 0.35);
    g.add(beam, plate, l);
    return blinkers(g, [l]);
  },
  boxcorer: () => { // box corer, coming down on its wire
    const g = new THREE.Group();
    for (const [x, z] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) g.add(tube3([x * 1.3, 0, z * 1.3], [x * 0.4, 3.6, z * 0.4], 0.08, M.steel));
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.1, 0.9), M.steel);
    box.position.y = 0.55;
    const spade = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 0.9, 12, 1, true, 0, Math.PI / 2), M.frame);
    spade.rotation.z = Math.PI / 2;
    spade.position.y = 1.3;
    g.add(box, spade);
    for (let k = 0; k < 4; k++) {
      const wgt = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.22, 12), M.chimney);
      wgt.position.y = 2.2 + k * 0.26;
      g.add(wgt);
    }
    g.add(tube3([0, 3.6, 0], [0, 140, 0], 0.06, M.wire));
    return corerRiders(g, 3.1);
  },
  multicorer: () => { // multicorer: a frame with eight core tubes in a ring
    const g = new THREE.Group();
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
      g.add(tube3([Math.cos(a) * 1.8, 0, Math.sin(a) * 1.8], [Math.cos(a) * 0.5, 3.9, Math.sin(a) * 0.5], 0.08, M.frame));
    }
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.75, 0.06, 6, 24), M.steel);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 1.5;
    g.add(ring);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const t = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 1.3, 10), M.clear);
      t.position.set(Math.cos(a) * 0.75, 1.1, Math.sin(a) * 0.75);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.1, 10), M.red);
      cap.position.set(t.position.x, 1.8, t.position.z);
      g.add(t, cap);
    }
    const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 1.2, 12), M.chimney);
    stack.position.y = 2.6;
    g.add(stack, tube3([0, 3.9, 0], [0, 140, 0], 0.06, M.wire));
    return corerRiders(g, 3.2);
  },
  hut: () => { // a little seafloor lab, all blue, with instruments bolted on everywhere
    const g = new THREE.Group();
    const BLUE = 0x2a6fdb, DARK = 0x173f8a;
    const walls = new THREE.Mesh(new THREE.BoxGeometry(3, 2.2, 2.4), pmat(BLUE));
    walls.position.y = 1.1;
    const roofShape = new THREE.Shape([new THREE.Vector2(-1.75, 0), new THREE.Vector2(1.75, 0), new THREE.Vector2(0, 1.3)]);
    const roof = new THREE.Mesh(new THREE.ExtrudeGeometry(roofShape, { depth: 2.8, bevelEnabled: false }), pmat(DARK));
    roof.position.set(0, 2.2, -1.4);
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.75, 1.5, 0.06), pmat(DARK));
    door.position.set(-0.6, 0.75, 1.22);
    const win = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.55, 0.06), new THREE.MeshBasicMaterial({ color: 0xbfe6ff }));
    win.position.set(0.7, 1.35, 1.22);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.38), M.labSign);
    sign.position.set(0, 1.95, 1.231);
    g.add(walls, roof, door, win, sign);
    // on the roof: floats, an acoustic modem, a mast with a current meter (propeller) and a blinking lamp
    for (const x of [-0.9, 0.9]) {
      const f = new THREE.Mesh(new THREE.SphereGeometry(0.32, 12, 8), M.yellow);
      f.position.set(x, 3.0, 0.2);
      g.add(f);
    }
    const modem = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.6, 10), pmat(0xffc928));
    modem.position.set(0, 3.7, 0.3);
    g.add(modem, tube3([1.2, 2.5, -0.7], [1.2, 4.6, -0.7], 0.04, M.steel));
    const prop = new THREE.Group();
    for (let k = 0; k < 3; k++) {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.32, 0.02), pmat(0xf2f2f2));
      blade.position.y = 0.16;
      const arm = new THREE.Group();
      arm.rotation.z = (k / 3) * Math.PI * 2;
      arm.add(blade);
      prop.add(arm);
    }
    prop.position.set(1.2, 4.3, -0.62);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), M.hazard);
    lamp.position.set(1.2, 4.65, -0.7);
    g.add(prop, lamp);
    // on the front: a camera with a light, an ADCP (four heads), sensors strapped on, a cable to the seafloor
    const cam = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.25, 0.4), pmat(0x1c1c1c));
    cam.position.set(1.25, 2.0, 1.4);
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.12, 10), pmat(0x3a6aa0));
    lens.rotation.x = Math.PI / 2;
    lens.position.set(1.25, 2.0, 1.65);
    const light = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), new THREE.MeshBasicMaterial({ color: 0xfff2c0 }));
    light.position.set(0.9, 2.05, 1.5);
    g.add(cam, lens, light);
    const adcp = new THREE.Group();
    adcp.add(new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.4, 12), pmat(0xffc928)));
    for (let k = 0; k < 4; k++) {
      const head = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.12, 8), pmat(0x1c1c1c));
      head.position.set(Math.cos((k * Math.PI) / 2) * 0.12, 0.24, Math.sin((k * Math.PI) / 2) * 0.12);
      adcp.add(head);
    }
    adcp.position.set(-1.25, 2.45, 1.0);
    g.add(adcp);
    for (const [x, y, c] of [[-1.53, 1.2, 0xff6a1a], [-1.53, 0.6, 0xf2f2f2], [1.53, 1.0, 0x7dff9a]]) { // sensor bottles on the sides
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.7, 10), pmat(c));
      b.rotation.z = Math.PI / 2;
      b.rotation.y = Math.PI / 2;
      b.position.set(x, y, 0.2);
      g.add(b);
    }
    g.add(tube3([1.5, 0.3, 0.6], [2.6, 0.03, 1.8], 0.04, pmat(0x111111))); // the cable out
    for (let k = 0; k < 5; k++) { // a thermistor chain on a float, beside the hut
      const bead = new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 4), pmat(0xff3b2f));
      bead.position.set(-2.0, 0.6 + k * 0.6, -0.4);
      g.add(bead);
    }
    const top = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), M.yellow);
    top.position.set(-2.0, 3.7, -0.4);
    g.add(top, tube3([-2.0, 0, -0.4], [-2.0, 3.6, -0.4], 0.015, M.wire));
    g.userData.anim = (now) => { prop.rotation.z = now / 120; };
    g.scale.setScalar(0.62); // a little lab
    return blinkers(g, [lamp]);
  },
  toilet: () => { // a toilet on the seafloor (a long-term experiment, they say)
    const g = new THREE.Group();
    const bowl = new THREE.Mesh(new THREE.LatheGeometry([[0.22, 0], [0.24, 0.25], [0.3, 0.4], [0.36, 0.5], [0.3, 0.5], [0.12, 0.3]].map(([x, y]) => new THREE.Vector2(x, y)), 20), M.porcelain);
    bowl.scale.z = 1.25;
    const seat = new THREE.Mesh(new THREE.TorusGeometry(0.31, 0.04, 6, 20), pmat(0xf4f4f4));
    seat.rotation.x = Math.PI / 2;
    seat.scale.y = 1.25;
    seat.position.y = 0.53;
    const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.03, 20), pmat(0xf4f4f4));
    lid.scale.z = 1.2;
    lid.rotation.x = -1.35; // open, leaning on the tank
    lid.position.set(0, 0.92, -0.44);
    const tank = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.55, 0.22), M.porcelain);
    tank.position.set(0, 0.86, -0.5);
    const button = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.03, 12), M.steel);
    button.position.set(0, 1.15, -0.5);
    const roll = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.12, 14), pmat(0xffffff));
    roll.rotation.z = Math.PI / 2;
    roll.position.set(0.55, 0.6, -0.1);
    g.add(bowl, seat, lid, tank, button, roll, tube3([0.55, 0, -0.1], [0.55, 0.6, -0.1], 0.02, M.steel));
    g.scale.setScalar(2.4); // bigger than life, so it's seen
    return g;
  },
  hooks: () => { // two of the deck crew with long boat hooks, facing the track (+z)
    const g = new THREE.Group();
    const poles = [];
    for (const [x, look] of [[-1.4, { shirt: 0xff7a1a, hair: 0x2a2a2a, cap: 0xffd400, beard: 0x2a2a2a }], [1.4, { shirt: 0xff7a1a, hair: 0xe0c070, cap: 0xf2f2f2, longHair: true }]]) {
      const p = standing(makePerson({ pants: 0x2a3550, spikes: false, pose: "stand", arms: "hold", shoes: 0x4a2a10, ...look }), 1.7);
      p.position.x = x;
      g.add(p);
      const pivot = new THREE.Group(); // at the hands; rotation.x: raised (−) or lowered towards the ROV
      pivot.position.set(x, 0.92 * 1.7 + 0.45 * 1.7 - 0.05, 0.77);
      pivot.add(tube3([0, 0, -1.2], [0, 0, 8.9], 0.06, M.pole));
      const hook = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.06, 6, 14, Math.PI * 1.3), M.steel);
      hook.rotation.y = Math.PI / 2;
      hook.position.set(0, -0.3, 8.9);
      pivot.add(hook);
      pivot.rotation.x = -0.9;
      g.add(pivot);
      poles.push(pivot);
    }
    g.userData.poles = poles;
    return g;
  },
  plume: () => { // a small pile of stirred-up sediment: soft brown puffs, slowly billowing
    const g = new THREE.Group();
    // light tan, a little self-lit so it reads as a cloud in the murk, not as a boulder
    const mat = new THREE.MeshStandardMaterial({ color: 0xc9b08a, emissive: 0x4a3b26, roughness: 1, transparent: true, opacity: 0.42, depthWrite: false });
    const puffs = [];
    for (let i = 0; i < 16; i++) {
      const r = rand(0.6, 1.5);
      const puff = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 2), mat);
      puff.position.set(rand(-1.9, 1.9), r * 0.5 + rand(0, 2.2) * (1 - Math.abs(i % 4 - 1.5) / 3), rand(-1.8, 1.8));
      puff.userData.base = puff.position.clone();
      puff.userData.k = rand(0, 6);
      puffs.push(puff);
      g.add(puff);
    }
    g.userData.anim = (now) => {
      for (const p of puffs) {
        const k = p.userData.k + now / 1400;
        p.position.set(p.userData.base.x + Math.sin(k) * 0.25, p.userData.base.y + Math.sin(k * 0.7) * 0.2, p.userData.base.z + Math.cos(k) * 0.25);
        p.scale.setScalar(1 + Math.sin(k * 1.3) * 0.12);
      }
    };
    return g;
  },
  camwoman: () => { // a camerawoman in an orange hard hat, shoulder camera with a red REC light, filming the ROV
    const g = new THREE.Group();
    const p = standing(makePerson({ shirt: 0x6a2c8a, pants: 0x1f2633, hair: 0x1a1a1a, spikes: false, longHair: true, hardhat: 0xff7a1a, pose: "stand", arms: "camera", shoes: 0xf2f2f2 }), 1.7);
    g.add(p);
    const cam = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.22, 0.5), pmat(0x1c1c1c));
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.22, 12), pmat(0x0d0d0d));
    lens.rotation.x = Math.PI / 2;
    lens.position.z = 0.34;
    const glass = new THREE.Mesh(new THREE.CircleGeometry(0.075, 12), new THREE.MeshBasicMaterial({ color: 0x3a6aa0 }));
    glass.position.z = 0.451;
    const rec = new THREE.Mesh(new THREE.SphereGeometry(0.03, 6, 4), M.hazard);
    rec.position.set(0, 0.12, 0.2);
    const mic = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.25, 6), pmat(0x444444));
    mic.rotation.x = Math.PI / 2;
    mic.position.set(0.06, 0.14, 0.18);
    cam.add(body, lens, glass, rec, mic);
    cam.position.set(0.16 * 1.7, (0.92 + 0.68) * 1.7, 0.1 * 1.7); // on her right shoulder
    cam.scale.setScalar(1.7);
    g.add(cam);
    g.userData.person = p;
    return blinkers(g, [rec]);
  },
  egg: () => { // a giant egg sculpture, about a lane wide: it falls from above and cracks on landing
    const g = new THREE.Group();
    const a = 2.5, R = 1.8, pts = [];
    for (let i = 0; i <= 24; i++) { // egg profile: fuller at the bottom
      const t = (i / 24) * Math.PI;
      pts.push(new THREE.Vector2(Math.max(0.001, Math.sin(t) * R * (1 + 0.1 * Math.cos(t))), a - Math.cos(t) * a));
    }
    const egg = new THREE.Mesh(new THREE.LatheGeometry(pts, 32), M.egg);
    egg.castShadow = true;
    g.add(egg);
    // cracks: a zigzag around the shell, shown once it has landed
    const crack = [];
    let y = 1.6;
    for (let k = 0; k <= 18; k++) {
      const ang = (k / 18) * Math.PI * 1.3 - 0.5, yy = y + (k % 2 ? 0.35 : -0.25) + Math.sin(k) * 0.2;
      const r = R * 1.005 * Math.sin(Math.acos(1 - yy / a)) * (1 + 0.1 * (1 - yy / a));
      crack.push(new THREE.Vector3(Math.sin(ang) * r, yy, Math.cos(ang) * r));
    }
    const groove = (p) => new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(p, false, "catmullrom", 0.1), 60, 0.07, 5), M.eggCrack);
    const branch = crack.slice(6, 11).map((p, i) => { // a second crack, up from the first
      const yy = p.y + 0.3 + i * 0.25, r = R * 1.01 * Math.sin(Math.acos(1 - yy / a)) * (1 + 0.1 * (1 - yy / a)), ang = Math.atan2(p.x, p.z) + (i % 2 ? 0.08 : -0.08);
      return new THREE.Vector3(Math.sin(ang) * r, yy, Math.cos(ang) * r);
    });
    const crackG = new THREE.Group();
    crackG.add(groove(crack), groove(branch));
    crackG.visible = false;
    // its shadow on the seafloor while it falls: the warning
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(R, 24), M.eggShadow);
    shadow.rotation.x = -Math.PI / 2;
    shadow.visible = false;
    g.add(crackG, shadow);
    g.userData.crack = crackG;
    g.userData.shadow = shadow;
    g.userData.egg = egg;
    return g;
  },
  bell: () => { // the ship's bell
    const g = new THREE.Group();
    const pts = [[0, 0], [0.75, 0], [0.7, 0.15], [0.5, 0.5], [0.45, 1], [0.3, 1.2], [0, 1.25]].map(([x, y]) => new THREE.Vector2(x, y));
    const b = new THREE.Mesh(new THREE.LatheGeometry(pts, 20), M.gold);
    b.position.y = -0.6;
    g.add(b);
    return g;
  },
});
const VALUE = { nodule: 10, tube: 50, bell: 500, cake: 100, coffee: 50, cucumber: 25 };
const JAR = 7, JAR_BONUS = 1000; // sea cucumbers in a full pickle jar; its bonus
const POWERS = new Set(["magnet", "shield", "turbo"]);
const OVER = new Set(["rock", "corer", "chamber", "crate"]); // climb over these
const UNDER = new Set(["net", "girder"]); // dive under these
const BLOCK = new Set(["chimney", "lander", "mooring", "container", "ofos", "boxcorer", "multicorer", "egg"]); // change lanes
const DROPS = new Set(["boxcorer", "multicorer", "egg"]); // come down from above as the ROV gets close
const REACH = { container: 3.3, ofos: 2.2, lander: 1.9, egg: 1.9 }; // how far along the track they reach (m); else 1.4
const HEIGHT = { egg: 5 }; // blocking things: the ROV only gets over them this high up; else 4
const COLOR = { nodule: 0xffb13b, cucumber: 0x7ccf3a, tube: 0x4fe3ff, bell: 0xffd34d, magnet: 0xd38cff, shield: 0x4fe3ff, turbo: 0xff5a1f, rock: 0xc9b48a,
  net: 0xbfe0d0, chimney: 0xff5a1f, lander: 0xffc928, mooring: 0xffe14a, corer: 0xff3b2f, chamber: 0x9aa4ab, ofos: 0xffc928,
  container: 0x2f6fb0, crate: 0x7a4a2c, girder: 0x7a4a2c, boxcorer: 0x9aa4ab, multicorer: 0xffc928, egg: 0xf6efe2 };
const WHY = {
  rock: "You hit a boulder: ↑ climbs over them.",
  net: "Tangled in a ghost net: ↓ dives under them.",
  chimney: "You flew into a black smoker: change lanes.",
  lander: "You hit a benthic lander. Six months of data: gone.",
  mooring: "You snagged a mooring. The physical oceanographers would like a word.",
  corer: "You ploughed through a push-core site: ↑ climbs over experiments.",
  chamber: "You flattened a benthic chamber: ↑ climbs over experiments.",
  ofos: "You rammed the OFOS. The whole ship watched it on the live feed.",
  container: "You hit a stack of containers inside the wreck: change lanes.",
  crate: "You hit cargo in the hold: ↑ climbs over it.",
  girder: "You hit a fallen girder: ↓ dives under them.",
  boxcorer: "The box corer came down on you. Nice sample, though.",
  multicorer: "You got multicored. Eight tubes of ROV.",
  egg: "A giant egg sculpture fell on you. Who ordered that?!",
};
const pool = {};
const things = []; // {type, s, x, alt, obj, gone, pop, passed}
function place(type, s, x, alt = 0, decor = false) {
  const obj = (pool[type] ||= []).pop() || MAKE[type]();
  obj.visible = true;
  obj.scale.setScalar(1);
  obj.rotation.set(0, decor ? -Math.sign(x) * rand(0.2, 0.6) : 0, 0);
  if (!obj.parent) scene.add(obj);
  const t = { type, s, x, alt, obj, gone: false, pop: 0, passed: false, decor };
  things.push(t);
  return t;
}
function release(t) {
  t.gone = true;
  t.obj.visible = false;
  pool[t.type].push(t.obj);
}

// ---------- spawning patterns ----------
let nextSpawn = 0;
function coinLine(s, lane, n, altFn = () => ALT) {
  for (let i = 0; i < n; i++) place("nodule", s + i * 3.6, LANES[lane], altFn(i));
}
function coinZigzag(s, n) { // nodules weaving across the lanes: chase them
  let lane = Math.floor(Math.random() * 3);
  for (let i = 0; i < n; i++) {
    if (i % 3 === 2) lane = clamp(lane + pick([-1, 1]), 0, 2);
    place("nodule", s + i * 3.6, LANES[lane], ALT);
  }
}
function spawnRow(s, speed) {
  const r = Math.random();
  if (g.s > 250 && r < 0.035) { // the camerawoman, right in a lane: flies you head over heels, −100 points, no crash
    const lane = Math.floor(Math.random() * 3);
    place("camwoman", s, LANES[lane]);
    coinLine(s - 14, (lane + 1 + Math.floor(Math.random() * 2)) % 3, 6);
    return;
  }
  const hard = clamp((speed - V0) / (VMAX - V0), 0, 1);
  if (r < 0.12) {
    const lane = Math.floor(Math.random() * 3), n = 8 + Math.floor(Math.random() * 5);
    const cuke = Math.random() < 0.25; // sometimes the line ends in a sea cucumber
    coinLine(s, lane, cuke ? n - 1 : n);
    if (cuke) place("cucumber", s + (n - 1) * 3.6, LANES[lane], ALT);
  }
  else if (r < 0.2) coinZigzag(s, 12);
  else {
    // obstacles in 1 or 2 lanes (3 at speed, with one passable), nodules in a free lane or over a rock
    const lanes = [0, 1, 2].sort(() => Math.random() - 0.5);
    const ofos = things.some((t) => !t.gone && t.type === "ofos"); // it drifts across lanes: keep room
    const n = ofos ? 1 : Math.random() < 0.45 + hard * 0.35 ? (Math.random() < 0.15 + hard * 0.45 ? 3 : 2) : 1;
    const kinds = [];
    for (let i = 0; i < n; i++) kinds.push(pick(["rock", "rock", "net", "net", "chimney", "lander", "mooring", "corer", "chamber", "boxcorer", "multicorer"]));
    if (n === 3) { // one lane must stay passable: at most one that blocks it all
      let blocks = 0;
      kinds.forEach((k, i) => { if (BLOCK.has(k) && blocks++) kinds[i] = pick(["rock", "net", "corer"]); });
    }
    lanes.slice(0, n).forEach((lane, i) => {
      const t = place(kinds[i], s, LANES[lane]);
      if (!DROPS.has(kinds[i])) return;
      if (kinds[i] !== "egg") placeCorer(t);
      t.alt = kinds[i] === "egg" ? 45 : 30;
      if (kinds[i] === "egg") { // falls freely (faster and faster), tumbling a little
        const u = t.obj.userData;
        u.crack.visible = false;
        u.shadow.visible = true;
        u.egg.rotation.set(rand(-0.5, 0.5), 0, rand(-0.5, 0.5));
        t.vy = 6;
      }
    });
    const free = lanes.slice(n);
    const fr = Math.random();
    if (free.length && fr < 0.2) place("cucumber", s - 12, LANES[free[0]], ALT); // a sea cucumber for the jar, instead of nodules
    else if (free.length && fr < 0.8) coinLine(s - 18, free[0], 7);
    const rockLane = lanes.slice(0, n).find((_, i) => OVER.has(kinds[i]));
    if (rockLane != null && Math.random() < 0.7) { // an arc over the boulder: reward the climb
      coinLine(s - 7.2, rockLane, 5, (i) => ALT + Math.sin((i / 4) * Math.PI) * (ALT_UP - ALT));
    }
    const netLane = lanes.slice(0, n).find((_, i) => kinds[i] === "net");
    if (netLane != null && Math.random() < 0.6) coinLine(s - 3.6, netLane, 3, () => ALT_DOWN); // low under the net
  }
  if (Math.random() < SAMPLE_CHANCE) place("tube", s + 12, LANES[Math.floor(Math.random() * 3)], ALT + (Math.random() < 0.4 ? ALT_UP - ALT : 0));
  if (Math.random() < POWER_CHANCE) place(pick(["magnet", "shield", "turbo", "turbo"]), s + 18, LANES[Math.floor(Math.random() * 3)], ALT);
}

let nextDecor = 0;
function spawnDecor(s) { // experiments (and creatures) beside the track: just for looks
  if (Math.random() < 0.42) { spawnCreature(s); return; }
  const side = Math.random() < 0.5 ? -1 : 1;
  const type = Math.random() < 0.012 ? "toilet" // rare: that's what makes it funny
    : pick(["lander", "mooring", "ctd", "flag", "sign", "corer", "chamber", "hut", "camwoman", "tyre", "anchor", "barrel", "barrel", "glassfloat"]);
  const t = place(type, s, side * (type === "camwoman" ? rand(8.5, 10) : rand(12.5, 17)), type === "ctd" ? rand(0.3, 3) : 0, true);
  if (type === "hut" || type === "toilet") t.obj.rotation.y = -side * rand(0.5, 1.1); // turned to the track
}
const SIGHTS = { toilet: ["Pilot: Is that… a toilet? At 4,000 m?", "Chief scientist: Leave it. Long-term experiment.", "Biologist: Occupied. By a sea cucumber."],
  hut: ["Pilot: Someone built a lab down here?", "Bridge: The deep-sea lab. Rent is cheap, commute is long.", "Chief scientist: That's where the PhD students live."] };
function faceRov(obj) { obj.rotation.y = Math.atan2(rov.position.x - obj.position.x, rov.position.z - obj.position.z); }
function placeCorer(t) { // sometimes someone rides it down: a deck hand or a scientist
  const u = t.obj.userData, who = Math.random() < 0.4 ? (Math.random() < 0.5 ? 0 : 1) : -1;
  u.riders.forEach((r, i) => { r.visible = i === who; });
  u.wave = who >= 0 ? u.riders[who].userData.wave : null;
  t.rider = who;
}

// A wreck lying across the track: the ROV flies in through a hole in her side and out through
// another. Each ship is built once, then moved to where she lies; the seafloor is flattened under
// her (Seafloor.flat). Local z: 0 = the side flown into (at s0), -WRECK_L = the far side.
const wrecks = {}; // name → built group
function sideWall(L, mats) { // the hull's side, with a ragged hole over all three lanes
  const outer = new THREE.Shape([[-L / 2, -3], [L / 2, -3], [L / 2, WRECK_H], [-L / 2, WRECK_H]].map(([x, y]) => new THREE.Vector2(x, y)));
  const hole = [];
  for (let k = 0; k < 40; k++) { // a squarish ellipse, torn: at least ±8.6 m wide at the ROV's heights
    const a = (k / 40) * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a);
    const r = 1 / (c ** 4 + sn ** 4) ** 0.25 + rand(0, 0.14);
    hole.push(new THREE.Vector2(c * r * 9, 4.5 + sn * r * 7));
  }
  outer.holes.push(new THREE.Path(hole));
  return new THREE.Mesh(new THREE.ExtrudeGeometry(outer, { depth: 0.6, bevelEnabled: false }), mats);
}
function buildWreck(ship) {
  const L = ship.len, w = new THREE.Group();
  const hullM = M.hull.clone();
  hullM.color.setHex(ship.hull);
  hullM.emissive.setHex(ship.hull).multiplyScalar(0.25);
  const houseM = M.shipRed.clone();
  houseM.color.setHex(ship.house);
  houseM.emissive.setHex(ship.house).multiplyScalar(0.12);
  const near = sideWall(L, [sideMaterial(ship), hullM]);
  near.position.z = -0.6;
  const far = sideWall(L, hullM);
  far.position.z = -WRECK_L;
  w.add(near, far);
  const deck = new THREE.Mesh(new THREE.BoxGeometry(L, 0.6, WRECK_L), hullM);
  deck.position.set(0, WRECK_H + 0.3, -WRECK_L / 2);
  const stern = new THREE.Mesh(new THREE.BoxGeometry(0.6, WRECK_H + 3, WRECK_L), hullM);
  stern.position.set(-L / 2, WRECK_H / 2 - 1.5, -WRECK_L / 2);
  w.add(deck, stern);
  const bowL = Math.hypot(16, WRECK_L / 2);
  for (const sgn of [1, -1]) { // the bow: two plates meeting in a point
    const b = new THREE.Mesh(new THREE.BoxGeometry(bowL, WRECK_H + 3, 0.6), hullM);
    b.position.set(L / 2 + 8, WRECK_H / 2 - 1.5, -WRECK_L / 2 + sgn * WRECK_L / 4);
    b.rotation.y = sgn * Math.atan2(WRECK_L / 2, 16);
    w.add(b);
  }
  // superstructure: deckhouse, bridge with windows, funnel; the A-frame at the stern
  const house = new THREE.Mesh(new THREE.BoxGeometry(L * 0.31, 9, WRECK_L - 4), houseM);
  house.position.set(L * 0.21, WRECK_H + 5, -WRECK_L / 2);
  const bridge = new THREE.Mesh(new THREE.BoxGeometry(L * 0.19, 4.5, WRECK_L - 2), houseM);
  bridge.position.set(L * 0.26, WRECK_H + 11.5, -WRECK_L / 2);
  const funnel = new THREE.Mesh(new THREE.BoxGeometry(6, 9, 7), pmat(ship.funnel));
  funnel.position.set(L * 0.05, WRECK_H + 9, -WRECK_L / 2);
  funnel.rotation.z = 0.1;
  const top = new THREE.Mesh(new THREE.BoxGeometry(6.2, 1.2, 7.2), M.hull);
  top.position.set(L * 0.05 + 0.4, WRECK_H + 13.6, -WRECK_L / 2);
  top.rotation.z = 0.1;
  w.add(house, bridge, funnel, top);
  for (let x = L * 0.17; x <= L * 0.35; x += 1.8) {
    const win = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.4), Math.random() < 0.35 ? M.window : M.strobeOff);
    win.position.set(x, WRECK_H + 12, -0.95);
    w.add(win);
  }
  for (const z of [-4, -WRECK_L + 4]) w.add(tube3([-L / 2 + 2, WRECK_H, z], [-L / 2 - 3, WRECK_H + 12, z], 0.5, M.frame));
  w.add(tube3([-L / 2 - 3, WRECK_H + 12, -4], [-L / 2 - 3, WRECK_H + 12, -WRECK_L + 4], 0.55, M.frame));
  w.add(tube3([-L * 0.09, WRECK_H, -WRECK_L / 2], [-L * 0.09, WRECK_H + 16, -WRECK_L / 2], 0.35, houseM)); // mast
  // deck lights still on (it's a game); inside: frames, beams, glowing life, cargo off the lanes
  for (let x = -L / 2 + 4; x < L / 2; x += 10) {
    const l = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 6), M.window);
    l.position.set(x, WRECK_H + 0.8, 0.3);
    w.add(l);
  }
  const inner = L / 2 - 6;
  for (let x = -Math.floor(inner / 7) * 7; x <= inner; x += 7) {
    if (Math.abs(x) < 10) continue;
    for (const z of [-1, -WRECK_L + 1]) {
      const r = new THREE.Mesh(new THREE.BoxGeometry(0.5, WRECK_H + 2, 0.5), M.rust);
      r.position.set(x, WRECK_H / 2 - 1, z);
      w.add(r);
    }
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.7, WRECK_L), M.rust);
    b.position.set(x, WRECK_H - 0.5, -WRECK_L / 2);
    w.add(b);
  }
  for (let k = 0; k < L / 2; k++) {
    const b = new THREE.Mesh(new THREE.CircleGeometry(rand(0.3, 0.9), 10), M.bio);
    const nearSide = Math.random() < 0.5;
    let x = rand(-inner, inner);
    if (Math.abs(x) < 11) x += Math.sign(x || 1) * 11;
    b.position.set(x, rand(1, WRECK_H - 2), nearSide ? -0.65 : -WRECK_L + 0.05);
    b.rotation.y = nearSide ? Math.PI : 0;
    w.add(b);
  }
  for (const x of [-30, -21, 17, 26, 35]) {
    if (Math.abs(x) > inner - 3) continue;
    const c = new THREE.Mesh(new THREE.BoxGeometry(6, 2.6, 2.6), Math.random() < 0.5 ? M.container : M.container2);
    c.position.set(x, 1.3, -rand(5, WRECK_L - 5));
    c.rotation.y = rand(-0.4, 0.4);
    w.add(c);
  }
  detailShip(w, ship, L, houseM);
  scene.add(w);
  return w;
}
function startWreck() { // somewhere ahead that has no terrain or things yet
  const end = Math.max(...chunks.map((c) => c.start + CHUNK));
  const s0 = Math.ceil(Math.max(end, nextSpawn) + 90);
  let sum = 0;
  for (let s = s0; s <= s0 + WRECK_L; s += 2) sum += g.floor.h(s, 0);
  const y = sum / (WRECK_L / 2 + 1);
  g.floor.flat = { a: s0 - 10, b: s0 + WRECK_L + 10, y, ramp: 35 };
  const ship = pick(FLEET.filter((f) => f.name !== g.lastShip)); // a different one each time
  g.lastShip = ship.name;
  const obj = (wrecks[ship.name] ||= buildWreck(ship));
  obj.visible = true;
  obj.position.set(0, y, -s0);
  g.wreck = { s0, y, ship, obj, spawned: false, said: 0, done: false };
}
function spawnWreck(w) { // in the hold: one row of cargo, the ship's bell in the free lane
  const lanes = [0, 1, 2].sort(() => Math.random() - 0.5);
  const kinds = [pick(["container", "crate", "girder"]), pick(["crate", "girder"])];
  kinds.forEach((k, i) => place(k, w.s0 + WRECK_L / 2, LANES[lanes[i]]));
  coinLine(w.s0 - 22, lanes[2], 5);
  place("bell", w.s0 + WRECK_L / 2, LANES[lanes[2]], ALT);
}

// ---------- fly-bys: the AUV and an OFOS cross the track, photographing the seafloor ----------
const auvMap = textTexture(512, 128, (x, w, h) => {
  x.clearRect(0, 0, w, h);
  x.fillStyle = "#111"; x.textAlign = "center";
  x.font = "900 76px sans-serif"; x.fillText(N.auv.toUpperCase(), w / 2, 74, w - 24);
  x.fillStyle = "#0b2a6b"; x.font = "bold 30px sans-serif"; x.fillText(N.institute, w / 2, 114, w - 24);
});
const crackMap = textTexture(256, 128, (x, w, h) => { // a big ugly crack, with branches
  x.clearRect(0, 0, w, h);
  const line = (pts, wd) => {
    x.lineJoin = "miter";
    x.strokeStyle = "#3a1c08"; x.lineWidth = wd + 5; x.beginPath(); pts.forEach(([a, b], i) => (i ? x.lineTo(a, b) : x.moveTo(a, b))); x.stroke();
    x.strokeStyle = "#000"; x.lineWidth = wd; x.stroke();
  };
  const main = [[6, 70]];
  for (let px = 6; px < 250;) { px += rand(14, 28); main.push([px, 64 + rand(-30, 30)]); }
  line(main, 7);
  for (let k = 0; k < 5; k++) {
    let [a, b] = pick(main.slice(1, -1));
    const br = [[a, b]];
    for (let i = 0; i < 3; i++) { a += rand(-20, 20); b += rand(10, 22) * (k % 2 ? 1 : -1); br.push([a, b]); }
    line(br, 3);
  }
});
M.auvLabel = new THREE.MeshBasicMaterial({ map: auvMap, transparent: true, depthWrite: false });
M.crack = new THREE.MeshBasicMaterial({ map: crackMap, transparent: true, depthWrite: false });
const beamMat = new THREE.MeshBasicMaterial({ color: 0xf4fbff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
  depthWrite: false, side: THREE.DoubleSide });
function flashBeam() { // a cone of light from the camera down to the seafloor, scaled to the height
  return new THREE.Mesh(new THREE.ConeGeometry(0.45, 1, 20, 1, true).translate(0, -0.5, 0), beamMat);
}
function makeAuv() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 3.4, 20), M.auv);
  body.rotation.z = Math.PI / 2;
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.42, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), M.auv);
  nose.rotation.z = -Math.PI / 2;
  nose.position.x = 1.7;
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.42, 1.3, 20), M.auv);
  tail.rotation.z = Math.PI / 2;
  tail.position.x = -2.35;
  g.add(body, nose, tail);
  for (let k = 0; k < 4; k++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.05, 0.6), M.hull);
    fin.position.set(-2.6, 0, 0);
    fin.rotation.x = (k * Math.PI) / 2;
    fin.translateZ(0.42);
    g.add(fin);
  }
  const prop = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.05, 6, 16), M.steel);
  prop.rotation.y = Math.PI / 2;
  prop.position.x = -3.05;
  g.add(prop);
  for (const sgn of [1, -1]) { // name and crack on both sides, the crack over the top too
    const name = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 0.48), M.auvLabel);
    name.position.set(-0.6, 0.05, sgn * 0.43);
    const crack = new THREE.Mesh(new THREE.PlaneGeometry(2, 0.8), M.crack);
    crack.position.set(0.9, 0, sgn * 0.44);
    if (sgn < 0) { name.rotation.y = Math.PI; crack.rotation.y = Math.PI; }
    g.add(name, crack);
  }
  const topCrack = new THREE.Mesh(new THREE.PlaneGeometry(2, 0.7), M.crack);
  topCrack.rotation.x = -Math.PI / 2;
  topCrack.position.set(0.9, 0.43, 0);
  const strobe = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), M.strobeOff);
  strobe.position.set(0.6, -0.43, 0);
  const beam = flashBeam();
  beam.position.copy(strobe.position);
  g.add(topCrack, strobe, beam);
  // the rider: black cap, glasses, black shoes with yellow laces; facing forward (+x)
  const rider = makePerson({ shirt: 0x8d99a6, pants: 0x2a3550, cap: 0x111111, glasses: true, shoes: 0x111111, laces: 0xffd400, pose: "ride",
    hull: (0.42 * 2.2) / 1.5 }); // the AUV's radius, in the rider's own scale
  rider.rotation.y = Math.PI / 2;
  rider.position.set(-0.4, 0.44, 0);
  rider.scale.setScalar(1.5 / 2.2);
  g.add(rider);
  // sometimes: towing the rubber boat (recovery gone wrong), with someone in it, waving for help
  const boat = new THREE.Group();
  const tubeM = pmat(0x4a4f57), orange = pmat(0xff6a1a);
  for (const sz of [-1, 1]) {
    const tb = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 1.5, 4, 10), tubeM);
    tb.rotation.z = Math.PI / 2;
    tb.position.set(0, 0.17, sz * 0.42);
    const stripe = new THREE.Mesh(new THREE.CapsuleGeometry(0.175, 0.5, 4, 10), orange);
    stripe.rotation.z = Math.PI / 2;
    stripe.position.set(0.15, 0.17, sz * 0.42);
    boat.add(tb, stripe);
  }
  const bow = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.62, 4, 10), tubeM);
  bow.rotation.x = Math.PI / 2;
  bow.position.set(0.92, 0.17, 0);
  const floorB = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.06, 0.8), pmat(0x2a2d33));
  floorB.position.y = 0.05;
  const motor = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.3, 0.2), pmat(0x1c1c1c));
  motor.position.set(-0.98, 0.45, 0);
  boat.add(bow, floorB, motor, tube3([-0.98, 0.3, 0], [-0.98, -0.25, 0], 0.03, pmat(0x1c1c1c)));
  const sailor = makePerson({ shirt: 0xff6a1a, pants: 0x2a3550, hair: 0x7a4a22, spikes: false });
  sailor.scale.setScalar(0.62);
  sailor.rotation.y = Math.PI / 2; // facing the AUV, waving for help
  sailor.position.set(-0.2, 0.32, 0);
  boat.add(sailor);
  boat.position.set(-6.4, 0.25, 0);
  boat.add(tube3([1.05, 0.2, 0], [3.5, -0.25, 0], 0.02, pmat(0xffd400))); // the painter, to the AUV's tail
  boat.visible = false;
  g.add(boat);
  Object.assign(g.userData, { strobe, beam, size: 2.2, boat, boatWave: sailor.userData.wave });
  g.scale.setScalar(2.2); // bigger than life: it's a game
  return g;
}
// The ocean floor elevator: a steel frame with floats on top and experiments inside, lowered free-fall to
// the seafloor. This one has eyes (and a name): ELEVATOR BOI.
function makeElevator() {
  const g = new THREE.Group();
  const W = 1.5, H = 3.2;
  const edges = [];
  for (const x of [-W, W]) for (const z of [-W, W]) edges.push([[x, 0, z], [x, H, z]]);
  for (const y of [0, 1.1, H]) {
    edges.push([[-W, y, -W], [W, y, -W]], [[-W, y, W], [W, y, W]], [[-W, y, -W], [-W, y, W]], [[W, y, -W], [W, y, W]]);
  }
  for (const [a, b] of edges) g.add(tube3(a, b, 0.08, M.frame));
  const ballast = new THREE.Mesh(new THREE.BoxGeometry(W * 2, 0.35, W * 2), M.chimney);
  ballast.position.y = -0.18;
  g.add(ballast);
  for (const [x, z] of [[-0.75, -0.75], [0.75, -0.75], [-0.75, 0.75], [0.75, 0.75], [0, 0]]) { // floats in yellow hard hats
    const f = new THREE.Mesh(new THREE.SphereGeometry(0.55, 14, 10), M.yellow);
    f.position.set(x, H + 0.5, z);
    g.add(f);
  }
  // the experiments it carries: chambers, a sediment trap, boxes of electronics
  for (const [x, z, c] of [[-0.8, -0.6, 0x9aa4ab], [0.7, -0.7, 0xff3b2f], [-0.6, 0.7, 0x2f6fb0], [0.8, 0.6, 0x7dff9a]]) {
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.9, 12), pmat(c));
    b.position.set(x, 0.5, z);
    g.add(b);
  }
  const trap = new THREE.Mesh(new THREE.ConeGeometry(0.6, 1.4, 14, 1, true), pmat(0xffffff));
  trap.rotation.x = Math.PI;
  trap.position.set(0, 2, 0);
  const box = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.6, 0.8), pmat(0x30343c));
  box.position.set(0, 1.45, -0.6);
  g.add(trap, box);
  // a face on the front: big eyes on the front floats, and a grin on the top bar
  const eyes = [];
  for (const x of [-0.75, 0.75]) {
    const white = new THREE.Mesh(new THREE.SphereGeometry(0.3, 14, 10), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    white.position.set(x, H + 0.6, 0.75 + 0.42);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), new THREE.MeshBasicMaterial({ color: 0x111111 }));
    pupil.position.set(0, 0, 0.22);
    white.add(pupil);
    g.add(white);
    eyes.push(pupil);
  }
  const grin = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.06, 6, 16, Math.PI), new THREE.MeshBasicMaterial({ color: 0x111111 }));
  grin.rotation.z = Math.PI;
  grin.position.set(0, H - 0.05, W + 0.09);
  g.add(grin);
  const name = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 0.5), M.boiSign);
  name.position.set(0, 0.55, W + 0.1);
  g.add(name);
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), M.hazard);
  lamp.position.set(0, H + 1.15, 0);
  g.add(lamp);
  Object.assign(g.userData, { eyes, lamp });
  g.scale.setScalar(1.6);
  return g;
}
function makeSub() { // the manned submersible (N.sub): yellow, a big round window, a pilot inside
  const g = new THREE.Group();
  const yellow = M.auv;
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 1.6, 20, 1, true), yellow); // x -0.8…0.8
  body.rotation.z = Math.PI / 2;
  const back = new THREE.Mesh(new THREE.SphereGeometry(0.8, 20, 10, 0, Math.PI), yellow);
  back.rotation.y = -Math.PI / 2;
  back.position.x = -0.8;
  g.add(back);
  const skid = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.12, 1.5), M.steel);
  skid.position.y = -0.95;
  const tower = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.55, 0.7), M.shipRed);
  tower.position.set(0.1, 0.95, 0);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.8, 20, 12, 0, Math.PI), M.clear); // the front: a clear half sphere
  dome.rotation.y = Math.PI / 2;
  dome.position.x = 0.8;
  g.add(body, skid, tower, dome);
  for (const z of [-0.95, 0.95]) {
    const th = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.5, 10), M.steel);
    th.rotation.z = Math.PI / 2;
    th.position.set(-0.9, 0, z);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 6), M.window);
    lamp.position.set(0.7, 0.68, z * 0.42);
    g.add(th, lamp);
  }
  const label = textTexture(256, 96, (x, w, h) => { x.clearRect(0, 0, w, h); x.fillStyle = "#111"; x.textAlign = "center"; x.font = "900 64px sans-serif"; x.fillText(N.sub, w / 2, 70, w - 16); });
  for (const sgn of [1, -1]) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.34), new THREE.MeshBasicMaterial({ map: label, transparent: true, depthWrite: false }));
    p.position.set(0.1, 0.95, sgn * 0.36);
    if (sgn < 0) p.rotation.y = Math.PI;
    g.add(p);
  }
  const pilot = makePerson({ shirt: 0xe05a1a, pants: 0x30343c, hair: 0x5a3a22 }); // in the window, waving
  pilot.rotation.y = Math.PI / 2;
  pilot.position.set(0.95, -0.2, 0);
  pilot.scale.setScalar(0.7);
  g.add(pilot);
  g.userData.wave = pilot.userData.wave;
  const strobe = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), M.strobeOff);
  strobe.position.set(0.9, -0.85, 0);
  const beam = flashBeam();
  beam.position.copy(strobe.position);
  g.add(strobe, beam);
  Object.assign(g.userData, { strobe, beam, size: 1.6 });
  g.scale.setScalar(1.6);
  return g;
}
function makeFlyOfos() {
  const g = MAKE.ofos();
  const beam = flashBeam();
  beam.position.set(0, 0, 0.6);
  g.add(beam);
  Object.assign(g.userData, { beam, size: 1.6 });
  g.scale.setScalar(1.6);
  return g;
}
const flyLight = new THREE.PointLight(0xffffff, 0, 45, 1.2); // the flash on the seafloor (always in the scene)
scene.add(flyLight);
const flyObjs = {};
let fly = null;
function startFly(kind) {
  const obj = (flyObjs[kind] ||= { auv: makeAuv, jago: makeSub, ofos: makeFlyOfos, elevator: makeElevator }[kind]());
  if (!obj.parent) scene.add(obj);
  const dir = Math.random() < 0.5 ? 1 : -1;
  obj.visible = true;
  obj.rotation.y = dir > 0 ? 0 : Math.PI;
  seen(kind === "ofos" ? "ofosfly" : kind);
  const boat = kind === "auv" && Math.random() < 0.35;
  if (kind === "auv") { obj.userData.boat.visible = boat; obj.userData.wave = boat ? obj.userData.boatWave : null; }
  if (boat) seen("dinghy");
  fly = { kind, obj, dir, t: 0, dur: kind === "auv" ? 4.5 : 6, alt: kind === "auv" ? rand(8, 10) : kind === "jago" ? rand(7, 9) : rand(6.5, 8), shot: 0.3, on: 0, shotHit: false };
  if (kind === "elevator") { startElevator(); return; }
  if (boat) radio(pick([`Boat crew: ${N.auv}! We were supposed to tow YOU!`, "Bridge: The AUV recovery is going… creatively.", "Boat crew: Release the painter! RELEASE THE PAINTER!"]));
  else radio(kind === "jago"
    ? pick([`${N.institute}: ${N.sub} is diving nearby. Wave to the pilots!`, `${N.sub}: We see you. Don't come closer, we have only one window.`, `Bridge: ${N.sub} is on its way back up, give way.`])
    : kind === "auv"
    ? pick([`${N.institute}: AUV ${N.auv} is crossing on its survey line. Mind the crack.`, "AUV team: Yes, we know about the crack. It's fine. Probably.", `AUV team: ${N.auv} is photographing your area. Smile!`])
    : pick(["OFOS team: Crossing your track, smile for the camera!", "OFOS team: A photo every second. Please don't be in all of them.", "Bridge: Ship is turning with the OFOS, coming across."]));
}
// ELEVATOR BOI: arrives with a BING (points for spotting him), sails across high up, then comes down
// beside the track much too fast and throws its experiments everywhere.
const ELEV_T = 3.6;
function startElevator() {
  const f = fly;
  f.obj.rotation.set(0, 0, 0); // face to the camera, whichever way it goes
  beamMat.opacity = 0;
  f.dur = ELEV_T;
  f.x0 = -f.dir * 28;
  f.x1 = f.dir * rand(7.5, 9.5); // lands beside the lanes, on the far side
  f.sLand = g.s + g.v * ELEV_T + 40;
  f.crashed = false;
  // the arrival chime: BING (two bell partials)
  tone(1568, 1.4, { type: "sine", gain: 0.16 });
  tone(3136, 0.7, { type: "sine", gain: 0.04 });
  tone(1175, 1.6, { type: "sine", gain: 0.1, delay: 0.32 });
  if (g.state === "run") {
    banner("ELEVATOR BOI!", "🛗 BING! · +500 for the sighting", "#ffc928");
    flash(0.35, "#ffc928");
    addPoints(500, { x: g.x, s: g.s, alt: g.alt + 3 }, "#ffc928");
    seen("elevator");
  }
  radio(pick(["Lander team: Elevator is released! Heads up down there!", "Bridge: The elevator is on its way down. Free fall. Like we planned. Sort of.",
    "Lander team: ELEVATOR BOI is coming! Twelve experiments on board!"]));
}
function updateElevator(f, dt, now) {
  const ud = f.obj.userData;
  ud.lamp.visible = now % 900 < 450;
  for (const e of ud.eyes) e.position.x = Math.sin(now / 300) * 0.07; // looking around
  if (f.crashed) {
    if (g.s > f.sLand + 20 || g.state === "ready") endFly();
    return;
  }
  f.t += dt;
  const k = Math.min(1, f.t / f.dur), ease = 1 - (1 - k) ** 2;
  const x = f.x0 + (f.x1 - f.x0) * ease, s = f.sLand + (1 - k) * 25;
  const ground = g.floor.h(s, x), track = g.floor.h(s, 0);
  const alt = 26 * (1 - k * k); // falls faster and faster
  f.obj.position.set(x, Math.max(ground, track + alt) + (k < 1 ? Math.sin(now / 180) * 0.3 * (1 - k) : 0), -s);
  f.obj.rotation.z = Math.sin(now / 160) * 0.12 * k; // wobbles as it drops
  if (k < 1) return;
  // CRASH: on its side a bit, sediment, experiments in all directions
  f.crashed = true;
  f.obj.position.y = ground - 0.2;
  f.obj.rotation.set(0.12, 0, f.dir * 0.22);
  burst(x, ground + 1, -s, 0x8a7a5a, 160, 12, 2);
  burst(x, ground + 0.5, -s, 0xc9b48a, 70, 16, 0.6);
  const close = s - g.s < 90;
  if (close && g.state === "run") {
    shake = Math.max(shake, 0.6);
    flash(0.3, "#ffc928");
    tone(55, 0.7, { type: "sine", gain: 0.3, slide: 0.5 });
    tone(900, 0.25, { type: "square", gain: 0.04, slide: 0.3, delay: 0.05 }); // clatter
    radio(pick(["Lander team: It was supposed to land GENTLY.", "Chief scientist: Well, the experiments are deployed. Technically.",
      "Lander team: Twelve experiments, twelve positions. Very… spread out.", "Pilot: ELEVATOR BOI has landed. Everywhere."]));
  }
  for (let n = 0; n < 11; n++) { // the experiments fly off and land on the seafloor, beside the lanes
    const type = pick(["chamber", "chamber", "corer", "corer", "flag", "sign", "lander", "glassfloat", "barrel"]);
    const t = place(type, s, x, 1.5, true);
    const side = n % 3 === 0 ? -Math.sign(x) : Math.sign(x);
    const xt = side * rand(6.5, 17), st = s + rand(-8, 40), T = rand(0.9, 1.7);
    t.fly = { vx: (xt - x) / T, vs: (st - s) / T, vy: 12.5 * T * 0.5 + rand(2, 5) / T, spin: [rand(-6, 6), rand(-6, 6)] };
  }
}
function endFly() {
  if (!fly) return;
  fly.obj.visible = false;
  fly = null;
  flyLight.intensity = 0;
}
function updateFly(dt, now) {
  const f = fly;
  if (!f) return;
  if (f.kind === "elevator") { updateElevator(f, dt, now); return; }
  f.t += dt;
  const k = f.t / f.dur;
  if (k >= 1) { endFly(); return; }
  const x = f.dir * (-30 + 60 * k); // across, from one side to the other
  const s = g.s + 48 - 22 * k; // ahead of the ROV, coming closer
  const ground = g.floor.h(s, x), track = g.floor.h(s, 0);
  const y = Math.max(ground + 2.5, track + f.alt); // level over the track, clear of the canyon sides
  f.obj.position.set(x, y + Math.sin(now / 450) * 0.25, -s);
  const ud = f.obj.userData;
  if ((f.shot -= dt) <= 0) { // click: a photo of the seafloor
    f.shot = f.kind === "auv" ? 0.6 : 0.9;
    f.on = 0.12;
    if (g.state === "run") {
      flash(0.12, "#ffffff");
      tone(2400, 0.04, { type: "square", gain: 0.03 });
      if (Math.abs(x - g.x) < 3 && !f.shotHit) { // the ROV is in the picture
        f.shotHit = true;
        seen("picture");
        addPoints(50, { x: g.x, s: g.s, alt: g.alt + 2 }, "#ffffff");
        popup("📸 IN THE PICTURE!", g.x, rov.position.y + 3, -g.s, "#ffffff", true);
        flash(0.35, "#ffffff");
      }
    }
  }
  f.on -= dt;
  const on = f.on > 0;
  beamMat.opacity = on ? 0.28 : 0;
  ud.strobe.material = on ? M.strobe : M.strobeOff;
  waveArm(f.obj, now);
  const h = (y - ground - 0.3) / ud.size;
  ud.beam.scale.set(h * 0.55, h, h * 0.55);
  flyLight.position.set(x, ground + 1.5, -s);
  flyLight.intensity = on ? 90 : 0;
  if (f.kind === "auv" && Math.random() < 0.6) burst(x + rand(-0.8, 0.8), y + 0.6, -s, 0xcfe9ff, 1, 1.2, 2.5); // it leaks
}

// ---------- particles: bursts, sparks, explosions ----------
const PN = 1600;
const pPos = new Float32Array(PN * 3), pCol = new Float32Array(PN * 3), pVel = new Float32Array(PN * 3), pLife = new Float32Array(PN);
const pGeom = new THREE.BufferGeometry();
pGeom.setAttribute("position", new THREE.BufferAttribute(pPos, 3));
pGeom.setAttribute("color", new THREE.BufferAttribute(pCol, 3));
function dotTexture() { // a soft round dot (points are squares otherwise)
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const x = c.getContext("2d"), grd = x.createRadialGradient(16, 16, 0, 16, 16, 16);
  grd.addColorStop(0, "rgba(255,255,255,1)"); grd.addColorStop(0.35, "rgba(255,255,255,0.8)"); grd.addColorStop(1, "rgba(255,255,255,0)");
  x.fillStyle = grd;
  x.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}
const DOT = dotTexture();
snow.material.map = DOT; snow.material.size = 0.2; snow.material.needsUpdate = true;
bubbles.material.map = DOT; bubbles.material.needsUpdate = true;
const sparks = new THREE.Points(pGeom, new THREE.PointsMaterial({ size: 0.55, map: DOT, vertexColors: true, transparent: true, opacity: 1,
  blending: THREE.AdditiveBlending, depthWrite: false }));
sparks.frustumCulled = false;
scene.add(sparks);
let pNext = 0;
const _c = new THREE.Color();
function burst(x, y, z, color, n = 30, speed = 9, up = 2) {
  _c.setHex(color);
  for (let k = 0; k < n; k++) {
    const i = pNext; pNext = (pNext + 1) % PN;
    const a = Math.random() * Math.PI * 2, e = Math.acos(rand(-1, 1)), v = speed * rand(0.4, 1);
    pPos.set([x, y, z], i * 3);
    pVel.set([Math.sin(e) * Math.cos(a) * v, Math.cos(e) * v + up, Math.sin(e) * Math.sin(a) * v - g.v * 0.6], i * 3);
    const f = rand(0.7, 1.2);
    pCol.set([_c.r * f, _c.g * f, _c.b * f], i * 3);
    pLife[i] = rand(0.35, 0.8);
  }
}
function updateSparks(dt) {
  for (let i = 0; i < PN; i++) {
    if (pLife[i] <= 0) continue;
    pLife[i] -= dt;
    if (pLife[i] <= 0) { pPos[i * 3 + 1] = -9999; continue; }
    const k = i * 3;
    pVel[k] *= 1 - dt * 2.5; pVel[k + 1] = pVel[k + 1] * (1 - dt * 2.5) - dt * 3; pVel[k + 2] *= 1 - dt * 1.5;
    pPos[k] += pVel[k] * dt; pPos[k + 1] += pVel[k + 1] * dt; pPos[k + 2] += pVel[k + 2] * dt;
    pCol[k] *= 1 - dt * 1.2; pCol[k + 1] *= 1 - dt * 1.2; pCol[k + 2] *= 1 - dt * 1.2;
  }
  pGeom.attributes.position.needsUpdate = true;
  pGeom.attributes.color.needsUpdate = true;
}

// speed streaks: lines rushing past, longer and brighter the faster the ROV goes
const SN = 90;
const streakPos = new Float32Array(SN * 6);
const streakGeom = new THREE.BufferGeometry();
streakGeom.setAttribute("position", new THREE.BufferAttribute(streakPos, 3));
const streakMat = new THREE.LineBasicMaterial({ color: 0xbfefff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
const streaks = new THREE.LineSegments(streakGeom, streakMat);
streaks.frustumCulled = false;
scene.add(streaks);
const streakSeed = Array.from({ length: SN }, () => [rand(-14, 14), rand(-2, 10), rand(-90, 0)]);

// ---------- ship details: rail, windows, lifeboats, radar mast, cranes, helideck, funnel band ----------
function detailShip(w, ship, L, houseM) {
  const railM = pmat(0xe8e4d8);
  w.add(tube3([-L / 2, WRECK_H + 1.1, 0.2], [L / 2, WRECK_H + 1.1, 0.2], 0.05, railM));
  for (let x = -L / 2 + 2; x < L / 2; x += 4) w.add(tube3([x, WRECK_H + 0.6, 0.2], [x, WRECK_H + 1.1, 0.2], 0.04, railM));
  for (let x = L * 0.07; x <= L * 0.35; x += 2.2) { // two rows of cabin windows on the deckhouse
    for (const y of [WRECK_H + 2.6, WRECK_H + 6.2]) {
      const win = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.9), Math.random() < 0.3 ? M.window : M.strobeOff);
      win.position.set(x, y, -1.95);
      w.add(win);
    }
  }
  const boatM = pmat(0xff6a00);
  for (const x of [L * 0.11, L * 0.31]) { // lifeboats in their davits
    const boat = new THREE.Mesh(new THREE.CapsuleGeometry(1.1, 4.5, 4, 12), boatM);
    boat.rotation.z = Math.PI / 2;
    boat.position.set(x, WRECK_H + 4, -0.9);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(4, 0.5, 1.6), pmat(0xf2f0ea));
    roof.position.set(x, WRECK_H + 5, -0.9);
    w.add(boat, roof);
    for (const dx of [-2.6, 2.6]) w.add(tube3([x + dx, WRECK_H + 2, -2], [x + dx, WRECK_H + 6, -0.6], 0.12, railM));
  }
  const mastX = L * 0.26, mastY = WRECK_H + 13.8; // radar mast on the bridge
  w.add(tube3([mastX, mastY, -WRECK_L / 2], [mastX, mastY + 7, -WRECK_L / 2], 0.25, houseM));
  w.add(tube3([mastX, mastY + 5, -WRECK_L / 2 - 3], [mastX, mastY + 5, -WRECK_L / 2 + 3], 0.15, houseM));
  for (const z of [-WRECK_L / 2 - 3, -WRECK_L / 2 + 3]) {
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.7, 12, 8), pmat(0xf2f0ea));
    dome.position.set(mastX, mastY + 5.7, z);
    w.add(dome);
  }
  const radar = new THREE.Mesh(new THREE.BoxGeometry(4, 0.25, 0.4), pmat(0x333333));
  radar.position.set(mastX, mastY + 7.2, -WRECK_L / 2);
  w.add(radar);
  w.userData.radar = radar; // turns slowly, even down here
  const craneM = pmat(ship.crane);
  for (const x of [-L * 0.2, -L * 0.33]) { // cranes on the working deck
    const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.9, 3.5, 10), craneM);
    ped.position.set(x, WRECK_H + 1.75, -6);
    w.add(ped, tube3([x, WRECK_H + 3.3, -6], [x + 6, WRECK_H + 11, -3], 0.35, craneM), tube3([x + 6, WRECK_H + 11, -3], [x + 6, WRECK_H + 6, -3], 0.04, M.wire));
  }
  const funnelBand = new THREE.Mesh(new THREE.BoxGeometry(6.3, 1.6, 7.3), pmat(ship.band));
  funnelBand.position.set(L * 0.05 + 0.25, WRECK_H + 11, -WRECK_L / 2);
  funnelBand.rotation.z = 0.1;
  w.add(funnelBand);
  if (ship.helideck) { // the polar ship: helicopter deck on top of the deckhouse, yellow ring and H
    const deck = new THREE.Mesh(new THREE.BoxGeometry(18, 0.5, WRECK_L - 3), pmat(0x3c5a46));
    deck.position.set(L * 0.1, WRECK_H + 9.8, -WRECK_L / 2);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(6, 0.25, 6, 32), pmat(0xffd400));
    ring.rotation.x = Math.PI / 2;
    ring.position.set(L * 0.1, WRECK_H + 10.1, -WRECK_L / 2);
    w.add(deck, ring);
    for (const [dx, dz, sx, sz] of [[-1.5, 0, 0.5, 5], [1.5, 0, 0.5, 5], [0, 0, 3, 0.5]]) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(sx, 0.1, sz), pmat(0xffffff));
      b.position.set(L * 0.1 + dx, WRECK_H + 10.1, -WRECK_L / 2 + dz);
      w.add(b);
    }
  }
}

// the ROV's name (N.rov), on the back of the ROV we're flying
const rovNameMap = textTexture(512, 128, (x, w, h) => {
  x.fillStyle = "#ffd400"; x.fillRect(0, 0, w, h);
  x.fillStyle = "#111"; x.textAlign = "center"; x.font = "900 84px sans-serif"; x.fillText(N.rov, w / 2, 94, w - 24);
});
{
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 0.42), new THREE.MeshBasicMaterial({ map: rovNameMap }));
  plate.position.set(0, 0.75, 1.32);
  plate.rotation.x = -0.35;
  rov.add(plate);
}

// ---------- the runner (the developer): red shorts, a shirt with lettering, a 2 l bottle and a laptop (N.runner) ----------
const RUN = N.runner;
const shirtMap = textTexture(256, 96, (x, w, h) => {
  x.fillStyle = `#${RUN.shirt.toString(16).padStart(6, "0")}`; x.fillRect(0, 0, w, h);
  x.fillStyle = "#fff"; x.textAlign = "center"; x.font = "900 54px sans-serif"; x.fillText(RUN.text, w / 2, 66, w - 16);
});
function makeRunner(add = true) {
  const g = new THREE.Group(); // stands on the seafloor, runs towards -z (along with the ROV)
  const SKIN = 0xf0c8a0, BLUE = RUN.shirt, RED = 0xd8261c;
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.62, 0.26), pmat(BLUE));
  torso.position.y = 1.32;
  const back = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.15), new THREE.MeshBasicMaterial({ map: shirtMap }));
  back.position.set(0, 1.45, 0.131); // the back: what the camera sees
  const front = back.clone();
  front.position.z = -0.131;
  front.rotation.y = Math.PI;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 14, 10), pmat(SKIN));
  head.position.y = 1.8;
  g.add(torso, back, front, head);
  if (RUN.cap != null) { // a cap, peak forward (-z)
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.142, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), pmat(RUN.cap));
    cap.position.y = 1.83;
    const peak = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.02, 0.16), pmat(RUN.cap));
    peak.position.set(0, 1.84, -0.18);
    g.add(cap, peak);
  }
  if (RUN.curls) for (let k = 0; k < 22; k++) { // curls
    const a = Math.random() * Math.PI * 2, e = Math.random() * 1.2;
    const c = new THREE.Mesh(new THREE.SphereGeometry(0.055, 6, 5), pmat(0x3b2414));
    c.position.set(Math.sin(e) * Math.cos(a) * 0.14, 1.83 + Math.cos(e) * 0.12, Math.sin(e) * Math.sin(a) * 0.14 + 0.02);
    if (c.position.z < -0.08 && c.position.y < 1.88) continue; // keep the face free
    g.add(c);
  }
  const legs = [], arms = [];
  for (const sx of [-1, 1]) {
    const hip = new THREE.Group();
    hip.position.set(sx * 0.11, 1.02, 0);
    limb(hip, [0, 0.05, 0], [0, -0.22, 0], 0.095, RED); // shorts
    const knee = new THREE.Group();
    knee.position.y = -0.46;
    limb(hip, [0, -0.2, 0], [0, -0.46, 0], 0.065, SKIN);
    limb(knee, [0, 0, 0], [0, -0.46, 0], 0.055, SKIN);
    const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.08, 0.26), pmat(0xf2f2f2));
    shoe.position.set(0, -0.5, -0.05);
    knee.add(shoe);
    hip.add(knee);
    g.add(hip);
    legs.push([hip, knee]);
    const sh = new THREE.Group();
    sh.position.set(sx * 0.27, 1.58, 0);
    limb(sh, [0, 0, 0], [0, -0.26, 0], 0.05, BLUE);
    const elbow = new THREE.Group();
    elbow.position.y = -0.26;
    elbow.rotation.x = 1.3; // forearms forward (-z), bent
    limb(elbow, [0, 0, 0], [0, -0.26, 0], 0.045, SKIN);
    if (sx > 0) { // the laptop, open, screen glowing at him
      const lap = new THREE.Group();
      lap.position.set(0, -0.3, -0.05);
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.015, 0.22), pmat(RUN.laptop));
      const lid = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.22, 0.012), pmat(RUN.laptop));
      lid.position.set(0, 0.11, -0.11);
      lid.rotation.x = -0.3;
      const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.29, 0.19), new THREE.MeshBasicMaterial({ color: 0x9fd8ff }));
      screen.position.set(0, 0.11, -0.103);
      screen.rotation.set(-0.3, 0, 0); // facing him
      const glow = new THREE.Mesh(new THREE.CircleGeometry(0.025, 12), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      glow.position.set(0, 0.12, -0.118); // on the back of the lid
      glow.rotation.set(-0.3, Math.PI, 0);
      lap.add(base, lid, screen);
      if (RUN.logo) lap.add(glow);
      lap.rotation.x = -1.3; // level again
      elbow.add(lap);
    } else { // the big blue 2 l bottle
      const bottle = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.065, 0.34, 12), new THREE.MeshStandardMaterial({ color: 0x2a7dff, emissive: 0x0a2a66, transparent: true, opacity: 0.85 }));
      bottle.position.set(0, -0.3, 0);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.05, 10), pmat(0x111111));
      cap.position.set(0, -0.12, 0);
      elbow.add(bottle, cap);
    }
    sh.add(elbow);
    g.add(sh);
    arms.push(sh);
  }
  g.userData.run = (phase) => { // legs and arms swing; a little bounce
    legs.forEach(([hip, knee], i) => {
      const p = phase + i * Math.PI;
      hip.rotation.x = Math.sin(p) * 0.75;
      knee.rotation.x = -Math.max(0, Math.sin(p + 1.2)) * 1.3; // shins swing back
    });
    arms.forEach((sh, i) => { sh.rotation.x = -Math.sin(phase + i * Math.PI) * 0.6; });
    g.children[0].position.y = 1.32 + Math.abs(Math.sin(phase)) * 0.04;
  };
  const torch = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff })); // a head torch: it's dark down here
  torch.position.set(0, 1.86, -0.13);
  const beam = new THREE.Mesh(new THREE.ConeGeometry(0.9, 4, 16, 1, true).translate(0, -2, 0), torchMat);
  beam.position.copy(torch.position);
  beam.rotation.x = 1.25; // shining ahead
  g.add(torch, beam);
  g.traverse((o) => { // he glows a little: he's seen far off in the dark
    if (o.material?.isMeshStandardMaterial) { o.material = o.material.clone(); o.material.emissive.copy(o.material.color).multiplyScalar(0.6); }
    if (o.material) o.material.fog = false; // the midnight zone's fog would swallow him
  });
  g.scale.setScalar(1.8); // a bit bigger than life
  if (add) scene.add(g);
  return g;
}
const torchMat = new THREE.MeshBasicMaterial({ color: 0xfff1c0, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
let runner = null, runnerObj = null;
function startRunner() { // the developer, once a run (DEV_AT): far off on the canyon slope
  runnerObj ||= makeRunner();
  runnerObj.visible = true;
  runner = { side: Math.random() < 0.5 ? -1 : 1, t: 0, dur: 11, phase: 0 };
  seen("runner");
  radio(pick([
    "Bridge: Is that the developer jogging on the seafloor?!",
    "Pilot: The developer is pushing a hotfix. On foot. At 4,000 m.",
    "Data manager: The developer says it works on his machine.",
    `Co-pilot: 4,000 m, a ${N.laptop} and two litres of water. Respect.`,
    "Chief scientist: Could the developer add one more feature while he's down there?",
  ]));
}
function updateRunner(dt) {
  const r = runner;
  if (!r) return;
  r.t += dt;
  const k = r.t / r.dur;
  if (k >= 1 || g.state === "over") { runner = null; runnerObj.visible = false; return; }
  const off = 60 - 42 * k; // far ahead, slowly overtaken: he's nearly as fast as the ROV
  const s = g.s + off, x = r.side * 13;
  r.phase += dt * 16;
  runnerObj.position.set(x, g.floor.h(s, x), -s);
  runnerObj.userData.run(r.phase);
}

// ---------- sea creatures (beside the track, just for the joy of it) ----------
function eyes(g, y, z, r, gap) {
  for (const sx of [-1, 1]) {
    const white = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 10), pmat(0xffffff));
    white.position.set(sx * gap, y, z);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(r * 0.55, 10, 8), pmat(0x111111));
    pupil.position.set(sx * gap, y, z + r * 0.6);
    const shine = new THREE.Mesh(new THREE.SphereGeometry(r * 0.18, 6, 5), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    shine.position.set(sx * gap + r * 0.2, y + r * 0.25, z + r * 1.05);
    g.add(white, pupil, shine);
  }
}
Object.assign(MAKE, {
  starfish: () => { // a big orange sea star, lying flat, its arms curling a little
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0xff7a2f, emissive: 0x5a1e00, flatShading: true });
    const arms = [];
    const disc = new THREE.Mesh(new THREE.SphereGeometry(0.28, 10, 6), mat);
    disc.scale.y = 0.4;
    g.add(disc);
    for (let k = 0; k < 5; k++) {
      const arm = new THREE.Group();
      arm.rotation.y = (k / 5) * Math.PI * 2;
      const a = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.95, 6), mat);
      a.rotation.z = -Math.PI / 2;
      a.position.x = 0.55;
      a.scale.z = 0.5;
      arm.add(a);
      g.add(arm);
      arms.push(arm);
    }
    g.position.y = 0.08;
    g.userData.anim = (now, t) => arms.forEach((a, k) => { a.rotation.z = Math.sin(now / 900 + k + t.s) * 0.12; });
    g.scale.setScalar(1.8);
    return g;
  },
  crab: () => { // a red deep-sea crab, scuttling sideways
    const g = new THREE.Group();
    const red = new THREE.MeshStandardMaterial({ color: 0xd8401f, emissive: 0x4a1000 });
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.4, 12, 8), red);
    body.scale.set(1.3, 0.5, 1);
    body.position.y = 0.45;
    g.add(body);
    const legs = [];
    for (const sx of [-1, 1]) for (let k = 0; k < 4; k++) {
      const leg = new THREE.Group();
      leg.position.set(sx * 0.4, 0.42, -0.25 + k * 0.17);
      leg.add(tube3([0, 0, 0], [sx * 0.4, 0.15, 0], 0.035, red), tube3([sx * 0.4, 0.15, 0], [sx * 0.6, -0.42, 0], 0.03, red));
      g.add(leg);
      legs.push(leg);
    }
    for (const sx of [-1, 1]) { // claws up
      g.add(tube3([sx * 0.3, 0.5, 0.3], [sx * 0.45, 0.8, 0.55], 0.05, red));
      const claw = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 6), red);
      claw.scale.set(1, 0.7, 1.4);
      claw.position.set(sx * 0.47, 0.85, 0.6);
      g.add(claw);
    }
    eyes(g, 0.72, 0.28, 0.06, 0.12);
    g.userData.anim = (now, t) => {
      legs.forEach((l, k) => { l.rotation.x = Math.sin(now / 90 + k * 1.3) * 0.35; });
      t.x += Math.sin(now / 800 + t.s) * 0.012; // a few steps this way, then that
    };
    g.scale.setScalar(1.7);
    return g;
  },
  crinoid: () => { // a sea lily: a long stalk with feathery arms, swaying in the current
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0xffe0a0, emissive: 0x4a3a10 });
    const stalk = new THREE.Group();
    stalk.add(tube3([0, 0, 0], [0, 2.4, 0], 0.04, mat));
    const crown = new THREE.Group();
    crown.position.y = 2.4;
    for (let k = 0; k < 10; k++) {
      const arm = new THREE.Group();
      arm.rotation.set(0.6 + (k % 2) * 0.25, (k / 10) * Math.PI * 2, 0, "YXZ");
      arm.add(tube3([0, 0, 0], [0, 0.9, 0], 0.025, mat));
      for (let j = 1; j < 6; j++) arm.add(tube3([0, j * 0.15, 0], [0.12, j * 0.15 + 0.08, 0], 0.01, mat), tube3([0, j * 0.15, 0], [-0.12, j * 0.15 + 0.08, 0], 0.01, mat));
      crown.add(arm);
    }
    stalk.add(crown);
    g.add(stalk);
    g.userData.anim = (now, t) => { stalk.rotation.z = Math.sin(now / 1100 + t.s) * 0.12; crown.rotation.y = now / 3000; };
    g.scale.setScalar(1.4);
    return g;
  },
  sponge: () => { // a glass sponge: a pale, see-through vase
    const g = new THREE.Group();
    const pts = [[0.15, 0], [0.3, 0.3], [0.45, 1], [0.55, 1.8], [0.62, 2.3], [0.55, 2.3]].map(([x, y]) => new THREE.Vector2(x, y));
    const mat = new THREE.MeshStandardMaterial({ color: 0xe8f4ff, emissive: 0x2a3540, transparent: true, opacity: 0.55, side: THREE.DoubleSide, wireframe: false });
    const vase = new THREE.Mesh(new THREE.LatheGeometry(pts, 18), mat);
    const lattice = new THREE.Mesh(new THREE.LatheGeometry(pts, 12), new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.35 }));
    g.add(vase, lattice);
    g.scale.setScalar(1.3);
    return g;
  },
  rattail: () => { // a grenadier: big head, long tapering tail, cruising just above the seafloor
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, emissive: 0x1e2226 });
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 8), mat);
    head.scale.set(0.8, 0.9, 1.1);
    head.position.z = 0.4;
    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.26, 1.6, 10), mat);
    tail.rotation.x = -Math.PI / 2;
    tail.position.z = -0.5;
    g.add(head, tail);
    eyes(g, 0.1, 0.62, 0.07, 0.12);
    g.userData.anim = (now, t) => { tail.rotation.y = Math.sin(now / 160 + t.s) * 0.25; t.s += 0.04; }; // swims along with the ROV, slowly
    g.scale.setScalar(1.6);
    return g;
  },
  tubeworms: () => { // a cluster of white tube worms with red plumes, swaying
    const g = new THREE.Group();
    const plumes = [];
    for (let k = 0; k < 9; k++) {
      const x = rand(-0.6, 0.6), z = rand(-0.6, 0.6), h = rand(1, 2.2);
      g.add(tube3([x, 0, z], [x * 1.1, h, z * 1.1], 0.07, pmat(0xf2f2ea)));
      const p = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 6), new THREE.MeshStandardMaterial({ color: 0xff2a3a, emissive: 0x801018 }));
      p.position.set(x * 1.1, h + 0.08, z * 1.1);
      p.scale.y = 1.5;
      g.add(p);
      plumes.push(p);
    }
    g.userData.anim = (now, t) => plumes.forEach((p, k) => { p.scale.y = 1.3 + Math.sin(now / 400 + k + t.s) * 0.3; });
    g.scale.setScalar(1.2);
    return g;
  },
  tyre: () => { // an old tyre, half in the mud
    const g = new THREE.Group();
    const t = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.25, 10, 22), pmat(0x1c1c1c));
    t.rotation.x = Math.PI / 2 - 0.3;
    t.position.y = 0.2;
    g.add(t);
    g.scale.setScalar(1.6);
    return g;
  },
  anchor: () => { // a lost anchor, with its chain trailing off
    const g = new THREE.Group();
    const rust = pmat(0x7a4a2c);
    g.add(tube3([0, 0.2, 0], [0, 2.4, 0], 0.09, rust), tube3([-0.5, 2.1, 0], [0.5, 2.1, 0], 0.07, rust));
    const arc = new THREE.Mesh(new THREE.TorusGeometry(0.8, 0.09, 6, 18, Math.PI), rust);
    arc.rotation.z = Math.PI;
    arc.position.y = 0.95;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.05, 6, 12), rust);
    ring.position.y = 2.6;
    g.add(arc, ring);
    for (let k = 0; k < 9; k++) {
      const link = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.035, 5, 10), rust);
      link.position.set(0.3 + k * 0.22, 2.4 - k * 0.27 > 0.05 ? 2.4 - k * 0.27 : 0.05, k * 0.05);
      link.rotation.y = (k % 2) * (Math.PI / 2);
      g.add(link);
    }
    g.rotation.z = 0.35; // fallen over a bit
    return g;
  },
  barrel: () => { // a rusty old barrel, dented, on its side
    const g = new THREE.Group();
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.45, 1.2, 14), pmat(0x8a5a2a));
    b.rotation.z = Math.PI / 2;
    b.position.y = 0.42;
    g.add(b);
    for (const x of [-0.3, 0.3]) {
      const hoop = new THREE.Mesh(new THREE.TorusGeometry(0.45, 0.03, 5, 16), pmat(0x5a3a1a));
      hoop.rotation.y = Math.PI / 2;
      hoop.position.set(x, 0.42, 0);
      g.add(hoop);
    }
    g.scale.setScalar(1.5);
    return g;
  },
  glassfloat: () => { // a lost glass float in its yellow hard hat, still on its line
    const g = new THREE.Group();
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.4, 14, 10), M.yellow);
    ball.position.y = 1.8;
    g.add(ball, tube3([0, 0, 0], [0, 1.4, 0], 0.015, M.wire));
    const w = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.2, 0.4), M.chimney);
    w.position.y = 0.1;
    g.add(w);
    g.userData.anim = (now, t) => { ball.position.x = Math.sin(now / 1300 + t.s) * 0.15; };
    g.scale.setScalar(1.5);
    return g;
  },
  dumbo: () => { // the cutest thing in the deep sea: flapping ear fins, big eyes, blushing
    const g = new THREE.Group();
    const body = new THREE.Group();
    const PINK = 0xff9f8a;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.9, 20, 14), pmat(PINK));
    head.scale.set(1, 1.1, 0.95);
    head.position.y = 0.6;
    const skirt = new THREE.Mesh(new THREE.ConeGeometry(1.05, 1, 16, 1, true), new THREE.MeshStandardMaterial({ color: PINK, emissive: 0x401c16, side: THREE.DoubleSide }));
    skirt.position.y = -0.35;
    skirt.rotation.x = Math.PI;
    body.add(head, skirt);
    eyes(body, 0.55, 0.72, 0.2, 0.32);
    for (const sx of [-1, 1]) {
      const blush = new THREE.Mesh(new THREE.CircleGeometry(0.13, 12), new THREE.MeshBasicMaterial({ color: 0xff5f8a, transparent: true, opacity: 0.7 }));
      blush.position.set(sx * 0.48, 0.28, 0.78);
      body.add(blush);
    }
    const smile = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.025, 6, 12, Math.PI), pmat(0x7a2a2a));
    smile.position.set(0, 0.3, 0.86);
    smile.rotation.z = Math.PI;
    body.add(smile);
    const ears = [];
    for (const sx of [-1, 1]) {
      const ear = new THREE.Group();
      ear.position.set(sx * 0.75, 1.15, 0);
      const fin = new THREE.Mesh(new THREE.SphereGeometry(0.45, 12, 8), pmat(0xffb09e));
      fin.scale.set(1, 0.2, 0.7);
      fin.position.x = sx * 0.4;
      ear.add(fin);
      body.add(ear);
      ears.push([ear, sx]);
    }
    for (let k = 0; k < 8; k++) { // little tentacle tips under the skirt
      const a = (k / 8) * Math.PI * 2;
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.09, 6, 5), pmat(PINK));
      tip.position.set(Math.cos(a) * 0.9, -0.85, Math.sin(a) * 0.9);
      body.add(tip);
    }
    g.add(body);
    g.userData.anim = (now) => {
      for (const [ear, sx] of ears) ear.rotation.z = sx * Math.sin(now / 160) * 0.5;
      body.position.y = Math.sin(now / 420) * 0.35;
      body.rotation.z = Math.sin(now / 700) * 0.12;
      body.scale.y = 1 + Math.sin(now / 210) * 0.04;
    };
    g.scale.setScalar(1.3);
    return g;
  },
  jelly: () => { // a glowing jellyfish, pulsing
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: pick([0x9f7bff, 0x7be0ff, 0xff7bd5]), transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const bell = new THREE.Mesh(new THREE.SphereGeometry(0.8, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), mat);
    g.add(bell);
    const tent = [];
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const t = tube3([Math.cos(a) * 0.55, 0, Math.sin(a) * 0.55], [Math.cos(a) * 0.4, -2.4, Math.sin(a) * 0.4], 0.025, mat);
      g.add(t);
      tent.push(t);
    }
    g.userData.anim = (now, t) => {
      const p = Math.sin(now / 260 + t.s);
      bell.scale.set(1 + p * 0.15, 1 - p * 0.2, 1 + p * 0.15);
      g.position.y += Math.sin(now / 900 + t.s) * 0.6;
    };
    return g;
  },
  seapig: () => { // Scotoplanes: a pink sausage on little legs, wobbling along
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.35, 1, 6, 12), new THREE.MeshStandardMaterial({ color: 0xf2a6b8, emissive: 0x3a1a22, transparent: true, opacity: 0.85 }));
    body.rotation.x = Math.PI / 2;
    body.position.y = 0.45;
    g.add(body);
    for (let k = 0; k < 5; k++) for (const sx of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.3, 6), pmat(0xf2a6b8));
      leg.position.set(sx * 0.22, 0.13, -0.5 + k * 0.25);
      leg.rotation.x = Math.PI;
      g.add(leg);
    }
    for (const sx of [-0.12, 0.12]) { // the "antennae" on top
      g.add(tube3([sx, 0.7, -0.45], [sx * 1.6, 1.15, -0.55], 0.04, pmat(0xf2a6b8)));
    }
    eyes(g, 0.62, -0.78, 0.07, 0.13);
    g.rotation.y = Math.PI; // eyes towards the camera
    g.userData.anim = (now, t) => { body.scale.z = 1 + Math.sin(now / 300 + t.s) * 0.06; g.rotation.z = Math.sin(now / 400 + t.s) * 0.08; };
    g.scale.setScalar(1.6);
    return g;
  },
  angler: () => { // only in the dark: teeth, and a glowing lure that looks just like a nodule
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.7, 14, 10), pmat(0x2a2a30));
    body.scale.set(1, 0.9, 1.2);
    const jaw = new THREE.Mesh(new THREE.SphereGeometry(0.62, 14, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), pmat(0x3a3036));
    jaw.position.set(0, -0.05, 0.25);
    g.add(body, jaw);
    for (let k = 0; k < 9; k++) {
      const a = -0.9 + (k / 8) * 1.8;
      const tooth = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.2, 5), pmat(0xf4f0e0));
      tooth.position.set(Math.sin(a) * 0.55, -0.05, 0.3 + Math.cos(a) * 0.55);
      g.add(tooth);
    }
    eyes(g, 0.25, 0.75, 0.09, 0.3);
    g.add(tube3([0, 0.6, 0.3], [0, 1.4, 1.2], 0.03, pmat(0x2a2a30)));
    const lure = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), new THREE.MeshBasicMaterial({ color: 0xbfffe8 }));
    lure.position.set(0, 1.4, 1.25);
    g.add(lure);
    g.userData.anim = (now) => { lure.scale.setScalar(1 + Math.sin(now / 120) * 0.25); jaw.rotation.x = Math.max(0, Math.sin(now / 500)) * 0.4; };
    g.scale.setScalar(1.6);
    return g;
  },
  // Kaffee und Kuchen: a slice of cake with a strawberry, and a mug of coffee
  cake: () => {
    const g = new THREE.Group();
    const sponge = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 0.45, 16, 1, false, 0, 0.9), pmat(0xf2c66d));
    const cream = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 0.14, 16, 1, false, 0, 0.9), pmat(0xfff6ea));
    cream.position.y = 0.29;
    const berry = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), pmat(0xe0202a));
    berry.position.set(Math.sin(0.45) * 0.5, 0.45, Math.cos(0.45) * 0.5);
    g.add(sponge, cream, berry);
    return g;
  },
  coffee: () => {
    const g = new THREE.Group();
    const mug = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.28, 0.65, 16), pmat(0xffffff));
    const top = new THREE.Mesh(new THREE.CircleGeometry(0.29, 16), pmat(0x4a2a14));
    top.rotation.x = -Math.PI / 2;
    top.position.y = 0.3;
    const handle = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.05, 6, 12), pmat(0xffffff));
    handle.position.x = 0.38;
    g.add(mug, top, handle);
    return g;
  },
  neptune: () => { // for the equator crossing: crown, beard, trident, waving it
    const g = new THREE.Group();
    const SKIN = 0x8fd0b8;
    const robe = new THREE.Mesh(new THREE.ConeGeometry(1.4, 3.2, 14), pmat(0x1d4fa0));
    robe.position.y = 1.6;
    const chest = new THREE.Mesh(new THREE.SphereGeometry(0.75, 14, 10), pmat(SKIN));
    chest.position.y = 3.3;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.5, 14, 10), pmat(SKIN));
    head.position.y = 4.35;
    const beard = new THREE.Mesh(new THREE.ConeGeometry(0.45, 1.2, 10), pmat(0xf4f4f4));
    beard.position.set(0, 3.7, 0.3);
    beard.rotation.x = Math.PI;
    const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.45, 0.3, 12), M.gold);
    crown.position.y = 4.85;
    g.add(robe, chest, head, beard, crown);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.35, 5), M.gold);
      spike.position.set(Math.cos(a) * 0.4, 5.15, Math.sin(a) * 0.4);
      g.add(spike);
    }
    eyes(g, 4.45, 0.42, 0.09, 0.18);
    const arm = new THREE.Group();
    arm.position.set(0.8, 3.6, 0);
    arm.add(tube3([0, 0, 0], [0.5, 1, 0], 0.16, pmat(SKIN)));
    const trident = new THREE.Group();
    trident.position.set(0.5, 1, 0);
    trident.add(tube3([0, -2.5, 0], [0, 2.2, 0], 0.07, M.gold));
    for (const dx of [-0.35, 0, 0.35]) trident.add(tube3([dx, 2.2, 0], [dx, 2.9, 0], 0.06, M.gold));
    trident.add(tube3([-0.35, 2.2, 0], [0.35, 2.2, 0], 0.06, M.gold));
    arm.add(trident);
    g.add(arm);
    g.userData.anim = (now) => { arm.rotation.z = Math.sin(now / 300) * 0.3; };
    g.scale.setScalar(1.6);
    return g;
  },
});
const CREATURES = new Set(["dumbo", "jelly", "seapig", "angler", "neptune", "starfish", "crab", "crinoid", "sponge", "rattail", "tubeworms"]);
function spawnCreature(s) {
  const side = Math.random() < 0.5 ? -1 : 1;
  const r = Math.random();
  if (g.dark > 0.5 && r < 0.2) place("angler", s, side * rand(7, 9), rand(2, 3.5), true);
  else if (r < 0.35) place("jelly", s, rand(-12, 12), rand(8, 12), true);
  else if (r < 0.48) place("seapig", s, side * rand(6.5, 9), 0, true);
  else if (r < 0.58) place("starfish", s, side * rand(6.5, 10), 0, true);
  else if (r < 0.68) place("crab", s, side * rand(6.5, 9), 0, true);
  else if (r < 0.77) place("crinoid", s, side * rand(7, 12), 0, true);
  else if (r < 0.85) place("sponge", s, side * rand(7, 13), 0, true);
  else if (r < 0.93) place("tubeworms", s, side * rand(7, 12), 0, true);
  else place("rattail", s, side * rand(6.5, 8.5), rand(0.8, 1.5), true);
}

// what a run has seen, for the dive report and the high score list
function seen(key) { g.seen[key] = (g.seen[key] || 0) + 1; }
const SEEN = [ // key, icon, label: in this order on the list
  ...FLEET.map((f) => [f.name, f.icon, `${f.name} wreck`]),
  ["bell", "🔔", "ship's bells"], ["ofos", "📷", "OFOS dodged"], ["ofosfly", "📸", "OFOS fly-bys"], ["auv", "🤖", `AUV ${N.auv}`],
  ["jago", "🛟", N.sub], ["picture", "🤳", "in the picture"], ["photobomb", "😎", "photobombs"], ["runner", "🏃", "the developer"],
["dumbo", "🐙", "Dumbo octopus"], ["jelly", "🪼", "jellyfish"], ["seapig", "🐷", "sea pigs"], ["crab", "🦀", "crabs"],
  ["starfish", "🌟", "sea stars"], ["crinoid", "🌸", "sea lilies"], ["sponge", "🏺", "glass sponges"], ["tubeworms", "🪱", "tube worms"], ["rattail", "🐟", "rattails"],
  ["angler", "🎣", "anglerfish"], ["coffee", "☕", "Kaffee & Kuchen"], ["bergfest", "🎉", "Bergfest"], ["equator", "🔱", "equator crossing"],
  ["midnight", "🌑", "midnight zone"], ["corer", "🧪", "corers landing"], ["rider", "🧑‍🔬", "corer riders"], ["egg", "🥚", "egg sculptures"],
  ["dinghy", "🛶", "AUV towing the boat"], ["elevator", "🛗", "ELEVATOR BOI"], ["hooked", "🪝", "hooked by the deck crew"], ["camera", "🎬", "flipped by the film crew"],
  ["pickles", "🫙", "pickle jars filled"], ["toilet", "🚽", "deep-sea toilet"], ["hut", "🏠", "deep-sea lab"], ["smash", "💥", "turbo smashes"], ["dropout", "📺", "video dropouts"], ["plume", "🌫️", "sediment plumes"],
];
function seenList(s, withLabels) {
  return SEEN.filter(([k]) => s?.[k]).map(([k, icon, label]) => (withLabels ? `${icon} ${label}${s[k] > 1 ? ` ×${s[k]}` : ""}` : icon));
}

// ---------- video dropout: static over the picture ----------
const noise = $("static"), noiseCtx = noise.getContext("2d");
noise.width = 160; noise.height = 90;
const noiseImg = noiseCtx.createImageData(160, 90);
function drawNoise() {
  const d = noiseImg.data;
  for (let i = 0; i < d.length; i += 4) { const v = Math.random() * 255; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
  noiseCtx.putImageData(noiseImg, 0, 0);
}

// ---------- Bergfest: lametta raining down ----------
const LN = 360;
const lamPos = new Float32Array(LN * 6), lamCol = new Float32Array(LN * 6), lamSeed = [];
const lamGeom = new THREE.BufferGeometry();
lamGeom.setAttribute("position", new THREE.BufferAttribute(lamPos, 3));
lamGeom.setAttribute("color", new THREE.BufferAttribute(lamCol, 3));
const lametta = new THREE.LineSegments(lamGeom, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }));
lametta.frustumCulled = false;
lametta.visible = false;
scene.add(lametta);
for (let i = 0; i < LN; i++) {
  lamSeed.push([rand(-16, 16), rand(0, 22), rand(-50, 8), rand(0, 6)]);
  _c.setHex(pick([0xe8e8f0, 0xffd34d, 0xff7bd5, 0x7be0ff, 0x9dff7b]));
  lamCol.set([_c.r, _c.g, _c.b, _c.r * 0.6, _c.g * 0.6, _c.b * 0.6], i * 6);
}
function updateLametta(dt, now, y) {
  for (let i = 0; i < LN; i++) {
    const sd = lamSeed[i];
    sd[1] -= dt * 3;
    if (sd[1] < -2) { sd[1] = rand(14, 22); sd[0] = rand(-16, 16); sd[2] = rand(-50, 8); }
    const x = g.x + sd[0] + Math.sin(now / 300 + sd[3]) * 0.4, yy = y + sd[1], z = -g.s + sd[2];
    lamPos.set([x, yy, z, x + Math.sin(now / 200 + sd[3]) * 0.15, yy - 0.9, z], i * 6);
  }
  lamGeom.attributes.position.needsUpdate = true;
}

// ---------- screen effects: flashes, pop-ups, banners, shake ----------
let flashLevel = 0, flashColor = "#fff", shake = 0;
function flash(o, color = "#ffffff") {
  if (o >= flashLevel * 0.6) { flashLevel = Math.max(flashLevel, o); flashColor = color; }
}
const _v = new THREE.Vector3();
function popup(text, wx, wy, wz, color = "#ffb13b", big = false) {
  const box = $("pops");
  if (box.childElementCount > 24) box.firstChild.remove();
  _v.set(wx, wy, wz).project(camera);
  if (_v.z > 1) return;
  const el = document.createElement("div");
  el.className = "pop" + (big ? " big" : "");
  el.textContent = text;
  el.style.color = color;
  el.style.left = `${(_v.x * 0.5 + 0.5) * 100}%`;
  el.style.top = `${(-_v.y * 0.5 + 0.5) * 100}%`;
  box.append(el);
  setTimeout(() => el.remove(), 850);
}
function banner(text, sub = "", color = "#ffb13b") {
  const el = $("banner");
  el.classList.remove("show");
  el.style.color = color;
  el.replaceChildren(text, ...(sub ? [Object.assign(document.createElement("small"), { textContent: sub })] : []));
  void el.offsetWidth;
  el.classList.add("show");
}

// radio chatter from the ship, as subtitles
const CHATTER = [
  "Chief scientist: Could you grab just one more sample?",
  "Bridge: Holding position. Mostly.",
  "Pilot: Who left a sandwich on the console?",
  "Winch: 4,000 m of tether out. No loops, please.",
  "Data manager: The recording is on, right? … RIGHT?",
  "Bridge: Mess says dinner in ten minutes.",
  "Co-pilot: Was that a new species? No time, keep going.",
  "Chief scientist: That nodule looked special. They all look special.",
  "Bridge: Swell is picking up. Enjoy the calm down there.",
  "Navigator: USBL fix lost… and it's back.",
  "Pilot: Copy, slowing down. (Not slowing down.)",
  `Student: Can I drive ${N.rov} next?`,
  "Bridge: Pilots, shift change in 5. Somebody wake up the next watch.",
  "Data manager: Who unplugged the DSHIP server? Again?",
  "Co-pilot: Coffee machine in the control van is broken. This is an emergency.",
  "Chief scientist: Please log that in the dive protocol. All of it.",
  "Bridge: Sunday tomorrow: Fischbrötchen at breakfast.",
  "Winch: Tether's twisted. Could you do one loop the other way? Thanks.",
  "Bridge: Kaffee ist fertig.",
  "Chief scientist: Please stay out of my study area. All of it.",
  "Co-pilot: Manipulator is parked. Probably.",
  "Bridge: Someone took the last Franzbrötchen.",
];
function radio(text) {
  const el = $("radio");
  el.classList.remove("show");
  el.textContent = text;
  void el.offsetWidth;
  el.classList.add("show");
  if (!muted) tone(1800, 0.05, { type: "square", gain: 0.03 });
}

// ---------- sound (tiny synth, no files) ----------
// One AudioContext, created and resumed inside a tap/click/key: iPhones only allow sound then.
// iOS also mutes web audio with the ring/silent switch on, unless the page says it plays media
// (navigator.audioSession, iOS 17+; older: a silent looping <audio>, which does the same).
let audio = null, master = null, sfxBus = null, musicBus = null, silentLoop = null;
let muted = store.get("deeprun.muted") === "1";
function ensureAudio() {
  if (audio) return audio;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch { /* older Safari */ }
  audio = new AC();
  master = audio.createGain();
  master.gain.value = muted ? 0 : 1;
  master.connect(audio.destination);
  sfxBus = audio.createGain();
  sfxBus.connect(master);
  musicBus = audio.createGain();
  musicBus.gain.value = music.on ? 1 : 0;
  musicBus.connect(master);
  return audio;
}
function silentWav() { // 0.5 s of silence as a WAV file, made here
  const n = 4000, b = new DataView(new ArrayBuffer(44 + n * 2));
  const str = (o, t) => [...t].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); b.setUint32(4, 36 + n * 2, true); str(8, "WAVEfmt "); b.setUint32(16, 16, true); b.setUint16(20, 1, true);
  b.setUint16(22, 1, true); b.setUint32(24, 8000, true); b.setUint32(28, 16000, true); b.setUint16(32, 2, true); b.setUint16(34, 16, true);
  str(36, "data"); b.setUint32(40, n * 2, true);
  return URL.createObjectURL(new Blob([b], { type: "audio/wav" }));
}
function unlockAudio() {
  const a = ensureAudio();
  if (!a) return;
  if (a.state !== "running") {
    a.resume().catch(() => {});
    const src = a.createBufferSource(); // a tiny silent sound, played inside the gesture
    src.buffer = a.createBuffer(1, 1, 22050);
    src.connect(a.destination);
    src.start(0);
  }
  if (!navigator.audioSession && !silentLoop && /iPhone|iPad|iPod/.test(navigator.userAgent)) {
    silentLoop = new Audio(silentWav());
    silentLoop.loop = true;
    silentLoop.setAttribute("playsinline", "");
    silentLoop.play().catch(() => {});
  }
  music.start();
}
for (const ev of ["touchend", "pointerdown", "keydown", "click"]) window.addEventListener(ev, unlockAudio, { passive: true });
function tone(freq, dur, { type = "sine", gain = 0.12, slide = 0, delay = 0 } = {}) {
  if (muted || !audio || audio.state !== "running") return;
  try {
    const t = audio.currentTime + delay;
    const o = audio.createOscillator(), gn = audio.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), t + dur);
    gn.gain.setValueAtTime(gain, t);
    gn.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(gn).connect(sfxBus);
    o.start(t); o.stop(t + dur + 0.02);
  } catch { /* no audio */ }
}
const sfx = {
  nodule: (combo) => tone(880 * 2 ** (Math.min(combo, 24) / 24), 0.09, { type: "triangle", slide: 1.5 }), // rises with the combo
  tube: () => [660, 880, 1320, 1760].forEach((f, i) => tone(f, 0.12, { type: "triangle", delay: i * 0.05 })),
  power: () => [440, 660, 990, 1320].forEach((f, i) => tone(f, 0.2, { type: "square", gain: 0.06, delay: i * 0.05 })),
  move: () => tone(300, 0.06, { type: "sine", gain: 0.05, slide: 1.6 }),
  bonus: () => { tone(1200, 0.08, { type: "square", gain: 0.05 }); tone(1600, 0.1, { type: "square", gain: 0.05, delay: 0.06 }); },
  combo: () => [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, 0.16, { type: "triangle", gain: 0.1, delay: i * 0.045 })),
  smash: () => { tone(220, 0.25, { type: "sawtooth", gain: 0.15, slide: 0.3 }); tone(900, 0.12, { type: "square", gain: 0.06, slide: 0.5 }); },
  crash: () => { tone(160, 0.6, { type: "sawtooth", gain: 0.2, slide: 0.25 }); tone(90, 0.8, { type: "square", gain: 0.12, slide: 0.4 }); },
  shieldHit: () => tone(520, 0.3, { type: "square", gain: 0.1, slide: 0.5 }),
  bell: () => [0, 0.5, 1].forEach((d) => { tone(1046, 1.2, { type: "sine", gain: 0.14, delay: d * 0.5 }); tone(2093, 0.8, { type: "sine", gain: 0.05, delay: d * 0.5 }); }),
  dark: () => tone(110, 2.2, { type: "sine", gain: 0.18, slide: 0.5 }),
};

// ---------- music: an ambient underwater bed, and an action loop that builds up with the speed ----------
// All synthesized: a drone with slowly moving filter, water rumble, sonar pings and the odd whale;
// over it, while diving, 4 bars in A minor (Am F C G): it gets more layers and a faster tempo the
// further the dive goes (MUSIC_LEVELS), speeds up with the ROV and even more in turbo;
// muffled in the dark and in wrecks.
const MUSIC_LEVELS = [0, 150, 500, 1100, 1900, 2900, 4200]; // m: each one adds a layer and tempo
const LEAD = [ // melody, semitones from A4 per 16th (null: rest), one row per bar
  [12, null, null, 10, null, 7, null, null, 8, null, 7, null, 3, null, 5, null],
  [8, null, null, 7, null, 5, null, null, 3, null, 5, null, 7, null, null, null],
  [7, null, null, 8, null, 10, null, null, 12, null, 10, null, 7, null, 3, null],
  [10, null, null, 7, null, 5, null, 2, null, null, 3, null, null, 2, null, null],
];
const music = {
  level: 0, bpm: 120, turbo: false,
  on: store.get("deeprun.music") !== "0",
  started: false, step: 0, next: 0, timer: 0, nextPing: 0, nextWhale: 0, noise: null,
  action: null, filter: null, ambient: null, layers: {},
  start() {
    if (this.started || !audio) return;
    this.started = true;
    const a = audio;
    const N = a.sampleRate * 2, buf = a.createBuffer(1, N, a.sampleRate), d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < N; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } // brown noise
    const white = a.createBuffer(1, N, a.sampleRate), wd = white.getChannelData(0);
    for (let i = 0; i < N; i++) wd[i] = Math.random() * 2 - 1;
    this.noise = white;
    // ambient bed
    this.ambient = a.createGain();
    this.ambient.gain.value = 0.55;
    this.ambient.connect(musicBus);
    const lp = a.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 380; lp.Q.value = 3;
    lp.connect(this.ambient);
    const lfo = a.createOscillator(), lfoG = a.createGain();
    lfo.frequency.value = 0.06; lfoG.gain.value = 220;
    lfo.connect(lfoG).connect(lp.frequency);
    lfo.start();
    for (const [f, type, gain, det] of [[55, "sine", 0.32, 0], [82.4, "sine", 0.18, 4], [110, "triangle", 0.07, -7], [164.8, "sine", 0.04, 3]]) {
      const o = a.createOscillator(), gn = a.createGain();
      o.type = type; o.frequency.value = f; o.detune.value = det; gn.gain.value = gain;
      o.connect(gn).connect(lp);
      o.start();
    }
    const water = a.createBufferSource(), wlp = a.createBiquadFilter(), wg = a.createGain();
    water.buffer = buf; water.loop = true;
    wlp.type = "lowpass"; wlp.frequency.value = 420;
    wg.gain.value = 0.22;
    water.connect(wlp).connect(wg).connect(this.ambient);
    water.start();
    this.echo = a.createDelay(1);
    this.echo.delayTime.value = 0.42;
    const fb = a.createGain();
    fb.gain.value = 0.38;
    this.echo.connect(fb).connect(this.echo);
    this.echo.connect(this.ambient);
    // action loop: its own bus, through a filter (muffled in the dark and in wrecks)
    this.filter = a.createBiquadFilter();
    this.filter.type = "lowpass"; this.filter.frequency.value = 16000; this.filter.Q.value = 0.7;
    this.action = a.createGain();
    this.action.gain.value = 0;
    this.filter.connect(this.action).connect(musicBus);
    for (const k of ["kick", "bass", "hat", "clap", "arp", "pad", "lead", "drive", "fill"]) {
      const gn = a.createGain();
      gn.gain.value = 0;
      gn.connect(this.filter);
      this.layers[k] = gn;
    }
    this.arpEcho = a.createDelay(1);
    this.arpEcho.delayTime.value = (60 / 124) * 0.75;
    const afb = a.createGain();
    afb.gain.value = 0.3;
    this.arpEcho.connect(afb).connect(this.arpEcho);
    this.arpEcho.connect(this.layers.arp);
    this.leadEcho = a.createDelay(1);
    this.leadEcho.delayTime.value = (60 / 124) * 0.5;
    const lfb = a.createGain();
    lfb.gain.value = 0.25;
    this.leadEcho.connect(lfb).connect(this.leadEcho);
    this.leadEcho.connect(this.layers.lead);
    this.next = a.currentTime + 0.1;
    this.nextPing = a.currentTime + 3;
    this.nextWhale = a.currentTime + 14;
    this.timer = setInterval(() => this.tick(), 50);
  },
  set(param, v, time = 0.4) { param.setTargetAtTime(v, audio.currentTime, time); },
  mix() { // what plays now, from the game's state
    const running = g.state === "run";
    const speed = clamp((g.v - V0) / (VMAX - V0), 0, 1), turbo = g.turbo > 0, party = g.party > 0;
    this.set(this.action.gain, running ? 0.5 : 0, running ? 0.6 : 0.25);
    this.set(this.ambient.gain, running ? 0.4 : 0.6, 1.5);
    const L = this.layers;
    let level = 0; // the further the dive, the more is going on
    while (level < MUSIC_LEVELS.length - 1 && g.s >= MUSIC_LEVELS[level + 1]) level++;
    if (!running) level = 0;
    if (level > this.level) this.levelUp(audio.currentTime);
    this.level = level;
    this.turbo = turbo;
    const lv = level + (turbo || party ? 2 : 0); // turbo and Bergfest: two levels on top
    // tempo: 120 bpm at the start, +5 per level, +12 with full speed, +14 in turbo (glides there)
    const target = Math.min(184, 120 + 5 * level + 12 * speed + (turbo ? 14 : 0) + (party ? 6 : 0));
    this.bpm += (target - this.bpm) * (target > this.bpm ? 0.08 : 0.03);
    const beat = 60 / this.bpm;
    this.set(this.arpEcho.delayTime, beat * 0.75, 0.2);
    this.set(this.leadEcho.delayTime, beat * 0.5, 0.2);
    this.set(L.kick.gain, 1);
    this.set(L.bass.gain, 0.85);
    this.set(L.clap.gain, lv >= 1 ? 0.7 : 0);
    this.set(L.hat.gain, lv >= 2 || speed > 0.3 ? 0.6 : 0);
    this.set(L.fill.gain, lv >= 2 ? 0.6 : 0);
    this.set(L.arp.gain, lv >= 3 || g.combo >= 20 ? 0.5 : 0);
    this.set(L.lead.gain, lv >= 4 ? 0.55 : 0);
    this.set(L.drive.gain, lv >= 5 ? 0.5 : 0);
    this.set(L.pad.gain, g.dark > 0.5 || g.wreck ? 0.5 : 0.2);
    const inWreck = g.wreck && g.s > g.wreck.s0 - 5 && g.s < g.wreck.s0 + WRECK_L + 5;
    this.set(this.filter.frequency, inWreck ? 900 : g.dark > 0.5 ? 3200 : 16000, 0.3);
  },
  tick() {
    if (!audio || audio.state !== "running") return;
    const a = audio, now = a.currentTime;
    this.mix();
    if (now > this.nextPing) { this.ping(now); this.nextPing = now + rand(7, 13); }
    if (now > this.nextWhale) { this.whale(now); this.nextWhale = now + rand(25, 45); }
    if (g.state !== "run") { this.next = now + 0.05; return; } // the loop waits for the dive
    while (this.next < now + 0.15) {
      this.play(this.step, this.next);
      this.next += 60 / this.bpm / 4;
      this.step = (this.step + 1) % 64;
    }
  },
  osc(type, f, t, dur, gain, dest, { slide = 0, cutoff = 0, q = 1 } = {}) {
    const a = audio, o = a.createOscillator(), gn = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
    gn.gain.setValueAtTime(0.0001, t);
    gn.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    gn.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = o.connect(gn);
    if (cutoff) { const f2 = a.createBiquadFilter(); f2.type = "lowpass"; f2.frequency.setValueAtTime(cutoff, t); f2.frequency.exponentialRampToValueAtTime(Math.max(80, cutoff / 4), t + dur); f2.Q.value = q; node = node.connect(f2); }
    node.connect(dest);
    o.start(t); o.stop(t + dur + 0.05);
  },
  hit(t, dur, gain, dest, type, freq) { // noise burst: hats and claps
    const a = audio, src = a.createBufferSource(), f = a.createBiquadFilter(), gn = a.createGain();
    src.buffer = this.noise;
    f.type = type; f.frequency.value = freq; f.Q.value = type === "bandpass" ? 1.2 : 0.7;
    gn.gain.setValueAtTime(gain, t);
    gn.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(gn).connect(dest);
    src.start(t, Math.random()); src.stop(t + dur + 0.02);
  },
  play(step, t) {
    const L = this.layers, bar = Math.floor(step / 16), s = step % 16;
    const ROOT = [110, 87.31, 130.81, 98][bar]; // A, F, C, G
    const MINOR = bar === 0; // Am; the others major
    if (s % 4 === 0) this.osc("sine", 150, t, 0.22, 0.9, L.kick, { slide: 42 });
    if ([0, 3, 6, 8, 11, 14].includes(s)) this.osc("sawtooth", ROOT * (s === 6 || s === 14 ? 2 : 1), t, 0.2, 0.32, L.bass, { cutoff: 900, q: 6 });
    const lv = this.level + (this.turbo ? 2 : 0);
    if (s % 2 === 1 || s % 4 === 2 || lv >= 5) this.hit(t, s % 4 === 2 ? 0.07 : 0.035, s % 4 === 2 ? 0.22 : s % 2 ? 0.12 : 0.07, L.hat, "highpass", 7500); // 16ths from level 5
    if (lv >= 6 && (s === 7 || s === 15)) this.osc("sine", 150, t, 0.16, 0.6, L.kick, { slide: 42 }); // kick pickups
    if (step === 0 && lv >= 2) this.hit(t, 1.4, 0.25, L.fill, "highpass", 4500); // crash at the top of the loop
    if (step >= 60 && lv >= 2) this.hit(t, 0.1, 0.18 + (step - 60) * 0.1, L.fill, "bandpass", 1800 + (step - 60) * 300); // snare fill
    if (step >= 56 && step < 60 && lv >= 6) this.hit(t, 0.08, 0.15, L.fill, "bandpass", 1500);
    if (this.turbo && s % 2 === 0) this.osc("sawtooth", ROOT * 2, t, 0.09, 0.12, L.drive, { cutoff: 2400, q: 4 }); // turbo: 8th-note octave bass
    if (s === 4 || s === 12) this.hit(t, 0.18, 0.5, L.clap, "bandpass", 1600);
    const chord = [1, MINOR ? 1.189 : 1.26, 1.498, 2]; // root, third, fifth, octave
    { // arpeggio (its layer gain decides if it's heard)
      const order = [0, 1, 2, 3, 2, 1, 2, 3];
      const f = ROOT * 4 * chord[order[s % 8]];
      this.osc("square", f, t, 0.11, 0.09, this.arpEcho, { cutoff: 3200, q: 2 });
      this.osc("square", f, t, 0.11, 0.09, L.arp, { cutoff: 3200, q: 2 });
    }
    if (s === 0) for (const k of chord.slice(0, 3)) { // pad: a soft chord for the whole bar
      for (const det of [-8, 8]) {
        const a = audio, o = a.createOscillator(), gn = a.createGain(), f = a.createBiquadFilter();
        o.type = "sawtooth"; o.frequency.value = ROOT * 2 * k; o.detune.value = det;
        f.type = "lowpass"; f.frequency.value = 900;
        const dur = (60 / this.bpm) * 4;
        gn.gain.setValueAtTime(0.0001, t);
        gn.gain.linearRampToValueAtTime(0.035, t + 0.4);
        gn.gain.linearRampToValueAtTime(0.0001, t + dur);
        o.connect(f).connect(gn).connect(L.pad);
        o.start(t); o.stop(t + dur + 0.05);
      }
    }
    const note = LEAD[bar][s]; // melody from level 4
    if (note !== null && lv >= 4) {
      const f = 440 * 2 ** (note / 12), len = (60 / this.bpm) * 0.5;
      this.osc("square", f, t, len, 0.07, L.lead, { cutoff: 4200, q: 1 });
      this.osc("triangle", f * 2, t, len, 0.05, this.leadEcho);
    }
    if (lv >= 5 && (s % 4 === 2)) for (const k of chord.slice(0, 3)) this.osc("sawtooth", ROOT * 4 * k, t, 0.12, 0.05, L.drive, { cutoff: 5000, q: 3 }); // offbeat stabs
  },
  levelUp(t) { // a whoosh up into the new level
    const a = audio, src = a.createBufferSource(), f = a.createBiquadFilter(), gn = a.createGain();
    src.buffer = this.noise;
    f.type = "bandpass"; f.Q.value = 2;
    f.frequency.setValueAtTime(400, t);
    f.frequency.exponentialRampToValueAtTime(9000, t + 1.4);
    gn.gain.setValueAtTime(0.0001, t);
    gn.gain.exponentialRampToValueAtTime(0.28, t + 1.3);
    gn.gain.exponentialRampToValueAtTime(0.0001, t + 1.5);
    src.connect(f).connect(gn).connect(this.action);
    src.start(t); src.stop(t + 1.55);
  },
  ping(t) { // sonar: a clean ping with its echoes
    this.osc("sine", 1318, t, 0.5, 0.12, this.echo);
    this.osc("sine", 1318, t, 0.5, 0.06, this.ambient);
  },
  whale(t) { // far away, something big sings
    const a = audio, o = a.createOscillator(), gn = a.createGain(), f = a.createBiquadFilter();
    o.type = "sine";
    o.frequency.setValueAtTime(rand(220, 320), t);
    o.frequency.exponentialRampToValueAtTime(rand(140, 190), t + 2.2);
    o.frequency.exponentialRampToValueAtTime(rand(200, 260), t + 3.4);
    f.type = "lowpass"; f.frequency.value = 600;
    gn.gain.setValueAtTime(0.0001, t);
    gn.gain.exponentialRampToValueAtTime(0.09, t + 0.8);
    gn.gain.exponentialRampToValueAtTime(0.0001, t + 3.6);
    o.connect(f).connect(gn).connect(this.echo);
    o.start(t); o.stop(t + 3.7);
  },
};
function toggleMusic() {
  music.on = !music.on;
  store.set("deeprun.music", music.on ? "1" : "0");
  $("music").classList.toggle("off", !music.on);
  if (musicBus) musicBus.gain.setTargetAtTime(music.on ? 1 : 0, audio.currentTime, 0.1);
}

// ---------- game state ----------
const g = {
  state: "loading", // loading | ready | run | crash | over | paused
  floor: new Seafloor(), s: 0, v: V0, lane: 1, x: 0, alt: ALT, altTarget: ALT, move: 0,
  score: 0, items: 0, mult: 1, magnet: 0, shield: false, turbo: 0, crashT: 0, why: "",
  combo: 0, comboT: 0, bestCombo: 0, milestone: 1000,
  dark: 0, darkSaid: false, wreck: null, wreckAt: WRECK_AT, nextOfos: 0, chat: 0, nextFly: 0,
  passedN: 0, seen: {}, flip: 0, diveT: 0, reported: false, cukes: 0, nextHooks: rand(450, 800), devAt: 0, nextDumbo: 0, coffeeAt: 0, bergAt: 0, eqAt: 0, eq: null, party: 0, drop: 0, nextDrop: 0, plume: 0, plumeK: 0, nextPlume: 0,
};
let best = Number(store.get("deeprun.best")) || 0;
$("best").textContent = best.toLocaleString("en");
$("mute").textContent = muted ? "🔇" : "🔊";
let saved = true; // the last run's score is on the list (or was not worth saving)

async function newRun() {
  g.state = "loading";
  $("play").disabled = true;
  $("play").textContent = "Loading the seafloor…";
  const floor = new Seafloor();
  await floor.load();
  for (const t of things) if (!t.gone) release(t);
  things.length = 0;
  Object.assign(g, { floor, s: 0, v: V0, lane: 1, x: 0, alt: ALT, altTarget: ALT, move: 0, score: 0, items: 0, mult: 1,
    magnet: 0, shield: false, turbo: 0, crashT: 0, combo: 0, comboT: 0, bestCombo: 0, milestone: 1000,
    dark: 0, darkSaid: false, wreck: null, wreckAt: WRECK_AT, nextOfos: rand(600, 1300), chat: rand(10, 18),
    nextFly: rand(250, 500), passedN: 0, seen: {}, flip: 0, diveT: 0, reported: false, cukes: 0, nextHooks: rand(450, 800), eggAt: rand(EGG_AT[0], EGG_AT[1]), devAt: 0, nextDumbo: rand(180, 400),
    coffeeAt: rand(1300, 2300), bergAt: rand(2400, 3300), eqAt: rand(3800, 5000), eq: null, party: 0, drop: 0, nextDrop: rand(35, 70), plume: 0, plumeK: 0, nextPlume: rand(PLUME_FIRST[0], PLUME_FIRST[1]) });
  let dev = rand(DEV_AT[0], DEV_AT[1]); // the developer: not at the same time as Bergfest
  if (Math.abs(dev - g.bergAt) < 400) dev = g.bergAt + (dev < g.bergAt ? -400 : 400);
  g.devAt = dev;
  endFly();
  if (runner) { runner = null; runnerObj.visible = false; }
  if (eqLine) eqLine.visible = false;
  canvas.classList.remove("flip");
  lametta.visible = false;
  $("dropout").hidden = true;
  for (const w of Object.values(wrecks)) w.visible = false;
  nextDecor = 30;
  chunks.forEach((ch, k) => { ch.start = (k - 1) * CHUNK; buildChunk(ch, floor); });
  nextSpawn = 80;
  coinLine(20, 1, 10);
  $("floor").textContent = `Seafloor: ${floor.name}`;
  rov.rotation.set(0, 0, 0);
  jarHud(); // empty jar
  g.state = "ready";
  window.deeprunOk = true; // loaded: game.html's startup check stops waiting
  $("play").disabled = false;
  $("play").textContent = "Dive!";
}

async function start() {
  if (g.state !== "ready") return;
  if (!saved) await saveScore();
  $("start").hidden = true;
  $("over").hidden = true;
  if (gallery.items.length) { clearGallery(); gallery.renderer.setScissor(0, 0, gallery.w, gallery.h); gallery.renderer.clear(); }
  g.state = "run";
  unlockAudio(); // inside the tap: iPhones allow sound from here on
  banner("GO!", g.floor.name, "#4fe3ff");
  setTimeout(() => radio(pick([`Pilot: ${N.rov} is out of the garage. Let's go.`, `Bridge: ${N.rov}, you have the seafloor.`, "Chief scientist: Good luck, and please don't break anything.", `Winch: Tether is paying out. ${N.rov}, off you go.`])), 1200);
  flash(0.35, "#4fe3ff");
}

function steer(d) {
  if (g.state !== "run") return;
  const lane = clamp(g.lane + d, 0, 2);
  if (lane !== g.lane) { g.lane = lane; sfx.move(); }
}
function vertical(target) {
  if (g.state !== "run") return;
  g.altTarget = target;
  g.move = MOVE_TIME;
  sfx.move();
}

function crash(why) {
  if (g.shield) {
    g.shield = false;
    sfx.shieldHit();
    flash(0.6, "#4fe3ff");
    shake = 0.6;
    burst(rov.position.x, rov.position.y, rov.position.z, 0x4fe3ff, 80, 14);
    popup("SHIELD!", rov.position.x, rov.position.y + 2, rov.position.z, "#4fe3ff", true);
    return false;
  }
  g.state = "crash";
  g.crashT = 0;
  g.why = why;
  sfx.crash();
  flash(0.9, "#ff3b1f");
  shake = 1.2;
  burst(rov.position.x, rov.position.y, rov.position.z, 0xff7a1a, 140, 16, 4);
  return true;
}

function gameOver() {
  g.state = "over";
  const score = Math.floor(g.score);
  const isBest = score > best;
  if (isBest) { best = score; store.set("deeprun.best", String(best)); $("best").textContent = best.toLocaleString("en"); }
  $("why").textContent = g.why;
  $("final").textContent = score.toLocaleString("en");
  $("newbest").hidden = !isBest;
  $("stats").textContent = `${Math.floor(g.s).toLocaleString("en")} m · ${g.items} collected · ${g.passedN} obstacles passed · best combo ${g.bestCombo} · ${g.floor.name}`;
  const list = seenList(g.seen, true);
  $("seen").textContent = list.length ? `Dive report: ${list.join(" · ")}` : "";
  buildGallery(g.seen);
  $("dropout").hidden = true;
  last_run = { score, distance: Math.floor(g.s), items: g.items, seafloor: g.floor.name.slice(0, 100), passed: g.passedN, seen: { ...g.seen } };
  reportRun(g.why); // every run counts on the stats page
  saved = score <= 0;
  $("name-row").hidden = saved;
  $("save").disabled = false;
  $("save").textContent = "Save score";
  $("over").hidden = false;
  loadBoard($("board2"));
  newRun(); // the next seafloor loads while the result is shown
}
let last_run = null;
// Every run is recorded in this browser for the stats page (stats.html): finished ones, and
// ones left mid-dive (tab closed, reload, link).
function reportRun(why) {
  if (g.reported) return;
  g.reported = true;
  recordRun({ time: new Date().toISOString(), score: Math.floor(g.score), distance: Math.floor(g.s), items: g.items,
    seafloor: g.floor.name.slice(0, 100), passed: g.passedN, seen: { ...g.seen }, seconds: Math.round(g.diveT * 10) / 10,
    why: why.slice(0, 200), name: ($("name").value.trim() || store.get("deeprun.name") || "").slice(0, 40) });
}
addEventListener("pagehide", () => { // leaving in the middle of a dive
  if ((g.state === "run" || g.state === "paused" || g.state === "crash") && g.s > 1) reportRun("Left the game mid-dive.");
});
async function saveScore() {
  if (saved || !last_run) return;
  saved = true;
  const name = $("name").value.trim();
  store.set("deeprun.name", name);
  $("save").disabled = true;
  $("save").textContent = "Saving…";
  try {
    const r = addScore({ ...last_run, name: name || "Anonymous" });
    nameLastRun(name);
    board($("board2"), r.top, r.rank);
    $("save").textContent = r.rank ? `Saved: #${r.rank}` : "Saved";
  } catch (e) {
    saved = false;
    $("save").disabled = false;
    $("save").textContent = "Save score";
    $("stats").textContent += ` · not saved: ${e.message}`;
  }
}

function board(el, top, rank = null) {
  if (!top) { el.replaceChildren(); return; }
  const rows = top.map((r, i) => {
    const tr = document.createElement("tr");
    if (rank === i + 1) tr.className = "me";
    const icons = seenList(r.seen, false).join(""), labels = seenList(r.seen, true).join("\n");
    for (const [text, cls] of [[`${i + 1}`, "n"], [r.name, "who"], [r.score.toLocaleString("en"), "n"], [`${(r.distance || 0).toLocaleString("en")} m`, "n"],
      [`${r.passed ?? "–"}`, "n"], [icons, "seen"]]) {
      const td = document.createElement("td");
      td.textContent = text;
      if (cls) td.className = cls;
      if (cls === "seen") td.title = labels;
      if (cls === "who" && icons) { // phones: the icons go in one line under the name (no Seen column)
        const mini = Object.assign(document.createElement("div"), { className: "mini", textContent: icons, title: labels });
        td.append(mini);
      }
      tr.append(td);
    }
    return tr;
  });
  const table = document.createElement("table");
  const head = document.createElement("tr");
  for (const [t, short, c] of [["#", "#", "n"], ["High scores", "High scores", "who"], ["Score", "Score", "n"], ["Distance", "Dist.", "n"], ["Passed", "Pass", "n"], ["Seen", "", "seen"]]) {
    const th = document.createElement("th");
    th.append(Object.assign(document.createElement("span"), { className: "long", textContent: t }),
      Object.assign(document.createElement("span"), { className: "short", textContent: short }));
    if (c) th.className = c;
    if (t === "Passed") th.title = "obstacles passed";
    head.append(th);
  }
  table.append(head, ...rows);
  if (!rows.length) {
    const tr = document.createElement("tr"), td = document.createElement("td");
    td.colSpan = 6; td.textContent = "No scores on this device yet."; td.style.color = "var(--dim)";
    tr.append(td); table.append(tr);
  }
  el.replaceChildren(table);
  const me = el.querySelector("tr.me"); // your place, in the middle of the scroll box
  if (me) el.scrollTop = me.offsetTop - el.clientHeight / 2;
}
function loadBoard(el) {
  try { board(el, topScores()); } catch { board(el, null); }
}

function setPaused(on) {
  if (on && g.state === "run") { g.state = "paused"; $("paused").hidden = false; }
  else if (!on && g.state === "paused") { g.state = "run"; $("paused").hidden = true; last = performance.now(); }
}

// ---------- scoring ----------
function addPoints(base, t, color) {
  const pts = Math.round(base * g.mult * (1 + Math.floor(g.combo / 10) * 0.5) * (g.party > 0 ? 2 : 1));
  g.score += pts;
  popup(`+${pts}`, t.x, floorY(t) + t.alt + 1, -t.s, color);
  bump();
  return pts;
}
const floorY = (t) => g.floor.h(t.s, t.x);
function collect(t) {
  const x = t.x, y = floorY(t) + t.alt, z = -t.s;
  if (t.type in VALUE) {
    g.combo++; g.comboT = COMBO_TIME; g.items++;
    g.bestCombo = Math.max(g.bestCombo, g.combo);
    if (t.type === "bell") {
      addPoints(VALUE.bell, t, "#ffd34d");
      const ship = g.wreck?.ship.name || FLEET[0].name;
      banner("SHIP'S BELL!", `a piece of the ${ship}`, "#ffd34d");
      flash(0.75, "#ffd34d");
      shake = Math.max(shake, 0.5);
      burst(x, y, z, 0xffd34d, 160, 18, 3);
      sfx.bell();
      seen("bell");
      radio(`Chief scientist: Is that… the ship's bell of the ${ship}? The museum will love this.`);
      return;
    }
    if (t.type === "cucumber") {
      g.cukes++;
      addPoints(VALUE.cucumber, t, "#9be05a");
      burst(x, y, z, 0x9be05a, 40, 9);
      flash(0.2, "#9be05a");
      popup(`🥒 ${g.cukes}/${JAR}`, x, y + 1.6, z, "#9be05a");
      tone(520, 0.08, { type: "sine", gain: 0.12, slide: 1.6 }); // plop
      tone(780, 0.1, { type: "triangle", gain: 0.06, delay: 0.06 });
      jarHud(true);
      if (g.cukes >= JAR) jarFull();
      else if (g.cukes === 1 && !g.seen.pickles && Math.random() < 0.5) radio(pick(["Biologist: Into the jar with it. For science.", "Chief scientist: Sea cucumbers! Seven of them and we have lunch.", "Biologist: Sea pigs are sea cucumbers too, by the way. Don't tell them."]));
      return;
    }
    if (t.type === "cake" || t.type === "coffee") {
      addPoints(VALUE[t.type], t, "#ffe0b0");
      burst(x, y, z, t.type === "cake" ? 0xfff6ea : 0x8a5a2a, 40, 9);
      flash(0.2, "#ffe0b0");
      sfx.tube();
      return;
    }
    const tube = t.type === "tube";
    addPoints(VALUE[t.type], t, tube ? "#4fe3ff" : "#ffb13b");
    burst(x, y, z, COLOR[t.type], tube ? 60 : 22, tube ? 12 : 8);
    flash(tube ? 0.45 : 0.1 + Math.min(0.15, g.combo * 0.006), tube ? "#4fe3ff" : "#ffb13b");
    if (tube) { sfx.tube(); shake = Math.max(shake, 0.25); } else sfx.nodule(g.combo);
    if (g.combo % 10 === 0) {
      banner(`COMBO ${g.combo}`, `points ×${1 + Math.floor(g.combo / 10) * 0.5}`, "#ffb13b");
      flash(0.55, "#ffd27a");
      burst(rov.position.x, rov.position.y, rov.position.z, 0xffd27a, 120, 18);
      sfx.combo();
    }
  } else {
    sfx.power();
    burst(x, y, z, COLOR[t.type], 90, 15);
    flash(0.55, `#${COLOR[t.type].toString(16).padStart(6, "0")}`);
    if (t.type === "magnet") { g.magnet = MAGNET_S; banner("MAGNET", "nodules come to you", "#d38cff"); }
    else if (t.type === "shield") { g.shield = true; banner("SHIELD", "one free hit", "#4fe3ff"); }
    else { g.turbo = TURBO_S; banner("TURBO!", "smash through everything", "#ff7a1a"); shake = 0.5; }
  }
}
// ---------- the pickle jar: seven sea cucumbers fill it, then it rains cucumbers ----------
function jarHud(pop = false) {
  const el = $("jar");
  el.hidden = g.cukes === 0;
  el.querySelector(".fill").style.height = `${(100 * g.cukes) / JAR}%`;
  el.querySelector(".n").textContent = `${g.cukes}/${JAR}`;
  if (pop) { el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump"); }
}
function jarFull() {
  g.cukes = 0;
  addPoints(JAR_BONUS, { x: g.x, s: g.s, alt: g.alt + 2.5 }, "#9be05a");
  banner("PICKLE JAR FULL!", `${JAR} sea cucumbers · bonus`, "#9be05a");
  flash(0.6, "#b8f070");
  shake = Math.max(shake, 0.4);
  burst(rov.position.x, rov.position.y, rov.position.z, 0x9be05a, 160, 18, 3);
  [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, 0.14, { type: "triangle", gain: 0.1, delay: i * 0.07 })); // ta-da
  tone(180, 0.12, { type: "square", gain: 0.06, slide: 3, delay: 0.42 }); // the lid: pop
  seen("pickles");
  radio(pick(["Chief scientist: A full jar of sea cucumbers. Dinner is sorted.", "Cook: Pickled sea cucumbers again? Fine.", "Biologist: Seven! That's a sample size.", "Bridge: It's raining cucumbers. Log it."]));
  cucumberRain();
  jarHud();
}
function cucumberRain() { // a few seconds of cucumbers falling over the screen
  const box = $("rain");
  const n = window.innerWidth < 600 ? 40 : 70;
  for (let k = 0; k < n; k++) {
    const c = document.createElement("span");
    c.textContent = Math.random() < 0.12 ? "🫙" : "🥒";
    c.style.left = `${rand(-3, 100)}%`;
    c.style.fontSize = `${rand(22, 48)}px`;
    c.style.animationDuration = `${rand(1.6, 3)}s`;
    c.style.animationDelay = `${rand(0, 1.6)}s`;
    c.style.setProperty("--spin", `${rand(-540, 540)}deg`);
    c.style.setProperty("--drift", `${rand(-60, 60)}px`);
    box.append(c);
    c.addEventListener("animationend", () => c.remove());
  }
}

function passed(t) { // an obstacle went by: bonus for clearing it closely
  const dx = Math.abs(t.x - g.x);
  if (g.turbo > 0) return;
  if (t.type === "ofos") {
    seen("ofos");
    if (dx < 5.5) {
      seen("photobomb");
      sfx.combo();
      addPoints(100, { ...t, alt: 4 }, "#ffffff");
      popup("PHOTOBOMB!", t.x, floorY(t) + 6, -t.s, "#ffffff", true);
      flash(0.5, "#ffffff");
      radio(pick(["OFOS team: Was that the ROV in our picture?!", "OFOS team: Great, now we have 300 photos of an ROV.", "Bridge: Nice wave to the OFOS camera."]));
    }
    return;
  }
  if (dx < 2.2 && !BLOCK.has(t.type)) {
    const what = OVER.has(t.type) ? "OVER!" : "UNDER!";
    sfx.bonus();
    addPoints(30, { ...t, alt: 3 }, "#7dff9a");
    popup(what, t.x, floorY(t) + 6, -t.s, "#7dff9a", true);
    flash(0.25, "#7dff9a");
    burst(rov.position.x, rov.position.y - 0.6, rov.position.z, 0x7dff9a, 40, 10);
  } else if (dx < 5.2) {
    sfx.bonus();
    addPoints(15, { ...t, alt: 3 }, "#7dff9a");
    popup("CLOSE!", t.x, floorY(t) + 5, -t.s, "#7dff9a");
    flash(0.12, "#7dff9a");
  }
}
function smash(t) { // turbo: obstacles burst apart
  const y = floorY(t) + 2;
  burst(t.x, y, -t.s, COLOR[t.type], 110, 20, 5);
  burst(t.x, y, -t.s, 0xffffff, 40, 26, 5);
  sfx.smash();
  flash(0.4, "#ff7a1a");
  shake = Math.max(shake, 0.7);
  addPoints(25, { ...t, alt: 3 }, "#ff7a1a");
  popup("SMASH!", t.x, y + 4, -t.s, "#ff7a1a", true);
  seen("smash");
  if (t.type === "ofos") { addPoints(175, { ...t, alt: 3 }, "#ff7a1a"); radio("Chief scientist: …that was our only OFOS."); }
  else if (t.type === "lander" || t.type === "mooring") radio(pick(["Chief scientist: MY EXPERIMENT!", "Bridge: We'll put that in the cruise report as \"lost at sea\"."]));
  release(t);
}

// ---------- the story of a run: OFOS, chatter, the dark, the wreck ----------
function events(dt) {
  if ((g.chat -= dt) <= 0) { radio(pick(CHATTER)); g.chat = rand(16, 30); }
  if (!g.darkSaid && g.score >= DARK_AT) {
    g.darkSaid = true;
    seen("midnight");
    banner("MIDNIGHT ZONE", "only your lights now", "#8fb3ff");
    flash(0.6, "#000000");
    sfx.dark();
    radio("Pilot: Lights to full. It's getting really dark down here.");
  }
  if (!g.wreck && g.score >= g.wreckAt) {
    g.wreckAt += WRECK_EVERY;
    startWreck();
    endFly();
    radio(`Sonar: Big contact ahead, about ${g.wreck.ship.len} m long, lying across our track. Looks like… a ship?`);
  }
  const w = g.wreck;
  if (w) {
    const to = w.s0 - g.s;
    if (w.said === 0 && to < 110) { w.said = 1; banner(`THE ${w.ship.name}`, "through the hole in her side", "#ffd98a"); radio(`Bridge: That's… the old ${w.ship.name}. Careful in there.`); }
    if (w.said === 1 && to < 0) { w.said = 2; flash(0.3, "#ffd98a"); sfx.power(); }
    if (!w.done && g.s > w.s0 + WRECK_L) {
      w.done = true;
      seen(w.ship.name);
      const pts = Math.round(1000 * g.mult);
      g.score += pts;
      bump();
      banner(`${w.ship.name} CLEARED`, `+${pts.toLocaleString("en")}`, "#ffd98a");
      flash(0.7, "#ffd98a");
      burst(rov.position.x, rov.position.y, rov.position.z, 0xffd98a, 200, 20, 3);
      sfx.combo();
      radio("Chief scientist: Not in the dive plan, but I'll allow it.");
    }
    if (g.s > w.s0 + WRECK_L + 80) { g.wreck = null; g.floor.flat = null; w.obj.visible = false; }
  }
  insiders(dt);
  if (!fly && !g.wreck && g.s > g.nextFly) {
    startFly(pick(["auv", "auv", "jago", "ofos", "elevator"]));
    g.nextFly = g.s + rand(550, 1100);
  }
  if (g.eggAt && !g.wreck && g.s > g.eggAt) { // the egg, once: alone in its row, so there's a way round
    g.eggAt = 0;
    const se = g.s + AHEAD * 0.6, lane = Math.floor(Math.random() * 3);
    for (const o of things) if (!o.gone && !o.decor && o.s > se - 14 && o.s < se + 14 && (BLOCK.has(o.type) || OVER.has(o.type) || UNDER.has(o.type))) release(o);
    const t = place("egg", se, LANES[lane]);
    const u = t.obj.userData;
    t.alt = 45; t.vy = 6;
    u.crack.visible = false; u.shadow.visible = true;
    u.egg.rotation.set(rand(-0.5, 0.5), 0, rand(-0.5, 0.5));
  }
  if (!g.wreck && g.s > g.nextHooks) { // the deck crew with boat hooks: room in their lane where they pull you
    g.nextHooks = g.s + rand(800, 1500);
    const side = pick([-1, 1]), sh = g.s + AHEAD * 0.85;
    const t = place("hooks", sh, side * 10, 0, true);
    t.obj.rotation.y = side < 0 ? Math.PI / 2 : -Math.PI / 2;
    for (const o of things) {
      if (!o.gone && !o.decor && o.x === LANES[side > 0 ? 2 : 0] && o.s > sh - 8 && o.s < sh + 30 && (BLOCK.has(o.type) || OVER.has(o.type) || UNDER.has(o.type))) release(o);
    }
  }
  if (!g.wreck && g.s + AHEAD * 0.8 > g.nextOfos) {
    const t = place("ofos", g.nextOfos, LANES[Math.floor(Math.random() * 3)], 0);
    t.lane = LANES.indexOf(t.x);
    g.nextOfos += rand(1000, 1900);
    radio(pick(["Bridge: OFOS is in the water. Keep clear of the tow wire!", "OFOS team: We're towing the OFOS through your area, sorry!", "Winch: OFOS at 3 m above ground, ROV please stay away."]));
  }
}
// the cruise's rituals and mishaps: runner, Dumbo, Kaffee & Kuchen, Bergfest, equator, video dropouts
let eqLine = null;
function insiders(dt) {
  if (g.devAt && !runner && !g.wreck && g.s > g.devAt) { g.devAt = 0; startRunner(); }
  if (g.s > g.nextDumbo) {
    place("dumbo", g.s + AHEAD - 20, (Math.random() < 0.5 ? -1 : 1) * 7.4, 3.6, true);
    g.nextDumbo = g.s + rand(600, 1100);
  }
  if (g.coffeeAt && g.s > g.coffeeAt && !g.wreck) { // 15:00: cake and coffee down the lanes, no obstacles for a bit
    g.coffeeAt = 0;
    seen("coffee");
    banner("KAFFEE & KUCHEN", "15:00 sharp, the whole ship stops", "#ffe0b0");
    radio(pick(["Bridge: Kaffee und Kuchen in the mess! Pilots, we'll save you a piece. Maybe.", "Cook: Today's cake: Frankfurter Kranz. Don't be late.", "Chief scientist: Science can wait. Cake cannot."]));
    flash(0.3, "#ffe0b0");
    const s0 = nextSpawn;
    let lane = 1;
    for (let i = 0; i < 12; i++) {
      if (i % 3 === 2) lane = clamp(lane + pick([-1, 1]), 0, 2);
      place(i % 2 ? "coffee" : "cake", s0 + 8 + i * 4.5, LANES[lane], ALT);
    }
    nextSpawn = s0 + 70;
  }
  if (g.bergAt && g.s > g.bergAt) { // halfway through the cruise: party, lametta, the world on its head
    g.bergAt = 0;
    seen("bergfest");
    g.party = 9;
    banner("BERGFEST!", "halfway through the cruise · points ×2", "#ff7bd5");
    radio(pick(["Chief scientist: Halfway through the cruise! Bergfest tonight, the bar is open.", "Bridge: Bergfest! Who brought the lametta?", "Cook: Grill's on the aft deck. Bergfest!"]));
    flash(0.7, "#ff7bd5");
    sfx.combo();
    for (const c of [0xff7bd5, 0xffd34d, 0x7be0ff]) burst(rov.position.x, rov.position.y + 3, rov.position.z - 6, c, 80, 16, 4);
    lametta.visible = true;
    canvas.classList.add("flip");
    setTimeout(() => canvas.classList.remove("flip"), 1500);
  }
  if (g.party > 0 && (g.party -= dt) <= 0) { lametta.visible = false; banner("BERGFEST OVER", "back to work", "#ff7bd5"); }
  if (g.eqAt && g.s + 140 > g.eqAt && !g.eq && !g.wreck) { // the equator: a line on the seafloor, Neptune waiting beside it
    const s = g.eqAt, side = Math.random() < 0.5 ? -1 : 1;
    if (!eqLine) {
      eqLine = new THREE.Group();
      for (let k = 0; k < 40; k++) {
        const b = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.15, 0.4), new THREE.MeshBasicMaterial({ color: k % 2 ? 0xffffff : 0xff2a2a }));
        eqLine.add(b);
      }
      scene.add(eqLine);
    }
    eqLine.children.forEach((b, k) => { const x = -30 + k * 1.5; b.position.set(x, g.floor.h(s, x) + 0.12, -s); });
    eqLine.visible = true;
    place("neptune", s + 4, side * 10.5, 0, true).obj.rotation.y = -side * 0.5;
    g.eq = { s, done: false };
  }
  if (g.eq && !g.eq.done && g.s > g.eq.s) {
    g.eq.done = true;
    g.eqAt = 0;
    seen("equator");
    banner("ÄQUATORTAUFE!", "0°00' · Neptune wants a word", "#4fe3ff");
    radio(pick(["Neptune: Who dares to cross my equator without a baptism?!", "Bridge: Crossing the line. All first-timers to the aft deck, old clothes only.", `Neptune: ${N.rov}, you smell like a pollywog.`]));
    flash(0.6, "#4fe3ff");
    sfx.power();
    for (const c of [0x4fe3ff, 0xffffff, 0x2a7dff]) burst(rov.position.x, rov.position.y + 2, rov.position.z - 4, c, 70, 14, 3);
    addPoints(300, { x: g.x, s: g.s + 6, alt: 4 }, "#4fe3ff");
  }
  if (g.s > g.nextPlume) { // a sediment plume ahead, in a random lane (sometimes two side by side)
    const lane = Math.floor(Math.random() * 3);
    place("plume", g.s + AHEAD, LANES[lane], 0, true);
    if (Math.random() < 0.3) place("plume", g.s + AHEAD + rand(-3, 3), LANES[(lane + pick([1, 2])) % 3], 0, true);
    g.nextPlume = g.s + rand(PLUME_EVERY[0], PLUME_EVERY[1]);
  }
  if (g.plume > 0 && (g.plume -= dt) <= 0) {
    g.plume = 0;
    if (Math.random() < 0.5) radio(pick(["Pilot: And we're out. I can see again.", "Sedimentologist: It'll settle. In a few weeks.", "Chief scientist: Did the turbidity sensor get all that?"]));
  }
  if ((g.nextDrop -= dt) <= 0 && !g.drop) { // the fibre hiccups: static, no picture
    g.drop = rand(0.25, 0.45);
    g.nextDrop = rand(60, 110);
    seen("dropout");
    $("dropout").hidden = false;
    tone(90, g.drop, { type: "sawtooth", gain: 0.02 });
  }
  if (g.drop > 0) {
    drawNoise();
    if ((g.drop -= dt) <= 0) {
      g.drop = 0;
      $("dropout").hidden = true;
      if (Math.random() < 0.6) radio(pick(["Video tech: Sorry, the fibre hiccupped. You're back.", "Pilot: Flying blind for a second there. Totally under control.", "Data manager: Did the recording catch that? …Did it?"]));
    }
  }
  if (g.wreck) g.wreck.obj.userData.radar.rotation.y += dt * 1.2;
}
// The deck crew with boat hooks, beside the track: in the middle lane they hook the ROV and pull it
// into the lane on their side. Climbing (↑) or turbo gets past them.
function updateHooks(t, dt, dz) {
  const u = t.obj.userData, side = Math.sign(t.x);
  let aim = -0.9; // poles up
  if (t.done) aim = t.got ? -1.25 : -0.9;
  else if (dz < 32 && dz > -6) aim = g.lane === 1 ? 0.12 : -0.35; // reaching for the ROV
  for (const p of u.poles) p.rotation.x += (aim - p.rotation.x) * Math.min(1, dt * 5);
  if (g.state !== "run" || t.done) return;
  if (!t.said && dz < 70) {
    t.said = true;
    radio(pick(["Deck crew: We'll get it with the boat hooks! Hold still!", "Bosun: Hooks ready! Grab it when it comes by!", "Deck crew: Is that the buoy? Looks like the buoy. Get it!"]));
  }
  if (Math.abs(dz) > 1.5) return;
  t.done = true;
  if (g.lane !== 1) return;
  if (g.alt > 4.5 || g.turbo > 0) { // over them, or too fast
    popup("SLIPPED THE HOOKS!", g.x, rov.position.y + 3, -g.s, "#7dff9a", true);
    addPoints(100, { x: g.x, s: g.s, alt: g.alt + 2 }, "#7dff9a");
    return;
  }
  t.got = true;
  g.lane = side > 0 ? 2 : 0;
  seen("hooked");
  shake = Math.max(shake, 0.45);
  flash(0.25, "#ff7a1a");
  sfx.move(); tone(260, 0.25, { type: "sawtooth", gain: 0.06, slide: 0.5 });
  burst(g.x, rov.position.y + 1, -g.s, 0xff7a1a, 40, 8, 2);
  popup("HOOKED! 🪝", g.x, rov.position.y + 3, -g.s, "#ff7a1a", true);
  radio(pick(["Deck crew: Got it! … wait, that's the ROV.", "Bosun: Pull! Pull! … Ah. Wrong thing.", "Deck crew: Sorry! We thought you were the mooring."]));
}
const FLIP_T = 0.95; // s: the camerawoman flips the ROV head over heels
const CAM_PENALTY = 100; // points off for knocking her over
function updateCam(t, dt, dz) {
  if (t.knock > 0) { // bumped out of the way: she topples over to the side, still filming
    t.knock = Math.max(0, t.knock - dt);
    t.x += t.away * dt * 5;
    t.obj.rotation.z = -t.away * Math.min(1.35, (1 - t.knock) * 3);
  } else if (!t.hit) faceRov(t.obj);
  if (g.state !== "run" || t.hit || Math.abs(dz) > 1.6 || Math.abs(t.x - g.x) > 2.2) return;
  t.hit = true;
  t.knock = 1;
  t.away = t.x === 0 ? pick([-1, 1]) : Math.sign(t.x);
  g.flip = FLIP_T;
  seen("camera");
  flash(0.35, "#ffffff");
  shake = Math.max(shake, 0.3);
  tone(520, 0.3, { type: "triangle", gain: 0.08, slide: 2 });
  g.score = Math.max(0, g.score - CAM_PENALTY); // a flat penalty: no multiplier, never below 0
  bump();
  popup(`−${CAM_PENALTY} 🎬`, g.x, rov.position.y + 3, -g.s, "#ff5c5c", true);
  radio(pick(["Camerawoman: Hey! Watch where you're flying!", "Film crew: That camera costs more than your sample!", "Camerawoman: Cut! CUT! Who taught you to drive?", "Film crew: Great, now we have to do the whole take again."]));
}

function enterPlume(t) { // into the murk: the fog thickens (setDark), brown over the picture
  t.passed = true;
  if (!g.plume) {
    seen("plume");
    radio(pick(["Chief scientist: That's a collector plume. Exactly what we came here to measure!", "Pilot: Visibility zero. Flying on sonar.",
      "Sedimentologist: Beautiful plume! …Sorry, I mean: careful.", `Bridge: ${N.rov}, are you still there? We only see brown.`]));
    tone(70, 0.8, { type: "sine", gain: 0.05, slide: 0.6 });
  }
  g.plume = PLUME_T;
  burst(t.x, rov.position.y, -t.s, 0x8a7556, 60, 6, 2.5);
}

function sighting(t) { // a creature went by
  seen(t.type);
  if (t.type === "dumbo") { // cheers you up: keeps the combo going
    g.comboT = COMBO_TIME + 1;
    addPoints(25, { x: t.x, s: t.s, alt: t.alt + 2 }, "#ff7bd5");
    popup("DUMBO SAYS HI ♥", t.x, rov.position.y + 4, -t.s, "#ff7bd5", true);
    burst(t.x, g.floor.h(t.s, t.x) + t.alt + 2, -t.s, 0xff7bd5, 50, 6, 2);
    flash(0.2, "#ff7bd5");
    tone(1320, 0.12, { type: "triangle", gain: 0.08 }); tone(1760, 0.18, { type: "triangle", gain: 0.08, delay: 0.1 });
    radio(pick(["Control van: Awwwww 🥰", "Everyone: AWWW. Dive plan paused for Dumbo.", "Chief scientist: Look at its little ears!", "Biologist: Grimpoteuthis! Somebody get a picture!", "Pilot: OK, now I'm in a good mood."]));
  } else if (t.type === "angler" && Math.random() < 0.3) radio("Biologist: Careful, that's not a nodule. That's a lure.");
  else if (t.type === "seapig" && Math.random() < 0.08) radio("Biologist: Sea pigs! Scotoplanes! I love them.");
  else if (t.type === "crab" && Math.random() < 0.08) radio("Biologist: A crab! It's waving. Is it waving?");
  else if (t.type === "crinoid" && Math.random() < 0.08) radio("Biologist: Sea lily! Older than the dinosaurs, that family.");
  else if (t.type === "sponge" && Math.random() < 0.08) radio("Biologist: Glass sponge. Some of them are thousands of years old. Don't touch.");
  else if (t.type === "rattail" && Math.random() < 0.1) radio("Pilot: A rattail is racing us. And winning.");
}
const WATER_C = new THREE.Color(WATER), DARK_C = new THREE.Color(0x000205);
const plumeEl = $("plume");
function setDark(dt) { // fades the water to black above DARK_AT points; the ROV's lights take over
  const target = g.darkSaid && g.state !== "loading" ? 1 : 0;
  g.dark += (target - g.dark) * Math.min(1, dt * 0.5);
  const d = g.dark;
  // a sediment plume: in fast, out slowly
  const pt = g.plume > 0 && g.state !== "loading" ? 1 : 0;
  g.plumeK += (pt - g.plumeK) * Math.min(1, dt * (pt ? 5 : 1.2));
  const pk = g.plumeK;
  scene.background.copy(WATER_C).lerp(DARK_C, d).lerp(PLUME_C, pk * 0.85);
  scene.fog.color.copy(scene.background);
  scene.fog.density = 0.0095 + d * 0.011 + pk * 0.024;
  plumeEl.style.opacity = (pk * 0.62).toFixed(3);
  plumeEl.classList.toggle("thick", pk > 0.5);
  hemi.intensity = 1.1 * (1 - 0.94 * d);
  sun.intensity = 0.9 * (1 - d);
  headlamp.intensity = 170 * d;
  glowLight.intensity = 14 * d;
  for (const m of beamMats) m.opacity = 0.08 + 0.14 * d;
  snow.material.color.setHex(d > 0.5 ? 0x9fc4ff : 0xcfe9ff);
}

// ---------- the dive report on the game-over screen: each sighting as a little live 3D model ----------
const gallery = { renderer: null, scene: null, items: [], w: 0, h: 0 };
const noiseTex = new THREE.CanvasTexture(noise);
noiseTex.magFilter = THREE.NearestFilter;
const GALLERY = { // key → the model shown (fresh ones; wrecks are copies of the ones seen)
  bell: () => MAKE.bell(), ofos: () => MAKE.ofos(), ofosfly: () => makeFlyOfos(), auv: () => makeAuv(), jago: () => makeSub(),
  picture: () => buildRov(), photobomb: () => MAKE.ofos(), runner: () => makeRunner(false),
  dumbo: () => MAKE.dumbo(), jelly: () => MAKE.jelly(), seapig: () => MAKE.seapig(), angler: () => MAKE.angler(),
  equator: () => MAKE.neptune(), corer: () => MAKE.multicorer(),
  rider: () => { const c = MAKE.boxcorer(); c.userData.riders[1].visible = true; c.userData.wave = c.userData.riders[1].userData.wave; return c; },
  dinghy: () => { const a = makeAuv(); a.userData.boat.visible = true; a.userData.wave = a.userData.boatWave; return a; },
  elevator: () => makeElevator(), pickles: () => MAKE.jar(), crab: () => MAKE.crab(), starfish: () => MAKE.starfish(), crinoid: () => MAKE.crinoid(),
  sponge: () => MAKE.sponge(), tubeworms: () => MAKE.tubeworms(), rattail: () => MAKE.rattail(), hooked: () => MAKE.hooks(), camera: () => MAKE.camwoman(), toilet: () => MAKE.toilet(), hut: () => MAKE.hut(), egg: () => { const e = MAKE.egg(); e.userData.crack.visible = true; return e; }, smash: () => MAKE.rock(), midnight: () => MAKE.angler(),
  coffee: () => { const c = new THREE.Group(), a = MAKE.cake(), b = MAKE.coffee(); a.position.x = -0.6; b.position.x = 0.7; c.add(a, b); return c; },
  bergfest: () => { // the ROV on its head, in lametta
    const grp = new THREE.Group(), r = buildRov();
    r.rotation.z = Math.PI;
    grp.add(r);
    for (let k = 0; k < 40; k++) {
      const st = new THREE.Mesh(new THREE.BoxGeometry(0.03, rand(0.4, 1), 0.03), new THREE.MeshBasicMaterial({ color: pick([0xe8e8f0, 0xffd34d, 0xff7bd5, 0x7be0ff]) }));
      st.position.set(rand(-1.6, 1.6), rand(-1.4, 1.6), rand(-1.6, 1.6));
      st.rotation.z = rand(-0.4, 0.4);
      grp.add(st);
    }
    return grp;
  },
  plume: () => MAKE.plume(),
  dropout: () => { // an old monitor showing static
    const grp = new THREE.Group();
    const box = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.2, 1.1), pmat(0x30343c));
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.9), new THREE.MeshBasicMaterial({ map: noiseTex }));
    screen.position.z = 0.56;
    grp.add(box, screen);
    return grp;
  },
};
function galleryModel(key) {
  const ship = FLEET.find((f) => f.name === key);
  if (ship) {
    if (!wrecks[key]) return null;
    const c = wrecks[key].clone();
    c.visible = true;
    c.position.set(0, 0, 0);
    c.userData = { shared: true }; // its geometry belongs to the wreck in the game: not disposed (clone() turned the rest into JSON)
    return c;
  }
  return GALLERY[key]?.() || null;
}
function fitBox(obj) { // the model's size without tow wires and light beams (they'd make it tiny)
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3(), part = new THREE.Box3();
  obj.traverse((o) => {
    if (!o.isMesh || o.material === M.wire || o.material.blending === THREE.AdditiveBlending) return;
    o.geometry.computeBoundingBox();
    box.union(part.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld));
  });
  return box.isEmpty() ? new THREE.Box3().setFromObject(obj) : box;
}
function clearGallery() {
  for (const it of gallery.items) {
    if (it.obj) gallery.scene.remove(it.obj);
    if (it.obj && !it.obj.userData.shared) it.obj.traverse((o) => o.geometry?.dispose());
  }
  gallery.items = [];
  $("rep-l").replaceChildren();
  $("rep-r").replaceChildren();
  $("rep-m").replaceChildren();
}
const wide = matchMedia("(min-width: 980px)"); // columns beside the card; else a strip in the card
function placeTiles() {
  gallery.items.forEach((it, i) => {
    it.col = $(wide.matches ? (i % 2 ? "rep-r" : "rep-l") : "rep-m");
    it.col.append(it.tile);
  });
}
wide.addEventListener("change", placeTiles);
function buildGallery(seenCounts) {
  if (!gallery.renderer) {
    gallery.renderer = new THREE.WebGLRenderer({ canvas: $("gallery"), alpha: true, antialias: true });
    gallery.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    gallery.renderer.setClearColor(0x000000, 0);
    gallery.renderer.setScissorTest(true);
    gallery.scene = new THREE.Scene();
    gallery.scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.8));
    const sunG = new THREE.DirectionalLight(0xffffff, 2.2);
    sunG.position.set(2, 3, 4);
    gallery.scene.add(sunG);
  }
  clearGallery();
  const list = SEEN.filter(([k]) => seenCounts?.[k]);
  list.forEach(([key, icon, label], i) => {
    const tile = document.createElement("div");
    tile.className = "tile";
    const view = document.createElement("div");
    view.className = "view";
    const cap = document.createElement("div");
    cap.textContent = `${icon} ${label}`;
    if (seenCounts[key] > 1) cap.append(Object.assign(document.createElement("b"), { textContent: ` ×${seenCounts[key]}` }));
    tile.append(view, cap);
    const obj = galleryModel(key);
    if (!obj) { view.textContent = icon; view.classList.add("emoji"); gallery.items.push({ tile, el: view, obj: null }); return; }
    const base = new THREE.Vector3(i * 600, 0, 0);
    obj.position.copy(base);
    gallery.scene.add(obj);
    const sphere = fitBox(obj).getBoundingSphere(new THREE.Sphere());
    const cam = new THREE.PerspectiveCamera(32, 92 / 80, 0.1, 3000);
    const ship = FLEET.some((f) => f.name === key);
    const dir = new THREE.Vector3(ship ? 0.35 : 0.6, ship ? 0.35 : 0.3, 1).normalize();
    cam.position.copy(sphere.center).addScaledVector(dir, (sphere.radius / Math.sin((16 * Math.PI) / 180)) * (ship ? 0.8 : 1.02));
    cam.lookAt(sphere.center);
    gallery.items.push({ tile, el: view, obj, cam, base, spin: ship ? 0.25 : 0.7, phase: 0, t: { s: i * 3 } });
  });
  placeTiles();
}
function renderGallery(dt, now) {
  if (!gallery.items.length || $("over").hidden) return;
  const r = gallery.renderer, W = window.innerWidth, H = window.innerHeight;
  if (gallery.w !== W || gallery.h !== H) { r.setSize(W, H, false); gallery.w = W; gallery.h = H; }
  r.setScissor(0, 0, W, H);
  r.clear();
  drawNoise();
  noiseTex.needsUpdate = true;
  const card = $("over").querySelector(".card").getBoundingClientRect();
  for (const it of gallery.items) {
    if (!it.obj) continue;
    // only the part that's visible: in its column, and in the card when the strip scrolls with it
    const rect = it.el.getBoundingClientRect(), clip = it.col.getBoundingClientRect();
    const inCard = it.col.id === "rep-m";
    const top = Math.max(rect.top, clip.top, inCard ? card.top : -1e9), bottom = Math.min(rect.bottom, clip.bottom, inCard ? card.bottom : 1e9);
    const left = Math.max(rect.left, clip.left), right = Math.min(rect.right, clip.right);
    if (bottom <= top || right <= left || rect.width === 0) continue;
    const o = it.obj, ud = o.userData;
    o.position.copy(it.base);
    if (!ud.shared) o.rotation.y += dt * it.spin;
    ud.anim?.(now, it.t);
    if (ud.run) { it.phase += dt * 12; ud.run(it.phase); }
    waveArm(o, now);
    if (ud.strobe) ud.strobe.material = now % 1300 < 90 ? M.strobe : M.strobeOff;
    if (ud.radar) ud.radar.rotation.y += dt * 1.2;
    if (Math.abs(it.cam.aspect - rect.width / rect.height) > 0.01) { it.cam.aspect = rect.width / rect.height; it.cam.updateProjectionMatrix(); }
    r.setViewport(rect.left, H - rect.bottom, rect.width, rect.height);
    r.setScissor(left, H - bottom, right - left, bottom - top);
    r.render(gallery.scene, it.cam);
  }
}

// ---------- the loop ----------
const tmp = new THREE.Vector3();
let last = performance.now();
let shownScore = -1;
function update(dt, now) {
  const floor = g.floor;
  if (g.state === "run") {
    const base = Math.min(VMAX, V0 + g.s * ACCEL);
    const target = g.turbo > 0 ? base * TURBO_X : base;
    g.v += (target - g.v) * Math.min(1, dt * 3);
    const ds = g.v * dt;
    g.s += ds;
    g.diveT += dt; // time spent diving (for the stats page)
    const mult = Math.min(8, 1 + Math.floor(g.s / 600));
    if (mult > g.mult) { g.mult = mult; banner(`×${mult}`, "multiplier up", "#ffb13b"); flash(0.35, "#ffb13b"); sfx.combo(); }
    g.score += ds * 0.5 * g.mult * (g.party > 0 ? 2 : 1);
    if (g.s >= g.milestone) {
      banner(`${g.milestone.toLocaleString("en")} m`, "", "#ffffff");
      flash(0.4, "#ffffff");
      g.milestone += 1000;
    }
    if (g.move > 0 && (g.move -= dt) <= 0) g.altTarget = ALT;
    if (g.magnet > 0) g.magnet -= dt;
    if (g.turbo > 0 && (g.turbo -= dt) <= 0) banner("TURBO OVER", "", "#ff7a1a");
    if (g.combo && (g.comboT -= dt) <= 0) g.combo = 0;
    events(dt);
  }
  setDark(dt);
  updateFly(dt, now);
  updateRunner(dt);
  if (lametta.visible) updateLametta(dt, now, rov.position.y);
  // ROV: lane, height above the seafloor, attitude
  const targetX = LANES[g.lane];
  const vx = (targetX - g.x) * Math.min(1, dt * 18);
  g.x += vx;
  g.alt += (g.altTarget - g.alt) * Math.min(1, dt * (g.altTarget < g.alt ? 14 : 11));
  const ground = floor.h(g.s, g.x);
  const y = ground + g.alt;
  rov.position.set(g.x, y, -g.s);
  if (g.state === "crash" || g.state === "over") {
    g.crashT += dt;
    rov.rotation.z += dt * 4;
    rov.rotation.x += dt * 1.5;
    rov.position.y -= Math.min(g.alt - 0.6, g.crashT * 3);
    if (g.state === "crash" && g.crashT > 1.1) gameOver();
  } else {
    const ahead = floor.h(g.s + 6, g.x);
    rov.rotation.set(clamp((ahead - ground) / 6, -0.35, 0.35) + (g.altTarget - g.alt) * 0.04, 0, -vx / Math.max(dt, 1e-3) * 0.012);
    if (g.flip > 0) { // head over heels (the camerawoman): a full somersault with a little hop
      g.flip = Math.max(0, g.flip - dt);
      const k = 1 - g.flip / FLIP_T, e = k * k * (3 - 2 * k);
      rov.rotation.x -= e * Math.PI * 2;
      rov.position.y += Math.sin(k * Math.PI) * 1.6;
    }
  }
  rov.userData.blink?.(now);
  shieldMesh.visible = g.shield || g.turbo > 0;
  shieldMesh.material.color.setHex(g.turbo > 0 ? 0xff7a1a : 0x4fe3ff);
  if (shieldMesh.visible) shieldMesh.material.opacity = (g.turbo > 0 ? 0.25 : 0.14) + 0.06 * Math.sin(now / 90);
  if (g.turbo > 0 && g.state === "run" && Math.random() < 0.7) burst(g.x + rand(-0.6, 0.6), y - 0.2, -g.s + 1.8, pick([0xff7a1a, 0xffd27a]), 3, 4, 0);
  $("vignette").className = "vignette" + (g.turbo > 0 && g.state === "run" ? " turbo" : "");

  // terrain pieces ahead
  for (const ch of chunks) {
    if (ch.start + CHUNK < g.s - 25) { ch.start += CHUNKS * CHUNK; buildChunk(ch, floor); }
  }
  floor.trim(g.s);

  // spawn ahead, update and hit-test things
  if (g.state === "run" || g.state === "ready") {
    while (nextSpawn < g.s + AHEAD) {
      const w = g.wreck;
      if (w && !w.spawned && nextSpawn > w.s0 - 45) { spawnWreck(w); w.spawned = true; nextSpawn = w.s0 + WRECK_L + 35; continue; }
      spawnRow(nextSpawn, g.v);
      nextSpawn += Math.max(24, g.v * rand(0.85, 1.25));
    }
    while (nextDecor < g.s + AHEAD) {
      const w = g.wreck;
      if (!(w && nextDecor > w.s0 - 40 && nextDecor < w.s0 + WRECK_L + 25)) spawnDecor(nextDecor);
      nextDecor += rand(16, 40);
    }
  }
  const blinkOn = now % 600 < 300;
  for (const t of things) {
    if (t.gone) continue;
    const dz = t.s - g.s;
    if (dz < -15) { release(t); continue; }
    if (t.type === "ofos") { // tows along slowly, changes lanes now and then, its strobe fires
      t.s += dt * 3.5;
      if ((t.drift = (t.drift ?? rand(2, 4)) - dt) <= 0) { t.lane = clamp((t.lane ?? LANES.indexOf(t.x)) + pick([-1, 1]), 0, 2); t.drift = rand(3, 6); }
      if (t.lane != null) t.x += (LANES[t.lane] - t.x) * Math.min(1, dt * 0.9);
      const on = now % 1300 < 90;
      t.obj.userData.strobe.material = on ? M.strobe : M.strobeOff;
      if (on && !t.flashed && dz > 0 && dz < 70) { flash(0.18, "#ffffff"); t.flashed = true; }
      if (!on) t.flashed = false;
    }
    const egg = t.type === "egg";
    if (DROPS.has(t.type) && t.alt > 0 && dz < (egg ? 85 : 75)) { // lowered from the ship (or just falling): down it comes
      if (egg) t.vy += dt * 55;
      t.alt = Math.max(0, t.alt - dt * (egg ? t.vy : 32));
      const u = t.obj.userData;
      if (egg) { // shadow on the floor, darker as it nears; the egg rights itself
        u.shadow.position.y = -t.alt + 0.08;
        u.shadow.material.opacity = 0.2 + 0.5 * (1 - t.alt / 45);
        u.egg.rotation.x *= 1 - Math.min(1, dt * 2); u.egg.rotation.z *= 1 - Math.min(1, dt * 2);
      }
      if (t.alt === 0) {
        const ty = floor.h(t.s, t.x);
        burst(t.x, ty + 0.5, -t.s, 0x8a7a5a, egg ? 140 : 70, egg ? 10 : 7, 1.5); // a sediment cloud
        burst(t.x, ty + 0.3, -t.s, 0xc9b48a, egg ? 60 : 30, 11, 0.5);
        if (egg) { // CRACK
          u.crack.visible = true;
          u.shadow.visible = false;
          u.egg.rotation.set(0, 0, rand(-0.08, 0.08)); // lands a bit crooked
          burst(t.x, ty + 3, -t.s, 0xf6efe2, 25, 9, 3); // shell chips
          if (dz < 60 && g.state === "run") {
            shake = Math.max(shake, 0.7);
            flash(0.3, "#f6efe2");
            tone(48, 0.6, { type: "sine", gain: 0.3, slide: 0.5 });
            tone(1800, 0.12, { type: "square", gain: 0.05, slide: 0.4, delay: 0.02 }); // the crack
            if (Math.random() < 0.5) radio(pick([
              "Bridge: Did… did an egg just fall past the CTD?",
              "Chief scientist: That's not in the cruise plan.",
              "Pilot: Big egg, lane " + (LANES.indexOf(t.x) + 1) + ". Going around.",
              "Biologist: I need a sample of that. For science.",
            ]));
          }
          if (g.state === "run") seen("egg");
        } else {
          if (dz < 45) { shake = Math.max(shake, 0.35); tone(70, 0.3, { type: "sine", gain: 0.2, slide: 0.6 }); }
          if (g.state === "run") {
            seen("corer");
            if (t.rider >= 0 && dz > 0) {
              seen("rider");
              if (Math.random() < 0.6) radio(pick(t.rider === 0
                ? ["Deck: Has anyone seen Jens? … Oh.", "Bosun: Who's riding the corer?! Get off that thing!", "Winch: Corer on the bottom. Plus one deck hand."]
                : ["Chief scientist: I'll take the sample myself, thank you.", "Winch: Corer on the bottom. And the station leader.", "Scientist: Best seat on the ship!"]));
            }
          }
        }
      }
    }
    if (t.decor && t.fly) { // thrown by ELEVATOR BOI: flying, spinning, then landing with a puff
      const f = t.fly;
      t.x += f.vx * dt; t.s += f.vs * dt; f.vy -= 25 * dt; t.alt += f.vy * dt;
      t.obj.rotation.x += f.spin[0] * dt; t.obj.rotation.z += f.spin[1] * dt;
      if (t.alt <= 0 && f.vy < 0) {
        t.alt = 0;
        t.fly = null;
        t.obj.rotation.set(rand(-0.2, 0.2), t.obj.rotation.y, rand(-0.3, 0.3)); // lands a bit askew
        burst(t.x, floor.h(t.s, t.x) + 0.3, -t.s, 0x8a7a5a, 25, 5, 1);
      }
    }
    if (t.decor) {
      t.obj.position.set(t.x, floor.h(t.s, t.x) + t.alt, -t.s);
      t.obj.userData.anim?.(now, t);
      if (t.type === "camwoman") faceRov(t.obj);
      if (t.type === "hooks") updateHooks(t, dt, dz);
      if (t.type === "plume" && !t.passed && Math.abs(dz) < 2.5 && Math.abs(t.x - g.x) < 2.8 && g.state === "run") enterPlume(t);
      if (CREATURES.has(t.type) && !t.passed && dz < 5 && g.state === "run") { t.passed = true; sighting(t); }
      if (SIGHTS[t.type] && !t.passed && dz < 5 && g.state === "run") {
        t.passed = true;
        seen(t.type);
        if (Math.random() < 0.35) radio(pick(SIGHTS[t.type]));
      }
      if (t.obj.userData.lights) for (const l of t.obj.userData.lights) l.visible = blinkOn;
      continue;
    }
    const isItem = t.type in VALUE || POWERS.has(t.type);
    if (g.magnet > 0 && t.type === "nodule" && dz < MAGNET_RANGE && dz > -2 && !t.pop) {
      t.x += (g.x - t.x) * Math.min(1, dt * 9);
      t.alt += (g.alt - t.alt) * Math.min(1, dt * 9);
      t.s -= dz * Math.min(1, dt * 6);
    }
    const ty = floor.h(t.s, t.x);
    t.obj.position.set(t.x, ty + t.alt, -t.s);
    if (isItem) {
      if (t.pop) { // collected: grows and fades
        t.pop += dt;
        t.obj.scale.setScalar(1 + t.pop * 8);
        if (t.pop > 0.15) release(t);
        continue;
      }
      t.obj.rotation.y = now / 300 + t.s;
      t.obj.position.y += Math.sin(now / 200 + t.s) * 0.18;
      if (g.state === "run" && Math.abs(dz) < 1.6 && Math.abs(t.x - g.x) < 1.7 && Math.abs(t.alt - g.alt) < 2.3) {
        t.pop = 1e-6;
        collect(t);
      }
      continue;
    }
    if (t.type === "chimney") {
      for (const p of t.obj.userData.puffs) {
        const k = (p.userData.t + now / 2200) % 1;
        p.position.set(Math.sin(k * 6 + t.s) * 0.6, 9.3 + k * 8, 0);
        p.scale.setScalar(0.6 + k * 2.2);
      }
    } else if (t.obj.userData.lights) {
      for (const l of t.obj.userData.lights) l.visible = blinkOn;
    }
    if (t.type === "ofos") { t.obj.position.y += 1.2 + Math.sin(now / 500) * 0.3; waveArm(t.obj, now); }
    if (t.obj.userData.wave && DROPS.has(t.type)) waveArm(t.obj, now); // a corer rider
    if (t.type === "camwoman") { updateCam(t, dt, dz); continue; }
    if (g.state !== "run") continue;
    // obstacles: only within reach, in the ROV's lane
    const reach = REACH[t.type] || 1.4;
    if (Math.abs(dz) < reach && Math.abs(t.x - g.x) < (t.type === "ofos" ? 2.5 : 2.2)) {
      const hit = (BLOCK.has(t.type) && t.alt < (HEIGHT[t.type] || 4)) || (OVER.has(t.type) && g.alt < 3.3) || (UNDER.has(t.type) && g.alt > NET_LOW - 0.25);
      if (hit) {
        if (g.turbo > 0) { smash(t); continue; }
        if (!crash(WHY[t.type])) release(t);
        continue;
      }
    }
    if (!t.passed && dz < -reach) { t.passed = true; g.passedN++; passed(t); }
  }
  if (things.length > 500) for (let i = things.length - 1; i >= 0; i--) if (things[i].gone) things.splice(i, 1);
  updateSparks(dt);

  // camera behind and above, looking ahead; wider and lower in turbo; shakes on impacts
  const turbo = g.turbo > 0 && g.state === "run";
  const camTarget = tmp.set(g.x * 0.6, y + (turbo ? 5.4 : 6.6), -g.s + (turbo ? 11 : 12.5));
  camera.position.lerp(camTarget, Math.min(1, dt * 6));
  const camFloor = floor.h(g.s - 10, camera.position.x) + 2;
  if (camera.position.y < camFloor) camera.position.y = camFloor;
  const fov = (window.innerWidth < window.innerHeight ? 75 : 62) + (g.v - V0) * 0.25 + (turbo ? 14 : 0);
  if (Math.abs(camera.fov - fov) > 0.1) { camera.fov += (fov - camera.fov) * Math.min(1, dt * 4); camera.updateProjectionMatrix(); }
  camera.lookAt(g.x * 0.7, y + 0.2, -g.s - 22);
  if (shake > 0) {
    shake = Math.max(0, shake - dt * 2.2);
    camera.position.x += rand(-1, 1) * shake * 0.6;
    camera.position.y += rand(-1, 1) * shake * 0.6;
    camera.rotation.z += rand(-1, 1) * shake * 0.03;
  }
  sun.position.set(-20 + g.x, y + 60, -g.s + 10);
  sun.target.position.set(g.x, y, -g.s - 20);

  // snow drifts past, wrapping around the camera; bubbles rise from the ROV; streaks at speed
  const sp = snowGeom.attributes.position;
  for (let i = 0; i < SNOW; i++) {
    let z = sp.getZ(i);
    if (z > -g.s + 20) { z -= 140; sp.setX(i, g.x + rand(-40, 40)); sp.setY(i, y + rand(-6, 25)); }
    sp.setZ(i, z);
    sp.setY(i, sp.getY(i) - dt * 0.15);
  }
  sp.needsUpdate = true;
  const speedness = clamp((g.v - V0 * 0.9) / (VMAX * TURBO_X - V0), 0, 1);
  streakMat.opacity = g.state === "run" ? 0.15 + speedness * 0.6 : 0;
  const len = 1.5 + g.v * 0.09;
  for (let i = 0; i < SN; i++) {
    const sd = streakSeed[i];
    sd[2] += g.v * dt * 0.9; // relative to the ROV, rushing back
    if (sd[2] > 14) { sd[0] = rand(-14, 14); sd[1] = rand(-2, 10); sd[2] = rand(-90, -40); }
    const zx = -g.s + sd[2];
    streakPos.set([g.x + sd[0], y + sd[1], zx, g.x + sd[0], y + sd[1], zx + len], i * 6);
  }
  streakGeom.attributes.position.needsUpdate = true;
  if (g.state === "run" && now > bubNext) {
    bubNext = now + 40;
    const i = Math.floor(Math.random() * BUB);
    bubPos.set([g.x + rand(-0.8, 0.8), y + rand(-0.2, 0.6), -g.s + 1.4], i * 3);
    bubLife[i] = 1.2;
  }
  for (let i = 0; i < BUB; i++) {
    if (bubLife[i] <= 0) { bubPos[i * 3 + 1] = -9999; continue; }
    bubLife[i] -= dt;
    bubPos[i * 3 + 1] += dt * 2.2;
    bubPos[i * 3] += Math.sin(now / 200 + i) * dt * 0.4;
  }
  bubGeom.attributes.position.needsUpdate = true;

  // HUD
  const shown = Math.floor(g.score);
  if (shown !== shownScore) { $("score").textContent = shown.toLocaleString("en"); shownScore = shown; }
  $("dist").textContent = `${Math.floor(g.s).toLocaleString("en")} m`;
  $("mult").textContent = `×${g.mult}`;
  const combo = $("combo");
  combo.hidden = g.combo < 3;
  if (!combo.hidden) combo.textContent = `combo ${g.combo}`;
  const powers = [];
  if (g.turbo > 0) powers.push(`<span class="power" style="color:#ff7a1a">🚀 ${Math.ceil(g.turbo)}s</span>`);
  if (g.magnet > 0) powers.push(`<span class="power magnet">🧲 ${Math.ceil(g.magnet)}s</span>`);
  if (g.shield) powers.push(`<span class="power shield">🛡 shield</span>`);
  const html = powers.join("");
  if ($("powers").innerHTML !== html) $("powers").innerHTML = html;
}
function bump() {
  const el = $("score");
  el.classList.remove("bump");
  void el.offsetWidth;
  el.classList.add("bump");
}

function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (g.state !== "paused" && g.state !== "loading") update(dt, now);
  else updateSparks(dt);
  // the screen flash: colour over everything, fading fast
  const f = $("flash");
  if (flashLevel > 0.004) {
    f.style.background = flashColor;
    f.style.opacity = flashLevel.toFixed(3);
    flashLevel *= Math.exp(-dt * 7);
  } else if (f.style.opacity !== "0") { f.style.opacity = "0"; flashLevel = 0; }
  renderer.render(scene, camera);
  renderGallery(dt, now);
  requestAnimationFrame(frame);
}

// ---------- input ----------
function primary() {
  if (g.state === "ready") start();
  else if (g.state === "paused") setPaused(false);
}
window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) { // typing the name
    if (e.key === "Enter") { e.preventDefault(); saveScore(); e.target.blur(); }
    return;
  }
  const k = e.key;
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " "].includes(k)) e.preventDefault();
  if (k === "ArrowLeft" || k === "a" || k === "A") steer(-1);
  else if (k === "ArrowRight" || k === "d" || k === "D") steer(1);
  else if (k === "ArrowUp" || k === "w" || k === "W") vertical(ALT_UP);
  else if (k === "ArrowDown" || k === "s" || k === "S") vertical(ALT_DOWN);
  else if (k === " ") { if (g.state === "run") vertical(ALT_UP); else primary(); }
  else if (k === "Enter") { if (!saved && g.state !== "run") saveScore(); else primary(); }
  else if (k === "p" || k === "P" || k === "Escape") setPaused(g.state === "run");
  else if (k === "m" || k === "M") toggleMute();
  else if (k === "n" || k === "N") toggleMusic();
});
let touch = null;
window.addEventListener("touchstart", (e) => {
  const t = e.changedTouches[0];
  touch = { x: t.clientX, y: t.clientY, done: false };
}, { passive: true });
window.addEventListener("touchmove", (e) => {
  if (!touch || touch.done) return;
  const t = e.changedTouches[0], dx = t.clientX - touch.x, dy = t.clientY - touch.y;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
  touch.done = true; // one swipe, one move
  if (Math.abs(dx) > Math.abs(dy)) steer(dx > 0 ? 1 : -1);
  else vertical(dy < 0 ? ALT_UP : ALT_DOWN);
}, { passive: true });
window.addEventListener("touchend", (e) => {
  if (touch && !touch.done && !e.target.closest("button, a, input, .card")) primary();
  touch = null;
});
function toggleMute() {
  muted = !muted;
  store.set("deeprun.muted", muted ? "1" : "0");
  $("mute").textContent = muted ? "🔇" : "🔊";
  if (master) master.gain.setTargetAtTime(muted ? 0 : 1, audio.currentTime, 0.05);
}
$("music").addEventListener("click", toggleMusic);
$("music").classList.toggle("off", !music.on);
$("mute").addEventListener("click", toggleMute);
$("pause").addEventListener("click", () => setPaused(g.state === "run"));
$("play").addEventListener("click", start);
$("again").addEventListener("click", start);
$("save").addEventListener("click", saveScore);
$("resume").addEventListener("click", () => setPaused(false));
document.addEventListener("visibilitychange", () => { if (document.hidden) setPaused(true); });
window.addEventListener("blur", () => setPaused(true));

// the name for the high score list: the last one typed
$("name").value = store.get("deeprun.name") || "";
$("as").textContent = "Scores and stats stay on this device.";

if (new URLSearchParams(location.search).has("debug")) { // for testing: set g.score etc., look at models
  window.deeprun = g;
  window.deeprunKit = { THREE, scene, camera, MAKE, makeAuv, makeSub, makeFlyOfos, waveArm, things, place, LANES, startFly, placeCorer, get fly() { return fly; }, makeRunner, get runner() { return runnerObj; }, get audio() { return audio; }, get master() { return master; }, music };
}
loadBoard($("board1"));
newRun();
requestAnimationFrame(frame);
})();
