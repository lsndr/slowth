// WebGL host for the 3D sloth. World units == CSS px at z=0 (camera is calibrated for that).
import * as THREE from 'three';
import { createRig } from './rig.js';

export const LIFT = 24;   // body centre sits this many px above the surface it lies on

export function createSloth(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(20, 1, 50, 6000);

  scene.add(new THREE.HemisphereLight(0xe4ecff, 0x6a5240, 1.5));
  const key = new THREE.DirectionalLight(0xfff0d6, 2.6); key.position.set(-350, 750, 600); scene.add(key);
  const rim = new THREE.DirectionalLight(0xbcd2ff, 1.0); rim.position.set(500, 200, -300); scene.add(rim);

  const rig = createRig(scene);

  function resize() {
    const W = innerWidth, H = innerHeight;
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    renderer.setSize(W, H, false);
    camera.aspect = W / H;
    const dist = (H / 2) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    camera.far = dist + 1500;
    camera.position.set(W / 2, -H / 2, dist);
    camera.lookAt(W / 2, -H / 2, 0);
    camera.updateProjectionMatrix();
  }
  resize();
  addEventListener('resize', resize);

  return {
    update(dt, inp) {
      const out = rig.update(dt, inp);
      if (!document.hidden) renderer.render(scene, camera);
      return out;
    },
    reset: rig.reset,
    resize,
  };
}
