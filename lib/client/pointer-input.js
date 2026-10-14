// 指针输入 → 归一化 [0,1]（y 向下，与 WE/OWE 的 pointer 约定一致；只采集不插值，插值在 parallax.advancePointer）。
// 幂等装/卸：HMR 重挂不得叠加监听（AGENT.md §5.43）。
import { POINTER_CENTER } from './parallax.js';
export function createPointerTracker(opts = {}) {
    const host = opts.target ?? (typeof window !== 'undefined' ? window : null);
    const viewport = opts.viewport ?? (() => ({
        width: typeof window === 'undefined' ? 0 : window.innerWidth || 0,
        height: typeof window === 'undefined' ? 0 : window.innerHeight || 0,
    }));
    let current = { ...POINTER_CENTER };
    let installed = false;
    const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
    const onMove = (ev) => {
        const e = ev;
        const { width, height } = viewport();
        if (!(width > 0) || !(height > 0))
            return;
        current = { x: clamp01(Number(e.clientX) / width), y: clamp01(Number(e.clientY) / height) };
    };
    return {
        install() {
            if (installed || !host)
                return;
            installed = true;
            host.addEventListener('pointermove', onMove, { passive: true });
        },
        dispose() {
            if (!installed || !host)
                return;
            installed = false;
            host.removeEventListener('pointermove', onMove);
            current = { ...POINTER_CENTER };
        },
        // 只读快照：每次移动/卸载换成一个**新对象**（不就地改写）⇒ 调用方持有的旧引用是那一刻的值，
        // 交给别处保存（如 player.setParallaxPointer）不会被后续事件改写；返回对象本身不得写入。
        target() { return current; },
    };
}
