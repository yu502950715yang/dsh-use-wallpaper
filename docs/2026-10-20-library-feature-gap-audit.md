# 本机 Wallpaper Engine 壁纸功能缺口审计

> 审计日期：2026-10-20 ｜ 插件版本：`@dsh-use/wallpaper-engine` v0.8.0（代码基准 `73fe6ab`）
> 壁纸库：`D:/Steam/steamapps/workshop/content/431960`（43 张：37 scene + 4 web + 2 video，全部只读）
> 判定基准：[`capabilities.md`](../research/audit-2026-10-20/capabilities.md)（160 项能力支持度，逐项带源码 `path:line`）
> **独立复核**：本报告已按对抗性复核 [`verification.md`](../research/audit-2026-10-20/verification.md) 修订（22 项抽查：通过 13 / 有误 7 / 部分有误 1 / 存疑 1）。复核**否决 2 条误报**（2011060960、2132420420 的 `_rt_` mask 槽判断）、**补入 1 条漏报**（2859263090 的 `instanceoverride.colorn`），并对若干结论降级/标注「待真机验证」——详见第七节修订记录。

## TL;DR

- **43 张里 30 张存在「插件还没做/只做了一部分」的功能**；13 张在当前插件版本下可完整还原。
- **高严重度 5 张**：`2911105183` Subway Station、`3790775478` The Duskbloods、`2454403969` 赛博朋克2077（壁纸级 bloom / 全屏后处理层）、`2132420420` 守望先锋 Dva女警（util 合成层脉冲光）、`3804412656` 终末地·佩丽卡（web 属性/音频/键盘交互全不可用）。
- 影响面最大的**功能缺口**（按命中壁纸张数）：粒子**子粒子系统**（12 张）、**sound 音量/播放模式**（5 张 + 多文件叠播 2 张）、**text 对象的 effects**（7 张）、**util 后处理层不渲染**（4 张）、**用户属性扩展**（9 张，含 3 张 web）、**粒子 starttime**（25 张，相位差）、**`_rt_` 运行时 RT 真未绑定**（复核后仅 1 张 1 槽，其余 4 张落在 bind 覆盖槽 → 无害）。
- 大部分 scene 壁纸的**主链路（背景/粒子/线性与具名 RT 效果链/时钟文本/音效/降级链）工作正常**；缺口集中在「后处理层、音频细节、脚本交互、属性系统、粒子高级特性」五类。

---

## 一、方法与口径

1. **全库素材扫描**：解包 43 张壁纸的 `project.json` / `scene.pkg`，提取对象类型、image 材质（shader/blending/combos/textures）、粒子 spec（emitter/initializer/operator/renderer/children/starttime/material）、effects 链（effect.json → material → shader、bind/fbos/textures 覆写、`_rt_*` 引用）、text/script/用户属性/general 字段，生成 `scene-feature-matrix.json`（+ 补充扫描 `scene-extra.json`）。
2. **能力基准**：从当前源码（以代码为准，AGENT.md §7 只作交叉核对）梳理 160 项可判定能力 → `capabilities.md`（已实现 60 / 部分 44 / 未实现 47 / 降级替代 9）。
3. **逐张判定**：scene 37 张分两组逐张回查原始 `scene.pkg` 的 JSON 与 shader，按「WE 语义是否改变画面 → 代码有无消费路径 → 不支持时回退成什么 → 该壁纸是否真的触发」四问判定；web/video 6 张单独分析。证据链 = 素材字段/文件 + 源码 `path:line`。
4. **排除项**（不计入插件缺口）：作者素材自身缺陷、浏览器/环境限制、插件设置项（遮罩/模糊/Ken Burns/画质档位等）、WE 自身也弱的能力。
5. **交叉复核**：`crosscheck.json` 把能力缺口映射到全库素材；独立复核员用逐 pass 扫描 + 抽查把关键结论重新验证一遍（结果见 `verification.md`）。**标「待验」的结论需要真机截图/听感确认**。

逐张详情：
- scene A 组（18 张）→ [`gaps-scene-A.md`](../research/audit-2026-10-20/gaps-scene-A.md)
- scene B 组（19 张）→ [`gaps-scene-B.md`](../research/audit-2026-10-20/gaps-scene-B.md)
- web / video（6 张）→ [`gaps-media.md`](../research/audit-2026-10-20/gaps-media.md)
- 复核订正 → [`verification.md`](../research/audit-2026-10-20/verification.md)

> 说明：上述研究文件保留审计当时原文；**结论以本报告的「已订正版本」为准**（复核否决/降级的条目已在第七节列明）。

---

## 二、43 张壁纸总表

> 结论列：**缺** = 存在插件未实现/部分实现的功能且该壁纸确实触发；**不缺** = 当前版本可完整还原（不含环境性限制与作者缺陷）。

| # | ID | 标题 | 类型 | 结论 | 严重度 | 主要缺口 |
|---|---|---|---|---|---|---|
| 1 | 2911105183 | Subway Station | scene | **缺** | **高** | util 后处理层（projectlayer 上的 bloom+bokeh）整层不渲染；combo 用户属性导致 3 个时钟文本叠加；表针 `{script}` 不执行；text effects/alpha；image color |
| 2 | 3790775478 | The Duskbloods | scene | **缺** | **高** | 壁纸级 `general.bloom`（strength 2.04）未实现，血月亮部无辉光 |
| 3 | 2454403969 | 赛博朋克2077 | scene | **缺** | **高** | 壁纸级 `general.bloom`（0.98）未实现，霓虹亮部无辉光 |
| 4 | 2132420420 | 守望先锋 Dva女警 | scene | **缺** | **高** | util Compose 层（composelayer + pulse）不渲染 → 整屏暖色脉冲光丢失（localcontrast 经复核**正常执行**，不计） |
| 5 | 3804412656 | 终末地·佩丽卡 | web | **缺** | **高** | WE 用户属性/系统音频监听/键盘点击交互均不可用（只剩鼠标视差） |
| 6 | 2597392171 | 克西高达 RX-105 | scene | 缺 | 中 | godrays 的 `_rt_FullFrameBuffer` 槽留空 → COPYBG 背景输入缺失（低·待验）；全屏 blur util 层缺失；子粒子；雾层 `{animation}` 不漂移；14 首音频叠播 |
| 7 | 3765967112 | Crimson Horizon | scene | 缺 | 中 | image 精灵表按整表渲染（3 帧挤在一张 quad）；属性脚本（日夜切换）不执行；4 层 text effects/brightness；ropetrail+子粒子；Text UPDATER 变空串 |
| 8 | 2832263418 | EVA 卡农弦乐四重奏 | scene | 缺 | 中 | 点击/悬停交互链失效（getLayer(name) 写入丢弃、getEffect stub、thisLayer/localStorage 未定义、音频 play/stop 无实现）；audio_rainbow 两层效果编译失败；avatar 常显 |
| 9 | 3793620838 | In the Mountains 21:9 w lofi | scene | 缺 | 中 | 模拟时钟指针 `{script}`（engine.timeOfDay）不执行；6 首 BGM 同时全音量循环；Bird 粒子 emitter audio/duration 字段忽略 |
| 10 | 3789452668 | Knight in a red cloak | scene | 缺 | 中 | 3 层 text effects/brightness；audio 频谱线为 solid util 层（alpha=0，桌面可见性待验）；effect.visible 的 user 不消费 |
| 11 | 3811798465 | 大丽花-月下秋千 | scene | 缺 | 中 | 跟随鼠标的樱花缺 vortex 算子 / mapsequencearoundcontrolpoint / link_mouse 控制点；萤火虫子粒子 |
| 12 | 2460786246 | DVA守望先锋 | scene | 缺 | 中 | 闪电云/余烬子粒子（2 层；第 3 个 Ember 本就 visible:false，不计）；时钟 text vhs 效果与 alpha 不生效 |
| 13 | 2236329190 | Death stranding | scene | 缺 | 中 | 余烬子粒子；sound volume 0.5 被按 1.0 播放 |
| 14 | 3303428996 | 死亡搁浅-玛玛 | scene | 缺 | 中 | 唯一对象是 puppet，其上 lightshafts 效果链不挂链 → 光柱缺失 |
| 15 | 3660373677 | Spider Man 4K | scene | 缺 | 中 | 时钟/星期/日期三层 text 的 blurprecise 效果被静默丢弃 → 文字缺柔光 |
| 16 | 2859263090 | DK WOTLK | scene | 缺 | 中 | 37 个火把/火盆子粒子（火星）缺失；Drops ropetrail 退化；鼠标互动粒子失去吸引；音频驱动雪量不随音乐；**`instanceoverride.colorn` 的 `{user,value}` 包装未解包 → additive 雪层变黑不可见**（复核新增） |
| 17 | 2011060960 | Eva 01 | scene | 缺 | 中 | 余烬子粒子；sound volume 0.31（约 3 倍响）（blur/localcontrast 经复核**正常执行**，不计） |
| 18 | 3743126786 | GTR | scene | 缺 | 中 | 流星 ropetrail 形态错误 + 光晕子粒子缺失（light 对象无材质光照，本张无可见差） |
| 19 | 2937346640 | Lycoris Recoil 锦木千束 | scene | 缺 | 中 | 壁纸级 bloom；Simple Visualizer 脚本未装载（prelude 缺 `createScriptProperties`）→ 64 条音频条完全不绘制；slider 属性面板缺失；效果级 visible:{user} 不消费 |
| 20 | 1922570576 | 魔兽之门 | scene | 缺 | 中 | 魔法漩涡 vortex 算子跳过 + ropetrail 退化 + 子粒子；3D Clock 的 `init()` 阴影层不建；text alpha |
| 21 | 3795587868 | FF7 Revelation Trilogy Art Part 3 | scene | 缺 | 中 | 火焰/余烬全部子粒子缺失；sound volume 0.46（约 2.2 倍响） |
| 22 | 3814332254 | 三角洲骇爪 粉云海 | scene | 缺 | 中 | 3 个时间/日期文本的 blurprecise 效果被丢弃 → 文字缺柔光 |
| 23 | 2980088441 | CodeTime | scene | 缺 | 中 | `general.clearcolor`（#111418）被恒黑清屏替代 → 整屏底色偏黑；`_24hr` 的 `{user}` 绑定不解析（12/24h 可能与桌面不同，待验）；音频响应文字颜色不脉动 |
| 24 | 3780477933 | spider man bnd 2 | scene | 缺 | 中 | 效果 shader 全局 `g_PointerPosition` 未注入 → 点阵「鼠标影响」固定在原点角落 |
| 25 | 1280029027 | Evangelion Eva's | scene | 缺 | 低 | Lightning cloud 的 lightning1b 子粒子缺失 |
| 26 | 3811655063 | 三角洲疾风-光 | scene | 缺 | 低 | VHS 时间文本上的 waterwaves 文本效果被静默丢弃（缺轻微水波） |
| 27 | 3778198228 | WoW Classic Login Screen | web | 缺 | 中 | WE 用户属性不下发（音乐/音效开关与音量无效）；音频开关不受插件控制/受 autoplay 策略影响（`video.webm` 实为 VP9 无音轨，声音来自独立 `music.mp3` + `sound.wav`，复核订正） |
| 28 | 3789244610 | Night City Rain | web | 缺 | 中 | WE 用户属性不下发（雨量/雨滴大小/背景模糊三个滑块无效） |
| 29 | 3422242110 | 沉鱼落燕 | video | 缺 | 中 | 视频壁纸恒静音：H.264+AAC 音轨永不播放 |
| 30 | 3802068825 | yuki恋冢爱 | video | 缺 | 中 | 恒静音；HEVC(H.265) 依赖浏览器解码扩展（Edge 缺解码时回退预览图） |
| 31 | 2897292240 | 死亡搁浅 | scene | 不缺 | — | 雨/雾 effect 与 REFRACT 雨层全部走已实现路径；maxcount 10000 会按需扩容不截断；`perspective:true` 未解析（低·待验） |
| 32 | 3094852179 | 在山的那边 | scene | 不缺 | — | 4 条线性效果（foliagesway/waterflow/waterripple）全部已实现 |
| 33 | 3800645169 | 爱丽丝 一帘山雨 | scene | 不缺 | — | 视频纹理 + waterripple + blur 走已实现路径（视频纹理静音属已登记环境限制） |
| 34 | 2851992662 | 黑神话:悟空 | scene | 不缺 | — | 单图 + 樱花粒子；黑神话特化 scale 已兼容 |
| 35 | 3760200530 | 海绵宝宝章鱼哥 | scene | 不缺 | — | 4 层气泡粒子全在已实现白名单 |
| 36 | 2816905191 | 死亡搁浅 | scene | 不缺 | — | 单图 + text.script 时钟（已实现）+ 单音轨 loop |
| 37 | 1429403119 | Orange | scene | 不缺 | — | 24 条水波/抖动线性效果全部可执行；`copybackground`×19 字段未实现但 effect 链无 `_rt_` 引用（像素差待真机 A/B，复核后不判缺口） |
| 38 | 1968789468 | Fantasy Sky Mantis | scene | 不缺 | — | shake/waterflow/shine 链均可执行；`_rt_imageLayerComposite_13_b` 落在被 bind 覆盖的槽 ⇒ 与桌面一致 |
| 39 | 3281450801 | Wet green leaves | scene | 不缺 | — | foliagesway + 雨透视粒子 + 音效（音量 1）正常 |
| 40 | 2683211654 | EVA | scene | 不缺 | — | waterwaves + 雾粒子正常 |
| 41 | 3392903359 | 生化危机 | scene | 不缺 | — | 仅雪粒子 starttime/emitter sign 两处低危，无可见缺口 |
| 42 | 2212665284 | 最后的生还者 | scene | 不缺 | — | 单图层无效果；copybackground 单层（无 `_rt_` 引用，待真机） |
| 43 | 1184182304 | EVA初号机暴走-5 | web | 不缺 | — | jQuery 视差；鼠标跟随由插件指针直传已支持（本机回环 GUI 下完整） |

**统计**：缺功能 30 张（scene 25 / web 3 / video 2），不缺 13 张；高 5 / 中 23 / 低 2 / 其余不缺。逐张登记的缺口条目约 85 条（含低危与待验项；复核后净变化：删 2 条误报、补 1 条漏报、多处降级）。

---

## 三、按功能的「还没做」清单（按影响面排序）

### 3.1 影响面最大的缺口

| # | 未实现/部分实现的功能 | 状态 | 命中壁纸 | 画面/交互后果 | 源码证据 |
|---|---|---|---|---|---|
| F1 | **粒子子粒子系统**（`children`：eventspawn / eventfollow / death） | 未实现 | 12 张：1280029027、1922570576、2011060960、2236329190、2460786246、2597392171、2859263090、3660373677、3743126786、3765967112、3795587868、3811798465 | 火焰缺火星/余烬、雷电缺二次放电、流星缺光晕、雪暴缺雾层、萤火虫缺闪烁 | `wasm/src/particle/sim.rs:785-786` |
| F2 | **util 合成/全屏/项目层不渲染**（`models/util/*`：composelayer / fullscreenlayer / projectlayer / solidlayer），其 effects 永不挂链 | 未实现 | 4 张：2911105183（高）、2132420420（高）、2597392171、3789452668（待验） | 全屏 bloom/bokeh 后处理、整屏脉冲光、全屏 blur、音频频谱线整层缺失 | `src/client/scene-json.ts:230-236`、`src/client/three-renderer.ts:870-882` |
| F3 | **text 对象的 effects 不挂链**（连汇总 warn 都没有） | 未实现 | 7 张：2460786246、2911105183、3660373677、3765967112、3789452668、3811655063、3814332254 | 时钟/日期文字缺 blurprecise 柔光、vhs 质感、水波扰动 | `src/client/object-range.ts:88-97` |
| F4 | **sound 对象语义**：`volume` 不消费、`playbackmode` 恒 loop、一个对象多文件时**全部同时**播放 | 未实现/部分 | 5 张：2011060960(0.31)、2236329190(0.5)、2597392171(0.55,random,14 轨)、3793620838(0.41,6 轨)、3795587868(0.46) | 背景音乐偏响 2–3 倍；多首 BGM 叠播（桌面只播一首） | `src/client/scene-json.ts:145-161`、`src/client/audio-input.ts:93-102` |
| F5 | **用户属性系统只支持 bool ∩ visible.user**：slider/color/combo/text 不支持；`visible.user` 的 `{name,condition}` 形态不识别；非 visible 字段的 `{user}` 绑定不消费；effect 级 `visible:{user}` 不消费 | 未实现 | 9 张：2832263418(color)、2859263090(instanceoverride)、2911105183(combo+color+effect visible)、2937346640(slider+effect visible)、2980088441(text scriptproperties)、3811655063(text scriptproperties) + web 3 张（slider 等） | 面板缺滑杆/选色/多选；2911105183 三个时钟状态叠加显示；CodeTime 12/24h 可能与桌面不同；效果开关无效 | `src/host/user-props.ts:24`、`src/client/visibility.ts:24-43`、`src/client/three-renderer.ts:160-163` |
| F6 | **`_rt_*` 运行时纹理**：`_rt_FullFrameBuffer` 的**效果链**消费门控关闭（`ENABLE_CHAIN_FRAME_SNAPSHOT_CONSUMER=false`） | 降级替代（低·待验） | **复核后仅 1 张 1 槽真未绑定**：2597392171（godrays COPYBG 的背景输入）；其余 4 张（1922570576、1968789468、2011060960、2132420420）的 `_rt_imageLayerComposite_*` 均落在被 bind 覆盖的槽 ⇒ 无害、与桌面一致 | godrays 只在 albedo.a<1 的像素/边缘有差异（不是光柱整层消失） | `src/client/effect-runner.ts:742-761`、`src/client/object-effects.ts:23` |
| F7 | **粒子 starttime 不解析**（全部从 0 起播） | 未实现 | 25 张有粒子且 starttime≠0 的壁纸 | 起播相位/数量与桌面不同；雨雪雾类不明显，闪光/流星/余烬类可感知 | `wasm/src/particle/mod.rs:387-515` |
| F8 | **壁纸级 `general.bloom*`**（及 hdr） | 未实现 | 3 张：2454403969（高）、3790775478（高）、2937346640（中） | 整幅亮部无辉光，画面发干（插件应用级 Glow 不能等同作者 bloom 的强度/阈值） | `src/client/scene-json.ts:300-320` |
| F9 | **粒子白名单外特性静默忽略**：`ropetrail` 按 sprite 画、`vortex` 算子跳过、`link_mouse`/`worldspace` 控制点跳过、`mapsequencearoundcontrolpoint` 忽略、emitter 的 `duration/speedmin/speedmax/sign/audio` 字段忽略 | 未实现/降级 | ropetrail 4 张（1922570576、2859263090、3743126786、3765967112）、vortex 2 张（1922570576、3811798465）、link_mouse 2 张（2859263090、3811798465）、mapsequence 1 张（3811798465） | 绳状拖尾退化成贴片、魔法漩涡无旋转、鼠标互动粒子不跟手、初速度分布不同 | `wasm/src/particle/mod.rs:397-479`、`src/client/threejs-player.ts:141-160` |
| F10 | **脚本/交互链缺口**：`getLayer(name)` 写入丢弃、`getEffect().visible` 恒 true、prelude 缺 `thisLayer/localStorage/engine.timeOfDay`（缺全局直接抛错停用整个脚本）、`{script,user}` 同键时脚本不装载、`visible.script` 的 `update(value)` 入参恒 `''` 且只认布尔返回、鼠标 hover 回调（cursorEnter/Leave/Down/Up）不派发 | 未实现/部分 | 2832263418（点击切歌/头像/NERV 交互全失效，avatar 常显）、3765967112（日夜切换不执行）、2911105183/3793620838（表针冻结） | 点击/悬停交互全部无效；应隐藏图层常显；时钟指针静止 | `src/client/scene-script-vm.ts:102-138,163-197,412-423,486-498`、`src/client/scene-script-host.ts:81-88` |
| F11 | **audio visualizer / `engine.registerAudioBuffers`** 未实现；visualizer 识别是死代码；`supportsaudioprocessing`（系统音频）未接 | 未实现 | 2937346640（64 条频谱条完全不绘制）、2980088441（颜色不随音频）、2859263090（雪量不随音乐）、2832263418（Simple_Audio_Bars 编译失败） | 音频可视化层缺失/不随音乐动 | `src/client/scene-script-vm.ts:38-202`、`src/client/script-patterns.ts:17-21` |
| F12 | **text 字段缺口**：`alpha`/`brightness`/`backgroundcolor`/`opaquebackground`/`anchor`/`limitwidth/maxwidth/limitrows` 等未解析；text.script 的 `init()` 不执行 | 未实现 | 2911105183、3765967112、3789452668、2460786246、1922570576（3D Clock 阴影层）、3814332254 等 | 文字过亮/过暗、透明度不对、背景框/换行/定位差异、3D 时钟变平面 | `src/client/scene-json.ts:264-295` |
| F13 | **image 材质语义**（只消费 textures[0]：shader/blending/cullmode/combos 不读）与 **image 级渲染特性**：精灵表整表 UV、image color 不应用、alignment 不应用 | 部分/未实现 | 4 张：3765967112（精灵表 3 帧整表渲染）、2911105183/2832263418（image color 偏色）、2937346640（alignment bottomright） | 日夜图标显示成整张竖排帧表；广告牌/彩虹层颜色错误；图层偏半个对象尺寸 | `src/client/scene-assets.ts:80-86`、`src/client/threejs-player.ts:1335,2202-2247,2320` |
| F14 | **`{script}`/`{animation}` 属性与轨道绑定**：只取静态 `value` | 未实现/降级 | `{script}`：2911105183、3793620838、3765967112、2832263418；`{animation}`：2597392171（34 帧轨道 0/17/34，雾层不漂移） | 表针冻结、日夜图标不变帧、雾层不漂移 | `src/client/scene-json.ts:6-19` |
| F15 | **`general.clearcolor` 解析但无消费**（清屏恒黑） | 未实现 | 2832263418（深棕）、2980088441（#111418，整屏底色） | 纯文本场景整屏底色偏黑 | `src/client/scene-json.ts:300,315` |
| F16 | **web 壁纸**：WE 用户属性不下发（M1）、系统音频监听不下发（M2）、点击/滚轮/键盘不合成（M3）、音频开关不受控（M4）、失败无回退（M7）、dpr 变化不重建（M8）、opaque origin 下 WebGL 白屏（M9）、暂停联动不可控（M10） | 未实现/部分 | 3778198228、3789244610、3804412656 | 作者属性面板/滑块/快捷键全部无效、音乐开关无效、失败空白 | `src/client/background-layer.ts`、`src/host/routes.ts` |
| F17 | **video 壁纸恒静音**（`video.muted=true`）；无音量/播放模式 | 未实现 | 3422242110、3802068825 | AAC 音轨永不播放 | `src/client/background-layer.ts:334` |
| F18 | **效果 shader 全局 uniform 注入不全**：`g_PointerPosition` 未注入（`g_ParallaxPosition` 也未）；部分效果链 shader 仍编译失败（chromatic_aberration、Simple_Audio_Bars） | 未实现/部分 | 3780477933（鼠标影响固定角落）、2832263418、2911105183（音频条/色差缺失） | 鼠标交互效果不跟光标；对应效果整条失效 | `src/client/shader/uniform-binder.ts:45-59` |
| F19 | **puppet 对象上的 effects 不挂链** | 未实现 | 3303428996 | 光柱效果缺失 | `src/client/three-renderer.ts:714-719` |
| F20 | **text.script 的 `{user}` scriptproperties 不解析**（非 visible 绑定）；音频响应颜色取静态值 | 未实现/降级 | 2980088441、2937346640、3811655063 | 12/24h/语言等属性不生效；文字颜色不随音频脉动 | `src/client/script-patterns.ts:40-49`、`src/client/scene-json.ts:107-122` |
| F21 | **`instanceoverride` 的 `{user,value}`/`{script,value}` 包装未解包**（复核新增漏报） | 未实现 | 2859263090（`colorn={user:null,value:"1 1 1"}`；`rate` 恰好默认值无差） | JS 原样透传到 wasm，`colorn` 被 `vec3()` 当对象解析 → [0,0,0] → **additive 雪层变黑不可见** | `src/client/scene-json.ts:163-174`、`wasm/src/particle/mod.rs:203-235,323-343` |

### 3.2 已核实「本机库无实际影响」的项（避免误判）

- **`_rt_imageLayerComposite_*` 4 张**（1922570576、1968789468、2011060960、2132420420）：经逐 pass 扫描，引用都落在**被 `bind` 覆盖的槽**（bind 优先级最高）→ 不拦截、不告警、与桌面一致。**唯一真未绑定 = 2597392171 的 `_rt_FullFrameBuffer`**（已列 F6，低·待验）。
- **image 材质 blending**：本机全部为 `translucent`；combos 绝大多数是 `version/VERSION=2`（格式版本，无视觉含义）；`REFLECTION=0` 当前行为即不反射 → 无差。
- **image/particle `alignment`**：除 2937346640 的 1 个 `bottomright` 外全为缺省/center → 无差。
- **`light` 对象**：仅 3743126786 有 1 个，但该壁纸材质未启用光照 → 无可见差（对象仍不渲染）。
- **`general.camera`**：37 张全为正交默认相机（isOrtho 全 true），插件固定正交 cover 等价 → 无差。
- **`general.hdr` / `camerashake` / `transparentsorting` / `wind` / `gravity` / `fog*`**：本机库未命中。
- **粒子 REFRACT**：仅 2897292240 真实启用（combo=1）且已实现；其余材质 `REFRACT:0` 不触发。
- **粒子 maxcount > 2048**：2897292240 的 10000 会按需扩容，不截断（2048 只是初始预分配钳制）。
- **`copybackground`**（21 张命中）：字段语义确实未实现（AGENT.md §7.31），但 37 张 scene 的 effect 链中只有 2597392171 显式引用背景 RT；其余素材无 `_rt_` 引用可证 → **当前未发现可见后果，需真机 A/B（不作为缺口计数）**。
- **稀疏事件源粒子**（3660373677 的 26 个 spark：children + maxcount=1 + rate<1）：整层跳过与桌面观测一致，属正确降级。
- **puppet 静态族**（3303428996）：本机唯一 `.mdl` 无骨骼/动画段 → 无动画可播，与素材一致。
- **2460786246 的第 3 个 Ember**：`visible:false`，装载期本就不渲染 → 不计缺口（有效子粒子缺口 2 层）。

---

## 四、推荐修复优先级

| 优先级 | 缺口 | 理由 |
|---|---|---|
| **P0** | F2 util 后处理层、F8 壁纸级 bloom、F3 text effects、F1 子粒子、F4 sound 音量/多文件、F5 用户属性扩展、F16/F17 web/video 音频与属性 | 可见/可听差异明显，且覆盖多张壁纸；F2+F8 直接决定 5 张「高」壁纸的观感 |
| **P1** | F11 音频可视化/registerAudioBuffers、F10 脚本交互链、F13 精灵表 image、F15 clearcolor、F12 text 字段、F21 instanceoverride 解包 | 局部可见；F10 影响「点击类」壁纸的核心交互 |
| **P2** | F6 `_rt_FullFrameBuffer` 1 张（低·待验）、F9 粒子高级特性（ropetrail/vortex/link_mouse/emitter 字段）、F14 `{script}`/`{animation}`、F7 starttime、F18 g_PointerPosition、F20 属性绑定细分 | 单一效果或相位级差异，需真机对照确认量级 |
| **P3** | 环境边界（HEVC 解码、opaque origin、dpr 重建、抓帧 readPixels） | 属浏览器/部署环境限制，已在面板提示/降级链中处理 |

---

## 五、作者素材缺陷与环境限制（不计入插件缺口）

**作者素材**（只报告，不修；壁纸目录只读）：
- 3778198228：`<video>` 写死 `object-fit:cover`，窗口宽于 16:9 时裁掉约 15%。
- 3789244610：`city.jpg` 404、空 `<nav>` 让脚本抛 TypeError、文档溢出（AGENT.md §7.35）。
- 2911105183 / 3765967112 / 2460786246：`scene.json` 引用的字体（summer85.ttf / Atami-Regular.otf）不在 pkg 内 → 回退 sans-serif（桌面同样取不到）。

**环境限制**（非插件能力问题）：
- HEVC/H.265 视频能否播放取决于浏览器/系统解码扩展（3802068825 在 Edge 缺解码时回退预览图并提示）。
- 局域网 IP / 隧道访问 GUI 时 web 壁纸退回 opaque origin：WebGL 贴图类 web 壁纸（3789244610、3804412656）会白屏（AGENT.md §7.33）。
- 无 GPU / 上下文丢失时首帧抓帧（readPixels）失败，只影响降级链缓存，不影响渲染。
- 浏览器 autoplay 策略可能拦截 web 壁纸音频（插件已注入 `allow="autoplay"`，但仍取决于浏览器）。
- 2897292240 两层 10000 粒子在 CPU 模拟 + 实例扩容下的帧率需要真机验证（正确性无缺口）。

---

## 六、附：证据文件

| 文件 | 内容 |
|---|---|
| `research/audit-2026-10-20/capabilities.md` | 160 项能力支持度基准（源码 path:line） |
| `research/audit-2026-10-20/gaps-scene-A.md` / `gaps-scene-B.md` | 37 张 scene 逐张缺口详情（素材字段 + 源码证据 + 待验） |
| `research/audit-2026-10-20/gaps-media.md` | 4 web + 2 video 缺口详情 |
| `research/audit-2026-10-20/scene-feature-matrix.json` | 43 张全库特性矩阵（含 featureIndex 反向索引） |
| `research/audit-2026-10-20/scene-extra.json` | 补充字段扫描（camera/general/text/sound/light/effects 覆写/粒子 children-starttime） |
| `research/audit-2026-10-20/crosscheck.json` | 能力缺口 → 全库素材命中映射（交叉核对） |
| `research/audit-2026-10-20/verification.md` | 独立复核结论（对抗性验证，22 项） |

> 说明：`research/` 在 `.gitignore` 内（本机研究产物，不入库）。本报告位于 `docs/`，供用户查阅与后续修复排期。

---

## 七、修订记录（独立复核后）

复核见 [`verification.md`](../research/audit-2026-10-20/verification.md)：22 项抽查 = 通过 13 / 有误 7 / 部分有误 1 / 存疑 1。本报告对应的修订：

| # | 原结论 | 复核结果 | 本报告处理 |
|---|---|---|---|
| 1 | 2011060960：blur/localcontrast 的 mask 槽引用 `_rt_imageLayerComposite_634_a` → 效果失效 | **误报**：`_rt_` 在 textures[2] 且被 bind index2=previous 覆盖，mask 槽是真实 `blur_combine_mask` | 已删除该缺口（该张缺口 3→2 条，严重度仍中） |
| 2 | 2132420420：localcontrast 的 mask 槽留空 → 效果失效 | **误报**：同上（mask = `util/white`，白=全强度） | 已删除该缺口（缺口 2→1 条，severity 高不变） |
| 3 | `_rt_` 槽留空影响 5 张 | **4 张落在 bind 覆盖槽 → 无害**；全库唯一真未绑定 = 2597392171 `_rt_FullFrameBuffer` | F6 改为 1 张 1 槽、降为「降级替代/低·待验」；影响描述改为「COPYBG 背景输入缺失」 |
| 4 | 2859263090 只记「雪量不随音乐」 | **漏报**：`instanceoverride.colorn={user:null,value}` 未解包 → wasm `vec3(对象)=[0,0,0]` → additive 雪层整层不可见 | 新增 F21 并补入总表第 16 行 |
| 5 | 1429403119 等 copybackground「无可见后果」 | **依据不足**：19 个中 18 个是分层对象，WE 语义为把背景副本纳入该层效果输入 | 统一改为「字段未实现；effect 链无 `_rt_` 引用；像素差待真机 A/B」，不判缺口 |
| 6 | 2911105183 引 WE 编辑器文案（ui_en-us.json:1311-1312）证明 projectlayer | 该文案实为 **fullscreen layer** 说明；projectlayer 证据应引本机 WE 资产 `projectlayer:true` | 结论保留（高），语义标注「待真机对照」 |
| 7 | 2597392171 godrays「光柱消失/整层错色」 | **过度推断**：albedo 槽由 previous 正确绑定，缺的只是 COPYBG 背景项 → 只在 albedo.a<1 像素/边缘有差异 | 降为「低·待验」，影响描述改写 |
| 8 | 2937346640 visualizer 脚本「NaN 写回 thisLayer，原单条可能消失」 | **机制不成立**：脚本顶层 `createScriptProperties()` 在 prelude 中不存在 → eval 失败即跳过；init 内 `thisLayer` 也未定义 | 改为「脚本未装载 → 64 条不建、原 bar 静态可见」，结论不变 |
| 9 | 3778198228 证据「video.webm（含音轨）」 | **事实错误**：VP9 无音轨；声音来自独立 `music.mp3` + `sound.wav` | 已订正证据（结论不变） |
| 10 | 小数字：3793620838 starttime（Bird=0/Smoke=1/light_shafts_0=10）、2597392171「17 帧」（实为 34 帧轨道 0/17/34）、2460786246「3 层子粒子」（实为 2 层有效） | 已订正 | 见总表 #12/#9 与 F14 |
| 11 | capabilities 数字口径：util effects 实为 10 条/8 对象、none effects = 0（原写 16 张库的 util 10 + none 11） | 已订正 | 见复核 §C1，不影响本报告结论 |
| 12 | 296… 无 | 复核确认 **43/43 全部有判定**、高危 4 张主体成立、能力基准无「声称未实现但实际有消费路径」的误报 | 保留 |
