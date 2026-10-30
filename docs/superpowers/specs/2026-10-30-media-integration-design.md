# 媒体集成（Windows SMTC）+ SceneScript media 事件 + 时间线属性动画 设计

> 日期：2026-10-30 ｜ 基线：`master` @ `87cce0b`
> 动机：`3797976859 小作 2(有声)` 在 DSH 里常驻一个白色方块（媒体播放器模板的专辑封面占位层）。
> 根因：该壁纸的 5 个媒体图层（`35 Media Area` / `38 Song Title` / `39 Artist` / `40 Album Cover Frame` / `45 Album Cover`）的隐藏逻辑只挂在 `mediaPlaybackChanged(PLAYBACK_STOPPED)` 上，而本插件**没有任何媒体事件派发**；同时 `$mediaThumbnail` 实例纹理未实现，回退 `util/white` 纯白。
> 范围（用户已确认）：**方案 B 完整媒体集成**；仅 Windows 宿主（其它平台按「无媒体会话」降级隐藏）；首版**视觉全保真**（封面/歌名/歌手 + 淡入滑入动画 + 主色边框）；面板开关默认开；媒体数据仅内存、不落盘、不记日志。

## 1. 目标与非目标

**目标**：
1. 无媒体会话时，媒体图层隐藏（白框消失），其它 47 张壁纸零行为变化。
2. 播放媒体时，媒体图层显示：专辑封面（含切歌更新）、歌名、歌手、封面边框主色；播放/暂停/停止/切歌按 WE 语义响应。
3. 补齐「对象属性时间线动画」缺口（`thisObject.getAnimation()` / `startpaused` / single·loop·mirror / for 父子联动），使淡入、滑入、循环漂移等动画真正播放。
4. 设置面板可关闭媒体集成；关闭后媒体层隐藏且不启动任何媒体进程。

**不做**（记录在 AGENT.md 已知边界）：
- macOS/Linux 媒体源（MPRIS / Now Playing）——非 Windows 返回 `unsupported-platform`，媒体层隐藏；
- 媒体播放控制（上一首/下一首/seek）与 `mediaTimelineChanged` 事件派发（快照里保留 position/duration 供后续）；
- `general.*` / effects / material 属性的时间线动画（本机唯一受影响的 `Leon 3812518176` 的 `general.bloomstrength` 保持静态）；
- WE 专辑封面取色的原始算法（用启发式主色近似）；贝塞尔曲线逐位对齐 WE（按样本校准，允许视觉近似）；
- 多会话选择/媒体 blocklist/自动切歌源优先级配置（固定单选规则，见 §4.3）。

## 2. 架构总览

```
┌ host（Node，src/host/media-session.ts）──────────────────────────────┐
│  PowerShell watcher（常驻、懒启动、空闲 20s 退出）                    │
│    每 700ms: WinRT SMTC GetSessions() → 变化时输出一行 JSON（含封面） │
│  MediaSessionService：行解析 → 内存快照 + 封面字节 → selectSession()  │
└───────┬──────────────────────────────────────────────────────────────┘
        │ GET /wallpapers/media-session?title=<页面标题>（快照）
        │ GET /wallpapers/media-session/thumbnail?rev=N（封面字节）
┌───────▼ client（src/client/media-input.ts，1s 轮询）─────────────────┐
│  diff → 事件：playback / status / properties / thumbnail             │
│  （仅当前场景需要媒体时创建；暂停/隐藏/卸载即停轮询）                 │
└───────┬───────────────────────────────┬──────────────────────────────┘
        │ SceneScriptHost/VM            │ text-script runtime
        │ media* 事件 + thisObject      │ mediaPropertiesChanged → update()
        │ + 多脚本 + 时间线动画         │
        └──────────────┬────────────────┴──────────────────────────────┘
                       │
         three-renderer：实例纹理 $mediaThumbnail 绑定（共享封面纹理）
                        + 主色提取（客户端从封面位图算）
```

新增模块：`src/shared/media.ts`（纯类型）、`src/host/media-session.ts`（watcher + 选择 + 缓存）、`src/client/media-input.ts`（轮询/退避/生命周期）、`src/client/scene-timeline.ts`（时间线解析与求值）、`src/client/media-palette.ts`（主色提取）。
修改模块：`src/host/routes.ts`、`src/host/settings.ts`、`src/host/index.ts`、`src/client/{scene-json,scene-assets,scene-script-vm,scene-script-host,text-script,three-renderer,threejs-player,settings,settings-section/client,types}.ts`。

## 3. 共享类型（`src/shared/media.ts`，纯类型）

```ts
export type MediaPlaybackState = 'stopped' | 'playing' | 'paused';
export type MediaReason =
  | 'ok' | 'no-session' | 'disabled' | 'unsupported-platform'
  | 'no-powershell' | 'watcher-failed';

export interface MediaSessionSnapshot {
  available: boolean;            // 有可用会话（selectSession 命中）
  reason: MediaReason;           // available=false 时的原因（面板提示用）
  appId: string; title: string; artist: string; album: string;
  contentType: string;           // SMTC MediaPlaybackType（music/video/image/unknown）
  playback: MediaPlaybackState;
  hasThumbnail: boolean;
  thumbnailRev: number;          // 封面字节版本号（0 = 无）
  positionMs?: number; durationMs?: number;  // 仅供未来 timeline 事件，本期不派发
  at: number;                    // 宿主采样时间（ms）
}

export interface MediaPalette {
  primary: [number, number, number];      // 0-1
  secondary: [number, number, number];
  tertiary: [number, number, number];
  text: [number, number, number];
  highContrast: [number, number, number]; // 黑或白
}
```

WE 常量（官方 `lib.sceneScript.d.ts`，本机 WE 安装目录）：`MediaPlaybackEvent.PLAYBACK_STOPPED=0 / PLAYBACK_PLAYING=1 / PLAYBACK_PAUSED=2`。

## 4. host 媒体会话（`src/host/media-session.ts` + 路由）

### 4.1 watcher 进程

- **仅 `process.platform === 'win32'`**；其它平台不 spawn。
- 懒启动：首个 `/wallpapers/media-session` 请求才 spawn；单实例。命令：
  `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command <常量脚本>`
  —— 脚本体是**常量**，不拼接任何运行期数据（无注入面）。
- 脚本（常量）：
  - `[Console]::OutputEncoding = [Text.Encoding]::UTF8`；WinRT prelude 与 `Await` 同 `research/_smtc-probe.ps1`；
  - 每 700ms：`$mgr.GetSessions()` 全量会话，逐会话读 `SourceAppUserModelId` / `GetPlaybackInfo().PlaybackStatus` / `TryGetMediaPropertiesAsync()`（Title/Artist/AlbumTitle/ContentType）/ `GetTimelineProperties()`（Position/EndTime）；
  - **只在签名变化时**输出一行：`{"v":1,"at":<ms>,"sessions":[{appId,status,title,artist,album,contentType,positionMs,durationMs,artB64?,artType?,artRev?}]}`；封面只在该会话的 (appId|title|artist) 签名变化时重取并随行携带，单张 ≤512KB（超限 ⇒ 该会话 `artB64` 省略）；输出 `[Console]::Out.WriteLine` + `Flush`。
- **空闲 20s 无请求 → kill**（进程 + 清状态）；下一次请求重新拉起。watcher 异常退出 → 指数退避重启（1s 起、上限 8s；60s 内 3 次失败 ⇒ 60s 内直接返回 `watcher-failed`，不再反复拉起）。
- 插件 dispose（`ctx.on('dispose')`）时 kill。
- 内存：最新快照 + 每封面 ≤2MB；**不落盘、不写日志**（日志只允许状态/原因计数，绝不打印 title/artist/album）。

### 4.2 行解析与缓存

- `parseWatcherLine(line)`（纯函数）：校验 `v===1`/`at`/`sessions[]` 形状；坏行丢弃并计一次 `badLines`（不抛）。
- `MediaSessionService`：`{ request({pageTitle}), thumbnail(rev), dispose(), stats() }`。
  - `request`：确保 watcher 已启动 → 返回 `selectSession(latest, {ownAppId, pageTitle})`。
  - `thumbnail(rev)`：内存里 rev 命中返回 `{bytes, contentType}`，否则 `null`（客户端按 404 处理并等下轮快照）。
  - `ownAppId = path.basename(process.execPath)`（桌面 App = `DeepSeek Harness.exe`）。

### 4.3 会话选择（纯函数 `selectSession`）

输入全部会话 + `{ownAppId, pageTitle}`；规则（顺序即优先级）：

1. 剔除 `appId === ownAppId`（DSH 自己）；
2. 剔除 `title` 为空；
3. 剔除 `title === pageTitle`（Chromium 为壁纸音效 `<audio>` 注册的自会话，标题 = 页面标题）；
4. 只在 `playing` / `paused` 中选（SMTC 的 Closed/Opened/Changing/Stopped 视为 stopped）；
5. 排序：`playing` 优于 `paused` → `artist` 非空优于空 → `lastChangedAt` 最新（host 按 §4.1 的会话签名变化时刻记录；签名不含 `positionMs`，播放进度推进不算「变化」）。

命中 → `available:true`；否则 `available:false, reason:'no-session'`。**已知启发式边界**：浏览器里播放其它内容时，其会话标题≠DSH 页面标题，会被正常选中；壁纸音效在**浏览器 GUI**里造成的会话若标题恰等于页面标题会被剔除，否则可能误选（记入已知边界）。

### 4.4 路由（`src/host/routes.ts`）

| 路由 | 行为 |
|---|---|
| `GET /wallpapers/media-session?title=<页面标题>` | 设置关 → `{available:false,reason:'disabled'}`（不启动 watcher）；非 win32 → `unsupported-platform`；无 PowerShell → `no-powershell`；正常 → `{available, reason, appId, title, artist, album, contentType, playback, hasThumbnail, thumbnailRev, positionMs?, durationMs?, at}` |
| `GET /wallpapers/media-session/thumbnail?rev=N` | `rev` 命中返回字节 + `content-type` + `cache-control: no-store`；未命中 404 |

- `pageTitle` 仅作过滤，不写入日志/缓存。
- 路由只读内存快照，**不阻塞在子进程**（首次请求只在 spawn 后立即返回 `{available:false, reason:'no-session'}`，下一轮 1s 后才有数据）。

### 4.5 设置

- `WallpaperSettingsSchema` 新增 `mediaIntegrationEnabled: z.boolean().default(true)`；client `DEFAULTS` 与 `ClientSettings` 类型（`src/client/types.ts`）同步；运行期改动经既有 `setWallpaperRuntimeHandler` 下发到渲染器（新增 `setMediaIntegrationEnabled` 入口）。
- 面板「显示效果」组新增开关 + 一行说明：*本机读取系统媒体会话（仅 Windows），数据只留在内存、不落盘、不上传；关闭后媒体图层隐藏*。

## 5. client 媒体总线（`src/client/media-input.ts`）

- **创建条件**：装配期判定「当前场景需要媒体」—— 任一声明脚本源（visible/属性/text）含 `mediaPlaybackChanged|mediaThumbnailChanged|mediaPropertiesChanged|MediaPlaybackEvent`，或任一对象 `instance.usertextures` 含 `$mediaThumbnail`。不满足 → 不轮询、不派发（其余壁纸零开销）。
- 轮询：每 **1000ms** `fetch('/wallpapers/media-session?title=' + encodeURIComponent(document.title))`；带 `fetchWithRetry` 口径的失败重试（仅网络失败）。
- diff（键：`available/reason/appId/playback/title/artist/album/hasThumbnail/thumbnailRev`）→ 回调派发顺序：
  1. 首次快照：先 `mediaStatus(enabled)`，再 `mediaPlaybackChanged(state)`（无会话 = stopped），命中会话且 playing/paused 时随后派发 properties +（有封面）thumbnail；
  2. 后续：playback 变 → playback；title/artist/album 变 → properties；thumbnailRev 变 → thumbnail；available/reason 变 → 按 §5.1 降级；
  3. 切歌时顺序：playback（若变）→ properties → thumbnail。
- **装配即先派发一次 `playback(STOPPED)`**（在首次轮询返回前），保证无白框闪烁；数据到达后再纠偏为 playing。
- 封面：`thumbnailRev` 变化且有封面 → fetch 字节 → `createImageBitmap` → `media-palette` 算主色 → 更新共享封面纹理 → 派发 `mediaThumbnailChanged`；解码失败 → `hasThumbnail:false` + 中性色。
- 生命周期：壁纸暂停 / 切后台（`visibilitychange`）/ 卸载 → 停轮询；恢复 → 立即拉一次；连续失败 3 次 → 间隔 10s 退避（不打断渲染），成功复位。
- 设置关（运行期）：停止轮询 + 派发 `mediaStatus(false)` + `playback(STOPPED)`；再开：立即恢复轮询。

## 6. SceneScript 媒体事件层（VM / Host / 多脚本 / thisObject）

### 6.1 prelude 新增

- `MediaPlaybackEvent`：静态常量 `PLAYBACK_STOPPED/PLAYING/PAUSED`（0/1/2）+ 实例 `state`；
- `MediaStatusEvent {enabled}`；`MediaPropertiesEvent {title, artist, contentType, albumTitle, subTitle, albumArtist, genres}`；`MediaThumbnailEvent {hasThumbnail, primaryColor, secondaryColor, tertiaryColor, textColor, highContrastColor}`（颜色 = `Vec3` 0-1）。

### 6.2 事件抓取与派发

- `LoadedModule` 增加 `handlers: {playback?, status?, properties?, thumbnail?}`；`load()` 额外抓 `mediaPlaybackChanged/mediaStatusChanged/mediaPropertiesChanged/mediaThumbnailChanged`（`mediaTimelineChanged` 本期不派发，见 §1）。
- `VM.dispatchMedia(eventName, payload)`：按装载顺序调用所有模块对应 handler（每次调用重置指令预算；payload 在 quickjs 内新建对象，调用后 dispose）。
- `SceneScriptHost` 暴露 `mediaPlayback(state)` / `mediaStatus(enabled)` / `mediaProperties(props)` / `mediaThumbnail(thumb)`；事件内 `thisLayer.*` 写入走既有 `LayerStateTable`，装配期初始派发的脏写入由调用方在首帧前 `applyLayerState` 一次。

### 6.3 每对象多脚本（消除现有丢弃）

- 现状：`collectScriptSources` 每对象只取 1 个（visible 优先，属性脚本被丢）。改为收集：
  - `visible.script`（property = undefined）；
  - `angles/origin/scale/color` 各自脚本（property = 对应名）。
- `SceneScriptHost.tick()`：可见性信号改按模块 `{objectId, property}` 映射 —— 只有 `property===undefined` 的返回值被当 visible 信号；属性脚本写回不变。
- 回归面（本机 48 张扫描）：仅 3 张受影响 —— `3797976859`（目标）、`2832263418 EVA卡农`（3 visible + 2 属性脚本）、`3793620838 In the Mountains`（2 属性脚本）。三张做前后对照截图（预期更贴 WE，不得黑屏/停摆）。

### 6.4 `thisObject`

- 全局 `thisObject`（当前脚本所属对象）：
  - 属性脚本：ILayer 代理 + `getAnimation(name?)` → 无参 = 当前属性绑定的时间线动画播放器；有参 = 按动画 `options.name` 查找；
  - visible/text 脚本：ILayer 代理 + `getAnimation(name?)`（按名查；无绑定 = 惰性 no-op 播放器，避免事件里 `.play()` 抛错停用脚本）。
- 播放器复用 `AnimRegistry` 的 `play/pause/stop/isPlaying/setFrame/getFrame`，并补 `fps/frameCount/duration/name/rate`（见 §8）。

## 7. 文本脚本媒体事件（`text-script.ts`）

- `bind()` 额外抓 `mediaPropertiesChanged` 句柄；`TextScriptRuntime` 增加 `dispatchMediaProperties(props)`（对全部 binding 派发，事件内改脚本内部变量）。
- `text-object` 的帧驱动逻辑不变：`update()` 返回的文本与上一帧不同才重绘；空文本时 1px 宽（现状）。
- 目标壁纸的 `38 Song Title` / `39 Artist` 因此在切歌时显示 `event.title` / `event.artist`。

## 8. 时间线属性动画（`src/client/scene-timeline.ts`）

### 8.1 解析

- scene.json 属性对象 `{animation:{c0?,c1?,c2?,options}, value}`（属性 = `alpha/origin/scale/angles/color`）解析为：
  `TimelineAnimation { property, channels: Keyframe[][], fps, frameCount, mode: 'single'|'loop'|'mirror', startPaused, relative, wrapLoop, name?, parentKey?, childrenKeys? }`；
  `Keyframe { frame, value, back?: {x,y,enabled}, front?: {x,y,enabled} }`；
  `frameCount = options.length`（缺省 60），`fps = options.fps`（缺省 60），`duration = frameCount / fps`。
- 通道数：`alpha` 1 通道（c0），`origin/scale/angles/color` 3 通道。某通道缺失（如 alpha 无 c0）⇒ **该通道/属性不用时间线**，回退静态 `value`，不猜测默认值。
- `parent`（`{key}`）/`children`（`[{key}]`）= 属性键联动：子动画帧位置跟随父动画。

### 8.2 求值与播放（纯数据可单测）

- 每通道：按帧位置找段 → 三次贝塞尔（段起点 `front`、段终点 `back`；handle `enabled=false` 或缺失 → 线性）；handle x 归一化到段长、y 归一化到值差（**按本机样本校准的近似**，不逐位对齐 WE，允许视觉近似；校准结果写入单测夹具）。
- 时间步长：帧时间 `dt` 钳制 0.0001–0.25 s（WE 主循环口径），避免切后台/卡顿后动画跳变。
- 模式：`single` 到末帧停住；`loop` 回绕；`mirror` 往返；`startPaused` → 停在 frame 0；`relative` → 结果叠加静态 `value`。
- 优先级：**时间线值 > 静态/用户值；脚本该帧的 `update()` 返回值 > 时间线**（实现顺序：先推进/写入时间线值 → 再跑脚本 tick → 脚本写入覆盖 → `takeDirty` 应用）。
- 初始应用：装配完成时对所有时间线求值一次（非 startPaused 从第 0 帧开始播放；startPaused 应用第 0 帧值），首帧画面即正确。
- 播放器：`TimelinePlayback` 实现 `play/pause/stop/isPlaying/getFrame/setFrame` + `fps/frameCount/duration/name/rate`；`thisObject.getAnimation()` / `thisLayer.getAnimation(name)` 指向同一实例。
- 回归面：仅 3 张含动画（目标 / `克西高达` Fog origin loop / `Leon` general 不做）；`Fog` 将开始循环漂移（对齐 WE）。

## 9. 实例纹理与主色

### 9.1 `instance` 解析（`scene-json.ts`）

- image 对象新增 `instance?: { textures?: string[]; usertextures?: Array<{ name: string; type: string }> }`。
- `textures` 覆盖材质纹理槽（名字相对 `materials/`，如 `util/white` → `materials/util/white.tex`）；与材质原纹理相同则无操作。
- `usertextures` 含 `name === '$mediaThumbnail'` → 该对象纹理槽绑定「媒体封面纹理源」。

### 9.2 共享封面纹理源（client）

- `MediaThumbnailTextureSource`：初始 map = 材质原纹理（本样本 `util/white`）；封面到达/切换 → `createImageBitmap` 后替换共享 `THREE.Texture`（`needsUpdate=true`），所有绑定对象自动刷新；切歌先设空再设新图（避免旧图残留）；teardown 时 dispose。
- 无封面（播放器不提供缩略图）→ `hasThumbnail:false`，纹理保持占位（`util/white`），媒体层显隐仍由 playback 事件控制。

### 9.3 主色（`src/client/media-palette.ts`）

- 位图降采样 32×32 → 4-bit 直方图 + 3 类 k-means（确定性初始化，迭代 ≤8 次）→ 按权重得 primary/secondary/tertiary；
- `textColor` = {secondary, tertiary, black, white} 中与 primary 对比度最高者；`highContrastColor` = 黑/白中对比度更高者；
- 输出 0-1 归一化 Vec3；`mediaThumbnailChanged` 按官方字段派发。固定小图单测。

## 10. 错误处理与降级

| 场景 | 行为 |
|---|---|
| 非 Windows / 无 PowerShell / watcher 失败 | `available:false` + reason；派发 `playback(STOPPED)` → 媒体层隐藏；面板一行提示（不含歌名）；watcher 退避重启，不影响渲染 |
| 无媒体会话 | `no-session`；媒体层隐藏 |
| 设置关闭 | `disabled`；不 spawn watcher；派发 `status(false)` + `playback(STOPPED)` |
| 封面字节缺失/超限/解码失败 | `hasThumbnail:false` + 中性色；不阻塞其它事件 |
| 封面 rev 不匹配 | 404 → 客户端等下一轮快照重取 |
| watcher 坏行/退出 | 丢弃 + 计数；退出走退避重启 |
| 事件 handler 抛错 | 既有 VM 语义：单脚本停用 + 一次 warn（不影响其它脚本/渲染） |

## 11. 性能预算

- watcher：空闲 20s 自动退出；活跃时 1 进程（PowerShell + WinRT，~30-60MB），700ms 采样（单次查询实测 50ms 量级，冷启动 1.2s 只在拉起时发生）。
- client：1s 轮询 = 一个本地 GET（命中内存快照，毫秒级）；封面只在 rev 变化时下载（≤512KB）。
- 时间线动画：本机 ≤10 条/壁纸，每帧求值 <50µs；1080p 帧率门槛沿用既有 e2e（≥30fps，非判据项）。
- 不修改任何既有壁纸的默认路径：无媒体脚本的壁纸不创建轮询、不派发事件。

## 12. 测试策略

**单测（vitest）**
- `media-session.test.ts`：行解析（坏行/多会话/art 省略）、`selectSession` 规则（自会话/pageTitle/playing 优先/artist 优先）、空闲退出与退避（注入 fake spawn/timer，**不真起进程**）、路由分支（disabled/unsupported/no-session/thumbnail 404）。
- `media-input.test.ts`：diff→事件序列（首次/切歌/停止）、轮询启停（暂停/隐藏/设置关）、失败退避、thumbnail 拉取失败降级（fake fetch/fake timers）。
- `media-palette.test.ts`：固定小图 → 主/次/三色与对比色断言（含纯黑/纯白边界）。
- `scene-timeline.test.ts`：贝塞尔（线性/曲线/端点）、single/loop/mirror、startPaused 初值、relative、父子联动、`getAnimation` 播放器状态机。
- `scene-script-vm.test.ts` 增补：media 事件 handler 派发、`thisObject.getAnimation().play()`、多脚本（visible + 属性脚本各自更新）、MediaPlaybackEvent 常量。
- `scene-script-host.test.ts` 增补：多脚本可见性信号映射。
- `scene-json.test.ts` 增补：`instance` 与属性动画解析、畸形回退。
- `text-script.test.ts` 增补：`mediaPropertiesChanged` → `update()` 返回新文本。

**e2e（headless，复用 `e2e/harness` 模式）**
- `verify-media-layer.mjs`：3797976859 + mock `/wallpapers/media-session*`：
  1. 无会话 → 白块区域 (255,255,255) 像素数 = 0（现状 ≈ 万级）；
  2. 播放态 → 封面区域出现非白像素、Song Title/Artist 文本纹理非空、媒体层可见；
  3. 停止 → 媒体层消失；
  4. 动画 → 播放事件后 N 帧 alpha/位置与静态基线不同（淡入/滑入生效）。
- 回归对照：`2832263418` / `3793620838` / `2597392171` 三张前后截图（人工确认无异常）。

**真机验收（TESTING.md 新增小节）**
- DSH 桌面 App 内播放音乐（SMTC 兼容播放器）→ 切歌/暂停/停止/关闭媒体集成各一遍；确认封面、歌名、歌手、边框主色、动画；日志无歌名/歌手；数据目录无新增文件。

## 13. 交付物

- 代码：§2 新增/修改模块。
- 文档：AGENT.md 新增「媒体集成」小节（数据流、隐私、路由、选择规则、已知边界）+ §7 已知缺口更新（时间线动画已实现、general/effect 动画与 `mediaTimelineChanged` 仍不做）；`.agents/notes/implemented/feature/2026-10-30-media-integration.md` 决策笔记；README 特性一句话；`TESTING.md` 真机验收小节。
- 提交：按仓库约定小步提交（host / VM 事件 / 时间线动画 / 实例纹理 / 文档），全程 `npm test`、`npm run typecheck:tests`、`npm run verify:arch`、`npm run build:client` 绿。

## 14. 验收标准（DoD）

1. 无会话：目标壁纸白框消失（e2e 像素判据），媒体层全部隐藏。
2. 播放：封面显示且切歌更新、歌名/歌手更新、边框主色生效、淡入/滑入动画播放；暂停/停止/切歌响应正确。
3. 关闭开关：媒体层隐藏、watcher 不启动、无残留轮询。
4. 非 Windows/失败路径：媒体层隐藏、无白框、无未捕获异常、面板给出原因。
5. 回归：`2832263418`/`3793620838`/`2597392171` 对照无异常；其余壁纸既有 e2e 全绿。
6. 隐私：日志无 title/artist/album；封面与快照仅内存。
7. 性能：watcher 空闲 20s 退出；播放壁纸帧率不低于既有基线；动画求值 <50µs/帧。
8. 单测/类型/构建/架构守卫全绿。

## 15. 风险与缓解

| 风险 | 缓解 |
|---|---|
| PowerShell watcher 在部分机器被策略禁用（ExecutionPolicy/AppLocker） | `-ExecutionPolicy Bypass` + 常量 `-Command`；失败 → `no-powershell`/`watcher-failed` 降级隐藏，不影响渲染 |
| 自会话过滤误判（浏览器 GUI 的壁纸音效会话标题变化） | 以 `appId` + 页面标题双条件；已知边界写入文档；设置可关 |
| 多脚本装载改变 3 张壁纸行为 | 前后对照截图 + 保留「visible 优先」旧注释提示；异常即回滚该壁纸路径 |
| 时间线动画让既有壁纸动起来（Fog）与 WE 曲线不完全一致 | 视觉近似可接受；本机只有 3 张，人工对照；误差记入已知边界 |
| Chromium/Electron 的 SMTC 会话混入 | ownAppId 过滤 + pageTitle 过滤 + 文档边界 |
| 动画/事件与脚本写入的优先级错位 | 定死顺序（时间线 → 脚本 → 应用）并为每条写单测（含脚本覆盖时间线用例） |
