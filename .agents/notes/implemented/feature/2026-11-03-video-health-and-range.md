# Agent Note: 视频壁纸可观测性与 Range 路由

Status: implemented

## Problem

视频壁纸（当前素材 4K60、16.9s 循环）在真机出现「偶发卡顿」时，插件没有任何现场指标可看：`<video>` 的 fps、丢帧与循环点停顿只能靠外部 GPU 计数器 / headless 侧写反推；设置面板只有 scene 的健康行，视频壁纸完全不显示状态。另外 `/wallpapers/media/<id>/file` 是 `readFileSync` + 200 全量，与同文件的场景素材路由（`sendSceneAsset`，已支持 Range/206/HEAD/流式）口径不一致——`<video>` 的 loop seek 能否廉价回绕取决于数据源是否可 seek，且大文件同步读会阻塞 host 事件循环。

## Decision

- **视频路由复用场景素材管线**：`GET /wallpapers/media/<id>/file` 保留 `project.json` 解析、file 名校验（400）与存在性（404），改为 `statSync` + `{size, readAll, openRange}` 交给 `sendSceneAsset`；`.mp4 → video/mp4` 自动流式，`preview` 分支不动（图片仍 200 全量）。
- **新增 `src/client/video-health.ts` 只读采样**：`createVideoHealthMonitor({now, sampleIntervalMs=1000, tickIntervalMs=100, maxLoopStalls=5, timers})` 返回 `attach/detach/snapshot/dispose`。fps / 丢帧取 `getVideoPlaybackQuality()` 两次采样的增量；循环点用 100ms `currentTime` 采样判定（上一拍 > duration×0.75、本拍 < ×0.25），停顿取两次采样的墙钟差；8 类媒体事件记 `lastEvent`；状态优先级 `lost > paused > stalled(5s 窗口) > ok`。attach 先同步打一拍基线（fps 只算增量、起播位置不误判为回绕），detach 清定时器与监听。
- **接线**：`BackgroundLayer.getVideoHealth()` 随 `<video>` attach/detach；`index.ts` 暴露 `window.__wallpaperEngine.videoHealth()`，并向设置面板注册 `WallpaperVideoHealthHandler`（teardown 撤销）；面板「实时渲染」卡片在视频壁纸期间显示一行「分辨率 · 实测 fps · 近 1s 丢帧 · 最近循环停顿」（1s 轮询，与媒体集成状态行同口径）。契约见 `AGENT.md` §5.56。

## Affected repositories

- `dsh-use-wallpaper` 分支 `master` commits `9ca50c1`

## Alternatives considered

**只用 `requestVideoFrameCallback` 测帧间隔。** 最贴近「呈现帧」语义，能同时看到丢帧与循环点。但实测 rVFC 在 loop seek 时会中断回调链（40 秒内一个循环点都没捕到），无法可靠记录 loop 停顿；改回 `currentTime` 轮询，牺牲精度（100ms 分辨率）换稳定性。否决 rVFC 单方案。

**面板用推送订阅。** 与 scene 健康行一致、无轮询开销。但视频健康每 100ms 变化，推送会让面板高频重渲染，而面板大多时候不打开。与媒体集成状态行同样用「挂载时读一次 + 1s 轮询」，够用且实现最小。否决推送。

**加 `webkitDecodedFrameCount` 兜底。** 老 Safari 需要，但本项目 GUI 只跑 Chromium/Electron（DSH），加分支无收益。未做。

**host 侧 ffmpeg 转码降码率/分辨率。** 能从根上降低 4K60 解码成本，但仓库明确不做 ffmpeg（`AGENT.md` §5.41），依赖与体积代价大。否决；降载仍靠素材替换与系统侧（避免 WE 本体双播）。

**只加面板状态、不改视频路由。** 改动更小。但视频 file 路由的无 Range / 同步整读是与场景素材不一致的真实缺口（loop seek、拖动进度条），顺手补齐比留已知坑更便宜。否决。

## Consequences

**收益：** 视频壁纸下一次卡顿可直接在面板或 `window.__wallpaperEngine.videoHealth()` 看出是解码掉帧还是循环点停顿；视频路由与场景素材同口径支持 Range/206/416/HEAD，loop seek 不再受 200 全量数据源限制，也去掉整文件同步读阻塞 host 事件循环的路径。

**代价／已知边界：** 循环停顿分辨率 = tick 间隔（100ms），不是精确帧时间；面板状态行只在视频壁纸期间显示（非视频返回 null 隐藏）；`getVideoPlaybackQuality` 缺失/抛错时读 0 不抛；attach 后累计计数是元素自创建以来的值（面板显示窗口增量 fps 与累计丢帧）。**既有问题（本次未修）：** 本机 `intent-notes` 门禁 3 有 3 篇存量笔记锚点不合法（不存在的分支 / 行格式），与本次改动无关；改它们会牵动历史提交哈希，留给归档清理。
