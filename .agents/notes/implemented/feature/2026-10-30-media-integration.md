# Agent Note: 媒体集成（Windows SMTC）+ SceneScript media 事件 + 时间线属性动画

Status: implemented

## Problem

壁纸 `3797976859`（小作 2(有声)）在插件里常驻一个白色方块：它的 5 个媒体图层（封面框 / 封面 / 歌名 / 歌手 / 媒体区）的隐藏逻辑只挂在 `mediaPlaybackChanged(PLAYBACK_STOPPED)` 上，而本插件从未派发任何媒体事件；`$mediaThumbnail` 实例纹理也未实现，封面回退成 `util/white` 纯白。同时 `{animation}` 时间线轨道从未解析，媒体层的淡入/滑入与 Fog 的 loop 漂移都不会播放。设计见 [2026-10-30-media-integration-design.md](../../../../docs/superpowers/specs/2026-10-30-media-integration-design.md)，实施计划见 [2026-10-30-media-integration.md](../../../../docs/superpowers/plans/2026-10-30-media-integration.md)，现状契约见 `AGENT.md` §5.54。

## Decision

- **host 常驻 watcher、懒启动、空闲退出**：仅 win32；首个 `now-playing` 请求才 spawn 一个 PowerShell（WinRT SMTC，每 700ms 采样，只在会话签名变化时输出一行 JSON，封面随行携带、单张 ≤512KB）；单实例、空闲 20s 退出（5s 检查一次）、异常退出由下一次轮询重新拉起（启动失败 5s 退避，60s 内 3 次失败降级 60s），插件 dispose 时 kill。数据只留在内存，**不落盘、不写日志**（日志只允许状态/原因计数），路由 `GET /wallpapers/now-playing?title=…` 与 `GET /wallpapers/now-playing/thumbnail?rev=N`。
- **客户端 1s 轮询而不是 SSE**：快照本就是 host 内存里的一个 GET，1s 本地轮询毫秒级；SSE 要维护 host→多标签页的事件流、重连与生命周期，收益不抵复杂度。仅当装配期判定「场景需要媒体」（媒体事件脚本或 `$mediaThumbnail`）才创建轮询，其余壁纸零请求。
- **会话选择的启发式**：`selectSession` 先剔除自身 `appId`（`path.basename(process.execPath)`）与 `title === document.title` 的会话（Chromium 为壁纸音效 `<audio>` 注册的自会话），再按 playing > paused → artist 非空 → 最近变化排序。页面标题过滤不可能完备，边界写入 `AGENT.md` §5.54/§7.44 并由面板开关兜底。
- **rev 语义 = 「封面变化」而非「递增序号」**：host 的 rev 全局单调、仅作内存缓存键；客户端只做 `!==` 比较（回退也算变化），不假设顺序或单调，避免关→开、淘汰后重取时把「不同图」误判成同一张。
- **事件层**：`SceneScriptHost/VM` 派发 `mediaPlaybackChanged` / `mediaStatusChanged` / `mediaPropertiesChanged` / `mediaThumbnailChanged`，`MediaPlaybackEvent` 常量按 WE 官方 **0/1/2 = stopped/playing/paused**；每对象多脚本（visible + 属性脚本不再互相丢弃）；`thisObject.getAnimation()` 返回时间线播放器；文本脚本额外广播 `mediaPropertiesChanged`。
- **时间线只覆盖 layer 属性**：`scene-timeline.ts` 解析 `alpha/origin/scale/angles/color` 的 `{animation:{c0,c1,c2,options}}`，支持贝塞尔（按本机样本校准的近似）、single/loop/mirror、startpaused、relative、父子 `parent/children` 与 `name`；时序固定为「时间线写状态表 → 脚本 tick 覆盖 → 重算世界变换」。**keep-out**：`general.*` / effect / material 属性不做（本机唯一受影响的 `3812518176` 的 `general.bloomstrength` 保持静态），隔离对象合成 quad 不做世界变换，粒子只应用 origin 平移。
- **封面 flipY 约定**：`createImageBitmap(blob, { imageOrientation: 'flipY' })` + 共享纹理 `flipY = false`——ImageBitmap 上传忽略 `UNPACK_FLIP_Y_WEBGL`，若再翻一次就是上下颠倒；所有 `$mediaThumbnail` 对象共享同一张 `THREE.Texture`，切歌先清旧图再设新图；主色用客户端 32×32 直方图 + 3 类 k-means 启发式（非 WE 原算法）。
- **R7：PowerShell 泛型名必须双反引号**（`"IAsyncOperation``1"`）：单反引号在 PS 双引号串里是转义符，会被吞成 `IAsyncOperation1` ⇒ `$asTask` 为 null、watcher 启动即 `Cannot index into a null array.`（Task 1 实测）。
- **R8：`lib/**` 与 `dist/**` 随提交**：本仓 `lib/` 是 npm 分发产物且纳入版本控制，改 `src/` 的每个 Task 都要 `npm run build` 并把对应 `lib/**` 变更随提交；`dist/client.js` 只在 client 变化时重建并提交。
- **Task 7 的 alpha 回滚在 Task 10 解除**：属性脚本的 media 回调常先写 `alpha=0` 再播放淡入；Task 7 尚无时间线，写入会永久透明 ⇒ 无 timeline 时只回滚这次 alpha≈0 写入（其余属性照常）。Task 10 起含动画场景会传入 timeline ⇒ 回滚自动解除（淡入交给时间线）。
- **基线红处置**：`tests/verify-real-library.test.ts` 曾对 `3797976859` 报 `materials/util/solidlayer_instance.json` 不存在——该材质由 WE 引擎目录在运行时提供（host 路由 pkg → `<WE>/assets` 两级查找），不是 pkg 链断。测试改为「已知引擎前缀（`materials/util/`）的缺失材质视作引擎提供、不计入 evidence」，其它缺失仍判红，并加确定性单测断言。

## Alternatives considered

**每次请求短命 spawn PowerShell / 用 `exec` 一次性查询**：冷启动约 1.2s，而客户端 1s 轮询意味着几乎每个请求都要冷启动，成本与进程抖动不可接受；否决。

**SSE / WebSocket 推送**：见 Decision——快照本身是内存读取，1s 轮询更简单，失败退避与多标签页生命周期都无需新机制；否决。

**客户端直接读取 SMTC**：浏览器没有 WinRT/SMTC 能力，只能 host 侧读；否决。

**host 侧解码封面并取主色**：host 没有 canvas/图像库，且主色要跟随渲染纹理与切歌时序；client 侧 `createImageBitmap` + 32×32 直方图更直接、失败可降级中性色；否决。

**严格逐位复刻 WE 的贝塞尔/取色算法**：本机样本与权威参考不足，先按样本校准近似、以真机视觉验收兜底，边界写入文档；否决「一次做到位」。

**用轮询结果动态决定是否启动媒体**：那会让无媒体壁纸也先发一次请求；改为装配期静态判定 `sceneNeedsMedia`，把「零开销」做成结构性承诺；否决。

## Consequences

**收益：** 目标壁纸白框消失、播放时封面/歌名/歌手/主色/淡入滑入联动；时间线让 3 张既有壁纸中的淡入与 Fog loop 真正播放；无媒体脚本的壁纸零请求；媒体数据只在内存。

**代价：** 仅 Windows 有数据源；只读不控、不派发 `mediaTimelineChanged`；色板与贝塞尔都是近似；页面标题过滤可能误选（可关开关）；watcher 活跃时多一个 PowerShell 进程（约 30–60MB）；`color` 时间线已接线但本机无真实样本；隔离对象与 `general.*` 时间线仍缺。基线红处置放宽的是「已知引擎前缀」，其它证据不变。

## Affected repositories

- `dsh-use-wallpaper` 分支 `master` commits `fe9243c` `7ffd6f7` `1a60219` `6a7e7ff` `d06bc49` `0954b16`
