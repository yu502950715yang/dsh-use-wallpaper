import { type LayerWrite } from './layer-state.js';
import type { DynamicMeshRegistry } from './dynamic-mesh.js';
export interface SceneScriptHostOptions {
    /** 必须按 scene.json 的 objects 顺序传入（脚本靠 shared 互通，顺序影响 init 期状态）。 */
    scripts: Array<{
        objectId: number;
        source: string;
    }>;
    userProperties: Record<string, unknown>;
    onWarn?: (msg: string) => void;
    /** 动态网格注册表：透传给 VM，让 createModelData/createLayer/applyData 有真实落点。 */
    dynamicMesh?: DynamicMeshRegistry;
    /** engine.registerAsset 的回调（装载期收集材质资产路径，由调用方解析成 three 材质）。 */
    onAsset?: (materialPath: string) => void;
}
export declare class SceneScriptHost {
    private readonly anims;
    private readonly state;
    private readonly vm;
    private constructor();
    /** 创建并装载。无脚本时返回一个"空 host"（tick 恒返回空表 = 画面等于现状）。
     *  quickjs 初始化失败返回 null（调用方同样退回现状）。 */
    static create(opts: SceneScriptHostOptions): Promise<SceneScriptHost | null>;
    /** 已装载的脚本数（eval 失败的不计）。 */
    get scriptCount(): number;
    /** 仍可用的脚本数（抛错后被停用的不计）。 */
    get activeCount(): number;
    /** 每帧调用：先推进动画播放器（脚本 advanceFrame 的时间源），再跑各脚本 update。
     *  返回本帧的脏写入（调用方应用后即丢弃）。 */
    tick(dt: number): Map<number, LayerWrite>;
    /** 派发一次点击（3798688689 的「切换按钮」靠它触发 shared.we2dSwitchScene）。 */
    click(): void;
    dispose(): void;
}
