import { describe, expect, it } from 'vitest';
import type { SceneDescription, TimelineAnimation, TimelineKeyframe, TimelineKeyframeHandle } from '../src/shared/types.js';
import type { LayerWrite } from '../src/client/layer-state.js';
import { parseSceneJson } from '../src/client/scene-json.js';
import { SceneScriptHost } from '../src/client/scene-script-host.js';
import {
  createTimelineRuntime, parseTimelineAnimation, sampleTimeline, sampleTimelineChannel,
  type TimelineRuntime,
} from '../src/client/scene-timeline.js';

const handle = (x: number, y: number, enabled = false): TimelineKeyframeHandle => ({ x, y, enabled });
const kf = (
  frame: number,
  value: number,
  opts: Partial<Pick<TimelineKeyframe, 'front' | 'back'>> = {},
): TimelineKeyframe => ({ frame, value, front: handle(0, 0), back: handle(0, 0), ...opts });
const anim = (
  channels: Record<string, unknown>,
  options: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  ...channels,
  options: { fps: 60, length: 60, mode: 'single', ...options },
  ...extra,
});

describe('parseTimelineAnimation', () => {
  it('解析三通道/选项/relative/父子/名称', () => {
    const raw = anim(
      { c0: [kf(0, 0)], c1: [kf(0, -0.25), kf(30, 0)], c2: [kf(0, 0)] },
      {
        mode: 'loop', startpaused: true, name: 'Title',
        parent: { key: 'origin' }, children: [{ key: 'alpha' }], wraploop: true,
      },
      { relative: true },
    );
    const a = parseTimelineAnimation('scale', raw)!;
    expect(a).toMatchObject({
      property: 'scale', fps: 60, frameCount: 60, duration: 1, mode: 'loop',
      startPaused: true, relative: true, wrapLoop: true, name: 'Title',
      parentKey: 'origin', childrenKeys: ['alpha'],
    });
    expect(a.channels).toHaveLength(3);
    expect(a.channels[1]![1]).toMatchObject({ frame: 30, value: 0 });
  });

  it('alpha 只有 c0；缺 options 用缺省；坏数据 ⇒ null', () => {
    expect(parseTimelineAnimation('alpha', { c0: [kf(0, 0.2)] })?.channels).toHaveLength(1);
    expect(parseTimelineAnimation('alpha', {})).toBeNull();
    expect(parseTimelineAnimation('alpha', { c0: [] })).toBeNull();
  });

  it('缺省值：fps=60/length=60/single/无名称/无父子/非 relative', () => {
    const a = parseTimelineAnimation('alpha', { c0: [kf(0, 1)] })!;
    expect(a).toMatchObject({
      fps: 60, frameCount: 60, duration: 1, mode: 'single',
      startPaused: false, relative: false, wrapLoop: false,
      name: '', parentKey: null, childrenKeys: [],
    });
  });

  it('relative 只认 animation 根（options 内不算）；mode 非法回退 single；fps/length 非法回退', () => {
    const base = { c0: [kf(0, 0)], c1: [kf(0, 0)], c2: [kf(0, 0)] };
    const rel = parseTimelineAnimation('origin', { ...base, options: { relative: true } })!;
    expect(rel.relative).toBe(false);
    expect(parseTimelineAnimation('origin', { ...base, options: { mode: 'bounce' } })!.mode).toBe('single');
    expect(parseTimelineAnimation('origin', { ...base, options: { mode: 'mirror' } })!.mode).toBe('mirror');
    expect(parseTimelineAnimation('origin', { ...base, options: { fps: 0, length: -3 } }))
      .toMatchObject({ fps: 60, frameCount: 60 });
    expect(parseTimelineAnimation('origin', { ...base, options: { fps: '30', length: '150' } }))
      .toMatchObject({ fps: 30, frameCount: 150, duration: 5 });
  });

  it('关键帧按 frame 升序；i>0 通道缺失/畸形 ⇒ 空数组；c0 坏 ⇒ null', () => {
    const sorted = parseTimelineAnimation('scale', anim({
      c0: [kf(20, 2), kf(0, 0), kf(10, 1)], c2: [kf(0, 3)],
    }))!;
    expect(sorted.channels[0]!.map((k) => k.frame)).toEqual([0, 10, 20]);
    expect(sorted.channels[1]).toEqual([]);
    expect(parseTimelineAnimation('scale', { c0: [kf(0, 0)], c1: [{ frame: 'x' }], c2: [kf(0, 0)] })!.channels[1])
      .toEqual([]);
    expect(parseTimelineAnimation('alpha', { c0: [{ frame: 0 }] })).toBeNull();
    expect(parseTimelineAnimation('alpha', { c0: 'nope' })).toBeNull();
    expect(parseTimelineAnimation('alpha', [])).toBeNull();
  });

  it('真实素材形态（3797976859 的 scale/alpha 块，去脚本只留数值）', () => {
    const h = (x: number) => ({ enabled: true, magic: true, x, y: 0 });
    const scale = parseTimelineAnimation('scale', {
      c0: [
        { frame: 0, value: 0, front: h(1), back: h(-0.625), lockangle: true, locklength: true },
        { frame: 30, value: 0, front: h(0.625), back: h(-1), lockangle: true, locklength: true },
      ],
      c1: [
        { frame: 0, value: -0.25, front: h(1), back: h(-0.625) },
        { frame: 30, value: 0, front: h(0.625), back: h(-1) },
      ],
      c2: [
        { frame: 0, value: -0.25, front: h(1), back: h(-0.625) },
        { frame: 30, value: 0, front: h(0.625), back: h(-1) },
      ],
      options: { fps: 30, length: 150, mode: 'single', smoothing: null, stiffness: null, wraploop: null },
      relative: true,
    })!;
    expect(scale).toMatchObject({ fps: 30, frameCount: 150, duration: 5, relative: true });
    expect(scale.channels.map((c) => c.map((k) => k.frame))).toEqual([[0, 30], [0, 30], [0, 30]]);
    expect(sampleTimeline(scale, 0)).toEqual([0, -0.25, -0.25]);
    expect(sampleTimeline(scale, 30)).toEqual([0, 0, 0]);

    const alpha = parseTimelineAnimation('alpha', {
      c0: [{ frame: 0, value: 0 }, { frame: 1, value: 0.5 }],
      options: { fps: 60, length: 60, mode: 'single', startpaused: true, wraploop: null },
    })!;
    expect(alpha).toMatchObject({ startPaused: true, channels: expect.any(Array) });
    expect(sampleTimeline(alpha, 0)).toEqual([0]);
    expect(sampleTimeline(alpha, 1)).toEqual([0.5]);
  });
});

describe('sampleTimelineChannel', () => {
  it('端点精确；线性段中点 = 两关键帧均值（handles 关闭）', () => {
    const ch = [kf(0, 0), kf(10, 100)];
    expect(sampleTimelineChannel(ch, 0)).toBe(0);
    expect(sampleTimelineChannel(ch, 10)).toBe(100);
    expect(sampleTimelineChannel(ch, 5)).toBeCloseTo(50, 1);
    // 中间关键帧也精确（不在首/末位置）
    const mid = [kf(0, 0), kf(10, 100), kf(20, 50)];
    expect(sampleTimelineChannel(mid, 10)).toBe(100);
    expect(sampleTimelineChannel(mid, 15)).toBeCloseTo(75, 1);
  });

  it('段前后按端点值钳制；单关键帧恒定；空通道 ⇒ 0', () => {
    const ch = [kf(5, 7), kf(10, 9)];
    expect(sampleTimelineChannel(ch, 0)).toBe(7);
    expect(sampleTimelineChannel(ch, 99)).toBe(9);
    expect(sampleTimelineChannel([kf(3, 4.5)], 100)).toBe(4.5);
    expect(sampleTimelineChannel([], 1)).toBe(0);
  });

  it('曲线段（front/back enabled）单调落在两端值之间', () => {
    const ch = [
      kf(0, 0, { front: { enabled: true, x: 1, y: 0 } }),
      kf(10, 100, { back: { enabled: true, x: -1, y: 0 } }),
    ];
    const mid = sampleTimelineChannel(ch, 5);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(100);
  });

  it('对称 ease handles：中点 ≈ 均值，段前段后偏离线性（曲线生效）', () => {
    const ch = [
      kf(5, 0, { front: { enabled: true, x: 1, y: 0 } }),
      kf(35, 1, { back: { enabled: true, x: -1, y: 0 } }),
    ];
    expect(sampleTimelineChannel(ch, 20)).toBeCloseTo(0.5, 3);
    expect(sampleTimelineChannel(ch, 10)).toBeLessThan((10 - 5) / 30);
    expect(sampleTimelineChannel(ch, 30)).toBeGreaterThan(0.5);
  });

  it('低价值边界：NaN/负帧/重复帧不产生 NaN', () => {
    const ch = [kf(5, 7), kf(10, 9)];
    expect(sampleTimelineChannel(ch, Number.NaN)).toBe(7);
    expect(sampleTimelineChannel(ch, -100)).toBe(7);
    const dup = [kf(0, 1), kf(0, 2), kf(10, 3)];
    const at0 = sampleTimelineChannel(dup, 0);
    expect(Number.isFinite(at0)).toBe(true);
    expect(Number.isFinite(sampleTimelineChannel(dup, 0.0001))).toBe(true);
  });

  it('handles 出现但 enabled=false ⇒ 线性；畸形 handle 不产生 NaN', () => {
    const linear = [
      kf(0, 0, { front: handle(1, 1, false) }),
      kf(10, 100, { back: handle(-1, -1, false) }),
    ];
    expect(sampleTimelineChannel(linear, 5)).toBeCloseTo(50, 1);

    const broken = [
      kf(0, 0, { front: handle(Number.NaN, Number.NaN, true) }),
      kf(10, 100, { back: { x: Number.NaN, y: 0, enabled: true } }),
    ];
    const mid = sampleTimelineChannel(broken, 5);
    expect(Number.isFinite(mid)).toBe(true);
    expect(mid).toBeCloseTo(50, 1);
  });
});

describe('sampleTimeline', () => {
  it('多通道分别采样', () => {
    const a = parseTimelineAnimation('origin', anim({
      c0: [kf(0, 1), kf(10, 2)], c1: [kf(0, 5), kf(10, 6)], c2: [kf(0, 0), kf(10, 0)],
    }))!;
    expect(sampleTimeline(a, 10)).toEqual([2, 6, 0]);
  });

  it('空通道按 0 偏移（缺 c1/c2 的 origin 动画）', () => {
    const a = parseTimelineAnimation('origin', anim({ c0: [kf(0, 0), kf(10, 10)] }))!;
    expect(a.channels).toHaveLength(3);
    expect(sampleTimeline(a, 5)).toEqual([5, 0, 0]);
  });
});

describe('scene-json 动画字段接入', () => {
  const parse = (objects: unknown[]) => parseSceneJson(JSON.stringify({ objects })).objects;

  it('五个可动画属性的 animation 块进 animations，静态 value 不变', () => {
    const obj = parse([{
      id: 7, name: 'Media Area', image: 'models/x.json',
      origin: {
        value: '100 200 0',
        animation: {
          c0: [kf(0, 0), kf(10, 10)], c1: [kf(0, 0), kf(10, 0)], c2: [kf(0, 0), kf(10, 0)],
          options: { fps: 10, length: 10, name: 'Move' }, relative: true,
        },
      },
      alpha: { value: 0.4, animation: { c0: [kf(0, 0), kf(10, 1)], options: { fps: 10, length: 10 } } },
      scale: { value: '0.25 0.25 0.25', animation: { c0: [kf(0, 0)], options: {} } },
      angles: { value: '0 0 0.5', animation: { c0: [kf(0, 0), kf(10, 0.5)] } },
      color: {
        value: '10 20 30',
        animation: { c0: [kf(0, 10)], c1: [kf(0, 20)], c2: [kf(0, 30)], options: {} },
      },
    }])[0] as any;
    expect(obj.origin).toEqual([100, 200, 0]);
    expect(obj.alpha).toBe(0.4);
    expect(obj.scale).toEqual([0.25, 0.25, 0.25]);
    expect(obj.angles).toEqual([0, 0, 0.5]);
    expect(obj.color).toEqual([10, 20, 30]);
    expect(Object.keys(obj.animations).sort()).toEqual(['alpha', 'angles', 'color', 'origin', 'scale']);
    expect(obj.animations.origin).toMatchObject({ property: 'origin', relative: true, name: 'Move' });
    expect(obj.animations.alpha).toMatchObject({ property: 'alpha' });
    expect(obj.animations.alpha.channels).toHaveLength(1);
    expect(obj.animations.origin.channels).toHaveLength(3);
    expect(obj.animations.angles.channels).toHaveLength(3);
    expect(obj.animations.color.channels[2]![0]).toMatchObject({ value: 30 });
    // 只有 animation、无 script 的字段不产生 objectScripts
    expect(obj.objectScripts).toBeUndefined();
  });

  it('animation 与属性脚本同存：animations 与 objectScripts 互不影响', () => {
    const obj = parse([{
      id: 8, name: 'x', image: 'models/x.json',
      scale: {
        value: '1 1 1',
        script: 'export function update(v) { return v; }',
        animation: { c0: [kf(0, 0)], c1: [kf(0, 0)], c2: [kf(0, 0)], options: {} },
      },
    }])[0] as any;
    expect(obj.animations.scale).toMatchObject({ property: 'scale' });
    expect(obj.objectScripts).toHaveLength(1);
    expect(obj.objectScripts[0]).toMatchObject({ property: 'scale' });
    expect(obj.objectScripts[0].script).toContain('update');
  });

  it('无动画字段 ⇒ animations undefined；畸形 animation ⇒ 该属性不产出', () => {
    expect((parse([{ id: 1, image: 'models/x.json' }])[0] as any).animations).toBeUndefined();
    const obj = parse([{
      id: 2, image: 'models/x.json',
      alpha: { value: 0.5, animation: { c0: [] } },
      color: { value: '1 1 1', animation: { c0: [{ frame: 0, value: 0 }] } },
    }])[0] as any;
    expect(obj.animations).toEqual({ color: expect.objectContaining({ property: 'color' }) });
    expect(obj.alpha).toBe(0.5);
  });
});

// ── Task 10：时间线运行时（自动播放/startpaused/mode/relative/父子/世界变换） ──
type Vec3 = [number, number, number];
interface LocalT {
  origin: Vec3;
  scale: Vec3;
  angles: Vec3;
}

function runtimeOfDesc(desc: SceneDescription) {
  const localTransforms = new Map<number, LocalT>(desc.objects.map((o) => [o.id, {
    origin: [...o.origin] as Vec3,
    scale: [...o.scale] as Vec3,
    angles: [...(o.angles ?? [0, 0, 0])] as Vec3,
  }]));
  const worldTransforms = new Map<number, LocalT>(localTransforms);
  const writes: Array<Map<number, LayerWrite>> = [];
  const worldWrites: Array<[number, LocalT]> = [];
  const state = new Map<number, LayerWrite>();
  const rt = createTimelineRuntime({
    desc,
    localTransforms,
    worldTransforms,
    applyLocal: (w) => {
      writes.push(w);
      for (const [id, patch] of w) state.set(id, { ...state.get(id), ...patch });
    },
    readLocal: (id) => ({ ...(state.get(id) ?? {}) }),
    applyWorld: (id, wt) => { worldWrites.push([id, wt]); },
  });
  return { rt, writes, worldWrites, localTransforms };
}

const runtimeOf = (json: string) => runtimeOfDesc(parseSceneJson(json));
const lastWrite = (writes: Array<Map<number, LayerWrite>>, id: number): LayerWrite | undefined =>
  writes[writes.length - 1]?.get(id);
const playbackOf = (rt: TimelineRuntime, id: number, prop: 'alpha' | 'origin' | 'scale' | 'angles' | 'color') =>
  rt.getByProperty(id, prop, '')!;

const descOf = (objects: Array<Record<string, unknown>>): SceneDescription => ({
  camera: { center: [0, 0, 0], eye: [0, 0, 1], up: [0, 1, 0] },
  orthogonal: { width: 100, height: 100 },
  parallax: { enabled: false, amount: 0, delay: 0, mouseInfluence: 0 },
  objects: objects as never,
});

const animLiteral = (over: Partial<TimelineAnimation> = {}): TimelineAnimation => ({
  property: 'alpha',
  channels: [[{ frame: 0, value: 0 }], [{ frame: 0, value: 0 }], [{ frame: 0, value: 0 }]],
  fps: 10,
  frameCount: 10,
  duration: 1,
  mode: 'single',
  startPaused: false,
  relative: false,
  wrapLoop: false,
  name: '',
  parentKey: null,
  childrenKeys: [],
  ...over,
});

const IMAGE = { kind: 'image', name: 'x', image: 'models/x.json', origin: [0, 0, 0], scale: [1, 1, 1] };

describe('createTimelineRuntime', () => {
  it('非 startpaused 自动播放；startpaused 停在 frame 0，play 后推进', () => {
    const auto = runtimeOf(JSON.stringify({ objects: [{ id: 1, image: 'm.json',
      alpha: { value: 0.3, animation: { c0: [{ frame: 0, value: 0 }, { frame: 20, value: 1 }], options: { fps: 20, length: 20 } } } }] }));
    auto.rt.primeInitial(); auto.rt.applyInitial();
    expect(lastWrite(auto.writes, 1)?.alpha).toBeCloseTo(0, 6);
    auto.rt.advance(0.25); auto.rt.sampleAndWrite(); // 5 帧
    expect(lastWrite(auto.writes, 1)?.alpha).toBeCloseTo(0.25, 2);
    expect(playbackOf(auto.rt, 1, 'alpha').isPlaying()).toBe(true);

    const paused = runtimeOf(JSON.stringify({ objects: [{ id: 2, image: 'm.json',
      alpha: { value: 0.9, animation: { c0: [{ frame: 0, value: 0.2 }, { frame: 20, value: 1 }], options: { fps: 20, length: 20, startpaused: true } } } }] }));
    paused.rt.primeInitial(); paused.rt.applyInitial();
    expect(lastWrite(paused.writes, 2)?.alpha).toBeCloseTo(0.2, 6);
    paused.rt.advance(1); paused.rt.sampleAndWrite(); // dt 钳 0.25s，但未 play 不推进
    expect(lastWrite(paused.writes, 2)?.alpha).toBeCloseTo(0.2, 6);
    expect(playbackOf(paused.rt, 2, 'alpha').isPlaying()).toBe(false);
    playbackOf(paused.rt, 2, 'alpha').play();
    paused.rt.advance(0.25); paused.rt.sampleAndWrite(); // 5 帧 → 0.4
    expect(lastWrite(paused.writes, 2)?.alpha).toBeCloseTo(0.4, 2);
  });

  it('relative 叠加本地基值；子动画帧 = 父帧 ×（子帧数/父帧数）', () => {
    const { rt, writes } = runtimeOf(JSON.stringify({ objects: [{ id: 3, image: 'm.json',
      origin: {
        value: '100 200 0',
        animation: {
          c0: [{ frame: 0, value: 0 }, { frame: 20, value: 10 }],
          c1: [{ frame: 0, value: 0 }, { frame: 20, value: 20 }],
          c2: [{ frame: 0, value: 0 }, { frame: 20, value: 0 }],
          options: { fps: 20, length: 20, name: 'Move', children: [{ key: 'alpha' }] },
          relative: true,
        },
      },
      alpha: {
        value: 1,
        animation: {
          c0: [{ frame: 0, value: 0 }, { frame: 20, value: 1 }],
          options: { fps: 20, length: 20, parent: { key: 'origin' } },
        },
      } }] }));
    rt.primeInitial(); rt.applyInitial();
    rt.advance(0.25); rt.sampleAndWrite(); // 父/子都到第 5 帧
    const patch = lastWrite(writes, 3)!;
    expect(patch.origin![0]).toBeCloseTo(102.5, 3);
    expect(patch.origin![1]).toBeCloseTo(205, 3);
    expect(patch.alpha).toBeCloseTo(0.25, 3);
    expect(playbackOf(rt, 3, 'alpha').getFrame()).toBeCloseTo(5, 6);
    // 按名查找；同名不匹配 ⇒ null。
    const move = rt.getByName(3, 'Move')!;
    expect(move).not.toBeNull();
    expect(rt.getByProperty(3, 'origin', 'Move')).toBe(move);
    expect(rt.getByProperty(3, 'origin', 'Nope')).toBeNull();
    expect(rt.getByName(3, 'Nope')).toBeNull();
  });

  it('父子帧率不同：子帧按父帧比例换算', () => {
    const { rt } = runtimeOf(JSON.stringify({ objects: [{ id: 1, image: 'm.json',
      origin: {
        animation: {
          c0: [{ frame: 0, value: 0 }, { frame: 20, value: 20 }],
          c1: [{ frame: 0, value: 0 }, { frame: 20, value: 0 }],
          c2: [{ frame: 0, value: 0 }, { frame: 20, value: 0 }],
          options: { fps: 10, length: 20, children: [{ key: 'alpha' }] },
        },
        relative: true,
      },
      alpha: {
        animation: {
          c0: [{ frame: 0, value: 0 }, { frame: 10, value: 1 }],
          options: { fps: 10, length: 10, parent: { key: 'origin' } },
        },
      } }] }));
    rt.primeInitial(); rt.applyInitial();
    rt.advance(0.25); // 父 2.5 帧 → 子 2.5×(10/20)=1.25 帧
    rt.sampleAndWrite();
    expect(playbackOf(rt, 1, 'alpha').getFrame()).toBeCloseTo(1.25, 6);
  });

  it('single 到末帧停住；play 从 0 重播（媒体事件重复触发依赖它）', () => {
    const { rt } = runtimeOf(JSON.stringify({ objects: [{ id: 4, image: 'm.json',
      alpha: { animation: { c0: [{ frame: 0, value: 0 }, { frame: 10, value: 1 }], options: { fps: 10, length: 10 } } } }] }));
    rt.primeInitial(); rt.applyInitial();
    const pb = playbackOf(rt, 4, 'alpha');
    for (let i = 0; i < 4; i++) rt.advance(0.25);
    expect(pb.getFrame()).toBeCloseTo(10, 6);
    expect(pb.isPlaying()).toBe(false);
    rt.advance(0.25);
    expect(pb.getFrame()).toBeCloseTo(10, 6);
    pb.play();
    rt.advance(0.25);
    expect(pb.getFrame()).toBeCloseTo(2.5, 6);
    expect(pb.isPlaying()).toBe(true);
  });

  it('loop 回绕；mirror 往返（相位保留，不在同一半区反复反射）', () => {
    const loop = runtimeOf(JSON.stringify({ objects: [{ id: 5, image: 'm.json',
      alpha: { animation: { c0: [{ frame: 0, value: 0 }, { frame: 10, value: 1 }], options: { fps: 10, length: 10, mode: 'loop' } } } }] }));
    loop.rt.primeInitial(); loop.rt.applyInitial();
    const lp = playbackOf(loop.rt, 5, 'alpha');
    for (let i = 0; i < 4; i++) loop.rt.advance(0.25); // 10 帧 → 回绕 0
    expect(lp.getFrame()).toBeCloseTo(0, 6);
    expect(lp.isPlaying()).toBe(true);
    loop.rt.advance(0.25);
    expect(lp.getFrame()).toBeCloseTo(2.5, 6);

    const mirror = runtimeOf(JSON.stringify({ objects: [{ id: 6, image: 'm.json',
      alpha: { animation: { c0: [{ frame: 0, value: 0 }, { frame: 10, value: 1 }], options: { fps: 10, length: 10, mode: 'mirror' } } } }] }));
    mirror.rt.primeInitial(); mirror.rt.applyInitial();
    const mp = playbackOf(mirror.rt, 6, 'alpha');
    const frames: number[] = [];
    for (let i = 0; i < 4; i++) { mirror.rt.advance(0.25); frames.push(mp.getFrame()); }
    // 2.5 → 5 → 7.5 → 10（峰）
    expect(frames.map((f) => Math.round(f * 10) / 10)).toEqual([2.5, 5, 7.5, 10]);
    const back: number[] = [];
    for (let i = 0; i < 4; i++) { mirror.rt.advance(0.25); back.push(mp.getFrame()); }
    // 回到起点：7.5 → 5 → 2.5 → 0
    expect(back.map((f) => Math.round(f * 10) / 10)).toEqual([7.5, 5, 2.5, 0]);
    mirror.rt.advance(0.25);
    expect(mp.getFrame()).toBeCloseTo(2.5, 6); // 再次向前
  });

  it('syncWorld：动画对象 + 后代重算世界变换，非受影响对象不写', () => {
    const { rt, worldWrites } = runtimeOf(JSON.stringify({ objects: [
      { id: 1, image: 'm.json',
        scale: {
          value: '0.25 0.25 0.25',
          animation: {
            c0: [{ frame: 0, value: 0 }, { frame: 10, value: 0 }],
            c1: [{ frame: 0, value: -0.25 }, { frame: 10, value: 0 }],
            c2: [{ frame: 0, value: 0 }, { frame: 10, value: 0 }],
            options: { fps: 10, length: 10 },
            relative: true,
          },
        } },
      { id: 2, image: 'm.json', parent: 1, origin: '10 20 0' },
      { id: 3, image: 'm.json', origin: '5 5 0' },
    ] }));
    rt.primeInitial(); rt.applyInitial();
    worldWrites.length = 0;
    rt.syncWorld();
    expect(worldWrites.map(([id]) => id).sort()).toEqual([1, 2]);
    const w1 = worldWrites.find(([id]) => id === 1)![1];
    const w2 = worldWrites.find(([id]) => id === 2)![1];
    // 首帧：relative scale 偏移 -0.25 ⇒ 本地 scale = (0.25, 0, 0.25)
    expect(w1.scale[0]).toBeCloseTo(0.25, 6);
    expect(w1.scale[1]).toBeCloseTo(0, 6);
    // 子 origin = 父 origin + 父 scale ⊙ 子 LocalOrigin = (0,0,0) + (10×0.25, 20×0, 0) = (2.5, 0, 0)
    expect(w2.origin[0]).toBeCloseTo(2.5, 6);
    expect(w2.origin[1]).toBeCloseTo(0, 6);
  });

  it('空通道（非 relative）回退静态基值，不把缺失轴写成 0', () => {
    const nonRel = runtimeOf(JSON.stringify({ objects: [{ id: 7, image: 'm.json',
      origin: {
        value: '100 200 300',
        animation: {
          c0: [{ frame: 0, value: 0 }, { frame: 10, value: 10 }],
          options: { fps: 10, length: 10 },
        },
      } }] }));
    nonRel.rt.primeInitial(); nonRel.rt.applyInitial();
    nonRel.rt.advance(0.25); nonRel.rt.sampleAndWrite(); // 2.5 帧 → c0=2.5
    expect(lastWrite(nonRel.writes, 7)?.origin).toEqual([2.5, 200, 300]);

    const rel = runtimeOf(JSON.stringify({ objects: [{ id: 8, image: 'm.json',
      origin: {
        value: '100 200 300',
        animation: {
          c0: [{ frame: 0, value: 0 }, { frame: 10, value: 10 }],
          options: { fps: 10, length: 10 },
          relative: true,
        },
      } }] }));
    rel.rt.primeInitial(); rel.rt.applyInitial();
    rel.rt.advance(0.25); rel.rt.sampleAndWrite();
    expect(lastWrite(rel.writes, 8)?.origin).toEqual([102.5, 200, 300]);
  });

  it('angles：状态表写度（脚本通道），世界变换用弧度', () => {
    const { rt, writes, worldWrites } = runtimeOf(JSON.stringify({ objects: [{ id: 9, image: 'm.json',
      angles: {
        value: '0 0 0.5',
        animation: {
          c0: [{ frame: 0, value: 0 }, { frame: 10, value: 0 }],
          c1: [{ frame: 0, value: 0 }, { frame: 10, value: 0 }],
          c2: [{ frame: 0, value: 0 }, { frame: 10, value: 0.5 }],
          options: { fps: 10, length: 10 },
          relative: true,
        },
      } }] }));
    rt.primeInitial(); rt.applyInitial();
    rt.advance(0.25); rt.sampleAndWrite(); // 2.5 帧 → z = 0.5 + 0.125 = 0.625 rad
    const patch = lastWrite(writes, 9)!;
    expect(patch.angles![2]).toBeCloseTo((0.625 * 180) / Math.PI, 3);
    worldWrites.length = 0;
    rt.syncWorld();
    expect(worldWrites[0]![1].angles[2]).toBeCloseTo(0.625, 6);
  });

  it('防环：自引用 / 互相引用不联动、不产生 NaN', () => {
    const self = runtimeOfDesc(descOf([{
      id: 1, ...IMAGE,
      animations: { alpha: animLiteral({ parentKey: 'alpha', channels: [[{ frame: 0, value: 0 }, { frame: 10, value: 1 }]] }) },
    }]));
    self.rt.primeInitial(); self.rt.applyInitial();
    self.rt.advance(0.25);
    self.rt.sampleAndWrite();
    expect(self.rt.getByProperty(1, 'alpha', '')!.getFrame()).toBeCloseTo(2.5, 6);
    expect(Number.isFinite(lastWrite(self.writes, 1)!.alpha!)).toBe(true);

    const mutual = runtimeOfDesc(descOf([{
      id: 2, ...IMAGE,
      animations: {
        alpha: animLiteral({ parentKey: 'origin', channels: [[{ frame: 0, value: 0 }, { frame: 10, value: 1 }]] }),
        origin: animLiteral({
          property: 'origin', parentKey: 'alpha',
          channels: [[{ frame: 0, value: 0 }, { frame: 10, value: 5 }], [], []],
        }),
      },
    }]));
    mutual.rt.primeInitial(); mutual.rt.applyInitial();
    mutual.rt.advance(0.25);
    mutual.rt.sampleAndWrite();
    expect(mutual.rt.getByProperty(2, 'origin', '')!.getFrame()).toBeCloseTo(2.5, 6);
    expect(Number.isFinite(lastWrite(mutual.writes, 2)!.origin![0])).toBe(true);
  });

  it('防御：frameCount=0 / fps=0 / NaN frame / 非有限 dt 均不推进、不写 NaN', () => {
    const bad = runtimeOfDesc(descOf([{
      id: 1, ...IMAGE,
      animations: {
        alpha: animLiteral({
          frameCount: 0, fps: 0, duration: 0,
          channels: [[{ frame: 0, value: 0.5 }, { frame: 10, value: 1 }]],
        }),
      },
    }]));
    bad.rt.primeInitial(); bad.rt.applyInitial();
    bad.rt.advance(0.25);
    const bp = bad.rt.getByProperty(1, 'alpha', '')!;
    bp.setFrame(Number.NaN);
    bad.rt.advance(Number.NaN);
    bad.rt.advance(Number.POSITIVE_INFINITY);
    bad.rt.sampleAndWrite();
    expect(Number.isFinite(bp.getFrame())).toBe(true);
    expect(Number.isFinite(lastWrite(bad.writes, 1)!.alpha!)).toBe(true);

    const good = runtimeOf(JSON.stringify({ objects: [{ id: 2, image: 'm.json',
      alpha: { animation: { c0: [{ frame: 0, value: 0 }, { frame: 10, value: 1 }], options: { fps: 10, length: 10 } } } }] }));
    good.rt.primeInitial(); good.rt.applyInitial();
    const gp = good.rt.getByProperty(2, 'alpha', '')!;
    good.rt.advance(Number.NaN);
    good.rt.advance(Number.POSITIVE_INFINITY);
    expect(gp.getFrame()).toBeCloseTo(0, 6);
    good.rt.advance(10); // 钳到 0.25s = 2.5 帧
    expect(gp.getFrame()).toBeCloseTo(2.5, 6);
  });

  it('dispose 幂等；dispose 后不再推进/写状态', () => {
    const { rt, writes, worldWrites } = runtimeOf(JSON.stringify({ objects: [{ id: 1, image: 'm.json',
      alpha: { animation: { c0: [{ frame: 0, value: 0 }, { frame: 10, value: 1 }], options: { fps: 10, length: 10 } } } }] }));
    rt.primeInitial(); rt.applyInitial();
    const writeCount = writes.length;
    const worldCount = worldWrites.length;
    rt.dispose();
    expect(() => rt.dispose()).not.toThrow();
    rt.advance(0.25);
    rt.sampleAndWrite();
    rt.syncWorld();
    expect(writes.length).toBe(writeCount);
    expect(worldWrites.length).toBe(worldCount);
  });

  // I3：renderer 顺序 = primeInitial → host.create（init 可 play/setFrame）→ applyInitial（只写值）。
  // 旧实现 applyInitial 会把 init 里的 play/setFrame 重置回第 0 帧停住。
  it('脚本 init 的 play/setFrame 不被 applyInitial 覆盖', async () => {
    const desc = parseSceneJson(JSON.stringify({ objects: [{
      id: 1, image: 'm.json',
      // 用 origin（Vec3 属性）：alpha 属性的 init 被标量契约跳过（VM 里 alpha 只派发媒体回调）。
      origin: { value: '0 0 0', animation: {
        c0: [{ frame: 0, value: 0 }, { frame: 10, value: 10 }],
        c1: [{ frame: 0, value: 0 }, { frame: 10, value: 10 }],
        c2: [{ frame: 0, value: 0 }, { frame: 10, value: 0 }],
        options: { fps: 10, length: 10, startpaused: true, name: 'Move' },
      } },
    }] }));
    const writes: Array<Map<number, LayerWrite>> = [];
    let host: SceneScriptHost | null = null;
    const rt = createTimelineRuntime({
      desc,
      localTransforms: new Map(),
      worldTransforms: new Map(),
      applyLocal: (w) => { writes.push(w); host?.applyExternal(w); },
      readLocal: (id) => host?.read(id) ?? {},
      applyWorld: () => {},
    });
    rt.primeInitial();
    host = await SceneScriptHost.create({
      userProperties: {},
      timeline: rt,
      scripts: [{
        objectId: 1,
        property: 'origin',
        source: 'export function init(){ thisObject.getAnimation().play(); thisObject.getAnimation().setFrame(7); }',
      }],
    });
    expect(host?.activeCount).toBe(1);
    rt.applyInitial();
    const pb = playbackOf(rt, 1, 'origin');
    expect(pb.isPlaying()).toBe(true);
    expect(pb.getFrame()).toBe(7);
    expect(writes[writes.length - 1]?.get(1)?.origin).toEqual([7, 7, 0]);
    host?.dispose();
    rt.dispose();
  });
});
