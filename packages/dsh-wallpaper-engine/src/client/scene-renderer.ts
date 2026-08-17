import * as THREE from 'three';
import type { SceneDescription, SceneImageObject } from '../shared/types.js';

export interface SceneRenderer {
  setScene(desc: SceneDescription): void;
  setImageObject(tex: THREE.Texture | null, obj: SceneImageObject): void;
  start(): void;
  stop(): void;
}

export function createSceneRenderer(canvas: HTMLCanvasElement): SceneRenderer {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
  let raf = 0;
  let running = false;

  const clock = new THREE.Clock();

  function frame() {
    const dt = Math.min(clock.getDelta(), 0.05);
    scene.traverse((obj) => {
      const upd = (obj as any).userData?.update;
      if (typeof upd === 'function') upd(dt);
    });
    renderer.render(scene, camera);
    if (running) raf = requestAnimationFrame(frame);
  }

  return {
    setScene(desc: SceneDescription) {
      scene.clear();
      const { width, height } = desc.orthogonal;
      camera.left = -width / 2; camera.right = width / 2;
      camera.top = height / 2; camera.bottom = -height / 2;
      camera.updateProjectionMatrix();
      if (desc.clearColor) {
        scene.background = new THREE.Color(desc.clearColor[0], desc.clearColor[1], desc.clearColor[2]);
      }
      renderer.setSize(width, height, false);
    },
    setImageObject(tex, obj) {
      const geometry = new THREE.PlaneGeometry(1, 1);
      const material = new THREE.MeshBasicMaterial({ map: tex ?? undefined, transparent: true });
      const mesh = new THREE.Mesh(geometry, material);
      const s = obj.scale;
      mesh.scale.set(s[0], s[1], s[2]);
      mesh.position.set(obj.origin[0], obj.origin[1], obj.origin[2]);
      scene.add(mesh);
    },
    start() {
      if (running) return;
      running = true;
      clock.start();
      raf = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      cancelAnimationFrame(raf);
      renderer.dispose();
    },
  };
}
