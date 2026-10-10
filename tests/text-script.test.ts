import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { getTextScriptRuntime } from '../src/client/text-script.js';

// 真实素材（魔兽之门 #778）：见 tests/fixtures/1922570576/README.md
const WOW_CLOCK = JSON.parse(
  readFileSync(new URL('./fixtures/1922570576/text-object-778.json', import.meta.url), 'utf8'),
) as { text: { script: string; value: string } };

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

  // 2026-09-30：WE 官方的下拉框 API 名是 `addCombo`（OWE Script.cpp:1203 `builder.addCombo = adder('Combo')`），
  // 而本插件的 builder 只注册了不存在的 `addComboBox` ⇒ 用 addCombo 的脚本 eval 直接
  // `TypeError: not a function` ⇒ bind 返回 null ⇒ 文本层被整层跳过（用户报告 Spider Man 4K
  // 的「DAY」「DATE」两行字在 DSH 里消失，只剩 Clock）。
  it('builder 支持 WE 官方方法名 addCombo（缺失会让整段脚本 bind 失败）', async () => {
    const rt = await getTextScriptRuntime();
    const s = `'use strict';
export var scriptProperties = createScriptProperties()
  .addCombo({ name: 'mode', label: 'Mode', options: [{ label: 'A', value: '1' }, { label: 'B', value: '2' }] })
  .addCheckbox({ name: 'on', label: 'On', value: true })
  .finish();
export function update(v) { return scriptProperties.mode + '/' + scriptProperties.on; }`;
    const b = rt!.bind(s, { mode: '2', on: false }, '');
    expect(b).not.toBeNull();
    expect(b!.update()).toBe('2/false');
    b!.dispose();
  });

  it('未知 add* 方法可链式调用且不抛错（OWE 的长尾 stub 名单，Script.cpp:1206-1214）', async () => {
    const rt = await getTextScriptRuntime();
    const s = `'use strict';
export var scriptProperties = createScriptProperties()
  .addFoo({ name: 'x', value: 1 })
  .addCombo({ name: 'y', value: 'z' })
  .addAnimation({ name: 'a' })
  .finish();
export function update(v) { return scriptProperties.x + '' + scriptProperties.y; }`;
    const b = rt!.bind(s, {}, '');
    expect(b).not.toBeNull();
    expect(b!.update()).toBe('1z');
    b!.dispose();
  });

  it('未知 add* 方法不崩（宽松 builder）', async () => {
    const rt = await getTextScriptRuntime();
    const s = `export var p = createScriptProperties().addWhatever({ name: 'k', value: 'v' }).finish();
export function update(v){ return p.k; }`;
    const b = rt!.bind(s, {}, '');
    expect(b).not.toBeNull();
    expect(b!.update()).toBe('v');
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

  // 2026-10-10：WE 脚本的 `import * as X from 'X'`（模块是引擎注入的 WE 模块，不是文件）此前**整条
  // 语句被原样丢进 evalCode** ⇒ QuickJS 在函数体内报 `expecting '('`（import 语句不能出现在函数体里）
  // ⇒ bind 返回 null ⇒ 该文本层被整层跳过（用户报告「魔兽之门」1922570576 右下角的时间数字不显示；
  // 对象 #778 的脚本里根本没有用到 WEMath）。全库 33 个 text 脚本里只有这 1 条带 import。
  it('WE 模块 import 不导致 bind 失败（魔兽之门 #778：import * as WEMath）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 10, 14, 5, 7)); // 2026-10-10 14:05:07
    const rt = await getTextScriptRuntime();
    const s = `'use strict';
import * as WEMath from 'WEMath';
let delimiter = ':';
let showSeconds = true;
let use24hFormat = true;
export function update(value) {
  let time = new Date();
  let hours = use24hFormat ? ("00" + time.getHours()).slice(-2) : time.getHours();
  let minutes = ("00" + time.getMinutes()).slice(-2);
  let seconds = ("00" + time.getSeconds()).slice(-2);
  value = hours + delimiter + minutes;
  if (showSeconds) value += delimiter + seconds;
  return value;
}`;
    const b = rt!.bind(s, {}, '<3D Clock>');
    expect(b).not.toBeNull();
    expect(b!.update()).toBe('14:05:07');
    b!.dispose();
  });

  it('WE 模块 import 转成本地可用值（* as X → object；{ x } → 可调用 shim，缺实现不崩）', async () => {
    const rt = await getTextScriptRuntime();
    const ns = rt!.bind(
      `import * as WEMath from 'WEMath';
export function update(v) { return typeof WEMath; }`,
      {}, '',
    );
    expect(ns).not.toBeNull();
    expect(ns!.update()).toBe('object');
    ns!.dispose();
    const named = rt!.bind(
      `import { clamp } from 'WEMath';
export function update(v) { return typeof clamp; }`,
      {}, '',
    );
    expect(named).not.toBeNull();
    expect(named!.update()).toBe('function');
    named!.dispose();
  });

  it('import 语句出现在字符串/注释里不被改写（只处理真正的 import 语句）', async () => {
    const rt = await getTextScriptRuntime();
    const b = rt!.bind(
      `// import * as WEMath from 'WEMath';
export function update(v) { return "import { x } from 'y'"; }`,
      {}, '',
    );
    expect(b).not.toBeNull();
    expect(b!.update()).toBe("import { x } from 'y'");
    b!.dispose();
  });

  // 回归靶子：真实素材（tests/fixtures/1922570576/text-object-778.json，scene.pkg 原文逐字复制）。
  // 这条脚本在修复前 bind 返回 null ⇒ 生产装配整层跳过 ⇒ 用户看不到右下角的时间数字。
  it('真实素材：魔兽之门 #778「3D Clock」脚本 bind 成功并输出 HH:MM:SS', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 10, 9, 4, 5)); // 2026-10-10 09:04:05
    const rt = await getTextScriptRuntime();
    const b = rt!.bind(WOW_CLOCK.text.script, {}, WOW_CLOCK.text.value);
    expect(b).not.toBeNull();
    expect(b!.update()).toBe('09:04:05');
    b!.dispose();
  });
});

afterEach(() => {
  vi.useRealTimers();
});
