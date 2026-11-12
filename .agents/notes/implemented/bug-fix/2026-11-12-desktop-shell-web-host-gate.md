# Agent Note: 桌面壳的 GUI 请求不参与 `/wallpapers/web` 承载 Host 绑定

Status: implemented

## Problem

入口名修复（[web 壁纸入口跟随 project.json.file](./2026-11-12-web-wallpaper-entry-file.md)）之后，用户在**桌面版**里仍看不到任何 web 壁纸（本机样本：荷塘观鱼 `3818900270`）。

桌面壳（`dsh-app://app`）把该协议下的插件请求经 Electron `forwardWebRequest` 代理到宿主 HTTP 服务，代理请求的 `Host` = 宿主 HTTP origin（并显式删除 `sec-fetch-site`；`Sec-*` 本身也是 fetch 禁止头）。1.0.0 的 S2 加固（2026-11-10）把这些请求的 Host 登记进 `guiHosts`，而**桌面 iframe 的承载 origin 恰恰就是这个宿主 HTTP origin**（`planWebFrameOrigin` 的 transport 分支，`__DSH_TRANSPORT__.streamBaseUrl`）⇒ `/wallpapers/web/*` 对桌面 iframe 恒 403，所有 web 壁纸空白。加固设计文档 §5 原判断「桌面版不参与 HTTP Host 判定，无影响」，与实现不符。

## Decision

- `rememberGuiHost` 只登记**浏览器直接发起**的请求（判据：带 `Sec-Fetch-Site`）。桌面壳的代理请求不带该头，不登记 ⇒ 桌面 iframe 以 transport origin 访问 `/web` 恢复 200。
- web 版的安全判据不变：`dsh web` 的 GUI 直连请求都带 `Sec-Fetch-Site`，登记照旧；壁纸 iframe 自我导航回 GUI origin 的逃逸请求同样带该头，仍命中 `guiHosts` ⇒ 403。
- 保留 `planWebFrameOrigin` 的桌面分支（宿主 HTTP origin 权威、不探活），不改承载 origin：根因是登记口径，不是 origin 选择。
- 回归用例：`tests/security-sandbox.test.ts` 新增「桌面代理请求（无 Sec-Fetch-Site）⇒ `/web` 200」；原 403 用例改注为浏览器直连（补 `Sec-Fetch-Site`）。

## Affected repositories

- `dsh-use-wallpaper` 分支 `master` commits `d8e3c91`

## Alternatives considered

**桌面 iframe 改承载到「另一回环主机名」（`localhost:port`）。** 不动安全闸门，但要新增探活，并依赖 `localhost`→`127.0.0.1` 的解析/回退与自定义协议页的 fetch/CSP 行为（未验证面变大）；也与既有决策「桌面壳用宿主 HTTP origin（权威、不探活、绕开 dsh-app 代理丢 `content-length`）」冲突。

**在 `/web` 判定时按 `Sec-Fetch-Site` / `Referer` 区分。** 桌面 iframe 首次加载与 web 版逃逸导航都是 iframe 导航、都带 `Sec-Fetch-Site`，区分不可靠；只有**记录侧**（代理请求没有 `Sec-*`）有稳定信号。

**放宽或删除 S2 闸门。** 会重新打开「壁纸导航回 GUI origin 取回自身 HTML 进而读 `parent.document`」的逃逸路径（1.0 已修），不能回退。

## Consequences

**收益：** 桌面版 web 壁纸恢复（iframe 承载 origin 的 `/web` 请求 200）；web 版闸门语义与判据不变。

**代价 / 边界：** ① 判据依赖「DSH 桌面壳经 Electron fetch 代理插件请求」这一实现（已在 `resources/app.asar` 的 `forwardWebRequest` 核对）；若未来改成浏览器直连，桌面 Host 会重新被登记、桌面 web 壁纸再 403，需按 §5.60 重设。② 同一宿主同时被浏览器以 GUI 方式打开时，该 Host 会被登记、桌面 iframe 仍 403（桌面 host 仅回环可达，属边缘场景）。③ 中间层若剥离 `Sec-Fetch-*`，web 版的闸门不会 arm；该部署形态（非回环访问）本就落 opaque origin 兜底，S2 的目标场景（回环双主机名）不触发。
