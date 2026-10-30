// 时间线动画性能证据（Node，不依赖浏览器/GPU）：
// 用生产 `lib/client/scene-timeline.js` 构造 10 条动画的运行时，测
// advance + sampleAndWrite + syncWorld 的单帧耗时（N=2000 取均值），断言 < 50µs（spec §11）。
// 动画数据为内联固定夹具（不依赖本机壁纸库），数值与素材无关；退出码 0/1。
import { createTimelineRuntime } from '../../lib/client/scene-timeline.js';

const N = 2000;
const WARMUP = 200;
const BUDGET_US = 50;

/** 极简断言器（与其它 verify 脚本同风格：逐条打印 + 汇总）。 */
const results = [];
function judge(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? '✅' : '❌'} ${name}  ${detail}`);
}

const kf = (frame, value) => ({
  frame, value,
  front: { x: 0, y: 0, enabled: false },
  back: { x: 0, y: 0, enabled: false },
});

/** 单通道 0→1 的线性关键帧（覆盖采样最坏路径：24 次贝塞尔反解 + 插值）。 */
const channel = () => [kf(0, 0), kf(30, 0.5), kf(60, 1)];

function anim(property, extra = {}) {
  return {
    property,
    channels: property === 'alpha' ? [channel()] : [channel(), channel(), channel()],
    fps: 30,
    frameCount: 60,
    duration: 2,
    mode: 'loop',
    startPaused: false,
    relative: false,
    wrapLoop: true,
    name: `${property}-anim`,
    parentKey: null,
    childrenKeys: [],
    ...extra,
  };
}

// 10 条动画：5 个对象 × (scale/origin/alpha/color)，其中 object 1 有父子联动。
const objects = [
  {
    id: 1, origin: [480, 270, 0], scale: [1, 1, 1], angles: [0, 0, 0],
    animations: {
      scale: anim('scale', { childrenKeys: ['alpha'], name: 'Container' }),
      alpha: anim('alpha', { parentKey: 'scale' }),
    },
  },
  {
    id: 2, parent: 1, origin: [500, 270, 0], scale: [1, 1, 1], angles: [0, 0, 0],
    animations: { origin: anim('origin'), color: anim('color') },
  },
  {
    id: 3, parent: 1, origin: [460, 270, 0], scale: [1, 1, 1], angles: [0, 0, 0],
    animations: { scale: anim('scale'), origin: anim('origin') },
  },
  {
    id: 4, parent: 2, origin: [500, 300, 0], scale: [1, 1, 1], angles: [0, 0, 0],
    animations: { color: anim('color'), alpha: anim('alpha') },
  },
  {
    id: 5, parent: 3, origin: [460, 240, 0], scale: [1, 1, 1], angles: [0, 0, 0],
    animations: { scale: anim('scale'), origin: anim('origin') },
  },
];
const desc = { objects };

const localTransforms = new Map(objects.map((o) => [o.id, {
  origin: [...o.origin], scale: [...o.scale], angles: [...o.angles],
}]));
const worldTransforms = new Map(localTransforms);
const state = new Map();
let worldWrites = 0;

const rt = createTimelineRuntime({
  desc,
  localTransforms,
  worldTransforms,
  applyLocal: (writes) => {
    for (const [id, patch] of writes) state.set(id, { ...state.get(id), ...patch });
  },
  readLocal: (id) => ({ ...(state.get(id) ?? {}) }),
  applyWorld: () => { worldWrites += 1; },
});

const step = () => {
  rt.advance(1 / 60);
  rt.sampleAndWrite();
  rt.syncWorld();
};

rt.primeInitial();
rt.applyInitial();
for (let i = 0; i < WARMUP; i += 1) step();

const t0 = process.hrtime.bigint();
for (let i = 0; i < N; i += 1) step();
const elapsedNs = Number(process.hrtime.bigint() - t0);
const meanUs = elapsedNs / N / 1000;

// 逐帧样本（max 仅诊断：GC 尖峰不参与均值断言）。
let maxUs = 0;
for (let i = 0; i < N; i += 1) {
  const a = process.hrtime.bigint();
  step();
  const us = Number(process.hrtime.bigint() - a) / 1000;
  if (us > maxUs) maxUs = us;
}

console.log(`[perf] timeline 10 anims × ${N} 帧: mean=${meanUs.toFixed(3)}µs/frame max=${maxUs.toFixed(1)}µs ` +
  `(warmup=${WARMUP}, budget<${BUDGET_US}µs)`);
judge('时间线求值均值 < 50µs/帧', meanUs < BUDGET_US, `mean=${meanUs.toFixed(3)}µs`);
judge('syncWorld 实际写世界变换', worldWrites > 0, `worldWrites=${worldWrites}`);

rt.dispose();

const failed = results.filter((r) => !r.pass);
console.log('\n===== 判定 =====');
if (failed.length === 0) console.log(`  ✅ 全部 ${results.length} 条判据通过`);
else {
  console.log(`  ❌ ${failed.length}/${results.length} 条判据失败：${failed.map((r) => r.name).join(' / ')}`);
  process.exitCode = 1;
}
