// @vitest-environment jsdom
// Task 1：three.js 场景骨架。WebGLRenderer 无法在 node/jsdom（无 WebGL）环境构造，
// 测试按契约「可 mock renderer」注入 mock（真实 Scene/Camera/cover 数值仍可验证）。
// 聚焦：构造后 scene/camera/renderer 存在；resize 更新 cover；update+render 不抛错；
// 正交相机 cover 尺寸正确（复用 scene-renderer.coverRange 语义）。

import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { ThreeScenePlayer, loadSceneToThree, resolvePixelRatio, frameCountFromDims, textureFrameCount, textureFrameGrid, specMaxcount, particleCapacity, specEmitterOrigin, simEmitterOffset, BLACKMYTH_OBJ_SCALE, DEFAULT_PARTICLE_CAPACITY, MAX_PARTICLE_CAPACITY } from '../src/client/threejs-player.js';
import { textLayerOffset, type TextLayout } from '../src/client/text-object.js';
import { coverRange } from '../src/client/scene-renderer.js';
import { createCompositeGeometry, screenScalePx } from '../src/client/object-range.js';

// 注入的 mock renderer：只测相机/场景/RAF 逻辑，不触碰 WebGL。
function createMockRenderer() {
  let loop: (() => void) | null = null;
  const setAnimationLoop = vi.fn((fn: (() => void) | null) => {
    loop = fn;
  });
  // 清屏 alpha 与渲染目标都要记录：渲染到 RT 时必须清成透明黑（见 AGENT.md §5.22）。
  let clearAlpha = 1;
  let currentTarget: unknown = null;
  const renders: Array<{ scene: unknown; target: unknown; clearAlpha: number }> = [];
  const renderer = {
    setSize: vi.fn(),
    setPixelRatio: vi.fn(),
    render: vi.fn((scene: unknown) => { renders.push({ scene, target: currentTarget, clearAlpha }); }),
    // 对象隔离渲染（Task 3）：renderIsolatedContents 会切换渲染目标到对象 RT，
    // mock 需提供同名方法（no-op），否则隔离路径全部以 TypeError 失败。
    setRenderTarget: vi.fn((t: unknown = null) => { currentTarget = t; }),
    getClearAlpha: vi.fn(() => clearAlpha),
    setClearAlpha: vi.fn((v: number) => { clearAlpha = v; }),
    dispose: vi.fn(),
    setAnimationLoop,
    _getLoop: () => loop,
    _renders: renders,
    _clearAlpha: () => clearAlpha,
  };
  return renderer;
}

function makePlayer(w = 1920, h = 1080, mock = createMockRenderer()) {
  const canvas = document.createElement('canvas');
  const player = new ThreeScenePlayer(canvas, w, h, mock as unknown as THREE.WebGLRenderer);
  return { player, mock };
}

// text 对象（2026-09-21）：与 image 同路径渲染成背景 quad；clock 由 driver 每帧判断文本变化，
// 变了才重绘 canvas 并置 texture.needsUpdate（同分钟不重绘，省开销）。
describe('loadSceneToThree text 对象', () => {
  const scene = JSON.stringify({
    camera: { center: '0 0 0', eye: '0 0 1', up: '0 1 0' },
    general: { orthogonalprojection: { width: 1920, height: 1080 } },
    objects: [
      { id: 7, name: 'Clock', origin: '960 540 0', scale: '1 1 1', size: '400 100', text: { value: '12:34' } },
    ],
  });
  const makeTextAssets = (layer?: {
    texture: THREE.Texture;
    driver?: { update(now: Date): boolean; readonly layout: TextLayout };
    size?: [number, number];
    anchorOffset?: [number, number];
  }) => ({
    renderer: createMockRenderer() as unknown as THREE.WebGLRenderer,
    textLayers: new Map(layer ? [[7, layer]] : []),
  });

  it('textLayers 提供纹理 → 渲染为背景 quad 并计入 backgroundIds', () => {
    const tex = new THREE.DataTexture(new Uint8Array(4), 2, 2);
    const result = loadSceneToThree(scene, makeTextAssets({ texture: tex }), document.createElement('canvas'));
    expect(result.backgroundIds).toHaveLength(1);
  });

  // 文本图层尺寸 = 装配期实测的 canvas（= 文本 + 2×padding），世界尺寸 = canvas × scale；
  // 位置 = origin + 锚点偏移（halign/valign 决定 origin 落在文本框哪条边）。
  it('textLayers 的 size/anchorOffset → quad 几何尺寸与位置', () => {
    const tex = new THREE.DataTexture(new Uint8Array(4), 2, 2);
    const result = loadSceneToThree(
      scene,
      makeTextAssets({ texture: tex, size: [600, 200], anchorOffset: [15, -5] }),
      document.createElement('canvas'),
    );
    const mesh = result.player.scene.children[0] as THREE.Mesh;
    const geo = mesh.geometry as THREE.PlaneGeometry;
    expect(geo.parameters.width).toBe(600);
    expect(geo.parameters.height).toBe(200);
    // origin 960 540 - 场景中心 (960, 540) + 锚点偏移
    expect(mesh.position.toArray()).toEqual([15, -5, 0]);
  });

  it('textLayers 无该对象条目 → 跳过（visible=false 由调用方过滤，player 不兜底）', () => {
    const result = loadSceneToThree(scene, makeTextAssets(), document.createElement('canvas'));
    expect(result.backgroundIds).toHaveLength(0);
  });

  it('帧循环驱动 clock：driver 返回 true 时置 texture.needsUpdate（version 递增）', () => {
    const tex = new THREE.DataTexture(new Uint8Array(4), 2, 2);
    const driver = { update: vi.fn(() => true), layout: { width: 400, height: 100, textWidth: 400, textHeight: 100 } };
    const assets = makeTextAssets({ texture: tex, driver });
    loadSceneToThree(scene, assets, document.createElement('canvas'));
    const before = tex.version;
    (assets.renderer as unknown as { _getLoop: () => (() => void) | null })._getLoop()!();
    expect(driver.update).toHaveBeenCalledTimes(1);
    expect(tex.version).toBeGreaterThan(before);
  });

  it('driver 返回 false（同一分钟）时不动纹理', () => {
    const tex = new THREE.DataTexture(new Uint8Array(4), 2, 2);
    const driver = { update: vi.fn(() => false), layout: { width: 400, height: 100, textWidth: 400, textHeight: 100 } };
    const assets = makeTextAssets({ texture: tex, driver });
    loadSceneToThree(scene, assets, document.createElement('canvas'));
    const before = tex.version;
    (assets.renderer as unknown as { _getLoop: () => (() => void) | null })._getLoop()!();
    expect(tex.version).toBe(before);
  });
});

// 文本变化 → 帧循环必须按 driver.layout 同步 quad 的几何尺寸与中心（对齐 OME
// update_text_layout：SetSize(text+2×padding) + apply_text_anchor）。否则新文本超出旧画布
// 被裁切（2980088441 minute 层），或整体漂移。
describe('loadSceneToThree text 动态 resize', () => {
  const scene = JSON.stringify({
    camera: { center: '0 0 0', eye: '0 0 1', up: '0 1 0' },
    general: { orthogonalprojection: { width: 1920, height: 1080 } },
    objects: [
      {
        id: 7, name: 'ClockMinute', origin: '1000 500 0', scale: '0.5 0.5 1', size: '400 100',
        horizontalalign: 'left', verticalalign: 'bottom', text: { value: '12' },
      },
    ],
  });
  const SCALE = [0.5, 0.5, 1];
  // padding 20（画布 = 文本 + 40），两版高度不变、只有文本宽变长/变短
  const SMALL: TextLayout = { textWidth: 160, textHeight: 100, width: 200, height: 140 };
  const LARGE: TextLayout = { textWidth: 360, textHeight: 100, width: 400, height: 140 };

  function makeAssets(texIn?: THREE.Texture) {
    const tex = texIn ?? new THREE.DataTexture(new Uint8Array(4), 2, 2);
    const state = { changed: false, layout: SMALL as TextLayout };
    const driver = { update: vi.fn(() => state.changed), get layout() { return state.layout; } };
    const renderer = createMockRenderer();
    return {
      state, driver, tex, renderer,
      assets: {
        renderer: renderer as unknown as THREE.WebGLRenderer,
        textLayers: new Map([[7, {
          texture: tex,
          driver,
          size: [SMALL.width, SMALL.height] as [number, number],
          anchorOffset: textLayerOffset(SMALL, 'left', 'bottom', undefined, SCALE),
        }]]),
      },
    };
  }

  it('文本变长：quad 几何放大、锚点边（left/bottom）在世界里不动 ⇒ 原地生长', () => {
    const { assets, state, renderer, tex } = makeAssets();
    const result = loadSceneToThree(scene, assets, document.createElement('canvas'));
    const mesh = result.player.scene.children[0] as THREE.Mesh;
    // 装配期：几何 = 实测画布 200；中心 = origin + 锚点偏移 - 场景中心
    expect((mesh.geometry as THREE.PlaneGeometry).parameters.width).toBe(200);
    expect(mesh.position.x).toBeCloseTo(1000 + 160 / 2 * 0.5 - 960, 10);  // +40 → 80
    expect(mesh.position.y).toBeCloseTo(500 + 100 / 2 * 0.5 - 540, 10);   // +25 → -15
    // 文本左缘 / 下缘（halign left + valign bottom 的锚点边）= origin - padding×scale
    const leftEdge0 = mesh.position.x - (200 / 2) * 0.5;
    const bottomEdge0 = mesh.position.y - (140 / 2) * 0.5;

    state.layout = LARGE;
    state.changed = true;
    const beforeVersion = tex.version;
    renderer._getLoop()!();

    expect(tex.version).toBeGreaterThan(beforeVersion);                    // 纹理已重传
    expect((mesh.geometry as THREE.PlaneGeometry).parameters.width).toBe(400);
    expect(mesh.position.x).toBeCloseTo(1000 + 360 / 2 * 0.5 - 960, 10);  // +90 → 130
    expect(mesh.position.x - (400 / 2) * 0.5).toBeCloseTo(leftEdge0, 10);  // 左缘不动
    expect(mesh.position.y - (140 / 2) * 0.5).toBeCloseTo(bottomEdge0, 10); // 下缘不动
  });

  it('文本变短：quad 几何缩小（同一锚点公式）', () => {
    const { assets, state, renderer } = makeAssets();
    state.layout = LARGE;
    assets.textLayers.get(7)!.size = [LARGE.width, LARGE.height];
    assets.textLayers.get(7)!.anchorOffset = textLayerOffset(LARGE, 'left', 'bottom', undefined, SCALE);
    const result = loadSceneToThree(scene, assets, document.createElement('canvas'));
    const mesh = result.player.scene.children[0] as THREE.Mesh;
    expect((mesh.geometry as THREE.PlaneGeometry).parameters.width).toBe(400);
    const leftEdge0 = mesh.position.x - (400 / 2) * 0.5;

    state.layout = SMALL;
    state.changed = true;
    renderer._getLoop()!();

    expect((mesh.geometry as THREE.PlaneGeometry).parameters.width).toBe(200);
    expect(mesh.position.x).toBeCloseTo(1000 + 160 / 2 * 0.5 - 960, 10);
    expect(mesh.position.x - (200 / 2) * 0.5).toBeCloseTo(leftEdge0, 10);
  });

  it('resizeBackground：未知 id / 尺寸未变 → no-op；新尺寸 → 换几何并释放旧几何', () => {
    const { player } = makePlayer();
    const tex = new THREE.DataTexture(new Uint8Array(4), 2, 2);
    const id = player.addBackground({ origin: [0, 0, 0], size: [100, 50], scale: [1, 1, 1], texture: tex, sceneW: 1920, sceneH: 1080 });
    const mesh = player.scene.children[0] as THREE.Mesh;
    const geo0 = mesh.geometry;
    const disposeSpy = vi.spyOn(geo0, 'dispose');
    player.resizeBackground(999, [10, 10]);                 // 未知 id
    player.resizeBackground(id, [100, 50]);                 // 尺寸未变
    expect(mesh.geometry).toBe(geo0);
    expect(disposeSpy).not.toHaveBeenCalled();
    player.resizeBackground(id, [250, 50]);
    expect(mesh.geometry).not.toBe(geo0);
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect((mesh.geometry as THREE.PlaneGeometry).parameters.width).toBe(250);
  });

  // three r170 对 canvas 纹理在 WebGL2 走**不可变** texStorage2D（只在首次上传时分配存储），
  // 画布尺寸变了以后 texSubImage2D 越界 → 上传被 GL 静默丢弃，屏幕上仍是旧画布被拉伸。
  // ⇒ 尺寸变化必须 dispose 纹理，让下一次渲染按新尺寸重新分配存储（纯 needsUpdate 不够）。
  it('画布尺寸变化 → dispose 纹理（否则新画布上传失败，屏幕一直是旧内容被拉伸）', () => {
    const canvasTex = new THREE.CanvasTexture(document.createElement('canvas'));
    const { assets, state, renderer, tex } = makeAssets(canvasTex);
    expect(tex.isCanvasTexture).toBe(true);
    const disposeSpy = vi.spyOn(tex, 'dispose');
    loadSceneToThree(scene, assets, document.createElement('canvas'));
    renderer._getLoop()!();                                 // 文本未变 → 不 resize、不 dispose
    expect(disposeSpy).not.toHaveBeenCalled();
    state.layout = LARGE;
    state.changed = true;
    renderer._getLoop()!();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });
});

// 省电与画质档位（2026-09-21）：暂停门控 RAF + 渲染像素比 = 设备像素比 × 画质档位。
// 画质档位必须与 three-renderer 挂载期算屏幕密度用的是**同一个数**，否则对象 RT 尺寸口径
// 与画布缓冲不一致（AGENT.md §5.15/§5.21：曾因此整层锐度 −52%）。
describe('ThreeScenePlayer 暂停与画质档位', () => {
  it('resolvePixelRatio：设备像素比 × 档位，非法输入回退 1', () => {
    expect(resolvePixelRatio(2, 1)).toBe(2);
    expect(resolvePixelRatio(2, 0.5)).toBe(1);
    expect(resolvePixelRatio(1.5, 1.5)).toBeCloseTo(2.25, 10);
    expect(resolvePixelRatio(0, 1)).toBe(1);
    expect(resolvePixelRatio(Number.NaN, 1)).toBe(1);
    expect(resolvePixelRatio(2, 0)).toBe(2);
    expect(resolvePixelRatio(2, -1)).toBe(2);
  });

  it('构造接受画质档位：pixelRatio 与画布缓冲都按 dpr×档位', () => {
    const orig = (window as { devicePixelRatio?: number }).devicePixelRatio;
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
    const canvas = document.createElement('canvas');
    const mock = createMockRenderer();
    const player = new ThreeScenePlayer(canvas, 1920, 1080, mock as unknown as THREE.WebGLRenderer, 0.5);
    player.resize(1600, 900);
    expect(mock.setPixelRatio).toHaveBeenLastCalledWith(1);
    expect(canvas.width).toBe(1600);
    expect(canvas.height).toBe(900);
    Object.defineProperty(window, 'devicePixelRatio', { value: orig, configurable: true });
  });

  it('setQualityScale 走 resize 路径重推缓冲与屏幕密度（对象 RT 基准随之变化）', () => {
    const orig = (window as { devicePixelRatio?: number }).devicePixelRatio;
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
    const { player, mock } = makePlayer();
    player.resize(1600, 900);
    const before = player.screenScalePx();
    expect(player.canvas.width).toBe(3200);
    player.setQualityScale(0.5);
    expect(mock.setPixelRatio).toHaveBeenLastCalledWith(1);
    expect(player.canvas.width).toBe(1600);
    expect(player.canvas.height).toBe(900);
    // 屏幕密度 = 设备像素/世界单位，必须同步减半（否则对象 RT 仍按旧密度建 → 口径漂移）
    expect(player.screenScalePx()).toBeCloseTo(before / 2, 10);
    player.setQualityScale(1);
    expect(player.canvas.width).toBe(3200);
    expect(player.screenScalePx()).toBeCloseTo(before, 10);
    Object.defineProperty(window, 'devicePixelRatio', { value: orig, configurable: true });
  });

  it('resize 重读 devicePixelRatio（窗口拖到另一块不同缩放比例的显示器）', () => {
    const orig = (window as { devicePixelRatio?: number }).devicePixelRatio;
    Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true });
    const { player } = makePlayer();
    player.resize(1600, 900);
    expect(player.canvas.width).toBe(1600);
    // 构造后设备像素比变化（跨屏拖动）→ 下一次 resize 必须按新值重推
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
    player.resize(1600, 900);
    expect(player.canvas.width).toBe(3200);
    Object.defineProperty(window, 'devicePixelRatio', { value: orig, configurable: true });
  });

  it('pause 停止 RAF 排程，resume 重新排程（同一帧回调）', () => {
    const { player, mock } = makePlayer();
    const fn = vi.fn();
    player.setAnimationLoop(fn);
    const loop = mock._getLoop();
    expect(typeof loop).toBe('function');
    player.pause();
    expect(player.isPaused()).toBe(true);
    expect(mock.setAnimationLoop).toHaveBeenLastCalledWith(null);
    // 暂停期间即使外部仍调用帧体也不推进（防御：排程已停，但不依赖 three 的实现细节）
    loop!();
    expect(fn).not.toHaveBeenCalled();
    player.resume();
    expect(player.isPaused()).toBe(false);
    expect(mock.setAnimationLoop).toHaveBeenLastCalledWith(expect.any(Function));
    mock._getLoop()!();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('暂停期间 setAnimationLoop 不排程（挂载即暂停的场景）', () => {
    const { player, mock } = makePlayer();
    player.pause();
    player.setAnimationLoop(() => {});
    expect(mock.setAnimationLoop).toHaveBeenLastCalledWith(null);
    player.resume();
    expect(mock.setAnimationLoop).toHaveBeenLastCalledWith(expect.any(Function));
  });

  it('暂停冻结 elapsedSeconds（恢复后不跳帧，g_Time 驱动的滚动不瞬移）', () => {
    const nowSpy = vi.spyOn(performance, 'now');
    nowSpy.mockReturnValue(1000);
    const { player } = makePlayer();
    nowSpy.mockReturnValue(2000);
    expect(player.elapsedSeconds()).toBeCloseTo(1, 5);
    player.pause();
    nowSpy.mockReturnValue(9000); // 暂停 7 秒
    expect(player.elapsedSeconds()).toBeCloseTo(1, 5);
    player.resume();
    nowSpy.mockReturnValue(9500);
    expect(player.elapsedSeconds()).toBeCloseTo(1.5, 5);
    nowSpy.mockRestore();
  });
});

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

  /** GlowStage 的最小 spy：断言 apply / resize / dispose 的调用。 */
  function glowStageSpy() {
    const applied: Array<[unknown, unknown]> = [];
    const sizes: Array<[number, number]> = [];
    let disposed = false;
    return {
      stage: {
        apply: (_r: unknown, s: unknown, c: unknown) => { applied.push([s, c]); },
        resize: (w: number, h: number) => { sizes.push([w, h]); },
        setOptions: () => {},
        dispose: () => { disposed = true; },
      },
      applied, sizes, isDisposed: () => disposed,
    };
  }

  it('未装配 glowStage 时帧序不变（直接 renderer.render(scene, camera)）', () => {
    const { player, mock } = makePlayer();
    const before = mock._renders.length;
    player.setGlowStage(null);
    player.render();
    expect(mock._renders.length).toBe(before + 1);
    expect(mock._renders[mock._renders.length - 1].target).toBeNull(); // 渲到 canvas
  });

  it('装配 glowStage 时委托 apply，且不直接渲染主场景', () => {
    const { player, mock } = makePlayer();
    const g = glowStageSpy();
    const before = mock._renders.length;
    player.setGlowStage(g.stage as never);
    player.render();
    expect(g.applied.length).toBe(1);
    // 实参必须是 player 自己的 scene/camera（只断言调用次数抓不到参数传错的回归）
    expect(g.applied[0][0]).toBe(player.scene);
    expect(g.applied[0][1]).toBe(player.camera);
    expect(mock._renders.length).toBe(before); // 主场景渲染被委托给 stage（spy 不真渲）
  });

  it('resize 时把画布缓冲尺寸同步给 glowStage', () => {
    const { player } = makePlayer();
    const g = glowStageSpy();
    player.setGlowStage(g.stage as never);
    player.resize(800, 600);
    expect(g.sizes.length).toBe(1);
    const [w, h] = g.sizes[0];
    // 传的是**画布缓冲**尺寸（≥ CSS 尺寸；jsdom 默认 dpr=1 ⇒ 相等）
    expect(w).toBeGreaterThanOrEqual(800);
    expect(h).toBeGreaterThanOrEqual(600);
  });

  it('dpr=2 时 resize 同步给 glowStage 的是**画布缓冲** 1600×1200，不是 CSS 800×600', () => {
    const orig = (window as { devicePixelRatio?: number }).devicePixelRatio;
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
    try {
      const { player } = makePlayer();
      const g = glowStageSpy();
      player.setGlowStage(g.stage as never);
      player.resize(800, 600);
      // 缓冲 = 视口 × dpr（不变量）；传 CSS 尺寸会让 Glow 各级 RT 只有 1/dpr 分辨率
      expect(g.sizes).toEqual([[1600, 1200]]);
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', { value: orig, configurable: true });
    }
  });

  it('dispose 时拆除 glowStage', () => {
    const { player } = makePlayer();
    const g = glowStageSpy();
    player.setGlowStage(g.stage as never);
    player.dispose();
    expect(g.isDisposed()).toBe(true);
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

// ===== 对象隔离渲染（对象级效果链的前置能力）=====
describe('ThreeScenePlayer 对象隔离', () => {
  // 屏幕密度 = 对象 RT 尺寸的唯一基准（RT 像素 = 世界尺寸 × 密度 = 屏占位像素），必须与主相机
  // 实际铺满的像素网格同源。挂载期由 three-renderer 用纯函数 screenScalePx(...) 算（player 还没
  // 创建），resize 期取 player.screenScalePx()。两者必须给出**同一个数**，否则任何一次 resize
  // 都会把 RT 打回与屏占位不符的尺寸 ⇒ 合成那一步重采样 ⇒ 锐度掉一半（实测 −52%）。
  describe('screenScalePx（与 three-renderer 的独立计算同源）', () => {
    it('构造尺寸 = 视口尺寸时 = dpr；resize/setSceneSize 后与纯函数逐点一致', () => {
      for (const [sceneW, sceneH, vw, vh, dpr] of [
        [1920, 1080, 1920, 1080, 1],
        [1920, 1080, 1920, 1080, 2],
        [1920, 1080, 1600, 900, 1],
        [7430, 4147, 1280, 720, 1],
        [3840, 2160, 2560, 1080, 2], // 视口比场景更窄 → 左右裁剪
      ] as const) {
        Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: dpr });
        const { player } = makePlayer(sceneW, sceneH);
        player.setSceneSize(sceneW, sceneH);
        player.resize(vw, vh);
        expect(player.screenScalePx()).toBeCloseTo(screenScalePx(sceneW, sceneH, vw, vh, dpr), 10);
      }
      Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 });
    });
    it('GTR 3743126786：场景 7430×4147、视口 1280×720 → 密度 = 720/4147（cover 裁左右）', () => {
      const { player } = makePlayer(7430, 4147);
      player.setSceneSize(7430, 4147);
      player.resize(1280, 720);
      expect(player.screenScalePx()).toBeCloseTo(720 / 4147, 10);
    });
  });


  function makeTexture(): THREE.Texture {
    const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    tex.needsUpdate = true;
    return tex;
  }

  // ⚠️ 回归（2026-09-14，真机 HiDPI 反馈「很多 scene 壁纸错乱」）：局部正交相机的
  // left/right/top/bottom 是**世界坐标范围**（内容以世界单位绘制），必须覆盖对象的
  // **钳制后世界尺寸**；RT 的像素尺寸只决定分辨率（= 世界 × dpr 收口），**不得**拿来当相机范围。
  // 曾用 rtW/rtH 当相机范围：dpr>1 时相机多覆盖 dpr 倍 ⇒ 内容只占 RT 的 1/dpr、四周是空白，
  // 合成 quad 再按「全窗口」把它拉回世界尺寸 ⇒ 对象缩小 + 边缘 clamp 拉伸（HiDPI 屏整张壁纸错乱）。
  // 既有测试漏检的原因：那些用例的 rtWidth/rtHeight 恰好等于 worldW/worldH，且都不断言相机范围；
  // headless e2e 的 dpr=1 也让 rt == world，故端到端同样漏检。
  it('局部相机覆盖的世界范围 = 对象世界尺寸（不是 RT 像素尺寸）', () => {
    const { player } = makePlayer();
    // world 2560×1440，RT 像素 5120×2880（dpr=2 的典型结果）——两者不等才能暴露该缺陷。
    player.addBackground({
      origin: [960, 540, 0], size: [2560, 1440], scale: [1, 1, 1],
      texture: makeTexture(), sceneW: 1920, sceneH: 1080,
      isolate: { objectId: 77, rtWidth: 5120, rtHeight: 2880, worldW: 2560, worldH: 1440 },
    });
    const entry = player.isolatedObjects()[0];
    expect(entry.rt.width).toBe(5120);
    // 相机必须覆盖世界尺寸 2560×1440（而不是 RT 像素 5120×2880）。
    expect(entry.localCamera.right - entry.localCamera.left).toBeCloseTo(2560, 5);
    // ⚠️ y **镜像**（top=-720 < bottom=+720，2026-09-14 v 约定修复）：局部相机渲染出的对象 RT 是
    // 效果链的输入，必须取 WE 的 v 约定（v=0=图像顶部，见 attachIsolated 注释）⇒ 幅值仍是 1440，
    // 但 top/bottom 互换。断言按 `bottom - top`（= 幅值）写，与相机范围语义一致。
    expect(entry.localCamera.bottom - entry.localCamera.top).toBeCloseTo(1440, 5);
    expect(entry.localCamera.top).toBeLessThan(entry.localCamera.bottom);
    // RT 覆盖完整对象 ⇒ 合成几何 UV 为全窗口。
    const uv = (entry.quad.geometry as THREE.PlaneGeometry).attributes.uv.array as Float32Array;
    expect(Math.min(...Array.from(uv))).toBeCloseTo(0, 5);
    expect(Math.max(...Array.from(uv))).toBeCloseTo(1, 5);
  });

  it('世界尺寸超过 RT 像素上限时相机仍覆盖完整对象（不产生边缘拉伸带）', () => {
    const { player } = makePlayer();
    player.addBackground({
      origin: [0, 0, 0], size: [6000, 1000], scale: [1, 1, 1],
      texture: makeTexture(), sceneW: 6000, sceneH: 1000,
      isolate: { objectId: 78, rtWidth: 4096, rtHeight: 683, worldW: 6000, worldH: 1000 },
    });
    const entry = player.isolatedObjects()[0];
    // 相机覆盖**完整**世界尺寸（6000×1000），不被 4096 钳制 —— 4096 只约束 RT 的**像素**尺寸。
    // （曾把相机也钳到 4096：RT 只覆盖对象中央一块，UV 窗口外侧被 CLAMP 采样成边缘拉伸带，
    //   实测 GTR 3743126786 对象世界宽 7430 ⇒ 右侧 22% 画面宽是条纹。）
    expect(entry.localCamera.right - entry.localCamera.left).toBeCloseTo(6000, 5);
    expect(entry.localCamera.bottom - entry.localCamera.top).toBeCloseTo(1000, 5);
    // RT 覆盖完整对象 ⇒ 合成几何 UV 全窗口（超限只降低分辨率，不做几何裁剪）。
    const uv = (entry.quad.geometry as THREE.PlaneGeometry).attributes.uv.array as Float32Array;
    expect(Math.min(...Array.from(uv))).toBeCloseTo(0, 5);
    expect(Math.max(...Array.from(uv))).toBeCloseTo(1, 5);
  });

  it('isolate：内容进 localScene（position/rotation 归零、scale 保留），主 scene 放合成 quad', () => {
    const { player } = makePlayer();
    const id = player.addBackground({
      origin: [960, 540, 0], size: [400, 200], scale: [2, 2, 1], angles: [0, 0, 0.5],
      texture: makeTexture(), sceneW: 1920, sceneH: 1080,
      // isolate 五字段：objectId = 隔离条目的键（= scene.json 对象 id，与 addBackground 返回的
      // 图层计数器 id 不是一套编号）；rtWidth/rtHeight = 对象 RT 像素尺寸；
      // worldW/worldH = 合成 quad 的世界尺寸。
      isolate: { objectId: 42, rtWidth: 400, rtHeight: 200, worldW: 800, worldH: 400 },
    });
    // 返回值语义未变：仍是图层计数器 id（backgroundEntries 的键），首个背景层 = 0。
    expect(id).toBe(0);
    const iso = player.isolatedObjects();
    expect(iso).toHaveLength(1);
    const entry = iso[0];
    // 隔离条目的 id = isolate.objectId（对象 id 42），**不是**图层 id 0。
    expect(entry.id).toBe(42);
    expect(entry.kind).toBe('background');
    expect(entry.rt.width).toBe(400);
    expect(entry.rt.height).toBe(200);
    // 世界尺寸用调用方传入值（= |size × scale|），不得被 RT 像素尺寸冒充。
    expect(entry.worldW).toBe(800);
    expect(entry.worldH).toBe(400);
    // 内容：对象中心即局部原点，旋转归零（效果作用在对象自身纹理空间），缩放保留
    const content = entry.localScene.children[0] as THREE.Mesh;
    expect(content.position.toArray()).toEqual([0, 0, 0]);
    expect(content.rotation.toArray().slice(0, 3)).toEqual([0, 0, 0]);
    expect(content.scale.toArray()).toEqual([2, 2, 1]);
    // ⚠️ 隔离内容材质必须**双面**（2026-09-14 v 约定修复）：隔离内容的局部相机是 y 镜像
    // （对象 RT 取 WE 的 v=0=图像顶部约定，见 attachIsolated 注释），投影 y 取负会翻转屏幕
    // 空间绕序 ⇒ FrontSide 的 quad 会被背面剔除（对象整体消失）。
    expect((content.material as THREE.Material).side).toBe(THREE.DoubleSide);
    // 局部相机 y 镜像（top < bottom，幅值仍是相机覆盖的世界范围）
    expect(entry.localCamera.bottom - entry.localCamera.top).toBeCloseTo(400, 5);
    expect(entry.localCamera.top).toBeLessThan(entry.localCamera.bottom);
    // 合成 quad 的 UV 已把 RT 的 WE 约定翻回显示约定（v → 1-v；全窗口下 uv.y ∈ {0,1} 不变）
    const quadUv = (entry.quad.geometry as THREE.PlaneGeometry).attributes.uv.array as Float32Array;
    expect(Math.min(...Array.from(quadUv))).toBeCloseTo(0, 5);
    expect(Math.max(...Array.from(quadUv))).toBeCloseTo(1, 5);    // 合成 quad：材质**独立于内容材质**（不得 clone 内容材质——内容材质已把调制烘进 RT，
    // clone 会让贴回画面时二次施加调制；粒子内容材质是 InstancedBufferGeometry 专用 shader，
    // clone 到普通 PlaneGeometry 上 alpha 恒为 0）。背景无 colorBlendMode → MeshBasicMaterial。
    expect(entry.quad.material).not.toBe(content.material);
    expect(entry.quad.material).toBeInstanceOf(THREE.MeshBasicMaterial);
    const quadBasic = entry.quad.material as THREE.MeshBasicMaterial;
    // 合成 quad 的调制中性（无 alpha/brightness 时也必须是 1 / (1,1,1)，不继承内容材质）。
    expect(quadBasic.opacity).toBe(1);
    expect([quadBasic.color.r, quadBasic.color.g, quadBasic.color.b]).toEqual([1, 1, 1]);
    // 合成 quad：世界位置 = origin - scene/2（y 不翻），旋转 = 对象 angles（背景 RT 内容不含
    // 旋转，旋转必须由 quad 承载），尺寸 = |size×scale| 由几何承载
    expect(entry.quad.position.toArray()).toEqual([0, 0, 0]);
    expect(entry.quad.rotation.z).toBeCloseTo(0.5, 6);
    expect(entry.quad.scale.toArray()).toEqual([1, 1, 1]);
    // 主 scene 里只有合成 quad（内容不在主 scene）
    expect(player.scene.children).toContain(entry.quad);
    expect(player.scene.children).not.toContain(content);
  });

  it('合成 quad 的 UV = 显示约定（RT 的 WE 约定逐顶点取反 ⇒ 世界顶采样 v=0）', () => {
    const { player } = makePlayer();
    player.addBackground({
      origin: [0, 0, 0], size: [100, 100], scale: [1, 1, 1], texture: makeTexture(),
      sceneW: 100, sceneH: 100, isolate: { objectId: 91, rtWidth: 100, rtHeight: 50, worldW: 100, worldH: 100 },
    });
    const entry = player.isolatedObjects().find((e) => e.id === 91)!;
    const geo = entry.quad.geometry as THREE.PlaneGeometry;
    const got = geo.attributes.uv.array as Float32Array;
    // 独立参考：同参数、**未**翻转的合成几何（窗口映射与翻转可交换，故逐顶点 1-v 即期望值；
    // 本路径 camW/camH = |worldW/worldH| ⇒ 窗口恒全窗口，翻转后 uv.y ∈ {0,1}）
    const ref = createCompositeGeometry(100, 100, 100, 100).attributes.uv.array as Float32Array;
    expect(got.length).toBe(ref.length);
    for (let i = 0; i < got.length; i += 2) {
      expect(got[i]).toBeCloseTo(ref[i], 6);            // u 不动
      expect(got[i + 1]).toBeCloseTo(1 - ref[i + 1], 6); // v → 1-v
    }
    // 方向语义（关键）：世界**顶**（position.y = +50）的顶点必须采样 RT 的 v=0
    // ——RT 的 v=0 是**图像顶部**（WE 约定），两处镜像（局部相机 y 镜像 + 本处 UV 取反）
    // 精确抵消 ⇒ 对象在画面上正立。
    const pos = geo.attributes.position.array as Float32Array;
    for (let k = 0; k < got.length / 2; k++) {
      expect(got[k * 2 + 1]).toBeCloseTo(pos[k * 3 + 1] > 0 ? 0 : 1, 6);
    }
  });

  it('隔离：内容材质保留调制（烘进 RT），合成 quad 调制中性（不二次施加）', () => {
    const { player } = makePlayer();
    player.addBackground({
      origin: [0, 0, 0], size: [10, 10], scale: [1, 1, 1], texture: makeTexture(),
      alpha: 0.5, brightness: 0.8,
      sceneW: 100, sceneH: 100, isolate: { objectId: 7, rtWidth: 10, rtHeight: 10, worldW: 10, worldH: 10 },
    });
    const entry = player.isolatedObjects().find((e) => e.id === 7)!;
    const content = entry.localScene.children[0] as THREE.Mesh;
    const contentMat = content.material as THREE.MeshBasicMaterial;
    // 内容材质继续带调制：调制必须烘进 RT（内容渲染时施加一次）。
    expect(contentMat.opacity).toBeCloseTo(0.5, 6);
    expect(contentMat.color.r).toBeCloseTo(0.8, 6);
    // 合成 quad 中性：opacity=1、color=(1,1,1)——否则贴回主场景会再乘一次（0.5 → 0.25）。
    const quadMat = entry.quad.material as THREE.MeshBasicMaterial;
    expect(quadMat.opacity).toBe(1);
    expect([quadMat.color.r, quadMat.color.g, quadMat.color.b]).toEqual([1, 1, 1]);
  });

  it('不传 isolate 时行为不变：内容直接进主 scene，isolatedObjects 为空', () => {
    const { player } = makePlayer();
    player.addBackground({
      origin: [960, 540, 0], size: [400, 200], scale: [1, 1, 1],
      texture: makeTexture(), sceneW: 1920, sceneH: 1080,
    });
    expect(player.isolatedObjects()).toHaveLength(0);
    expect(player.scene.children).toHaveLength(1);
  });

  it('粒子隔离：内容 mesh 以负对象中心归位，objCenter uniform 保持原值', () => {
    const { player } = makePlayer();
    const verts = () => new Float32Array([0, 0, 0, 10, 0, 0, 1, 1, 1, 1]);
    const id = player.addParticle(verts, {
      frameCount: 1, blend: 'alpha',
      objectCenter: [100, 50, 0], objectScale: [1, 1, 1], objectAngles: [0, 0, 0.3],
      isolate: { objectId: 71, rtWidth: 64, rtHeight: 64, worldW: 64, worldH: 64 },
    });
    // 返回值 = 粒子图层计数器 id（particleLayers 的键）= 0；隔离条目的键是对象 id 71
    // ——两个独立计数器各自从 0 起，正是必须用对象 id 作隔离键的原因。
    expect(id).toBe(0);
    const entry = player.isolatedObjects().find((e) => e.id === 71)!;
    expect(entry.kind).toBe('particle');
    const content = entry.localScene.children[0] as THREE.Mesh;
    const mat = content.material as THREE.ShaderMaterial;
    // 归零改由「内容 mesh 的负中心平移」承载：shader 用
    // `local = particlePosition - objCenter - bmOffset` 反解局部坐标，而 particlePosition 本身
    // 含对象中心 → uniform 置零会让反解错误、内容整体出画（局部相机只有对象 RT 那么大）。
    // （`-c[2]` 在 c[2]=0 时得到 -0，故 +0 归一化后再比较数值。）
    expect(content.position.toArray().map((v) => v + 0)).toEqual([-100, -50, 0]);
    // 注意：粒子 shader 的对象中心 uniform 名是 `objCenter`（不是 objectCenter），
    // 角度是 `objAngles`——见 PARTICLE_VERTEX_SHADER 的 uniform 声明与 addParticle 的创建处。
    expect((mat.uniforms.objCenter.value as THREE.Vector3).toArray()).toEqual([100, 50, 0]);
    expect((mat.uniforms.objAngles.value as THREE.Vector3).toArray()).toEqual([0, 0, 0.3]);
    // 对象 scale 保留在局部内容上（染色/镜像由局部渲染承担，不由合成 quad 承担）。
    expect((mat.uniforms.objScale.value as THREE.Vector3).toArray()).toEqual([1, 1, 1]);
    // 旋转分工：粒子 RT 内容**已含** R(objAngles) → 合成 quad 不得再转（否则双重旋转）。
    expect(entry.quad.rotation.z).toBe(0);
    expect(entry.quad.position.toArray()).toEqual([100, 50, 0]);
    // 合成 quad 的材质独立于粒子内容材质（billboard shader 依赖逐实例属性，clone 到普通
    // PlaneGeometry 上 alpha 恒为 0 → 隔离粒子完全不可见）；且调制中性。
    expect(entry.quad.material).not.toBe(content.material);
    expect(entry.quad.material).toBeInstanceOf(THREE.MeshBasicMaterial);
    const quadMat = entry.quad.material as THREE.MeshBasicMaterial;
    expect(quadMat.opacity).toBe(1);
    expect([quadMat.color.r, quadMat.color.g, quadMat.color.b]).toEqual([1, 1, 1]);
  });

  // 键冲突回归（审查 Important 2）：背景层与粒子层各有一个**从 0 起的独立计数器**；旧实现把隔离
  // 条目按这两个计数器编号 → 同一壁纸「既有带效果 image 又有带效果 particle」时，后建的粒子条目
  // 会**覆盖**先建的背景条目（背景的 quad 从此采样一张永不被渲染的 RT，且两个对象映到同一个键）。
  // 改用对象 id 作键后两条目共存。
  it('隔离键 = 对象 id：带效果 image 与 particle 同时隔离时两条目共存（不互相覆盖）', () => {
    const { player } = makePlayer();
    const bgId = player.addBackground({
      origin: [0, 0, 0], size: [10, 10], scale: [1, 1, 1], texture: makeTexture(),
      sceneW: 100, sceneH: 100, isolate: { objectId: 13, rtWidth: 10, rtHeight: 10, worldW: 10, worldH: 10 },
    });
    const verts = () => new Float32Array([0, 0, 0, 10, 0, 0, 1, 1, 1, 1]);
    const particleId = player.addParticle(verts, {
      frameCount: 1, blend: 'alpha', objectCenter: [0, 0, 0],
      isolate: { objectId: 71, rtWidth: 8, rtHeight: 8, worldW: 8, worldH: 8 },
    });
    // 两个图层计数器各自从 0 起（互不相干）→ 旧实现下两个隔离条目会撞在同一个键上。
    expect([bgId, particleId]).toEqual([0, 0]);
    expect(player.isolatedObjects().map((e) => e.id).sort((a, b) => a - b)).toEqual([13, 71]);
    // 背景条目仍是自己的 RT（未被粒子条目覆盖）。
    const bgEntry = player.isolatedObjects().find((e) => e.id === 13)!;
    expect(bgEntry.kind).toBe('background');
    expect(bgEntry.rt.width).toBe(10);
    expect(bgEntry.rt.height).toBe(10);
    const particleEntry = player.isolatedObjects().find((e) => e.id === 71)!;
    expect(particleEntry.kind).toBe('particle');
    expect(particleEntry.rt.width).toBe(8);
  });

  it('setObjectOutput 切换合成 quad 的采样源（MeshBasicMaterial 路径；cb 混合仍落在 quad 上）', () => {
    const { player } = makePlayer();
    const texA = makeTexture();
    const texB = makeTexture();
    const idBasic = player.addBackground({
      origin: [0, 0, 0], size: [10, 10], scale: [1, 1, 1], texture: texA,
      sceneW: 100, sceneH: 100, isolate: { objectId: 101, rtWidth: 10, rtHeight: 10, worldW: 10, worldH: 10 },
    });
    const idBlend = player.addBackground({
      origin: [0, 0, 0], size: [10, 10], scale: [1, 1, 1], texture: texA, colorBlendMode: 7,
      sceneW: 100, sceneH: 100, isolate: { objectId: 102, rtWidth: 10, rtHeight: 10, worldW: 10, worldH: 10 },
    });
    // 切换采样源用**隔离条目的键**（对象 id），不是 addBackground 的返回值（图层 id 0/1）。
    expect([idBasic, idBlend]).toEqual([0, 1]);
    player.setObjectOutput(101, texB);
    player.setObjectOutput(102, texB);
    const entryBasic = player.isolatedObjects().find((e) => e.id === 101)!;
    const entryBlend = player.isolatedObjects().find((e) => e.id === 102)!;
    // 两条路径现在**都是 MeshBasicMaterial**（合成 quad 采样的是非预乘的对象 RT，禁用内容那套
    // 预乘 shader，见 createCompositeQuadMaterial 注释）。
    expect(entryBasic.quad.material).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect(entryBlend.quad.material).toBeInstanceOf(THREE.MeshBasicMaterial);
    const basic = entryBasic.quad.material as THREE.MeshBasicMaterial;
    const blend = entryBlend.quad.material as THREE.MeshBasicMaterial;
    expect(basic.map).toBe(texB);
    expect(blend.map).toBe(texB);
    // 合成 quad 材质独立于内容材质（不 clone 内容材质）；内容材质仍带原有调制。
    const contentBlend = entryBlend.localScene.children[0] as THREE.Mesh;
    expect(blend).not.toBe(contentBlend.material);
    expect(entryBasic.quad.material).not.toBe((entryBasic.localScene.children[0] as THREE.Mesh).material);
    // 合成 quad 调制中性（不二次施加 alpha/brightness）。
    expect([blend.color.r, blend.color.g, blend.color.b]).toEqual([1, 1, 1]);
    expect(blend.opacity).toBe(1);
    // colorBlendMode=7（Screen）必须落在合成这一步：CustomBlending + OneMinusDstColor
    expect(blend.blending).toBe(THREE.CustomBlending);
    expect(blend.blendSrc).toBe(THREE.OneMinusDstColorFactor);
    expect(blend.blendDst).toBe(THREE.OneFactor);
    // alpha 按 WE 保留背景的（gl_FragColor.a = screen.a）。
    expect(blend.blendSrcAlpha).toBe(THREE.ZeroFactor);
    expect(blend.blendDstAlpha).toBe(THREE.OneFactor);
    // 回归（2026-09-15，GTR 云挡住人物）：WE 的 cbm 语义是 `mix(A, blend(A,B), opacity)` ——
    // 颜色因子（OneMinusDstColor/One）**不看 alpha**，所以图层 alpha（opacity 0.26 × mask）必须
    // 由片元自己预乘进 rgb（`premultipliedAlpha` ⇒ `gl_FragColor.rgb *= gl_FragColor.a`），
    // 否则云层会以全强度盖在人物上、mask 也失效。cbm=0 走普通 alpha 混合，必须**不**预乘。
    expect(blend.premultipliedAlpha).toBe(true);
    expect(basic.premultipliedAlpha).toBe(false);
    // 无 cb 的合成 quad 仍是普通 alpha 混合。
    expect(basic.blending).toBe(THREE.NormalBlending);
  });

  // 2026-09-14：WE 的 colorBlendMode 混合语义从「内容材质」搬到「合成 quad」。
  // 隔离内容渲染到**新清空的 RT**（alpha=0），若内容材质仍套 cb 的 Zero/One alpha 因子会得到
  // 「保持背景的 alpha」= 恒 0 ⇒ 合成 quad 的预乘片元被乘成 0 ⇒ 对象整体不可见。
  // 2026-09-15 补：WE 在「对象有多个 pass」时把**首个 pass 强制成 BlendingMode_Normal（= ONE/ZERO
  // 覆盖）**（lwe `CImage.cpp` setupPasses 前那段 setBlendingMode），所以隔离内容必须**覆盖写**
  // ⇒ RT.rgb = 非预乘的 B、RT.a = 内容 alpha；否则 rgb 被预乘一次，合成再乘一次最终 alpha
  // ⇒ 半透明图层只剩一半亮度（GTR 云「太淡看不清」）。
  it('隔离内容材质覆盖写（不套 cb、不预乘），由合成 quad 承担混合', () => {
    const { player } = makePlayer();
    player.addBackground({
      origin: [0, 0, 0], size: [10, 10], scale: [1, 1, 1], texture: makeTexture(), colorBlendMode: 7,
      sceneW: 100, sceneH: 100, isolate: { objectId: 103, rtWidth: 10, rtHeight: 10, worldW: 10, worldH: 10 },
    });
    const entry = player.isolatedObjects().find((e) => e.id === 103)!;
    const content = entry.localScene.children[0] as THREE.Mesh;
    // 内容材质不是预乘 cb shader（隔离路径 forIsolation=true）。
    expect(content.material).not.toBeInstanceOf(THREE.ShaderMaterial);
    expect(content.material).toBeInstanceOf(THREE.MeshBasicMaterial);
    const contentMat = content.material as THREE.MeshBasicMaterial;
    expect(contentMat.blending).toBe(THREE.NoBlending);   // WE 首个 pass = Normal(ONE/ZERO)
    expect(contentMat.blendSrcAlpha).toBeNull();
    expect(contentMat.blendDstAlpha).toBeNull();
  });

  it('非隔离的 colorBlendMode=7 内容材质**仍**套 cb（主路径语义不变）', () => {
    const { player } = makePlayer();
    player.addBackground({
      origin: [0, 0, 0], size: [10, 10], scale: [1, 1, 1], texture: makeTexture(), colorBlendMode: 7,
      sceneW: 100, sceneH: 100,
    });
    const mesh = player.scene.children[0] as THREE.Mesh;
    const mat = mesh.material as THREE.ShaderMaterial;
    expect(mat).toBeInstanceOf(THREE.ShaderMaterial);
    expect(mat.blending).toBe(THREE.CustomBlending);
    expect(mat.blendSrc).toBe(THREE.OneMinusDstColorFactor);
    expect(mat.blendSrcAlpha).toBe(THREE.ZeroFactor);
    expect(mat.blendDstAlpha).toBe(THREE.OneFactor);
  });

  // 回归（AGENT.md §5.22）：渲染到 RT 必须透明清屏（clearAlpha=0），主场景 → 画布保持原值。
  it('隔离内容渲染用透明清屏（clearAlpha=0），主场景渲染保持原值', () => {
    const { player, mock } = makePlayer();
    player.addBackground({
      origin: [0, 0, 0], size: [10, 10], scale: [1, 1, 1], texture: makeTexture(),
      sceneW: 100, sceneH: 100, isolate: { objectId: 77, rtWidth: 10, rtHeight: 10, worldW: 10, worldH: 10 },
    });
    player.render();
    const isoRender = mock._renders.find((r) => r.target !== null);
    const mainRender = mock._renders.find((r) => r.target === null);
    expect(isoRender?.clearAlpha).toBe(0);   // 对象 RT：透明黑清屏
    expect(mainRender?.clearAlpha).toBe(1);  // 主场景 → 画布：原值不变
    expect(mock._clearAlpha()).toBe(1);      // 渲染后状态已恢复
  });

  it('帧钩子按序调用：隔离内容渲染 → bindOutputs → 主场景渲染 → advance', () => {
    const { player, mock } = makePlayer();
    const order: string[] = [];
    (mock.render as unknown as { mockImplementation: (f: (s: unknown, c: unknown) => void) => void })
      .mockImplementation((s: unknown) => { order.push(s === player.scene ? 'main' : 'isolated'); });
    player.addBackground({
      origin: [0, 0, 0], size: [10, 10], scale: [1, 1, 1], texture: makeTexture(),
      sceneW: 100, sceneH: 100, isolate: { objectId: 55, rtWidth: 10, rtHeight: 10, worldW: 10, worldH: 10 },
    });
    player.setObjectEffectStage({
      bindOutputs: () => order.push('bind'),
      advance: () => order.push('advance'),
    });
    player.render();
    expect(order).toEqual(['isolated', 'bind', 'main', 'advance']);
  });

  it('零回归：不传 isolate 且无 stage 时，render() 只渲染主场景一次', () => {
    const { player, mock } = makePlayer();
    player.render();
    expect(mock.render).toHaveBeenCalledTimes(1);
    expect((mock.render as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]).toBe(player.scene);
  });

  it('resizeObjectRT 只改 RT 分辨率，不同步相机、不重建合成几何', () => {
    const { player } = makePlayer();
    const id = player.addBackground({
      origin: [0, 0, 0], size: [10, 10], scale: [1, 1, 1], texture: makeTexture(),
      sceneW: 100, sceneH: 100, isolate: { objectId: 88, rtWidth: 10, rtHeight: 10, worldW: 10, worldH: 10 },
    });
    const entry = player.isolatedObjects()[0];
    const oldGeo = entry.quad.geometry;
    // 返回值 = 图层计数器 id（0）；重设 RT 用**隔离条目的键**（对象 id 88）。
    expect(id).toBe(0);
    player.resizeObjectRT(88, 40, 20);
    expect(entry.rt.width).toBe(40);
    expect(entry.rt.height).toBe(20);
    // 扁平视图必须同步（编排器按它算效果链纹理槽分辨率）。
    expect(entry.rtWidth).toBe(40);
    expect(entry.rtHeight).toBe(20);
    // ⚠️ 相机覆盖的**世界范围**只依赖世界尺寸（10×10），与 RT 像素无关 ⇒ 不得跟着 RT 变。
    // 曾在此按 RT 像素重设视锥（left=-20/right=20）：dpr>1 时内容被缩小到 1/dpr 并露出边缘
    // （真机 HiDPI 整张壁纸错乱的同一根因）。
    expect(entry.localCamera.left).toBe(-5);
    expect(entry.localCamera.right).toBe(5);
    // y 镜像（v 约定修复）：幅值 5 不变，top/bottom 符号互换（见 attachIsolated 注释）。
    expect(entry.localCamera.top).toBe(-5);
    expect(entry.localCamera.bottom).toBe(5);
    // 合成几何同样不重建：其世界尺寸与 UV 窗口都只依赖世界尺寸。
    expect(entry.quad.geometry).toBe(oldGeo);
  });

  it('dispose 释放隔离 RT / 合成 quad / 内容', () => {
    const { player } = makePlayer();
    player.addBackground({
      origin: [0, 0, 0], size: [10, 10], scale: [1, 1, 1], texture: makeTexture(),
      sceneW: 100, sceneH: 100, isolate: { objectId: 12, rtWidth: 10, rtHeight: 10, worldW: 10, worldH: 10 },
    });
    const entry = player.isolatedObjects()[0];
    const rtDispose = vi.spyOn(entry.rt, 'dispose');
    player.dispose();
    expect(rtDispose).toHaveBeenCalled();
    expect(player.isolatedObjects()).toHaveLength(0);
  });
});
