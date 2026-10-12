# §5 关键约定（明细）

> 归档文件（2026-10-10 从 `AGENT.md` 逐字搬出，编号保持原样）。每条编号与 AGENT.md 的 §5.x 一一对应（多处代码注释按该编号引用）。
> 精简后的入口文档是仓库根的 `AGENT.md`；本文只作历史与细节查阅。
## 5. 关键约定（踩过的坑）

### §5.1

1. **wasm 产物必须 `--target web`**：曾用 `--target module`（无默认导出 `__wbg_init`）导致 wasm 静默失败、一路回退。加载侧期望「动态 import + 调默认导出 `mod.default(wasmUrl)` 初始化」。
### §5.2

2. **`research/`、`wasm/pkg/`、`dist/static/ptex-*.tex` 是 gitignore**；`lib/`、`dist/` 其余部分**必须提交**（见 §3.2）。
### §5.3

3. **对象 `angles`（弧度）必须应用**，否则局部朝向被直接当世界朝向。全库 **79 个对象带非零 angles**（粒子 75 / image 2 / text 1 / other 1，涉及 15 张壁纸）。回归：GTR `3743126786` 烟柱 `angles.z = -1.20063`（≈ −68.8°）应把局部 +Y 转到世界 `(0.932, 0.362)` = 向右偏上；漏掉就变成直着向上。三个应用点：粒子顶点 shader、背景 `mesh.rotation`、util/text（字段解析保留，暂不做几何变换）。
### §5.4

4. **`turbulentvelocityrandom` = `forward` 绕 `normal` 旋转**（不是「沿 normal 偏移」）：官方 `TurbulentVelocityRandomProgram`（OWE `ParticleParser.cpp:326-357`）= curl 噪声采样 → 投影到垂直 normal 的平面 → 与 forward 求夹角 → `AngleAxisf(angle*scale + offset, normal) * forward`。方向**恒在垂直 normal 的平面内**（缺省 normal=+Z / forward=+Y 时 z 恒 0、x/y 随机）。旧实现写成 `forward*cosθ + normal*sinθ*scale`，得到 `(0, cosθ, sinθ)`：x 恒 0、速度全进屏幕上不可见的 z 轴 → 粒子排成一条竖线。影响全库 **9 张壁纸**（2011060960 / 2236329190 / 2460786246 / 2597392171 / 2851992662 / 2859263090 / 2897292240 / 3743126786 / 3760200530，且都没显式写 normal/forward）。实现见 `sim.rs`（复用既有 `curl_noise`，采样位置跨 spawn 累积，`offset/timescale/phasemin/phasemax` 全部参与）。GPU 路径的 `turb_velocity` 本就是球面均匀随机，不受影响。
### §5.5

5. **对象级 `instanceoverride`**（scene.json → 粒子）：`alpha/size/lifetime/speed` 是**乘数**，`color/colorn` 是**覆盖**（`UiColorToLinear` = v²，legacy `color` 先 /255），emitter rate **× `count`**；缺省恒等。JS 侧只透传原始 JSON（`SceneParticleObject.instanceOverrideJson` → `CpuParticleSim.new` 第 5 参，**空串 = 无覆盖**），语义解析在 Rust（`particle::parse_particle_override`）。回归：GTR 烟柱 `alpha 0.03` 是它在桌面端几乎不可见的原因（未实现时实测粒子 alpha 均值 0.797）。
### §5.6

6. **图像 `colorBlendMode`（→ shader combo `BLENDMODE`）不是 alpha 混合**，而是**额外追加一遍「读当前帧缓冲」的混合 pass**（WE 材质 `materials/util/effectpassthrough.json`，shader `genericimage3`；lwe `CImage.cpp:751-767`）：`ApplyBlending(BLENDMODE, A=背景, B=自己, 自己的 alpha)`，alpha 保持背景的。模式表在 **WE 明文 shader** `<WE>/assets/shaders/common_blending.h`：1=Darken 2=Multiply 3=ColorBurn … **6=Lighten 7=Screen** … 30=Tint **31=A+B×opacity** 32=A+A×B。three 侧用**预乘片元**（`vec4(rgb×tint×a, a)`）+ `CustomBlending` 复刻：7 → `(OneMinusDstColor, One)`、31 → `(One, One)`、6 → `MaxEquation`，alpha 用 `(Zero, One)`（**2026-09-14 `6bb3d71` 起**：对象级**隔离**路径不再复用这套内容材质 —— 混合语义整体移到**合成 quad**（`MeshBasicMaterial` + 同一套 `CustomBlending` 因子，采样的是非预乘的对象 RT），隔离内容材质只做普通 alpha 写入；见 §7.1 的 `colorBlendMode ∈ {6,7,31}` 条）。**未实现的模式回退普通 alpha 混合**（不静默画错）。关键性质：`BlendScreen(A, 0) = A` —— Screen 下纯黑底完全不改变背景（GTR 左上角黑块就是漏了这条：`clouds.tex` 78% 是不透明纯黑）。全库非零的只有 3 个对象：3743126786=7、2832263418=6、2460786246=31。
### §5.7

7. **粒子 alpha 属性链**：透明度 = 生命周期衰减 × alpha（`alpharandom` 等经属性链传入），JS ShaderMaterial 与 wasm 粒子层双路径同语义；改 alpha 相关逻辑要双路径验证（`wasm/tests/particle_alpha_tests.rs` + `tests/particles.test.ts`）。
### §5.8

8. **场景资源禁止浏览器缓存**：`/wallpapers/scene/<id>/asset` 返回 `Cache-Control: no-store`，改资源无需清缓存。
9. ~~**wasm 效果链的历史卡点（已绕开，勿重走）**~~：naga 24/25 的 **glsl frontend 编译不了含 `uniform sampler2D` 的 GLSL**（`NotImplemented("variable qualifier")`），而几乎全部 WE 效果 shader 都采样 `g_Texture0`。现行链路是 **GLSL → `@webgpu/glslang` → SPIR-V → `spirv-webgpu-transform`（把组合采样拆成独立 texture+sampler）→ naga `spv-in` → WGSL**（`glsl-to-naga.ts` 产 `chain_desc`，wasm 侧 `effect.rs::spv_to_wgsl` 编译）；`chain_desc` 为空/解析失败才回退内置演示 pass（绝不白屏）。
    - **2026-09-22 作废**：整条链路与它的所有依赖（`@webgpu/glslang`、`naga`、`spirv-webgpu-transform`、`glsl-to-naga.ts`、`effect.rs`）**已随 WebGPU 渲染器删除**（§7.14）。主路径的效果链走 three.js 的 GLSL 路径（`effect-chain.ts` + `effect-runner.ts`），与本条无关。仅作历史记录保留。
### §5.10

10. **对象级效果链管线要点**（`wasm/src/render/mod.rs`，备用路径）：每带效果对象一条 `ObjectEffectEntry` / `ParticleObjectEffect`，流水线 = 内容 → 对象 RT → 效果链 ping-pong → 输出 RT → 合成 quad 贴回 surface；对象 RT 尺寸逐轴钳制 `[1, 4096]`，合成 quad **不钳制**、靠 UV 窗口只采样可见段。效果链创建失败 → 合成 quad 采样内容纹理（对象正常显示、无效果）。
    - **订正**：本条早先记「钳制 `[1, 2048]`」，与代码不符。实际值是 **4096** —— wasm 侧 `wasm/src/render/effect.rs:225` 的 `OBJECT_RT_MAX = 4096.0`，three 主路径 `src/client/object-range.ts:15` 的 `OBJECT_RT_MAX = 4096`（两条路径同值）。2048 会把满屏主图（如 2560×1440）钳小、主图被裁剪且合成 quad 只剩钳制窗口（Clamp 出竖直色条），故当初已提到 4096，只是文档没跟上（2026-09-14 订正）。
### §5.11

11. **效果链的一切编译/建管线必须在加载时一次性完成**（`EffectChain::new` / `set_object_effect` / `set_particle_object_effect`）；`render_frame` / `render_object_effects` / `step` / `EffectChain::render` **不得**做 naga 编译或建管线（每帧只写 uniform + 建 bind group + 提交 pass）。
### §5.12

12. **音频管线**：`createAudioAnalyzer` 频谱 → EffectRunner 音频 uniform + visualizer 条高；壁纸 `sound` 数组经 `playWallpaperSound` 接入（autoplay 被拦时 context suspended、可视化全零，用户手势后恢复）；无 Web Audio → 全零静音。
### §5.13

13. **测试沙箱**：vitest / esbuild 依赖 service 子进程（命名管道），受限沙箱下报 `spawn EPERM` —— 需完整权限运行。
    - **2026-09-20 补充**：同一条命名管道限制**也会让 headless Edge 根本起不来** —— 受限沙箱下启动即 `FATAL:mojo\public\cpp\platform\platform_channel.cc:183] Check failed: . : 拒绝访问。 (0x5)`。⇒ **真机 / 端到端验收同样必须完整权限**（不要误判成 flag 问题或 Edge 装坏了）。完整权限下 vitest 正常（`effect-runner` / `object-effects` / `three-renderer` / `threejs-player` 实测 189 项全过）。
### §5.14

14. **WE 内置粒子纹理走 host 路由，不随包分发（2026-09-11）**：粒子材质引用的纹理（`particle/fog/fog1`、`particle/halo` …）是 **WE 的第三方素材**。早先由 `build:client` 从本机 WE 目录复制成 `dist/static/ptex-*.tex`，结果被 `files: ["dist"]` 一并打进 npm 包（解包 43 MB 里 33 MB 是它）。现在 client 请求 **`/wallpapers/particle-texture?name=<相对 assets/materials 的路径>`**（路由见 `src/host/routes.ts`），由 host 从用户本机 `<weAssetsDir>/assets/materials` 直读。要点：
    - **`name` 就是材质纹理的原始相对路径，不能无条件加 `particle/` 前缀** —— 全库有 `workshop/<id>/particle/...` 这类路径（`2897292240` 的雨粒子）；
    - 别名表 `PARTICLE_TEX_ALIASES` 的值是「去 `particle/` 前缀」的短形式，命中后要补回前缀；
    - **纹理可能在壁纸自己的 pkg 里：路由带可选 `id`，先在 `scene.pkg` 的 `materials/<name>.tex` 找，再回退引擎目录（2026-09-29）** —— 依据 WE 挂载顺序（lwe `Container::m_mountpoints` 顺序遍历：壁纸目录/scene.pkg 挂在引擎 assets 之前）。回归：`3793620838`「In the Mountains 21:9 w lofi」的两只鸟纹理（`particle/BIRD TEST 3 FILTER`、`workshop/2478413376/particle/bird sprite sheet`）只在 pkg 内，旧路由 404 → client 白图兜底 + `maskMode=0` → 每个粒子渲染成**软圆点**（用户现象「是一个个圆圈状的光点」）。全库 30 张 / 125 个粒子对象里 5 个属此类（`1280029027` 的 `presets/lightshaft` 此前被别名表掩盖、`2897292240` 的 `...blank`）。
    - 代价：该路由属 host 侧，**升级插件后需重启 `dsh web`** 才注册；weAssetsDir 探测失败时纹理缺失 → 回退纯色粒子（不白屏）；
    - **普通 scene 素材也走「pkg → 引擎目录」两级查找（2026-10-10）**：字体（`fonts/X.ttf`）此前只在 pkg 里找 ⇒ 11 个 text 对象落回退字体（见 §5.28）。现在 `/wallpapers/scene/<id>/asset` 在 pkg 未命中时回退 `<weAssetsDir>/assets/<name>`（`isSafeAssetName` + `resolveEngineAsset`，只放行相对路径），顺序与 WE 的挂载顺序一致。
    - 验证脚本：`research/verify-particle-tex-fallback.mjs`（全库扫描每个粒子的纹理路径能否解析到真实文件）。
    - **`util/*` 效果纹理槽也走同一路由（2026-09-14，提交 `78e898f`）**：效果链引用的 WE 内置素材（`util/noise`、`util/clouds_256`、`util/white` …）同样不在壁纸 pkg 内，**必须优先从 WE 安装目录取真身**（`loadEffectTextureSlot`：① `util/*` 真身走 `/wallpapers/particle-texture` → ② 程序化回退 → ③ 壁纸 pkg 资源；沿用 `alphaPriority: false` 的效果遮罩语义）。踩过的坑：`resolveBuiltinTexture` 曾把 `util/noise` 与 `util/clouds_256` 映射到**同一张**程序化**均匀白噪声**（`mulberry32` 逐像素随机），而 WE 里它们是两张**结构化噪声**（263 KB / 200 KB）⇒ `vhs` 拿它调制扫描线/失真，结果变成**满屏杂乱条纹**（CP2077 `2454403969` 真机截图；修复前 Laplacian 均方 152.3 → 修复后 39.3，且「本该平滑区的高通残差」天空 2.35→1.08、扫描线区 4.37→1.81，证明下降来自去掉白噪声而非细节损失）。回退路径现在把两者拆成两个 key、两个不同种子。注意 `_rt_*` **不试真身**（WE 目录下无任何 `_rt_*` 文件，尝试必然 404），保留程序化回退且不告警。
    - **`prewarm()` 只在「寿命随机」时打散相位（2026-09-29）**：寿命**固定**且**池会满**（`rate × 寿命 ≥ maxcount`）时，真实稳态是「同批同步」—— 一批同龄粒子一起飞、一起死，再补下一批（`3793620838`：`Birds` life=25 固定 / rate=20 / maxcount=8 ⇒ 每 ~25 秒一波 8 只；用户实测桌面「每隔半分钟一群小鸟飞过去」）。此时随机打散相位会把整群摊成年龄均布 ⇒ 每刻只剩零散几只（用户报告「数量比桌面少」）。判别式 `fixed_life && rate×mean_life ≥ maxcount`，全库只有这张壁纸的 2 个对象命中（其余 7 个固定寿命对象的池都不满，116 个随机寿命对象不变）。实测时序（21:9 视口，每 3s 采样）：`obj133` 8→8→0…→8（周期 ~25s），`obj202` 50→50→0…→50（周期 ~31s）。**批内必须错开出生**（2026-09-29 补）：把同批相位全设 `age=0` 会让整群挤成一点（实测 50 只乌鸦只占 **44 px** 横向跨度，用户报「位置太集中」）—— 真实稳态里这批要花 `maxcount/rate` 秒发射（Bird 2s / Birds 0.4s），故批内 `age_frac ∈ [0, batch_span/life]` 随机；改后乌鸦群横向跨度 **44 → 179 px**。**仍未实现**（2026-09-29 已实现大半）：`controlpointattract` —— `obj202` 的 CP1 就在发射点（`scale=-200`、`threshold=100`），桌面端粒子一出生就被径向推开（初速 25 → ~200 px/s 且四散），这是「桌面比我们更分散」的主因。实现见下条。
    - **`controlpointattract` 已实现（2026-09-29）**：官方语义是 `diff = center - pos`，`|diff| < threshold` 时 `vel += normalize(diff) * scale * dt`（OWE `ParticleParser.cpp:1368-1386`；**`threshold` 不除以 2**，lwe 除以 2 是它的偏差；`scale` 为负 = 推离控制点）。控制点位置 = spec 的 `controlpoint[i].offset`（相对粒子系统位置；`flags` bit0 `link_mouse`、bit1 `worldspace`）**加上** instanceoverride 的 `controlpointN`（`ParticleRuntime.cpp:602-628`）。三个必须注意的点：① **空间对齐** —— 控制点 offset 要落到与 `p.pos` 相同的基准（`we_to_three(obj_origin) + emitter.origin×BLACKMYTH_OBJ_SCALE`），否则 `|cp - pos|` 恒大于 threshold、算子静默失效（首次接入实测跨度毫无变化）；② **worldspace 控制点**需要对象的 world←spawn 变换（对象 angles/scale），本模拟器未接收这两个参数 ⇒ 这类控制点（本壁纸 CP2/3/4）**不生成算子**，宁可不生效也不用错坐标推坏画面；③ **link_mouse 控制点不生成算子** —— 官方位置还要加 `mouse_local`，桌面鼠标居中时它落在场景中央、离发射点极远（CP1：2180 ≫ threshold 100）⇒ 实际不推任何粒子；DSH 无鼠标输入，按 `mouse_local=0` 处理等于把它钉在发射点上、凭空造出强力排斥源（实测整群炸到 **986×695 px**，用户报「乌鸦太分散」）⇒ 跳过；④ 位置在 instanceoverride 落地后才定，故由 `resolve_controlpoint_attract` 在 `CpuParticleSim::new` 里 override 之后调用。**实测**：这张壁纸的 CP1（link_mouse）与 CP2/3/4（worldspace；对象 `angles=-π` 使世界点映射到 spawn 空间后落到 (-4444,931)、离粒子 4500 单位）**都不生效** ⇒ 乌鸦群的自然分布就是「批内错开 + 速度差」的 **178×53 px**；`Birds` 无此算子，不受影响。
    - **精灵表序列帧已按官方语义推进（2026-09-29）**：`animationmode` 只有 `randomframe` 是「spawn 时随机固定一帧」，**其余值（含缺省）都是 `sequence`** —— 帧号 = `(1 - life/initial_life) × sequencemultiplier × 帧数`，再按帧数 wrap（官方 `AnimationLifetime`：OWE `ParticleRawGenerator.cpp:154`；`ToAnimMode` 见 `SceneParticleObjectParser.cpp:94`）。此前一律按 randomframe 处理 ⇒ 帧**永不推进**（`3793620838` 的小鸟不扇翅膀，24 帧精灵表还只用到 0..3 帧）。影响面：全库 125 个粒子对象里**只有 2 个**是多帧精灵表（就是这张壁纸的两只鸟），其余 114 个是单帧纹理（frames≤1 ⇒ 帧恒 0）⇒ 零回归面。
### §5.15

15. **对象级 RT 的三条不变量（2026-09-14 真机 bug 修复回写，对应 `076ad36` / `ecfcc10` / `3fd6b00`；改这块先读代码注释）**：
    - ① **局部正交相机的 left/right/top/bottom 是「世界坐标范围」**，对象内容也以世界单位绘制 ⇒ 相机必须覆盖**完整对象世界尺寸**（`Math.abs(worldW/worldH)`，`threejs-player.ts:796-807`）。两个踩过的坑：**拿 RT 像素当范围**（`076ad36`）⇒ dpr>1 时相机多覆盖 dpr 倍、内容只占 RT 的 1/dpr、合成 quad 再按全窗口拉回世界尺寸 ⇒ 对象缩小 + 边缘 clamp 拉伸（HiDPI 真机整张壁纸错乱；headless 里 `dpr ≡ 1` 时 rt == world，故端到端漏检）；**按 `OBJECT_RT_MAX`(4096) 钳制范围**（`ecfcc10`）⇒ RT 只覆盖对象中央，UV 窗口外侧被 CLAMP 采样 ⇒ **边缘拉伸带**（GTR `3743126786` 背景对象世界宽 7430 > 4096 ⇒ 右侧 22% 画面宽是条纹）。超限对象的正确代价是「**分辨率低**」（欠采样），**不是**几何裁剪。
    - ② **RT 的像素尺寸 = `|world| × 屏幕密度`（= 对象在画布缓冲上的**占位像素**），等比收口到 4096**（`object-range.objectRtSize`，`src/client/object-range.ts:270-289`；密度 = `object-range.screenScalePx` = 画布缓冲宽 / cover 视锥宽，`:230-249`）。**2026-09-14 换口径**（详见 §5.21）：旧口径「`min(world × dpr, 视口 × dpr, 4096)`」把**预算当成了基准**，与屏上占位差 0.8%（GTR 实测 RT `1280×714` vs 占位 `1290×720`）⇒ 合成那一步是比 0.992 的双线性缩小 + 亚纹素相位漂移 ⇒ 整层锐度 −52%。基准必须是**未钳制**的 `world`（image = `|size × scale|`、particle = `particleWorldSize`），**不能**用 `objectCameraRange` / `particleObjectRange` 的 `range`（那是「相机范围」语义、逐轴钳到 4096；`3fd6b00`）：实测拿 range 当基准得 **720×720**（7430×4147 对象、1280×720 视口），贴回屏幕要放大 1.78× ⇒ 大幅背景壁纸整层明显模糊。image 与 particle 两条路径都如此（`three-renderer.ts:300-341`）。
    - ③ **`isolate` 的键是 `scene.json` 的对象 id**（`isolate.objectId`），**不是** player 的图层计数器 id —— 背景 / 粒子各有一个从 0 起的独立计数器，撞键会让同一壁纸的隔离 image 与 particle 互相覆盖（后建覆盖先建，quad 从此采样一张永不被渲染的 RT）。`isolatedObjects()` / `setObjectOutput(id, …)` / `resizeObjectRT(id, …)` 收的都是对象 id（`threejs-player.ts:766-771, 824-825`；`three-renderer.ts:337-340`）。
### §5.16

16. **效果纹理槽编号 + sampler `combo` 派生（遮罩是否生效由这两条共同决定）**：
    - **`textures[i] → g_Texture(i)`**（**不是** `g_Texture(i+1)`）：WE 官方文档明写 textures 依次绑到 `g_Texture0, g_Texture1, …`（`.superpowers/we-layerd-src/third_party/wallpaper-engine-renderer/wpdoc/scenejson.md:22`），实现见 `effect-runner.ts:429-435`。写错会让**所有效果的纹理槽整体错位一个** ⇒ mask / 方向图落到别的 sampler、shader 采到默认纹理（shake 的 flowmask 采白 ⇒ `flowMask≈1.0` ⇒ 全图位移）。
    - **sampler 声明带 `"combo":"X"` 时，该槽被绑定（scene.json 的 `textures` 对应项非 null）即置 `X = 1`**，`scene.json` 的 `pass.combos` 显式值优先（`shader/effect-chain.ts:77-95`，必须在 `preprocessWeShader` **之前**）。缺失会让 `#if MASK` 的**局部作用分支永不启用** ⇒ 效果全图生效（`pulse` / `foliagesway` 的 mask 分支）。
    - 这两条加上下面两条纹理语义，就是 GTR 从「整屏晃动 + 整屏脉冲」回到桌面 WE「只抖排气管、女孩脸上反光一闪一闪」的全部原因（`3031158`）。
### §5.17

17. **`g_TextureNResolution` 的 vec4 分量：四分量一律同值 = 纹理各分支实际上传的宽高** —— 正确的不变量是「**四分量一律同值 ⇒ `.z/.x` 与 `.w/.y` 恒为 1**」（A1 起 `fxRes` 由各分支自报「即将上传的 `(w,h)`」：视频内在尺寸（0 时回退 mip0 记录）、编码图像解码尺寸、raw 裁剪尺寸、DXT `ceil4` 尺寸；无 `fxRes` 的 RT 按同口径回退自身尺寸 = 其上传尺寸）。效果 shader 用 `.z/.x` 缩放遮罩 UV（`waterripple.vert` / `shake.vert` 的 `v_TexCoord.zw = uv * g_Texture1Resolution.z / g_Texture1Resolution.x`），比值必须为 1；**本机库内不存在**按 padding 分配的纹理（编码图像类 `createImageBitmap` 解出即上传；原始像素载荷类经 `cropToMap` 裁到内容宽高后上传）⇒ 上传的纹理被内容占满，填 `.tex` 头的分配尺寸会让 NPOT 遮罩按 分配/内容 挤向画面左上 —— ⚠️ **真实残留**是 `fxRes` **无法表达「内容域偏移」**（WE 的 `(内容宽,内容高,打包宽,打包高)` 语义，见 `mesh-shaders.ts:26-32`）：本实现每分支只报一个 `(w,h)` 对，故 `cropToMap` 对 `flags & 4`（sprite）**刻意不裁剪**（`tex-loader.ts:285`）也满足该不变量 —— A1 之前「sprite + header padding ⇒ `.z/.x = 1` 对它不再成立」的旧断言已作废。为此 `withSprite` 把「本分支即将上传的宽高」写成 `[w, h, w, h]` 存进 `tex.userData.fxRes`（`tex-loader.ts:470-478`，`fxRes` 的唯一生产者）；`resolveTextureResolution4` 读该字段，**RT 等无该字段的纹理按同口径回退为 `(w, h, w, h)`**（`effect-runner.ts:305-320`，回退 `return` 在 `:317-319`）。

    **2026-10-12 修复归档（分支 `fix/mask-uv-npot`：`b8df5e2`…`cdbdd56`；触发 = 用户报告「魔兽之门湖面波动跑到湖上方树上」）** —— 审计脚本在 gitignored 的 `output/blur-analysis/`（`mask_placement.py` / `mask_scope.py` / `shader_audit.py` / `tex_padding_scope.py` / `fxres_npot_miprecord_scan.py`），数字全部随文留档（不能只留路径）：

    - **遮罩几何验算**（`mask_placement.py`：从 `scene.pkg` 直接解码遮罩图，`1922570576`）—— 两张 `waterripple_mask` 的 `header(分配)=4096×2048 / mip0(内容)=2500×1200`，padding 比 **1.6384 × 1.7067**：

      | 遮罩（`materials/masks/`） | 遮罩内「水域」非零区（遮罩自身 UV） | 旧口径落点（`uv × 分配/内容`） | 现口径落点（比值 = 1） |
      |---|---|---|---|
      | `waterripple_mask_c5b9…` | u∈[0.025, 0.366] **v∈[0.784, 0.862]** | u∈[0.015, 0.224] **v∈[0.459, 0.505]** | 同左（v∈[0.784, 0.862]） |
      | `waterripple_mask_7413…` | u∈[0.393, 0.854] **v∈[0.828, 0.992]** | u∈[0.240, 0.521] **v∈[0.485, 0.581]** | 同左（v∈[0.828, 0.992]） |

      水域（画面底部 v≈0.78–0.99）被旧口径整体搬到 v≈0.46–0.58，即树线一带 —— 与真机现象逐点吻合；叠加图 `output/blur-analysis/mask_placement.png`（红带 = 旧口径落点，绿带 = 比值 1 落点）。

    - **全库 shader 表达式分类**（`shader_audit.py`：按**大小写不敏感**的 `type.lower() == "scene"` 口径 —— 命中 **471** 行、归一化后 **40** 种表达式，33 张 scene 壁纸里带 shader 文本源的 **21** 张；其中 5 行来自本仓库自身 `src/`（`mesh-shaders.ts` 2 + `threejs-player.ts` 3），其余全部来自壁纸包）：
      ⚠️ **口径订正**：初稿的 **376 行 / 32 种 / 17-of-28** 是只扫 **`type == "scene"`（大小写精确匹配）的 28 张**得到的 —— 本机库另有 **5 张 `type == "Scene"`**（`2236329190` / `2911105183` / `2937346640` / `3765967112` / `3780477933`；`AGENT.md` §5.31 早已记过 `type` 实测有 `"Scene"`）被整批漏掉。其中 **4 张带 shader 文本源**，贡献 **95 行**（`2911105183` 47 / `2937346640` 18 / `3765967112` 16 / `3780477933` 14）与 **8 种新表达式**；脚本设 `SCENE_MATCH=exact` 可复现旧的 28 张口径。初稿另记的 380 行 / 33 种含 `src/` 注释里被删掉的 4 行引文、1 种表达式，不是 shader 用法。

      | 类 | 表达式（归一化后，括号内为出现行数；**粗体 = 本轮重扫新增**） | 行数（库级 / 旧 28 张） | 需要哪个量 |
      |---|---|---|---|
      | **A 遮罩 / 纹理 UV 缩放** | `v_TexCoord.zw = vec2(uv.x * .z/.x, uv.y * .w/.y)`（86+98）、`a_TexCoord` 版（20+38）、`v_TexCoordMask.zw = vec2(.z/.x, .w/.y)`（32）、`v_TexCoordMask.xy = …`（16+12+2）、`v_TexCoord.z *= .z/.x`（14）、`v_TexCoord.w *= .w/.y`（14）、**`vec2 t2 = .xy / .zw`（2）** | **334** / 268 | **比值** `.z/.x`、`.w/.y`（须为 1） |
      | **B 尺寸（texel 步长 / 顶点偏移 / 归一化基准）** | `blurredCoords += 0.75 / .zw`（6）、`offsetX/offsetY = g_Scale.x/y / .z/.w`（8+8）、`v_TexCoord.z/.w = g_Scale.x/y / .z/.w`（9+9）、**`.x / min(.w, .z)`（3）**、**`.y / min(.w, .z)`（3）**、**`textureScale = .zw * g_TextureReductionScale`（1）** | **47** / 34 | **真实（上传）尺寸**（A1 起 = 各分支实际上传尺寸） |
      | **C `.xy` 当尺寸** | `vec2 offsets = 1.0 / .xy`（10）、`0.5 / .xy`（5）、`v_TexCoord.zw += 0.5 / .xy`（5）、`v_StepSize = 1.0 / vec4(-.xy, .xy)`（4）、`ApplyCompositeOffset(…, .xy)`（4）、`v_PointerUV.xy *= 0.5 / .xy`（1）、**`#define pixelSize (1.0 / .xy)`（2）** | **31** / 25 | **真实（上传）尺寸**（A1 起四分量同源同值） |
      | **D 宽高比 + 注释行** | 共 **14** 种 / **59** 行。**非注释 9 种 / 48 行**：`.x/.y` 4 种 —— `rippleTextureAdjustment = (x/y)`（14）、`ratio = x/y`（4）、`uv.x *= x/y`（2）、`x_norm = abs(uv.x)/(0.5*x/y)`（2）= 22；`.z/.w` 2 种 —— `aspect = z/w`（14）、`aspect = z/w * g_Ratio`（6）= 20；`.y/.x` 1 种 —— `v_PointerUV.w = y/-x`（2）；`.zw/.xy` 1 种 —— `mapped = zw/xy`（2）；**`.xy / .y` 1 种 —— `ratCorr = xy/y`（2）**。**注释行 5 种 / 11 行**：`//float ratio1 = x/y`（2）、`//float xyRatio = x/y`（2）、`//float aspect = z/w`（4）、`// 粒子纹理的「高/宽」比…`（2）、`//   texelRatio 纹理 高/宽…`（1）。**22+20+2+2+2 = 48，48+11 = 59**（`x`/`z` 等分量均指 `g_TextureNResolution`；逐条原文见 `output/blur-analysis/shader_audit_ci.txt`） | **59** / 49 | 图像长宽比（同源） |

      合计 334+47+31+59 = **471** = 命中行数（旧口径 268+34+25+49 = 376）。※ D 类的 `.zw/.xy`（2 行，REPO 自研 `mesh-shaders.ts` 的 UV 缩放比值）语义上近 A 类，为与旧稿可比仍计入 D。

      **结论（降级为有证据的限定表述，勿再写成全称）**：在**已审计的全部 40 种用法**中，需要的是 **比值**（A 类 334 行：遮罩 / 纹理 UV 缩放；D 类 59 行：宽高比）与 **真实上传尺寸**（B 类 47 行 + C 类 31 行：texel 步长 / 顶点偏移 / 归一化基准）这两类量；**未发现**需要「分配尺寸」这个量的用法 —— 即没有任何用法要求 `.zw` 保持 `.tex` 头的打包尺寸。其中 **8 种表达式显式把 `.z`/`.w` 当尺寸用**（B 类的 `0.75/.zw`、`g_Scale.x/.z`、`g_Scale.y/.w` 各 2 式、`.x/min(.w,.z)` 与 `.y/min(.w,.z)`、`.zw * g_TextureReductionScale`），它们的正确值是**实际上传的纹理尺寸**：该轮口径对 `mip0 记录 == image` 的 **44** 个是**修正**，对 `mip0 记录 == 分配` 的 **51** 个逐分量不变（当时其 `.x/.y` / `.z/.w` 作为 texel 步长仍偏约 1.6×；**A1 已补齐**：现由各分支自报裁剪后的上传尺寸，偏差消除）。另两条精确化：① B 类「texel 步长偏小 1.64×」这句话**只对 44 个会变的那一类成立**（如魔兽之门的旧口径 `.z/.x` = 1.6384）；② D 类内部曾自相矛盾（同文件里 `.x/.y` 内容比 2.083 vs `.z/.w` 分配比 2.0，相差 4%），A1 后四分量同源同值 ⇒ 该矛盾**消失**。

      **新增的 8 种表达式对本机库当前是零行为影响**（逐条已读上下文，见下表）—— 它们证明的是**初稿的全称结论不成立（审计域漏了 5 张壁纸）**，而不是新增了一处回归：

      | # | 表达式（原文） | 所在壁纸 / 文件:行 | 判定 | 理由 |
      |---|---|---|---|---|
      | 1 | `g_Texture1Resolution.x / min(g_Texture1Resolution.w, g_Texture1Resolution.z),` | `3780477933` `shaders/workshop/2179455321/effects/dot_matrix_mobile_fix.frag:72` | **尺寸**（ii） | 归 B 类：`min(.w,.z)` 是「短边像素尺寸」这个量；旧口径里分子 `.x`（内容）与分母 `min(.w,.z)`（分配）**混了两个空间**（自相矛盾），新口径四分量同源 ⇒ 内部一致。该槽 `g_Texture1` 是材质默认 noise map（`util/clouds_256`，POT）、该壁纸唯一 `.tex` 也是 POT（不在 23 张 NPOT 清单）⇒ 本次数值不变 |
      | 2 | `g_Texture1Resolution.y / min(g_Texture1Resolution.w, g_Texture1Resolution.z)` | 同上 `:73` | **尺寸**（ii） | 同 #1（Y 分量） |
      | 3 | `#define pixelSize (1.0 / g_Texture0Resolution.xy)` | `2911105183` `shaders/workshop/2798319181/effects/gaussian.frag:18`、`bokeh_blur.frag:16` | **尺寸**（ii） | 归 C 类：只用 `.xy`，而本次修复**只改 `.z/.w`** ⇒ 数值恒不变；`g_Texture0` 是 pass 链输入（RT 或无 `fxRes` 纹理走 `(w,h,w,h)` 回退）⇒ 无影响（A1 起 `.xy` 亦为实际上传尺寸，该槽是 POT 的 `util/clouds_256` ⇒ 仍不变） |
      | 4 | `//float ratio1 = g_Texture1Resolution.x / g_Texture1Resolution.y;` | `3780477933` `…dot_matrix_mobile_fix.frag:70` | 注释行（非可执行） | 归 D 类：被注释的宽高比，无行为 |
      | 5 | `//float xyRatio = g_Texture0Resolution.x / g_Texture0Resolution.y;` | 同上 `:83` | 注释行（非可执行） | 同 #4 |
      | 6 | `vec2 ratCorr = g_Texture0Resolution.xy / g_Texture0Resolution.y;` | 同上 `:85` | **比值**（i） | 归 D 类：只用 `.xy` / `.y`，本次修复不改这两个分量 ⇒ 数值恒不变 |
      | 7 | `vec2 t2 = g_Texture2Resolution.xy / g_Texture2Resolution.zw;`（用于 `texSample2D(g_Texture2, v_TexCoord.xy / t2)`，`:134`） | 同上 `:133` | **比值**（i） | 归 A 类：这是「打包/图像」比值式的遮罩 UV 缩放。旧口径 `.xy` = 内容、`.zw` = 分配 ⇒ `t2` = 内容/分配 = 0.61 ⇒ `uv / t2` = `uv × 1.64`，NPOT 遮罩会被采样到 `[0,1]` 之外并被 CLAMP —— 与 `waterripple` 同根因；新口径 `t2 = 1` ⇒ `uv × 1`，与本插件的上传口径（内容占满整张纹理）一致 ⇒ **修正**。该槽是材质默认 `util/white`（POT）且该壁纸无 NPOT `.tex` ⇒ 本机库当前数值不变 |
      | 8 | `vec2 textureScale = g_Texture0Resolution.zw * g_TextureReductionScale;` | `2911105183` `shaders/effects/skew.vert:25` | **尺寸**（ii） | 归 B 类：把 `.zw` 当**像素尺寸**换算顶点偏移（`position.x += textureScale.x * …`）。该行在 `#if MODE == 1` 内，而该壁纸 3 个 `skew` pass（对象 `108`/`144`/`148`）都**未设 combos** ⇒ MODE 取默认 0（UV 模式）⇒ 该行不参与编译；`g_Texture0` 亦为 pass 链输入（RT）⇒ 本机库当前零影响。若将来某壁纸以 `MODE=1` 用它，则新口径给出的 `.zw` = 实际上传尺寸（**修正**；A1 起对 padded raw 也已是裁剪后的上传尺寸，1.6× 偏差消除） |

      **没有任何一种新表达式属 (iii)「真的需要分配尺寸」**：**本机库内**不存在按 `.tex` 头 padding 分配的纹理（编码图像类 `createImageBitmap` 原图上传；原始像素载荷类 `cropToMap` 裁到内容宽高）⇒ 要求「分配尺寸」的用法在当前实现下无对象；⚠️ **A1 后的残留**是 `fxRes` **无法表达「内容域偏移」**（WE 的 `(内容宽,内容高,打包宽,打包高)` 语义，见 `mesh-shaders.ts:26-32`）：`cropToMap` 对 `flags & 4`（sprite）**刻意不裁剪**（`tex-loader.ts:285`）也不违反「四分量同值 ⇒ `.z/.x = 1`」这一不变量（A1 之前「sprite + header padding ⇒ 不成立」的旧断言已作废）。将来若改做真 padding 上传（方案 B），才需要把 `.zw` 恢复为分配尺寸并重扫上表（见 `AGENT.md` §7.37）。

    - **影响面**（`tex_padding_scope.py` + `fxres_npot_miprecord_scan.py`；**库级口径 = `type.lower() == "scene"`，本机壁纸库快照 33 张**，对照列为初稿的 28 张 `type == "scene"` 精确匹配口径）：

      | 口径 | 库级（33 张，本轮真值） | 初稿（28 张） |
      |---|---|---|
      | 全库 `.tex` | **218** 个（`materials/masks/` 113 / 其它 105） | 175 个（遮罩 92 / 其它 83） |
      | `header ≠ image`（NPOT padding） | **95** 个（44%），分布 **23** 张壁纸 | 88 个（50%），21 张壁纸 |
      | 其中**会变**（`mip0 记录 == image`，**编码图像类（NPOT 集合内无视频样本）**） | **44** 个（`imageFormat=13` 31 + `=2` 13；含遮罩 **15**） | 38 个（27 + 11；含遮罩 15） |
      | 其中**不变**（`mip0 记录 == 分配`，**原始像素载荷（带 padding）**） | **51** 个（TEXB0003 `imageFormat=-1` 49 + TEXB0002 1 + TEXB0004 1；含遮罩 **26**） | 50 个（48 + 1 + 1；含遮罩 26） |

      **数字变化的来源**：初稿的 175/88/21 是**只扫了 `type == "scene"` 的 28 张**（大小写精确匹配漏掉 5 张 `type == "Scene"`）⇒ 不是数字凭空变了，而是审计域被补全。新增的 7 个 NPOT 全部落在 `2911105183`（6 个，均会变）与 `2236329190`（1 个，不变）；**遮罩侧数字不受口径影响**（新增的 5 张壁纸只有 POT 遮罩）—— 库级 NPOT 遮罩仍是 **41** 个、仍只涉及 5 张（`1429403119` 21 / `1922570576` 3 / `1968789468` 4 / `2011060960` 12 / `2132420420` 1）。

      新值与旧值**逐分量相等 iff `mip0 记录 == 分配`**（库级头部扫描无第三类，二分穷尽）；51 类的上传路径是「mip0 载荷本身 = 分配尺寸，上传前经 `cropToMap` 裁到 image」⇒ 旧 `.z/.x` 本就是 `分配/分配 = 1`，本次**零改动**。⚠️ 该类的成因表述必须用「**原始像素载荷（带 padding）**」，**不得**写成「全部 `imageFormat=-1`」（库里另有 1 个 TEXB0002 其 `imageFormat` 为 None，同机制）；只会变的 44 类**不得**写成「视频类」：**NPOT 集合内无视频样本** —— 库内另有 2 个视频样本（`2911105183` 的 `materials/CP_ads_01/02.tex`，`flags=35`、`alloc == image == 1280×720`、载荷含 `ftyp`），是 POT ⇒ **不在** 44/51 二分内（同文件 §5.23 记的「实测样本」即这两个，不矛盾）。遮罩侧 `header ≠ image` 的 **41** 个中：**会变 15 个**（`1922570576` 3 + `2011060960` 11 + `2132420420` 1）、**不变 26 个**（`1429403119` 21 + `1968789468` 4 + `2011060960` 1）—— 用户报告的「魔兽之门」属会变那批。

    - **e2e 真机实测**（`e2e/verify/verify-isolated-rt-sharpness.mjs --gpu`，串行；探针 = `window.__fxResProbe()`，加在 `e2e/harness/harness-text-clock-entry.mjs:228-260`；两条判据在 `e2e/verify/verify-isolated-rt-sharpness.mjs` 的判定段）：
      - 单张 `1922570576`：探针 **21 槽、`bad=0`**；命中遮罩 `obj=13 slot=1 tex=[2500,1200] z/x=1.0000`；两条判据 PASS，**exit 0**。
      - 全清单（修复当时的 **5 张**）：**5/5、exit 0**；判据①在 **262** 槽（21+65+8+88+80）上逐槽要求 `|z/x − 1| < 1e-6`，**零样本判 FAIL**；判据②（2500×1200 遮罩已绑定且口径为 1）只对 `1922570576` 断言，其它张打印**显式 SKIP**（该素材专属该张，不静默跳过）。**A2（2026-10-12）起缺省清单扩到 8 张**（+ `2011060960` / `2132420420` / `1968789468`）⇒ 现为 **8/8、exit 0、357 槽**（21+65+8+88+80+58+10+27）；判据①的作用域不变（全部 8 张全部槽无条件），判据②仍只对 `1922570576`。
      - **反向验证**（临时把 `src/client/tex-loader.ts` 回退到修复前提交 `7ba4eca`）：**exit 1**，`FAIL 遮罩槽分辨率口径 z/x === 1 ← 3/21 处异常，例：obj=13 slot=1 z/x=1.6384`（**1.6384 = 4096/2500**，与该张 3 个 NPOT 遮罩的条数、比值完全吻合）。**A2 对新增张的同法反向验证**：`--id=2011060960` → **exit 1**、`11/58 处异常，例：obj=634 slot=2 z/x=1.1907`（= 2048/1720，与该张 11 个会变遮罩吻合），恢复后 **exit 0**。
      - **谁守卫生产（勿写错）**：**守卫生产代码的是 `tests/tex-loader.test.ts` 的 fxRes 用例**（A1 后共 5 条：`:824-827` 的 `[100,50,100,50]`、`:839-843` 的比值 1、`:845` padded-raw、`:857` sprite 早返回、`:871` DXT `ceil4` —— `tex-loader.ts:475` 一回退它们就红，**不得削弱 / 删除**）；`tests/effect-runner.test.ts:608-628` 是**消费者侧契约钉**（用例内合成字面量、不调用 `textureFromTex`，其中第 3 条仅做判据灵敏度自证）。判据用法见 `TESTING.md` §2.5。
    **2026-10-12 A1 修复归档（分支 `fix/fxres-actual-upload-size`：`51a3b4f`…`687b038`）** —— 触发 = 语义正确性 + 对未来素材的健壮性（**预期与实测均无观感变化**）：

    - **改动**：`withSprite(tex, w, h)` 增参，4 个调用点各报「即将上传的宽高」（视频 `videoWidth/Height`、编码图像解码 bitmap、raw `cropToMap`/`cropRowsToMap` 的返回、DXT `cropCompressedToMap` 的块对齐尺寸）。上文影响面表的「会变 / 不变」是 `mask-uv-npot` 轮的口径 —— A1 起**那 51 个 padded raw 也变**（由分配尺寸改为 `cropToMap` 裁剪后的上传尺寸），其 `.x/.y` / `.z/.w` 的 1.6× 偏差消除。变更集（e2e 8 张清单范围内）= **51** 个纹理。
    - **单测**：padded-raw（alloc 256×128 / image 100×50）⇒ `[100,50,100,50]`；DXT 块对齐 **60×30 ⇒ `[60,32,60,32]`**（`ceil4`，**只在该 fixture 出现，本机库 0 实例**）；视频 `mip0 ≠ 视频尺寸` ⇒ 以视频为准；视频内在尺寸 **0 ⇒ 回退 mip0 记录**（`[1280,720,1280,720]`）；既有三条断言**逐字保留**。
    - **e2e 实测**（`verify-isolated-rt-sharpness.mjs --gpu`，8 张清单）：**8/8、0 FAIL、exit 0**；判据①（`z/x === 1`）全部槽全绿；`xOverTexImage` **234 个可比槽偏离 0**（357 槽中 **123 槽无 `texImage`** 不可比）。**反向验证**（把 `tex-loader.ts` 回退到 A1 前）：`1429403119` **21/56 → 0**、**exit 1 → 0**；恢复后 `git diff --stat -- src/` 为空。

### §5.18

18. **R8 / RG88 有两套通道语义，不能混用**：`convertUnormToRgba(data, format, alphaPriority = true)`（`tex-loader.ts:490-515`）——
    - 缺省 `true` = **粒子纹理**语义（`TextureFlags_AlphaChannelPriority`：形状 / 覆盖写在 R（R8）或 G（RG88）通道）：R8 → `vec4(1,1,1,r)`、RG88 → `vec4(r,r,r,g)`；
    - `false` = **效果纹理槽**语义：R8 → `(r,r,r,1)`、RG88 → `(r,g,0,1)` —— 效果 shader 直接读 `.r` / `.rg` 当**遮罩数值**（`pulse.frag` 的 `float mask = texSample2D(g_Texture2, v_TexCoord.zw).r;`、`shake.frag` 用 `.rg` 取两个方向分量），按粒子语义会让 `.r` 恒为 1 ⇒ mask 失效 ⇒ 本该局部的效果覆盖全图（真机「GTR 整屏脉冲 / 整屏抖动」的主因）。
    - 调用方：`EffectRunner.resolveTextureSlot` 传 `{ alphaPriority: false }`（`effect-runner.ts:390-393`）；粒子纹理路径保持缺省 `true`（`tex-loader.ts:531-537`）。
    - ⚠️ **待办（2026-09-14 发现）**：这个语义的**权威来源应是 `.tex` 头的 `TextureFlags_AlphaChannelPriority`（bit19 = 524288）**，现在却由**调用方路径**推断（效果槽一律 `false`）。对当前库恰好正确，但语义来源错了。全库 **82 张** `.tex` 带此位。
### §5.19

19. **`.tex` 的 flags 必须被消费（2026-09-14，提交 `9306ae6`；权威定义见 `research/.lwe/.../Data/Assets/Texture.h:91-97`）**：`textureFromTex` 曾只读格式与尺寸、**把 flags 整个丢掉**（sprite 那一位除外），已暴露三类语义偏差：
    - **`ClampUVs = 2`（bit1）—— 已修**：WE 默认 **REPEAT**，**仅带此位才 CLAMP**（lwe `CTexture.cpp:176-183`）。曾一律落到 three 默认 `ClampToEdgeWrapping` ⇒ `clouds.frag` 有意把第二组 UV 旋转到负象限（`cloudTexCoods.zw = vec2(-w, z)`，u ∈ [-0.5, 0]），clamp 下 `cloud1` **全部塌到纹理最左一列**（该列 R 均值 0.706 vs 全图 0.494）⇒ `cloudColor = cloud0*cloud1` 从推导的 ≈0.24 抬到 **0.419** ⇒ CP2077（`2454403969`）**整屏偏白**，且**随时间越来越白**（相位 60 s 亮度 105.93；修复后 68.91）。**全库 477 张 `.tex` 中 105 张因此由 clamp 改 repeat**（pkg 内 12/166、素材库 93/311）。
    - **`NoInterpolation = 1`（bit0）—— 待办**：`applyLinearSampling` **无条件**设 `LinearFilter` + `LinearMipmapLinearFilter`，带此位的纹理（全库 **4 张**）本该 `NearestFilter` ⇒ 被插值偏糊。
    - **`ClampUVsBorder = 8`（bit3）**：按 lwe 的 `CTexture` 路径落 REPEAT（全库 **0 张**带此位，当前无实际影响，语义未验证）。
    - ⚠️ **RT 纹理必须保持 CLAMP**：`object-range.ts` 的对象合成 quad 依赖它。`WebGLRenderTarget` 不经 `textureFromTex`，所以只要不改 RT 创建处就安全 —— **别在别处一律改成 repeat**。
### §5.20

20. **纹理 v 轴约定：WE 是 `v=0` = 图像顶部；效果链一侧必须按 WE 约定、显示路径保持现状（2026-09-14，提交 `426446c`；报告 `v-convention-report.md`）**：
    - **WE/lwe 证据**：`research/.lwe/.../CTexture.cpp:84` 直接 `glTexImage2D(..., dataptr)` 上传 `.tex` 原始字节，**只有 `glPixelStorei(GL_UNPACK_ALIGNMENT, 1)`、无任何垂直翻转** ⇒ `.tex` 第一行 → `v=0`，v 沿图像**向下**。
    - **我们的显示路径**：`textureFromTex` 翻行序（`v=0` = 图像底部）+ mesh UV 不翻 ⇒ **画面正确**（不颠倒），但**效果 shader 里的 v 语义与 WE 相反** ⇒ **用 v 表达的方向量整体反向**（`waterflow` 带符号位移的**纵分量**、`clouds` 旋转 UV、`foliagesway` 摆动、相位图）。真机表现 = 「**方向对但位置/斜度不对**」（Crimson Horizon `3765967112` 的水流）。注意：流动区域的**位置**取决于两侧是否同约定 —— 一直是**对的**（别误判成"条带被镜像"）。
    - **修法（窄修，勿全量迁移）**：只在**效果链一侧**按 WE 约定加载（`tex-loader` 的 `rowOrder` 参数 + `effect-runner` 的 `{load}` 注入点 + `object-effects` 注入 topDown 加载器），并用「**隔离局部相机 y 镜像** + 合成 quad 的 `flipGeometryUvY` 反镜像**精确抵消**」⇒ RT 内容与 mask 同约定、画面仍正立。**显示路径（背景 / 粒子 / text / 共享场景 / scene-renderer）一行未改**。
    - **为什么不做全量迁移**：那要改 4~8 个显示采样点（含**未接入、无法端到端验证**的 `scene-renderer` 与 text），**漏一处就是整图上下颠倒**；收益却与窄修相同。
    - **判据（权威对照）**：第三方 WE 约定 CPU 参照（`research/dsh-wallpaper-engine-v0.7.1` 的 we-renderer `effectWaterflow` 逐字调用）在流动 band 内 —— **修复后 0.04/255**、修复前 1.29/255 ⇒ 修复后与 WE 约定的实现几乎逐像素一致（仅 `PERSPECTIVE=0` 路径可对照）。
### §5.21

21. **对象 RT 的尺寸口径 = 屏占位；屏幕密度必须与主相机 cover 同源、mount 与 resize 同源（2026-09-14，用户「scene 壁纸不如桌面 WE 清楚」的机械归因）**：
    - **现象与归因**（证据：`.superpowers/sdd/2026-09-14-three-object-effects-pipeline/clarity-report.md`，逐环节把 RT/效果输出读回后测同口径 Laplacian）：隔离路径相对**直渲**锐度 −52%（Laplacian 均方 `713.2 → 341.5`，与 dpr 无关、与 MSAA 无关）。定界结果：内容→对象 RT **712.9**（−0.04%）、效果 pass **711.2**（−0.24%）、**合成 quad→屏幕 341.5（−52%）** ⇒ 纯 RT 往返无损，损失 100% 在最后一步重采样。机制 = RT 像素网格与对象在屏上的**占位像素网格**不一致（旧口径 `1280×714` vs 占位 `1290×720`，比 0.992）⇒ 双线性 + 亚纹素相位漂移把最高频成对平均掉。
    - **口径（现）**：`RT 像素 = |世界尺寸| × 屏幕密度`，单一等比收口到 4096。密度 = **画布缓冲宽 / cover 视锥宽**（`object-range.screenScalePx`，与 `ThreeScenePlayer.applyCover` 共用 `coverRange`）。**为什么两者必须同源**：screenScale 是「世界 → 设备像素」的线性映射，用视口宽当分子、用场景宽当分母就退化成旧口径（差 0.8%）。**mount 与 resize 必须是同一个数**：挂载期由 `three-renderer` 用纯函数算（player 此刻还不存在），resize 期取 `player.screenScalePx()`（player 的 state 刚被 `resize()` 更新）—— 旧实现「两处各算一份预算」正是 `3fd6b00` 那类「挂载期对、任何一次 resize 又被打回」地雷的同源结构（已删：`ObjectEffectStage` 不再持有 dpr/预算，只持一个 `screenScale`）。
    - **实测（GTR `3743126786`，headless Edge/SwiftShader，声明视口 1280×720，相位 5 s，`--no-particles`）**：隔离（纯 `shake` 对照）**711.1** vs 直渲 **713.2（−0.3%）**、逐像素 MAD **0.0414**（修复前 341.5 / MAD 1.804）；全效果链 **675.1**（修复前 313.3；与归因实验的仪器值 675.1 逐位吻合）；`dpr=1 vs dpr=2` 下采样后 MAD **2.075**（= 直渲地板 2.105；修复前隔离 5.503）；挂载期 RT `1612×900`（窗口 1400×900@1）→ `__fxApplyViewport()` 后 `1290×720`，两次都与独立 oracle 相符（唯一 ID 断言为门禁）。
    - **显存代价（全库 15 个带线性效果链的壁纸 / 40 个隔离对象，审计脚本 `research/q-rt-vram-sweep.mjs`）**：`1920×1080@dpr1` 合计 530 MB（旧口径 386 MB）、单壁纸最大 **131.8 MB / 中位 27.9 MB**（旧 39.0 / 23.7；最坏倍数 3.38×，来自把 3840×6000 的对象整体按屏密度栅格化 —— 它比屏幕高 2.8×，可见区只占 1/3）；`@dpr2` 与 `4K@dpr1` 单壁纸最大 **245.7 MB**（旧 156.1，1.57×）、中位 95.0（旧 94.9 / 63.2）。结论：**典型代价 ≈ +18%、最坏 +3.4×（均为 dpr=1）**，4096 硬上限仍把单对象钉在 ~107 MB。`objectRtSize` 保留第 4 个参数 `cap` 作为**逐对象字节预算**的预留口子（实测 `cap = min(4096, 1.5×视口长边)` 只收窄 2/40 个对象、最坏降到 121.5 MB；`2×` 一个都不收窄 —— 因为超屏对象的问题在**短边**，真要用得按轴设），需要时只改调用点 + oracle，不动口径。
    - **已知边界**：未与桌面 WE 做像素对照（只证明「我们比自己直渲糊 52%」⇒ 已修到 ±0.3%）；WE 的对象 RT 是**源纹理真实尺寸**（lwe `CImage::getSize()`，GTR 相当于 5.76× 超采样），我们取 1:1（最小无损）**不复制**其超采样（需 352 MB/对象）；对象远大于屏幕（占位 > 4096）时仍是无 mipmap 的缩小 ⇒ 锯齿，真超采样要「×2 占位 + RT mipmap」（归因报告里的方案 F，**未验证**）；`scene-renderer.ts`（wasm 备用路径）仍是旧口径，本期未动。

### §5.22

22. **渲染进 RenderTarget 必须「透明清屏」（清屏 alpha = 0）——「整片黑块」的根因（2026-09-15，用户报告 `2911105183 Subway Station` 很多地方是黑的）**：
    - **机制**：three 的清屏 alpha 由 `WebGLRenderer` 的 `alpha` 构造参数决定（`WebGLBackground`：`let clearAlpha = alpha === true ? 0 : 1`）。主路径是 `new THREE.WebGLRenderer({ canvas, antialias: true })`（`alpha` 缺省 **false**）⇒ **clearAlpha = 1**；这份状态是 renderer 级的，`renderer.render()` 渲染到**任何 RenderTarget** 时**同样生效** ⇒ 每个 RT 都被清成**不透明黑 `(0,0,0,1)`**。于是：
      - **对象 RT**：隔离对象内容本身透明的地方（WE 图层普遍带 mask / alpha）留成不透明黑；
      - **效果链 ping-pong RT**：效果把 alpha 降下去的地方（`opacity`、各类 `*mask`）——normal 混合的 rgb 因子是 `SrcAlpha` ⇒ rgb 被乘成 0；而 alpha 通道的 blendFunc 是 `(ONE, ONE_MINUS_SRC_ALPHA)` ⇒ **alpha 只增不减、恒为 1**（不是「透明的黑」，是**不透明黑**）；
      - **合成 quad** 用 `MeshBasicMaterial` 采样这张 RT（普通 alpha 混合）⇒ 采到 alpha=1 的黑 ⇒ **直接盖在主场景上**。注意：走 `colorBlendMode ∈ {6,7,31}` 的合成 quad 用 CustomBlending（`blendSrcAlpha=Zero/blendDstAlpha=One`、颜色因子不看 alpha）⇒ **不受影响**（GTR 全隔离对象都是 cbm=7，A/B 实测逐像素无差）。
    - **实测（headless Edge/SwiftShader + `lib/` 生产代码，1280×720，`research/tmp-2911105183/render-lab.mjs`）**：`2911105183` 全画面纯黑（RGB 全 <12）像素 **31.1% → 0.7%**；其中 **obj 130**（一张全屏背景 + 带 mask 的 `opacity` 效果）单独就占 **26.3 个百分点**（只渲染 obj 13 + obj 130 两个对象时黑像素仍是 26.3%，剥掉该对象的效果则 0.7%）。定界实验：把 `opacity.frag` 改成 `albedo.a = 1.0`（不降 alpha）→ 黑区消失（0.7%）；改成 `albedo.a = 0.0`（全透明）→ 全屏 **100%** 黑 ⇒ 链路上「alpha 降下去 ⇒ 输出不透明黑」确凿。
    - **修法**：`src/client/rt-render.ts` 的 `renderIntoRenderTarget()` —— 渲染前置 0、渲染后恢复原值。两个调用点：`threejs-player.renderIsolatedContents()`（对象 RT）与 `effect-runner.update()`（ping-pong RT，编译探针的 1×1 RT 也走同一入口）。**刻意不改 renderer 的 `alpha` 参数**：`alpha: true` 会让画布在未绘制处变成透明（画布背后是 DSH 页面），是另一种可见行为变更、波及全库。
    - **顺带修掉的既有遗留（§7.4 旧条目）**：`2597392171`（`copybackground: true` 的两个全屏图层走隔离路径「接近全黑」）的**真因就是本条**，不是 copybackground 语义缺失 —— 同一 A/B（把 `setClearAlpha` 打成 no-op 复现旧行为）实测：旧行为全画面均值 **14.03/255**（与早先记录的 15.3 / 14.98 一致），修复后 **83.99/255**（与「去掉 effects 不隔离直渲」的 81.0 对齐），黑像素 86.6% → **0.0%**。
    - **GTR `3743126786` 无回归**：同一 A/B 下旧行为/修复后黑像素都是 12.0%，全画面均值 47.78 vs 47.77（原因见上：其隔离对象全是 cbm=7 的 Screen 合成 quad，混合因子不看 alpha）。
    - **回归测试**：`tests/rt-render.test.ts`（置 0 → 渲染 → 恢复；无 get/setClearAlpha 的 mock 静默跳过）、`tests/threejs-player.test.ts`「隔离内容渲染用透明清屏（clearAlpha=0），主场景渲染保持原值」、`tests/effect-runner.test.ts`「pass 渲染时清屏 alpha=0，渲染后恢复原值」。

### §5.23

23. **WE 视频纹理（`flags` bit5 = Video）已实现（2026-09-15）：`.tex` 的 mip0 载荷是完整 mp4，直接交给浏览器解码**
    - **形态**：带此位的纹理（权威定义 `research/.lwe/.../Data/Assets/Texture.h` 的 `TextureFlags_Video`）mip0 **不是像素数据**，而是一个**完整 mp4 文件**。实测样本（全库唯一）`2911105183` 的 `CP_ads_01/02.tex`：`ftyp isom/iso2/avc1/mp41`、H.264、1280×720、**27.41s / 27.73s**、1024 万字节、**无音轨**（moov 里只有 `avc1`）。此前按原始 RGBA 解 ⇒ 广告牌画成乱码（清屏修复前是不透明黑块，修复后是透明）。
    - **判定**（纯函数 `isVideoTexPayload`，node 可测）：`flags & 32` **且** mip0 前 8 字节是 mp4 的第一个 box（`?? ?? ?? ?? 'ftyp'`）。两个条件都要 —— 只看 flags 会把「标了 Video 位其实是像素」的包当视频，只看 magic 会误判恰好以该四字节开头的像素数据。
    - **建纹理**（`tex-loader.videoTextureFromMp4`，必须排在**编码图像与原始像素两条分支之前**）：`Blob(video/mp4)` → `URL.createObjectURL` → 离屏 `<video muted loop playsInline preload=auto>` → 等 `loadeddata`（5s 超时）→ `THREE.VideoTexture`。实测（`research/tmp-2911105183/probe-video-play.mjs`，headless Edge）：`readyState=4`、`duration=27.41`、静音 `play()` 成功、`texImage2D(…, video)` 后 `glError=0` ⇒ 浏览器原生解码即可，不需要解封装/前端解码器。
    - **三个不显然的约束**：① **静音自动播放**（壁纸没有用户手势）：`muted + playsInline` 才允许起播，被策略拒绝时挂一次性 `pointerdown/keydown` 重试；② **不进 mip 链**（`VideoTexture` 每帧 `needsUpdate`，`generateMipmaps` 会每帧重建整条 mip）⇒ 强制 `LinearFilter` + `generateMipmaps=false`；③ **生命周期不归 GPU 管**：`renderer.dispose()` 只释放 WebGL 资源、**不会停解码**，故清理挂在纹理的 `dispose` 事件上（`tex.addEventListener('dispose', release)` → pause + 清 `src` + `revokeObjectURL`），并要求调用方**真的 dispose 纹理**（见下条）。
    - **行序**：与 ImageBitmap 分支同一套语义 —— 显示约定（`rowOrder` 缺省 bottomUp）`flipY=true`；效果槽约定（`topDown` = WE 的 v=0=顶部）`flipY=false`。
    - **不可播时的降级**：返回 **1×1 透明纹理** + 一条可辨识 `console.warn`（**不是** null、**不是**当像素解码）。理由：`createLayerMaterial(map: null)` 会退回**白色不透明**面板；而 mp4 位流当 RGBA 解是乱码，且载荷常比 `w×h×4` 小 ⇒ 原始路径的 `flipRows` 会**越界抛错**。
    - **附带补的一处资源所有权缺口**：`three-renderer` 此前不释放本次装配的背景纹理（注释口径是「随 `renderer.dispose` 清理」，对 GPU 纹理成立、对视频不成立）⇒ 现在 `teardown()` 显式 `texture.dispose()` 本次 `backgroundTextures`，壁纸切换即停播 + 撤销 Blob（否则每切一次漏一个仍在解码的视频 + 一份 10MB Blob）。**边界**：效果**纹理槽**用的纹理（`EffectRunner` 的 `this.textures` 缓存）仍不 dispose（槽里混有模块级共享的空槽常量纹理，误 dispose 会波及其他 runner；库内也无「视频纹理当效果槽」的用法）。
      - **2026-09-20 订正：该边界已消除（`textures.clear()` 那条缺口就是泄漏，见 §7.5）**。纹理槽缓存改为**按所有权释放** —— 模块级共享纹理（`BUILTIN_CACHE` / `EMPTY_SLOT_CACHE`）打 `userData.__shared = true`，`clearTextures()` 跳过它们；其余（本实例从 WE 目录 / 壁纸 pkg 加载的纹理）**必须 dispose**。原口径「一律不 dispose」会让同一 WebGL 上下文内每次 resize 泄漏约 28 张纹理。库内仍无「视频纹理当效果槽」的用法。
    - **验证**：单测 `tests/tex-loader.test.ts`（判定正/反例）+ `tests/dom/tex-loader-video.dom.test.ts`（jsdom + FakeVideo：VideoTexture/flipY/wrap/fxRes/dispose 清理/error 降级）+ `tests/three-renderer.test.ts`（teardown 释放纹理，切壁纸与 dispose 两条路径）；端到端 `research/tmp-2911105183/render-lab.mjs` 的 `bg-ads` 变体（只留静态背景 + 三个广告牌）两帧连拍：**只有两块广告牌区域在动**（粗网格 8×6 变化率 10.4%/5.2% 与 4.7%/2.1%，其余全 0.0%），整屏黑像素仍 **0.7%**、广告牌区域暗像素 **0.0%**。`research/verify-object-effects.mjs` 的 [2] 判据同步升级为「盒外 = 去掉全部**动画源**（时间驱动效果对象 **+ 视频纹理对象**）」——视频是独立于效果链的动画源，不建模它会把广告牌误判成「效果漫出盒子」（升级前该判据 FAIL：盒外最大差 155；升级后 PASS：盒外最大差 0）。

### §5.24

24. **uniform 注解里的**嵌套对象**必须完整解析（2026-09-15，用户报告 `3303428996 死亡搁浅-玛玛` 整屏黑）**：
    - **根因**：`extractUniformAnnotations` 用非贪婪 `\{[\s\S]*?\}` 抓 `// {...}` 注解，遇到**内层 `}`**（WE 注解普遍带 `"require":{"DIRECTDRAW":0}`、`"options":{...}`）就截断 ⇒ `JSON.parse` 失败 ⇒ **注解整体丢失** ⇒ binder 拿不到 `material` 映射与 `default`，uniform 落到「按类型全零」。修法：正则改为抓到行尾，再用 `takeBalancedJson`（配对花括号扫描）截出首个完整对象。
    - **为什么现在才炸**：`3303428996` 的唯一效果是 `effects/lightshafts`，其 **vert** 用 `inverse(squareToQuad(g_Point0..3))` 算透视矩阵 —— 四个点全 0 ⇒ 矩阵退化 ⇒ `v_TexCoordFx.z = 0` ⇒ `fxCoordRef.y` 为 Inf/NaN ⇒ `albedo.rgb = A + B*fx` 里 `B*0 = NaN` ⇒ 输出 NaN ⇒ 渲染成**不透明黑**（实测效果输出 RT 全 `(0,0,0,255)`，整屏 100% 黑）。此前这条 pass 因为 `float(format) == FORMAT_RG88`（§7.1 已修）**编译失败被跳过**，墙上那张图是「效果没跑」的状态；修好编译后效果真的跑起来，才暴露这个注解解析缺陷。
    - **影响面（全库 194 个 shader 扫描，`research/tmp-2911105183/scan-annotation-impact.mjs`）**：仅 **10** 条注解从「丢失」变「解析成功」——4 条是 `lightshafts` 的 `g_Point0..3`（本条修复对象）、5 条是 `blur_precise_gaussian` 的 `g_Texture2`（`mode:opacitymask` + `combo:MASK`；那些链属**具名 RT 图链**，2026-09-15 P2 落地后**注解已参与绑定** —— 但链是否真的挂载取决于它挂在什么对象上（全库有 10 条挂在 text/util 上不挂链），见 §7.1）、1 条是 `lightshafts` 的 `g_Texture2`（`RENDERING==1` 才用）。
    - **验证**：单测 `tests/shader-preprocessor.test.ts` 两条（嵌套 `require` 的 vec 注解完整解析；sampler 注解的 `mode`/`combo` 不丢）；端到端 `3303428996` 黑像素 **100% → 7.2%**（7.2% 是该图自身的暗部，与 `preview.jpg` 对比画面与「光柱」效果一致）；`2911105183` 复测仍 **0.7%**（无回归）。

### §5.25

25. **效果 pass 的 `blending: "normal"` = 覆盖（`ONE/ZERO`），不是 alpha 混合（2026-09-15，用户报告 GTR 左上云消失）**：
    - **WE 语义（参考实现逐字）**：`research/.lwe .../Render/Objects/Effects/CPass.cpp::setupRenderFramebuffer` —— `Normal → glBlendFuncSeparate(ONE, ZERO, ONE, ZERO)`（**直接覆盖**）、`Translucent → (SRC_ALPHA, ONE_MINUS_SRC_ALPHA, …)`、`Additive → (SRC_ALPHA, ONE)`；`MaterialParser::parseBlendMode` 未知值也回落 Normal。我们的 `blendModeToThree` 曾把 `normal` 映射成 three 的 `NormalBlending`（`SrcAlpha/OneMinusSrcAlpha`）⇒ pass 写 ping-pong RT（每 pass 都清成透明）时 **rgb 被乘一次自身 alpha、每过一个 pass 再乘一次**。
    - **症状与定界（GTR `3743126786` obj 246「Clouds Back」：scroll + waterripple + opacity，内容 alpha 0.5）**：修复前该对象的效果输出 RT **rgb 全 0**（alpha 0.13 = 0.5×0.26），合成是 cbm=7 Screen（颜色因子不看 alpha）⇒ 加 0 ⇒ **云整层不可见**；修复后输出均值 rgb 0→21.7（云的游动/涟漪可见）。为什么以前看不出来：§5.22 那轮修复之前 RT 被清成**不透明黑**，alpha 通道被 alpha blendFunc 钉在 1（不会逐级衰减），rgb 恰好不被继续乘 ⇒ 这个缺陷被「不透明清屏」掩盖了；§5.22 让 alpha 变真实后立刻显形。
    - **修法**：`blendModeToThree` 改为 `normal`/未知 → `THREE.NoBlending`（= `ONE/ZERO`），`additive/add` → Additive，`translucent/alpha` → Normal，保留 `multiply/subtract`（WE pass 枚举里没有，属我们既有扩展）。**注意**：pass 不再预乘 alpha 后，cbm 6/7/31 的合成就必须自己把图层 alpha 乘回来（见 §5.26，否则云层全强度盖住人物）。
    - **验证**：`tests/effect-runner.test.ts` 改断言（旧断言把 `normal` 记成 NormalBlending，是错的语义）；端到端 GTR 云层恢复（含 scroll 游动）；`2911105183` 复测 **0.7%**、`3303428996` 复测 **7.2%** 均无回归；验收脚本 [1][2][2-归因×2][2-有效性][3b][4] PASS。

### §5.26

26. **cbm 6/7/31 的合成 quad 必须把图层 alpha 预乘进 rgb（2026-09-15，用户报告 GTR 云挡住人物）**：
    - **WE 语义**：`colorBlendMode` 是 `mix(A, Blend(A, B), opacity)`（A=背景、B=图层、opacity=图层 alpha）——**opacity 参与**。我们的合成 quad 用 CustomBlending 复刻，而 Screen(7) 的颜色因子 `(OneMinusDstColor, One)`、31 的 `(One, One)`、6 的 `MaxEquation` **都不看 alpha** ⇒ 图层 alpha（`alpha 0.5` × `opacity 0.26` × mask）必须由片元预乘进 rgb。
    - **症状**：§5.25 让 pass 不再预乘 alpha 之后，云层以**全强度**Screen 叠加 ⇒ 人物区均值 61.6 → **85.8**（被云洗亮、「云挡住人物」），mask 也整个失效。修法：cb 分支的合成 quad 开 `mat.premultipliedAlpha = true`（three 的 `<premultiplied_alpha_fragment>` 会做 `gl_FragColor.rgb *= gl_FragColor.a`）。
    - **实测（GTR `3743126786`，同分辨率逐区域均值）**：人物区 85.8 → **58.7**（基线 5d4e3da 61.6）、云/天空区 65.8 → **43.0**（基线 46.4）、全屏 53.3 → 48.2（基线 48.9）⇒ 回到本会话之前的观感（云在人物之后、被 mask 排除）。
    - **已知近似（未做到 WE 的严格数学）**：对象 RT 的 rgb 本来就是「内容 alpha 预乘过」的（内容渲染走普通 alpha 混合），合成再乘一次最终 alpha ⇒ 半透明图层的贡献仍带一次多余的内容 alpha（GTR 云实到 `0.5×0.13`，WE 是 `0.13`）。要严格对齐得让内容侧写非预乘 rgb（或按 alpha 反除），改动面更大，本期不做。
    - **验证**：`tests/threejs-player.test.ts` 断言 cb quad `premultipliedAlpha === true`、cbm=0 quad 为 `false`；其它 cbm 用例（`2832263418` cbm=6、`2460786246` cbm=31）端到端黑像素正常（0.0% / 8.8%）。

### §5.27

27. **GTR 云 vs 桌面 WE 的量化对照（2026-09-15，用户提供桌面截图后实测）**：桌面截图（1920×1039，裁掉任务栏）缩到 1280×693 后对齐残差 5.97、scale 0.99、dx=dy=0（`research/tmp-2911105183/compare-desktop.mjs`）。区域亮度（我们 / 桌面）：云区 **46.3 / 48.1**（中位 40/41、云区核心 40.2/41.3）、天空无云 58.5/59.5、**城市灯 58.3/63.4**、全屏 46.0/47.9。⇒ **云层本身已与桌面一致（均值差 1~2/255）**；差异集中在**亮部发光**：云区 p99 **199 / 225**（**注**：这里的 **199** 与 §7.1 的「关 **200**」是**两次不同时间的「改动前」采集** —— 口径 / 时点不同，**并非矛盾**）、城市灯 p90 133/147，且桌面的发丝/路灯有明显的 bloom 光晕（`research/tmp-2911105183/lab/cloud-ab.png` 上下拼图可见）。结论（**2026-09-16 实现期订正：原归因是错的**）：~~这不是云层公式问题，而是被跳过的具名 RT 图链（`workshop/2822917890/bloom`）~~ ⇒ 桌面亮部更亮的来源是 **WE 的「应用级后处理」（Glow / 全屏 bloom）**，它由 WE 自己的配置开启（本机 `config.json`：`general.user.postprocessing = "enabled"`），**作用于整帧、不属于任何壁纸字段**，插件既读不到也无法被作者关闭 —— 我们**未实现**它（见 §7.1 的「应用级后处理未实现」条）。订正的四条证据：① **素材里没有那道光锥** —— 主图 `2222222222.tex` 解出来是 7430×4147 的 PNG（与 tex 头声明一致、无 padding），灯罩周围只有一小圈光晕，**没有**桌面对比截图里那道锥形光柱；② 壁纸级 **`general.bloom = false`**（不生效）；③ 对象级 `workshop/2822917890/bloom` 链经 P2 已执行，但其 `apply_mask`（R8）只有 **3.17%** 像素非零、位置在画面中右纵向 25–58%（跑车尾灯/右侧建筑），**不覆盖路灯**（实测生效区域 **3.14%**、逐格吻合）；④ 链参数已逐项验证正确（`p0` 的 `EMITTERMASK=1`/`MODE=0`，`p15` 的 `OPACITY=1`/`BLENDMODE=31` = `A+B*opacity`，`common_blending.h:263`）。P2 的落地依然正确且必要（它恢复了跑车尾灯/右侧建筑那块的光晕），只是**它不是**桌面亮部差异的成因。（**2026-09-20 订正**：该应用级后处理**已实现并默认开启**，见 §7.1 的「应用级后处理 ⇒ 已实现」子条；本条与 §7.1 用的**云区**口径即区域 **`[0,0,576,242]`**，颜色空间约定见 §5.32。）

### §5.28

28. **具名 RT 图链的执行语义（P2，2026-09-15；设计文档 `docs/superpowers/specs/2026-09-15-three-rt-graph-executor-design.md`）**：加载期由纯函数 `buildEffectPlan`（`effect-graph.ts`）把链编译成静态计划，`EffectRunner.setPlan` 按计划建**具名 RT 池**；帧内只查表绑槽 + 提交 pass（§5.11）。
    - **尺寸与作用域**：具名 RT = 对象 RT ÷ `fbos.scale`（未声明 = 1），**池作用域 = 单条链**（key 带链序号 ⇒ 两条链同名 RT 各持一份）；
    - **`bind.index` = `g_Texture<index>`**（**不是** `g_Texture<index+1>`），且 `bind` 优先于 `textures`；
    - **`previous` = 进入 target 序列前的输入**（即对象 RT 原图），**不是**上一 pass 输出 —— 按后者实现会让合成基底变成自己的模糊结果；
    - **写具名 RT 的 pass 编译失败 ⇒ 整条计划放弃**（回退对象 RT 原图）：派生读端会读到空 RT，P1 的「跳该 pass、读端不变」在这里不成立；
    - 引用链内不存在的 `_rt_*`（全库仅 1 处，全局运行时 RT `_rt_FullFrameBuffer`）⇒ 该槽**保持默认、不绑白纹** + 一条去重告警；
    - effect 级 `visible === false` 整条不挂链（全库 1 条，**不打降级告警** —— 作者正常内容）；**`visible` 仅由 three 主路径解析**（未接入的 `scene-renderer` / `wasm-renderer` 并源循环未过滤）；本期**未做显存 cap**；清屏沿用透明清屏（§5.22），与 lwe 的 `LoadOp::Load` 有差异，但写具名 RT 的 pass 全是全屏覆盖写 ⇒ 清与不清同结果（**全库复核 2026-09-15**：**62** 个写具名 RT 的 pass 的 `blendMode` **全部**为 `normal` —— 即 `blendModeToThree` 映射到 `NoBlending`(ONE/ZERO)，**0 例外**；脚本 `research/q-named-rt-blendmode.mjs`，只读、gitignore）。
### §5.29

29. **combo 宏必须跨 stage 合并（2026-09-15，提交 `eab01aa`；缺陷早于 P2，P2 放开准入后才暴露）**：`effect-chain.ts` 在两次 `preprocessWeShader` **之前**，把 vert/frag **两侧**的 `[COMBO]` 默认值合并进同一份 `combos`（序同 wasm 路径 `glsl-to-naga.passCombos`）。依据：WE/lwe 的 combo 是 **per-pass**（lwe `ShaderUnit.cpp:694-714` 互并、WE layerd 两个 unit 共用一份 `shader_info->combos`），而预处理器按**单个 stage** 兜底 ⇒ 一侧从 `[COMBO]` 取 `NOISE 1`、另一侧被 `#if` 裸标识符兜底成 `0` ⇒ frag 引用 vert 未声明的 varying ⇒ **program 链接失败**（链接错误不在 shader info log 里，旧告警看不到原因）⇒ 命中「写具名 RT 的 pass 失败即整条计划放弃」。**不要只特判某个宏**：修掉 `NOISE` 后 `KERNEL` 的 varying 数组长度不匹配会立刻顶上。

### §5.30

30. **web 壁纸 iframe 必须「与自身资源同源 + 与宿主跨源」——opaque origin 沙箱会让 WebGL 类壁纸整片空白（2026-09-16，用户报告 `3789244610 Night City Rain (Kiroshi Boulevard)` 报错）**：
    - **现象**：切到该壁纸后 console 报 `Uncaught (in promise) DOMException: The operation is insecure.`（Chromium 同处文案 `SecurityError: Failed to execute 'texImage2D' … Tainted canvases may not be loaded.`），并伴随 `img/city.jpg` 404 + `OpaqueResponseBlocking`；画面空白。
    - **根因**：`background-layer.ts` 的 `showWeb` 用 `sandbox="allow-scripts"`（**无** `allow-same-origin`）⇒ 壁纸文档是 **opaque origin**，按规范它**自己的** `img/city.png` / `city-loop.webm` 也算跨源 ⇒ rain 渲染器 `createTexture` 里 `texImage2D` 抛 SecurityError ⇒ init 中断、`window.__rain` 从不建立 ⇒ 空白。设计文档里「无跨域」的假设本身不成立：**沙箱就是跨源**。
    - **实测（headless Edge + CDP，同一份壁纸文件）**：`sandbox="allow-scripts"` → SecurityError；同一路径换另一回环主机名且不沙箱 → `window.__rain` 建立、画面正常（`research/_web-wallpaper-sandbox-probe*.mjs`）。
    - **修法**：`showWeb` 把 iframe 指向**另一个回环主机名**（`127.0.0.1` ↔ `localhost`，DSH webserver 两个都接），并保留 `sandbox="allow-scripts allow-same-origin"` —— 壁纸与自身资源同源（贴图可用）、与宿主页**仍跨源**（实测父页读子帧 DOM 抛 SecurityError，隔离不降级，因为允许同源只影响它自己的 origin）。另一主机名探活失败（非回环访问等）则兜底回同源 + 纯 `allow-scripts`（隔离优先，WebGL 类壁纸降级，见 §7）。
    - **端到端**：`research/_web-wallpaper-origin-e2e.mjs`（自起 harness + 反代 `/wallpapers/*` 到真实 DSH，用生产代码 `lib/client/background-layer.js`）：插件侧 10 项全 PASS（含 `window.__rain`、隔离、`scrolling=no`、画面非黑），另有 2 条 INFO 报告**壁纸自身**的既有问题（见下条，按用户要求不修）。
    - **壁纸自身的三个问题（已定位，但 2026-09-16 起按用户明令「不得改壁纸目录」——只记录、只报给用户，由用户在创作源里改）**：① `css/style1.css:46` 的 `url(../img/city.jpg)` 指向不存在的文件（目录里只有 `city.png`）⇒ 404（Firefox 另报 `OpaqueResponseBlocking`）；② `index.html` 的 `<nav class="slideshow__nav">` 为空 ⇒ `index.min.js` 的 `h()` 里 `document.querySelector("[href='#slide-1']")` 为 null ⇒ `i.classList.add(...)` 抛 `TypeError`（连带跳过 storm 闪电定时器与 `slide--current`）；③ 文档自身溢出（见下条）。**曾经的临时修法**（`city.png`、`i &&` 守卫、`body{overflow:hidden}`）已按要求全部回退，壁纸目录现为原始字节。
    - **同一壁纸的第二症状：横/纵两条滚动条（2026-09-16，用户追问「切换后出现横纵滚动条」）**：滚动条在**壁纸 iframe 自己的文档里**（宿主页 `vBar=0`，不是 DSH 页面在滚）。壁纸文档自身溢出时（问题 ③：`.image-preload` 的 `left:-9999px` 图簇实测 `bottom:1444`）**Firefox 计入可滚动溢出、Chromium 不计** ⇒ 只有 Firefox 出现纵向滚动条（实测 `innerWidth−clientWidth = 17`、`scrollHeight 1444 / clientHeight 666`），而壁纸的 `.slideshow{width:100vw}` 与 `#container`（`width = window.innerWidth`）都按「含滚动条」的视口宽算 ⇒ 反撑出横向滚动条（同样 17），`100vh` 再把纵向留住 —— 两条互相维持。**插件侧修法（唯一落地的一层）**：iframe 加 `scrolling="no"` —— Firefox/Edge 实测子帧 `clientWidth == innerWidth`、`vBar = hBar = 0`，即不出现滚动条占位，也对齐 WE 的 CEF 表现（背景层本就 `pointer-events:none`，滚动从不可用）。**代价**：`scrolling` 是 obsolete 属性，将来浏览器若忽略它，问题 ③ 的滚动条会回来 —— 根治仍在壁纸侧（`body{overflow:hidden}` + `.image-preload` 裁剪），需由用户在自己的创作源里改。探针 `research/_ff-scroll-probe.mjs`（页面自上报，Firefox 与 Edge 同页各跑一次，不依赖 CDP）。
    - **遗留**：壁纸自身仍有 `enableVertexAttribArray: -1` / `vertexAttribPointer: -1` 的 WebGL 警告（它的 water vertex shader 只声明 `a_position`，frag 却声明 `v_texCoord`），非致命、本次未动。
    - **桌面壳（`dsh-app://app`）承载已支持（2026-09-29，用户报告桌面版切到 `3789244610` 后无壁纸）**：桌面版 GUI 由 Electron 自定义协议承载 ⇒ `window.location` = `dsh-app://app` ⇒ `alternateLoopbackOrigin` 返回 null ⇒ 旧逻辑直接落 opaque origin 兜底（即本条 2026-09-16 的空白根因复现，console 报同一个 `texImage2D` SecurityError）。**修法**：`showWeb` 的承载 origin 交给 `planWebFrameOrigin(loc, readTransportOrigin())` 决策 —— ① **桌面壳公布的宿主 HTTP origin 优先**（`globalThis.__DSH_TRANSPORT__.streamBaseUrl`，官方接缝：`@deepseek-ai/dsh-client-connection` README 明确「静态桌面页面可以通过它提供其所拥有 Host 的 HTTP origin」，`@deepseek-ai/dsh-api-gateway` 也用它作流式基址）；它由壳保证可达故**不探活**，与宿主页同源时不采用（iframe 必须与宿主页跨源）；② 回环页维持「另一回环主机名 + 探活」（**web 版行为零变化**）；③ 其余退回 opaque origin 兜底。
      **另一收益**：桌面版下壁纸资源不再走 `dsh-app://` 代理 —— 该代理 `forwardWebRequest` 会丢弃 `content-length`，66 MB 的 `city-loop.webm` 在旧路径实测 `net::ERR_FAILED 200 (OK)`；改走真实 HTTP origin 后视频正常（`readyState 4`）。
      **实测**（headless Edge + 反代 `/wallpapers/*` 到真实 DSH，同一份壁纸文件，`output/playwright/wallpaper-{opaque,fixed,webpath}.png`）：opaque 分支 `window.__rain=false` + SecurityError + **整屏单一颜色**（亮度 std 0.00、唯一色 **1**）；HTTP origin 分支 `__rain=true`、无 SecurityError、158666 色；web 版生产代码路径（`lib/client/background-layer.js` + `localhost` 页）159920 色、行为一致。新增 8 项单测/DOM 测试，全量 976 项全绿；`e2e:colorblend` 全 PASS（场景链路未受影响）。

### §5.31

31. **`project.json` 的 `type` 大小写敏感 ⇒ web 壁纸被判 `unknown`、只剩 192×192 的 preview 图兜底（2026-09-17，用户报告 `3778198228 World of Warcraft: Classic | Login Screen`「DSH 里只放大了某一块，桌面能看全」）**：
    - **现象**：DSH 背景是被放大约 10 倍且糊掉的一块画面（只见拱门中段），桌面 WE 播的是完整 4K 视频。
    - **根因**：该壁纸写的是 `"type": "Web"`（首字母大写），而 `scanner.ts` 的 `kindFromProjectJson` 以 `t === 'web'` **大小写敏感**比较 ⇒ 返回 `unknown` ⇒ `resolveBackground` 既不是 scene（`hasScene=false`）也不是 video/web ⇒ 回落 `previewUrl`。它的 `preview.gif` 是 **192×192 的正方形裁切**，被 `.wp-bg-fill img{width:100%;height:100%;object-fit:cover}` 铺满视口 ⇒ **放大约 10 倍 + 纵向裁掉一半**，正是「某一块被放大」的观感。
    - **实测（headless Edge + 生产 `lib/`，1920×919 视口，脚本 `research/_wow-webcheck.mjs`，gitignore）**：坏路径 `img naturalWidth/Height = 192/192`、`clientWidth/Height = 1920/919`、`objectFit=cover`（截图 `research/.wow-webcheck/before-preview-image.png` 与用户截图构图一致）；修复后走 iframe，子帧 `videoWidth/Height = 3840×2160`、`readyState=4`、`!paused`、`currentTime=10.98`（`after-web-iframe.png` 为完整壁纸）。
    - **修法**：`kindFromProjectJson` 先 `trim().toLowerCase()` 再比较。影响面：全库**只有这一张**由 `unknown` 变为 `web`；另有 5 张 `"Scene"`（`2236329190`/`2911105183`/`2937346640`/`3765967112`/`3780477933`）此前同样误判 `unknown`，因 `hasScene=true` 侥幸仍走 scene 分支，画面无碍。
    - **残留（非插件缺陷）**：壁纸自身给 video 写死 `object-fit:cover`，DSH 窗口比 16:9 更宽时会纵向裁掉约 15% —— 作者设定，跨源 iframe 改不了，且 §6 禁止改壁纸目录。另：`/wallpapers/web` 路由整文件 `readFileSync`、无 Range 支持，该 webm 66 MB 实测能正常播放，大文件下的表现未专门测。

### §5.32

32. **应用级 Glow 的颜色空间在本仓库是「字节域恒等」⇒ 链内不做任何转换（2026-09-20；订正设计文档 §3.4）**：离线标定 `threshold = 0.65` 用的是 **sRGB 字节域**（PNG 像素），而 spec 原设计假定主场景渲染进 RT 得到的是**线性**值，要求 shader 内「线性 → `toSrgb()` → 算 luma / bright-pass / 各级模糊 → composite 后 `toLinear()`」。**该前提在本仓库不成立**：`threejs-player.ts` **强制 `outputColorSpace = LinearSRGBColorSpace`**（three 的 `linearToOutputTexel` 恒等），且全库纹理**未标 `colorSpace`**（采样不转换）⇒ 全链路**字节域恒等**；此时再插一次 `toSrgb(base)` 就是**二次编码**（threshold 等效约 **0.38** 域、发光范围远超 A 档）。实现按实测改为**链内不做任何颜色转换**（composite 直接渲到 canvas）。经验证据（也是自查手段）：关闭档云区 p99 **200** 与离线在 8bit PNG 字节域标定的 **200** **完全一致** ⇒ `0.65` 两边含义相同。⇒ 通用教训：**先确认 `outputColorSpace` 与纹理 `colorSpace` 的实际取值，再决定要不要手工对齐** —— 域错配的后果是阈值语义整体偏移（sRGB 域 0.65 ≈ 线性域 0.83），表现为「**几乎不发光**」而**不报错**。端到端判据（云区 p99 ≥ 215，区域 `[0,0,576,242]`）就是用来抓这类域错配的。

### §5.33

33. **纹理槽必须在探针渲染前**预建**进 `material.uniforms` —— `godrays_combine` 整屏近黑的根因（2026-09-21，用户报告 `2937346640`「背景一闪而过 / 近黑」）**：
    - **机制（three 侧）**：`materialProperties.uniformsList = WebGLUniforms.seqWithValue(program.seq, material.uniforms)` 只在**换 program** 时重算（`three.module.js:30611-30622`），上传走它（`:31008`）；而 `getMaterial` 的 1×1 编译探针渲染会先把 program 定下来 ⇒ **探针之后再往 `material.uniforms` 里补的条目永不上传**。`bindSlot` 的绑定语义本身没错（「缺席就补建」），补建了却不生效 ⇒ sampler 停在 GLSL 默认 unit 0，读到的是 `g_Texture0` 那张纹理。
    - **触发条件（我方口径）**：`effect-chain` 的 `samplerModes` **只收带 `mode` 注解的 sampler**（它的语义是「空槽绑什么常量纹理」），而槽预建范围曾**只看 samplerModes** ⇒ 全 `"hidden":true` 的 sampler 让该 pass 槽数算成 0。`2937346640` obj44 的 `effects/godrays` **末 pass**（`godrays_combine`：声明 `g_Texture0/1`，`scene.json` 未给 `textures`，`bind = _rt_HalfCompoBuffer2@0 + previous@1`）⇒ `g_Texture1`（albedo，本该是 `previous` 原图）读到 `g_Texture0` 的**光线 RT** ⇒ 输出近黑、alpha 恰为 2×（`albedo.a = rays.a + rays.a`）。
    - **修法**：`effect-chain` 新增 `samplerNames`（**全部** sampler 声明名，扫未预处理原始源）；`effectSlotCount` = `max(textures.length, g_TextureN 最大下标 + 1)`，声明来源 = `samplerNames ∪ samplerModes`。**未改 `bindSlot`**，也未改 `samplerModes` 的空槽语义（无 mode 的槽预置值仍是 `null`）。
    - **端到端（headless Edge/SwiftShader，1280×720，相位 5 s，`research/verify-hidpi-object-rt.mjs --id=2937346640 --dprs=1 --phase=5`）**：整屏平均亮度 **1.53 → 107.90**（摘掉全部效果链的参照图 108.36，差 0.46/255）；暗像素（luma<8）占比 **96.79% → 0.02%**；看图：修复前只有右上角时钟与左上几缕残光，修复后是完整的便利店橱窗 + 白发少女 + 暖橙火光。
    - **影响面（全库静扫 `research/_scan-slot-gap.mjs`，29 个 `scene.pkg` / 169 条链 / 240 个 pass）**：踩同一坑（声明了无 mode 注解且下标 ≥ 旧槽数的 sampler）的 **11 个 pass**，其中 **8 个**的该槽真的会被 `bind.index` 或 `textures[idx]` 绑定（即引擎本意要绑、却被静默丢弃），涉及 **5 张壁纸**：`3798688689`(4) / `2911105183`(3) / `2937346640`(2) / `2832263418`(1) / `2897292240`(1)。另有 **72 个 pass** 的槽数从 0→1 只是补上 `g_Texture0`（旧代码本就硬编码预建，行为不变）。
    - **遗留 / 未验证**：只有 `2937346640` 做了**像素级**端到端验证，其余 4 张壁纸的 10 个 pass 是静态认定 + 同一机制推断（未逐张出图）；预建更多槽只多几个 `uniform` / `Vector4` 条目与 `gl.uniform1i` 上传，**显存与绑定副作用未实测**；⇒ 通用教训：往 `material.uniforms` 里补条目必须在**首次渲染之前**完成，别指望「之后换 program 会重算」——1×1 探针渲染使该假设不成立。

### §5.34

34. **DSH 设置系统双路径：兼容 0.1.5-rc.3 / 0.1.6-alpha.2（旧）与 0.1.7-alpha.2（新）——用户升级后「配置不好使」的根因与修法（2026-09-23）**：
    - **断点**：0.1.7-alpha.1 起 `dsh-settings` 从 `SettingsProvider.register(ns, schema)` 换成 `SettingsForms`：命名空间 = **profile 条目 id**（本插件 `dsh-wallpaper-engine`，不再是短名 `wallpaper-engine`），表单只投影条目 `Config` 里 `.volatile()` 的字段（`volatileForm`，无 volatile 字段的条目不进 `describe()`），持久化到 profile `cordis.patch.yml`（旧版是 `$DSH_HOME/settings.yaml`）。旧插件于是：host 调 `settings.register` 命中 undefined（TypeError 在 `ctx.inject` 子 fiber 内被吞）、client 只找短名 ⇒ 永远匹配不到 ⇒ 回退 `DEFAULTS`：面板空、`/wallpapers/list` 空。
    - **两个「真会崩」的点**：① `settingsNamespace` 自 0.1.2-rc.1 起就不在该包的导出里（静态命名导入 = **链接期 SyntaxError**，此前没炸只因解析到插件自带的 `dsh-settings@0.1.0-rc.8` 副本）⇒ **不得静态 import 该包**；② `.volatile()` 需 `schemastery ≥3.18.4`（3.18.1/3.18.2 无此 API）⇒ 依赖已升 `^3.18.4` 并更新 lockfile。
    - **实现**：`src/host/settings.ts` 同时导出普通 `WallpaperSettingsSchema`（旧路径 `register` 用；volatile schema 在旧版解析取不到普通值）与 `Config = schema.volatile()`（新版 loader 用）；`Config` **必须挂在默认导出的 `apply` 上** —— loader 的 `unwrapExports` 在存在 default 导出时会丢弃命名导出。`apply` 内以 `typeof settings.register === 'function'` 分流：旧路径 `register(WALLPAPER_NS, WallpaperSettingsSchema, { base: configValue(config) })`（**base 必须传**，否则旧版面板读不到 config、也不会自动恢复选中壁纸），新路径 `configure({ auto: false }, ctx.fiber)`（owner 要显式给插件自身 fiber）。
    - **volatile 读值（真机 list 为空的直接原因）**：0.1.7 交给插件的 `config` 是 schemastery 的活引用（对象级 volatile ⇒ `config.get()` 才拿到普通对象）；直接读 `config.wallpaperDir` 得到 `undefined`。`state` 一律用 getter + `configValue()` 解引用，**不得在 `apply` 里快照**（loader 就地更新引用）。
    - **client**：`readClientSettings` 按候选 `['dsh-wallpaper-engine', 'wallpaper-engine']` 探测 `describe()` 行并记住命中的 ns；写入以该 ns 优先、其余候选兜底重试（`RemoteResult.ok === false` 也算失败），全失败 `console.warn` 且 `writeClientSettings` 返回 `false`，面板据此提示失败（此前静默 ⇒ 面板谎报「已保存」）。
    - **配置位置（用户侧，两版通吃）**：profile `cordis.patch.yml` 的 `- id: dsh-wallpaper-engine` + `config`。旧 `~/.dsh/settings.yaml` 已被 0.1.7 改名成 `settings.yaml.imported`（且 section 名与条目 id 不同名 ⇒ 未导入），profile `package.json` 的 `dsh.profile.config` 两版都不读。
    - **真机验收（2026-09-23，临时装的三个真实 DSH + headless Edge）**：0.1.5-rc.3 / 0.1.6-alpha.2 / 0.1.7-alpha.2 均 `/wallpapers/list` 200 / 5660B；旧版面板目录框显示 config 值、选中壁纸刷新后自动恢复（迁移前这两处都是坏的）；0.1.7 面板读到 config、点选壁纸把 `selectedWallpaperId` 写进 profile patch、刷新后自动恢复渲染（截图 `output/playwright/dsh017-rc2-wallpaper-restored.png`、`dsh015-rc3-panel-after-migration.png`）；`npm run e2e:colorblend` PASS（渲染零回归）。方案与清单见 `docs/superpowers/plans/2026-09-23-dsh-settings-compat-migration.md`。

### §5.36

36. **右侧栏「常驻遮罩」＝ 0.1.7 改了收起方式（2026-09-23，用户报告新版本所有壁纸右半边发暗）**：0.1.7 起 `.P3OORG_panel` 不再有 `visibility:hidden` 与自带底色，收起改成隐藏 **dock 子内容**（`[data-dockkit-host=dock]` / `[data-dockkit-empty]` / `[data-dockkit-divider]` 走 `translateX(var(--dsh-sidebar-width)) + visibility:hidden`，`[data-sidebar-right-open]` 才恢复）⇒ 面板容器本身成了**常驻、可见的透明空盒子**（`position:absolute; right:0`，宽 = 侧栏宽度）。插件那条「给面板容器补半透明底」（本意是打开时面板文字可读）于是把这个空盒子画成常驻遮罩：暗色 `rgba(24,26,30,.62)`（用户截图）、浅色 `rgba(255,255,255,.74)`。旧版（≤0.1.6）容器自带 `visibility:hidden`（实测收起时该元素甚至不在 DOM）⇒ 同一条规则显不出底，所以是 0.1.7 独有回归。
    - **修法**：两条半透明底规则加 `[data-sidebar-right-open]` 限定（该属性三版都渲染：`"data-sidebar-right-open": expanded || void 0`）。
    - **⚠️ 加了属性限定后必须同时 `:not([data-sidebar-right-panel="fullscreen"])`**（用户当天即报告「全屏背景变透明」）：属性限定把半透明底的具体度从 (0,2,1) 抬到 (0,3,1)，压过了全屏那条 `body[data-we-wallpaper] [data-sidebar-right-panel="fullscreen"]` 的 (0,2,1)（暗色下是 (0,4,1) vs (0,3,1)），真机全屏面板算到 `rgba(255,255,255,.74)` ⇒ 壁纸透上来。用 `:not(...)` 让两个选择器**互斥**，不依赖源码顺序决胜。
    - **⚠️ fullscreen 那两条也必须限定 `[data-sidebar-right-open]`（用户同一天第四报：「全屏后收起 → 整个页面没有任何内容」）**：收起按钮只调 `actions.toggleExpanded`、**不改 mode**（源码 `PanelChrome`），故「mode=fullscreen + 未展开」是**可达**状态：面板仍 `width:100vw`，但 DSH 把 dock 子内容 `visibility:hidden` ⇒ 未限定的不透明底（+ 下面那条 z-index:15）就是一块 100vw 的空盒子盖住整个应用，暗色主题下=整页空白。**上一版此处写的「不要加 open 限定」是错的**：当时以为 autoFullscreen（视口 <768px）下无 open 的面板仍需底色，实际那种状态下 dock 内容本就被 DSH 隐藏，底色毫无意义。
    - **全屏还必须自带 `z-index:15`（用户同一天第三报：「全屏时 AI 聊天框仍显示」）**：0.1.7 删掉了旧版 `.P3OORG_panel{z-index:10}` ⇒ 容器 `z-index:auto`，而聊天输入框所在的 `wSkVaW_composerStack` 是 **z-index:1**、面板 dock 内容是 **z-index:40 但背景全透明** ⇒ 输入框浮在面板（z auto）之上、dock 又盖不住它（透明）。实测聊天内容层最高 `z-index:10`（dsh-client-ui-conversation）、DSH 自己的 `overlayLayer` 是 20、对话框 100+，故取 **15**（高于聊天、低于 DSH 遮罩/弹窗）。**排除法教训**：`.P3OORG_panel` 带 `pointer-events:none`，用 `elementFromPoint` 判断覆盖关系会得到假结论（必须临时 `pointer-events:auto` 或看 `elementsFromPoint` 栈 + 截图）。
    - **⚠️ 这条 z-index 必须写成 `:where()` 低具体度，否则会反噬旧版（用户追问「修改会影响之前的版本吗」）**：旧版（≤0.1.6）DSH **自己**就有 `.P3OORG_panel[data-sidebar-right-panel=fullscreen]{z-index:40; position:fixed; inset:0}`。第一版把 `z-index:15` 写进高具体度规则（`body[...][...] [data-sidebar-right-panel="fullscreen"][data-sidebar-right-open]`），真机 Chromium 层叠实测把旧版的 40 **压成 15**（`elementFromPoint`/合成顺序都证明 DSH 的 40 被覆盖）。现改为 `body[data-we-wallpaper] :where([data-sidebar-right-panel="fullscreen"][data-sidebar-right-open]){z-index:15}`：`:where()` 不贡献具体度 ⇒ 本规则 (0,1,1) < DSH 的 (0,2,0) ⇒ **旧版保留 40、0.1.7 拿到 15**。**底不能一起放进 `:where()`**（旧版容器有 `background:var(--dsw-alias-bg-base)`，被我们置 transparent，需要我们的 `#fff/rgb(24,26,30)` 赢）⇒ 底与 z-index 拆成两条规则、两种具体度。jsdom 对 `:where()` 的具体度实现不可信（会算出 15），必须用真实浏览器或纯具体度计算验证。
    - **验证**：`tests/styles.test.ts` 断言「半透明底规则必须带 open 限定且排除 fullscreen」+「全屏底必须带 open 限定」+「唯一带 z-index 的全屏规则必须带 open 限定、10 < z < 20 且具体度 < `.P3OORG_panel[data-sidebar-right-panel=fullscreen]`」；真机 0.1.7 四态实测 —— (push,收起) `rgba(0,0,0,0)`；(push,展开) `rgba(255,255,255,.74)` 且与聊天区无重叠；(fullscreen,展开) `rgb(255,255,255)` + `z-index:15`（输入框中心 `elementsFromPoint` 栈只剩面板元素，截图确认聊天 hero/输入框被盖住）；(fullscreen,收起) `rgba(0,0,0,0)` + `z-index:auto`（应用正常显示，不再整页空白）。旧版 0.1.5-rc.3 真机（注入同款元素 + 插件 CSS）：(fullscreen,展开) `z-index:40`（DSH 胜）+ 底 `rgb(255,255,255)`（插件胜）；(fullscreen,收起) `z-index:40` + 底 transparent。dock 内容自身仍 transparent ⇒ 展开时这层底仍需保留。

### §5.37

37. **弹层菜单底 `--dsw-specific-menu` 在 0.1.7 变成半透明玻璃 ⇒ 指令菜单文字发虚（2026-09-23，用户报告「输入框面板透明度太高，看不清文字」）**：0.1.7 把该 token 从 `var(--dsw-alias-bg-layer-3)`（主题不透明面，浅色 = `#fff`）改成字面量 **`#f8f9fa94`（α≈.58）/ `#30313680`（α≈.5）**，并给 `._menu` 加了 `backdrop-filter:var(--dsw-menu-backdrop-filter)`（`blur(40px) saturate(150%)`）。它是 DSH 的**共享弹层底**（`dsh-client-ui-input-trigger` / `commands` / `model-selection` / `chat` / `conversation` / `cordis` / `goal` / `jobs` 共 8 个包消费）⇒ 有壁纸时壁纸透上来、指令菜单与各选择器文字发虚。
    - **修法**：浅色分支 `--dsw-specific-menu:rgba(255,255,255,.92)!important`、深色分支 `rgba(24,26,30,.94)!important`（与本插件其他面板 `.9` 口径一致；DSH 的 blur 保留；`!important` 覆盖 DSH 主题分支 `body, body *` 的定义）。
    - **跨版本**：旧版（≤0.1.6）该 token 本身就是不透明面，我们的覆盖会把菜单从「完全不透明」变成「92% / 94%」——8% 透出、文字仍清晰（旧版真机实测 token 计算值 = `rgba(255,255,255,.92)`）；属可接受的一致化，不是回归。
    - **验证**：`tests/styles.test.ts` 断言两条分支都覆盖该 token 且 α ≥ .9；真机 0.1.7 指令菜单（`_3e4SsG_menu`）计算背景 **`.58 → .92`**（手加 `data-ds-dark-theme` 后 `.94`），截图 `output/playwright/dsh017-menu-fixed-light.png` 文字清晰。
    - **⚠️ 0.1.7-rc.2 再次回归并订正（2026-09-28，用户报告「用 `/` 调出的命令面板看不清内容」——与 rc.1 同一处观感）**：rc.2 把**公共菜单**迁到 `dsh-client-ui-primitives` 的 **`MenuSurface`** 组件，底由该组件的 `.material` 读取新 token **`--dsw-menu-surface-fill`**（`MenuSurface.module.css:26`），并把旧 token 变成它的**别名**（`--dsw-specific-menu:var(--dsw-menu-surface-fill)`；**仅 macOS** 保留接近不透明的 `#f8f9faf0` / `#303136f0`）⇒ **只覆盖旧 token 对这类菜单不再生效**（`dsh-client-ui-input-trigger` 的 `_3e4SsG_menu` CSS 在 rc.2 里已无 `background` 声明）。
      - **实测（真实 GUI + 有壁纸，Playwright 量 `getComputedStyle`）**：`.material` 的 `background-color = rgba(248,249,250,.58)`、`--dsw-menu-surface-fill = #f8f9fa94`（DSH 原值）、`--dsw-specific-menu = rgba(255,255,255,.92)`（**我们的覆盖仍生效，只是菜单不读它**）⇒ 复现「半透明 + `blur(40px)` 下壁纸与文字混在一起」。
      - **修法**：**两个 token 都覆盖**（浅 `.92` / 深 `.94`），DSH 的 `backdrop-filter` 保留；断言见 `tests/styles.test.ts` 新增用例（rc.2 起生效）。修复后同口径实测 `.58 → .92`（深色 `.94`），浅/深两态截图 `output/playwright/cmdk-fixed-*.png` 文字清晰。
      - **通用教训**：DSH 把某类浮层的底从 token A 迁到 token B 时，插件的可读性覆盖必须**同时覆盖两个** —— 别名在非 macOS 上不再保留不透明度，且新组件可能完全不读旧 token。

### §5.38

38. **可见性有两套判定，别混用（2026-09-25）**：`resolveVisibility`（**text** 用；`script` 绑定按 `value` 静态定论）与 `isStaticallyHidden`（**image/particle** 用；**`script` 恒不隐藏**，交给 `visible.script` 的运行时通道）。把后者换成前者，会让 9 个脚本控制的图层在装载期被永久剔掉（脚本再也打不开它）；反过来给 image/particle 套 `resolveVisibility` 是这类改动的头号地雷。

### §5.39

39. **设置面板的 DOM 钩子与样式断言被测试锁定（2026-09-25 UI 重设计）**：`tests/dom/settings-section.dom.test.tsx`（15 项）与 `tests/styles.test.ts` 钉住了这些选择器/文本，重排结构时必须保留：`.wss-thumb`（数量）、`.wss-thumb-title`（**textContent 精确等于壁纸名**）、`.wss-cancel`/`.wss-refresh`/`.wss-probe`/`.wss-save-dirs`/`.wss-adopt[data-path]`/`.wss-candidate[data-kind]`、`.wss-dir-workshop`/`.wss-dir-assets`、`.wss-glow-threshold`/`.wss-glow-strength`、`.wss-quality`、`.wss-sound`、**`.wss-power` 内恰好 2 个复选框**（音效开关**不能**并进去）、**首个 `.wss-glow-row` 的 textContent 必须精确等于「光晕（立即生效）」**；样式侧要求 `.wss-root` 规则含 `var(--dsw-alias-label-primary`、`.wss-cancel` 规则含 `var(--dsw-alias-border-l2`。2026-09-25 的重设计（分区卡片 + 16:9 缩略图 + 控件行两端对齐）就在这个约束下完成，**零断言改动**。

### §5.40

40. **web 壁纸 iframe 必须「先挂载 + 强制布局，再赋 `src`」（2026-09-30，用户报「启动桌面版时壁纸加载不出来，调整窗口大小才出现」）**：`makeWebFrame` 原先建完元素就 `frame.src = url`，**那时元素还没进 DOM**；跨源子帧是 **OOPIF（独立进程）**，冷启动时父帧尚未给它分配盒子尺寸 ⇒ 子帧里 `window.innerWidth/innerHeight` 读到 **0**。壁纸 `3789244610` 初始化时把这些值**快照**成画布尺寸（且全 bundle 无 resize 监听）⇒ 画布永远 0×0、画面空白，直到用户调整窗口触发 `reloadWebFrame` **重建 iframe**（该站点实例已存在、视口正确）才显示 —— 这就是「必须调一下窗口」的来源。**修法**：`background-layer.ts` 的 `appendWebFrame` 固定顺序 `appendChild(frame)` → `frame.getBoundingClientRect()`（强制一次布局）→ `frame.src = url`；首次装载与 resize 重建两条路径共用它，**顺序即修复本身，勿调换**。**证据**（真机桌面版 + CDP 直连该跨源子帧 target）：同一页面同一时刻 A/B —— 旧顺序 `canvas = 0x0`、`window.__rain === undefined`；新顺序 `canvas = 1280x820`、`__rain` 建立、画面正常；整页 reload（等价启动）后首帧即正常。**排查手段备查**：桌面壳用 `--remote-debugging-port=<port>` 启动后，`http://127.0.0.1:<port>/json` 会列出该跨源子帧（`type=iframe`）的独立 target，可直接 `Runtime.evaluate` 读它的 canvas 尺寸 / 壁纸全局 / rAF —— 父页面读不到跨源 iframe 内部，这是唯一直接通道。

### §5.41

41. **贴壁纸文字颜色从「只能自动」扩成「可手动配置 + 可选描边」（2026-10-01，用户报告「某些壁纸某区域文字看不清；有的壁纸开始是亮的，播放后变暗」）**：原实现只有一条链路 —— preview 图平均亮度 → 黑/白二选一（2026-09-03）。
    - **为什么不做逐帧采样自动适配（已实测、未采用）**：真机 RTX 3060 / ANGLE D3D11 上测过「帧内采样正在播放的画面 → 局部亮度 → 逐元素变色」。开销确实可忽略（CPU 后端 64×36 采样画布：draw 0.10 + `getImageData` 1.27 ms/次；节流 400ms ⇒ 摊薄 <0.2ms/帧；DOM 40 元素一轮 p50 0.2ms；帧间隔与基线无差），**但能力天花板是黑/白二选一**：一块文字压在亮暗交界或花色纹理上时，采得再准也只有一个颜色，且失败分支多（web 壁纸跨源读不到、桌面壳 `dsh-app://` 是否 taint 未验证、`object-fit:cover` 映射写错会错位；另实测帧外读取恒为全黑 ⇒ 必须帧内挂 `render()` 之后）。故选择「用户手动指定 + 描边」这条确定性路线。采样数据留在 `e2e/.out/contrast-probe*.{mjs,json}`，将来要叠加自动化不必重测。
    - **实现**：新增 `src/client/text-color.ts`（纯逻辑：`normalizeMode` / `normalizeHexColor` / `manualTextColor` / `outlineShadow` / `outlineLabel`）；`ClientSettings` 新增 `textColorMode`（auto/white/black/custom）、`textColor`、`textOutline`（0-3）三字段，**client `DEFAULTS` 与 host schema 两处都要加**（漏 host 侧会被 schema 丢弃）；`wallpaper-controller` 的手动档**跳过 preview 测量**直接下发固定色，且测量回调落地前重读一次模式（双保险，防异步覆盖手选色）；面板在「显示效果」后新增「文字可读性」卡片（`.wss-textcolor-mode` / `.wss-textcolor-custom` / `.wss-textcolor-outline`）。
    - **默认值 = 既有行为**：`auto` + 描边 0 档 ⇒ 老用户升级后观感不变（零回归）。
    - **⚠️ `text-shadow` 是**可继承**属性，实底区域必须显式复位**：消息列那条规则组（`[class*="flowItem"] p/span/li/...`）会**同时命中气泡、present 卡片、changed-files 卡片、行内 code 内的同名元素**，描边会渗进去（浅底黑边、深底白边都发脏）。故这些实底区域各加 `text-shadow:none` 挡住 —— 这是端到端实测抓到的缺陷，纯 CSS 文本断言看不出来。
    - **修订（同日用户追问「选自动时描边是不是不生效」）**：`auto` 档原先每次下发都要重新测一次 preview 亮度 ⇒ 拖动描边滑杆要等测光回来才见效果（观感＝滑杆没反应），且每次拖动都重新加载一遍 preview 图。现按**壁纸 id 缓存**最近一次测光结果（`autoColor` / `autoColorFor`）：设置变更时**同步**复用（零延迟、不再测图）；`select` 路径传 `forceMeasure=true` 强制重测（换壁纸/重选不复用旧色）；测光瞬时失败但已有缓存时**保留旧值**（不闪回主题默认）。注意「该壁纸从未测光成功」（无 preview，或桌面壳下 preview 跨源被拒）时颜色与描边仍会一起回主题默认 —— 这是刻意的：没有文字色就没有可推导的对立色描边。
    - **验证**：`tests/styles.test.ts` 断言「描边只出现在贴壁纸文字上、实底区域必须显式复位且命中规则」；`tests/text-color.test.ts` + 控制器/设置/面板共新增 40 项，全量 1022 项全绿；`npm run build` + `build:client` 通过；真实 Chromium 计算样式端到端 `e2e/.out/text-outline-probe.mjs` 8 项全 PASS（默认 none → 写变量后正文带描边、气泡/code/卡片仍为 none → 移除变量后消失）。

### §5.42

42. **通知卡片（turn-trigger）与代码块在**深色主题**下不同底 ⇒ 有壁纸时「收到任务消息」与代码块观感不一致（2026-10-08，用户报告两者颜色不一致）**：DSH 的卡片规则是 `background:var(--dsw-alias-turn-trigger-bg, var(--dsw-alias-markdown-code-block))`（`TurnTriggerNodeView`，`dsh-client-ui-chat`），而该 token 在 **深色**主题取 `--dsw-alias-interactive-bg-hover`（**#ffffff14，8% 白半透明**），代码块取 `--dsw-alias-markdown-code-block`（= `--dsw-static-neutral-bluish-900` **#1b1b1c 实色**）；**浅色**主题下它恰好等于代码块那个 token（`--dsw-static-neutral-bluish-50`）⇒ 只有深色暴露。插件把 `--dsw-alias-bg-base` 透明化让壁纸透出，卡片的 8% 白下面从页面底（#0f1115）换成了壁纸 ⇒ 卡片随壁纸变色、代码块恒定，差异被放大；插件又把 `--dsw-alias-border-l1` 提到 `rgba(180,180,180,.35)`，卡片轮廓更显眼。截图实测（1509×852）：代码块区众数 **(27,27,28) = #1b1b1c**（占 90% 像素）、卡片区众数是壁纸色 (20,25,32) 而非 #1b1b1c。
    - **修法**：浅/深两个分支各覆盖 `--dsw-alias-turn-trigger-bg` 与 `--dsw-alias-turn-trigger-bg-hover` 为 `var(--dsw-alias-markdown-code-block)`（hover 同色，避免鼠标移上又透回壁纸）；卡内文字按**实底口径**复位 —— 文字 `--dsw-alias-label-primary` + `text-shadow:none`，header（图标/标题/时间）保留 `--dsw-alias-label-tertiary`、说明保留 `--dsw-alias-label-secondary`。
    - **⚠ 两个坑**：① **token 覆盖必须写进浅/深分支**（(0,2,1)）—— DSH 自己的定义在 `body[data-ds-dark-theme]`（(0,1,1)），写成单条 `body[data-we-wallpaper]` 与它同具体度、只能靠样式表插入顺序取胜；② **卡内文字复位必须带 `[class*="flowItem"]` 前缀** —— 消息列反色规则 `[class*="flowItem"] p` 是 (0,2,2)，而通配后代 `[data-turn-trigger] *` 只有 (0,2,1)（`*` 不贡献具体度）⇒ 少了前缀压不过它、卡内仍是黑字压深底（**e2e 实测 FAIL 才抓到**，纯看 CSS 会以为写对了）。同源陷阱 §7 已记过一次：`styles.ts` 的 CSS 模板串里**注释也不能出现反引号**（本次写「必须带 flowItem 前缀」时误用，esbuild 直接报错）。
    - **验证**：`tests/styles.test.ts` 新增 3 项（两分支 token 覆盖、卡内字色复位且具体度高于反色规则、层级色保留），全量 **1039 项全绿**；`npm run e2e:card`（`e2e/verify/verify-turn-trigger-card.mjs`：headless Edge + **从 `app.asar` 现场提取的 DSH 主题/组件 CSS** + esbuild 打包的插件 CSS + 真实类名 DOM）**9 项全 PASS** —— 修复前卡片 `rgba(255,255,255,0.08)` ≠ 代码块 `rgb(27,27,28)`；修复后两者都是 `rgb(27,27,28)`（浅色 `rgb(249,250,251)`）、hover 同色、卡内文字 `rgb(249,250,251)`，且**同页普通正文仍被 `--wp-chat-fg` 反成黑**（对照组，排除「反色规则根本没写对」的假通过）。分析与实测数据详见 `docs/2026-10-08-turn-trigger-card-vs-codeblock.md`。

### §5.43

43. **插件被重挂载（DSH client-hmr 的 `rebuilt` 重载）后叠出多份背景层 ⇒ 切壁纸「怎么点都不换」（2026-10-10，用户报告「选魔兽之门却一直显示三角洲」）**：`@deepseek-ai/dsh-client-hmr` 在客户端 bundle 被重建时会**重新执行 bundle 并以全新状态重挂载插件**（旧 fiber 被 drain）。而 `bootstrap` 既没注册 `ctx.effect` 收尾、`mount()` 也只在**闭包内**判重 ⇒ 每重载一次就 `prepend` 一份新的 `.wp-background-layer`，旧的连带它的 canvas / WebGL 循环 / wasm 模拟 / AudioContext 全部存活。两层的 `z-index` 同为 0（`styles.ts`），同层按 DOM 序绘制 ⇒ **DOM 序在后的「最老实例」永远压在最上面**，且它再也不会收到 select：点击只在新实例被压住的画布里生效（真机层数 **9**，持久化 `selectedWallpaperId` 与控制台 `scene loaded id=…` 都正确，唯独屏幕不变）。
    - **修法**（`src/client/index.ts`）：① `ctx.effect(() => teardown, …)` 登记收尾 —— `controller.select('')` 释放渲染器 + 摘 root + 注销 `visibilitychange` + 清 `window.__wpEngineTeardown`；② `mount()` 单例化（`dropStaleLayers()`）：先调上一个实例的收尾（跨模块实例靠 window 上的 `__wpEngineTeardown`），再按 DOM 兜底摘掉所有无主的 `.wp-background-layer`（老版本没有 teardown，真机升级路径上是 9 层；顺手 `WEBGL_lose_context` 丢弃它们的 GL 上下文、停 video）；③ `disposed` 标记防延迟的 `DOMContentLoaded`/异步恢复把已收尾的插件复活；④ 暴露 `window.__wallpaperEngine.teardown()` 供排查。
    - **验证**：`tests/dom/plugin-lifecycle.dom.test.ts` 4 项（重挂载后只剩一层且是新实例那层 / 无主残留层被清 / ctx dispose 摘层回默认背景 / dispose 后 mount 不复活）—— 修复前 4 项全红（2 层、4 层、摘不掉、会复活），修复后全绿；全量 **1063 项全绿**；`npm run build` + `build:client` 通过。真实浏览器（headless Edge + `lib/` 生产代码）9 项全 PASS：3 个残留层（真 WebGL2 红屏）→ apply 后剩 1 层、3 个上下文 `isContextLost()=true`、截图红像素 **0**（旧层被换掉而非叠加）、再 apply 仍 1 层、ctx dispose 后 0 层。
    - **同源坑**：样式注入早就做了幂等守卫（`injectWallpaperStyles` 查 `style[data-plugin-css]`），层没有 —— 凡是「插入 DOM / 起循环 / 开上下文」的挂载点都要同时具备幂等与收尾。

### §5.44

44. **满屏隔离对象关 MSAA 是结构性无操作；RT 纹理的采样参数只在 `setupRenderTarget` 下发（2026-10-12，隔离对象 RT 分辨率特性 `cab0ab7`..`fb8476f`）**：
    - **MSAA 对「铺满 RT 的整块 quad」零影响（实测）**：背景隔离对象的 RT 内容就是一张盖满整张 RT 的 quad，RT 内**没有轮廓边** ⇒ 逐像素完全相同（`samples=0` vs `4` 的 **MAD = 0.0000**）。单张 A/B（`1922570576` 魔兽之门，harness 1600×900 / dpr=1；指标 = 逐块「梯度/对比度」比，桌面 WE = 1.00）：**现状 0.55 / 只关 MSAA（4→0）0.56 / 只摘掉 3 条效果链 0.67 / RT 1.5× 0.73 / 4096 收口 0.87 / 4096 收口 + mipmap 0.88** —— 关 MSAA 本身不改变画质（0.55→0.56 属重复测量噪声），它省下的是每像素 24 B（28 B/px「无 MSAA」vs 52 B/px「MSAA 4×」模型）⇒ 把省下的显存换成分辨率才是杠杆（0.55 → 0.87）。多壁纸 A/B（实现前 → 实现后，逐块中位数，含关 MSAA + 4096 收口 + mipmap）：**GTR 1.41 / Crimson 1.48 / Subway 1.41 / Orange 1.10**。
    - **非满屏对象保留 `samples=4`**：贴片与粒子 billboard 有真实几何边，MSAA 有用。判定式 = `kind === 'background'` **且** `|worldW| ≥ 0.98 × 场景宽` **且** `|worldH| ≥ 0.98 × 场景高`（两轴都要达标；单轴达标、粒子一律仍为 4），守卫用例在 `tests/threejs-player.test.ts`（MSAA 专门用例 **2 个 `it()`**，覆盖 4 个对象场景：两轴满屏 background → 0、单轴 / 贴片 / 满屏 particle → 4；本特性相关用例共 **8 个 `it()`**）。
    - **RT 纹理的采样参数只在 `setupRenderTarget` 下发（结论先读 three 源码得出，非转述）**：three 0.170.0 里唯一写 `TEXTURE_MIN_FILTER` 的是 `webgl/WebGLTextures.js:615` 的 `setTextureParameters`，调用点只有 `uploadTexture`（`:777`）、`uploadCubeTexture`（`:1231`）与 `setupRenderTarget`（`:1841`（cube 分支）/ `:1877` / `:1901`）三处；而本仓库的 2D 隔离 RT 走不到前两条上传路径 —— `:518`（`setTexture2D`）的上传分支只在 `texture.isRenderTargetTexture === false` 时进入 ⇒ 采样参数只在 `setupRenderTarget` 下发；而 `setupRenderTarget` 只在**首次使用或 `dispose()` 之后**执行 —— `WebGLRenderer.js:2287-2289` 的判据是 `renderTargetProperties.__webglFramebuffer === undefined`。`texture.needsUpdate` 对 RT 纹理**无效**：`webgl/WebGLTextures.js:518`（`setTexture2D`）只在 `texture.isRenderTargetTexture === false` 时进上传分支 ⇒ RT 纹理整段跳过。
    - **为什么必须 `dispose()`**：`generateMipmaps` 是**实时**读的（`WebGLTextures.js:108-112`；`updateRenderTargetMipmap` `:1937-1957` 在每次渲染进 RT 后被调用）⇒ 只改 `minFilter` 而不 dispose，会出现「**每帧白生成 mip，却仍按旧 `LINEAR` 采样**」＝判定翻转后画面没变好、还多付 mip 生成开销。修法：判定翻转时 `rt.dispose()`（`core/RenderTarget.js:154` 只 `dispatchEvent('dispose')`；`WebGLTextures.js:317-325` 的 `onRenderTargetDispose` 摘监听 + `:457` `properties.remove(renderTarget)`；`setupRenderTarget` 每次都重新 `addEventListener`（`:1715`）⇒ 无监听泄漏，下一帧按新参数重建）；**未翻转时不要 dispose**（那等于每帧重建 FBO）。翻转判据取 `rt.texture.minFilter`（离散、与写入同源），故**不会误 dispose**：新建 RT 缺省即 `LinearFilter` ⇒ `minifying=false` 时 `flipped=false`；`minifying=true` 时 `flipped=true`、确实会 dispose 一次，但此刻 RT 尚未 setup、监听尚未挂上，dispose 是 no-op，无害。
    - **回归**：`tests/threejs-player.test.ts` —— 满屏 background `samples=0` / 未铺满仍为 4、铺满整屏的 particle 仍开 MSAA、RT 不大于屏占位时不生成 mip（`generateMipmaps=false` + `LinearFilter` 与 three 缺省逐值相同）、resize 后重估（判定翻转 dispose 恰好 1 次 / 未翻转 0 次）。

