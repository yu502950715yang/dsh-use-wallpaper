# 渲染 / 场景能力缺口审计（面向 1.0.0）

> 审计日期：2026-11-06 ｜ 插件版本：`@dsh-use/wallpaper-engine` **v0.13.0**（代码基准 HEAD `0056109`）
> 对照基准：**Wallpaper Engine 桌面版 v2.8.42**（本机安装目录 `D:/Steam/steamapps/common/wallpaper_engine`，其 `assets/shaders` 为明文，可直接核对语义）
> 素材口径：`D:/Steam/steamapps/workshop/content/431960` 当前 **50 个条目 = 43 个 scene 条目（42 个独立 `scene.pkg` + 1 个 preset `3163840671` 共享依赖 `3118949804`）+ 4 web + 3 video**。**注意**：`docs/2026-10-20-library-feature-gap-audit.md` 的口径是 43 张（37 scene + 4 web + 2 video），此后库增至 50，本文数字按当前库重扫，不能直接与旧报告对比。
> 方法：逐条以**当前代码**为准（不采信「已修」记录本身）；素材侧用只读脚本解包 42 个 `scene.pkg`，统计 `scene.json` / 粒子 spec / effect 链 / 脚本内联源码的字段命中；语义疑问直接读 WE 明文 shader 核对。未运行 vitest/e2e/build（由另一 teammate 负责）。

## TL;DR

1. **没有发现 v0.8.0 审计里那批 P0 级缺口残留**：util 层（有 effects）、text effects、壁纸级 bloom、clearcolor、用户属性全类型、sound 音量/播放模式、视频声音、starttime、`_rt_FullFrameBuffer` 消费、`instanceoverride` 解包、g_PointerPosition 等均已在 v0.8.1–v0.13 修复并有代码证据（见 C 节 F1–F21）。
2. **剩余最大的用户可感知缺口是「粒子引擎的高级能力」**：子粒子 `children`（14 张 scene 命中）、`ropetrail/rope`（5 张）、`vortex`（2 张）、`link_mouse` 鼠标互动控制点（6 张）、`mapsequencearoundcontrolpoint`（1 张）、`boids`/`remapvalue`（1 张）——这些在桌面 WE 里是原生的常见特性。
3. **两个「整层缺失」类问题**：puppet 对象上的 effects 不挂链（2 张，`3303428996` 的光柱整层缺失）；puppet 蒙皮动画唯一真实样本 `3812518176` 的 `MDLA` 解析仍 failed（角色动画大概率静止）。
4. **一条已证实的正确性 bug**：粒子自旋轴序。WE 明文 `assets/shaders/common_particles.h` 的 `ComputeParticleTangents` 是 `Rz·Rx·Ry`，本项目统一用 `Rz·Ry·Rx`；多轴自旋（9 张）结果会与桌面不同，z-only 等价。**这是 1.0 前性价比最高的一条**（S）。
5. **`copybackground` 只是部分解决**：唯一真实消费点 `2597392171` 的 godrays 已随对象链快照修复（技术笔记里的「未绑定」记录已过时）；但对象级 `copybackground` 字段本身仍未解析，本机 **23 个 scene 条目**命中该字段，其余 22 张是否有可见差**待真机 A/B 定性**。
6. **文档-实现漂移**（发布前必须同步，否则 1.0 的「如实标注」原则打折）：`docs/technical-notes.md:78` 仍写 `_rt_FullFrameBuffer` 不绑（实际 2026-10-28 已开对象链消费）；`three-renderer.ts:1391` 注释称门控关闭、与 `object-effects.ts:25` 常量矛盾；README「使用前请了解」未披露 puppet effects 不支持、puppet 动画解析边界、vortex/link_mouse 鼠标互动粒子不支持（README 已披露 ropetrail/children/hdr/clearenabled/点击不可达，这几项不算漂移）。
7. **场景交互在生产 GUI 不可达是既定产品决策**（背景层 `pointer-events:none`，2026-10-20），不是 1.0 缺陷；但 `getLayer(name)` 写入丢弃、`getEffect().visible` stub、`cursorEnter/Leave/Down/Up` 未派发属实现缺口（影响 2–3 张）。
8. **性能/显存没有量化门槛**：无场景 FPS 计时、无显存 cap；1.0 需要一次参考机测量（不改代码，S）。
9. **本机零可见影响的「引擎完备性缺口」**：HDR / bloomhdr / bloomtint、colorBlendMode 其它模式、跨层 `_rt_imageLayerComposite_*`、视差传播组、`disablepropagation`、`clearenabled`、mediaTimelineChanged——均可记边界，不该阻塞 1.0。
10. **建议 1.0 定位 = 「scene 主链路稳定 + 边界诚实公开」，不是「WE 功能对齐」**（详见 D 节）。

---

## A. 当前仍缺（按用户可感知度排序）

> 类型：**引擎能力** = 实现层面未覆盖；**素材边界** = 依赖作者素材/WE 私有数据；**环境限制** = 浏览器/部署环境。
> 影响面 = 本机 50 条目中命中的 scene 条目数（preset 与依赖同名时单独注明）；「未知/待确认」不猜。
> 工作量：S（≈<0.5 周）/ M（≈1–2 周）/ L（>2 周）——粗估，仅用于排期，不含验收与真机对拍。

| # | 缺口 | 类型 | 影响面 | 用户可感知后果 | 代码证据（path:line） | 工作量 |
|---|---|---|---|---|---|---|
| A1 | **子粒子 `children`（eventspawn/eventfollow/death）完全未实现** | 引擎能力 | **14 张**（1280029027、1922570576、2011060960、2236329190、2460786246、2597392171、2859263090、3118949804、3660373677、3743126786、3765967112、3795587868、3811798465、3812518176；另 preset 3163840671 共享） | 火焰缺火星/余烬、雷电缺二次放电、流星缺光晕、雪暴缺雾层、萤火虫缺闪烁：粒子层「少一半」 | `wasm/src/particle/sim.rs:785-786`（明确「本实现不支持 children」）；`wasm/src/particle/mod.rs` 无 `children` 解析；`src/client/threejs-player.ts:230-248` 仅对稀疏事件源整层跳过 | **L**：需 wasm 侧子发射器队列 + 渲染侧多粒子层/生命周期联动，且要处理事件类型与 dt 语义 |
| A2 | **`ropetrail` / `rope` renderer 退化画成贴片 sprite** | 引擎能力 | **5 张**（1922570576、2859263090、3743126786、3765967112、3812518176） | 绳索/流星拖尾形态错误（应为沿路径的条带/绳） | `wasm/src/particle/mod.rs:430-447`（解析出 `Renderer::Rope/RopeTrail`，但注释 `:432` 明说「当前交由 sprite 兜底」）；`src/client/threejs-player.ts:169-176`（`specRenderer` 只认 spritetrail） | **M**：需按路径点生成条带几何（或 shader 内拉伸），wasm 需维护轨迹点 |
| A3 | **`vortex` 算子被当未知算子跳过** | 引擎能力 | **2 张**（1922570576 魔法漩涡、3811798465 樱花） | 漩涡无旋转、花瓣不绕旋 | `wasm/src/particle/mod.rs:413-426`（无 vortex 分支→Other）；`wasm/src/particle/spec_to_emitter.rs:223`（「不可识别算子（vortex 等）跳过」） | **M**：绕控制点的切向/径向力，需控制点世界坐标 |
| A4 | **`link_mouse` 控制点不生效（鼠标互动粒子）** | 引擎能力 | **6 张**（2859263090、2911105183、2937346640、3793620838、3811798465、3812518176） | 雪/尘埃/樱花等粒子不跟随光标（桌面 WE 会跟手），互动壁纸整类失效 | `wasm/src/particle/mod.rs:237-245`（解析 flags 并注明「本实现忽略鼠标位移」）；`spec_to_emitter.rs:209-215`（直接不生成 attract 算子，测试 `skips_link_mouse_controlpoint_attract`） | **M**：插件已有 `pointer-input` 归一化指针，需把场景坐标下发 wasm 并实现控制点位移 |
| A5 | **`worldspace` 控制点被跳过** | 引擎能力 | **2 张**（3793620838、3812518176） | 世界坐标吸引点（鸟群/雨）不生效 | `wasm/src/particle/spec_to_emitter.rs:204-208`；`wasm/src/particle/sim.rs:922-928` | **M**：同 A4 的输入前提（对象 world 变换传入模拟器） |
| A6 | **`mapsequencearoundcontrolpoint` initializer 完全不解析** | 引擎能力 | **1 张**（3811798465 樱花） | 花瓣生成位置/轨迹与桌面不同（叠加 A3/A4） | 粒子 initializer 名集合：`mod.rs:399-409` 仅 8 种，无 mapsequence；`3811798465` 的 `Cherry_Blossoms_2.json` 实际含该 initializer | **S/M**：本质是按控制点序列铺初值，可复用 A4/A5 的控制点数据 |
| A7 | **`boids` / `remapvalue` 算子未实现** | 引擎能力 | **1 张**（3812518176） | 鸟群聚散、数值重映射失效（该张为复杂新样本） | `wasm/src/particle/mod.rs:413-426` 未列；本机扫描 operator 名发现 `boids:3`、`remapvalue:2`（均在该张） | **M**：boids 需邻域查询（CPU 模拟可做，但 1000 粒子需网格加速） |
| A8 | **粒子 emitter 扩展字段未解析**：`duration` / `speedmin` / `speedmax` / `sign` / `audioprocessingbounds` / `flags` / `instantaneous` | 引擎能力（多数低风险） | **12 张**有任一字段（sign 8 / speedmax 6 / speedmin 2 / duration 2 / audioprocessingbounds 2 / instantaneous 2 / flags 1） | 初速分布、方向符号、音频驱动发射与桌面可能不同；**取值多为 0/缺省，可感知量级未证实** | `mod.rs:469-481`（`EmitterSpec` 只有 rate/directions/distance/origin/is_sphere）；`sim.rs:790-791`（注释明确这些字段依赖 flags/delay 等，当前忽略） | **S/M** + 待真机 A/B 定性 |
| A9 | **粒子自旋轴序 Rz·Ry·Rx ≠ WE 的 Rz·Rx·Ry** | 引擎能力（正确性 bug） | **9 张**多轴自旋（1280029027、1429403119、2011060960、2851992662、2897292240、2911105183、3811798465、3812518176、3828359750；z-only 时逐像素等价） | 多轴自旋粒子的朝向与桌面不同（火球/星芒类可感知） | 本项目：`src/client/threejs-player.ts:394-403` + `:418,443`（同一 `weObjectRotate` 用于对象角度与粒子自旋）；WE：`D:/Steam/steamapps/common/wallpaper_engine/assets/shaders/common_particles.h` 的 `ComputeParticleTangents` = `mul(mul(Rz,Rx),Ry)`；AGENT.md §7.3 | **S**：新增一个按 WE 顺序的粒子旋转函数即可；但需桌面 A/B 验证 |
| A10 | **puppet 对象上的 effects 不挂链** | 引擎能力 | **2 张**（3303428996 的 `lightshafts`、3812518176 的 `waterwaves`，各 1 条链） | `3303428996` 的 lightshafts 光柱**整层缺失**；隔离/效果链对 puppet 直接放弃 | `src/client/three-renderer.ts:923-925`（puppet 不进隔离）、`:977-981`（warn「puppet 对象不支持对象级效果链」）；AGENT.md §7.19 | **L**：需把 SkinnedMesh 渲染进局部 RT 并保持骨架/相机语义 |
| A11 | **`.mdl` puppet 蒙皮动画唯一真实样本解析 failed、蒙皮退化** | 素材边界 / 引擎能力 | **1 张**（3812518176 `models/leon_puppet.mdl`：MDLS 13 骨可解、MDLA failed、顶点蒙皮引用缺骨 → 退化为静态网格） | 角色动画大概率静止/绑定姿态错误 | `src/client/mdl-parser.ts:349-388`（MDLS 双候选）、`:413-475`（MDLA 自洽校验）；AGENT.md §7.40 记录实测 `segments={mdls:'ok',mdla:'failed'}`、`tests/mdl-real-library.test.ts` 只覆盖静态样本 `3303428996` | **L**：需要按真实样本逆向 MDLA 头/轨布局（版权边界内只能按字节事实推）；**待确认**是否必须 1.0 前 |
| A12 | **脚本交互链缺口**：`getLayer(name)` 写入丢弃、`getEffect().visible` 恒 true、`cursorEnter/Leave/Down/Up/Move` 未派发、生产 GUI 点击不可达 | 引擎能力（后一项产品决策） | **2–3 张**（2832263418 点击/悬停/avatar；3797976859 cursorMove；3765967112 点击切帧） | 点击切歌/切日夜/显示角色、鼠标悬停效果均失效 | `src/client/scene-script-vm.ts:669-679`（`keyOf` 只接受 `id:<n>`，`name:`/`new:` 一律 -1 → 写入丢弃）、`:274-276`（getEffect 返回 `visible:true` stub）、`:704-726`（只抓 `cursorClick`）；`src/client/three-renderer.ts:312-314`（canvas click 监听）、`:1240`（注释：生产不可达、按产品决策不转发） | **S/M**（name→id 映射 + 悬停事件 + getEffect 真实绑定）；点击转发属产品决策 |
| A13 | **`engine.registerAudioBuffers` 未实现**（仅按脚本模式代建 visualizer） | 引擎能力 | **3 张直接受影响**（2859263090 雪量随音乐、2980088441 CodeTime 文字音频响应、3797976859 beat 响应）+ 2 张 visualizer 由代建近似（2937346640、3118949804） | 音频驱动的粒子发射/文字/beat 效果静止（不崩溃，返回安全 0） | `src/client/scene-script-vm.ts:339-344`（engine 只有 userProperties/registerAsset/frametime/timeOfDay，未知 API 走 `__any` 代理兜底）；`src/client/script-patterns.ts:19-28`（只识别 visualizer 模式） | **M**：把 analyser 频谱接进脚本 API（audio-input 已有数据） |
| A14 | **`{script}` 值未执行**：`instanceoverride` 的 `{script,value}` 只取静态 value | 引擎能力 | **1 张**（2859263090 的 `rate` 是音频脚本） | 雪量不随音乐变化（恒按作者 value） | `src/client/scene-json.ts:288-315`（`normalizeOverrideValue` 丢弃 script 取 value）；AGENT.md §7.16 | **S/M**（依赖 A13 的频谱 API；属性脚本机制已有） |
| A15 | **`{animation}` 时间线只覆盖 layer 属性**：`general.*` / effect / material 属性动画未实现 | 引擎能力 | **1 张**（3812518176 的 `general.bloomstrength` 关键帧） | 泛光强度不随时间脉动 | `src/client/scene-timeline.ts:25`（`PROPERTY_CHANNELS` 仅 alpha/origin/scale/angles/color）；`src/client/scene-json.ts:470-477`（bloom 静态解析）；AGENT.md §7.16 | **S**（新增 general 轨道并接 bloom stage 的 `setOptions`） |
| A16 | **util 层无 effects 时不渲染** | 引擎能力（本机低影响） | 3 个对象 / 3 张（1429403119 的 compose 2600×1500、2832263418 的 fullscreen 脚本载体、3797976859 的 4×4 cursor compose） | 预计无可见差（compose 无效果时应为直通；另两个是脚本载体/极小层）——**待确认** compose 无 effect 时 WE 是否有合成语义 | `src/client/three-renderer.ts:918-922`（`isAdmittedUtil` 要求 effectChains 非空）、`:969-975`（无链早退）；AGENT.md §7.42⑧ | **S/M**（若确认无效果 util 也要走直通合成） |
| A17 | **image 材质自定义 shader 未执行**（只取 `passes[0].textures[0]` + spritesheet/colorBlendMode 特判） | 引擎能力 | **1 张**（2937346640 的 `workshop/2652493753/tint`，用于 visualizer bar；该张已由代建 bars 近似覆盖） | 自定义着色（tint/alpha/滚动）不生效；本张可感知差**待确认** | `src/client/scene-assets.ts:89-97`（只读材质纹理名）；image 渲染走内建 MeshBasicMaterial | **S/M**（若确需：复用 shader 方言层渲染 image 材质） |
| A18 | **`copybackground` 对象级字段未解析**（仅完成唯一真实消费点） | 引擎能力 / 待确认 | 字段命中 **23 个 scene 条目**；已证实消费点 = 2597392171 godrays（**已修**） | 若 WE 语义为「效果输入改用背景副本」，其余 22 个条目可能有差异；**待真机 A/B 定性** | src 内无 `copybackground` 字符串；`_rt_FullFrameBuffer` 消费已开：`src/client/object-effects.ts:19-25,244-254`；`src/client/three-renderer.ts:1389-1395`（错误注释称门控关闭，实际常量=true）；AGENT.md §7.31 | **S（A/B 定性）**，若需全量实现 **L** |
| A19 | **应用级 Glow 只覆盖 scene 壁纸** | 引擎能力（产品范围） | **7 个条目**（3 video + 4 web）；WE 的 postprocessing 对 video 也生效 | 视频/网页壁纸没有「光晕」观感（scene 有） | `src/client/glow-stage.ts` 只在 `three-renderer.ts:1426-1437` 装配；`src/client/background-layer.ts` 无后处理；AGENT.md §7.30 | **M**（video 可做：给 `<video>` 画进 canvas 后处理；web 跨源不可做） |
| A20 | **Glow 开启 / 段渲染时整帧失去 MSAA** | 引擎能力（画质） | 全部 scene（Glow 默认开） | 边缘锯齿比 `antialias:true` 的直渲明显（几何边、文字） | `src/client/threejs-player.ts:826`（canvas `antialias:true`）；`src/client/glow-stage.ts:126-138`（RT 无 `samples`）；`src/client/frame-capture.ts:32-41`（段目标无 `samples`）；AGENT.md §7.30 | **M**（WebGL2 RT 可设 samples；需处理 resolve 与性能） |
| A21 | **场景渲染无性能/显存量化门槛** | 工程门槛 | 全部 scene | 无法对外承诺 1080p/4K 性能；4K 单壁纸可达数百 MB 显存（README 已提示） | 无 FPS 计时（仅视频壁纸 `video-health` 有采样）；docs/technical-notes.md §4 明确「严格 FPS 验收未做 / 未做显存 cap」 | **S**（测量，不改代码；需参考机） |
| A22 | **web 壁纸用户属性不下发 / 键鼠事件不合成 / 无失败回退** | 引擎能力（产品范围） | **3 张**（3778198228、3789244610、3804412656；3/3 页面都调用 `wallpaperPropertyListener`） | 作者属性面板（雨量/音量/角色开关）在插件内无效 | `src/host/routes.ts:659` 仅注入指针/声音 shim；无 `wallpaperPropertyListener` 注入；`background-layer.ts` 无键鼠合成；AGENT.md §7.32 | **M**（web 侧产品范围，可不进 1.0） |
| A23 | **多文件声音只播一首**（loop 轮播 / random 播完重随机未实现） | 引擎能力（低） | **2 张**（2597392171 14 首 random、3793620838 6 首 loop） | 多 BGM 壁纸只听到一首；随机不重抽 | `src/client/audio-input.ts`（按对象选一首）；AGENT.md §7.42④；README:264 已披露 | **S/M** |
| A24 | **个别效果 pass 仍编译失败**（G2/G3 语义层） | 引擎能力（单素材） | **1 张**（2832263418 的 `chromatic_aberration`） | 该 pass 缺失（色差效果） | `AGENT.md §7.42⑮`；`docs/superpowers/specs/2026-09-21-shader-dialect-compat-design.md`（剩余失败归属 G2 写只读 frag 输入 + G3 隐式窄化） | **L**（需类型推断/数据流分析），建议不做 |
| A25 | **text effects 隔离尺寸装配期冻结 / text 动态 color 不应用** | 引擎能力（已披露） | text effects 9 张；动态 color 1 张（2980088441） | 时钟文本跨分钟变宽可能轻微裁边/拉伸；文字颜色不随音频/脚本变化 | `src/client/three-renderer.ts:1013-1028`（装配期尺寸）；`src/client/threejs-player.ts` 的 `dynamicColorDisabled`；AGENT.md §7.42① 与 §7.44⑤ | **M** |

### A2. 已核实「本机零可见影响 / 不算缺口」（用于避免 1.0 决策误伤）

| 项 | 结论 | 证据 |
|---|---|---|
| `general.hdr` / `bloomhdr*` / `bloomtint` | **未实现**，但本机 `hdr` 字段存在者全为 `false`（少量早期条目无该字段）、bloomhdr 为缺省、bloomtint 全 `1 1 1` ⇒ 0 可见影响 | 全库扫描（本审计）；README:266「hdr 未实现」；`scene-json.ts:470-477` 只读 strength/threshold |
| `general.clearenabled` | 未消费，但本机全为 `true` 且 `clearcolor` 已实现 ⇒ 0 可见影响 | `scene-json.ts:461-469`；README:268 |
| `general.wind*` / `gravity*` / `camerashake*` | 未消费；本机 `windenabled` 全 false、`camerashake` 全 false；`gravitystrength=1` 为 WE 缺省值，是否作用于粒子**待确认**（桌面 A/B 一次即可） | 全库扫描；`scene-json.ts` 无相应解析 |
| `colorBlendMode` 其它模式 | 只实现 6/7/31；本机非零对象 **5 个，全部 6/7/31**（2460786246:31、2832263418:6、3743126786:7、3797976859:7、3811798465:6）⇒ 0 影响 | `threejs-player.ts:558-573`；WE `common_blending.h` 有 1..31 模式表 |
| 跨层 `_rt_imageLayerComposite_*` | 16 个条目引用这些名字，但**全部落在被 `bind` 覆盖的槽**（逐 pass 扫描 rtComposite=0）⇒ 与桌面一致、无实害 | `effect-runner.ts:796` 注释；`object-effects.ts:19-25`；旧审计复核结论一致 |
| 视差传播组 / `disablepropagation` / 缺省 `{1,1}` | 未实现；`disablepropagation` 字段命中 17 个条目但**全为 false**；cameraparallax 启用 **5 个条目**（3118949804、3163840671、3797976859、3812518176 的 amount=0 无位移；唯一有效 3793620838 amount=0.08 且全对象显式 depth、无父子容器）⇒ 0 可见影响（本机） | `parallax.ts:17-26`（只读 4 字段）、`parallaxShift` 每对象自算；AGENT.md §7.39 |
| `mediaTimelineChanged` | 未派发，但本机 0 个脚本监听该事件 ⇒ 0 影响 | 全库脚本扫描；AGENT.md §7.16 |
| puppet 静态族 `3303428996` 的 `.mdl` 无骨骼/动画 | 与素材一致（非缺口） | `tests/mdl-real-library.test.ts:41` 断言 `segments={absent,absent}` |
| text 的 `backgroundcolor` / `opaquebackground` / `limitrows` | 未解析，但本机命中样本 `opaquebackground` 全 `false`、`limitrows` 全 `false` ⇒ 0 可见影响 | 全库 text 对象采样（2980088441/2911105183/1922570576） |
| 视频壁纸声音 / 音量 / 开关 | **已实现（v0.13）**，不是缺口；HEVC 缺解码属环境限制（已回退预览 + 面板提示） | AGENT.md §5.57；README:264,270 |

---

## B. 分档

### P0（1.0.0 前置；建议全部为「小成本 + 防投诉/防误标」项）

1. **A9 粒子自旋轴序修正**（S）：WE 明文 shader 已证实顺序差；改动局部、z-only 零回归，但必须在参考素材上做一次 A/B。
2. **文档-实现口径同步**（S）：`docs/technical-notes.md:78` 的 `_rt_FullFrameBuffer` 未绑定已过时（对象链消费自 2026-10-28 已开）；`three-renderer.ts:1391` 的「门控保持关闭」注释与 `object-effects.ts:25` 常量矛盾；README/AGENT 未列 vortex/link_mouse/puppet effects 三项差异 ⇒ 1.0 的「如实标注」要求这些差异公开（更新 README「使用前请了解」+ AGENT §7）。
3. **A18 copybackground 定性 A/B**（S）：23 个条目命中该字段、实现为 0；至少用 2597392171 + 一张普通 effects 层（如 1429403119）在桌面 WE 下逐像素/人眼对照，判定「是否真的需要全量实现」。若判需要 → 升 P0-L 或明确推迟到 1.x 并写进 README。
4. **A21 性能量化**（S）：参考机（本机 RTX 3060）+ 最重场景（2911105183 / 1429403119 / 2597392171）记录 1080p FPS/渲染提交耗时与显存峰值，写进发布说明；1.0 才能对外说「可用」。
5. **A10/A11 的披露底线**（S，二选一）：puppet effects 与 MDLA 动画要么 1.0 前修（L），要么在 README 明确「puppet 对象不支持 effects / 动画素材解析边界」——不能让 `3303428996`/`3812518176` 的差异悬空。

### P1（1.0.x 可补；用户可感知但影响面或成本可控）

- A4 `link_mouse` 鼠标互动粒子（6 张，M）——插件已有指针通路，性价比高，建议 1.0.x 第一优先。
- A1 子粒子 `children`（14 张，L）——影响面最大，但成本高；若 1.x 有「scene 还原度」目标，应作为 1.x 首项。
- A3 vortex（2 张）+ A6 mapsequence（1 张）+ A5 worldspace（2 张）——可与 A4 同批做（共用控制点/坐标基础设施，打包后成本下降）。
- A12 脚本交互链（`getLayer(name)` 映射 + `getEffect().visible` + hover 事件，S/M）。
- A13/A14 `registerAudioBuffers` + `{script}` instanceoverride（4 张，M）。
- A15 `general.*` 时间线（1 张，S）。
- A17 image 自定义 shader（1 张，待确认）。
- A19 Glow 覆盖 video（M，产品范围）。
- A23 多文件声音轮播/重随机（2 张，S/M）。
- A16 util 无 effects（待确认语义后再决定）。
- A2 ropetrail/rope（5 张，M）——形态错误可接受但会被老玩家一眼看出，可在 1.x 排。

### 不做（1.0 明确记边界）

- A24 效果 shader 语义层类型推断（G2/G3）：单素材 `chromatic_aberration`，成本 L。
- A20 MSAA：影响观感但非功能；可在 1.0.x 视性能余量决定。
- A22 web 壁纸用户属性/键鼠合成/失败回退：跨源与产品范围限制（iframe 无法注入属性监听，需要产品级方案）。
- A25 text 隔离尺寸冻结 / text 动态 color：已在 README 披露，1.x 视反馈再定。
- HDR / bloomhdr / bloomtint / colorBlendMode 其它模式 / 跨层 `_rt_imageLayerComposite_*` / 视差传播组 / `disablepropagation` / 默认 parallaxDepth / `clearenabled` / `mediaTimelineChanged`：本机零可见影响，均记边界（AGENT §7 已有条目）。
- A8 emitter 扩展字段中取值恒为 0/缺省的部分（duration=0、instantaneous=0、speedmin/max=0）：仅保留「已记录、待素材触发」。
- A7 boids/remapvalue：单张复杂新样本，成本 M 且无第二样本验证；1.x 视素材增长再议（若 `3812518176` 是重点展示素材则改 P1）。

---

## C. 与 `docs/2026-10-20-library-feature-gap-audit.md` 的 F1–F21 差异对照（以 v0.13.0 代码为准）

> 旧审计是 v0.8.0（代码基准 `73fe6ab`、库 43 张）快照；下表逐项核对当前代码，**不可直接引用旧结论排期**。

| F# | 旧结论（v0.8.0） | v0.13.0 状态 | 当前证据 / 备注 |
|---|---|---|---|
| F1 粒子子粒子 | 未实现（12 张） | **仍缺**（14 张，+2 新素材） | A1；`sim.rs:785-786`、无 `children` 解析 |
| F2 util 层不渲染 | 未实现（4 张） | **已修（有 effects）**；无 effects 仍不渲染（记边界，本机 3 对象无可见差） | `three-renderer.ts:918-922,969-975`；A16 |
| F3 text effects 不挂链 | 未实现（7 张） | **已修**（9 张样本可执行；边界=装配期尺寸冻结） | AGENT §7.42①；`three-renderer.ts:1013-1028` |
| F4 sound 音量/播放模式/多文件 | 未实现 | **已修**（volume、single/loop/random、每对象一首）；剩余多文件轮播/重随机（2 张） | `scene-json.ts:271-286`；AGENT §7.42④；A23 |
| F5 用户属性只 bool∩visible.user | 未实现（9 张） | **已修**（bool/slider/color/combo、非 visible 绑定、effect visible、instanceoverride、scriptproperties） | `user-bindings.ts:191-347`；AGENT §7.41 |
| F6 `_rt_*` 门控关闭 | 降级（1 张 1 槽） | **大部分已修**：`_rt_FullFrameBuffer` 三类消费点全绑定（对象链 2026-10-28）；跨层 `_rt_imageLayerComposite_*` 仍未实现（0 实害） | `object-effects.ts:19-25,244-254`；A18/A2 表 |
| F7 粒子 starttime | 未实现（25 张） | **已修**（预推进 + 900 步=15 effect-s 上限） | `mod.rs:516`、`sim.rs:827-840`；**不是缺口** |
| F8 壁纸级 bloom | 未实现（3 张） | **已修**（4 张：2454403969/2937346640/3790775478/3812518176 用户属性）；边界=hdr/bloomhdr/bloomtint 未实现（本机 0 影响） | `scene-json.ts:470-477`；`three-renderer.ts:1413-1425` |
| F9 粒子白名单外特性 | 未实现/降级 | **部分已修**：starttime 已修；ropetrail/vortex/link_mouse/worldspace/mapsequence/emitter 字段**仍缺**（且新增 boids/remapvalue） | A1–A9 |
| F10 脚本/交互链 | 未实现/部分 | **部分已修**：thisLayer/localStorage/engine.timeOfDay/scriptproperties/属性脚本/媒体事件已实现；**仍缺** getLayer(name) 写入、getEffect().visible、cursorEnter/Leave/Down/Up/Move、生产点击不可达 | `scene-script-vm.ts:669-679,274-276,704-726`；A12 |
| F11 音频可视化/registerAudioBuffers/系统音频 | 未实现 | **部分已修**：visualizer 代建（simple+pixel-bars）、系统音频捕获已实现；`engine.registerAudioBuffers` 通用 API 未实现（4 张脚本音频响应失效/近似） | `script-patterns.ts:19-28`；A13 |
| F12 text 字段缺口 | 未实现 | **已修**：alpha/brightness/anchor/limitwidth/maxwidth；backgroundcolor/opaquebackground/limitrows 未解析但本机 0 可见影响 | `scene-json.ts:107-119`；A2 表 |
| F13 image 材质语义 | 部分/未实现 | **大部分已修**：spritesheet、color、alignment、colorBlendMode 6/7/31；剩余自定义 image shader 未执行（1 张近似） | `scene-assets.ts:89-97`；A17 |
| F14 `{script}`/`{animation}` | 未实现/降级 | **部分已修**：layer 属性动画（alpha/origin/scale/angles/color）与属性脚本已实现；general/effect/material 时间线、instanceoverride 的 `{script}`、mediaTimelineChanged 未实现 | `scene-timeline.ts:25`；`scene-json.ts:288-315`；A14/A15 |
| F15 clearcolor | 未实现 | **已修**（clearenabled 未消费，本机全 true 无差） | `scene-json.ts:461-469` |
| F16 web 壁纸（属性/音频/交互/回退） | 未实现/部分 | **部分已修**：指针直传、web 声音 shim、承载 origin 方案；仍缺用户属性下发、键鼠合成、失败回退、dpr 重建 | `host/routes.ts:659`；A22 |
| F17 video 恒静音 | 未实现 | **已修**（声音开关/音量/音轨探测，v0.13） | AGENT §5.57；README:264 |
| F18 全局 uniform 注入 | 未实现/部分 | **已修** g_PointerPosition / g_ParallaxPosition；剩余 1 条 shader 编译失败（chromatic_aberration） | `effect-runner.ts:674-689`；A24 |
| F19 puppet effects | 未实现（1 张） | **仍缺**（2 张） | `three-renderer.ts:923-925,977-981`；A10 |
| F20 text `{user}` scriptproperties | 未实现/降级 | **已修**（scriptproperties 深解 + text 脚本注入）；剩余 text 动态 color 不应用（1 张） | `user-bindings.ts:304-340`；A25 |
| F21 instanceoverride 包装 | 未实现（1 张） | **已修**（JS 解包装 + wasm 全字段语义） | `scene-json.ts:288-315`；`mod.rs:199-235` |

**另：旧审计的「25 张 starttime 相位差」「9 张 turbulence 方向」等结论已全部过时**（starttime 已修、turbulence 已在 2026-09-22 修正），不要作为 1.0 待办。

---

## D. 1.0.0 渲染门槛建议（一页）

**建议 1.0 的定位**：**「scene 壁纸核心渲染稳定、可解释、边界诚实」**——即 WE 常见场景（背景层 / 粒子 / 线性与具名 RT 效果链 / 文本时钟 / 音效 / 降级链 / 对象效果链 / 用户属性）在真实库上稳定出图，**不承诺** WE 引擎的全部高级特性（子粒子、绳索、鼠标互动粒子、HDR、跨层 RT 等）。

**建议的四条硬门槛（G1–G4）**：

- **G1 文档-实现一致性（必须）**：README「使用前请了解」逐条与代码一致；已知差异全部公开（至少补：vortex/link_mouse/mapsequence、puppet effects、puppet MDLA、`getLayer(name)`/hover 交互不可用）；修正 `docs/technical-notes.md:78` 的 `_rt_FullFrameBuffer` 过时记录与 `three-renderer.ts:1391` 的矛盾注释。
  - 判据：`grep` 旧结论不再出现；README 每条限制都能指到 `src`/`wasm` 的**未实现点**。
- **G2 真实库回归（必须）**：`tests/verify-real-library.test.ts` 全库解析零失败（已有）+ 至少 **9 张重点素材**的端到端验证结论归档：`3812518176`（puppet/复杂新样本）、`3303428996`（puppet+effects）、`2859263090`/`3811798465`（子粒子/鼠标互动）、`2832263418`（交互/音频条）、`2597392171`（godrays + 子粒子）、`3765967112`（text effects + spritesheet）、`2911105183`（最重效果链）、`1429403119`（最重线性链）。形式可以是 e2e 截图 + 人眼结论（不要求逐像素全库）。
  - 当前已有真机人眼验收（2026-10-23）的项可复用；**新增素材 `3812518176` 需补一次人眼验收**。
- **G3 性能与显存有数字（必须）**：参考机（本机 RTX 3060）在 1080p、默认 Glow 下：
  - 最重场景（2911105183 / 1429403119 / 2597392171）**每帧 render 提交 ≤ 16.7ms（或 FPS ≥ 30）**、**显存峰值记录**；
  - 4K / dpr2 至少记录「可用性 + 是否触发 `qualityScale` 档位」；
  - 报告写进 `TESTING.md` 新小节与发布说明。**只测量、不改代码**。
- **G4 无未披露的「整层缺失」（必须）**：三类整层缺失必须二选一（修 / 公开边界）：puppet effects（A10）、puppet 动画（A11）、util 无 effects（A16 先定性）。子粒子/绳索/鼠标互动等**已披露**的差异不阻塞 1.0，但必须出现在 1.x 路线图。

**建议 1.0 前实际动代码的最小集（P0，约 S+S+S+S）**：
1. 粒子自旋轴序（A9，S）+ 一张多轴自旋素材的桌面 A/B；
2. `copybackground` 定性 A/B（A18，S，结果决定是否推迟到 1.x 并写入 README）；
3. 文档/注释口径同步（G1）；
4. 性能量化（G3，测量）。

**明确留到 1.x**：子粒子（A1）、ropetrail（A2）、vortex/link_mouse/worldspace/mapsequence（A3–A6）、boids/remapvalue（A7）、puppet effects 实现（A10 若选不修则 README 披露）、web 用户属性与交互（A22）、MSAA（A20）、text 尺寸冻结（A25）。

**一句话**：如果 1.0 的承诺是「WE 桌面版的 scene 壁纸主链路可靠还原」，那么当前渲染实现**已经足够**，前提是完成 G1 的口径同步 + G3 的量化 + P0 的四项小成本工作（自旋轴序、copybackground 定性、文档同步、性能量化）；如果 1.0 想宣称「场景特性对齐 WE」，则 A1（子粒子）+ A4（鼠标互动）+ A10（puppet effects）**必须在 1.0 前补齐**，否则 1.0 无法自圆其说。

---

## 附：本审计的关键证据与口径

- 逐条代码证据行号以 HEAD `0056109` 为准；WE 语义基准为本机 **WE 2.8.42** 的明文 `assets/shaders`（`common_particles.h`、`common_blending.h`、`common_composite.h`）。
- 素材统计方法：只读 Node 脚本解包 42 个 `scene.pkg`（PKGV 解包逻辑同 `src/host/pkg-reader.ts`），对 `scene.json` / 粒子 spec JSON / effect JSON / 内联脚本源码做字段与模式扫描；预设 `3163840671` 按依赖 `3118949804` 统计。**扫描脚本未入库**（只读、一次性）。
- 库现状与旧审计不同：50 条目（旧 43）；新增 7 个条目（3118949804、3163840671 preset、3797976859、3809943023、3812518176、3815771488、3828359750），其中 `3812518176` 是当前最复杂的样本（puppet + 8 effects + 7 children + rope/ropetrail + boids/remapvalue + general 动画）。
- 当前库效果链统计：43 个 scene 条目共 **206 条效果引用**（160 线性链 + 46 具名 RT 链），38 种 effect 文件；最重场景 `2911105183`（32 条引用）、`1429403119`（24 条线性）、`3793620838`（18 条）。
