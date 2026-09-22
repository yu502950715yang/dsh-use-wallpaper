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
        });
        if (!vm)
            return null;
        for (const s of scripts)
            vm.load(s.source, `obj ${s.objectId}`);
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
     *  返回本帧的脏写入（调用方应用后即丢弃）。 */
    tick(dt) {
        if (!this.vm)
            return new Map();
        this.vm.setFrametime(dt);
        this.anims.tick(dt);
        this.vm.updateAll();
        return this.state.takeDirty();
    }
    /** 派发一次点击（3798688689 的「切换按钮」靠它触发 shared.we2dSwitchScene）。 */
    click() {
        this.vm?.clickAll();
    }
    dispose() {
        this.vm?.dispose();
    }
}
