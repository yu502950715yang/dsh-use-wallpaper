// 对象级效果链所需的共享纯函数。本文件断言两件事：
//   ① 行为与搬移前一致（关键边界：幅值/钳制/下限、UV 窗口、等比与钳制语义）；
//   ② scene-renderer.ts 的重新导出与 object-range.ts 是**同一个函数对象**
//      （防止有人日后在 scene-renderer 里再写一份实现，造成两处漂移）。
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  CAMERA_DISTANCE, OBJECT_RT_MAX, PARTICLE_DEFAULT_DISTANCE,
  materialModulation, objectCameraRange, particleObjectRange, particleWorldSize,
  createObjectRenderTarget, shouldUseObjectPath, groupEffectsByObject, PendingChainStore,
  uvWindow, createCompositeGeometry, coverRange, flipGeometryUvY,
} from '../src/client/object-range.js';
import * as sceneRenderer from '../src/client/scene-renderer.js';

describe('object-range 常量', () => {
  it('CAMERA_DISTANCE=300 / OBJECT_RT_MAX=4096 / PARTICLE_DEFAULT_DISTANCE=64', () => {
    expect(CAMERA_DISTANCE).toBe(300);
    expect(OBJECT_RT_MAX).toBe(4096);
    expect(PARTICLE_DEFAULT_DISTANCE).toBe(64);
  });
});

describe('objectCameraRange', () => {
  it('按幅值取对象尺寸×缩放，逐轴钳制 4096、下限 1', () => {
    expect(objectCameraRange([100, 50], [2, 3])).toEqual({ w: 200, h: 150 });
    // 负 scale 是对象自身镜像，不改变可见大小（取幅值），也不得被下限钳成 1
    expect(objectCameraRange([100, 50], [-2, -0.18])).toEqual({ w: 200, h: 9 });
    expect(objectCameraRange([10000, 10], [1, 1])).toEqual({ w: 4096, h: 10 });
    expect(objectCameraRange([0, 0], [1, 1])).toEqual({ w: 1, h: 1 });
  });
});

describe('particleObjectRange / particleWorldSize', () => {
  const spec = { distanceMax: 100 };
  it('范围取 |distanceMax × scale| 并钳制；缺省 distanceMax 回退 64', () => {
    expect(particleObjectRange(spec, [2, 1])).toEqual({ w: 200, h: 100 });
    expect(particleObjectRange({}, [1, 1])).toEqual({ w: 64, h: 64 });
    expect(particleObjectRange({ distanceMax: 0 }, [1, 1])).toEqual({ w: 64, h: 64 });
  });
  it('世界尺寸 = 未钳制的 |distanceMax × scale|（钳制只发生在 RT 范围）', () => {
    expect(particleWorldSize({ distanceMax: 10000 }, [1, 1])).toEqual({ w: 10000, h: 10000 });
  });
});

describe('uvWindow / createCompositeGeometry', () => {
  it('未钳制轴（clamped ≥ unclamped）→ 全窗口；钳制轴 → 居中窗口', () => {
    expect(uvWindow(100, 100)).toEqual({ start: 0, end: 1 });
    expect(uvWindow(100, 200)).toEqual({ start: 0, end: 1 });
    expect(uvWindow(100, 50)).toEqual({ start: 0.25, end: 0.75 });
    expect(uvWindow(0, 50)).toEqual({ start: 0, end: 1 });
  });
  it('合成几何尺寸取幅值（镜像活在 RT 内容里，不在 quad 帧上二次翻转）', () => {
    const geo = createCompositeGeometry(-200, 100, 200, 100);
    const pos = geo.attributes.position.array as Float32Array;
    // PlaneGeometry(200,100) 的 x 极值应为 ±100
    expect(Math.max(...Array.from(pos).filter((_, i) => i % 3 === 0))).toBeCloseTo(100, 5);
    expect(Math.min(...Array.from(pos).filter((_, i) => i % 3 === 0))).toBeCloseTo(-100, 5);
  });
  // v 约定翻转（2026-09-14）：对象 RT 取 WE 约定（v=0=图像顶部）后，合成 quad 必须把 v 翻回
  // 显示约定才能正立贴回主场景。本函数**不**改 createCompositeGeometry 的默认行为
  // （未迁移的调用方 = scene-renderer 保持逐字不变），故单独测。
  it('flipGeometryUvY：v → 1-v（u 不动），且与 UV 窗口映射可交换', () => {
    const geo = createCompositeGeometry(100, 100, 100, 100); // 全窗口 ⇒ uv.y ∈ {0,1}
    flipGeometryUvY(geo);
    const uv = geo.attributes.uv.array as Float32Array;
    expect(Array.from(uv.filter((_, i) => i % 2 === 1)).every((v) => v === 0 || v === 1)).toBe(true);
    // 逐顶点校验 v 已取反（与位置顺序无关，直接比集合）
    const before = new THREE.PlaneGeometry(100, 100).attributes.uv.array as Float32Array;
    for (let i = 1; i < uv.length; i += 2) expect(uv[i]).toBeCloseTo(1 - before[i], 6);

    // 交换律：先窗口后翻转 == 先翻转后窗口（窗口恒居中 start+end=1 ⇒ (end-v)/wy == 1-(v-start)/wy）
    const a = createCompositeGeometry(100, 50, 100, 50);      // y 轴被钳制（窗口 [0.25,0.75]）
    const b = createCompositeGeometry(100, 50, 100, 50);
    flipGeometryUvY(a);
    const uvsB = b.attributes.uv.array as Float32Array;
    for (let i = 1; i < uvsB.length; i += 2) uvsB[i] = 1 - uvsB[i];
    const uvsA = a.attributes.uv.array as Float32Array;
    for (let i = 1; i < uvsA.length; i += 2) expect(uvsA[i]).toBeCloseTo(uvsB[i], 6);
  });
});

describe('分组与调度谓词', () => {
  it('shouldUseObjectPath 仅对非空 effects 数组为真', () => {
    expect(shouldUseObjectPath({ effects: [] })).toBe(false);
    expect(shouldUseObjectPath({ effects: [{ file: 'a' }] })).toBe(true);
    expect(shouldUseObjectPath({})).toBe(false);
  });
  it('groupEffectsByObject 按 objects 顺序保留每对象自身 effects，且跳过 text', () => {
    const objs = [
      { kind: 'image', id: 1, effects: [{ file: 'a' }] },
      { kind: 'text', id: 2, effects: [{ file: 'b' }] },
      { kind: 'particle', id: 3, effects: [{ file: 'c' }] },
      { kind: 'image', id: 4 },
    ] as never[];
    const groups = groupEffectsByObject(objs);
    expect(groups.map((g) => g.obj.id)).toEqual([1, 3]);
    expect(groups[0].effects).toEqual([{ file: 'a' }]);
  });
});

describe('PendingChainStore', () => {
  it('条目已存在 → 就地应用；否则暂存并在 take 时取出一次', () => {
    const store = new PendingChainStore<string[]>();
    expect(store.applyIfReady(7, ['x'], true)).toBe(true);
    expect(store.take(7)).toBeUndefined();
    expect(store.applyIfReady(7, ['y'], false)).toBe(false);
    expect(store.take(7)).toEqual(['y']);
    expect(store.take(7)).toBeUndefined();
  });
});

describe('createObjectRenderTarget / coverRange / materialModulation', () => {
  it('RT 尺寸取整并下限 1（不产生退化 RT）', () => {
    const rt = createObjectRenderTarget(100.4, 0);
    expect(rt.width).toBe(100);
    expect(rt.height).toBe(1);
    rt.dispose();
  });
  it('coverRange 按视口宽高比裁剪', () => {
    expect(coverRange(1920, 1080, 1920 / 1080)).toEqual({ w: 1920, h: 1080 });
    // 视口宽高比 1（更窄）→ 场景高度铺满（1080）、宽度按视口比裁到 1080，即水平裁剪。
    // 注：brief 此处期望 {1920,1920} 是 contain 语义的结果（整场景可见 + 垂直留白），
    // 与 cover 语义矛盾；实现逐字搬移未改动，故按实现既有语义（cover）修正期望值。
    expect(coverRange(1920, 1080, 1)).toEqual({ w: 1080, h: 1080 });
  });
  it('materialModulation：color/255×brightness、alpha 钳制 0-1', () => {
    expect(materialModulation()).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    expect(materialModulation([255, 128, 0], 0.5, 0.5).a).toBeCloseTo(0.5, 5);
    expect(materialModulation([255, 255, 255], undefined, 2).r).toBe(1);
  });
});

describe('re-export 同一性（防两处实现漂移）', () => {
  it('scene-renderer.ts 的导出与 object-range.ts 是同一函数对象', () => {
    expect(sceneRenderer.objectCameraRange).toBe(objectCameraRange);
    expect(sceneRenderer.uvWindow).toBe(uvWindow);
    expect(sceneRenderer.createCompositeGeometry).toBe(createCompositeGeometry);
    expect(sceneRenderer.coverRange).toBe(coverRange);
    expect(sceneRenderer.materialModulation).toBe(materialModulation);
    expect(sceneRenderer.PendingChainStore).toBe(PendingChainStore);
    expect(sceneRenderer.CAMERA_DISTANCE).toBe(CAMERA_DISTANCE);
  });
});
