// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createPointerTracker } from '../src/client/pointer-input.js';

function move(x: number, y: number) {
  const ev = new Event('pointermove') as any;
  ev.clientX = x; ev.clientY = y;
  window.dispatchEvent(ev);
}

describe('pointer-input', () => {
  it('按视口归一化到 [0,1]，越界夹紧', () => {
    const t = createPointerTracker({ viewport: () => ({ width: 1000, height: 500 }) });
    t.install();
    expect(t.target()).toEqual({ x: 0.5, y: 0.5 }); // 未移动 = 居中（OWE 缺省）
    move(250, 125);
    expect(t.target()).toEqual({ x: 0.25, y: 0.25 });
    move(-50, 9999);
    expect(t.target()).toEqual({ x: 0, y: 1 });
    t.dispose();
  });
  // 旧引用是快照：target() 每次换新对象、不就地改写 ⇒ 别处保存的引用不会被后续事件改写（契约见 pointer-input.ts）。
  it('旧引用是快照：已取出的对象不被后续 pointermove 改写', () => {
    const t = createPointerTracker({ viewport: () => ({ width: 100, height: 100 }) });
    t.install();
    const p = t.target();
    move(70, 30);
    expect(p).toEqual({ x: 0.5, y: 0.5 });
    expect(t.target()).toEqual({ x: 0.7, y: 0.3 });
    t.dispose();
  });
  it('幂等安装：重复 install 只留一个监听；dispose 后不再更新', () => {
    const t = createPointerTracker({ viewport: () => ({ width: 100, height: 100 }) });
    t.install(); t.install();
    move(50, 50);
    expect(t.target()).toEqual({ x: 0.5, y: 0.5 });
    t.dispose();
    move(10, 10);
    expect(t.target()).toEqual({ x: 0.5, y: 0.5 });
  });
  // 上一条的「move(50,50) 后仍是 0.5」在重复监听下也成立（两次写入同值）⇒ 用处理次数直接钉住幂等。
  it('重复 install 后每个事件只被处理一次；dispose 后事件不再被处理', () => {
    let reads = 0;
    const t = createPointerTracker({ viewport: () => { reads++; return { width: 100, height: 100 }; } });
    t.install(); t.install();
    move(10, 10);
    expect(reads).toBe(1);
    t.dispose();
    move(20, 20);
    expect(reads).toBe(1);
  });
  // `installed` 守卫本身（上面两条在「重复挂监听」下同样为绿）⇒ 用计数 target 直接数挂/卸次数。
  it('installed 守卫：重复 install 只挂一次监听；dispose 卸同一个 handler 且可再挂', () => {
    const adds: Array<[string, unknown]> = [];
    const removes: Array<[string, unknown]> = [];
    const target = {
      addEventListener: (type: string, fn: unknown) => adds.push([type, fn]),
      removeEventListener: (type: string, fn: unknown) => removes.push([type, fn]),
    } as unknown as EventTarget;
    const t = createPointerTracker({ target });
    t.install(); t.install(); t.install();
    expect(adds).toEqual([['pointermove', expect.any(Function)]]);
    t.dispose();
    expect(removes).toEqual([['pointermove', adds[0][1]]]);
    t.dispose(); // 幂等：未挂载时不再重复移除
    expect(removes).toHaveLength(1);
    t.install(); // 卸载后可重挂（切壁纸 = teardown → render 再次 install）
    expect(adds).toHaveLength(2);
    expect(adds[1][1]).toBe(adds[0][1]);
  });
  // 退化视口（0 / 负 / NaN）⇒ 忽略事件、保持居中：除零会产出 Infinity/NaN 并被 clamp 成 0/1 的假位置。
  it('退化视口 ⇒ 事件被忽略，target() 恒居中', () => {
    for (const vp of [{ width: 0, height: 0 }, { width: -5, height: -5 }, { width: NaN, height: NaN }, { width: 100, height: 0 }]) {
      const t = createPointerTracker({ viewport: () => vp });
      t.install();
      move(10, 10);
      expect(t.target()).toEqual({ x: 0.5, y: 0.5 });
      t.dispose();
    }
  });
});
