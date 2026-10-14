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
});
