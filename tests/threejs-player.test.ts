// @vitest-environment jsdom
// Task 1：three.js 场景骨架。WebGLRenderer 无法在 node/jsdom（无 WebGL）环境构造，
// 测试按契约「可 mock renderer」注入 mock（真实 Scene/Camera/cover 数值仍可验证）。
// 聚焦：构造后 scene/camera/renderer 存在；resize 更新 cover；update+render 不抛错；
// 正交相机 cover 尺寸正确（复用 scene-renderer.coverRange 语义）。

import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { ThreeScenePlayer } from '../src/client/threejs-player.js';
import { coverRange } from '../src/client/scene-renderer.js';

// 注入的 mock renderer：只测相机/场景/RAF 逻辑，不触碰 WebGL。
function createMockRenderer() {
  let loop: (() => void) | null = null;
  const setAnimationLoop = vi.fn((fn: (() => void) | null) => {
    loop = fn;
  });
  const renderer = {
    setSize: vi.fn(),
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

  it('update_background：未知 id → no-op（不抛错）', () => {
    const { player } = makePlayer(3840, 2160);
    expect(() => player.update_background(999, [1, 2, 3])).not.toThrow();
  });
});
