// SceneScript VM（quickjs 单上下文 + 宿主原语）的行为测试。
// 覆盖：图层读写进状态表、userProperties 注入、异常隔离、动画播放器打通、stub 不抛错、handle 释放。
import { describe, it, expect } from 'vitest';
import { SceneScriptVm } from '../src/client/scene-script-vm.js';
import { createLayerStateTable } from '../src/client/layer-state.js';
import { AnimRegistry } from '../src/client/scene-anim.js';

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
});
