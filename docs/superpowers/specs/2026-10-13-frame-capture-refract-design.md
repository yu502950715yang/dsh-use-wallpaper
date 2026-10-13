# 帧内快照（`_rt_FullFrameBuffer`）与粒子 REFRACT 实现设计

- 日期：2026-10-13
- 分支：`feat/frame-capture-refract`（自 `master` = `951bd7d`）
- 状态：设计已定，待用户审阅 → 转 `docs/superpowers/plans/2026-10-13-frame-capture-refract.md`
- 立案由：壁纸 `2897292240`（THE ART OF DEATH STRANDING）的雨层 #25/#36 在 DSH 里被画成不透明白方块/白竖条，
  WE 里是「玻璃水滴/雨痕」。旧审计（`refract-particles-audit.md`）误判「该层在 WE 里不可见」并建议**跳过**；
  重新调研推翻该结论（实机 A/B 证据见 §1）。

---

## 0. 一句话

把「一次性整场景 `renderer.render`」改为**按 WE 对象序逐段渲染 + 消费者段边界帧内快照**，借此实现两件事：
(a) `2897292240` 的 REFRACT 粒子层按 WE 公式采样背景做位移，画出**玻璃水滴**；
(b) `2597392171` 对象 #50 的 `godrays` 效果链拿到真实的 `_rt_FullFrameBuffer` 背景（不再被静默跳过）。

## 1. 事实与证据（结论已定，勿重查）

| 事实 | 证据 |
|---|---|
| WE 的 REFRACT 输出 = `a·Bg(uv+off) + (1−a)·Bg(uv)`，`off` 是**数十像素**而非亚像素 | `refract-visible-evidence.md`（`genericparticle.frag:103-117`、`common_particles.h:88-106`、`g_RefractAmount` 默认 0.05 于 `:18`） |
| 遮罩 `normal.a` = 槽 1 纹理的 **R 通道**（实测恒 255 ≡ 1）；`normal.x←A`、`normal.y←G` | `refract-normal-channels.txt`、`common_fragment.h:34-49` |
| **实机确证**：WE 里 #25/#36 产生满屏玻璃水滴，隐藏后水滴全部消失；#51/#78 雨幕几乎不可见 | `refract-we-ab-evidence.md` + `we-ab/ab-tower-4way.png`（`|DoG|>8` 密度 0.0189→0.0162；`norain≈noall`） |
| 该层在 DSH 退化成白方块/白竖条：只采 `passes[0].textures[0]`（实测 RGBA 全 255）+ `maskMode=1` ⇒ `shape≡1` | `scene-assets.ts:120`、`threejs-player.ts:443/1405`；#36 `scale.y=30` ⇒ 300–900 单位白竖条 |
| `_rt_FullFrameBuffer` = 「到那一刻为止已绘制的内容」（场景 FBO 本身） | lwe `CScene.cpp:351-361`（按 `m_objectsByRenderOrder` 顺序逐个 `render()`）、`CWallpaper.cpp:319-322` |
| REFRACT 粒子在**画该层前** blit 场景 FBO 到副本 FBO（避免读写同一 FBO） | lwe `CParticle.cpp:2069-2079` |
| WE 对象顺序 ≡ `scene.json` 的 `objects` 数组序（`dependencies` 只做 DFS 前置） | lwe `CScene.cpp:94-101/262-295`；全库 **34/34** 一致，`order`/`zorder` 命中 0，`parallaxDepth` 只用于视差 |
| `2897292240` 的对象序 = **`I P P P P I P P`**（#13 背景 → #25/#36 折射层 → #51/#78 雨幕 → **#3188 前景 image（4 条效果链）** → #3349/#3470 `visible:false`） | `render-order-refactor-survey.md` 全库扫描 + `pkg/2897292240/scene.json` |
| `_rt_FullFrameBuffer` 的**唯一真实消费者** = `2597392171` obj#50 `柯西` 的 `godrays_combine.json` `textures[2]`（`COPYBG=1`，`mix(bg, albedo, albedo.a)`）；现状被跳过 ⇒ 半透明区被压黑 | `refract-rt-consumers.md` |
| workshop 的 `materials/**`+`particles/**`（414 个 json）里 `_rt_` 槽引用 = **0** | 同上（文本 + 裸字节双口径） |

## 2. 目标与非目标

**目标**
1. 帧内快照能力：能在「某个消费者被绘制之前」拿到当前帧已绘制内容的纹理，语义对齐 WE 的场景 FBO。
2. 段渲染骨架：渲染顺序对齐 WE 的对象序（顺带修正 DSH 现行 `image=0/particle=1` 二分造成的层序偏差）。
3. 粒子 REFRACT：`2897292240` 画出 WE 的玻璃水滴。
4. 效果链消费者：`2597392171` 的 godrays `_rt_FullFrameBuffer` 槽拿到快照纹理。

**非目标（见 §8）**：`_rt_imageLayerComposite_*`（对象结果池）、对象材质 `BLENDMODE` 的 `_rt_FullFrameBuffer` 消费点（161 材质）、HDR/HalfFloat 管线、`general.clearcolor` 消费、JSONC 效果文件容错。

## 3. 架构

### 3.1 层序与 `renderOrder` 唯一化

- 每个可渲染对象按 `scene.json objects` 下标得到**全局唯一** `renderOrder`（隔离对象的合成 quad 沿用其宿主对象的下标）。
  现状的三个硬编码值（`threejs-player.ts:962` image=0、`:1448` particle=1、`:1205` quad）由统一分配替代。
- 结果：three 的提交顺序 = WE 的对象序（`dependencies` 全库无反例，DSH 不解析它）。
- **可见变更（须知）**：全库有 7 个「粒子在前、image 在后」的 pkg，叠加次序会变（对齐 WE）。验收时逐张目视确认，**不得当回归**。

### 3.2 段骨架与 `frameRT`

- `frameRT`：**画布缓冲尺寸**（`canvas.width × canvas.height`，dpr 已含），**UnsignedByte**，与 Glow 的 `baseRT` **同选项且共用一张**（Glow 开启时直接用它的；关闭时按同选项自建）。
- 渲染改为逐段 `renderer.render(scene, camera)`：
  - 仅首段之前对 `frameRT` 清屏一次（`clearColor`/`clearAlpha` 与现状默认 fb 一致：黑 + alpha 1），
  - 其余段 `renderer.autoClear = false` 累积（**用 try/finally 局部关闭**；全仓 `autoClear` 从未读写过，`rt-render.ts` 的 4 个调用点依赖它清屏，全局改动会污染对象 RT）。
  - 末段把 `frameRT` 全屏合成到默认 framebuffer（或交给 Glow）。
- **惰性**：无消费者（无 REFRACT 层、无引用 `_rt_FullFrameBuffer` 的效果链）时**完全走现状路径** —— 不建 `frameRT`、不切段、不合成 ⇒ 结构性零回归。
- 段数 = 消费者数 + 1。`2897292240` 为 3 段（背景段 → 快照 → 折射层段 → 雨幕/前景段）；`2597392171` 为 2 段。
- 深度：主场景所有材质 `depthWrite=false`（粒子还 `depthTest=false`），跨段无深度污染；`frameRT` 带 depth，段间保留，与单次渲染一致。

### 3.3 快照 API

新文件 `src/client/frame-capture.ts`：

```ts
export interface FrameCapture {
  // 该帧是否已被使用（有无消费者）——false 时调用方走现状路径
  readonly active: boolean;
  // 在消费者被绘制之前拍一张「当前帧已绘制内容」
  capture(): THREE.Texture;
  resize(width: number, height: number): void;
  dispose(): void;
}
export function createFrameCapture(renderer: THREE.WebGLRenderer, opts?: { rt?: THREE.WebGLRenderTarget }): FrameCapture;
```

- 实现：`THREE.FramebufferTexture`（r170）+ `renderer.copyFramebufferToTexture(tex)`，从当前绑定 framebuffer 复制（同帧内有效、避免读写同一 FBO 的反馈）。
- 快照纹理：`ClampToEdge` + `LinearFilter` + 不生成 mip + **不标 sRGB**（全链路 `outputColorSpace = LinearSRGBColorSpace`，字节域恒等 —— 与 `glow-stage.ts:5-6` 同前提）。
- 每帧至多拍 **消费者数** 次；相邻消费者若在同一段边界则共享一次（由段划分决定）。
- 惰性：`capture()` 首次调用才真正建立 RT/纹理。

### 3.4 Glow

- `glowStage.apply()` 现在自己把主场景渲进 `baseRT`（`glow-stage.ts:291-314`）。改造后：段渲染已经写进 `frameRT`（= 同一张 `baseRT`），Glow 只做 bright-pass + 多级模糊 + 合成。
- Glow 开启时本改动**净开销 ≈ 0**（省掉原本那次主场景渲染）。

### 3.5 隔离对象与对象级效果链

- **隔离体系不动**：挂效果链的对象仍渲进自己的对象 RT（`renderIsolatedContents`，`:900-905`，`rt-render.ts` 透明清屏不变量），主场景只放一张采样该 RT 的合成 quad。
- **效果链执行时机改为「轮到该消费者的段边界时同步执行」**（`objectEffectStage`）：
  - 现状是主渲染前统一 `bindOutputs()`；改造后按段边界触发对应 runner，使链内看到的快照是**本帧该对象之前的内容**（对齐 lwe 的「绘制前 blit」）。
  - 同帧执行必须纳入 object-effects 既有的同一把串行锁，避免 ping-pong 写端错配。
  - `ObjectEffectHost` 增加 `captureFullFrame(): THREE.Texture | null`，`EffectRunner.update` 增加 frameTexture 入参。
- **UV 口径**：WE 的对象链 pass 用对象 RT 的 `v_TexCoord`(`[0,1]`) 直接采全屏场景 FBO ⇒ DSH 同样**直采**整帧快照的同一 UV，**不做对象 rect → 画布 UV 映射**（映射反而是错的）。实现期用 `2597392171` 目视核对（若发现 WE 实为映射，再改；记录为验证点）。

### 3.6 不变量清单（实现与审查都要逐条核）

1. `renderer.autoClear` 只在段渲染范围内被 `try/finally` 临时关闭，退出即恢复原值。
2. `rt-render.ts` 的「透明清屏」行为不变（对象 RT / 效果链 RT 不得残留上一帧）。
3. `resize()`：`frameRT` 与快照纹理跟随 `canvas.width/height`（`:687-690` 不变量）；`dispose()` 释放全部新建 RT/纹理。
4. 无消费者时调用序列与现状**逐字节一致**（单测钉住）。
5. 不引入 `preserveDrawingBuffer`，不重建 renderer（`three-renderer.ts:640` 零改动）。
6. 颜色空间：`frameRT`/快照不标 sRGB，与默认 fb 同域。

## 4. 粒子 REFRACT

### 4.1 解析层（`src/client/scene-assets.ts`）

`ParticleMaterialRef` 扩展（`:96-101`）：

```ts
export interface ParticleMaterialRef {
  texUrl: string | null;
  blending: string | null;
  refract: boolean;              // passes[0].combos.REFRACT === 1
  normalTexUrl: string | null;   // passes[0].textures[1] 经同一条 particle-texture 路由；无则 null
  refractAmount: number;         // passes[0].constantshadervalues.ui_editor_properties_refract_amount ?? 0.05
}
```

- 判据只认 `combos.REFRACT === 1`（WE 权威 combo）；`REFRACT: 0` / 无 `combos` ⇒ `false`（失败开放）。
- 槽 1 拼 URL 与槽 0 **同一条路由** `/wallpapers/particle-texture?id=..&name=..`（pkg 优先；空格/子目录合法），**不加** `materials/` 前缀、**不走** `resolveTexPath`。
- ⚠️ `tests/scene-assets.test.ts:44-47` 的 `toEqual({texUrl, blending})` 全等断言必须同步更新。

### 4.2 装配层（`src/client/three-renderer.ts`）

- 槽 1 用 `loadTexTexture(mat.normalTexUrl)` 加载；与槽 0 同一 `texUv`（帧网格同源），不另算帧网格。
- 传给 `player.addParticle(..., { tex, frameCount, blend, softness, refract: { normalTex, amount } })`。

### 4.3 着色器（`src/client/threejs-player.ts`）

- `material.defines = { REFRACT: 1 }`（仅折射层）；three 的 define 注入与 program cache key 均含 defines（r170），多给的 uniform 由 ACTIVE_UNIFORMS 表忽略。
- 新增 uniform：`refractNormal`（槽 1 纹理，缺省 1×1 白）、`refractBg`（帧快照，缺省 1×1 白）、`refractAmount`（缺省 0.05）。
- 顶点：`vScreenCoord = gl_Position.xyw`；`vScreenTangents = refractAmount * vec4(rRight.x, rUp.x, rRight.y, rUp.y)`，`rRight/rUp` 复用文件内既有 `weObjectRotate`（旋转序与本文件 quad 展开一致；WE 的 `ComputeParticleTangents` 合成序差异写进注释）。
- 片元（照 WE `genericparticle.frag:103-116` 逐行）：

```glsl
vec4 nrm = texture2D(refractNormal, texUv);
float nx = nrm.a * 2.0 - 1.0;   // normal.x ← A
float ny = nrm.g * 2.0 - 1.0;   // normal.y ← G
float mask = nrm.r;             // normal.a ← R
vec2 off = vScreenTangents.xy * nx + vScreenTangents.zw * ny;
off.y = -off.y;
off *= mask * vParticleAlpha;
vec2 rsUv = vScreenCoord.xy / vScreenCoord.z * 0.5 + 0.5 + off;
rgb *= texture2D(refractBg, rsUv).rgb;
```

- 帧序：`render()` 在 `objectEffectStage?.bindOutputs()` 之后、主渲染之前处理折射层段边界（隐藏该层 → 拍快照/段渲染 → 恢复 `visible` → `refractBg` 指向快照）。
- 保真度注记：WE 的 `DecompressNormalWithMask` 在本素材走非 DXT 分支（`fmt=0`），DSH 的 RGBA8888 解码逐字节保真（`tex-loader.ts:557-576`，只翻行不做通道操作）⇒ R/G/A 可直接按上式用。

### 4.4 门槛与降级

| 情形 | 行为 |
|---|---|
| 层挂了效果链（`isolate`） | **不启用** REFRACT define（对象 RT 的裁剪空间 ≠ 屏幕 UV）⇒ 等价 WE 的「不折射」，不报错 |
| 槽 1 缺失/加载失败 | 该层**不可见**（WE 的 `NORMALMAP=0` 语义：`off≡0` ⇒ 输出≡背景），**绝不回退白方块** |
| 快照不可用（无 frame-capture） | 不启用 REFRACT（同上，层不可见），并记一次性诊断日志 |
| `combos.REFRACT ≠ 1` | 完全不进本条路径（零开销、零分歧） |

## 5. 诊断

一条一次性日志：`[three] refract layer=<objId> bg=<w>x<h> amount=<a>`（仿 `threejs-player.ts:1521-1527` 风格），用于真机确认段边界确实发生。

## 6. Ruling 清单（本轮由 Lead 裁决，用户知情）

| # | Ruling | 代价/若判错 |
|---|---|---|
| R1 | 段渲染方案 = 画布尺寸 `frameRT` + 段边界 `copyFramebufferToTexture` 快照 + 末段合成；**不用** `camera.layers`（会污染隔离路径 `localCamera`，对象 RT 变空白）、**不用**多 `THREE.Scene`（破坏 `player.scene` 统一 parent 契约） | 若 r170 的 `FramebufferTexture` 路径在目标 GPU 不可用 → 退化到「per-segment RT」方案（贵一档） |
| R2 | `renderOrder` 按 objects 下标唯一化；段数 = 消费者数 + 1 | 7 个 pkg 叠加次序变化；若用户不接受，改成「只在消费者前后切开、组内保持现状」 |
| R3 | `frameRT` = UnsignedByte 且与 Glow `baseRT` 共用 | 若将来引入 HDR 素材需改 HalfFloat（管线改动） |
| R4 | 效果链在消费者段边界**同帧同步**执行（不沿用「主渲染后 advance」的上一帧快照） | 若与既有串行锁冲突，退化为「该对象不隔离 + 帧末执行」 |
| R5 | 不做「临时近似版」单独上线；但任务顺序让粒子折射尽早可验收 | 用户晚一点看到水滴修复 |
| R6 | `godrays`（`2597392171` obj#50）纳入本轮（能力的真实消费者） | 若其 UV 口径/写端尺寸出现未预期冲突，降级为「能力就绪 + 链维持现状」并另立任务 |
| R7 | `_rt_imageLayerComposite_*`（7 处）出本轮 → 另立任务 | 那 7 处继续维持现状（当前被 `bind=previous` 覆盖，非本次语义） |
| R8 | 对象材质 `BLENDMODE` 的 `_rt_FullFrameBuffer`（161 材质）出本轮 → 另立任务 | 这些壁纸的对象路径仍只读槽 0（现状不变） |
| R9 | 未知/派生 `_rt_` 名（如 `_rt_FullCompoBuffer1_23_40`）维持「白图 + 一次性告警」；顺手修「既是链内 target 又出现在 textures 且无 bind」的邻接 bug（本库 0 实例） | 未知名壁纸仍不正确（现状如此） |
| R10 | 6 个 JSONC 引擎 effect.json 的容错出本轮 → 另立任务 | 引用它们的壁纸整链失效（本库暂无壁纸引用） |
| R11 | 不消费 `general.clearcolor`（现状 = 黑），保持 `frameRT` 清屏与默认 fb 一致 | 有 clearcolor 的壁纸仍与 WE 不同（现状如此） |

## 7. 验收

### 7.1 无 GPU 单测（可全部稳定断言）

| # | 断言 | 落点 |
|---|---|---|
| 1 | 解析三态：`REFRACT=1` ⇒ `refract=true`；`REFRACT=0`/无 `combos` ⇒ `false`；槽 1 缺失 ⇒ `normalTexUrl=null`；`refractAmount` 缺省 0.05 | `tests/scene-assets.test.ts`（改写 `:44`） |
| 2 | 槽 1 走**同一条** particle-texture 路由（pkg 优先、空格/子目录保留） | `tests/scene-assets.test.ts` + `tests/three-renderer.test.ts` |
| 3 | 误伤护栏：`particle/chromaticdot` + additive + 无 `combos` ⇒ **不进** REFRACT 路径 | `tests/scene-assets.test.ts` |
| 4 | RGBA8888 通道保真（R 恒 255 的 mask 不被 rgb 化/预乘） | `tests/tex-loader.test.ts` |
| 5 | **帧序**：有消费者 ⇒ 段渲染次数 = 段数且首段 `target=frameRT`；无消费者 ⇒ 调用序列与现状逐字节一致 | `tests/threejs-player.test.ts:14-39` mock（记录 `{scene,target,clearAlpha}`） |
| 6 | 段内 `visible` 切换成对出现，之后恢复 | 同上（遍历 `player.scene`） |
| 7 | uniform 契约：`refractBg === snapshot`、`refractAmount === 0.05`、`defines.REFRACT === 1`；非折射层 `undefined` | 同上 |
| 8 | RT 生命周期：`resize()` 后尺寸 = `canvas.width/height`；`dispose()` 全部释放 | 同上 + spy |
| 9 | shader 文本契约：片元含 `#ifdef REFRACT`/`texture2D(refractNormal`/`vScreenCoord.xy / vScreenCoord.z`；顶点含 `gl_Position.xyw` 与 `weObjectRotate(vec3(1.0, 0.0, 0.0)` | `tests/threejs-player.test.ts`（纯字符串） |
| 10 | 效果链：`_rt_FullFrameBuffer` 槽拿到 frameTexture（而非 1×1 白） | `tests/effect-runner.test.ts` / `tests/object-effects.test.ts` |
| 11 | 真库对照：`2897292240/halo_50_1.json` ⇒ `refract=true`，全库其余材质 `false` | `tests/verify-real-library.test.ts` 先例 + `refract-scan.json` 基线 |

### 7.2 真机/e2e

- **改动前后对拍（零回归）**：不含消费者的壁纸（如 `3793620838`）逐像素一致（`e2e/verify/compare-shots.mjs`：maxAbs≤1 且差≥2 像素数=0）。**改 `src/` 后必须先 `npm run build`**（`verify-hidpi-object-rt.mjs:128-134` 无 src 重定向，否则测的是旧 `lib/`）。
- **7 个「粒子在前 image 在后」壁纸**：预期有差异，逐张目视确认是改善。
- **`2897292240`**：白方块/白竖条消失；出现 WE 那种玻璃水滴；与 WE A/B 帧（`output/blur-analysis/we-ab/`）并排比对。
- **`2597392171`**：obj#50 `柯西` 半透明区不再被压黑。
- **性能**：`frameRT` 开启与否的帧时/显存记录（`2897292240` 每帧 +N 段渲染 + N 次快照 blit）。
- 全量 `npx vitest run`（基线 **1118**）。

## 8. 不做的事（YAGNI / 另立任务）

1. `_rt_imageLayerComposite_*` 对象结果池（R7）。
2. 对象材质 `BLENDMODE` 的 `_rt_FullFrameBuffer` 消费点（161 材质，R8）。
3. HDR/`HalfFloat` 管线与 bloom 类效果的真实语义。
4. JSONC 效果文件容错（R10）。
5. `general.clearcolor` 消费（R11）。
6. 折射层被隔离时的支持（§4.4 门槛）。
7. 半分辨率 `frameRT` 优化（先测性能再定）。

## 9. 风险与回退

| 风险 | 缓解 |
|---|---|
| 渲染主干重构，一次改坏可能是黑屏/花屏，且难以二分 | 任务按「快照抽象 → 段骨架（恒 1 段，行为应与现状逐像素一致）→ renderOrder 唯一化 → 粒子 REFRACT → 效果链消费者 → 性能调优」渐进，**每步一次全库对拍** |
| `autoClear` 被误全局关闭 ⇒ 对象 RT 残留 | 唯一写入点用 try/finally，单测钉「无消费者调用序列逐字节一致」 |
| `copyFramebufferToTexture` 在 r170 需 `FramebufferTexture`，mock renderer 无此方法 | feature-detect + 明确降级（§4.4），测试用 mock 断言调用契约 |
| Glow 改造引入回归 | 无消费者时 Glow 路径**完全不动**；有消费者时才共用 `frameRT` |
| 7 个 pkg 可见变更被误当回归 | §7.2 显式列出并人工确认 |

**回退**：全部改动集中在一个分支；最坏情况 `git revert` 该分支的合并提交即可（不涉及数据迁移）。

## 10. 证据与工件索引

| 文件 | 内容 |
|---|---|
| `output/blur-analysis/refract-visible-evidence.md` | WE 侧语义、通道、位移量级、数值复现 |
| `output/blur-analysis/refract-we-ab-evidence.md` + `we-ab/` | 实机 A/B（4 组对照、原始帧、4-way 对比图） |
| `output/blur-analysis/refract-dsh-feasibility.md` | DSH 侧落点、GLSL、测试可行性、防坑清单 |
| `output/blur-analysis/render-order-refactor-survey.md` | 管线地图、顺序权威、分段方案对比、回归面 |
| `output/blur-analysis/refract-rt-consumers.md` | `_rt_*` 全库爆炸半径（1 处真实消费者） |
| `research/.lwe/src/WallpaperEngine/Render/**` | lwe 权威实现（`CScene.cpp`、`CParticle.cpp`、`CWallpaper.cpp`） |
| `output/blur-analysis/ds-regression.md` | 本缺陷最初的根因取证 |

---

# 附录 A：执行结果与偏差（2026-10-13 收口回写）

> 本附录**不改上面任何一条原设计**，只如实记录「实际做成了什么、与设计哪里不同、哪些没做」。台账（含全部 Ruling 与 deferred minors）：`.superpowers/sdd/2026-10-13-frame-capture-refract/progress.md`。

## A.1 执行区间与提交

| 任务 | 提交区间 | 说明 |
|---|---|---|
| Setup | `333537f`（spec）、`486740b`（plan） | 分支 `feat/frame-capture-refract` 自 `master` = `951bd7d` |
| T1 FrameCapture 抽象（零接入） | `7a5185d` → `9a9040d` | 含两轮 fix（`capture()` 每次 blit、`reset()`、快照纹理参数、尺寸守卫） |
| T2 `renderOrder` 唯一化 | `3f97f35` | 落点在 `loadSceneToThree`（`three-renderer.ts` 只做资源加载，不改） |
| T3 段渲染骨架 + frameRT + 末段合成 + Glow 共用 | `8ae1d0a` → `cbbbdec` | 含两轮 fix（快照改到消费者段 render **之前**、段划分回到 N+1、capture 按创建它的 renderer 换绑） |
| T4 粒子 REFRACT | `4f13857` | 槽 1 缺失/加载失败 ⇒ **不装配该层**（绝不回退白方块） |
| T5 效果链 `_rt_FullFrameBuffer` | `9e919f1` | 引用该槽的链自动登记为段边界消费者（原接线缺口由实现者内联补齐，Lead 背书） |
| T6 收口（本附录） | 见 `git log`（文档 + 单测） | 全量单测 / deferred minors / 文档回写 / `tsc --noEmit` |

## A.2 实测数字

- **全量单测**：起始 **1118**（本轮之前的基线）→ Task 5 结束 **1190** → 收口后 **1193**（`npx vitest run`：**57 files / 1193 passed**）。T6 新增的 3 条都在补 deferred minor 的钉子（`tests/frame-capture.test.ts` 的快照代号自增、`tests/object-effects.test.ts` 的 resize 作废在途快照、`tests/threejs-player.test.ts` 的 resize 必通知）；另在既有用例里补了非恒真断言（主场景 children 数、快照代号随通知下发、告警文案口径），**没有删除或放宽任何既有断言**。
- **`tsc --noEmit -p tsconfig.json`**：exit 0。
- **真机目视（用户确认，2026-10-13 14:28）**：`2897292240` 的雨层 **白块/白竖条消失，出现水滴/雨痕**。当时的产物状态 = **Task 4**（`npm run build` + `npm run build:client` 重建 `lib/` + `dist/client.js` 后经 DSH client-hmr 热重载），GLSL 真机编译通过（此前只有文本护栏）。⚠️ 该目视**不含** T5 的效果链消费者路径。

## A.3 Ruling 更正（如实记录走过的弯路）

**段划分最终为「仅在消费者之前切一刀」（段数 = 消费者数 + 1）**。执行中期曾按「消费者独占一段（前后各切一刀）」实现，并在台账里作为 Ruling 写下；Task 3 评审核对后指出：那种切法实际段数是 **2N+1**（不是当时记的 N+1），且支撑它的理由（「相邻消费者时后一个的快照会缺前一个已画的内容」）**不成立** —— 正确的对齐点是「快照拍在该消费者段 `render()` **之前**」（lwe `CParticle.cpp:2069-2079`），而这一点在 N+1 切法下同样成立。已改正：`renderSegmented()` 只在消费者处开新段，快照在该段 render 之前拍。R2 的字面（段数 = 消费者数 + 1）**未变**。

## A.4 已知偏差与限制（做完的部分）

| # | 偏差 / 限制 | 影响与状态 |
|---|---|---|
| ① | **效果链的执行时机**：实际是「段边界**同步选取快照** + 帧末 `advance` 推进」，与 §3.5 / R4 的字面（「到该消费者的段边界时同步执行 runner」）不同 | 帧序是 `bindOutputs → 段渲染（通知）→ advance`，快照**同帧**进入 runner（不落后一帧）；单消费者下内容与 R4 **等价**。代价：同一壁纸有 **≥2 个效果链消费者**时会同帧别名到同一张快照。本库只有 1 个（`2597392171` obj#50）⇒ **列为未来工作**（每消费者一份快照拷贝）。Task 5 评审的 Important #1 由 Lead 背书接受。 |
| ② | **Glow 开启时仍多分配一张画布尺寸 `baseRT`**（未与 `frameRT` 共用） | 段渲染路径把 `frameRT` 作为 `preRendered` 传给 `glowStage.apply()`，`baseRT` 那张只被分配、不被使用（§3.2/R3 原意是共用）。**本轮不修**：改动会牵动既有 `rtCount` 断言（`tests/glow-stage.test.ts` 的 7）与 Glow 的失败回退路径 ⇒ 列为**后续优化**。 |
| ③ | **隔离的折射层只关 `REFRACT` define，仍会画自己的槽 0** | `§4.4` 门槛的语义是「不启用 REFRACT define」；被隔离的折射层因此仍会把槽 0（实测 RGBA 全 255 的白图）画进自己的对象 RT。**本库 0 实例**，design §8.6 已列为不做。 |
| ④ | **`FrameCapture` 只有一张快照纹理** | 快照逐帧覆盖 ⇒ 多消费者需要每消费者一份拷贝（与 ① 是同一件事的两面）。本库 1 个消费者，足够。 |
| ⑤ | **本轮只做 `_rt_FullFrameBuffer` 一个名字** | `_rt_imageLayerComposite_*`（对象结果池，**7 处**）、对象材质 `BLENDMODE` 的 `_rt_FullFrameBuffer`（**161 材质**，R8）、6 个 JSONC 引擎 `effect.json` 的容错（R10）、`general.clearcolor` 消费（R11）**均未做**，仍按原行为（白纹 / 留空 + 去重告警 / 黑清屏），**另立任务**。 |

## A.5 未做（本轮不覆盖，交 Lead 与用户统一安排）

- **真机 e2e 逐像素对拍**（无消费者壁纸的零回归，`e2e/verify/compare-shots.mjs`）。
- **性能 / 显存测量**（`2897292240` 段渲染开 / 关的帧时与 `renderer.info.memory`）⇒ 因此「半分辨率 `frameRT`」这条优化项是否必要**尚无数据**（见 A.4 ②）。
- **9 个「粒子在前 image 在后」壁纸的目视**（口径差见 A.6）。
- **产物重建与提交**（`npm run build*` 与 `lib/`、`dist/` 的提交）。
- **客观证据补强**：原计划用项目自带 e2e harness 抓 `2897292240` 帧与 `output/blur-analysis/we-ab/` 的 WE 帧做统计对比（§7.2），本轮未执行。

## A.6 与计划文本的口径差（事实订正）

- plan / 本设计 §3.1 与 §7.2 写的「**7 个** pkg 叠加次序变化」是**未按 `visible` / 稀疏事件源过滤**的口径；Task 2 按实际会变的清单实测为 **9 个**：`1429403119` / `2597392171` / `2897292240` / `2911105183` / `2937346640` / `3743126786` / `3765967112` / `3793620838` / `3789452668`。
- §3.3 的 `createFrameCapture(..., { rt })` **可选注入参数未实现**（T3 自持段目标、Glow 走 `preRendered` 第 4 参，不需要外部注入 RT）；若将来要让 capture 复用外部 RT，需另开一个小改动。
- `tests/verify-real-library.test.ts` 的全库 REFRACT 集合断言**已从「恰为 `[halo_50_1.json]`」改为「∈ 集合 ∧ 与 `refract-scan.json` 基线一致」**：原写法与本文件既有「不钉本机素材快照」的约定冲突（用户装一张新折射壁纸就会假失败）。

## A.7 收口时顺手修的 deferred minors（T6）

1. `tests/threejs-player.test.ts` 里两处仍以 `renderOrder === 0 / === 1` 选「背景 / 粒子」的反模式 ⇒ 改用 `displayObject(13)` / `displayObject(22)`（该反模式在 fixture objects 序恰好为 `[image, particle]` 时才能通过）。
2. 同一文件的 `expect(meshes).toHaveLength(4)` 对 4 元素 `.map()` **恒真** ⇒ 补 `expect(result.player.scene.children).toHaveLength(4)`（证明这些背景确实进了主场景）+ 非 `undefined` 断言。
3. `src/client/dynamic-mesh.ts` 的 `createLayer` 注释（「缺省 1 = 背景之上、与既有粒子同层」）过期 ⇒ 订正为「缺省 1；生产侧映射未接线（延后），脚本自建图层当前恒为 1」。
4. `src/client/threejs-player.ts` 折射顶点注释称 WE `ComputeParticleTangents` 是「先对象角度、后粒子自旋」——**与 WE 相反**（`common_particles.h:26-39` + `genericparticle.vert:85,117` 是粒子自旋在先），与本文件 `:368-370` 自相矛盾 ⇒ 改为「与 WE 同序」。
   - ⚠️ **连带发现（未改，越界）**：`docs/fixes/threejs-path-fixes.md:167` 与 `AGENT.md` §7.3 记的是另一回事 ——「轴序偏差」：本项目 `Rz·Ry·Rx` vs WE `Rz·Rx·Ry`，仅多轴自旋（全库 6 个对象）可能不同。两处口径**并不冲突**（一个是次序、一个是轴序），但 §7.3 那条**仍然成立、未被本轮关闭**。
5. `tests/verify-real-library.test.ts` 的全库 REFRACT 集合断言（见 A.6）。
6. `effect-runner.ts` 的快照不可用告警：① 去掉因果推断（被 `bind` 覆盖的快照槽与快照无关，却会打出「半透明区会被压黑」）；② 点明两条路径的差别（**直接调 `resolveBuiltinTexture` 无快照 → 1×1 白纹** vs **runner 路径无快照 → 槽留空 + 每槽去重告警**）。
7. **`resize()` 与异步 `update` 竞争 ⇒ 一帧黑**（`frame-capture.ts` 的 `dispose()` + 重建 vs 已交给异步串行 update 的快照）：修法 = ① `FrameCapture.snapshotVersion` 在重建/释放时自增，`ObjectEffectStage` 在执行当刻比对并丢弃作废引用（按「无快照」= 既有 null 语义走）；② `player.resize()` 通知 `notifyViewportResize()` 作废在途快照。**已补 3 条能钉住该行为的用例**（见 A.2）。

