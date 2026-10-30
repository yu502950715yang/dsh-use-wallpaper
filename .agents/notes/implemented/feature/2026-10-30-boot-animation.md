# Agent Note: 开机动画（独立全屏层 + 视频/图片素材 + 四种展示方式）

Status: implemented

## Problem

插件名为 Wallpaper Engine，却只有「会话背景」这一块能力；用户想要的是打开 DSH 时的一段片头。日常壁纸与开机片头的诉求彼此独立（素材、时长、开关都不同），若复用背景层状态，任何一侧的改动都会互相污染（轮播 / 暂停 / 健康状态 / 文字颜色）。设计见 [2026-10-30-boot-animation-design.md](../../../../docs/superpowers/specs/2026-10-30-boot-animation-design.md)，实施计划见 [2026-10-30-boot-animation.md](../../../../docs/superpowers/plans/2026-10-30-boot-animation.md)，现状契约见 `AGENT.md` §5.55 / §7.45。

## Decision

- **独立全屏层，不复用背景层**：`.wp-boot-layer` 由 `boot-overlay.ts` 单独创建（`position:fixed;inset:0;z-index:2147483000`），不写 `body[data-we-wallpaper]`、不调 background-layer 的 `setFitMode/setPaused`，因此壁纸的轮播、暂停、健康状态、文字颜色与省电档位都不受开机动画影响；播完移除后 DOM 与加功能前一致。代价是两套播放器各自维护（可接受：语义本就不同）。
- **只做 video / image，不在片头里实时渲染 scene**：WE scene 需要 wasm/three 装配，冷启动首帧慢，与「8 秒内必须结束或静默」直接冲突；scene / web 壁纸在面板里不出现。视频走现有 `/wallpapers/media/<id>/file`（页面按 id 解析 `project.json.file`），图片走 `/wallpapers/media/<id>/preview`。
- **本地视频仅回环来源，且拒绝 UNC / 网络路径（final fix wave 加固）**：本地路径由宿主代读（浏览器不能直接打开任意路径），所以 `/wallpapers/boot/local-video` 与 `/wallpapers/boot/probe` 要求**来源地址 + `Host` 头都是回环主机**（`127.0.0.1` / `localhost` / `::1`）——DNS rebinding 页面的连接同样来自本地套接字，只查 `remoteAddress` 挡不住；并拒绝 `\\host\share` / `//host/share` / `\\?\` 前缀（否则宿主会发起 SMB/NTLM 连接），再加扩展名白名单 `{.mp4,.webm,.mov,.m4v,.ogv}` 与绝对路径校验。流式与校验两条路由共用 `resolveBootVideoPath`，保证 400/404 同口径。
- **固定静音、每页面会话一次、8 秒超时静默**：`muted + playsInline`（自动播放策略下不提供声音开关）；`sessionStorage['we:boot-played']` 在真正播放前写入，刷新 / HMR 不重播，面板「试播」（`force`）绕过开关与标记；素材 8s 未就绪、路径无效、解码失败一律静默交接（`timeout` / `failed`），绝不把主界面压在黑屏上。
- **结果只记内存**：`getLast()` 供面板「上次播放」显示结果；不落盘、不写日志（路径不回显）。
- **面板独立 section（`wbs-*`）**：与「Wallpaper 壁纸」并列（order 20 / 21），新类名避免动到现有 `wss-*` 契约；「视频不支持平铺」在面板禁用，而不是运行时纠正。
- **自动化门禁口径**：host 纯函数与路由、overlay / player / panel 单测，加上 bootstrap 级生命周期用例（真实 `ctx.effect` 收尾、启用配置下自动起层且 mount 清理不误删、`settings.section` 只能在 `inject` 回调内注册）；真机验收见 `TESTING.md` §2.18（当前未执行）。
- **放弃项**：scene 实时渲染（用户明确排除）、声音开关（自动播放策略）、多素材轮播 / 开机音频 / 按星期分时段（后续增强，未实现）。平铺只实现图片（背景图 `repeat`），视频的平铺在面板禁用。

## Errata

- **`start()` 位置（final fix wave）**：初版在 bootstrap 顶部 `void start()`，早于 `mount()` 的 `dropStaleLayers()`；真正的竞态窗口是 `readyState === 'loading'`（mount 延后到 DOMContentLoaded，起播先建层、清理随后误删），`complete` 时 mount 同步先跑、顺序恰好安全。现移入 `mount()`、`dropStaleLayers()` 之后，语义等价（仍尽早、不 await），顺序确定。
- **设置字段防御（final fix wave）**：`bootAssetFromSettings`（`.trim()`）与 `normalizeBootFit` 的调用纳入 try/catch —— 旧版本 / 手工写入的非 string 字段不再把异常漏出 `start()`（`void` 调用下就是 unhandled rejection），按 `failed` 静默。
- **spec 4 处口径修正（final fix wave）**：删除非法回环地址 `::ffff:::1`（回环集合 = 3 个地址）；`play(asset, fit)` → `play(asset, fit, maxDurationMs?)`；`window.__wallpaperEngineBoot` 删除不存在的 `result` 字段；面板「上次播放」改为只显示结果（时间 / 素材为后续增强）。

## Alternatives considered

**复用 `.wp-background-layer` 播片头**：能省一套播放器，但背景层承载 fit / 暂停 / 轮播 / 健康状态与 `body[data-we-wallpaper]` 契约，播完还要「恢复」壁纸，失败路径会把主界面拖黑。隔离是更便宜的方案；否决。

**把片头做成 scene 渲染**：视觉上限更高，但冷启动装配 + wasm 下载与 8s 静默超时直接冲突，且用户明确只要视频 / 图片；否决。

**仅用 `remoteAddress` 判回环**：不足以挡 DNS rebinding（攻击页面的连接同样来自本地套接字）；补 `Host` 头校验与 UNC 拒绝只多两行纯函数；否决「只查来源地址」。

**把本地路径交给前端 `<video src="file://...">`**：浏览器 GUI 无权限，且桌面壳暴露 file 协议会放大攻击面；宿主代读 + 白名单更可控；否决。

**开机音频 / 声音开关**：自动播放策略下带声播放会被拦截，做了也多半静默失败；固定静音；否决。

## Consequences

**收益：** 开机动画与日常壁纸完全独立（默认关闭时零 DOM、零请求）；WE video / image 与本地 mp4 三类素材、四种展示方式；失败 / 超时 / 跳过都不阻塞主界面；本地文件路由有来源 + `Host` 双闸门与 UNC 拦截。

**代价／已知边界：** 桌面壳自身启动闪屏无法替换，两者可能各闪一次；固定静音；平铺仅图片；`getLast` 只有结果，时间 / 素材列为后续增强；面板「校验」不做编码探测（只看扩展名与存在性）；overlay 覆盖缺口（stretch→fill 断言、图片 min 分支、video error、监听摘除等）、autoplay 拒绝兜底与面板八项细节按 final review 记为 deferred，见本轮 final fix 报告的「剩余 concern」。

## Affected repositories

- `dsh-use-wallpaper` 分支 `feat/boot-animation` commits `51bac74` `62d8bf8` `dd891b7` `0046d55` `66d595a` `3c99e97`（最终修复轮代码/测试与产物）+ 本笔记所在的文档提交
