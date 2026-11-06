// Procedural 3D sloth: ellipsoid body parts covered in shell-fur, a face with lids/brows/mouth, long hooked claws.
// Units are CSS pixels (the whole scene is calibrated so 1 world unit == 1 CSS px at z=0).
import * as THREE from 'three';

export const SHARED = {
  uWind: { value: new THREE.Vector3() },
  uLight: { value: new THREE.Vector3(-0.35, 0.75, 0.55).normalize() },
};

/* ---------------- Shell fur ---------------- */
const FUR_VERT = /* glsl */`
uniform float uLayers, uLen, uDroop;
uniform vec3 uWind;
varying vec3 vN, vLN, vLocal, vView;
varying float vL;
void main() {
  float l = float(gl_InstanceID) / (uLayers - 1.0);
  vec3 p = position + normal * uLen * l;
  vec4 w = modelMatrix * vec4(p, 1.0);
  w.y -= uDroop * l * l;
  w.xyz += uWind * l * l;
  vL = l; vLocal = position; vLN = normal;
  vN = normalize(mat3(modelMatrix) * normal);
  vView = cameraPosition - w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const FUR_FRAG = /* glsl */`
uniform vec3 uRoot, uTip, uLight, uRim, uAlgae, uCutC, uCutR;
uniform float uDensity, uAlgaeAmt;
varying vec3 vN, vLN, vLocal, vView;
varying float vL;
float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
void main() {
  if (uCutR.x > 0.0) { vec3 d = (vLocal - uCutC) / uCutR; if (dot(d, d) < 1.0) discard; }
  mat3 R = mat3(0.80, 0.36, -0.48, -0.31, 0.93, 0.19, 0.51, -0.05, 0.86);
  vec3 q = R * vLocal * uDensity + vec3(13.7, 5.1, 9.3); vec3 c = floor(q);
  float h = hash(c), h2 = hash(c + 7.31);
  vec3 f = fract(q) - 0.5 - (vec3(h2, hash(c + 3.1), hash(c + 9.7)) - 0.5) * 0.55;
  if (vL > 0.001) {
    float len = 0.3 + 0.7 * h;
    if (vL > len) discard;
    float rad = 0.64 * (1.0 - 0.8 * vL / len);
    if (length(f) > rad) discard;
  }
  vec3 N = normalize(vN), V = normalize(vView);
  float diff = clamp(dot(N, uLight) * 0.5 + 0.5, 0.0, 1.0); diff *= diff;
  float ao = mix(0.32, 1.0, pow(vL, 0.7));
  vec3 col = mix(uRoot, uTip, pow(vL, 0.8) * (0.65 + 0.55 * h2));
  col = mix(col, uAlgae, uAlgaeAmt * clamp(vLN.y, 0.0, 1.0) * vL);
  col *= (0.38 + 0.85 * diff) * ao;
  float rim = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
  col += uRim * rim * vL * 0.5;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

function makeFur({ radii, offset = [0, 0, 0], len, root, tip, rim = '#ffe2b0', algae = 0, layers = 16,
                   density = 0.85, droop = 3, cut = null, seg = [28, 18] }) {
  const g = new THREE.SphereGeometry(1, seg[0], seg[1]);
  const p = g.attributes.position, n = g.attributes.normal;
  const [a, b, c] = radii;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const nx = x / a, ny = y / b, nz = z / c, nl = Math.hypot(nx, ny, nz) || 1;
    n.setXYZ(i, nx / nl, ny / nl, nz / nl);
    p.setXYZ(i, x * a + offset[0], y * b + offset[1], z * c + offset[2]);
  }
  g.computeBoundingSphere();
  const mat = new THREE.ShaderMaterial({
    vertexShader: FUR_VERT, fragmentShader: FUR_FRAG,
    uniforms: {
      uLayers: { value: layers }, uLen: { value: len }, uDroop: { value: droop },
      uWind: SHARED.uWind, uLight: SHARED.uLight,
      uRoot: { value: new THREE.Color(root) }, uTip: { value: new THREE.Color(tip) },
      uRim: { value: new THREE.Color(rim) }, uAlgae: { value: new THREE.Color('#8f9b5f') },
      uAlgaeAmt: { value: algae }, uDensity: { value: density },
      uCutC: { value: new THREE.Vector3(...(cut ? cut.c : [0, 0, 0])) },
      uCutR: { value: new THREE.Vector3(...(cut ? cut.r : [0, 0, 0])) },
    },
  });
  const mesh = new THREE.InstancedMesh(g, mat, layers);
  const id = new THREE.Matrix4();
  for (let i = 0; i < layers; i++) mesh.setMatrixAt(i, id);
  mesh.frustumCulled = false;
  return mesh;
}

/* ---------------- helpers ---------------- */
function ellipsoid(r, color, { rough = 0.7, metal = 0, emissive = 0 } = {}) {
  const g = new THREE.SphereGeometry(1, 16, 12);
  g.scale(r[0], r[1], r[2]);
  return new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, emissive: emissive ? color : 0, emissiveIntensity: emissive }));
}

function clawGeo(len = 21, r = 2.1, bend = 9) {
  const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, len * 0.6, -bend * 0.2), new THREE.Vector3(0, len, -bend));
  const seg = 8, rad = 6;
  const g = new THREE.TubeGeometry(curve, seg, r, rad, false);
  const pos = g.attributes.position, c = new THREE.Vector3(), v = new THREE.Vector3();
  for (let i = 0; i <= seg; i++) {
    curve.getPointAt(i / seg, c);
    const k = 1 - 0.9 * Math.pow(i / seg, 0.9);
    for (let j = 0; j <= rad; j++) {
      const idx = i * (rad + 1) + j;
      v.fromBufferAttribute(pos, idx).sub(c).multiplyScalar(k).add(c);
      pos.setXYZ(idx, v.x, v.y, v.z);
    }
  }
  g.computeVertexNormals();
  return g;
}

const CLAW_GEO = clawGeo();
const CLAW_MAT = new THREE.MeshStandardMaterial({ color: '#efe3c6', roughness: 0.42, metalness: 0.05 });

function buildLimb(front, near) {
  const l1 = front ? 32 : 30, l2 = front ? 30 : 28, r1 = front ? 9.5 : 10.5, r2 = front ? 7.6 : 8.4;
  const col = near ? { root: '#34251a', tip: '#a78a63' } : { root: '#22160f', tip: '#7a6246' };
  const upper = new THREE.Group(), lower = new THREE.Group(), hand = new THREE.Group();
  upper.add(makeFur({ radii: [r1, l1 / 2 + r1 * 0.55, r1], offset: [0, l1 / 2, 0], len: 5.5, ...col, algae: 0.15, seg: [18, 12] }));
  lower.add(makeFur({ radii: [r2, l2 / 2 + r2 * 0.55, r2], offset: [0, l2 / 2, 0], len: 5, ...col, seg: [18, 12] }));
  hand.add(makeFur({ radii: [6.4, 8.5, 5.8], offset: [0, 3, 0], len: 3.5, ...col, seg: [14, 10] }));
  const claws = [];
  for (let i = 0; i < 3; i++) {
    const pivot = new THREE.Group();
    pivot.position.set((i - 1) * 3.7, 9, 0);
    const m = new THREE.Mesh(CLAW_GEO, CLAW_MAT);
    pivot.add(m); hand.add(pivot); claws.push(pivot);
  }
  return { upper, lower, hand, claws, l1, l2, front, near };
}

function bentTube(pts, r) {
  return new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(...pts.map(p => new THREE.Vector3(...p))), 12, r, 6, false);
}

/* ---------------- the sloth ---------------- */
export function buildSloth() {
  const root = new THREE.Group();
  const body = new THREE.Group(); root.add(body);
  const pelvis = new THREE.Group(); body.add(pelvis);
  const chest = new THREE.Group(); chest.position.set(-10, 0, 0); pelvis.add(chest);

  pelvis.add(makeFur({ radii: [55, 28, 31], offset: [-36, -2, 0], len: 8, root: '#2f2118', tip: '#a88a62', algae: 0.3, droop: 4 }));
  chest.add(makeFur({ radii: [57, 30, 33], offset: [42, 3, 0], len: 9, root: '#33241a', tip: '#b19468', algae: 0.4, droop: 4 }));

  /* head (face looks toward +z, i.e. at the viewer) */
  const head = new THREE.Group(); head.position.set(96, 0, 8); head.scale.setScalar(1.25); chest.add(head);
  head.add(makeFur({
    radii: [27, 23, 24], len: 7, root: '#33241a', tip: '#b39569', algae: 0.2, density: 1.0, droop: 2.5,
    cut: { c: [0, -2, 12], r: [17.5, 14, 15] }, seg: [28, 20],
  }));
  const mask = makeFur({ radii: [19, 16, 13], offset: [0, -2, 12], len: 1.8, root: '#b79d74', tip: '#f1e4c4', rim: '#fff4dc', density: 1.4, droop: 0, layers: 8, seg: [24, 16] });
  head.add(mask);

  const dark = '#4d392a';
  for (const s of [-1, 1]) {   // eye stripes
    const st = ellipsoid([5.4, 10.5, 3.2], dark, { rough: 0.9 });
    st.position.set(s * 10.5, 0.5, 23); st.rotation.z = -s * 0.25; head.add(st);
  }

  const eyes = [];
  for (const s of [-1, 1]) {
    const pivot = new THREE.Group(); pivot.position.set(s * 10, 3.8, 24.3); head.add(pivot);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(3.4, 20, 14), new THREE.MeshStandardMaterial({ color: '#0d0907', roughness: 0.08, metalness: 0.15 }));
    pivot.add(ball);
    const glint = new THREE.Mesh(new THREE.SphereGeometry(0.95, 8, 6), new THREE.MeshBasicMaterial({ color: '#ffffff' }));
    glint.position.set(1.2, 1.4, 2.7); ball.add(glint);
    const lidPivot = new THREE.Group(); pivot.add(lidPivot);
    const lid = new THREE.Mesh(new THREE.SphereGeometry(3.85, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#5a4332', roughness: 0.95, side: THREE.DoubleSide }));
    lidPivot.add(lid);
    eyes.push({ pivot, ball, lidPivot });
  }

  const brows = [];
  for (const s of [-1, 1]) {
    const b = ellipsoid([6, 1.3, 1.6], '#2a1d14', { rough: 1 });
    b.position.set(s * 10.5, 12.2, 23.4); head.add(b); brows.push({ mesh: b, s });
  }

  const nose = ellipsoid([4.8, 3.3, 3.6], '#17100b', { rough: 0.25 });
  nose.position.set(0, -4.5, 25.6); head.add(nose);

  const smile = new THREE.Mesh(bentTube([[-7.5, -9.2, 23.2], [0, -13.5, 25.8], [7.5, -9.2, 23.2]], 0.85), new THREE.MeshStandardMaterial({ color: '#3a281b', roughness: 0.9 }));
  head.add(smile);
  const mouth = ellipsoid([6.8, 5.6, 2.6], '#35151a', { rough: 0.6 });
  mouth.position.set(0, -11.3, 24.4); head.add(mouth);
  const teeth = new THREE.Mesh(new THREE.BoxGeometry(12, 3.4, 1.6), new THREE.MeshStandardMaterial({ color: '#f6eedc', roughness: 0.4 }));
  teeth.position.set(0, -8.6, 25.4); head.add(teeth);

  const sweat = [];
  for (const [x, y, z, ph] of [[22, 16, 12, 0], [-23, 12, 10, 0.5]]) {
    const d = new THREE.Mesh(new THREE.SphereGeometry(2.1, 10, 8), new THREE.MeshStandardMaterial({ color: '#9fd8f2', roughness: 0.1, transparent: true, opacity: 0.9 }));
    d.scale.set(0.8, 1.25, 0.8); d.position.set(x, y, z); head.add(d); sweat.push({ mesh: d, x, y, z, ph });
  }

  /* limbs (placed by IK in root space; fur-covered, with long claws) */
  const defs = [
    { front: true, near: true, parent: chest, at: [64, -8, 17] },
    { front: true, near: false, parent: chest, at: [64, -8, -17] },
    { front: false, near: true, parent: pelvis, at: [-62, -8, 17] },
    { front: false, near: false, parent: pelvis, at: [-62, -8, -17] },
  ];
  const limbs = defs.map(d => {
    const L = buildLimb(d.front, d.near);
    L.shoulder = new THREE.Object3D(); L.shoulder.position.set(...d.at); d.parent.add(L.shoulder);
    root.add(L.upper, L.lower, L.hand);
    return L;
  });
  // far-side limbs first so near ones draw over them (depth buffer does the real work)
  return { root, body, pelvis, chest, head, limbs, face: { eyes, brows, nose, smile, mouth, teeth, sweat } };
}
