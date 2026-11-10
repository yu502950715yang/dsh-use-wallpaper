interface RendererLike {
    getContext(): unknown;
    domElement?: {
        width?: number;
        height?: number;
    };
}
export declare class FrameCaptureRuntime {
    private readonly renderer;
    private pending;
    constructor(renderer: RendererLike);
    /**
     * 请求下一帧的 PNG（null = 不支持/失败）。必须与 render() 在同一任务内读像素，
     * 故这里只登记请求、由 render() 末尾调用 flush()。
     */
    nextFrame(): Promise<Uint8Array | null>;
    flush(): void;
    /** 释放：未决请求作废（否则 Promise 永不 settle）。 */
    dispose(): void;
}
export {};
