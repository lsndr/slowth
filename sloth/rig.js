// Rig: two-bone IK, claw-hook planner (plant / step / slip), face + body animation, scratch marks.
// Page coordinates are CSS pixels (y down). Three.js world is (x, -y, z).
import * as THREE from 'three';
import { buildSloth, SHARED } from './model.js';

const V3 = THREE.Vector3;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const sm = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));
const env = (t, a, b, c, d) => t < a ? 0 : t < b ? sm((t - a) / (b - a)) : t < c ? 1 : t < d ? 1 - sm((t - c) / (d - c)) : 0;
const pw = (t, k) => { // piecewise-smooth keyframes [[t,v],...]
  if (t <= k[0][0]) return k[0][1];
  for (let i = 1; i < k.length; i++) if (t <= k[i][0]) return lerp(k[i - 1][1], k[i][1], sm((t - k[i - 1][0]) / (k[i][0] - k[i - 1][0])));
  return k[k.length - 1][1];
};

/* ---------- two-bone IK ---------- */
const _d = new V3(), _pv = new V3();
function solveIK(S, T, pole, l1, l2, elbow, wrist) {
  _d.copy(T).sub(S);
  const dist = _d.length() || 1e-4;
  const dc = clamp(dist, Math.abs(l1 - l2) + 0.5, (l1 + l2) * 0.996);
  _d.multiplyScalar(1 / dist);
  const a = (l1 * l1 - l2 * l2 + dc * dc) / (2 * dc);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  _pv.copy(pole).addScaledVector(_d, -pole.dot(_d));
  if (_pv.lengthSq() < 1e-6) _pv.set(0, 0, -1);
  _pv.normalize();
  elbow.copy(S).addScaledVector(_d, a).addScaledVector(_pv, h);
  wrist.copy(S).addScaledVector(_d, dc);
}

const Y = new V3(0, 1, 0), _q = new THREE.Quaternion();
function placeSeg(g, A, B) {
  g.position.copy(A);
  _d.copy(B).sub(A);
  if (_d.lengthSq() > 1e-8) g.quaternion.copy(_q.setFromUnitVectors(Y, _d.normalize()));
}
const _bx = new V3(), _bz = new V3(), _m = new THREE.Matrix4(), _zref = new V3(0, 0, 1);
function placeHand(g, W, dir) { // local +y = dir, local -z faces the card
  g.position.copy(W);
  _bx.crossVectors(dir, _zref); if (_bx.lengthSq() < 1e-6) _bx.set(1, 0, 0); _bx.normalize();
  _bz.crossVectors(_bx, dir).normalize();
  _m.makeBasis(_bx, dir, _bz); g.quaternion.setFromRotationMatrix(_m);
}

/* ---------- gripping parameters per fight level ---------- */
const LEVELS = [
  { reach: 30, stepDur: 0.9, cool: 0.25, minRel: 6, maxRel: 54, slips: false },   // calm / climbing back
  { reach: 32, stepDur: 0.5, cool: 0.12, minRel: 8, maxRel: 52, slips: false },   // fighting
  { reach: 20, stepDur: 0.26, cool: 0.04, minRel: 8, maxRel: 46, slips: true },   // panic
];
const LANES = [16, 6, -12, -22];

export function createRig(scene) {
  const M = buildSloth(); scene.add(M.root);
  const { face } = M;

  /* shadow blob on the card face */
  const sc = document.createElement('canvas'); sc.width = sc.height = 64;
  const sx = sc.getContext('2d'), grd = sx.createRadialGradient(32, 32, 2, 32, 32, 31);
  grd.addColorStop(0, 'rgba(20,10,0,.55)'); grd.addColorStop(1, 'rgba(20,10,0,0)');
  sx.fillStyle = grd; sx.fillRect(0, 0, 64, 64);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sc), transparent: true, depthWrite: false }));
  shadow.renderOrder = -1; scene.add(shadow);

  /* scratch marks left by slipping claws */
  const scratches = [];
  for (let i = 0; i < 54; i++) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: '#2a1a0e', transparent: true, opacity: 0, depthWrite: false }));
    m.visible = false; m.position.z = 1.2; scene.add(m); scratches.push({ m, life: 0 });
  }
  let sIdx = 0;
  function scratch(x, y, dx) {
    const len = Math.max(3, Math.abs(dx));
    for (let k = -1; k <= 1; k++) {
      const s = scratches[sIdx++ % scratches.length];
      s.life = 1; s.m.visible = true;
      s.m.position.set(x - dx / 2, -(y + k * 3.4), 1.2);
      s.m.scale.set(len, 1.1, 1);
      s.m.rotation.z = (Math.random() - 0.5) * 0.12;
    }
  }

  const limbs = M.limbs.map((m, i) => ({
    m, i, front: i < 2, near: i % 2 === 0, mode: 'free',
    pos: new V3(0, 0, 0), vel: new V3(), anchor: null,
    from: null, to: null, stepT: 0, stepDur: 0.7, cool: 0, waitT: 0, slipT: 0, prevSx: null, curl: 0.4,
    shuffleAt: 4 + i * 2.3, zoff: 0,
  }));
  const partner = i => limbs[i ^ 1];

  /* tmp vectors */
  const tS = new V3(), tT = new V3(), tE = new V3(), tW = new V3(), tD = new V3(), pole = new V3();

  let time = 0, state = '', stateT = 0, blinkAt = 3, blinkT = -1, idle = null, nextIdle = 7;
  const fp = { o: 0.04, brow: 0, mouth: 0, teeth: 0, sweat: 0, yaw: 0.5, pitch: 0.3, roll: -0.1, headY: -8, wide: 1 };
  let wx = 0, wy = 0;
  const headCss = { x: 0, y: 0 };

  function newAnchor(L, sxs, g, surf) {
    let x = sxs + g.up * g.reach + LANES[L.i] + (Math.random() - 0.5) * 6;
    x = clamp(x, surf.cx - surf.half + 8, surf.cx + surf.half - 8);
    return { x, y: surf.top + (L.near ? 26 : 31) + Math.random() * 3 };
  }
  function startStep(L, sxs, g, surf) {
    L.from = { x: L.pos.x, y: L.pos.y };
    L.to = newAnchor(L, sxs, g, surf);
    L.stepT = 0; L.stepDur = g.stepDur * (0.85 + Math.random() * 0.3); L.mode = 'stepping'; L.anchor = null;
  }

  /* --------- one frame --------- */
  function update(dt, inp) {
    time += dt;
    if (inp.state !== state) { state = inp.state; stateT = 0; idle = null; nextIdle = time + 6 + Math.random() * 4; } else stateT += dt;
    const st = state, t = stateT;
    const surf = inp.surface;
    const g = { ...LEVELS[inp.level || 0], up: inp.up || 0, slide: -(inp.up || 0) };
    if (!inp.up) g.reach = 0;

    /* --- root + wind --- */
    M.root.position.set(inp.cx, -inp.cy, -10);
    M.root.rotation.z = -inp.rot * Math.PI / 180;
    const sq = inp.squash == null ? 1 : inp.squash;
    M.root.scale.set(1 / Math.sqrt(sq), sq, 1 / Math.sqrt(sq));
    wx = damp(wx, clamp(-(inp.vx || 0) * 0.02, -9, 9), 6, dt);
    wy = damp(wy, clamp(-(inp.vy || 0) * 0.02, -9, 9), 6, dt);
    SHARED.uWind.value.set(wx, wy, 0);

    /* --- breathing / strain --- */
    const breathHz = st === 'sleeping' ? 0.19 : st === 'awake' ? 0.3 : 0.5;
    let breath = Math.sin(time * breathHz * Math.PI * 2) * (st === 'sleeping' ? 0.035 : 0.02);
    let strain = 0;
    if (st === 'awake' && inp.level === 1) strain = Math.sin(time * 17) * 0.5 + 0.5;
    if (st === 'awake' && inp.level === 2) strain = Math.sin(time * 26) * 0.5 + 0.5;
    M.chest.scale.set(1 + strain * 0.015, 1 + breath * 0.9 - strain * 0.03, 1 + breath);
    M.chest.rotation.z = st === 'sleeping' ? -0.05 : st === 'awake' ? (inp.level ? 0.07 * (inp.slide || 0) + strain * 0.015 : 0) : 0;
    M.pelvis.rotation.z = 0;
    M.root.updateMatrixWorld(true);

    /* --- idle events while asleep --- */
    if (st === 'sleeping') {
      if (!idle && time > nextIdle) { idle = { type: ['stretch', 'stir', 'stir', 'stretch'][Math.floor(Math.random() * 4)], t: 0, dur: 5.5 }; }
      if (idle) { idle.t += dt; if (idle.t > idle.dur) { idle = null; nextIdle = time + 8 + Math.random() * 7; } }
    }
    const idleP = idle ? idle.t / idle.dur : 0;
    const stir = idle && idle.type === 'stir' ? env(idleP, 0.1, 0.35, 0.6, 0.9) : 0;
    const stretch = idle && idle.type === 'stretch' ? env(idleP, 0.1, 0.4, 0.6, 0.9) : 0;
    const shake = inp.shakeStir ? 1 : 0;

    /* --- limbs --- */
    let pullSum = 0, pullW = 0, planted = 0;
    for (const L of limbs) {
      const sh = L.m.shoulder.getWorldPosition(tS);
      const shx = sh.x, shy = -sh.y;
      const zPlane = L.near ? 5 : 2.5;
      L.cool -= dt;
      let curlT = 0.4, extraX = 0, extraY = 0;
      const dsx = L.prevSx == null ? 0 : shx - L.prevSx; L.prevSx = shx;

      const hanging = inp.hang && L.i === 0;
      const gripOn = !!inp.gripOn && !hanging;

      if (hanging) {
        L.mode = 'hang'; L.anchor = { x: inp.hang.x, y: inp.hang.y };
        L.pos.set(inp.hang.x, inp.hang.y, zPlane); L.vel.set(0, 0, 0);
        curlT = inp.releasing ? -0.8 : 1;
      } else if (gripOn) {
        if (L.mode === 'free' || L.mode === 'hang') { L.mode = 'wait'; L.waitT = 0.15 + L.i * 0.35; L.anchor = null; }
        if (L.mode === 'wait') { L.waitT -= dt; if (L.waitT <= 0) startStep(L, shx, g, surf); }
        else if (L.mode === 'planted') {
          const a = L.anchor, rel = a.x - shx, relUp = rel * g.up;
          curlT = 1; planted++;
          let needs = false;
          if (g.up !== 0 && relUp < g.minRel) needs = true;
          if (Math.abs(rel) > g.maxRel) needs = true;
          if (!g.up && time > L.shuffleAt && L.cool <= 0) { needs = true; L.shuffleAt = time + 5 + Math.random() * 6; }
          if (needs && L.cool <= 0 && partner(L.i).mode !== 'stepping') startStep(L, shx, g, surf);
          else {
            if (Math.abs(rel) > g.maxRel + 3) {      // overstretched and unable to re-hook: claws get dragged
              const nx = shx + Math.sign(rel) * (g.maxRel + 3);
              scratch(nx, a.y, nx - a.x); a.x = nx;
            }
            if (g.slips && L.slipT <= 0 && Math.random() < dt * 1.4) L.slipT = 0.35;
            if (L.slipT > 0) {
              L.slipT -= dt; const dx = g.slide * 80 * dt;
              if (Math.abs(dx) > 0.01) { a.x += dx; if (Math.random() < 0.5) scratch(a.x, a.y, dx * 3); }
              curlT = 0.7;
            } else {
              pullSum += (front(L) ? 1 : 0.6) * (a.x - LANES[L.i] - shx); pullW += (front(L) ? 1 : 0.6);
            }
            L.pos.set(a.x, a.y, zPlane);
          }
        }
        if (L.mode === 'stepping') {
          L.to.x += dsx * 0.8;
          L.stepT += dt / L.stepDur;
          const u = sm(L.stepT);
          L.pos.x = lerp(L.from.x, L.to.x, u);
          const lift = Math.sin(Math.PI * clamp(L.stepT, 0, 1));
          L.pos.y = lerp(L.from.y, L.to.y, u) - lift * 10;
          L.pos.z = zPlane + lift * 14;
          curlT = L.stepT < 0.7 ? -0.6 : lerp(-0.6, 1, (L.stepT - 0.7) / 0.3);
          if (L.stepT >= 1) { L.mode = 'planted'; L.anchor = { x: L.to.x, y: L.to.y }; L.cool = g.cool; L.pos.z = zPlane; }
        }
      } else {
        if (L.mode !== 'free') { L.mode = 'free'; L.anchor = null; }
        curlT = 0.45;
      }

      if (L.mode === 'free' || L.mode === 'wait') {
        // dangling arm: critically-ish damped spring toward "hang from the shoulder", with per-state extras
        let hangLen = L.front ? 54 : 50;
        if (st === 'sleeping') {
          extraX = Math.sin(time * 0.6 + L.i) * 3;
          if (L.i === 0) { extraX += stretch * 42; extraY -= stretch * 92; curlT = lerp(0.45, -0.3, stretch); }
          if (L.i === 1) { extraX -= stir * 6; }
        } else if (st === 'waking') {
          const y = env(t, 1.0, 1.6, 2.1, 2.8);
          if (L.i === 0) { extraX += y * 46; extraY -= y * 96; curlT = lerp(0.45, -0.5, y); }
          extraX += Math.sin(time * 1.2 + L.i) * 2;
        } else if (st === 'falling' || st === 'dangling') {
          const fl = st === 'falling' ? 1 : 0.7 + 0.3 * (inp.level === 2 ? 1 : 0);
          if (st === 'falling' || L.front) {
            extraX += Math.sin(time * (8 + L.i) + L.i * 1.7) * 40 * fl;
            extraY += -30 + Math.cos(time * (7 + L.i * 0.6) + L.i) * 34 * fl;
            curlT = Math.sin(time * 9 + L.i) * 0.7;
          }
          if (st === 'dangling' && L.i === 1 && inp.hang) {   // free hand scrabbles for the edge
            const tx = inp.hang.x + (inp.dir || 1) * -6 + Math.sin(time * 5) * 7;
            extraX = tx - shx - 0; hangLen = 0; extraY = inp.hang.y + 10 + Math.cos(time * 6) * 8 - shy;
          }
        } else if (st === 'landed') {
          extraX = Math.sin(time * 0.5 + L.i) * 3;
        }
        const tx = shx + extraX, ty = shy + hangLen + extraY;
        const k = 80, c = 9.5;
        L.vel.x += ((tx - L.pos.x) * k - L.vel.x * c) * dt;
        L.vel.y += ((ty - L.pos.y) * k - L.vel.y * c) * dt;
        L.vel.z += ((zPlane - L.pos.z) * k - L.vel.z * c) * dt;
        L.pos.addScaledVector(L.vel, dt);
        // keep the free hand roughly within reach
        const dx = L.pos.x - shx, dy = L.pos.y - shy, dl = Math.hypot(dx, dy);
        const maxL = L.m.l1 + L.m.l2 + 6;
        if (dl > maxL) { L.pos.x = shx + dx / dl * maxL; L.pos.y = shy + dy / dl * maxL; }
        if (L.mode === 'free') L.mode = 'free';
      }

      /* ---- IK in root-local space ---- */
      L.curl = damp(L.curl, curlT, 14, dt);
      tT.set(L.pos.x, -L.pos.y, L.pos.z);                 // claw tip target (world)
      // hand direction: planted claws point along the card face; free ones continue the arm downward
      tD.set(0, -1, 0);
      if (L.mode === 'free' || L.mode === 'wait') tD.set(Math.sin(time * 0.7 + L.i) * 0.12 + L.vel.x * 0.003, -1, 0).normalize();
      tW.copy(tT).addScaledVector(tD, -21);                // wrist sits 21px behind the claw tips
      M.root.worldToLocal(tT.copy(tW));
      const dirLocal = tD.clone().transformDirection(M.root.matrixWorld.clone().invert());
      const Sl = M.root.worldToLocal(tS.clone().set(shx, -shy, sh.z));
      pole.set(L.front ? -0.5 : 0.55, 0.15, L.near ? 0.7 : -0.7);
      solveIK(Sl, tT, pole, L.m.l1, L.m.l2, tE, tW);
      placeSeg(L.m.upper, Sl, tE);
      placeSeg(L.m.lower, tE, tW);
      placeHand(L.m.hand, tW, dirLocal);
      const open = Math.max(0, -L.curl);
      L.m.claws.forEach((c, ci) => { c.rotation.x = -L.curl * 0.62 + (L.curl < 0 ? 0.35 * -L.curl : 0); c.rotation.z = (ci - 1) * (0.1 + open * 0.28); });
    }

    /* --- face / head --- */
    let o = 0.95, brow = 0, mouth = 0, teeth = 0, sweat = 0, yaw = 0.15, pitch = 0.05, roll = 0, headY = 0, wide = 1;
    if (st === 'sleeping') {
      o = 0.04 + stir * 0.42 + (shake ? 0.25 : 0); yaw = 0.55 - stir * 0.2; pitch = 0.3 - stir * 0.15; roll = -0.1; headY = -8 + stir * 4;
    } else if (st === 'waking') {
      o = pw(t, [[0, 0.04], [1.05, 0.78], [1.45, 0.2], [1.85, 0.22], [2.35, 0.9], [2.6, 0.15], [3, 0.95]]);
      const y = env(t, 1.1, 1.7, 2.15, 2.75);
      mouth = y * 1.6; pitch = lerp(0.3, 0.05, sm(t / 1.6)) - 0.5 * y; yaw = lerp(0.55, 0.15, sm(t / 2)); roll = lerp(-0.1, 0, sm(t / 2)); headY = lerp(-8, 0, sm(t / 1.4)) + y * 4;
    } else if (st === 'awake') {
      const lv = inp.level || 0;
      if (lv === 0) { yaw = 0.2 + Math.sin(time * 0.35) * 0.3 + (inp.tilt || 0) * 0.008; pitch = 0.05 + Math.sin(time * 0.27) * 0.06; roll = Math.sin(time * 0.31) * 0.05; }
      else if (lv === 1) { o = 0.58; brow = 0.9; mouth = 0.18; teeth = 1; sweat = 1; yaw = 0; pitch = 0.2; roll = (inp.slide || 0) * -0.08; }
      else { o = 1.25; brow = -0.9; mouth = 1.1; sweat = 1.6; yaw = 0; pitch = -0.08; }
    } else if (st === 'dangling') {
      o = 1.2; brow = -0.8; mouth = inp.releasing ? 1.2 : 0.7; sweat = 1.4; yaw = 0; pitch = -0.4; teeth = inp.releasing ? 0 : 0.4;
    } else if (st === 'falling') {
      o = 1.3; brow = -1; mouth = 1.4; yaw = 0; pitch = -0.2; sweat = 0;
    } else if (st === 'landed') {
      o = 0.9 - sm((t - 4) / 5) * 0.8; yaw = 0.2; pitch = 0.1 + sm((t - 4) / 5) * 0.2; headY = -sm((t - 4) / 5) * 6;
    }
    // blinking when awake
    if ((st === 'awake' || st === 'landed') && !(inp.level >= 1)) {
      if (blinkT < 0 && time > blinkAt) { blinkT = 0; blinkAt = time + 2.5 + Math.random() * 3.5; }
      if (blinkT >= 0) { blinkT += dt; const b = Math.sin(clamp(blinkT / 0.22, 0, 1) * Math.PI); o *= 1 - b * 0.92; if (blinkT > 0.22) blinkT = -1; }
    }
    const K = (st === 'waking' || st === 'sleeping') ? 12 : 9;
    fp.o = damp(fp.o, o, K, dt); fp.brow = damp(fp.brow, brow, 10, dt); fp.mouth = damp(fp.mouth, mouth, 12, dt);
    fp.teeth = damp(fp.teeth, teeth, 14, dt); fp.sweat = damp(fp.sweat, sweat, 8, dt);
    fp.yaw = damp(fp.yaw, yaw, 4, dt); fp.pitch = damp(fp.pitch, pitch, 5, dt); fp.roll = damp(fp.roll, roll, 4, dt);
    fp.headY = damp(fp.headY, headY, 4, dt);

    const jit = (st === 'awake' && inp.level >= 1) ? (inp.level === 2 ? 0.05 : 0.025) : 0;
    M.head.position.y = fp.headY + (jit ? Math.sin(time * 41) * 0.8 : 0);
    M.head.rotation.set(fp.pitch, fp.yaw, fp.roll + (jit ? Math.sin(time * 37) * jit : 0), 'YXZ');
    M.head.updateMatrixWorld(true);

    const open01 = clamp(fp.o, 0, 1);
    for (const e of face.eyes) {
      e.lidPivot.rotation.x = lerp(1.62, -0.45, open01);
      const sc = 1 + Math.max(0, fp.o - 1) * 0.5;
      e.ball.scale.setScalar(sc);
    }
    for (const b of face.brows) {
      const a = Math.abs(fp.brow);
      b.mesh.scale.set(1, a * 1.3, 1);
      b.mesh.rotation.z = -b.s * fp.brow * 0.5;
      b.mesh.position.y = 12.2 + (fp.brow < 0 ? 2.5 * a : -1.5 * a);
    }
    face.mouth.scale.set(1 + fp.mouth * 0.15, Math.max(0.001, fp.mouth), 1);
    face.mouth.position.y = -11.3 - fp.mouth * 1.2;
    face.teeth.scale.y = Math.max(0.001, fp.teeth); face.teeth.visible = fp.teeth > 0.05;
    face.smile.visible = fp.mouth < 0.7;
    for (const s of face.sweat) {
      const ph = ((time * (fp.sweat > 1.2 ? 1.9 : 1.1)) + s.ph) % 1;
      s.mesh.visible = fp.sweat > 0.1;
      s.mesh.position.y = s.y - ph * 24; s.mesh.scale.setScalar(clamp(fp.sweat, 0, 1) * (1 - ph * 0.5));
    }

    /* --- head position for the z z Z bubble --- */
    M.head.getWorldPosition(tS); headCss.x = tS.x; headCss.y = -tS.y;

    /* --- shadow + scratches --- */
    const sh = inp.shadow;
    if (sh) { shadow.visible = sh.a > 0.01; shadow.position.set(sh.x, -sh.y, 0.4); shadow.scale.set(sh.w, sh.h, 1); shadow.material.opacity = sh.a; }
    for (const s of scratches) if (s.life > 0) { s.life -= dt / 3; s.m.material.opacity = Math.max(0, s.life) * 0.5; if (s.life <= 0) s.m.visible = false; }

    return { pull: pullW > 0 ? pullSum / 3.2 : 0, planted, head: headCss };
  }
  function front(L) { return L.front; }
  function reset() { for (const L of limbs) { L.mode = 'free'; L.anchor = null; } for (const s of scratches) { s.life = 0; s.m.visible = false; } }

  return { update, reset, root: M.root, limbs };
}
