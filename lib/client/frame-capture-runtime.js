// 单帧抓取运行时（阶段 3 切片）：从 ThreeScenePlayer 拆出的 readPixels 路径（审查 P0-9）。
// 只负责「登记请求 → render() 末尾同一任务内读像素 → resolve PNG」；帧内快照（FrameCapture 状态机）
// 与段渲染仍属渲染管线，留在 player。
import { readPixelsToPng } from './frame-export.js';
export class FrameCaptureRuntime {
    renderer;
    pending = null;
    constructor(renderer) {
        this.renderer = renderer;
    }
    /**
     * 请求下一帧的 PNG（null = 不支持/失败）。必须与 render() 在同一任务内读像素，
     * 故这里只登记请求、由 render() 末尾调用 flush()。
     */
    nextFrame() {
        if (this.pending)
            return Promise.resolve(null);
        return new Promise((resolve) => { this.pending = resolve; });
    }
    // render() 末尾调用：读像素/编码的失败只 warn 并 resolve(null)，绝不把异常抛进帧循环。
    flush() {
        const resolve = this.pending;
        if (!resolve)
            return;
        this.pending = null;
        try {
            const gl = this.renderer.getContext();
            // 上下文已丢失时 readPixels 只会读回全零（没有异常），会把「黑帧」写进首帧缓存 ⇒ 直接跳过。
            if (typeof gl.isContextLost === 'function' && gl.isContextLost()) {
                console.warn('[three] scene 抓帧失败（WebGL 上下文已丢失），已跳过首帧缓存');
                resolve(null);
                return;
            }
            const dom = this.renderer.domElement;
            // 画布缓冲尺寸优先取 GL 的 drawingBuffer*（= 实际可读像素区），mock/异常环境退回 domElement。
            const width = Math.floor(gl.drawingBufferWidth || dom?.width || 0);
            const height = Math.floor(gl.drawingBufferHeight || dom?.height || 0);
            void readPixelsToPng(gl, width, height).then((png) => {
                if (!png)
                    console.warn('[three] scene 抓帧失败（读像素/编码不可用），已跳过首帧缓存');
                resolve(png);
            });
        }
        catch (e) {
            console.warn('[three] scene 抓帧失败（已跳过首帧缓存）:', e instanceof Error ? e.message : String(e));
            resolve(null);
        }
    }
    /** 释放：未决请求作废（否则 Promise 永不 settle）。 */
    dispose() {
        this.pending?.(null);
        this.pending = null;
    }
}
