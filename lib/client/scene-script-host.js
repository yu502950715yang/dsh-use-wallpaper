// src/client/scene-script-host.ts
//
// SceneScript 的编排层：装载期建 fps 表与 VM；帧内「推进动画 → 各脚本 update → 交出脏写入」。
// 本模块**不依赖 three** —— 脏写入由调用方（three-renderer）用 applyLayerState 落到渲染对象上，
// 所以运行时可以纯 node 单测。
import { AnimRegistry, extractAnimFps } from './scene-anim.js';
import { createLayerStateTable } from './layer-state.js';
import { SceneScriptVm } from './scene-script-vm.js';
export class SceneScriptHost {
    anims;
    state;
    vm;
    constructor(anims, state, vm) {
        this.anims = anims;
        this.state = state;
        this.vm = vm;
    }
    /** 创建并装载。无脚本时返回一个"空 host"（tick 恒返回空表 = 画面等于现状）。
     *  quickjs 初始化失败返回 null（调用方同样退回现状）。 */
    static async create(opts) {
        const scripts = (opts.scripts ?? []).filter((s) => typeof s?.source === 'string' && s.source.length > 0);
        // fps 表：scene.pkg 内没有动画数据，唯一来源是脚本内嵌 config 的 "name":…,"fps":N
        const fpsTable = new Map();
        for (const s of scripts) {
            for (const [name, fps] of extractAnimFps(s.source)) {
                if (!fpsTable.has(name))
                    fpsTable.set(name, fps);
            }
        }
        const anims = new AnimRegistry(fpsTable);
        const state = createLayerStateTable();
        if (scripts.length === 0)
            return new SceneScriptHost(anims, state, null);
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
        if (!vm)
            return null;
        for (const s of scripts) {
            vm.load(s.source, `obj ${s.objectId}`, s.objectId, s.scriptProperties, s.property);
        }
        vm.initAll();
        return new SceneScriptHost(anims, state, vm);
    }
    /** 已装载的脚本数（eval 失败的不计）。 */
    get scriptCount() {
        return this.vm?.loadedCount ?? 0;
    }
    /** 仍可用的脚本数（抛错后被停用的不计）。 */
    get activeCount() {
        return this.vm?.activeCount ?? 0;
    }
    /** 每帧调用：先推进动画播放器（脚本 advanceFrame 的时间源），再跑各脚本 update。
     *  返回本帧的脏写入（调用方应用后即丢弃）。
     *  只有「无 property 的对象脚本 + 布尔返回值」才是 visible 信号（属性脚本不参与）。 */
    tick(dt) {
        if (!this.vm)
            return new Map();
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
    click() {
        this.vm?.clickAll();
    }
    /** 媒体播放状态变化（0 stopped / 1 playing / 2 paused）。 */
    mediaPlayback(state) {
        this.vm?.dispatchMedia({
            event: 'mediaPlaybackChanged',
            playback: state === 'playing' ? 1 : state === 'paused' ? 2 : 0,
        });
    }
    /** 媒体集成开关（脚本据此隐藏/显示媒体层）。 */
    mediaStatus(enabled) {
        this.vm?.dispatchMedia({ event: 'mediaStatusChanged', enabled });
    }
    /** 曲目元数据变化。 */
    mediaProperties(props) {
        this.vm?.dispatchMedia({ event: 'mediaPropertiesChanged', properties: props });
    }
    /** 封面/配色变化。 */
    mediaThumbnail(thumb) {
        this.vm?.dispatchMedia({ event: 'mediaThumbnailChanged', thumbnail: thumb });
    }
    /** 外部（媒体/文本通道）向状态表写入；脚本下一帧读到。 */
    applyExternal(writes) {
        for (const [id, patch] of writes)
            this.state.write(id, patch);
    }
    /** 读对象当前状态（副本）。 */
    read(objectId) {
        return this.state.read(objectId);
    }
    /** 取走并清空累计的脏写入。 */
    drainDirty() {
        return this.state.takeDirty();
    }
    dispose() {
        this.vm?.dispose();
    }
}
