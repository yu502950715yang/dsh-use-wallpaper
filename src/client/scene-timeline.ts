// 时间线动画源（T6 只放接口壳；解析/求值与运行时由 Task 9/10 填充）。
// VM 的 thisObject.getAnimation(name) 先按对象+属性+动画名查本接口，未命中再回退 AnimRegistry。
import type { AnimPlayback } from './scene-anim.js';
import type {
  TimelineAnimation,
  TimelineKeyframe,
  TimelineKeyframeHandle,
  TimelineProperty,
} from '../shared/types.js';

export interface TimelineAnimationSource {
  /** 按对象 + 属性 + 动画名（'' = 当前属性绑定）取播放器；无 ⇒ null（调用方回退 AnimRegistry）。 */
  getByProperty(objectId: number, property: TimelineProperty, name: string): AnimPlayback | null;
  /** 按对象 + 动画 name 取播放器（thisLayer.getAnimation('Title')）。 */
  getByName(objectId: number, name: string): AnimPlayback | null;
}

// ── 时间线动画解析与求值（纯函数）：scene.json 的 { animation: { c0,c1,c2, options, relative } } 块 ──

const HANDLE_KEYS = ['c0', 'c1', 'c2'] as const;
const PROPERTY_CHANNELS: Record<TimelineProperty, number> = { alpha: 1, origin: 3, scale: 3, angles: 3, color: 3 };

// 帧号/值只收有限数或数字字符串；其余（缺失/null/布尔/非数字串）⇒ null。
function asNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
}

// 贝塞尔手柄：x/y 必须是有限数，enabled 必须显式为 true 才参与曲线；畸形 ⇒ undefined（按无手柄处理）。
function parseHandle(raw: unknown): TimelineKeyframeHandle | undefined {
  const o = asRecord(raw);
  if (!o) return undefined;
  const x = asNumber(o.x);
  const y = asNumber(o.y);
  if (x === null || y === null) return undefined;
  return { x, y, enabled: o.enabled === true };
}

// 单通道关键帧：任一帧非法 ⇒ 整通道 null；空数组同样 null。按 frame 升序（同帧保持原相对顺序）。
function parseKeyframes(raw: unknown): TimelineKeyframe[] | null {
  if (!Array.isArray(raw)) return null;
  const out: TimelineKeyframe[] = [];
  for (const item of raw) {
    const o = asRecord(item);
    if (!o) return null;
    const frame = asNumber(o.frame);
    const value = asNumber(o.value);
    if (frame === null || value === null) return null;
    const keyframe: TimelineKeyframe = { frame, value };
    const front = parseHandle(o.front);
    if (front) keyframe.front = front;
    const back = parseHandle(o.back);
    if (back) keyframe.back = back;
    out.push(keyframe);
  }
  if (out.length === 0) return null;
  out.sort((a, b) => a.frame - b.frame);
  return out;
}

// options 里的联动键：{ key: 'origin' } / [{ key: 'alpha' }]；非字符串/缺失 ⇒ ''。
function keyOf(raw: unknown): string {
  const o = asRecord(raw);
  return typeof o?.key === 'string' ? o.key : '';
}

export function parseTimelineAnimation(property: TimelineProperty, raw: unknown): TimelineAnimation | null {
  const o = asRecord(raw);
  if (!o) return null;
  const channels: TimelineKeyframe[][] = [];
  for (let i = 0; i < PROPERTY_CHANNELS[property]; i++) {
    const parsed = parseKeyframes(o[HANDLE_KEYS[i]!]);
    if (!parsed) {
      // c0 缺失/空 ⇒ 该属性不走时间线（回退静态 value）；i>0 缺通道 ⇒ 空数组（采样按 0 偏移）。
      if (i === 0) return null;
      channels.push([]);
      continue;
    }
    channels.push(parsed);
  }
  const options = asRecord(o.options) ?? {};
  const fpsRaw = asNumber(options.fps);
  const fps = fpsRaw !== null && fpsRaw > 0 ? fpsRaw : 60;
  const lengthRaw = asNumber(options.length);
  const frameCount = lengthRaw !== null && lengthRaw > 0 ? Math.floor(lengthRaw) : 60;
  const modeRaw = options.mode;
  const mode: TimelineAnimation['mode'] = modeRaw === 'loop' || modeRaw === 'mirror' ? modeRaw : 'single';
  const parentKey = keyOf(options.parent);
  const children = Array.isArray(options.children) ? options.children.map(keyOf).filter(Boolean) : [];
  return {
    property,
    channels,
    fps,
    frameCount,
    duration: frameCount / fps,
    mode,
    startPaused: options.startpaused === true,
    relative: o.relative === true,
    wrapLoop: options.wraploop === true,
    name: typeof options.name === 'string' ? options.name : '',
    parentKey: (parentKey || null) as TimelineProperty | null,
    childrenKeys: children as TimelineProperty[],
  };
}

function bezier(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

// handle 的 x/y 归一化到段长/值差；非有限值（畸形数据）按 0（无偏移）处理。
function handleCoord(handle: TimelineKeyframeHandle | undefined, axis: 'x' | 'y'): number {
  const v = handle?.[axis];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// 单通道采样：端点精确；区间外钳制；段内 handles 两关 ⇒ 线性，否则三次贝塞尔（x(t)=frame 二分 24 次）。
export function sampleTimelineChannel(channel: TimelineKeyframe[], frame: number): number {
  if (channel.length === 0) return 0;
  if (channel.length === 1) return channel[0]!.value;
  const first = channel[0]!;
  if (frame <= first.frame) return first.value;
  const last = channel[channel.length - 1]!;
  if (frame >= last.frame) return last.value;
  let i = 0;
  while (i + 1 < channel.length && channel[i + 1]!.frame <= frame) i += 1;
  const a = channel[i]!;
  if (frame === a.frame) return a.value; // 中间关键帧也精确（避免贝塞尔求根的浮点误差）
  const b = channel[i + 1]!;
  const span = b.frame - a.frame;
  if (span <= 0) return b.value;
  const tFrame = (frame - a.frame) / span;
  const frontOn = a.front?.enabled === true;
  const backOn = b.back?.enabled === true;
  if (!frontOn && !backOn) return a.value + (b.value - a.value) * tFrame;
  // 手柄偏移量 = 归一化坐标 × 段长/值差；段起点用 front（出向），段终点用 back（入向）。
  const valueSpan = b.value - a.value;
  const c1x = a.frame + (frontOn ? handleCoord(a.front, 'x') : 0) * span;
  const c1y = a.value + (frontOn ? handleCoord(a.front, 'y') : 0) * valueSpan;
  const c2x = b.frame + (backOn ? handleCoord(b.back, 'x') : 0) * span;
  const c2y = b.value + (backOn ? handleCoord(b.back, 'y') : 0) * valueSpan;
  let lo = 0;
  let hi = 1;
  for (let n = 0; n < 24; n++) {
    const mid = (lo + hi) / 2;
    if (bezier(a.frame, c1x, c2x, b.frame, mid) < frame) lo = mid;
    else hi = mid;
  }
  return bezier(a.value, c1y, c2y, b.value, (lo + hi) / 2);
}

/** 逐通道采样；空通道（缺 c1/c2）给 0 偏移。 */
export function sampleTimeline(anim: TimelineAnimation, frame: number): number[] {
  return anim.channels.map((channel) => sampleTimelineChannel(channel, frame));
}
