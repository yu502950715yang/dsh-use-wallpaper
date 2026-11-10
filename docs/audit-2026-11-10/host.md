# 主机侧审查（host）

> 范围：`src/host/**` 全部文件 + `src/shared/pointer-shim.ts` / `web-audio-shim.ts` 的注入逻辑；只读静态审查，未跑 build/test/e2e。文件路径均相对仓库根；行号按当前工作区。
> 说明：`SECURITY.md` §5.1 已明确「除 boot 两条外不校验来源地址与 Host」，因此本文**不把「其余路由没有回环校验」本身重复记为缺陷**；只记它带来的、文档没有覆盖的升级后果（任意视频读取、CSRF 副作用、DNS rebinding 数据面）。已知边界见 §5.55/§5.56/§7.42④/§7.44，本文只列未记录项与「文档宣称不符」项。

## P0（会导致安全问题/数据损坏/进程崩溃）

| # | 问题 | 证据 path:line | 触发条件 | 影响 | 修复建议 |
|---|---|---|---|---|---|
| P0-1 | **不可信 web 壁纸可读取任意本地视频文件**（`/boot/local-video` 的回环双闸门对「同源 iframe」无效） | `src/host/routes.ts:237-259`（`isLoopbackRemote`/`isLoopbackHostHeader`）、`src/host/routes.ts:433-446`（路由）、`src/client/background-layer.ts:47-53/94-97`（iframe 用另一回环主机名承载） | 任意 `web` 壁纸的脚本里执行 `fetch('/wallpapers/boot/local-video?path=' + encodeURIComponent('C:\\Users\\Public\\Videos\\a.mp4')).then(r => r.arrayBuffer())`。iframe 的 origin 是 `http://localhost:<port>`（或 `127.0.0.1`，取决于 GUI 地址），同源可达同一 DSH 服务；请求的 `remoteAddress` 是 127.0.0.1、`Host` 是 `localhost:<port>`，两道检查都通过。文件需在白名单扩展名（`.mp4/.webm/.mov/.m4v/.ogv`）内。 | 恶意 web 壁纸（第三方不可信页面）可把用户磁盘上**任意目录的任意视频文件**读成字节并上传到外部；`/boot/probe` 还提供任意路径的存在性/大小 oracle。这直接推翻 `SECURITY.md:54`「不提供任意文件读取」与 §4.1 对 boot 路由「只读单个视频 + 回环来源」的安全叙事（回环来源不区分 GUI 与壁纸 iframe）。 | 不要只靠 `remoteAddress`/`Host`：给 boot 两条路由加一个**只有 GUI 侧能拿到、iframe 同源也读不到**的凭据（由 DSH 注入 GUI bootstrap，或宿主生成后经非 HTTP 通道交付），或把本地文件路由放**独立端口/origin**。退而求其次可校验 `Sec-Fetch-Site`/`Referer` 且拒绝缺失，但 iframe 可用 `no-referrer` 绕过，只能作纵深。 |
| P0-2 | **web 壁纸 iframe 可自我导航回宿主 origin，借 `allow-same-origin` 取得 `parent.document` / `localStorage`**（浏览器 `dsh web`） | `src/client/background-layer.ts:92-97`（`sandbox: 'allow-scripts allow-same-origin'`）、`:339-355`（iframe 赋 sandbox/src）、`src/host/routes.ts:630-671`（同一 HTTP 服务同时以两个回环主机名提供 `/wallpapers/web`）；`SECURITY.md:68-72` 宣称跨源隔离 | GUI 在 `http://127.0.0.1:<port>` 时，iframe 在 `http://localhost:<port>`。壁纸脚本执行 `location.href = 'http://127.0.0.1:<port>/wallpapers/web/<id>/index.html'`（GUI 在 localhost 时反向）；该 URL 仍由同一 DSH 服务提供，新文档 origin 变成 GUI 的 origin，而 iframe 的 `allow-same-origin` 仍在 ⇒ 可访问 `parent.document`、`parent.localStorage`，也可继续调用 GUI 同源 API。**待浏览器实测确认**：真机 CDP 在子帧执行 `parent.document.title`/`parent.localStorage.length`；若被 CSP `frame-src` 或浏览器沙箱规则拦住则降为 P1。 | 恶意 web 壁纸从「跨源不可信页面」升级为「与 DSH GUI 同源的脚本」：可读聊天 DOM、设置、localStorage，代用户调用宿主 API 并外传；`SECURITY.md` §4.3 的跨源隔离承诺失效。桌面壳（顶层 `dsh-app://app`）下不能直接拿 GUI DOM，但 iframe 仍与宿主 HTTP transport origin 同源（DSH HTTP API 是否带同源 cookie 需另行确认）。 | 根本修法是把壁纸内容放到**独立端口/origin**；或在 GUI 侧对 `/wallpapers/web` 的 HTML 请求校验「发起导航的 Referer 不是 `/wallpapers/web/` 且来源是 GUI 页面」，并拒绝 `no-referrer`；只给壁纸 HTML 加 CSP `sandbox allow-scripts` 会退回 opaque origin，破坏 WebGL 壁纸（§5.30 的已知代价）。 |
| P0-3 | **恶意 `.tex` 的 LZ4 解压炸弹**：每条 mip 可声明 1GB 输出、最多 64 image × 256 mip，客户端 OOM/崩溃 | `src/client/tex-loader.ts:151-198`（`imageCount ≤ 64`、`mipmapCount ≤ 256`）、`:190-192`（`decompressedBytes ≤ 1<<30` 且每条独立）、`:263-266`（先 `new Uint8Array(decompressedSize)`，零长 `subarray` 仍持有底层 buffer）；`node_modules/lz4js/lz4.js:204-262`（空 `src` 直接返回 `dIndex=0`，不抛错）；宿主供给路径 `src/host/routes.ts:495-541`（`/scene/<id>/asset` 原样返回 pkg 内 `.tex`，无大小/解压预算） | 在恶意壁纸 `scene.pkg` 里放一个约 328KB 的 `TEXB0002`：`imageCount=64`、每 image `mipmapCount=256`，每条 mip 记录 `mw=1,mh=1,isLZ4=1,decompressedBytes=1073741824,bytesLen=0`（或 `imageCount=1,mipmapCount=256` 的约 5KB 变体）。`lz4js.decompressBlock` 对空载荷返回 0，`tex-loader.ts:265` 得到 `out.subarray(0,0)` 但底层 1GB buffer 仍被 `mipmaps` 数组持有；下一条继续分配 1GB。前几条就触发渲染标签页 OOM/卡死。 | 第三方不可信素材可让 DSH 渲染进程 OOM/崩溃（不是宿主 Node 崩溃，但 GUI 同样不可用）；当前 host 对 `.tex` 不设 entry 大小/解压预算。属任务清单第 4 项「LZ4 解压炸弹」。 | ① `decompressedBytes` 必须等于按 `mw*mh*format` 推导的精确字节数（不接受空 LZ4 载荷 + 巨大输出）；② 给单纹理总输出设预算（如 256MB）并限制 mip/image 数；③ `lz4Decompress` 先校验 `src.length` 与 `decompressedSize` 的比例，LZ4 返回长度不等于声明时直接拒绝且不保留 `out`；④ host 侧对 `.tex` entry 设上限。 |

## P1（真实缺陷，应修）

| # | 问题 | 证据 path:line | 触发条件 | 影响 | 修复建议 |
|---|---|---|---|---|---|
| P1-1 | **未配置 `wallpaperDir` 时 `/wallpapers/web` 把进程 cwd 当作根目录** | `src/host/index.ts:43`（`wallpaperDir || ''`）、`src/host/routes.ts:322`（`dir()` 可为 `''`）、`src/host/routes.ts:643-650`（`join('', id)` 后直接 `existsSync`/`readFileSync`）；`src/host/index.ts:6-8` 注释称未配置时路由返回空列表/提示 | 全新安装、profile 里 `wallpaperDir` 为空时，`GET /wallpapers/web/.git/config`（或 `/wallpapers/web/src/host/routes.ts`、`/wallpapers/web/Documents/…`）。`join('', '.git')` = `.git`，前缀校验仍通过，文件被原样返回。若 DSH 进程 cwd 是用户目录，可读 `Desktop/`、`Documents/`、`Downloads/` 下任意普通文件；若是仓库目录，可读 `.git/config`（可能含远端凭据）与源码。 | 未配置状态下的「任意（cwd 子目录内）文件读取」；且该路由无 Host 校验，DNS rebinding 页面也能读。与 `index.ts` 注释及 SECURITY §4.1「读取范围限定在用户已配置的目录内」不符。 | `dir()` 为空/非绝对路径时，`/wallpapers/web`、`/media`、`/scene`、`/properties` 一律 400/404；在 `apply` 时把配置解析成绝对路径；禁止相对路径落盘。 |
| P1-2 | **`/wallpapers/media/<id>/preview` 对目录/竞态无 `isFile` 与 try/catch** | `src/host/routes.ts:395-403`：`existsSync(p)` 后直接 `readFileSync(p)`，没有 `statSync(p).isFile()`，也没有外层 try | 壁纸目录里放一个名为 `preview.gif`（或 `.jpg`/`.jpeg`/`.png`）的**目录**，然后请求 `/wallpapers/media/<id>/preview`。`existsSync` 为真，`readFileSync` 抛 `EISDIR`；同样可被「exists 后文件被删」的 TOCTOU 触发。**待确认** Cordis `webServer` 是否包裹同步 handler 异常：若未包裹即为未捕获异常（P0 进程崩溃）；若包裹则至少每次 500 且无降级。 | 恶意壁纸一个目录条目即可让预览请求持续报错/可能打崩宿主；比 `/web` 的 `statSync().isFile()` 防护弱。 | `existsSync` 前改用 `statSync` + `isFile()`；整个读取包 `try/catch`，失败按 404 返回；不要把 `readFileSync` 放在未保护路径。 |
| P1-3 | **`PkgReader` 全局缓存最多 32 个「整包 Buffer」，无字节预算/删除失效** | `src/host/routes.ts:39-58`（`READER_CACHE_MAX = 32`，按 path+mtime 命中）、`src/host/pkg-reader.ts:54-58`（构造时 `readFileSync` 整个 pkg）；`AGENT.md:279` 只记录了单个 PkgReader 整包常驻（147MB 级），未记录 32 倍放大 | 用户浏览/请求 32 张不同 scene 壁纸的资源（`/scene/<id>/asset`、`video-probe`、`particle-texture` 都会 `getPkgReader`）。若每包 100–150MB，常驻 RSS 可达 3–5GB；删除壁纸后旧 Buffer 仍被 Map 持有，直到第 33 个 path 把最旧项淘汰。 | 正常使用即可造成宿主内存膨胀/被系统 OOM kill；恶意 web 壁纸更可通过 `/wallpapers/list` 拿 32 个 id 主动灌满缓存。 | 改成按**总字节数**的 LRU（如 512MB），或改用文件句柄 + 区间读取（真正流式）；在壁纸目录/配置变化或文件被删时主动失效；至少不要缓存整包，只缓存 entry 表。 |
| P1-4 | **不可信的 `project.json` / `scene.json` 无大小上限，宿主同步整块读入** | `src/host/scanner.ts:38`（每张壁纸 `readFileSync(project.json)`）、`src/host/scene-source.ts:40-45`、`src/host/routes.ts:774`（`/properties` 再读）、`src/host/routes.ts:780-781`（pkg 内 `scene.json` 整块 `JSON.parse`） | 恶意壁纸目录放一个 1.2GB 的 `project.json`（或 pkg 内 1GB 的 `scene.json`），请求 `/wallpapers/list?refresh=1` 或 `/wallpapers/properties?id=<id>`。`readFileSync` 先分配整块内存，再 `JSON.parse`；1.5GB 级即可把宿主 RSS 推到 OOM，且同步解析阻塞事件循环。**待确认** Workshop 上传体积上限；本地/自解压壁纸可直接构造。 | 宿主 Node 进程内存耗尽/长时间卡死；`PkgReader` 的整包内存已记录，但这里是不经 pkg 的独立放大点。 | 读前 `statSync().size` 设上限（project.json 例如 1MB、scene.json 例如 64MB）；超限按「损坏素材」跳过并 warn；`/properties` 同样限制。 |
| P1-5 | **无来源/Origin 校验 + 昂贵同步路由可被任意网页 CSRF 触发** | `src/host/routes.ts:717-730`（`/probe` 每次同步 `spawnSync('reg')`，`src/host/steam-paths.ts:131-147`）、`src/host/routes.ts:368-384`（`/list?refresh=1` 同步扫描全部 `project.json` + MP4 探测）、`src/host/routes.ts:467-543`（`/scene` 首次 pkg 解析）、`src/host/routes.ts:732-740`（`/now-playing` 懒启动 PowerShell） | 任意外部网页放 `<img src="http://127.0.0.1:62063/wallpapers/probe">` 或 `?refresh=1` 的 `<img>`/`fetch(...,{mode:'no-cors'})`；无需读响应，请求本身就会执行。HTTPS 公网页面可能被 mixed-content/PNA 策略拦住，HTTP 页面、本地页面或已获本地网络权限的页面可直接触发。连续请求可让 `reg` 子进程风暴、全库扫描、PowerShell 启动反复发生。 | GUI 事件循环被同步 I/O/子进程阻塞，用户感知卡顿甚至短暂无响应；外部页面无需知道壁纸 id。该副作用面在 SECURITY §5.1（只讲数据被读）中没有记录。 | 对非 boot 路由校验 `Sec-Fetch-Site`（仅允许 `same-origin`/`none`）并拒绝跨站；`/probe` 结果短 TTL 缓存、限流；`refresh=1` 加最小间隔；避免请求线程内 `spawnSync`。 |

## P2（健壮性/可维护性建议）

| # | 问题 | 证据 path:line | 触发条件 | 影响 | 修复建议 |
|---|---|---|---|---|---|
| P2-1 | **多段 Range 被当作非法直接 416；Range 单位大小写也敏感** | `src/host/routes.ts:158-174`：正则 `^bytes=(\d*)-(\d*)$` 只接受单区间 | `Range: bytes=0-1,4-5`（Safari/部分视频客户端会发）→ 416；`Range: Bytes=0-1`（单位按 RFC 不区分大小写）→ 416；非法格式（`bytes=abc`）也 416 而非忽略。 | 多段请求本可返回 200 全量或 multipart，返回 416 会让部分播放器直接报错；`/media/<id>/file` 视频拖动可能受影响。 | 多段时忽略 Range 返回 200（或实现 multipart）；非法 Range 按 RFC 忽略；`bytes` 用小写比较；补 `If-Range`。 |
| P2-2 | **号称「防软链」但没有 realpath 校验** | `src/host/routes.ts:111-118`（`resolveEngineAsset` 只做 `resolve` 前缀比较）、`:630-650`（`/web` 同）、`:707-708`（particle 同）；`SECURITY.md:42` 宣称「防 `..`、绝对路径、软链绕过」 | 在壁纸目录/引擎 `assets/materials` 内放一个 symlink/目录联接，指向配置目录外的文件；`existsSync`/`readFileSync` 会跟随。Windows 上需开发者模式/管理员或 junction；恶意 zip 解包也可能保留。 | 若本地已能写壁纸目录，可读配置目录外文件；与文档宣称不符。属纵深防御缺口（本地写权限是前置）。 | `realpathSync` 后再次与 `realpath(base)` 做前缀比较；或对 `stat` 结果拒绝 reparse point（Windows）。 |
| P2-3 | **boot 的 UNC 拦截只查字面量，未处理映射驱动器/symlink 指向网络** | `src/host/routes.ts:264-282`：只拒绝前两字符都是分隔符的路径；`statSync(p)` 会跟随 symlink/映射盘 | 用户机器有 `Z:` 映射到 SMB/DFS，或路径是本地 symlink → `\\attacker\share\video.mp4`；`/boot/local-video?path=Z:\x.mp4` 通过绝对路径+扩展名校验，随后发起 SMB 访问。 | 可触发 SMB/NTLM 凭据泄露（与 §5.55 防 UNC 的目标冲突）；需本机已有映射/symlink。 | `realpathSync` 后检查最终路径不是 UNC；`fs.statfs`/`GetDriveType` 拒绝 `DRIVE_REMOTE`；拒绝 reparse point。 |
| P2-4 | **`isLoopbackHostHeader` 的解析存在可接受的非规范 Host** | `src/host/routes.ts:244-254`：`[::1].evil` 会因 `slice(1,end)` 等于 `::1` 返回 true；`127.0.0.1:80@evil` 会因 `lastIndexOf(':')` 截出 `127.0.0.1` 返回 true | 非浏览器客户端/本机进程伪造 Host；浏览器不会生成这类 Host，且 boot 还要求 remoteAddress 回环，故远程不可直接利用。 | 校验器与真实 hostname 语义不一致，审计/回归容易误判；非回环来源仍被 remoteAddress 挡住。 | 用 `new URL('http://' + host)` 解析并检查 `.hostname` ∈ 允许集、拒绝 userinfo/多余冒号；补单测 `[::1].evil`、`127.0.0.1:80@evil`。 |
| P2-5 | **boot 路由无法区分 GUI 与「跨站 `<video>`」；存在性 oracle 与自动播放** | `src/host/routes.ts:237-259/433-446`；`SECURITY.md:46` 只讲「仅回环来源」 | 任意网页放 `<video src="http://127.0.0.1:62063/wallpapers/boot/local-video?path=C:\Users\Public\Videos\x.mp4">`；浏览器自动带 `Host: 127.0.0.1`，`remoteAddress` 127，路由返回 200/206。页面读不到字节，但可据 `loadedmetadata`/`error` 判断文件存在，拿到 duration/尺寸，甚至让用户听到声音。 | 本地视频路径/存在性隐私泄露；与「远程访问者不得读任意文件」的边界相比，这是同一浏览器的 confused deputy。 | 同 P0-1 的凭据方案；至少要求 `Sec-Fetch-Dest` 与 GUI 侧 `Referer`，并意识到 `<video>`/canvas 仍可被壁纸同源利用。 |
| P2-6 | **`/wallpapers/web` 的路径段不解码：带空格/中文的壁纸资源 404** | `src/host/routes.ts:229-232`（`new URL(...).pathname` 原样 percent-encoded）、`:639-645`（逐段检查后直接 `join`）；`src/host/scanner.ts:27-31/58`（id 来自目录名，未过滤/编码） | web 壁纸有 `img/my logo.png`，浏览器请求 `.../img/my%20logo.png`；服务端找字面 `my%20logo.png` → 404。目录名带空格/中文的壁纸在 `/list` 可见，但 `/media`、`/web`、`/scene` 的 id 白名单会拒绝 `%` 或空格。 | 功能性回归：常见带空格/Unicode 文件的 web 壁纸资源加载失败；误报路径不存在。 | 对每个 path segment 先 `decodeURIComponent`（捕获 malformed），再重新校验 `..`、`/`、`\`、`:`，最后 join；scanner 对 id 做 encode 或过滤。 |
| P2-7 | **HTML 注入不检查 UTF-8，非 UTF-8 页面会被替换字符破坏** | `src/host/routes.ts:654-661`：`body.toString('utf8')` 后 `injectWebShims`，注释写「非 UTF-8 安全则原样返回」但代码只判 `null`；`src/shared/pointer-shim.ts:90-101` 只按锚点返回 null | web 壁纸的 `index.html` 是 GBK/Shift-JIS 等 8-bit 编码且含 ASCII `<head>`；`toString('utf8')` 把中文变成 U+FFFD，再 `Buffer.from(patched,'utf8')` 回写，页面文本全部损坏。 | 非 UTF-8 的 web 壁纸从「可正常显示」变成乱码；注释与实现不符。 | 用 `TextDecoder('utf-8', {fatal:true})` 或 `Buffer.isUtf8` 预检，失败原样返回；或按 `<meta charset>` 解码后再编码（需保持字节一致）。 |
| P2-8 | **不可信壁纸内容可以 executable MIME 从 GUI 同源返回** | `src/host/routes.ts:145-148`（`mimeOfAsset` 按扩展名）、`:541`（scene asset）、`:650-667`（web）、`:751-753`（thumbnail）；没有 `Content-Disposition`/`X-Content-Type-Options`/CSP | scene.pkg 里放 `evil.html`/`evil.svg`/`evil.js`，请求 `/wallpapers/scene/<id>/asset?name=evil.html`（或 media 的 project.json `file` 指向 `.html`、SMTC thumbnail 的 `contentType` 为 `text/html`），再导航到该 URL；脚本以 `127.0.0.1:<port>` 的 GUI origin 执行，可读 GUI localStorage/DOM。 | 存储型同源 XSS（需要导航/打开链接；web 壁纸的自我导航已由 P0-2 覆盖，scene 资产是额外入口）。 | scene asset 对 `.html/.svg/.js` 强制 `application/octet-stream` + `Content-Disposition: attachment`；所有路由加 `X-Content-Type-Options: nosniff`；thumbnail 只允许 `image/*`。 |
| P2-9 | **`art.contentType` 直接写响应头，未白名单/去 CRLF** | `src/host/routes.ts:751-753`；来源 `src/host/media-session.ts:42`（PowerShell 的 `$st.ContentType` 原样进 JSON） | SMTC 应用把 Thumbnail 的 ContentType 报成 `text/html` 或含 `\r\n` 的串；`res.writeHead` 对非法头会抛 `ERR_INVALID_CHAR`，合法 `text/html` 则把封面字节当 HTML 提供。 | 单次请求 500/未捕获异常（同 P1-2 的宿主包裹问题）；若为 HTML 且用户导航则同源 XSS；头像数据来自本机应用，属边界但应防御。 | 只允许 `image/png`/`image/jpeg`/`image/webp` 等，其他回退 `image/png`；写入前 strip CR/LF；把 `art.bytes` 用 `image` 解码校验。 |
| P2-10 | **抓帧目录权限与错误日志路径** | `src/host/data-dir.ts:16`（`mkdirSync(dir, {recursive:true})` 用默认 mode）、`src/host/scene-frame-store.ts:85`（`writeFileSync` 默认 mode）、`src/host/index.ts:70`（`warn('... %s', error)` 含绝对路径） | POSIX 上 umask 022 时目录 0755、帧 0644，同机其他用户可读壁纸截图；数据目录初始化失败时错误信息把 `<home>/.dsh-use-wallpaper` 绝对路径写进 DSH 日志。 | 本机多用户隐私（Wallpaper 截屏）与日志路径泄露；Windows 用户 profile ACL 下影响较小。 | `mkdirSync(dir,{recursive:true,mode:0o700})`、写文件 `mode:0o600`；日志只记原因码/`error.code`，不打印路径。 |
| P2-11 | **frame-store 的 tmp 文件不参与淘汰，且无 fsync/Windows rename 失败重试** | `src/host/scene-frame-store.ts:37-62`（`prune` 只认 `.png`）、`:82-96`（tmp + `renameSync`，无 fsync） | 进程在 `writeFileSync(tmp)` 与 `renameSync` 之间崩溃 → `.tmp` 永久留在 frames 目录；Windows 上目标帧正被读取时 `renameSync` 可能 EPERM，写入直接 500；掉电后 rename 无 fsync 可能丢数据。 | 少量磁盘泄漏、偶发写失败；与 §5.49「原子写 + 限额」的强承诺有差距。 | 启动时清理 `*.tmp`；写后 `fsync` 临时文件/目录（可接受成本时）；rename 失败按短退避重试一次；或使用 `wx` + 唯一名。 |
| P2-12 | **list-cache 的 mtime 在扫描前采样，扫描期间变更会缓存陈旧列表** | `src/host/list-cache.ts:37-47`：`mtimeMs = statSync(dir).mtimeMs` → `await scanWallpapers` → `cache.set(dir,{mtimeMs,...})` | 扫描 10 万文件/慢盘期间新增/删除壁纸；目录 mtime 已变，但缓存记录的是旧 mtime，下一次同 mtime 请求会命中旧列表，直到再变一次。 | 列表短暂陈旧（§5.50 只记录了「改子目录 project.json 根 mtime 不变」的边界，这是另一条竞态）。 | 扫描后再 `statSync` 一次，与扫描前比较；不同则重扫或把 mtime 写成 `null` 不缓存。 |
| P2-13 | **`getPkgReader` 用 `mtimeMs=0` 同时表示「stat 失败」** | `src/host/routes.ts:43-50`：stat 失败置 0，然后 `hit.mtimeMs === mtimeMs` 命中 | 一个真实 pkg 的 mtime 恰为 epoch 0（归档/复制工具可造），先成功缓存；随后文件被删除，`statSync` 失败仍得 0，命中旧 reader，`readEntry` 返回旧字节或 `createReadStream` 对不存在文件报错。 | 已删除素材仍被当作可读；`asset` 可能返回 200 但流中断。 | 用 `number | null` 表示 stat 失败；stat 失败直接构造（抛 404）并删除缓存项，不参与命中。 |
| P2-14 | **`scene.pkg` 是目录/损坏 pkg 时 `/scene/asset` 直接 500，跳过引擎 assets 回退** | `src/host/routes.ts:505-521`：`existsSync(pkgPath)` 为真即 `getPkgReader`，catch 后 `return json(500)`；引擎回退在 `:524-539` 之后才执行 | 壁纸目录里 `scene.pkg` 是目录（或空文件/坏 magic），请求 `/scene/<id>/asset?name=fonts/X.ttf`；pkg 解析抛错 → 500，浏览器拿不到 WE 引擎 assets 里的字体。 | 单张坏素材导致该壁纸所有资源加载失败（而不是回退到引擎 assets/404）；与 §5.53「file 非法回退标准名」的容错叙事不一致。 | pkg 解析失败时记 warn 并继续走引擎 assets 回退，最后才 404；把 500 留给真正的内部错误。 |
| P2-15 | **`/web`、`/static`、`/scene` 引擎分支、`/particle-texture` 的 `existsSync` 后 `statSync` 无 try（TOCTOU）** | `src/host/routes.ts:613`（static）、`:650`（web）、`:526`（`resolveEngineAsset` 内 `statSync`）、`:707-708`（particle） | 请求到达后、`statSync` 前文件被删除/权限变化；`statSync` 抛 `ENOENT`/`EACCES`，同步 handler 未捕获（同 P1-2 的宿主包裹问题）。 | 500 或未捕获异常；正常并发删除壁纸/切换目录时可触发。 | 用单个 `statSync` 放 try 里并检查 `isFile()`；删除 `existsSync` 预检。 |
| P2-16 | **`collectUserProperties` 对 scene.json 递归无深度/节点上限** | `src/host/user-props.ts:33-53`（`collectUsedBy` 递归）、`src/host/routes.ts:791`（handler 内直接调用，无 try） | 恶意 scene.json 构造极深的 `{a:{a:{...}}}`（10k+ 层）或极大对象；`JSON.parse` 成功后递归 `RangeError`，`/properties` 抛异常。 | 单次请求 500/可能未捕获；大 scene.json 还会在解析时占内存（P1-4 的另一面）。 | 递归改显式栈并设最大深度/节点数；`/properties` 整体 try/catch 返回空属性。 |
| P2-17 | **只读路由不校验方法；`DELETE /frame` 在无 dataDir 时谎报成功** | `src/host/routes.ts:368-384`（list 不校验）、`:717-730`（probe）、`:732-740`（now-playing）、`:760-795`（properties）、`:577-580`（DELETE 恒 200） | 对 `/wallpapers/list`、`/probe`、`/now-playing`、`/properties` 发 POST/DELETE（与 GET 同效）；`frameStore` 为 null 时 `DELETE /wallpapers/frame/x` 返回 `{ok:true}` 但未删除。 | 方法语义错误/CSRF 面扩大；客户端误以为帧已删。 | 除 `/frame` 的 GET/HEAD/POST/DELETE 外统一拒绝非 GET/HEAD（405 + Allow）；无 dataDir 的 DELETE 返回 503/404。 |
| P2-18 | **`/particle-texture` 与 `/probe` 细节**：particle 整文件 `readFileSync` 无流式/上限；`/boot/probe` 的 `playable` 恒 true | `src/host/routes.ts:704-710`（particle）、`:455-463`（probe 返回 `playable:true`） | 引擎/壁纸提供一个 500MB 的 `.tex` → particle 路由一次性读入宿主内存；`/boot/probe` 对一个扩展名合法但编码损坏/0 字节的 `.mp4` 仍报 `playable:true`。 | particle 大文件内存峰值；面板对不可播放文件给出「可播放」假阳性。 | particle 复用 `sendSceneAsset` 的流式/大小限制（它是二进制，不需要整块）；`playable` 改为「存在且 isFile」或真实探测。 |

## 已检查无问题的项（列表）

- **PKGV 解析边界（`pkg-reader.ts:7-42`）**：`nameLen` 有 0/1024 上下界，`entryEnd` 先检 `> buf.length`，`off/size` 的 32 位读取为负即抛，`dataStart+off+size > buf.length` 二次校验，条目数 ≤10000；`readEntry` 只做 `subarray`，不越界。检查过，无越界/负偏移问题。
- **TEXV 的宿主侧探测（`scene-media-probe.ts:8-20`）**：`readUInt32LE(22)` 前有 `entry.length >= 64`，`ftyp` 的 `boxStart` 与 `size` 都做 `boxStart+size > entry.length` 校验；检查过，无 OOB。LZ4 解压见 P0-3（client）。
- **MP4 moov 审计（`mp4-audio-probe.ts:20-98`）**：每个 box 先检 `end-off >= 8/16`，`size=0/1` 分支有边界，`moov` 上限 64MB 且 `readSync` 长度校验；检查过，无 OOB/无限循环。
- **`..`/绝对路径/UNC（正常路径）**：`isSafeToken`（`routes.ts:94-96`）禁 `..`；scene asset `name`（`:499`）与 particle `name`（`:687`）拒绝 `..`；`isSafeAssetName` 拒绝 `\`/前导 `/`；`/static` 与 `/web` 做 `resolve`/前缀；`scene-source.isSafeEntry` 拒绝 `..`/盘符/前导分隔符；boot 拒绝双分隔符 UNC、NUL、非白名单扩展名（`:264-282`）。检查过，仍存在 P1-1（未配置目录）和 P2-2（symlink），但上述按字面量校验本身无 `..`/绝对路径绕过。
- **URL 规范化**：`new URL(req.url,'http://localhost')` 会折叠 `.`/`..` 与 `%2e%2e`；`%2F` 保持单段，`isSafeToken` 拒绝 `%`；`/frame/1%2F2`、`/web/w2/..%2F..%2Fetc` 均被拒。检查过，无 URL 编码穿越。
- **NUL/超长路径**：`resolveBootVideoPath` 拒绝 NUL；其余路径 NUL 会被 regex/`isSafeToken` 拒绝或 fs 报错；16KB 级 id 由 fs 返回 ENOENT/ENAMETOOLONG 并被 catch。检查过，无崩溃。
- **Range 单区间边界（`routes.ts:158-174`）**：`bytes=0-`、`bytes=2-`、`bytes=-N`（含 N>size）、`bytes=5-3`、`bytes=999999-`、负数、非数字、超 `Number.MAX_SAFE_INTEGER` 均有明确结果；`416` 带 `Content-Range: bytes */size`；`HEAD` 无 body 且长度正确；小/大文件分别整块/流式。检查过，单区间语义无问题（多段见 P2-1）。
- **`Content-Length`/`Content-Type` 固定响应**：`json()`、`sendTexture`、frame/preview/scene/static/web 的固定 Buffer 均按实际 `Buffer.length` 写头；`sendSceneAsset` 对稳定文件正确；检查过，未发现固定响应长度不符。
- **错误响应不泄露路径/堆栈**：所有 catch 分支返回固定 `{error:'...'}`，不拼接异常消息/绝对路径；检查过。
- **frame 写入**：id 正则、PNG 签名、12MB 上限、tmp + `renameSync` 同目录、失败清理 tmp、`prune` 按 mtime；检查过，原子性/限额主体正确（tmp 与 fsync 见 P2-11）。
- **list-cache**：ETag 含内容 SHA1 前 12 位 + 条数，`refresh=1` 强制重扫，304 弱比较，目录不可读不写缓存；检查过，内容指纹/304 语义正确（mtime 竞态见 P2-12）。
- **`PkgReader` mtime 缓存命中**：正常 mtime 变化会重建；删除后 stat 失败不会误命中（除非 mtime 恰为 0，P2-13）。
- **PowerShell 子进程**：`WATCH_SCRIPT` 是常量，`spawn('powershell.exe', ['-NoProfile',...,'-Command', WATCH_SCRIPT])` 不拼接 `pageTitle`/查询参数；`reg query` 参数是常量；检查过，无命令/参数注入。
- **JSON 行协议畸形输入**：`parseWatcherLine` 校验 `v===1`、`at` 为 number、`sessions` 为数组，字段逐个 `typeof` 兜底；base64 长度 ≤512KB；坏行只 `badLines++` 不改快照；1MB buffer 上限；检查过，畸形行不会抛/污染状态。
- **媒体隐私**：日志只输出 `started/stopped/degraded/exited` 等状态，不打印 title/artist/album/封面；`stats()` 无媒体字段；检查过。唯一路径泄露在 `index.ts:70` 的数据目录错误日志（P2-10）。
- **XSS/反射**：`/probe`、`/list`、`/properties`、`/now-playing` 的字符串由 React/文本节点渲染（`settings-section.tsx` 的 `{property.label}` 等），无 `innerHTML`；错误体不反射输入；检查过，标题/标签本身不构成 XSS。
- **HTML shim 注入内容**：`injectWebShims` 只拼接常量 shim，`escapeShimForInlineScript` 转义 `</script` 与 `<!--`；壁纸 HTML 内容不会进入脚本源码；检查过，无「壁纸内容 → 注入脚本」的代码注入（编码/锚点问题见 P2-6/7）。
- **`isSafeToken`/设备名**：Windows 保留名（`CON`、`NUL` 等）在当前 Node 的 fs 路径下返回 ENOENT（实测 `E:\...\CON`/`NUL.png`），未形成设备访问；检查过，无实际危害（但白名单仍可更严）。
- **`/frame`、`/media`、`/scene`、`/properties` 的 id 校验**：均先 `isSafeToken`，`/properties` 无 id 时返回空；检查过，无 id 注入。
- **`steam-paths`**：`reg`/VDF 只读、参数常量，VDF 路径只用于候选展示与 `existsSync`；检查过，无命令注入（UNC/网络盘的副作用见 P2-3）。
- **`data-dir` 默认值**：`DSH_USE_WALLPAPER_DATA_DIR` trim 后空则回退 `~/.dsh-use-wallpaper`；`framesDirOf` 只拼 `frames`；检查过，无默认路径穿越。

## 与文档的一致性核查

### 1. 文档声称 vs 代码

| 文档 | 原文/声称 | 代码事实 | 结论 |
|---|---|---|---|
| `SECURITY.md:42` | 所有 `/wallpapers/*` 只读、id/文件名白名单、**根目录二次前缀检查（防绝对路径、软链绕过）** | `/media/preview` 只有 id 白名单、无根前缀/`isFile`（`routes.ts:395-403`）；`/web`、`/scene`、`/particle` 只做 `resolve` 字面前缀、无 `realpath`（`:526/650/707`）；`/frame` 有 POST/DELETE 写/删 | **不符**：软链防护不存在；「只读」只对部分路由成立（P2-2/P2-8/P2-17）。 |
| `SECURITY.md:46` | boot 两条「仅回环来源（remoteAddress + Host）…防 DNS rebinding」 | 校验确实存在（`routes.ts:237-259/436/452`），但不区分 GUI 与同源 iframe；跨站 `<video>` 的 Host 仍是 127.0.0.1 | **部分不符/覆盖不足**：DNS rebinding 挡住了，但「同源不可信壁纸」和「普通网页的 `<video>`」不在威胁模型内（P0-1/P2-5）。 |
| `SECURITY.md:54` | 「不提供任意文件读取」 | `/boot/local-video` 允许任意绝对路径+视频扩展名；web 壁纸 iframe 与服务同源 ⇒ 可读；未配置 `wallpaperDir` 时 `/web` 以 cwd 为根 | **不符**（P0-1/P1-1）。 |
| `SECURITY.md:55` | 「写操作只有抓帧 POST /wallpapers/frame/<id>」 | `DELETE /wallpapers/frame/<id>` 也写（删除）（`routes.ts:577-580`） | **不符**（P2-17）。 |
| `SECURITY.md:68-72` | web 壁纸在跨源 iframe 内，「拿不到宿主 GUI 的 DOM、localStorage」 | `allow-same-origin` + 同服务双回环主机名，壁纸脚本可自我导航到 GUI origin | **不符（待浏览器复验）**（P0-2）。 |
| `SECURITY.md:97`（§5.1） | 除 boot 外不校验来源地址与 Host；风险描述限于「绑 0.0.0.0/隧道后素材与媒体信息被读」 | 代码确实只保护 boot；但默认回环下 DNS rebinding 仍可读非 boot 数据，且可 CSRF 触发昂贵路由（probe/list refresh）、写/删 frame | **已知边界被低估**：不是「只有暴露到网络才有风险」，同浏览器 rebinding 与 CSRF 副作用未记（P1-5/P2-5）。 |
| `AGENT.md:212`（§5.55） | boot 本地视频「仅回环来源」，UNC/网络路径拦截、扩展名白名单 | 字面 UNC/NUL/扩展名校验与代码一致；但映射盘/symlink 未拦、跨站 `<video>` 与同源 iframe 可触发 | **主体一致，边界不足**（P2-3/P2-5/P0-1）。 |
| `AGENT.md:214`（§5.56） | `/media/<id>/file` 复用 `sendSceneAsset`，支持 Range/206/416/HEAD | 与代码一致；单区间均正确 | **一致**（多段 Range 未记录，见 P2-1）。 |
| `AGENT.md:146`（§5.14） | particle-texture 先 pkg `materials/<name>.tex`、后引擎 `assets/materials`，`name` 是相对路径 | 与 `routes.ts:683-714` 一致；`name` 白名单 + 前缀校验；检查过 | **一致**。 |
| `AGENT.md:190-196`（§5.49/§5.50） | frame 原子写/12MB/200 张；list 按根 mtime 缓存 + 内容指纹 ETag | 与 `scene-frame-store.ts`/`list-cache.ts` 一致；边界（tmp/fsync、扫描竞态）未记 | **主体一致，补充 P2-11/P2-12**。 |
| `AGENT.md:279`（§7.42④） | `PkgReader` 整包常驻内存（147MB 级，v0.9 改按需读取） | 单包整包已记录；但 `READER_CACHE` 32 个整包未记录 | **已知边界放大**（P1-3）。 |
| `AGENT.md:184-189`（§5.48） | 注入在 `<head>` 后/`<html>` 后/文档前置；无锚点原样返回 | 锚点逻辑一致；`routes.ts:654-661` 注释声称「非 UTF-8 安全」但无预检 | **注释/实现不符**（P2-7）；锚点误匹配属 client P2-11，不重复。 |
| `AGENT.md:297`（§7.44） | 媒体日志不含曲目；封面只在内存 | 日志确实不含；但 `art.contentType` 未白名单/未去 CRLF 就写响应头 | **主体一致，补充 P2-9**。 |
| `docs/fixes/conventions-details.md:262` | `/wallpapers/web` 整文件 `readFileSync`、无 Range，大文件未专门测 | 代码仍如此（`routes.ts:652`） | **已知，不重复报告**；无大小上限的 OOM 风险仍建议按 P1-2 同口径处理。 |
| `docs/release-1.0/p0-docs-done.md:30` | 「其余路由 id/路径白名单 + 根目录前缀二次校验」 | `/media/preview` 无根前缀；`/web` 无 realpath | **不符**（P2-2/P1-2）。 |

### 2. 路由来源校验矩阵（逐路由）

> 结论：只有 `/boot/*` 两条有来源闸门；其余路由的「无 Host 校验」本身是 `SECURITY.md:97` 的已知边界，但其中 `/probe`、`/list?refresh=1`、`/now-playing`、`/frame` 的**副作用**、`/boot` 的**浏览器内触发**、`/web` 的**同源 iframe** 是文档未覆盖部分。

| 路由 | 回环/Host 校验 | 其他防护 | 读/写 | 备注 |
|---|---|---|---|---|
| `GET /wallpapers/list` | 无 | 目录扫描、ETag、4 项 FIFO 缓存 | 读 | `refresh=1` 可跨站触发全量同步扫描（P1-5）；方法未校验（P2-17） |
| `GET /wallpapers/media/<id>/preview` | 无 | id 白名单 | 读 | 无 `isFile`/catch（P1-2）、无 Cache-Control、整文件读 |
| `GET /wallpapers/media/<id>/file` | 无 | id + project.json `file` 无分隔符、`sendSceneAsset` | 读 | 支持 Range；`file` 可指向 `.html`（P2-8） |
| `GET /wallpapers/boot/local-video` | **有**（remoteAddress + Host） | 绝对路径、UNC/NUL、扩展名白名单 | 读 | 同源 iframe/跨站 `<video>` 可触发（P0-1/P2-5）；映射盘/symlink 未拦（P2-3） |
| `GET /wallpapers/boot/probe` | **有** | 同一 `resolveBootVideoPath` | 读 | `playable` 恒 true（P2-18）；路径 oracle |
| `/wallpapers/scene/<id>/asset` | 无 | id + name 白名单 + pkg/引擎前缀 | 读 | pkg 损坏 500 不回退（P2-14）；symlink/TOCTOU（P2-2/P2-15） |
| `/wallpapers/scene/<id>/video-probe` | 无 | id 白名单 | 读（解析 pkg） | 跨站可触发重扫描（P1-5） |
| `/wallpapers/scene/<id>/embedded-video` | 无 | id 白名单 | 读 | 200 全量、无 Range；发整个 entry 尾部 |
| `/wallpapers/frame/<id>` | 无 | id 正则、PNG、12MB、原子写 | **读/写/删** | 写/删无鉴权；DNS rebinding/同源 web 壁纸可写（§5.2 已知面）；DELETE 无 dataDir 谎报（P2-17） |
| `/wallpapers/static/<file>` | 无 | 单段 token + `resolve` 前缀 | 读 | 构建产物；TOCTOU（P2-15） |
| `/wallpapers/web/<id>/<path...>` | 无 | id + 逐段检查 + 字面前缀 | 读 | **P0-2 的载体**；未配置目录 P1-1；percent 解码 P2-6；UTF-8 P2-7；symlink P2-2 |
| `/wallpapers/particle-texture` | 无 | name 白名单 + pkg/引擎前缀 | 读 | 整文件读；name 白名单较宽但前缀校验有效 |
| `/wallpapers/probe` | 无 | 无 | 读 + 同步 `reg` | 跨站 CSRF DoS（P1-5） |
| `/wallpapers/now-playing` | 无 | 无 | 读（可 spawn watcher） | 跨站可懒启动进程；媒体快照隐私（§5.1 已知） |
| `/wallpapers/now-playing/thumbnail` | 无 | rev 正整数 | 读 | `contentType` 未净化（P2-9） |
| `/wallpapers/properties` | 无 | id 白名单 | 读 | 大 project/scene 解析（P1-4/P2-16） |

### 3. 本次未重复报告的已知边界

- `SECURITY.md:97` 的非 boot 路由无鉴权/无 Host 校验：已知；本文只报其升级后果（P0-1/P1-5）。
- `SECURITY.md:105` 的 web 壁纸可访问同源本地服务：已知；P0-1 是其中「boot 任意视频读取」的具体升级，P0-2 是「GUI origin 沙箱逃逸」。
- `AGENT.md:279` 的 PkgReader 整包常驻：已知；P1-3 是 32 倍缓存放大。
- `docs/fixes/conventions-details.md:262` 的 `/web` 整文件读/无 Range：已知；未重复。
- §7.32（web resize/dpr）、§7.33（局域网 opaque）、§7.35（单张壁纸缺陷）、§7.44（媒体边界）：属 client/素材侧，本次未发现 host 侧新增矛盾；仅 §7.44 的日志边界由 P2-9（响应头而非日志）补充。
