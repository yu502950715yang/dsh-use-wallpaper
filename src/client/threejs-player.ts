// Task 1：three.js 场景骨架（renderer + 正交相机 cover + RAF 循环）。
// 这是「WE 场景 → three.js 播放器」思路的第一步：先把播放器骨架搭好，后续 Task 2/3/4
// 往里加背景 Sprite 与粒子。
//
// 坐标 / cover 语义复用 scene-renderer.ts（不重写，避免双份语义漂移）：
//   - coverRange(sceneW, sceneH, viewAspect)：把场景固有尺寸（WE 正交视口 view_w×view_h）
//     按视口宽高比做 cover 裁剪（铺满、不变形、超出方向裁掉），得到正交相机视锥尺寸
//     view_w/view_h。构造传入的 width/height 是场景固有尺寸（scene.json 未就绪前的冗余值）；
//     视口缺省与场景同尺寸，此时 cover == contain == 场景尺寸（无裁剪）。
//   - CAMERA_DISTANCE：相机沿 +z 放置，使 shader 里 300/-mv.z = 1（点尺寸=像素尺寸）。
//   - 正交相机 y 轴不做翻转（WE 系左下原点 y 向上与 three 正交相机一致，见 scene-renderer
//     文件头坐标注释；背景/粒子用同一相机，保持 cover 与 we_to_three 语义）。
import * as THREE from 'three';
import { coverRange, CAMERA_DISTANCE, materialModulation } from './scene-renderer.js';

// 背景图层条目：记录 WE 场景坐标与当前已应用状态，供 update_background 对齐既有
// update_image 语义（undefined = 保持现状；无变化则跳过）。
type BackgroundEntry = {
  mesh: THREE.Mesh;
  // WE 场景坐标（创建时的 origin，未中心化）——update_background 用它重算 we_to_three 位置。
  origin: [number, number, number];
  scale: [number, number, number];
  alpha: number;         // 已应用 material.opacity（0-1）
  brightness: number;    // 亮度乘法系数（原始值，materialModulation 内部 clamp）
  // 该背景创建时用的场景固有尺寸（we_to_three 中心化基准 = origin - scene/2）。
  sceneW: number;
  sceneH: number;
};

export class ThreeScenePlayer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.OrthographicCamera;

  // 场景固有尺寸（WE 正交视口 view_w×view_h；scene.json 未就绪前用构造传入值，越过后
  // 用 setSceneSize 更新）与当前视口尺寸（canvas 逻辑像素）。
  private sceneWidth: number;
  private sceneHeight: number;
  private viewWidth: number;
  private viewHeight: number;

  private lastTime = 0;

  // 背景图层条目（按 addBackground 返回的 id 索引，供 update_background 引用）。
  private backgroundEntries = new Map<number, BackgroundEntry>();
  private nextBackgroundId = 0;

  constructor(
    canvas: HTMLCanvasElement,
    width: number,
    height: number,
    // 可选注入 renderer：node/jsdom 无 WebGL 无法构造真 WebGLRenderer，测试用 mock 注入
    // （契约「可 mock renderer」）。缺省创建标准 antialias WebGLRenderer。
    renderer?: THREE.WebGLRenderer,
  ) {
    this.sceneWidth = width;
    this.sceneHeight = height;
    // 视口缺省与场景同尺寸 → cover == 场景尺寸（无裁剪）。resize(w,h) 后按视口裁剪。
    this.viewWidth = width;
    this.viewHeight = height;

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
    this.camera.position.z = CAMERA_DISTANCE;

    this.renderer = renderer ?? new THREE.WebGLRenderer({ canvas, antialias: true });
    this.applyCover();
    this.renderer.setSize(width, height, false);
  }

  // 视口尺寸变更（浏览器 resize / controller 设置 canvas 逻辑尺寸）：只改视口，重新按
  // cover 推导相机范围（cover 语义保持，裁剪方向随视口宽高比变化，不固定传 w/h）。
  resize(width: number, height: number): void {
    this.viewWidth = width;
    this.viewHeight = height;
    this.applyCover();
    this.renderer.setSize(width, height, false);
  }

  // 场景固有尺寸（scene.json 的 general.orthogonalprojection）就绪后设置，同时重推 cover。
  // 构造传入的 width/height 只是缺省冗余值（「缺省用传入 width/height」）。
  setSceneSize(width: number, height: number): void {
    this.sceneWidth = width;
    this.sceneHeight = height;
    this.applyCover();
  }

  // 按 cover 语义把相机视锥设为场景尺寸的 cover 视图（中心原点，z 范围 -1000..1000 不变）。
  private applyCover(): void {
    const viewAspect = this.viewWidth / this.viewHeight;
    const fg = coverRange(this.sceneWidth, this.sceneHeight, viewAspect);
    this.camera.left = -fg.w / 2;
    this.camera.right = fg.w / 2;
    this.camera.top = fg.h / 2;
    this.camera.bottom = -fg.h / 2;
    this.camera.updateProjectionMatrix();
  }

  // 每帧扩展钩子：Task 1 空实现，后续 Task 2/3/4 在这里挂背景 Sprite 更新 / 粒子模拟。
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  update(_dt: number): void {}

  // 启动帧循环（renderer.setAnimationLoop 内部 RAF）。每帧：update(dt)（内部钩子）→
  // 可选外部回调 fn(dt) → render(scene, camera)。dt 用 performance.now 差分，clamp 0.1s
  // 防 tab 切后台 / RAF 停顿后 dt 过大把粒子瞬移出视口（同 wasm-renderer 语义）。
  setAnimationLoop(fn?: (dt: number) => void): void {
    this.lastTime = performance.now();
    this.renderer.setAnimationLoop(() => {
      const now = performance.now();
      const dt = Math.min((now - this.lastTime) / 1000, 0.1);
      this.lastTime = now;
      this.update(dt);
      fn?.(dt);
      this.renderer.render(this.scene, this.camera);
    });
  }

  // 手动渲染一帧（不依赖 RAF，供测试/调用方直接触发）。
  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  // Task 2：背景图层（Sprite/Mesh）。用 we_to_three 中心化定位（three = we - scene/2，
  // 左下原点 y 向上 → 中心原点 y 向上，y 不翻，与背景一致）；size×scale 定尺寸；
  // alpha → material.opacity、brightness 调色（复用 scene-renderer.materialModulation：
  // color 缺省全白 → rgb = clamp01(brightness)，a = clamp01(alpha)）。
  // sceneW/sceneH 为场景固有尺寸（we_to_three 基准，通常 == setSceneSize 注入值）。
  // 返回分配的背景 id，供 update_background 引用；与后续粒子共用同一相机（Task 1 cover）。
  addBackground(opts: {
    origin: [number, number, number];
    size?: [number, number];
    scale: [number, number, number];
    texture?: THREE.Texture;
    alpha?: number;
    brightness?: number;
    sceneW: number;
    sceneH: number;
  }): number {
    const sceneW = opts.sceneW;
    const sceneH = opts.sceneH;
    // 背景尺寸 = size × scale。geometry 用未缩放 size、mesh.scale 承载 scale（同
    // scene-renderer.setImageObject 语义），世界尺寸 = size*scale；size 缺省回退纹理宽高。
    const w = opts.size?.[0] ?? (opts.texture?.image?.width as number | undefined) ?? 1;
    const h = opts.size?.[1] ?? (opts.texture?.image?.height as number | undefined) ?? 1;
    const geometry = new THREE.PlaneGeometry(w, h);
    const material = new THREE.MeshBasicMaterial({
      map: opts.texture ?? null,
      transparent: true,
    });
    const mod = materialModulation(undefined, opts.alpha, opts.brightness);
    material.color.setRGB(mod.r, mod.g, mod.b);
    material.opacity = mod.a;
    const mesh = new THREE.Mesh(geometry, material);
    const s = opts.scale;
    mesh.scale.set(s[0], s[1], s[2] ?? 1);
    // we_to_three：origin - scene/2（y 不翻）。
    mesh.position.set(opts.origin[0] - sceneW / 2, opts.origin[1] - sceneH / 2, opts.origin[2]);
    this.scene.add(mesh);

    const id = this.nextBackgroundId++;
    this.backgroundEntries.set(id, {
      mesh,
      origin: [opts.origin[0], opts.origin[1], opts.origin[2]],
      scale: [s[0], s[1], s[2] ?? 1],
      alpha: mod.a,
      brightness: opts.brightness ?? 1,
      sceneW,
      sceneH,
    });
    return id;
  }

  // Task 2：更新背景图层状态，对齐既有 update_image 语义——undefined = 保持现状；
  // 传入值若无变化（与当前已应用状态相等）则跳过该字段；未知 id → no-op。
  // origin 为 WE 场景坐标，先按 we_to_three 中心化（origin - scene/2）再写 mesh.position。
  update_background(
    id: number,
    origin?: [number, number, number],
    scale?: [number, number, number],
    alpha?: number,
    brightness?: number,
  ): void {
    const entry = this.backgroundEntries.get(id);
    if (!entry) return;
    if (origin) {
      const [ox, oy, oz] = origin;
      if (ox !== entry.origin[0] || oy !== entry.origin[1] || oz !== entry.origin[2]) {
        entry.origin = [ox, oy, oz];
        entry.mesh.position.set(ox - entry.sceneW / 2, oy - entry.sceneH / 2, oz);
      }
    }
    if (scale) {
      const [sx, sy, sz] = scale;
      if (sx !== entry.scale[0] || sy !== entry.scale[1] || sz !== entry.scale[2]) {
        entry.scale = [sx, sy, sz];
        entry.mesh.scale.set(sx, sy, sz);
      }
    }
    if (alpha !== undefined) {
      const a = Math.max(0, Math.min(1, alpha));
      if (a !== entry.alpha) {
        entry.alpha = a;
        (entry.mesh.material as THREE.MeshBasicMaterial).opacity = a;
      }
    }
    if (brightness !== undefined) {
      if (brightness !== entry.brightness) {
        entry.brightness = brightness;
        // brightness 调色：rgb = clamp01(brightness)，a 用当前 opacity（复用调制函数）。
        const mod = materialModulation(undefined, entry.alpha, brightness);
        (entry.mesh.material as THREE.MeshBasicMaterial).color.setRGB(mod.r, mod.g, mod.b);
      }
    }
  }

  // 停止循环并释放 renderer 资源。
  dispose(): void {
    this.renderer.setAnimationLoop(null);
    // 释放背景图层几何/材质（texture 所有权通常在外，随 scene 清理，不在此 dispose）。
    for (const entry of this.backgroundEntries.values()) {
      entry.mesh.geometry.dispose();
      (entry.mesh.material as THREE.Material).dispose();
    }
    this.backgroundEntries.clear();
    this.renderer.dispose();
  }
}
