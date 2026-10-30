import { describe, it, expect } from 'vitest';
import {
  parseUserRef, matchCondition, resolveUserValue, propertyConditionMet, parseColorTriplet,
  resolveSceneUserBindings,
} from '../src/client/user-bindings.js';
import { resolveUniformBindings } from '../src/client/shader/uniform-binder.js';

describe('parseUserRef', () => {
  it('字符串与对象形态', () => {
    expect(parseUserRef('clock')).toEqual({ name: 'clock' });
    expect(parseUserRef({ name: 'clock', condition: '1' })).toEqual({ name: 'clock', condition: '1' });
    expect(parseUserRef(null)).toBeUndefined();
    expect(parseUserRef({})).toBeUndefined();
    expect(parseUserRef({ name: '' })).toBeUndefined();
  });
});

describe('matchCondition（绑定侧）', () => {
  it('bool：condition "0"=开、"1"=关', () => {
    expect(matchCondition(true, '0')).toBe(true);
    expect(matchCondition(false, '1')).toBe(true);
    expect(matchCondition(true, '1')).toBe(false);
    expect(matchCondition(false, '0')).toBe(false);
  });
  it('combo 精确匹配、slider 数值容差', () => {
    expect(matchCondition('1', '1')).toBe(true);
    expect(matchCondition('1', '2')).toBe(false);
    expect(matchCondition(2, '2')).toBe(true);
    expect(matchCondition(3.13, '3.13')).toBe(true);
  });
  it('空 condition = 真值判定', () => {
    expect(matchCondition(true, undefined)).toBe(true);
    expect(matchCondition('', undefined)).toBe(false);
  });
});

describe('resolveUserValue', () => {
  const props = { clock: '1', clockcolor: '0.5 0 0', speed: 2 };
  it('条件匹配用用户值；不匹配写中性零值', () => {
    expect(resolveUserValue({ value: true, user: { name: 'clock', condition: '1' } }, props, 'bool')).toBe(true);
    expect(resolveUserValue({ value: true, user: { name: 'clock', condition: '2' } }, props, 'bool')).toBe(false);
  });
  it('无绑定/属性缺失 → 静态 value', () => {
    expect(resolveUserValue({ value: 0.5 }, props, 'number')).toBe(0.5);
    expect(resolveUserValue({ value: 0.5, user: { name: 'missing' } }, props, 'number')).toBe(0.5);
  });
  it('color 解析为 0-255 三元组', () => {
    expect(resolveUserValue({ value: '1 1 1', user: { name: 'clockcolor' } }, props, 'color')).toEqual([127.5, 0, 0]);
  });
  it('color01（shader 常量颜色）保留 0-1 字符串', () => {
    expect(resolveUserValue({ value: '1 1 1', user: { name: 'clockcolor' } }, props, 'color01')).toBe('0.5 0 0');
    expect(resolveUserValue({ value: '1 1 1', user: { name: 'missing' } }, props, 'color01')).toBe('1 1 1');
    expect(resolveUserValue(
      { value: '1 1 1', user: { name: 'clockcolor', condition: '2' } }, props, 'color01',
    )).toBe('0 0 0');
  });
});

describe('propertyConditionMet（属性级 condition）', () => {
  const props = { audiobar: true, mode: 'balanced', speed: 2 };
  it('最小表达式', () => {
    expect(propertyConditionMet('audiobar.value==true', props)).toBe(true);
    expect(propertyConditionMet('audiobar.value==false', props)).toBe(false);
    expect(propertyConditionMet('mode.value==balanced', props)).toBe(true);
    expect(propertyConditionMet('speed.value==2', props)).toBe(true);
    expect(propertyConditionMet('audiobar.value==true && mode.value==balanced', props)).toBe(true);
    expect(propertyConditionMet('audiobar.value==false || mode.value==balanced', props)).toBe(true);
    expect(propertyConditionMet('mode.value!=balanced', props)).toBe(false);
    expect(propertyConditionMet('mode.value!=eco', props)).toBe(true);
  });
  it('空/畸形 → 满足（失败开放）', () => {
    expect(propertyConditionMet(undefined, props)).toBe(true);
    expect(propertyConditionMet('(((', props)).toBe(true);
    expect(propertyConditionMet('audiobar.value==true &&', props)).toBe(true);
  });
  it('大小于号不在文法内 → 整条失败开放，不把组合表达式翻成 false', () => {
    // 旧行为：`a.value>2` 被当成字符串字面量（真值），右半边不匹配时整条变 false。
    expect(propertyConditionMet('a.value>2 && b.value==1', props)).toBe(true);
    expect(propertyConditionMet('a.value<2 && audiobar.value==false', props)).toBe(true);
  });
});

describe('parseColorTriplet', () => {
  it('0-1 与 0-255 双语义', () => {
    expect(parseColorTriplet('1 1 1')).toEqual([255, 255, 255]);
    expect(parseColorTriplet('0.5 0 0')).toEqual([127.5, 0, 0]);
    expect(parseColorTriplet('255 0 0')).toEqual([255, 0, 0]);
    expect(parseColorTriplet('bad')).toBeUndefined();
  });
});

// 装配前统一 resolve：scene 解析产物只带 userRefs / {value,user}；此处一次性换成静态值。
describe('resolveSceneUserBindings', () => {
  const baseDesc = (objects: unknown[]) => ({
    camera: { center: [0, 0, 0], eye: [0, 0, 0], up: [0, 1, 0] },
    orthogonal: { width: 100, height: 100 },
    parallax: { enabled: false, amount: 0, delay: 0, mouseInfluence: 0 },
    objects,
  }) as any;

  it('装配前 resolve：绑定字段被用户值覆盖、静态字段不动、输入不被就地修改', () => {
    const desc = baseDesc([
      {
        id: 1, kind: 'image', color: [255, 255, 255], alpha: 1, brightness: 1,
        origin: [0, 0, 0], scale: [1, 1, 1], angles: [0, 0, 0],
        userRefs: {
          color: { name: 'clockcolor' }, alpha: { name: 'vis' }, brightness: { name: 'bright' },
          origin: { name: 'move' }, scale: { name: 'zoom' }, angles: { name: 'rot' },
        },
      },
      { id: 2, kind: 'image', color: [255, 255, 255] },
    ]);
    const out = resolveSceneUserBindings(desc, {
      clockcolor: '0.5 0 0', vis: 0.25, bright: 2, move: 10, zoom: 3, rot: 1.5,
    });
    const o = out.objects[0] as any;
    expect(o.color).toEqual([127.5, 0, 0]);
    expect(o.alpha).toBe(0.25);
    expect(o.brightness).toBe(2);
    expect(o.origin).toEqual([10, 10, 10]); // 逐分量 number
    expect(o.scale).toEqual([3, 3, 3]);
    expect(o.angles).toEqual([1.5, 1.5, 1.5]);
    expect((out.objects[1] as any).color).toEqual([255, 255, 255]);
    expect((desc.objects[0] as any).color).toEqual([255, 255, 255]); // 返回新对象，不就地改
  });

  it('属性缺失回退作者值；绑定 condition 不匹配写中性零值', () => {
    const desc = baseDesc([{
      id: 1, kind: 'image', color: [10, 20, 30], alpha: 0.5,
      userRefs: {
        color: { name: 'missing' },
        alpha: { name: 'vis', condition: '0' },
      },
    }]);
    const out = resolveSceneUserBindings(desc, { vis: 0.5 });
    expect((out.objects[0] as any).color).toEqual([10, 20, 30]);
    expect((out.objects[0] as any).alpha).toBe(0); // condition '0' 对数值 ≠ 0 → 不匹配
  });

  it('effects / instanceoverride 内的 {user,value} 被递归 resolve', () => {
    const desc = baseDesc([{
      id: 1, kind: 'particle',
      effects: [{ visible: { user: 'depthparallax', value: true }, passes: [{ constantshadervalues: { speed: { user: 'speed', value: 1 } } }] }],
      instanceOverrideJson: '{"rate":{"user":"leavedspeed","value":1},"nested":[{"user":"speed","value":2}]}',
    }]);
    const out = resolveSceneUserBindings(desc, { depthparallax: false, leavedspeed: 2, speed: 3 });
    const o = out.objects[0] as any;
    expect(o.effects[0].visible).toBe(false);
    expect(o.effects[0].passes[0].constantshadervalues.speed).toBe(3);
    expect(JSON.parse(o.instanceOverrideJson)).toEqual({ rate: 2, nested: [3] });
  });

  it('effects 的 shader 颜色保持 "r g b" 0-1 字符串（交给 uniform-binder）；脚本/wasm 保持原格式', () => {
    const desc = baseDesc([{
      id: 1, kind: 'particle',
      effects: [{ passes: [{ constantshadervalues: { tint: { user: 'tint', value: '1 1 1' } } }] }],
      scriptProperties: { tint: { value: '1 1 1', user: { name: 'tint' } } },
      instanceOverrideJson: '{"colorn":{"user":"tint","value":"1 1 1"}}',
    }]);
    const out = resolveSceneUserBindings(desc, { tint: '0.5 0 0' });
    const o = out.objects[0] as any;
    // shader 颜色是 0-1 语义：保留字符串由 uniform-binder 解析（转 0-255 会 255× 过曝）。
    expect(o.effects[0].passes[0].constantshadervalues.tint).toBe('0.5 0 0');
    expect(resolveUniformBindings(
      [{ name: 'g_Tint', type: 'vec3', annotation: { material: 'tint' } }],
      o.effects[0].passes[0].constantshadervalues,
    ).get('g_Tint')).toEqual([0.5, 0, 0]);
    expect(o.scriptProperties.tint).toBe('0.5 0 0');
    expect(JSON.parse(o.instanceOverrideJson).colorn).toBe('0.5 0 0');
  });

  it('effects 颜色 condition 不匹配 → shader 中性黑；属性缺失回退作者串', () => {
    const desc = baseDesc([{
      id: 1, kind: 'particle',
      effects: [{
        passes: [{
          constantshadervalues: {
            off: { user: { name: 'mode', condition: '2' }, value: '1 1 1' },
            missing: { user: 'absent', value: '1 1 1' },
          },
        }],
      }],
    }]);
    const out = resolveSceneUserBindings(desc, { mode: 1 });
    const cs = (out.objects[0] as any).effects[0].passes[0].constantshadervalues;
    expect(cs.off).toBe('0 0 0');
    expect(cs.missing).toBe('1 1 1');
  });

  it('scriptProperties：解析形态 {value,user} 与原始 {user,value} 都被 resolve 为标量', () => {
    const desc = baseDesc([{
      id: 1, kind: 'text',
      scriptProperties: {
        delimiter: ':',
        use24hFormat: { value: true, user: { name: '_24h' } },
      },
      visible: {
        kind: 'script', script: 'x', value: true,
        scriptProperties: { flag: { user: 'flag', value: false } },
      },
      objectScripts: [{
        property: 'origin', script: 'x',
        scriptProperties: { dayStart: { value: 0, user: { name: 'day' } } },
      }],
    }]);
    const out = resolveSceneUserBindings(desc, { _24h: false, flag: true, day: 6 });
    const o = out.objects[0] as any;
    expect(o.scriptProperties).toEqual({ delimiter: ':', use24hFormat: false });
    expect(o.visible.scriptProperties).toEqual({ flag: true });
    expect(o.objectScripts?.[0]?.scriptProperties).toEqual({ dayStart: 6 });
  });

  it('bloomUser / parallaxUser 覆盖 general 配置', () => {
    const desc = baseDesc([]);
    desc.bloom = { strength: 2, threshold: 0.65 };
    desc.bloomUser = { name: 'bloom' };
    desc.parallax = { enabled: false, amount: 0.5, delay: 0, mouseInfluence: 0 };
    desc.parallaxUser = { name: 'par' };
    const out = resolveSceneUserBindings(desc, { bloom: false, par: true });
    expect(out.bloom).toBeUndefined();
    expect(out.parallax.enabled).toBe(true);
    expect(out.parallax.amount).toBe(0.5);
    expect(out.bloomUser).toEqual({ name: 'bloom' }); // 配置解绑后参考信息保留
  });
});
