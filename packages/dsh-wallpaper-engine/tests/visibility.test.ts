import { describe, expect, it } from 'vitest';
import { parseVisible, resolveVisibility } from '../src/client/visibility.js';

// T4.2 可见性绑定（user/script）：
//   parseVisible —— scene.json 的 visible 字段（布尔 / {user,value} / {script,value}）
//     归一化为 VisibleBinding（{kind:'plain'|'user'|'script', value, key?/script?}）；
//   resolveVisibility —— 纯函数：注入用户属性表，求对象最终可见性（node 可测，
//     不触碰渲染器/设置存储——renderScene 只负责把 getter 查询结果聚成 userProps 传入）。

describe('parseVisible（visible 字段归一化）', () => {
  it('布尔 → plain 绑定（value 原样保留）', () => {
    expect(parseVisible(true)).toEqual({ kind: 'plain', value: true });
    expect(parseVisible(false)).toEqual({ kind: 'plain', value: false });
  });

  it('{user,value} → user 绑定（key/value 保留，2937346640 timeand 形态）', () => {
    expect(parseVisible({ user: 'timeand', value: true })).toEqual({ kind: 'user', key: 'timeand', value: true });
  });

  it('{script,value} → script 绑定（script 保留；scriptproperties 的 {user,value} 解包）', () => {
    expect(parseVisible({
      script: 'let audioData = engine.registerAudioBuffers(64);',
      scriptproperties: { barWidth: 0.83, originX: { user: '_x', value: 12.67 } },
      value: true,
    })).toEqual({
      kind: 'script',
      script: 'let audioData = engine.registerAudioBuffers(64);',
      scriptProperties: { barWidth: 0.83, originX: 12.67 },
      value: true,
    });
  });

  it('value 缺失/非布尔 → 缺省 true（不误杀对象）', () => {
    expect(parseVisible({ user: 'timeand' })?.value).toBe(true);
    expect(parseVisible({ user: 'timeand', value: 'yes' })?.value).toBe(true);
    expect(parseVisible({ script: 'x()' })?.value).toBe(true);
  });

  it('同对象同时含 user 与 script（畸形数据）→ user 优先（用户开关优先于脚本）', () => {
    expect(parseVisible({ user: 'a', script: 'x()', value: false })).toEqual({ kind: 'user', key: 'a', value: false });
  });

  it('缺失/畸形输入（undefined/null/数组/数字/字符串/空对象）→ undefined（无绑定 = 默认可见）', () => {
    expect(parseVisible(undefined)).toBeUndefined();
    expect(parseVisible(null)).toBeUndefined();
    expect(parseVisible([])).toBeUndefined();
    expect(parseVisible(42)).toBeUndefined();
    expect(parseVisible('true')).toBeUndefined();
    expect(parseVisible({})).toBeUndefined();
  });
});

describe('resolveVisibility（可见性解析：注入用户属性）', () => {
  it('无 visible 绑定 → true（默认可见）', () => {
    expect(resolveVisibility({}, {})).toBe(true);
    expect(resolveVisibility({ visible: undefined }, {})).toBe(true);
  });

  it('plain 布尔 → 原样返回', () => {
    expect(resolveVisibility({ visible: { kind: 'plain', value: true } }, {})).toBe(true);
    expect(resolveVisibility({ visible: { kind: 'plain', value: false } }, {})).toBe(false);
  });

  it('user 绑定：userProps[key] 为布尔 → 用用户值覆盖绑定 value', () => {
    const obj = { visible: { kind: 'user' as const, key: 'timeand', value: true } };
    expect(resolveVisibility(obj, { timeand: false })).toBe(false);
    expect(resolveVisibility(obj, { timeand: true })).toBe(true);
  });

  it('user 绑定：key 缺失（或值非布尔）→ 回退绑定 value（缺省 = value）', () => {
    const on = { visible: { kind: 'user' as const, key: 'timeand', value: true } };
    expect(resolveVisibility(on, {})).toBe(true);
    const off = { visible: { kind: 'user' as const, key: 'timeand', value: false } };
    expect(resolveVisibility(off, {})).toBe(false);
    // key 存在但值非布尔（存储损坏）→ 同样回退 value，返回恒为布尔
    expect(resolveVisibility(off, { timeand: 'yes' })).toBe(false);
  });

  it('script 绑定 → 保持 value（脚本求值超出本期范围；不匹配模式的脚本同样按 value）', () => {
    expect(resolveVisibility({ visible: { kind: 'script', script: 'x()', value: true } }, {})).toBe(true);
    expect(resolveVisibility({ visible: { kind: 'script', script: 'x()', value: false } }, {})).toBe(false);
  });
});
