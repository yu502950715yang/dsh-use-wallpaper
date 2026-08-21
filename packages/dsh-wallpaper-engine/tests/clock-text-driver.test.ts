// @vitest-environment jsdom
// T3.3 时钟脚本驱动：ClockTextDriver 每帧刷新文本纹理（文本变化才重建 CanvasTexture，
// 旧纹理必须 dispose；未变化时不触碰 material.map）。jsdom 未实现 canvas 2D，
// 与 text-object.test.ts 一致：mock getContext 返回记录型 2D 上下文。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { ClockTextDriver } from '../src/client/scene-renderer.js';

function makeMock2d() {
  return {
    font: '', fillStyle: '', textAlign: '', textBaseline: '',
    fillText: vi.fn(),
  };
}

describe('ClockTextDriver（时钟文本纹理逐帧刷新）', () => {
  let ctx: ReturnType<typeof makeMock2d>;

  beforeEach(() => {
    ctx = makeMock2d();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const makeDriver = () => {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 100),
      new THREE.MeshBasicMaterial({ transparent: true }),
    );
    const driver = new ClockTextDriver(mesh, { width: 400, height: 100 }, { use24hFormat: true, delimiter: ':' });
    return { mesh, driver };
  };

  it('构造即生成初始纹理（material.map 为 CanvasTexture，文本 = 当前时刻）', () => {
    const { mesh, driver } = makeDriver();
    expect(mesh.material).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect((mesh.material as THREE.MeshBasicMaterial).map).toBeInstanceOf(THREE.CanvasTexture);
    expect(ctx.fillText).toHaveBeenCalled();
    driver.dispose();
  });

  it('文本未变化（同分钟不同秒）→ 不重建纹理（material.map 引用不变）', () => {
    const { mesh, driver } = makeDriver();
    driver.update(new Date(2026, 7, 21, 14, 5, 0));
    const map1 = (mesh.material as THREE.MeshBasicMaterial).map;
    driver.update(new Date(2026, 7, 21, 14, 5, 59)); // 同一分钟：文本相同
    expect((mesh.material as THREE.MeshBasicMaterial).map).toBe(map1);
    driver.dispose();
  });

  it('文本变化（跨分钟）→ 重建纹理、旧纹理 dispose、map 换新', () => {
    const { mesh, driver } = makeDriver();
    driver.update(new Date(2026, 7, 21, 14, 5));
    const old = (mesh.material as THREE.MeshBasicMaterial).map as THREE.CanvasTexture;
    const disposeSpy = vi.spyOn(old, 'dispose');
    driver.update(new Date(2026, 7, 21, 14, 6));
    const fresh = (mesh.material as THREE.MeshBasicMaterial).map as THREE.CanvasTexture;
    expect(fresh).not.toBe(old);
    expect(disposeSpy).toHaveBeenCalledTimes(1); // 旧纹理已释放（防每帧纹理泄漏）
    expect(ctx.fillText).toHaveBeenLastCalledWith('14:06\nAug. 21 2026', 200, 50);
    driver.dispose();
  });

  it('12h 格式文本生成（use24hFormat=false → meridiem 前缀）', () => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(400, 100), new THREE.MeshBasicMaterial());
    const driver = new ClockTextDriver(mesh, { width: 400, height: 100 }, { use24hFormat: false, delimiter: ':' });
    driver.update(new Date(2026, 7, 21, 14, 6));
    expect(ctx.fillText).toHaveBeenLastCalledWith('PM 02:06\nAug. 21 2026', 200, 50);
    driver.dispose();
  });

  it('dispose 释放当前纹理（stop() 时回收，无残留）', () => {
    const { driver } = makeDriver();
    const tex = (driver as unknown as { lastTex: THREE.CanvasTexture }).lastTex;
    expect(tex).toBeInstanceOf(THREE.CanvasTexture);
    const disposeSpy = vi.spyOn(tex, 'dispose');
    driver.dispose();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });
});
