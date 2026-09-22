// SceneScriptHost（编排层）行为测试：装载顺序、逐动画 fps 推进、脏写入、点击、降级。
import { describe, it, expect } from 'vitest';
import { SceneScriptHost } from '../src/client/scene-script-host.js';

describe('SceneScriptHost', () => {
  it('装载多个脚本并按传入顺序执行；后执行者看到先执行者写的 shared；同值不再脏', async () => {
    const host = await SceneScriptHost.create({
      userProperties: {},
      scripts: [
        { objectId: 1, source: `export function init(){ shared.n = 0; }
          export function update(){ shared.n = 1; thisScene.getLayerByID(1).alpha = shared.n; }` },
        { objectId: 2, source: `export function update(){ thisScene.getLayerByID(2).alpha = shared.n; }` },
      ],
    });
    expect(host).not.toBeNull();
    expect(host!.scriptCount).toBe(2);
    const d1 = host!.tick(1 / 60);
    expect(d1.get(1)?.alpha).toBe(1);
    expect(d1.get(2)?.alpha).toBe(1); // 后执行的脚本读到先执行者写的 shared.n
    expect(host!.tick(1 / 60).size).toBe(0); // 写同值不再脏（避免每帧无谓应用）
    host!.dispose();
  });

  it('动画按逐动画 fps 推进（1200 vs 60 —— 同一壁纸内相差 20 倍）', async () => {
    const host = await SceneScriptHost.create({
      userProperties: {},
      scripts: [{
        objectId: 1,
        source: `const config={"loops":[{"name":"fast","fps":1200},{"name":"slow","fps":60}]};
        export function init(){
          thisScene.getLayerByID(1).getAnimation('fast').play();
          thisScene.getLayerByID(1).getAnimation('slow').play();
        }
        export function update(){
          thisScene.getLayerByID(1).alpha = thisScene.getLayerByID(1).getAnimation('fast').getFrame();
          thisScene.getLayerByID(2).alpha = thisScene.getLayerByID(1).getAnimation('slow').getFrame();
        }`,
      }],
    });
    expect(host).not.toBeNull();
    const d = host!.tick(1 / 60);
    expect(d.get(1)?.alpha).toBeCloseTo(20, 3); // 1200 fps × 1/60 s
    expect(d.get(2)?.alpha).toBeCloseTo(1, 3);  // 60 fps × 1/60 s
    host!.dispose();
  });

  it('单脚本抛错不影响其他脚本；停用后不再调用', async () => {
    const host = await SceneScriptHost.create({
      userProperties: {},
      scripts: [
        { objectId: 1, source: `export function update(){ throw new Error('x'); }` },
        { objectId: 2, source: `export function update(){ thisScene.getLayerByID(2).alpha = 0.3; }` },
      ],
    });
    const d = host!.tick(1 / 60);
    expect(d.get(2)?.alpha).toBeCloseTo(0.3);
    expect(d.has(1)).toBe(false);
    expect(host!.activeCount).toBe(1);
    host!.dispose();
  });

  it('click 触发各脚本 cursorClick（94001 → shared.we2dSwitchScene 链路）', async () => {
    const host = await SceneScriptHost.create({
      userProperties: {},
      scripts: [
        { objectId: 94000, source: `export function init(){ shared.we2dSwitchScene = function(){ shared.called = 1; }; }` },
        { objectId: 94001, source: `export function cursorClick(){ shared.we2dSwitchScene(); thisScene.getLayerByID(5).alpha = shared.called; }` },
      ],
    });
    host!.click();
    const d = host!.tick(1 / 60);
    expect(d.get(5)?.alpha).toBe(1);
    host!.dispose();
  });

  it('scripts 为空时 create 成功，tick 返回空表（画面 = 现状）', async () => {
    const host = await SceneScriptHost.create({ userProperties: {}, scripts: [] });
    expect(host).not.toBeNull();
    expect(host!.scriptCount).toBe(0);
    expect(host!.tick(1 / 60).size).toBe(0);
    host!.dispose();
  });

  it('装载顺序影响 init 期状态（后装载者看到先装载者写入的 shared）', async () => {
    const host = await SceneScriptHost.create({
      userProperties: {},
      scripts: [
        { objectId: 92000, source: `export function init(){ shared.order = 'first'; }` },
        { objectId: 94000, source: `export function init(){ shared.seen = shared.order; }
          export function update(){ thisScene.getLayerByID(7).alpha = shared.seen === 'first' ? 1 : 0; }` },
      ],
    });
    const d = host!.tick(1 / 60);
    expect(d.get(7)?.alpha).toBe(1);
    host!.dispose();
  });

  // visible.script 的返回值应用（2026-09-22）：10 个歌曲字标各挂一个 visible.script，
  // 按 shared.we2dMusicIndex 择一显示；返回值被丢弃时它们会全部叠加（真机：歌名重影）。
  it('visible.script 的布尔返回值写进状态表', async () => {
    const host = await SceneScriptHost.create({
      userProperties: {},
      scripts: [
        { objectId: 11, source: `export function update(){ return true; }` },
        { objectId: 12, source: `export function update(){ return false; }` },
        { objectId: 13, source: `export function update(){ return 'not-a-bool'; }` },
      ],
    });
    const d = host!.tick(1 / 60);
    expect(d.get(11)?.visible).toBe(true);
    expect(d.get(12)?.visible).toBe(false);
    expect(d.get(13)).toBeUndefined(); // 非布尔不写（畸形数据不误杀图层）
    host!.dispose();
  });

  it('同一帧内 visible 与 alpha 是两条独立通道，互不覆盖', async () => {
    const host = await SceneScriptHost.create({
      userProperties: {},
      scripts: [
        { objectId: 1, source: `export function update(){ thisScene.getLayerByID(21).alpha = 0.5; return false; }` },
        { objectId: 2, source: `export function update(){ thisScene.getLayerByID(21).alpha = 0.9; return true; }` },
      ],
    });
    const d = host!.tick(1 / 60);
    expect(d.get(21)?.alpha).toBeCloseTo(0.9); // 后执行者设的 alpha 生效
    expect(d.get(1)?.visible).toBe(false);     // 各自的可见性也都在
    expect(d.get(2)?.visible).toBe(true);
    host!.dispose();
  });

  it('可见性随脚本返回值逐帧变化（切歌后另一个字标显示）', async () => {
    const host = await SceneScriptHost.create({
      userProperties: {},
      scripts: [
        { objectId: 31, source: `export function update(){ return shared.idx === 0; }` },
        { objectId: 32, source: `export function update(){ return shared.idx === 1; }` },
        { objectId: 30, source: `export function init(){ shared.idx = 0; } export function update(){ return true; }` },
      ],
    });
    const d1 = host!.tick(1 / 60);
    expect(d1.get(31)?.visible).toBe(true);
    expect(d1.get(32)?.visible).toBe(false);
    host!.dispose();
  });
});
