import { describe, expect, it } from 'vitest';
import { collectVisibleBoolProperties } from '../src/host/user-props.js';

// v0.8 Task 7：壁纸用户属性面板的数据源。
// 只暴露「project.json 的 bool 属性」∩「scene.json objects[].visible.user 的键」；
// slider/color/combo 留 v0.9。样本形状来自本机真实壁纸（controller 已确认）：
//   project.json 的 general.properties 形如
//     { clouds: { order: 2.5, text: '云层', type: 'bool', value: true },
//       speed: { type: 'slider', value: 1 },
//       internal: { editable: false, type: 'bool', value: true } }
//   scene.json 的对象里有 visible: { user: 'clouds', value: true }。

const project = {
  general: {
    properties: {
      clouds: { order: 2.5, text: '云层', type: 'bool', value: true },
      speed: { order: 1, text: '速度', type: 'slider', value: 1 },
      internal: { editable: false, text: 'x', type: 'bool', value: true },
    },
  },
};
const scene = {
  objects: [
    { visible: { user: 'clouds', value: true } },
    { visible: { user: 'internal', value: true } },
    { visible: true },
  ],
};

describe('collectVisibleBoolProperties（bool × visible.user 交集）', () => {
  it('只保留 bool × visible.user ∩，按 order 浮点排序，去 HTML 标签', () => {
    const out = collectVisibleBoolProperties(project, scene);
    expect(out).toEqual([{ key: 'clouds', label: '云层', type: 'bool', value: true, order: 2.5 }]);
  });

  it('label 取 text 去 HTML 标签 / &nbsp;；空文本回退 key', () => {
    const out = collectVisibleBoolProperties({
      general: {
        properties: {
          a: { type: 'bool', value: false, text: '<b>云层</b>&nbsp;A' },
          b: { type: 'bool', value: true, text: '   ' },
          c: { type: 'bool', value: true },
        },
      },
    }, { objects: [{ visible: { user: 'a' } }, { visible: { user: 'b' } }, { visible: { user: 'c' } }] });
    expect(out.map((p) => p.label)).toEqual(['云层 A', 'b', 'c']);
    expect(out.find((p) => p.key === 'a')?.value).toBe(false); // value 原样保留（可 false）
  });

  it('按 order 浮点升序、同序按 key 码位升序；order 缺失/非法按 0', () => {
    const props = {
      z: { type: 'bool', value: true, order: 2 },
      a: { type: 'bool', value: true, order: 1.5 },
      b: { type: 'bool', value: true, order: 2 },
      m: { type: 'bool', value: true },
      n: { type: 'bool', value: true, order: 'x' },
    };
    const keys = Object.keys(props);
    const out = collectVisibleBoolProperties(
      { general: { properties: props } },
      { objects: keys.map((user) => ({ visible: { user } })) },
    );
    expect(out.map((p) => p.key)).toEqual(['m', 'n', 'a', 'b', 'z']);
    expect(out.map((p) => p.order)).toEqual([0, 0, 1.5, 2, 2]);
  });

  it('同一 user 键在多个对象上出现 → 只输出一次', () => {
    const out = collectVisibleBoolProperties(
      { general: { properties: { clouds: { type: 'bool', value: true, text: '云层' } } } },
      { objects: [{ visible: { user: 'clouds' } }, { visible: { user: 'clouds', value: false } }] },
    );
    expect(out).toHaveLength(1);
  });

  it('非 user 可见性（plain/script/畸形）不算键；非 bool 属性/editable:false 丢弃', () => {
    const out = collectVisibleBoolProperties({
      general: { properties: {
        plain: { type: 'bool', value: true },
        script: { type: 'bool', value: true },
        slider: { type: 'slider', value: 1 },
        locked: { type: 'bool', value: true, editable: false },
      } },
    }, { objects: [
      { visible: true },
      { visible: { script: 'x()' } },
      { visible: { user: 42 } },
      { visible: { user: '' } },
      { visible: { user: 'slider' } },
      { visible: { user: 'locked' } },
    ] });
    expect(out).toEqual([]);
  });

  it('坏 JSON / 缺字段 / 畸形输入 → []（不抛）', () => {
    expect(collectVisibleBoolProperties(null, null)).toEqual([]);
    expect(collectVisibleBoolProperties('not json', { objects: [] })).toEqual([]);
    expect(collectVisibleBoolProperties(project, null)).toEqual([]);
    expect(collectVisibleBoolProperties({ general: {} }, scene)).toEqual([]);
    expect(collectVisibleBoolProperties({ general: { properties: [] } }, scene)).toEqual([]);
    expect(collectVisibleBoolProperties(project, { objects: 'nope' })).toEqual([]);
    expect(collectVisibleBoolProperties(undefined, undefined)).toEqual([]);
    // 只有一个参数坏掉时另一边也无从产出
    expect(collectVisibleBoolProperties({}, scene)).toEqual([]);
  });
});
