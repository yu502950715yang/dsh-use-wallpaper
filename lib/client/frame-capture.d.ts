import * as THREE from 'three';
export interface FrameCapture {
    /** 该实例（一次壁纸装配周期）是否已有消费者：调用方据此决定走不走段渲染。 */
    readonly active: boolean;
    /** 段渲染目标（画布尺寸）。读取会构造 RT（有副作用），调用方应只在 active === true 时使用。 */
    readonly target: THREE.WebGLRenderTarget;
    /** 声明本帧有消费者（激活）；不建任何 GPU 资源。 */
    use(): void;
    /** 复位 active（不释放资源）。装配新壁纸（新的消费者集合）时必须调用，否则会永久走段渲染路径。 */
    reset(): void;
    /**
     * 每次调用都 copyFramebufferToTexture 拍一次，返回同一张纹理实例（内容被覆盖）。
     * 调用前须已把渲染目标绑到 target（本方法不切 target）；消费者不得跨帧持有该引用。
     */
    capture(): THREE.Texture;
    /**
     * 快照实例的代号：`resize()` 重建快照纹理 / `dispose()` 时自增。消费方（对象效果链的异步串行队列）
     * 在**执行当刻**读它，与**捕获当刻**记录的代号比较：不一致即说明手里那张已被 dispose，按「无快照」走。
     */
    readonly snapshotVersion: number;
    /** 同步 target 与快照尺寸；尺寸变化会重建快照纹理（FramebufferTexture 无 setSize），旧引用作废。 */
    resize(width: number, height: number): void;
    /** 释放两张资源且幂等；此后 use()/resize() 静默无效，capture()/target 抛错（调用方据此降级）。 */
    dispose(): void;
}
export declare function createFrameCapture(renderer: THREE.WebGLRenderer, deps?: {
    createTarget?: (w: number, h: number) => THREE.WebGLRenderTarget;
    createTexture?: (w: number, h: number) => THREE.Texture;
}): FrameCapture;
