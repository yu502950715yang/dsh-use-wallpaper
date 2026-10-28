# Agent Note: 壁纸音频随暂停一起挂起

Status: implemented

## Problem

最小化/切后台的「省电暂停」（`pauseOnHidden`）早就实现了：`visibilitychange` 触发 `setPaused(true)`，scene 的 rAF 帧循环停掉、视频元素 pause、轮播停表。但 `player.pause()` 只停 `setAnimationLoop(null)`——**壁纸音频完全没有被触碰**（`PlaybackHandle` 只有 `stop()`），所以最小化后画面冻结、BGM 却继续播放。用户感知上就是「最小化没有暂停」。

## Decision

暂停路径统一挂起 scene 音频，恢复时从原位置继续：

- `AudioAnalyzer.setSuspended(suspended)`：`context.suspend()/resume()`，失败静默（autoplay 可能拒绝 resume）。解码路径（`AudioBufferSourceNode`，无 pause API）靠 context 时钟冻结。
- 流式 `<audio>` 句柄新增可选 `pause()/resume()`：`el.pause()` / `el.play()`。**必须显式暂停元素**——`context.suspend()` 不会停 MediaElement 的时钟，否则恢复后音乐已经跳过暂停时长。
- `three-renderer.setPaused` 同步音频（先挂句柄再挂 context；恢复先 resume context 再续播句柄）；装配期已暂停（最小化中换壁纸）与暂停期间迟到的异步句柄都立即挂起，避免突然出声。
- 手动「暂停壁纸（省电）」走同一路径，因此现在也会停音频（此前只停画面）。

## Affected repositories

- `dsh-use-wallpaper` 分支 `master` commits `a9f95d5`

## Alternatives considered

**只调 `context.suspend()`。** 改动最小，一条链路能冻结所有音频图（含解码路径）。不采用：`<audio>` 元素由 MediaElement 自己的时钟驱动，context 挂起期间它仍在走，恢复后音乐从「暂停前位置 + 暂停时长」处继续，等于跳过了最小化那段时间。

**复用 `setSoundEnabled(false/true)` 停声/重播。** 现成接口、无需新增。不采用：它会 `close()` AudioContext 并在重开时从头播放，既不符合「续播」，也会把用户「音效开关」的设置语义与临时暂停混在一起。

**给解码路径也实现 pause（重建 BufferSource 并记录 offset）。** 语义最精确。不采用：`AudioBufferSourceNode` 没有 pause API，重建要跟踪每个源的 offset/循环/音量，代码量与失败面远大于 `context.suspend()` 一行。

**在 `index.ts` 的 `applyRuntimeSettings` 里直接调 `setSoundEnabled`。** 不动 renderer。不采用：会把「省电暂停」错误地映射成用户设置里的音效开关（还可能污染 `soundEnabled` 的持久值），状态来源混乱。

## Consequences

**收益：** 最小化/切后台/手动暂停后彻底静音，恢复从原位置续播；迟到的异步音频句柄不会在暂停中突然出声；无 Web Audio 或 resume 被拒时静默降级，不阻塞画面。

**代价：** web 壁纸 iframe 内的音视频仍不可控（跨源，插件无法暂停）；系统音频采集（visualizer 的 `getDisplayMedia`）不受暂停影响（独立 AudioContext）；极低概率恢复时 `el.play()` 被自动播放策略拒绝，表现为保持静音直到下一次用户交互。
