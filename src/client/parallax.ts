// WE 相机视差的纯数学层（公式与缺省值取自 OWE UniformSource.cpp:399-415，见
// research/audit-parallax-mechanism.md §1/§3/§5）：视差是**对象 model 矩阵的 2D 平移**，相机不动。
// 与 three 解耦（只算数字），便于 node 单测；应用点在 threejs-player 的 tickParallax。
import type { ParallaxConfig } from '../shared/types.js';

export type { ParallaxConfig };

/** OWE 解析器缺省：cameraparallax=false / amount=0 / delay=0 / mouseinfluence=0。 */
export const DEFAULT_PARALLAX: ParallaxConfig = { enabled: false, amount: 0, delay: 0, mouseInfluence: 0 };

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

/** 读 scene.json 的 general.cameraparallax* 四字段（非对象/畸形一律回落缺省，不误开视差）。 */
export function readParallaxConfig(gen: unknown): ParallaxConfig {
  if (typeof gen !== 'object' || gen === null) return { ...DEFAULT_PARALLAX };
  const g = gen as Record<string, unknown>;
  return {
    enabled: g.cameraparallax === true,
    amount: num(g.cameraparallaxamount, 0),
    delay: num(g.cameraparallaxdelay, 0),
    mouseInfluence: num(g.cameraparallaxmouseinfluence, 0),
  };
}

/** 归一化指针（[0,1]，y 向下 = 屏幕约定；缺省居中）。 */
export interface PointerState { x: number; y: number }
export const POINTER_CENTER: PointerState = { x: 0.5, y: 0.5 };

/** 指针跟随状态：`value` = 当前插值位置；`elapsed` = **本帧**的滞后时钟（见 advancePointer）。 */
export interface PointerFollow { value: PointerState; elapsed: number }

/**
 * 每帧向目标位置线性靠近（OWE UniformSource.cpp:249-274）：delay=0 立即跟随；delay>0 时每帧按
 * `min(dt, delay) / delay` 靠近（时间常数 ≈ delay 的一阶平滑，滞后感**每次**移动都在）。
 *
 * ⚠️ 与 OWE 字面写法的唯一偏离：OWE 每帧先 `SetPointerInput`（滞后时钟减去已流逝时间）再 `Advance`
 * （加回同一个 `frame.delta`），两者在同一帧内抵消 ⇒ `elapsed` 只剩「历史最大帧长」（`max(0,e−dt)+dt = e`）。
 * 本播放器 dt 被 clamp 到 0.1s，而本机唯一开视差壁纸的 delay 恰好是 0.1 ⇒ 一次长帧（切走标签页再切回）
 * 就会把 amount 永久打成 1、平滑消失。故这里每帧直接取 `min(dt, delay)`：稳态比例与 OWE 相同、不残留历史。
 */
export function advancePointer(
  follow: PointerFollow,
  target: PointerState,
  cfg: ParallaxConfig,
  dt: number,
): PointerFollow {
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
export function parallaxShift(o: {
  pointer: PointerState;
  orthoW: number;
  orthoH: number;
  nodeX: number;
  nodeY: number;
  camX: number;
  camY: number;
  depth: [number, number];
  cfg: ParallaxConfig;
}): [number, number] {
  if (!o.cfg.enabled) return [0, 0];
  if (o.depth[0] === 0 && o.depth[1] === 0) return [0, 0];
  const mouseX = (0.5 - o.pointer.x) * o.orthoW * o.cfg.mouseInfluence;
  const mouseY = (o.pointer.y - 0.5) * o.orthoH * o.cfg.mouseInfluence;
  // -0 归一：零轴（0 × 负数）与 amount=0 都会产出 IEEE-754 的 -0，让下游 `toEqual` 式精确断言假失败。
  const nz = (v: number) => (v === 0 ? 0 : v);
  return [
    nz(o.depth[0] * o.cfg.amount * (o.nodeX - o.camX + mouseX)),
    nz(o.depth[1] * o.cfg.amount * (o.nodeY - o.camY + mouseY)),
  ];
}
