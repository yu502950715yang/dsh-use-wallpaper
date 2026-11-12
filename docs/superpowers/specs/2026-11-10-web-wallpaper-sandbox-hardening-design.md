# web 壁纸沙箱加固（S1/S2）设计

> 日期：2026-11-10 ｜ 来源：`docs/fixes/audit-2026-11-10-summary.md` P0-1 / P0-2 / P2-8 ｜ 状态：已批准实现

## 1. 要修的两个漏洞

**S1 — 不可信 web 壁纸可读任意本地视频**：壁纸 iframe 承载在「另一回环主机名」（`localhost:port`），而插件路由在同一 DSH webserver 上 ⇒ iframe 内 `fetch('/wallpapers/boot/local-video?path=…')` 是同源请求，`isLoopbackRequest`（remoteAddress + Host 都只判「是否回环」）无法区分 GUI 与壁纸 iframe，`?path=` 接受任意绝对路径 ⇒ 任意本地视频被读成字节。

**S2 — web 壁纸 iframe 可逃逸到 GUI origin**：`/wallpapers/web/<id>/...` 在 GUI 主机名上同样可访问（无 Host 校验）⇒ 壁纸 `location.href` 导航到 GUI origin 的同一路径，拿回的是**壁纸自己的恶意 HTML**，此时 origin = GUI origin 且 sandbox 的 `allow-same-origin` 仍在 ⇒ 可访问 `parent.document` / `localStorage`。同源 XSS 还有两个入口：`/scene/<id>/asset?name=evil.html`（`mimeOfAsset` 返回 `text/html`）与 `/media/<id>/file` 指向 `.html`。

## 2. 方案（不做 B2：保留 WebGL 贴图类 web 壁纸）

### A1 — boot 路由只读配置的路径

- `/boot/local-video` 与 `/boot/probe` 不再信任 `?path=`：从 `state.bootAnimationLocalPath`（= profile config 值，volatile 活引用）取唯一允许的路径。
- `?path=` 可继续传（client 无需改），但 **trim 后必须与配置值逐字相等**，否则 403 `path not configured`。
- 配置为空 ⇒ 403（未配置不得读任何文件）。
- `resolveBootVideoPath` 的现有校验（绝对路径 / UNC / NUL / 扩展名白名单）保留——用户手写配置的非法值仍在 probe 阶段被拒。

### B1 — `/wallpapers/web` 的承载 Host 绑定 + 危险 MIME 收紧

- 记录「GUI host 集合」：任一非 `/web` 的插件路由被请求时，把其 `Host` 头记入 `guiHosts`（上限 8 个，FIFO）。
- `/wallpapers/web/*` 请求：若 `Host` ∈ `guiHosts` ⇒ **403**（这是从 GUI origin 发起、想拿壁纸文档的逃逸尝试）；否则按承载 host 放行。
- 壁纸加载顺序保证 `guiHosts` 已就绪：client 是「先 `load()` 列表、再 `select()`」（`index.ts:376-377`），`/list` 先于 iframe 创建。
- MIME 收紧（统一在 `mimeOfAsset` / `sendSceneAsset` / thumbnail）：
  - `.html` / `.htm` / `.svg` / `.js` / `.mjs` / `.xml` → `application/octet-stream` + `Content-Disposition: attachment`；
  - 所有响应加 `X-Content-Type-Options: nosniff`；
  - thumbnail 的 `art.contentType` 只允许 `image/*` 白名单，其余回落 `image/png`，并 strip CR/LF。

## 3. 行为契约（before → after）

| 请求 | 之前 | 之后 |
|---|---|---|
| `GET /boot/local-video?path=<任意合法视频>`（配置为空或不同） | 200 + 字节 | **403** |
| `GET /boot/local-video?path=<配置值>` | 200 | 200 |
| `GET /boot/local-video`（无 query，配置非空） | 400（path 缺失） | 200（用配置值） |
| `GET /web/<id>/index.html`（Host = 承载 host） | 200 | 200 |
| `GET /web/<id>/index.html`（Host = 已知 GUI host） | 200 | **403** |
| `GET /scene/<id>/asset?name=evil.html` | 200 `text/html` | 200 `application/octet-stream` + attachment |
| `GET /now-playing/thumbnail`（ContentType 非 image/*） | 原样透传 | `image/png` |
| 任意路由响应 | 无 nosniff | `X-Content-Type-Options: nosniff` |

## 4. 测试策略（TDD）

- 新增 `tests/security-sandbox.test.ts`：覆盖上表每一行（先写、先红）。
- 更新 `tests/boot-asset.test.ts` 的 15 个 boot 用例：改为注入 `state.bootAnimationLocalPath`，query 与配置一致 / 不一致两条路径。
- 更新 `tests/routes.test.ts` 中受 `guiHosts` 影响的 `/web` 用例（补 Host 区分断言）。
- 全量 `pnpm test` + `typecheck:tests` + `verify:arch` + `e2e:colorblend`。

## 5. 影响面

- 用户可见行为：开机动画选文件流程不变；web 壁纸正常加载不变；WebGL 贴图类壁纸保留。
- 边缘变化：直接在 GUI 同源打开 `/wallpapers/web/<id>/index.html` 会 403；构造未配置的 boot path 会 403（即攻击面）。
- 桌面版 App：GUI origin 为 `dsh-app://`，不参与 HTTP Host 判定，无影响。
  - **2026-11-12 勘误（实现与本节假设不符，已修）**：桌面壳仍会把 `dsh-app://app` 的插件请求代理到宿主 HTTP 服务（`forwardWebRequest`），其 Host 被原实现登记进 `guiHosts`；而桌面 iframe 的承载 origin 正是同一个宿主 HTTP origin ⇒ 桌面版所有 `/wallpapers/web` 请求恒 403（荷塘观鱼 `3818900270` 用户报告）。修法：`guiHosts` 只登记**浏览器直接请求**（带 `Sec-Fetch-Site`）；桌面壳代理请求不带该头（Electron fetch 代理显式删除 + `Sec-*` 为 fetch 禁止头），不再登记。本节「不参与 HTTP Host 判定」的意图由此落实。

## 6. 残留边界（不在本次修复）

- iframe 与插件 API 仍同源：壁纸仍可同源调用 `/list`、`/properties`、`/frame` 等（`SECURITY.md §5.1` 已记录的已知边界）。彻底消除需 opaque origin（B2）或独立端口（DSH 不支持）。
- 壁纸导航到 DSH GUI 首页（`/`）：得到的是 DSH 自己的页面（非恶意文档），不构成同源执行。
