# Agent Note: 视频壁纸声音（壁纸声音开关 + 音轨探测 + 开机动画声音）

Status: implemented

## Problem

视频壁纸的 `<video>` 在背景层代码里被硬编码 `muted = true`（`background-layer.ts` 的 `showVideo`），README 把「视频壁纸暂不播放音频」列为已知边界。用户报告「沉鱼落燕（`3422242110`）没有声音」——该 mp4 实测有 AAC-LC 44.1kHz 立体声音轨，而桌面 Wallpaper Engine 播放同一素材是有声的；所以这是插件侧的能力缺口，不是回归（从 2026-08-17 第一版背景层起就静音）。

调查还发现静音并非平台必需：DSH 桌面壳（Electron 44.7）主进程没有设置 `autoplayPolicy`，`webPreferences.autoplayPolicy` 默认 `no-user-gesture-required`，桌面窗口里非静音自动播放是被允许的；只有浏览器 GUI（Chrome 打开 `http://127.0.0.1:<port>`）才受「需要用户手势」的自动播放策略约束。

## Decision

1. **不复用 `soundEnabled` 之外的第二个开关**（用户拍板）：`soundEnabled` 从「scene 壁纸 sound 对象」扩展为**壁纸声音总开关**，同时控制 scene sound 对象与视频壁纸音轨；面板把「壁纸音效」从「性能与省电」移出，独立成「声音」卡。默认开（与既有 `soundEnabled` 默认一致）。
2. **视频声音策略**：桌面壳（页面协议 `dsh-app:`）直接 `muted=false`；浏览器在无用户激活（`navigator.userActivation.hasBeenActive !== true`）时先静音起播保画面，首次 `pointerdown/keydown` 解锁并续播，失败静默降级；`soundEnabled=false` 或素材无音轨时保持静音。scene 降级链的内嵌视频固定 `silent`（WE 视频纹理本就无声，不随开关出声）。
3. **音轨探测放 host**：扫描到 `type='video'` 的 `project.json.file` 时，用 box 解析定位 mp4 的 `moov`（只读少量字节，不整文件加载），找 `hdlr.handler_type === 'soun'` → `hasAudio`。`false` 的素材不解锁声音，面板提示「当前视频壁纸没有音轨」；`null`（无法判断）按未知处理、照常尝试。
4. **开机动画独立开关** `bootAnimationSoundEnabled`（默认开，用户拍板）：桌面壳直接出声；浏览器冷启动无用户手势，自动播放策略下只能静音，且首次手势会触发「跳过」直接结束动画，因此**不做手势解锁**。
5. **音量（用户验收时追加）**：壁纸声音加 `soundVolume`（0-1，默认 1），scene 音效与视频壁纸共用；scene 侧在 `AudioAnalyzer` 的 analyser 之后接 masterGain（频谱读 pre-master，音量不影响音频条），视频侧写 `<video>.volume`，运行期下发即时生效。开机动画加独立 `bootAnimationVolume`（默认 1）。面板各加一条滑杆，显示百分比。
6. **web 壁纸声音（用户验收时追加）**：宿主无法访问跨源沙箱 iframe 的 DOM，改为 host 在 `/wallpapers/web` 的 HTML 里注入声音 shim（与已有的指针 shim 同一次插入、`shared/web-audio-shim.ts`）；shim 监听 `__wpSound` postMessage，设置页内所有 `<audio>/<video>` 的 `muted/volume`，MutationObserver 覆盖动态创建的媒体；宿主在 web 帧 `load` 后与 `setSoundEnabled/setVolume` 时经 `contentWindow.postMessage` 下发。**边界**：只覆盖 HTML media 元素（Web Audio 自建声源控制不到）；CSP 禁内联脚本时注入被拦，保持网页原状。
7. **开机动画期间抑制壁纸声音（用户验收时追加的 bug）**：开机动画层与壁纸层独立，`mount()` 会同时起播片头并恢复上次壁纸——视频/ web 壁纸出声后，片头期间壁纸声音叠响。修法：`bootPlayer` 新增 `onActiveChange`（只在真正调用 overlay.play 的区间触发 true/false），`index.ts` 维护 `bootActive` 并把它并入「应下发给壁纸层的声音开关」（effective = bootActive ? false : 用户设置），scene/视频/web 三条声音路径都按 effective 下发；片头结束后恢复用户设置（scene 音效按上次规格重播）。
8. **web 声音在片头期间仍响（第二次验收 bug）**：用户重启后仍听到片头期间有壁纸声音——排查发现当前壁纸是 `3778198228`（WoW 登录界面，Web 类型），其页面脚本 `updateAudio()` 会主动把 `sound.muted = false`，而当时 web 声音只靠「帧创建时发一条 + iframe load 后补发」：首条在 shim（`<head>` 内联）执行前发出必丢，load 又要等 66MB `video.webm`，且页面初始化覆盖了 `muted` ⇒ 片头期间持续出声。修法：① shim 监听 `play` 事件（捕获）在每次播放时重新应用宿主开关/音量，兜住页面自己写回；② 宿主在 web 帧创建后 250ms 间隔重发约 5s（`retrySoundPost`），不再依赖 iframe load；③ resize 重建帧同样重发。用真实页面（JSDOM + 注入后的 HTML）验证：页面初始化 `muted=false` → 宿主 `enabled=false` 后 music/sound 均静音 → 页面改回 `muted=false` 并 play 后仍静音 → 宿主 `enabled=true, volume=0.5` 时恢复且音量生效。

## Affected repositories

- `dsh-use-wallpaper` 工作区（未提交）：`background-layer` / `audio-input` / `three-renderer` / `settings-section` / `boot-overlay` / `boot-player` / `boot-settings-section` / `settings` / `styles` / `host/routes` / `host/scanner` / `host/settings` / `shared/web-audio-shim` + `host/mp4-audio-probe`。

## Alternatives considered

**新增独立的「视频壁纸声音」开关（默认关）。** 更保守、不会改变现有用户「视频壁纸安静」的预期。否决：用户明确要求复用现有「壁纸音效」按钮并默认开。

**加视频音量滑杆（首版否决）。** 首版只解决「有没有声音」，音量交给系统。后续用户验收时明确要求可调，改为第 5 条（共用 `soundVolume` + masterGain）；不做每个来源独立音量（scene/视频/开机动画各一条）——控制项过多且用户未要求。

**浏览器端也先尝试非静音自动播放、被拒再回退静音。** 可以少一次手势延迟。否决：Chromium 在 `play()` 被策略拒绝时会 reject 并暂停媒体，回退路径要处理「已开始播 → 被暂停」的状态，复杂度换来的收益（仅限已激活页面）已经被 `userActivation` 判断覆盖。

**开机动画做手势解锁。** 否决：boot overlay 的 `pointerdown/keydown` 被「跳过」占用，手势即结束动画，解锁没有意义。

**扫描时整文件读入再找 `soun`。** 实现最省事。否决：视频壁纸可达几十 MB，扫描是同步路径且每次列表刷新都跑；box 链只需几次 seek。

## Consequences

**收益：** 桌面客户端里带音轨的视频壁纸默认有声（`soundEnabled` 默认开）；浏览器第一次交互后同样有声；关掉开关立即静音且画面继续；壁纸与开机动画音量可独立调节且运行期即时生效；无音轨素材不再让人误以为是插件坏了。

**代价：** 浏览器 GUI 冷启动阶段视频壁纸仍静音（自动播放策略，需一次交互）；桌面端的有声依赖 Electron 默认 `autoplayPolicy`，宿主未来显式改成 `document-user-activation-required` 会退化为「首次交互后才有声」；`hasAudio` 只覆盖 mp4 容器（其它扩展名按未知处理）；开机动画在浏览器里实质仍静音；音量只做全局一条（不按 scene/视频分别调节）。

**面板 UI 附带修复：** 卡片头 hint 之前停在卡片中间——`.wss-details-hint` 和折叠箭头 `::after` 都设了 `margin-left:auto`，flex 会把剩余空间平分给两份 auto margin。改成箭头 `margin-left:0`（hint 独占 auto）后靠右；所有 `wss-details-head` 都有 hint，无需无 hint 分支。
