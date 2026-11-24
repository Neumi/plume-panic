// The ROV model (a work-class ROV), from Bubblemaker's 3D view: window.DeepRun.buildRov.
window.DeepRun = window.DeepRun || {};
(() => {
"use strict";
const THREE = window.THREE;

const RAD = Math.PI / 180;
const ROV_KEEL = 0.99; // m: underside of the skids below the model's origin

/** A cylinder from point a to point b ([x, y, z]). */
function tube(a, b, radius, material, segments = 10) {
  const from = new THREE.Vector3(...a), to = new THREE.Vector3(...b);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, from.distanceTo(to), segments), material);
  m.position.copy(from).add(to).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize());
  return m;
}

/** A work-class ROV, about 3 m long, 1.8 m wide and 2 m high; forward = -z, up = +y:
 * yellow buoyancy block on an open frame with skids, thrusters, pressure housings,
 * a camera on a pan-and-tilt and two manipulator arms at the front. */
function buildRov() {
  const g = new THREE.Group();
  const yellow = new THREE.MeshStandardMaterial({ color: 0xf5c400, roughness: 0.5 });
  const frameMat = new THREE.MeshStandardMaterial({ color: 0xb8bec6, metalness: 0.6, roughness: 0.35 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x23272d, roughness: 0.7 });
  const housing = new THREE.MeshStandardMaterial({ color: 0x8a939e, metalness: 0.7, roughness: 0.3 });
  const orange = new THREE.MeshStandardMaterial({ color: 0xff7a1a, roughness: 0.5 });
  const L = 1.45, W = 0.85, TOP = 0.45, BOT = -0.85; // frame half length / half width, rails (m)

  // Buoyancy: yellow foam on top, a darker band under it, three vertical thruster ducts through it.
  const foam = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.55, 2.9), yellow);
  foam.position.y = 0.78;
  const band = new THREE.Mesh(new THREE.BoxGeometry(1.82, 0.08, 2.92), dark);
  band.position.y = 0.49;
  g.add(foam, band);
  for (const [x, z] of [[-0.5, -0.55], [0.5, -0.55], [0, 0.75]]) {
    const duct = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.57, 20), dark);
    duct.position.set(x, 0.78, z);
    g.add(duct);
  }

  // Open frame: corner and middle posts, rails along the sides and across the ends.
  for (const x of [-W, W]) {
    for (const z of [-L, 0, L]) g.add(tube([x, BOT, z], [x, TOP, z], 0.04, frameMat));
    for (const y of [BOT, TOP, -0.2]) g.add(tube([x, y, -L], [x, y, L], 0.035, frameMat));
  }
  for (const z of [-L, L]) for (const y of [BOT, TOP]) g.add(tube([-W, y, z], [W, y, z], 0.035, frameMat));
  // Skids: their underside is the lowest point
  for (const x of [-0.7, 0.7]) {
    const skid = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 3.1), dark);
    skid.position.set(x, -ROV_KEEL + 0.06, 0);
    g.add(skid);
  }

  // Pressure housings (electronics, hydraulics) inside the frame, along the ROV.
  for (const [x, y, r] of [[-0.35, -0.15, 0.17], [0.35, -0.15, 0.17], [0, -0.55, 0.22]]) {
    g.add(tube([x, y, -0.9], [x, y, 1.1], r, housing, 16));
  }

  // Horizontal thrusters at the four corners, turned 45° (vectored), orange shrouds.
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const c = [x * 0.72, -0.2, z * 1.22];
    const axis = [x * 0.16, 0, -z * 0.16];
    g.add(tube([c[0] - axis[0], c[1], c[2] - axis[2]], [c[0] + axis[0], c[1], c[2] + axis[2]], 0.17, orange, 16));
  }

  // Camera on a pan-and-tilt, front centre, lens forward (blue).
  const cam = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.3, 0.36), housing);
  cam.position.set(0, 0.1, -1.45);
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.1, 16),
    new THREE.MeshStandardMaterial({ color: 0x80d0ff, emissive: 0x2060a0 }));
  lens.rotation.x = Math.PI / 2;
  lens.position.set(0, 0.1, -1.68);
  g.add(cam, lens);

  // Two manipulator arms, folded forward and down below the camera, with jaws.
  for (const x of [-0.45, 0.45]) {
    const shoulder = [x, -0.55, -1.35], elbow = [x, -0.35, -1.85], wrist = [x * 0.7, -0.75, -2.1];
    g.add(tube(shoulder, elbow, 0.07, housing), tube(elbow, wrist, 0.06, housing));
    for (const dx of [-0.06, 0.06]) g.add(tube(wrist, [wrist[0] + dx, -0.92, -2.18], 0.025, dark, 6));
  }

  // Headlights: two lamps at the front, real spot lights (light up the seafloor) plus
  // faint beams, so the ROV's direction is obvious at a glance.
  const beamMat = new THREE.MeshBasicMaterial({
    color: 0xfff1c0, transparent: true, opacity: 0.08, side: THREE.DoubleSide,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const BEAM = 14, TILT = 30 * RAD; // beam length (m), angle below the ROV's horizontal
  const dir = new THREE.Vector3(0, -Math.sin(TILT), -Math.cos(TILT)); // forward = -z, down
  for (const x of [-0.6, 0.6]) {
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xfff6d8 }));
    lamp.position.set(x, 0.3, -1.5); // on the top front rail
    // Open cone with its apex moved to the origin, opening along -y; then turned to `dir`.
    const geom = new THREE.ConeGeometry(BEAM * 0.3, BEAM, 24, 1, true).translate(0, -BEAM / 2, 0);
    const beam = new THREE.Mesh(geom, beamMat);
    beam.position.copy(lamp.position);
    beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir);
    const spot = new THREE.SpotLight(0xfff1c0, 60, 45, 0.33, 0.5, 1.2);
    spot.position.copy(lamp.position);
    spot.target.position.copy(lamp.position).addScaledVector(dir, 10);
    for (const o of [lamp, beam, spot]) o.userData.lit = true; // off while the position is stale
    g.add(lamp, beam, spot, spot.target);
  }
  // Navigation lights: red = port (-x), green = starboard (+x); forward is -z.
  for (const [x, color] of [[-0.98, 0xff3030], [0.98, 0x30ff60]]) {
    const light = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), new THREE.MeshBasicMaterial({ color }));
    light.position.set(x, 0.9, -1.2);
    light.userData.lit = true;
    g.add(light);
  }
  // Red flashing beacon on top (blink() in the render loop), lights up its surroundings.
  const beaconMat = new THREE.MeshBasicMaterial({ color: 0xff2020 });
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 8), beaconMat);
  beacon.position.set(0, 1.15, 1.0);
  const glow = new THREE.PointLight(0xff2020, 0, 12, 1.5);
  glow.position.copy(beacon.position);
  for (const o of [beacon, glow]) o.userData.lit = true;
  g.add(beacon, glow);
  /** Short flash once a second (t in ms). */
  g.userData.blink = (t) => {
    const on = t % 1000 < 150;
    beaconMat.color.setHex(on ? 0xff2020 : 0x401010);
    glow.intensity = on ? 8 : 0;
  };
  return g;
}

DeepRun.buildRov = buildRov;
})();
