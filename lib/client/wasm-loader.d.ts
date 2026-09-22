export interface WasmSceneModule {
    default(moduleOrPath?: string | URL | Request): Promise<unknown>;
}
export type LoadWasm = () => Promise<WasmSceneModule | null>;
export declare function defaultLoadWasm(): Promise<WasmSceneModule | null>;
