import { describe, expect, it } from 'vitest';
import {
  parseVisible, resolveVisibility, isStaticallyHidden, computeEffectiveVisibility,
} from '../src/client/visibility.js';

// T4.2 可见性绑定（user/script）：
//   parseVisible —— scene.json 的 visible 字段（布尔 / {user,value} / {script,value}）
//     归一化为 VisibleBinding（{kind:'plain'|'user'|'script', value, key?/script?}）；
//   resolveVisibility —— 纯函数：注入用户属性表，求对象最终可见性（node 可测，
//     不触碰渲染器/设置存储——renderScene 只负责把 getter 查询结果聚成 userProps 传入）。
//   isStaticallyHidden —— 装载期静态隐藏判定（image/particle 用；script 绑定恒不隐藏）。

describe('parseVisible（visible 字段归一化）', () => {
  it('布尔 → plain 绑定（value 原样保留）', () => {
    expect(parseVisible(true)).toEqual({ kind: 'plain', value: true });
    expect(parseVisible(false)).toEqual({ kind: 'plain', value: false });
  });

  it('{user,value} → user 绑定（key/value 保留，2937346640 timeand 形态）', () => {
    expect(parseVisible({ user: 'timeand', value: true })).toEqual({ kind: 'user', key: 'timeand', value: true });
  });

  it('对象形态 user 解析出 condition', () => {
    expect(parseVisible({ user: { name: 'clock', condition: '1' }, value: true }))
      .toEqual({ kind: 'user', key: 'clock', condition: '1', value: true });
  });

  it('{script,value} → script 绑定（script 保留；scriptproperties 的 user 绑定保留）', () => {
    expect(parseVisible({
      script: 'let audioData = engine.registerAudioBuffers(64);',
      scriptproperties: { barWidth: 0.83, originX: { user: '_x', value: 12.67 } },
      value: true,
    })).toEqual({
      kind: 'script',
      script: 'let audioData = engine.registerAudioBuffers(64);',
      scriptProperties: { barWidth: 0.83, originX: { value: 12.67, user: { name: '_x' } } },
      value: true,
    });
  });

  it('value 缺失/非布尔 → 缺省 true（不误杀对象）', () => {
    expect(parseVisible({ user: 'timeand' })?.value).toBe(true);
    expect(parseVisible({ user: 'timeand', value: 'yes' })?.value).toBe(true);
    expect(parseVisible({ script: 'x()' })?.value).toBe(true);
  });

  // WE 真实数据（3797976859 的媒体层）就是三个键并存：装载期按用户开关，visible 脚本走运行期通道。
  it('同对象同时含 user 与 script → user 绑定优先，但 script 保留给运行期', () => {
    expect(parseVisible({ user: 'a', script: 'x()', value: false }))
      .toEqual({ kind: 'user', key: 'a', script: 'x()', value: false });
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

  it('kind 为未知值（畸形数据）→ 默认可见（switch 缺省分支兜底，不误杀对象）', () => {
    // 解析器产出的 kind 恒为 plain/user/script；此处模拟运行时收到畸形绑定的防御场景
    const obj = { visible: { kind: 'unknown-kind' as unknown as 'plain', value: false } };
    expect(resolveVisibility(obj, {})).toBe(true);
  });
});

// image/particle 的装载期静态隐藏（2026-09-25）。与 resolveVisibility 的关键差别：
// **script 绑定恒不隐藏** —— 那类对象的可见性是 visible.script 的每帧返回值（applyLayerState），
// 装载期就把它剔掉会让脚本永远无法把它打开（全库 9 个 image/particle 属此类）。
describe('isStaticallyHidden（装载期静态隐藏判定）', () => {
  it('无绑定 → 不隐藏（默认可见）', () => {
    expect(isStaticallyHidden(undefined, {})).toBe(false);
  });

  it('plain → 取反 value', () => {
    expect(isStaticallyHidden({ kind: 'plain', value: true }, {})).toBe(false);
    expect(isStaticallyHidden({ kind: 'plain', value: false }, {})).toBe(true);
  });

  it('user 绑定：用户值为布尔时以用户值为准，键缺失/非布尔回退绑定 value', () => {
    const on = { kind: 'user' as const, key: 'timeand', value: true };
    expect(isStaticallyHidden(on, { timeand: false })).toBe(true);
    expect(isStaticallyHidden(on, { timeand: true })).toBe(false);
    const off = { kind: 'user' as const, key: 'timeand', value: false };
    expect(isStaticallyHidden(off, {})).toBe(true);
    expect(isStaticallyHidden(off, { timeand: 'yes' })).toBe(true);
  });

  it('script 绑定 → 恒不隐藏（value=false 也交给运行时 visible.script 通道）', () => {
    expect(isStaticallyHidden({ kind: 'script', script: 'x()', value: false }, {})).toBe(false);
    expect(isStaticallyHidden({ kind: 'script', script: 'x()', value: true }, {})).toBe(false);
  });

  it('kind 为未知值（畸形数据）→ 不隐藏（不误杀对象）', () => {
    expect(isStaticallyHidden({ kind: 'unknown-kind' as unknown as 'plain', value: false }, {})).toBe(false);
  });
});

// 3812518176「Leon」的文字重影：父对象 visible 为对象形态 user + condition，
// 子 Date/Clock 无自身绑定 ⇒ 可见性必须沿 parent 链继承（WE SceneNode 语义）。
describe('computeEffectiveVisibility（对象形态 condition + 父链继承）', () => {
  const leon = [
    { id: 192, visible: { kind: 'user' as const, key: 'clock', condition: '1', value: true } },
    { id: 199, parent: 192 },
    { id: 209, parent: 192 },
    { id: 227, visible: { kind: 'user' as const, key: 'clock', condition: '2', value: false } },
    { id: 234, parent: 227 },
    { id: 245, parent: 227 },
  ];
  const visibleIds = (eff: Map<number, boolean>) =>
    [...eff.entries()].filter(([, v]) => v).map(([k]) => k).sort((a, b) => a - b);

  it('clock=1：只显示样式 A（192/199/209），父链隐藏样式 B', () => {
    expect(visibleIds(computeEffectiveVisibility(leon, { clock: '1' }))).toEqual([192, 199, 209]);
  });

  it('clock=2：只显示样式 B', () => {
    expect(visibleIds(computeEffectiveVisibility(leon, { clock: '2' }))).toEqual([227, 234, 245]);
  });

  it('父缺失/环容错；script 绑定不静态剔除', () => {
    const eff = computeEffectiveVisibility([
      { id: 1, visible: { kind: 'user' as const, key: 'missing', value: false } },
      { id: 2, parent: 999 },
      { id: 3, parent: 3 },
      { id: 4, visible: { kind: 'script' as const, value: true } },
    ], {});
    expect(eff.get(1)).toBe(false);
    expect(eff.get(2)).toBe(true);
    expect(eff.get(3)).toBe(true);
    expect(eff.get(4)).toBe(true);
  });

  it('2911105183 场景：三个独立 Clock 只在 condition 匹配时可见（Hide=2 → obj148）', () => {
    // 作者 value：108=true、144/148=false；condition 命中即显示，与 value 无关（真实 scene.json 取值）
    const clocks = [
      { id: 108, visible: { kind: 'user' as const, key: 'clock', condition: '0', value: true } },
      { id: 144, visible: { kind: 'user' as const, key: 'clock', condition: '1', value: false } },
      { id: 148, visible: { kind: 'user' as const, key: 'clock', condition: '2', value: false } },
    ];
    const visible = (clock: string) =>
      [...computeEffectiveVisibility(clocks, { clock }).entries()].filter(([, v]) => v).map(([k]) => k);
    expect(visible('0')).toEqual([108]);
    expect(visible('1')).toEqual([144]);
    // Hide=2 命中的 obj148 仍是作者放的 24h 时钟（与桌面 WE 一致），不是「三个全隐藏」
    expect(visible('2')).toEqual([148]);
  });
});
