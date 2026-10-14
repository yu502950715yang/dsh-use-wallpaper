# scene 鼠标视差 + puppet 骨骼模型 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 WE scene 里两处**当前完全没有实现**的能力补齐：① 鼠标视差（`general.cameraparallax*` + 对象 `parallaxDepth`），② puppet 骨骼模型（`models/*.json` 的 `puppet` 字段 → `.mdl` 二进制 → 骨骼蒙皮 + MDLA 动画）。完成后本机唯一的 puppet 壁纸 `3303428996`（死亡搁浅-玛玛）与 16 个带 `parallaxDepth` 的样本应从「静态/无动」变成与桌面 WE 同形的视差 + 骨骼动画。

**Architecture:** 两个子系统，**先视差后 puppet**（视差小、可当天闭环；puppet 依赖前者建立的「逐帧对象位移」与「assets 装配」两条通路）。视差走 OWE 的权威公式（`research/audit-parallax-mechanism.md` §3.2：`shift = ((n − c) + mouse) ⊙ depth × amount`，**作用于对象 model 矩阵的 2D 平移，相机不动**），逐帧只写 `Object3D.position`，不碰相机与渲染帧序。puppet 走「解析 → `THREE.SkinnedMesh` + `THREE.Skeleton`」：MDLS 的本地绑定矩阵摆成骨骼层级后 `bind()`，three 自动得到 `World(anim) · World(bind)⁻¹` 蒙皮矩阵；MDLA 关键帧逐帧采样写回 `bone.position/quaternion/scale`。**不新增对象 kind**：puppet 是 `image` 对象的分支（`image` → `models/x.json` → `"puppet": "models/x_puppet.mdl"`），判别发生在资源解析阶段。

**Tech Stack:** TypeScript、three.js r170（`SkinnedMesh` / `Skeleton` / `Bone` / `BufferGeometry` / `InstancedBufferGeometry`）、vitest（node + jsdom）、headless Edge（`e2e/`）

**Spec / 判据来源（本计划不另写 spec，直接依据以下已有材料；引用的都是仓库内或公开源码）:**
- 视差机制：`research/audit-parallax-mechanism.md`（OWE `UniformSource.cpp:399-415`、`CScene.cpp`、`CImage.cpp`、`ObjectParser.cpp` 的行号证据与公式推导；本计划的公式与缺省值**逐条**取自该文件）
- MDL 格式：上游 WebWallGL `renderer/vendor/we-scene/render/mdl-parse.js`（MDLV/MDLS/MDLA/MDLE 段布局、stride 表、四元数关键帧）与 `linux-wallpaperengine` 的 `CImage.cpp` / `ModelParser.cpp` / `ObjectParser.cpp`（版本白名单、`material` 必需、`animationlayers` 字段与缺省值）
- 仓库内参考实现（**只读参照，不得 import**，它是 e0.7.1 的弱化副本）：`research/dsh-wallpaper-engine-v0.7.1/lib/we-renderer/puppet.js`（`_parseMdl`：80B stride 顶点/权重偏移、MDLS 骨骼头变体、MDLA 段扫描、MDLE 扩展矩阵）、`.../mdl.js`（静态 MDLV stride 评分）
- 上游源码（外部，仅供事实核对）：[webwallgl `mdl-parse.js`](https://github.com/oneincase/webwallgl/blob/main/renderer/vendor/we-scene/render/mdl-parse.js)、[webwallgl `mdl-skin.js`](https://github.com/oneincase/webwallgl/blob/main/renderer/vendor/we-scene/render/mdl-skin.js)、[linux-wallpaperengine `ModelParser.cpp`](https://github.com/almamu/linux-wallpaperengine/blob/main/src/WallpaperEngine/Data/Parsers/ModelParser.cpp)、[linux-wallpaperengine `CImage.cpp`](https://github.com/almamu/linux-wallpaperengine/blob/main/src/WallpaperEngine/Render/Objects/CImage.cpp)

## Global Constraints

- **壁纸目录只读**（`AGENT.md` §6，用户明令）：验证只能读 Steam 工坊的 pkg，**不得**改动其中任何文件；需要夹具就**在测试里构造字节流**。
- **不改相机与帧序**：视差是**对象平移**（OWE `UniformSource.cpp:415` `model = Translation(shift) * model`），主相机 lookAt/cover 一律不动；`render()` 的相机更新点不新增。
- **不改 WE 坐标约定**（`AGENT.md` §2.3 / §5.3）：`we_to_three = origin − viewport/2`，**y 不翻转**；对象 `angles` 是**弧度**、`R = Rz·Ry·Rx`。视差的 y 分量按 OWE 的 `mouse_y = (py − 0.5) × H × mi`（屏幕 y 向下、世界 y 向上，该式已含符号）。
- **属性名必须用 three 内建**（`AGENT.md` §5 语境 + `mesh-shaders.ts:10-14`）：`position` / `uv` / `skinIndex` / `skinWeight`；矩阵必须用 `projectionMatrix` / `modelViewMatrix`。写成 WE 的 `a_Position` 会**静默**不绑（顶点恒 0）。
- **不改纹理/效果链语义**：puppet 用 `THREE.MeshBasicMaterial`（three 内建材质才自动注入蒙皮代码）；WE 的 `colorBlendMode ≠ 0` 在 puppet 上回退普通 alpha 混合（与仓库既有「未实现模式回退」口径一致）。
- **新增 `research/` 之外的夹具**：测试夹具写成代码（`Uint8Array` 构造），不放二进制进仓库（`research/` 是 gitignore，不能当 CI 夹具）。
- **每一步都能单独验收**：Task 1-5（视差）与 Task 6-8（puppet）各自可独立合并；puppet 的 Task 6 解析器不依赖视差。
- 注释一行说清「是什么 / 为什么」（§6）；提交标题一行 + 正文 ≤3 行；提交与文档简体中文。
- 每个 Task 结束都要跑：`npx vitest run <改动文件>` + `pnpm exec tsc -p tsconfig.json --noEmit`。
- **`lib/` 与 `dist/client.js` 必须重新生成并提交**（CI 产物新鲜度守卫，§3.3）。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `src/client/parallax.ts`（新） | 纯函数：读 `general.cameraparallax*`、指针延迟插值（OWE 线性上升）、逐对象 `shift` |
| `src/client/pointer-input.ts`（新） | `window` 指针监听 → 归一化 `[0,1]`；幂等装/卸（§5.43） |
| `src/client/mdl-parser.ts`（新） | MDLV/MDLS/MDLA/MDLE 段解析 → `MdlPuppet`（网格 + 骨骼 + 动画轨），全部自洽校验 + 结构化错误 |
| `src/client/puppet.ts`（新） | `MdlPuppet` → `THREE.SkinnedMesh` + `Skeleton`；关键帧采样与逐帧写回 |
| `src/shared/types.ts`（改） | `SceneDescription.parallax`、`SceneImageObject.parallaxDepth` / `animationLayers` |
| `src/client/scene-json.ts`（改） | 解析上面三项（缺省值按 OWE 解析器） |
| `src/client/scene-assets.ts`（改） | `resolveImageAssets(id, obj)` 返回 `{ texture, puppetPath }`（唯一调用点 `three-renderer.ts:409`）；新增 `fetchMdlBytes` |
| `src/client/threejs-player.ts`（改） | `addBackground` 记录 `parallaxNode` / `parallaxDepth`；新增 `setParallax` / `setParallaxPointer` / 帧内 `tickParallax`；新增 `addPuppet`；粒子层视差 uniform |
| `src/client/three-renderer.ts`（改） | 装 `desc.parallax` + 指针 tracker；装配 `assets.puppetMeshes`；逐帧推进 puppet 动画 + 视差；收尾释放 |
| `tests/parallax.test.ts`（新） | 公式 / 延迟插值 / 缺省值（node） |
| `tests/pointer-input.test.ts`（新） | 归一化 + 幂等装卸（jsdom） |
| `tests/mdl-parser.test.ts`（新） | 自建最小 MDLV0021 + MDLS0004 + MDLA0006 字节流 → 逐字段断言；畸形输入不抛（node） |
| `tests/puppet.test.ts`（新，jsdom） | 骨骼层级 / bind 逆矩阵 / 关键帧采样 / 帧号回绕 |
| `tests/scene-json-parallax.test.ts`（新） | `parallaxDepth` 与 `cameraparallax*` 解析（含缺省与畸形） |
| `tests/threejs-player.test.ts`（改） | 视差逐帧只改 `position`；`depth={0,0}` 对象不动；隔离对象写到合成 quad |
| `AGENT.md` / `TESTING.md`（改） | §2.1/§2.3 增补；§7 如实标注 puppet 的版本覆盖与未知段；TESTING.md 增手工验收清单 |

---

### Task 1: 视差纯函数 `parallax.ts`

**Files:**
- Create: `src/client/parallax.ts`
- Modify: `src/shared/types.ts`（新增 `ParallaxConfig` 接口 —— 放 shared 是因为 `SceneDescription` 要用它，而 shared 不得反向依赖 client）
- Test: `tests/parallax.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `interface ParallaxConfig { enabled: boolean; amount: number; delay: number; mouseInfluence: number }`
  - `const DEFAULT_PARALLAX: ParallaxConfig`（`false / 0 / 0 / 0`，= OWE 解析器缺省）
  - `readParallaxConfig(gen: unknown): ParallaxConfig`
  - `interface PointerState { x: number; y: number }`、`const POINTER_CENTER: PointerState`
  - `interface PointerFollow { value: PointerState; elapsed: number }`
  - `advancePointer(follow: PointerFollow, target: PointerState, cfg: ParallaxConfig, dt: number): PointerFollow`
  - `parallaxShift(o: { pointer, orthoW, orthoH, nodeX, nodeY, camX, camY, depth, cfg }): [number, number]`

- [ ] **Step 1: 写失败测试** `tests/parallax.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_PARALLAX, POINTER_CENTER, advancePointer, parallaxShift, readParallaxConfig } from '../src/client/parallax.js';

describe('readParallaxConfig', () => {
  it('缺省 = OWE 解析器缺省（关 / 0 / 0 / 0）', () => {
    expect(readParallaxConfig(undefined)).toEqual(DEFAULT_PARALLAX);
    expect(readParallaxConfig({})).toEqual(DEFAULT_PARALLAX);
  });
  it('读四个字段并容错非数值', () => {
    expect(readParallaxConfig({ cameraparallax: true, cameraparallaxamount: 0.5, cameraparallaxdelay: 0.1, cameraparallaxmouseinfluence: 1 }))
      .toEqual({ enabled: true, amount: 0.5, delay: 0.1, mouseInfluence: 1 });
    expect(readParallaxConfig({ cameraparallax: 'yes', cameraparallaxamount: 'x' }))
      .toEqual({ enabled: false, amount: 0, delay: 0, mouseInfluence: 0 });
  });
});

describe('advancePointer（OWE UniformSource.cpp:263-274 的线性上升插值）', () => {
  const cfg = { enabled: true, amount: 1, delay: 0.5, mouseInfluence: 1 };
  it('delay=0 → 立即跟随', () => {
    const f = advancePointer({ value: POINTER_CENTER, elapsed: 0 }, { x: 1, y: 0 }, { ...cfg, delay: 0 }, 0.016);
    expect(f.value).toEqual({ x: 1, y: 0 });
  });
  it('elapsed 累积到 delay 前按比例靠近，之后完全跟随', () => {
    let f = { value: POINTER_CENTER, elapsed: 0 };
    f = advancePointer(f, { x: 1, y: 0.5 }, cfg, 0.25); // amount = 0.25/0.5 = 0.5
    expect(f.value.x).toBeCloseTo(0.75, 6);
    f = advancePointer(f, { x: 1, y: 0.5 }, cfg, 0.25); // amount = 1
    expect(f.value.x).toBeCloseTo(1, 6);
  });
});

describe('parallaxShift（OWE UniformSource.cpp:399-415）', () => {
  const cfg = { enabled: true, amount: 1, delay: 0, mouseInfluence: 1 };
  it('鼠标居中且对象在原点 → 无位移', () => {
    expect(parallaxShift({ pointer: POINTER_CENTER, orthoW: 1920, orthoH: 1080, nodeX: 0, nodeY: 0, camX: 0, camY: 0, depth: [1, 1], cfg }))
      .toEqual([0, 0]);
  });
  it('鼠标右移 px=1 → shift_x 为负（对象向左，OWE 方向约定）', () => {
    const [sx] = parallaxShift({ pointer: { x: 1, y: 0.5 }, orthoW: 1920, orthoH: 1080, nodeX: 0, nodeY: 0, camX: 0, camY: 0, depth: [1, 1], cfg });
    expect(sx).toBeCloseTo((0.5 - 1) * 1920, 6);
  });
  it('鼠标下移 py=1 → shift_y 为正', () => {
    const [, sy] = parallaxShift({ pointer: { x: 0.5, y: 1 }, orthoW: 1920, orthoH: 1080, nodeX: 0, nodeY: 0, camX: 0, camY: 0, depth: [1, 1], cfg });
    expect(sy).toBeCloseTo(540, 6);
  });
  it('结构项：离屏中心越远、摆幅越大（乘 depth × amount）', () => {
    const [sx] = parallaxShift({ pointer: POINTER_CENTER, orthoW: 1920, orthoH: 1080, nodeX: 300, nodeY: 0, camX: 0, camY: 0, depth: [0.5, 0], cfg: { ...cfg, amount: 2 } });
    expect(sx).toBeCloseTo(300, 6);
  });
  it('depth 为 0 或总开关关 → 恒 0', () => {
    const base = { pointer: { x: 1, y: 1 }, orthoW: 1920, orthoH: 1080, nodeX: 100, nodeY: 100, camX: 0, camY: 0, cfg };
    expect(parallaxShift({ ...base, depth: [0, 0] })).toEqual([0, 0]);
    expect(parallaxShift({ ...base, depth: [1, 1], cfg: { ...cfg, enabled: false } })).toEqual([0, 0]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/parallax.test.ts --reporter=basic`
Expected: FAIL —— 无法解析 `../src/client/parallax.js`

- [ ] **Step 3: 实现** `src/shared/types.ts` 加接口 + `src/client/parallax.ts`

`src/shared/types.ts` 追加（**唯一声明点**；client 侧 import 它，shared 不 import client）：

```ts
/** WE 相机视差配置（scene.json `general.cameraparallax*`；缺省全关/全 0，= OWE 解析器缺省）。 */
export interface ParallaxConfig {
  enabled: boolean;
  amount: number;
  delay: number;
  mouseInfluence: number;
}
```

`src/client/parallax.ts`：

```ts
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

/** 指针跟随状态：elapsed 是 OWE 的 m_pointer_delayed_time（累积到 delay 即完全跟随）。 */
export interface PointerFollow { value: PointerState; elapsed: number }

export function advancePointer(
  follow: PointerFollow,
  target: PointerState,
  cfg: ParallaxConfig,
  dt: number,
): PointerFollow {
  const delay = Math.max(0, cfg.delay);
  const elapsed = Math.min(follow.elapsed + Math.max(0, dt), delay);
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
  return [
    o.depth[0] * o.cfg.amount * (o.nodeX - o.camX + mouseX),
    o.depth[1] * o.cfg.amount * (o.nodeY - o.camY + mouseY),
  ];
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/parallax.test.ts --reporter=basic`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/client/parallax.ts tests/parallax.test.ts
git commit -m "feat(parallax): 视差纯数学层（OWE 公式 + 指针延迟插值）"
```

---

### Task 2: 解析 `parallaxDepth` 与 `cameraparallax*`

**Files:**
- Modify: `src/shared/types.ts`（`SceneImageObject`、`SceneDescription`）
- Modify: `src/client/scene-json.ts:150-152`、`:211-220`、`:265-282`
- Test: `tests/scene-json-parallax.test.ts`（新增）

**Interfaces:**
- Consumes: Task 1 的 `ParallaxConfig` / `readParallaxConfig`
- Produces:
  - `SceneObject.parallaxDepth?: [number, number]`（**所有 kind**：解析器把它放在对象 `base` 上；缺省 `undefined` = OWE 的 `{0,0}` ⇒ 不动）
  - `SceneDescription.parallax: ParallaxConfig`

> **2026-10-14 修订（控制方亲测真实壁纸库后的裁定）**：原计划只让 **image** 分支产出 `parallaxDepth`，但真实库 34 张 scene 壁纸里 227 处该字段的分布是 **particle 106 / image 91 / text 20 / other 10** —— 47% 挂在粒子上，而 Task 4 要用它给粒子注 `u_Parallax`。若只做 image，粒子视差与本计划验收样本里的 5 个粒子对象都会永远取到 `undefined`。故改为放进对象 `base`，并给 `SceneParticleObject` / `SceneTextObject` 补字段类型。
> 同一轮实测：`general.cameraparallax` 在本机 34 张里**只有 1 张为 `true`（`3793620838`）**、33 张为 `false` ⇒ Task 5 的视差视觉验收**必须用 `3793620838`**（原计划写的 `1280029027` 是 `false`，照它验收会白跑）；其余 33 张上视差无可见效果，须在文档中如实写明。

- [ ] **Step 1: 写失败测试** `tests/scene-json-parallax.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { parseSceneJson } from '../src/client/scene-json.js';

// 字段形态抄自本机真实 scene.json 副本（research/*-scene.json），此处内联以免依赖 gitignore 目录。
const scene = (extra: Record<string, unknown> = {}) => JSON.stringify({
  general: {
    cameraparallax: true, cameraparallaxamount: 0.5,
    cameraparallaxdelay: 0.1, cameraparallaxmouseinfluence: 1,
    orthogonalprojection: { width: 2400, height: 1555 },
  },
  objects: [{
    id: 12, name: 'bg', image: 'models/bg.json',
    origin: '1200.00000 777.50000 0.00000', size: '2400.00000 1555.00000',
    parallaxDepth: '1.00000 1.00000', ...extra,
  }],
});

describe('scene.json 视差字段', () => {
  it('读 general.cameraparallax* 与对象 parallaxDepth', () => {
    const d = parseSceneJson(scene());
    expect(d.parallax).toEqual({ enabled: true, amount: 0.5, delay: 0.1, mouseInfluence: 1 });
    const obj = d.objects[0];
    expect(obj.kind).toBe('image');
    expect(obj.kind === 'image' && obj.parallaxDepth).toEqual([1, 1]);
  });
  it('缺 parallaxDepth → undefined（不误开视差）', () => {
    const d = parseSceneJson(scene({ parallaxDepth: undefined }));
    expect(d.objects[0].kind === 'image' && d.objects[0].parallaxDepth).toBeUndefined();
  });
  it('缺 general 视差字段 → 全缺省', () => {
    const d = parseSceneJson(JSON.stringify({ objects: [] }));
    expect(d.parallax).toEqual({ enabled: false, amount: 0, delay: 0, mouseInfluence: 0 });
  });
  it('只有一轴非零也保留（另一轴 0 = 该轴不动）', () => {
    const d = parseSceneJson(scene({ parallaxDepth: '0.00000 2.00000' }));
    expect(d.objects[0].kind === 'image' && d.objects[0].parallaxDepth).toEqual([0, 2]);
  });
  it('畸形 parallaxDepth（空串 / 非字符串）→ undefined', () => {
    expect(parseSceneJson(scene({ parallaxDepth: '' })).objects[0]).toMatchObject({ kind: 'image' });
    expect((parseSceneJson(scene({ parallaxDepth: '' })).objects[0] as any).parallaxDepth).toBeUndefined();
    expect((parseSceneJson(scene({ parallaxDepth: 5 })).objects[0] as any).parallaxDepth).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/scene-json-parallax.test.ts --reporter=basic`
Expected: FAIL —— `d.parallax` 为 `undefined`

- [ ] **Step 3: 改 `shared/types.ts`**

`SceneImageObject` 追加：

```ts
  /** WE 对象级视差深度（scene.json `parallaxDepth`，两根轴）；缺省 = OWE 的 {0,0} ⇒ 不参与视差。 */
  parallaxDepth?: [number, number];
```

`SceneDescription` 追加：

```ts
  /** 相机视差总配置（scene.json `general.cameraparallax*`，缺省全 0）。 */
  parallax: ParallaxConfig;
```

（`ParallaxConfig` 由本 Task 1 Step 3 定义在 `src/shared/types.ts`；`parallax.ts` `import type` 后 re-export，client 侧一律从 `parallax.js` 取，避免两处声明漂移。**不得**让 `shared/types.ts` import `client/`。）

- [ ] **Step 4: 改 `scene-json.ts`**

在文件里的 `size2` / `optNum` 附近加一个与 `vec3` 同族的解析器：

```ts
// WE 对象级 parallaxDepth：两根轴的空格分隔字符串（与 origin/size 同形）；缺省/畸形 → undefined。
function optNum2(s: unknown): [number, number] | undefined {
  if (typeof s !== 'string') return undefined;
  const p = s.trim().split(/\s+/).map(Number);
  if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return undefined;
  return [p[0], p[1]];
}
```

image 分支（`:211-220` 的返回对象）加一行：

```ts
        parallaxDepth: optNum2(o.parallaxDepth),
```

返回对象（`:265-282`）加：

```ts
    // 相机视差总开关与系数（general.cameraparallax*）；缺省全 0 = 与加此功能前观感一致。
    parallax: readParallaxConfig(gen),
```

并在文件顶部 `import { readParallaxConfig } from './parallax.js';`（`ParallaxConfig` 类型按 Step 3 的落点从 `../shared/types.js` import）。

- [ ] **Step 5: 跑测试（含既有 scene-json 测试，确认无回归）**

Run: `npx vitest run tests/scene-json-parallax.test.ts tests/scene-json.test.ts --reporter=basic`
Expected: PASS（既有 scene-json 测试若做整对象 `toEqual`，需在期望值里补 `parallax` 字段 —— 这是**预期内**的同步改动）

- [ ] **Step 6: 提交**

```bash
git add src/shared/types.ts src/client/scene-json.ts src/client/parallax.ts tests/scene-json-parallax.test.ts tests/scene-json.test.ts
git commit -m "feat(parallax): 解析 general.cameraparallax* 与对象 parallaxDepth"
```

---

### Task 3: 指针输入模块

**Files:**
- Create: `src/client/pointer-input.ts`
- Test: `tests/pointer-input.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `PointerState` / `POINTER_CENTER`
- Produces: `createPointerTracker(opts?: { target?: EventTarget; viewport?: () => { width: number; height: number } }): { install(): void; dispose(): void; target(): PointerState }`

- [ ] **Step 1: 写失败测试** `tests/pointer-input.test.ts`

```ts
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createPointerTracker } from '../src/client/pointer-input.js';

function move(x: number, y: number) {
  const ev = new Event('pointermove') as any;
  ev.clientX = x; ev.clientY = y;
  window.dispatchEvent(ev);
}

describe('pointer-input', () => {
  it('按视口归一化到 [0,1]，越界夹紧', () => {
    const t = createPointerTracker({ viewport: () => ({ width: 1000, height: 500 }) });
    t.install();
    expect(t.target()).toEqual({ x: 0.5, y: 0.5 }); // 未移动 = 居中（OWE 缺省）
    move(250, 125);
    expect(t.target()).toEqual({ x: 0.25, y: 0.25 });
    move(-50, 9999);
    expect(t.target()).toEqual({ x: 0, y: 1 });
    t.dispose();
  });
  it('幂等安装：重复 install 只留一个监听；dispose 后不再更新', () => {
    const t = createPointerTracker({ viewport: () => ({ width: 100, height: 100 }) });
    t.install(); t.install();
    move(50, 50);
    expect(t.target()).toEqual({ x: 0.5, y: 0.5 });
    t.dispose();
    move(10, 10);
    expect(t.target()).toEqual({ x: 0.5, y: 0.5 });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/pointer-input.test.ts --reporter=basic`
Expected: FAIL

- [ ] **Step 3: 实现** `src/client/pointer-input.ts`

```ts
// 指针输入 → 归一化 [0,1]（y 向下，与 WE/OWE 的 pointer 约定一致；见 parallax.ts 的符号约定）。
// 只做采集，不做插值（插值在 parallax.advancePointer，逐帧按 dt 推进）。
// 幂等装/卸：HMR 重挂不得叠加监听（AGENT.md §5.43）。
import { POINTER_CENTER } from './parallax.js';
import type { PointerState } from './parallax.js';

export interface PointerTracker {
  install(): void;
  dispose(): void;
  target(): PointerState;
}

export function createPointerTracker(opts: {
  target?: EventTarget;
  viewport?: () => { width: number; height: number };
} = {}): PointerTracker {
  const host = opts.target ?? (typeof window !== 'undefined' ? window : null);
  const viewport = opts.viewport ?? (() => ({
    width: typeof window === 'undefined' ? 0 : window.innerWidth || 0,
    height: typeof window === 'undefined' ? 0 : window.innerHeight || 0,
  }));
  let current: PointerState = { ...POINTER_CENTER };
  let installed = false;
  const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const onMove = (ev: Event) => {
    const e = ev as PointerEvent;
    const { width, height } = viewport();
    if (!(width > 0) || !(height > 0)) return;
    current = { x: clamp01(Number(e.clientX) / width), y: clamp01(Number(e.clientY) / height) };
  };
  return {
    install() {
      if (installed || !host) return;
      installed = true;
      host.addEventListener('pointermove', onMove, { passive: true });
    },
    dispose() {
      if (!installed || !host) return;
      installed = false;
      host.removeEventListener('pointermove', onMove);
      current = { ...POINTER_CENTER };
    },
    target() { return current; },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/pointer-input.test.ts --reporter=basic`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/client/pointer-input.ts tests/pointer-input.test.ts
git commit -m "feat(parallax): 指针输入归一化模块（幂等装卸）"
```

---

### Task 4: 逐帧应用视差（player）

**Files:**
- Modify: `src/client/threejs-player.ts`（`BackgroundEntry` 类型 `:28-42`、`addBackground` `:1098-1160`、`loadSceneToThree` 的 image/text 分支 `:1975-2033`、`installLoop` `:812-834`、类字段 `:597` 附近）
- Test: `tests/threejs-player.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1/2
- Produces（`ThreeScenePlayer` 新方法）:
  - `setParallax(cfg: ParallaxConfig | null): void`
  - `setParallaxPointer(p: PointerState): void`
  - 内部 `private tickParallax(dt: number): void`（在 `installLoop` 的 `this.update(dt)` 之后调用）
  - `addBackground` 新增可选入参 `parallaxDepth?: [number, number]`

- [ ] **Step 1: 写失败测试**（追加到 `tests/threejs-player.test.ts`）

```ts
describe('视差逐帧应用', () => {
  function makePlayer() {
    const canvas = document.createElement('canvas');
    const renderer = { setAnimationLoop: vi.fn(), setPixelRatio: vi.fn(), setSize: vi.fn(), render: vi.fn(), domElement: canvas } as any;
    return new ThreeScenePlayer(canvas, 1920, 1080, renderer);
  }
  it('depth 非 0 的对象按 shift 平移；depth 0 的对象保持原位', () => {
    const p = makePlayer();
    const idA = p.addBackground({ origin: [960, 540, 0], size: [100, 100], scale: [1, 1, 1], sceneW: 1920, sceneH: 1080, parallaxDepth: [1, 1] });
    const idB = p.addBackground({ origin: [960, 540, 0], size: [100, 100], scale: [1, 1, 1], sceneW: 1920, sceneH: 1080 });
    p.setParallax({ enabled: true, amount: 1, delay: 0, mouseInfluence: 1 });
    p.setParallaxPointer({ x: 1, y: 0.5 });
    p.tickParallaxForTest(0.016);
    const a = p.backgroundMeshForTest(idA);
    const b = p.backgroundMeshForTest(idB);
    expect(a.position.x).toBeCloseTo(-1920 / 2, 3); // 鼠标右移 → 向左
    expect(b.position.x).toBeCloseTo(0, 6);         // depth 缺失 → 不动
  });
  it('关掉视差后对象回到基准位置', () => {
    const p = makePlayer();
    const id = p.addBackground({ origin: [960, 540, 0], size: [100, 100], scale: [1, 1, 1], sceneW: 1920, sceneH: 1080, parallaxDepth: [1, 1] });
    p.setParallax({ enabled: true, amount: 1, delay: 0, mouseInfluence: 1 });
    p.setParallaxPointer({ x: 1, y: 1 });
    p.tickParallaxForTest(0.016);
    p.setParallax({ enabled: false, amount: 0, delay: 0, mouseInfluence: 0 });
    p.tickParallaxForTest(0.016);
    expect(p.backgroundMeshForTest(id).position.x).toBeCloseTo(0, 6);
    expect(p.backgroundMeshForTest(id).position.y).toBeCloseTo(0, 6);
  });
});
```

同时在该测试文件顶部已有的测试辅助手法里加两个**仅测试用**的读接口到 `ThreeScenePlayer`（见 Step 3 最后一段）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/threejs-player.test.ts -t "视差" --reporter=basic`
Expected: FAIL —— `tickParallaxForTest is not a function`

- [ ] **Step 3: 改 `threejs-player.ts`**

顶部补 import（`ParallaxConfig` / `PointerState` / `PointerFollow` / `POINTER_CENTER` / `advancePointer` / `parallaxShift` 全部来自 `./parallax.js`）。

`BackgroundEntry`（`:28-42`）追加两个字段：

```ts
  // 视差：node = 实际承载世界位置的 three 对象（非隔离 = mesh，隔离 = 合成 quad）；
  // depth 来自 scene.json 的 parallaxDepth（缺省 undefined = 不参与视差）。
  parallaxNode: THREE.Object3D;
  parallaxDepth?: [number, number];
```

`addBackground` 入参（`:1086-1097` 的 opts 类型）追加 `parallaxDepth?: [number, number];`，并在 `:1147` 的 `backgroundEntries.set(id, { … })` 里补：

```ts
      parallaxNode: opts.isolate ? (this.isolated.get(opts.isolate.objectId)?.quad ?? mesh) : mesh,
      parallaxDepth: opts.parallaxDepth,
```

> `this.isolated` 的写入点在 `attachIsolated`（`:1327-1330`，含 `quad`），`addBackground` 在 `:1135` 调它之后才 `backgroundEntries.set` ⇒ 取得到 quad。

类字段处（`:597` 附近）加：

```ts
  // 视差状态：配置 + 目标指针 + 跟随值（插值状态），全部为 null 时逐帧零成本。
  private parallaxCfg: ParallaxConfig | null = null;
  private parallaxTarget: PointerState = { ...POINTER_CENTER };
  private parallaxFollow: PointerFollow = { value: { ...POINTER_CENTER }, elapsed: 0 };
```

新方法（放在 `update()` 附近）：

```ts
  /** 相机视差配置（null = 关闭）。关闭时下一帧把对象写回基准位置。 */
  setParallax(cfg: ParallaxConfig | null): void { this.parallaxCfg = cfg; }

  /** 宿主指针监听的最新归一化位置（[0,1]）；插值在本类的 tickParallax 内按 dt 推进。 */
  setParallaxPointer(p: PointerState): void { this.parallaxTarget = p; }

  /** 逐帧：推进指针插值并按 depth 写对象位置（隔离对象写合成 quad）。 */
  private tickParallax(dt: number): void {
    const cfg = this.parallaxCfg;
    if (!cfg) return;
    this.parallaxFollow = advancePointer(this.parallaxFollow, this.parallaxTarget, cfg, dt);
    for (const entry of this.backgroundEntries.values()) {
      const x = entry.origin[0] - entry.sceneW / 2;
      const y = entry.origin[1] - entry.sceneH / 2;
      const z = entry.origin[2];
      if (!cfg.enabled || !entry.parallaxDepth) {
        entry.parallaxNode.position.set(x, y, z);
        continue;
      }
      const [sx, sy] = parallaxShift({
        pointer: this.parallaxFollow.value,
        // OWE 的 ortho 是**场景**正交尺寸（general.orthogonalprojection），不是窗口尺寸。
        orthoW: this.sceneWidth,
        orthoH: this.sceneHeight,
        nodeX: x, nodeY: y,
        // three 坐标下主相机位于场景中心（we_to_three 已把中心移到原点）。
        camX: 0, camY: 0,
        depth: entry.parallaxDepth,
        cfg,
      });
      entry.parallaxNode.position.set(x + sx, y + sy, z);
    }
  }
```

⚠️ **隔离对象的旋转**：合成 quad 的 `rotation` 由 `attachIsolated` 设置且**不受视差影响**（OWE 也是 `Translation * model`，平移在旋转之前 = 沿世界轴）。本步骤只写 `position`，不得碰 `rotation`/`scale`。

`installLoop`（`:816-833`）在 `this.update(dt)` 之后、`this.render()` 之前插入：

```ts
        this.update(dt);
        this.tickParallax(dt);   // 视差是纯位置写入：无配置时立即返回
        this.render();
```

`loadSceneToThree` 的 image 分支（`:1979-1999`）与 text 分支（`:2009-2020`）把 `parallaxDepth` 传进去：

```ts
        parallaxDepth: obj.kind === 'image' ? obj.parallaxDepth : undefined,
```

测试读接口（仅测试用，命名带 `ForTest` 后缀以免被误当生产 API）：

```ts
  /** 测试用：取某背景条目的 three 对象（隔离对象返回合成 quad）。 */
  backgroundMeshForTest(id: number): THREE.Object3D { return this.backgroundEntries.get(id)!.parallaxNode; }
  /** 测试用：直接推进一帧视差。 */
  tickParallaxForTest(dt: number): void { this.tickParallax(dt); }
```

- [ ] **Step 4: 粒子层视差（同一 Task 内）**

粒子对象的视差应进粒子顶点 shader（它是对象局部的世界平移，等价于给 `worldPos` 加偏移）。两步：

**① shader（确定的部分）**：在 `PARTICLE_VERTEX_SHADER` 顶部加 uniform，并在 `worldPos` 组装完成之后、`gl_Position` 之前加偏移：

```glsl
uniform vec2 u_Parallax;   // 对象级视差的世界平移（0 = 关）
…
  worldPos.x += u_Parallax.x;
  worldPos.y += u_Parallax.y;
```

**② 逐帧赋值**：先确认粒子层的容器字段名（不同实现的命名不同，别照抄本计划）：

```bash
grep -n "private particle\|particleEntries\|particleLayers" src/client/threejs-player.ts
```

用查到的那个字段（本步骤下称 `this.particleLayerList`），其元素必须有 `material` 与对象的 `origin`；若元素里没有 `parallaxDepth`，在 `addParticle` 的 opts 类型与 `loadSceneToThree` 的粒子分支（`:2034` 起）各加一个 `parallaxDepth?: [number, number]` 并透传。然后在 `tickParallax` 末尾加：

```ts
    // 粒子层：视差作为世界平移注入顶点 shader（与对象的 model 平移语义一致）。
    for (const layer of this.particleLayerList) {
      const u = (layer.material.uniforms as Record<string, { value: THREE.Vector2 }>).u_Parallax;
      if (!u) continue;
      const depth = layer.parallaxDepth;
      if (!cfg.enabled || !depth) { u.value.set(0, 0); continue; }
      const x = layer.origin[0] - this.sceneWidth / 2;
      const y = layer.origin[1] - this.sceneHeight / 2;
      const [sx, sy] = parallaxShift({
        pointer: this.parallaxFollow.value, orthoW: this.sceneWidth, orthoH: this.sceneHeight,
        nodeX: x, nodeY: y, camX: 0, camY: 0, depth, cfg,
      });
      u.value.set(sx, sy);
    }
```

- [ ] **Step 5: 跑测试与类型检查**

Run: `npx vitest run tests/threejs-player.test.ts --reporter=basic && pnpm exec tsc -p tsconfig.json --noEmit`
Expected: PASS / 无类型错误

- [ ] **Step 6: 提交**

```bash
git add src/client/threejs-player.ts tests/threejs-player.test.ts
git commit -m "feat(parallax): player 逐帧应用对象视差（含隔离 quad 与粒子 uniform）"
```

---

### Task 5: 视差接线 + 真机验收

**Files:**
- Modify: `src/client/three-renderer.ts`（装配区 `:393-446`、`:647-680`、`teardown` `:281-318`）
- Modify: `AGENT.md`（§2.1/§2.3 各一条）

**Interfaces:**
- Consumes: Task 1-4
- Produces: 渲染器内部接线（无新对外 API）

- [ ] **Step 1: 接线**

`three-renderer.ts` 顶部：

```ts
import { createPointerTracker } from './pointer-input.js';
```

在 renderer 闭包内（与 `onWindowResize` 同域）加：

```ts
  // 指针：整个 renderer 生命周期一个 tracker（幂等装/卸），每次 render 把最新值下发给 player。
  const pointer = createPointerTracker();
```

`render()` 内装配完成、`result.player.setGlowStage(...)` 附近加：

```ts
        // 相机视差：配置来自 scene.json（缺省全 0 = 与加此功能前观感一致）。
        result.player.setParallax(desc.parallax);
        pointer.install();
        pointerTrackerInstalled = true;
```

并把指针值逐帧下发（挂在 `assets.onFrame` 的包装里，与 Task 2 的看护打点同一处）：

```ts
        const userOnFrame = assets.onFrame;
        assets.onFrame = (dt: number) => {
          current?.player.setParallaxPointer(pointer.target());
          userOnFrame?.(dt);
        };
```

`teardown`（`:281-318`）里补 `pointer.dispose();`（tracker 自身幂等，重复调用安全）。

- [ ] **Step 2: 单测确认装配期不炸**

Run: `npx vitest run tests/three-renderer.test.ts --reporter=basic`
Expected: PASS（jsdom 里 `pointermove` 不触发，`pointer.target()` 恒居中 ⇒ 视差为 0）

- [ ] **Step 3: 真机验收（视差）**

```bash
npm run build && npm run build:client   # lib/ 与 dist/client.js
# 重启 dsh web（host 侧改动不热重载），强刷 GUI
```

在 GUI 里逐条核对（写进 `TESTING.md`）：

1. 选 **`3793620838`**（本机 34 张里**唯一** `general.cameraparallax: true` 的壁纸；其余 33 张为 false，视差在那些壁纸上无可见效果、属预期）→ 鼠标在窗口内移动，画面**整体**轻微反向漂移；鼠标停下后画面**平滑收尾**（`delay` 的滞后感）。
2. 选一张 `general.cameraparallax=false` 的壁纸 → **完全不动**（零回归）。
3. 同一张壁纸里 `parallaxDepth` 为 `0 0` 的对象不动、非 0 的对象动（用 Chrome DevTools 的 Layers/像素对比确认「不是整屏平移」）。
4. 切到别的壁纸再切回来 → 视差仍然工作（tracker 未被重复安装或提前卸载）。
5. 暂停壁纸（面板「暂停」）→ 鼠标移动画面不动（帧循环停了，视差随之停）。

- [ ] **Step 4: 提交**

```bash
git add src/client/three-renderer.ts AGENT.md lib dist
git commit -m "feat(parallax): 渲染器接线指针追踪与逐帧下发"
```

---

### Task 6: `.mdl` 解析器

**Files:**
- Create: `src/client/mdl-parser.ts`
- Test: `tests/mdl-parser.test.ts`（夹具在测试里构造）

**Interfaces:**
- Consumes: 无
- Produces:
  - `interface MdlMesh { positions: Float32Array; uvs: Float32Array; blendIndices: Uint16Array | null; blendWeights: Float32Array | null; indices: Uint16Array; vertexCount: number; materialPath: string }`
  - `interface MdlBone { index: number; parent: number; bind: Float32Array }`（16 元素，**列主序**）
  - `interface MdlKeyframe { pos: [number, number, number]; rot: [number, number, number, number]; scale: [number, number] }`
  - `interface MdlTrack { boneId: number; keys: MdlKeyframe[] }`
  - `interface MdlAnimation { id: number; name: string; mode: string; fps: number; frameCount: number; tracks: MdlTrack[] }`
  - `interface MdlPuppet { version: string; mesh: MdlMesh; bones: MdlBone[]; animations: MdlAnimation[] }`
  - `type MdlParseResult = { ok: true; puppet: MdlPuppet } | { ok: false; error: string }`
  - `parseMdl(buf: Uint8Array): MdlParseResult`
  - `const MDL_VERTEX_STRIDE = 80`（MDLV0021/0023 打包族）

- [ ] **Step 1: 写失败测试** `tests/mdl-parser.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { MDL_VERTEX_STRIDE, parseMdl } from '../src/client/mdl-parser.js';

// ── 夹具：在测试里构造最小合法 MDLV0021 + MDLS0004 + MDLA0006 ──────────────────
// 布局按上游 mdl-parse.js 的文档化段结构（本文件即「解析器 ↔ 夹具」的同一份口径）。
function buildMdlFixture(): Uint8Array {
  const vertices = new DataView(new ArrayBuffer(MDL_VERTEX_STRIDE * 3));
  for (let i = 0; i < 3; i++) {
    const o = i * MDL_VERTEX_STRIDE;
    vertices.setFloat32(o, i, true); vertices.setFloat32(o + 4, i * 2, true); vertices.setFloat32(o + 8, 0, true);
    for (let k = 0; k < 4; k++) vertices.setUint32(o + 40 + k * 4, i, true);          // boneIdx：三角各绑一根骨
    vertices.setFloat32(o + 56, 1, true);                                            // weights[0] = 1
    vertices.setFloat32(o + 72, i / 2, true); vertices.setFloat32(o + 76, 0.5, true); // uv
  }
  const indices = new Uint16Array([0, 1, 2]);

  const parts: number[] = [];
  const push = (bytes: number[]) => parts.push(...bytes);
  const pushStr = (s: string) => { for (const ch of s) parts.push(ch.charCodeAt(0)); parts.push(0); };
  const pushU32 = (v: number) => parts.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
  const pushI32 = (v: number) => pushU32(v >>> 0);
  const pushF32 = (v: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); push([...b]); };

  pushStr('MDLV0021');                       // 0..8（8 字符 + 本应有 NUL，此处 9 字节由 pushStr 给出）
  // 头部：材质路径（零结尾）+ 32 字节偏移后的顶点字节数（MDLV0021 族）
  pushStr('materials/m.json');
  for (let i = 0; i < 32; i++) parts.push(0);
  pushU32(MDL_VERTEX_STRIDE * 3);
  push([...new Uint8Array(vertices.buffer)]);
  pushU32(indices.byteLength);
  push([...new Uint8Array(indices.buffer)]);

  // MDLS0004：magic(9) + u32 段尾 + u32 骨数；每骨 u8 flag + u32 id + i32 parent + u32 matSize + f32[16] + cstr json
  pushStr('MDLS0004');
  pushU32(0); pushU32(2);
  const bone = (id: number, parent: number, tx: number) => {
    push([0]); pushU32(id); pushI32(parent); pushU32(64);
    const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, tx, 0, 0, 1]; // 列主序，平移在 [12..14]
    for (const v of m) pushF32(v);
    pushStr('{}');
  };
  bone(0, -1, 0); bone(1, 0, 5);

  // MDLA0006：magic(9) + u32 段尾 + u32 动画数
  pushStr('MDLA0006');
  pushU32(0); pushU32(1);
  pushU32(7); pushU32(0);                    // id=7 / unk
  pushStr('idle'); pushStr('loop');          // 名称 / 模式
  pushF32(30);                               // fps
  pushU32(2); pushU32(0); pushU32(1);        // frameCount / unk / trackCount
  for (let i = 0; i < 35; i++) parts.push(0); // 固定 35B 填充
  pushU32(1); pushU32(36 * 2);               // track：boneId=1 / trackBytes
  for (const tx of [5, 9]) {                 // 两帧：pos + 四元数 xyzw + scale xy
    pushF32(tx); pushF32(0); pushF32(0);
    pushF32(0); pushF32(0); pushF32(0); pushF32(1);
    pushF32(1); pushF32(1);
  }
  return new Uint8Array(parts);
}

describe('mdl-parser', () => {
  it('解析 MDLV 顶点（stride 80：pos/boneIdx@40/weights@56/uv@72）与索引', () => {
    const r = parseMdl(buildMdlFixture());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { mesh } = r.puppet;
    expect(mesh.vertexCount).toBe(3);
    expect([...mesh.indices]).toEqual([0, 1, 2]);
    expect([...mesh.positions.slice(0, 3)]).toEqual([0, 0, 0]);
    expect([...mesh.positions.slice(3, 6)]).toEqual([1, 2, 0]);
    expect([...mesh.uvs.slice(0, 2)]).toEqual([0, 0.5]);
    expect([...mesh.blendIndices!.slice(0, 4)]).toEqual([0, 0, 0, 0]);
    expect(mesh.blendWeights![0]).toBe(1);
    expect(mesh.materialPath).toBe('materials/m.json');
  });

  it('解析 MDLS 骨骼（父索引 + 列主序绑定矩阵平移）', () => {
    const r = parseMdl(buildMdlFixture());
    if (!r.ok) throw new Error(r.error);
    expect(r.puppet.bones).toHaveLength(2);
    expect(r.puppet.bones[0].parent).toBe(-1);
    expect(r.puppet.bones[1].parent).toBe(0);
    expect(r.puppet.bones[1].bind[12]).toBe(5); // 列主序平移 x
  });

  it('解析 MDLA 动画（id/名称/模式/fps/帧数/轨与 36B 关键帧）', () => {
    const r = parseMdl(buildMdlFixture());
    if (!r.ok) throw new Error(r.error);
    expect(r.puppet.animations).toHaveLength(1);
    const a = r.puppet.animations[0];
    expect([a.id, a.name, a.mode, a.fps, a.frameCount]).toEqual([7, 'idle', 'loop', 30, 2]);
    expect(a.tracks).toHaveLength(1);
    expect(a.tracks[0].boneId).toBe(1);
    expect(a.tracks[0].keys.map((k) => k.pos[0])).toEqual([5, 9]);
    expect(a.tracks[0].keys[1].rot).toEqual([0, 0, 0, 1]);
  });

  it('畸形输入返回结构化错误，绝不抛（含空 buffer / 坏 magic / 截断）', () => {
    expect(parseMdl(new Uint8Array(0)).ok).toBe(false);
    expect(parseMdl(new Uint8Array(16)).ok).toBe(false);
    const bad = buildMdlFixture(); bad[0] = 0x58; // 'X'
    const r = parseMdl(bad);
    expect(r.ok).toBe(false);
    expect(parseMdl(buildMdlFixture().slice(0, 60)).ok).toBe(false);
  });

  it('版本白名单：MDLV0013/0016/0017/0019/0021/0023 之外拒收', () => {
    const buf = buildMdlFixture();
    const ascii = (v: string) => { for (let i = 0; i < 8; i++) buf[i] = v.charCodeAt(i); };
    ascii('MDLV0002');
    expect(parseMdl(buf).ok).toBe(false);
    ascii('MDLV0023');
    expect(parseMdl(buf).ok).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/mdl-parser.test.ts --reporter=basic`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现** `src/client/mdl-parser.ts`

```ts
// WE puppet 模型（.mdl）解析：MDLV（网格）+ MDLS（骨骼）+ MDLA（动画）+ MDLE（绑定姿势扩展）。
// 段布局依据上游 mdl-parse.js（MDLV0021/0023 打包族 stride 80；MDLA0006 头 + 36B 关键帧）
// 与 linux-wallpaperengine CImage.cpp 的版本白名单（只认 0021/0023，本仓放宽到已知常量表）。
// 解析全程自洽校验（长度可整除、索引不越界、权重和为 1），畸形一律返回结构化错误、不抛 ——
// 一张解析不了的 puppet 只能退化成普通贴图，不该拖垮整张壁纸。

export const MDL_VERTEX_STRIDE = 80;
const SUPPORTED_MDLV = ['MDLV0013', 'MDLV0016', 'MDLV0017', 'MDLV0019', 'MDLV0021', 'MDLV0023'];
const KEYFRAME_BYTES = 36; // f32[3] pos + f32[4] quat + f32[2] scale

export interface MdlMesh { … }        // 见 Interfaces
export interface MdlBone { … }
export interface MdlKeyframe { … }
export interface MdlTrack { … }
export interface MdlAnimation { … }
export interface MdlPuppet { … }
export type MdlParseResult = { ok: true; puppet: MdlPuppet } | { ok: false; error: string };

function ascii(buf: Uint8Array, at: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(buf[at + i] ?? 0);
  return s;
}
/** 零结尾 C 字符串（返回 [字符串, 下一个可读位置]）。 */
function cstr(buf: Uint8Array, at: number, limit = buf.length): [string, number] {
  let e = at;
  while (e < limit && buf[e] !== 0) e++;
  let s = '';
  for (let i = at; i < e; i++) s += String.fromCharCode(buf[i]);
  return [s, Math.min(e + 1, limit)];
}
function u32(dv: DataView, at: number): number { return dv.getUint32(at, true); }
function f32(dv: DataView, at: number): number { return dv.getFloat32(at, true); }

export function parseMdl(buf: Uint8Array): MdlParseResult {
  if (!(buf instanceof Uint8Array) || buf.length < 16) return { ok: false, error: 'too-short' };
  const version = ascii(buf, 0, 8);
  if (!version.startsWith('MDLV') || !SUPPORTED_MDLV.includes(version)) {
    return { ok: false, error: 'unsupported-header:' + version };
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // 段起点：向后扫第一个 MDLS/MDLA（网格块必须落在它之前）。
  const nextSegment = (from: number): number => {
    for (let i = from; i + 4 < buf.length; i++) {
      const s = ascii(buf, i, 4);
      if (s === 'MDLS' || s === 'MDLA') return i;
    }
    return buf.length;
  };
  const meshLimit = nextSegment(9);
  const mesh = parseMesh(buf, dv, meshLimit);
  if (!mesh) return { ok: false, error: 'mesh-parse-failed' };
  const bones = parseBones(buf, dv);
  const animations = parseAnimations(buf, dv, bones.length);
  if (bones.length === 0) return { ok: false, error: 'no-bones' };
  return { ok: true, puppet: { version, mesh, bones, animations } };
}
```

`parseMesh`（把参考实现的**扫描式定位**与文档化锚点合起来，先试锚点再退扫描）：

```ts
function parseMesh(buf: Uint8Array, dv: DataView, meshLimit: number): MdlMesh | null {
  const [materialPath, afterMat] = cstr(buf, 9, meshLimit);
  // 候选顶点块起点：文档化锚点（材质串 NUL 之后 + 32）优先，然后退回逐字节扫描
  // （参考实现 research/.../puppet.js 的扫描式定位；两个都要求同一组自洽校验）。
  const candidates: number[] = [afterMat + 32];
  for (let off = 9; off + 12 < meshLimit; off++) candidates.push(off);
  for (const off of candidates) {
    const vertexBytes = u32(dv, off + 4);
    const verticesOffset = off + 8;
    if (vertexBytes === 0 || vertexBytes % MDL_VERTEX_STRIDE !== 0) continue;
    const vertexCount = vertexBytes / MDL_VERTEX_STRIDE;
    if (vertexCount < 3 || vertexCount > 200_000) continue;
    const indexLenOffset = verticesOffset + vertexBytes;
    if (indexLenOffset + 4 > meshLimit) continue;
    const indexBytes = u32(dv, indexLenOffset);
    const indicesOffset = indexLenOffset + 4;
    if (indexBytes === 0 || indexBytes % 2 !== 0 || indexBytes % 6 !== 0) continue;
    if (indicesOffset + indexBytes > meshLimit) continue;
    const indexCount = indexBytes / 2;
    const indices = new Uint16Array(indexCount);
    let bad = 0;
    for (let i = 0; i < indexCount; i++) {
      const v = dv.getUint16(indicesOffset + i * 2, true);
      indices[i] = v;
      if (v >= vertexCount) bad++;
    }
    if (bad > indexCount * 0.02) continue;
    const positions = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    const blendIndices = new Uint16Array(vertexCount * 4);
    const blendWeights = new Float32Array(vertexCount * 4);
    let weightOk = true;
    for (let i = 0; i < vertexCount; i++) {
      const o = verticesOffset + i * MDL_VERTEX_STRIDE;
      positions[i * 3] = f32(dv, o); positions[i * 3 + 1] = f32(dv, o + 4); positions[i * 3 + 2] = f32(dv, o + 8);
      for (let k = 0; k < 4; k++) blendIndices[i * 4 + k] = dv.getUint32(o + 40 + k * 4, true);
      let sum = 0;
      for (let k = 0; k < 4; k++) { const w = f32(dv, o + 56 + k * 4); blendWeights[i * 4 + k] = w; sum += w; }
      if (Math.abs(sum - 1) > 0.05) weightOk = false;
      uvs[i * 2] = f32(dv, o + 72); uvs[i * 2 + 1] = f32(dv, o + 76);
    }
    return {
      positions, uvs,
      blendIndices: weightOk ? blendIndices : null,   // 权重不自洽 ⇒ 按静态网格渲染（不蒙皮）
      blendWeights: weightOk ? blendWeights : null,
      indices, vertexCount, materialPath,
    };
  }
  return null;
}
```

`parseBones`（MDLS0004：`magic(9) + u32 段尾 + u32 骨数` + 每骨 `u8 tmp + u32 id + i32 parent + u32 matSize(64) + f32[16] + cstr`；保留参考实现的「10 字节头变体」容错）：

```ts
function parseBones(buf: Uint8Array, dv: DataView): MdlBone[] {
  const at = indexOfAscii(buf, 'MDLS');
  if (at < 0 || at + 17 > buf.length) return [];
  let p = at + 9 + 4;               // 跳过 magic(9) 与段尾字段
  const boneCount = u32(dv, p); p += 4;
  const bones: MdlBone[] = [];
  for (let b = 0; b < boneCount && bones.length < 512; b++) {
    if (p + 13 > buf.length) break;
    let head = 9, id = u32(dv, p + 1), parent = dv.getInt32(p + 5, true), len = u32(dv, p + 9);
    if (len !== 64) { // 10 字节头变体（tmp 为 u16）
      head = 10; id = u32(dv, p + 2); parent = dv.getInt32(p + 6, true); len = u32(dv, p + 10);
    }
    if (len !== 64 || p + head + len > buf.length) break;
    const bind = new Float32Array(16);
    for (let i = 0; i < 16; i++) bind[i] = f32(dv, p + head + i * 4);
    bones.push({ index: b, parent: parent === -1 ? -1 : parent, bind });
    p += head + len;
    [, p] = cstr(buf, p, buf.length);   // 跳过每骨的 JSON 约束串
  }
  // 父索引必须在范围内（越界按根处理，避免建树时成环）
  for (const bone of bones) if (bone.parent >= bones.length) bone.parent = -1;
  return bones;
}
```

`parseAnimations`（MDLA0006 文档化头 + 35B 填充 + 每轨 `u32 boneId / u32 trackBytes / 36B 关键帧`；`frameCount` 与 `trackBytes/36` 做自洽校验，不符则拒收该动画）：

```ts
function parseAnimations(buf: Uint8Array, dv: DataView, boneCount: number): MdlAnimation[] {
  const at = indexOfAscii(buf, 'MDLA');
  if (at < 0 || at + 17 > buf.length) return [];
  let p = at + 9 + 4;
  const animCount = u32(dv, p); p += 4;
  const out: MdlAnimation[] = [];
  for (let a = 0; a < animCount && out.length < 64; a++) {
    if (p + 8 > buf.length) break;
    const id = u32(dv, p); p += 8;             // u32 id + u32 unk
    let name: string;
    [name, p] = cstr(buf, p);
    let mode: string;
    [mode, p] = cstr(buf, p);
    if (p + 20 + 35 > buf.length) break;
    const fpsRaw = f32(dv, p); p += 4;
    const frameCount = u32(dv, p); p += 4;
    p += 4;                                     // u32 unk
    const trackCount = u32(dv, p); p += 4;
    p += 35;                                    // 固定填充
    const tracks: MdlTrack[] = [];
    let ok = true;
    for (let t = 0; t < trackCount; t++) {
      if (p + 8 > buf.length) { ok = false; break; }
      const boneId = u32(dv, p); const trackBytes = u32(dv, p + 4); p += 8;
      if (trackBytes % KEYFRAME_BYTES !== 0 || p + trackBytes > buf.length || boneId >= boneCount) { ok = false; break; }
      const keyCount = trackBytes / KEYFRAME_BYTES;
      const keys: MdlKeyframe[] = [];
      for (let k = 0; k < keyCount; k++) {
        const o = p + k * KEYFRAME_BYTES;
        keys.push({
          pos: [f32(dv, o), f32(dv, o + 4), f32(dv, o + 8)],
          rot: [f32(dv, o + 12), f32(dv, o + 16), f32(dv, o + 20), f32(dv, o + 24)],
          scale: [f32(dv, o + 28), f32(dv, o + 32)],
        });
      }
      p += trackBytes;
      tracks.push({ boneId, keys });
    }
    if (!ok) break;
    const fps = Number.isFinite(fpsRaw) && fpsRaw > 0 && fpsRaw <= 240 ? fpsRaw : 30;
    if (frameCount > 0 && tracks.length > 0) out.push({ id, name, mode, fps, frameCount, tracks });
  }
  return out;
}

/** 段扫描：找 ASCII 标记（与参考实现同口径，但只在段头位置接受）。 */
function indexOfAscii(buf: Uint8Array, marker: string): number {
  outer: for (let i = 0; i + marker.length <= buf.length; i++) {
    for (let k = 0; k < marker.length; k++) if (buf[i + k] !== marker.charCodeAt(k)) continue outer;
    return i;
  }
  return -1;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/mdl-parser.test.ts --reporter=basic`
Expected: PASS

- [ ] **Step 5: 用本机真实样本做**只读**冒烟（仓库既有 `skipIf` 模式，CI 上自动跳过）**

新增 `tests/mdl-real-library.test.ts`（与既有 `tests/verify-real-library.test.ts` 同一纪律：无库时跳过并告警）：

```ts
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseMdl } from '../src/client/mdl-parser.js';

// 本机唯一样本：死亡搁浅-玛玛（pkg 内 models/20240220213723_1_puppet.mdl，110892 B）。
const PKG = 'D:/Steam/steamapps/workshop/content/431960/3303428996/scene.pkg';
const hasLib = existsSync(PKG);

function readEntry(pkg: Buffer, want: (name: string) => boolean): Uint8Array | null {
  let pos = 16, dataStart = 0;
  const entries: Array<{ name: string; off: number; size: number }> = [];
  while (pos + 4 <= pkg.length) {
    const n = pkg.readUInt32LE(pos);
    if (n <= 0 || n > 1024) { dataStart = pos; break; }
    entries.push({ name: pkg.toString('utf8', pos + 4, pos + 4 + n), off: pkg.readUInt32LE(pos + 4 + n), size: pkg.readUInt32LE(pos + 8 + n) });
    pos += 4 + n + 8;
  }
  const e = entries.find((x) => want(x.name));
  return e ? new Uint8Array(pkg.subarray(dataStart + e.off, dataStart + e.off + e.size)) : null;
}

describe.skipIf(!hasLib)('真实 puppet 样本（本机库）', () => {
  it('解析出门 3303428996 的 MDL（几何 + 骨骼必有；动画数列入日志不作断言）', () => {
    const pkg = readFileSync(PKG);
    const bytes = readEntry(pkg, (n) => n.toLowerCase().endsWith('.mdl'));
    expect(bytes, 'pkg 内应有 .mdl 条目').not.toBeNull();
    const r = parseMdl(bytes as Uint8Array);
    expect(r.ok, r.ok ? '' : (r as { error: string }).error).toBe(true);
    if (!r.ok) return;
    // 几何与骨骼是「解析器能否落到正确段」的硬判据
    expect(r.puppet.mesh.vertexCount).toBeGreaterThan(0);
    expect(r.puppet.bones.length).toBeGreaterThan(0);
    expect(r.puppet.mesh.blendWeights, '打包族应带蒙皮权重').not.toBeNull();
    // 动画：口径未在真实样本上确证前**只记录不断言**（见 AGENT.md §7.39）
    console.log(`[mdl] version=${r.puppet.version} verts=${r.puppet.mesh.vertexCount} bones=${r.puppet.bones.length} anims=${r.puppet.animations.length}`);
  });
});
```

Run: `npx vitest run tests/mdl-real-library.test.ts --reporter=basic`

Expected: 有库时 PASS 并打印一行 `[mdl] version=MDLV0021 verts=… bones=… anims=…`；无库时 **skip**（不进 CI 判红）。

**若 `anims=0`**：说明本机样本的 MDLA 段布局与文档化口径不一致 —— **不要改测试去迁就**，把实测的段头十六进制记进 `AGENT.md` §7.39，并把该壁纸的动画列为未支持（如实标注），Task 8 仍可按「无动画的静态 puppet」交付。

- [ ] **Step 6: 提交**

```bash
git add src/client/mdl-parser.ts tests/mdl-parser.test.ts
git commit -m "feat(puppet): 新增 .mdl 解析器（MDLV/MDLS/MDLA）

段布局按上游 mdl-parse.js 文档化口径；自洽校验 + 结构化错误，畸形不抛。"
```

---

### Task 7: puppet → `THREE.SkinnedMesh` 并接入渲染

**Files:**
- Create: `src/client/puppet.ts`
- Modify: `src/client/scene-assets.ts:68-84`（`resolveImageTexture` → `resolveImageAssets`）、`src/client/three-renderer.ts:404-446`（装配）、`src/client/threejs-player.ts`（`SceneAssets` `:1824-1856`、`addPuppet`、image 分支 `:1975-2000`、`ThreeSceneLoadResult` `:1859-1867`）
- Test: `tests/puppet.test.ts`（新增，jsdom）

**Interfaces:**
- Consumes: Task 6 的 `MdlPuppet`
- Produces:
  - `createPuppetMesh(puppet: MdlPuppet, material: THREE.Material): { mesh: THREE.SkinnedMesh; bones: THREE.Bone[]; skeleton: THREE.Skeleton; animations: MdlAnimation[]; applyFrame(anim: MdlAnimation, frame: number): void; dispose(): void }`
  - `scene-assets.ts`：`resolveImageAssets(id: string, obj: SceneImageObject): Promise<{ texture: THREE.Texture | null; puppetPath: string | null }>`（**取代** `resolveImageTexture`，唯一调用点 `three-renderer.ts:409`）；`fetchMdlBytes(id: string, path: string): Promise<Uint8Array | null>`
  - `SceneAssets.puppetMeshes?: Map<number, PuppetInstance>`；`ThreeSceneLoadResult.puppetLayers: number[]`
  - `ThreeScenePlayer.addPuppet(opts: { objectId, puppet, origin, scale, angles, sceneW, sceneH, renderOrder, parallaxDepth? }): number`

- [ ] **Step 1: 写失败测试** `tests/puppet.test.ts`

```ts
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createPuppetMesh } from '../src/client/puppet.js';
import type { MdlPuppet } from '../src/client/mdl-parser.js';

const puppet: MdlPuppet = {
  version: 'MDLV0021',
  mesh: {
    positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]),
    uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
    blendIndices: new Uint16Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    blendWeights: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
    indices: new Uint16Array([0, 1, 2]),
    vertexCount: 3,
    materialPath: 'materials/m.json',
  },
  bones: [
    { index: 0, parent: -1, bind: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) },
    { index: 1, parent: 0, bind: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1]) },
  ],
  animations: [{
    id: 7, name: 'idle', mode: 'loop', fps: 30, frameCount: 2,
    tracks: [{ boneId: 1, keys: [
      { pos: [5, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1] },
      { pos: [9, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1] },
    ] }],
  }],
};

describe('puppet → SkinnedMesh', () => {
  it('骨骼层级按 parent 建树，根骨挂在 mesh 下', () => {
    const p = createPuppetMesh(puppet, new THREE.MeshBasicMaterial());
    expect(p.bones).toHaveLength(2);
    expect(p.bones[1].parent).toBe(p.bones[0]);
    expect(p.mesh.isSkinnedMesh).toBe(true);
    expect(p.mesh.skeleton.bones).toHaveLength(2);
  });
  it('几何属性名必须是 three 内建 skinIndex/skinWeight', () => {
    const p = createPuppetMesh(puppet, new THREE.MeshBasicMaterial());
    expect(p.mesh.geometry.getAttribute('skinIndex')).toBeTruthy();
    expect(p.mesh.geometry.getAttribute('skinWeight')).toBeTruthy();
    expect(p.mesh.geometry.getAttribute('position')).toBeTruthy();
    expect(p.mesh.geometry.getAttribute('uv')).toBeTruthy();
  });
  it('applyFrame 采样关键帧（帧 0/1 平移 5/9），并写回骨骼本地变换', () => {
    const p = createPuppetMesh(puppet, new THREE.MeshBasicMaterial());
    p.applyFrame(p.animations[0], 0);
    expect(p.bones[1].position.x).toBeCloseTo(5, 5);
    p.applyFrame(p.animations[0], 1);
    expect(p.bones[1].position.x).toBeCloseTo(9, 5);
    // 该骨架没有轨道的骨骼保持绑定姿态（帧间不得被清成 0）
    expect(p.bones[0].position.x).toBeCloseTo(0, 5);
  });
  it('applyFrame 越界帧号被夹到合法区间（不产生 NaN 骨骼）', () => {
    const p = createPuppetMesh(puppet, new THREE.MeshBasicMaterial());
    p.applyFrame(p.animations[0], 99);
    expect(Number.isFinite(p.bones[1].position.x)).toBe(true);
    p.applyFrame(p.animations[0], -1);
    expect(Number.isFinite(p.bones[1].position.x)).toBe(true);
  });
  it('无骨骼权重（blendIndices=null）时退化为静态网格但仍可渲染', () => {
    const staticPuppet: MdlPuppet = { ...puppet, mesh: { ...puppet.mesh, blendIndices: null, blendWeights: null } };
    const p = createPuppetMesh(staticPuppet, new THREE.MeshBasicMaterial());
    expect(p.mesh.isSkinnedMesh).toBe(false);
    expect(p.mesh.geometry.getAttribute('position')).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/puppet.test.ts --reporter=basic`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现** `src/client/puppet.ts`

```ts
// MdlPuppet → three：骨骼层级 + 蒙皮网格 + 关键帧采样。
// 蒙皮矩阵由 three 自动给出（Skeleton 在 bind() 时按当前世界矩阵算 boneInverses，
// 逐帧 = bone.matrixWorld × boneInverse = World(anim) · World(bind)⁻¹，正合 WE 语义）。
// 用 MeshBasicMaterial 这类**内建材质**：three 只对内建材质自动注入蒙皮 shader 代码。
import * as THREE from 'three';
import type { MdlAnimation, MdlKeyframe, MdlPuppet } from './mdl-parser.js';

export interface PuppetInstance {
  mesh: THREE.Mesh | THREE.SkinnedMesh;
  bones: THREE.Bone[];
  skeleton: THREE.Skeleton | null;
  animations: MdlAnimation[];
  applyFrame(anim: MdlAnimation, frame: number): void;
  dispose(): void;
}

function decomposeBind(bone: THREE.Bone, bind: Float32Array): void {
  // MDLS 存的是**列主序**局部矩阵（平移在 [12][13][14]）；three 的 Matrix4.fromArray 也是列主序。
  const m = new THREE.Matrix4().fromArray(Array.from(bind));
  m.decompose(bone.position, bone.quaternion, bone.scale);
}

const _q = new THREE.Quaternion();

export function createPuppetMesh(puppet: MdlPuppet, material: THREE.Material): PuppetInstance {
  const { mesh: data, bones: boneDefs, animations } = puppet;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
  const skinned = Boolean(data.blendIndices && data.blendWeights);
  if (skinned) {
    geometry.setAttribute('skinIndex', new THREE.BufferAttribute(data.blendIndices as Uint16Array, 4));
    geometry.setAttribute('skinWeight', new THREE.BufferAttribute(data.blendWeights as Float32Array, 4));
  }
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));

  // 骨骼树：按 parent 索引建父子（父索引越界在解析期已归一到 -1）。
  const bones: THREE.Bone[] = boneDefs.map(() => new THREE.Bone());
  boneDefs.forEach((def, i) => {
    // 绑定姿态先落到骨骼本地变换，bind() 的逆矩阵据此计算。
    decomposeBind(bones[i], def.bind);
    if (def.parent >= 0 && def.parent < bones.length) bones[def.parent].add(bones[i]);
  });

  let mesh: THREE.Mesh | THREE.SkinnedMesh;
  let skeleton: THREE.Skeleton | null = null;
  if (skinned && bones.length > 0) {
    const sm = new THREE.SkinnedMesh(geometry, material);
    mesh = sm;
    sm.add(bones[0]);           // 根骨挂在网格下（three 的骨骼必须在被渲染的场景图里）
    sm.updateMatrixWorld(true);
    skeleton = new THREE.Skeleton(bones);   // 构造函数按**当前**世界矩阵算 boneInverses = 绑定姿态逆
    sm.bind(skeleton);
  } else {
    mesh = new THREE.Mesh(geometry, material);
  }

  const dispose = () => {
    geometry.dispose();
    material.dispose();
  };

  return {
    mesh, bones, skeleton, animations,
    applyFrame(anim, frame) {
      const last = Math.max(0, anim.frameCount - 1);
      const f = Math.min(Math.max(0, Math.floor(frame)), last);
      const next = Math.min(f + 1, last);
      const t = last === 0 ? 0 : Math.min(Math.max(0, frame - f), 1);
      for (const track of anim.tracks) {
        const bone = bones[track.boneId];
        if (!bone || track.keys.length === 0) continue;
        const a = track.keys[Math.min(f, track.keys.length - 1)];
        const b = track.keys[Math.min(next, track.keys.length - 1)];
        bone.position.set(
          a.pos[0] + (b.pos[0] - a.pos[0]) * t,
          a.pos[1] + (b.pos[1] - a.pos[1]) * t,
          a.pos[2] + (b.pos[2] - a.pos[2]) * t,
        );
        _q.set(a.rot[0], a.rot[1], a.rot[2], a.rot[3]);
        const qb = new THREE.Quaternion(b.rot[0], b.rot[1], b.rot[2], b.rot[3]);
        bone.quaternion.copy(_q).slerp(qb, t);
        bone.scale.set(
          a.scale[0] + (b.scale[0] - a.scale[0]) * t,
          a.scale[1] + (b.scale[1] - a.scale[1]) * t,
          1,
        );
      }
    },
    dispose,
  };
}
```

- [ ] **Step 4: 改 `scene-assets.ts`（单一调用点扩散面最小）**

```ts
/** 一次拿到 image 对象的纹理与 puppet 路径（model JSON 只拉一次）。 */
export async function resolveImageAssets(id: string, obj: SceneImageObject): Promise<{ texture: THREE.Texture | null; puppetPath: string | null }> {
  try {
    const modelResp = await fetch(`/wallpapers/scene/${id}/asset?name=${encodeURIComponent(obj.image)}`);
    if (!modelResp.ok) return { texture: null, puppetPath: null };
    const model = await modelResp.json();
    const puppetPath = typeof model?.puppet === 'string' && model.puppet ? String(model.puppet) : null;
    const matRef: unknown = model?.material;
    if (typeof matRef !== 'string' || !matRef) return { texture: null, puppetPath };
    const matResp = await fetch(`/wallpapers/scene/${id}/asset?name=${encodeURIComponent(matRef)}`);
    if (!matResp.ok) return { texture: null, puppetPath };
    const mat = await matResp.json();
    const texName: unknown = mat?.passes?.[0]?.textures?.[0];
    if (typeof texName !== 'string' || !texName) return { texture: null, puppetPath };
    return { texture: await loadTexTexture(`/wallpapers/scene/${id}/asset?name=${encodeURIComponent(resolveTexPath(matRef, texName))}`), puppetPath };
  } catch {
    return { texture: null, puppetPath: null };
  }
}

/** `.mdl` 原始字节（走既有 scene asset 路由，pkg 内条目）。 */
export async function fetchMdlBytes(id: string, path: string): Promise<Uint8Array | null> {
  const resp = await fetch(`/wallpapers/scene/${id}/asset?name=${encodeURIComponent(path)}`);
  if (!resp.ok) return null;
  return new Uint8Array(await resp.arrayBuffer());
}
```

把 `resolveImageTexture` 从 `scene-assets.ts` 删除，并改 `three-renderer.ts:409` 的调用点（该对象循环里同时收 `puppetMeshes`）：

```ts
          const { texture, puppetPath } = await resolveImageAssets(id, obj);
          if (texture) backgroundTextures.set(obj.id, texture);
          if (puppetPath) {
            const bytes = await fetchMdlBytes(id, puppetPath);
            const parsed = bytes ? parseMdl(bytes) : { ok: false as const, error: 'mdl-fetch-failed' };
            if (parsed.ok) {
              const inst = createPuppetMesh(parsed.puppet, new THREE.MeshBasicMaterial({
                map: texture ?? null, transparent: true, side: THREE.DoubleSide, depthWrite: false,
              }));
              puppetMeshes.set(obj.id, inst);
            } else {
              // 解析/取字节失败 ⇒ 退化成普通背景贴图（本节拍出图来源链的最末一级），并留一条可排查告警
              console.warn(`[three] puppet 解析失败（id=${obj.id} ${puppetPath}）：${parsed.error}`);
            }
          }
```

（`puppetMeshes` 在 `:396` 附近与 `backgroundTextures` 同处新建，并在 `:647` 前后挂进 `assets`。）

- [ ] **Step 5: 改 `threejs-player.ts`**

`SceneAssets` 追加 `puppetMeshes?: Map<number, PuppetInstance>;`（type-only import `puppet.js`，与既有 `GlowStage` / `FrameCapture` 同法）；`ThreeSceneLoadResult` 追加 `puppetLayers: number[]`。

`three-renderer.ts` 需要 three 的**值**导入（`new THREE.MeshBasicMaterial`）：在文件顶部确认/补 `import * as THREE from 'three';`（既有代码若只有 `import type { Texture } from 'three'`，两者并存即可）。

`ThreeScenePlayer` 类字段处（`:597` 附近）加：

```ts
  // puppet 图层：{ 图层 id, 实例, 动画层（已过滤 visible）, 已播时长, 是否已告警多动画层 }
  private puppetLayers: Array<{
    id: number;
    instance: PuppetInstance;
    layers: NonNullable<SceneImageObject['animationLayers']>;
    elapsed: number;
    warned?: boolean;
  }> = [];
```

`teardown()`（`:281-318`）里释放它们：`for (const l of this.puppetLayers) l.instance.dispose();`，然后 `this.puppetLayers.length = 0;`（视差与 puppet 都挂在同一份图层生命周期上，切壁纸即释放）。

新增方法（与 `addBackground` 平行，含视差登记）：

```ts
  /** puppet 图层：SkinnedMesh（带骨骼）+ 视差登记。返回图层 id（与 addBackground 同一编号空间）。 */
  addPuppet(opts: {
    objectId: number;
    puppet: PuppetInstance;
    origin: [number, number, number];
    scale: [number, number, number];
    angles: [number, number, number];
    sceneW: number;
    sceneH: number;
    renderOrder?: number;
    parallaxDepth?: [number, number];
  }): number {
    const { mesh } = opts.puppet;
    mesh.renderOrder = opts.renderOrder ?? 0;
    mesh.scale.set(opts.scale[0], opts.scale[1], opts.scale[2] ?? 1);
    mesh.rotation.set(opts.angles[0], opts.angles[1], opts.angles[2]);
    mesh.position.set(opts.origin[0] - opts.sceneW / 2, opts.origin[1] - opts.sceneH / 2, opts.origin[2]);
    this.scene.add(mesh);
    const id = this.nextBackgroundId++;
    this.backgroundEntries.set(id, {
      mesh, origin: [...opts.origin], size: [0, 0], scale: [...opts.scale], angles: [...opts.angles],
      alpha: 1, brightness: 1, sceneW: opts.sceneW, sceneH: opts.sceneH,
      parallaxNode: mesh, parallaxDepth: opts.parallaxDepth,
    });
    this.puppetLayers.push({ id, instance: opts.puppet, frame: 0 });
    return id;
  }
```

`loadSceneToThree` 的 image 分支（`:1975-2000`）前置判断：

```ts
    if (obj.kind === 'image') {
      const t = world(obj);
      const puppet = assets.puppetMeshes?.get(obj.id);
      if (puppet) {
        const id = player.addPuppet({
          objectId: obj.id, puppet, origin: t.origin, scale: t.scale, angles: t.angles,
          sceneW, sceneH, renderOrder, parallaxDepth: obj.parallaxDepth,
        });
        backgroundIds.push(id);
        puppetLayers.push(id);
        continue;
      }
      …（既有 addBackground 路径不变，只补 parallaxDepth 入参）…
```

`puppetLayers` 是本地数组，最后随 `ThreeSceneLoadResult` 返回（并在 `three-renderer` 的「零可见对象」判定里计入：`result.backgroundIds.length === 0 && result.particleLayers.length === 0 && result.puppetLayers.length === 0`）。

- [ ] **Step 6: 跑测试与类型检查**

Run: `npx vitest run tests/puppet.test.ts tests/threejs-player.test.ts --reporter=basic && pnpm exec tsc -p tsconfig.json --noEmit`
Expected: PASS / 无类型错误

- [ ] **Step 7: 提交**

```bash
git add src/client/puppet.ts src/client/scene-assets.ts src/client/threejs-player.ts src/client/three-renderer.ts tests/puppet.test.ts
git commit -m "feat(puppet): .mdl → three SkinnedMesh 并接入 image 分支

蒙皮矩阵交给 three（bind 时算 boneInverses）；解析失败退化成普通贴图 + 可排查告警。"
```

---

### Task 8: MDLA 动画播放（`animationlayers`）+ 真机验收

**Files:**
- Modify: `src/shared/types.ts`（`SceneImageObject.animationLayers`）、`src/client/scene-json.ts`（image 分支）
- Modify: `src/client/threejs-player.ts`（`puppetLayers` 的逐帧推进）、`src/client/three-renderer.ts`（装配期读 `animationLayers` 下发给 puppet 实例）
- Modify: `AGENT.md`（§2.1/§7）、`TESTING.md`
- Test: `tests/scene-json-animation.test.ts`、`tests/puppet.test.ts`（追加帧推进）

**Interfaces:**
- Consumes: Task 6/7
- Produces:
  - `SceneImageObject.animationLayers?: Array<{ id: number; animation: number; rate: number; blend: number; visible: boolean }>`
  - `PuppetInstance.play(animations, layers)` 语义由此处的调用方（player）逐步推进：`player` 持有 `{ instance, frame, layers }`

- [ ] **Step 1: 写失败测试** `tests/scene-json-animation.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { parseSceneJson } from '../src/client/scene-json.js';

const s = (animationlayers: unknown) => JSON.stringify({
  objects: [{ id: 16, name: 'mama', image: 'models/x.json', origin: '1280 720 0', size: '2560 1440', animationlayers }],
});

describe('animationlayers 解析（OWE ObjectParser.cpp 的字段与缺省）', () => {
  it('读 id/animation/rate/blend/visible，缺省 rate=1 blend=1 visible=false', () => {
    const d = parseSceneJson(s([{ id: 0, animation: 3 }]));
    const o = d.objects[0] as any;
    expect(o.animationLayers).toEqual([{ id: 0, animation: 3, rate: 1, blend: 1, visible: false }]);
  });
  it('无该字段 → undefined；空数组 → []', () => {
    expect((parseSceneJson(s(undefined)).objects[0] as any).animationLayers).toBeUndefined();
    expect((parseSceneJson(s([])).objects[0] as any).animationLayers).toEqual([]);
  });
  it('畸形条目被跳过，不产出半截对象', () => {
    const d = parseSceneJson(s([{ id: 'x' }, { id: 1, animation: 2, visible: true }]));
    expect((d.objects[0] as any).animationLayers).toEqual([{ id: 1, animation: 2, rate: 1, blend: 1, visible: true }]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/scene-json-animation.test.ts --reporter=basic`
Expected: FAIL

- [ ] **Step 3: 解析 + 类型**

`shared/types.ts` 的 `SceneImageObject` 追加：

```ts
  /** WE 动画层（scene.json `animationlayers`）：animation = MDLA 动画 id；visible=false 表示不应用。 */
  animationLayers?: Array<{ id: number; animation: number; rate: number; blend: number; visible: boolean }>;
```

`scene-json.ts` 的 image 分支加：

```ts
        animationLayers: parseAnimationLayers(o.animationlayers),
```

```ts
// WE 动画层：id/animation 必需；rate 缺省 1、blend 缺省 1、visible 缺省 false（OWE ObjectParser.cpp）。
function parseAnimationLayers(raw: unknown): SceneImageObject['animationLayers'] {
  if (!Array.isArray(raw)) return undefined;
  const out: NonNullable<SceneImageObject['animationLayers']> = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    const id = optNum(o.id);
    const animation = optNum(o.animation);
    if (id === undefined || animation === undefined) continue;
    out.push({
      id,
      animation,
      rate: optNum(o.rate) ?? 1,
      blend: optNum(o.blend) ?? 1,
      visible: o.visible === true,
    });
  }
  return out;
}
```

- [ ] **Step 4: 逐帧推进（player）**

`addPuppet` 的登记改为记录动画层与时钟：

```ts
  this.puppetLayers.push({
    id, instance: opts.puppet,
    layers: (opts.animationLayers ?? []).filter((l) => l.visible !== false),
    elapsed: 0,
  });
```

`tickParallax` 之后（或在 `update(dt)` 内、与粒子同处）加 `tickPuppets(dt)`：

```ts
  /** 逐帧：按 animationlayers 的 rate 推进帧号并采样骨骼（v1 只应用第一条可见层，多条时告警一次）。 */
  private tickPuppets(dt: number): void {
    for (const layer of this.puppetLayers) {
      const active = layer.layers[0];
      if (!active) continue;
      const anim = layer.instance.animations.find((a) => a.id === active.animation);
      if (!anim || anim.frameCount <= 0) continue;
      layer.elapsed += dt * Math.max(0, active.rate);
      layer.instance.applyFrame(anim, (layer.elapsed * anim.fps) % anim.frameCount);
      if (layer.layers.length > 1 && !layer.warned) {
        layer.warned = true;
        console.warn(`[three] puppet 图层 ${layer.id} 有 ${layer.layers.length} 条动画层，v1 只应用第一条（${anim.name}）`);
      }
    }
  }
```

`three-renderer.ts` 的 image 装配处把 `obj.animationLayers` 传进 `assets.puppetMeshes`（或在 `loadSceneToThree` 的 `addPuppet` 入参里带上 —— **采用后者**：`addPuppet` 增加 `animationLayers?: SceneImageObject['animationLayers']`，由 image 分支传入）。

- [ ] **Step 5: 跑测试**

Run: `npx vitest run tests/scene-json-animation.test.ts tests/puppet.test.ts tests/threejs-player.test.ts --reporter=basic`
Expected: PASS（`puppet.test.ts` 追加一条：`applyFrame` 用 `(elapsed*fps)%frameCount` 的回绕结果落在 [0, frameCount) 内）

- [ ] **Step 6: 真机验收（puppet）**

```bash
pnpm run build && pnpm run build:client
# 重启 dsh web + 强刷 GUI
```

1. 选 `3303428996`（死亡搁浅-玛玛）→ Console 应出现 `[three] scene loaded id=3303428996 background=N particleLayers=M`（`background` 计数把 puppet 图层算进去）。
2. 画面里角色部件（身体/头发/裙子）应随动画**动起来**，且部件之间**不撕裂**（蒙皮正确）；与桌面 WE 同帧对拍截图比较。
3. 若 Console 出现 `puppet 解析失败` → 记录实际的 MDL 段头十六进制（见 Task 6 Step 5 的冒烟输出），据此决定是补段布局还是如实标注为未支持。
4. 其它 scene 壁纸（非 puppet，占绝大多数）**逐像素零回归**：`npm run e2e:hidpi -- --tag=before`（改动前）→ `--tag=after` → `npm run e2e:compare`。

- [ ] **Step 7: 文档**

`AGENT.md` §2.1 追加：

```markdown
- **puppet 骨骼模型**（2026-10-13）：`image` → `models/*.json` 的 `puppet` 字段 → `.mdl`（MDLV/MDLS/MDLA）→ `THREE.SkinnedMesh` + `Skeleton`；蒙皮矩阵由 three 的 `bind()` 给出（= `World(anim)·World(bind)⁻¹`），MDLA 关键帧逐帧采样写回骨骼。`mdl-parser.ts` 全程自洽校验、畸形返回结构化错误；解析失败**退化成普通贴图**并打一条可排查告警。段布局口径见计划书 Task 6。
- **鼠标视差**（2026-10-13）：`general.cameraparallax*` + 对象 `parallaxDepth`，公式取 OWE `UniformSource.cpp:399-415`（对象 model 矩阵左乘 2D 平移，**相机不动**）；`parallax.ts` 是纯数学层，应用点在 `threejs-player.tickParallax`（隔离对象写合成 quad、粒子走 `u_Parallax` uniform）。
```

`AGENT.md` §7 追加（**如实标注**）：

```markdown
39. **puppet / 视差的已知边界**：① `.mdl` 段布局按上游 `mdl-parse.js` 的文档化口径实现，**只在本机唯一样本 `3303428996` 上验证过**；其它 MDLV 版本（0013/0016/0017/0019/0023）只有合成夹具覆盖，无真实样本 ⇒ 可能整段脚本/绑定姿势（MDLE）失效；② 动画层只应用**第一条可见层**（`blend` 未参与混合）；③ 视差的传播组（父链锚点 + `disablepropagation`）**未实现**，按「每对象自算」近似（`research/audit-parallax-mechanism.md` §7.4 的口径）；④ `parallaxDepth` 缺省时不参与视差 —— WE 对 composite 容器有 `{1,1}` 缺省，本仓未实现该缺省；⑤ puppet 材质走 three 内建材质，WE 的 `colorBlendMode ≠ 0` 与自定义 shader（如 `genericimage4` 的特有分支）**未复刻**；⑥ 无 puppet 的 e2e 自动化判据（只有真机人工验收 + 非 puppet 壁纸的零回归对拍）。
```

`TESTING.md` 增补 Task 5 Step 3 与 Task 8 Step 6 的两份手工验收清单（原文照抄）。

- [ ] **Step 8: 提交**

```bash
git add src/shared/types.ts src/client/scene-json.ts src/client/threejs-player.ts src/client/three-renderer.ts AGENT.md TESTING.md lib dist tests
git commit -m "feat(puppet): 支持 animationlayers 动画播放并记录边界"
```

---

## Self-Review

- **需求覆盖**：咨询选定的「②鼠标视差」（Task 1-5）与「②puppet 骨骼模型全量」（Task 6-8）各自闭环；每个 Task 都有独立可运行的测试与提交点。
- **命名一致性**：`ParallaxConfig` / `PointerState` / `PointerFollow` / `advancePointer` / `parallaxShift`（Task 1）在 Task 2/4/5 引用同名；`MdlPuppet` / `MdlMesh` / `MdlBone` / `MdlAnimation` / `MdlTrack` / `MdlKeyframe` / `parseMdl`（Task 6）在 Task 7/8 引用同名；`PuppetInstance` / `createPuppetMesh` / `applyFrame`（Task 7）在 Task 8 引用同名；`resolveImageAssets` 取代 `resolveImageTexture` 时**唯一调用点**（`three-renderer.ts:409`）在同一 Task 内改完。
- **风险最高的一处已单列**：MDLA 段布局（Task 6 Step 5 的实测冒烟 + 允许「如实标注为未支持」的出口），不把猜测写成事实。
- **未覆盖（已列 §7 遗留）**：视差传播组、多动画层混合、MDLE 绑定姿势、puppet 的 WE 自定义材质分支、puppet e2e 自动化。
