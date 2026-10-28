// @vitest-environment jsdom
// Task 1：three.js 场景骨架。WebGLRenderer 无法在 node/jsdom（无 WebGL）环境构造，
// 测试按契约「可 mock renderer」注入 mock（真实 Scene/Camera/cover 数值仍可验证）。
// 聚焦：构造后 scene/camera/renderer 存在；resize 更新 cover；update+render 不抛错；
// 正交相机 cover 尺寸正确（复用 object-range.coverRange 语义）。

import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { ThreeScenePlayer, loadSceneToThree, resolvePixelRatio, frameCountFromDims, textureFrameCount, textureFrameGrid, specMaxcount, particleCapacity, specEmitterOrigin, simEmitterOffset, specRenderer, specPerspective, particlePerspectiveCamera, specSparseEventSource, BLACKMYTH_OBJ_SCALE, DEFAULT_PARTICLE_CAPACITY, MAX_PARTICLE_CAPACITY, PARTICLE_FLOATS_PER_INSTANCE, type ParticleSim } from '../src/client/threejs-player.js';
import { ObjectEffectStage, ENABLE_CHAIN_FRAME_SNAPSHOT_CONSUMER } from '../src/client/object-effects.js';
import type { CompiledEffectPass } from '../src/client/shader/effect-chain.js';
import { textLayerOffset, type TextLayout } from '../src/client/text-object.js';
import { coverRange, createCompositeGeometry, screenScalePx } from '../src/client/object-range.js';
import { createFrameCapture } from '../src/client/frame-capture.js';
import { createGlowStage } from '../src/client/glow-stage.js';
import type { PuppetInstance } from '../src/client/puppet.js';
import { parseSceneJson } from '../src/client/scene-json.js';
import { computeEffectiveVisibility } from '../src/client/visibility.js';

// 注入的 mock renderer：只测相机/场景/RAF 逻辑，不触碰 WebGL。
// Task 3 起还承载段渲染契约：autoClear 可读写、清屏参数可读、段边界 copyFramebufferToTexture 可观测。
function createMockRenderer() {
  let loop: (() => void) | null = null;
  const setAnimationLoop = vi.fn((fn: (() => void) | null) => {
    loop = fn;
  });
  // 清屏 alpha 与渲染目标都要记录：渲染到 RT 时必须清成透明黑（见 AGENT.md §5.22）。
  let clearAlpha = 1;
  const clearColor = new THREE.Color(0, 0, 0);
  let currentTarget: unknown = null;
  // `renders` 的既有形状 {scene,target,clearAlpha} 不得改动（大量断言依赖）；新增字段只追加。
  const renders: Array<{ scene: unknown; target: unknown; clearAlpha: number; autoClear: boolean }> = [];
  // 帧内观测口：需要在 render **当刻**读 scene 状态（visible / 段边界）的用例挂这里，
  // 不要替换 `render` 实现（那样会同时废掉 renders 记录 ⇒ 快照时序断言失真）。
  let onRender: ((scene: unknown) => void) | null = null;
  // `rendersBefore` = 拍快照时已发生的 render 次数：钉住「快照在消费者渲染**之前**」这条语义。
  const copies: Array<{ texture: unknown; target: unknown; rendersBefore: number }> = [];
  const renderer = {
    setSize: vi.fn(),
    setPixelRatio: vi.fn(),
    render: vi.fn((scene: unknown) => {
      renders.push({ scene, target: currentTarget, clearAlpha, autoClear: renderer.autoClear });
      onRender?.(scene);
    }),
    // 对象隔离渲染（Task 3）：renderIsolatedContents 会切换渲染目标到对象 RT，
    // mock 需提供同名方法（no-op），否则隔离路径全部以 TypeError 失败。
    setRenderTarget: vi.fn((t: unknown = null) => { currentTarget = t; }),
    getClearAlpha: vi.fn(() => clearAlpha),
    setClearAlpha: vi.fn((v: number) => { clearAlpha = v; }),
    // 段渲染：清屏参数（黑 + alpha 1，与默认 fb 一致）+ autoClear 可读写 + 显式 clear。
    // 段渲染路径（Task 3）读取的三个接口，缺一个都会以 TypeError 整条路径失败。
    getClearColor: vi.fn((c: THREE.Color) => c.copy(clearColor)),
    setClearColor: vi.fn((c: THREE.ColorRepresentation, a = 1) => {
      clearColor.set(c as THREE.ColorRepresentation);
      clearAlpha = a;
    }),
    clear: vi.fn(),
    autoClear: true,
    // FrameCapture（Task 1）的两个依赖：快照 blit 与惰性建资源时的画布缓冲尺寸。
    copyFramebufferToTexture: vi.fn((tex: unknown) => {
      copies.push({ texture: tex, target: currentTarget, rendersBefore: renders.length });
    }),
    getDrawingBufferSize: vi.fn((v: THREE.Vector2) => v.set(1920, 1080)),
    dispose: vi.fn(),
    setAnimationLoop,
    _getLoop: () => loop,
    _setOnRender: (fn: ((scene: unknown) => void) | null) => { onRender = fn; },
    _renders: renders,
    _copies: copies,
    _clearAlpha: () => clearAlpha,
    _clearColor: () => clearColor.clone(),
    _currentTarget: () => currentTarget,
  };
  return renderer;
}

function makePlayer(w = 1920, h = 1080, mock = createMockRenderer()) {
  const canvas = document.createElement('canvas');
  const player = new ThreeScenePlayer(canvas, w, h, mock as unknown as THREE.WebGLRenderer);
  return { player, mock };
}

// v0.8.1 F15：壁纸清屏色（general.clearcolor，0-255）。设置值按工作色彩空间（linear-srgb）原样写入，
// 取 hex 必须显式指定该色彩空间，否则 getHexString 会按 sRGB 编码回写（17 → 0x49），与真实像素不符。
const rawHex = (c: THREE.Color): string => c.getHexString(THREE.LinearSRGBColorSpace);

// SceneScript 音频可视化（visualizer）：脚本 init 动态 createLayer 的 64 条 bar 由 player 代建，
// 每帧按音频频谱更新高度（bottom 对齐，无音频归零）。
describe('visualizer 音频条', () => {
  it('setVisualizerBars 建 count 条并按 freqData 更新高度/位置', () => {
    const { player } = makePlayer(3840, 2160);
    const ids = player.setVisualizerBars({
      origin: [113.7435, 83.14454, 0], barSize: [4, 4], barWidth: 0.83,
      scaleY: 23.89, originX: 12.67, sceneW: 3840, sceneH: 2160, renderOrder: 60, count: 4,
    });
    expect(ids).toHaveLength(4);
    // displayObject 只登记 scene 对象 id（bars 无 objectId）⇒ 用 scene.children 顺序取。
    const bars = player.scene.children as THREE.Mesh[];
    expect(bars).toHaveLength(4);
    // 初始高度 0（无音频不可见）
    expect(bars[0].scale.y).toBe(0);
    expect(bars[0].scale.x).toBeCloseTo(0.83, 6);
    const freq = new Uint8Array(64);
    freq[0] = 255; freq[1] = 128;
    player.updateVisualizerBars(freq);
    expect(bars[0].scale.y).toBeCloseTo(23.89, 3); // 255/255 × scaleY
    expect(bars[1].scale.y).toBeCloseTo((128 / 255) * 23.89, 3);
    // bottom 对齐：中心 y = baseY + h/2（baseY = origin.y − sceneH/2）
    expect(bars[0].position.y).toBeCloseTo(83.14454 - 1080 + (4 * 23.89) / 2, 3);
    player.updateVisualizerBars(null);
    expect(bars[0].scale.y).toBe(0);
  });
});

describe('ThreeScenePlayer 清屏色（F15）', () => {
  const CLEAR: [number, number, number] = [17, 20, 24];

  it('构造 opts.clearColor → setClearColor 收到 0-255 归一化后的清屏色（alpha 1）', () => {
    const mock = createMockRenderer();
    new ThreeScenePlayer(
      document.createElement('canvas'), 1920, 1080, mock as unknown as THREE.WebGLRenderer, 1,
      { clearColor: CLEAR },
    );
    expect(mock.setClearColor).toHaveBeenCalledTimes(1);
    const [color, alpha] = mock.setClearColor.mock.calls[0] as [THREE.Color, number];
    expect(rawHex(color)).toBe('111418');
    expect(alpha).toBe(1);
    expect(rawHex(mock._clearColor())).toBe('111418');
  });

  it('未提供 clearColor → 不改渲染器清屏色（零回归：缺省仍为黑）', () => {
    const mock = createMockRenderer();
    new ThreeScenePlayer(document.createElement('canvas'), 1920, 1080, mock as unknown as THREE.WebGLRenderer);
    expect(mock.setClearColor).not.toHaveBeenCalled();
    expect(rawHex(mock._clearColor())).toBe('000000');
  });

  it('loadSceneToThree 按 general.clearcolor 装配清屏色', () => {
    const mock = createMockRenderer();
    const scene = JSON.stringify({
      camera: { center: '0 0 0', eye: '0 0 1', up: '0 1 0' },
      // 真实 scene.json 为 0-1 归一化（本机 37 张全部 ≤ 1；2980088441 原值即此）。
      general: { orthogonalprojection: { width: 1920, height: 1080 }, clearcolor: '0.06667 0.07843 0.09412' },
      objects: [],
    });
    loadSceneToThree(scene, { renderer: mock as unknown as THREE.WebGLRenderer }, document.createElement('canvas'));
    expect(rawHex(mock._clearColor())).toBe('111418');
  });

  // A1 [Critical]：默认 Glow 开启时主场景先自渲进 base RT。若该步强制 clearAlpha=0，
  // premultipliedAlpha 会把清屏 RGB 乘成 0 ⇒ clearcolor 壁纸变黑。base RT 必须保留清屏 alpha。
  it('默认 Glow 自渲 baseRT 保留清屏 alpha（clearcolor 不被预乘成黑）', () => {
    const mock = createMockRenderer();
    const player = new ThreeScenePlayer(
      document.createElement('canvas'), 1920, 1080, mock as unknown as THREE.WebGLRenderer, 1,
      { clearColor: CLEAR },
    );
    const stage = createGlowStage(1920, 1080)!;
    player.setGlowStage(stage);
    player.render();
    // 主场景只渲一次（进 base RT，不直渲画布），且当刻清屏 alpha 仍是 1
    const sceneRenders = mock._renders.filter((r) => r.scene === player.scene);
    expect(sceneRenders).toHaveLength(1);
    expect(sceneRenders[0].target).not.toBeNull();
    expect(sceneRenders[0].clearAlpha).toBe(1);
    expect(mock._clearAlpha()).toBe(1);
    stage.dispose();
    player.dispose();
  });

  it('段渲染清屏改用同一清屏色（RT 段内与 finally 恢复都保持该色）', () => {
    const mock = createMockRenderer();
    const player = new ThreeScenePlayer(
      document.createElement('canvas'), 1920, 1080, mock as unknown as THREE.WebGLRenderer, 1,
      { clearColor: CLEAR },
    );
    const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    for (const [i, objectId] of [11, 22].entries()) {
      player.addBackground({
        origin: [i * 10, 0, 0], size: [10, 10], scale: [1, 1, 1], texture: tex,
        sceneW: 100, sceneH: 100, objectId, renderOrder: i,
      });
    }
    const cap = createFrameCapture(mock as unknown as THREE.WebGLRenderer);
    cap.use();
    player.setFrameCapture(cap);
    player.registerFrameConsumer(22); // 2 段：段 1（#11）| 段 2（#22 = 消费者）
    mock.setClearColor.mockClear(); // 只观测渲染期的清屏调用（构造期那次已断言）
    const seen: string[] = [];
    mock._setOnRender((s) => {
      if (s === player.scene) seen.push(rawHex(mock._clearColor()));
    });
    player.render();
    // 段首 clear 与默认 fb 同色：两段 render 都发生在自定义清屏色下
    expect(seen).toEqual(['111418', '111418']);
    const segColor = mock.setClearColor.mock.calls[0][0] as THREE.Color;
    expect(rawHex(segColor)).toBe('111418');
    // finally 恢复的是「进入前的清屏色」= 同一自定义色（不是黑）
    expect(rawHex(mock._clearColor())).toBe('111418');
    player.dispose();
  });
});

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

  // v0.8.1 F3：text 与 image 共用 addBackground 的隔离入口（有 effects 时进对象 RT）。
  it('isolate 条目 → text 图层同样进隔离路径（不再走共享场景直渲）', () => {
    const tex = new THREE.DataTexture(new Uint8Array(4), 2, 2);
    const assets = {
      ...makeTextAssets({ texture: tex, size: [600, 200] }),
      isolate: new Map([[7, { objectId: 7, rtWidth: 300, rtHeight: 100, worldW: 600, worldH: 200 }]]),
    };
    const result = loadSceneToThree(scene, assets, document.createElement('canvas'));
    expect(result.backgroundIds).toHaveLength(1);
    expect(result.player.isolatedObjects()).toHaveLength(1);
    expect(result.player.isolatedObjects()[0].id).toBe(7);
    // update_background 必须移动合成 quad（内容 mesh 在对象 RT 内坐标恒为 0），
    // 否则时钟跨分钟改 origin 会把内容移出对象 RT 视野。
    const iso = result.player.isolatedObjects()[0];
    const content = iso.localScene.children[0];
    result.player.update_background(result.backgroundIds[0], [1000, 500, 0]);
    expect(iso.quad.position.x).toBeCloseTo(1000 - 1920 / 2, 5);
    expect(iso.quad.position.y).toBeCloseTo(500 - 1080 / 2, 5);
    expect(content.position.toArray()).toEqual([0, 0, 0]);
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

  // v0.8.2 F12：text 的 alpha 与 image 同口径 —— materialModulation 烘进**内容**材质 opacity；
  // 隔离路径合成 quad 保持 1（内容已承载 alpha，再乘一次会变 a²）。brightness 由 canvas 侧承担，
  // 不重复乘入材质（否则半透明会平方、>1 也会被 clamp 掉）。
  it('text 对象 alpha → 内容材质 opacity（直渲/隔离同口径，合成 quad 不二次调制）', () => {
    const sceneWithAlpha = JSON.stringify({
      camera: { center: '0 0 0', eye: '0 0 1', up: '0 1 0' },
      general: { orthogonalprojection: { width: 1920, height: 1080 } },
      objects: [{
        id: 7, name: 'Clock', origin: '960 540 0', scale: '1 1 1',
        alpha: 0.5, brightness: 2.5, anchor: 'topright', limitwidth: true, maxwidth: 300,
        text: { value: '12:34' },
      }],
    });
    const tex = new THREE.DataTexture(new Uint8Array(4), 2, 2);
    const direct = loadSceneToThree(
      sceneWithAlpha,
      makeTextAssets({ texture: tex, size: [400, 100] }),
      document.createElement('canvas'),
    );
    const directMat = (direct.player.scene.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial;
    expect(directMat.opacity).toBe(0.5);

    const isolated = loadSceneToThree(
      sceneWithAlpha,
      {
        ...makeTextAssets({ texture: tex, size: [400, 100] }),
        isolate: new Map([[7, { objectId: 7, rtWidth: 400, rtHeight: 100, worldW: 400, worldH: 100 }]]),
      },
      document.createElement('canvas'),
    );
    const iso = isolated.player.isolatedObjects()[0];
    expect((iso.localScene.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial)
      .toMatchObject({ opacity: 0.5 });
    expect((iso.quad.material as THREE.MeshBasicMaterial).opacity).toBe(1);
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

  it('渲染一帧时按需校准 DPR（桌面版启动时 dpr 未就绪 → 不必重选壁纸即恢复锐利）', () => {
    const orig = (window as { devicePixelRatio?: number }).devicePixelRatio;
    try {
      Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true });
      const { player } = makePlayer();
      player.resize(1600, 900);
      expect(player.canvas.width).toBe(1600);
      // 系统缩放这时才反映到该窗口（DSH 桌面版窗口创建早于 DPR 生效），窗口尺寸不变 ⇒ resize 不会被调用
      Object.defineProperty(window, 'devicePixelRatio', { value: 1.25, configurable: true });
      player.render();
      expect(player.canvas.width).toBe(2000); // 1600 × 1.25，无需重新装配
      // DPR 不变时不做无谓的 resize（幂等：再渲染一帧尺寸不变）
      player.render();
      expect(player.canvas.width).toBe(2000);
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', { value: orig, configurable: true });
    }
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

  // v0.8.2 F13：image alignment 决定 quad 原点 —— origin 是锚点，mesh/合成 quad 中心按
  // WE ResolveImageAlignmentOffset 偏移（bottomright = 右下角钉在 origin）。
  it('addBackground：alignment → 锚点偏移（bottomright：中心左移半宽、上移半高）', () => {
    const { player } = makePlayer(1000, 600);
    player.addBackground({
      origin: [500, 300, 0], size: [100, 50], scale: [1, 1, 1],
      alignment: 'bottomright', sceneW: 1000, sceneH: 600,
    });
    const mesh = player.scene.children[0] as THREE.Mesh;
    expect(mesh.position.x).toBeCloseTo(-50, 6);
    expect(mesh.position.y).toBeCloseTo(25, 6);
  });

  it('addBackground：alignment 偏移随 scale 缩放、随 angles 旋转（与 mesh TRS 同序）', () => {
    const { player } = makePlayer(1000, 600);
    // left：中心在 origin 右侧半宽；scale.x=2 ⇒ 世界偏移 100，再绕 z 转 90° ⇒ (0,100)。
    player.addBackground({
      origin: [500, 300, 0], size: [100, 50], scale: [2, 1, 1],
      angles: [0, 0, Math.PI / 2], alignment: 'left', sceneW: 1000, sceneH: 600,
    });
    const mesh = player.scene.children[0] as THREE.Mesh;
    expect(mesh.position.x).toBeCloseTo(0, 6);
    expect(mesh.position.y).toBeCloseTo(100, 6);
  });

  it('隔离：alignment 落合成 quad 位置（内容 mesh 仍居中于 RT，二者中心一致）', () => {
    const { player } = makePlayer(1000, 600);
    player.addBackground({
      origin: [500, 300, 0], size: [100, 50], scale: [1, 1, 1],
      alignment: 'bottomright', sceneW: 1000, sceneH: 600, objectId: 13,
      isolate: { objectId: 13, rtWidth: 100, rtHeight: 50, worldW: 100, worldH: 50 },
    });
    const entry = player.isolatedObjects().find((e) => e.id === 13)!;
    expect(entry.quad.position.x).toBeCloseTo(-50, 6);
    expect(entry.quad.position.y).toBeCloseTo(25, 6);
    // 内容渲染进对象 RT 时居中（锚点偏移由合成 quad 承载，不在 RT 内重复偏移）。
    expect((entry.localScene.children[0] as THREE.Mesh).position.toArray()).toEqual([0, 0, 0]);
    // 脚本/显示对象看到的是合成 quad ⇒ 可见内容中心 = quad 位置。
    expect(player.displayObject(13)).toBe(entry.quad);
  });

  it('视差基准位包含 alignment 偏移（开/关视差都不丢锚点）', () => {
    const { player: p } = makePlayer(1920, 1080);
    const id = p.addBackground({
      origin: [960, 540, 0], size: [100, 50], scale: [1, 1, 1], alignment: 'bottomright',
      parallaxDepth: [1, 1], sceneW: 1920, sceneH: 1080,
    });
    const node = p.backgroundMeshForTest(id);
    expect(node.position.x).toBeCloseTo(-50, 6);
    expect(node.position.y).toBeCloseTo(25, 6);
    // 视差按**锚点 origin**（不含 alignment 偏移）算 shift：-960（指针右移）。
    p.setParallax({ enabled: true, amount: 1, delay: 0, mouseInfluence: 1 });
    p.setParallaxPointer({ x: 1, y: 0.5 });
    p.tickParallaxForTest(0.016);
    expect(node.position.x).toBeCloseTo(-50 - 960, 3);
    expect(node.position.y).toBeCloseTo(25, 3);
    // 关视差写回基准位：仍带 alignment 偏移（不是裸 origin - scene/2）。
    p.setParallax({ enabled: false, amount: 0, delay: 0, mouseInfluence: 0 });
    p.tickParallaxForTest(0.016);
    expect(node.position.x).toBeCloseTo(-50, 6);
    expect(node.position.y).toBeCloseTo(25, 6);
  });

  it('update_background：改 origin 后 alignment 偏移仍生效', () => {
    const { player } = makePlayer(1000, 600);
    const id = player.addBackground({
      origin: [500, 300, 0], size: [100, 50], scale: [1, 1, 1],
      alignment: 'bottomright', sceneW: 1000, sceneH: 600,
    });
    player.update_background(id, [400, 200, 0]);
    const mesh = player.scene.children[0] as THREE.Mesh;
    expect(mesh.position.x).toBeCloseTo(400 - 500 - 50, 6);
    expect(mesh.position.y).toBeCloseTo(200 - 300 + 25, 6);
  });

  it('update_background：brightness 更新保留 image color tint（不重置为白）', () => {
    const { player } = makePlayer(1000, 600);
    const id = player.addBackground({
      origin: [500, 300, 0], size: [100, 50], scale: [1, 1, 1],
      color: [128, 64, 32], brightness: 1, sceneW: 1000, sceneH: 600,
    });
    player.update_background(id, undefined, undefined, undefined, 0.5);
    const mat = (player.scene.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial;
    expect(mat.color.r).toBeCloseTo(64 / 255, 6);  // 128/255 × 0.5
    expect(mat.color.g).toBeCloseTo(32 / 255, 6);
    expect(mat.color.b).toBeCloseTo(16 / 255, 6);
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

  // 脚本/视差已经写过位置时，scale 更新只改尺寸；锚点偏移不变就**不得**写回基准位。
  it('update_background：scale 更新但 alignment 偏移不变 → 保留既有位置（不覆盖视差/脚本位移）', () => {
    const { player } = makePlayer(1000, 600);
    const id = player.addBackground({
      origin: [500, 300, 0], size: [100, 50], scale: [1, 1, 1], sceneW: 1000, sceneH: 600,
    });
    const node = player.backgroundMeshForTest(id);
    node.position.set(12, -34, 5); // 已有位移（视差跟随或脚本写入）
    player.update_background(id, undefined, [2, 3, 1]);
    expect(node.scale.toArray()).toEqual([2, 3, 1]);
    expect(node.position.toArray()).toEqual([12, -34, 5]);
  });

  it('update_background：scale 使 alignment 偏移变化 → 只平移偏移差（既有位移量保留）', () => {
    const { player } = makePlayer(1000, 600);
    const id = player.addBackground({
      origin: [500, 300, 0], size: [100, 50], scale: [1, 1, 1],
      alignment: 'bottomright', sceneW: 1000, sceneH: 600,
    });
    const node = player.backgroundMeshForTest(id);
    expect(node.position.x).toBeCloseTo(-50, 6); // bottomright → (-w/2, +h/2)
    expect(node.position.y).toBeCloseTo(25, 6);
    node.position.x += 7;
    node.position.y -= 3;
    player.update_background(id, undefined, [2, 2, 1]);
    // scale×2 ⇒ 偏移 (-100, +50)，差 (-50, +25)：只叠加差值，脚本/视差位移保留。
    expect(node.position.x).toBeCloseTo(-50 + 7 - 50, 6);
    expect(node.position.y).toBeCloseTo(25 - 3 + 25, 6);
    // 同一 scale 再更新一次必须幂等：偏移差不得重复叠加。
    player.update_background(id, undefined, [2, 2, 1]);
    expect(node.position.x).toBeCloseTo(-50 + 7 - 50, 6);
    expect(node.position.y).toBeCloseTo(25 - 3 + 25, 6);
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

// renderOrder 唯一化（层序对齐 WE `m_objectsByRenderOrder`，lwe CScene.cpp:94-101/262-295）：
// 显式传入时生效；**不传时逐字保持原值**（背景 0 / 粒子 1），既有调用方不受影响。
describe('ThreeScenePlayer renderOrder 透传', () => {
  it('addBackground/addParticle：显式 renderOrder 生效，缺省仍是背景 0 / 粒子 1', () => {
    const { player } = makePlayer(1920, 1080);
    player.addBackground({
      origin: [960, 540, 0], size: [100, 100], scale: [1, 1, 1],
      sceneW: 1920, sceneH: 1080, renderOrder: 5,
    });
    player.addParticle(() => new Float32Array(0), { frameCount: 1, blend: 'alpha', renderOrder: 3 });
    expect(player.scene.children.map((c) => (c as THREE.Mesh).renderOrder)).toEqual([5, 3]);

    const d = makePlayer(1920, 1080);
    d.player.addBackground({
      origin: [960, 540, 0], size: [100, 100], scale: [1, 1, 1], sceneW: 1920, sceneH: 1080,
    });
    d.player.addParticle(() => new Float32Array(0), { frameCount: 1, blend: 'alpha' });
    expect(d.player.scene.children.map((c) => (c as THREE.Mesh).renderOrder)).toEqual([0, 1]);
  });
});

// Task 3：粒子图层（addParticle / updateParticles）。用 mock getter 提供 sim 顶点（每粒子
// [pos3,size,uv2,color3,alpha,rot3] 13 浮点，对应 wasm SceneParticleSim::build_instance_vertices），
// 验证 BufferGeometry（InstancedBufferGeometry）被正确填充、updateParticles 刷新 buffer、
// blend/softness 设到 ShaderMaterial。
describe('ThreeScenePlayer particle layer', () => {
  // 每粒子 [pos3, size, uv2, color3, alpha, rot3, vel3]（16 浮点，见 PARTICLE_FLOATS_PER_INSTANCE）。
  // helper 把平铺数组转 Float32Array。
  function makeVerts(...parts: number[][]): Float32Array {
    return new Float32Array(parts.flat());
  }

  // 2 粒子数据：
  //   p0: pos(1,2,3) size40 uv(0.625,0.5) color(0.5,0.6,0.7) alpha0.25 rot(0.1,0.2,0.75) vel(-0.5,-3000,0)
  //   p1: pos(-4,5,6) size20 uv(0.125,0.5) color(1,0,0) alpha0.5 rot(-0.3,0.4,-0.5) vel(12,-20,3)
  const dataA = makeVerts(
    [1, 2, 3, 40, 0.625, 0.5, 0.5, 0.6, 0.7, 0.25, 0.1, 0.2, 0.75, -0.5, -3000, 0],
    [-4, 5, 6, 20, 0.125, 0.5, 1, 0, 0, 0.5, -0.3, 0.4, -0.5, 12, -20, 3],
  );

  // 取 addParticle 后 scene 里的粒子 mesh（无背景时 scene.children[0]）。
  function particleMesh(player: ThreeScenePlayer): THREE.Mesh {
    const mesh = player.scene.children[0] as THREE.Mesh;
    expect(mesh).toBeInstanceOf(THREE.Mesh);
    return mesh;
  }

  it('addParticle：geometry 属性数/长度符合 sim 顶点（每粒子 [pos3,size,uv2,color3,alpha,rot3,vel3]）', () => {
    const { player } = makePlayer(1920, 1080);
    player.addParticle(() => dataA, { frameCount: 4, blend: 'additive', softness: 0.3 });
    const mesh = particleMesh(player);
    const geom = mesh.geometry as THREE.InstancedBufferGeometry;
    expect(geom).toBeInstanceOf(THREE.InstancedBufferGeometry);
    expect(geom.instanceCount).toBe(2);

    // 7 个 per-particle instanced 属性（position/size/uv/color/alpha/rot/velocity）。
    // 属性按**实例容量**预分配（不是按当前粒子数）——three 首帧锁存容量，必须一次给足（见
    // addParticle 的根因注释），故此处断言「容量 ≥ 当前粒子数 + 各属性长度 = count×itemSize」，
    // 而非旧实现的「长度恰为 粒子数×itemSize」。
    const pos = geom.getAttribute('particlePosition') as THREE.InstancedBufferAttribute;
    const size = geom.getAttribute('particleSize') as THREE.InstancedBufferAttribute;
    const uv = geom.getAttribute('particleUv') as THREE.InstancedBufferAttribute;
    const color = geom.getAttribute('particleColor') as THREE.InstancedBufferAttribute;
    const alpha = geom.getAttribute('particleAlpha') as THREE.InstancedBufferAttribute;
    const rot = geom.getAttribute('particleRot') as THREE.InstancedBufferAttribute;
    const vel = geom.getAttribute('particleVelocity') as THREE.InstancedBufferAttribute;
    expect(pos.count).toBeGreaterThanOrEqual(2);
    expect((pos.array as Float32Array).length).toBe(pos.count * 3);
    expect((size.array as Float32Array).length).toBe(size.count);
    expect((uv.array as Float32Array).length).toBe(uv.count * 2);
    expect((color.array as Float32Array).length).toBe(color.count * 3);
    expect((alpha.array as Float32Array).length).toBe(alpha.count);
    expect((rot.array as Float32Array).length).toBe(rot.count * 3);
    expect(vel).toBeDefined();
    expect(vel.itemSize).toBe(3);
    expect((vel.array as Float32Array).length).toBe(vel.count * 3);

    // 数据写回：p0 pos=(1,2,3)、size=40、uv=(0.625,0.5)、color=(0.5,0.6,0.7)、alpha=0.25、rot=0.75。
    expect(Array.from(pos.array as Float32Array).slice(0, 3)).toEqual([1, 2, 3]);
    expect((size.array as Float32Array)[0]).toBe(40);
    expect(Array.from(uv.array as Float32Array).slice(0, 2)).toEqual([0.625, 0.5]);
    // F4：欧拉角**三分量**进入独立 instanced 属性（顶点 shader 据此构造 quad 基向量）。
    // Float32 精度：0.1/0.2/0.3/0.4 不可精确表示，故逐分量 closeTo。
    const rotArr = rot.array as Float32Array;
    const expect3 = (off: number, x: number, y: number, z: number) => {
      expect(rotArr[off]).toBeCloseTo(x, 6);
      expect(rotArr[off + 1]).toBeCloseTo(y, 6);
      expect(rotArr[off + 2]).toBeCloseTo(z, 6);
    };
    expect3(0, 0.1, 0.2, 0.75);
    expect3(3, -0.3, 0.4, -0.5);
    // Float32 精度：0.5/0.625 可精确，0.6/0.7 需 closeTo。
    const col0 = Array.from(color.array as Float32Array).slice(0, 3);
    expect(col0[0]).toBeCloseTo(0.5, 6);
    expect(col0[1]).toBeCloseTo(0.6, 6);
    expect(col0[2]).toBeCloseTo(0.7, 6);
    expect((alpha.array as Float32Array)[0]).toBe(0.25);
    // vel3（spritetrail 拉伸方向的数据源，2026-09-26）：来自 sim 顶点末 3 浮点。
    const velArr = vel.array as Float32Array;
    expect(velArr[0]).toBeCloseTo(-0.5, 6);
    expect(velArr[1]).toBe(-3000);
    expect(velArr[2]).toBe(0);
    expect(velArr[3]).toBe(12);
    expect(velArr[4]).toBe(-20);
    expect(velArr[5]).toBe(3);
    // p1：pos=(-4,5,6)、size=20。
    expect(Array.from(pos.array as Float32Array).slice(3, 6)).toEqual([-4, 5, 6]);
    expect((size.array as Float32Array)[1]).toBe(20);
  });

  it('粒子顶点契约：每粒子 16 浮点（13 + vel3），与 wasm build_instance_vertices 同步', () => {
    expect(PARTICLE_FLOATS_PER_INSTANCE).toBe(16);
  });

  // spritetrail（2026-09-26）：Wallpaper Engine 的雨丝/风痕靠 `renderer[0].name == "spritetrail"`
  // 沿速度方向拉伸 billboard 呈现（WE `common_particles.h` 的 ComputeParticleTrailTangents）。
  // 此前只解析不消费 → Spider Man 4K 的雨退化成 3.8px 方点、肉眼不可见。
  it('specRenderer：解析 spec.renderer[0] —— spritetrail 取 length/maxlength/minlength；sprite/缺省/非法 → 不启用拖尾', () => {
    expect(specRenderer(JSON.stringify({ renderer: [{ name: 'spritetrail', length: 0.005, maxlength: 100 }] })))
      .toEqual({ kind: 'spritetrail', length: 0.005, maxLength: 100, minLength: 0 });
    expect(specRenderer(JSON.stringify({ renderer: [{ name: 'spritetrail', length: 0.01, maxlength: 2, minlength: 0.5 }] })))
      .toEqual({ kind: 'spritetrail', length: 0.01, maxLength: 2, minLength: 0.5 });
    // 缺省值与 wasm `parse_particle_spec` 一致，并与 WE/lwe/OWE 口径相同
    // （length 0.05 / maxlength 10 / minlength 0）—— 曾用 1.0/1.0 会让缺 maxlength 的预设没拖尾。
    expect(specRenderer(JSON.stringify({ renderer: [{ name: 'spritetrail' }] })))
      .toEqual({ kind: 'spritetrail', length: 0.05, maxLength: 10, minLength: 0 });
    expect(specRenderer(JSON.stringify({ renderer: [{ name: 'sprite' }] })).kind).toBe('sprite');
    // rope/ropetrail 与 wasm 侧一致地走 sprite 兜底（不白屏）。
    expect(specRenderer(JSON.stringify({ renderer: [{ name: 'rope', subdivision: 4 }] })).kind).toBe('sprite');
    expect(specRenderer('{}').kind).toBe('sprite');
    expect(specRenderer('').kind).toBe('sprite');
  });

  it('addParticle：trail 选项 → 拖尾 uniform（参数 + 纹理高宽比）；未传 → 不启用（sprite 外观零回归）', () => {
    const { player } = makePlayer(1920, 1080);
    // 32×128 的雨滴纹理：textureRatio = 128/32 = 4（WE `g_Texture0Resolution.y / .x`）。
    const dropTex = new THREE.DataTexture(new Uint8Array(32 * 128 * 4), 32, 128);
    player.addParticle(() => dataA, {
      frameCount: 1, blend: 'additive', tex: dropTex,
      trail: { length: 0.005, maxLength: 100, minLength: 0 },
    });
    const mat = particleMesh(player).material as THREE.ShaderMaterial;
    expect(mat.uniforms.trailEnabled.value).toBe(1);
    expect(mat.uniforms.trailParams.value.x).toBeCloseTo(0.005, 6);
    expect(mat.uniforms.trailParams.value.y).toBe(100);
    expect(mat.uniforms.trailParams.value.z).toBe(0);
    expect(mat.uniforms.texelRatio.value).toBeCloseTo(4, 6);

    // 无 trail（既有全部壁纸）→ trailEnabled=0，顶点 shader 走原旋转分支（外观与今天逐像素一致）。
    const p2 = makePlayer(1920, 1080);
    p2.player.addParticle(() => dataA, { frameCount: 1, blend: 'additive' });
    const mat2 = particleMesh(p2.player).material as THREE.ShaderMaterial;
    expect(mat2.uniforms.trailEnabled.value).toBe(0);
  });

  // 2026-10-08：用户桌面录屏 163 帧（5.4s）在 3660373677 的 26 个 Szikra 坐标上**没有任何白团**
  // （逐帧「中心亮 vs 环带」判据全为 0），而本插件会渲染出大白柔光斑 ⇒ 按观测对齐：跳过这类
  // 「稀疏事件源」粒子。条件收窄到三条同时成立，全库只命中该壁纸的 26 个对象。
  it('specSparseEventSource：仅「eventspawn 子粒子 + maxcount≤1 + rate<1」判定为桌面不渲染', () => {
    // 3660373677 的 spark.json（实测桌面无此光斑）
    expect(specSparseEventSource(JSON.stringify({ children: [{ type: 'eventspawn' }], maxcount: 1, emitter: [{ rate: 0.2 }] }))).toBe(true);
    // GTR 的流星（eventfollow + maxcount 16）→ 不受影响
    expect(specSparseEventSource(JSON.stringify({ children: [{ type: 'eventfollow' }], maxcount: 16, emitter: [{ rate: 0.2 }] }))).toBe(false);
    // Crimson Horizon 的流星（eventfollow ×2 + maxcount 100 + rate 6）→ 不受影响
    expect(specSparseEventSource(JSON.stringify({ children: [{ type: 'eventfollow' }, { type: 'eventfollow' }], maxcount: 100, emitter: [{ rate: 6 }] }))).toBe(false);
    // eventspawn 但池子/速率正常 → 不抑制
    expect(specSparseEventSource(JSON.stringify({ children: [{ type: 'eventspawn' }], maxcount: 50, emitter: [{ rate: 10 }] }))).toBe(false);
    expect(specSparseEventSource(JSON.stringify({ children: [{ type: 'eventspawn' }], maxcount: 1, emitter: [{ rate: 10 }] }))).toBe(false);
    expect(specSparseEventSource('{}')).toBe(false);
    expect(specSparseEventSource('')).toBe(false);
    expect(specSparseEventSource('not json')).toBe(false);
  });

  it('specPerspective：spec.flags 的 perspective 位（bit2 = 4）→ 该粒子对象改用透视相机', () => {
    expect(specPerspective('{"flags":4}')).toBe(true);
    expect(specPerspective('{"flags":6}')).toBe(true); // 位 2 + 位 1（3790775478 的 ash.json）
    expect(specPerspective('{"flags":"4"}')).toBe(true);
    expect(specPerspective('{"flags":0}')).toBe(false);
    expect(specPerspective('{}')).toBe(false);
    expect(specPerspective('')).toBe(false);
    expect(specPerspective('not json')).toBe(false);
  });

  // WE 的透视相机（正交场景内）：position.z = distance，fov 取 perspectiveoverridefov（>0 时）
  // 否则按固定 1000 距离反算；distance = 高 / (2·tan(fov/2))（OWE Algorism.cpp:8-17）。
  it('particlePerspectiveCamera：对齐 WE 的 CalculatePersperctiveDistance / Fov', () => {
    const p90 = particlePerspectiveCamera({ fov: 50, perspectiveOverrideFov: 90, sceneH: 2160 });
    expect(p90.fov).toBe(90);
    expect(p90.distance).toBeCloseTo(1080, 9); // 2160 / (2·tan45°)（浮点，故 closeTo）
    const auto = particlePerspectiveCamera({ fov: 50, perspectiveOverrideFov: 0, sceneH: 2160 });
    expect(auto.distance).toBe(1000);
    expect(auto.fov).toBeCloseTo((2 * Math.atan(2160 / 1000 / 2) * 180) / Math.PI, 6);
    const small = particlePerspectiveCamera({ fov: 50, perspectiveOverrideFov: 0, sceneH: 1080 });
    expect(small.distance).toBe(1000);
    expect(small.fov).toBeCloseTo((2 * Math.atan(1080 / 1000 / 2) * 180) / Math.PI, 6);
  });

  it('addParticle：perspective 选项 → 透视投影 uniform（矩阵 + 相机眼位）；未传 → 关闭（正交零回归）', () => {
    const { player } = makePlayer(1920, 1080);
    player.addParticle(() => dataA, {
      frameCount: 1, blend: 'additive',
      perspective: { fov: 90, distance: 1080, aspect: 3840 / 2160 },
    });
    const mat = particleMesh(player).material as THREE.ShaderMaterial;
    expect(mat.uniforms.perspEnabled.value).toBe(1);
    expect(mat.uniforms.persp.value).toBeInstanceOf(THREE.Matrix4);
    expect(mat.uniforms.perspEye.value.z).toBe(1080);
    // 透视矩阵的 m[11]（透视项）非 0；正交投影矩阵该位恒 0。
    expect((mat.uniforms.persp.value as THREE.Matrix4).elements[11]).not.toBe(0);

    const p2 = makePlayer(1920, 1080);
    p2.player.addParticle(() => dataA, { frameCount: 1, blend: 'additive' });
    const mat2 = particleMesh(p2.player).material as THREE.ShaderMaterial;
    expect(mat2.uniforms.perspEnabled.value).toBe(0);
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
      [7, 8, 9, 50, 0.875, 0.5, 0.1, 0.2, 0.3, 0.9, 0.1, 0, 0.25, 0, -100, 0],
      [10, 11, 12, 30, 0.375, 0.5, 0.4, 0.5, 0.6, 0.6, 0, 0.2, 1.5, 5, 0, 0],
      [-1, -2, -3, 15, 0.125, 0.5, 0.7, 0.8, 0.9, 0.1, -0.4, 0, -2.25, 0, 0, -7],
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
    verts = makeVerts(...Array.from({ length: 50 }, (_, i) => [i, i, 0, 40, 0.625, 0.5, 1, 1, 1, 1, 0, 0, 0, 0, -50, 0]));
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
    verts = makeVerts(...Array.from({ length: 30 }, (_, i) => [i, i, 0, 40, 0.625, 0.5, 1, 1, 1, 1, 0, 0, 0, 0, -50, 0]));
    player.updateParticles(1 / 60);
    expect(Math.min(geom.instanceCount, a.meshPerAttribute * a.count)).toBe(30);
  });

  it('addParticle：粒子数超出预分配容量 → 属性扩容**且**同步 three 锁存的 _maxInstanceCount', () => {
    const { player } = makePlayer(1920, 1080);
    let verts = new Float32Array(0);
    player.addParticle(() => verts, { frameCount: 4, blend: 'alpha', maxInstances: 2 });
    const geom = particleMesh(player).geometry as THREE.InstancedBufferGeometry;
    expect((geom as unknown as { _maxInstanceCount?: number })._maxInstanceCount).toBeUndefined(); // 未渲染过
    verts = makeVerts(...Array.from({ length: 5 }, (_, i) => [i, 0, 0, 10, 0.625, 0.5, 1, 1, 1, 1, 0, 0, 0, 0, -50, 0]));
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

  // 每粒子 [pos3, size, uv2, color3, alpha, rot3, vel3] 16 浮点（2 粒子），供 mock sim.vertices() 返回。
  const SIM_VERT = new Float32Array([
    1, 2, 3, 40, 0.625, 0.5, 0.5, 0.6, 0.7, 0.25, 0.1, 0.2, 0.75, 0, -3000, 0,
    -4, 5, 6, 20, 0.125, 0.5, 1, 0, 0, 0.5, -0.3, 0.4, -0.5, 10, 0, -5,
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

  // v0.8.2 F13：image 的 color/alignment 必须从 scene.json 下发到 addBackground
  //（color → 内容材质 tint，alignment → 锚点偏移；缺任一等于字段被静默忽略）。
  it('image 的 color/alignment 下发（tint + 锚点偏移）', () => {
    const canvas = document.createElement('canvas');
    const scene = JSON.stringify({
      general: { orthogonalprojection: { height: 600, width: 1000 } },
      objects: [{
        id: 13, image: 'models/a.json', origin: '500 300 0', scale: '1 1 1', size: '100 50',
        color: '0.5 0.25 0.125', alignment: 'bottomright', alpha: 0.5, brightness: 1,
      }],
    });
    const result = loadSceneToThree(
      scene, { renderer: createMockRenderer() as unknown as THREE.WebGLRenderer }, canvas,
    );
    const mesh = result.player.displayObject(13) as THREE.Mesh;
    expect(mesh.position.x).toBeCloseTo(-50, 6);
    expect(mesh.position.y).toBeCloseTo(25, 6);
    const mat = mesh.material as THREE.MeshBasicMaterial;
    expect(mat.color.r).toBeCloseTo(0.5, 6);
    expect(mat.color.g).toBeCloseTo(0.25, 6);
    expect(mat.color.b).toBeCloseTo(0.125, 6);
    expect(mat.opacity).toBeCloseTo(0.5, 6);
  });

  // 静态隐藏对象（scene.json visible:false）不装配：其纹理被装载过滤跳过，若仍建 quad 会渲染
  // 成无 map 的白色全屏层（2832263418 的 all_fg_still 覆盖背景）。
  it('visible:false 的 image 对象不装配（不产生无纹理白色 quad）', () => {
    const canvas = document.createElement('canvas');
    const scene = JSON.stringify({
      general: { orthogonalprojection: { height: 1080, width: 1920 } },
      objects: [
        { id: 13, image: 'models/a.json', origin: '960 540 0', scale: '1 1 1', size: '1920 1080', visible: true },
        { id: 115, image: 'models/b.json', origin: '960 540 0', scale: '1 1 1', size: '1920 1080', visible: false },
      ],
    });
    const result = loadSceneToThree(
      scene, { renderer: createMockRenderer() as unknown as THREE.WebGLRenderer }, canvas,
    );
    expect(result.backgroundIds).toHaveLength(1);
    expect(result.player.scene.children).toHaveLength(1);
    expect(result.player.displayObject(115)).toBeUndefined();
  });

  // Task 3 修复：renderer 装配期算好的 effective 可见性（对象形态 condition + 父链）随 SceneAssets
  // 下发，绘制链路必须优先用它；空 userProps 的旧判定会把 condition/父链结果覆盖掉。
  describe('effectiveVisible（condition + 父链）', () => {
    const tex = () => new THREE.DataTexture(new Uint8Array(4), 2, 2);
    const leonScene = JSON.stringify({
      general: { orthogonalprojection: { height: 1080, width: 1920 } },
      objects: [
        { id: 192, text: { value: 'A' }, origin: '960 540 0', scale: '1 1 1',
          visible: { user: { name: 'clock', condition: '1' }, value: true } },
        { id: 227, text: { value: 'B' }, origin: '960 540 0', scale: '1 1 1',
          visible: { user: { name: 'clock', condition: '2' }, value: false } },
      ],
    });
    const effectiveAt = (clock: string) =>
      computeEffectiveVisibility(parseSceneJson(leonScene).objects, { clock });

    it('clock=2：condition 命中的 227 建文本层（旧判定会按作者 value:false 丢弃）', () => {
      const result = loadSceneToThree(leonScene, {
        renderer: createMockRenderer() as unknown as THREE.WebGLRenderer,
        // renderer 在 clock=2 的装载结果：只给 227 建了文本层。
        textLayers: new Map([[227, { texture: tex(), size: [100, 50] as [number, number] }]]),
        effectiveVisible: effectiveAt('2'),
      }, document.createElement('canvas'));
      expect(result.player.displayObject(227)).toBeDefined();
      expect(result.backgroundIds).toHaveLength(1);
    });

    it('clock=1：condition 不命中的 227 不建层（只建 192）', () => {
      const result = loadSceneToThree(leonScene, {
        renderer: createMockRenderer() as unknown as THREE.WebGLRenderer,
        textLayers: new Map([[192, { texture: tex(), size: [100, 50] as [number, number] }]]),
        effectiveVisible: effectiveAt('1'),
      }, document.createElement('canvas'));
      expect(result.player.displayObject(192)).toBeDefined();
      expect(result.player.displayObject(227)).toBeUndefined();
      expect(result.backgroundIds).toHaveLength(1);
    });

    // 对照既有「visible:false 不建无纹理白色 quad」用例：父链继承隐藏同样必须在绘制链路生效。
    it('父链隐藏的 image 不建无纹理 quad（不产生白色全屏层）', () => {
      const scene = JSON.stringify({
        general: { orthogonalprojection: { height: 1080, width: 1920 } },
        objects: [
          { id: 20, text: { value: 'P' }, origin: '960 540 0', scale: '1 1 1', size: '400 100',
            visible: { user: { name: 'clock', condition: '1' }, value: true } },
          { id: 21, parent: 20, image: 'models/a.json', origin: '960 540 0', scale: '1 1 1', size: '100 100' },
          { id: 22, parent: 20, image: 'models/b.json', origin: '960 540 0', scale: '1 1 1', size: '100 100' },
        ],
      });
      const result = loadSceneToThree(scene, {
        renderer: createMockRenderer() as unknown as THREE.WebGLRenderer,
        // 装载期已按 effective 跳过隐藏父链 ⇒ 纹理表为空（旧链路会给 21/22 建无 map 的白 quad）。
        effectiveVisible: computeEffectiveVisibility(parseSceneJson(scene).objects, { clock: '2' }),
      }, document.createElement('canvas'));
      expect(result.backgroundIds).toHaveLength(0);
      expect(result.player.scene.children).toHaveLength(0);
    });
  });

  // renderOrder 唯一化：装配循环把 objects 数组下标作为 renderOrder 透传（WE 的绘制序 =
  // m_objectsByRenderOrder，即 scene.json objects 序）。被 `continue` 跳过的对象**不改变**下标。
  it('renderOrder = objects 数组下标（唯一；被跳过的对象不占位）', () => {
    const canvas = document.createElement('canvas');
    const scene = JSON.stringify({
      general: { orthogonalprojection: { height: 1080, width: 1920 } },
      objects: [
        { id: 13, image: 'models/a.json', origin: '960 540 0', scale: '1 1 1', size: '1920 1080' },
        // index 1：text 无 textLayers 条目 → 装配时 continue（下标仍是 1，不占 renderOrder）
        { id: 20, text: { value: 'x' }, origin: '960 540 0', scale: '1 1 1', size: '400 100' },
        { id: 22, particle: 'particles/presets/smoke2.json', origin: '5101 1089 0', scale: '1 1 1' },
        { id: 30, image: 'models/b.json', origin: '100 100 0', scale: '1 1 1', size: '100 100' },
      ],
    });
    const tex = () => new THREE.DataTexture(new Uint8Array(4), 2, 2);
    const assets = {
      renderer: createMockRenderer() as unknown as THREE.WebGLRenderer,
      backgroundTextures: new Map([[13, tex()], [30, tex()]]),
      particles: new Map([[22, { specJson: '{}', blend: 'alpha' as const }]]),
      createParticleSim: vi.fn(() => makeMockSim()),
    };
    const result = loadSceneToThree(scene, assets, canvas);
    expect(result.player.scene.children.map((c) => (c as THREE.Mesh).renderOrder)).toEqual([0, 2, 3]);
    // scene 对象 id → 显示对象的 renderOrder = 该对象的数组下标（唯一，互不相同）
    expect((result.player.displayObject(13) as THREE.Mesh).renderOrder).toBe(0);
    expect((result.player.displayObject(22) as THREE.Mesh).renderOrder).toBe(2);
    expect((result.player.displayObject(30) as THREE.Mesh).renderOrder).toBe(3);
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
    // 按 scene.json 对象 id 取显示对象：renderOrder 现在 = objects 数组下标，不再是「背景=0/粒子=1」的层标记。
    const bg = result.player.displayObject(13) as THREE.Mesh;
    expect(bg.rotation.z).toBeCloseTo(0.5, 6);
    // 粒子：objAngles uniform 收到同一份对象 angles。
    const part = result.player.displayObject(22) as THREE.Mesh;
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
    // 按对象 id 取显示对象：renderOrder 现在 = objects 数组下标，不能再当「背景层」的筛选条件
    // （四个对象的下标 0..3 恰好都曾是「背景」）。
    const meshes = [17, 246, 300, 301].map((id) => result.player.displayObject(id) as THREE.Mesh);
    expect(meshes).not.toContain(undefined); // 四个对象都进了 displayObjects（漏登记即假绿）
    expect(meshes.map((m) => m.renderOrder)).toEqual([0, 1, 2, 3]);
    // 这四个背景确实进了主场景（`meshes` 的 length 由 4 元素 map 决定，是恒真断言）。
    expect(result.player.scene.children).toHaveLength(4);

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

  it('colorBlendMode ≠ 0：内容材质不做对象 color tint（B = 内容原色）', () => {
    const canvas = document.createElement('canvas');
    const scene = JSON.stringify({
      general: { orthogonalprojection: { height: 1080, width: 1920 } },
      objects: [
        { id: 11, image: 'models/a.json', origin: '960 540 0', size: '1920 1080', color: '0 0.45882 1', colorBlendMode: 6 },
        { id: 12, image: 'models/b.json', origin: '960 540 0', size: '1920 1080', color: '0 0.45882 1' },
      ],
    });
    const tex = () => new THREE.DataTexture(new Uint8Array(4), 2, 2);
    const result = loadSceneToThree(
      scene,
      { renderer: createMockRenderer() as unknown as THREE.WebGLRenderer, backgroundTextures: new Map([[11, tex()], [12, tex()]]) },
      canvas,
    );
    // 11：colorBlendMode=6 → 追加混合 pass 的 B 用内容原色 ⇒ tint 白
    const tintA = (result.player.displayObject(11) as THREE.Mesh).material as THREE.ShaderMaterial;
    const tint = tintA.uniforms.tint.value as THREE.Vector3;
    expect([tint.x, tint.y, tint.z]).toEqual([1, 1, 1]);
    // 12：无 colorBlendMode → F13 color tint 照常生效（g = 0.45882 = 117/255，未乘 colorBlendMode 修正）
    const tintB = (result.player.displayObject(12) as THREE.Mesh).material as THREE.MeshBasicMaterial;
    expect(tintB.color.g).toBeCloseTo(0.45882, 3);
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

  it('loadSceneToThree：spec.flags 带 perspective 位 → 该粒子层启用透视投影；无该位 → 关闭', () => {
    const mk = (specJson: string) => {
      const canvas = document.createElement('canvas');
      const assets = {
        renderer: createMockRenderer() as unknown as THREE.WebGLRenderer,
        backgroundTextures: new Map([[13, new THREE.DataTexture(new Uint8Array(4), 2, 2)]]),
        particles: new Map([[71, { specJson, tex: new THREE.DataTexture(new Uint8Array(4), 512, 128), blend: 'alpha' as const }]]),
        createParticleSim: vi.fn(() => makeMockSim()),
      };
      const r = loadSceneToThree(BLACKMYTH_SCENE, assets, canvas);
      const mesh = r.player.scene.children.find(
        (c) => (c as THREE.Mesh).material instanceof THREE.ShaderMaterial,
      ) as THREE.Mesh;
      return (mesh.material as THREE.ShaderMaterial).uniforms;
    };
    // 3660373677 的雨、2851992662 的樱花等：flags=4 → 透视（相机眼位在 +z，即 WE 的 distance）。
    const persp = mk(JSON.stringify({ flags: 4, maxcount: 50, emitter: [{ rate: 20 }] }));
    expect(persp.perspEnabled.value).toBe(1);
    expect(persp.persp.value).toBeInstanceOf(THREE.Matrix4);
    expect(persp.perspEye.value.z).toBeGreaterThan(0);
    // 无 perspective 位（全库多数粒子）→ 保持正交投影（零回归）。
    const ortho = mk(JSON.stringify({ flags: 0, maxcount: 50, emitter: [{ rate: 20 }] }));
    expect(ortho.perspEnabled.value).toBe(0);
  });

  it('loadSceneToThree：稀疏事件源 spark 不建粒子层（桌面无此光斑）；普通粒子照常建层', () => {
    const mk = (specJson: string) => {
      const canvas = document.createElement('canvas');
      const assets = {
        renderer: createMockRenderer() as unknown as THREE.WebGLRenderer,
        backgroundTextures: new Map([[13, new THREE.DataTexture(new Uint8Array(4), 2, 2)]]),
        particles: new Map([[71, { specJson, tex: new THREE.DataTexture(new Uint8Array(4), 64, 64), blend: 'alpha' as const }]]),
        createParticleSim: vi.fn(() => makeMockSim()),
      };
      return loadSceneToThree(BLACKMYTH_SCENE, assets, canvas);
    };
    const sparkSpec = JSON.stringify({ children: [{ type: 'eventspawn' }], maxcount: 1, emitter: [{ rate: 0.2 }] });
    expect(mk(sparkSpec).particleLayers.length).toBe(0);
    expect(mk(JSON.stringify({ maxcount: 50, emitter: [{ rate: 20 }] })).particleLayers.length).toBe(1);
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

  // v0.8.2 F2：util 对象只渲染「带效果链（isolate 条目）」的层 —— 条目由 three-renderer 按
  // utilWorldSize 算好下发；无条目（无链）保持改动前的「不渲染」，不引入白块。
  it('util 对象：有 isolate 条目 → addBackground(util)；无条目 → 不渲染', () => {
    const scene = JSON.stringify({
      general: { orthogonalprojection: { height: 1080, width: 1920 } },
      objects: [
        {
          id: 58, image: 'models/util/projectlayer.json',
          origin: '960 540 0', scale: '1 1 1', size: '1920 1080',
          alpha: 1, color: '1 1 1', effects: [{ file: 'effects/w/effect.json' }],
        },
        { id: 37, image: 'models/util/composelayer.json', size: '400 850', origin: '200 200 0', scale: '1 1 1' },
      ],
    });
    const assets = {
      renderer: createMockRenderer() as unknown as THREE.WebGLRenderer,
      isolate: new Map([[58, { objectId: 58, rtWidth: 1920, rtHeight: 1080, worldW: 1920, worldH: 1080 }]]),
    };
    const result = loadSceneToThree(scene, assets, document.createElement('canvas'));
    expect(result.backgroundIds).toHaveLength(1);
    expect(result.player.isolatedObjects().map((o) => o.id)).toEqual([58]);
    expect(result.player.displayObject(58)).toBe(result.player.isolatedObjects()[0].quad);
    // 无链 util 层不建图层（与 v0.8.1 行为一致）。
    expect(result.player.displayObject(37)).toBeUndefined();
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
  // **未钳制世界尺寸**；RT 的像素尺寸只决定分辨率（= 世界 × dpr 收口），**不得**拿来当相机范围。
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

  // renderOrder 唯一化：隔离对象在主场景里的代表是**合成 quad**（内容 mesh 只进对象 RT），
  // 其 renderOrder 跟随宿主对象的数组下标；不传时仍是 kind 缺省（背景 0 / 粒子 1）。
  it('隔离合成 quad 的 renderOrder 由调用方透传（缺省仍按 kind）', () => {
    const { player } = makePlayer(1920, 1080);
    player.addBackground({
      origin: [960, 540, 0], size: [100, 100], scale: [1, 1, 1], texture: makeTexture(),
      sceneW: 1920, sceneH: 1080, objectId: 13, renderOrder: 7,
      isolate: { objectId: 13, rtWidth: 64, rtHeight: 64, worldW: 100, worldH: 100 },
    });
    player.addParticle(() => new Float32Array(0), {
      frameCount: 1, blend: 'alpha', objectId: 71, renderOrder: 9,
      isolate: { objectId: 71, rtWidth: 64, rtHeight: 64, worldW: 100, worldH: 100 },
    });
    expect(player.isolatedObjects().find((e) => e.id === 13)!.quad.renderOrder).toBe(7);
    expect(player.isolatedObjects().find((e) => e.id === 71)!.quad.renderOrder).toBe(9);

    // 不传 renderOrder：背景 quad 0、粒子 quad 1（与改动前逐字相同）
    const d = makePlayer(1920, 1080);
    d.player.addBackground({
      origin: [960, 540, 0], size: [100, 100], scale: [1, 1, 1], texture: makeTexture(),
      sceneW: 1920, sceneH: 1080, objectId: 14,
      isolate: { objectId: 14, rtWidth: 64, rtHeight: 64, worldW: 100, worldH: 100 },
    });
    d.player.addParticle(() => new Float32Array(0), {
      frameCount: 1, blend: 'alpha', objectId: 72,
      isolate: { objectId: 72, rtWidth: 64, rtHeight: 64, worldW: 100, worldH: 100 },
    });
    expect(d.player.isolatedObjects().find((e) => e.id === 14)!.quad.renderOrder).toBe(0);
    expect(d.player.isolatedObjects().find((e) => e.id === 72)!.quad.renderOrder).toBe(1);
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

  // MSAA 分型（Task 7）：只有 `kind === 'background'` 且**两轴都**盖满场景（≥ 0.98×）的对象才是
  // 「一整块铺满 RT 的 quad」——这种对象 RT 内没有任何轮廓边，MSAA 结构性无效，关掉省 24 B/px；
  // 粒子 billboard 即使铺满整屏也**有硬边**，必须保留 MSAA（故判定必须同时要求 background）。
  it('铺满整屏的 background 关 MSAA（samples=0），未铺满的 background 仍为 4', () => {
    const { player } = makePlayer(5000, 2400);
    player.setSceneSize(5000, 2400);
    // ① 两轴都盖满 → 满屏 quad → samples 0
    player.addBackground({
      origin: [2500, 1200, 0], size: [5000, 2400], scale: [1, 1, 1], texture: makeTexture(),
      sceneW: 5000, sceneH: 2400,
      isolate: { objectId: 13, rtWidth: 4096, rtHeight: 1966, worldW: 5000, worldH: 2400 },
    });
    // ② 满宽但不满高（单轴达标不算满屏）→ 4
    player.addBackground({
      origin: [2500, 540, 0], size: [5000, 1080], scale: [1, 1, 1], texture: makeTexture(),
      sceneW: 5000, sceneH: 2400,
      isolate: { objectId: 246, rtWidth: 4096, rtHeight: 884, worldW: 5000, worldH: 1080 },
    });
    // ③ 贴片（两轴都不达标）→ 4
    player.addBackground({
      origin: [960, 540, 0], size: [1920, 1080], scale: [1, 1, 1], texture: makeTexture(),
      sceneW: 5000, sceneH: 2400,
      isolate: { objectId: 247, rtWidth: 1920, rtHeight: 1080, worldW: 1920, worldH: 1080 },
    });
    const samples = (id: number) => player.isolatedObjects().find((e) => e.id === id)!.rt.samples;
    expect([samples(13), samples(246), samples(247)]).toEqual([0, 4, 4]);
    // 尺寸未被本改动动到：RT 像素 = 调用方下发的口径，逐字透传（只升不降）。
    const full = player.isolatedObjects().find((e) => e.id === 13)!;
    expect([full.rtWidth, full.rtHeight]).toEqual([4096, 1966]);
  });

  // R20：粒子即使铺满整屏也保留 MSAA —— 满屏判定里的 `kind === 'background'` 是硬条件。
  it('铺满整屏的 particle 仍开 MSAA（samples=4，billboard 有硬边）', () => {
    const { player } = makePlayer(5000, 2400);
    player.setSceneSize(5000, 2400);
    player.addParticle(() => new Float32Array(0), {
      frameCount: 1, blend: 'alpha', objectCenter: [0, 0, 0],
      isolate: { objectId: 71, rtWidth: 4096, rtHeight: 1966, worldW: 5000, worldH: 2400 },
    });
    const entry = player.isolatedObjects().find((e) => e.id === 71)!;
    expect(entry.kind).toBe('particle');
    expect(entry.rt.samples).toBe(4);
  });

  // 合成 mipmap（Task 7）：RT 可能大于屏占位（源纹理收口 4096 的结果）⇒ 合成那一步是**缩小采样**，
  // 不生成 mip 会高频走样/闪烁。
  it('RT 大于屏占位时开合成 mipmap（generateMipmaps + LinearMipmapLinearFilter）', () => {
    // dpr=2 ⇒ 屏幕密度 2：对象世界 1920×1080 的屏占位长边 = 3840 < RT 长边 4096。
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
    try {
      const { player } = makePlayer(5000, 2400);
      player.setSceneSize(5000, 2400);
      expect(player.screenScalePx()).toBe(2);
      player.addBackground({
        origin: [960, 540, 0], size: [1920, 1080], scale: [1, 1, 1], texture: makeTexture(),
        sceneW: 5000, sceneH: 2400,
        isolate: { objectId: 13, rtWidth: 4096, rtHeight: 2304, worldW: 1920, worldH: 1080 },
      });
      const rt = player.isolatedObjects().find((e) => e.id === 13)!.rt;
      expect(rt.texture.generateMipmaps).toBe(true);
      expect(rt.texture.minFilter).toBe(THREE.LinearMipmapLinearFilter);
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 });
    }
  });

  it('RT 不大于屏占位时不开 mipmap（保持 three 的既有无 mip 行为）', () => {
    // dpr=2 ⇒ 满屏对象屏占位长边 = 10000 > RT 长边 4096（已顶硬上限、放大不上去）⇒ 不是缩小采样。
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
    try {
      const { player } = makePlayer(5000, 2400);
      player.setSceneSize(5000, 2400);
      player.addBackground({
        origin: [2500, 1200, 0], size: [5000, 2400], scale: [1, 1, 1], texture: makeTexture(),
        sceneW: 5000, sceneH: 2400,
        isolate: { objectId: 13, rtWidth: 4096, rtHeight: 1966, worldW: 5000, worldH: 2400 },
      });
      const rt = player.isolatedObjects().find((e) => e.id === 13)!.rt;
      expect(rt.texture.generateMipmaps).toBe(false);
      expect(rt.texture.minFilter).toBe(THREE.LinearFilter);
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 });
    }
  });

  // ⚠️ 回归（Fix round 1，正确性）：合成采样标志不能只在挂载期算一次 —— resize 只改变屏占位，
  // RT 的**像素尺寸可能不变**（源纹理收口口径下 4096 长期顶着上限）⇒ 缩小关系会反转，必须重估。
  // 反例：4K 视口挂载时屏占位长边 5000 ≥ RT 4096 ⇒ 关 mip；窗口缩到 1280×720 后屏占位长边只剩
  // 1500、RT 仍是 4096 ⇒ 合成已是 2.7× 缩小采样却无 mip ⇒ 走样被 resize 重新制造出来。
  it('resize 后 RT 相对屏占位变成缩小采样 ⇒ 重估出 mipmap（generateMipmaps + LinearMipmapLinearFilter）', () => {
    const { player } = makePlayer(5000, 2400);
    player.setSceneSize(5000, 2400);
    player.addBackground({
      origin: [2500, 1200, 0], size: [5000, 2400], scale: [1, 1, 1], texture: makeTexture(),
      sceneW: 5000, sceneH: 2400,
      isolate: { objectId: 13, rtWidth: 4096, rtHeight: 1966, worldW: 5000, worldH: 2400 },
    });
    const entry = player.isolatedObjects().find((e) => e.id === 13)!;
    // 挂载期：视口 = 场景（dpr=1）⇒ 屏占位长边 5000 > RT 长边 4096 ⇒ 不是缩小采样。
    expect(player.screenScalePx()).toBe(1);
    expect(entry.rt.texture.generateMipmaps).toBe(false);
    // 窗口缩到 1280×720 ⇒ 屏占位长边 = 5000 × 720/2400 = 1500 < 4096 ⇒ 反转成缩小采样。
    player.resize(1280, 720);
    expect(player.screenScalePx()).toBeCloseTo(0.3, 10);
    // ⚠️ 生产路径的重估点：窗口 resize 走 player.resize（three-renderer 的 onWindowResize），
    // 而效果链编排器在「RT 像素尺寸未变」时会跳过 resizeObjectRT ⇒ 这里必须已经反转。
    expect(entry.rt.texture.generateMipmaps).toBe(true);
    expect(entry.rt.texture.minFilter).toBe(THREE.LinearMipmapLinearFilter);
    // 直接调 resizeObjectRT（即使尺寸与挂载期**相同**，尺寸口径未变）也必须幂等重估。
    player.resizeObjectRT(13, 4096, 1966);
    expect([entry.rtWidth, entry.rtHeight]).toEqual([4096, 1966]);
    expect(entry.rt.texture.generateMipmaps).toBe(true);
    expect(entry.rt.texture.minFilter).toBe(THREE.LinearMipmapLinearFilter);
  });

  // 反方向：挂载期是缩小采样（开 mip），窗口放大后 RT 不再大于屏占位 ⇒ 必须重估回无 mip
  // （否则白付 mipmap 生成开销与显存）。
  it('resize 后 RT 不再相对屏占位缩小 ⇒ 重估回无 mip（generateMipmaps=false + LinearFilter）', () => {
    const { player } = makePlayer(5000, 2400);
    player.setSceneSize(5000, 2400);
    // 先在 1280×720 的小窗口挂载：屏占位长边 1500 < RT 4096 ⇒ 缩小采样。
    player.resize(1280, 720);
    player.addBackground({
      origin: [2500, 1200, 0], size: [5000, 2400], scale: [1, 1, 1], texture: makeTexture(),
      sceneW: 5000, sceneH: 2400,
      isolate: { objectId: 13, rtWidth: 4096, rtHeight: 1966, worldW: 5000, worldH: 2400 },
    });
    const entry = player.isolatedObjects().find((e) => e.id === 13)!;
    expect(entry.rt.texture.generateMipmaps).toBe(true);
    expect(entry.rt.texture.minFilter).toBe(THREE.LinearMipmapLinearFilter);
    // 窗口放大到 3840×2160 ⇒ 屏占位长边 = 5000 × 0.9 = 4500 > RT 4096 ⇒ 不再缩小。
    player.resize(3840, 2160);
    expect(player.screenScalePx()).toBeCloseTo(0.9, 10);
    // 同上：重估点在 player.resize（生产路径不会调用 resizeObjectRT，尺寸没变）。
    expect(entry.rt.texture.generateMipmaps).toBe(false);
    expect(entry.rt.texture.minFilter).toBe(THREE.LinearFilter);
    player.resizeObjectRT(13, 4096, 1966);
    expect(entry.rt.texture.generateMipmaps).toBe(false);
    expect(entry.rt.texture.minFilter).toBe(THREE.LinearFilter);
  });

  // ⚠️ 回归（Fix round 2，真实渲染器）：只写 rt.texture.minFilter 到不了 GL —— 采样参数**只在**
  // setupRenderTarget 下发（`setTexture2D` 对 isRenderTargetTexture 整段跳过，needsUpdate 无效），
  // 而它只在初次使用或 dispose 后重建。故判定翻转必须 dispose 让下次 setRenderTarget 重下发。
  it('采样判定翻转（RT 像素尺寸不变）时 dispose 隔离 RT，让 minFilter 真正下发', () => {
    const { player } = makePlayer(5000, 2400);
    player.setSceneSize(5000, 2400);
    player.addBackground({
      origin: [2500, 1200, 0], size: [5000, 2400], scale: [1, 1, 1], texture: makeTexture(),
      sceneW: 5000, sceneH: 2400,
      isolate: { objectId: 13, rtWidth: 4096, rtHeight: 1966, worldW: 5000, worldH: 2400 },
    });
    const entry = player.isolatedObjects().find((e) => e.id === 13)!;
    // 视口 = 场景（dpr=1）⇒ 屏占位长边 5000 > RT 4096 ⇒ 挂载期不缩小：无 mip。
    expect(entry.rt.texture.minFilter).toBe(THREE.LinearFilter);
    // spy 是 mock 下唯一可观测的「到 GL」代理：dispose ⇒ 下次 setRenderTarget 重跑 setupRenderTarget。
    const rtDispose = vi.spyOn(entry.rt, 'dispose');
    // 窗口缩到 1280×720 ⇒ 屏占位长边 1500 < 4096 ⇒ 翻转成缩小采样，RT 像素尺寸逐值不变。
    player.resize(1280, 720);
    expect([entry.rt.width, entry.rt.height]).toEqual([4096, 1966]);
    expect(entry.rt.texture.minFilter).toBe(THREE.LinearMipmapLinearFilter);
    expect(rtDispose).toHaveBeenCalledTimes(1);
    // 同一判定再缩一次窗口：无翻转 ⇒ 不得再 dispose（否则等于每帧重建 RT）。
    player.resize(1024, 576);
    expect(entry.rt.texture.minFilter).toBe(THREE.LinearMipmapLinearFilter);
    expect(rtDispose).toHaveBeenCalledTimes(1);
  });

  it('采样判定未翻转时不得 dispose 隔离 RT（防每帧重建）', () => {
    const { player } = makePlayer(5120, 2880);
    player.setSceneSize(5000, 2400);
    // 满屏对象：RT 长边 4096 顶住硬上限，屏占位长边按 cover 口径随视口变化。
    player.addBackground({
      origin: [2500, 1200, 0], size: [5000, 2400], scale: [1, 1, 1], texture: makeTexture(),
      sceneW: 5000, sceneH: 2400,
      isolate: { objectId: 13, rtWidth: 4096, rtHeight: 1966, worldW: 5000, worldH: 2400 },
    });
    const entry = player.isolatedObjects().find((e) => e.id === 13)!;
    const minifying = () => 4096 > 5000 * player.screenScalePx() + 0.5;
    // 两档视口的判定必须落在「同一侧且不缩小」，才谈得上「未翻转」。
    expect(minifying()).toBe(false);
    player.resize(3840, 2160);
    expect(minifying()).toBe(false);
    // 判定未翻转 ⇒ 不得 dispose（dispose 会让渲染器下一帧重建 RT）。
    const rtDispose = vi.spyOn(entry.rt, 'dispose');
    expect(entry.rt.texture.minFilter).toBe(THREE.LinearFilter);
    player.resize(5120, 2880);
    expect(minifying()).toBe(false);
    expect(entry.rt.texture.minFilter).toBe(THREE.LinearFilter);
    expect(rtDispose).not.toHaveBeenCalled();
    player.resizeObjectRT(13, 4096, 1966);
    expect(entry.rt.texture.minFilter).toBe(THREE.LinearFilter);
    expect(rtDispose).not.toHaveBeenCalled();
  });

  // v0.8.2 F2：util 层无 pkg 纹理（models/util/*.json 是引擎内置材质）⇒ addBackground 走内置材质；
  // 有 isolate 条目时与 image 同路径（内容进 localScene + 主场景合成 quad）。
  it('addBackground(util) 无 pkg 纹理时用内置材质建 mesh 并返回合成 quad', () => {
    const { player } = makePlayer(3840, 2160);
    const id = player.addBackground({
      objectId: 58, util: 'project', size: [3840, 2160], scale: [1, 1, 1], origin: [1920, 1080, 0],
      sceneW: 3840, sceneH: 2160,
      isolate: { objectId: 58, rtWidth: 3840, rtHeight: 2160, worldW: 3840, worldH: 2160 },
    });
    // 返回值仍是背景图层计数器 id；隔离条目的键 = scene.json 对象 id。
    expect(typeof id).toBe('number');
    const iso = player.isolatedObjects();
    expect(iso).toHaveLength(1);
    const entry = iso[0];
    expect(entry.id).toBe(58);
    expect(player.scene.children).toContain(entry.quad);
    expect(entry.localScene.children).toHaveLength(1);
    const content = entry.localScene.children[0] as THREE.Mesh;
    expect(content).toBeInstanceOf(THREE.Mesh);
    expect(content.material).toBeInstanceOf(THREE.MeshBasicMaterial);
    const mat = content.material as THREE.MeshBasicMaterial;
    expect(mat.map).toBeNull();
    // passthrough：白色直通占位、透明（内容由效果链/快照覆盖，首帧不得白屏）
    expect(mat.transparent).toBe(true);
    expect(mat.opacity).toBe(0);
    expect(mat.color.getHexString()).toBe('ffffff');
    expect(mat.side).toBe(THREE.DoubleSide);
    expect(entry.worldW).toBe(3840);
    expect(entry.worldH).toBe(2160);
    expect(entry.localCamera.right - entry.localCamera.left).toBeCloseTo(3840, 5);
    expect(entry.localCamera.bottom - entry.localCamera.top).toBeCloseTo(2160, 5);
    // 脚本/帧消费者按对象 id 找到的是合成 quad（不是 RT 内的内容 mesh）。
    expect(player.displayObject(58)).toBe(entry.quad);
  });

  it('addBackground(util solid) → 纯色材质（color 0-255 × brightness、opacity = alpha）', () => {
    const { player } = makePlayer(1920, 1080);
    player.addBackground({
      objectId: 327, util: 'solid', size: [1000, 1000], scale: [0.87, -0.98, 0.1],
      origin: [500, 500, 0], color: [100, 50, 25], alpha: 0.5, brightness: 2,
      sceneW: 1920, sceneH: 1080,
    });
    const mesh = player.displayObject(327) as THREE.Mesh;
    expect(mesh).toBeInstanceOf(THREE.Mesh);
    const mat = mesh.material as THREE.MeshBasicMaterial;
    expect(mat.transparent).toBe(true);
    expect(mat.opacity).toBeCloseTo(0.5, 6);
    // color = 0-255/255 × brightness（>1 由 materialModulation clamp）
    expect(mat.color.r).toBeCloseTo(200 / 255, 6);
    expect(mat.color.g).toBeCloseTo(100 / 255, 6);
    expect(mat.color.b).toBeCloseTo(50 / 255, 6);
    // 纯色层比例保留：scale 烘进 mesh.scale（几何 = scene.json size）。
    expect(mesh.scale.toArray()).toEqual([0.87, -0.98, 0.1]);
    expect(player.isolatedObjects()).toHaveLength(0);
  });

  it('addBackground(util fullscreen) 缺 size → 内容 quad 回退整场景尺寸（2597392171 形态）', () => {
    const { player } = makePlayer(3840, 6000);
    player.addBackground({
      objectId: 54, util: 'fullscreen', scale: [1, 1, 1], origin: [0, 0, 0],
      sceneW: 3840, sceneH: 6000,
      isolate: { objectId: 54, rtWidth: 1920, rtHeight: 3000, worldW: 3840, worldH: 6000 },
    });
    const entry = player.isolatedObjects()[0];
    const content = entry.localScene.children[0] as THREE.Mesh;
    const geo = content.geometry as THREE.PlaneGeometry;
    expect(geo.parameters.width).toBe(3840);
    expect(geo.parameters.height).toBe(6000);
    // 隔离内容中心/旋转归零（位移/旋转交给合成 quad）。
    expect(content.position.toArray()).toEqual([0, 0, 0]);
  });

  // v0.8.2 Fix round 1（Critical 1）：全屏 util 层的 WE 语义 = 铺满视口。2597392171 #54 无
  // origin/size/scale（缺省 [0,0,0]）⇒ 旧实现把合成 quad 放在场景左下四分之一。
  it('全屏 util（2597392171 形态）合成 quad 居中并覆盖整场景', () => {
    const scene = JSON.stringify({
      general: { orthogonalprojection: { height: 6000, width: 3840 } },
      objects: [{ id: 54, image: 'models/util/fullscreenlayer.json', effects: [{ file: 'effects/w/effect.json' }] }],
    });
    const assets = {
      renderer: createMockRenderer() as unknown as THREE.WebGLRenderer,
      isolate: new Map([[54, { objectId: 54, rtWidth: 1920, rtHeight: 3000, worldW: 3840, worldH: 6000 }]]),
    };
    const result = loadSceneToThree(scene, assets, document.createElement('canvas'));
    const entry = result.player.isolatedObjects()[0];
    const quad = entry.quad;
    // 世界位置 = 场景中心（we_to_three 的 0,0），不是 (-sceneW/2, -sceneH/2)。
    expect(quad.position.toArray()).toEqual([0, 0, 0]);
    // 覆盖整场景：quad 几何与世界尺寸都 = 3840×6000；内容 mesh 与 world 同尺寸（铺满局部相机）。
    const qgeo = quad.geometry as THREE.PlaneGeometry;
    expect([qgeo.parameters.width, qgeo.parameters.height]).toEqual([3840, 6000]);
    expect([entry.worldW, entry.worldH]).toEqual([3840, 6000]);
    const content = entry.localScene.children[0] as THREE.Mesh;
    const cgeo = content.geometry as THREE.PlaneGeometry;
    expect([cgeo.parameters.width, cgeo.parameters.height]).toEqual([3840, 6000]);
    expect(result.player.displayObject(54)).toBe(quad);
  });

  // v0.8.2 Fix round 1（Important 3）：util 对象 alpha 必须作用到合成输出。3789452668 #327 alpha=0、
  // 效果链（audioline）自产 alpha ⇒ 只在内容占位上收口会在静音时画出可见横线。
  it('util 隔离合成的 quad 应用对象 alpha（alpha=0 不可见；效果输出同样受限）', () => {
    const { player } = makePlayer(3840, 2160);
    player.addBackground({
      objectId: 327, util: 'solid', size: [1000, 1000], scale: [1, 1, 1], origin: [500, 500, 0],
      color: [202, 202, 202], alpha: 0,
      sceneW: 3840, sceneH: 2160,
      isolate: { objectId: 327, rtWidth: 1000, rtHeight: 1000, worldW: 1000, worldH: 1000 },
    });
    const quad = player.displayObject(327) as THREE.Mesh;
    expect((quad.material as THREE.MeshBasicMaterial).opacity).toBe(0);
    // 效果链输出替换采样纹理时 alpha 仍在（不会随 setObjectOutput 丢失）。
    player.setObjectOutput(327, new THREE.Texture());
    expect((quad.material as THREE.MeshBasicMaterial).opacity).toBe(0);
    // image 隔离路径零回归：合成 quad 保持中性（alpha 已烘进 RT，不得二次施加）。
    player.addBackground({
      objectId: 13, size: [100, 100], scale: [1, 1, 1], origin: [10, 10, 0], alpha: 0.5,
      texture: new THREE.Texture(), sceneW: 3840, sceneH: 2160,
      isolate: { objectId: 13, rtWidth: 100, rtHeight: 100, worldW: 100, worldH: 100 },
    });
    expect((player.displayObject(13) as THREE.Mesh).material).toMatchObject({ opacity: 1 });
  });

  // v0.8.2 Fix round 1（Minor 10）：util 层按 scene 对象顺序透传 renderOrder（不统一置后）。
  it('util 层的合成 quad 按 objects 下标 renderOrder，不统一置后', () => {
    const scene = JSON.stringify({
      general: { orthogonalprojection: { height: 1080, width: 1920 } },
      objects: [
        { id: 13, image: 'models/a.json', origin: '960 540 0', scale: '1 1 1', size: '1920 1080' },
        {
          id: 58, image: 'models/util/projectlayer.json', origin: '960 540 0', scale: '1 1 1',
          size: '1920 1080', effects: [{ file: 'effects/w/effect.json' }],
        },
        { id: 30, image: 'models/b.json', origin: '100 100 0', scale: '1 1 1', size: '100 100' },
      ],
    });
    const assets = {
      renderer: createMockRenderer() as unknown as THREE.WebGLRenderer,
      isolate: new Map([[58, { objectId: 58, rtWidth: 1920, rtHeight: 1080, worldW: 1920, worldH: 1080 }]]),
    };
    const result = loadSceneToThree(scene, assets, document.createElement('canvas'));
    // 下标 0/1/2：隔离 util 的合成 quad 沿用其宿主对象的绘制序（1），其后还有 image（2）。
    const orders = [13, 58, 30].map((id) => (result.player.displayObject(id) as THREE.Mesh).renderOrder);
    expect(orders).toEqual([0, 1, 2]);
    expect(result.player.displayObject(58)).toBe(result.player.isolatedObjects()[0].quad);
  });
});

// 2026-10-13 Task 3：段渲染骨架（按 renderOrder 在消费者前切段 → 段边界拍快照 → 末段合成回默认 fb）。
// 核心不变量：**无消费者时调用序列与现状逐字节一致**（本文件既有全部渲染断言即该不变量的回归网）。
describe('ThreeScenePlayer 段渲染（frameCapture）', () => {
  function makeTexture(): THREE.Texture {
    const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    tex.needsUpdate = true;
    return tex;
  }

  /** 造 3 个背景对象（renderOrder 0/1/2 = scene.json 对象 id 11/22/33）。 */
  function addThreeLayers(player: ThreeScenePlayer): void {
    for (const [i, objectId] of [11, 22, 33].entries()) {
      player.addBackground({
        origin: [i * 10, 0, 0], size: [10, 10], scale: [1, 1, 1], texture: makeTexture(),
        sceneW: 100, sceneH: 100, objectId, renderOrder: i,
      });
    }
  }

  it('无消费者时调用序列与现状逐字节一致（1 次 render 到默认 fb）', () => {
    const { player, mock } = makePlayer();
    addThreeLayers(player);
    const cap = createFrameCapture(mock as unknown as THREE.WebGLRenderer);
    player.setFrameCapture(cap); // 未 use() → active=false
    player.render();
    expect(mock._renders.map((r) => r.target)).toEqual([null]);
    expect(mock._renders[0].scene).toBe(player.scene);
    expect(mock._copies).toHaveLength(0);        // 不拍快照
    expect(mock.setRenderTarget).not.toHaveBeenCalled(); // 不切 target
    // 零回归钉子：不碰全局清屏参数，首段清屏口径仍是默认的 alpha=1
    expect(mock.setClearColor).not.toHaveBeenCalled();
    expect(mock._renders[0].clearAlpha).toBe(1);
    player.dispose();
  });

  it('有消费者时：段渲染进 RT、段间 autoClear=false、末段合成回默认 fb', () => {
    const { player, mock } = makePlayer();
    addThreeLayers(player);
    const cap = createFrameCapture(mock as unknown as THREE.WebGLRenderer);
    cap.use();
    player.setFrameCapture(cap);
    player.registerFrameConsumer(22); // 第 2 个对象（renderOrder 1）是消费者 → 2 段（#22 与其后的 #33 同段）
    player.render();
    const targets = mock._renders.map((r) => r.target);
    // 段 1（#11）→ RT，段 2（#22 消费者 + #33）→ RT，末段合成 → 默认 fb
    expect(targets).toEqual([cap.target, cap.target, null]);
    // 段内 autoClear 必须为 false（累积），合成段恢复原值
    expect(mock._renders.map((r) => r.autoClear)).toEqual([false, false, true]);
    expect(mock.autoClear).toBe(true);           // 退出后恢复原值
    expect(mock._currentTarget()).toBeNull();    // 退出后 target 已复位
    // 现状默认 fb 的透明清屏不变量（clearAlpha=1/黑）在 RT 上保持一致
    expect(mock._renders[0].clearAlpha).toBe(1);
    expect(mock.setClearColor).toHaveBeenCalledWith(0x000000, 1);
    player.dispose();
  });

  it('消费者边界的快照恰好一次，且拍在消费者被绘制之前（rendersBefore 钉子）', () => {
    const { player, mock } = makePlayer();
    addThreeLayers(player);
    const cap = createFrameCapture(mock as unknown as THREE.WebGLRenderer);
    cap.use();
    player.setFrameCapture(cap);
    player.registerFrameConsumer(22);
    player.registerFrameConsumer(33); // 两个消费者 ⇒ 3 段（renderOrder 0 / 1 / 2 各一段）、2 次快照
    player.render();
    expect(mock._copies).toHaveLength(2); // 每个消费者边界**恰好一次**（capture() 无幂等性）
    // 快照必须发生在该消费者所在段的 render **之前**：#22 是第 2 段 ⇒ 拍时只渲过 1 段；
    // #33 是第 3 段 ⇒ 拍时已渲过 2 段（若拍在段后则是 [2, 3]，消费者会把自己拍进去）。
    expect(mock._copies.map((c) => c.rendersBefore)).toEqual([1, 2]);
    // 段 1（#11）→ 拍快照 → 段 2（#22）→ 拍快照 → 段 3（#33）→ 合成
    expect(mock._renders.length).toBe(4); // 3 段 + 1 次合成
    expect(mock._copies.every((c) => c.target === cap.target)).toBe(true);
    expect(mock._copies.every((c) => c.texture !== cap.target.texture)).toBe(true); // 快照纹理≠段目标纹理
    player.dispose();
  });

  it('段渲染临时改动的 clearColor/clearAlpha 在 finally 恢复原值（不污染全局清屏状态）', () => {
    const { player, mock } = makePlayer();
    addThreeLayers(player);
    mock.setClearColor(0x336699, 0.25); // 进入前是非默认值：恢复与否可观测
    const cap = createFrameCapture(mock as unknown as THREE.WebGLRenderer);
    cap.use();
    player.setFrameCapture(cap);
    player.registerFrameConsumer(22);
    player.render();
    expect(mock._renders[0].clearAlpha).toBe(1);        // 段内确实是黑 + alpha 1
    expect(mock._clearAlpha()).toBe(0.25);              // 退出后恢复原 alpha
    expect(mock._clearColor().getHex()).toBe(0x336699); // 退出后恢复原颜色
    player.dispose();
  });

  it('段渲染期间只有本段对象 visible；结束后全部恢复原值', () => {
    const { player, mock } = makePlayer();
    addThreeLayers(player);
    const cap = createFrameCapture(mock as unknown as THREE.WebGLRenderer);
    cap.use();
    player.setFrameCapture(cap);
    player.registerFrameConsumer(22);
    // 记录每次 render 时三个顶层对象的 visible
    const snapshots: boolean[][] = [];
    mock._setOnRender((s) => {
      if (s === player.scene) snapshots.push(player.scene.children.map((c) => c.visible));
    });
    player.render();
    // 只有 #22 是消费者 ⇒ 2 段：#11 | #22（消费者，与其后的 #33 同段）
    expect(snapshots).toEqual([
      [true, false, false],  // 段 1：#11
      [false, true, true],   // 段 2：#22（消费者）+ #33
    ]);
    expect(player.scene.children.map((c) => c.visible)).toEqual([true, true, true]);
    player.dispose();
  });

  it('原本 visible=false 的对象在段渲染期间保持 false、退出后仍为 false', () => {
    const { player, mock } = makePlayer();
    addThreeLayers(player);
    player.scene.children[0].visible = false; // #11 本来不可见
    const cap = createFrameCapture(mock as unknown as THREE.WebGLRenderer);
    cap.use();
    player.setFrameCapture(cap);
    player.registerFrameConsumer(22);
    const snapshots: boolean[][] = [];
    mock._setOnRender((s) => {
      if (s === player.scene) snapshots.push(player.scene.children.map((c) => c.visible));
    });
    player.render();
    // 第 1 段虽包含 #11，但它本来就不可见 ⇒ 必须保持 false（不得被段逻辑改成 true）
    expect(snapshots).toEqual([
      [false, false, false],
      [false, true, true],
    ]);
    expect(player.scene.children.map((c) => c.visible)).toEqual([false, true, true]);
    player.dispose();
  });

  it('同一 renderOrder 上的两个消费者各自成段，快照都拍在自己之前', () => {
    const { player, mock } = makePlayer();
    // 三个对象同 renderOrder：唯一化（objects 下标）未落地时也必须逐个消费者切段。
    for (const objectId of [11, 22, 33]) {
      player.addBackground({
        origin: [0, 0, 0], size: [10, 10], scale: [1, 1, 1], texture: makeTexture(),
        sceneW: 100, sceneH: 100, objectId, renderOrder: 0,
      });
    }
    const cap = createFrameCapture(mock as unknown as THREE.WebGLRenderer);
    cap.use();
    player.setFrameCapture(cap);
    player.registerFrameConsumer(11); // 首个对象就是消费者
    player.registerFrameConsumer(33); // 与 #22 同序，但仍是独立段
    const snapshots: boolean[][] = [];
    mock._setOnRender((s) => {
      if (s === player.scene) snapshots.push(player.scene.children.map((c) => c.visible));
    });
    player.render();
    // 切段规则 = 消费者**开启**新的一段、其后非消费者同段 ⇒ #11 段含 #22，#33 开启第二段
    expect(snapshots).toEqual([
      [true, true, false],   // 段 1：#11（消费者）+ #22
      [false, false, true],  // 段 2：#33（消费者）
    ]);
    expect(mock._copies).toHaveLength(2);
    // 两个快照都在各自消费者被绘制之前：#11 是首个对象（拍时 0 段）、#33 拍时已渲过 1 段
    expect(mock._copies.map((c) => c.rendersBefore)).toEqual([0, 1]);
    player.dispose();
  });

  // Task 5（design §3.5）：段边界**同步**把本帧快照交给编排器 ⇒ 效果链的 `_rt_FullFrameBuffer`
  // 拿到的是「该对象绘制之前」的本帧内容，而不是上一帧。
  it('段边界同步通知编排器：快照即该边界唯一那次 blit 的纹理，且在消费者段渲染之前', () => {
    const { player, mock } = makePlayer();
    addThreeLayers(player);
    const cap = createFrameCapture(mock as unknown as THREE.WebGLRenderer);
    cap.use();
    player.setFrameCapture(cap);
    player.registerFrameConsumer(22); // 3 个对象、1 个消费者 ⇒ 2 段
    const notes: Array<{ id: number; tex: unknown; ver: unknown; rendersBefore: number }> = [];
    player.setObjectEffectStage({
      bindOutputs: () => {},
      advance: () => {},
      onSegmentBoundary: (id: number, tex: THREE.Texture | null, ver?: number) => {
        notes.push({ id, tex, ver, rendersBefore: mock._renders.length });
      },
    });
    mock._setOnRender(null);
    player.render();
    const boundary = notes;
    // 只通知消费者、恰好一次，且纹理 = 该边界唯一那次 capture（不重复 blit）
    expect(boundary.map((n) => n.id)).toEqual([22]);
    expect(mock._copies).toHaveLength(1);
    expect(boundary[0].tex).toBe(mock._copies[0].texture);
    // 快照代号随通知下发：消费方据此在执行当刻丢弃 resize 之后作废的引用（Task 6）
    expect(boundary[0].ver).toBe(cap.snapshotVersion);
    // 通知发生在 #22 所在段 render **之前**（此刻只渲过第 1 段 #11，与快照同一时点）
    expect(boundary[0].rendersBefore).toBe(mock._copies[0].rendersBefore);
    expect(boundary[0].rendersBefore).toBe(1);
    player.dispose();
  });

  // resize 与异步 update 竞争（Task 6）：`player.resize()` 会重建 FrameCapture 的快照纹理
  //（旧引用已 dispose），而排队中的 runner.update 仍握着它 ⇒ 该对象会黑一帧。
  // 契约：resize 时通知编排器作废尚未消费的在途快照（已被带进闭包的那份由实时代号比对兜底，
  // 见 object-effects.advance / snapshotStale）。
  it('resize 通知编排器作废在途快照（画布缓冲尺寸未变时也通知）', () => {
    const { player, mock } = makePlayer();
    addThreeLayers(player);
    const cap = createFrameCapture(mock as unknown as THREE.WebGLRenderer);
    cap.use();
    player.setFrameCapture(cap);
    player.registerFrameConsumer(22);
    // 画布缓冲尺寸未变时也必须通知（隔离出「通知」这一条判据：不依赖 FrameCapture.resize 真的换了尺寸）。
    const notify = vi.fn();
    player.setObjectEffectStage({ bindOutputs: () => {}, advance: () => {}, notifyViewportResize: notify });
    mock._setOnRender(null);
    // 先真的建出快照资源：否则 `snapshotVersion` 停在 0 只是因为**根本没有资源**，
    // 「尺寸未变 ⇒ 快照未重建」是恒真的假证据（Minor 2）。建出的尺寸 = 画布缓冲 1920×1080
    //（FrameCapture 的尺寸来自 canvas；mock 无 domElement ⇒ 退回本类自持的 canvas），
    // 故随后必须用**同一尺寸** resize 才算「缓冲尺寸未变」。
    const snapshot = cap.capture();
    const before = cap.snapshotVersion;
    player.resize(1920, 1080);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(cap.snapshotVersion).toBe(before); // 缓冲尺寸未变 ⇒ 未重建快照（没有任何引用被作废）
    expect(cap.capture()).toBe(snapshot);     // 同一张快照实例，可反证「未 dispose + 重建」
    // 快照代号的实时读取入口（ObjectEffectHost 契约）：消费方在执行当刻据此比对作废。
    expect(player.frameSnapshotVersion()).toBe(cap.snapshotVersion);
    player.dispose();
  });

  it('captureFullFrame（ObjectEffectHost 契约）：未注入/未激活 → null，激活后拍一张并返回快照', () => {
    const { player, mock } = makePlayer();
    expect(player.captureFullFrame()).toBeNull(); // 未注入 FrameCapture
    const cap = createFrameCapture(mock as unknown as THREE.WebGLRenderer);
    player.setFrameCapture(cap);
    expect(player.captureFullFrame()).toBeNull(); // 注入但未激活（本壁纸无消费者）
    expect(mock._copies).toHaveLength(0);         // 未激活不拍
    cap.use();
    expect(player.captureFullFrame()).toBe(mock._copies[0].texture);
    expect(mock._copies).toHaveLength(1);
    player.dispose();
  });

  it('段渲染异常时 autoClear / clearColor / renderTarget / visible 全部恢复（try/finally）', () => {
    const { player, mock } = makePlayer();
    addThreeLayers(player);
    mock.setClearColor(0x336699, 0.25); // 进入前是非默认值：恢复与否可观测
    const cap = createFrameCapture(mock as unknown as THREE.WebGLRenderer);
    cap.use();
    player.setFrameCapture(cap);
    player.registerFrameConsumer(22);
    (mock.render as unknown as { mockImplementation: (f: () => void) => void })
      .mockImplementation(() => { throw new Error('boom'); });
    expect(() => player.render()).toThrow('boom');
    expect(mock.autoClear).toBe(true);
    expect(mock._currentTarget()).toBeNull();
    expect(player.scene.children.map((c) => c.visible)).toEqual([true, true, true]);
    expect(mock._clearAlpha()).toBe(0.25);
    expect(mock._clearColor().getHex()).toBe(0x336699);
    player.dispose();
  });

  it('setFrameCapture(null) / reset() 后回到现状路径（不切段、不合成）', () => {
    const { player, mock } = makePlayer();
    addThreeLayers(player);
    const cap = createFrameCapture(mock as unknown as THREE.WebGLRenderer);
    cap.use();
    player.setFrameCapture(cap);
    player.registerFrameConsumer(22);
    player.render();
    const afterSegmented = mock._renders.length;
    cap.reset(); // 装配新壁纸时的复位
    player.render();
    const tail = mock._renders.slice(afterSegmented);
    expect(tail.map((r) => r.target)).toEqual([null]); // 又只剩一次主场景直渲
    player.setFrameCapture(null);
    player.render();
    expect(mock._renders.slice(afterSegmented + 1).map((r) => r.target)).toEqual([null]);
    player.dispose();
  });

  it('renderSegmented 不改变「隔离内容 → bindOutputs → 主场景 → advance」帧序', () => {
    const { player, mock } = makePlayer();
    const order: string[] = [];
    (mock.render as unknown as { mockImplementation: (f: (s: unknown, c: unknown) => void) => void })
      .mockImplementation((s: unknown) => { order.push(s === player.scene ? 'main' : 'isolated'); });
    player.addBackground({
      origin: [0, 0, 0], size: [10, 10], scale: [1, 1, 1], texture: makeTexture(),
      sceneW: 100, sceneH: 100, objectId: 11, renderOrder: 0,
      isolate: { objectId: 11, rtWidth: 10, rtHeight: 10, worldW: 10, worldH: 10 },
    });
    player.addBackground({
      origin: [10, 0, 0], size: [10, 10], scale: [1, 1, 1], texture: makeTexture(),
      sceneW: 100, sceneH: 100, objectId: 22, renderOrder: 1,
    });
    player.setObjectEffectStage({
      bindOutputs: () => order.push('bind'),
      advance: () => order.push('advance'),
    });
    const cap = createFrameCapture(mock as unknown as THREE.WebGLRenderer);
    cap.use();
    player.setFrameCapture(cap);
    player.registerFrameConsumer(22);
    player.render();
    // 隔离内容在段渲染之前；对象效果链仍统一在段渲染前 bindOutputs（本任务不改链时机）
    expect(order[0]).toBe('isolated');
    expect(order[1]).toBe('bind');
    expect(order[order.length - 1]).toBe('advance');
    player.dispose();
  });

  it('Glow 开启时把 frameRT 交给 apply（第四参），不另建 composite-quad', () => {
    const { player, mock } = makePlayer();
    addThreeLayers(player);
    const applied: unknown[][] = [];
    player.setGlowStage({
      apply: (...args: unknown[]) => { applied.push(args); },
      resize: () => {}, setOptions: () => {}, dispose: () => {},
    } as never);
    const cap = createFrameCapture(mock as unknown as THREE.WebGLRenderer);
    cap.use();
    player.setFrameCapture(cap);
    player.registerFrameConsumer(22);
    player.render();
    expect(applied).toHaveLength(1);
    // args = [renderer, scene, camera, frameRT]
    expect(applied[0][0]).toBe(mock);
    expect(applied[0][1]).toBe(player.scene);
    expect(applied[0][2]).toBe(player.camera);
    expect(applied[0][3]).toBe(cap.target); // 复用同一张段目标，不自渲主场景
    // Glow 路径由 stage 自己合成到 canvas ⇒ 玩家侧不得再多渲一次（2 段：2 次 RT render）
    expect(mock._renders.map((r) => r.target)).toEqual([cap.target, cap.target]);
    player.dispose();
  });

  it('resize 把画布缓冲尺寸转发给 capture（快照/段目标跟随 dpr）', () => {
    const { player, mock } = makePlayer();
    const cap = createFrameCapture(mock as unknown as THREE.WebGLRenderer);
    cap.use();
    player.setFrameCapture(cap);
    const spy = vi.spyOn(cap, 'resize');
    player.resize(800, 600);
    expect(spy).toHaveBeenCalledWith(800, 600); // jsdom dpr=1 ⇒ 缓冲 == 视口
    player.dispose();
  });

  it('dispose 只解除 capture 引用、不释放它（创建者 three-renderer 独占释放）', () => {
    const { player, mock } = makePlayer();
    const cap = createFrameCapture(mock as unknown as THREE.WebGLRenderer);
    cap.use();
    player.setFrameCapture(cap);
    const disposeSpy = vi.spyOn(cap, 'dispose');
    const rtDispose = vi.spyOn(cap.target, 'dispose');
    player.dispose();
    expect(disposeSpy).not.toHaveBeenCalled();
    expect(rtDispose).not.toHaveBeenCalled();
  });

  it('装配 → dispose → 再装配复用同一 capture：仍可用（active/use()/capture() 正常）', () => {
    const mock = createMockRenderer(); // 一个 renderer 跨两次装配（= 生产：渲染器级资源）
    const cap = createFrameCapture(mock as unknown as THREE.WebGLRenderer);
    // 第一次装配：注入 + 登记消费者 + 真的走一次段渲染
    const first = makePlayer(1920, 1080, mock);
    addThreeLayers(first.player);
    first.player.setFrameCapture(cap);
    first.player.registerFrameConsumer(22);
    first.player.render();
    expect(mock._copies).toHaveLength(1);
    first.player.dispose(); // 切壁纸：不得把 capture 标记为已释放
    cap.reset();            // 每次装配开始 three-renderer 都会 reset
    expect(cap.active).toBe(false);
    cap.use();              // 显式激活仍有效（Task 1 接口）
    expect(cap.active).toBe(true);
    cap.reset();
    // 第二次装配（真实链路 = three-renderer 的 `frameCapture ??=` 复用同一实例）
    const second = makePlayer(1920, 1080, mock);
    addThreeLayers(second.player);
    second.player.setFrameCapture(cap);
    expect(cap.active).toBe(false);           // 仅注入 capture 还不算有消费者
    second.player.registerFrameConsumer(22);  // 命中显示对象 ⇒ 自动激活
    expect(cap.active).toBe(true);
    expect(cap.target).toBeTruthy();          // 此前会抛「FrameCapture 已 dispose」
    second.player.render();
    expect(mock._copies).toHaveLength(2);     // 段渲染照常（此前会静默退化为直渲）
    second.player.dispose();
  });

  it('registerFrameConsumer 命中显示对象才置 active（active 的唯一真值来源）', () => {
    const { player, mock } = makePlayer();
    addThreeLayers(player);
    const cap = createFrameCapture(mock as unknown as THREE.WebGLRenderer);
    player.setFrameCapture(cap);
    expect(cap.active).toBe(false); // 未登记消费者
    player.registerFrameConsumer(22);
    expect(cap.active).toBe(true);  // 无需显式 use()
    player.dispose();
  });

  it('登记了未匹配显示对象的消费者：告警一次且不激活段渲染', () => {
    const { player, mock } = makePlayer();
    addThreeLayers(player);
    const cap = createFrameCapture(mock as unknown as THREE.WebGLRenderer);
    player.setFrameCapture(cap);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    player.registerFrameConsumer(999); // 未登记进 displayObjects（该段边界不存在）
    player.registerFrameConsumer(999); // 重复登记不重复告警
    player.registerFrameConsumer(22);  // 命中 ⇒ 正常激活
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('999');
    expect(cap.active).toBe(true);
    player.render();
    expect(mock._renders.map((r) => r.target)).toEqual([cap.target, cap.target, null]); // 仍只有 #22 开段
    warn.mockRestore();
    player.dispose();
  });

  // ── v0.8.2 F2 / T3：快照作为 util 层**内容输入**（真实 util 链读 bind: previous，不读
  //    `_rt_FullFrameBuffer`）。段边界拍到快照后把它写成内容材质 map，并立即重渲该层内容进 RT
  //    ⇒ 同一帧 advance 的效果链输入就是本帧内容（不是上一帧的透明占位）。
  /** 全屏 util 层（2597392171 #54 形态）：场景 3840×6000、视口 1920×1080（竖构图被横向裁切）。 */
  function addFullscreenUtil(player: ThreeScenePlayer): void {
    player.setSceneSize(3840, 6000);
    player.addBackground({
      origin: [1920, 3000, 0], size: [3840, 6000], scale: [1, 1, 1],
      sceneW: 3840, sceneH: 6000, objectId: 54, renderOrder: 0, util: 'fullscreen',
      isolate: { objectId: 54, rtWidth: 640, rtHeight: 1000, worldW: 3840, worldH: 6000 },
    });
  }

  it('util 层登记帧消费者 → 段边界把快照写成内容输入并重渲进 RT', () => {
    const { player, mock } = makePlayer(1920, 1080);
    addFullscreenUtil(player);
    const cap = createFrameCapture(mock as unknown as THREE.WebGLRenderer);
    player.setFrameCapture(cap);
    expect(player.utilContentTextureForTest(54)).toBeNull(); // 帧消费者未登记前仍是透明占位
    player.registerFrameConsumer(54);
    expect(cap.active).toBe(true);
    player.render();

    // ① 段边界恰好一次快照，内容材质换成同一张快照纹理（不是占位）。
    expect(mock._copies).toHaveLength(1);
    const snap = mock._copies[0].texture as THREE.Texture;
    expect(player.utilContentTextureForTest(54)).toBe(snap);
    expect(player.currentFrameSnapshot()).toBe(snap);
    const iso = player.isolatedObjects().find((o) => o.id === 54)!;
    const content = iso.localScene.children[0] as THREE.Mesh;
    const mat = content.material as THREE.MeshBasicMaterial;
    expect(mat.map).toBe(snap);
    expect(mat.opacity).toBe(1);

    // ② 快照在帧首内容渲染**之后**、内容重渲**之前**：后者保证链输入是本帧内容。
    expect(mock._copies[0].rendersBefore).toBe(1); // 帧首 renderIsolatedContents 已经画过一张
    const contentRenders = mock._renders.filter((r) => r.scene === iso.localScene);
    expect(contentRenders).toHaveLength(2);        // 帧首一次 + 段边界重渲一次
    expect(mock._renders[1].scene).toBe(iso.localScene);
    expect(mock._renders[1].target).toBe(iso.rt);

    // ③ cover 映射：3840×6000 场景在 1920×1080 视口下 cover = 3840×2160（裁高度）⇒
    //    快照占内容 mesh UV 的中间横带（sy=0.32, sh=0.36），**不是**拉伸到整块。
    expect(player.utilContentUvForTest(54)!).toEqual({
      sx: 0, sy: expect.closeTo(0.32, 6), sw: 1, sh: expect.closeTo(0.36, 6),
    });
    const uv = (content.geometry as THREE.PlaneGeometry).attributes.uv.array as Float32Array;
    // PlaneGeometry 顶点 uv = [(0,1),(1,1),(0,0),(1,0)]；变换后 u 不变、v' = (v - 0.32)/0.36。
    // v=1（画面顶）→ 1.889、v=0（画面底）→ -0.889：v 方向**不翻**（快照 v=0 = 画面底）。
    expect(uv[0]).toBeCloseTo(0, 6);
    expect(uv[1]).toBeCloseTo((1 - 0.32) / 0.36, 5);
    expect(uv[2]).toBeCloseTo(1, 6);
    expect(uv[5]).toBeCloseTo((0 - 0.32) / 0.36, 5);
    player.dispose();
  });

  // 快照失败（copyFramebufferToTexture 抛错/资源已释放）⇒ 只告警一次并跳过 util 层：
  // 不把异常抛进帧循环（否则整帧丢失），主场景段渲染与末段合成照旧。
  it('段边界快照失败 → 不抛错、util 内容不被替换、只 warn 一次、主场景继续', () => {
    const { player, mock } = makePlayer(1920, 1080);
    addFullscreenUtil(player);
    const cap = createFrameCapture(mock as unknown as THREE.WebGLRenderer);
    player.setFrameCapture(cap);
    player.registerFrameConsumer(54);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(cap, 'capture').mockImplementation(() => { throw new Error('copy 失败'); });

    const before = mock._renders.length;
    expect(() => player.render()).not.toThrow();
    const frameRenders = mock._renders.slice(before);
    expect(frameRenders.some((r) => r.target === cap.target)).toBe(true); // 段渲染继续
    expect(frameRenders.some((r) => r.target === null)).toBe(true);       // 末段合成到画布
    expect(player.utilContentTextureForTest(54)).toBeNull();              // 透明占位未被替换
    expect(player.currentFrameSnapshot()).toBeNull();

    expect(() => player.render()).not.toThrow(); // 第二帧同样失败：只 warn 一次
    const snapshotWarns = warn.mock.calls.filter((c) => String(c[0]).includes('帧快照失败'));
    expect(snapshotWarns).toHaveLength(1);
    warn.mockRestore();
    player.dispose();
  });

  // resize / 换 capture 都会重建或作废旧快照：上一帧的兜底引用必须清空，
  // 否则渲染器每帧把它同步给 stage，放行的链会采到已 dispose 的纹理。
  it('resize / setFrameCapture 清空 lastFrameSnapshot（旧快照不得同步回 stage）', () => {
    const { player, mock } = makePlayer(1920, 1080);
    addFullscreenUtil(player);
    const cap = createFrameCapture(mock as unknown as THREE.WebGLRenderer);
    player.setFrameCapture(cap);
    player.registerFrameConsumer(54);
    player.render();
    expect(player.currentFrameSnapshot()).toBe(mock._copies[0].texture);
    player.resize(1600, 900);
    expect(player.currentFrameSnapshot()).toBeNull();
    // 新 capture 尚未产生快照：旧 capture 的引用同样作废。
    player.render();
    expect(player.currentFrameSnapshot()).not.toBeNull();
    player.setFrameCapture(createFrameCapture(mock as unknown as THREE.WebGLRenderer));
    expect(player.currentFrameSnapshot()).toBeNull();
    player.dispose();
  });

  it('setUtilContentTexture：显式 cover 生效（探针回读 + 几何 UV 按 (u-sx)/sw 重写）', () => {
    const { player } = makePlayer(1920, 1080);
    addFullscreenUtil(player);
    const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    tex.needsUpdate = true;
    player.setUtilContentTexture(54, tex, { cover: { sx: 0, sy: 0.25, sw: 1, sh: 0.5 } });
    expect(player.utilContentTextureForTest(54)).toBe(tex);
    expect(player.utilContentUvForTest(54)).toEqual({ sx: 0, sy: 0.25, sw: 1, sh: 0.5 });
    const iso = player.isolatedObjects().find((o) => o.id === 54)!;
    const uv = ((iso.localScene.children[0] as THREE.Mesh).geometry as THREE.PlaneGeometry)
      .attributes.uv.array as Float32Array;
    expect(uv[1]).toBeCloseTo((1 - 0.25) / 0.5, 6); // 1.5
    expect(uv[5]).toBeCloseTo((0 - 0.25) / 0.5, 6); // -0.5
    // 无 cover 参数 = 全 UV（几何回到 [0,1]²）
    player.setUtilContentTexture(54, tex);
    expect(player.utilContentUvForTest(54)).toEqual({ sx: 0, sy: 0, sw: 1, sh: 1 });
    expect(uv[1]).toBeCloseTo(1, 6);
    expect(uv[5]).toBeCloseTo(0, 6);
    player.dispose();
  });

  it('solid util 层保留纯色内容：快照只填 passthrough 内容（不建内容输入条目）', () => {
    const { player } = makePlayer(1920, 1080);
    player.addBackground({
      origin: [960, 540, 0], size: [1000, 1000], scale: [1, 1, 1],
      sceneW: 1920, sceneH: 1080, objectId: 327, renderOrder: 0, util: 'solid',
      color: [255, 0, 0], alpha: 0.5,
      isolate: { objectId: 327, rtWidth: 500, rtHeight: 500, worldW: 1000, worldH: 1000 },
    });
    player.setUtilContentTexture(327, new THREE.DataTexture(new Uint8Array(4), 1, 1));
    expect(player.utilContentTextureForTest(327)).toBeNull();
    const iso = player.isolatedObjects().find((o) => o.id === 327)!;
    const mat = (iso.localScene.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial;
    expect(mat.map ?? null).toBeNull();     // 纯色内容不被快照替换
    expect(mat.color.r).toBeCloseTo(1, 6);  // 颜色仍在（#ff0000）
    player.dispose();
  });

  it('无帧消费者：util 内容保持透明占位、帧序不变（零回归）', () => {
    const { player, mock } = makePlayer(1920, 1080);
    addFullscreenUtil(player);
    const cap = createFrameCapture(mock as unknown as THREE.WebGLRenderer);
    player.setFrameCapture(cap);           // 未登记消费者 ⇒ 不激活段渲染
    player.render();
    expect(cap.active).toBe(false);
    expect(mock._copies).toHaveLength(0);
    expect(player.utilContentTextureForTest(54)).toBeNull();
    expect(mock._renders.filter((r) => r.scene === player.scene)).toHaveLength(1);
    const mat = (player.isolatedObjects()[0].localScene.children[0] as THREE.Mesh)
      .material as THREE.MeshBasicMaterial;
    expect(mat.opacity).toBe(0);           // T2 的透明占位不变
    player.dispose();
  });
});

// v0.8.1 F8：壁纸级 bloom（scene.json general.bloom*）与应用级 Glow 的两级串联。
// 顺序契约：bloom 先（写中间 RT）→ Glow 读中间 RT 合成到画布 / 无 Glow 时 composite-quad 贴回。
describe('ThreeScenePlayer 壁纸级 bloom（F8）', () => {
  /** bloom/glow 的最小 spy：记录 apply 实参、调用顺序与 resize 尺寸（诊断字段不进 GlowStage 接口）。 */
  function stageSpy(tag: string, calls: string[], args: unknown[][], sizes: Array<[number, number]> = []) {
    return {
      apply: (...a: unknown[]) => { calls.push(tag); args.push(a); },
      resize: (w: number, h: number) => { sizes.push([w, h]); },
      setOptions: () => {},
      dispose: () => {},
    } as never;
  }

  function makeTexture(): THREE.Texture {
    const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    tex.needsUpdate = true;
    return tex;
  }

  /** 造 3 个背景对象（renderOrder 0/1/2 = scene.json 对象 id 11/22/33）。 */
  function addLayers(player: ThreeScenePlayer): void {
    for (const [i, objectId] of [11, 22, 33].entries()) {
      player.addBackground({
        origin: [i * 10, 0, 0], size: [10, 10], scale: [1, 1, 1], texture: makeTexture(),
        sceneW: 100, sceneH: 100, objectId, renderOrder: i,
      });
    }
  }

  it('有壁纸 bloom 时先 bloom 再 glow（同一张中间 RT 串联，最终由 Glow 合成到画布）', () => {
    const { player } = makePlayer();
    const calls: string[] = [];
    const bloomArgs: unknown[][] = [];
    const glowArgs: unknown[][] = [];
    player.setBloomStage(stageSpy('bloom', calls, bloomArgs));
    player.setGlowStage(stageSpy('glow', calls, glowArgs));
    player.render();
    expect(calls).toEqual(['bloom', 'glow']);
    // bloom 自渲主场景（前 3 参 = player 的 renderer/scene/camera），第 5 参 = 中间 RT
    expect(bloomArgs[0][0]).toBe(player.renderer);
    expect(bloomArgs[0][1]).toBe(player.scene);
    expect(bloomArgs[0][2]).toBe(player.camera);
    expect(bloomArgs[0][3]).toBeUndefined();
    const middle = bloomArgs[0][4];
    expect(middle).toBeInstanceOf(THREE.WebGLRenderTarget);
    // glow 把同一张中间 RT 当 preRendered 读（第 4 参 = 段渲染/上游结果），不再自渲主场景
    expect(glowArgs[0][3]).toBe(middle);
  });

  it('只有壁纸 bloom（Glow 关闭）时：bloom 写 RT 后由 composite-quad 贴回画布，不直渲主场景', () => {
    const { player, mock } = makePlayer();
    const calls: string[] = [];
    const bloomArgs: unknown[][] = [];
    player.setBloomStage(stageSpy('bloom', calls, bloomArgs));
    const before = mock._renders.length;
    player.render();
    expect(calls).toEqual(['bloom']);
    // 末段合成 = 一次默认 fb 渲染，且渲染的不是主场景（composite-quad 的全屏 quad）
    const after = mock._renders.slice(before);
    expect(after.length).toBe(1);
    expect(after[0].scene).not.toBe(player.scene);
    expect(after[0].target).toBeNull();
  });

  it('无壁纸 bloom 时 Glow 单独装配仍按原 3 参调用（零回归：不额外建中间 RT）', () => {
    const { player } = makePlayer();
    const calls: string[] = [];
    const glowArgs: unknown[][] = [];
    player.setGlowStage(stageSpy('glow', calls, glowArgs));
    player.render();
    expect(calls).toEqual(['glow']);
    expect(glowArgs[0]).toHaveLength(3);
  });

  it('resize 同步 bloomStage 与 bloomRT（按画布缓冲尺寸）', () => {
    const { player } = makePlayer();
    const calls: string[] = [];
    const bloomArgs: unknown[][] = [];
    const sizes: Array<[number, number]> = [];
    player.setBloomStage(stageSpy('bloom', calls, bloomArgs, sizes));
    player.render(); // 惰性建中间 RT
    player.resize(800, 600);
    player.render();
    const middle = bloomArgs[bloomArgs.length - 1][4] as THREE.WebGLRenderTarget;
    // jsdom dpr=1 ⇒ 画布缓冲 == 视口
    expect([middle.width, middle.height]).toEqual([800, 600]);
    expect(sizes[sizes.length - 1]).toEqual([800, 600]);
  });

  it('dispose 释放 bloomStage 与中间 RT', () => {
    const { player } = makePlayer();
    let stageDisposed = 0;
    const bloom = {
      apply: () => {}, resize: () => {}, setOptions: () => {},
      dispose: () => { stageDisposed += 1; },
    };
    player.setBloomStage(bloom as never);
    player.render(); // 建 RT
    const middle = (player as unknown as { bloomRT: THREE.WebGLRenderTarget | null }).bloomRT;
    expect(middle).toBeInstanceOf(THREE.WebGLRenderTarget);
    const rtDisposed = vi.spyOn(middle!, 'dispose');
    player.dispose();
    expect(stageDisposed).toBe(1);
    expect(rtDisposed).toHaveBeenCalled();
  });

  it('段渲染末段：bloom 读 frameRT（第 4 参）写中间 RT，Glow 再读中间 RT', () => {
    const { player, mock } = makePlayer();
    addLayers(player);
    const calls: string[] = [];
    const bloomArgs: unknown[][] = [];
    const glowArgs: unknown[][] = [];
    player.setBloomStage(stageSpy('bloom', calls, bloomArgs));
    player.setGlowStage(stageSpy('glow', calls, glowArgs));
    const cap = createFrameCapture(mock as unknown as THREE.WebGLRenderer);
    cap.use();
    player.setFrameCapture(cap);
    player.registerFrameConsumer(22);
    player.render();
    expect(calls).toEqual(['bloom', 'glow']);
    expect(bloomArgs[0][3]).toBe(cap.target);       // 段渲染内容已写进 frameRT ⇒ bloom 不自渲主场景
    expect(glowArgs[0][3]).toBe(bloomArgs[0][4]);   // Glow 读 bloom 的中间 RT
    // 2 段 RT 渲染 + stage 接管末段（spy 不真渲）⇒ 不再向默认 fb 渲染
    expect(mock._renders.map((r) => r.target)).toEqual([cap.target, cap.target]);
    player.dispose();
  });

  it('段渲染末段且无 Glow：bloom 写中间 RT 后由 composite-quad 贴回默认 fb', () => {
    const { player, mock } = makePlayer();
    addLayers(player);
    const calls: string[] = [];
    const bloomArgs: unknown[][] = [];
    player.setBloomStage(stageSpy('bloom', calls, bloomArgs));
    const cap = createFrameCapture(mock as unknown as THREE.WebGLRenderer);
    cap.use();
    player.setFrameCapture(cap);
    player.registerFrameConsumer(22);
    player.render();
    expect(calls).toEqual(['bloom']);
    expect(bloomArgs[0][3]).toBe(cap.target);
    const targets = mock._renders.map((r) => r.target);
    expect(targets.slice(0, 2)).toEqual([cap.target, cap.target]); // 2 段
    expect(targets[2]).toBeNull();                                 // composite-quad 贴回画布
    expect(mock._renders[2].scene).not.toBe(player.scene);
    player.dispose();
  });
});

// Task 4：粒子 REFRACT（材质 combo REFRACT=1）—— 首个真实消费者（2897292240 的雨层 obj #25/#36）。
// 语义：片元按槽 1 的法线/遮罩把屏幕 UV 位移后采「本帧场景快照」；折射层自动成为段边界消费者。
describe('ThreeScenePlayer 粒子 REFRACT', () => {
  const NORMAL = new THREE.DataTexture(new Uint8Array([0, 128, 0, 128]), 2, 2);

  /** 造一个折射粒子层（objectId = scene.json 对象 id，renderOrder 缺省 1 = 粒子）。 */
  function addRefract(player: ThreeScenePlayer, objectId: number, amount = 0.05, renderOrder = 1): THREE.Mesh {
    player.addParticle(() => new Float32Array(16), {
      frameCount: 1,
      blend: 'alpha',
      objectId,
      renderOrder,
      refract: { normalTex: NORMAL, amount },
    });
    return player.displayObject(objectId) as THREE.Mesh;
  }

  /** 造 n 个背景对象（renderOrder 0..n-1，scene.json 对象 id 11,12,...）。 */
  function addBackgrounds(player: ThreeScenePlayer, n: number): void {
    for (let i = 0; i < n; i++) {
      player.addBackground({
        origin: [i * 10, 0, 0], size: [10, 10], scale: [1, 1, 1],
        texture: new THREE.DataTexture(new Uint8Array(4), 2, 2),
        sceneW: 100, sceneH: 100, objectId: 11 + i, renderOrder: i,
      });
    }
  }

  it('shader 文本契约：REFRACT 分支与屏幕 UV 位移逐行在源里', () => {
    const { player } = makePlayer();
    const mesh = addRefract(player, 22);
    const mat = mesh.material as THREE.ShaderMaterial;
    expect(mat.fragmentShader).toContain('#ifdef REFRACT');
    expect(mat.fragmentShader).toContain('texture2D(refractNormal');
    expect(mat.fragmentShader).toContain('vScreenCoord.xy / vScreenCoord.z');
    expect(mat.fragmentShader).toContain('rgb *= texture2D(refractBg, rsUv).rgb');
    expect(mat.fragmentShader).toContain('off.y = -off.y');
    expect(mat.fragmentShader).toContain('off *= mask * vParticleAlpha');
    expect(mat.vertexShader).toContain('gl_Position.xyw');
    expect(mat.vertexShader).toContain('weObjectRotate(vec3(1.0, 0.0, 0.0)');
    expect(mat.vertexShader).toContain('vScreenTangents = refractAmount * vec4(rRight.x, rUp.x, rRight.y, rUp.y)');
    // 结构护栏（无 GPU 时唯一能挡住 GLSL 文本级错误的断言）：条件块一开一合、花括号配对。
    for (const src of [mat.vertexShader, mat.fragmentShader]) {
      const opens = src.split('#ifdef').length - 1;
      expect(opens).toBeGreaterThan(0);
      expect(opens).toBe(src.split('#endif').length - 1);
      expect(src.split('{').length).toBe(src.split('}').length);
    }
    player.dispose();
  });

  it('折射层：defines.REFRACT===1、uniform 三项就位；消费者渲染时 refractBg 已指向本帧快照', () => {
    const { player, mock } = makePlayer();
    addBackgrounds(player, 1);                       // #11（段 1）
    const mesh = addRefract(player, 22, 0.05);       // #22（段 2 = 消费者）
    const mat = mesh.material as THREE.ShaderMaterial;
    expect(mat.defines.REFRACT).toBe(1);
    expect(mat.uniforms.refractAmount.value).toBe(0.05);
    expect(mat.uniforms.refractNormal.value).toBe(NORMAL);
    // 缺省 refractBg = 1×1 白（未接快照时不产生位移）。
    const bgDefault = mat.uniforms.refractBg.value as THREE.DataTexture;
    expect(bgDefault.image.width).toBe(1);
    expect(bgDefault.image.height).toBe(1);

    const cap = createFrameCapture(mock as unknown as THREE.WebGLRenderer);
    // 折射层在 addParticle 里就登记为消费者 ⇒ 仅注入 capture 即激活（无需外部 registerFrameConsumer）。
    player.setFrameCapture(cap);
    expect(cap.active).toBe(true);

    const bgAtRender: unknown[] = [];
    mock._setOnRender((s) => { if (s === player.scene) bgAtRender.push(mat.uniforms.refractBg.value); });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    player.render();
    player.render(); // 诊断日志只一条
    // 首段 target === capture.target（段渲染）→ 2 段 + 末段合成
    expect(mock._renders.map((r) => r.target)).toEqual([cap.target, cap.target, null, cap.target, cap.target, null]);
    expect(mock._copies).toHaveLength(2);
    // 段 1（#11，背景）时还是缺省白图；段 2（#22 折射层）时已是快照 ⇒ 消费者只采本帧背景。
    expect(bgAtRender[0]).not.toBe(mock._copies[0].texture);
    expect(bgAtRender[1]).toBe(mock._copies[0].texture);
    expect(mat.uniforms.refractBg.value).toBe(mock._copies[1].texture);
    const refractLogs = log.mock.calls.filter((c) => String(c[0]).includes('refract layer=22'));
    expect(refractLogs).toHaveLength(1);
    expect(String(refractLogs[0][0])).toBe('[three] refract layer=22 bg=1920x1080 amount=0.05');
    log.mockRestore();
    player.dispose();
  });

  it('非折射层：defines.REFRACT===undefined、不建 refract uniform、不登记消费者（帧序与现状一致）', () => {
    const { player, mock } = makePlayer();
    addBackgrounds(player, 1);
    player.addParticle(() => new Float32Array(16), { frameCount: 1, blend: 'alpha', objectId: 22, renderOrder: 1 });
    const mat = (player.displayObject(22) as THREE.Mesh).material as THREE.ShaderMaterial;
    expect(mat.defines?.REFRACT).toBeUndefined();
    expect(mat.uniforms.refractBg).toBeUndefined();
    expect(mat.uniforms.refractNormal).toBeUndefined();
    expect(mat.uniforms.refractAmount).toBeUndefined();
    const cap = createFrameCapture(mock as unknown as THREE.WebGLRenderer);
    player.setFrameCapture(cap);
    expect(cap.active).toBe(false);
    player.render();
    expect(mock._renders.map((r) => r.target)).toEqual([null]); // 单次直渲，零分歧
    expect(mock._copies).toHaveLength(0);
    player.dispose();
  });

  it('隔离层（opts.isolate）不启用 REFRACT，也不登记消费者（对象 RT 的裁剪空间 ≠ 屏幕 UV）', () => {
    const { player, mock } = makePlayer();
    player.addParticle(() => new Float32Array(16), {
      frameCount: 1, blend: 'alpha', objectId: 22,
      isolate: { objectId: 22, rtWidth: 10, rtHeight: 10, worldW: 10, worldH: 10 },
      refract: { normalTex: NORMAL, amount: 0.05 },
    });
    const entry = player.isolatedObjects()[0];
    const mat = entry.localScene.children[0].material as THREE.ShaderMaterial;
    expect(mat.defines?.REFRACT).toBeUndefined();
    expect(mat.uniforms.refractBg).toBeUndefined();
    const cap = createFrameCapture(mock as unknown as THREE.WebGLRenderer);
    player.setFrameCapture(cap);
    expect(cap.active).toBe(false);
    player.render();
    expect(mock._copies).toHaveLength(0);
    player.dispose();
  });

  it('无可用 FrameCapture ⇒ 折射层隐藏并告警一次（快照不可用时绝不画白方块）', () => {
    const { player, mock } = makePlayer();
    const mesh = addRefract(player, 22);
    expect(mesh.visible).toBe(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    player.render();
    player.render();
    expect(mesh.visible).toBe(false);
    const refractWarns = warn.mock.calls.filter((c) => String(c[0]).includes('折射层'));
    expect(refractWarns).toHaveLength(1);
    expect(mock._renders.map((r) => r.target)).toEqual([null, null]);
    warn.mockRestore();
    player.dispose();
  });

  it('槽1 缺失（调用方不装配该层）⇒ 该粒子对象不入 scene、不建 sim（不可见而非白方块）', () => {
    const canvas = document.createElement('canvas');
    const scene = JSON.stringify({
      general: { orthogonalprojection: { height: 1080, width: 1920 } },
      objects: [{ id: 22, particle: 'particles/p.json', origin: '960 540 0', scale: '1 1 1' }],
    });
    const createParticleSim = vi.fn(() => ({
      update: vi.fn(), vertices: vi.fn(() => new Float32Array(0)),
      frame_count: vi.fn(() => 1), set_frame_count: vi.fn(), particle_count: vi.fn(() => 0),
    }));
    const result = loadSceneToThree(scene, {
      renderer: createMockRenderer() as unknown as THREE.WebGLRenderer,
      particles: new Map(), // ← three-renderer 在槽 1 缺失/加载失败时不下发条目
      createParticleSim,
    }, canvas);
    expect(result.player.scene.children).toHaveLength(0);
    expect(result.sims).toHaveLength(0);
    expect(createParticleSim).not.toHaveBeenCalled();
    result.player.dispose();
  });

  it('装配折射层（particles 带 refract）⇒ 该层登记为消费者并走段渲染', () => {
    const canvas = document.createElement('canvas');
    const mock = createMockRenderer();
    const scene = JSON.stringify({
      general: { orthogonalprojection: { height: 1080, width: 1920 } },
      objects: [
        { id: 11, image: 'models/a.json', origin: '960 540 0', scale: '1 1 1', size: '1920 1080' },
        { id: 36, particle: 'particles/p.json', origin: '960 540 0', scale: '1 1 1' },
      ],
    });
    const result = loadSceneToThree(scene, {
      renderer: mock as unknown as THREE.WebGLRenderer,
      backgroundTextures: new Map([[11, new THREE.DataTexture(new Uint8Array(4), 2, 2)]]),
      particles: new Map([[36, { specJson: '{}', blend: 'alpha' as const, refract: { normalTex: NORMAL, amount: 0.05 } }]]),
      createParticleSim: vi.fn(() => ({
        update: vi.fn(), vertices: vi.fn(() => new Float32Array(0)),
        frame_count: vi.fn(() => 1), set_frame_count: vi.fn(), particle_count: vi.fn(() => 0),
      })),
    }, canvas);
    const mat = (result.player.displayObject(36) as THREE.Mesh).material as THREE.ShaderMaterial;
    expect(mat.defines.REFRACT).toBe(1);
    const cap = createFrameCapture(mock as unknown as THREE.WebGLRenderer);
    result.player.setFrameCapture(cap);
    expect(cap.active).toBe(true);
    result.player.render();
    expect(mock._renders[0].target).toBe(cap.target); // 首段 target === capture.target
    result.player.dispose();
  });
});


// 2026-09-22 Task 8：SceneScript 运行时需要的「scene 对象 id → 最终显示对象」映射与帧钩子。
// 脚本的状态表键是 scene.json 的**对象 id**，而 backgroundEntries/particleLayers 的键是图层
// 计数器 id —— 映射必须记**最终显示物**（隔离对象记合成 quad，内容 mesh 只渲染进对象 RT）。
describe('ThreeScenePlayer displayObject 映射与 onFrame 帧钩子', () => {
  function makeTexture(): THREE.Texture {
    const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    tex.needsUpdate = true;
    return tex;
  }

  // 最小 ParticleSim 桩（字段与既有 makeMockSim 同形，这里只需 update 的顺序与类型）。
  function makeSim(order: string[] = []): {
    update(dt: number): void; vertices(): Float32Array; frame_count(): number;
    set_frame_count(n: number): void; particle_count(): number;
  } {
    return {
      update: () => { order.push('sim.update'); },
      vertices: () => new Float32Array(0),
      frame_count: () => 1,
      set_frame_count: () => {},
      particle_count: () => 0,
    };
  }

  it('非隔离对象返回其 mesh（= 主场景里的那个），未登记对象返回 undefined', () => {
    const { player } = makePlayer(100, 100);
    const id = player.addBackground({
      origin: [50, 50, 0], size: [10, 10], scale: [1, 1, 1], texture: makeTexture(),
      sceneW: 100, sceneH: 100, objectId: 42,
    });
    // 返回值仍是图层计数器 id（0），与 scene 对象 id 42 是两套编号。
    expect(id).toBe(0);
    expect(player.displayObject(42)).toBe(player.scene.children[0]);
    expect(player.displayObject(42)).toBeInstanceOf(THREE.Mesh);
    expect(player.displayObject(999)).toBeUndefined();
  });

  it('隔离对象的显示物是合成 quad，不是只渲染进对象 RT 的内容 mesh', () => {
    const { player } = makePlayer(100, 100);
    player.addBackground({
      origin: [0, 0, 0], size: [10, 10], scale: [1, 1, 1], texture: makeTexture(),
      sceneW: 100, sceneH: 100, objectId: 77,
      isolate: { objectId: 77, rtWidth: 10, rtHeight: 10, worldW: 10, worldH: 10 },
    });
    const entry = player.isolatedObjects()[0];
    expect(player.displayObject(77)).toBe(entry.quad);
    expect(player.displayObject(77)).not.toBe(entry.localScene.children[0]);
  });

  it('不传 objectId（既有调用方）→ 不登记任何映射（零回归）', () => {
    const { player } = makePlayer(100, 100);
    player.addBackground({
      origin: [50, 50, 0], size: [10, 10], scale: [1, 1, 1], sceneW: 100, sceneH: 100,
    });
    expect(player.scene.children).toHaveLength(1);
    expect(player.displayObject(0)).toBeUndefined();
    expect(player.displayObject(42)).toBeUndefined();
  });

  it('粒子图层同样按对象 id 登记（非隔离 = 粒子对象本身，隔离 = 合成 quad）', () => {
    const { player } = makePlayer(100, 100);
    player.addParticle(() => new Float32Array(0), { frameCount: 1, blend: 'alpha', objectId: 71 });
    expect(player.displayObject(71)).toBe(player.scene.children[0]);
    expect(player.displayObject(71)).toBeInstanceOf(THREE.Mesh);

    const { player: p2 } = makePlayer(100, 100);
    p2.addParticle(() => new Float32Array(0), {
      frameCount: 1, blend: 'alpha', objectId: 72, objectCenter: [0, 0, 0],
      isolate: { objectId: 72, rtWidth: 10, rtHeight: 10, worldW: 10, worldH: 10 },
    });
    const entry = p2.isolatedObjects()[0];
    expect(p2.displayObject(72)).toBe(entry.quad);
    expect(p2.displayObject(72)).not.toBe(entry.localScene.children[0]);
  });

  it('loadSceneToThree：image / text / particle 三处装配都按 scene 对象 id 登记显示物', () => {
    const canvas = document.createElement('canvas');
    const scene = JSON.stringify({
      general: { orthogonalprojection: { width: 100, height: 100 } },
      objects: [
        { id: 10750, image: 'models/layers/l_10750.json', origin: '50 50 0', scale: '1 1 1', size: '10 10' },
        { id: 5, origin: '50 50 0', scale: '1 1 1', size: '10 10', text: { value: 'x' } },
        { id: 71, particle: 'particles/presets/p.json', origin: '50 50 0', scale: '1 1 1' },
      ],
    });
    const r = loadSceneToThree(scene, {
      renderer: createMockRenderer() as unknown as THREE.WebGLRenderer,
      backgroundTextures: new Map([[10750, makeTexture()]]),
      textLayers: new Map([[5, { texture: makeTexture(), size: [10, 10] as [number, number] }]]),
      particles: new Map([[71, { specJson: '{}', blend: 'alpha' as const }]]),
      createParticleSim: () => makeSim(),
    }, canvas, { width: 100, height: 100 });
    expect(r.player.displayObject(10750)).toBeInstanceOf(THREE.Mesh);
    expect(r.player.displayObject(5)).toBeInstanceOf(THREE.Mesh);
    expect(r.player.displayObject(71)).toBeInstanceOf(THREE.Mesh);
    // 未参与渲染的对象（这里没有）查不到 → 脚本查询必须安全返回 undefined。
    expect(r.player.displayObject(94000)).toBeUndefined();
    r.player.dispose();
  });

  it('onFrame 每帧最先执行（早于 sim.update），可写 three 对象状态', () => {
    const canvas = document.createElement('canvas');
    const renderer = createMockRenderer();
    const order: string[] = [];
    const seen: number[] = [];
    const scene = JSON.stringify({
      general: { orthogonalprojection: { width: 100, height: 100 } },
      objects: [{ id: 71, particle: 'particles/presets/p.json', origin: '50 50 0', scale: '1 1 1' }],
    });
    const r = loadSceneToThree(scene, {
      renderer: renderer as unknown as THREE.WebGLRenderer,
      particles: new Map([[71, { specJson: '{}', blend: 'alpha' as const }]]),
      createParticleSim: () => makeSim(order),
      onFrame: (dt) => { order.push('onFrame'); seen.push(dt); },
    }, canvas, { width: 100, height: 100 });
    // mock renderer 不跑 RAF：直接调它记录的帧体（既有 createMockRenderer 的 _getLoop）。
    (renderer as unknown as { _getLoop: () => (() => void) | null })._getLoop()!();
    expect(order).toEqual(['onFrame', 'sim.update']);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeGreaterThanOrEqual(0);
    r.player.dispose();
  });

  it('不传 onFrame 时帧体行为不变（不抛错，sim 照常推进）', () => {
    const canvas = document.createElement('canvas');
    const renderer = createMockRenderer();
    const order: string[] = [];
    const scene = JSON.stringify({
      general: { orthogonalprojection: { width: 100, height: 100 } },
      objects: [{ id: 71, particle: 'particles/presets/p.json', origin: '50 50 0', scale: '1 1 1' }],
    });
    const r = loadSceneToThree(scene, {
      renderer: renderer as unknown as THREE.WebGLRenderer,
      particles: new Map([[71, { specJson: '{}', blend: 'alpha' as const }]]),
      createParticleSim: () => makeSim(order),
    }, canvas, { width: 100, height: 100 });
    (renderer as unknown as { _getLoop: () => (() => void) | null })._getLoop()!();
    expect(order).toEqual(['sim.update']);
    r.player.dispose();
  });
});

// 最终审查（C2 降级 + 附带要求）：**真实装配链路**的端到端门控用例 —— 真 `loadSceneToThree`
// （真 player、真 addParticle/attachIsolated）+ 真 `ObjectEffectStage` + 真 `createFrameCapture`。
// 两条互补断言：① 门控关闭时引用 `_rt_FullFrameBuffer` 的效果链**不**登记消费者（active=false、
// 帧序 = 改动前）；② 粒子 REFRACT（当前**唯一**消费点）经真实装配即登记 ⇒ active=true。
describe('最终审查 C2：真实装配链路的帧快照消费者门控（端到端）', () => {
  const NORMAL = new THREE.DataTexture(new Uint8Array([0, 128, 0, 128]), 2, 2);

  function makeTexture(): THREE.Texture {
    const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    tex.needsUpdate = true;
    return tex;
  }

  function makeSim(order: string[] = []) {
    let frameCount = 1;
    return {
      update: () => { order.push('update'); },
      vertices: () => new Float32Array(0),
      frame_count: () => frameCount,
      set_frame_count: (n: number) => { frameCount = Math.max(1, n); },
      particle_count: () => 0,
    };
  }

  /** 最小 CompiledEffectPass：godrays_combine 形态（`textures[1] = "_rt_FullFrameBuffer"`）。 */
  function frameSlotPass(): CompiledEffectPass {
    return {
      vertSrc: '', fragSrc: '', rawVert: '', rawFrag: '',
      combos: {}, uniforms: new Map(), textureSlots: [null, '_rt_FullFrameBuffer'],
      blendMode: 'normal', target: null, bind: [], fboScale: {},
    };
  }

  it('门控开启：真 player + 真 ObjectEffectStage 挂「引用快照」的链 ⇒ 登记消费者、段渲染拍快照、槽绑快照', () => {
    expect(ENABLE_CHAIN_FRAME_SNAPSHOT_CONSUMER).toBe(true);
    const canvas = document.createElement('canvas');
    const mock = createMockRenderer();
    const scene = JSON.stringify({
      general: { orthogonalprojection: { height: 1080, width: 1920 } },
      objects: [{ id: 13, image: 'models/a.json', origin: '960 540 0', scale: '1 1 1', size: '1920 1080' }],
    });
    const result = loadSceneToThree(scene, {
      renderer: mock as unknown as THREE.WebGLRenderer,
      backgroundTextures: new Map([[13, makeTexture()]]),
      // 生产链路里带效果链的对象一律被隔离（ObjectEffectStage 挂链的前提）
      isolate: new Map([[13, { objectId: 13, rtWidth: 1920, rtHeight: 1080, worldW: 1920, worldH: 1080 }]]),
    }, canvas);
    const player = result.player;
    const cap = createFrameCapture(mock as unknown as THREE.WebGLRenderer);
    player.setFrameCapture(cap);
    const stage = new ObjectEffectStage(player, { wallpaperId: '2597392171', screenScale: 1 });
    player.setObjectEffectStage(stage);
    // 与 three-renderer 同一顺序契约：先 setWorldSize，再 setObjectChains
    stage.setWorldSize(13, 1920, 1080, null);
    stage.setObjectChains(13, [[frameSlotPass()]]);
    // 门控开启 ⇒ 引用快照的链登记消费者（唯一登记入口是 setObjectChains）⇒ 段渲染激活。
    expect(cap.active).toBe(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    player.render();
    // 段渲染：消费者段边界**恰好拍一次**快照；该槽绑快照（不再留空告警）。
    expect(mock._copies).toHaveLength(1);
    expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('跳过绑定（槽留空）'))).toHaveLength(0);
    player.render();
    expect(mock._copies).toHaveLength(2); // 每帧一次
    warn.mockRestore();
    player.dispose();
  });

  it('粒子 REFRACT 经真实装配即登记消费者（当前唯一消费点）⇒ 仅注入 capture 即 active=true', () => {
    const canvas = document.createElement('canvas');
    const mock = createMockRenderer();
    const scene = JSON.stringify({
      general: { orthogonalprojection: { height: 1080, width: 1920 } },
      objects: [
        { id: 13, image: 'models/a.json', origin: '960 540 0', scale: '1 1 1', size: '1920 1080' },
        { id: 25, particle: 'particles/presets/halo_50_1.json', origin: '960 540 0', scale: '1 1 1' },
      ],
    });
    const result = loadSceneToThree(scene, {
      renderer: mock as unknown as THREE.WebGLRenderer,
      backgroundTextures: new Map([[13, makeTexture()]]),
      particles: new Map([[25, {
        specJson: '{}', blend: 'alpha' as const,
        refract: { normalTex: NORMAL, amount: 0.05 },
      }]]),
      createParticleSim: () => makeSim(),
    }, canvas);
    const cap = createFrameCapture(mock as unknown as THREE.WebGLRenderer);
    expect(cap.active).toBe(false); // 仅装配、未注入 capture ⇒ 尚不激活
    result.player.setFrameCapture(cap);
    expect(cap.active).toBe(true);  // 折射层在 addParticle 内登记（无需外部 registerFrameConsumer）
    result.player.render();
    // 2 段（#13 段 → #25 消费者段）+ 1 次快照 + 末段合成
    expect(mock._copies).toHaveLength(1);
    expect(mock._renders.map((r) => r.target)).toEqual([cap.target, cap.target, null]);
    result.player.dispose();
  });
});

// Task 4：逐帧应用视差 = **对象 model 矩阵的 2D 世界平移**（相机与帧序不动）：非隔离背景写 mesh、隔离对象写
// 合成 quad、粒子层写顶点 shader 的 u_Parallax（隔离粒子层同样落 quad，否则内容会在对象 RT 内被裁掉）。
// 断言的都是真实位置数值而非「函数被调用」；口径见 AGENT.md §2.3。
describe('视差逐帧应用', () => {
  function makePlayer() {
    const canvas = document.createElement('canvas');
    const renderer = { setAnimationLoop: vi.fn(), setPixelRatio: vi.fn(), setSize: vi.fn(), render: vi.fn(), domElement: canvas } as any;
    return new ThreeScenePlayer(canvas, 1920, 1080, renderer);
  }

  // 需要 RAF 帧体（installLoop 插桩）或 render 观测口的用例用完整 mock。
  function makeLoopPlayer() {
    const canvas = document.createElement('canvas');
    const mock = createMockRenderer();
    return { player: new ThreeScenePlayer(canvas, 1920, 1080, mock as unknown as THREE.WebGLRenderer), mock };
  }

  // 视差参数：amount=1 / delay=0（立即跟随）/ mouseInfluence=1 → shift = depth ⊙ (node + mouse)，
  // mouse_x = (0.5 - px) × 1920、mouse_y = (py - 0.5) × 1080。
  const ON = { enabled: true, amount: 1, delay: 0, mouseInfluence: 1 };

  it('depth 非 0 的对象按 shift 平移；depth 0 的对象保持原位', () => {
    const p = makePlayer();
    const idA = p.addBackground({ origin: [960, 540, 0], size: [100, 100], scale: [1, 1, 1], sceneW: 1920, sceneH: 1080, parallaxDepth: [1, 1] });
    const idB = p.addBackground({ origin: [960, 540, 0], size: [100, 100], scale: [1, 1, 1], sceneW: 1920, sceneH: 1080 });
    p.setParallax({ enabled: true, amount: 1, delay: 0, mouseInfluence: 1 });
    p.setParallaxPointer({ x: 1, y: 0.5 });
    p.tickParallaxForTest(0.016);
    const a = p.backgroundMeshForTest(idA);
    const b = p.backgroundMeshForTest(idB);
    expect(a.position.x).toBeCloseTo(-1920 / 2, 3); // 鼠标右移 → 向左
    expect(b.position.x).toBeCloseTo(0, 6);         // depth 缺失 → 不动
  });

  it('关掉视差后对象回到基准位置', () => {
    const p = makePlayer();
    const id = p.addBackground({ origin: [960, 540, 0], size: [100, 100], scale: [1, 1, 1], sceneW: 1920, sceneH: 1080, parallaxDepth: [1, 1] });
    p.setParallax({ enabled: true, amount: 1, delay: 0, mouseInfluence: 1 });
    p.setParallaxPointer({ x: 1, y: 1 });
    p.tickParallaxForTest(0.016);
    p.setParallax({ enabled: false, amount: 0, delay: 0, mouseInfluence: 0 });
    p.tickParallaxForTest(0.016);
    expect(p.backgroundMeshForTest(id).position.x).toBeCloseTo(0, 6);
    expect(p.backgroundMeshForTest(id).position.y).toBeCloseTo(0, 6);
  });

  it('depth=[0,0] 不动；指针回中 → 已平移的对象回到基准位', () => {
    const p = makePlayer();
    const idZero = p.addBackground({ origin: [960, 540, 0], size: [100, 100], scale: [1, 1, 1], sceneW: 1920, sceneH: 1080, parallaxDepth: [0, 0] });
    const idDep = p.addBackground({ origin: [960, 540, 0], size: [100, 100], scale: [1, 1, 1], sceneW: 1920, sceneH: 1080, parallaxDepth: [1, 1] });
    p.setParallax(ON);
    p.setParallaxPointer({ x: 1, y: 1 });
    p.tickParallaxForTest(0.016);
    expect(p.backgroundMeshForTest(idZero).position.x).toBeCloseTo(0, 6);
    expect(p.backgroundMeshForTest(idZero).position.y).toBeCloseTo(0, 6);
    expect(p.backgroundMeshForTest(idDep).position.x).toBeCloseTo(-960, 3);
    expect(p.backgroundMeshForTest(idDep).position.y).toBeCloseTo(540, 3);
    // 指针居中 → mouse 项归零、node 项为 0（居中对象）⇒ 回基准位
    p.setParallaxPointer({ x: 0.5, y: 0.5 });
    p.tickParallaxForTest(0.016);
    expect(p.backgroundMeshForTest(idDep).position.x).toBeCloseTo(0, 6);
    expect(p.backgroundMeshForTest(idDep).position.y).toBeCloseTo(0, 6);
  });

  it('无配置（setParallax(null)）逐帧零成本早退，不触碰任何对象', () => {
    const p = makePlayer();
    const id = p.addBackground({ origin: [960, 540, 0], size: [100, 100], scale: [1, 1, 1], sceneW: 1920, sceneH: 1080, parallaxDepth: [1, 1] });
    const node = p.backgroundMeshForTest(id);
    const setSpy = vi.spyOn(node.position, 'set');
    p.setParallaxPointer({ x: 1, y: 1 });
    p.tickParallaxForTest(0.016);
    expect(setSpy).not.toHaveBeenCalled();
    expect(node.position.x).toBe(0);
  });

  // 零回归：全库 34 张里只有 1 张开视差，其余 33 张的 cfg 是 {enabled:false,…}。若关视差时**每帧**都写
  // position，就会盖掉脚本写同一对象的 origin（layer-state.applyLayerState）⇒ 动态网格/可视化条静止。
  it('关视差：写回一次基准位后不再改写，脚本写入的 origin 不被覆盖', () => {
    const p = makePlayer();
    const id = p.addBackground({ origin: [960, 540, 0], size: [100, 100], scale: [1, 1, 1], sceneW: 1920, sceneH: 1080, parallaxDepth: [1, 1] });
    const node = p.backgroundMeshForTest(id);
    p.setParallax(ON);
    p.setParallaxPointer({ x: 1, y: 1 });
    p.tickParallaxForTest(0.016);
    expect(node.position.x).toBeCloseTo(-960, 3);

    p.setParallax({ enabled: false, amount: 0, delay: 0, mouseInfluence: 0 });
    p.tickParallaxForTest(0.016);
    expect(node.position.x).toBeCloseTo(0, 6);   // 一次性写回基准位
    expect(node.position.y).toBeCloseTo(0, 6);

    node.position.set(120, -30, 0);              // 脚本写 origin（we_to_three 后的值）
    p.tickParallaxForTest(0.016);
    expect(node.position.x).toBeCloseTo(120, 6); // 关视差后不再被覆盖
    expect(node.position.y).toBeCloseTo(-30, 6);
  });

  it('开视差但对象无 depth：不写 position（同样不盖掉脚本写入）', () => {
    const p = makePlayer();
    const id = p.addBackground({ origin: [960, 540, 0], size: [100, 100], scale: [1, 1, 1], sceneW: 1920, sceneH: 1080 });
    const node = p.backgroundMeshForTest(id);
    node.position.set(120, -30, 0);
    p.setParallax(ON);
    p.setParallaxPointer({ x: 1, y: 1 });
    p.tickParallaxForTest(0.016);
    expect(node.position.x).toBeCloseTo(120, 6);
    expect(node.position.y).toBeCloseTo(-30, 6);
  });

  // 偏差②的残留面：`[0,0]` 字段存在但是 truthy ⇒ 旧谓词 `!entry.parallaxDepth` 判不出「不参与视差」
  // ⇒ 每帧 position.set(基准位) 会盖掉脚本写同一对象的 origin（shift 恒 0 只是数值上不可见）。
  it('depth=[0,0]（字段存在但全 0）不参与视差：脚本写入的 position 不被每帧覆盖', () => {
    const p = makePlayer();
    const id = p.addBackground({ origin: [960, 540, 0], size: [100, 100], scale: [1, 1, 1], sceneW: 1920, sceneH: 1080, parallaxDepth: [0, 0] });
    const node = p.backgroundMeshForTest(id);
    p.setParallax(ON);
    p.setParallaxPointer({ x: 1, y: 1 });
    node.position.set(7, 9, 0);                  // 脚本写 origin（layer-state.applyLayerState 直接写 three 对象）
    p.tickParallaxForTest(0.016);
    p.tickParallaxForTest(0.016);
    expect(node.position.x).toBe(7);
    expect(node.position.y).toBe(9);
  });

  it('粒子层 depth=[0,0]：u_Parallax 一次都不写（等于不接管该层）；[1,1] 的邻居照常写', () => {
    const p = makePlayer();
    const verts = () => new Float32Array([0, 0, 0, 10, 0, 0, 1, 1, 1, 1]);
    p.addParticle(verts, { frameCount: 1, blend: 'alpha', objectCenter: [100, 50, 0], parallaxDepth: [0, 0] });
    p.addParticle(verts, { frameCount: 1, blend: 'alpha', objectCenter: [100, 50, 0], parallaxDepth: [1, 1] });
    const [meshZero, meshDep] = p.scene.children as THREE.Mesh[];
    const uZero = (meshZero.material as THREE.ShaderMaterial).uniforms.u_Parallax;
    const setSpy = vi.spyOn(uZero.value, 'set');
    p.setParallax(ON);
    p.setParallaxPointer({ x: 1, y: 0.5 });
    p.tickParallaxForTest(0.016);
    p.tickParallaxForTest(0.016);
    expect(setSpy).not.toHaveBeenCalled();
    expect(uZero.value.x).toBe(0);
    expect(uZero.value.y).toBe(0);
    // 同帧的邻居仍在动 ⇒ 上面「没写」不是整个循环被跳过
    expect((meshDep.material as THREE.ShaderMaterial).uniforms.u_Parallax.value.x).toBeCloseTo(-860, 3);
  });

  it('隔离对象：平移写在合成 quad 上（内容 mesh 位置不动、quad rotation 不被视差改写）', () => {
    const p = makePlayer();
    const id = p.addBackground({
      origin: [960, 540, 0], size: [100, 100], scale: [1, 1, 1], angles: [0, 0, 0.5],
      texture: new THREE.DataTexture(new Uint8Array(4), 1, 1),
      sceneW: 1920, sceneH: 1080, objectId: 13, parallaxDepth: [1, 1],
      isolate: { objectId: 13, rtWidth: 100, rtHeight: 100, worldW: 100, worldH: 100 },
    });
    const entry = p.isolatedObjects().find((e) => e.id === 13)!;
    // 隔离条目的 three 对象就是合成 quad（内容 mesh 只渲染进对象 RT，不在主场景）。
    expect(p.backgroundMeshForTest(id)).toBe(entry.quad);
    p.setParallax(ON);
    p.setParallaxPointer({ x: 1, y: 1 });
    p.tickParallaxForTest(0.016);
    expect(entry.quad.position.x).toBeCloseTo(-960, 3);
    expect(entry.quad.position.y).toBeCloseTo(540, 3);
    // 只写 position：OWE 也是 Translation × model（平移在旋转之前 = 沿世界轴）。
    expect(entry.quad.rotation.z).toBeCloseTo(0.5, 6);
    const content = entry.localScene.children[0] as THREE.Mesh;
    expect(content.position.x).toBe(0);
    expect(content.position.y).toBe(0);
  });

  it('粒子层：depth 非 0 → u_Parallax 收到世界位移（含 node 项）；缺 depth → 恒 0', () => {
    const p = makePlayer();
    const verts = () => new Float32Array([0, 0, 0, 10, 0, 0, 1, 1, 1, 1]);
    p.addParticle(verts, {
      frameCount: 1, blend: 'alpha', objectCenter: [100, 50, 0], parallaxDepth: [1, 1],
    });
    p.addParticle(verts, { frameCount: 1, blend: 'alpha', objectCenter: [100, 50, 0] });
    const [meshA, meshB] = p.scene.children as THREE.Mesh[];
    const matA = meshA.material as THREE.ShaderMaterial;
    const matB = meshB.material as THREE.ShaderMaterial;
    p.setParallax(ON);
    p.setParallaxPointer({ x: 1, y: 0.5 });
    p.tickParallaxForTest(0.016);
    // node = objCenter = (100, 50)；mouse_x = -960、mouse_y = 0 → shift = (-860, 50)
    expect(matA.uniforms.u_Parallax.value.x).toBeCloseTo(-860, 3);
    expect(matA.uniforms.u_Parallax.value.y).toBeCloseTo(50, 3);
    expect(matB.uniforms.u_Parallax.value.x).toBeCloseTo(0, 6);
    expect(matB.uniforms.u_Parallax.value.y).toBeCloseTo(0, 6);
  });

  it('隔离粒子层：平移落在合成 quad 上，RT 内容不偏移（否则内容被 RT 边界裁掉）', () => {
    const p = makePlayer();
    const verts = () => new Float32Array([0, 0, 0, 10, 0, 0, 1, 1, 1, 1]);
    p.addParticle(verts, {
      frameCount: 1, blend: 'alpha', objectCenter: [100, 50, 0], parallaxDepth: [1, 1],
      isolate: { objectId: 71, rtWidth: 100, rtHeight: 100, worldW: 100, worldH: 100 },
    });
    const entry = p.isolatedObjects().find((e) => e.id === 71)!;
    p.setParallax(ON);
    p.setParallaxPointer({ x: 1, y: 0.5 });
    p.tickParallaxForTest(0.016);
    // node = objCenter = (100, 50)；shift = (100 - 960, 50 + 0) = (-860, 50) ⇒ 位置 = node + shift
    expect(entry.quad.position.x).toBeCloseTo(-760, 3);
    expect(entry.quad.position.y).toBeCloseTo(100, 3);
    const content = entry.localScene.children[0] as THREE.Mesh;
    expect(content.position.toArray().map((v) => v + 0)).toEqual([-100, -50, 0]);
    const mat = content.material as THREE.ShaderMaterial;
    expect(mat.uniforms.u_Parallax.value.x).toBe(0);
    expect(mat.uniforms.u_Parallax.value.y).toBe(0);
    // 反向：关视差后 quad 回对象中心
    p.setParallax({ enabled: false, amount: 0, delay: 0, mouseInfluence: 0 });
    p.tickParallaxForTest(0.016);
    expect(entry.quad.position.x).toBeCloseTo(100, 6);
    expect(entry.quad.position.y).toBeCloseTo(50, 6);
  });

  // 守卫：隔离层的位移只能落在合成 quad 上，quad 缺失时**必须跳过该层** —— 退化写 u_Parallax 会在
  // 对象 RT 内平移内容并被 RT 边界裁掉（正是偏差①禁止的落点）。
  it('隔离粒子层缺合成 quad：跳过该层，不退化为写 u_Parallax；同帧的非隔离层照常写', () => {
    const p = makePlayer();
    const verts = () => new Float32Array([0, 0, 0, 10, 0, 0, 1, 1, 1, 1]);
    const captured: THREE.Mesh[] = [];
    // 让 attachIsolated 不登记条目 ⇒ addParticle 里 `isolated.get(id)?.quad` 取到 undefined
    //（真实成因：隔离条目缺失/被提前拆除），层本身仍是隔离层。
    vi.spyOn(p as any, 'attachIsolated').mockImplementation((_id: number, _kind: string, content: THREE.Mesh) => {
      captured.push(content);
    });
    p.addParticle(verts, {
      frameCount: 1, blend: 'alpha', objectCenter: [100, 50, 0], parallaxDepth: [1, 1],
      isolate: { objectId: 71, rtWidth: 100, rtHeight: 100, worldW: 100, worldH: 100 },
    });
    p.addParticle(verts, { frameCount: 1, blend: 'alpha', objectCenter: [100, 50, 0], parallaxDepth: [1, 1] });
    const uIsolated = (captured[0].material as THREE.ShaderMaterial).uniforms.u_Parallax;
    const setSpy = vi.spyOn(uIsolated.value, 'set');
    const meshPlain = p.scene.children[0] as THREE.Mesh;
    p.setParallax(ON);
    p.setParallaxPointer({ x: 1, y: 0.5 });
    p.tickParallaxForTest(0.016);
    p.tickParallaxForTest(0.016);
    expect(setSpy).not.toHaveBeenCalled();
    expect(uIsolated.value.x).toBe(0);
    expect((meshPlain.material as THREE.ShaderMaterial).uniforms.u_Parallax.value.x).toBeCloseTo(-860, 3);
  });

  it('帧循环：tickParallax 在 update 之后、render 之前', () => {
    const { player, mock } = makeLoopPlayer();
    const id = player.addBackground({ origin: [960, 540, 0], size: [100, 100], scale: [1, 1, 1], sceneW: 1920, sceneH: 1080, parallaxDepth: [1, 1] });
    const node = player.backgroundMeshForTest(id);
    const atUpdate: number[] = [];
    const atRender: number[] = [];
    const origUpdate = player.update.bind(player);
    (player as unknown as { update: (dt: number) => void }).update = (dt: number) => {
      atUpdate.push(node.position.x);
      origUpdate(dt);
    };
    mock._setOnRender(() => atRender.push(node.position.x));
    player.setParallax(ON);
    player.setParallaxPointer({ x: 1, y: 0.5 });
    player.setAnimationLoop();
    mock._getLoop()!();
    expect(atUpdate[0]).toBe(0);                   // update 当刻还没施加视差
    expect(atRender[0]).toBeCloseTo(-960, 3);      // render 前已施加
    player.dispose();
  });

  it('loadSceneToThree：image/text/particle 三种 kind 的 parallaxDepth 全部透传', () => {
    const canvas = document.createElement('canvas');
    const mock = createMockRenderer();
    const scene = JSON.stringify({
      general: { orthogonalprojection: { height: 1080, width: 1920 } },
      objects: [
        { id: 13, image: 'models/a.json', origin: '960 540 0', scale: '1 1 1', size: '100 100', parallaxDepth: '1.00000 1.00000' },
        // text 的 parallaxDepth 同样要透传（真实库 20 处；写成 `kind === 'image' ? … : undefined` 会丢掉它）
        { id: 20, text: { value: 'x' }, origin: '1160 640 0', scale: '1 1 1', size: '200 140', parallaxDepth: '1.00000 1.00000' },
        { id: 22, particle: 'particles/presets/smoke2.json', origin: '1260 740 0', scale: '1 1 1', parallaxDepth: '1.00000 1.00000' },
      ],
    });
    const tex = () => new THREE.DataTexture(new Uint8Array(4), 2, 2);
    const sim: ParticleSim = {
      update: vi.fn(), vertices: () => new Float32Array(0), frame_count: () => 1,
      set_frame_count: vi.fn(), particle_count: () => 0,
    };
    const result = loadSceneToThree(scene, {
      renderer: mock as unknown as THREE.WebGLRenderer,
      backgroundTextures: new Map([[13, tex()]]),
      textLayers: new Map([[20, { texture: tex(), size: [200, 140] as [number, number] }]]),
      particles: new Map([[22, { specJson: '{}', blend: 'alpha' as const }]]),
      createParticleSim: () => sim,
    }, canvas);
    const player = result.player;
    player.setParallax(ON);
    player.setParallaxPointer({ x: 1, y: 0.5 });
    player.tickParallaxForTest(0.016);
    // node = origin - 场景中心：image (0,0) / text (200,100) / particle (300,200)；mouse_x = -960。
    // 位置 = node + shift = node + depth ⊙ (node - cam + mouse)。
    expect(player.displayObject(13)!.position.x).toBeCloseTo(-960, 3);
    expect(player.displayObject(20)!.position.x).toBeCloseTo(-560, 3);
    expect(player.displayObject(20)!.position.y).toBeCloseTo(200, 3);
    const pmat = (player.displayObject(22) as THREE.Mesh).material as THREE.ShaderMaterial;
    expect(pmat.uniforms.u_Parallax.value.x).toBeCloseTo(-660, 3);
    expect(pmat.uniforms.u_Parallax.value.y).toBeCloseTo(200, 3);
    player.dispose();
  });
});

// puppet 图层（Task 7）：装配（addPuppet）、逐帧采样与释放。本机唯一 .mdl 样本是静态族 ⇒ 这里用桩实例
// 钉住**接线**（真实几何/骨骼数值由 tests/puppet.test.ts 覆盖）。
describe('puppet 图层（addPuppet / image 分支 / 逐帧动画）', () => {
  type PuppetStub = PuppetInstance & { frames: number[]; anims: number[]; disposed: number };

  function makePuppetStub(animations: PuppetInstance['animations'] = []): PuppetStub {
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    const stub: PuppetStub = {
      mesh, bones: [], skeleton: null, animations,
      frames: [], anims: [], disposed: 0,
      applyFrame: (_anim, frame) => { stub.frames.push(frame); stub.anims.push(_anim.id); },
      dispose: () => { stub.disposed++; },
    };
    return stub;
  }

  const anim = {
    id: 7, name: 'idle', mode: 'loop', fps: 10, frameCount: 3,
    tracks: [{ boneId: 0, keys: [{ pos: [0, 0, 0] as [number, number, number], rot: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1] as [number, number] }] }],
  };

  it('addPuppet：we_to_three 定位 + scale/angles/renderOrder + 脚本桥登记（与 addBackground 同一编号空间）', () => {
    const { player } = makePlayer(1920, 1080);
    const stub = makePuppetStub([anim]);
    const id = player.addPuppet({
      objectId: 16, puppet: stub, origin: [1000, 600, 3], scale: [2, 4, 1],
      angles: [0.5, 0, 0], sceneW: 1920, sceneH: 1080, renderOrder: 5,
    });
    expect(id).toBe(0);                                   // 与 addBackground 共用图层计数器
    expect(player.displayObject(16)).toBe(stub.mesh);      // scene 对象 id → 显示对象
    expect(player.scene.children).toContain(stub.mesh);
    // we_to_three = origin − viewport/2（y 不翻转，见 AGENT.md §2.3）
    expect(stub.mesh.position.x).toBeCloseTo(40, 6);
    expect(stub.mesh.position.y).toBeCloseTo(60, 6);
    expect(stub.mesh.position.z).toBeCloseTo(3, 6);
    expect(stub.mesh.scale.toArray()).toEqual([2, 4, 1]);
    expect(stub.mesh.rotation.x).toBeCloseTo(0.5, 6);
    expect(stub.mesh.renderOrder).toBe(5);
    // 视差落点 = puppet 自身 mesh（不在隔离路径上，没有合成 quad）
    expect(player.backgroundMeshForTest(id)).toBe(stub.mesh);
  });

  it('addPuppet 透传对象级 alpha/brightness（与背景同源 materialModulation）；缺省 1/1 逐像素不变', () => {
    const { player } = makePlayer(1920, 1080);
    const dim = makePuppetStub();
    const plain = makePuppetStub();
    player.addPuppet({
      objectId: 1, puppet: dim, origin: [960, 540, 0], scale: [1, 1, 1], angles: [0, 0, 0],
      sceneW: 1920, sceneH: 1080, alpha: 0.5, brightness: 0.5,
    });
    player.addPuppet({
      objectId: 2, puppet: plain, origin: [960, 540, 0], scale: [1, 1, 1], angles: [0, 0, 0],
      sceneW: 1920, sceneH: 1080,
    });
    const dm = dim.mesh.material as THREE.MeshBasicMaterial;
    expect(dm.opacity).toBeCloseTo(0.5, 6);           // alpha → material.opacity
    expect(dm.color.r).toBeCloseTo(0.5, 6);           // brightness 乘入 color（白 × 0.5）
    expect([dm.color.g, dm.color.b]).toEqual([0.5, 0.5]);
    const pm = plain.mesh.material as THREE.MeshBasicMaterial;
    expect(pm.opacity).toBe(1);                       // 缺省 1/1 → 与改动前逐像素一致
    expect(pm.color.toArray()).toEqual([1, 1, 1]);
  });

  it('addPuppet 带 parallaxDepth ⇒ 与背景同一套视差位移；depth 缺失 ⇒ 不动', () => {
    const { player } = makePlayer(1920, 1080);
    const moved = makePuppetStub();
    const still = makePuppetStub();
    player.addPuppet({
      objectId: 1, puppet: moved, origin: [960, 540, 0], scale: [1, 1, 1], angles: [0, 0, 0],
      sceneW: 1920, sceneH: 1080, parallaxDepth: [1, 1],
    });
    player.addPuppet({
      objectId: 2, puppet: still, origin: [960, 540, 0], scale: [1, 1, 1], angles: [0, 0, 0],
      sceneW: 1920, sceneH: 1080,
    });
    player.setParallax({ enabled: true, amount: 1, delay: 0, mouseInfluence: 1 });
    player.setParallaxPointer({ x: 1, y: 0.5 });
    player.tickParallaxForTest(0.016);
    expect(moved.mesh.position.x).toBeCloseTo(-1920 / 2, 3); // 鼠标右移 → 内容左移
    expect(still.mesh.position.x).toBeCloseTo(0, 6);
  });

  it('逐帧采样首个动画：帧号 = 已播秒数 × fps 对帧数取模；无动画层直接跳过', () => {
    const { player } = makePlayer(1920, 1080);
    const stub = makePuppetStub([anim]);
    const silent = makePuppetStub();
    player.addPuppet({
      objectId: 1, puppet: stub, origin: [960, 540, 0], scale: [1, 1, 1], angles: [0, 0, 0],
      sceneW: 1920, sceneH: 1080,
    });
    player.addPuppet({
      objectId: 2, puppet: silent, origin: [960, 540, 0], scale: [1, 1, 1], angles: [0, 0, 0],
      sceneW: 1920, sceneH: 1080,
    });
    player.update(0.05);   // 0.05s × 10fps = 0.5 帧
    player.update(0.25);   // 累计 0.3s × 10fps = 3 帧 → 对 3 帧取模回到 0
    expect(stub.frames).toEqual([0.5, 0]);
    expect(silent.frames).toEqual([]);
  });

  it('animationLayers：只应用第一条可见层（按 id 找动画、rate 乘进时钟、visible=false 被过滤）', () => {
    const { player } = makePlayer(1920, 1080);
    // 动画表首个是 id=7（fps 10 / 3 帧），但层选的是 id=3（fps 20 / 4 帧）⇒ 选错动画会立刻在帧号上暴露。
    const stub = makePuppetStub([
      { ...anim, id: 7, name: 'idle', fps: 10, frameCount: 3 },
      { ...anim, id: 3, name: 'walk', fps: 20, frameCount: 4 },
    ]);
    player.addPuppet({
      objectId: 1, puppet: stub, origin: [960, 540, 0], scale: [1, 1, 1], angles: [0, 0, 0],
      sceneW: 1920, sceneH: 1080,
      animationLayers: [
        { id: 0, animation: 3, rate: 1, blend: 1, visible: false },   // 不可见 ⇒ 不参与选择
        { id: 1, animation: 3, rate: 2, blend: 1, visible: true },    // 第一条可见层：动画 3、rate 2
        { id: 2, animation: 7, rate: 1, blend: 1, visible: true },    // 第二条可见层：v1 不应用
      ],
    });
    player.update(0.1);    // 0.1s × rate 2 = 0.2s → 0.2 × 20fps = 4 帧 % 4 = 0
    player.update(0.05);   // 累计 0.3s → 6 帧 % 4 = 2（回绕落在 [0, frameCount)）
    expect(stub.anims).toEqual([3, 3]);
    expect(stub.frames).toHaveLength(2);
    expect(stub.frames[0]).toBeCloseTo(0, 6);
    expect(stub.frames[1]).toBeCloseTo(2, 6);   // 帧号本身是浮点（0.3 × 20fps 对 4 取模）
    player.dispose();
  });

  it('animationLayers 多条可见层：只应用第一条并告警一次（不逐帧刷屏）', () => {
    const { player } = makePlayer(1920, 1080);
    const stub = makePuppetStub([
      { ...anim, id: 7, name: 'idle' },
      { ...anim, id: 3, name: 'walk' },
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    player.addPuppet({
      objectId: 1, puppet: stub, origin: [960, 540, 0], scale: [1, 1, 1], angles: [0, 0, 0],
      sceneW: 1920, sceneH: 1080,
      animationLayers: [
        { id: 0, animation: 7, rate: 1, blend: 1, visible: true },
        { id: 1, animation: 3, rate: 1, blend: 1, visible: true },
      ],
    });
    player.update(0.1);
    player.update(0.1);
    expect(stub.anims).toEqual([7, 7]);
    const hits = warn.mock.calls.filter((c) => String(c[0]).includes('只应用第一条'));
    expect(hits).toHaveLength(1);
    expect(String(hits[0][0])).toContain('idle');
    warn.mockRestore();
    player.dispose();
  });

  it('animationLayers 为空数组/无可见层/动画 id 不存在/帧数为 0 ⇒ 不采样；字段缺失 ⇒ 播首个动画（零回归）', () => {
    const { player } = makePlayer(1920, 1080);
    const empty = makePuppetStub([{ ...anim, id: 3 }]);
    const invisible = makePuppetStub([{ ...anim, id: 3 }]);
    const missingAnim = makePuppetStub([{ ...anim, id: 7 }]);
    const zeroFrames = makePuppetStub([{ ...anim, id: 3, frameCount: 0 }]);
    const legacy = makePuppetStub([{ ...anim, id: 3 }]);
    const base = { origin: [960, 540, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number], angles: [0, 0, 0] as [number, number, number], sceneW: 1920, sceneH: 1080 };
    player.addPuppet({ objectId: 1, puppet: empty, ...base, animationLayers: [] });
    player.addPuppet({ objectId: 2, puppet: invisible, ...base, animationLayers: [{ id: 0, animation: 3, rate: 1, blend: 1, visible: false }] });
    player.addPuppet({ objectId: 3, puppet: missingAnim, ...base, animationLayers: [{ id: 0, animation: 99, rate: 1, blend: 1, visible: true }] });
    player.addPuppet({ objectId: 4, puppet: zeroFrames, ...base, animationLayers: [{ id: 0, animation: 3, rate: 1, blend: 1, visible: true }] });
    player.addPuppet({ objectId: 5, puppet: legacy, ...base });   // 无 animationLayers 字段
    player.update(0.1);
    expect([empty.frames, invisible.frames, missingAnim.frames, zeroFrames.frames]).toEqual([[], [], [], []]);
    expect(legacy.anims).toEqual([3]);    // 改动前行为：取动画表首个、rate 1 循环
    expect(legacy.frames).toEqual([1]);   // 0.1s × 10fps = 1 帧
    player.dispose();
  });

  it('采样抛错且 dispose 也抛错 ⇒ 图层照样摘掉（不每帧重复抛、不把帧循环打断）', () => {
    const { player } = makePlayer(1920, 1080);
    const broken = makePuppetStub([anim]);
    let calls = 0;
    let disposes = 0;
    broken.applyFrame = () => { calls++; throw new Error('骨骼矩阵爆炸'); };
    broken.dispose = () => { disposes++; throw new Error('释放也炸'); };
    player.addPuppet({
      objectId: 1, puppet: broken, origin: [960, 540, 0], scale: [1, 1, 1], angles: [0, 0, 0],
      sceneW: 1920, sceneH: 1080,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // dispose 抛错也不得穿出帧循环（update 抛错会跳过 render ⇒ 本帧画面不更新）
    expect(() => player.update(0.1)).not.toThrow();
    expect([calls, disposes]).toEqual([1, 1]);
    player.update(0.1);                          // delete 在 finally 里 ⇒ 下一帧不再重复抛
    expect([calls, disposes]).toEqual([1, 1]);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('puppet 动画采样失败'))).toBe(true);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('puppet 释放失败'))).toBe(true);
    warn.mockRestore();
    player.dispose();
  });

  it('loadSceneToThree：scene.json 的 animationlayers 透传到选层（走 image 分支入参）', () => {
    const scene = JSON.stringify({
      camera: { center: '0 0 0', eye: '0 0 1', up: '0 1 0' },
      general: { orthogonalprojection: { width: 1920, height: 1080 } },
      objects: [{
        id: 16, name: 'puppet', image: 'models/p.json', origin: '1000 600 0', scale: '2 2 1', size: '100 100',
        animationlayers: [{ id: 0, animation: 3, rate: 1, blend: 1, visible: true }],
      }],
    });
    const stub = makePuppetStub([
      { ...anim, id: 7, fps: 10, frameCount: 3 },
      { ...anim, id: 3, fps: 20, frameCount: 4 },
    ]);
    const result = loadSceneToThree(
      scene,
      { renderer: createMockRenderer() as unknown as THREE.WebGLRenderer, puppetMeshes: new Map([[16, stub]]) },
      document.createElement('canvas'),
    );
    result.player.update(0.1);         // 0.1s × 20fps = 2 帧（选中动画 3 才会是 2；选 7 会是 1）
    expect(stub.anims).toEqual([3]);
    expect(stub.frames).toEqual([2]);
    result.player.dispose();
  });

  it('loadSceneToThree：puppetMeshes 命中 ⇒ 走 addPuppet（不再建 quad），并计入 puppetLayers', () => {
    const scene = JSON.stringify({
      camera: { center: '0 0 0', eye: '0 0 1', up: '0 1 0' },
      general: { orthogonalprojection: { width: 1920, height: 1080 } },
      objects: [{ id: 16, name: 'puppet', image: 'models/p.json', origin: '1000 600 0', scale: '2 2 1', size: '100 100' }],
    });
    const stub = makePuppetStub([anim]);
    const result = loadSceneToThree(
      scene,
      { renderer: createMockRenderer() as unknown as THREE.WebGLRenderer, puppetMeshes: new Map([[16, stub]]) },
      document.createElement('canvas'),
    );
    expect(result.puppetLayers).toEqual(result.backgroundIds);   // 同一批图层 id
    expect(result.backgroundIds).toHaveLength(1);
    expect(result.player.displayObject(16)).toBe(stub.mesh);
    expect(stub.mesh.position.x).toBeCloseTo(40, 6);
    expect(stub.mesh.scale.toArray()).toEqual([2, 2, 1]);
    // 该对象只有 puppet 一个显示物：主场景里除了 puppet mesh 没有额外的背景 quad
    expect(result.player.scene.children).toEqual([stub.mesh]);
    // 帧循环经 player.update 推进 → puppet 也被采样
    result.player.update(0.2);   // 0.2s × 10fps = 2 帧
    expect(stub.frames).toEqual([2]);
  });

  it('loadSceneToThree：puppetMeshes 未命中 ⇒ 维持既有背景 quad 路径（零回归）', () => {
    const scene = JSON.stringify({
      camera: { center: '0 0 0', eye: '0 0 1', up: '0 1 0' },
      general: { orthogonalprojection: { width: 1920, height: 1080 } },
      objects: [{ id: 16, name: 'bg', image: 'models/p.json', origin: '960 540 0', scale: '1 1 1', size: '100 100' }],
    });
    const tex = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    const result = loadSceneToThree(
      scene,
      {
        renderer: createMockRenderer() as unknown as THREE.WebGLRenderer,
        backgroundTextures: new Map([[16, tex]]),
        puppetMeshes: new Map(),
      },
      document.createElement('canvas'),
    );
    expect(result.puppetLayers).toEqual([]);
    expect(result.backgroundIds).toHaveLength(1);
    expect(result.player.scene.children[0]).toBeInstanceOf(THREE.Mesh);
    expect((result.player.scene.children[0] as THREE.Mesh).geometry.type).toBe('PlaneGeometry');
  });

  it('loadSceneToThree：puppet 对象的 scene.json alpha/brightness 透传到网格材质', () => {
    const scene = JSON.stringify({
      camera: { center: '0 0 0', eye: '0 0 1', up: '0 1 0' },
      general: { orthogonalprojection: { width: 1920, height: 1080 } },
      objects: [{
        id: 16, name: 'puppet', image: 'models/p.json', origin: '1000 600 0', scale: '2 2 1',
        size: '100 100', alpha: 0.25, brightness: 0.5,
      }],
    });
    const stub = makePuppetStub();
    const result = loadSceneToThree(
      scene,
      { renderer: createMockRenderer() as unknown as THREE.WebGLRenderer, puppetMeshes: new Map([[16, stub]]) },
      document.createElement('canvas'),
    );
    const mat = stub.mesh.material as THREE.MeshBasicMaterial;
    expect(mat.opacity).toBeCloseTo(0.25, 6);
    expect(mat.color.r).toBeCloseTo(0.5, 6);
    expect(result.puppetLayers).toHaveLength(1);
  });

  it('resizeBackground 对 puppet 图层早退：不换成 PlaneGeometry、不 dispose 蒙皮几何', () => {
    const { player } = makePlayer(1920, 1080);
    const stub = makePuppetStub();
    const geometry = stub.mesh.geometry;
    const disposeSpy = vi.spyOn(geometry, 'dispose');
    const id = player.addPuppet({
      objectId: 1, puppet: stub, origin: [960, 540, 0], scale: [1, 1, 1], angles: [0, 0, 0],
      sceneW: 1920, sceneH: 1080,
    });
    player.resizeBackground(id, [200, 100]);
    expect(stub.mesh.geometry).toBe(geometry);
    expect(geometry.type).toBe('BufferGeometry');
    expect(disposeSpy).not.toHaveBeenCalled();
  });

  it('单个 puppet 的采样抛错 ⇒ 只丢弃该图层的动画，不中断帧循环/不连累其它图层', () => {
    const { player } = makePlayer(1920, 1080);
    const broken = makePuppetStub([anim]);
    let calls = 0;
    broken.applyFrame = () => { calls++; throw new Error('骨骼矩阵爆炸'); };
    const healthy = makePuppetStub([anim]);
    player.addPuppet({
      objectId: 1, puppet: broken, origin: [960, 540, 0], scale: [1, 1, 1], angles: [0, 0, 0],
      sceneW: 1920, sceneH: 1080,
    });
    player.addPuppet({
      objectId: 2, puppet: healthy, origin: [960, 540, 0], scale: [1, 1, 1], angles: [0, 0, 0],
      sceneW: 1920, sceneH: 1080,
    });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => player.update(0.1)).not.toThrow();   // 0.1s × 10fps = 帧号 1
    expect(healthy.frames).toHaveLength(1);
    expect(healthy.frames[0]).toBeCloseTo(1, 6);      // 健康图层照常采样
    expect(warn.mock.calls.some((c) => String(c[0]).includes('puppet 动画采样失败'))).toBe(true);
    // 坏图层被摘掉：下一帧不再重复抛错（不刷屏），健康图层继续
    player.update(0.1);
    expect(calls).toBe(1);
    expect(healthy.frames).toHaveLength(2);
    expect(healthy.frames[1]).toBeCloseTo(2, 6);
    // 摘掉即释放：这是该实例唯一的释放机会（player.dispose 只遍历仍在表里的图层）。
    expect(broken.disposed).toBe(1);
    expect(healthy.disposed).toBe(0);
    warn.mockRestore();
    player.dispose();
  });

  it('采样失败摘表 ⇒ 同 id 的 backgroundEntries/displayObjects 引用一并摘净，resizeBackground 不再换掉已 dispose 的蒙皮几何', () => {
    const { player } = makePlayer(1920, 1080);
    const broken = makePuppetStub([anim]);
    broken.applyFrame = () => { throw new Error('骨骼矩阵爆炸'); };
    const id = player.addPuppet({
      objectId: 16, puppet: broken, origin: [960, 540, 0], scale: [1, 1, 1], angles: [0, 0, 0],
      sceneW: 1920, sceneH: 1080,
    });
    const geometry = broken.mesh.geometry;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    player.update(0.1);
    expect(broken.disposed).toBe(1);
    // 残留 backgroundEntries 条目会让 resizeBackground（只查 puppetLayers）把已 dispose 的蒙皮几何换成
    // PlaneGeometry。⚠️ 生产上只有文本层调它 ⇒ 这是潜在地雷而非现行活路径，故用注释钉住而不是删守卫。
    player.resizeBackground(id, [200, 100]);
    expect(broken.mesh.geometry).toBe(geometry);
    expect(broken.mesh.geometry.type).toBe('BufferGeometry');
    expect(player.displayObject(16)).toBeUndefined();          // 脚本桥不留悬垂引用
    expect(() => player.backgroundMeshForTest(id)).toThrow();  // 图层条目也已摘除
    warn.mockRestore();
    player.dispose();
  });

  it('player.dispose() 释放 puppet 实例（同一份图层生命周期）', () => {
    const { player } = makePlayer(1920, 1080);
    const stub = makePuppetStub([anim]);
    player.addPuppet({
      objectId: 1, puppet: stub, origin: [960, 540, 0], scale: [1, 1, 1], angles: [0, 0, 0],
      sceneW: 1920, sceneH: 1080,
    });
    player.dispose();
    expect(stub.disposed).toBe(1);
  });
});

// scene 抓帧（v0.8 Task 6）：captureNextFrame 必须在 render() 同一 JS 任务内读默认 framebuffer；
// 失败/不支持只 resolve(null)，不得把异常抛进帧循环。
describe('scene 抓帧 captureNextFrame', () => {
  // mock renderer 追加抓帧接口：drawingBuffer 尺寸 + readPixels（生产上就是 THREE.WebGLRenderer 的两个成员）。
  function captureMock() {
    const mock = createMockRenderer();
    const readPixels = vi.fn(
      (_x: number, _y: number, _w: number, _h: number, _f: number, _t: number, out: Uint8Array) => {
        out.fill(7);
      },
    );
    const gl = { RGBA: 0x1908, UNSIGNED_BYTE: 0x1401, drawingBufferWidth: 2, drawingBufferHeight: 2, readPixels };
    (mock as unknown as { getContext: () => unknown }).getContext = () => gl;
    (mock as unknown as { domElement: { width: number; height: number } }).domElement = { width: 2, height: 2 };
    return { mock, readPixels };
  }

  it('render() 末尾按 drawingBuffer 尺寸读默认 framebuffer（node 无 OffscreenCanvas ⇒ 编码返回 null）', async () => {
    const { mock, readPixels } = captureMock();
    const { player } = makePlayer(2, 2, mock);
    const pending = player.captureNextFrame();
    player.render();
    await expect(pending).resolves.toBeNull();
    expect(readPixels).toHaveBeenCalledWith(0, 0, 2, 2, 0x1908, 0x1401, expect.any(Uint8Array));
    player.dispose();
  });

  it('同一时刻只允许一个 pending：第二次调用立即 null，本帧只读一次像素', async () => {
    const { mock, readPixels } = captureMock();
    const { player } = makePlayer(2, 2, mock);
    const first = player.captureNextFrame();
    const second = player.captureNextFrame();
    await expect(second).resolves.toBeNull();
    player.render();
    await expect(first).resolves.toBeNull();
    expect(readPixels).toHaveBeenCalledTimes(1);
    player.dispose();
  });

  it('无 pending 时 render() 不读像素（对渲染零影响）', () => {
    const { mock, readPixels } = captureMock();
    const { player } = makePlayer(2, 2, mock);
    player.render();
    expect(readPixels).not.toHaveBeenCalled();
    player.dispose();
  });

  it('dispose() 将未决请求 resolve(null)，不再读像素', async () => {
    const { mock, readPixels } = captureMock();
    const { player } = makePlayer(2, 2, mock);
    const pending = player.captureNextFrame();
    player.dispose();
    await expect(pending).resolves.toBeNull();
    expect(readPixels).not.toHaveBeenCalled();
  });

  it('读像素抛错 → resolve(null) 且只 warn（不抛进帧循环）', async () => {
    const mock = createMockRenderer();
    (mock as unknown as { getContext: () => unknown }).getContext = () => { throw new Error('context lost'); };
    const { player } = makePlayer(2, 2, mock);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pending = player.captureNextFrame();
    expect(() => player.render()).not.toThrow();
    await expect(pending).resolves.toBeNull();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('抓帧'))).toBe(true);
    warn.mockRestore();
    player.dispose();
  });

  it('WebGL 上下文已丢失 → 跳过读像素（不把黑帧写进首帧缓存）', async () => {
    const mock = createMockRenderer();
    const readPixels = vi.fn();
    (mock as unknown as { getContext: () => unknown }).getContext = () => ({
      RGBA: 0x1908, UNSIGNED_BYTE: 0x1401, drawingBufferWidth: 2, drawingBufferHeight: 2,
      readPixels, isContextLost: () => true,
    });
    const { player } = makePlayer(2, 2, mock);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pending = player.captureNextFrame();
    player.render();
    await expect(pending).resolves.toBeNull();
    expect(readPixels).not.toHaveBeenCalled();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('上下文已丢失'))).toBe(true);
    warn.mockRestore();
    player.dispose();
  });
});


// v0.8.1 F13：image 图层精灵表帧 UV（材质 combos.spritesheet=1 + TEXS 帧元数据）。
// UV 子矩形 v 方向约定：v=0 = 图像底部（tex-loader 的显示约定），TEXS 的 row 0 = 表顶行
// ⇒ 第 0 行落在高 v 段（与粒子 shader 的 (rows-1-row) 反转同源）。
describe('image 精灵表帧 UV（F13）', () => {
  const IMG = { origin: [0, 0, 0] as [number, number, number], size: [256, 256] as [number, number], scale: [1, 1, 1] as [number, number, number], sceneW: 1920, sceneH: 1080, objectId: 123 };
  const spriteTex = (frames: number, cols: number, rows: number): THREE.Texture => {
    const tex = new THREE.Texture();
    tex.userData.sprite = { frames, cols, rows };
    tex.userData.spritesheet = true;
    return tex;
  };
  const planeUv = (player: ThreeScenePlayer): number[] => {
    const mesh = player.scene.children[0] as THREE.Mesh;
    return [...(mesh.geometry.attributes.uv.array as Float32Array)];
  };

  it('3 帧竖排：t=0 第 1 帧、t=1s 第 2 帧，geometry UV 写入当前帧子矩形', () => {
    const { player } = makePlayer();
    const tex = spriteTex(3, 1, 3);
    player.addBackground({ ...IMG, texture: tex });
    expect(player.spritesheetUvForTest(123)).toEqual({ u0: 0, v0: 2 / 3, u1: 1, v1: 1 });
    player.update(1.0);
    expect(player.spritesheetUvForTest(123)).toEqual({ u0: 0, v0: 1 / 3, u1: 1, v1: 2 / 3 });
    // PlaneGeometry 顶点 UV 顺序：(0,1) (1,1) (0,0) (1,0)；Float32 uv 缓冲按 6 位小数比较。
    const uv = planeUv(player);
    [0, 2 / 3, 1, 2 / 3, 0, 1 / 3, 1, 1 / 3].forEach((exp, i) => expect(uv[i]).toBeCloseTo(exp, 6));
    player.dispose();
  });

  it('帧率 1fps：0.5s 仍在第 1 帧，1.0s 才到第 2 帧', () => {
    const { player } = makePlayer();
    player.addBackground({ ...IMG, texture: spriteTex(3, 1, 3) });
    player.update(0.5);
    expect(player.spritesheetUvForTest(123)).toEqual({ u0: 0, v0: 2 / 3, u1: 1, v1: 1 });
    player.update(0.5);
    expect(player.spritesheetUvForTest(123)).toEqual({ u0: 0, v0: 1 / 3, u1: 1, v1: 2 / 3 });
    player.dispose();
  });

  it('TEXS frametime 覆盖缺省 1fps（0.5s/帧 = 2fps）', () => {
    const { player } = makePlayer();
    const tex = spriteTex(3, 1, 3);
    tex.userData.sprite = { frames: 3, cols: 1, rows: 3, frametime: 0.5 };
    player.addBackground({ ...IMG, texture: tex });
    player.update(0.5); // 半秒 → 第 2 帧（1fps 时此处仍是第 1 帧）
    expect(player.spritesheetUvForTest(123)).toEqual({ u0: 0, v0: 1 / 3, u1: 1, v1: 2 / 3 });
    player.dispose();
  });

  it('帧循环：t=2s 第 3 帧、t=3s 回到第 1 帧', () => {
    const { player } = makePlayer();
    player.addBackground({ ...IMG, texture: spriteTex(3, 1, 3) });
    player.update(2.0);
    expect(player.spritesheetUvForTest(123)).toEqual({ u0: 0, v0: 0, u1: 1, v1: 1 / 3 });
    player.update(1.0);
    expect(player.spritesheetUvForTest(123)).toEqual({ u0: 0, v0: 2 / 3, u1: 1, v1: 1 });
    player.dispose();
  });

  it('二维网格：2×2 的第 3 帧 = 第 2 行第 1 列（floor 行列映射）', () => {
    const { player } = makePlayer();
    player.addBackground({ ...IMG, texture: spriteTex(4, 2, 2) });
    player.update(2.0);
    expect(player.spritesheetUvForTest(123)).toEqual({ u0: 0, v0: 0, u1: 0.5, v1: 0.5 });
    player.dispose();
  });

  it('非 spritesheet 纹理：UV 不接管（整图 [0,1]² 保持不变）', () => {
    const { player } = makePlayer();
    const tex = new THREE.Texture(); // 普通 image 纹理（无 userData.spritesheet）
    player.addBackground({ ...IMG, texture: tex });
    const before = planeUv(player);
    player.update(2.0);
    expect(planeUv(player)).toEqual(before);
    expect(player.spritesheetUvForTest(123)).toBeNull();
    player.dispose();
  });

  it('有 spritesheet 标记但缺 TEXS 帧元数据 ⇒ 不接管 UV（失败开放，保持整图）', () => {
    const { player } = makePlayer();
    const tex = new THREE.Texture();
    tex.userData.spritesheet = true;
    player.addBackground({ ...IMG, texture: tex });
    const before = planeUv(player);
    player.update(1.0);
    expect(planeUv(player)).toEqual(before);
    expect(player.spritesheetUvForTest(123)).toBeNull();
    player.dispose();
  });

  it('未登记的对象 id ⇒ null（不抛）', () => {
    const { player } = makePlayer();
    player.addBackground({ ...IMG, texture: spriteTex(3, 1, 3) });
    expect(player.spritesheetUvForTest(999)).toBeNull();
    player.dispose();
  });

  it('resizeBackground 换几何后仍写当前帧子矩形（新几何 UV 是整图，不能退回整表）', () => {
    const { player } = makePlayer();
    const id = player.addBackground({ ...IMG, texture: spriteTex(3, 1, 3) });
    player.update(1.0); // 第 2 帧
    player.resizeBackground(id, [128, 256]);
    expect(player.spritesheetUvForTest(123)).toEqual({ u0: 0, v0: 1 / 3, u1: 1, v1: 2 / 3 });
    const uv = planeUv(player);
    [0, 2 / 3, 1, 2 / 3, 0, 1 / 3, 1, 1 / 3].forEach((exp, i) => expect(uv[i]).toBeCloseTo(exp, 6));
    player.dispose();
  });

  // 对象级脚本控制（2026-10-20）：3765967112 的 angles.script init 会 pause + setFrame，
  // 之后 updateSpriteSheets 不得再自动推进（桌面 WE 图标静止）。
  it('pause 后 dt 推进不换帧；setFrame 立即写 UV；play 恢复自动推进', () => {
    const { player } = makePlayer();
    player.addBackground({ ...IMG, texture: spriteTex(3, 1, 3) });
    expect(player.isSpriteSheetPlaying(123)).toBe(true);
    player.pauseSpriteSheet(123);
    expect(player.isSpriteSheetPlaying(123)).toBe(false);
    player.update(5.0); // 5 秒足以自动播完一整轮
    expect(player.getSpriteSheetFrame(123)).toBe(0);
    expect(player.spritesheetUvForTest(123)).toEqual({ u0: 0, v0: 2 / 3, u1: 1, v1: 1 });
    player.setSpriteSheetFrame(123, 2);
    expect(player.getSpriteSheetFrame(123)).toBe(2);
    expect(player.spritesheetUvForTest(123)).toEqual({ u0: 0, v0: 0, u1: 1, v1: 1 / 3 });
    player.update(0.9); // 暂停期间仍不推进
    expect(player.getSpriteSheetFrame(123)).toBe(2);
    player.playSpriteSheet(123);
    expect(player.isSpriteSheetPlaying(123)).toBe(true);
    player.update(1.1); // elapsed 从 setFrame 的 2s 继续：3.1s → 第 0 帧
    expect(player.getSpriteSheetFrame(123)).toBe(0);
    player.dispose();
  });

  it('stop 停播并回到第 0 帧；未登记 id 的控制方法安全 no-op', () => {
    const { player } = makePlayer();
    player.addBackground({ ...IMG, texture: spriteTex(3, 1, 3) });
    player.setSpriteSheetFrame(123, 1);
    player.stopSpriteSheet(123);
    expect(player.getSpriteSheetFrame(123)).toBe(0);
    expect(player.isSpriteSheetPlaying(123)).toBe(false);
    expect(player.spritesheetUvForTest(123)).toEqual({ u0: 0, v0: 2 / 3, u1: 1, v1: 1 });
    player.update(3.0);
    expect(player.getSpriteSheetFrame(123)).toBe(0);
    expect(() => {
      player.pauseSpriteSheet(999);
      player.playSpriteSheet(999);
      player.stopSpriteSheet(999);
      player.setSpriteSheetFrame(999, 1);
    }).not.toThrow();
    expect(player.getSpriteSheetFrame(999)).toBe(-1);
    expect(player.isSpriteSheetPlaying(999)).toBe(false);
    player.dispose();
  });
});


describe('pixel-bars visualizer（v0.9 修复 #3118949804：视觉条按对象 scale/angles 布局 + minBarHeight）', () => {
  it('静音时高度 = minBarHeight；有音频按 scale.y×0.25；角度承载对象旋转', () => {
    const { player } = makePlayer(3840, 2160);
    const ids = player.setPixelVisualizerBars({
      origin: [-4.5, 816, 0],
      scale: [1800, 500, 1],
      angles: [0, 0, -1.5707963267948966],
      barSize: [1, 2],
      barWidth: 14.0625,
      minBarHeight: 5,
      scaleY: 500,
      barPath: 'models/workshop/3007895627/full-pixel.json',
      downscaleMode: 'max',
      sceneW: 3840,
      sceneH: 2160,
      count: 4,
    });
    expect(ids).toHaveLength(4);
    const bars = player.scene.children as THREE.Mesh[];
    expect(bars).toHaveLength(4);
    // 静音：世界高 = texH(2) × minBarHeight(5) ⇒ 倍率 5
    expect(bars[0].scale.y).toBeCloseTo(5, 6);
    // 对象 angles 承载到 mesh（弧度）
    expect(bars[0].rotation.z).toBeCloseTo(-1.5707963267948966, 6);
    // 条宽倍率 = 世界条宽（tex 宽 1）
    expect(bars[0].scale.x).toBeCloseTo(14.0625, 6);
    const freq = new Uint8Array(64);
    freq[0] = 255;
    player.updateVisualizerBars(freq);
    // max(5, 255/255 × 500 × 0.25) = 125
    expect(bars[0].scale.y).toBeCloseTo(125, 3);
    player.updateVisualizerBars(null);
    expect(bars[0].scale.y).toBeCloseTo(5, 6);
  });
});
