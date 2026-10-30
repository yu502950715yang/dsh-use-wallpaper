// SceneScript VM（quickjs 单上下文 + 宿主原语）的行为测试。
// 覆盖：图层读写进状态表、userProperties 注入、异常隔离、动画播放器打通、stub 不抛错、handle 释放。
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { SceneScriptVm, localTimeOfDay } from '../src/client/scene-script-vm.js';
import { createLayerStateTable } from '../src/client/layer-state.js';
import { AnimRegistry } from '../src/client/scene-anim.js';
import { DynamicMeshRegistry } from '../src/client/dynamic-mesh.js';

const DAY_NIGHT_SCRIPT = readFileSync(
  new URL('./fixtures/3765967112/day-night-script.js', import.meta.url),
  'utf8',
);
const DAY_DATE_SCRIPT = readFileSync(
  new URL('./fixtures/3789452668/day-date-script.js', import.meta.url),
  'utf8',
);

function setup(userProps: Record<string, unknown> = {}, fps = new Map<string, number>()) {
  const state = createLayerStateTable();
  const anims = new AnimRegistry(fps);
  const warns: string[] = [];
  return { state, anims, userProps, warns };
}

describe('SceneScriptVm', () => {
  it('装载并执行 init/update；脚本对图层的写入进状态表', async () => {
    const { state, anims, userProps } = setup();
    const vm = await SceneScriptVm.create({ userProperties: userProps, state, anims });
    expect(vm).not.toBeNull();
    expect(vm!.load(`
      export function init(value){ return value; }
      export function update(value){
        var L = thisScene.getLayerByID(10750);
        L.alpha = 0.25;
        L.origin = new Vec3(10, 20, 0);
        L.visible = true;
        return value;
      }`)).toBe(true);
    vm!.initAll();
    vm!.updateAll();
    expect(state.read(10750).alpha).toBeCloseTo(0.25);
    expect(state.read(10750).origin).toEqual([10, 20, 0]);
    vm!.dispose();
  });

  it('engine.userProperties 注入并在 applyUserProperties 中可见', async () => {
    const { state, anims, userProps } = setup({ fx_float: false });
    const vm = await SceneScriptVm.create({ userProperties: userProps, state, anims });
    vm!.load(`export function applyUserProperties(changed){
      thisScene.getLayerByID(1).alpha = changed.fx_float ? 1 : 0;
    }`);
    vm!.initAll();
    expect(state.read(1).alpha).toBe(0);
    vm!.dispose();
  });

  it('init 抛错只停用该脚本，其余脚本继续', async () => {
    const { state, anims, userProps, warns } = setup();
    const vm = await SceneScriptVm.create({ userProperties: userProps, state, anims, onWarn: (m) => warns.push(m) });
    vm!.load(`export function init(){ throw new Error('boom'); }`);
    vm!.load(`export function update(){ thisScene.getLayerByID(2).alpha = 0.5; }`);
    vm!.initAll();
    vm!.updateAll();
    expect(state.read(2).alpha).toBeCloseTo(0.5);
    expect(warns.some((w) => w.includes('boom'))).toBe(true);
    expect(vm!.loadedCount).toBe(2);
    expect(vm!.activeCount).toBe(1);
    vm!.dispose();
  });

  it('动画播放器持久：同一 name 的两次 getAnimation 共享状态', async () => {
    const { state, anims, userProps } = setup({}, new Map([['fast', 1200]]));
    const vm = await SceneScriptVm.create({ userProperties: userProps, state, anims });
    vm!.load(`export function init(){
      var a = thisScene.getLayerByID(1).getAnimation('fast');
      a.play();
      var b = thisScene.getLayerByID(1).getAnimation('fast');
      b.setFrame(100);
      thisScene.getLayerByID(1).alpha = (a.getFrame() === 100 && a.isPlaying()) ? 1 : 0;
    }`);
    vm!.initAll();
    expect(state.read(1).alpha).toBe(1);
    vm!.dispose();
  });

  it('engine.frametime 反映宿主设置的本帧 dt', async () => {
    const { state, anims, userProps } = setup();
    const vm = await SceneScriptVm.create({ userProperties: userProps, state, anims });
    vm!.load(`export function update(){ thisScene.getLayerByID(3).alpha = engine.frametime; }`);
    vm!.initAll();
    vm!.setFrametime(1 / 30);
    vm!.updateAll();
    expect(state.read(3).alpha).toBeCloseTo(1 / 30, 6);
    vm!.dispose();
  });

  it('createLayer / createModelData / getEffect / registerAsset 是安全 stub（不抛错）', async () => {
    const { state, anims, userProps, warns } = setup();
    const vm = await SceneScriptVm.create({ userProperties: userProps, state, anims, onWarn: (m) => warns.push(m) });
    vm!.load(`export function init(){
      var m = thisScene.createModelData({ shapes: [] });
      m.applyData(new Float32Array(4), 0);
      var L = thisScene.createLayer({ model: m, name: 'x' });
      L.setParent(null);
      var e = thisScene.getLayerByID(3).getEffect('角色动态');
      e.visible = false;
      e.setMaterialProperty('frame', 2);
      engine.registerAsset('materials/a.json', true);
      thisScene.getLayerByID(3).alpha = 1;
    }`);
    vm!.initAll();
    expect(warns).toEqual([]);
    expect(state.read(3).alpha).toBe(1);
    vm!.dispose();
  });

  it('eval 失败的脚本不装载（load 返回 false），不影响其他脚本', async () => {
    const { state, anims, userProps, warns } = setup();
    const vm = await SceneScriptVm.create({ userProperties: userProps, state, anims, onWarn: (m) => warns.push(m) });
    expect(vm!.load('export function update( { 语法错误')).toBe(false);
    expect(vm!.load(`export function update(){ thisScene.getLayerByID(4).alpha = 0.1; }`)).toBe(true);
    vm!.initAll();
    vm!.updateAll();
    expect(state.read(4).alpha).toBeCloseTo(0.1);
    expect(vm!.loadedCount).toBe(1);
    expect(warns.length).toBeGreaterThan(0);
    vm!.dispose();
  });

  it('多个脚本共享同一 shared（跨脚本通信的前提）', async () => {
    const { state, anims, userProps } = setup();
    const vm = await SceneScriptVm.create({ userProperties: userProps, state, anims });
    vm!.load(`export function init(){ shared.counter = 41; }`);
    vm!.load(`export function update(){ thisScene.getLayerByID(9).alpha = shared.counter + 1; }`);
    vm!.initAll();
    vm!.updateAll();
    expect(state.read(9).alpha).toBe(42);
    vm!.dispose();
  });

  it('dispose 不抛，且重复 dispose 安全（handle 全部释放）', async () => {
    const { state, anims, userProps } = setup();
    const vm = await SceneScriptVm.create({ userProperties: userProps, state, anims });
    vm!.load(`export function init(){ thisScene.getLayerByID(1).alpha = 1; }`);
    vm!.initAll();
    expect(() => vm!.dispose()).not.toThrow();
    expect(() => vm!.dispose()).not.toThrow();
  });

  // ⚠️ 真实 GUI 回归（2026-09-22）：预算只减不增 ⇒ 长时间运行后报 `InternalError: interrupted`
  // 并把所有脚本永久停用。headless e2e 只跑几帧测不出来，故用可注入的小预算做回归。
  it('指令预算每次调用都重置（不会被累积耗尽）', async () => {
    const { state, anims, userProps } = setup();
    const warns: string[] = [];
    const vm = await SceneScriptVm.create({
      userProperties: userProps, state, anims,
      onWarn: (m) => warns.push(m),
      stepBudget: 200_000,
    });
    vm!.load(`export function update(){
      var s = 0;
      for (var i = 0; i < 200; i++) s += i;
      thisScene.getLayerByID(11).alpha = s > 0 ? 1 : 0;
    }`);
    vm!.initAll();
    for (let i = 0; i < 60; i++) vm!.updateAll();
    expect(warns.filter((w) => w.includes('interrupted'))).toEqual([]);
    expect(vm!.activeCount).toBe(1);
    expect(state.read(11).alpha).toBe(1);
    vm!.dispose();
  });

  // ⚠️ 真实 GUI 回归（2026-09-22）：221591「双击切歌」的 init 调 thisScene.getLayer(name).stop()
  // —— 未实现的 WE API 必须走兜底 Proxy，否则单个缺失方法就 TypeError 并停用整个脚本。
  it('未实现的 WE API（layer.stop 等）走兜底不抛错', async () => {
    const { state, anims, userProps, warns } = setup();
    const vm = await SceneScriptVm.create({ userProperties: userProps, state, anims, onWarn: (m) => warns.push(m) });
    vm!.load(`export function init(){
      thisScene.getLayer('某首歌').stop();
      thisScene.getLayer('某首歌').play();
      thisScene.getLayer('某首歌').setSomethingUnknown(1, 2);
      thisScene.someUnknownApi().then();
      thisScene.getLayerByID(12).alpha = 1;
    }`);
    vm!.initAll();
    expect(warns).toEqual([]);
    expect(vm!.activeCount).toBe(1);
    expect(state.read(12).alpha).toBe(1);
    vm!.dispose();
  });

  // 动态网格（2026-09-22）：脚本 createModelData/createLayer/applyData 落到 DynamicMeshRegistry。
  it('createModelData / createLayer / applyData 接真实网格注册表', async () => {
    const { state, anims, userProps } = setup();
    const parent = new THREE.Scene();
    const assets: string[] = [];
    const warns: string[] = [];
    const registry = new DynamicMeshRegistry({ parent, materialFor: () => new THREE.MeshBasicMaterial() });
    const vm = await SceneScriptVm.create({
      userProperties: userProps, state, anims, dynamicMesh: registry, onAsset: (p) => assets.push(p),
      onWarn: (m) => warns.push(m),
    });
    vm!.load(`export function init(){
      var mat = engine.registerAsset('materials/particles/emitter_00.json', true);
      var verts = new Float32Array(2 * 36);
      verts[0] = 100; verts[1] = 50; verts[5] = 1; verts[6] = 1; verts[7] = 1; verts[8] = 1;
      var model = thisScene.createModelData({ boundingBoxMins: new Vec3(-1,-1,-1), boundingBoxMaxs: new Vec3(1,1,1),
        shapes: [{ vertexBuffer: verts, indexBuffer: new Uint16Array(12),
                   vertexFormat: [IModelData.POSITION, IModelData.UV, IModelData.COLOR], material: mat, isVertexBufferDynamic: true }] });
      var layer = thisScene.createLayer({ model: model, name: '测试层', origin: new Vec3(0,0,0), perspective: false });
      layer.visible = true;
      model.applyData({ vertexBuffer: verts });
    }`);
    vm!.initAll();
    expect(warns).toEqual([]);
    expect(assets).toEqual(['materials/particles/emitter_00.json']);
    expect(registry.modelCount).toBe(1);
    const g = registry.geometryOf(0)!;
    expect(g.getAttribute('position').array[0]).toBeCloseTo(100);
    expect(g.getAttribute('position').array[1]).toBeCloseTo(50);
    expect(g.drawRange.count).toBe(6);
    expect(registry.meshOf(0)!.name).toBe('测试层');
    expect(parent.children.length).toBe(1);
    vm!.dispose();
  });

  it('未注入 dynamicMesh 时 createModelData 仍是安全哑对象（其他壁纸零影响）', async () => {
    const { state, anims, userProps } = setup();
    const vm = await SceneScriptVm.create({ userProperties: userProps, state, anims });
    vm!.load(`export function init(){
      var m = thisScene.createModelData({ shapes: [{ vertexBuffer: new Float32Array(36), vertexFormat: [0,1,2] }] });
      var l = thisScene.createLayer({ model: m, name: 'x' });
      l.visible = false;
      m.applyData({ vertexBuffer: new Float32Array(36) });
    }`);
    expect(() => { vm!.initAll(); vm!.updateAll(); }).not.toThrow();
    expect(vm!.activeCount).toBe(1);
    vm!.dispose();
  });

  it('运行时图层的 visible 读写走宿主（脚本用它剔除空 mesh）', async () => {
    const { state, anims, userProps } = setup();
    const registry = new DynamicMeshRegistry({ parent: new THREE.Scene(), materialFor: () => new THREE.MeshBasicMaterial() });
    const vm = await SceneScriptVm.create({ userProperties: userProps, state, anims, dynamicMesh: registry });
    vm!.load(`export function init(){
      var verts = new Float32Array(36); verts[0] = 1;
      var m = thisScene.createModelData({ shapes: [{ vertexBuffer: verts, vertexFormat: [0,1,2] }] });
      var l = thisScene.createLayer({ model: m, name: 'L' });
      l.visible = false;
      thisScene.getLayerByID(21).alpha = l.visible ? 0 : 1;
    }`);
    vm!.initAll();
    expect(registry.isVisible(0)).toBe(false);
    expect(state.read(21).alpha).toBe(1);
    vm!.dispose();
  });

  // visible.script 的信号源（2026-09-22）：`update(value)` 的**返回值**就是「该对象是否可见」。
  // 一期调用后把返回值丢掉了 ⇒ 10 个歌曲字标全部显示、歌名重影。
  it('updateAll 按装载顺序返回各脚本的 {objectId, property, value}', async () => {
    const { state, anims, userProps } = setup();
    const vm = await SceneScriptVm.create({ userProperties: userProps, state, anims });
    vm!.load(`export function update(value){ return true; }`);
    vm!.load(`export function update(value){ return false; }`);
    vm!.load(`export function update(value){ return 42; }`);
    vm!.load(`export function init(){ thisScene.getLayerByID(1).alpha = 1; }`); // 无 update
    vm!.load(`export function update(v){ v.z = 1; return v; }`, 'obj 5', 5, undefined, 'angles');
    vm!.initAll();
    expect(vm!.updateAll()).toEqual([
      { objectId: null, property: null, value: true },
      { objectId: null, property: null, value: false },
      { objectId: null, property: null, value: 42 },
      { objectId: null, property: null, value: undefined },
      { objectId: 5, property: 'angles', value: undefined },
    ]);
    expect(state.read(5).angles).toEqual([0, 0, 1]);
    vm!.dispose();
  });
});

// ── 对象级脚本的宿主 API（2026-10-20）：thisLayer.getTextureAnimation / engine.timeOfDay /
//    localStorage / createScriptProperties。真实样本：3765967112 的 angles.script。
describe('SceneScriptVm 对象级脚本 API', () => {
  function fakeTexAnim() {
    const calls: string[] = [];
    let frame = 0;
    let playing = true;
    return {
      calls,
      host: {
        pause: (id: number) => { calls.push(`pause:${id}`); playing = false; },
        play: (id: number) => { calls.push(`play:${id}`); playing = true; },
        stop: (id: number) => { calls.push(`stop:${id}`); playing = false; frame = 0; },
        isPlaying: () => playing,
        setFrame: (id: number, f: number) => { calls.push(`frame:${id}:${f}`); frame = f; },
        getFrame: () => frame,
      },
    };
  }

  it('thisLayer 指向当前脚本所属对象；getTextureAnimation 走宿主且同一 key 复用同一对象', async () => {
    const { state, anims, userProps } = setup();
    const tex = fakeTexAnim();
    const vm = await SceneScriptVm.create({
      userProperties: userProps, state, anims, textureAnimation: tex.host,
    });
    vm!.load(`export function init(){
      var a = thisLayer.getTextureAnimation();
      a.pause();
      a.setFrame(2);
      a.play();
      thisScene.getLayerByID(9).alpha = (a === thisLayer.getTextureAnimation() && a.getFrame() === 2 && a.isPlaying()) ? 1 : 0;
    }`, 'obj 123', 123);
    vm!.initAll();
    expect(tex.calls).toEqual(['pause:123', 'frame:123:2', 'play:123']);
    expect(state.read(9).alpha).toBe(1);
    vm!.dispose();
  });

  it('真实 Fixture：scriptProperties 用 scene.json 覆盖（dayStart=0/nightStart=12），跨日夜边界才换帧', async () => {
    const { state, anims, userProps } = setup();
    const tex = fakeTexAnim();
    let tod = 10 / 24; // 上午 = day（若用脚本缺省 8/20，13 点也仍是 day —— 覆盖值才让 13 点变 night）
    const vm = await SceneScriptVm.create({
      userProperties: userProps, state, anims,
      textureAnimation: tex.host,
      timeOfDay: () => tod,
    });
    vm!.load(DAY_NIGHT_SCRIPT, 'obj 123', 123, { dayStart: 0, nightStart: 12 });
    vm!.initAll();
    expect(tex.calls).toEqual(['pause:123', 'frame:123:0']); // automatic：init 只 pause + setFrame(0)
    vm!.updateAll();
    expect(tex.calls).toEqual(['pause:123', 'frame:123:0']); // 状态未变 ⇒ 不重写帧
    tod = 13 / 24;
    vm!.updateAll();
    expect(tex.calls).toEqual(['pause:123', 'frame:123:0', 'frame:123:2']); // 跨入 night
    vm!.updateAll();
    expect(tex.calls.length).toBe(3); // 同状态不再写帧
    vm!.dispose();
  });

  it('cursorClick 循环 automatic→day→night 并写 localStorage', async () => {
    const { state, anims, userProps } = setup();
    const tex = fakeTexAnim();
    const store = new Map<string, string>();
    const vm = await SceneScriptVm.create({
      userProperties: userProps, state, anims,
      textureAnimation: tex.host,
      wallpaperId: '3765967112',
      storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => { store.set(k, v); } },
    });
    vm!.load(DAY_NIGHT_SCRIPT, 'obj 123', 123, { dayStart: 8, nightStart: 20 });
    vm!.initAll();
    vm!.clickAll();
    expect(tex.calls.at(-1)).toBe('frame:123:1');
    expect(store.get('we:scenescript:3765967112:currentTimeState')).toBe('"day"');
    vm!.clickAll();
    expect(tex.calls.at(-1)).toBe('frame:123:2');
    expect(store.get('we:scenescript:3765967112:currentTimeState')).toBe('"night"');
    vm!.clickAll();
    expect(tex.calls.at(-1)).toBe('frame:123:0');
    expect(store.get('we:scenescript:3765967112:currentTimeState')).toBe('"automatic"');
    vm!.dispose();
  });

  it('engine.timeOfDay 是宿主注入的 0-1 值；缺省走本地时钟且在有界区间', async () => {
    const { state, anims, userProps } = setup();
    const vm = await SceneScriptVm.create({
      userProperties: userProps, state, anims,
      timeOfDay: () => 14.5 / 24,
    });
    vm!.load(`export function init(){ thisScene.getLayerByID(1).alpha = engine.timeOfDay; }`);
    vm!.initAll();
    expect(state.read(1).alpha).toBeCloseTo(14.5 / 24, 6);
    vm!.dispose();

    const vm2 = await SceneScriptVm.create({ userProperties: userProps, state, anims });
    vm2!.load(`export function init(){ thisScene.getLayerByID(2).alpha = engine.timeOfDay; }`);
    vm2!.initAll();
    const t = state.read(2).alpha!;
    expect(t).toBeGreaterThanOrEqual(0);
    expect(t).toBeLessThan(1);
    vm2!.dispose();

    // 越界值钳到 [0,1)：1 与 0 同义（次日午夜）。
    const vm3 = await SceneScriptVm.create({ userProperties: userProps, state, anims, timeOfDay: () => 1 });
    vm3!.load(`export function init(){ thisScene.getLayerByID(3).alpha = engine.timeOfDay; }`);
    vm3!.initAll();
    expect(state.read(3).alpha).toBeLessThan(1);
    vm3!.dispose();
    const vm4 = await SceneScriptVm.create({ userProperties: userProps, state, anims, timeOfDay: () => -0.5 });
    vm4!.load(`export function init(){ thisScene.getLayerByID(4).alpha = engine.timeOfDay; }`);
    vm4!.initAll();
    expect(state.read(4).alpha).toBe(0);
    vm4!.dispose();
  });

  // 缺省映射必须用**本地** getHours（UTC 实现在 Asia/Shanghai 会把 06:00 算成 22:00）。
  it('默认 localTimeOfDay = 本地时钟当天占比（06:00 → 0.25）', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 9, 20, 6, 0, 0));
      expect(localTimeOfDay()).toBeCloseTo(0.25, 9);
    } finally {
      vi.useRealTimers();
    }
  });

  it('localStorage get/set 往返对象/字符串，缺失返回 null（前缀 + 壁纸 id + JSON）', async () => {
    const { state, anims, userProps } = setup();
    const store = new Map<string, string>();
    const vm = await SceneScriptVm.create({
      userProperties: userProps, state, anims,
      wallpaperId: '3765967112',
      storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => { store.set(k, v); } },
    });
    vm!.load(`export function init(){
      localStorage.set('currentTimeState', 'day');
      localStorage.set('obj', { a: [1, 2] });
      var o = localStorage.get('obj');
      thisScene.getLayerByID(1).alpha = (localStorage.get('currentTimeState') === 'day' && o.a[1] === 2) ? 1 : 0;
      thisScene.getLayerByID(2).alpha = localStorage.get('missing') === null ? 1 : 0;
    }`);
    vm!.initAll();
    expect(state.read(1).alpha).toBe(1);
    expect(state.read(2).alpha).toBe(1);
    expect(store.get('we:scenescript:3765967112:currentTimeState')).toBe('"day"');
    expect(JSON.parse(store.get('we:scenescript:3765967112:obj')!)).toEqual({ a: [1, 2] });
    vm!.dispose();
  });

  // 已存状态恢复（按壁纸隔离的键）：day → 重新 init 直接 setFrame(1)（太阳帧）。
  it('localStorage 已存 day 时重新 init 回到 frame1', async () => {
    const { state, anims, userProps } = setup();
    const tex = fakeTexAnim();
    const store = new Map<string, string>([['we:scenescript:3765967112:currentTimeState', '"day"']]);
    const vm = await SceneScriptVm.create({
      userProperties: userProps, state, anims,
      textureAnimation: tex.host,
      wallpaperId: '3765967112',
      storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => { store.set(k, v); } },
    });
    vm!.load(DAY_NIGHT_SCRIPT, 'obj 123', 123, { dayStart: 0, nightStart: 12 }, 'angles');
    vm!.initAll();
    expect(tex.calls).toEqual(['pause:123', 'frame:123:1']);
    vm!.updateAll();
    expect(tex.calls).toEqual(['pause:123', 'frame:123:1']); // 非 automatic 状态不再换帧
    vm!.dispose();
  });

  // WE 属性脚本契约：update(value)/init(value) 收当前值 Vec3，返回 Vec3 写回属性。
  // angles 用 WE 的脚本单位（度）存进 {state}；applyLayerState 落 three 时转弧度（layer-state.test.ts）。
  it('属性脚本 init/update 收当前 Vec3，返回 Vec3 写回 angles；非向量/无返回不动属性', async () => {
    const { state, anims, userProps, warns } = setup();
    const vm = await SceneScriptVm.create({
      userProperties: userProps, state, anims, onWarn: (m) => warns.push(m),
    });
    vm!.load(`export function init(v){ v.z = 0.25; return v; }
      export function update(v){ v.z = 0.5; return v; }`, 'obj 200', 200, undefined, 'angles');
    vm!.load(`export function update(v){ v.z = 9; return 'nope'; }`, 'obj 201', 201, undefined, 'angles');
    vm!.load(`export function update(v){ v.z = 9; }`, 'obj 202', 202, undefined, 'angles');
    vm!.initAll();
    expect(state.read(200).angles).toEqual([0, 0, 0.25]);
    vm!.updateAll();
    expect(state.read(200).angles).toEqual([0, 0, 0.5]);
    expect(state.read(201).angles).toBeUndefined();
    expect(state.read(202).angles).toBeUndefined();
    expect(warns).toEqual([]);
    vm!.dispose();
  });

  // thisLayer.angles 与属性脚本同单位（度）：写入 90 后读回 90（three 侧转弧度由 applyLayerState 负责）。
  it('thisLayer.angles 读写走 WE 脚本单位（度）', async () => {
    const { state, anims, userProps } = setup();
    const vm = await SceneScriptVm.create({ userProperties: userProps, state, anims });
    vm!.load(`export function init(){ thisScene.getLayerByID(77).angles = new Vec3(0, 0, 90); }
      export function update(){ thisScene.getLayerByID(78).alpha = thisScene.getLayerByID(77).angles.z; }`);
    vm!.initAll();
    expect(state.read(77).angles).toEqual([0, 0, 90]);
    vm!.updateAll();
    expect(state.read(78).alpha).toBe(90);
    vm!.dispose();
  });

  // 真实库 2980088441 obj54：color 属性脚本返回 Vec3 —— 只记录（进状态表），不要求像素生效。
  it('color 属性脚本返回 Vec3 只记录；init(value) 拿到当前颜色（默认 1,1,1）', async () => {
    const { state, anims, userProps } = setup();
    const vm = await SceneScriptVm.create({ userProperties: userProps, state, anims });
    vm!.load(`export function init(v){ thisScene.getLayerByID(1).alpha = v.x; }
      export function update(){ return new Vec3(0.25, 0.5, 0.75); }`, 'obj 54', 54, undefined, 'color');
    vm!.initAll();
    expect(state.read(1).alpha).toBe(1);
    vm!.updateAll();
    expect(state.read(54).color).toEqual([0.25, 0.5, 0.75]);
    vm!.dispose();
  });

  // 多 object script：thisLayer 必须指向各自对象（key 不能串台）。
  it('多 object script 的 thisLayer 各自绑定正确对象', async () => {
    const { state, anims, userProps } = setup();
    const tex = fakeTexAnim();
    const vm = await SceneScriptVm.create({
      userProperties: userProps, state, anims, textureAnimation: tex.host,
    });
    vm!.load(`export function init(){ thisLayer.getTextureAnimation().setFrame(1); }`, 'obj 101', 101);
    vm!.load(`export function init(){ thisLayer.getTextureAnimation().setFrame(2); }`, 'obj 202', 202);
    vm!.initAll();
    expect(tex.calls).toEqual(['frame:101:1', 'frame:202:2']);
    vm!.dispose();
  });

  // 真实 Fixture（Crimson 的 angles.script）：生命周期脚本不写 angles（update 无返回值）。
  it('Crimson 真实脚本作为 angles 属性脚本时不写 angles', async () => {
    const { state, anims, userProps } = setup();
    const tex = fakeTexAnim();
    const vm = await SceneScriptVm.create({
      userProperties: userProps, state, anims,
      textureAnimation: tex.host,
      timeOfDay: () => 10 / 24,
    });
    vm!.load(DAY_NIGHT_SCRIPT, 'obj 123', 123, { dayStart: 0, nightStart: 12 }, 'angles');
    vm!.initAll();
    vm!.updateAll();
    expect(state.read(123).angles).toBeUndefined();
    vm!.dispose();
  });

  // 真实 Fixture（3789452668 obj80 的 visible.script）：每帧算日期字符串，返回值不是布尔 ⇒ 被忽略但不报错。
  it('真实 Fixture：日期文本 visible.script 每帧执行不报错（返回字符串被忽略）', async () => {
    const { state, anims, userProps, warns } = setup();
    const vm = await SceneScriptVm.create({
      userProperties: userProps, state, anims, onWarn: (m) => warns.push(m),
    });
    vm!.load(DAY_DATE_SCRIPT, 'obj 80', 80, {
      addDelimiter: '/', alignVertical: false, dayFormat: '1', monthFormat: '1', showDay: true, useDelimiter: false,
    });
    vm!.initAll();
    const out = vm!.updateAll();
    expect(warns).toEqual([]);
    expect(vm!.activeCount).toBe(1);
    expect(typeof out[0]!.value).toBe('string');
    vm!.dispose();
  });

  // __mkTextureAnimation 未知成员（setSpeed 等）走 __wrap/__any，不得 TypeError 停用脚本。
  it('getTextureAnimation 的未知方法走兜底不抛错', async () => {
    const { state, anims, userProps, warns } = setup();
    const tex = fakeTexAnim();
    const vm = await SceneScriptVm.create({
      userProperties: userProps, state, anims, textureAnimation: tex.host, onWarn: (m) => warns.push(m),
    });
    vm!.load(`export function init(){
      var a = thisLayer.getTextureAnimation();
      a.setSpeed(2);
      a.pause();
      thisScene.getLayerByID(1).alpha = 1;
    }`, 'obj 303', 303);
    vm!.initAll();
    expect(warns).toEqual([]);
    expect(vm!.activeCount).toBe(1);
    expect(tex.calls).toEqual(['pause:303']);
    vm!.dispose();
  });
});

// ── 媒体事件（媒体集成 T6）：四个 handler + MediaPlaybackEvent 常量 + thisObject.getAnimation ──
describe('SceneScriptVm 媒体事件', () => {
  const THUMB = {
    hasThumbnail: true,
    primaryColor: [1, 0, 0] as [number, number, number],
    secondaryColor: [0, 1, 0] as [number, number, number],
    tertiaryColor: [0, 0, 1] as [number, number, number],
    textColor: [1, 1, 1] as [number, number, number],
    highContrastColor: [0, 0, 0] as [number, number, number],
  };

  it('mediaPlaybackChanged：MediaPlaybackEvent 常量可用，事件 state 进脚本，thisLayer 写状态表', async () => {
    const { state, anims, userProps } = setup();
    const vm = await SceneScriptVm.create({ userProperties: userProps, state, anims });
    vm!.load(`export function mediaPlaybackChanged(event){
      if (event.state == MediaPlaybackEvent.PLAYBACK_STOPPED) thisLayer.visible = false;
      else thisLayer.visible = true;
    }`, 'obj 1', 1);
    expect(vm!.dispatchMedia({ event: 'mediaPlaybackChanged', playback: 0 })).toBe(1);
    expect(state.read(1).visible).toBe(false);
    vm!.dispatchMedia({ event: 'mediaPlaybackChanged', playback: 1 });
    expect(state.read(1).visible).toBe(true);
    vm!.dispatchMedia({ event: 'mediaPlaybackChanged', playback: 2 });
    expect(state.read(1).visible).toBe(true); // PAUSED=2 也是可见
    vm!.dispose();
  });

  it('mediaPropertiesChanged / mediaThumbnailChanged：字段与 Vec3 颜色进脚本', async () => {
    const { state, anims, userProps } = setup();
    const vm = await SceneScriptVm.create({ userProperties: userProps, state, anims });
    vm!.load(`
      export function mediaPropertiesChanged(event){
        var L = thisScene.getLayerByID(5);
        L.alpha = (event.title == 'T' && event.artist == 'A' && event.album == '' && event.contentType == 'music') ? 0.5 : 0;
      }
      export function mediaThumbnailChanged(event){
        var L = thisScene.getLayerByID(5);
        if (event.hasThumbnail) L.color = new Vec3(event.primaryColor.x, event.primaryColor.y, event.primaryColor.z);
      }`);
    expect(vm!.dispatchMedia({
      event: 'mediaPropertiesChanged',
      properties: { title: 'T', artist: 'A', album: '', contentType: 'music' },
    })).toBe(1);
    expect(state.read(5).alpha).toBeCloseTo(0.5);
    expect(vm!.dispatchMedia({ event: 'mediaThumbnailChanged', thumbnail: THUMB })).toBe(1);
    expect(state.read(5).color).toEqual([1, 0, 0]);
    vm!.dispose();
  });

  it('dispatchMedia 只调对应 handler：返回实际调用成功的数量', async () => {
    const { state, anims, userProps } = setup();
    const vm = await SceneScriptVm.create({ userProperties: userProps, state, anims });
    vm!.load(`export function mediaStatusChanged(e){ thisScene.getLayerByID(1).alpha = e.enabled ? 1 : 0; }`, 'obj 1', 1);
    vm!.load(`export function mediaPlaybackChanged(e){ thisScene.getLayerByID(2).alpha = e.state; }`, 'obj 2', 2);
    expect(vm!.dispatchMedia({ event: 'mediaStatusChanged', enabled: false })).toBe(1);
    expect(state.read(1).alpha).toBe(0);
    expect(vm!.dispatchMedia({ event: 'mediaPlaybackChanged', playback: 2 })).toBe(1);
    expect(state.read(2).alpha).toBe(2);
    expect(vm!.dispatchMedia({ event: 'mediaPropertiesChanged', properties: { title: '', artist: '', album: '', contentType: '' } })).toBe(0);
    vm!.dispose();
  });

  it('media handler 抛错：停用该脚本并 warn，不计入成功数（与 callOne 同语义）', async () => {
    const { state, anims, userProps, warns } = setup();
    const vm = await SceneScriptVm.create({ userProperties: userProps, state, anims, onWarn: (m) => warns.push(m) });
    vm!.load(`export function mediaStatusChanged(e){ throw new Error('media boom'); }`, 'obj 9', 9);
    expect(vm!.dispatchMedia({ event: 'mediaStatusChanged', enabled: true })).toBe(0);
    expect(vm!.activeCount).toBe(0);
    expect(warns.some((w) => w.includes('media boom'))).toBe(true);
    expect(vm!.dispatchMedia({ event: 'mediaStatusChanged', enabled: true })).toBe(0); // 停用后不再调用
    vm!.dispose();
  });

  it('thisObject.getAnimation()：属性脚本经时间线源取播放器并 play（不抛错）', async () => {
    const { state, anims, userProps } = setup();
    const played: string[] = [];
    const vm = await SceneScriptVm.create({
      userProperties: userProps, state, anims,
      timeline: {
        getByProperty: (id, prop, name) => {
          played.push(`${id}:${prop}:${name}`);
          return {
            play: () => { played.push('play'); }, pause() { /* noop */ }, stop() { /* noop */ },
            isPlaying: () => false, setFrame() { /* noop */ }, getFrame: () => 0,
          };
        },
        getByName: () => null,
      },
    });
    vm!.load(`export function mediaThumbnailChanged(event){ thisObject.getAnimation().play(); }`,
      'obj 123', 123, undefined, 'angles');
    expect(vm!.dispatchMedia({ event: 'mediaThumbnailChanged', thumbnail: THUMB })).toBe(1);
    expect(played).toEqual(['123:angles:', 'play']);
    expect(vm!.activeCount).toBe(1);
    vm!.dispose();
  });

  it('thisObject.getAnimation(名)：无属性绑定时按 name 走 getByName', async () => {
    const { state, anims, userProps } = setup();
    const named: string[] = [];
    const propertyCalls: string[] = [];
    const vm = await SceneScriptVm.create({
      userProperties: userProps, state, anims,
      timeline: {
        getByProperty: (id, prop) => { propertyCalls.push(`${id}:${prop}`); return null; },
        getByName: (id, name) => {
          named.push(`${id}:${name}`);
          return {
            play: () => { named.push('play'); }, pause() { /* noop */ }, stop() { /* noop */ },
            isPlaying: () => false, setFrame() { /* noop */ }, getFrame: () => 0,
          };
        },
      },
    });
    vm!.load(`export function mediaStatusChanged(event){ thisObject.getAnimation('Title').play(); }`, 'obj 7', 7);
    expect(vm!.dispatchMedia({ event: 'mediaStatusChanged', enabled: true })).toBe(1);
    expect(propertyCalls).toEqual([]);
    expect(named).toEqual(['7:Title', 'play']);
    expect(vm!.activeCount).toBe(1);
    vm!.dispose();
  });

  it('无时间线源时 thisObject.getAnimation 走 AnimRegistry 播放器（play/setFrame/getFrame 可用）', async () => {
    const { state, anims, userProps, warns } = setup();
    const vm = await SceneScriptVm.create({ userProperties: userProps, state, anims, onWarn: (m) => warns.push(m) });
    vm!.load(`export function mediaStatusChanged(event){
      var a = thisObject.getAnimation('fallback');
      a.play();
      thisObject.alpha = 0.25;
      thisScene.getLayerByID(10).alpha = thisObject.alpha;
      thisScene.getLayerByID(11).alpha = (thisObject === thisObject && a === thisObject.getAnimation('fallback')) ? 1 : 0;
      thisScene.getLayerByID(7).alpha = a.isPlaying() ? 1 : 0;
      a.setFrame(3);
      thisScene.getLayerByID(8).alpha = a.getFrame();
      thisScene.getLayerByID(9).alpha = a.rate;
    }`, 'obj 7', 7);
    expect(vm!.dispatchMedia({ event: 'mediaStatusChanged', enabled: true })).toBe(1);
    expect(state.read(7).alpha).toBe(1);
    expect(state.read(8).alpha).toBe(3);
    expect(state.read(9).alpha).toBe(1); // 缺省 rate = 1
    expect(state.read(10).alpha).toBe(0.25); // thisObject 透传图层字段
    expect(state.read(11).alpha).toBe(1); // 播放器/thisObject 缓存稳定
    expect(warns).toEqual([]);
    expect(vm!.activeCount).toBe(1);
    vm!.dispose();
  });
});
