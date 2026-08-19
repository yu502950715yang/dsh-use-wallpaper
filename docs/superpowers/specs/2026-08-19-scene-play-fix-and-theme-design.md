# DSH Wallpaper Engine 浅色模式适配 — 设计文档

- 日期：2026-08-19（范围修订：Scene 修复延后，本次仅实施 B 浅色模式适配）
- 状态：设计中
- 项目根：`E:\code\dsh-use-wallpaper`
- 关联：`2026-08-17-dsh-wallpaper-engine-design.md`（总设计）、`2026-08-18-dsh-wallpaper-engine-effects-design.md`（效果链渲染，已实施）
- 竞品参考：`research/competitor/`（elysia395/dsh-wallpaper-engine 本地克隆，其主题适配体系为本设计 B 的直接蓝本）
- **范围变更记录（2026-08-19）**：原设计含 Scene 播放修复（A1-A5）与浅色模式适配（B）。用户指示 Scene 相关问题暂不修改（后续另行讨论），**本次仅实施 B**；A1-A5 移入 §12"后续迭代"。

## 1. 背景与目标

用户报告两个已知问题：
1. **Scene 类型壁纸无法正常播放**（黑屏/空白/无动画感）——**本次不做**，后续讨论；
2. **浅色模式不适配**（插件 UI 硬编码深色 + 强制透明背景导致浅色主题文字不可读）——**本次实施**。

本设计目标：完成浅色模式适配，吸收竞品的主题适配工程资产（`body[data-ds-dark-theme]` 属性双分支 + `--dsw-alias-label-*` token 覆盖），使插件在 DSH 浅色/深色主题下均可用且文字可读。

## 2. 根因分析（事实基础）

### 2.1 Scene 播放问题（按可能性排序）

| # | 根因 | 证据 |
|---|---|---|
| 1 | 粒子渲染与真实差距巨大 + 效果链失败 → "看起来没在播放" | 粒子无纹理（硬编码圆形点精灵，`scene-renderer.ts:171-182`）；`particlesFromSpec` 丢弃 material/maxcount/operator（`scene-assets.ts:17-46`）；EVA 的 fog2/lightning1 无 velocityrandom → 粒子静止；lightshafts rate=0.3 → 3 秒 1 粒子；效果链 shader 编译失败被静默跳过（`we-headers.ts` 缺 `ApplyComposite`/`ApplyCompositeOffset`，3 壁纸 6 处依赖） |
| 2 | `renderScene` 异常全被吞 → 静默回退 preview | `scene-renderer.ts:311-314` try/catch 全吞返回 false → `wallpaper-controller.ts:55-58` 回退静态图，Console 无任何报错 |
| 3 | 纯 text 壁纸必回退 | 全库 68 个 text 对象（Clock/Text Layer）落入 `scene-json.ts:48` 空粒子兜底；2980088441（11 个 text 对象）`rendered=0` → 必回退 |
| 4 | model/text 对象不支持 | `scene-json.ts:25-49` 无对应分支 |
| 5 | 效果链编译失败（ApplyComposite 系列缺失） | `we-headers.ts` 缺 2 函数；`effect-chain.ts:35` 跳过 `materials/util/*` 合成 pass |

**已排除**（实测健康）：tex 加载 100% 成功（63 张 parseTex OK）；HTTP 路由 0 失败；scene.json 解析 100% 成功；`resolveTexPath` 全库 0 失败。

### 2.2 粒子现状（全库实测）

- 29 个粒子文件，**100% 有 `material` 字段**（如 EVA `materials/particle/halo_1.json` → `passes[0].textures[0]` = `particle/debris/debris1` → 实际 tex 存在于 pkg）——纹理加载收益全覆盖；
- operator 类型分布：`movement`×27、`alphafade`×28、`oscillateposition`×5、`sizechange`×4、`oscillatealpha`×3、`controlpointattract`×3、`turbulence`×2、`angularmovement`×2、`colorchange`×2 —— **中等升级只做 `movement`（重力）与 `alphafade`（透明度）**，覆盖 55 处中的 55 处。

### 2.3 浅色模式问题

`src/client/styles.ts` 全部硬编码深色（详见 §6 B 节），无任何 `data-ds-dark-theme` 主题分支。竞品方案（`body[data-ds-dark-theme]` 属性双分支 + `--dsw-alias-label-*` token 覆盖）经确认可直接移植。

## 3. 范围（2026-08-19 修订）

- **本次实施（B）**：浅色模式适配——`styles.ts` 主题分支重构 + `background-layer.ts` body 属性 + 插件 UI token 化（§9）
- **后续迭代**（本设计保留设计稿，暂不实施）：A1-A5 Scene 播放修复（§4-8）、A6 util 合成层、阶段 C 功能面补齐（弹窗/轮播/滑块/上传/倍速/翻转/host 增强）
- Scene 相关问题将在后续单独讨论后再定方案

## 4. 设计 A1：失败可视化

**问题**：`renderScene` 静默失败，用户面对无解释的黑屏/静态图。

**方案**：
1. `scene-renderer.ts` `renderScene` 的 catch 分支（L311）加 `console.error('[wallpaper-engine] scene 渲染失败', id, err)`；
2. `wallpaper-controller.ts`：scene 渲染失败回退 preview 时（L55-58 分支），在背景层显示状态徽标「壁纸渲染失败，已回退预览图」（小 DOM 元素，位于背景层右下角，5 秒后自动移除）；成功渲染时无徽标；
3. 徽标样式挂入 `styles.ts`（随主题变量，见 B）。

**测试**：`wallpaper-controller.test.ts` 补"渲染失败 → 回退 preview + 徽标出现"断言。

## 5. 设计 A2：粒子中等升级（核心亮点）

### 5.1 粒子材质纹理

- `scene-assets.ts` `particlesFromSpec` 返回结构扩展：解析 `root.material`（如 `materials/particle/halo_1.json`）→ 材质 json → `passes[0].textures[0]`（如 `particle/debris/debris1`）→ 复用 `resolveTexPath`（`scene-renderer.ts:235-239`）推导 tex 路径 → `loadTexTexture` 加载；
- `scene-renderer.ts` `addParticleSystem` 接受可选纹理参数；粒子 shader 改为：有纹理时 `texture2D(tex, gl_PointCoord)`（乘法混合到颜色），无纹理时保留圆形点精灵；新增 `uniform sampler2D g_ParticleTex`；
- 纹理加载失败静默回退圆形（不阻断粒子渲染）。

### 5.2 operator 支持（movement + alphafade）

- `particles.ts` `createParticleSystem` 增加 `operators` 参数：
  - `movement`：`gravity`（向量，默认 `0,0,0`）每帧 `v += gravity * dt`；
  - `alphafade`：`fadein`/`fadeout`（秒）→ 每粒子 alpha 曲线（fadein 斜坡 + fadeout 斜坡）；
- 粒子 alpha 实现（明确方案）：**不新增 attribute**，复用现有 `vLife`（= 剩余寿命比例，见 §5.4）作为基础透明度，alphafade 曲线在 CPU 侧算入粒子 `aSize` 同款 `aAlpha` 缓冲（每粒子 float）——即新增 `attribute float aAlpha` 存 alphafade 曲线因子（0-1），fragment alpha = `smoothstep * vLife * aAlpha`；无 alphafade operator 时 aAlpha 恒 1；
- `scene-assets.ts` `particlesFromSpec` 解析 `root.operator[]`，提取 `type==='movement'` 与 `type==='alphafade'`（其余 operator 忽略并 console.warn 一次）。

### 5.3 fog 类粒子修复

- 无 `velocityrandom` initializer 的粒子系统（fog2/lightning1 等）：`particlesFromSpec` 检测 `!vel` 时，以 `emitter.distanceMin/Max` 为半径随机方向生成初速度（扩散模拟），避免粒子静止；
- 保持确定性种子（`mulberry32`）不变。

### 5.4 每粒子透明度衰减

- 当前 shader `vLife = 1.0` 恒定（`scene-renderer.ts:173`）→ 改为按剩余寿命比例计算（`life/maxLife`），`fragmentShader` alpha *= vLife。

**测试**：`particles.test.ts` 补 movement（重力下落位移断言）、alphafade（曲线端点值）、无 velocityrandom 扩散（速度非零断言）；`scene-assets.test.ts` 补 material/operator 解析断言（真实 EVA Ashes fixture 已有 material）。

## 6. 设计 A3：大纹理降采样 + DXT 翻转

**问题**：TEXB0003+ 内嵌 JPEG 单 mip 全尺寸上传（2911105183 主图 3840×2160，7.5MB JPEG），Task 6 确认该壁纸黑屏为基线问题；DXT1/3/5 分支（`tex-loader.ts:205-215`）未做行翻转 → 压缩纹理壁纸上下颠倒。

**方案**：
1. `tex-loader.ts` `textureFromTex` 的编码图像分支（L175-193）：`createImageBitmap(blob, { imageOrientation: 'flipY', resizeWidth: 2048, resizeHeight: 等比 })`——**仅当 mip 宽高 > 2048 时降采样**（`resizeWidth: 2048, resizeHeight: Math.round(h * 2048 / w)`），≤2048 的保持原样；
2. DXT 分支补块级行翻转（`flipRows` 按 4×4 块行、每块 8/16 字节处理，DXT1=8B/块、DXT3/5=16B/块）；
3. 降采样失败（个别浏览器 createImageBitmap resize 不支持）回退原尺寸。

**测试**：`tex-loader.test.ts` 补"大 mip 触发 resize 参数"（mock createImageBitmap 断言参数）与 DXT 翻转（构造 8×8 DXT1 块数据断言行序）。

## 7. 设计 A4：we-headers 补全

**事实**（全库调用形态扫描）：
- `texSample2D` 全部 407 处均为 2 参（`sampler2D, vec2`），现有签名覆盖，**无需处理**（早前"3 参"为嵌套调用正则误报）；
- 缺失仅 2 函数、3 壁纸（2011060960/2597392171/2897292240）的 `shaders/effects/blur_combine.frag` 依赖：
  - `vec2 ApplyCompositeOffset(vec2 coords, vec2 resolution)`（3 处调用：`ApplyCompositeOffset(blurredCoords, g_Texture0Resolution.xy)`）；
  - `vec4 ApplyComposite(vec4 old, vec4 current)`（3 处调用：`ApplyComposite(albedoOld, blurred)` 与 `ApplyComposite(albedoOld, vec4(blurred.rgb / div, blurred.a))`）。

**方案**：
1. `we-headers.ts` 补 `ApplyCompositeOffset` 与 `ApplyComposite` 实现（语义对齐 linux-wallpaperengine 逆向源码，实施时先核对再写死）；
2. 若语义不确定，实施第一步先对照 `linux-wallpaperengine` 仓库（GitHub）确认后实现。

**测试**：`shader-headers.test.ts` 补两个函数存在性与 `blur_combine.frag` 真实片段编译（在现有 shader 测试框架内）。

## 8. 设计 A5：text 对象支持

**事实**：全库 23 个 text 对象（Clock/Text Layer），字段含 `text`（字体路径，如 `fonts/Atami-Regular.otf`）、`font`、`color`、`pointsize`、`horizontalalign`、`verticalalign`、`alpha`、`angles`、`solid` 等；2980088441 为纯 text 壁纸（11 对象）。

**方案**：
1. `scene-json.ts`：对象无 image/particle 但含 `text`/`font` 字段 → `kind: 'text'`，保留 `text`/`font` 等原始字段（`SceneTextObject` 加入 `src/shared/types.ts`）；
2. `scene-renderer.ts` `renderScene`：`kind==='text'` 时用 Canvas 2D 离屏绘制文字（`document.fonts` + `FontFace` 加载 host 已支持的字体 MIME：`.otf/.ttf` 已在 `routes.ts` MIME 表）→ `CanvasTexture` → 平面 mesh（按 size/origin 摆放，`solid`=背景色方块，`angles` 旋转）；
3. 绘制内容：文字值取对象 `text` 字段之外的内容——**实施时先 dump 一个真实 text 对象完整定义确认"显示什么文字"**（Clock 对象通常由 WE 运行时注入当前时间，浏览器端一期先渲染静态占位文本或对象自带文本字段，spec 实施时定）；
4. 字体加载失败回退系统 sans-serif。

**测试**：`scene-json.test.ts` 补 text 分类断言；`scene-renderer` 的 text 分支因 WebGL 不可测，做 `CanvasTexture` 创建逻辑的 node 侧单元测试（mock canvas）。

## 9. 设计 B：浅色模式适配（移植竞品主题体系）

**蓝本**：`research/competitor/src/client.js:1390-1496`（`body[data-ds-dark-theme]` 三分支）。

**方案**（`styles.ts` 重构）：
1. **壁纸激活状态属性**：`background-layer.ts` 挂载壁纸层时给 `document.body` 加 `data-we-wallpaper` 属性（清空壁纸时移除）；
2. **浅色分支** `body[data-we-wallpaper]:not([data-ds-dark-theme])`：
   - 文字对比度提升：`--dsw-alias-label-primary: #000`、`--dsw-alias-label-secondary: rgb(40,42,46)`、`--dsw-alias-label-tertiary: rgb(70,73,79)` 等整条灰阶压暗（对照竞品 1396-1403）；
   - 遮罩：`.wp-bg-overlay` 保持 `rgba(0,0,0,.25)`（浅色主题下黑遮罩对比度足够）；
   - 玻璃透明度：`--dsw-specific-input-major: rgba(255,255,255,.15)`、`--dsw-specific-bubble: rgba(255,255,255,.12)`（对照竞品 1429-1431）；
3. **深色分支** `body[data-ds-dark-theme][data-we-wallpaper]`：玻璃透明度降至 `.06/.05`（对照 1433-1436）；
4. **插件自身 UI token 化**：`.wp-picker`/`.wp-fab`/`.wp-thumb`/`.wp-badge` 颜色改为 CSS 变量（`--wp-panel-bg`、`--wp-text` 等），在深浅两个分支下分别定义；移除硬编码 `rgba(20,22,28,.92)`/`#eee`；
5. **背景透明化收敛**：保留"有壁纸时 `#root`/body 背景透明"（壁纸透出必需），但收窄作用域——仅在 `body[data-we-wallpaper]` 下生效（`body[data-we-wallpaper] #root{...}`），避免无壁纸时也破坏浅色背景；侧栏 token `--dsw-specific-sidebar-fill` 改为主题感知（浅色 `rgba(255,255,255,.55)` / 深色 `rgba(20,22,28,.55)`）。

**测试**：`styles.ts` 导出 CSS 字符串，测试断言包含三个主题分支与 `data-we-wallpaper` 属性选择器；`background-layer.test.ts` 断言挂载/清除时 body 属性切换。

## 10. 验证（阶段 D）

1. **单元测试**：全量 `vitest run`（node + jsdom 双环境）+ `tsc --noEmit` + `npm run build` + `node scripts/build-client.mjs`；
2. **安装**：按 README 将 `@dsh-use/wallpaper-engine` 装入 `C:\Users\0009\.dsh\profiles\web`（bundles 列表 + cordis.patch.yml 合并）→ 重启 DSH web；
3. **浏览器实测**：headless Edge + CDP（沿用 `research/verify-blackout.mjs`）对全库 24 个 scene 壁纸逐个切换：黑屏率 → 0、静态判定、两帧差异、console 错误收集（A1 后应能看到明确错误而非静默）；
4. **对照验证**：2911105183（4K JPEG 黑屏基线）应恢复渲染；2980088441（纯 text）应显示文字内容；1429403119/2832263418 渲染质量对比 Task 6 记录应更好（粒子纹理/运动）；
5. **浅色模式**：浏览器 `document.body.removeAttribute('data-ds-dark-theme')` 后检查 picker/FAB 颜色与文字对比度。

## 11. 非目标（本设计明确不做）

- A6 util 合成层渲染；model 对象（.obj/.mdl）加载；音频可视化效果；
- 阶段 C 全部功能（弹窗/轮播/上传/滑块/倍速/翻转/host 增强）；
- GPU 粒子重构；liquid glass 完整配方（玻璃效果属 C）。

## 12. 涉及文件清单

| 文件 | 改动 |
|---|---|
| `src/client/scene-renderer.ts` | A1 日志、A2 粒子纹理/operator/透明度、A5 text 渲染 |
| `src/client/particles.ts` | A2 operators 参数 + 应用 |
| `src/client/scene-assets.ts` | A2 material/operator/fog 解析 |
| `src/client/tex-loader.ts` | A3 降采样 + DXT 翻转 |
| `src/client/scene-json.ts` | A5 text 分类 |
| `src/client/shader/we-headers.ts` | A4 补 2 函数 |
| `src/shared/types.ts` | A5 SceneTextObject |
| `src/client/wallpaper-controller.ts` | A1 失败徽标 |
| `src/client/background-layer.ts` | B body 属性 + 徽标挂载 |
| `src/client/styles.ts` | B 主题分支 + token 化 |
| `tests/*` | 各节对应测试 |
