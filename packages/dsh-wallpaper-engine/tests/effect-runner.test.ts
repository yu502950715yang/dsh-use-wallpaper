// tests/effect-runner.test.ts
import { describe, expect, it } from 'vitest';
import { rtAlternation } from '../src/client/effect-runner.js';

describe('rtAlternation（ping-pong RT 交替）', () => {
  it('单链两 pass：输入 rtA → pass0 写 rtB → pass1 写 rtA（返回 rtA）', () => {
    const plan = rtAlternation([2]);
    expect(plan).toEqual([
      { passIndex: 0, writeTo: 'B' },
      { passIndex: 1, writeTo: 'A' },
    ]);
  });
  it('双链各 1 pass：链0 写 B，链1 读 B 写 A', () => {
    const plan = rtAlternation([1, 1]);
    expect(plan).toEqual([
      { passIndex: 0, writeTo: 'B' },
      { passIndex: 1, writeTo: 'A' },
    ]);
  });
  it('pass 数为 0 的链跳过（扁平索引从 0 起）', () => {
    expect(rtAlternation([0, 2])).toEqual([
      { passIndex: 0, writeTo: 'B' },
      { passIndex: 1, writeTo: 'A' },
    ]);
  });
});
