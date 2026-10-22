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
 * 每帧向目标位置线性靠近（OWE UniformSource.cpp:249-274）：delay=0 立即跟随；delay>0 每帧按 min(dt, delay)/delay 靠近。
 * 滞后时钟按「本帧」取、不得跨帧累积（OWE 的减/加同帧抵消，推导与理由见 AGENT.md §5.47）。
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

/**
 * 效果 shader 全局 uniform（F18）：pointerPosition = 原始指针（y 向下）；
 * parallaxPosition = 0.5 + 中心化视差指针 × mouseinfluence（y 翻到向上，关视差 → 中性 0.5）。
 * `parallaxPointer` 传插值后的跟随值（player.parallaxPointer()），缺省用原始指针。
 */
export function effectPointerUniforms(
  pointer: PointerState,
  cfg: ParallaxConfig,
  parallaxPointer: PointerState = pointer,
): { pointerPosition: [number, number]; parallaxPosition: [number, number] } {
  const pointerPosition: [number, number] = [pointer.x, pointer.y];
  if (!cfg.enabled) return { pointerPosition, parallaxPosition: [0.5, 0.5] };
  const mi = cfg.mouseInfluence;
  return {
    pointerPosition,
    parallaxPosition: [
      0.5 + (parallaxPointer.x - 0.5) * mi,
      0.5 + (0.5 - parallaxPointer.y) * mi,
    ],
  };
}
