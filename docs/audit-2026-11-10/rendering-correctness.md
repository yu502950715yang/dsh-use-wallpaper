# 渲染正确性审查

> 范围：scene 渲染主路径（`threejs-player.ts` / `three-renderer.ts` / 对象效果链四件 / shader 预处理 / 纹理与隔离 RT / 脚本与时间线落点）。
> 方法：**只读**静态审查（HEAD `d5ff886` 工作树），未跑 build/test/e2e。所有 `path:line` 以当前工作树行号为准。
> 判据：① 已知实现中的**新 bug**；② 违反 `AGENT.md` §5 硬约束的代码；③ 静默失败风险；④ 测试未覆盖的边界。**不重复** §7 已记录的功能缺口。
> 标注「待确认」的条目缺真实素材/真机证据，需按建议的判据补测后再定性。

---

## P0（会产生错误画面/崩溃/内存失控）

### P0-1 重叠 `render()` 互相覆盖 `current`：显示中的 player 永不释放，运行时控制作用到未显示画布

- **位置**：`src/client/three-renderer.ts:574`（入口先 `teardown()`）、`:1104`（`current = result`）、`:1579-1585`（`dispose()` 只按闭包 `current` 释放）；控制器侧 `src/client/wallpaper-controller.ts:158`（每次 select 自增 gen）、`:161`（入口 dispose）、`:230`（旧装配完成后直接 `return`，不再 dispose）。
- **触发**：两次 `select()` 重叠（快速点选/轮播定时器与手动切换撞车）。A 的 `render` 慢、B 的 `render` 快：B 先 `current = playerB` 并返回 true；A 随后 `current = playerA` 并返回 true。控制器因 `gen` 不匹配**丢弃 A 的画布**（`wallpaper-controller.ts:230`）且不释放 A 的 player；同时 A 覆盖了 `current`，B 的 player 从此不再被任何路径引用。
- **影响**：① 被丢弃那份的 `player.setAnimationLoop` 永续（RAF + 整场景渲染到已脱离 DOM 的 canvas），场景/RT/纹理/脚本运行时不释放 ⇒ 内存与 GPU 持续失控；② `setPaused` / `setGlow` / `setSoundEnabled` / `captureFrame` / `onWindowResize` / `setMediaIntegration` 全部作用在 `current` 上，即**未显示的那份画布**：暂停不生效、抓帧抓到旧壁纸、resize 改错 canvas（显示中的 canvas 保持旧缓冲，画面被 CSS 拉伸）。快速连点后每丢弃一次泄漏一个完整 player。
- **建议**：`render()` 增加作用域 token（闭包 `renderSession` 自增）：`await` 之后若已被取代，则 `teardownQuietly()` 并 `return false`；或把 player 生命周期挂到本次 render 的局部对象上，仅当 token 仍是最新时才写 `current`。`dispose()` 只释放闭包 `current` 的模式无法覆盖竞态，需以 token 收口。
- **测试现状**：`tests/three-renderer.test.ts:3291-3420` 显式构造两次重叠 render 且都返回 `true`，但 player 是桩（无 RAF）、也没断言旧 player 被 dispose 或 `current` 指向谁 ⇒ 只钉住了健康归属/计时，未覆盖资源收尾（见「测试盲区」）。

### P0-2 粒子纹理、text 画布纹理、动态网格材质/纹理从未 dispose：每次装配泄漏数 MB VRAM

- **位置**：
  - 粒子槽 0/槽 1：`src/client/three-renderer.ts:750`、`:756`（`loadTexTexture` 结果只进 `particles` Map / 材质 uniform），`:765-775`；teardown 只释放 `currentTextures = backgroundTextures`（`:650`、`:483-487`），而 `particles` 的纹理**不在** `backgroundTextures` 里。`player.dispose()` 按设计不释放纹理（`src/client/threejs-player.ts:2908-2923`）。
  - text：`src/client/three-renderer.ts:826`、`:835`（`createTextTexture`），`textLayers` 只在 `loadSceneToThree` 内使用，teardown 无释放；`threejs-player.resizeBackground` 仅在同尺寸变化时 dispose 画布纹理（`:2550-2551`），最后一张永不释放。
  - 动态网格：`src/client/three-renderer.ts:1235-1243`（`materialTable` 与其 `loadTexTexture` 纹理）；`DynamicMeshRegistry.dispose()`（`src/client/dynamic-mesh.ts:212-220`）只 dispose geometry，`fallbackMaterial`（`three-renderer.ts:1195`）也没人释放。
  - pixel-bars 条纹理：`src/client/three-renderer.ts:711-714`（`resolveImageAssets` 新建纹理）只放进 `visualizerSpecs`，未登记 `currentTextures`。
- **触发**：每次切壁纸（含 HMR 重挂载）；凡含粒子/pixel-bars/动态网格/text 的壁纸都命中。
- **影响**：单张 1024² RGBA+mip 粒子贴图约 5.6MB，一个场景常有 2~10 个粒子对象（`resolveParticleMaterial` 按对象拉取、**同一 URL 不去重**，同材质多对象会重复解码）；text 画布约 0.7MB/层；动态网格纹理来自 scene.pkg、可能数 MB。轮播/频繁换壁纸时 VRAM 单调增长，最终触发 `webglcontextlost` → 回退 preview（用户观感＝「壁纸突然变糊图/黑屏」）。这是「切壁纸防泄漏」唯一没盖住的一支。
- **建议**：把粒子/折射法线/text/visualizer bar/动态网格纹理统一登记进 `currentTextures`（或 teardown 时遍历 `particles`/`textLayers`/`materialTable` 逐项 dispose），材质也需 dispose；对同一 `.tex` URL 加装配内缓存以省显存与解码。判据：`renderer.info.memory.textures` 在连续两次装配之间不增长。
- **测试现状**：全仓无「切壁纸后纹理/材质计数不增长」的断言；现有 dispose 测试只覆盖 player 自持的 geometry/material/RT。

---

## P1（真实缺陷，应修）

### P1-1 脚本通道 `applyLayerState` 对粒子/文本写**绝对** position：粒子双重平移、文本丢 anchorOffset

- **位置**：`src/client/layer-state.ts:137`（`obj.position.set(w.origin - sceneW/2, ...)`）；落点解析 `src/client/three-renderer.ts:1106-1109`（`layerLookup` → `player.displayObject`，非隔离粒子/文本返回的就是那个 mesh）。
- **触发**：scene 脚本（`visible.script` / 属性脚本）写 `thisLayer.origin`，且该对象**没有** `{animation}` 时间线（或不在 `currentTimeline` 的 `affected` 子树内）——此时唯一的位置写入就是 `applyLayerState`。
- **影响**：
  - **粒子**：`addParticle` 的内容由顶点 shader 的 `objCenter` 定位，`mesh.position` 只允许承载「相对装配期原点的增量」（`threejs-player.ts:1591-1609` 的注释与实现）。`applyLayerState` 写入 `origin - scene/2`（≈ 对象绝对中心）⇒ 该粒子层被额外平移一个 `objCenter`，常见量级是几百到上千世界单位（`3828798871` 类素材可整层出画）。测试 `tests/threejs-player.test.ts:5415-5431` 自己写明「applyLayerState 的通用路径会写 origin − scene/2（粒子内容已含对象中心 ⇒ 这是双重平移）」，但只在随后调用 `updateBackgroundTransform` 的路径上验证修正 ⇒ 脚本-only 路径仍错。
  - **text**：`addBackground` 的 origin 已含 `anchorOffset`（`threejs-player.ts:3263-3266`），`renderOffset` 由 `updateBackgroundTransform` 补回（`:1615-1630`）。脚本通道不补 ⇒ 文本整体偏移一个锚点偏移（左/上锚点时约为半宽/半高）。
- **建议**：给 `DisplayTarget` 增加 `kind`/`anchorOffset`/`baseOrigin` 元数据（或让 `layerLookup` 返回一个 `applyLayerWrite` 适配器），在 `applyLayerState` 内复刻 `updateBackgroundTransform` 的换算：粒子写增量、text 加 `renderOffset`、隔离对象写合成 quad。
- **测试盲区**：`tests/layer-state.test.ts` 全部用 mock 对象，不含 three 世界变换语义；`threejs-player.test.ts` 只测 `updateBackgroundTransform` 本身 ⇒ 看不到「帧内两条通道叠加」的真实结果。

### P1-2 畸形 `scene.json` 的 `orthogonalprojection` / `origin` / `scale` 未做有限性校验：NaN 相机＝全黑，但仍报告渲染成功

- **位置**：`src/client/scene-json.ts:60-65`（`vec3` 只 `?? 0`，`Number('nan')` 得 NaN）、`:79-84`（`scale3` 同）、`:494-497`（`Number(ortho.width ?? 1920)`，无 `>0 && finite` 校验）。下游 `src/client/threejs-player.ts:996-1004`（`applyCover` → `coverRange`，`src/client/object-range.ts:194-202`）对 0/负/NaN 全部无防护；`threejs-player.ts:827-831` 构造器也不 clamp。
- **触发**：畸形/手工编辑的 scene.json：`"width":"abc"`、`"width":0`、`"origin":"1 nan 0"`、`"scale":"1e999 1 1"`。注意 `size2`/`optNum2`/`optColor` 都有 isFinite 检查，**唯独几何主字段没有**，属于同类防御缺失。
- **影响**：
  - `orthogonal.width = 0/NaN` ⇒ `camera.left/right/top/bottom` 为 0/NaN ⇒ 整幅画面什么都不画；`three-renderer.render()` 仍会走到 `backgroundIds.length > 0` 的成功出口（`three-renderer.ts:1469-1481`）⇒ 黑屏 + 健康状态 `ok`，**降级链不会触发**，用户与面板都看不到任何原因。
  - 单个对象 `origin/angles` NaN ⇒ 该对象（或整个粒子层，NaN 经 `objCenter`/`objAngles` 进 shader）静默消失；`materialModulation` 的 `Math.max(0, Math.min(1, NaN))` 也返回 NaN（`object-range.ts:21-28`）。
- **建议**：`parseSceneJson` 对 orthogonal 做 `Number.isFinite && >0` 校验，非法回退 1920×1080 并 `warnOnce`；`vec3`/`scale3` 用与 `size2` 相同的有限性过滤（把非法分量归 0 或拒绝该字段）。`ThreeScenePlayer` 构造器/`setSceneSize` 再加一道 clamp（§5 类不变量不应只靠调用方）。
- **测试盲区**：`tests/scene-json.test.ts`（980 行）覆盖了大量畸形字段，但未见 `orthogonal` 非有限/非正用例；`object-range.test.ts:176-181` 测了 `screenScalePx` 的 NaN，却没测 `coverRange` 输入退化后的相机。

### P1-3 图片纹理/材质加载失败 ⇒ 不透明**白色** quad 覆盖画面，且零日志

- **位置**：`src/client/scene-assets.ts:79-103`（`catch { return { texture: null, ... } }` + 多处 `return { texture: null }`，全程无 warn）；`src/client/tex-loader.ts:579-581`（图像解码失败静默 null）、`:637`（不支持的格式返回 null）；落点 `src/client/threejs-player.ts:2073` 与 `:2295-2306`（`new THREE.MeshBasicMaterial({ map: null })` 默认 `color=0xffffff`、`opacity=mod.a`，缺省 alpha=1 ⇒ 纯白不透明）。
- **触发**：`models/*.json` 或材质 json 404/畸形；`.tex` 格式不在 `FORMAT_TO_GL`/RGBA/R8/RG88 白名单；单帧 fetch 失败（`fetchWithRetry` 用尽后返回 null）。**隐藏对象**已被 §7.42⑭ 的装配期过滤排除，这里说的是**可见对象**。
- **影响**：该对象区域被白色矩形覆盖（size 缺省会回退纹理尺寸，拿不到纹理会退 1×1×scale，但显式 size=场景的对象就是整屏白）；若走 `colorBlendMode` 分支，`createWhiteTexture()` 还会按 Screen/Add 把白叠加到整屏。console 完全无提示，排查只能靠 `__wallpaperEngine` 探针。全库解析回归（`tests/verify-real-library.test.ts`）若通过，则实际触发面主要限于网络瞬时错误与库外素材。
- **建议**：`resolveImageAssets` 的失败分支按原因 `warnOnce`（模型 404 / 材质 404 / 纹理 decode 失败分别留痕）；纹理为 null 时降级为**透明**（`opacity:0`）或跳过该对象并可观测地记一条降级原因，而不是白色覆盖。
- **测试盲区**：只有「静态隐藏对象不建白 quad」的用例（`tests/threejs-player.test.ts:1677`、`:1733`），没有「可见对象缺纹理」的断言（既没测画面，也没测 warn）。

### P1-4 dpr 变化走 `player.render()` 内部 self-resize，绕过 `ObjectEffectStage.onViewportResize`：隔离 RT 停旧密度

- **位置**：`src/client/threejs-player.ts:1324`（`if (this.devicePixelRatio() !== this.lastDpr) this.resize(...)`）→ `resize()`（`:868-908`）内只同步 glow/bloom/frameCapture/composite（`:894-902`），**不通知** stage；stage 的密度重算只在 `src/client/three-renderer.ts:1454-1460`（window `resize` 监听）与 `:1516-1521`（`setQualityScale`）。
- **触发**：装配后 dpr 变化但窗口逻辑尺寸不变（窗口拖到另一块缩放比例不同的显示器、DSH/系统缩放变化；浏览器不保证派发 `resize`）。该分支的注释本身就是为了覆盖「桌面版窗口创建早于系统缩放生效」。
- **影响**：隔离对象（image/text/util/particle/puppet 效果链）的 RT 停在装配期密度。dpr 变大 ⇒ RT 小于屏占位 ⇒ 合成那一步缩小采样，整层发糊（正是 §5.15/§5.21 记录过的缺陷类）；dpr 变小 ⇒ 超采样白烧显存。同一次 resize 里 Glow 被正确同步，于是出现「主画面/光晕清楚、带效果的对象糊」的不一致。
- **建议**：把密度同步收口到 player 的 resize 单点（构造时注入回调 `onViewportResize`，或让 `three-renderer` 在 `render()` 的 dpr 分支里统一调 `currentStage?.onViewportResize(current.player.screenScalePx())`）。
- **测试盲区**：`tests/three-renderer.test.ts` 只覆盖 window resize（`:380-401`）与 `setQualityScale`（`:1178-1215`）两条路径，没有「dpr 变化经 render 内部 resize」的用例。

### P1-5 窗口拖动/缩放时每个 resize 事件都全量「重挂链」：效果纹理重下载 + pass 着色器重编译

- **位置**：`src/client/three-renderer.ts:1454-1460`（监听无节流）→ `src/client/object-effects.ts:266-299`（`onViewportResize`：RT 尺寸变了就 `host.resizeObjectRT` + `buildEffectPlan` + `runner.setPlan`）→ `src/client/effect-runner.ts:467-481`（`setPlan` 里 `disposeMaterials()` + `clearTextures()` + 重新 `resolveTextureSlot` 预加载）。
- **触发**：拖动窗口边缘连续改变视口尺寸（每事件都改 `screenScalePx`）。`textures` 缓存被 `clearTextures()` 清空并 dispose，随后槽预加载走 `loadEffectTextureSlot` 重新 `fetch`；`/wallpapers/scene/.../asset` 是 `Cache-Control: no-store`（§5.8）⇒ **真实重复下载**。`disposeMaterials()` 让下一次 `update` 重走材质构造 + 1×1 探针编译。
- **影响**：拖拽窗口时出现网络请求风暴（每事件 × 每个隔离对象 × 每个纹理槽）与逐 pass 着色器重编译卡顿；期间 `bindOutputs` 还回退到 `view.rtTexture`（`object-effects.ts:294-298`），带效果的对象短暂「效果消失」。
- **建议**：`setPlan` 只在**壁纸/链/尺寸真实变化**时清纹理（同 URL 集合可复用缓存，只重建 RT 与计划）；`onViewportResize` 对 RT 像素变化做去抖（或用 `requestAnimationFrame` 合并一次），避免每事件重挂。

---

## P2（健壮性/可维护性）

### P2-1 `mdl-parser`：NaN 蒙皮权重通过「权重和＝1」校验，puppet 整体 NaN 消失且无告警

- **位置**：`src/client/mdl-parser.ts:356`（`if (Math.abs(sum - 1) > 0.05) weightOk = false;`）。
- **触发**：损坏/被截断的 `.mdl`：`blendWeights` 中某分量是 NaN/Infinity。`Math.abs(NaN - 1) > 0.05` 为 `false` ⇒ `weightOk` 保持 `true`，垃圾权重进 `blendWeights`；`validateBlendIndices`（`:578-597`）只校验下标。
- **影响**：骨骼矩阵 NaN ⇒ 整个 SkinnedMesh 顶点 NaN ⇒ 该 puppet（人物）整只不渲染，比文档里的「退化为静态网格」更糟，且没有任何 warn。
- **建议**：`if (!Number.isFinite(sum) || Math.abs(sum - 1) > 0.05)`；权重逐分量 `isFinite` 检查（成本可忽略）。同理 `:359` 的 UV 只查首尾两个元素 —— 中间含 NaN 时会静默产出退化三角形，建议抽样或逐顶点检查。

### P2-2 `ObjectEffectStage` 队列无上限：单个 runner 的 `update` 长时间不 settle 时每帧入队、无界增长

- **位置**：`src/client/object-effects.ts:450-482`（`enqueue`/`runTask`）、`:351-372`（`advance` 每帧对每个隔离对象入队一次）。
- **触发**：`runner.update` 内的 `await resolveTextureSlot(...)` 悬挂（慢盘/坏网/永不返回的 fetch）。
- **影响**：每帧新增 N 个闭包（含 `runner`、`rtTexture`、快照引用），队列与内存无界增长；画面停在旧输出（不报错）。
- **建议**：为队列设上限（例如每 runner 至多 1 个 pending：入队前按 objId 去重，旧任务用「最新帧优先」覆盖）；或在 runner 侧加超时/取消。

### P2-3 每帧分配（帧循环内）

- **位置与量**：
  - `src/client/effect-runner.ts:752-762`：`bindSlot` 每个 pass 每个槽都 `resolveTextureResolution4` 返回新对象 + `new THREE.Vector4(...)`。一个 4 pass × 5 槽的链每帧 ~20 个对象 + 20 个 Vector4 × N 个隔离对象。
  - `src/client/object-effects.ts:359` → `src/client/object-range.ts:228-234`：`effectScreenMatrix` 每帧每隔离对象 `new Matrix4()` ×4 + `new THREE.Euler()`。
  - `src/client/effect-runner.ts:799`：`this.chains.flat()` 每帧一次（只为取 `length`）。
  - `src/client/threejs-player.ts:1655-1657`：`isolatedObjects()` 每帧返回新数组，`object-effects.ts:308`/`:353` 各调一次。
  - `src/client/threejs-player.ts:1008` 等：`for (const [id, layer] of [...this.puppetLayers])` 每次 tick 复制 Map（有 puppet 时每帧一次）。
- **影响**：GC 压力集中在每帧，长跑壁纸（24h 常驻）易出现周期性掉帧；单条量不大，但乘上对象/槽数后不可忽略。
- **建议**：`Vector4`/分辨率对象在 material 上缓存并原地 `set`；`effectScreenMatrix` 复用同一个 `Matrix4`（`set`/`multiplyMatrices` 原地写）；`plannedPasses()` 的 `flat()` 改为缓存 `passCount`。

### P2-4 `EffectRunner.getMaterial` 的异常分支不进失败缓存：每帧重试 + 每帧 warn

- **位置**：`src/client/effect-runner.ts:690-695`（`catch` 里只 `warn` + dispose，**不** `this.failed.add(key)`）；对照编译失败分支 `:674-687`（有缓存）。
- **触发**：`this.renderer.debug` 缺失（自定义/未来 three 移除该字段/测试桩）或其他构造期异常 —— 第一处 `this.renderer.debug.onShaderError = ...`（`:659-660`）就会抛 TypeError。
- **影响**：该 pass 每帧重建材质、重建 scene、每帧一条 warn（日志刷屏），且 `update` 每帧付出构造成本；与「失败缓存」的设计意图相反。
- **建议**：catch 里同样 `this.failed.add(key)`（`setPlan` 会清空，重挂链仍会重试）；对 `renderer.debug` 缺失做 `if (!this.renderer.debug) return null` 风格的防御（同 `glow-stage.ts:202` 的做法）。

### P2-5 `shader-preprocessor.relaxGlsl3Strictness`：`main()` 花括号另起一行时把全局初始化插到 `{` 之前

- **位置**：`src/client/shader/shader-preprocessor.ts:360-389`：`mainIdx` 取 `void main(` 行，`:387` `lines.splice(mainIdx + 1, 0, ...moved)` 假设 `{` 与 `main()` 同行。
- **触发**：shader 写成
  ```
  void main()
  {
  ```
  且存在非编译期常量的全局初始化（该函数正是为这类 shader 而写）。
- **影响**：赋值语句被插到全局作用域的 `{` 之前 ⇒ 语法错误 ⇒ 整 pass 编译失败被跳过（有 warn，但该效果静默消失）。**待确认**：本机 WE 素材未见此排版（现有测试全部用 `void main() {`），属潜在雷。
- **建议**：`mainIdx` 之后跳过空行找 `{` 所在行，插入点取 `{` 行之后；或分支处理「`{` 在下一行」。

### P2-6 `uniform-binder` 不校验向量维度：畸形常量会让 `uniformNfv` 上传失败而静默保持旧值

- **位置**：`src/client/shader/uniform-binder.ts:11-26`（`parseValue` 任意长度数组）、`:52-60`（只有 `null/0` 才按声明维度补零）。
- **触发**：`scene.json` 的 `constantshadervalues` 给 `vec3` uniform 传 `"1 0"`（2 分量）、给 `vec4` 传 5 分量等。
- **影响**：three 以 `uniform3fv(addr, [1,0])` 上传，WebGL 对长度非 3 的倍数报 `INVALID_VALUE`（不抛异常）⇒ 该 uniform 保持上次值/0，效果静默算错。**待确认**：GL 的具体行为按实现（Chrome 报 INVALID_VALUE 并忽略该次上传）。
- **建议**：用 `u.type` 解析维度（vec2/vec3/vec4/matN/float），对数组做「截断/补零」后返回；维度不符时 `warnOnce`（现在连日志都没有）。
- **测试盲区**：`tests/uniform-binder.test.ts` 仅 49 行，只覆盖标量/正常数组/音频全零。

### P2-7 `parseAnimationLayers` 只认 `visible === true`：字符串/`{user,value}` 形态静默丢层且不回退首动画

- **位置**：`src/client/scene-json.ts:123-141`（`visible: o.visible === true`）；消费 `src/client/threejs-player.ts:2246-2252`（`filter(l => l.visible !== false)`）与 `:1019-1024`（`layers?.[0]` 为空 ⇒ 直接 `continue`）。
- **触发**：`animationlayers[].visible` 写成 `"true"`，或 `{user,value:true}` 绑定（`resolveSceneUserBindings` 是否会下钻到 animationLayers 需另核）。
- **影响**：所有层被过滤成空数组，`tickPuppets` 得不到 `anim` ⇒ puppet 冻结在绑定姿态；且**不会**按 §2.1「字段缺失退回动画表首个」兜底（因为 `animationlayers` 字段存在，`layers !== null`）。全库现有样本用布尔 `true`，暂无实害（**待确认**）。
- **建议**：解析时接受 `true`/`"true"`/`{value:true}`；空可见层时 `layers = null`（回退首动画语义）或至少 warn 一次。

### P2-8 负的 `size` 让几何绕序翻转、`FrontSide` 下对象直接不可见

- **位置**：`src/client/scene-json.ts:68-74`（`size2` 只校验 finite，允许负数）；`src/client/threejs-player.ts:2053`（`new THREE.PlaneGeometry(w, h)`）。
- **触发**：`size: "-100 200"`（畸形/手工编辑）。注意与**负 scale** 不同：three 会按 `matrixWorld.determinant() < 0` 自动翻转正面，但不会补偿几何自身为负尺寸。
- **影响**：非隔离对象（`side: FrontSide`，`threejs-player.ts:2305`）被背面剔除 ⇒ 静默消失；隔离内容用 `DoubleSide` 反而可见 ⇒ 两条路径表现不一致。
- **建议**：`addBackground` 对几何尺寸取 `Math.abs`（负号语义应由 `scale` 承载），或在解析期 reject 负 size 并 warn。

### P2-9 `tex-loader.cropRowsToMap` 在载荷被截断时静默产出全零行

- **位置**：`src/client/tex-loader.ts:330-347`（`if (src >= data.length) break;`，余下零初始化）。
- **触发**：`.tex` 的 mip 记录宽高与 `bytesLen` 自洽（`parseTex` 只校验 `pos + bytesLen <= buf.length`），但字节数小于 `cw*ch*bpp`。
- **影响**：纹理下半部（翻转后是上半部）全黑/全透明，画面出现黑带，无任何日志。
- **建议**：`parseTex` 校验 `bytesLen >= mipW*mipH*bpp`（压缩格式按块算），不满足时返回 null 并让上层走白图/告警路径。

### P2-10 折射层的快照失效窗口：快照失败后仍采旧纹理，且 `refractHidden` 无复位点

- **位置**：`src/client/threejs-player.ts:1474-1515`（`snapshot === null` 时 `refractBg` 保持上一帧赋值）、`:1411-1417`（`hideRefractWithoutCapture` 只在 `frameCapture.active !== true` 时隐藏，且置位后永不复位）。
- **触发**：`capture.capture()` 抛错（`FrameCapture` 已 dispose 但 player 仍持有 / 底层 GL 异常）。概率低。
- **影响**：`refractBg` 指向可能已 dispose 的纹理 ⇒ 折射层采样黑/花屏并被持续绘制；每帧只打一次 warn（`frameSnapshotWarned`），容易被误读为「已处理」。
- **建议**：快照失败时把 `refractBg` 复位为 1×1 白（等价 NORMALMAP=0）或隐藏该层；`setFrameCapture(null)`/新 capture 注入时复位 `refractHidden`。

---

## 静默吞错清单（位置 → 掩盖了什么 → 建议）

> 只列**会掩盖真实 bug / 让用户看到错误画面或缺失图层却无提示**的 catch；纯收尾型（`dispose`/`pause` 等「已释放」）不计。

| # | 位置 | 掩盖了什么 | 严重度 | 建议 |
|---|---|---|---|---|
| 1 | `src/client/scene-assets.ts:101-103`（`resolveImageAssets` catch） | 模型/材质 json 解析或 fetch 抛错 → 纹理 null → **白色 quad**；调用方完全不知道原因 | P1 | 按阶段 warnOnce（model/mat/tex），并让上层区分「无纹理」与「加载失败」 |
| 2 | `src/client/scene-assets.ts:192-194`（`resolveParticleMaterial` catch） | 粒子材质 json 畸形 → `blending/refract` 全丢 → 粒子按 alpha 混合画成黑方块（§5.6 记录的 DK 类症状）且无日志 | P1 | catch 内 warnOnce（带 object id）；与 `particleBlend` 的名启发式兜底一起留痕 |
| 3 | `src/client/tex-loader.ts:579-581`（编码图像 `createImageBitmap` catch） | 贴图解码失败静默 null → 白色 quad；无法区分「格式不支持」与「数据损坏」 | P1 | warnOnce（带 mime/尺寸/字节数） |
| 4 | `src/client/wasm-loader.ts:23-26`（`defaultLoadWasm` catch） | wasm 加载/实例化失败 → `CpuParticleSim` 缺失 → **全部粒子层静默消失**，只剩一行 `particleLayers=0` 的 info 日志 | P1 | catch 里 `console.warn('[three] wasm 加载失败，粒子层将跳过')`；或让上层在「本应有粒子」时记软失败 |
| 5 | `src/client/three-renderer.ts:1241-1242`（动态网格材质 catch，空 catch） | 材质 json/纹理解析抛错 → 网格永久用兜底白图材质，无日志（同函数里「缺失/解析失败」有 warnOnce，异常抛错没有） | P2 | 补 `warnOnce(mesh-mat:...)` 带上错误消息 |
| 6 | `src/client/shader/effect-chain.ts:172-174`（`resolveEffectChain` 整函数 catch） | 任何解析异常 → null；调用方只报「效果链解析失败: <file>」，**丢失原因**（缺 material/缺 shader/JSON 畸形/越界全一样） | P2 | catch 里带上 `e.message` 与阶段标记返回结构化原因，交给 `warnOnce` |
| 7 | `src/client/scene-json.ts:549-551`（`sceneJsonWithResolvedModulation` catch） | 写回失败静默返回原文 → 用户属性 resolve 后的 color/alpha 不生效（面板改了没反应），无日志 | P2 | 失败时 warnOnce（正常走不到，但一旦走到就是「属性面板失灵」） |
| 8 | `src/client/three-renderer.ts:111-113`（字体加载 catch） | 字体取不到 → 回退 sans-serif（设计如此），但 pkg 字体损坏与网络失败无法区分 | P3 | 可选 warnOnce（按字体路径去重） |
| 9 | `src/client/three-renderer.ts:1309-1315` / `:1332-1335`（封面取图/取色 catch） | 封面失败 → 中性色 + 空纹理（设计如此，且面板不暴露曲目信息） | P3 | 维持；若要可观测可加计数器到 `getMediaStatus()` |
| 10 | `src/client/text-script.ts:173-175`（媒体事件 catch，空） | quickjs 句柄/预算异常 → 丢事件且无日志（每帧 update 有 warn，事件通道没有） | P2 | 加 `mediaWarned` 同类的一次性 warn（已有字段，可复用） |
| 11 | `src/client/mdl-parser.ts:634-637`（`parseMdl` catch → `malformed`） | 越界读取等异常被收成结构化错误（符合契约），但**没有日志**；上层 `warnOnce` 只打 `parsed.error`（`malformed` 无细节） | P3 | 把 `e.message` 拼进 error 字符串（不抛） |
| 12 | `src/client/threejs-player.ts:1929-1931`（`captureFullFrame` catch） | 快照资源已释放 → 返回 null（调用方按无快照走），但这条路径与「本机就没有消费者」不可区分 | P2 | 返回前 warnOnce（与 `warnFrameSnapshotFailure` 合并计数） |

---

## 测试盲区（修复点 → 缺什么判据）

1. **重叠 render 的资源收尾**（P0-1）→ 用例：A 慢/B 快、两者都装配成功，断言「旧 player 的 dispose 被调用」「`current` 指向最新一次 render（或旧的一次被显式丢弃）」「只有一个 `setAnimationLoop` 存活」（用 player 桩计数 RAF 安装/拆除）。现有 `tests/three-renderer.test.ts:3291-3420` 只断言健康归属与计时。
2. **纹理/材质泄漏**（P0-2）→ 用例：连续两次 `render()`，断言 teardown 后 `currentTextures` **与**粒子/折射/text/visualizer bar/动态网格材质的 `dispose` 都被调用（spy `THREE.Texture.prototype.dispose`）；或 e2e 断言 `renderer.info.memory.textures` 不随装配次数增长。当前无任何此类断言。
3. **脚本 origin 落点**（P1-1）→ 用例：非隔离粒子 + text 各一，模拟 `host.tick` 返回 `{origin}` 的 dirty（**不**经 `updateBackgroundTransform`），断言粒子 mesh 位置是增量、text 位置含 `renderOffset`。现有测试只测 `updateBackgroundTransform` 与 mock 版 `applyLayerState`，两段之间没有缝。
4. **畸形正交/变换字段**（P1-2）→ 用例：`orthogonalprojection` 缺失/0/字符串/负数、`origin:"1 nan 0"` → 断言解析结果有限、或渲染出口报失败（而不是 `ok`）。`tests/scene-json.test.ts` 需补这几组。
5. **缺纹理的可见对象**（P1-3）→ 用例：`resolveImageAssets` 返回 `texture:null` → 断言不产生「白色不透明」画面（或至少有一条 warn/降级记因）。现有只测隐藏对象不建 quad。
6. **dpr 变化路径**（P1-4）→ 用例：装配后改 `window.devicePixelRatio` 并触发 `render()` 内 self-resize，断言 `ObjectEffectStage.onViewportResize` 被调用且参数 = `player.screenScalePx()`。现有只测 window resize / setQualityScale。
7. **resize 重挂链的副作用**（P1-5）→ 用例：同一链在 RT 尺寸变化后重挂，断言纹理槽 `load` 次数不增加（缓存复用）与材质不重建（或至少用显式计数判据钉住「每次 resize 重下载」这一已知行为）。当前 `tests/effect-runner.test.ts` 有 `setPlan` 用例，但未断言纹理重载次数。
8. **mdl NaN**（P2-1）→ 用例：把 fixture 的某个 `blendWeights` 改成 NaN，断言 `blendIndices/blendWeights` 被置 null（静态网格）而不是原样透传。现有 `tests/mdl-parser.test.ts` 覆盖了越界下标与权重和不等于 1，未覆盖 NaN。
9. **shader `main()` 换行**（P2-5）→ 用例：`relaxGlsl3Strictness('uniform float u;\nfloat g = u;\nvoid main()\n{\n}')`，断言赋值落在 `{` 之后。
10. **uniform 维度不匹配**（P2-6）→ 用例：vec3 uniform + 2 分量常量，断言被补零/截断（或返回明确失败），而不是原样 2 元素。
11. **visualizer bar 的 `renderOrder` 唯一性**（P2 附注）→ `setVisualizerBars`/`setPixelVisualizerBars` 用 `renderOrder + i + 1`（`threejs-player.ts:1714`、`:1767`），会与真实对象的「objects 下标」撞号（§5 的透明排序约定要求唯一），建议加 `objects.length + 段号` 的命名空间，并补一条「同壁纸所有 renderOrder 唯一」的断言。
12. **`animationlayers.visible` 形态**（P2-7）→ 字符串/绑定形态的解析用例 + 「全部层不可见时不回退首动画」的行为钉住（当前只有真实库样本路径）。

---

## 附：核对过但**不是**缺陷（避免下轮重复审）

- **Glow/bloom 的 RT 尺寸**：`three-renderer.ts:1421/1436` 传的是 `fg.width/height`，但 `fg` 是 canvas 元素 —— `loadSceneToThree` 内 `player.resize()` 已把 `canvas.width` 改为 `view×dpr`（`threejs-player.ts:883-890`），所以读到的就是**画布缓冲**尺寸；`glowSize` 同源。`tests/three-renderer.test.ts:562-593` 已用 dpr=2 钉住。
- **隔离局部相机 y 镜像 + 合成 quad `flipGeometryUvY`**：`threejs-player.ts:2442` / `:2450-2451`，两者精确抵消；puppet 内容 quad 不翻（`:2208-2225`）、翻转只在 `setObjectOutput` 采样处（`:1669-1681`）——与 §5.20/§7.40 的约定一致，且 `tests/threejs-player.test.ts:4974` 有判据。
- **`createCompositeGeometry` 的 UV 窗口**：`threejs-player.attachIsolated` 的局部相机范围恒等于未钳制世界尺寸（`:2432-2433`），`uvWindow` 恒退化为 `[0,1]`，不构成裁剪风险。
- **`frameCapture.resize` 的快照换代**：`frame-capture.ts:109-125` 只在 `hasSize` 后自增 `snapshotVersion`，且 resize 前未建资源时只记录尺寸，不会把无效代号带给消费方。
- **`readPixels` 的同任务读取**：`frame-export.ts:50-62` 在第一个 `await` 之前同步 `readPixels`，`threejs-player.flushCapture`（`:1357-1385`）的「同一 JS 任务」前提成立。
