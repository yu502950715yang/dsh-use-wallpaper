# 安全策略

本插件是跑在用户本机的 DSH（DeepSeek Harness）插件：host 侧是 DSH 进程内的 Node 插件，client 侧是浏览器 bundle。它**读取本机 Wallpaper Engine 安装目录与 Steam 工坊目录里的文件、注册本地 HTTP 路由、在浏览器里执行壁纸自带的脚本与网页**。这些能力决定了它的安全边界，本文如实写清边界与已知风险。

## 1. 支持版本

- **1.x**：只为最新 minor 提供安全修复（必要时发布 patch）。
- **0.x**：已在 GitHub Releases 归档，不再提供安全修复；仍在 0.1.x 上的用户请先升级 DSH 与插件（1.0 要求 DSH `>=0.2.0-rc.1 <0.3.0`）。
- 修复发布后会在 [GitHub Releases](https://github.com/yu502950715yang/dsh-use-wallpaper/releases) 与 [`CHANGELOG.md`](./CHANGELOG.md) 中注明（安全类条目不早于修复版本公开细节）。

## 2. 报告漏洞

**请优先使用 GitHub Security Advisories（私有渠道）**，不要开公开 issue：

👉 <https://github.com/yu502950715yang/dsh-use-wallpaper/security/advisories/new>

- 请在报告中给出：插件版本、DSH 版本、OS / 浏览器、复现步骤、影响（读到什么 / 能做什么）、最小 PoC。**不要附带你自己的壁纸路径、媒体曲目、个人截图等隐私数据**。
- 处理方式：尽力在 **7 天内确认**、**30 天内给出修复或缓解方案**（个人项目，不承诺 SLA）；修复发布后再公开细节，可协商署名或匿名。
- **不属于本插件安全问题**的情况，请走普通 issue：
  - 某张壁纸本身加载失败 / 样式错乱 —— 归壁纸作者（见 README「使用前请了解」；插件不会修改壁纸文件）。
  - 第三方 web 壁纸页面自身的行为 / 联网 —— 该页面是独立第三方网页。
  - 需要「攻击者已能在你本机以你的用户身份执行代码」才能成立的问题（本地插件无法防御同用户权限的本地攻击者）。
  - DSH 宿主 / 桌面壳本身的鉴权、token 与进程隔离问题 —— 请报给 DeepSeek Harness。

## 3. 威胁模型

| 组件 / 输入 | 是否可信 | 说明 |
|---|---|---|
| 本插件代码（`lib/` + `dist/client.js`） | ✅ 可信 | 由本仓库源码构建，`lib/`、`dist/` 入库并由 CI 校验与源码同步 |
| DSH 宿主 / 桌面壳 | ✅ 可信 | 进程隔离、鉴权、token 由 DSH 负责，本插件不额外加鉴权层 |
| 用户本机 WE 素材（`scene.pkg` / `.tex` / `.mdl` / `scene.json` / 材质 shader） | ❌ **不可信输入** | 解析器只读、容错；设计目标：越界/畸形素材只导致该壁纸降级，不执行其中内容、不影响宿主 |
| 壁纸自带 SceneScript / 脚本 | ❌ **不可信代码** | 在 QuickJS（wasm）沙箱内执行，见 §4.2 |
| web 壁纸页面（HTML/JS） | ❌ **不可信第三方网页** | 在跨源 iframe 内加载，见 §4.3 |
| 设置里的路径（壁纸目录 / WE 目录 / 开机动画本地视频） | ❌ 用户输入 | 只读取用户明确配置的路径；开机动画另有回环与网络路径限制 |
| 局域网 / 隧道访问 GUI 的访问者 | ❌ 不可信 | 本地路由默认按回环场景设计；跨机访问的残余风险见 §5.1 |
| 系统媒体信息（SMTC 曲目/封面）与系统音频 | 🔒 敏感数据 | 只在内存中供壁纸联动，不落盘、不发网络，见 §4.4 |

## 4. 安全边界（现状）

### 4.1 本地文件路由

host 侧注册的所有 `/wallpapers/*` 路由都是**只读本地文件 / 元数据**，读取范围限定在用户已配置的目录内；文件名与 id 一律白名单校验并做根目录二次前缀检查（防 `..`、绝对路径、软链绕过）。

| 路由 | 读取范围 | 防护 |
|---|---|---|
| `/wallpapers/boot/local-video`、`/wallpapers/boot/probe` | **只读设置里配置的单个本地视频路径**（profile config 的 `bootAnimationLocalPath`）；query 的 `path` 只能复述同一值，未配置或不一致一律 403 | **仅回环来源**：`remoteAddress` 与 `Host` 头都必须是 `127.0.0.1` / `localhost` / `::1`（防 DNS rebinding）；拒绝 UNC / 网络路径（含 `\\`、`//` 与混合分隔符，防 SMB/NTLM 凭据泄露）；要求绝对路径 + 扩展名白名单（`.mp4`/`.webm`/`.mov`/`.m4v`/`.ogv`）；Range/HEAD 流式 |
| `/wallpapers/scene/<id>/…` | 该壁纸目录内 `scene.pkg` 的条目 | id 白名单；资源名白名单且拒绝 `..`；`no-store` |
| `/wallpapers/media/<id>/…`、`/wallpapers/web/<id>/…` | 该壁纸目录内的 preview / 视频 / 网页静态文件 | id 白名单；逐段拒绝 `..`/绝对路径；结果必须落在壁纸目录内；HTML 只注入本插件的指针/声音 shim |
| `/wallpapers/particle-texture` | 壁纸 `scene.pkg` 或 `<WE>/assets/materials` 的纹理 | 路径白名单 + 根目录前缀校验；只能是 `.tex` |
| `/wallpapers/static/<file>` | 插件的构建产物目录（wasm / quickjs） | 单段文件名白名单 + resolve 后前缀校验 |
| `/wallpapers/frame/<id>` | 插件数据目录内的 `<id>.png` | id 正则（禁 `..`）；POST 仅 `image/png` 且单张 ≤12MB；原子写 |
| `/wallpapers/list`、`/wallpapers/probe`、`/wallpapers/properties`、`/wallpapers/now-playing*` | 元数据（壁纸列表、自动探测到的 Steam 路径、属性 schema、系统媒体快照） | 只读；不写文件、不执行壁纸内容 |

- **不提供任意文件读取**：没有任何路由接受「绝对路径 + 任意扩展名」并直接回文件。开机动画两条路由 1.0 起**只读 profile config 里配置的那一个路径**（`bootAnimationLocalPath`），query 的 `path` 只能复述该值——2026-11-10 加固：此前 `?path=` 允许任意绝对路径，而同源 web 壁纸 iframe 可以调用它把任意本地视频读成字节。
- **危险后缀一律二进制下载**：`.html` / `.svg` / `.js` / `.xml` 等可由浏览器执行/解析的后缀，在 scene / media 资产下载时强制 `application/octet-stream` + `Content-Disposition: attachment`；所有 `/wallpapers/*` 响应带 `X-Content-Type-Options: nosniff`（防「用户素材 → GUI origin 执行」的同源 XSS）。
- 写操作只有抓帧 `POST /wallpapers/frame/<id>`，且只写插件自己的数据目录。

### 4.2 壁纸脚本沙箱

scene 壁纸自带的脚本（SceneScript / 文本脚本）在 [QuickJS](https://bellard.org/quickjs/)（wasm）里执行，不是宿主 Node / 页面主线程的 `eval`：

- 运行时限制：内存上限 **1GB**、栈上限 **4MB**，并设指令预算中断（单次调用的死循环会被打断，不影响其它图层）。
- 宿主桥只暴露渲染所需的最小能力：读写场景图层状态（`origin`/`scale`/`angles`/`alpha`/`color`、可见性）、用户属性、动画与纹理动画控制、`engine.timeOfDay`、按壁纸 id 隔离的 `localStorage`（键前缀 `we:scenescript:<壁纸id>:`，浏览器 localStorage 配额/隐私模式下静默失败）。
- 脚本**不能**访问宿主 DOM、网络、文件系统或 Node API；能请求的资源只有当前场景包内的纹理（`particle-texture`/`scene-asset` 路由，pkg 未命中时回退 WE 引擎 assets 目录）。
- 解析器只把壁纸素材当数据：`.tex` / `.pkg` / `.mdl` / `scene.json` 的畸形输入不允许越界读或执行（有单测覆盖）。

### 4.3 web 壁纸 iframe

web 壁纸是第三方网页，加载在 **与宿主 GUI 不同源**的 iframe 里：

- 承载 origin 优先级（`background-layer.ts`）：① 桌面壳公布的宿主 HTTP origin（`__DSH_TRANSPORT__.streamBaseUrl`）；② 回环页换**另一个回环主机名**（`127.0.0.1` ↔ `localhost`）并探活；③ 其余（局域网 IP / 隧道）退回 **opaque origin**（`sandbox="allow-scripts"`，无 `allow-same-origin`）。
- iframe 与宿主页跨源，因此**拿不到宿主 GUI 的 DOM、localStorage、设置与插件 API 对象**；宿主与 iframe 的交互只有 `postMessage` 的指针坐标与声音开关/音量（只发给可见帧）。
- **承载 Host 绑定（2026-11-10）**：`/wallpapers/web/*` 若收到「已知 GUI 页面的 Host」（任一非 `/web` 插件路由被请求时记录），一律 403。否则壁纸 iframe 可以 `location.href` 导航回 GUI origin 的同一路径，拿回「GUI origin + 壁纸自己的 HTML」的组合，借 sandbox 的 `allow-same-origin` 访问 `parent.document`。承载 Host 是另一回环主机名，与 GUI Host 天然不同。
- 插件向 web 壁纸 HTML 注入的 shim（鼠标跟随、声音控制）是本插件的受控代码，只合成 mouse 事件、设置页内 `<audio>/<video>` 的 `muted/volume`；CSP 禁内联脚本的页面注入会被拦，插件保持网页原样。

### 4.4 不联网、无遥测、落盘边界

**本插件自身不联网、无遥测、不上传任何数据**（`src/` 内所有请求都是同源 `/wallpapers/*` 路由；host 侧不发起外网请求）。落盘只有两处 + 设置文件：

| 数据 | 位置 | 内容与生命周期 |
|---|---|---|
| 首帧抓帧缓存 | `~/.dsh-use-wallpaper/frames/<壁纸id>.png`（`DSH_USE_WALLPAPER_DATA_DIR` 可改根） | scene 首帧成功后的**壁纸画面**快照（不含 GUI 内容）；单张 ≤12MB、≤200 张，按修改时间淘汰；随时可删，删了下次渲染成功会重抓 |
| 浏览器本地状态 | localStorage：`we:fav` / `we:hidden` / `we:recent` / `we:userprop:<id>:<key>` / `we:renderfail:<id>` / `we:setup-tip` / `we:scenescript:<id>:<key>`；sessionStorage：`we:boot-played`（本次会话是否已播过开机动画，关页面即清） | 收藏 / 隐藏 / 最近使用 / 用户属性 / 渲染失败记忆 / 脚本存储；随站点数据清除 |
| 插件设置 | DSH profile `cordis.patch.yml` 的 `dsh-wallpaper-engine` 条目 `config` | 用户显式配置（含壁纸目录路径），由 DSH 管理 |

**只在内存、不落盘、不上传**：媒体集成读到的曲目/歌手/专辑/封面（可面板关闭；日志只含状态与原因计数，不含曲目信息）、系统音频频谱（浏览器 `getDisplayMedia` 授权，停止共享即清理）、壁纸音效解码数据、视频健康采样。桌面版 App 不可用系统音频（宿主权限策略），面板会提示改用浏览器。

### 4.5 供应链

- **依赖**：运行时依赖 4 个（`three` / `lz4js` / `quickjs-emscripten` / `@deepseek-ai/schemastery`）+ peer `@deepseek-ai/cordis`，版本锁定在 `pnpm-lock.yaml`；客户端打包进 `dist/client.js` 的第三方库及许可证见 [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md)（已用 `node -e` 读取 `node_modules` 的 license 字段核实）。
- **构建产物**：`lib/`、`dist/` 入库，CI 重跑构建并断言与入库产物零差异 —— 发布字节 = 源码构建字节；wasm 三件产物由 `dist/static/WASM_BUILD.json` 记录 sha256 与构建工具版本，发布前由 `scripts/check-release.mjs` 校验。
- **发布通道**：1.0 起由 tag 触发的 GitHub Actions 发布流水线执行门禁后 `npm publish --provenance`（OIDC `id-token: write`），npm 包带 provenance attestation，消费者可用 `npm audit signatures` 校验来源。历史 0.x 版本为手工发布，无 attestation。
- **更新**：`.github/dependabot.yml` 只自动跟 GitHub Actions（防止动作运行时漂移导致 CI 失败），npm 依赖由维护者人工审查升级；本包**没有 `postinstall` 等安装期脚本**。

## 5. 已知边界（按威胁模型接受，不算漏洞）

### 5.1 本地路由的鉴权责任在 DSH

除开机动画两条路由外，`/wallpapers/*` **不校验来源地址与 `Host` 头**（它们只暴露已配置目录内的素材与元数据，且没有任意文件读取）。这意味着：

- 默认只在本机回环使用 `dsh web` 时风险最低；
- 若把 `dsh web` 绑到 `0.0.0.0` / 通过隧道暴露，且 DSH 侧没有鉴权，则该服务上的本地素材路径、壁纸列表与正在播放的媒体信息可能被访问者读取；
- **建议**：不要在不可信网络上直接暴露只监听回环的服务；确实需要远程访问时，在反向代理/隧道侧加鉴权并限制到本人设备。

### 5.2 第三方 web 壁纸本身就是不可信网页

插件不限制 web 壁纸页面自身的脚本与网络请求（那是网页的固有行为），也无法在跨源 iframe 里审计它。**1.0 起**：它拿不到宿主 GUI 的 DOM / localStorage、不能借 boot 路由读任意本地视频、不能借 `/wallpapers/web` 导航回 GUI origin 取回自身 HTML；但它仍然同源，可以调用 `/wallpapers/list`、`/wallpapers/properties`、`/wallpapers/frame` 等只读元数据 / 抓帧路由（见 §5.1）。**只安装来源可信的 web 壁纸**；不需要 web 壁纸时直接选别的类型。

### 5.3 媒体集成会向壁纸暴露系统媒体信息

Windows SMTC 的曲目/歌手/专辑/封面会交给当前 scene 壁纸的脚本做联动（这是功能本身）。数据不发网络、不落盘，但**壁纸脚本可见**；不需要时在面板关闭媒体集成。会话选择是启发式的（可能误选到浏览器标签自身产生的音效会话），关闭开关即可。

### 5.4 系统音频只在浏览器 GUI 可用

桌面版 App 因宿主权限策略拿不到屏幕/音频捕获授权，插件直接返回失败并提示用浏览器；桌面版不存在绕过路径。

### 5.5 其它

- 抓帧 PNG 只抓**壁纸画布**，不含聊天内容与界面；但它是画面快照，介意时可不设壁纸或定期清理数据目录。
- web 壁纸没有失败回退（跨源 iframe 探测不到子帧错误），局域网/隧道访问时依赖 WebGL 贴图的 web 壁纸会因 opaque origin 限制空白 —— 属功能边界，不是安全问题。
- 壁纸 shader 来自第三方素材，编译失败只会跳过该效果并告警，不会在宿主里执行任意代码。

## 6. 清理与自检

- 彻底卸载后清理残留（不清理也不影响使用）：删 `~/.dsh-use-wallpaper`（或 `DSH_USE_WALLPAPER_DATA_DIR` 指定的目录）、清 localStorage 的 `we:` 前缀键、从 profile `cordis.patch.yml` 移除 `dsh-wallpaper-engine` 条目。命令见 README「卸载」。
- 自检：设置 → Wallpaper 壁纸 → 实时渲染 card 查看渲染健康状态；`window.__wallpaperEngine.health()` / `.videoHealth()` 可打印同一份快照。1.0 起面板「关于」提供「复制诊断信息」（**不含个人路径与媒体信息**），贴 issue 前请先自行检查内容。

## 7. 变更记录

安全边界的变更（新增本地路由、放宽路径限制、变更沙箱配置、依赖升级）必须在 PR 中说明，并同步本文与 `CHANGELOG.md`。
