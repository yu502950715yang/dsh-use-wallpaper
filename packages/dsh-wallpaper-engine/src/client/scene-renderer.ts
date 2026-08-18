import * as THREE from 'three';
import type { SceneDescription, SceneImageObject } from '../shared/types.js';
import { createParticleSystem } from './particles.js';
import type { ParticleEmitterSpec, ParticleInitializerSpec } from './particles.js';
import { fetchSceneDescription, fetchParticleSpec } from './scene-assets.js';
import { loadTexTexture } from './tex-loader.js';

export interface SceneRenderer {
  setScene(desc: SceneDescription): void;
  setImageObject(tex: THREE.Texture | null, obj: SceneImageObject): void;
  addParticleSystem(
    spec: { emitter: ParticleEmitterSpec; init: ParticleInitializerSpec },
    opts?: { sizeAttenuation?: boolean; origin?: [number, number, number]; scale?: [number, number, number] },
  ): void;
  start(): void;
  stop(): void;
}

// 坐标映射（Task 8 审查 Minor 1 修正）：
// Wallpaper Engine 场景系 = 左上原点、y 向下；three 正交相机 = 中心原点、y 向上。
// 映射：three.x = we.x - vw/2；three.y = vh/2 - we.y（即 y 翻转）。
// 对象锚点（origin）是 WE 中的中心点：中心映射为 (ox - vw/2, vh/2 - oy)。
// EVA 实测：image origin=(1200,777.5) = size/2，几何 2400×1555 → 中心 (0,0) 正好铺满正交视口。
const CAMERA_DISTANCE = 300; // 相机沿 +z 放置，使 shader 中 300/-mv.z = 1（点尺寸=像素尺寸）

// 按「contain」语义计算正交相机范围：场景完整可见、不变形，多出的方向留白（透明）。
function containRange(width: number, height: number, viewAspect: number) {
  const sceneAspect = width / height;
  if (sceneAspect > viewAspect) {
    // 场景更宽 → 宽度铺满相机，垂直留白
    return { w: width, h: width / viewAspect };
  }
  // 场景更窄 → 高度铺满相机，水平留白
  return { w: height * viewAspect, h: height };
}

// 按「cover」语义计算正交相机范围：场景铺满视口、不变形，超出方向被裁剪。
function coverRange(width: number, height: number, viewAspect: number) {
  const sceneAspect = width / height;
  if (viewAspect > sceneAspect) {
    // 视口更宽 → 场景宽度铺满，垂直裁剪
    return { w: width, h: width / viewAspect };
  }
  // 视口更窄 → 场景高度铺满，水平裁剪
  return { w: height * viewAspect, h: height };
}

export function createSceneRenderer(fgCanvas: HTMLCanvasElement, bgCanvas?: HTMLCanvasElement): SceneRenderer {
  // 前景：contain 完整显示，透明清屏（透明边缘露出模糊背景）
  const renderer = new THREE.WebGLRenderer({ canvas: fgCanvas, antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
  camera.position.z = CAMERA_DISTANCE;

  // 背景（可选）：cover 铺满，作为模糊填充层（clearColor 由 setScene 设置）
  let bgRenderer: THREE.WebGLRenderer | null = null;
  let bgCamera: THREE.OrthographicCamera | null = null;
  if (bgCanvas) {
    bgRenderer = new THREE.WebGLRenderer({ canvas: bgCanvas, antialias: true, alpha: false });
    bgCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
    bgCamera.position.z = CAMERA_DISTANCE;
  }

  let raf = 0;
  let running = false;
  let ortho: { width: number; height: number } = { width: 1920, height: 1080 };

  const clock = new THREE.Clock();
  const particleSystems: Array<{ system: ReturnType<typeof createParticleSystem>; points: THREE.Points }> = [];

  function frame() {
    const dt = Math.min(clock.getDelta(), 0.05);
    for (const ps of particleSystems) {
      ps.system.update(dt);
      ps.system.positions(); // 关键：update 只改内部粒子数组，必须再次同步到 positions 缓冲（否则每帧重传同一份全零数据）
      ps.points.geometry.attributes.position.needsUpdate = true;
      ps.points.geometry.attributes.aColor.needsUpdate = true;
      ps.points.geometry.attributes.aSize.needsUpdate = true;
      ps.points.geometry.setDrawRange(0, ps.system.count());
    }
    if (bgRenderer && bgCamera) bgRenderer.render(scene, bgCamera);
    renderer.render(scene, camera);
    if (running && fgCanvas.isConnected) raf = requestAnimationFrame(frame);
    else stop(); // canvas 被 controller 移除（切换壁纸）时自动终止 raf，防止泄漏
  }

  return {
    setScene(desc: SceneDescription) {
      scene.clear();
      scene.background = null; // 清掉上一场景残留背景（Task 8 minor）
      ortho = desc.orthogonal;
      const { width, height } = desc.orthogonal;
      const vw = Math.max(1, Math.round(window.innerWidth || width));
      const vh = Math.max(1, Math.round(window.innerHeight || height));
      const viewAspect = vw / vh;

      // 前景相机：contain（完整显示，边缘透明）
      const fg = containRange(width, height, viewAspect);
      camera.left = -fg.w / 2; camera.right = fg.w / 2;
      camera.top = fg.h / 2; camera.bottom = -fg.h / 2;
      camera.updateProjectionMatrix();
      renderer.setSize(vw, vh, false);

      // 背景相机：cover（铺满，作为模糊层）
      if (bgRenderer && bgCamera) {
        const bg = coverRange(width, height, viewAspect);
        bgCamera.left = -bg.w / 2; bgCamera.right = bg.w / 2;
        bgCamera.top = bg.h / 2; bgCamera.bottom = -bg.h / 2;
        bgCamera.updateProjectionMatrix();
        const cc = desc.clearColor;
        bgRenderer.setClearColor(cc ? new THREE.Color(cc[0], cc[1], cc[2]) : 0x111114, 1);
        bgRenderer.setSize(vw, vh, false);
      }
    },
    setImageObject(tex, obj) {
      // 平面几何尺寸：scene.json 对象 size（WE 像素）优先，缺省回退纹理宽高
      const tw = tex?.image?.width ?? 1;
      const th = tex?.image?.height ?? 1;
      const w = obj.size?.[0] ?? tw;
      const h = obj.size?.[1] ?? th;
      const geometry = new THREE.PlaneGeometry(w, h);
      const material = new THREE.MeshBasicMaterial({ map: tex ?? undefined, transparent: true });
      const mesh = new THREE.Mesh(geometry, material);
      const s = obj.scale;
      mesh.scale.set(s[0], s[1], s[2] ?? 1);
      // 对象 origin 是 WE 场景中的中心点：中心映射 = (ox - vw/2, vh/2 - oy)（vw/vh = 正交视口尺寸，见文件头注释）。
      // 用对象尺寸做偏移只在 size==视口时偶然正确（EVA 全屏图），非全屏对象会错位——必须用视口尺寸。
      mesh.position.set(obj.origin[0] - ortho.width / 2, ortho.height / 2 - obj.origin[1], obj.origin[2]);
      scene.add(mesh);
    },
    addParticleSystem(spec, opts = {}) {
      const system = createParticleSystem(spec.emitter, spec.init, { maxParticles: 2048 });
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(system.positions(), 3));
      geometry.setAttribute('aColor', new THREE.BufferAttribute(system.colors(), 3));
      geometry.setAttribute('aSize', new THREE.BufferAttribute(system.sizes(), 1));
      geometry.setDrawRange(0, 0);
      // 每粒子颜色（WE colorrandom，0-255 → 0-1）与尺寸（WE 场景像素）
      const material = new THREE.ShaderMaterial({
        vertexShader: `attribute vec3 aColor; attribute float aSize; varying vec3 vColor; varying float vLife;
          void main(){ vLife = 1.0; vColor = aColor; vec4 mv = modelViewMatrix * vec4(position,1.0);
          gl_PointSize = aSize * (300.0 / -mv.z); gl_Position = projectionMatrix * mv; }`,
        fragmentShader: `varying vec3 vColor; varying float vLife; void main(){
          vec2 c = gl_PointCoord - 0.5; float d = length(c);
          if (d > 0.5) discard;
          float a = smoothstep(0.5, 0.0, d) * vLife;
          gl_FragColor = vec4(vColor, a); }`,
        transparent: true, depthWrite: false, depthTest: false,
        blending: THREE.AdditiveBlending,
      });
      const points = new THREE.Points(geometry, material);
      // 粒子模拟在 WE 系（y 向下）生成局部坐标：发射原点按中心映射平移，
      // scale.y 取负完成 y 翻转（方向/速度与 WE 屏幕表现一致）
      if (opts.origin) {
        points.position.set(
          opts.origin[0] - ortho.width / 2,
          ortho.height / 2 - opts.origin[1],
          opts.origin[2] ?? 0,
        );
      }
      const s = opts.scale ?? [1, 1, 1];
      points.scale.set(s[0], -(s[1] ?? s[0]), s[2] ?? 1);
      scene.add(points);
      particleSystems.push({ system, points });
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
      bgRenderer?.dispose();
    },
  };
}

// 材质引用 → tex 资源路径推导。
// WE 语义（全库实测验证）：material json 的 passes[0].textures[0] 是纹理槽位名，
//   不含 '/' → 材质同目录下同名 .tex（EVA 等常规布局）；
//   含 '/'   → 相对 materials/ 的路径（workshop 子目录纹理），拼 "materials/" + texName + ".tex"。
// 修复：旧实现直接 texName + ".tex"，丢失 materials/ 前缀，导致子目录纹理加载失败。
export function resolveTexPath(matRef: string, texName: string): string {
  return texName.includes('/')
    ? 'materials/' + texName + '.tex'
    : matRef.slice(0, matRef.lastIndexOf('/') + 1) + texName + '.tex';
}

// 图片对象纹理：obj.image 指向 models/xxx.json（材料引用），实际 .tex 需经
// 模型 json → material 字段 → materials/xxx.json → passes[0].textures[0] 推导。
async function resolveImageTexture(id: string, obj: SceneImageObject): Promise<THREE.Texture | null> {
  try {
    const modelResp = await fetch(`/wallpapers/scene/${id}/asset?name=${encodeURIComponent(obj.image)}`);
    if (!modelResp.ok) return null;
    const model = await modelResp.json();
    const matRef: unknown = model?.material;
    if (typeof matRef !== 'string' || !matRef) return null;
    const matResp = await fetch(`/wallpapers/scene/${id}/asset?name=${encodeURIComponent(matRef)}`);
    if (!matResp.ok) return null;
    const mat = await matResp.json();
    const texName: unknown = mat?.passes?.[0]?.textures?.[0];
    if (typeof texName !== 'string' || !texName) return null;
    return loadTexTexture(`/wallpapers/scene/${id}/asset?name=${encodeURIComponent(resolveTexPath(matRef, texName))}`);
  } catch {
    return null;
  }
}

export async function renderScene(id: string, fgCanvas: HTMLCanvasElement, bgCanvas?: HTMLCanvasElement): Promise<boolean> {
  let renderer: SceneRenderer | null = null;
  try {
    const desc = await fetchSceneDescription(id);
    renderer = createSceneRenderer(fgCanvas, bgCanvas);
    renderer.setScene(desc);
    let rendered = 0;
    for (const obj of desc.objects) {
      if (obj.kind === 'image') {
        const tex = await resolveImageTexture(id, obj);
        if (!tex) continue; // 纹理缺失 → 跳过该对象（骨架注记：失败即跳过）
        renderer.setImageObject(tex, obj);
        rendered++;
      } else if (obj.kind === 'particle' && obj.particle) {
        const spec = await fetchParticleSpec(id, obj.particle);
        if (spec) {
          renderer.addParticleSystem(spec, { origin: obj.origin, scale: obj.scale });
          rendered++;
        }
      }
      // kind === 'util'：WE 内置合成层/效果对象（models/util/*），一期跳过
      // （不 fetch、不计数；effects 效果链渲染属二期，见 shared/types.ts SceneUtilObject）
    }
    // 全部对象渲染失败 → 返回 false，让 controller 走 preview 回退（回退链接线）
    if (rendered === 0) {
      renderer.stop();
      return false;
    }
    renderer.start();
    return true;
  } catch {
    renderer?.stop();
    return false;
  }
}
