// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { PointerPostBridge } from '../src/client/pointer-post-bridge.js';

// P1 泄漏回归：web 壁纸 resize 重建路径会重复 attach；旧实现（background-layer 闭包内）每次
// attach 都 window.addEventListener 且不摘旧监听 ⇒ 旧闭包（含旧 iframe）永久残留。
// 修复 = attach 前先摘旧监听（见 PointerPostBridge.attach）。

function makeFrame(): HTMLIFrameElement {
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  return frame;
}

let addSpy: ReturnType<typeof vi.spyOn>;
let removeSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  addSpy = vi.spyOn(window, 'addEventListener');
  removeSpy = vi.spyOn(window, 'removeEventListener');
});

afterEach(() => {
  addSpy.mockRestore();
  removeSpy.mockRestore();
  document.body.replaceChildren();
});

const pointerAdds = () => addSpy.mock.calls.filter(([t]) => t === 'pointermove').length;
const pointerRemoves = () => removeSpy.mock.calls.filter(([t]) => t === 'pointermove').length;

describe('PointerPostBridge 监听生命周期', () => {
  it('重复 attach（resize 重建）不累积 window pointermove 监听', () => {
    const bridge = new PointerPostBridge();
    bridge.attach(makeFrame());
    bridge.attach(makeFrame());
    expect(pointerAdds()).toBe(2);
    // 第二次 attach 前必须先摘掉第一次的监听（否则旧闭包永久残留）
    expect(pointerRemoves()).toBe(1);
    bridge.detach();
    expect(pointerRemoves()).toBe(2);
  });

  it('detach 幂等：重复 detach 不抛错、不重复 remove', () => {
    const bridge = new PointerPostBridge();
    expect(() => bridge.detach()).not.toThrow();
    bridge.attach(makeFrame());
    bridge.detach();
    bridge.detach();
    expect(pointerRemoves()).toBe(1);
  });

  it('attach 后 detach：监听成对（add 1 / remove 1）', () => {
    const bridge = new PointerPostBridge();
    bridge.attach(makeFrame());
    expect(pointerAdds()).toBe(1);
    bridge.detach();
    expect(pointerRemoves()).toBe(1);
  });
});
