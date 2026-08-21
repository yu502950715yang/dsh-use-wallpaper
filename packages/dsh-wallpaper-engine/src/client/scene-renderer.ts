import * as THREE from 'three';
import type { SceneDescription, SceneImageObject } from '../shared/types.js';
import { createParticleSystem } from './particles.js';
import type { ParticleEmitterSpec, ParticleInitializerSpec } from './particles.js';
import { fetchSceneDescription, fetchParticleSpec } from './scene-assets.js';
import { loadTexTexture } from './tex-loader.js';
import { EffectRunner } from './effect-runner.js';
import { resolveEffectChain } from './shader/effect-chain.js';
import { fetchWithRetry } from './fetch-util.js';

export interface SceneRenderer {
  setScene(desc: SceneDescription): void;
  setImageObject(tex: THREE.Texture | null, obj: SceneImageObject): void;
  addParticleSystem(
    spec: { emitter: ParticleEmitterSpec; init: ParticleInitializerSpec },
    opts?: { sizeAttenuation?: boolean; origin?: [number, number, number]; scale?: [number, number, number] },
  ): void;
  setEffectChains(chains: import('./shader/effect-chain.js').CompiledEffectPass[][] | null, id: string): void;
  start(): void;
  stop(): void;
}

// 坐标映射（2026-08-20 方向修正，全库目检证实）：
// Wallpaper Engine 场景系 = 左下原点、y 向上（origin.y 是距底部的距离，非距顶部）；
// three 正交相机 = 中心原点、y 向上。
// 映射：three.x = we.x - vw/2；three.y = we.y - vh/2（y 不做翻转，两系 y 同向）。
// 对象锚点（origin）是 WE 中的中心点：中心映射为 (ox - vw/2, oy - vh/2)。
// 实测证据：NERV logo origin.y=150（2832263418）官方渲染在右下角（距底 150）；
//   Orange 部件 Тело origin.y=384 官方叠在少女身上（距底 384 = 距顶 1056）；
//   旧实现 `vh/2 - we.y`（y 翻转）把两者镜像到顶部 → 部件漂浮在少女头顶（1429403119 问题图）。
// EVA 主图 origin=(1200,777.5)=size/2 恰居中（oy=sh/2）故新旧公式结果相同，早期验收漏过。
const CAMERA_DISTANCE = 300; // 相机沿 +z 放置，使 shader 中 300/-mv.z = 1（点尺寸=像素尺寸）

// 对象级渲染目标尺寸上限：防止超大对象（如 6144px 贴图）的对象 RT 撑爆 VRAM
// （逐轴钳制，见 objectCameraRange 注释）。
const OBJECT_RT_MAX = 2048;

// 对象局部正交相机范围 = 对象尺寸 × 缩放（中心原点），逐轴钳制 2048、下限 1。
// 相机范围（场景像素）同时作为对象 RT 的分辨率基准：不钳制时对象 quad 精确填满 RT，
// 效果链 UV 0-1 与 foliagesway_mask 等 mask 纹理对齐对象局部空间。
// 钳制时该轴对象超出相机视锥被裁剪（超大对象保护性降采样，T1.3 合成时按 UV 语义映射）。
export function objectCameraRange(objSize: [number, number], scale: [number, number]): { w: number; h: number } {
  return {
    w: Math.max(1, Math.min(objSize[0] * scale[0], OBJECT_RT_MAX)),
    h: Math.max(1, Math.min(objSize[1] * scale[1], OBJECT_RT_MAX)),
  };
}

// 对象级渲染目标：按分辨率创建（浮点取整为整数像素，0/负数钳制 1 —— 保证
// EffectRunner.ensureTargets 收到的尺寸恒为干净的正整数，不产生退化 RT）。
export function createObjectRenderTarget(width: number, height: number): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));
}

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

  // 场景渲染目标：离屏 RT（效果链输入），最终经全屏 quad 贴到 canvas
  const sceneRT = new THREE.WebGLRenderTarget(1, 1);
  // 贴屏相机：独立 NDC 正交相机（场景相机是 contain 范围，不能复用）
  const screenCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
  screenCamera.position.z = CAMERA_DISTANCE;
  const screenScene = new THREE.Scene();
  // 贴屏 quad 必须 transparent：contain 留白区（场景未覆盖处）alpha 为 0，
  // 否则 OPAQUE 强制 alpha=1 → 黑边并完全遮挡 bg 模糊层（spec §3.1）
  const screenQuad = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.MeshBasicMaterial({ map: sceneRT.texture, transparent: true }),
  );
  screenQuad.frustumCulled = false;
  screenScene.add(screenQuad);
  let effectRunner: import('./effect-runner.js').EffectRunner | null = null;

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
  // 对象级渲染条目：带效果 image 对象渲染进各自独立 RT（局部正交相机，中心原点），
  // 效果链（T1.3）在对象 RT 上执行后合成回场景；无效果对象不走此路径（保持共享场景）。
  const objectEntries: Array<{ scene: THREE.Scene; camera: THREE.OrthographicCamera; rt: THREE.WebGLRenderTarget }> = [];

  function frame() {
    const dt = Math.min(clock.getDelta(), 0.05);
    for (const ps of particleSystems) {
      ps.system.update(dt);
      ps.system.positions(); // 关键：update 只改内部粒子数组，必须再次同步到 positions 缓冲（否则每帧重传同一份全零数据）
      ps.points.geometry.attributes.position.needsUpdate = true;
      ps.points.geometry.attributes.aColor.needsUpdate = true;
      ps.points.geometry.attributes.aSize.needsUpdate = true;
      ps.points.geometry.attributes.aAlpha.needsUpdate = true;
      ps.points.geometry.setDrawRange(0, ps.system.count());
    }
    // 对象级渲染：带效果对象渲染进各自对象 RT（局部相机）。T1.3 在对象 RT 上挂
    // 效果链并把输出合成回场景；本任务只建立对象 RT 渲染路径（对象暂不合成回场景）。
    for (const entry of objectEntries) {
      renderer.setRenderTarget(entry.rt);
      renderer.render(entry.scene, entry.camera);
    }
    // 场景渲染到离屏 RT
    renderer.setRenderTarget(sceneRT);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    // 贴屏源：有效果链时用 runner 最近完成输出（未完成回退场景 RT，避免首帧黑屏），否则 sceneRT
    const displayTex = effectRunner ? (effectRunner.lastOutput() ?? sceneRT.texture) : sceneRT.texture;
    (screenQuad.material as THREE.MeshBasicMaterial).map = displayTex;
    renderer.render(screenScene, screenCamera);
    // 效果链异步更新（纹理槽加载完成前输出=input，不阻塞帧循环）
    if (effectRunner) {
      void effectRunner.update(clock.elapsedTime, sceneRT);
    }
    if (bgRenderer && bgCamera) bgRenderer.render(scene, bgCamera);
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
      sceneRT.setSize(vw, vh);

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
      // 对象级效果链路径：带效果 image 对象渲染进独立对象 RT（局部正交相机，范围 =
      // size×scale、中心原点），效果链 UV 0-1 对齐对象局部空间；不参与共享场景，
      // T1.3 将对象 RT 的效果输出合成回场景（当前中间态：这些对象暂不显示）。
      if (Array.isArray(obj.effects) && obj.effects.length > 0) {
        const range = objectCameraRange([w, h], [s[0], s[1]]);
        const rt = createObjectRenderTarget(range.w, range.h);
        // 局部相机：中心原点、范围 = 对象世界尺寸（钳制后）——不钳制时 quad 精确填满
        // RT（每 RT 像素 = 1 场景像素），钳制时该轴对象被裁剪（保护性降采样）。
        const localCamera = new THREE.OrthographicCamera(
          -range.w / 2, range.w / 2, range.h / 2, -range.h / 2, -1000, 1000,
        );
        localCamera.position.z = CAMERA_DISTANCE;
        const localScene = new THREE.Scene();
        localScene.add(mesh); // mesh 保持 (0,0,0)：对象中心即局部原点
        objectEntries.push({ scene: localScene, camera: localCamera, rt });
        return;
      }
      // 无效果对象：共享场景路径（对象 origin 是 WE 场景中的中心点：中心映射 = (ox - vw/2, oy - vh/2)。
      // 旧实现 `vh/2 - oy` 把非居中对象上下镜像（EVA 主图 oy=sh/2 恰好 0 故漏过），
      // 导致 Orange 少女部件被渲染到头顶（问题图漂浮现象）——2026-08-20 修正为不翻转。）
      mesh.position.set(obj.origin[0] - ortho.width / 2, obj.origin[1] - ortho.height / 2, obj.origin[2]);
      scene.add(mesh);
    },
    addParticleSystem(spec, opts = {}) {
      const system = createParticleSystem(spec.emitter, spec.init, { maxParticles: 2048 });
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(system.positions(), 3));
      geometry.setAttribute('aColor', new THREE.BufferAttribute(system.colors(), 3));
      geometry.setAttribute('aSize', new THREE.BufferAttribute(system.sizes(), 1));
      geometry.setAttribute('aAlpha', new THREE.BufferAttribute(system.alphas(), 1));
      geometry.setDrawRange(0, 0);
      // 每粒子颜色（WE colorrandom，0-255 → 0-1）与尺寸（WE 场景像素）
      const material = new THREE.ShaderMaterial({
        vertexShader: `attribute vec3 aColor; attribute float aSize; attribute float aAlpha; varying vec3 vColor; varying float vLife;
          void main(){ vLife = aAlpha; vColor = aColor; vec4 mv = modelViewMatrix * vec4(position,1.0);
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
      // 粒子模拟在 WE 系（y 向上）生成局部坐标：发射原点按中心映射平移（同图片对象，
      // 左下原点 y 向上 → 中心原点 y 向上，不翻转）；scale.y 不取负（旧实现取负是配合
      // 错误的 y 翻转，2026-08-20 修正——snowflat 速度 vy∈[-90,-50] 为向下运动即证据）。
      if (opts.origin) {
        points.position.set(
          opts.origin[0] - ortho.width / 2,
          opts.origin[1] - ortho.height / 2,
          opts.origin[2] ?? 0,
        );
      }
      const s = opts.scale ?? [1, 1, 1];
      points.scale.set(s[0], s[1] ?? s[0], s[2] ?? 1);
      scene.add(points);
      particleSystems.push({ system, points });
    },
    setEffectChains(chains: import('./shader/effect-chain.js').CompiledEffectPass[][] | null, id: string) {
      // 空效果链（无效果壁纸如 EVA）：不创建 runner，帧循环直接贴 sceneRT
      // （避免空 runner 的 update 空转与潜在状态干扰）
      if (!chains || chains.length === 0) {
        effectRunner?.dispose();
        effectRunner = null;
        return;
      }
      if (!effectRunner) {
        const vw = Math.max(1, Math.round(window.innerWidth || ortho.width));
        const vh = Math.max(1, Math.round(window.innerHeight || ortho.height));
        effectRunner = new EffectRunner(renderer, vw, vh);
      }
      effectRunner.setChains(chains, id);
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
      // 释放对象级 RT（GPU 纹理，换壁纸/停止时必须回收，否则泄漏）
      for (const entry of objectEntries) entry.rt.dispose();
      objectEntries.length = 0;
      renderer.dispose();
      bgRenderer?.dispose();
      effectRunner?.dispose();
      effectRunner = null;
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
    // Ruling 5：所有对象的 effects 按 scene.json objects 顺序展平，
    // 全库实测 122 条效果中 105 条挂在 image 对象上，仅 util 会漏掉主视觉
    const utilEffects = desc.objects
      .flatMap((o) => (Array.isArray(o.effects) ? o.effects : []))
      .filter((fx: unknown): fx is { file: string; passes?: unknown[] } => typeof (fx as any)?.file === 'string');

    // 异步加载效果链（失败链 → null 过滤；加载中画面保持原样）
    void (async () => {
      const chains: import('./shader/effect-chain.js').CompiledEffectPass[][] = [];
      for (const fx of utilEffects) {
        const chain = await resolveEffectChain(fx, async (name) => {
          return fetchWithRetry(`/wallpapers/scene/${id}/asset?name=${encodeURIComponent(name)}`);
        });
        if (chain) chains.push(chain);
        // spec §4.4：效果链解析失败 → console.warn（解析器静默返回 null，warn 职责在本层）
        else console.warn('[wallpaper-engine] 效果链解析失败，跳过:', fx.file);
      }
      renderer.setEffectChains(chains, id);
    })();
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
