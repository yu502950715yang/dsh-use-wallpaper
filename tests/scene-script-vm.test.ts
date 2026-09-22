// SceneScript VM（quickjs 单上下文 + 宿主原语）的行为测试。
// 覆盖：图层读写进状态表、userProperties 注入、异常隔离、动画播放器打通、stub 不抛错、handle 释放。
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { SceneScriptVm } from '../src/client/scene-script-vm.js';
import { createLayerStateTable } from '../src/client/layer-state.js';
import { AnimRegistry } from '../src/client/scene-anim.js';
import { DynamicMeshRegistry } from '../src/client/dynamic-mesh.js';

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
});
