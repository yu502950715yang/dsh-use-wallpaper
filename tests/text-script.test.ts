import { describe, expect, it } from 'vitest';
import { getTextScriptRuntime } from '../src/client/text-script.js';

// WE text 脚本真实形态：builder 声明属性 + update(value) 返回新文本。
const SCRIPT = `'use strict';
export var scriptProperties = createScriptProperties()
  .addCheckbox({ name: 'showHour', label: 'x', value: true })
  .finish();
export function update(value) {
  return scriptProperties.showHour ? 'H' + scriptProperties.extra : 'M' + scriptProperties.extra;
}`;

describe('getTextScriptRuntime', () => {
  it('注入的 scriptproperties 覆盖 builder 默认值', async () => {
    const rt = await getTextScriptRuntime();
    expect(rt).not.toBeNull();
    const a = rt!.bind(SCRIPT, { showHour: true, extra: '7' }, 'init');
    const b = rt!.bind(SCRIPT, { showHour: false, extra: '9' }, 'init');
    expect(a!.update()).toBe('H7');
    expect(b!.update()).toBe('M9');
    a!.dispose();
    b!.dispose();
  });

  it('未知 add* 方法不崩（宽松 builder）', async () => {
    const rt = await getTextScriptRuntime();
    const s = `export function update(v){ return 'ok'; }`;
    const b = rt!.bind(s, {}, '');
    expect(b!.update()).toBe('ok');
    b!.dispose();
  });

  it('没有 update 的脚本 → bind 返回 null', async () => {
    const rt = await getTextScriptRuntime();
    expect(rt!.bind(`var x = 1;`, {}, '')).toBeNull();
  });

  it('语法错误的脚本 → bind 返回 null（不抛）', async () => {
    const rt = await getTextScriptRuntime();
    expect(rt!.bind(`export function update( {`, {}, '')).toBeNull();
  });

  it('update 的入参是上一次返回的文本', async () => {
    const rt = await getTextScriptRuntime();
    const b = rt!.bind(`export function update(v){ return '[' + v + ']'; }`, {}, '');
    expect(b!.update()).toBe('[]');
    expect(b!.update()).toBe('[[]]');
    b!.dispose();
  });

  it('dispose 后重复 bind 仍可用（单例不被销毁）', async () => {
    const rt = await getTextScriptRuntime();
    const first = rt!.bind(`export function update(v){ return 'a'; }`, {}, '');
    first!.dispose();
    const second = rt!.bind(`export function update(v){ return 'b'; }`, {}, '');
    expect(second!.update()).toBe('b');
    second!.dispose();
  });

  it('脚本抛错 → update 返回 null（隔离，不抛给宿主）', async () => {
    const rt = await getTextScriptRuntime();
    const b = rt!.bind(`export function update(v){ throw new Error('boom'); }`, {}, '');
    expect(b!.update()).toBeNull();
    b!.dispose();
  });

  it('死循环脚本被步数预算中断 → update 返回 null，且 runtime 仍可用', async () => {
    const rt = await getTextScriptRuntime();
    const bad = rt!.bind(`export function update(v){ while(true){} }`, {}, '');
    expect(bad!.update()).toBeNull();
    bad!.dispose();
    const good = rt!.bind(`export function update(v){ return 'still-alive'; }`, {}, '');
    expect(good!.update()).toBe('still-alive');
    good!.dispose();
  });
});
