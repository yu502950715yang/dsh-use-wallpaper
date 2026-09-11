// @vitest-environment jsdom
// Task 1：three.js 场景骨架。WebGLRenderer 无法在 node/jsdom（无 WebGL）环境构造，
// 测试按契约「可 mock renderer」注入 mock（真实 Scene/Camera/cover 数值仍可验证）。
// 聚焦：构造后 scene/camera/renderer 存在；resize 更新 cover；update+render 不抛错；
// 正交相机 cover 尺寸正确（复用 scene-renderer.coverRange 语义）。

import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { ThreeScenePlayer, loadSceneToThree, frameCountFromDims, textureFrameCount, textureFrameGrid, specMaxcount, particleCapacity, specEmitterOrigin, simEmitterOffset, BLACKMYTH_OBJ_SCALE, DEFAULT_PARTICLE_CAPACITY, MAX_PARTICLE_CAPACITY } from '../src/client/threejs-player.js';
import { coverRange } from '../src/client/scene-renderer.js';

// 注入的 mock renderer：只测相机/场景/RAF 逻辑，不触碰 WebGL。
function createMockRenderer() {
  let loop: (() => void) | null = null;
  const setAnimationLoop = vi.fn((fn: (() => void) | null) => {
    loop = fn;
  });
  const renderer = {
    setSize: vi.fn(),
    setPixelRatio: vi.fn(),
    render: vi.fn(),
    dispose: vi.fn(),
    setAnimationLoop,
    _getLoop: () => loop,
  };
  return renderer;
}

function makePlayer(w = 1920, h = 1080, mock = createMockRenderer()) {
  const canvas = document.createElement('canvas');
  const player = new ThreeScenePlayer(canvas, w, h, mock as unknown as THREE.WebGLRenderer);
  return { player, mock };
}

describe('ThreeScenePlayer', () => {
  it('构造后 scene / camera / renderer 均存在（scene/camera 为真实 THREE 对象）', () => {
    const { player, mock } = makePlayer();
    expect(player.scene).toBeInstanceOf(THREE.Scene);
    expect(player.camera).toBeInstanceOf(THREE.OrthographicCamera);
    expect(player.renderer).toBe(mock);
    // 正交相机 z 轴范围（-1000..1000）与相机沿 +z 放置（CAMERA_DISTANCE）
    expect(player.camera.near).toBe(-1000);
    expect(player.camera.far).toBe(1000);
    expect(player.camera.position.z).toBe(300);
  });

  it('renderer.outputColorSpace = LinearSRGBColorSpace（对齐 wasm 非 sRGB 管线，防纹理过曝/偏白）', () => {
    const { player } = makePlayer();
    // wasm 参考用 UNorm（非 sRGB）纹理直出；three 缺省 sRGB output 会对未标色域的纹理做
    // linear→sRGB 再编码 → 画面偏亮/过曝。强制 LinearSRGB → linearToOutputTexel 恒等（直出）。
    expect((player.renderer as unknown as { outputColorSpace: string }).outputColorSpace).toBe(THREE.LinearSRGBColorSpace);
  });

  it('renderer.setPixelRatio = window.devicePixelRatio（HiDPI 使渲染缓冲=物理像素，防整图放大模糊）', () => {
    // three WebGLRenderer 缺省 pixelRatio=1（渲染缓冲 = 视口 CSS 像素）；`.wp-scene-canvas` 以
    // width:100% 铺满窗口，在 HiDPI（devicePixelRatio>1）屏幕上 1× 缓冲被放大到物理像素 →
    // 整图模糊（背景 + 粒子都被糊成不可辨）。此处按 devicePixelRatio 设置像素比 → 1:1 锐利。
    const orig = (window as { devicePixelRatio?: number }).devicePixelRatio;
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
    const { mock } = makePlayer();
    expect(mock.setPixelRatio).toHaveBeenCalledWith(2);
    Object.defineProperty(window, 'devicePixelRatio', { value: orig, configurable: true });
  });

  it('resize 把「渲染缓冲 = 视口×dpr」钉死：canvas.width/height 不再是 HTML 默认 300×150', () => {
    // 2026-09-10 Task5（真机 console 实证起点）：`document.querySelector('canvas')` 读到
    // 300×150（HTML canvas 默认）→ 说明某个 canvas 从未被设成视口尺寸，被 CSS `width:100%`
    // 拉伸放大 → 画面模糊。本类自己保证该不变量：resize(w,h) 后 canvas.width/height 必须
    // = floor(w×dpr), floor(h×dpr)（即使注入的 renderer 是 no-op mock，也不能停在 300×150）。
    const { player } = makePlayer();
    const canvas = player.canvas;
    expect(canvas.width).toBe(300); // jsdom/HTML 默认值（修复前 resize 依赖 renderer.setSize）
    expect(canvas.height).toBe(150);
    player.resize(1920, 1080);
    expect(canvas.width).toBe(1920);
    expect(canvas.height).toBe(1080);
  });

  it('resize 在 HiDPI（dpr=2）下缓冲 = 视口×2（1:1 物理像素，不模糊）', () => {
    const orig = (window as { devicePixelRatio?: number }).devicePixelRatio;
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
    const { player, mock } = makePlayer();
    player.resize(1600, 900);
    expect(mock.setSize).toHaveBeenCalledWith(1600, 900, false);
    expect(mock.setPixelRatio).toHaveBeenLastCalledWith(2);
    expect(player.canvas.width).toBe(3200);
    expect(player.canvas.height).toBe(1800);
    Object.defineProperty(window, 'devicePixelRatio', { value: orig, configurable: true });
  });  it('缺省 cover：视口 == 场景尺寸 → 相机视锥 == 场景尺寸（1920×1080，无裁剪）', () => {
    const { player } = makePlayer(1920, 1080);
    expect(player.camera.left).toBe(-960);
    expect(player.camera.right).toBe(960);
    expect(player.camera.top).toBe(540);
    expect(player.camera.bottom).toBe(-540);
  });

  it('resize 更新 cover：视口更宽（1920×720）→ 垂直裁剪（宽度铺满，高裁到 720）', () => {
    const { player, mock } = makePlayer(1920, 1080);
    player.resize(1920, 720);
    expect(player.camera.left).toBe(-960);
    expect(player.camera.right).toBe(960);
    expect(player.camera.top).toBe(360);
    expect(player.camera.bottom).toBe(-360);
    expect(mock.setSize).toHaveBeenCalledWith(1920, 720, false);
  });

  it('resize 更新 cover：视口更窄（720×1080）→ 水平裁剪（高度铺满，宽裁到 720）', () => {
    const { player } = makePlayer(1920, 1080);
    player.resize(720, 1080);
    expect(player.camera.left).toBe(-360);
    expect(player.camera.right).toBe(360);
    expect(player.camera.top).toBe(540);
    expect(player.camera.bottom).toBe(-540);
  });

  it('cover 复用 scene-renderer.coverRange 同一语义（直接对拍数值）', () => {
    // 视口宽高比 4:3 < 场景 16:9 → 高度铺满、宽度裁剪
    expect(coverRange(1920, 1080, 4 / 3)).toEqual({ w: 1440, h: 1080 });
    // 视口宽高比 8:5 = 1.6 < 1.7778 → 高度铺满
    expect(coverRange(1920, 1080, 8 / 5)).toEqual({ w: 1728, h: 1080 });
    // 视口宽高比超高 21:9 ≈ 2.333 > 1.7778 → 宽度铺满、垂直裁剪
    expect(coverRange(1920, 1080, 21 / 9)).toEqual({ w: 1920, h: 1920 / (21 / 9) });
  });

  it('update + render 直接调用不抛错', () => {
    const { player, mock } = makePlayer();
    expect(() => player.update(0.1)).not.toThrow();
    expect(() => player.render()).not.toThrow();
    expect(mock.render).toHaveBeenCalledWith(player.scene, player.camera);
  });

  it('setAnimationLoop：每帧调用 update + render，且不抛错（RAF 循环体可运行）', () => {
    const { player, mock } = makePlayer();
    expect(() => player.setAnimationLoop()).not.toThrow();
    expect(mock.setAnimationLoop).toHaveBeenCalled();
    const loop = mock._getLoop();
    expect(loop).toBeTypeOf('function');
    // 手动跑一帧：update 空实现不抛错、render 被调用（camera/scene 为真实对象）
    expect(() => loop!()).not.toThrow();
    expect(mock.render).toHaveBeenCalledWith(player.scene, player.camera);
  });

  it('setAnimationLoop(fn)：外部回调收到 dt（0.1s 内数值，第一帧为差分）', () => {
    const { player, mock } = makePlayer();
    const fn = vi.fn();
    player.setAnimationLoop(fn);
    const loop = mock._getLoop();
    loop!();
    expect(fn).toHaveBeenCalledTimes(1);
    const dt = fn.mock.calls[0][0] as number;
    expect(dt).toBeGreaterThanOrEqual(0);
    expect(dt).toBeLessThanOrEqual(0.1);
  });

  // 2026-09-10 Task5 深挖（关键，对应「背景清晰但没有粒子」）：three r170 的
  // `WebGLAnimation.onAnimationFrame` = `animationLoop(...); requestId = context.requestAnimationFrame(...)`
  // （three.module.js 13612-13618），**重排下一帧在回调之后**且无 try/catch。只要帧体抛一次异常，
  // RAF 就永久不再排程 → 画面停在首帧（instanceCount=0，粒子永不出现）。本类必须自包裹，保证
  // 「单帧异常只丢该帧，循环继续」。
  it('setAnimationLoop：帧体抛异常不逃逸（three 才能重排下一帧，防 RAF 永久停摆 → 无粒子）', () => {
    const { player, mock } = makePlayer();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let calls = 0;
    player.setAnimationLoop(() => {
      calls++;
      if (calls === 1) throw new Error('sim panic（模拟 wasm 异常）');
    });
    const loop = mock._getLoop()!;
    // 第一帧：外部回调抛错 → 不得逃逸出帧回调（否则 three 不会重排 RAF）。
    expect(() => loop()).not.toThrow();
    // 循环继续：第二帧正常执行（渲染没有被停摆）。
    expect(() => loop()).not.toThrow();
    expect(calls).toBe(2);
    // 抛错那帧的 render 被跳过（异常发生在 fn 内，之后的 update/render 不执行）→ 只渲染了第二帧。
    expect(mock.render).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1); // 只警告一次（防刷屏）
    warn.mockRestore();
  });

  it('setAnimationLoop：renderer.render 抛异常同样不逃逸（循环自愈）', () => {
    const { player, mock } = makePlayer();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mock.render.mockImplementationOnce(() => { throw new Error('gl error'); });
    player.setAnimationLoop();
    const loop = mock._getLoop()!;
    expect(() => loop()).not.toThrow();
    expect(() => loop()).not.toThrow();
    expect(mock.render).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('setSceneSize 更新场景固有尺寸并重推 cover', () => {
    const { player } = makePlayer(1920, 1080);
    player.setSceneSize(2400, 1555);
    // 视口仍默认 1920×1080 → viewAspect 1.7778 > sceneAspect 2400/1555≈1.543 →
    // 宽度铺满、垂直裁剪：w=2400, h=2400/1.7778≈1350
    expect(player.camera.left).toBe(-1200);
    expect(player.camera.right).toBe(1200);
    expect(player.camera.top).toBeCloseTo(2400 / (1920 / 1080) / 2, 6);
    expect(player.camera.bottom).toBeCloseTo(-2400 / (1920 / 1080) / 2, 6);
  });

  it('dispose 停止循环并释放 renderer', () => {
    const { player, mock } = makePlayer();
    player.dispose();
    expect(mock.setAnimationLoop).toHaveBeenCalledWith(null);
    expect(mock.dispose).toHaveBeenCalled();
  });
});

// Task 2：背景图层（addBackground / update_background）。复用 Task 1 的 mock renderer 注入，
// 验证 we_to_three 中心化（y 不翻）、size×scale 尺寸、alpha/brightness 调制与 update 语义。
describe('ThreeScenePlayer background layer', () => {
  // 场景固有尺寸：构造宽高传场景尺寸（Task 1 裁决：构造器传场景尺寸，首帧 resize 推 cover）。
  it('addBackground：居中 origin=(1920,1080)，场景 3840×2160 → 背景 mesh position = 中心 (0,0)', () => {
    const { player } = makePlayer(3840, 2160);
    const id = player.addBackground({
      origin: [1920, 1080, 0], size: [100, 50], scale: [1, 1, 1],
      sceneW: 3840, sceneH: 2160,
    });
    expect(typeof id).toBe('number');
    const mesh = player.scene.children[0] as THREE.Mesh;
    expect(mesh).toBeInstanceOf(THREE.Mesh);
    expect(mesh.position.x).toBe(0);
    expect(mesh.position.y).toBe(0);
    expect(mesh.position.z).toBe(0);
    // scene 含背景对象（仅 1 个 mesh）
    expect(player.scene.children.length).toBe(1);
  });

  it('addBackground：非居中 origin=(2306.34,419.77)，3840×2160 → we_to_three (386.34,-660.23)', () => {
    const { player } = makePlayer(3840, 2160);
    player.addBackground({
      origin: [2306.34, 419.77, 0], size: [10, 10], scale: [1, 1, 1],
      sceneW: 3840, sceneH: 2160,
    });
    const mesh = player.scene.children[0] as THREE.Mesh;
    expect(mesh.position.x).toBeCloseTo(386.34, 2);
    expect(mesh.position.y).toBeCloseTo(-660.23, 2);
  });

  it('addBackground：size×scale 定尺寸（geometry=size，mesh.scale=scale→世界尺寸=size*scale）', () => {
    const { player } = makePlayer(3840, 2160);
    player.addBackground({
      origin: [1920, 1080, 0], size: [200, 100], scale: [2, 3, 1],
      sceneW: 3840, sceneH: 2160,
    });
    const mesh = player.scene.children[0] as THREE.Mesh;
    const geom = mesh.geometry as THREE.PlaneGeometry;
    expect(geom.parameters.width).toBe(200);
    expect(geom.parameters.height).toBe(100);
    expect(mesh.scale.x).toBe(2);
    expect(mesh.scale.y).toBe(3);
    expect(mesh.scale.z).toBe(1);
  });

  it('addBackground：alpha→material.opacity、brightness→color 调制（rgb=clamp01(brightness)，a=clamp01(alpha)）', () => {
    const { player } = makePlayer(3840, 2160);
    player.addBackground({
      origin: [1920, 1080, 0], size: [100, 100], scale: [1, 1, 1],
      alpha: 0.5, brightness: 0.8, sceneW: 3840, sceneH: 2160,
    });
    const mat = (player.scene.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial;
    expect(mat.transparent).toBe(true);
    expect(mat.opacity).toBeCloseTo(0.5, 6);
    expect(mat.color.r).toBeCloseTo(0.8, 6);
    expect(mat.color.g).toBeCloseTo(0.8, 6);
    expect(mat.color.b).toBeCloseTo(0.8, 6);
  });

  it('update_background：更新 origin/scale/alpha/brightness（undefined 保持现状）', () => {
    const { player } = makePlayer(3840, 2160);
    const id = player.addBackground({
      origin: [1920, 1080, 0], size: [100, 50], scale: [1, 1, 1],
      alpha: 1, brightness: 1, sceneW: 3840, sceneH: 2160,
    });
    const mesh = player.scene.children[0] as THREE.Mesh;
    const mat = mesh.material as THREE.MeshBasicMaterial;
    expect(mat.opacity).toBe(1);
    expect(mat.color.r).toBe(1);

    // 更新 origin（we_to_three 中心化随场景尺寸重算）
    player.update_background(id, [2456.34, 419.77, 0]);
    expect(mesh.position.x).toBeCloseTo(2456.34 - 3840 / 2, 2);
    expect(mesh.position.y).toBeCloseTo(419.77 - 2160 / 2, 2);

    // 更新 scale（世界尺寸 = size*scale）
    player.update_background(id, undefined, [2, 3, 1]);
    expect(mesh.scale.x).toBe(2);
    expect(mesh.scale.y).toBe(3);
    expect(mesh.scale.z).toBe(1);

    // 更新 alpha → material.opacity
    player.update_background(id, undefined, undefined, 0.5);
    expect(mat.opacity).toBeCloseTo(0.5, 6);

    // 更新 brightness → color 调色（rgb = clamp01(brightness)，a 不变）
    player.update_background(id, undefined, undefined, undefined, 0.8);
    expect(mat.color.r).toBeCloseTo(0.8, 6);
    expect(mat.color.g).toBeCloseTo(0.8, 6);
    expect(mat.color.b).toBeCloseTo(0.8, 6);
    expect(mat.opacity).toBeCloseTo(0.5, 6);
  });

  it('update_background：传入值无变化 → 跳过该字段（位置/opacity/color 保持现值）', () => {
    const { player } = makePlayer(3840, 2160);
    const id = player.addBackground({
      origin: [1920, 1080, 0], size: [100, 50], scale: [1, 1, 1],
      alpha: 0.5, brightness: 0.8, sceneW: 3840, sceneH: 2160,
    });
    const mesh = player.scene.children[0] as THREE.Mesh;
    const mat = mesh.material as THREE.MeshBasicMaterial;
    // 全部等于当前已应用状态 → 不触碰
    player.update_background(id, [1920, 1080, 0], [1, 1, 1], 0.5, 0.8);
    expect(mesh.position.x).toBe(0);
    expect(mesh.position.y).toBe(0);
    expect(mat.opacity).toBeCloseTo(0.5, 6);
    expect(mat.color.r).toBeCloseTo(0.8, 6);
  });

  it('addBackground：mesh.renderOrder=0、material.depthWrite=false（背景在粒子之下绘制、不写深度遮粒子）', () => {
    const { player } = makePlayer(3840, 2160);
    player.addBackground({
      origin: [1920, 1080, 0], size: [100, 100], scale: [1, 1, 1],
      sceneW: 3840, sceneH: 2160,
    });
    const mesh = player.scene.children[0] as THREE.Mesh;
    expect(mesh.renderOrder).toBe(0);
    expect((mesh.material as THREE.MeshBasicMaterial).depthWrite).toBe(false);
  });

  it('update_background：未知 id → no-op（不抛错）', () => {
    const { player } = makePlayer(3840, 2160);
    expect(() => player.update_background(999, [1, 2, 3])).not.toThrow();
  });
});

// Task 3：粒子图层（addParticle / updateParticles）。用 mock getter 提供 sim 顶点（每粒子
// [pos3,size,uv2,color3,alpha] 10 浮点，对应 wasm SceneParticleSim::build_instance_vertices），
// 验证 BufferGeometry（InstancedBufferGeometry）被正确填充、updateParticles 刷新 buffer、
// blend/softness 设到 ShaderMaterial。
describe('ThreeScenePlayer particle layer', () => {
  // 每粒子 [pos3, size, uv2, color3, alpha]。helper 把平铺数组转 Float32Array。
  function makeVerts(...parts: number[][]): Float32Array {
    return new Float32Array(parts.flat());
  }

  // 2 粒子数据：
  //   p0: pos(1,2,3) size40 uv(0.625,0.5) color(0.5,0.6,0.7) alpha0.25
  //   p1: pos(-4,5,6) size20 uv(0.125,0.5) color(1,0,0) alpha0.5
  const dataA = makeVerts(
    [1, 2, 3, 40, 0.625, 0.5, 0.5, 0.6, 0.7, 0.25],
    [-4, 5, 6, 20, 0.125, 0.5, 1, 0, 0, 0.5],
  );

  // 取 addParticle 后 scene 里的粒子 mesh（无背景时 scene.children[0]）。
  function particleMesh(player: ThreeScenePlayer): THREE.Mesh {
    const mesh = player.scene.children[0] as THREE.Mesh;
    expect(mesh).toBeInstanceOf(THREE.Mesh);
    return mesh;
  }

  it('addParticle：geometry 属性数/长度符合 sim 顶点（每粒子 [pos3,size,uv2,color3,alpha]）', () => {
    const { player } = makePlayer(1920, 1080);
    player.addParticle(() => dataA, { frameCount: 4, blend: 'additive', softness: 0.3 });
    const mesh = particleMesh(player);
    const geom = mesh.geometry as THREE.InstancedBufferGeometry;
    expect(geom).toBeInstanceOf(THREE.InstancedBufferGeometry);
    expect(geom.instanceCount).toBe(2);

    // 5 个 per-particle instanced 属性（position/size/uv/color/alpha）。
    // 属性按**实例容量**预分配（不是按当前粒子数）——three 首帧锁存容量，必须一次给足（见
    // addParticle 的根因注释），故此处断言「容量 ≥ 当前粒子数 + 各属性长度 = count×itemSize」，
    // 而非旧实现的「长度恰为 粒子数×itemSize」。
    const pos = geom.getAttribute('particlePosition') as THREE.InstancedBufferAttribute;
    const size = geom.getAttribute('particleSize') as THREE.InstancedBufferAttribute;
    const uv = geom.getAttribute('particleUv') as THREE.InstancedBufferAttribute;
    const color = geom.getAttribute('particleColor') as THREE.InstancedBufferAttribute;
    const alpha = geom.getAttribute('particleAlpha') as THREE.InstancedBufferAttribute;
    expect(pos.count).toBeGreaterThanOrEqual(2);
    expect((pos.array as Float32Array).length).toBe(pos.count * 3);
    expect((size.array as Float32Array).length).toBe(size.count);
    expect((uv.array as Float32Array).length).toBe(uv.count * 2);
    expect((color.array as Float32Array).length).toBe(color.count * 3);
    expect((alpha.array as Float32Array).length).toBe(alpha.count);

    // 数据写回：p0 pos=(1,2,3)、size=40、uv=(0.625,0.5)、color=(0.5,0.6,0.7)、alpha=0.25。
    expect(Array.from(pos.array as Float32Array).slice(0, 3)).toEqual([1, 2, 3]);
    expect((size.array as Float32Array)[0]).toBe(40);
    expect(Array.from(uv.array as Float32Array).slice(0, 2)).toEqual([0.625, 0.5]);
    // Float32 精度：0.5/0.625 可精确，0.6/0.7 需 closeTo。
    const col0 = Array.from(color.array as Float32Array).slice(0, 3);
    expect(col0[0]).toBeCloseTo(0.5, 6);
    expect(col0[1]).toBeCloseTo(0.6, 6);
    expect(col0[2]).toBeCloseTo(0.7, 6);
    expect((alpha.array as Float32Array)[0]).toBe(0.25);
    // p1：pos=(-4,5,6)、size=20。
    expect(Array.from(pos.array as Float32Array).slice(3, 6)).toEqual([-4, 5, 6]);
    expect((size.array as Float32Array)[1]).toBe(20);
  });

  // 2026-09-10 Task5 深挖：InstancedBufferGeometry 的包围球只看**基础四边形**（[-1,1]²，半径≈1.41），
  // 不含 per-instance 位置；粒子实际散布在世界坐标 ±1200 处 → 任何按 boundingSphere 剔除的路径都会
  // 把整层判为离屏（整层不绘制 = 花瓣全丢）。故 mesh.frustumCulled=false **且** geometry.boundingSphere
  // 显式设为无限半径，双保险。
  it('addParticle：frustumCulled=false 且 boundingSphere=无限半径（防整层被视锥剔除 → 无花瓣）', () => {
    const { player } = makePlayer(1920, 1080);
    player.addParticle(() => dataA, { frameCount: 1, blend: 'alpha' });
    const mesh = particleMesh(player);
    const geom = mesh.geometry as THREE.InstancedBufferGeometry;
    expect(mesh.frustumCulled).toBe(false);
    expect(geom.boundingSphere).toBeInstanceOf(THREE.Sphere);
    expect(geom.boundingSphere!.radius).toBe(Number.POSITIVE_INFINITY);
    // 基础四边形自身算出来的包围球半径只有 ≈1.41（远小于粒子世界坐标）——证明显式无限半径是必要的。
    const probe = new THREE.InstancedBufferGeometry();
    probe.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    probe.computeBoundingSphere();
    expect(probe.boundingSphere!.radius).toBeLessThan(2);
  });

  it('addParticle：blend 模式（additive/alpha）设到 material，transparent 恒置位', () => {    const { player } = makePlayer(1920, 1080);
    player.addParticle(() => dataA, { frameCount: 4, blend: 'additive' });
    const matAdd = particleMesh(player).material as THREE.ShaderMaterial;
    expect(matAdd.transparent).toBe(true);
    expect(matAdd.blending).toBe(THREE.AdditiveBlending);

    // alpha blend 用另一个 player（或清空既有图层）。
    const p2 = makePlayer(1920, 1080);
    p2.player.addParticle(() => dataA, { frameCount: 4, blend: 'alpha' });
    const matAlpha = particleMesh(p2.player).material as THREE.ShaderMaterial;
    expect(matAlpha.transparent).toBe(true);
    expect(matAlpha.blending).toBe(THREE.NormalBlending);
  });

  it('addParticle：softness / frameCount 设到 material 的 uniform', () => {
    const { player } = makePlayer(1920, 1080);
    player.addParticle(() => dataA, { frameCount: 3, blend: 'alpha', softness: 0.7 });
    const mat = particleMesh(player).material as THREE.ShaderMaterial;
    expect(mat.uniforms.softness.value).toBe(0.7);
    expect(mat.uniforms.frameCount.value).toBe(3);
    // 无 tex → map 兜底为 1×1 白 DataTexture（纯色粒子不依赖纹理内容）。
    expect(mat.uniforms.map.value).toBeInstanceOf(THREE.Texture);
  });

  it('addParticle：精灵表网格（frameCols/frameRows）设到 uniform；缺省为横向等分（cols=n, rows=1）', () => {
    const { player } = makePlayer(1920, 1080);
    player.addParticle(() => dataA, { frameCount: 64, frameCols: 8, frameRows: 8, blend: 'alpha' });
    const mat = particleMesh(player).material as THREE.ShaderMaterial;
    expect(mat.uniforms.frameCols.value).toBe(8);
    expect(mat.uniforms.frameRows.value).toBe(8);
    // 缺省（非精灵表）：cols=frameCount、rows=1（与旧的横向等分切片等价）。
    const p2 = makePlayer(1920, 1080);
    p2.player.addParticle(() => dataA, { frameCount: 4, blend: 'alpha' });
    const mat2 = particleMesh(p2.player).material as THREE.ShaderMaterial;
    expect(mat2.uniforms.frameCols.value).toBe(4);
    expect(mat2.uniforms.frameRows.value).toBe(1);
  });

  it('addParticle：对象变换（objCenter/objScale/emitterOrigin/bmOffset）设到 uniform；缺省恒等', () => {
    const { player } = makePlayer(1920, 1080);
    player.addParticle(() => dataA, {
      frameCount: 1, blend: 'additive',
      objectCenter: [100, -50, 0], objectScale: [-0.5, 0.25, 1], emitterOrigin: [150, 550, 0],
    });
    const mat = particleMesh(player).material as THREE.ShaderMaterial;
    expect((mat.uniforms.objCenter.value as THREE.Vector3).toArray()).toEqual([100, -50, 0]);
    expect((mat.uniforms.objScale.value as THREE.Vector3).toArray()).toEqual([-0.5, 0.25, 1]);
    expect((mat.uniforms.emitterOrigin.value as THREE.Vector3).toArray()).toEqual([150, 550, 0]);
    // bmOffset = BLACKMYTH_OBJ_SCALE ⊙ emitterOrigin（模拟器已加进 particlePosition 的偏移，
    // 顶点 shader 要减掉它才能拿到纯局部坐标）。
    expect((mat.uniforms.bmOffset.value as THREE.Vector3).toArray()).toEqual([
      150 * BLACKMYTH_OBJ_SCALE[0], 550 * BLACKMYTH_OBJ_SCALE[1], 0,
    ]);
    // 缺省（不传）→ 恒等变换：objCenter=0、objScale=1、emitterOrigin=0、bmOffset=0。
    const p2 = makePlayer(1920, 1080);
    p2.player.addParticle(() => dataA, { frameCount: 1, blend: 'alpha' });
    const mat2 = particleMesh(p2.player).material as THREE.ShaderMaterial;
    expect((mat2.uniforms.objCenter.value as THREE.Vector3).toArray()).toEqual([0, 0, 0]);
    expect((mat2.uniforms.objScale.value as THREE.Vector3).toArray()).toEqual([1, 1, 1]);
    expect((mat2.uniforms.bmOffset.value as THREE.Vector3).toArray().map((v) => v + 0)).toEqual([0, 0, 0]);
  });

  it('addParticle：softness 缺省按有无纹理（无 tex→1.0 软圆点、有 tex→0.15 薄软边），renderOrder=1（粒子在背景之上）', () => {
    const { player } = makePlayer(1920, 1080);
    // 无 tex → 白图兜底 → softness 1.0（整盘软圆点，而非硬边白方块）。
    player.addParticle(() => dataA, { frameCount: 4, blend: 'alpha' });
    const meshNoTex = particleMesh(player);
    const matNoTex = meshNoTex.material as THREE.ShaderMaterial;
    expect(matNoTex.uniforms.softness.value).toBe(1.0);
    expect(meshNoTex.renderOrder).toBe(1);
    // 有 tex → softness 0.15（薄软边，形状由 texel.a 提供）。
    const p2 = makePlayer(1920, 1080);
    p2.player.addParticle(() => dataA, {
      frameCount: 4, blend: 'alpha', tex: new THREE.DataTexture(new Uint8Array(4), 2, 2),
    });
    const meshTex = particleMesh(p2.player);
    const matTex = meshTex.material as THREE.ShaderMaterial;
    expect(matTex.uniforms.softness.value).toBe(0.15);
    expect(meshTex.renderOrder).toBe(1);
    // 显式传 softness 时以显式值为准（覆盖缺省）。
    const p3 = makePlayer(1920, 1080);
    p3.player.addParticle(() => dataA, { frameCount: 4, blend: 'alpha', tex: new THREE.DataTexture(new Uint8Array(4), 2, 2), softness: 0.7 });
    expect((particleMesh(p3.player).material as THREE.ShaderMaterial).uniforms.softness.value).toBe(0.7);
  });

  it('addParticle：maskMode 按有无纹理（无 tex→0 软圆盘、有 tex→1 纹理 alpha 遮罩保形状），对齐 wasm particle_billboard', () => {
    const { player } = makePlayer(1920, 1080);
    // 无 tex（白图兜底）→ maskMode=0：形状=软圆盘（disk，softness 控制边缘）。
    player.addParticle(() => dataA, { frameCount: 4, blend: 'alpha' });
    const matNoTex = particleMesh(player).material as THREE.ShaderMaterial;
    expect(matNoTex.uniforms.maskMode.value).toBe(0);
    // 有 tex → maskMode=1：形状=texel.a（纹理 alpha 遮罩），粒子保持纹理形状（花瓣/光柱/雪片），
    // 不被软圆盘裁成圆形。
    const p2 = makePlayer(1920, 1080);
    p2.player.addParticle(() => dataA, {
      frameCount: 4, blend: 'alpha',
      tex: new THREE.DataTexture(new Uint8Array([255, 255, 255, 128]), 2, 2),
    });
    const matTex = particleMesh(p2.player).material as THREE.ShaderMaterial;
    expect(matTex.uniforms.maskMode.value).toBe(1);
  });

  it('addParticle：无 tex 时用 1×1 白 DataTexture 兜底（map uniform 恒非空）', () => {
    const { player } = makePlayer(1920, 1080);
    player.addParticle(() => dataA, { frameCount: 4, blend: 'additive' });
    const mat = particleMesh(player).material as THREE.ShaderMaterial;
    const tex = mat.uniforms.map.value as THREE.DataTexture;
    expect(tex).toBeInstanceOf(THREE.DataTexture);
    expect(tex.image.width).toBe(1);
    expect(tex.image.height).toBe(1);
  });

  it('updateParticles：getter 返回值变化 → BufferAttribute 被刷新（粒子数/数据更新）', () => {
    const { player } = makePlayer(1920, 1080);
    // getter 捕获可变 verts；先两次调用返回 dataA，切换后返回 3 粒子 dataB（模拟 sim 推进）。
    let verts: Float32Array = dataA;
    const getter = () => verts;
    player.addParticle(getter, { frameCount: 4, blend: 'additive' });
    const geom = particleMesh(player).geometry as THREE.InstancedBufferGeometry;
    expect(geom.instanceCount).toBe(2);

    const dataB = makeVerts(
      [7, 8, 9, 50, 0.875, 0.5, 0.1, 0.2, 0.3, 0.9],
      [10, 11, 12, 30, 0.375, 0.5, 0.4, 0.5, 0.6, 0.6],
      [-1, -2, -3, 15, 0.125, 0.5, 0.7, 0.8, 0.9, 0.1],
    );
    verts = dataB;
    player.updateParticles(0.016);
    expect(geom.instanceCount).toBe(3);
    const pos = geom.getAttribute('particlePosition') as THREE.InstancedBufferAttribute;
    const size = geom.getAttribute('particleSize') as THREE.InstancedBufferAttribute;
    // 数据写回新值：p0 pos=(7,8,9)、size=50；p2 size=15。
    expect(Array.from(pos.array as Float32Array).slice(0, 3)).toEqual([7, 8, 9]);
    expect((size.array as Float32Array)[0]).toBe(50);
    expect((size.array as Float32Array)[2]).toBe(15);
    // 属性标记 needsUpdate（buffer 已刷新）。three.js 的 needsUpdate 是 setter-only，
    // 读需用 version>0 判定（写 needsUpdate=true 使 version++）。
    expect(pos.version).toBeGreaterThan(0);
    expect(size.version).toBeGreaterThan(0);
  });

  it('update(dt) 帧钩子驱动粒子刷新：getter 每帧被调用并写回 buffer', () => {
    const { player } = makePlayer(1920, 1080);
    const getter = vi.fn(() => dataA);
    player.addParticle(getter, { frameCount: 4, blend: 'additive' });
    expect(getter).toHaveBeenCalledTimes(1); // addParticle 首帧填一次
    player.update(0.1); // 帧钩子 → updateParticles → 再取 getter
    expect(getter).toHaveBeenCalledTimes(2);
  });

  // ⚠️ 核心回归测试（2026-09-10 真机根因）：three 对 InstancedBufferGeometry 的实例容量
  // `geometry._maxInstanceCount` **只在首次渲染时锁存一次**（`setupVertexAttributes`：
  // `if (object.isInstancedMesh !== true && geometry._maxInstanceCount === undefined)
  //      geometry._maxInstanceCount = attr.meshPerAttribute * attr.count;`），
  // 之后 draw 时 `instanceCount = min(geometry.instanceCount, _maxInstanceCount)`，
  // 且 `renderInstances` 在 `primcount === 0` 时**直接 return**（不画）。
  // 旧实现按「建层当帧的粒子数」分配属性（模拟器还没 update → 0；或用户机器上首帧恰好 1 个）
  // ⇒ 容量锁死 0/1 ⇒ 粒子层**永远不画** / **永远只画 1 个**（背景照画，故表现为「背景清晰、
  // 就是没有花瓣」，而 console 里那条 `count=1` 只是首帧非零的采样值）。
  // 这两条断言复刻 three 的锁存语义：容量必须一次给足（≥ sim 最终粒子数）。
  it('addParticle：实例容量一次性给足（three 首帧锁存）——首帧 0 粒子时容量仍 > 0，防整层永不绘制', () => {
    const { player } = makePlayer(1920, 1080);
    // 建层时模拟器尚未 update（getter 返回空）——正是生产路径的真实时序。
    let verts = new Float32Array(0);
    const getter = () => verts;
    player.addParticle(getter, { frameCount: 4, blend: 'alpha', maxInstances: 50 });
    const geom = particleMesh(player).geometry as THREE.InstancedBufferGeometry;
    // three 首帧锁存的容量（取第一个 instanced 属性）——必须 ≥ maxcount，否则 draw 被截断。
    const latch = () => {
      const a = geom.getAttribute('particlePosition') as THREE.InstancedBufferAttribute;
      return a.meshPerAttribute * a.count;
    };
    expect(latch()).toBe(50);
    expect(Math.min(geom.instanceCount, latch())).toBe(0); // 还没有粒子 → 不画（正确）

    // sim 推进到 50 个粒子（黑神话 leaves5 的 maxcount）→ draw 必须画满 50 个实例。
    verts = makeVerts(...Array.from({ length: 50 }, (_, i) => [i, i, 0, 40, 0.625, 0.5, 1, 1, 1, 1]));
    player.updateParticles(1 / 60);
    expect(geom.instanceCount).toBe(50);
    expect(Math.min(geom.instanceCount, latch())).toBe(50); // ← 旧实现此处是 0（容量锁死 0）
  });

  it('addParticle：未声明 maxInstances 时用缺省容量兜底（首帧 0 粒子也不会锁死 0）', () => {
    const { player } = makePlayer(1920, 1080);
    let verts = new Float32Array(0);
    player.addParticle(() => verts, { frameCount: 4, blend: 'alpha' });
    const geom = particleMesh(player).geometry as THREE.InstancedBufferGeometry;
    const a = geom.getAttribute('particlePosition') as THREE.InstancedBufferAttribute;
    expect(a.count).toBe(DEFAULT_PARTICLE_CAPACITY);
    verts = makeVerts(...Array.from({ length: 30 }, (_, i) => [i, i, 0, 40, 0.625, 0.5, 1, 1, 1, 1]));
    player.updateParticles(1 / 60);
    expect(Math.min(geom.instanceCount, a.meshPerAttribute * a.count)).toBe(30);
  });

  it('addParticle：粒子数超出预分配容量 → 属性扩容**且**同步 three 锁存的 _maxInstanceCount', () => {
    const { player } = makePlayer(1920, 1080);
    let verts = new Float32Array(0);
    player.addParticle(() => verts, { frameCount: 4, blend: 'alpha', maxInstances: 2 });
    const geom = particleMesh(player).geometry as THREE.InstancedBufferGeometry;
    expect((geom as unknown as { _maxInstanceCount?: number })._maxInstanceCount).toBeUndefined(); // 未渲染过
    verts = makeVerts(...Array.from({ length: 5 }, (_, i) => [i, 0, 0, 10, 0.625, 0.5, 1, 1, 1, 1]));
    player.updateParticles(1 / 60);
    const a = geom.getAttribute('particlePosition') as THREE.InstancedBufferAttribute;
    expect(a.count).toBeGreaterThanOrEqual(5);
    // 扩容后必须同步锁存值，否则 three 仍按旧容量（2）截断 draw。
    expect((geom as unknown as { _maxInstanceCount?: number })._maxInstanceCount).toBe(a.count);
  });

  it('addParticle 返回数值 id，dispose 释放粒子几何/材质', () => {
    const { player } = makePlayer(1920, 1080);
    const id = player.addParticle(() => dataA, { frameCount: 4, blend: 'additive' });
    expect(typeof id).toBe('number');
    const mesh = particleMesh(player);
    const geom = mesh.geometry;
    const mat = mesh.material;
    const spyGeom = vi.spyOn(geom, 'dispose');
    const spyMat = vi.spyOn(mat, 'dispose');
    player.dispose();
    expect(spyGeom).toHaveBeenCalled();
    expect(spyMat).toHaveBeenCalled();
  });
});

// Task 4：loadSceneToThree（WE scene → three 播放器）。用 mock createParticleSim 注入（node 无法
// 实例化 wasm CpuParticleSim），验证 scene.json 解析装配（背景/粒子数量）、frameCount 对齐、
// 播放帧 sim.update + player.updateParticles 的推进顺序。复用 Task 1 的 createMockRenderer 注入。
describe('ThreeScenePlayer loadSceneToThree', () => {
  // 黑神话（Sakura）scene.json 精简版：1 个 image 对象（主图，id=13）+ 1 个 particle 对象
  // （Sakura 花瓣，id=71，origin 顶部偏左 + 负 scale）——与 research/2851992662-scene.json 一致。
  const BLACKMYTH_SCENE = JSON.stringify({
    camera: {
      center: '0.00003 26.39995 0.00000',
      eye: '0.00003 26.39995 1.00000',
      up: '0.00000 1.00000 0.00000',
    },
    general: {
      clearcolor: '0.70000 0.70000 0.70000',
      orthogonalprojection: { height: 2160, width: 3840 },
    },
    objects: [
      {
        id: 13, name: 'blackmyth_wukong_wallpaper_035',
        image: 'models/blackmyth_wukong_wallpaper_035.json',
        origin: '1920.00000 1080.00000 0.00000', scale: '1.00000 1.00000 1.00000',
        size: '3840.00000 2160.00000', alignment: 'center',
        alpha: 1.0, brightness: 1.0, color: '1.00000 1.00000 1.00000', visible: true,
      },
      {
        id: 71, name: 'Sakura',
        particle: 'particles/presets/leaves5.json',
        origin: '2306.34155 419.76611 0.00000', scale: '-2.05166 2.11670 1.00000', visible: true,
      },
    ],
  });

  // 每粒子 [pos3, size, uv2, color3, alpha] 10 浮点（2 粒子），供 mock sim.vertices() 返回。
  const SIM_VERT = new Float32Array([
    1, 2, 3, 40, 0.625, 0.5, 0.5, 0.6, 0.7, 0.25,
    -4, 5, 6, 20, 0.125, 0.5, 1, 0, 0, 0.5,
  ]);

  // wasm CpuParticleSim 的 mock：记录 update/vertices 调用（可断言推进顺序），
  // set_frame_count 更新 frame_count() 返回值（对齐真实 sim 语义）。
  function makeMockSim(initialFrameCount = 4, log: string[] = []) {
    let frameCount = Math.max(1, initialFrameCount);
    const update = vi.fn(() => { log.push('update'); });
    const vertices = vi.fn(() => { log.push('vertices'); return SIM_VERT; });
    const frame_count = vi.fn(() => frameCount);
    const set_frame_count = vi.fn((n: number) => { frameCount = Math.max(1, n); });
    const particle_count = vi.fn(() => 2);
    return { update, vertices, frame_count, set_frame_count, particle_count };
  }

  it('解析黑神话 scene.json → 背景对象数(1) + 粒子 sim 数(1)，且装配到同一播放器', () => {
    const canvas = document.createElement('canvas');
    const renderer = createMockRenderer();
    const sim = makeMockSim();
    const createParticleSim = vi.fn(() => sim);
    const assets = {
      renderer: renderer as unknown as THREE.WebGLRenderer,
      backgroundTextures: new Map([[13, new THREE.DataTexture(new Uint8Array(4), 2, 2)]]),
      particles: new Map([[71, { specJson: '{}', tex: new THREE.DataTexture(new Uint8Array(4), 512, 128), blend: 'additive' as const, softness: 0.3 }]]),
      createParticleSim,
    };
    const result = loadSceneToThree(BLACKMYTH_SCENE, assets, canvas);
    expect(result.player).toBeInstanceOf(ThreeScenePlayer);
    expect(result.backgroundIds).toHaveLength(1);
    expect(result.sims).toHaveLength(1);
    expect(result.particleLayers).toHaveLength(1);
    expect(result.sims[0]).toBe(sim);
    // 粒子对象：new CpuParticleSim(json, origin, sceneW, sceneH)——origin 为 WE 场景坐标（顶部偏左）。
    expect(createParticleSim).toHaveBeenCalledTimes(1);
    const call = createParticleSim.mock.calls[0];
    expect(call[0]).toBe('{}');
    expect(call[1][0]).toBeCloseTo(2306.34155, 5);
    expect(call[1][1]).toBeCloseTo(419.76611, 5);
    expect(call[2]).toBe(3840);
    expect(call[3]).toBe(2160);
    // 第 5 参 = 该对象 instanceoverride 的原始 JSON；此对象没有 override → 空串（= 不覆盖）。
    expect(call[4]).toBe('');
    // 背景对象：addBackground 参数 source 为 scene.json 的 image 对象调制/尺寸。
    const bgMesh = result.player.scene.children[0] as THREE.Mesh;
    expect(bgMesh.material).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect(bgMesh.position.x).toBeCloseTo(0, 6); // origin 1920 - 3840/2
    expect(bgMesh.position.y).toBeCloseTo(0, 6); // origin 1080 - 2160/2
  });

  // 对象级 instanceoverride：`LoadedParticleAssets.overrideJson`（原始 JSON 文本）必须原样
  // 作为**第 5 参**交给模拟器工厂 → wasm `CpuParticleSim.new(...)`（Rust 按官方
  // OverrideSpawnProgram 语义应用 alpha/size/lifetime/speed/color × emitter rate）。
  // 回归背景（GTR 3743126786）：烟柱的 `{alpha: 0.03, size: 2.09}` 此前无处可传 → 粒子以
  // 材质 alpha（实测均值 0.797）渲染 = 贯穿全屏的竖直白烟串。
  it('粒子对象的 overrideJson → 工厂第 5 参（空串 = 无覆盖）', () => {
    const canvas = document.createElement('canvas');
    const sim = makeMockSim();
    const createParticleSim = vi.fn(() => sim);
    const overrideJson = JSON.stringify({ alpha: 0.029999999, id: 23, size: 2.0899999 });
    const scene = JSON.stringify({
      general: { orthogonalprojection: { height: 4147, width: 7430 } },
      objects: [
        {
          id: 22, name: 'Струя дыма', particle: 'particles/presets/smoke2.json',
          origin: '5101.16553 1089.44336 0.00000', scale: '2.89780 2.89780 2.89780',
        },
        {
          id: 67, name: 'Падающая звезда', particle: 'particles/presets/shootingstar.json',
          origin: '1107.52405 3202.11768 0.00000', scale: '2.71680 2.71680 2.71680',
        },
      ],
    });
    const assets = {
      renderer: createMockRenderer() as unknown as THREE.WebGLRenderer,
      particles: new Map([
        [22, { specJson: '{}', blend: 'alpha' as const, overrideJson }],
        [67, { specJson: '{}', blend: 'alpha' as const }],
      ]),
      createParticleSim,
    };
    loadSceneToThree(scene, assets, canvas);
    expect(createParticleSim).toHaveBeenCalledTimes(2);
    const withOverride = createParticleSim.mock.calls.find((c) => c[0] === '{}' && c[4] === overrideJson);
    expect(withOverride, '带 override 的对象应把 JSON 作为第 5 参').toBeTruthy();
    // 无 override 的对象 → 空串（不是 undefined，wasm 侧按「空串 = 无覆盖」解析）。
    const without = createParticleSim.mock.calls.filter((c) => c[4] === '');
    expect(without).toHaveLength(1);
  });

  // 对象 `angles`（WE 弧度欧拉角）此前**完全未应用** —— 粒子只在 scale 后的局部空间里运动，
  // 位置/发射点都没经过对象旋转。回归背景（GTR 3743126786）：烟柱 `angles.z = -1.20063`
  // 把局部 +Y（湍流的 forward）转到世界 (0.932, 0.362) = 向右偏上，正是桌面端的表现；
  // 丢掉旋转后烟直着向上 = 用户报的「方向不对」。
  it('对象 angles → 背景 mesh.rotation + 粒子 objAngles uniform', () => {
    const canvas = document.createElement('canvas');
    const sim = makeMockSim();
    const createParticleSim = vi.fn(() => sim);
    const scene = JSON.stringify({
      general: { orthogonalprojection: { height: 2160, width: 3840 } },
      objects: [
        {
          id: 13, image: 'models/a.json',
          origin: '1920.00000 1080.00000 0.00000', scale: '1.00000 1.00000 1.00000',
          size: '3840.00000 2160.00000', angles: '0.00000 0.00000 0.50000',
        },
        {
          id: 22, name: 'Струя дыма', particle: 'particles/presets/smoke2.json',
          origin: '5101.16553 1089.44336 0.00000', scale: '2.89780 2.89780 2.89780',
          angles: '-0.00000 -0.00000 -1.20063',
        },
      ],
    });
    const assets = {
      renderer: createMockRenderer() as unknown as THREE.WebGLRenderer,
      backgroundTextures: new Map([[13, new THREE.DataTexture(new Uint8Array(4), 2, 2)]]),
      particles: new Map([[22, { specJson: '{}', blend: 'alpha' as const }]]),
      createParticleSim,
    };
    const result = loadSceneToThree(scene, assets, canvas);

    // 背景：addBackground 的 T·R·S → mesh.rotation 承载对象 angles（three 的欧拉单位=弧度）。
    const bg = result.player.scene.children.find((c) => (c as THREE.Mesh).renderOrder === 0) as THREE.Mesh;
    expect(bg.rotation.z).toBeCloseTo(0.5, 6);
    // 粒子：objAngles uniform 收到同一份对象 angles。
    const part = result.player.scene.children.find((c) => (c as THREE.Mesh).renderOrder === 1) as THREE.Mesh;
    const uniforms = (part.material as THREE.ShaderMaterial).uniforms;
    expect(uniforms.objAngles.value.z).toBeCloseTo(-1.20063, 5);
  });

  // `colorBlendMode`（WE 图像颜色混合模式）→ 背景对象的 three 混合设置。
  // WE 语义（`shaders/common_blending.h::ApplyBlending`，由 genericimage3.frag 调用）：
  //   gl_FragColor.rgb = ApplyBlending(BLENDMODE, screen.rgb, 自己的颜色, 自己的 alpha)
  //   其中 screen = 当前帧缓冲（已渲染的背景）。
  // 回归背景（GTR 3743126786）：Clouds Back 的 `colorBlendMode: 7`（Screen）本应让
  // 黑底（BlendScreen(A,0) = A）完全不改变背景；未实现时黑底被普通 alpha 混合盖住
  // → 屏幕左上角一块黑色（clouds.tex 实测 78% 是纯黑）。
  it('图像 colorBlendMode → 背景用 CustomBlending 复刻 WE ApplyBlending', () => {
    const canvas = document.createElement('canvas');
    const scene = JSON.stringify({
      general: { orthogonalprojection: { height: 4147, width: 7430 } },
      objects: [
        { id: 17, name: 'bg', image: 'models/bg.json', origin: '3715 2073.5 0', size: '7430 4147' },
        {
          id: 246, name: 'Clouds Back', image: 'models/clouds.json',
          origin: '2465.74438 3493.03442 0.00000', scale: '2.60562 1.70045 1.54228',
          size: '1920 1080', alpha: 0.5, colorBlendMode: 7,
        },
        { id: 300, name: 'additive-ish', image: 'models/x.json', origin: '100 100 0', size: '100 100', colorBlendMode: 31 },
        { id: 301, name: 'lighten-ish', image: 'models/y.json', origin: '200 200 0', size: '100 100', colorBlendMode: 6 },
      ],
    });
    const tex = () => new THREE.DataTexture(new Uint8Array(4), 2, 2);
    const assets = {
      renderer: createMockRenderer() as unknown as THREE.WebGLRenderer,
      backgroundTextures: new Map([[17, tex()], [246, tex()], [300, tex()], [301, tex()]]),
    };
    const result = loadSceneToThree(scene, assets, canvas);
    const meshes = result.player.scene.children.filter((c) => (c as THREE.Mesh).renderOrder === 0) as THREE.Mesh[];
    expect(meshes).toHaveLength(4);

    // 缺省（mode=0）：保持既有普通 alpha 混合
    expect(meshes[0].material.blending).toBe(THREE.NormalBlending);

    // 7 = Screen：src=op×B 预乘，混合 (1−dst, 1) → A + op·B − op·A·B（= WE 的 mix(A, Screen(A,B), op)）
    const screen = meshes[1].material as THREE.ShaderMaterial;
    expect(screen.blending).toBe(THREE.CustomBlending);
    expect(screen.blendEquation).toBe(THREE.AddEquation);
    expect(screen.blendSrc).toBe(THREE.OneMinusDstColorFactor);
    expect(screen.blendDst).toBe(THREE.OneFactor);
    // alpha 按 WE 保留背景的（`gl_FragColor.a = screen.a`）
    expect(screen.blendSrcAlpha).toBe(THREE.ZeroFactor);
    expect(screen.blendDstAlpha).toBe(THREE.OneFactor);
    // 片元是**预乘**输出（rgb × 自身 alpha），否则 CustomBlending 拿不到 op 因子
    expect(screen.fragmentShader).toContain('gl_FragColor = vec4(c.rgb * tint * a, a)');

    // 31 = A + B·op → (1, 1) 加算
    expect((meshes[2].material as THREE.ShaderMaterial).blendSrc).toBe(THREE.OneFactor);
    expect((meshes[2].material as THREE.ShaderMaterial).blendDst).toBe(THREE.OneFactor);

    // 6 = Lighten → max(A, B)（op≈1）
    expect((meshes[3].material as THREE.ShaderMaterial).blendEquation).toBe(THREE.MaxEquation);
  });

  it('未实现的 colorBlendMode → 回退普通 alpha 混合（不静默画错）', () => {
    const canvas = document.createElement('canvas');
    const scene = JSON.stringify({
      general: { orthogonalprojection: { height: 1080, width: 1920 } },
      objects: [{ id: 17, image: 'models/bg.json', origin: '960 540 0', size: '1920 1080', colorBlendMode: 99 }],
    });
    const assets = {
      renderer: createMockRenderer() as unknown as THREE.WebGLRenderer,
      backgroundTextures: new Map([[17, new THREE.DataTexture(new Uint8Array(4), 2, 2)]]),
    };
    const result = loadSceneToThree(scene, assets, canvas);
    const mesh = result.player.scene.children[0] as THREE.Mesh;
    expect(mesh.material.blending).toBe(THREE.NormalBlending);
  });

  it('无粒子 spec（无 particles/createParticleSim）→ 只背景，粒子对象被跳过', () => {    const canvas = document.createElement('canvas');
    const result = loadSceneToThree(BLACKMYTH_SCENE, { renderer: createMockRenderer() as unknown as THREE.WebGLRenderer, backgroundTextures: new Map([[13, new THREE.DataTexture(new Uint8Array(4), 2, 2)]]) }, canvas);
    expect(result.backgroundIds).toHaveLength(1);
    expect(result.sims).toHaveLength(0);
    expect(result.particleLayers).toHaveLength(0);
    // 场景无粒子图层 → scene.children 只含 1 个背景 mesh。
    expect(result.player.scene.children.length).toBe(1);
  });

  it('frameCount 对齐：textureFrameCount(256×256)→1，sim.set_frame_count(1)，opts.frameCount==sim.frame_count()',
    () => {
      const canvas = document.createElement('canvas');
      const sim = makeMockSim(4); // sim 缺省 4 帧（DEFAULT_FRAME_COUNT），纹理单帧 → 需覆写为 1
      const createParticleSim = vi.fn(() => sim);
      const assets = {
        renderer: createMockRenderer() as unknown as THREE.WebGLRenderer,
        backgroundTextures: new Map([[13, new THREE.DataTexture(new Uint8Array(4), 2, 2)]]),
        particles: new Map([[71, { specJson: '{}', tex: new THREE.DataTexture(new Uint8Array(4), 256, 256), blend: 'alpha' as const }]]),
        createParticleSim,
      };
      const result = loadSceneToThree(BLACKMYTH_SCENE, assets, canvas);
      expect(sim.set_frame_count).toHaveBeenCalledWith(1);
      expect(sim.frame_count()).toBe(1);
      // 粒子图层 ShaderMaterial 的 frameCount uniform == sim.frame_count()（多帧切片与 sim 帧号对齐）。
      const mesh = result.player.scene.children.find(
        (c) => (c as THREE.Mesh).material instanceof THREE.ShaderMaterial,
      ) as THREE.Mesh;
      const mat = mesh.material as THREE.ShaderMaterial;
      expect(mat.uniforms.frameCount.value).toBe(1);
      expect(mat.uniforms.frameCount.value).toBe(sim.frame_count());
    });

  it('loadSceneToThree：对象 scale / emitter 原点接线到粒子 material（WE model matrix 语义）', () => {
    const canvas = document.createElement('canvas');
    const sim = makeMockSim();
    const assets = {
      renderer: createMockRenderer() as unknown as THREE.WebGLRenderer,
      backgroundTextures: new Map([[13, new THREE.DataTexture(new Uint8Array(4), 2, 2)]]),
      particles: new Map([[71, {
        specJson: '{"emitter":[{"origin":"350 750 0","rate":20}],"maxcount":50}',
        tex: undefined,
        blend: 'additive' as const,
      }]]),
      createParticleSim: vi.fn(() => sim),
    };
    const result = loadSceneToThree(BLACKMYTH_SCENE, assets, canvas);
    const mesh = result.player.scene.children.find(
      (c) => (c as THREE.Mesh).material instanceof THREE.ShaderMaterial,
    ) as THREE.Mesh;
    const u = (mesh.material as THREE.ShaderMaterial).uniforms;
    // 对象中心 = we_to_three(scene.json origin, 3840, 2160)（y 不翻）。
    expect((u.objCenter.value as THREE.Vector3).x).toBeCloseTo(2306.34155 - 1920, 4);
    expect((u.objCenter.value as THREE.Vector3).y).toBeCloseTo(419.76611 - 1080, 4);
    // 对象 scale 直传（可为负 = 镜像；DK 的 Ice 层 scale≈(0.29,0.15) 靠它把辉光斑缩回小冰晶）。
    expect((u.objScale.value as THREE.Vector3).toArray()).toEqual([-2.05166, 2.1167, 1]);
    // emitter 局部原点（spec 原值）+ 模拟器已加进 particlePosition 的偏移（黑神话 scale ⊙ origin）。
    expect((u.emitterOrigin.value as THREE.Vector3).toArray()).toEqual([350, 750, 0]);
    expect((u.bmOffset.value as THREE.Vector3).x).toBeCloseTo(350 * -2.05166, 4);
    expect((u.bmOffset.value as THREE.Vector3).y).toBeCloseTo(750 * 2.1167, 4);
  });

  it('loadSceneToThree：实例容量取自 spec 的 maxcount（three 首帧锁存，必须一次给足）', () => {
    // 黑神话 leaves5 的真实 spec：rate=20、maxcount=50。容量必须 = 50（而非建层当帧的粒子数）。
    const canvas = document.createElement('canvas');
    const sim = makeMockSim();
    const assets = {
      renderer: createMockRenderer() as unknown as THREE.WebGLRenderer,
      backgroundTextures: new Map([[13, new THREE.DataTexture(new Uint8Array(4), 2, 2)]]),
      particles: new Map([[71, {
        specJson: JSON.stringify({ maxcount: 50, emitter: [{ name: 'sphererandom', rate: 20 }] }),
        tex: new THREE.DataTexture(new Uint8Array(4), 512, 128),
        blend: 'alpha' as const,
      }]]),
      createParticleSim: vi.fn(() => sim),
    };
    const result = loadSceneToThree(BLACKMYTH_SCENE, assets, canvas);
    const mesh = result.player.scene.children.find(
      (c) => (c as THREE.Mesh).material instanceof THREE.ShaderMaterial,
    ) as THREE.Mesh;
    const geom = mesh.geometry as THREE.InstancedBufferGeometry;
    const pos = geom.getAttribute('particlePosition') as THREE.InstancedBufferAttribute;
    expect(pos.count).toBe(50); // ← 旧实现 = mock sim 当前粒子数（2）
    // mock sim 当前 2 个粒子 → 本帧画 2 个实例（draw = min(instanceCount, 锁存容量)）。
    expect(geom.instanceCount).toBe(2);
  });

  it('specMaxcount / particleCapacity：解析 spec.maxcount（含字符串）、缺省与上限兜底', () => {
    expect(specMaxcount('{"maxcount":50}')).toBe(50);
    expect(specMaxcount('{"maxcount":"50"}')).toBe(50); // WE JSON 亦有字符串写法
    expect(specMaxcount('{}')).toBe(0);
    expect(specMaxcount('not json')).toBe(0);
    // 声明值优先；未声明 → DEFAULT；不可超 MAX_PARTICLE_CAPACITY。
    expect(particleCapacity(50, 0)).toBe(50);
    expect(particleCapacity(0, 0)).toBe(DEFAULT_PARTICLE_CAPACITY);
    expect(particleCapacity(0, 3000)).toBe(3000);
    expect(particleCapacity(99999, 0)).toBe(MAX_PARTICLE_CAPACITY);
    expect(particleCapacity(2, 5)).toBe(5); // 容量不得小于建层当帧已有粒子数
  });

  it('frameCountFromDims / textureFrameCount 对齐 wasm frame_count_from_dims', () => {
    expect(frameCountFromDims(512, 128)).toBe(4); // rosepetals 512×128 → 4
    expect(frameCountFromDims(256, 256)).toBe(1); // 单帧
    expect(frameCountFromDims(200, 100)).toBe(2);
    expect(textureFrameCount(new THREE.DataTexture(new Uint8Array(4), 512, 128))).toBe(4);
    expect(textureFrameCount(new THREE.DataTexture(new Uint8Array(4), 256, 256))).toBe(1);
    expect(textureFrameCount(undefined)).toBe(1);
  });

  it('textureFrameCount / textureFrameGrid 优先用精灵表元数据（DK fire1/fog1 = 8×8=64 帧）', () => {
    // 关键：1024×1024 的 8×8 精灵表按宽高推是「1 帧」→ 每个粒子会画出整张表的 64 格网格。
    const tex = new THREE.DataTexture(new Uint8Array(4), 1024, 1024);
    tex.userData = { sprite: { frames: 64, cols: 8, rows: 8 } };
    expect(textureFrameCount(tex)).toBe(64);
    expect(textureFrameGrid(tex)).toEqual({ cols: 8, rows: 8 });
    // 非精灵表 → 回退按宽高推帧数 + 横向等分（cols=n, rows=1）。
    const plain = new THREE.DataTexture(new Uint8Array(4), 512, 128);
    expect(textureFrameCount(plain)).toBe(4);
    expect(textureFrameGrid(plain)).toEqual({ cols: 4, rows: 1 });
    // 非法元数据（缺 cols/rows 或非正）→ 忽略，回退旧语义。
    const bad = new THREE.DataTexture(new Uint8Array(4), 256, 256);
    bad.userData = { sprite: { frames: 0, cols: 0, rows: 0 } };
    expect(textureFrameCount(bad)).toBe(1);
    expect(textureFrameGrid(bad)).toEqual({ cols: 1, rows: 1 });
  });

  it('specEmitterOrigin / simEmitterOffset：解析 emitter[0].origin 并算黑神话偏移', () => {
    expect(specEmitterOrigin('{"emitter":[{"origin":"150 550 0"}]}')).toEqual([150, 550, 0]);
    expect(specEmitterOrigin('{"emitter":[{"rate":200}]}')).toEqual([0, 0, 0]);
    expect(specEmitterOrigin('{"emitter":[]}')).toEqual([0, 0, 0]);
    expect(specEmitterOrigin('{"emitter":[{"origin":"1 2"}]}')).toEqual([0, 0, 0]); // 分量不足
    expect(specEmitterOrigin('not json')).toEqual([0, 0, 0]);
    // 模拟器只对**第一个** emitter 的 origin 乘黑神话 scale，故偏移也只看第一个。
    expect(specEmitterOrigin('{"emitter":[{"origin":"10 20 0"},{"origin":"99 99 0"}]}')).toEqual([10, 20, 0]);
    expect(simEmitterOffset([150, 550, 0])).toEqual([
      150 * BLACKMYTH_OBJ_SCALE[0], 550 * BLACKMYTH_OBJ_SCALE[1], 0,
    ]);
    expect(simEmitterOffset([0, 0, 0]).map((v) => v + 0)).toEqual([0, 0, 0]);
  });

  it('播放帧：先 sim.update(dt) 再 player.updateParticles(dt)（getter 读已推进顶点，粒子不停留）', () => {
    const canvas = document.createElement('canvas');
    const renderer = createMockRenderer();
    const log: string[] = [];
    const sim = makeMockSim(4, log);
    const assets = {
      renderer: renderer as unknown as THREE.WebGLRenderer,
      backgroundTextures: new Map([[13, new THREE.DataTexture(new Uint8Array(4), 2, 2)]]),
      particles: new Map([[71, { specJson: '{}', tex: new THREE.DataTexture(new Uint8Array(4), 512, 128), blend: 'additive' as const }]]),
      createParticleSim: vi.fn(() => sim),
    };
    const result = loadSceneToThree(BLACKMYTH_SCENE, assets, canvas);
    // loadSceneToThree 已通过 player.setAnimationLoop 接线：getter 持有方推进 sim。
    const loop = renderer._getLoop();
    expect(loop).toBeTypeOf('function');
    // addParticle 首帧填一次顶点（log=[vertices]）；跑一帧：fn(dt)→sim.update(dt)，再 updateParticles→getter→vertices。
    expect(sim.vertices).toHaveBeenCalledTimes(1);
    loop!();
    expect(sim.update).toHaveBeenCalledTimes(1);
    // 帧内 updateParticles 读 getter 一次 → vertices 共 2 次；且顺序为 update 先、vertices 后。
    expect(sim.vertices).toHaveBeenCalledTimes(2);
    expect(log.slice(-2)).toEqual(['update', 'vertices']);
    // dt 为 0..0.1 秒（setAnimationLoop 帧差分 clamp），非 0 保证粒子持续推进。
    const dtArg = sim.update.mock.calls[0][0] as number;
    expect(dtArg).toBeGreaterThanOrEqual(0);
    expect(dtArg).toBeLessThanOrEqual(0.1);
    expect(result.player.scene.children.length).toBe(2); // 1 背景 + 1 粒子图层
  });

  // Task 5：cover 相机必须按**窗口/视口宽度比**推（而非场景尺寸）——窗口比例 ≠ 场景比例时背景
  // cover 裁切（不拉伸），对照 wasm 路径用 window.innerWidth/Height 推 cover。
  // EVA 场景 2400×1555（≈1.54）放 16:9 窗口（1.778）→ viewAspect > sceneAspect → 宽度铺满、垂直裁剪。
  const EVA_SCENE = JSON.stringify({
    general: { orthogonalprojection: { width: 2400, height: 1555 } },
    objects: [],
  });

  it('loadSceneToThree 传 viewport=窗口尺寸 → cover 按窗口宽高比裁剪（场景更窄 → 垂直裁到 1350）', () => {
    const canvas = document.createElement('canvas');
    const renderer = createMockRenderer();
    const result = loadSceneToThree(
      EVA_SCENE,
      { renderer: renderer as unknown as THREE.WebGLRenderer },
      canvas,
      { width: 1920, height: 1080 },
    );
    // viewAspect 1.7778 > sceneAspect 1.5434 → cover: w=2400, h=2400/(1920/1080)=1350。
    expect(result.player.camera.left).toBe(-1200);
    expect(result.player.camera.right).toBe(1200);
    expect(result.player.camera.top).toBeCloseTo(1350 / 2, 6);
    expect(result.player.camera.bottom).toBeCloseTo(-1350 / 2, 6);
    // resize 用真实窗口尺寸（1920×1080），而非场景尺寸（2400×1555）→ setSize 收到窗口尺寸。
    expect(renderer.setSize).toHaveBeenCalledWith(1920, 1080, false);
  });

  it('loadSceneToThree 不传 viewport → 缺省视口=场景尺寸 → cover 无裁剪（向后兼容）', () => {
    const canvas = document.createElement('canvas');
    const renderer = createMockRenderer();
    const result = loadSceneToThree(
      EVA_SCENE,
      { renderer: renderer as unknown as THREE.WebGLRenderer },
      canvas,
    );
    // 视口=场景 2400×1555 → viewAspect==sceneAspect → cover == 场景尺寸（无裁剪）。
    expect(result.player.camera.left).toBe(-1200);
    expect(result.player.camera.right).toBe(1200);
    expect(result.player.camera.top).toBeCloseTo(1555 / 2, 6);
    expect(result.player.camera.bottom).toBeCloseTo(-1555 / 2, 6);
    expect(renderer.setSize).toHaveBeenCalledWith(2400, 1555, false);
  });
});
