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
 * 每帧向目标位置线性靠近（OWE UniformSource.cpp:249-274）：delay=0 立即跟随；delay>0 每帧按 min(dt, delay)/delay 靠近。
 * 滞后时钟按「本帧」取、不得跨帧累积（OWE 的减/加同帧抵消，推导与理由见 AGENT.md §5.47）。
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
/** 效果 shader 全局 uniform（F18）：pointerPosition = 原始指针（y 向下）；
 *  parallaxPosition = 0.5 + 中心化视差 × mouseinfluence（y 向上，关视差 = 中性 0.5）；第三参缺省用原始指针。 */
export function effectPointerUniforms(pointer, cfg, parallaxPointer = pointer) {
    const pointerPosition = [pointer.x, pointer.y];
    if (!cfg.enabled)
        return { pointerPosition, parallaxPosition: [0.5, 0.5] };
    const mi = cfg.mouseInfluence;
    return {
        pointerPosition,
        parallaxPosition: [
            0.5 + (parallaxPointer.x - 0.5) * mi,
            0.5 + (0.5 - parallaxPointer.y) * mi,
        ],
    };
}
