// src/client/frame-capture.ts
// 帧内快照：把「到这一刻为止已绘制的内容」拷进一张纹理，供折射等消费者读。
// 语义 = WE 的 `_rt_FullFrameBuffer`（lwe CParticle.cpp:2069-2079 / CScene.cpp:351-361）。
import * as THREE from 'three';
// 显式写死非 sRGB 字节 RT 的参数：全链路 outputColorSpace = LinearSRGBColorSpace，
// 缺省值将来若变会让快照域与效果链不一致（显式化以防回归）。
const TARGET_OPTIONS = {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
    colorSpace: THREE.NoColorSpace,
};
export function createFrameCapture(renderer, deps = {}) {
    const buildTarget = deps.createTarget
        ?? ((w, h) => new THREE.WebGLRenderTarget(w, h, TARGET_OPTIONS));
    const buildTexture = deps.createTexture
        ?? ((w, h) => new THREE.FramebufferTexture(w, h));
    let active = false;
    let disposed = false;
    let hasSize = false;
    let width = 0;
    let height = 0;
    let target = null;
    let snapshot = null;
    // 快照实例代号：重建/释放快照时自增，供已排队的异步消费方判断自己手里那张是否已作废。
    let snapshotVersion = 0;
    /** 建资源前的兜底：0 尺寸的 RT/FramebufferTexture 非法（画布隐藏时 drawingBuffer 可能为 0）。 */
    function normalize(v) {
        return Number.isFinite(v) ? Math.max(1, Math.floor(v)) : 1;
    }
    /** 统一快照/段目标的采样参数：FramebufferTexture 构造写死 NearestFilter，必须显式覆盖。 */
    function applySnapshotParams(tex) {
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.generateMipmaps = false;
        tex.colorSpace = THREE.NoColorSpace;
    }
    /** 建 RT 并收口参数。 */
    function newTarget(w, h) {
        const rt = buildTarget(w, h);
        applySnapshotParams(rt.texture);
        return rt;
    }
    /** 建快照纹理并收口参数（注入的工厂同样受约束）。 */
    function newSnapshot(w, h) {
        const tex = buildTexture(w, h);
        applySnapshotParams(tex);
        return tex;
    }
    /** 惰性建资源：首次 capture()/读 target 时按已记录尺寸建；dispose 后调用抛错。 */
    function ensure() {
        if (disposed)
            throw new Error('[wallpaper-engine] FrameCapture 已 dispose');
        if (!hasSize) {
            const size = renderer.getDrawingBufferSize(new THREE.Vector2());
            width = normalize(size.x);
            height = normalize(size.y);
            hasSize = true;
        }
        if (target === null || snapshot === null) {
            target = newTarget(width, height);
            snapshot = newSnapshot(width, height);
        }
        return { target, snapshot };
    }
    function resize(w, h) {
        if (disposed)
            return;
        const nw = Math.floor(w);
        const nh = Math.floor(h);
        // 非法尺寸（非有限值/小于 1）不动资源（与 glow-stage 同策略）；Infinity 不得穿过。
        if (!Number.isFinite(nw) || !Number.isFinite(nh) || nw < 1 || nh < 1)
            return;
        if (hasSize && nw === width && nh === height)
            return;
        width = nw;
        height = nh;
        hasSize = true;
        if (target !== null && snapshot !== null) {
            target.setSize(nw, nh);
            snapshot.dispose();
            snapshot = newSnapshot(nw, nh);
            snapshotVersion++; // 旧引用作废（异步 update 可能仍握着它）
        }
    }
    function capture() {
        const res = ensure();
        // 每次调用都拍一次（每个消费者在自己的段边界各拍一次），内容覆盖进同一张纹理。
        // 不切 render target：copyFramebufferToTexture 拷的是**当前已绑定**的 framebuffer。
        renderer.copyFramebufferToTexture(res.snapshot);
        return res.snapshot;
    }
    function dispose() {
        if (disposed)
            return;
        disposed = true;
        active = false;
        target?.dispose();
        snapshot?.dispose();
        target = null;
        snapshot = null;
        snapshotVersion++;
    }
    /** 只复位 active，不释放资源（dispose 后调用静默无害）。 */
    function reset() {
        active = false;
    }
    return {
        get active() { return active; },
        get target() { return ensure().target; },
        get snapshotVersion() { return snapshotVersion; },
        use() { if (!disposed)
            active = true; },
        reset,
        capture,
        resize,
        dispose,
    };
}
