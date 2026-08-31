export interface ScriptObjectState {
    origin: {
        x: number;
        y: number;
        z: number;
    };
    scale: {
        x: number;
        y: number;
        z: number;
    };
    alpha: number;
    image: {
        alpha: number;
        brightness: number;
    };
}
export interface ScriptReadback {
    origin?: {
        x: number;
        y: number;
        z: number;
    };
    scale?: {
        x: number;
        y: number;
        z: number;
    };
    imageAlpha?: number;
    imageBrightness?: number;
}
export declare function buildInitialObjectState(origin: [number, number, number], scale: [number, number, number], alpha: number, brightness: number): ScriptObjectState;
export declare function normalizeReadback(raw: {
    origin?: {
        x: number;
        y: number;
        z: number;
    };
    scale?: {
        x: number;
        y: number;
        z: number;
    };
    imageAlpha?: number;
    imageBrightness?: number;
}): ScriptReadback;
export interface BoundScript {
    update(dt: number): ScriptReadback | null;
}
export declare class SceneScriptRuntime {
    private ctx;
    private runtime;
    private bounds;
    private constructor();
    /** 初始化（异步：quickjs wasm 懒加载）。失败返回 null，调用方退化无动画路径。 */
    static create(): Promise<SceneScriptRuntime | null>;
    /** 为一个对象绑定脚本。initial 来自 scene.json 解析值。返回 null = 脚本不可用（静态渲染）。 */
    bind(script: string, initial: {
        origin: [number, number, number];
        scale: [number, number, number];
        alpha: number;
        brightness: number;
    }): BoundScript | null;
    /** 每帧对单个绑定做 update + 读回。脚本抛错返回 null（隔离，不抛给宿主）。
     *  Finding 3：对比 committed（上次已提交基线），仅输出真正变化的字段——
     *  未变化字段省略（wasm-renderer 的 update_image 收到 undefined = 保持现状）。 */
    private runUpdate;
    /** 对每个绑定调用 update（Task 5 的 wasm-renderer 逐对象调 BoundScript.update，此方法可选）。
     *  Finding 3：与 per-binding update 共享同一 committed 基线，逐帧只输出变化字段。 */
    tick(dt: number): void;
    dispose(): void;
    /** 释放宿主构造的 this 对象图（嵌套 origin/scale/image + thisObj）。 */
    private disposeObjectGraph;
}
