import { describe, it, expect } from 'vitest';
import {
  parseUserRef, matchCondition, resolveUserValue, propertyConditionMet, parseColorTriplet,
} from '../src/client/user-bindings.js';

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
});

describe('parseColorTriplet', () => {
  it('0-1 与 0-255 双语义', () => {
    expect(parseColorTriplet('1 1 1')).toEqual([255, 255, 255]);
    expect(parseColorTriplet('0.5 0 0')).toEqual([127.5, 0, 0]);
    expect(parseColorTriplet('255 0 0')).toEqual([255, 0, 0]);
    expect(parseColorTriplet('bad')).toBeUndefined();
  });
});
