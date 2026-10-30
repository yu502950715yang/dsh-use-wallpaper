// src/client/scene-script-host.ts
//
// SceneScript 的编排层：装载期建 fps 表与 VM；帧内「推进动画 → 各脚本 update → 交出脏写入」。
// 本模块**不依赖 three** —— 脏写入由调用方（three-renderer）用 applyLayerState 落到渲染对象上，
// 所以运行时可以纯 node 单测。
import { AnimRegistry, extractAnimFps } from './scene-anim.js';
import { createLayerStateTable, type LayerStateTable, type LayerWrite } from './layer-state.js';
import { SceneScriptVm } from './scene-script-vm.js';
import type { MediaThumbnailPayload, TextureAnimationHost } from './scene-script-vm.js';
import type { TimelineAnimationSource } from './scene-timeline.js';
import type { DynamicMeshRegistry } from './dynamic-mesh.js';
import type { MediaPropertiesPayload } from '../shared/media.js';
import type { ObjectScriptProperty } from '../shared/types.js';

export interface SceneScriptHostOptions {
  /** 必须按 scene.json 的 objects 顺序传入（脚本靠 shared 互通，顺序影响 init 期状态）。 */
  scripts: Array<{
    objectId: number;
    source: string;
    /** 对象脚本的 scene.json 覆盖值（createScriptProperties 注入；缺省用脚本内默认值）。 */
    scriptProperties?: Record<string, unknown>;
    /** 对象级属性脚本挂载的属性名（有则 update(value) 收/回 Vec3；visible.script 无）。 */
    property?: ObjectScriptProperty;
  }>;
  userProperties: Record<string, unknown>;
  onWarn?: (msg: string) => void;
  /** 动态网格注册表：透传给 VM，让 createModelData/createLayer/applyData 有真实落点。 */
  dynamicMesh?: DynamicMeshRegistry;
  /** engine.registerAsset 的回调（装载期收集材质资产路径，由调用方解析成 three 材质）。 */
  onAsset?: (materialPath: string) => void;
  /** 对象级脚本的纹理动画落点（thisLayer.getTextureAnimation → player 的精灵表控制）。 */
  textureAnimation?: TextureAnimationHost;
  /** engine.timeOfDay 的 0-1 时间源（缺省本地时钟）。 */
  timeOfDay?: () => number;
  /** 壁纸 id：脚本 localStorage 按壁纸隔离（`we:scenescript:<wallpaperId>:<key>`）。 */
  wallpaperId?: string;
  /** 时间线动画源（thisObject.getAnimation 优先查它；Task 10 由 renderer 传入）。 */
  timeline?: TimelineAnimationSource;
}

export class SceneScriptHost {
  private readonly anims: AnimRegistry;
  private readonly state: LayerStateTable;
  private readonly vm: SceneScriptVm | null;

  private constructor(anims: AnimRegistry, state: LayerStateTable, vm: SceneScriptVm | null) {
    this.anims = anims;
    this.state = state;
    this.vm = vm;
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
    if (scripts.length === 0) return new SceneScriptHost(anims, state, null);

    const vm = await SceneScriptVm.create({
      userProperties: opts.userProperties ?? {},
      state,
      anims,
      onWarn: opts.onWarn,
      dynamicMesh: opts.dynamicMesh,
      onAsset: opts.onAsset,
      textureAnimation: opts.textureAnimation,
      timeOfDay: opts.timeOfDay,
      wallpaperId: opts.wallpaperId,
      timeline: opts.timeline,
    });
    if (!vm) return null;
    for (const s of scripts) {
      vm.load(s.source, `obj ${s.objectId}`, s.objectId, s.scriptProperties, s.property);
    }
    vm.initAll();
    return new SceneScriptHost(anims, state, vm);
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
   *  返回本帧的脏写入（调用方应用后即丢弃）。
   *  只有「无 property 的对象脚本 + 布尔返回值」才是 visible 信号（属性脚本不参与）。 */
  tick(dt: number): Map<number, LayerWrite> {
    if (!this.vm) return new Map();
    this.vm.setFrametime(dt);
    this.anims.tick(dt);
    for (const r of this.vm.updateAll()) {
      if (r.property === null && r.objectId !== null && typeof r.value === 'boolean') {
        this.state.write(r.objectId, { visible: r.value });
      }
    }
    return this.state.takeDirty();
  }

  /** 派发一次点击（3798688689 的「切换按钮」靠它触发 shared.we2dSwitchScene）。 */
  click(): void {
    this.vm?.clickAll();
  }

  /** 媒体播放状态变化（0 stopped / 1 playing / 2 paused）。 */
  mediaPlayback(state: 'stopped' | 'playing' | 'paused'): void {
    this.vm?.dispatchMedia({
      event: 'mediaPlaybackChanged',
      playback: state === 'playing' ? 1 : state === 'paused' ? 2 : 0,
    });
  }

  /** 媒体集成开关（脚本据此隐藏/显示媒体层）。 */
  mediaStatus(enabled: boolean): void {
    this.vm?.dispatchMedia({ event: 'mediaStatusChanged', enabled });
  }

  /** 曲目元数据变化。 */
  mediaProperties(props: MediaPropertiesPayload): void {
    this.vm?.dispatchMedia({ event: 'mediaPropertiesChanged', properties: props });
  }

  /** 封面/配色变化。 */
  mediaThumbnail(thumb: MediaThumbnailPayload): void {
    this.vm?.dispatchMedia({ event: 'mediaThumbnailChanged', thumbnail: thumb });
  }

  /** 外部（媒体/文本通道）向状态表写入；脚本下一帧读到。 */
  applyExternal(writes: Map<number, LayerWrite>): void {
    for (const [id, patch] of writes) this.state.write(id, patch);
  }

  /** 读对象当前状态（副本）。 */
  read(objectId: number): LayerWrite {
    return this.state.read(objectId);
  }

  /** 取走并清空累计的脏写入。 */
  drainDirty(): Map<number, LayerWrite> {
    return this.state.takeDirty();
  }

  dispose(): void {
    this.vm?.dispose();
  }
}
