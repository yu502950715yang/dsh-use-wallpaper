// v0.8.2 F12：text 可见字段（alpha/brightness/anchor/limitwidth/maxwidth）的 scene.json 解析。
// 真实素材取值：alpha 0/0.82/0.93/0.84、brightness 1/1.4/1.98/2.39、anchor none/center/right、
// limitwidth 全库 false、maxwidth 全库 500；limitwidth=true 与 9 值 anchor 只有夹具路径（真机留边界）。
import { describe, expect, it } from 'vitest';
import { parseSceneJson } from '../src/client/scene-json.js';
import type { SceneObject } from '../src/shared/types.js';

const BASE = {
  camera: { center: '0 0 0', eye: '0 0 1', up: '0 1 0' },
  general: { orthogonalprojection: { width: 1920, height: 1080 } },
};

function textOf(obj: Record<string, unknown>) {
  const scene = parseSceneJson(JSON.stringify({
    ...BASE,
    objects: [{ id: 5, name: 'Clock', text: { value: '12:34' }, origin: '100 100 0', scale: '1 1 1', ...obj }],
  }));
  const o = scene.objects[0];
  expect(o.kind).toBe('text');
  return o as Extract<SceneObject, { kind: 'text' }>;
}

describe('parseSceneJson text 可见字段（F12）', () => {
  it('对象形态 text：解析 alpha/brightness/anchor/limitwidth/maxwidth', () => {
    const o = textOf({
      alpha: 0.5, brightness: 2.5, anchor: 'topright', limitwidth: true, maxwidth: 300,
    });
    expect(o.alpha).toBe(0.5);
    expect(o.brightness).toBe(2.5);
    expect(o.anchor).toBe('topright');
    expect(o.limitwidth).toBe(true);
    expect(o.maxwidth).toBe(300);
    // 既有字段不受影响
    expect(o.text).toBe('12:34');
    expect(o.origin).toEqual([100, 100, 0]);
  });

  it('字符串形态 text（CodeTime 的 const/clock 形态）同样解析', () => {
    const o = textOf({
      text: 'const', alpha: '0.5', brightness: '1.4', anchor: 'right', limitwidth: true, maxwidth: '500',
    });
    expect(o.alpha).toBe(0.5);
    expect(o.brightness).toBe(1.4);
    expect(o.anchor).toBe('right');
    expect(o.limitwidth).toBe(true);
    expect(o.maxwidth).toBe(500);
  });

  it('缺省：brightness = 1（与 image/util 同口径），其余 undefined', () => {
    const o = textOf({});
    expect(o.brightness).toBe(1);
    expect(o.alpha).toBeUndefined();
    expect(o.anchor).toBeUndefined();
    expect(o.limitwidth).toBeUndefined();
    expect(o.maxwidth).toBeUndefined();
  });

  // 失败开放（spec §6）：非法字段各自忽略走缺省，不抛错、不影响其它字段。
  it('非法字段各自忽略：alpha "abc" / brightness "x" / anchor "" / limitwidth "yes" / maxwidth "wide"', () => {
    const o = textOf({
      alpha: 'abc', brightness: 'x', anchor: '', limitwidth: 'yes', maxwidth: 'wide',
    });
    expect(o.alpha).toBeUndefined();
    expect(o.brightness).toBe(1);
    expect(o.anchor).toBeUndefined();
    expect(o.limitwidth).toBeUndefined();
    expect(o.maxwidth).toBeUndefined();
  });

  it('alpha 复用 optAlpha：百分比 >1 归一化并 clamp 0-1（"50" → 0.5、"200" → 1、"0" → 0）', () => {
    expect(textOf({ alpha: '50' }).alpha).toBe(0.5);
    expect(textOf({ alpha: '200' }).alpha).toBe(1);
    expect(textOf({ alpha: 0 }).alpha).toBe(0);
  });

  it('anchor "none"（真实素材 19 处）原样保留，由渲染侧回退到 alignment 族', () => {
    expect(textOf({ anchor: 'none' }).anchor).toBe('none');
  });

  it('image 对象不产出 text 专有字段（零回归）', () => {
    const scene = parseSceneJson(JSON.stringify({
      ...BASE,
      objects: [{ id: 9, image: 'models/a.json', anchor: 'topright', limitwidth: true, maxwidth: 300 }],
    }));
    const o = scene.objects[0] as unknown as Record<string, unknown>;
    expect(o.kind).toBe('image');
    expect(o.anchor).toBeUndefined();
    expect(o.limitwidth).toBeUndefined();
    expect(o.maxwidth).toBeUndefined();
  });
});
