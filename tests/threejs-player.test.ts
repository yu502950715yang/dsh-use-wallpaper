// @vitest-environment jsdom
// Task 1：three.js 场景骨架。WebGLRenderer 无法在 node/jsdom（无 WebGL）环境构造，
// 测试按契约「可 mock renderer」注入 mock（真实 Scene/Camera/cover 数值仍可验证）。
// 聚焦：构造后 scene/camera/renderer 存在；resize 更新 cover；update+render 不抛错；
// 正交相机 cover 尺寸正确（复用 scene-renderer.coverRange 语义）。

import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { ThreeScenePlayer, loadSceneToThree, frameCountFromDims, textureFrameCount } from '../src/client/threejs-player.js';
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

  it('缺省 cover：视口 == 场景尺寸 → 相机视锥 == 场景尺寸（1920×1080，无裁剪）', () => {
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

    // 5 个 per-particle instanced 属性（position/size/uv/color/alpha），长度 = 粒子数×itemSize。
    const pos = geom.getAttribute('particlePosition') as THREE.InstancedBufferAttribute;
    const size = geom.getAttribute('particleSize') as THREE.InstancedBufferAttribute;
    const uv = geom.getAttribute('particleUv') as THREE.InstancedBufferAttribute;
    const color = geom.getAttribute('particleColor') as THREE.InstancedBufferAttribute;
    const alpha = geom.getAttribute('particleAlpha') as THREE.InstancedBufferAttribute;
    expect(pos.count).toBe(2);
    expect((pos.array as Float32Array).length).toBe(2 * 3);
    expect((size.array as Float32Array).length).toBe(2);
    expect((uv.array as Float32Array).length).toBe(2 * 2);
    expect((color.array as Float32Array).length).toBe(2 * 3);
    expect((alpha.array as Float32Array).length).toBe(2);

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

  it('addParticle：blend 模式（additive/alpha）设到 material，transparent 恒置位', () => {
    const { player } = makePlayer(1920, 1080);
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
    // 背景对象：addBackground 参数 source 为 scene.json 的 image 对象调制/尺寸。
    const bgMesh = result.player.scene.children[0] as THREE.Mesh;
    expect(bgMesh.material).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect(bgMesh.position.x).toBeCloseTo(0, 6); // origin 1920 - 3840/2
    expect(bgMesh.position.y).toBeCloseTo(0, 6); // origin 1080 - 2160/2
  });

  it('无粒子 spec（无 particles/createParticleSim）→ 只背景，粒子对象被跳过', () => {
    const canvas = document.createElement('canvas');
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

  it('frameCountFromDims / textureFrameCount 对齐 wasm frame_count_from_dims', () => {
    expect(frameCountFromDims(512, 128)).toBe(4); // rosepetals 512×128 → 4
    expect(frameCountFromDims(256, 256)).toBe(1); // 单帧
    expect(frameCountFromDims(200, 100)).toBe(2);
    expect(textureFrameCount(new THREE.DataTexture(new Uint8Array(4), 512, 128))).toBe(4);
    expect(textureFrameCount(new THREE.DataTexture(new Uint8Array(4), 256, 256))).toBe(1);
    expect(textureFrameCount(undefined)).toBe(1);
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
