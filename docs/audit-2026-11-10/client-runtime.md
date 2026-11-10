# 客户端运行时审查

> 范围：`src/client/` 的生命周期 / 资源 / 竞态（重点：`index.ts`、`wallpaper-controller.ts`、`background-layer.ts`、`rotation.ts`、`library-view.ts`、`local-store.ts`、三个 health、`media-input.ts`、`media-orchestration.ts`、`system-audio.ts`、`audio-input.ts`、`boot-player.ts`、`boot-overlay.ts`、`setup-tip.tsx`、`settings-shell.tsx`、`pointer-input.ts`、`pointer-post.ts`；为核对资源链，只读追踪了 `three-renderer.ts` / `scene-script-vm.ts` / `shared/pointer-shim.ts` 的对应调用点）。
> 方法：只读 grep 全量清单 + 逐行 + 交叉核对清理点；**未**跑 build / test / e2e。基线 = 当前工作树。
> 已排除 `AGENT.md` §5.43（HMR 幂等）、§5.48（web 指针 shim）、§5.50/§5.51（列表缓存 / 排序 / 不分页）、§5.52（音频暂停）、§7.38（看护边界）、§7.44（媒体集成边界）已记录的边界，只报新发现、与文档宣称矛盾或比文档更严重的问题。

## 摘要

| 级别 | 数量 | 一句话 |
|---|---|---|
| P0 | 1 | 并发 `select()` 触发的重叠 `render()` 无代际守卫，渲染器单例状态被后完成的旧装配覆盖（暂停/画质/声音作用到不可见 player + 泄漏整份帧循环与 GL 资源） |
| P1 | 3 | web iframe resize 重建泄漏 `pointermove` 监听；`localStorage` **取值器**抛错未兜（面板渲染 / 装配期硬失败）；系统音频「授权中点停止」竞态导致采集残留 |
| P2 | 17 | 见下（启动恢复未 catch、探活永久缓存 null、recent 被未上屏选择污染、面板 1s 全量重渲染、脚本 localStorage 无上限、shim 注入锚点过窄、`teardown`/`mount` 契约自相矛盾等） |

## 六项必检逐项结论（速览）

| 检查项 | 结论 |
|---|---|
| 1. 资源清理 | **基本完备但有两处真漏**：web 帧 resize 重建时旧 `pointermove` 监听永不摘除（P1-1）；`AudioContext` 手势监听在「未发生手势即收尾」时残留（P2-6）。其余监听/定时器/上下文均有明确清理点，见「资源清理清单核对」。HMR 重挂载幂等（单层、单定时器、单渲染器）成立（§5.43 核对通过），**但 `render()` 这个「起循环/开上下文」的入口没有幂等/串行**（P0-1）。 |
| 2. 异步竞态 | **controller 的 gen 守卫只保护「上屏」，不保护渲染器内部**（P0-1 根因）；系统音频授权等待期没有代号（P1-3）；recent 在「已被取代的 select」上仍写（P2-3）；媒体轮询的请求不可取消（P2-14）。其余迟到响应（测光、视频失败、iframe 预载、封面 rev、属性拉取）都有代号/归属校验。 |
| 3. 错误处理 | `fetch` 缺 `.ok` 3 处（P2-2）；`JSON.parse` 均有 try/catch；**`localStorage` 的 6 处读取入口缺 try/catch**（P1-2，与 `render-health.ts:50-52` 的正确写法不一致）；`AudioContext` 创建失败、`getDisplayMedia` 取消、`clipboard` 拒绝、`canvas.getContext` 为 null 均已降级处理。 |
| 4. 内存泄漏 | 主要问题是 P0-1 的整份渲染器泄漏与 P1-1 的监听/iframe 泄漏；缓存类集合均有上限（`recent` 200、`frameInFlight` 自清、`failed`/`retried` 按壁纸数）；未发现 frame 快照跨帧持有；**脚本 localStorage 无任何上限**（P2-10）。 |
| 5. 隐私 / 安全 | `postMessage` 恒 `'*'`（P2-5，payload 只有指针/音量，风险低）；客户端无 `innerHTML`/`document.write`（grep 0 命中），壁纸标题走 React 文本；诊断信息只输出布尔路径与壁纸 title，**未见磁盘路径泄漏**；shim 注入点锚点过窄且 fallback 会把 `<script>` 放到 `<!doctype>` 之前（P2-11，本机 4 个 web 壁纸均未触发）。 |
| 6. 用户可见健壮性 | 空列表 / 单元素 / 池 <2 都有明示；大库（数千张）无虚拟滚动是 §5.51 的既定取舍，但**面板每秒整表 reconcile** 未在文档中计入代价（P2-7）；localStorage 配额满时写入静默失败且面板谎报成功（P2-16）；**空库 + 开轮播时每次设置变更都重拉列表**（P2-15，重试风暴）；面板 1s 轮询在卸载后正常停止（核对通过）。 |

## P0（用户可感知的崩溃/卡死/状态错乱/泄漏）

### P0-1 重叠 `render()` 覆盖渲染器单例状态：暂停/画质/声音作用到不可见播放器，且整份帧循环 + GL 资源永不释放

- 证据：
  - `src/client/wallpaper-controller.ts:158-161`：每次 `select()` 先 `sceneRenderer.dispose()`（= `teardown()`），再 `await sceneRenderer.render(...)`；**没有串行化/排队**，第二次 `select` 会在第一次 `render` 未完成时再发一次 `render`。
  - `src/client/three-renderer.ts:574`：`render()` 入口的 `teardown()` 只能清「已经赋值到单例变量」的上一份状态，**清不到另一次在飞的 render**。
  - 单例赋值点全部没有代号比较：`currentTextures`（`:650`）、`current = result`（`:1104`）、`currentGlow`（`:1433`）、`window.addEventListener('resize', onWindowResize)`（`:1461`）、`currentHealthId`（`:567`）、`currentAudio`（`:411`）；`currentStage` / `currentScriptHost` / `currentMedia` / `currentTimeline` 同理。
  - 代码里唯一的「重叠」认知是 `three-renderer.ts:364-367` 的注释（只把**计时**局部化），但 `currentHealthId = id` 仍是实例级，与注释「id 按本次 render 的作用域传入」相反（次生问题见 P2-13）。
- 触发（现实路径，不需要调试 API）：
  1. 设置面板快速连点两张壁纸（装配 0.1–2s，双点必重叠）；或
  2. 轮播 `tick` 正在装配时用户手动选另一张（`rotation` 的 `select` 与面板 `select` 共用 controller）；或
  3. 「重试实时渲染」/软失败自动重试（`index.ts:107-112`、`:135-142`）与切换交叉。
- 影响（用户可感知）：
  - **控制作用到错误对象**：后完成的旧装配把 `current` 改成它自己的 player，而 controller 因 gen 不匹配不会把它上屏 ⇒ 屏幕上是新壁纸，但 `setPaused` / `setQualityScale` / `setGlow` / `setSoundEnabled` / `setSoundVolume` 全部作用在**不可见**的 player 上。真机表现：切两张后再点「暂停壁纸」，可见壁纸继续动；拖光晕/画质无效。
  - **泄漏**：被覆盖的那份 player 已由 `loadSceneToThree` 启动 `renderer.setAnimationLoop`（`threejs-player.ts:1280-1295`），`current` 已指向别人 ⇒ 再也不会有人 `player.dispose()`（唯一的 `setAnimationLoop(null)` 在 `threejs-player.ts:2903-2907`）。它继续每帧渲染进一个已从 DOM 摘掉的 canvas，持有整场景几何/材质/RT/纹理。每发生一次竞态泄漏一份；显存与 GPU 时间持续消耗，直到刷新页面。
  - **纹理泄漏**：`currentTextures`（`:650`）同样被后完成者覆盖，先完成那份的纹理集合不会再被 `teardown` 遍历 dispose。
  - **`window.resize` 监听叠加**：`onWindowResize` 变量只记最后一次，重叠装配会注册两条监听（`:1461`），被覆盖那条永远不摘，且闭包持有旧 canvas/`fg`。
  - **音效可能叠响且面板停不掉**：`startAudio` 先 `currentAudio = audio`（`:411`），旧装配在被 `currentAudio` 覆盖前已起的 `playWallpaperSound` 句柄只挂在它自己的 `audio.handles` 上；`stopAudio`（`:392-402`）只停 `currentAudio` ⇒ 若旧装配的音频在 B 的 `teardown` 之后才起播，它会一直循环，`soundEnabled=false` 也停不掉（只能刷新页面）。时序窗口 = 旧装配从入口到 `startAudio` 的整段（大部分装配时间）；另受 `playWallpaperSound` 句柄迟到检查（`:422-432`）部分缓解，是否真的漏取决于两次 await 的先后 ⇒ **待确认实际发生率，但代码无任何防线**。
  - 次生：旧 `fg` 的 `webglcontextlost` 监听被 B 的 `teardown` 摘掉（`contextLostCanvas` 被覆盖），该 canvas 丢失不会再触发回退；`pointer.dispose()/install()` 顺序被两次 render 交叉，最终可能停在「已 dispose 但有 player 在跑」⇒ 视差静默失效。
- 修复建议（择一，建议都做）：
  1. renderer 内加 `renderSeq`：入口 `const seq = ++renderSeq`；每个 `await` 之后 `if (seq !== renderSeq) { 释放本次已建资源; return false; }`；出口赋值 `current` 前再比一次，不一致就把刚建的 `result.player` / stage / glow / textures / scriptHost / media 全部 dispose 后返回 `false`。
  2. controller 串行化：`select` 内用一条 promise 链（`prev = prev.then(...)`）或在 `render` 入口排队，天然消除重叠。
  3. 至少给 `currentTextures/current/currentStage/currentGlow/currentAudio/currentHealthId` 的写入统一挂「代号」并在 `teardown` 里按代号释放。

## P1（真实缺陷，应修）

### P1-1 web 帧 resize 重建时 `pointermove` 监听泄漏（每个旧 iframe 永久留在 window 上）

- 证据：`src/client/background-layer.ts:212-226` 的 `attachPointerPost()` **只做 `addEventListener`**，`pointerPostToken += 1` 后直接覆盖 `pointerPostFn = onMove`；`detachPointerPost()`（`:204-209`）只能移除**当前**那个 `pointerPostFn`。resize 重建的成功分支（`:429-445` 的 `settle(true)`，`:439` 调 `attachPointerPost(frame)`）**前面没有 `detachPointerPost()`**。相比之下 `showWeb` 路径因为先走 `stopWebResizeReload()`（内部 `detachPointerPost`）所以不漏。
- 触发：web 壁纸显示期间拖动/改变窗口尺寸 → 每次「尺寸稳定 300ms 后重建」（`WEB_RESIZE_RELOAD_DELAY_MS`，`:105`）成功一次即泄漏一条 `window` 捕获相位 `pointermove` 监听。
- 影响：监听与闭包（`frame`、`pointerTarget`、`token`）无界累积；每条旧监听仍会在**每次**指针移动时被调用并走一遍 `frame.isConnected` / token 判断后早退（N 条空回调）；闭包持有被替换的 `<iframe>` 元素，使其在 GC 前一直存活。长时间会话 + 频繁调窗口可累积到几十上百条，属于明确的内存/CPU 泄漏，且与同文件 `:196-199` 注释「卸载时必须摘监听，否则 HMR/切壁纸会叠加」的自我要求相反。
- 修复建议：`attachPointerPost()` 开头先 `detachPointerPost()`（或把旧 `{fn, token}` 存进数组，token 作废时逐个 `removeEventListener`）；在 `settle(ok)` 里先 detach 再 attach。

### P1-2 `localStorage` **取值器**抛错未兜：面板渲染崩溃 / 场景装配被误判硬失败 / 属性面板抛错

- 证据（全部在 try/catch 之外访问 `localStorage`，且 `typeof localStorage` 本身就会触发取值器）：
  - `src/client/local-store.ts:13` `return typeof localStorage !== 'undefined' ? localStorage : null;`
  - `src/client/settings.ts:113-116`（`getUserPropertyValue` 先 `typeof localStorage`，再直接 `getItem`）
  - `src/client/wallpaper-properties.ts:35` 与 `:46`（`writeUserProperty` / `resetUserProperty` 打印在 try 之前的 `typeof localStorage`）
  - `src/client/setup-tip.tsx:37`（`storeOf`）、`:52`（`getItem` 未包）、`:66`（`setItem` 未包）
  - 对照：`src/client/render-health.ts:49-52` 已经用 `try { ... } catch { return null }` 正确兜住，说明项目知道这个写法。
- 触发条件：浏览器禁止存储（禁 cookie / 企业策略 / 存储被禁用）或页面处于不透明 origin（沙箱化嵌入）时，**读 `window.localStorage` 属性本身抛 `SecurityError`**（不是 `getItem` 抛）。桌面壳 `dsh-app://` 是否是不透明 origin **待确认**；一旦成立，影响面比下面列的更大。
- 影响链：
  1. **设置面板渲染即抛**：`settings-section.tsx:342` 的 `useState(loadLibraryState)` 在 render 期调用 → 设置页整体报错（DSH 是否有 error boundary 待确认）。
  2. **每次成功切壁纸后 `markRecent` 抛**（`index.ts:207`，`library-view.ts:63-69`）→ `selectWallpaper()` 返回 rejected，面板 handler 是 `void selectWallpaper(id)`（`index.ts:326`）⇒ unhandled rejection；轮播路径被 `rotation.ts:132-137` 的 try 吞掉但本次 `schedule()` 仍会执行。
  3. **场景壁纸被误判「装配异常」**：`three-renderer.ts:612` 在装配期调用 `getUserPropertyValue`，抛错落入 `:1482-1488` 的 catch ⇒ `fail(id, 'exception', ...)` = **硬失败**（`render-health.ts:6`）⇒ 该壁纸进失败记忆、轮播 `markFailed` 跳过、自动重试被禁用。只要 scene.json 里有一个 `{user}` 绑定就会命中，用户看到「装配异常」，实际是存储不可用。
  4. 属性面板保存/reset 在事件回调里抛（`settings-section.tsx:516-519`、`:549-554`），React 事件回调错误不被 boundary 捕获。
- 修复建议：加一个 `safeStorage()`（照抄 `render-health.ts:49-52`）供 `local-store.ts` / `settings.ts` / `wallpaper-properties.ts` / `setup-tip.tsx` 共用；读到的 `null` 走内存兜底或直接返回默认值（`getUserPropertyValue` 返回 `undefined` 即「未设置」，不会误杀对象）。

### P1-3 系统音频「授权/等待中点停止」竞态：采集在用户以为已停止后建立且无人释放

- 证据：`src/client/three-renderer.ts:1532-1547` 的 `startSystemAudio()` 在 `await startSystemAudioCapture(...)`（内部唯一 await 是 `getDisplayMedia`，`system-audio.ts:45`）期间**没有任何代号/`disposed` 检查**：入口 `systemAudioStarting` 只防重入，`stopSystemAudioCapture()` 在 await **之前**执行（`:1535`，此时 `currentSystemAudio` 还是 null）；await 返回后无条件 `currentSystemAudio = cap`（`:1543`）并返回 `'ok'`。`dispose()`/`teardown()`（`:516`、`:1580`）也只停「当前已有」的 cap。
- 触发：面板点「启用系统音频」→ 浏览器弹出共享选择框 → 用户此时点面板「停止系统音频」/关闭设置对话框/切壁纸/HMR 重载 → 然后才在弹出的共享框里点「共享」。
- 影响：`getDisplayMedia` 成功后 capture 被建立（`MediaStream` + 独立 `AudioContext` 持续运行、系统音频仍在采集），而 **UI 状态是 idle**（面板 `systemAudioState` 是组件局部，`settings-section.tsx:347`/`:479-482`），用户没有任何入口知道它在采集；只有下一次切壁纸/关插件才会被 `teardown → stopSystemAudioCapture` 收掉。隐私语义上与「停止共享即清理」（AGENT.md §5.42⑰）和「不重复出声/不落盘」的宣称不一致。
- 修复建议：`startSystemAudio` 加 `let audioSeq = 0`，await 前 `const seq = ++audioSeq`；`stopSystemAudioCapture` 也 `audioSeq += 1`；await 返回后 `if (seq !== audioSeq || disposed) { cap.stop(); return 'error'; }`。同时把「是否有活动采集」提到 renderer 供面板查询（或至少让面板卸载时调用 stop）。

## P2（健壮性/可维护性）

### P2-1 `altOriginProbe` 永久缓存 `null`：一次瞬时探活失败 ⇒ 本实例所有 web 壁纸永久降级

- 证据：`src/client/background-layer.ts:532` `altOriginProbe ??= probeAlternateOrigin(alt, url).then(...)`，`altOrigin` 一旦为 null 不再重探（`:326-333` 只有 1s 超时，且探的是**第一张** web 壁纸的完整路径）。
- 触发：启动窗口内 web 壁纸首次显示时另一回环主机名 1s 内不可达（服务器刚重启、IPv6 `::1` 先解析而服务只监听 IPv4、系统代理/防火墙瞬时拦截）。
- 影响：此后所有 web 壁纸都按 `allow-scripts`（opaque origin）承载，WebGL 类 web 壁纸整片空白（§5.30 的已知失败形态），且**本页面生命周期内不会恢复**、无日志。AGENT.md §5.30 只描述「不可达时兜底」，未声明「失败被永久记忆」。
- 修复建议：失败不写缓存（只在成功时 `??=`），或缓存加 TTL/在下次 `showWeb` 时重试一次并 `console.warn` 一次原因。

### P2-2 启动恢复路径未 `.catch` + 列表 `fetch` 不检查 `.ok`

- 证据：`src/client/index.ts:281` `fetchList: async () => (await fetch('/wallpapers/list')).json()`（无 `.ok`、无形状校验）；`index.ts:375-379` 恢复已保存选中项时 `void controller.load().then(...)` **没有 catch**；同类 `settings-section.tsx:56-58`、`boot-settings-section.tsx:28-30` 也不检查 `.ok`。
- 触发/影响：① 启动瞬间一次网络失败（服务端重启/代理抖）⇒ `controller.load()` reject ⇒ unhandled rejection（Electron/Chromium 控制台报错，恢复选中项静默失败）；② 若响应体不是数组（500 JSON / 反代 HTML 页），`controller` 把 `list` 置成非数组 ⇒ 后续 `list.find/filter` 抛 TypeError（`select` 内被 catch，但 `rotation.getPool`、面板 `filterLibrary` 会继续拿到它）；面板侧 `.json()` 成功但形状错时 `filterLibrary` 在 render 期抛 ⇒ 设置页白屏（当前 host `/wallpapers/list` 恒返回数组，故为防御性缺口）。
- 修复建议：`if (!r.ok) throw ...; const v = await r.json(); return Array.isArray(v) ? v : []`；恢复路径补 `.catch`。

### P2-3 `markRecent` 在「已被更新选择取代」时仍执行：最近使用被没上屏的壁纸污染

- 证据：`src/client/index.ts:200-209` `await controller.select(id)` 后无条件 `applySettingsToLayer` + `markRecent(id)`；而 `wallpaper-controller.ts:178/198/230/246` 在代号失配时**直接 return**，调用方无法区分「已应用」与「已被取代」。
- 触发：快速连点 A、B（或轮播 tick 与手动选择交叉）⇒ A 的 select 提前返回后仍 `markRecent(A)`，A 会被排到「最近使用」最前，尽管它从未上屏。
- 影响：`sort: 'recent'` 的列表顺序与实际使用不符；不崩溃。
- 修复建议：`controller.select` 返回 `boolean`（是否真正应用）或 `{applied}`，`selectWallpaper` 仅在 `applied` 时 `markRecent` / `notifyWallpaperHealth`。

### P2-4 换背景时未显式停旧 `<video>` / 断源，与大清理路径口径不一致

- 证据：`src/client/background-layer.ts:275-285` 的 `clear()` 只 `fill.replaceChildren()` + 置空引用，**没有 `pause()` / `removeAttribute('src')` / `load()`**；而同仓库的兜底清理 `index.ts:261-263` 对残留层是显式 `pause + removeAttribute('src') + load()`。
- 影响：依赖「媒体元素被移出文档即暂停」的浏览器行为；`preload=auto` 的网络/磁盘读取在元素 GC 前可能继续（大视频壁纸偶发「切走后仍在下载/占用解码器」）。属体验/资源小漏，非功能错误。
- 修复建议：`clear()` 里对 `currentVideo` 显式停播断源（与 `index.ts:261-263` 同口径）。

### P2-5 `postMessage` targetOrigin 恒为 `'*'`

- 证据：`src/client/background-layer.ts:222`（指针）与 `:362`（声音）都是 `postMessage(payload, '*')`。
- 影响：payload 只有指针归一化坐标/像素坐标与 `{enabled, volume}`，且接收方是壁纸自己的 iframe ⇒ 泄漏面很小；但在 `plan.kind === 'transport' | 'probe'`（已知 origin）时本可精确指定，`'*'` 让「壁纸页内被引入的第三方子帧」理论上也能读到（需要它拿到父窗口引用）。
- 建议：能确定 origin 时传 origin，只有 opaque-origin 兜底分支用 `'*'`；若不改，至少在此处注明「接受」。

### P2-6 音频侧两个「未收尾」的残留物

- 证据：
  - `src/client/audio-input.ts:81-101` 的 `armGestureResume`：三个 window 监听只在**首次手势**时摘除（`:89-97`）。若装配后用户从未手势就切壁纸（或页面一直无人操作），`stopAudio`（`three-renderer.ts:392-402`）只 close context，监听仍挂在 window 上并把已关闭的 context 留在闭包里。同理 `:117-133` 的 `armGesturePlay` 只由句柄 `teardown` 的 `disarm?.()` 摘，若句柄迟到被 `currentAudio !== audio` 分支直接 `stop()`（`three-renderer.ts:425-427`）则走 `teardown` ✓（此路径没问题）。
  - `src/client/audio-input.ts:178-184`：`__weAudioDebug` 全局对象持有最后一个 `<audio>` 元素及其 URL，**stop 后不清**（且 `stop()` 里已 `remove` 元素）。属诊断残留：一次会话只留一份，但保持元素/解码资源引用。
- 修复建议：`stopAudio` / 句柄 `teardown` 时调用 `detach` 并 `delete __weAudioDebug`（或改成弱引用/仅在调试开关下存在）。

### P2-7 面板两个 1s 轮询每次都产生新对象 ⇒ 视频/媒体壁纸下设置面板每秒全量重渲染

- 证据：`settings-section.tsx:381-393` 两个 `setInterval(read, 1000)`；`read()` 的来源每次返回**新对象**：`media-orchestration.ts:161-163`（`return { ...status }`）、`video-health.ts:242-262`（`snapshot()` 每次新建）。React 因引用不同必然重渲染，而每次 render 都重算 `filterLibrary(wallpapers, ...)`（`:356`）并 reconcile 整张缩略图网格（`:813-870`）。
- 触发：设置面板打开 + 当前是视频壁纸（或媒体集成 scene）且列表较大（数千张，§5.51 决定不分页）。
- 影响：面板打开期间每秒一次全量 diff/排序；大库下可感知掉帧与 CPU 占用。非崩溃。
- 修复建议：`read()` 里按关键字段比较后再 `setState`（或 `useSyncExternalStore` + 快照缓存）；`filterLibrary` 用 `useMemo`（`[wallpapers, filter, libState]`）。

### P2-8 boot-overlay 的媒体事件处理不校验归属：上一次 `play()` 的迟到事件可以结束新动画

- 证据：`src/client/boot-overlay.ts:105-122` 的 `finish()` 读的是 `active`（当前 entry）而不是事件来源；`:224-229` 的 `loadeddata` / `ended` / `error` 闭包只判 `entry.result`/`holdForBoot`，不判 `active === entry`。`teardown()`（`:125-136`）摘 DOM、`stopVideo` 断源，但已经入队的事件仍会派发。
- 触发：面板连续点「试播」两次（`play()` 内先 `teardown('skipped')` 再建新 entry），旧 `<video>` 的 `loadeddata/ended/error` 恰好在新 entry 建立后到达。
- 影响：新动画被提前 `finish`（表现为点试播后一闪而过/立刻结束）；**待确认**（取决于事件队列时序，本机未复现）。
- 修复建议：事件处理里加 `if (active !== entry) return;`（把 entry 传进闭包）。

### P2-9 本地视频选择器在「`cancel` 不触发」的平台会永久 pending

- 证据：`src/client/boot-settings-section.tsx:47-77` 的 `defaultPickLocalFile` 只监听 `change` 与 `cancel`，`<input>` 只在 `done()` 里移除。
- 触发：Chromium < 113 / 某些 Electron 版本对 `<input type=file>` 不派发 `cancel`，用户在选择框里点取消。
- 影响：隐藏 `<input>` 永久留在 body、Promise 永不 settle ⇒ 面板「选择本地文件」一直处于等待态（若 UI 有 loading 则永久 loading）。**待确认**（当前 Electron 版本是否已支持 `cancel`）。
- 修复建议：加超时兜底（如 5 分钟）或改用 `window.showOpenFilePicker`（桌面壳有 hostPaths 时优先）。

### P2-10 SceneScript 的 `localStorage` 无上限、切壁纸/删壁纸都不清理

- 证据：`src/client/scene-script-vm.ts:39`（键前缀 `we:scenescript:`）、`:600-609`（`lsSet` 直接写宿主 localStorage，只 catch 异常）、`:681-686`（按壁纸 id 加隔离段）。全仓无字节/键数上限，也无「壁纸卸载时清理该 id 前缀」的路径（host 侧也没有）。
- 触发：壁纸自带脚本循环 `localStorage` 写入（恶意或 buggy 素材），或多个脚本长期累积。
- 影响：写满**同源 localStorage 配额**后，插件其余键（`we:fav` / `we:hidden` / `we:recent` / `we:renderfail:*` / `we:userprop:*` / `we:setup-tip`）的写入全部静默失败（`saveJson` 返回 false 但调用方丢弃返回值，见 P2-16）⇒ 收藏/隐藏/失败记忆无声丢失；清理后也不会自动恢复已丢的键。隐私上无外泄，属可用性/资源问题。
- 修复建议：对脚本存储加 per-wallpaper 字节预算（如 256KB）与键数上限，超限 `warn` 一次并拒绝写；提供按壁纸前缀清理（切换壁纸时可保留，删除壁纸/清缓存时清理）。

### P2-11 shim 注入锚点只认精确 `<head>` / `<html>`，fallback 会把 `<script>` 放到 `<!doctype>` 之前

- 证据：`src/shared/pointer-shim.ts:90-101`：`lower.indexOf('<head>')`、`lower.indexOf('<html>')` 是**精确字符串**匹配，带属性的 `<html lang="zh">` / `<head profile=...>` 不命中；随后 `:99` 若匹配到 `<body>` 就把整段 `<script>` **前置到文档开头**（在 `<!doctype html>` 之前）。AGENT.md §5.48 的描述是「无 `<head>` 退 `<html>` 后」，与实现不一致。
- 触发：壁纸 HTML 没有裸 `<head>`（带属性、`<head >` 带空格/换行）——此时脚本被插到 doctype 前，浏览器进入 **quirks mode**，壁纸布局可能整体变形；同时 shim 仍在 `html` 解析前执行（功能上一般仍可用）。全大写 `<HEAD>` 不受影响（比较用的是小写副本），只有「精确 `<head>`」这一种形态被认。
- 实测范围：本机工坊 4 个 web 壁纸（`1184182304` / `3778198228` / `3789244610` / `3804412656`）**全部有裸 `<head>`**，故当前库未触发；属对第三方素材的健壮性缺口（**待确认**是否值得修）。
- 修复建议：用 `/<head\b[^>]*>/i` / `/<html\b[^>]*>/i` 定位并插到匹配的**结束位置**（保留原标签属性）；找不到任何锚点时返回 `null`（保留原文档）而不是前置。

### P2-12 `teardown` / `mount` 契约自相矛盾：公开 API 注释称可重新挂载，实现是一次性闩锁

- 证据：`src/client/index.ts:394-395` 注释「手动卸载（排查/救急用）：收尾并摘掉背景层；**下次 mount 可重新挂载**」；实现 `teardown` 置 `disposed = true`（`:215`）且全文件无复位（grep 仅 `:215` 一处赋值），`mount()` 首行 `if (disposed || layer) return`（`:268`）⇒ teardown 后 `mount()` / `select()` / `show()` 全部静默 no-op；`__wallpaperEngine` 全局对象也不清（只有 `__wpEngineTeardown` 按归属删除，`:240-242`）。
- 旁证：`tests/dom/plugin-lifecycle.dom.test.ts:93-100`「dispose 之后同实例再 mount 不复活」把不可恢复当作预期行为 ⇒ **注释是错的**，不是实现错。
- 影响：按注释去「救急卸载再挂载」的用户/排查者会发现插件彻底静默；`show()` 在 teardown 后无任何报错。属文档/API 契约缺陷。
- 修复建议：改注释为「不可恢复，恢复请刷新页面」；或提供 `remount()` 重置 `disposed` 并重建（需同时复位 `bootPlayer` / `rotation` / handlers）。

### P2-13 `getLastHealth()` 的 `currentHealthId` 是实例级，与注释声明的「按 render 作用域归属」相反

- 证据：`src/client/three-renderer.ts:564-567` 注释说「id 由调用方按本次 render 的作用域传入…实例级共享会把被取代那次的结论记到新壁纸键上」，但紧接着 `currentHealthId = id` 仍是实例级，`:1587-1589` 的 `getLastHealth()` 用它。
- 触发：P0-1 的重叠 render；或「旧装配后完成」。
- 影响：`__wallpaperEngine.health()` / 面板「读一次」拿到的是另一张壁纸的快照；`panelHealth()`（`index.ts:118-121`）因 id 不匹配返回 null，表现为「尚未渲染」而推送过的成功状态又消失，自相矛盾。属 P0-1 的次生可观测性错乱。
- 修复建议：随 P0-1 一起给 `currentHealthId` 加代号，或在 `render` 出口处仅在「未被取代」时写。

### P2-14 `media-input` 无超时/不可取消：一次挂死的请求让轮询永久停摆（跨 stop/start）

- 证据：`src/client/media-input.ts:100-133` 的 `poll()` 用 `inflight` 单飞标记，`fetchImpl` 无 `AbortController`/超时；`stop()`（`:142-148`）与 `dispose()`（`:165-170`）都不 abort 在途请求，`inflight` 只在 `finally` 归零。
- 触发：`GET /wallpapers/now-playing` 挂住（host watcher 首次启动、PowerShell 抖动、代理/网关卡住）。
- 影响：挂住期间每次 timer tick 都因 `inflight` 早退；用户关开媒体开关（`stop()`→`start()`）后依旧早退，媒体事件停更到请求自行结束为止；`dispose()` 之后该请求仍占用连接（页面级，非渲染阻塞）。属健壮性缺口，不会崩溃。
- 修复建议：`poll` 内 `AbortController` + 超时（如 5s），`stop/dispose` 时 abort；`inflight` 在 `stop()` 时随代次作废（用 `seq` 参与判断）。

### P2-15 空库 + 开轮播时，每次设置变更都重新拉列表（重试风暴）

- 证据：`src/client/index.ts:182-190`：`rotationListLoadAttempted` 在 `load()` 的 `then`/`catch` 里**又复位成 false**（`:188-189`），唯一的抑制条件是 `c.getList().length === 0`。列表为空（尚未配置素材目录 / 扫描失败）时该条件永远成立。
- 触发：启用轮播且列表为空，用户在面板里连续拖滑杆/切开关（每次 `onRuntimeSettings` → `applyRuntimeSettings`，也含每次 `visibilitychange`）。
- 影响：每次设置变更一发 `/wallpapers/list`（扫描耗时在 host 侧，且有 4 目录 FIFO 缓存），形成无谓重试风暴；与「列表非空后由长度守卫挡住重复拉取」的注释意图不符（空列表恰恰挡不住）。
- 修复建议：把「本会话已尝试过」做成真正的闩锁（成功/空列表都不复位，仅失败时允许下次重试），或加最小间隔（如 30s）。

### P2-16 收藏/隐藏写入失败被丢弃：配额满时面板显示成功但重启后丢失

- 证据：`src/client/library-view.ts:46-60` 的 `toggleFavorite` / `toggleHidden` 调 `saveStringSet`（`local-store.ts:46-48`）丢弃 `saveJson` 的 `boolean`；面板 `settings-section.tsx` 的收藏/隐藏 handler 也不看返回值。
- 影响：localStorage 配额满/隐私模式时 UI 立即翻转、无任何提示，重开面板/重启后回滚（用户感知为「收藏没保存」）。`writeClientSettings` 已经有失败提示，此处口径不一致。
- 修复建议：`saveStringSet` 返回 `boolean`，面板在 false 时显示一行「本地存储不可用，收藏仅本次有效」。

### P2-17 `copyText` 降级路径中途抛错会留下隐藏 `<textarea>`

- 证据：`src/client/diagnostics.ts:63-77`：`appendChild` 之后若 `ta.select()` / `execCommand` 抛错，`catch` 直接 `return false`，`removeChild` 被跳过。
- 影响：每点一次「复制诊断信息」在 `document.body` 留一个 `position: fixed; opacity: 0` 的 textarea（`-1000px`，不可见），数量随点击增长。极小但确定。
- 修复建议：把 `removeChild` 放进 `finally`。

## 资源清理清单核对（监听器/定时器/上下文 → 清理点）

> 只列「注册点 → 清理点」；✅ = 有明确清理且路径可达；⚠ = 有缺口（对应上面条目）。

| # | 资源 | 注册点 | 清理点 | 结论 |
|---|---|---|---|---|
| 1 | `document.visibilitychange` | `index.ts:366` | `teardown` `index.ts:241` | ✅ |
| 2 | `DOMContentLoaded`（once） | `index.ts:387` | 无（`mount` 有 `disposed` 守卫，触发也 no-op） | ✅ |
| 3 | 软失败自动重试 `setTimeout`（按壁纸 Map） | `index.ts:135` | `index.ts:219-220` + 回调自删 | ✅ |
| 4 | 轮播 `setTimeout` | `rotation.ts:116` | `rotation.ts:107-111` + `index.ts:217`（`teardown`） | ✅（唯一调度器；`start` 幂等） |
| 5 | 开机动画全部 timer / skip 监听 / `MutationObserver` / `<video>` | `boot-overlay.ts:76-92`、`:142-149`、`:181-188`、`:224-232` | `finish` `:105-122`、`teardown` `:125-136`、`dispose`、`bootPlayer.dispose`（`index.ts:239`） | ✅（事件归属有 P2-8 缺口） |
| 6 | 媒体失败订阅（mediaHealth → 面板） | `index.ts:80-82` | `teardown` `index.ts:231` | ✅ |
| 7 | web 指针直传 `window.pointermove`（capture） | `background-layer.ts:225` | `detachPointerPost` `:204-209`（`clear`/`stopWebResizeReload`） | ⚠ **resize 重建路径不减旧监听 → P1-1** |
| 8 | 视频声音解锁 `pointerdown`/`keydown` | `background-layer.ts:303-304` | `detachGestureUnlock` `:287-292`（`clear`/静音/成功后） | ✅ |
| 9 | web resize `window.resize` | `background-layer.ts:516` | `stopWebResizeReload` `:272` | ✅ |
| 10 | web resize debounce timer | `:413` | `:269` | ✅ |
| 11 | web 预载帧 8s 超时 | `:448` | `settle` `:432`（自清） | ⚠ 不入统一集合：`clear()` 后仍会空转到点（无害，无引用泄漏） |
| 12 | web 声音重发 `setInterval` | `:380` | `stopSoundRetry` `:372-374`（`clear`/`stopWebResizeReload`/下次重发） | ✅ |
| 13 | 另一主机名探活 `AbortController` + timer | `:328-332` | `finally` `:330-332` | ✅（结果缓存问题见 P2-1） |
| 14 | 视频健康：2×`setInterval` + 8 个媒体事件 | `video-health.ts:233-234`、`:217-229` | `detach` `:126-129`/`:199-209` ← `background-layer.clear()` `:277` | ✅（`dispose()` 从未被调用、`BackgroundLayer` 无 dispose：依赖 `controller.select('')` 路径，属隐含契约） |
| 15 | 视频首帧 `loadeddata`/`error` + 1.5s 超时 | `:497-499` | `done` `:491-496` | ✅ |
| 16 | 旧 `<img>/<video>/<iframe>` DOM | `:464-508` | `clear()` `:279` | ⚠ `<video>` 未显式停播断源（P2-4） |
| 17 | scene `AudioContext`（analyser + masterGain） | `three-renderer.ts:406` | `stopAudio` `:392-402` ← `teardown` `:512`/`setSoundEnabled(false)` | ✅ |
| 18 | scene 音频手势监听 | `audio-input.ts:98-100`、`:129-131` | 首次手势 `:89-97`、句柄 `teardown` `:153-162` | ⚠ 未手势即收尾时残留（P2-6） |
| 19 | 系统音频 `MediaStream` + `AudioContext` | `system-audio.ts:45/59` | `stop()` `:64-76`（含轨道 `onended`）、错误路径 `:53-62`/`:101-105` | ⚠ 授权竞态（P1-3） |
| 20 | VideoTexture 的 `<video>` + Blob URL | `tex-loader.ts:452-458` | `tex` 的 `dispose` 事件 `:475`（`release` `:459-464`） | ✅（手势 `resume` 监听不摘，见 P2-6 同类） |
| 21 | three 渲染器：`window.resize` / canvas `click` / `webglcontextlost` / 指针 tracker / 播放器 RAF / GL+RT+纹理 | `three-renderer.ts:1461`、`:1249`、`:578`、`:1447`、`threejs-player.ts:1280` | `teardown` `three-renderer.ts:457-517`、`dispose` `:1579-1585` | ⚠ 重叠 `render` 下全部可能漏（P0-1） |
| 22 | SceneScript `localStorage` 键 | `scene-script-vm.ts:600-609` | 无上限、无清理 | ⚠ P2-10 |
| 23 | 面板 1s 轮询 ×2 | `settings-section.tsx:384`、`:391` | cleanup `:385`、`:392` | ✅（重渲染成本见 P2-7） |
| 24 | 属性提交防抖 timer | `settings-section.tsx:542` | `:365`（切壁纸/卸载）、`:456` | ✅ |
| 25 | SetupTip 自动隐藏 timer | `setup-tip.tsx:76` | cleanup `:77` | ✅ |
| 26 | SetupTip 本地存储读/写 | `setup-tip.tsx:52`、`:66` | 无 try/catch | ⚠ P1-2 |
| 27 | `settings-shell` 的 rAF focus | `settings-shell.tsx:31` | 一次性，无需清理 | ✅ |
| 28 | `MediaInput` 轮询 interval | `media-input.ts:95` | `stopTimer` `:83-87`、`stop/dispose` `:142-170` | ✅（在途请求不可取消，P2-14） |
| 29 | `MediaOrchestration` → `MediaInput` | `media-orchestration.ts:104-118` | `dispose` `:154-160` ← `three-renderer.ts:502` | ✅ |
| 30 | 渲染看护 localStorage 键 | `render-health.ts:90-92` | `clear` `:118`、`clearAll` `:120-134`（按键前缀枚举） | ✅ |
| 31 | 风格注入 `<style>` | `styles.ts:775-779` | 不随 teardown 移除 | ✅（幂等且内容静态，无泄漏） |

**HMR 重挂载专项结论**：`dropStaleLayers`（`index.ts:246-266`）→ 旧实例 `teardown` → DOM 兜底清理 + `WEBGL_lose_context` 的顺序成立；`__wpEngineTeardown` / `__wallpaperEngineBoot` 都按归属删除（`:240`、`:242`），`teardown` 有 `disposed` 幂等闩锁，共享 handler 在 mount 内同步注册且 `dropStaleLayers` 先于注册执行 ⇒ **不会叠层/叠监听/叠定时器**（与 `tests/dom/plugin-lifecycle.dom.test.ts` 的 4 项断言一致）。真正的幂等缺口在渲染循环入口 `render()`（P0-1），不在 DOM 挂载点。

## 与文档一致性核查

| 文档条目 | 核查结果 |
|---|---|
| §5.43 HMR 幂等 / 收尾 | **代码与文档一致**（单层、单定时器、单渲染器；`ctx.effect` 收尾 + `mount()` 单例 + `window.__wpEngineTeardown` 交接齐备；测试佐证）。**但**同条「凡是插入 DOM / 起循环 / 开上下文的挂载点都要同时具备幂等与收尾」在 `render()` 上不成立（P0-1 重叠装配无代号），属于该条精神下的新缺口。另：公开 API 注释「teardown 后可重新 mount」与实现/测试相反（P2-12）。 |
| §5.48 web 指针 shim | 宿主侧的「只跟可见帧」「旧 token 作废」「重建后重挂」「iframe 先布局再赋 src」「坐标回退」均与文档一致；**新增缺陷**：重建时旧 `pointermove` 监听不摘（P1-1）——文档只要求「重挂 + 作废旧 token」，未要求「摘旧监听」，但同文件注释声称会摘，且实际会无界累积。注入点：文档称「无 `<head>` 退 `<html>` 后」，实现是精确字符串匹配 + 前置到文档开头（P2-11，本机 4 个 web 壁纸均命中裸 `<head>`，当前无实害）。`</script>` / `<!--` 转义与「注入在壁纸自带脚本前」符合文档；CSP 边界与文档一致。 |
| §5.50 / §5.51 列表缓存、排序 | 客户端只消费 `/wallpapers/list`，未发现与文档矛盾；`filterLibrary` 的「收藏置顶稳定分区、显式排序不重排」与 §5.51 一致。**未计入文档的新代价**：面板 1s 轮询导致大库每秒全量 `filterLibrary` + 网格 reconcile（P2-7）；建议在 §5.51 的「不加分页/虚拟滚动」取舍里补一句「面板打开期间有 1s 级轮询重渲染」。 |
| §5.52 音频暂停 | 逐路径核对通过：`setPaused` → `layer.setPaused`（视频 `pause/play`，`background-layer.ts:587-592`）+ `sceneRenderer.setPaused`（`applyAudioPause`，`three-renderer.ts:377-390`）；装配期已暂停（`:1449`）与暂停期迟到句柄（`:430-431`）都被处理；系统音频不受暂停影响与文档一致。未发现新问题。 |
| §7.38 看护边界 | ⑥⑦⑧⑨ 的修复代码在位（`show()` 四分支解绑、`ok`/`failure` 并存、`assembleMs`/`firstFrameMs` 分离、`formatTiming` 隐藏 `<0`）。**新发现**：`currentHealthId` 仍是实例级（P2-13），与 `three-renderer.ts:364-367` 注释声明的「按 render 作用域归属」相反 ⇒ 重叠装配时 `health()` 会读到别的壁纸，建议补进 §7.38 的边界清单。 |
| §7.44 媒体集成边界 | 生命周期正确：编排先于脚本宿主释放（`three-renderer.ts:500-508`）、输入 `dispose` 后迟到快照被 `disposed` 拦住（`media-orchestration.ts:108-112`）、面板状态只含 `available/reason/enabled`。**新发现**：`media-input` 无法取消在途请求（P2-14）；面板 1s 轮询新对象（P2-7）。均不影响文档宣称的功能边界，属健壮性。 |
| `local-store.ts:1` 注释「无存储环境（node/SSR）静默降级」 | **与实现不符**：只处理了 `typeof localStorage === 'undefined'`，未处理「属性访问抛 `SecurityError`」——后者会让调用方直接抛错（P1-2）。`render-health.ts:49-52` 的注释与实现是正确的对照。 |
| `index.ts:394-395` 注释「下次 mount 可重新挂载」 | **与实现和测试相反**（P2-12）。 |
| `background-layer.ts:196-199` 注释「卸载时必须摘监听，否则 HMR/切壁纸会叠加」 | 摘「当前」监听成立；重建路径不摘（P1-1），该注释描述的自我要求在 resize 场景下未达成。 |
| `three-renderer.ts:364-367` 注释「id 按本次 render 作用域传入，避免记到新壁纸键上」 | **半真**：`fail`/`succeed` 用的是参数 id（✓），但 `currentHealthId` 仍是实例级赋值（P2-13）。 |
