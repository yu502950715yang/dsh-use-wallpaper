// src/client/scene-script-host.ts
//
// SceneScript 的编排层：装载期建 fps 表与 VM；帧内「推进动画 → 各脚本 update → 交出脏写入」。
// 本模块**不依赖 three** —— 脏写入由调用方（three-renderer）用 applyLayerState 落到渲染对象上，
// 所以运行时可以纯 node 单测。
import { AnimRegistry, extractAnimFps } from './scene-anim.js';
import { createLayerStateTable, type LayerStateTable, type LayerWrite } from './layer-state.js';
import { SceneScriptVm } from './scene-script-vm.js';
import type { DynamicMeshRegistry } from './dynamic-mesh.js';

export interface SceneScriptHostOptions {
  /** 必须按 scene.json 的 objects 顺序传入（脚本靠 shared 互通，顺序影响 init 期状态）。 */
  scripts: Array<{ objectId: number; source: string }>;
  userProperties: Record<string, unknown>;
  onWarn?: (msg: string) => void;
  /** 动态网格注册表：透传给 VM，让 createModelData/createLayer/applyData 有真实落点。 */
  dynamicMesh?: DynamicMeshRegistry;
  /** engine.registerAsset 的回调（装载期收集材质资产路径，由调用方解析成 three 材质）。 */
  onAsset?: (materialPath: string) => void;
}

export class SceneScriptHost {
  private readonly anims: AnimRegistry;
  private readonly state: LayerStateTable;
  private readonly vm: SceneScriptVm | null;
  /** 各脚本对应的 scene 对象 id（与装载顺序一一对应）——把 update() 的返回值写回该对象的可见性。 */
  private readonly objectIds: number[];

  private constructor(anims: AnimRegistry, state: LayerStateTable, vm: SceneScriptVm | null, objectIds: number[]) {
    this.anims = anims;
    this.state = state;
    this.vm = vm;
    this.objectIds = objectIds;
  }

  /** 创建并装载。无脚本时返回一个"空 host"（tick 恒返回空表 = 画面等于现状）。
   *  quickjs 初始化失败返回 null（调用方同样退回现状）。 */
  static async create(opts: SceneScriptHostOptions): Promise<SceneScriptHost | null> {
    const scripts = (opts.scripts ?? []).filter((s) => typeof s?.source === 'string' && s.source.length > 0);
    // fps 表：scene.pkg 内没有动画数据，唯一来源是脚本内嵌 config 的 "name":…,"fps":N
    const fpsTable = new Map<string, number>();
    for (const s of scripts) {
      for (const [name, fps] of extractAnimFps(s.source)) {
        if (!fpsTable.has(name)) fpsTable.set(name, fps);
      }
    }
    const anims = new AnimRegistry(fpsTable);
    const state = createLayerStateTable();
    if (scripts.length === 0) return new SceneScriptHost(anims, state, null, []);

    const vm = await SceneScriptVm.create({
      userProperties: opts.userProperties ?? {},
      state,
      anims,
      onWarn: opts.onWarn,
      dynamicMesh: opts.dynamicMesh,
      onAsset: opts.onAsset,
    });
    if (!vm) return null;
    for (const s of scripts) vm.load(s.source, `obj ${s.objectId}`);
    vm.initAll();
    return new SceneScriptHost(anims, state, vm, scripts.map((s) => s.objectId));
  }

  /** 已装载的脚本数（eval 失败的不计）。 */
  get scriptCount(): number {
    return this.vm?.loadedCount ?? 0;
  }

  /** 仍可用的脚本数（抛错后被停用的不计）。 */
  get activeCount(): number {
    return this.vm?.activeCount ?? 0;
  }

  /** 每帧调用：先推进动画播放器（脚本 advanceFrame 的时间源），再跑各脚本 update。
   *  返回本帧的脏写入（调用方应用后即丢弃）。 */
  tick(dt: number): Map<number, LayerWrite> {
    if (!this.vm) return new Map();
    this.vm.setFrametime(dt);
    this.anims.tick(dt);
    const results = this.vm.updateAll();
    // `visible.script` 的 update() 返回值 = 该对象本帧是否可见（WE 语义）。只对布尔生效：
    // 返回值缺失/畸形时保持现状，不误杀图层（脚本抛错时该脚本返回 undefined）。
    for (let i = 0; i < results.length && i < this.objectIds.length; i++) {
      const v = results[i];
      if (typeof v === 'boolean') this.state.write(this.objectIds[i]!, { visible: v });
    }
    return this.state.takeDirty();
  }

  /** 派发一次点击（3798688689 的「切换按钮」靠它触发 shared.we2dSwitchScene）。 */
  click(): void {
    this.vm?.clickAll();
  }

  dispose(): void {
    this.vm?.dispose();
  }
}
