import type { LayerStateTable } from './layer-state.js';
import type { AnimRegistry } from './scene-anim.js';
export interface SceneScriptVmOptions {
    userProperties: Record<string, unknown>;
    state: LayerStateTable;
    anims: AnimRegistry;
    onWarn?: (msg: string) => void;
    /** 单次脚本调用的指令预算（缺省 50M）。测试可传小值，验证「预算每次调用都重置」。 */
    stepBudget?: number;
}
export declare class SceneScriptVm {
    private readonly ctx;
    private readonly runtime;
    private readonly handles;
    private readonly modules;
    private readonly animCache;
    private readonly state;
    private readonly anims;
    private readonly onWarn;
    private dt;
    /** 单次脚本调用的指令预算（缺省 STEP_BUDGET；callOne 每次调用前重置）。 */
    private readonly stepBudget;
    private budget;
    private constructor();
    /** 初始化 quickjs 并装好 prelude。失败返回 null（调用方退回"无脚本"路径，画面等于现状）。 */
    static create(opts: SceneScriptVmOptions): Promise<SceneScriptVm | null>;
    private keep;
    private warn;
    private installPrelude;
    /** prelude 的 key（`id:<scene对象id>` / `name:<名>` / `new:<名>`）→ scene 对象 id；非 id 形式返回 -1。 */
    private keyOf;
    private write;
    private anim;
    /** 装载一个模块脚本。返回 false = eval 失败（该脚本被跳过，其余继续）。
     *  `label` 用于日志（应带 scene 对象 id —— 脚本首行都是 `'use strict';`，不带 id 无法定位）。 */
    load(source: string, label?: string): boolean;
    private callOne;
    /** 每帧时间（供 engine.frametime）。必须在 updateAll 之前设置。 */
    setFrametime(dt: number): void;
    /** 按装载顺序调 applyUserProperties（一次）与 init。 */
    initAll(): void;
    /** 按装载顺序调 update（每帧）。 */
    updateAll(): void;
    /** 按装载顺序派发点击（cursorClick）。 */
    clickAll(): void;
    get loadedCount(): number;
    /** 仍可用的脚本数（抛错后被停用的不计）。 */
    get activeCount(): number;
    dispose(): void;
    /** 错误文本：quickjs 的 TypeError 只给 "not a function" 这类无主语 message，必须带 stack 才能定位。 */
    private errorText;
}
