// web 壁纸的指针直传桥（AGENT.md §5.48）：背景层 pointer-events:none ⇒ 鼠标进不了 iframe，
// 视差类 web 壁纸恒为静态；由宿主把指针坐标 postMessage 进去、iframe 内 shim 合成 mousemove。
//
// 从 background-layer 闭包里抽出（审查 P1）：原实现每次 attach 都 addEventListener 且不摘旧监听，
// resize 重建会累积（旧闭包含旧 iframe）。现在 attach 前先摘旧监听，且本类可独立单测。
import { computePointerPost } from './pointer-post.js';
export class PointerPostBridge {
    token = 0;
    fn = null;
    target = null;
    /** 挂到可见帧；重复 attach（resize 重建）前先摘旧监听。 */
    attach(frame) {
        if (this.fn) {
            window.removeEventListener('pointermove', this.fn, true);
            this.fn = null;
        }
        this.token += 1;
        const token = this.token;
        this.target = frame.contentWindow;
        const onMove = (ev) => {
            const fwin = frame.contentWindow;
            // token 变 / 帧已换（resize 重建）/ 帧已摘除（预载用的隐藏帧）/ 窗口不可达 ⇒ 丢弃，不往错的帧发坐标。
            if (token !== this.token || !fwin || fwin !== this.target || !frame.isConnected)
                return;
            const payload = computePointerPost(ev, frame.getBoundingClientRect(), 1);
            if (!payload)
                return;
            try {
                fwin.postMessage(payload, '*');
            }
            catch { /* 帧已卸载：忽略 */ }
        };
        this.fn = onMove;
        window.addEventListener('pointermove', onMove, { capture: true, passive: true });
    }
    /** 卸载：摘监听并作废在途 token（幂等）。 */
    detach() {
        this.token += 1;
        if (this.fn)
            window.removeEventListener('pointermove', this.fn, true);
        this.fn = null;
        this.target = null;
    }
}
