# Scene 播放调研报告（2026-08-19 实测）

- 日期：2026-08-19
- 方法：真实库静态扫描（24 个 scene.pkg）+ 浏览器实测（headless Edge + CDP 驱动 DSH GUI，全 24 个 scene 壁纸逐个切换、双帧截图、像素统计、console 收集）
- 关联：`docs/superpowers/specs/2026-08-19-scene-play-fix-and-theme-design.md`（A1-A5 设计稿，本次实测验证并补充新根因）

## 1. 结论摘要

1. **黑屏问题已不存在**：24 个 scene 壁纸 0 黑屏，15 个动态（OK）、9 个静态（STATIC）。
2. **静态壁纸中 7 个是"应动未动"**（效果链失败/粒子静止/text 回退），2 个是壁纸本身静态图（2212665284/2816905191，正常）。
3. **效果链是最大短板**：大量 shader pass 编译失败（单壁纸最多 2688 条警告）、纹理槽路径错误导致 mask/normal 全 404、7 个效果链整体解析失败——即使画面在动，效果质量也远低于真实 WE。
4. **粒子系统是第二短板**：材质纹理/operator/无 velocity 扩散/vLife 全部缺失，粒子"看起来不像在播放"。
5. **资源解析链路 100% 健康**（详见 §3 已排除）。

## 2. 实测判定表（headless Edge，双帧间隔 1.5s）

| id | 判定 | avg | diff | 编译失败 | 纹理槽失败 | 说明 |
|---|---|---|---|---|---|---|
| 1280029027 EVA | OK | 200.75 | 3.7% | 0 | 0 | 动态来自 Ashes/fog1 粒子 |
| 1429403119 | OK | 146.2 | 75.18% | 0 | 60 | 水波动但 mask/normal 全缺 |
| 1968789468 | OK | 155.17 | 38.52% | 2688 | 20 | 大量 pass 编译失败 |
| 2011060960 | OK | 121.56 | 70.16% | 1274 | 44 | blur_combine 缺 ApplyComposite |
| 2132420420 | **STATIC** | 129.89 | 0% | 38 | 8 | 效果链失效→静态图 |
| 2212665284 | STATIC | 107.21 | 0% | 0 | 0 | 纯静态图场景（正常） |
| 2236329190 | OK | 204.29 | 17.01% | 0 | 0 | |
| 2454403969 | **STATIC** | 39.39 | 0% | 893 | 8 | clouds 编译失败 + util 纹理缺失 |
| 2460786246 | OK | 193.38 | 41.95% | 896 | 2 | vhs 编译失败仍动 |
| 2597392171 | **STATIC** | 142.41 | 0% | 681 | 42 | pass0 失败 + mask 全 404 |
| 2683211654 | OK | 210.61 | 5.27% | 20 | 2 | |
| 2816905191 | STATIC | 127.56 | 0% | 0 | 0 | 静态图 + Clock text 不支持 |
| 2832263418 | OK | 175.8 | 37.85% | 863 | 10 | |
| 2851992662 | OK | 193.7 | 39.07% | 16 | 0 | |
| 2859263090 | **STATIC** | 214.06 | 0.15% | 0 | 0 | 粒子 NaN + 大量静止粒子 |
| 2897292240 | OK | 212.19 | 2.28% | 0 | 8 | blur 效果链解析失败 |
| 2911105183 | OK | 167.26 | 66.81% | 0 | 38 | 4K 黑屏基线已恢复；mask 全 404 |
| 2937346640 | OK | 70.71 | 1.37% | 1084 | 10 | foliagesway 编译失败 |
| 2980088441 | **STATIC** | 27.67 | 0.01% | 6 | 0 | **纯 text → 回退 preview（0c/1i）** |
| 3303428996 | STATIC | 164.89 | 0% | 0 | 0 | lightshafts 效果无可见动画 |
| 3392903359 | OK | 170.34 | 15.67% | 0 | 0 | |
| 3743126786 | OK | 130.12 | 6.96% | 0 | 16 | bloom 解析失败 + mask 404 |
| 3760200530 | OK | 178.63 | 3.35% | 0 | 0 | |
| 3765967112 | **STATIC** | 164.94 | 0% | 787 | 6 | waterflow 编译失败 + blurprecise 解析失败 |

判定：BLACK=avg<6 且 dark>95%；STATIC=两帧 diff<0.5%。

## 3. 已排除（链路健康，实测零失败）

- scene.json 解析：24/24 成功
- image 对象纹理链路（model→material→passes[0].textures[0]→.tex）：66/66 成功
- particle 规格解析：109/109 成功
- 效果链资源解析（effect.json→material→shader→include 展开）：122/122 成功
- HTTP 路由、tex 容器解析（TEXB0001-0004）：全库零失败
- tex 格式分布：RGBA8888×63、DXT1×2、DXT5×1、RG88/R8×N（mask 类）；imageFormat(FIF) JPEG×16/PNG×16

## 4. 根因清单（按优先级）

### P0-1 效果链纹理槽路径错误（新发现，spec 未覆盖）
- **现象**：几乎所有带效果壁纸的 mask/normal 纹理槽 404（1429403119×60、2911105183×38、2597392171×42…）。
- **根因**：`effect-runner.ts resolveTextureSlot`（L168）直接用 scene.json pass.textures 原始字符串 fetch；真实路径需推导：无后缀 → 加 `materials/` 前缀 + `.tex`（如 `masks/shake_mask_x` → `materials/masks/shake_mask_x.tex`，实测文件存在）。
- **证据**：`materials/masks/shake_mask_*.tex`、`materials/effects/waterripplenormal.tex` 均存在于 pkg，实测 404。
- **影响**：效果链无 mask → 全屏混合（无局部遮罩）、无 normal → 水波纹无扰动，视觉效果大减。

### P0-2 内置/动态纹理槽缺失回退
- **现象**：`util/white`、`util/noise`、`util/clouds_256`、`_rt_imageLayerComposite_*` 等纹理槽加载失败。
- **根因**：WE 引擎内置程序纹理（util/*）与运行时 RT 引用（_rt_*）在 pkg 中不存在；浏览器端无内置生成/回退。
- **方案**：`util/white` 回退 1×1 白纹理；`util/noise`/`util/clouds_256` 程序生成（或回退中性值）；`_rt_*` 按真实 WE 语义回退（多数是合成层 RT，一期回退 input 纹理或白色）。

### P0-3 效果 shader 编译失败（大量）
- **现象**：1968789468×2688、2011060960×1274、2937346640×1084、3765967112×787…；effect-runner 只报 pass 序号不报 shader 名。
- **已知根因**：`we-headers.ts` 的 `common_composite.h` 是空占位，而 3 壁纸（2011060960/2597392171/2897292240）的 `shaders/effects/blur_combine.frag` 调用 `ApplyComposite`/`ApplyCompositeOffset`（各 1 处）→ 编译必然失败（undefined function）。
- **待查**：其余大量编译失败（vhs/waterwaves/foliagesway/clouds 等）的具体 shader 错误文本——effect-runner 的 onShaderError 拦截未打印详情，需浏览器 hook 补充证据。
- **方案**：补 `ApplyComposite`/`ApplyCompositeOffset` 实现（语义对照 linux-wallpaperengine 逆向源码，见 spec A4）；随后对剩余编译失败逐 shader 收集错误文本。

### P0-4 效果链整体解析失败（7 个）→ 根因已查明（fetch 偶发失败）
- 现象：1429403119 waterwaves、2011060960 clouds、2597392171 godrays、2897292240 blur、2911105183 perspective/tint、3743126786 bloom、3765967112 blurprecise 各 1-2 条"效果链解析失败"。
- **根因（2026-08-19 实测确认）**：非文件/逻辑问题。内存版 `resolveEffectChain` 对 7 壁纸全部 100 条引用 **100/100 成功**（`tests/research-repro.test.ts`）；浏览器内静态逐条 fetch 也 100% 成功（`research/verify-chain-fetch.mjs`）；真实渲染时偶发 `fetch → TypeError: Failed to fetch`（仅 6ms，非超时，`research/verify-fetch-reject.mjs` 捕获）→ 高并发（200+ 请求/壁纸）下 HTTP keep-alive 连接复用竞态，浏览器复用已死连接。
- **修复方向**：`resolveEffectChain` 的 `loadFile` 加失败重试（1-2 次）；可选并发限流（纹理槽/效果链加载 Promise 池 ≤6）。

### P1-1 纯 text 壁纸必然回退 preview
- **现象**：2980088441（11 个 text 对象）实测 DOM=0c/1i → 回退 preview 缩略图。
- **根因**：`scene-json.ts` L48 无引用对象全部归为"空粒子"；`renderScene` 中 text 无分支 → rendered=0 → 回退。
- **方案**：spec A5（SceneTextObject + CanvasTexture 渲染）。全库 23 个 text 对象，Clock 文本由运行时注入，一期渲染占位文本。

### P1-2 粒子系统"看起来没在播放"（spec A2 全部待实施）
- **无材质纹理**：29 个粒子文件 100% 有 material，但 `particlesFromSpec` 丢弃 → 硬编码圆形点精灵（scene-renderer.ts L171-182）。注意实测 EVA 中仅 lightshaft.tex 存在，fog/lightning/ashes 的材质纹理在 pkg 中缺失（fog3/debris1 等不存在）→ 纹理加载失败须静默回退圆形。
- **operator 丢弃**：movement(gravity)×27、alphafade×28 全被忽略（如 Ashes gravity="1 0 0" 无下落、snowperspective alphafade 无淡入）。
- **无 velocityrandom → 粒子静止**：fog2/lightning1（EVA）、Drops/trail_2（2859263090）无 velocityrandom → vx=vy=vz=0，粒子出生后不动。
- **发射率过低**：lightshafts rate=0.3 → 3.3 秒 1 粒子。
- **vLife 恒 1.0**：scene-renderer.ts L173 `vLife = 1.0` → 无寿命淡出，粒子到点突然消失。
- **distancemax 向量解析 NaN**（新发现）：2859263090 的 `Ice_Particle_2.json` emitter.distancemax="50 256 0"（boxrandom 向量）→ `Number()` → NaN → 粒子坐标 NaN（实测 3 条 `computeBoundingSphere NaN` 错误）。

### P1-3 失败静默（spec A1 未实施）
- `renderScene` catch 全吞返回 false → controller 回退 preview 无任何提示；用户面对静态图/黑屏无解释。
- 方案：catch 加 console.error + 回退时状态徽标。

### P2 纹理质量项
- **RG88/R8 单通道 mask 不支持**（新发现）：2597392171/2832263418/2911105183/3743126786 的 mask tex 为 format 8/9 → `tex-loader.ts` FORMAT_TO_GL 无此格式 → null → mask 缺失。
- **DXT 未行翻转**（spec A3）：3 个 DXT 纹理（2937346640 DXT1 6144×3072、3743126786 clouds DXT1、3765967112 dayNightToggleSprite DXT5）上下颠倒。
- **大纹理降采样**（spec A3）：pickMipmap 已选 ≤2048 级（3743126786 7430×4147 有 1857×1036 mip ✓），单 mip 大图（2911105183 4096×4096 JPEG）建议 createImageBitmap resize。

## 5. 修复路径建议（按收益排序）

1. **P0-1 + P0-2**：纹理槽路径推导 + 内置纹理回退（一行级改动，收益最大：所有 mask/normal 生效）
2. **P0-3**：we-headers 补 ApplyComposite 2 函数（3 壁纸 blur_combine 恢复）
3. **P0-4**：逐个排查 7 个解析失败效果链
4. **P1-2**：粒子 A2 全套（材质纹理回退加载、movement/alphafade operator、无 velocity 扩散、vLife 衰减、distancemax 向量安全解析）
5. **P1-1**：text 对象（A5）
6. **P1-3**：失败可视化（A1）
7. **P2**：RG88/R8、DXT 翻转、降采样（A3）

## 6. 遗留验证点

- effect-runner 打印 shader 编译错误详情（onShaderError 收集 info log），定位剩余编译失败 shader
- 7 个效果链解析失败的逐链根因
- 3303428996 lightshafts 效果"编译成功但无动画"的语义确认（可能 shader 依赖音频/相机数据）
- 2911105183 4K 黑屏基线已恢复的根因确认（Task 7 后哪次修复生效）

## 7. 外部参考资源（GitHub 调研，2026-08-19）

### 现成 scene 解析+播放实现（均为 C++/原生，无 JS/Web 端先例）

| 仓库 | ★ | 技术栈 | 价值 |
|---|---|---|---|
| [Almamu/linux-wallpaperengine](https://github.com/Almamu/linux-wallpaperengine) | 4515 | C++/OpenGL | 最完整活跃的 WE 运行时：scene.pkg 全链路解析（`src/WallpaperEngine/Data/Parsers/`）+ 渲染 + 音频；`docs/`（JSON_FORMAT/OBJECTS/CAMERA_SETTINGS/TEXTURE_FORMAT）是 scene.json/tex 字段语义权威 |
| [catsout/wallpaper-scene-renderer](https://github.com/catsout/wallpaper-scene-renderer) | 43 | C++/Vulkan | 独立 scene 渲染器（43★但专注 scene）：`WPSceneParser/WPParticleParser/WPTexImageParser/WPShaderParser` + `src/Particle/`（ParticleEmitter/ParticleModify）+ `src/RenderGraph/`（效果链渲染图）+ `wpdoc/` 文档 |
| [NixaXI/AnisPaper](https://github.com/NixaXI/AnisPaper) | 39 | C++/Wayland | KDE Plasma 6 隔离渲染器，流式推帧 |
| [Unayung/wallpaper-engine-mac](https://github.com/Unayung/wallpaper-engine-mac) | 55 | C++/macOS | Open Wallpaper Engine 补丁版（补 scene 渲染） |
| [laobamac/MirageWallpaper](https://github.com/laobamac/MirageWallpaper) | 115 | macOS | 动态壁纸引擎，含 scene |
| [Paradox07127/macos-wallpaperengine](https://github.com/Paradox07127/macos-wallpaperengine) | 21 | Metal | macOS 原生 scene 渲染 |
| [notscuffed/repkg](https://github.com/notscuffed/repkg) | 3670 | C# | scene.pkg 提取 + TEX→图片转换（解析层权威，非渲染） |
| [liixini/skwd-wall](https://github.com/liixini/skwd-wall) | 622 | Rust | 壁纸选择器 + matugen 主题，scene 播放能力有限 |

### 结论

1. **无 JS/Web 端现成播放器**：浏览器端渲染 WE scene 目前没有开源先例，本项目为首创；C++ 实现可作语义蓝本，但代码无法直接移植（Vulkan/OpenGL + Qt）。
2. **我们最缺的 ApplyComposite 语义在开源仓库中没有 GLSL 实现**：`common_composite.h` 是 WE 引擎内置资产（不在壁纸 pkg 中），开源项目均从壁纸包读 shader 后自行兜底。权威来源：官方 [docs.wallpaperengine.io blur 文档](https://docs.wallpaperengine.io/en/scene/effects/effect/blur.html)（确认 Composite 4 模式：Normal/Blend/Under/Cutout，对应 blur_combine.frag 的 COMPOSITE combo 0/1/2/3）+ WE 安装目录 `assets/shaders/` 或 SteamDB [depot 431961 assets/shaders/combine_hdr](https://steamdb.info/depot/431961/history/?changeid=M:7021698248875048145#23)。
3. **字段语义对照**：scene.json 对象/粒子/材质字段（origin/scale/effects/particle.operator 等）以 linux-wallpaperengine `docs/rendering/OBJECTS.md` + catsout `wpdoc/scenejson.md` 为准；粒子 operator（movement/alphafade）实现参考 catsout `src/Particle/ParticleModify.cpp`。

## 8. 引擎内置头文件对照（本机权威源码，2026-08-19 新增）

**来源**：本机 WE 客户端 `D:\Steam\steamapps\common\wallpaper_engine\assets\shaders\`（官方引擎内置资产，非壁纸包）。`common_composite.h` 等 7 个头文件全部存在，含完整实现——这是 A4 补全的**权威依据**，不再依赖逆向猜测。

### 8.1 关键差异（we-headers.ts 现状 vs 引擎真实实现）

| 符号 | 引擎真实实现 | we-headers 现状 | 影响壁纸 |
|---|---|---|---|
| `M_PI_2` | **6.28318530718（=2π）**，另有 M_PI_HALF=π/2 | **1.5707963267948966（π/2，错误）** | 13 处/8 壁纸（旋转角度差 4 倍） |
| `ApplyComposite/ApplyCompositeOffset` | common_composite.h 完整实现（COMPOSITE 0/1/2/3 + COMPOSITEMONO + g_CompositeAlpha/Offset/Color uniform） | **缺失**（空占位） | 2011060960/2597392171/2897292240（blur_combine.frag 编译必失败） |
| `greyscale` | common.h `dot(color, vec3(0.11,0.59,0.3))` | **缺失** | 2011060960/2454403969/2460786246（clouds/vhs 编译失败） |
| `BlendOpacity/BlendLinearDodge` | common_blending.h 宏（`mix(base,F(base,blend),O)` / `min(base+blend,1)`） | **缺失** | 2454403969/2460786246（**vhs/clouds 编译失败直接根因**） |
| `ApplyBlending` | **BLENDMODE 宏驱动 31 种混合**（darken/multiply/softlight/tint/线加…） | 运行时 if 仅 5 种，且 12=SoftLight 误作 multiply、30=Tint/31=线加误作 mix | 全库（tint/clouds/vhs 视觉错误） |
| `blur13a/blur7a/blur3a` | 真实权重/偏移（13-tap 0.1976/0.2960/0.0935/0.0117；blur7a 为 4-tap **不对称**） | 旧式 13/5/3-tap 权重**不同** | 2597392171/2911105183/2937346640/3765967112 |
| `squareToQuad` | common_perspective.h 列主序 + p2/p3 交换 + det==0 分支 | 行主序近似版，**映射不同** | 2897292240/2911105183/3303428996/3743126786 |
| `DecompressNormal` | 处理 DXT swizzle（TEX1FORMAT combo）+ RG88 + wy 通道 | 简化版（xyz*2-1） | 2911105183（refract.frag） |
| `common_fragment.h/common_vertex.h` | 真实内容：FORMAT_* 宏/ComputeLight/ConvertTexture*/BuildTangentSpace | **空占位** | 当前全库无直接调用（影响小） |

### 8.2 全库符号调用实测（scan-header-symbols.mjs）

**必须补**（有调用）：M_PI_2×13、squareToQuad×6、blur13a/blur7a/blur3a×4、greyscale×3、ApplyComposite×3、ApplyCompositeOffset×3、BlendLinearDodge×2、BlendOpacity×2、DecompressNormal×1
**暂缺无害**（无调用）：hsv2rgb/rgb2hsv/M_PI_HALF/SQRT_2/SQRT_3、Desaturate/RGBToHSL/HSLToRGB/HueToRGB/ContrastSaturationBrightness、Blend* 其余 20+ 种、ComputeLight/ConvertTexture*/BuildTangentSpace、common_particles.h 全部

### 8.3 结论

1. **vhs/clouds 效果链编译失败的直接根因** = 缺 `BlendOpacity`/`BlendLinearDodge`/`greyscale`（2454403969/2460786246）；**blur_combine 编译失败根因** = 缺 `ApplyComposite*`（3 壁纸）。
2. A4 的实施 = 用引擎真实头文件内容**转写** we-headers（保留 frac/saturate/texSample2D/mul/CAST* 等 GLSL 补丁，因引擎走 HLSL 翻译而 we 走 GLSL3）。
3. 顺带修正 `M_PI_2` 常量值与 blur/squareToQuad/DecompressNormal/ApplyBlending 语义。

---

## 9. 阶段 1 修复后全库实测对比（Task 5，2026-08-19 收尾）

- **方法**：与 §2 基线同脚本 `research/verify-blackout.mjs`（headless Edge + CDP 驱动 DSH GUI，全 24 个 scene 壁纸逐个切换、双帧截图、console 收集）；bundle = HEAD 1b5357a（Task 1-4 全部提交）重新构建的 `dist/client.js` 同步至 profile 后启动全新 headless Edge 实例实测。运行中脚本 CDP 连接两次短暂停滞（页面侧超时/截图慢，约 3-5 分钟自恢复），全部壁纸均在修复后 bundle 下测得，结果有效。
- **console 统计口径**：编译/纹理为 error+warning 事件条数（同一警告按 pass 多次触发会重复计数）；"纹理槽失败"另按唯一文件口径统计。

### 9.1 对比表（基线 §2 vs 修复后）

| id | 基线判定 | 基线 diff | 基线 编译/纹理 | 修复后判定 | 修复后 diff | 修复后 编译/纹理 | 变化 |
|---|---|---|---|---|---|---|---|
| 1280029027 EVA | OK | 3.7% | 0/0 | OK | 31.19% | 0/0 | 更动态 ✓ |
| 1429403119 | OK | 75.18% | 0/60 | OK | 32.09% | 2272/0 | 纹理 60→0 ✓；编译 0→2272 ✗ |
| 1968789468 | OK | 38.52% | 2688/20 | **STATIC** | 0% | 1528/0 | **回归 OK→STATIC** ✗ |
| 2011060960 | OK | 70.16% | 1274/44 | OK | 19.77% | 1927/0 | 纹理 44→0 ✓；diff 大降 ✗ |
| 2132420420 | STATIC | 0% | 38/8 | STATIC | 0% | 1144/0 | 目标 D 未达 ✗ |
| 2212665284 | STATIC | 0% | 0/0 | STATIC | 0% | 20/0 | 纯静态图（正常），编译 0→20 ✗ |
| 2236329190 | OK | 17.01% | 0/0 | OK | 1.52% | 928/0 | diff 大降、编译 0→928 ✗ |
| 2454403969 | STATIC | 0% | 893/8 | STATIC | 0% | 1093/0 | 目标 D 未达 ✗ |
| 2460786246 | OK | 41.95% | 896/2 | OK | 37.93% | 308/0 | 编译 896→308 ✓（vhs 仍失败） |
| 2597392171 | STATIC | 0% | 681/42 | **OK** | 7.65% | 1743/10 | **目标 D 达成** ✓ |
| 2683211654 | OK | 5.27% | 20/2 | OK | 14.12% | 600/1 | 更动态，编译升 ✗ |
| 2816905191 | STATIC | 0% | 0/0 | STATIC | 0% | 10/0 | 纯静态图（正常） |
| 2832263418 | OK | 37.85% | 863/10 | OK | 13.36% | 1012/5 | diff 大降 ✗ |
| 2851992662 | OK | 39.07% | 16/0 | OK | 29.03% | 84/0 | diff 降 ✗ |
| 2859263090 | STATIC | 0.15% | 0/0 | **OK** | 8.61% | 0/0 | **转 OK** ✓（超出目标 D 名单） |
| 2897292240 | OK | 2.28% | 0/8 | OK | 5.9% | 805/5 | 编译 0→805 ✗ |
| 2911105183 | OK | 66.81% | 0/38 | OK | 95.8% | 999/0 | 纹理 38→0 ✓；编译 0→999 ✗ |
| 2937346640 | OK | 1.37% | 1084/10 | **STATIC** | 0% | 1240/20 | **回归 OK→STATIC** ✗ |
| 2980088441 | STATIC | 0.01% | 6/0 | STATIC | 0% | 16/0 | 纯 text 回退 preview（P1-1，正常） |
| 3303428996 | STATIC | 0% | 0/0 | STATIC | 0.01% | 298/0 | lightshafts 无可见动画（已知） |
| 3392903359 | OK | 15.67% | 0/0 | OK | 14.46% | 6/0 | 相近 |
| 3743126786 | OK | 6.96% | 0/16 | **STATIC** | 0% | 1936/7 | **回归 OK→STATIC** ✗ |
| 3760200530 | OK | 3.35% | 0/0 | **STATIC** | 0.36% | 744/0 | **回归 OK→STATIC（临界）** ✗ |
| 3765967112 | STATIC | 0% | 787/6 | STATIC | 0.25% | 1486/2 | 目标 D 未达 ✗ |

**汇总**：OK 15→15（其中 1968789468/2937346640/3743126786/3760200530 四个原 OK 转 STATIC，2597392171/2859263090 两个原 STATIC 转 OK，净判定数不变但构成恶化）；编译失败总条数 **9246 → 20199（+118%）**；纹理失败总条数 **274 → 50**（唯一失败文件 13 个）。

### 9.2 目标 A-D 达成情况

- **目标 A（纹理槽加载失败归零）：部分达成（❌ 未归零，但 404 已全灭）**。P0-1/P0-2 生效：`util/*`、`_rt_*` 内置回退工作正常，mask/normal 路径推导后不再 404（1429403119 60→0、2911105183 38→0、2011060960 44→0）。剩余 13 个唯一失败文件**全部**是 `materials/masks/*.tex`，已用 pkg 条目核对**文件真实存在且推导路径完全正确**（如 `materials/masks/waterripple_mask_a9fb4892.tex`），失败原因是 **tex 格式 format 8/9（R8/RG88 单通道）tex-loader 不支持**（§4 P2 已知项，`FORMAT_TO_GL` 无此格式 → parse 后纹理为 null）——属 P0 范围外遗留，非修复回归。
- **目标 B（效果链解析失败归零）：✅ 达成**。全库实测 `效果链解析失败` 0 次、`Failed to fetch` 0 次（P0-4 fetch 重试生效；基线 7 个壁纸各 1-2 条）。
- **目标 C（编译失败显著下降）：❌ 未达成，反而 +118%**。根因见 §9.3——P0-3 转写引入的 `1e-10` 字面量与既有预处理 bug 叠加，导致全库 effect pass 编译失败暴涨（1429403119 0→2272、2236329190 0→928、2897292240 0→805、2911105183 0→999、2132420420 38→1144 等）。仅 2460786246（896→308）下降。
- **目标 D（2132420420/2454403969/2597392171/3765967112 转 OK）：部分达成（2/4 + 额外 1 个）**。2597392171 ✅ 转 OK（7.65%）；2454403969 ❌ 仍 STATIC（clouds 编译失败 1093 条，现为 `1e-10` 损坏所致，非原 BlendOpacity 缺失）；2132420420 ❌ 仍 STATIC；3765967112 ❌ 仍 STATIC（0.25% 临界，diff 从 0% 微升）。额外：2859263090 由 STATIC→OK（8.61%）。
- **回归（原 OK 不变差）：❌ 严重**。1968789468（38.52%→0）、3743126786（6.96%→0）、3760200530（3.35%→0.36%）、2937346640（1.37%→0）四个原 OK 壁纸转 STATIC；2011060960（70%→20%）、2236329190（17%→1.5%）、2832263418（37.85%→13.36%）、2851992662（39%→29%）等 diff 显著下降。全部由 §9.3 同一根因解释（效果链 shader 编译失败 → 效果层动画消失，仅剩粒子/基础场景动画）。

### 9.3 编译失败暴涨根因（P0-3 回归，已 100% 定位）

- **现象**：`ERROR: 0:98-113: '.0' : syntax error`，行号范围恰好覆盖 Task 3 转写的引擎真实 `common.h` 中 `rgb2hsv` 函数体（98-113 行）。
- **证据链**：
  1. CDP 注入 `getShaderInfoLog`/`shaderSource` hook，对 1429403119/1968789468/2236329190/2454403969/3765967112 五壁纸收集 **12,024 条编译错误，去重 11 类，100% 为 `'.0' : syntax error`**，全部位于 `rgb2hsv` 的 `1e-10` 字面量处。
  2. node 复现：`preprocessWeShader` 对含 `#include "common.h"` 的 shader 输出 `float H = abs((Q.w - Q.y) / (6.0 * C + 1e-10.0) + Q.z);`——`1e-10` 被改写成非法 GLSL `1e-10.0`。
  3. 全库头文件扫描：**仅 common.h 含 `e-` 科学计数法字面量（`1e-10`×2，均在 rgb2hsv）**；修复前的旧 common.h 无 `1e-10`，故该 bug 在基线未触发。
- **根因**：`shader-preprocessor.ts` `normalizeFloatIntLiterals`（L108）的裸 int 补 `.0` 正则 `(?<![\w.])-?\d+(?![\w.])` 不排除科学计数法指数——`1e-10` 中指数 `10`（前驱为 `-`、后继为 `)`）被误判为裸 int 补成 `1e-10.0`。该函数处理**内联展开后的完整 shader**（含全部头文件），而 common.h 被自动注入到每个 effect shader（显式 include 者展开、未显式 include 者前置注入）→ **全库 effect pass 无一幸免**；粒子/基础场景（不走效果链 shader）不受影响，故 EVA/DK 等 0 编译失败且仍动态。
- **修复方向（已验证）**：在 L108 裸 int 正则之前先保护科学计数法字面量（`-?\d+(?:\.\d+)?[eE][+-]?\d+` 占位），复刻验证后 `1e-10.0` 损坏 0 次、`1e-10` 保留 2 次。此修复属阶段 2 范畴（本任务为验证收尾，不改代码）。
- **影响评估**：修复后 §9.1 中所有 `'.0'` 编译失败应消除，effect pass 恢复编译 → 目标 C/D 与回归项预期大幅改善；届时需重跑全库实测复核。

### 9.4 其他观测

- 2859263090 粒子 NaN 错误（`computeBoundingSphere NaN`×3，P1-2 distancemax 向量解析）仍在，但粒子已动（diff 8.61%）——P1-2 遗留。
- 2980088441 仍回退 preview（0c/1i，P1-1 纯 text），正常。
- `WebGL: too many errors` 警告在多壁纸出现：共享 WebGL 上下文错误预算耗尽后浏览器不再向 console 上报 GL 错误（不影响 COMPILE_STATUS 判定，应用层警告仍正常输出）。
- 基线 §6 遗留验证点"effect-runner 打印 shader 编译错误详情"仍未落实——本次通过外部 WebGL hook 补足证据；建议阶段 2 把 info log 接入 onShaderError（一行级改动，未来排查免 hook）。
