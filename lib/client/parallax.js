/** OWE 解析器缺省：cameraparallax=false / amount=0 / delay=0 / mouseinfluence=0。 */
export const DEFAULT_PARALLAX = { enabled: false, amount: 0, delay: 0, mouseInfluence: 0 };
function num(v, fallback) {
    const n = typeof v === 'string' ? Number(v) : v;
    return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}
/** 读 scene.json 的 general.cameraparallax* 四字段（非对象/畸形一律回落缺省，不误开视差）。 */
export function readParallaxConfig(gen) {
    if (typeof gen !== 'object' || gen === null)
        return { ...DEFAULT_PARALLAX };
    const g = gen;
    return {
        enabled: g.cameraparallax === true,
        amount: num(g.cameraparallaxamount, 0),
        delay: num(g.cameraparallaxdelay, 0),
        mouseInfluence: num(g.cameraparallaxmouseinfluence, 0),
    };
}
export const POINTER_CENTER = { x: 0.5, y: 0.5 };
/**
 * 每帧向目标位置线性靠近（OWE UniformSource.cpp:249-274）：delay=0 立即跟随；delay>0 时每帧按
 * `min(dt, delay) / delay` 靠近（时间常数 ≈ delay 的一阶平滑，滞后感**每次**移动都在）。
 *
 * ⚠️ 与 OWE 字面写法的唯一偏离：OWE 每帧先 `SetPointerInput`（滞后时钟减去已流逝时间）再 `Advance`
 * （加回同一个 `frame.delta`），两者在同一帧内抵消 ⇒ `elapsed` 只剩「历史最大帧长」（`max(0,e−dt)+dt = e`）。
 * 本播放器 dt 被 clamp 到 0.1s，而本机唯一开视差壁纸的 delay 恰好是 0.1 ⇒ 一次长帧（切走标签页再切回）
 * 就会把 amount 永久打成 1、平滑消失。故这里每帧直接取 `min(dt, delay)`：稳态比例与 OWE 相同、不残留历史。
 */
export function advancePointer(follow, target, cfg, dt) {
    const delay = Math.max(0, cfg.delay);
    const elapsed = Math.min(Math.max(0, dt), delay);
    const amount = delay > 0 ? elapsed / delay : 1;
    return {
        elapsed,
        value: {
            x: follow.value.x + (target.x - follow.value.x) * amount,
            y: follow.value.y + (target.y - follow.value.y) * amount,
        },
    };
}
/**
 * 逐对象 2D 平移（世界/场景单位）：
 *   mouse_x = (0.5 − px) × W × mi        mouse_y = (py − 0.5) × H × mi
 *   shift   = depth ⊙ ((node − cam) + mouse) × amount
 * cam 在 three 坐标下是 (0,0)（we_to_three 把场景中心移到原点），node 传 three 坐标。
 */
export function parallaxShift(o) {
    if (!o.cfg.enabled)
        return [0, 0];
    if (o.depth[0] === 0 && o.depth[1] === 0)
        return [0, 0];
    const mouseX = (0.5 - o.pointer.x) * o.orthoW * o.cfg.mouseInfluence;
    const mouseY = (o.pointer.y - 0.5) * o.orthoH * o.cfg.mouseInfluence;
    // -0 归一：零轴（0 × 负数）与 amount=0 都会产出 IEEE-754 的 -0，让下游 `toEqual` 式精确断言假失败。
    const nz = (v) => (v === 0 ? 0 : v);
    return [
        nz(o.depth[0] * o.cfg.amount * (o.nodeX - o.camX + mouseX)),
        nz(o.depth[1] * o.cfg.amount * (o.nodeY - o.camY + mouseY)),
    ];
}
