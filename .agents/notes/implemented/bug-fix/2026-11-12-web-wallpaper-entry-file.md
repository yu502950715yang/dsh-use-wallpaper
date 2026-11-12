# Agent Note: web 壁纸入口跟随 `project.json.file`

Status: implemented

## Problem

壁纸《荷塘观鱼 2.2完整版》（workshop `3818900270`，`type: Web`）在 DSH 里背景空白。`project.json` 的 `file` 是 `wallpaper.html`，而 client 的 `resolveBackground` web 分支写死 `webWallpaperUrl(info.id)`（默认 `index.html`）：iframe 恒请求 `/wallpapers/web/3818900270/index.html`，host 路由 404（同目录 `wallpaper.html` 实测 200）。本机 5 张 web 壁纸里只有这一张入口不是 `index.html`，故只有它坏。与 §5.53 的 scene 入口是同一类问题（2026-10-28 只修了 scene，web 分支没跟着改）。

## Decision

- `src/shared/routes.ts` 新增 `resolveWebEntryPath(file)`：接受壁纸目录内的相对路径（`\` 归一为 `/`，每段仅 `[A-Za-z0-9._-]`），含 `..`、绝对路径、空值、空格/`?#%` 等非法值一律回退 `index.html`；`webWallpaperUrl(id, file?)` 统一走它。
- `src/client/background-layer.ts` 的 web 分支改为 `webWallpaperUrl(info.id, info.file)`。入口名原本就在 `WallpaperInfo.file` 里由 scanner 下发（列表接口已返回），**零新增契约**。
- 新增两条回归用例（自定义入口 / 非法入口回退）；重建 `lib/` 与 `dist/client.js`（入库产物）。

## Affected repositories

- `dsh-use-wallpaper` 分支 `master` commits `256ab43`

## Alternatives considered

**在 host 的 `/wallpapers/web` 路由里做隐式回退（找不到 `index.html` 时改用 `project.json.file`）。** client 一行不用改，还能救旧缓存客户端。不用它：同一 URL 在不同壁纸上含义会变，契约变隐晦，且无法区分「真的没有这个文件」与「回退入口」；显式下发入口名可测。

**对 `wallpaper.html` 做白名单特判。** 不用它：WE 的 web 模板入口名不止一种，按 `project.json.file` 解析是参考实现的通用规则，和 §5.53 的 scene 入口口径一致。

**把入口名做成新的 `WallpaperInfo.webEntry` 字段（像 `sceneEntry`）。** 不用它：`file` 本来就下发且只有 web 分支消费它，多一个字段只是重复。

## Consequences

**收益：** 入口非 `index.html` 的 web 壁纸按真实入口渲染（e2e：生产 `lib/client` 装配后 iframe 画面为标准荷塘画面；对照组写死 `index.html` 时为 404 空白）。入口为 `index.html` 的 4 张 web 壁纸与全部 scene/video 壁纸零回归（缺省路径逐字节不变）。

**代价：** 入口名含空格 / 中文 / 百分号转义的 web 壁纸仍回退 `index.html`（host 路由按 URL pathname 取段、不解码百分号，支持它们要同时改服务端解码，未做）；入口名大小写按原样透传，靠 Windows 文件系统大小写不敏感兜底。
