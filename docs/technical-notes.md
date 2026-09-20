# 技术细节与实现现状

> 面向**开发者与贡献者**。README 只讲使用者需要知道的事，实现细节、内部机制与工程现状放在这里。
> 相关文档：`AGENT.md`（开发总纲与踩坑史）、`docs/superpowers/specs/`（设计文档）。

---

## 1. 渲染路径

### 1.1 three.js 播放器（当前主路径）

- **背景图层**：每个 `image` 对象 → `Mesh`（`PlaneGeometry` + `MeshBasicMaterial`），按 `we_to_three`（场景中心化、**y 不翻**）定位，`scale` / `alpha` / `brightness` 与 WE 语义一致；`renderOrder=0`、`depthWrite=false`。
- **粒子系统**：每个 `particle` 对象 → `InstancedBufferGeometry`（每粒子 4 角点 billboard + `ShaderMaterial`）。实例属性 `particlePosition/Size/Uv/Color/Alpha` 按 spec 的 `maxcount` **一次性预分配**（避免 three r170 `_maxInstanceCount` 首帧锁存导致层不绘制），运行期只更新 `instanceCount`。
- **粒子 shader**：billboard（`pos + corner*halfSize`）、`gl_Position.z=0`（2D，避开正交视锥裁剪）、多帧 sprite UV 网格切片（`frameCount` + cols/rows）、纹理 alpha 遮罩（有纹理 `shape=texel.a`、无纹理软圆盘）、`softness`、additive / alpha 混合。
- **渲染循环**：`renderer.setAnimationLoop`（`dt` = `performance.now` 差分，clamp 0.1s）→ 逐 `CpuParticleSim.update(dt)` → 刷新实例缓冲 → `render`；帧体 `try/catch` **异常自愈**（three 的 RAF 一次异常会永久停摆）。
- **相机 / 尺寸**：cover 正交相机（按**窗口宽高比**，非场景比例）；`canvas.width/height = 视口逻辑尺寸 × devicePixelRatio`。
- **对象级效果链接线**（2026-09-14 起 P1）：`createThreeSceneRenderer()` → `loadSceneToThree()`；隔离对象进 `localScene`、主场景放合成 quad、注入帧钩子；每帧 `renderIsolatedContents()` → `stage.bindOutputs()` → 渲染主场景 → `stage.advance(time)`（串行推进 `EffectRunner`，异步不阻塞本帧）。无带效果对象时 stage 为 null，帧序退化为原路径（零回归）。

### 1.2 粒子模拟（Rust/wasm，`wasm/src/particle/`）

经 wasm-bindgen 暴露 `CpuParticleSim`：

- 照 linux-wallpaperengine `CParticle` 语义实现：`emitter`（`boxrandom` 逐轴 vec3 / `sphererandom` 球壳 cbrt）、`initializer`（`sizerandom`、lifetime / velocity / color / alpha / rotation / angularVelocity / turbulent）、`operator`（movement 重力/阻力、angularMovement、alphaFade 梯形、size/alpha/colorChange、turbulence、oscillateAlpha/Size/Position、寿命 compaction）。
- **错落稳态（`prewarm`）**：启动时按 `min(maxcount, ceil(rate×平均寿命))` 铺入带**随机出生相位**的粒子，避免「一批同时下落、同时消失」。
- `build_instance_vertices()` 输出每粒子 `[pos3, size, uv2, color3, alpha]`（10 浮点）喂给 three.js。

### 1.3 纹理 / 材质解码（`src/client/tex-loader.ts`）

- `TEXV0005`：LZ4 解压；支持 **RGBA8888 / DXT1/3/5 / RG88 / R8**（RG88→`vec4(r,r,r,g)`、R8→`vec4(1,1,1,r)`，与 wasm 的 `r8_to_rgba_white_alpha` 对齐）。
- **2 的幂填充裁剪**（`cropToMap`）：mip 记录的是 2 的幂上传尺寸，按头部逻辑内容尺寸裁剪（EVA 4096×2048→2400×1555），避免背景只占左上角、右侧露黑。
- **DXT 用 mip0 全分辨率 + `LinearFilter`**（不用 mipmap 过滤），避免大尺寸压缩纹理被三线性 mip 过滤糊化。
- **sprite 精灵表**：解析 `TEXS000x` 段得到帧数与网格（如火把/雾 1024×1024 = 8×8=64 帧），shader 二维网格切片。
- 行序统一（`flipRows` / DXT 块行 `flipCompressedRows`）。

---

## 2. 与桌面 Wallpaper Engine 的语义对齐

（本轮与桌面 WE 真机逐像素对拍修正）

- **混合模式按材质 json 的 `passes[0].blending`**（`add`/`additive` → 加法），不再从材质文件名猜（此前导致 additive 层被当普通混合 → 黑方块 / 全屏泛光）。
- **粒子按对象 scale**：粒子局部坐标与 quad 尺寸乘**本对象真实 scale**（WE `mvp = viewProj×translate×rotate×scale`）。
- **`sizerandom` ÷2**：spec 存的是编辑器值的一半（`p.size` 为整宽），不除会全壁纸粒子 2 倍大；`sizerandom.exponent` 缺省 1.0（黑神话显式 2）。
- **`emitter.directions` 缺省 `(1,1,0)`**（lwe 语义；缺省零向量会让粒子全堆在同一点）；`distancemin/max` 逐轴 vec3。
- **y 约定**：`origin.y - sceneH/2` + emitter 局部 `+y` 朝上（与桌面 WE 实测一致）。
- **闪烁**：`oscillatealpha` 等算子接线，星点/火光按 spec 振荡。
- **坐标与变换**（勿再翻转 / 勿漏乘）：WE 场景系 = 左下原点、y 向上；three 正交相机 = 中心原点、y 向上。映射 `three = we − viewport/2`，**y 不翻转**。对象 model matrix = `T·R·S`，`angles` 是**弧度**，旋转顺序 `R = Rz·Ry·Rx`。历史事故：曾用 `vh/2 − oy` 导致非居中对象上下镜像。
- **`turbulentvelocityrandom` = `forward` 绕 `normal` 旋转**（不是「沿 normal 偏移」）：官方 `TurbulentVelocityRandomProgram` = curl 噪声采样 → 投影到垂直 normal 的平面 → 与 forward 求夹角 → `AngleAxisf(angle*scale + offset, normal) * forward`。方向**恒在垂直 normal 的平面内**。旧实现得到 `(0, cosθ, sinθ)`：x 恒 0、速度全进屏幕上不可见的 z 轴 → 粒子排成一条竖线。影响全库 **9 张壁纸**。
- **对象级 `instanceoverride`**：`alpha/size/lifetime/speed` 是**乘数**，`color/colorn` 是**覆盖**（`UiColorToLinear` = v²），emitter rate **× `count`**；缺省恒等。JS 侧只透传原始 JSON，语义解析在 Rust（`particle::parse_particle_override`）。
- **`.tex` flags 必须被消费**（权威定义见 `.lwe/.../Texture.h`）：
  - `ClampUVs = 2`（bit1）—— **已修**：WE 默认 **REPEAT**，**仅带此位才 CLAMP**。曾一律落到 three 默认 `ClampToEdgeWrapping` ⇒ `clouds.frag` 有意把第二组 UV 旋转到负象限 ⇒ `cloud1` 全部塌到最左一列 ⇒ CP2077 整屏偏白且随时间越来越白。**全库 477 张 `.tex` 中 105 张因此由 clamp 改 repeat**。
  - `NoInterpolation = 1`（bit0）—— **待办**：`applyLinearSampling` 无条件设 `LinearFilter`，带此位的纹理（全库 4 张）本该 `NearestFilter` ⇒ 被插值偏糊。
  - ⚠️ **RT 纹理必须保持 CLAMP**（对象合成 quad 依赖它），别在别处一律改成 repeat。
- **纹理 v 轴**：WE 是 `v=0` = 图像顶部；效果链一侧按 WE 约定加载（`tex-loader` 的 `rowOrder` 参数 + `effect-runner` 注入点），并用「隔离局部相机 y 镜像 + 合成 quad `flipGeometryUvY` 反镜像」精确抵消 ⇒ RT 内容与 mask 同约定、画面仍正立。**显示路径一行未改**（避免漏改一处就整图上下颠倒）。
- **效果纹理槽编号 + sampler `combo` 派生**：
  - **`textures[i] → g_Texture(i)`**（**不是** `g_Texture(i+1)`），写错会让所有效果的纹理槽整体错位一个。
  - sampler 声明带 `"combo":"X"` 时，该槽被绑定即置 `X = 1`（必须在 `preprocessWeShader` **之前**）；缺失会让 `#if MASK` 的局部作用分支永不启用 ⇒ 效果全图生效。
- **`g_TextureNResolution` 的 vec4 分量是 `(mip0.w, mip0.h, header.w, header.h)`**（lwe 约定），**不是** `(w, h, 1/w, 1/h)`：填错会让遮罩 UV 被压成 ~0 ⇒ 本该局部生效的效果变成全图等量位移。
- **R8 / RG88 有两套通道语义**（`convertUnormToRgba(data, format, alphaPriority)`）：`true`（缺省）= 粒子纹理语义（形状写在 R / G）；`false` = 效果纹理槽语义（`R8 → (r,r,r,1)`、`RG88 → (r,g,0,1)`，shader 直接读 `.r` / `.rg` 当遮罩数值）。按错语义 ⇒ 遮罩失效 ⇒ 效果覆盖全图。
  - ⚠️ **待办**：权威来源应是 `.tex` 头的 `TextureFlags_AlphaChannelPriority`（bit19），现由**调用方路径**推断；对当前库恰好正确，但语义来源错了。
- **`colorBlendMode`（→ combo `BLENDMODE`）不是 alpha 混合**，而是**额外追加一遍「读当前帧缓冲」的混合 pass**（`ApplyBlending(BLENDMODE, A=背景, B=自己, 自己的 alpha)`），alpha 保持背景的。模式表在 WE 明文 `common_blending.h`。three 侧用**预乘片元** + `CustomBlending` 复刻。**未实现的模式回退普通 alpha 混合**（不静默画错）。全库非零只有 3 个对象：`3743126786`=7、`2832263418`=6、`2460786246`=31。关键性质：`BlendScreen(A, 0) = A`。

---

## 3. 对象级效果链（effects）

- **全库覆盖（P1 + P2，2026-09-15）**：线性链与 **24 条具名 RT 图链**（blurprecise×13、blur×3、localcontrast×2、godrays×2、bloom×2、shine×1、bokeh_blur×1）都由同一执行器按计划执行（**模板均已覆盖**；其中 10 条不挂链、画面无变化，见下条）；**原先「整条跳过 + 去重告警」的降级已删除**。
- **新增的效果类别**：`blur` / `blurprecise` / `localcontrast` / `godrays` / `bloom` / `shine` / `bokeh_blur` 属 P2 新增。P1 已有的高频线性效应是 waterwaves 24 / shake 18 / opacity 8 / waterripple 7 / waterflow、pulse、perspective 各 5 / clouds、scroll、foliagesway 各 4 …。
- **计数口径**：`106 线性 + 24 RT`（130 条效果引用）是**声明口径**（按 effect 链数、不过滤 `visible`）；其中 1 条线性链的 effect 级 `visible=false`（`2597392171` obj50 的 `effects/shake`）生产侧整条跳过（**`visible` 仅 three 主路径解析**；未接入的 `scene-renderer` / `wasm-renderer` 并源循环未过滤）⇒ three 的**执行口径 = 105 线性 + 24 RT**。
- **10 条链在画面上看不到（不是能力差）**：24 条 RT 图链里 7 条挂在 `text` 对象（收链阶段就被过滤）、3 条挂在 `util` 对象（拿不到隔离条目 ⇒ 不挂链）；这两类对象的渲染是独立缺口。
- **验收口径（如实）**：端到端（真实 WebGL 逐像素）跑过的样本是 `2683211654` / `2911105183` / `2011060960`（双链同名 RT）/ `2937346640`（godrays）/ `1968789468`（shine）/ `2597392171`（godrays）/ `3743126786`（16 pass bloom）/ `3765967112`（blurprecise 挂 text，链不挂载，只作「不报错」回归）/ `1429403119`（性能相对信号）；该轮共 **30 PASS / 2 FAIL**，2 条 FAIL **全是 `[5]` 的归因对照**（bloom 不抬全屏 p99），**不是回归**（明细见 `AGENT.md` §7.1 的表）。⚠️ **2026-09-20 起 `[5]` 的全屏 p99 口径失去鉴别力**：Glow 默认开启后开关两侧都钉在 255 ⇒ 由 1 PASS + 2 FAIL 变 3 FAIL；**这不是 bloom 失效**（`[5-归因·主]` 的亮部诊断仍显示 bloom 有效），而是该判据口径不再有鉴别力（见 `AGENT.md` §7.1 的「应用级后处理 ⇒ 已实现」子条）。其余效果类别的「可由现有执行器正确执行」仍是**分类学推断**，**不是逐个实测**。GTR 的 bloom 只测到**局部增亮**（p99 Δ=0），**未与桌面 WE 逐像素对照**。
- **P2 遗留（如实）**：`3789452668` 的 `effects/color_grading`（线性链）有 `varying` 类型不匹配（`vec4` vs `vec2`）⇒ 该链不生效；`2597392171` 的 godrays 引用了全局运行时 RT `_rt_FullFrameBuffer` ⇒ 该槽不绑（保持默认）+ 告警一次，其完整语义属非目标；**未做显存 cap**。
- **对象 RT 的三条不变量**（改这块先读代码注释）：
  1. **局部正交相机的 left/right/top/bottom 是「世界坐标范围」**，必须覆盖**完整对象世界尺寸**。两个坑：拿 RT 像素当范围（dpr>1 时对象缩小 + 边缘 clamp 拉伸）；按 `OBJECT_RT_MAX`(4096) 钳制范围（超限对象只覆盖中央 ⇒ 边缘拉伸带）。超限对象的正确代价是「**分辨率低**」，**不是**几何裁剪。
  2. **RT 像素尺寸 = `|world| × 屏幕密度`**（= 对象在画布缓冲上的占位像素），等比收口到 4096。基准必须是**未钳制**的 `world`，**不能**用相机 `range`。旧口径「`min(world × dpr, 视口 × dpr, 4096)`」把预算当基准，与屏上占位差 0.8% ⇒ 合成那一步是双线性缩小 + 亚纹素相位漂移 ⇒ 整层锐度 **−52%**。
  3. **`isolate` 的键是 `scene.json` 的对象 id**，不是 player 的图层计数器 id（两者撞键会让隔离 image 与 particle 互相覆盖）。
- **`colorBlendMode ∈ {6,7,31}` 的对象已进入隔离路径、其效果生效**（2026-09-14 `6bb3d71`）：修法是把 WE 的混合语义从「内容材质」搬到「合成 quad」——隔离内容材质只做普通 alpha 写入，`createCompositeQuadMaterial` 统一用 `MeshBasicMaterial`（采样非预乘对象 RT）并按 `colorBlendMode` 设 `CustomBlending`。
- **`refraction` 在 GLSL3 下编译失败**（引擎源码自身的 `float(format) == FORMAT_RG88` 缺陷）：效果不生效。**已修的是「失败被缓存」**——此前每帧重试 ⇒ 重建材质 + 探针渲染 + 2 条 warning（实测该页 146×2 条刷屏）；现在按 pass key 缓存失败，同一 key 只试一次。
- **text 对象的 effects 被静默丢弃**：`groupEffectsByObject` 跳过 `kind === 'text'`，链在解析阶段就不进 `effectChains`（连汇总 warn 都没有）。实测样本 `3765967112` 的 4 条 `blurprecise` 全挂在 text 对象上。
- **21 条 effects 挂在 util / 音频等不参与渲染的对象类型上**（util:10 + none:11）：会被解析但不会挂链，每张壁纸打一条汇总 warn。
- **粒子对象的效果链只有单测覆盖**：全库实测 particle 挂载 effects = 0，管线里的粒子隔离分支**无真实样本可验**。
- ~~**链全为具名 RT 图链的对象不再隔离**（P2 前置优化）~~：**已作废（2026-09-15，P2）** —— `rtGraphOnly` 分支与其告警已删除，isolate 准入回到「至少有一条**可见**链」；原先不隔离的对象重新进入隔离路径，换来效果生效。

---

## 4. 显存与性能

- **对象 RT 显存（审计脚本 `research/q-rt-vram-sweep.mjs`）**：`1920×1080@dpr1` 合计 **530 MB**（旧口径 386 MB）；单壁纸最大 **131.8 MB** / 中位 27.9 MB；`@dpr2` 与 `4K@dpr1` 单壁纸最大 **245.7 MB**（旧 156.1）、中位 95.0。结论：**典型代价 ≈ +18%、最坏 +3.4×**（均为 dpr=1），4096 硬上限把单对象钉在 ~107 MB。
- **具名 RT 显存（P2，Task 9 实测；静态分配估算，非 GPU 实测）**：1080p@dpr1 全库合计 **39.0 MB / 28 张**（@dpr2 **124.0 MB**）；单壁纸最大 **11.0 MB**（`2597392171`）、单张最大 **7.91 MB**（`3789452668` 的 `_rt_FullCompoBuffer1`）；GTR `3743126786` **5.3 MB / 8 张**（`fbos` scale 2/4/8/16 的降采样金字塔）。占全库显存（3×对象 RT + 具名 RT）约 **6.6%**（两档同比例）⇒ 具名 RT 是「对象 RT + ping-pong」之外的小头，**未做显存 cap**。
- **清晰度归因（`clarity-report.md`）**：隔离路径相对**直渲**锐度 −52%（Laplacian 均方 `713.2 → 341.5`，与 dpr、MSAA 均无关）。逐环节定界：内容→对象 RT 712.9（−0.04%）、效果 pass 711.2（−0.24%）、**合成 quad→屏幕 341.5（−52%）** ⇒ 纯 RT 往返无损，损失 100% 在最后一步重采样。修法与实测（GTR `3743126786`，headless Edge，1280×720）：隔离 **711.1** vs 直渲 **713.2（−0.3%）**、逐像素 MAD **0.0414**（修复前 341.5 / MAD 1.804）。
- **性能门槛未验证**：设计文档 §7.4 自定「`1429403119`（23 对象 / 24 条链，全库最重）1080p **FPS ≥ 30**」为验收门槛，但**尚未在真实 GPU 上验证**。本机唯一端到端环境是 **headless Edge，其 WebGL 走 SwiftShader（软件光栅化）**，故只能给**相对信号**（帧间隔与每帧耗时中位数 / p95、隔离对象数、RT 显存估算）。**软件光栅化数字不能替代真机 FPS**，门槛状态一律记「未验证」。
  - **2026-09-20 订正（真机 GPU 验收）**：上面的前提**不成立** —— 本机 headless Edge 加 `--use-angle=d3d11 --ignore-gpu-blocklist` 拿到的是**真实 RTX 3060 / ANGLE D3D11**（探针 `research/gpu-probe.mjs`；`verify-object-effects.mjs --gpu` 档内置 renderer 自证）。同时**判据要改**：headless 的 RAF 恒锁 **60Hz 节拍**（真机与软渲染都是 16.7ms）⇒ **帧间隔不可反推 FPS**，改用**代理判据**「每帧 `renderer.render` 提交耗时 ≤ 33.3ms」⇒ 1080p 中位数 **2.0ms**（p95 2.7）、占预算 **6%**，**达成**；严格验收仍缺 GPU 侧耗时（需 timer query 或有头浏览器）。**真机显存（nvidia-smi）**：同一壁纸 1080p **+415 MiB**（对象 RT 静态估算仅 30.5 MB ⇒ 低估 8–14×）。**真机全量回归 37 PASS / 2 FAIL**，FAIL 项与软渲染基线逐项相同。完整数据见 `AGENT.md` §7.1 的 2026-09-20 订正。
  - **同轮发现并修复的一处泄漏**：`EffectRunner` 的纹理槽缓存在同一 WebGL 上下文内 resize 重挂链时**每次泄漏 28 张 GPU 纹理**（`renderer.info.memory.textures` 107→303 等差增长）；切换壁纸因新建上下文而不显形。修法与证据见 `AGENT.md` §7.5。
- **应用级 Glow 的显存与开销（2026-09-20 实测）**：base RT（画布缓冲尺寸）+ 6 张小 RT（三级各一对 ping-pong，合计约 **0.66×base** 面积）；实现用 `HalfFloatType`（RGBA8 口径翻倍）⇒ **720p 静态估算 ≈ 11.9 MB**（7 张：1280×720 base + 640×360 / 320×180 / 160×90 各两张），`renderer.info.memory.textures` 可精确核对（GTR **28 → 35，+7**）；spec 的 @3440×1440@dpr1 RGBA8 口径 ≈ 33 MB ⇒ HalfFloat 约 66 MB。**只统计 `glowEnabled` 时占用**，改阈值 / 强度不重建 RT。**开销**：每帧 CPU 侧 `renderer.render` 提交 **+0.1~+0.4 ms**（16.7ms 帧预算的 0.6~2.4%），**不含 GPU 时间**（真 GPU 光栅化异步，严格验收未做）。**`[6]` 显存泄漏探测仍 Δ 0**，但 5 次观测为 Δ0/Δ1/Δ0/Δ2/Δ0（开关两侧都出现过 Δ>0）⇒ 如实记为**零星残留 1~2 张、与 Glow 无关**（远小于修复前的 Δ196）。**如实**：只测了 GTR `3743126786` 一张壁纸；nvidia-smi 差值噪声 ±400 MiB，**不可用于定量**。完整数据见 `AGENT.md` §7.1 的 2026-09-20「已实现」子条。
- **音频响应效果不随频谱动**：three 主路径**没有音频源** —— `createAudioAnalyzer` 只被未接入的 `scene-renderer.ts` 引用，`ObjectEffectStage.advance` 每帧显式给 `EffectRunner` 传 `null`，音频 uniform 保持全零。属「效果在、但不随频谱动」，不是「不支持该效果」。接音频仍未做。

---

## 5. 备用 / 未接入路径（`AGENT.md` §2.1）

```
scene 壁纸 ──► three.js 播放器（**唯一路径**，v0.3.0 起）
                 │  渲染失败 / 渲染出 0 个可见对象
                 ▼
             preview 图 + Ken Burns（永不白屏）
```

- `wasm-renderer.ts`（`createWasmSceneRenderer` / `createFallbackSceneRenderer`）与 `scene-renderer.ts` 的 `renderScene`：**源码与单测保留，但运行时不再调用**（`index.ts` 仍 import 但未使用）。
- wasm 渲染器有**完整的对象效果链**（对象 RT + 局部正交相机 + `EffectChain` ping-pong + 合成 quad UV 窗口 + GLSL→SPIR-V→WGSL 编译链）；其 RT 图执行的 `bind` 索引语义与 lwe 不符（只取 `bind[0]`、按 `g_Texture(i+1)` 对齐；权威语义是 `bind.index → g_Texture<index>`）。three 路径的具名 RT 图链已于 **2026-09-15（P2）**实现，**能力差已消除**。
- **GPU（wasm）路径未消费 `instanceoverride`，也未应用对象 `angles`**：只接了 three 路径。用备用路径渲染同一张壁纸会有亮度与朝向差。
- **wasm 效果链对 visualizer / text 对象不生效**：这两类恒走共享场景路径（绕过对象 RT / 效果链）。
- **3 张壁纸在 wasm 路径判为 STATIC**（`2851992662` / `3392903359` / `3760200530`）：动画源是粒子（leaves/snow/bubbles），根因是 wasm 共享粒子路径动画未可见，属独立问题待专项。
- **wasm 效果链的历史卡点（已绕开，勿重走）**：naga 24/25 的 **glsl frontend 编译不了含 `uniform sampler2D` 的 GLSL**，而几乎全部 WE 效果 shader 都采样 `g_Texture0`。现行链路是 **GLSL → `@webgpu/glslang` → SPIR-V → `spirv-webgpu-transform`（拆组合采样）→ naga `spv-in` → WGSL**；`chain_desc` 为空/解析失败才回退内置演示 pass（绝不白屏）。
- **`g_ModelViewProjectionMatrix` 未由执行器提供**（材质 json 不给值 → 默认 0）。库内依赖 MVM 的效果都是「frag 效果 + vert passthrough」，故不受影响。
- **`collect_bindings` 用文本扫描从 WGSL 提取纹理绑定**，对更复杂的多纹理 shader 待改进。

---

## 6. 关键约定（踩过的坑）

1. **wasm 产物必须 `--target web`**：曾用 `--target module`（无默认导出 `__wbg_init`）导致 wasm 静默失败、一路回退。
2. **`research/`、`wasm/pkg/`、`dist/static/ptex-*.tex` 是 gitignore**；`lib/`、`dist/` 其余部分**必须提交**。
3. **场景资源禁止浏览器缓存**：`/wallpapers/scene/<id>/asset` 返回 `Cache-Control: no-store`。
4. **效果链的一切编译/建管线必须在加载时一次性完成**；`render_frame` / `render_object_effects` / `step` / `EffectChain::render` **不得**做 naga 编译或建管线（每帧只写 uniform + 建 bind group + 提交 pass）。
5. **对象 `angles`（弧度）必须应用**（粒子顶点 shader、背景 `mesh.rotation`）。全库 79 个对象带非零 angles（粒子 75 / image 2 / text 1 / other 1，涉及 15 张壁纸）。
6. **粒子 alpha 属性链**：透明度 = 生命周期衰减 × alpha；JS ShaderMaterial 与 wasm 粒子层双路径同语义，改 alpha 逻辑要双路径验证。
7. **WE 内置粒子/效果纹理走 host 路由，不随包分发**：`/wallpapers/particle-texture?name=<相对 assets/materials 的路径>`（`name` 不能无条件加 `particle/` 前缀 —— 有 `workshop/<id>/particle/...` 这类路径）。曾由 `build:client` 复制成 `dist/static/ptex-*.tex`，结果被 `files: ["dist"]` 打进 npm 包（解包 43 MB 里 33 MB 是它）。
8. **音频管线**：`createAudioAnalyzer` 频谱 → EffectRunner 音频 uniform + visualizer 条高；autoplay 被拦时 context suspended、可视化全零，用户手势后恢复。
9. **测试沙箱**：vitest / esbuild 依赖 service 子进程（命名管道），受限沙箱下报 `spawn EPERM` —— 需完整权限运行。

---

## 7. 工程现状 / 测试

- **全量 `vitest run` 有 15 项既有失败**（4 个文件：`wasm-renderer` 7 / `scene-renderer` 6 / `verify-real-library` 1 / `dom/bootstrap.dom` 1），均已确认在 v0.3.0 基线即失败；改动后请在 `git stash` 基线对比，**别把既有失败当成本次回归**。
  - 其中 `wasm-renderer` 那 7 项已定位到一半：`createWasmSceneRenderer.render()` 的裸 `catch {}` 把异常静默吞成「返回 false」（现已补 `console.warn`）。第一层真因是 mock 与代码脱节（mock scene 缺 `set_particle_sim` / `update_particles`）；补全 mock 后仍暴露更深的断言问题（`scene.add_particle` 未被调用）。
- **验证手段**：
  - 单测：`tests/**/*.test.ts`（默认 node），`tests/dom/**` 走 jsdom。
  - 全库解析回归：`tests/verify-real-library.test.ts`（全库 scene.pkg 的 scene.json / image 纹理 / particle 规格 / 效果链解析零失败）。
  - **端到端渲染（推荐）**：`research/verify-colorblend.mjs` 的模式 —— 自起 http server + headless Edge + esbuild 打包 harness，**用生产代码**渲染真实纹理并逐像素判定。**不依赖 DSH token**。
  - 全库浏览器回归：`research/verify-wasm-render.mjs` —— **当前跑不通**（硬编码 `?token=` 过期，401）。
- **README 效果素材的录制脚本**：`research/dsh-record/record-showcase.ps1`（真实 DSH 页面 + ffmpeg gdigrab 录屏，裁掉地址栏）。
- ⚠️ **README 里不要用 `<video>` 内嵌仓库内的 mp4 —— GitHub 上不会显示**（2026-09-14 实测，勿重走）：
  1. **GitHub 不重写 `<video>` 的相对路径**。它会把 `<img>` 的相对地址重写到 raw 域名，但不会对 `<video>` 这么做 ⇒ 浏览器按 README 所在页面路径去取 `github.com/<user>/<repo>/tree/<branch>/docs/videos/x.mp4`（HTML 页面），拿不到视频，显示为一片空白。
  2. **换成 raw 绝对地址同样播不了**：该仓库的 mp4 在所有 raw 域名下都返回 `Content-Type: application/octet-stream` 且带 `X-Content-Type-Options: nosniff`，nosniff 禁止浏览器把它当视频解码。

  实测矩阵（HEAD 请求）：

  | URL 形式 | HTTP | Content-Type | nosniff |
  |---|---|---|---|
  | `raw.githubusercontent.com/<repo>/<branch>/<path>` | 200 | `application/octet-stream` | `nosniff` |
  | `raw.githubusercontent.com/...?raw=true` | 200 | 同上 | 同上 |
  | `github.com/<repo>/raw/<branch>/<path>`（含 `?raw=true`） | 200 | 同上 | 同上 |
  | `github.com/<repo>/blob/<branch>/<path>?raw=true` | 200 | 同上 | 同上 |
  | `media.githubusercontent.com/media/<repo>/<branch>/<path>` | **404** | — | —（该 CDN 只服务 Git LFS 文件） |

  **可行做法**：README 内嵌用 **GIF**（正常返回 `Content-Type: image/gif`，可内嵌播放），mp4 留作「完整视频」链接（浏览器对顶层导航不套用 nosniff，点击后可在新页面播放/下载）。生成命令见 `research/gif-test`（已清理）所用的两遍调色板法：`fps=10,scale=560:-1` + `palettegen(max_colors=128)` + `paletteuse=dither=bayer`。
  注意 **GIF 是有损展示**（10fps / 128 色），不代表实际渲染帧率，故 mp4 不能删。
