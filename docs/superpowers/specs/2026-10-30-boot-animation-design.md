# 开机动画（独立于日常壁纸）+ 视频/图片素材 + 四种展示方式 设计

> 日期：2026-10-30 ｜ 基线：`master` @ `3c95962`（v0.9.0-29）
> 动机：插件名叫 Wallpaper Engine，却只有会话背景这一块；「开机动画」是最有感觉、一直空着的能力。
> 范围（用户已确认）：**只做视频与图片两类素材**（WE 库 video 壁纸 / 图片壁纸，以及本地视频文件）；scene、web 不做实时渲染；与日常壁纸完全独立设置、互不影响。

## 1. 目标与非目标

**目标**
1. 设置对话框新增**独立菜单项「开机动画」**，与「Wallpaper 壁纸」并列；两套设置各自独立读写。
2. 素材两路：**WE 库壁纸**（只列 `video` / `image` 两类）或**本地视频文件绝对路径**（host 流式读取，仅回环来源可访问）。
3. 展示方式四选：**平铺**（仅图片）/ **居中**（contain）/ **挤压**（stretch / `object-fit:fill`）/ **裁切填满**（cover，默认）。
4. 播放策略：每次冷启动/新窗口播一次（刷新不重播）；视频播完或到「最长播放」上限即淡出；点击/任意键/Esc 跳过；素材 8 秒未就绪静默跳过，**永不阻塞主界面**。
5. 与日常壁纸零耦合：新增独立的 `.wp-boot-layer` 全屏层，不碰背景层状态、不改变任何既有壁纸行为。

**不做**（记录边界）
- scene / web 壁纸的实时渲染（用户明确排除；选到这类壁纸在开机动画面板里不出现）。
- 声音开关：浏览器自动播放策略下固定静音（`muted + playsInline`）。
- 替换 Electron 桌面壳自身的启动闪屏（插件只能在页面加载后尽早覆盖，两者可能各闪一次）。
- 多素材轮播、开机音频、按星期分时段等增强（后续可加）。

## 2. 用户可见行为

| 场景 | 行为 |
|---|---|
| 开关关闭（默认） | 完全无效果，不创建任何 DOM/请求 |
| 开启 + 已配置素材 + 本次页面会话未播过 | 页面加载后尽早在最上层插入全屏层并播放；结束后 300ms 淡出移除 |
| 同一页面会话再次触发（刷新/HMR 重载） | 不重播（`sessionStorage` 标记） |
| 用户点击 / 按任意键 / Esc | 立即淡出交接 |
| 素材 8 秒未就绪 / 路径无效 / 编码不支持 | 静默跳过，主界面正常；面板「上次播放」显示原因 |
| 面板「试播」 | 不受开关与「只播一次」限制，立即预览**已保存**配置（面板改动即时写入，与现有壁纸面板一致） |

时长规则：视频 `min(视频时长, 最长播放)`；图片默认固定 4 秒；「最长播放」= 0 表示视频播完为止、图片仍 4 秒。

## 3. 架构总览

```
host（Node）
  routes.ts ── 复用 sendSceneAsset（Range/HEAD/206/416/流式）
    GET /wallpapers/boot/local-video?path=<绝对路径>   仅回环；扩展名白名单
    GET /wallpapers/boot/probe?path=<绝对路径>         面板「校验」用（exists/size/playable）
  settings.ts ── schema 追加 bootAnimation* 字段（与壁纸字段同一 ns，各管各的）

client（浏览器）
  boot-overlay.ts   纯 DOM 全屏播放器（视频/图片 + fit + 跳过 + 超时 + 淡出）
  boot-player.ts    编排：读设置 → 判断是否播 → 组装素材 plan → 调 overlay → 记录结果
  boot-settings-section.tsx  独立 settings.section（wbs-* 类）
  index.ts          bootstrap 里尽早 start()；teardown 一起销毁；注册第二个 section
  settings.ts / types.ts / styles.ts  字段、类型、样式

素材 URL
  WE 视频壁纸  → /wallpapers/media/<id>/file（页面已按 id 解析 project.json.file）
  WE 图片壁纸  → /wallpapers/media/<id>/preview（gif/jpg/png 由路由自动选）
  本地视频     → /wallpapers/boot/local-video?path=<encodeURIComponent(路径)>
```

## 4. 设置字段（host schema + client 类型同增）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `bootAnimationEnabled` | boolean | `false` | 总开关 |
| `bootAnimationSource` | string | `'we'` | `'we'` \| `'local'`（白名单归一在 client） |
| `bootAnimationWallpaperId` | string | `''` | WE 壁纸 id |
| `bootAnimationWallpaperKind` | string | `''` | `'video'` \| `'image'`（面板选择时一起写入，启动时免拉列表） |
| `bootAnimationLocalPath` | string | `''` | 本地视频绝对路径 |
| `bootAnimationFitMode` | string | `'cover'` | `'tile'` \| `'contain'` \| `'stretch'` \| `'cover'` |
| `bootAnimationMaxDurationMs` | number | `6000` | 0–30000；0 = 播完/不限 |

写入沿用 `client/settings.ts` 的 `writeClientSettings(patch)`（Typert 远程合并，候选 ns 探测）；读取沿用 `readClientSettings()`（新字段未下发时按 DEFAULTS 补齐，旧版本插件忽略未知字段）。

## 5. host：本地视频路由（`src/host/routes.ts` 内新增）

**回环判定**：`isLoopbackRemote(remoteAddress)` —— 接受 `127.0.0.1`、`::1`、`::ffff:127.0.0.1`；其余一律 403（dsh web 若绑 0.0.0.0，远程访问者不得借此读宿主任意文件）。

**`resolveBootVideoPath(raw)` 纯函数**（可单测）：
- 必须 `path.isAbsolute` 且非空；否则 `{ code: 400 }`
- 不允许含 NUL；扩展名小写后 ∈ `{.mp4,.webm,.mov,.m4v,.ogv}`；否则 `{ code: 400 }`
- `statSync` 不存在/不是文件 → `{ code: 404 }`
- 通过 → `{ file, size }`

**路由**：`GET /wallpapers/boot/local-video`
- 非回环 → 403；`resolveBootVideoPath` 失败按 code 返回；成功则构造 `SceneAssetSource = { size, readAll: () => readFileSync(file), openRange: (s, e) => createReadStream(file, { start: s, end: e }) }`，直接复用现有 `sendSceneAsset(req, res, file, source, 0)`（`streamThreshold=0` 恒流式）→ 自动获得 Range/HEAD/206/416/`Cache-Control: no-store`。
- `Content-Type` 由 `mimeOfAsset` 按扩展名给出；路径不回显到日志。

**`GET /wallpapers/boot/probe`**：同样回环 + 同一路径解析；返回 `{ ok, exists, isFile, size, playable, ext }`，供面板「校验」按钮显示（不读文件内容、不做编码探测）。

## 6. client：`src/client/boot-overlay.ts`

```ts
export type BootFitMode = 'tile' | 'contain' | 'stretch' | 'cover';
export type BootAsset = { kind: 'video'; url: string } | { kind: 'image'; url: string };
export type BootResult = 'ended' | 'skipped' | 'timeout' | 'failed' | 'already-played' | 'disabled' | 'no-asset';
export interface BootOverlay { play(asset: BootAsset, fit: BootFitMode, maxDurationMs?: number): Promise<BootResult>; dispose(): void; }
export function createBootOverlay(opts?: {
  readyTimeoutMs?: number;  // 默认 8000
  fadeMs?: number;          // 默认 300
  imageDurationMs?: number; // 默认 4000
  doc?: Document;           // 测试注入
}): BootOverlay;
```

行为：
- 创建 `.wp-boot-layer`（`position:fixed; inset:0; z-index:2147483000; background:#000; overflow:hidden`），`document.documentElement.appendChild`。
- **视频**：`<video autoplay muted playsInline preload="auto">`；`loadeddata` 起算；`ended` → `'ended'`；`maxDuration>0` 到点 → 结束；`error` → `'failed'`；`readyTimeoutMs` 内未就绪 → `'timeout'`。
- **图片**：`<img>`（contain/cover/stretch 用 `object-fit`）+ `tile` 用 `<div>` 的 `background-repeat:repeat`（object-fit 不支持平铺；GIF preview 同样适用）；创建后立即计时（不等待 `load`；`error` 仅判失败），`imageDurationMs` 或 maxDuration 到点结束。
- **跳过**：`pointerdown` / `keydown`（含 Esc）在 window 上 capture（不 passive，`onSkip` 会 `preventDefault`），一次性；跳过后立刻摘监听。
- **结束收尾**：停视频/清 src → 300ms opacity 过渡 → 移除 DOM；`dispose()` 幂等（重复调用/播放中被调都安全）。dispose 不产生 unhandled rejection。
- 一次 overlay 实例只播一次；重复 `play()` → 内部重建层（供面板预览）。

## 7. client：`src/client/boot-player.ts` 与 index 集成

```ts
export function bootAssetFromSettings(s: ClientSettings): BootAsset | null;   // 纯函数，可单测
export function shouldPlayBoot(s: ClientSettings, storage: Storage): boolean; // 纯函数
export function createBootPlayer(opts: {
  readSettings: () => Promise<ClientSettings>;
  overlay?: BootOverlay; storage?: Storage;
}): {
  start(): Promise<BootResult>;                 // 正常启动路径：受 enabled + sessionStorage 约束
  play(opts?: { force?: boolean }): Promise<BootResult>; // force=true 供面板试播
  getLast(): { result: BootResult; at: number; asset: BootAsset | null } | null;
  dispose(): void;
};
```

- `shouldPlayBoot`：`enabled && storage.getItem('we:boot-played') !== '1'`；真正播放前写 `'1'`（防止并发重复）。
- 组装：local → 本地视频 URL；we + kind=video → `/wallpapers/media/<id>/file`；we + kind=image → `/wallpapers/media/<id>/preview`；缺字段 → null（`no-asset`，静默）。
- `start()` 在 `bootstrap()` 中 `void` 调用（**不 await、不阻塞 mount**）；失败只记录，不抛。
- `dispose()` 供 teardown 调用（移除 overlay、清监听）；播放中的 `start()` 结果迟到时不得复活层（disposed 守卫）。
- 诊断：bootstrap 暴露 `window.__wallpaperEngineBoot = { play, getLast }`，面板试播与排查用。

**index.ts**：bootstrap 里创建 bootPlayer → `void start()`；注册第二个 `settings.section`（`id: 'wallpaper-engine-boot'`, `order: 21`, `label: '开机动画'`）；teardown 中 `bootPlayer.dispose()`。

## 8. client：设置面板（`src/client/boot-settings-section.tsx`，独立 section）

类名前缀统一 `wbs-*`（与现有被测试锁定的 `wss-*` 契约类解耦）。

- **卡片 1 · 启用**：开关（默认关）+「上次播放」状态行（只显示结果，来自 `getLast()`；时间/素材为后续增强）。
- **卡片 2 · 素材**
  - 单选：`WE 库壁纸` / `本地视频文件`
  - WE：`<select>` 只列 `/wallpapers/list` 中 `type ∈ {video, image}` 的项（显示「标题 · 视频/图片」）；选中即写 id+kind；「试播」按钮；列表为空时提示先去壁纸页配置目录/刷新。
  - 本地：文本框（绝对路径）+「校验」按钮（调 `/wallpapers/boot/probe`，显示 存在/大小/可播 或错误原因）+「试播」。
- **卡片 3 · 展示方式**：四个 radio（平铺/居中/挤压/裁切填满）；当前素材为视频时「平铺」禁用并提示「视频不支持平铺」。
- **卡片 4 · 最长播放**：滑杆 0–30 秒（0 = 播完/不限）。
- 底部说明：每次启动/新窗口播一次，刷新不重播；点击、按任意键或 Esc 跳过；固定静音（浏览器自动播放策略）。

## 9. 隔离与生命周期

- 全屏层独立于 `.wp-background-layer`：不改 `body[data-we-wallpaper]`、不调 background-layer 的 `setFitMode/setPaused`、不影响轮播/省电/健康状态。
- z-index 高于 `#root`（现有背景层 0 → `#root` 1 → boot 层 2147483000），播完移除后 DOM 与现状一致。
- **HMR/重挂载**：bootstrap 单例挂 `window.__wpEngineTeardown` 的收尾链里一并 dispose；`sessionStorage` 标记使刷新/重载不重播；面板「试播」可手动重看。
- 收尾后旧实例不得再创建层（`disposed` 守卫 + overlay.dispose 幂等）。

## 10. 错误处理与降级

| 失败 | 处理 |
|---|---|
| 路径非法/不存在/非白名单扩展名 | host 400/404；overlay 不创建；面板显示原因 |
| 非回环请求 | 403（安全兜底） |
| 视频编码不支持 / 解码 error | overlay → `'failed'`，静默交接 |
| 8 秒未就绪 | `'timeout'`，静默交接 |
| 设置读取失败/字段缺失 | 按 DEFAULTS；缺素材 → `no-asset`，不播放 |
| 播放中途 HMR 收尾 | dispose 立即移除层，主界面正常 |

## 11. 性能与边界

- 只在启用且未播过时创建 DOM 与请求；播放结束全部释放（video src 清空、监听摘除）。
- 8 秒就绪超时兜底，避免慢文件/坏编码把界面压在黑屏上；用户随时可跳过。
- 本地视频不复制文件、不落盘，只按需流式读取（Range 支持拖动/起播）。
- 图片素材用现有 preview（可能是 gif）；平铺按原始像素尺寸重复。

## 12. 测试策略

**host**（`tests/boot-asset.test.ts`）：`resolveBootVideoPath`（相对路径/不存在的文件/非白名单扩展名/合法路径）、`isLoopbackRemote`（IPv4/IPv6/映射地址/外网地址）；路由级：非回环 403、400/404 分支、Range 206 与 416、HEAD 无 body（用假 req/res，模式同 `tests/routes.test.ts`）。

**client**（`tests/boot-overlay.dom.test.ts`，jsdom）：四种 fit 映射（tile 用 repeat div、其余 object-fit）、视频 `ended`/图片计时/超时/跳过/失败、淡出后 DOM 移除、dispose 幂等与监听摘除。

**client**（`tests/boot-player.test.ts`，node）：`bootAssetFromSettings` 全分支、`shouldPlayBoot`（enabled × sessionStorage）、`start()` 写标记并返回结果、无素材静默、`play({force:true})` 绕过开关。

**面板**（`tests/dom/boot-settings-section.dom.test.tsx`）：渲染默认值、只列 video/image、视频时平铺禁用、选择后写入字段、校验按钮结果展示。

**回归**：`npm test`（现有 90+ 套件全绿）、`npm run typecheck:tests`、`npm run verify:arch`、`npm run build && npm run build:client` 产物更新；不涉及渲染路径，e2e 不强制重跑（可跑 `e2e:compare` 确认零差异）。

## 13. 交付物

- 新增：`src/client/boot-overlay.ts`、`src/client/boot-player.ts`、`src/client/boot-settings-section.tsx`、`tests/boot-overlay.dom.test.ts`、`tests/boot-player.test.ts`、`tests/boot-asset.test.ts`、`tests/dom/boot-settings-section.dom.test.tsx`
- 修改：`src/host/routes.ts`（两条路由 + 两个纯函数）、`src/host/settings.ts`（7 字段）、`src/client/settings.ts`（DEFAULTS）、`src/client/types.ts`（ClientSettings）、`src/client/index.ts`（集成 + 第二个 section + teardown）、`src/client/styles.ts`（`wbs-*` 样式）、`AGENT.md`（新能力与边界）、`lib/` + `dist/` 产物
- 文档：本 spec + writing-plans 生成的实施计划

## 14. 验收标准（DoD）

1. 设置侧边栏出现独立「开机动画」菜单；默认关闭时对现有行为零影响。
2. 开启并选 WE 视频壁纸/WE 图片壁纸/本地视频路径三种素材都能在页面加载后播放。
3. 四种展示方式生效；视频时「平铺」置灰。
4. 播完/到时长上限/8 秒超时/用户跳过四种结束路径都能 300ms 内淡出并移除层。
5. 刷新页面不重播；面板「试播」可重看；失败原因可见且不阻塞主界面。
6. 日常壁纸（含轮播、暂停、健康状态、文字颜色）行为零变化，现有测试全绿。
7. 关闭插件或 HMR 重载后无残留 `.wp-boot-layer`。

## 15. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 桌面壳自己的启动闪屏先出现，插件后覆盖 | 尽早挂载 + 文档写明边界；不做虚假承诺 |
| 浏览器拦截带声音自动播放 | 固定 muted+playsInline；不提供声音开关 |
| dsh web 绑 0.0.0.0 后本地路径路由变任意文件读取 | 仅回环来源可用 + 扩展名白名单 + 不回显日志 |
| 大文件/慢盘起播慢 | 8 秒就绪超时 + 可跳过；面板校验显示大小 |
| 与既有 wss-* 设置契约冲突 | 独立 section + `wbs-*` 新类名，现有契约测试不动 |
| 预览素材分辨率/比例差异 | 默认 cover（裁切填满），用户可换 contain/tile |
