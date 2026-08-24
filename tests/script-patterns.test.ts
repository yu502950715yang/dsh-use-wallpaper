// Task 3.3 脚本模式识别 + scriptproperties 解析 + 时钟文本生成。
// 真实 fixture：从 2937346640 的 scene.pkg 提取（PkgReader 读取对象 61 的
// visible.script/scriptproperties 与对象 182 的 text.script/scriptproperties，
// 见 tests/fixtures/2937346640/ 下的原始文件）。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  detectScriptPattern,
  parseScriptProperties,
  formatClockText,
  VISUALIZER_BAR_COUNT,
} from '../src/client/script-patterns.js';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/2937346640/${name}`, import.meta.url), 'utf8');

const VISUALIZER_SCRIPT = fixture('visualizer-script.js'); // Simple Visualizer（对象 61）
const CLOCK_SCRIPT = fixture('clock-script.js');           // VHS Time and Date（对象 182）
const VISUALIZER_PROPS = JSON.parse(fixture('visualizer-scriptproperties.json'));
const CLOCK_PROPS = JSON.parse(fixture('clock-scriptproperties.json'));

describe('detectScriptPattern（脚本模式启发式识别）', () => {
  it('真实 Simple Visualizer 脚本 → visualizer（registerAudioBuffers + createLayer）', () => {
    expect(detectScriptPattern(VISUALIZER_SCRIPT)).toBe('visualizer');
  });
  it('registerAudioBuffers + createLayerAsset（其他视觉系脚本写法）→ visualizer', () => {
    const src = 'let d = engine.registerAudioBuffers(32); let l = thisScene.createLayerAsset("models/a.json");';
    expect(detectScriptPattern(src)).toBe('visualizer');
  });
  it('真实 VHS Time and Date 脚本 → clock（new Date() + 月份数组 + getHours）', () => {
    expect(detectScriptPattern(CLOCK_SCRIPT)).toBe('clock');
  });
  it('有 registerAudioBuffers 但无 createLayer/createLayerAsset → null（仅音频注册不构成 visualizer）', () => {
    expect(detectScriptPattern('let d = engine.registerAudioBuffers(64);')).toBeNull();
  });
  it('有 new Date() + getHours 但无月份数组 → null（非时钟文本脚本）', () => {
    expect(detectScriptPattern('let t = new Date(); let h = t.getHours();')).toBeNull();
  });
  it('无关脚本 / 空串 / 非字符串 → null', () => {
    expect(detectScriptPattern('var x = 1;')).toBeNull();
    expect(detectScriptPattern('')).toBeNull();
    expect(detectScriptPattern(null as unknown as string)).toBeNull();
  });
});

describe('parseScriptProperties（WE scriptproperties 规范化：{user,value} 解包）', () => {
  it('普通数值/字符串原样保留；{user,value} 包装解包为内层 value', () => {
    expect(parseScriptProperties({ a: 1, b: 'x', c: { user: '_u', value: 42 } }))
      .toEqual({ a: 1, b: 'x', c: 42 });
  });
  it('真实 visualizer scriptproperties：barWidth/originX/scaleY/barAlignmentdir 全部直出', () => {
    expect(parseScriptProperties(VISUALIZER_PROPS)).toEqual({
      barAlignmentdir: 'bottom',
      barWidth: 0.82999998,
      originX: 12.67,
      scaleY: 23.889999,
    });
  });
  it('真实 clock scriptproperties：use24hFormat 的 {user,value} 包装解包为 value=false', () => {
    expect(parseScriptProperties(CLOCK_PROPS)).toEqual({
      delimiter: ':',
      use24hFormat: false,
    });
  });
  it('非对象输入（null/undefined/数组/字符串）→ 空对象（防御，不抛错）', () => {
    expect(parseScriptProperties(null)).toEqual({});
    expect(parseScriptProperties(undefined)).toEqual({});
    expect(parseScriptProperties([])).toEqual({});
    expect(parseScriptProperties('x')).toEqual({});
  });
  it('无 value 键的对象保持原样（非 WE 包装）', () => {
    expect(parseScriptProperties({ a: { nested: 1 } })).toEqual({ a: { nested: 1 } });
  });
});

describe('formatClockText（时钟文本生成，对齐 VHS Time and Date 脚本语义）', () => {
  const props = (use24hFormat: boolean) => ({ use24hFormat, delimiter: ':' });

  it('24h 格式：HH:MM\nMon. D YYYY（getMonth() 0 基 → 8 月 = Aug.）', () => {
    expect(formatClockText(new Date(2026, 7, 21, 14, 5), props(true)))
      .toBe('14:05\nAug. 21 2026');
  });
  it('12h 格式：meridiem 前缀 + 小时取模（14 时 → PM 02）', () => {
    expect(formatClockText(new Date(2026, 7, 21, 14, 5), props(false)))
      .toBe('PM 02:05\nAug. 21 2026');
  });
  it('12h 午夜 0 时 → AM 12（hours %= 12 后 0 → 12，与脚本一致）', () => {
    expect(formatClockText(new Date(2026, 0, 1, 0, 30), props(false)))
      .toBe('AM 12:30\nJan. 1 2026');
  });
  it('12h 正午 12 时 → PM 12', () => {
    expect(formatClockText(new Date(2026, 0, 1, 12, 0), props(false)))
      .toBe('PM 12:00\nJan. 1 2026');
  });
  it('小时/分钟补零（9 时 7 分 → 09:07）', () => {
    expect(formatClockText(new Date(2026, 0, 1, 9, 7), props(true)))
      .toBe('09:07\nJan. 1 2026');
  });
  it('缺省 use24hFormat → 24h（脚本 addCheckbox 默认值 true）', () => {
    expect(formatClockText(new Date(2026, 7, 21, 14, 5), { delimiter: ':' }))
      .toBe('14:05\nAug. 21 2026');
  });
  it('delimiter 缺省/非法 → ":"（脚本 addText 默认值）', () => {
    expect(formatClockText(new Date(2026, 7, 21, 14, 5), { use24hFormat: true }))
      .toBe('14:05\nAug. 21 2026');
  });
});

describe('VISUALIZER_BAR_COUNT（音频缓冲数 = 条数）', () => {
  it('脚本 registerAudioBuffers(64) → 64 条', () => {
    expect(VISUALIZER_BAR_COUNT).toBe(64);
  });
});
