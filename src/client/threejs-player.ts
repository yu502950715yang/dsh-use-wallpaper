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
import { parseSceneJson } from './scene-json.js';

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

// 粒子图层条目（Task 3）：记录 three.js billboard quad 的 GPU 资源与配套模拟取顶点 getter。
// 每粒子一个**实例**（InstancedBufferGeometry 的 instanced attribute），顶点 shader 由
// 基础四边形角点（position=[-1,1]²）+ 每粒子位置/尺寸展开成屏幕对齐的 billboard。
type ParticleLayer = {
  id: number;
  // 每粒子数据来自 wasm `SceneParticleSim::build_instance_vertices`（摊平 Float32Array，
  // 每粒子 `[pos3,size,uv2,color3,alpha]` 10 浮点）。getter 每帧刷新时返回当前顶点。
  getter: () => Float32Array;
  frameCount: number;
  geometry: THREE.InstancedBufferGeometry;
  material: THREE.ShaderMaterial;
  // 承载 billboard quad 的 mesh（每粒子一个实例）。frustumCulled=false（粒子散布在场景，
  // 不用基础四边形包围球做视锥剔除，防对象中心离屏时整层被裁掉）。
  mesh: THREE.Mesh;
  // 各 instanced attribute（per-particle），updateParticles 直接写其 Float32Array + needsUpdate。
  positions: THREE.InstancedBufferAttribute;
  sizes: THREE.InstancedBufferAttribute;
  uvs: THREE.InstancedBufferAttribute;
  colors: THREE.InstancedBufferAttribute;
  alphas: THREE.InstancedBufferAttribute;
};

// 4 角点单位四边形（[-1,1]²，z=0）：作为 InstancedBufferGeometry 的基础顶点 position（角点），
// 顶点 shader 用它展开 billboard（pos + corner*half_size）。索引 [0,1,2, 0,2,3] 组成 2 个三角形
// （从 +z 相机方向看为逆时针 → FrontSide 可见）。
const PARTICLE_QUAD_CORNERS = new Float32Array([
  -1, -1, 0,
   1, -1, 0,
   1,  1, 0,
  -1,  1, 0,
]);
const PARTICLE_QUAD_INDEX: [number, number, number, number, number, number] = [0, 1, 2, 0, 2, 3];

// 粒子 billboard 顶点 shader：每粒子一个实例，基础四边形 position=[-1,1]² 作角点，
// worldPos = particlePosition + corner*half_size（half_size = particleSize/2），再用
// modelViewMatrix×projectionMatrix（mvp）投影。position/normal/uv/矩阵由 three.js 自动注入；
// 这里只补每粒子 instanced 属性（particlePosition/Size/Uv/Color/Alpha）与传递 varyings。
const PARTICLE_VERTEX_SHADER = `
attribute vec3 particlePosition;
attribute float particleSize;
attribute vec2 particleUv;
attribute vec3 particleColor;
attribute float particleAlpha;
varying vec2 vCornerUv;
varying vec2 vParticleUv;
varying vec3 vParticleColor;
varying float vParticleAlpha;
void main() {
  vCornerUv = position.xy * 0.5 + 0.5;
  vParticleUv = particleUv;
  vParticleColor = particleColor;
  vParticleAlpha = particleAlpha;
  vec3 worldPos = particlePosition + vec3(position.xy * particleSize * 0.5, 0.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);
  // ⚠️ 修正：粒子是 2D billboard（无深度排序，z 不参与可见性）。three 正交相机 far/near 会把
  // 视锥外的 z 裁剪掉，而 wasm billboard 早已把投影矩阵 z 行全 0（clip.z=0，见 particle_billboard.wgsl）
  // 防「emitter 球壳散射可到 ±750 的粒子被 z 裁剪 → 粒子不可见」。这里把 NDC z 强制归中（0），
  // 配合 material.depthTest=false（忽略深度），保证粒子不被相机深度范围裁剪（对齐 wasm 语义）。
  gl_Position.z = 0.0;
}
`;

// 粒子 billboard fragment shader：多帧 uv 切片（frameCount，uv.x 帧子区，y 占满整高）→
// 采样纹理 → color*texel.rgb、alpha=texel.a*particle.alpha；softness 做中心→边缘软衰减。
// 混色（additive/alpha）由 three.js material.blending 承担（openGL blending），这里只输出 RGBA。
// 形状对齐 wasm `particle_billboard.wgsl` 的 mask_mode（2026-09-09）：
//   - mask_mode=1（真实纹理）：shape = texel.a（alpha 遮罩提供形状，**不再额外乘圆盘**）→
//     光线/花瓣/雪片保持纹理本身的形状，不被软圆盘裁成圆形；
//   - mask_mode=0（无纹理 1×1 白图兜底）：shape = 软圆盘（disk，softness 控制边缘）→ 纯色软圆点。
// 此前恒 `texel.a*falloff`（=mask_mode=1 还叠加圆盘）→ 有纹理粒子也被裁成软圆盘（丢形状），
// 且无纹理粒子呈硬边白块（softness=0 旧病，已由缺省 softness 修正）。
const PARTICLE_FRAGMENT_SHADER = `
uniform sampler2D map;
uniform float frameCount;
uniform float softness;
uniform float maskMode;
varying vec2 vCornerUv;
varying vec2 vParticleUv;
varying vec3 vParticleColor;
varying float vParticleAlpha;
void main() {
  float n = max(frameCount, 1.0);
  float frameIndex = floor(clamp(vParticleUv.x, 0.0, 0.999999) * n);
  frameIndex = min(frameIndex, n - 1.0);
  vec2 texUv = vec2((frameIndex + vCornerUv.x) / n, vCornerUv.y);
  vec4 texel = texture2D(map, texUv);
  // 圆盘软衰减（center→edge）。softness ∈ [0,1]：0=硬边（仅在 quad 边缘收尾），1=全柔（中心→边缘平滑衰减）。
  float dist = length(vCornerUv - 0.5) * 2.0;
  float edgeStart = clamp(1.0 - softness, 0.0001, 0.9999);
  float disk = 1.0 - smoothstep(edgeStart, 1.0, dist);
  // mask_mode：1（真实纹理遮罩，形状=texel.a）↔ 0（无纹理软圆点，形状=disk）。
  float shape = mix(disk, texel.a, maskMode);
  float a = vParticleAlpha * shape;
  gl_FragColor = vec4(vParticleColor * texel.rgb, a);
}
`;

// 无纹理（opts.tex 缺省）时的 1×1 白色兜底（同 scene-renderer.createWhiteDataTexture 语义）：
// 纯色粒子不依赖纹理内容，白图 → texel=白、alpha=1，颜色/透明度由 vParticleColor/vParticleAlpha 给定。
function createWhiteTexture(): THREE.DataTexture {
  const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  tex.needsUpdate = true;
  return tex;
}

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

  // 粒子图层条目（Task 3）：按 addParticle 返回的 id 索引，更新粒子时用其 getter 刷新缓冲区。
  private particleLayers = new Map<number, ParticleLayer>();
  private nextParticleLayerId = 0;

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

    // 注意：构造器**不调用 renderer.setSize(width,height,false)**——否则会把 canvas 尺寸重置回场景
    // 尺寸，覆盖调用方预设的窗口/视口尺寸（Task5 bug 根因：随后的 resize 读到被覆盖的 canvas.width
    // → viewport=场景尺寸 → cover 退化为「全场景无裁剪」+ CSS object-fit:fill 拉伸背景）。真正的
    // canvas 尺寸由调用方在构造后显式 `resize(vw,vh)` 设置（窗口尺寸），见 loadSceneToThree。
    this.renderer = renderer ?? new THREE.WebGLRenderer({ canvas, antialias: true });
    // 色彩管线对齐 wasm 参考（非 sRGB UNorm 管线，见 wasm/src/render/mod.rs / tex.rs 注释）：
    //   wasm 纹理用 UNorm（非 sRGB）、fragment 输出**原始编码值**、surface 直接显示——若 surface 是
    //   sRGB 会把线性值再编码 → 画面偏亮/过曝。three.js 缺省 `outputColorSpace=SRGBColorSpace`
    //   会对所有未标 `colorSpace` 的纹理做 linear→sRGB 再编码（同样偏亮/过曝，根因「整体偏白/过曝」）。
    //   这里强制 LinearSRGBColorSpace → `linearToOutputTexel` 恒等（不转换），纹理原始值直出，
    //   与 wasm 参考的非 sRGB 管线一致（壁纸恢复自然亮度，不再蒙白膜/过曝）。
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    // 画布/渲染分辨率（关键，修复「画面模糊」——HiDPI 屏幕像素比过低导致的整图放大模糊）：
    // three.js WebGLRenderer 缺省 `pixelRatio=1`（渲染缓冲 = 视口 CSS 像素），而 `.wp-scene-canvas`
    // 以 `width:100%`/`height:100%` 铺满窗口。在 HiDPI（devicePixelRatio>1）屏幕上，1× 缓冲被
    // 放大到 devicePixelRatio× 物理像素 → 整幅画面（背景 + 粒子）**模糊**，粒子（花瓣等）也被
    // 模糊成不可辨的小色块——这正是 headless SwiftShader（dpr=1）无法复现、真机可见的原因之一。
    // 按 `window.devicePixelRatio` 设置像素比，使渲染缓冲 = 物理像素（1:1 锐利），与 wasm 参考
    // 的视口语义一致。node/jsdom 测试用 mock renderer 注入（无 setPixelRatio），防御式跳过。
    const dpr = typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;
    const withSetPixelRatio = this.renderer as { setPixelRatio?: (v: number) => void };
    if (typeof withSetPixelRatio.setPixelRatio === 'function') {
      withSetPixelRatio.setPixelRatio(dpr);
    }
    this.applyCover();
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

  // 每帧扩展钩子：驱动粒子图层刷新（Task 3）。Task 1 空实现；背景更新由 update_background
  // 显式调用（对齐 wasm update_image 语义）。后续 Task 4 可在此挂背景/效果链更新。
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  update(_dt: number): void {
    this.updateParticles(_dt);
  }

  // 启动帧循环（renderer.setAnimationLoop 内部 RAF）。每帧：外部回调 fn(dt) → update(dt)
  // （内部钩子）→ render(scene, camera)。dt 用 performance.now 差分，clamp 0.1s 防 tab 切
  // 后台 / RAF 停顿后 dt 过大把粒子瞬移出视口（同 wasm-renderer 语义）。
  // Task 4 关键：fn(dt) 先于内部 update(dt)——fn 承载「模拟推进」（如 CpuParticleSim.update），
  // 使 update（→ updateParticles 读 getter）拿到**本帧已推进**的顶点（sim 已在帧内 advance），
  // 避免「先读旧顶点再推进」的一帧滞后。
  setAnimationLoop(fn?: (dt: number) => void): void {
    this.lastTime = performance.now();
    this.renderer.setAnimationLoop(() => {
      const now = performance.now();
      const dt = Math.min((now - this.lastTime) / 1000, 0.1);
      this.lastTime = now;
      fn?.(dt);
      this.update(dt);
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
      // 背景是透明图层（transparent=true），不写深度——避免其 depthWrite 干扰其他透明对象
      // （粒子 depthTest=false 不受影响，但背景写出深度会占据深度缓冲区，属多余）。
      depthWrite: false,
    });
    const mod = materialModulation(undefined, opts.alpha, opts.brightness);
    material.color.setRGB(mod.r, mod.g, mod.b);
    material.opacity = mod.a;
    const mesh = new THREE.Mesh(geometry, material);
    // renderOrder 0（缺省且显式）：背景在粒子（renderOrder 1）之前绘制（背景在下）。
    mesh.renderOrder = 0;
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

  // Task 3：粒子图层。`simVerticesGetter` 每帧返回模拟器当前顶点（摊平 Float32Array，
  // 每粒子 `[pos3, size, uv2, color3, alpha]` 10 浮点——来自 wasm `SceneParticleSim::build_instance_vertices`）。
  // 渲染用 three.js `ShaderMaterial` billboard quad（每粒子一个实例，shader 由基础角点+位置/尺寸展开），
  // 模拟逻辑仍由 `SceneParticleSim` 承担（思路 1 核心：不重写模拟，只换渲染引擎）。
  // 返回分配的图层 id，供更新/释放引用。
  addParticle(
    simVerticesGetter: () => Float32Array,
    opts: { tex?: THREE.Texture; frameCount: number; blend: 'additive' | 'alpha'; softness?: number },
  ): number {
    const frameCount = Math.max(1, Math.floor(opts.frameCount));
    // softness 默认按有无纹理对齐 wasm `particle_billboard` 的 mask_mode（Task 5 + 2026-09-09 深挖）：
    //   有纹理（真实 alpha 遮罩）→ 0.15（若 mask_mode=0 才用到的圆盘默认值；mask_mode=1 时形状由
    //     texel.a 提供，softness 不参与）——保留该默认值作兜底/精细控制；
    //   无纹理（1×1 白图兜底）→ 1.0（整盘软圆点）。
    // 此前恒 0 → 无纹理粒子是**硬边白方块**（叠在背景上呈白斑/偏白，单个粒子看作方块）。
    // 调用方显式传 softness 时以其为准（测试/精细控制）。
    const hasTex = !!opts.tex;
    const softness = opts.softness ?? (hasTex ? 0.15 : 1.0);

    // InstancedBufferGeometry：基础 4 角点四边形（position）+ 索引；每粒子一个实例（instanced 属性）。
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(PARTICLE_QUAD_CORNERS, 3));
    geometry.setIndex(new THREE.BufferAttribute(new Uint16Array(PARTICLE_QUAD_INDEX), 1));
    geometry.instanceCount = 0;

    // 初始 getter 数据 → 决定首帧每个 instanced 属性的容量（updateParticles 逐帧刷新/扩容）。
    const initial = simVerticesGetter();
    const count = Math.floor(initial.length / 10);

    // per-particle（每个实例）属性：pos(3)/size(1)/uv(2)/color(3)/alpha(1)；itemSize 与字段对应。
    const positions = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    const sizes = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
    const uvs = new THREE.InstancedBufferAttribute(new Float32Array(count * 2), 2);
    const colors = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    const alphas = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
    geometry.setAttribute('particlePosition', positions);
    geometry.setAttribute('particleSize', sizes);
    geometry.setAttribute('particleUv', uvs);
    geometry.setAttribute('particleColor', colors);
    geometry.setAttribute('particleAlpha', alphas);

    // ShaderMaterial：billboard quad（pos + corner*half_size，mvp 用相机投影/视图）、
    // fragment 多帧 uv 切片（frame_count）、additive/alpha blend、softness、color*texel.rgb、alpha=texel.a*particle.alpha。
    // maskMode：有纹理→1（形状由 texel.a 提供）；无纹理白图兜底→0（软圆盘）。对齐 wasm particle_billboard 的 mask_mode。
    const material = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: opts.tex ?? createWhiteTexture() },
        frameCount: { value: frameCount },
        softness: { value: softness },
        maskMode: { value: hasTex ? 1.0 : 0.0 },
      },
      vertexShader: PARTICLE_VERTEX_SHADER,
      fragmentShader: PARTICLE_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      blending: opts.blend === 'additive' ? THREE.AdditiveBlending : THREE.NormalBlending,
    });

    const mesh = new THREE.Mesh(geometry, material);
    // 粒子散布在场景（非基础四边形包围球），禁用视锥剔除防止对象中心离屏时整层消失。
    mesh.frustumCulled = false;
    // renderOrder 固定为 1：保证粒子 billboard 在透明渲染队列中**晚于**背景图层（renderOrder 0）
    // 绘制，使粒子叠在背景之上（背景 transparent 同排透明队列，靠插入顺序易受排序扰动，见
    // ThreeScenePlayer 背景/粒子同 z 的 reversePainterSortStable 稳定序）。这是「粒子不可见 /
    // 与背景竞争」的确定性保险（第 4 条：确认粒子被画出来且不被背景盖住）。
    mesh.renderOrder = 1;
    this.scene.add(mesh);

    const id = this.nextParticleLayerId++;
    const layer: ParticleLayer = {
      id,
      getter: simVerticesGetter,
      frameCount,
      geometry,
      material,
      mesh,
      positions,
      sizes,
      uvs,
      colors,
      alphas,
    };
    this.particleLayers.set(id, layer);
    // 立即写入首帧数据，保持 geometry 与 getter 一致（后续由 updateParticles 逐帧刷新）。
    this.writeParticleData(layer, initial, count);
    return id;
  }

  // 每帧刷新所有粒子图层：调用各自的 `simVerticesGetter()` 取当前顶点并写回 BufferAttribute。
  // `dt` 预留（模拟推进由 getter 持有方按其帧循环驱动，如 wasm `CpuParticleSim.update`）。
  updateParticles(dt: number): void {
    void dt;
    for (const layer of this.particleLayers.values()) {
      const data = layer.getter();
      const count = Math.floor(data.length / 10);
      this.writeParticleData(layer, data, count);
    }
  }

  // 把 per-particle 摊平顶点（每粒子 10 浮点）拆到 5 个 instanced 属性并标记需重传。
  // 属性容量不足时按需扩容（不足×2），收缩不回收（多余槽位不参与渲染，由 instanceCount 控制）。
  private writeParticleData(layer: ParticleLayer, data: Float32Array, count: number): void {
    const ensure = (
      attr: THREE.InstancedBufferAttribute,
      itemSize: number,
      need: number,
      name: string,
    ): THREE.InstancedBufferAttribute => {
      const arr = attr.array as Float32Array;
      if (arr.length >= need) return attr;
      const grown = new Float32Array(Math.max(need, Math.max(arr.length * 2, 1)));
      grown.set(arr);
      const next = new THREE.InstancedBufferAttribute(grown, itemSize);
      layer.geometry.setAttribute(name, next);
      return next;
    };
    layer.positions = ensure(layer.positions, 3, count * 3, 'particlePosition');
    layer.sizes = ensure(layer.sizes, 1, count, 'particleSize');
    layer.uvs = ensure(layer.uvs, 2, count * 2, 'particleUv');
    layer.colors = ensure(layer.colors, 3, count * 3, 'particleColor');
    layer.alphas = ensure(layer.alphas, 1, count, 'particleAlpha');

    const pos = layer.positions.array as Float32Array;
    const size = layer.sizes.array as Float32Array;
    const uv = layer.uvs.array as Float32Array;
    const color = layer.colors.array as Float32Array;
    const alpha = layer.alphas.array as Float32Array;
    for (let i = 0; i < count; i++) {
      const b = i * 10;
      pos[i * 3] = data[b];
      pos[i * 3 + 1] = data[b + 1];
      pos[i * 3 + 2] = data[b + 2];
      size[i] = data[b + 3];
      uv[i * 2] = data[b + 4];
      uv[i * 2 + 1] = data[b + 5];
      color[i * 3] = data[b + 6];
      color[i * 3 + 1] = data[b + 7];
      color[i * 3 + 2] = data[b + 8];
      alpha[i] = data[b + 9];
    }
    layer.positions.needsUpdate = true;
    layer.sizes.needsUpdate = true;
    layer.uvs.needsUpdate = true;
    layer.colors.needsUpdate = true;
    layer.alphas.needsUpdate = true;
    layer.geometry.instanceCount = count;
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
    // 释放粒子图层几何/材质（texture 所有权在外，随 scene 清理，不在此 dispose）。
    for (const layer of this.particleLayers.values()) {
      layer.geometry.dispose();
      layer.material.dispose();
    }
    this.particleLayers.clear();
    this.renderer.dispose();
  }
}

// ===== Task 4：把 WE 场景加载进 three.js 播放器（背景图层 + 粒子系统）=====
//
// `loadSceneToThree(sceneJson, assets, canvas, viewport?)` 复用既有解析（scene-json → SceneDescription）、
// 既有坐标（addBackground 内部 we_to_three，y 不翻）、既有材质调制（materialModulation），
// 把 WE 场景内容转换成 three.js 可渲染对象：
//   ① 背景对象（image）→ player.addBackground({origin,size,scale,texture,alpha,brightness,sceneW,sceneH})
//   ② 粒子对象（particle）→ 每对象 new 一个 CPU 模拟器（SceneParticleSim 的 wasm 导出
//      CpuParticleSim，经 assets.createParticleSim 工厂注入）→ set_frame_count(纹理帧数) →
//      player.addParticle(() => sim.vertices(), {tex, frameCount: sim.frame_count(), blend, softness})。
// 播放循环（Task 4）：player.setAnimationLoop(fn)——fn 每帧先 sim.update(dt)（帧差分 clamp 0.1，
// 见 setAnimationLoop），再由 player 内部 update(dt)（→ updateParticles(dt)）读 getter 刷新
// BufferAttribute（sim 已在帧内推进，无一帧滞后）。
// 背景/粒子共用同一 cover 正交相机（Task 1/2 裁决：构造器传场景尺寸 + setSceneSize + resize）；
// Task 5 修复：resize 的视口=窗口/视口尺寸（viewport 参数），而非场景尺寸——cover 按窗口比例裁剪，
// 避免窗口比例 ≠ 场景比例时背景被 object-fit:fill 拉伸（对照 wasm 用 window.innerWidth/Height 的 cover）。
//
// 注意：`loadSceneToThree` 不直接 import wasm `CpuParticleSim`——wasm-bindgen 把它导出为**静态**
// `CpuParticleSim.new(...)`（非 `new CpuParticleSim(...)`），且 node/jsdom 无法实例化 wasm 模块。
// 故由 `assets.createParticleSim` 工厂抽象：生产传 wasm 包装（`CpuParticleSim.new(json, Float32Array.from(origin), w, h)`），
// 测试传 mock。three 播放器与 wasm 解耦（思路 1：不重写模拟，只换渲染引擎）。

// 粒子模拟器接口（对齐 wasm `CpuParticleSim` 的 JS 形态，供 three 播放器读顶点/驱动）。
export interface ParticleSim {
  update(dt: number): void;
  vertices(): Float32Array;
  frame_count(): number;
  set_frame_count(n: number): void;
  particle_count(): number;
  free?(): void;
}

// 每粒子对象的渲染/材质条件（由调用方预组装：spec JSON 供 sim 解析、纹理/混合/软化供渲染）。
export interface LoadedParticleAssets {
  specJson: string;                            // 粒子规格 JSON（原始），供 CpuParticleSim::new 解析
  tex?: THREE.Texture;                         // 粒子 sprite sheet 纹理（缺省 = 白图兜底）
  blend: 'additive' | 'alpha';                 // 混合模式（three ShaderMaterial.blending）
  softness?: number;                           // 中心→边缘软衰减（0-1）
}

// 粒子模拟器工厂：从粒子规格 JSON + 对象中心构造模拟器。
// 生产传 wasm `CpuParticleSim` 的包装；测试传 mock（无需 wasm）。
export type ParticleSimFactory = (
  json: string,
  origin: [number, number, number],
  sceneW: number,
  sceneH: number,
) => ParticleSim;

// 场景装配输入：调用方把已解码的纹理/规格/模拟器工厂交给 `loadSceneToThree`。
export interface SceneAssets {
  // 可选注入 renderer（node/jsdom 无 WebGL，测试用 mock 注入；缺省构造标准 antialias WebGLRenderer）。
  renderer?: THREE.WebGLRenderer;
  // 背景纹理：image 对象 id → THREE.Texture（缺省 = 无纹理 MeshBasicMaterial，纯色/留白）。
  backgroundTextures?: Map<number, THREE.Texture>;
  // 粒子条件：particle 对象 id → 规格/纹理/混合。
  particles?: Map<number, LoadedParticleAssets>;
  // 粒子模拟器构造器（wasm CpuParticleSim 的包装；测试注入 mock）。
  createParticleSim?: ParticleSimFactory;
}

// `loadSceneToThree` 返回：播放器 + 已装配的模拟器/图层 id（供调用方驱动/释放/校验）。
export interface ThreeSceneLoadResult {
  player: ThreeScenePlayer;
  // 已创建的粒子模拟器（按 scene.json objects 顺序）；长度 = 有粒子 spec + createParticleSim 的粒子对象数。
  sims: ParticleSim[];
  // 背景图层 id（addBackground 返回值，按 objects 顺序）；长度 = image 对象数。
  backgroundIds: number[];
  // 粒子图层 id（addParticle 返回值）与其对应 sim 的配对。
  particleLayers: Array<{ id: number; sim: ParticleSim }>;
}

// 对齐 wasm `particle_render::frame_count_from_dims`：sprite sheet 横向帧数 = 纹理宽/高
// （每帧方形；rosepetals 512×128 → 4；单帧 → 1）。u32 整除 → floor。
export function frameCountFromDims(width: number, height: number): number {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  return Math.max(1, Math.floor(w / h));
}

// 从 THREE.Texture 读实际纹理尺寸推导 sprite sheet 帧数。
// DataTexture.image={width,height,data}；CompressedTexture.image 为 mip 数组 [{width,height,data},...]；
// ImageBitmap/HTMLImageElement.image.width/height。缺省/未知 → 1（单帧）。
export function textureFrameCount(tex?: THREE.Texture): number {
  if (!tex) return 1;
  const img = tex.image as { width?: unknown; height?: unknown } | undefined;
  if (
    img &&
    typeof img.width === 'number' && typeof img.height === 'number' &&
    img.width > 0 && img.height > 0
  ) {
    return frameCountFromDims(img.width, img.height);
  }
  if (Array.isArray(tex.image)) {
    const first = tex.image[0] as { width?: unknown; height?: unknown } | undefined;
    if (
      first &&
      typeof first.width === 'number' && typeof first.height === 'number' &&
      first.width > 0 && first.height > 0
    ) {
      return frameCountFromDims(first.width, first.height);
    }
  }
  return 1;
}

export function loadSceneToThree(
  sceneJson: string,
  assets: SceneAssets,
  canvas: HTMLCanvasElement,
  viewport?: { width: number; height: number },
): ThreeSceneLoadResult {
  const desc = parseSceneJson(sceneJson);
  const sceneW = desc.orthogonal.width;
  const sceneH = desc.orthogonal.height;
  // 构造器传场景尺寸（Task 1 裁决：视口缺省与场景同尺寸）；setSceneSize 冗余同步 + 用**真实视口**
  // resize（Task 5 修复：视口必须是窗口/视口尺寸，而非场景尺寸）。viewport 由调用方显式传入
  // （createThreeSceneRenderer.render 的 vw/vh = window.innerWidth/Height）；缺省回退场景尺寸
  // （构造器缺省 viewport=scene → cover==场景尺寸无裁剪，保持默认语义）。
  const player = new ThreeScenePlayer(canvas, sceneW, sceneH, assets.renderer);
  player.setSceneSize(sceneW, sceneH);
  const vw = viewport?.width ?? sceneW;
  const vh = viewport?.height ?? sceneH;
  if (vw > 0 && vh > 0) player.resize(vw, vh);

  const backgroundIds: number[] = [];
  const particleLayers: Array<{ id: number; sim: ParticleSim }> = [];
  const sims: ParticleSim[] = [];

  for (const obj of desc.objects) {
    if (obj.kind === 'image') {
      // 背景对象：we_to_three（addBackground 内部）+ 对象调制（alpha/brightness）→ 背景图层。
      // alignment 缺省 centre（addBackground 签名无 alignment，Task 2 裁决）；origin 直传。
      const id = player.addBackground({
        origin: obj.origin,
        size: obj.size,
        scale: obj.scale,
        texture: assets.backgroundTextures?.get(obj.id),
        alpha: obj.alpha,
        brightness: obj.brightness,
        sceneW,
        sceneH,
      });
      backgroundIds.push(id);
    } else if (obj.kind === 'particle' && obj.particle) {
      // 粒子对象：仅当调用方提供 spec + 模拟器工厂时装配（缺 spec/工厂 → 跳过该对象，绝不白屏，
      // 与缺失粒子纹理时白图兜底同语义）。
      const p = assets.particles?.get(obj.id);
      if (!p || !assets.createParticleSim) continue;
      // new CpuParticleSim(json, origin, sceneW, sceneH)（经工厂抽象：生产 wasm / 测试 mock）。
      const sim = assets.createParticleSim(p.specJson, obj.origin, sceneW, sceneH);
      // FrameCount 对齐（Task 3 Minor）：sim.set_frame_count(纹理帧数)，addParticle 的
      // opts.frameCount 取 sim.frame_count()——避免多帧 uv 切片与 sim 帧编号错位。
      const frameCount = textureFrameCount(p.tex);
      sim.set_frame_count(frameCount);
      const id = player.addParticle(() => sim.vertices(), {
        tex: p.tex,
        frameCount: sim.frame_count(),
        blend: p.blend,
        softness: p.softness,
      });
      particleLayers.push({ id, sim });
      sims.push(sim);
    }
  }

  // 播放循环：RAF 每帧先 sim.update(dt)（dt 由 setAnimationLoop 帧差分、clamp 0.1）再
  // player.update(dt)（→ updateParticles(dt) 读 getter = sim.vertices()，sim 已在帧内推进）。
  player.setAnimationLoop((dt) => {
    for (const sim of sims) sim.update(dt);
  });

  return { player, sims, backgroundIds, particleLayers };
}
