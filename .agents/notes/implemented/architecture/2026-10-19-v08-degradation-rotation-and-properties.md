# Agent Note: v0.8 降级链、轮播池、属性范围与抓帧落盘

Status: implemented

## Problem

v0.8 之前，scene 渲染失败后只剩一张作者预览图：带内嵌视频的壁纸也退化成静图，用户没有任何「继续看动态画面」的路径。同时三块日常能力缺失：不能按间隔自动换壁纸；壁纸库只能整列平铺，找一张冷门壁纸要翻很久；壁纸作者在 `project.json` 里提供的可切换属性没有面板入口。视频壁纸还有一条真实投诉：HEVC/H.265 在缺解码扩展的浏览器里停在黑背景，既不报错也不回退。

这些缺口都在「产品可用性」层，不需要改 scene 渲染语义。约束是：不能白屏、不能改既有设置行为、渲染像素路径零回归，且新增的磁盘与内存状态要能收尾（HMR 重挂载只允许一份）。

## Decision

四条决策以「契约写进 `AGENT.md`，理由留在这里」的方式落地（契约见 `AGENT.md` §5.49 与 §7.41）：

1. **scene 降级顺序 = 实时渲染 → 内嵌 MP4 → 抓帧 PNG → 作者 preview → 空态**。`src/client/scene-fallback.ts` 的 `showSceneFallback` 逐级尝试，视频播放必须返回 `'ok'` 才停在该层；`probeEmbeddedVideo` 探测 `/wallpapers/scene/:id/video-probe`，host 侧 `scene-media-probe.ts` 只在 `.tex` 头 204B 内认 flags bit5 + 合法 `ftyp` box，按 `(pkgPath, mtime)` 缓存。抓帧由 `frame-export.ts`（`readPixels` → 行序翻转 → PNG）与 `scene-frame-store.ts`（原子写 + 限额）完成，只在 scene 首帧成功后抓一次。
2. **抓帧缓存落宿主数据目录，不落客户端存储**：`~/.dsh-use-wallpaper/frames/<id>.png`，`DSH_USE_WALLPAPER_DATA_DIR` 可整体迁移；单张 ≤12MB、目录 ≤200 张（按 mtime 淘汰最旧）；帧响应一律 `Cache-Control: no-store`。抓帧是派生缓存，删掉只会让下次成功渲染时重抓。
3. **轮播池 = 收藏（≥2 张时）否则全部非隐藏且非 `unknown` 壁纸**。`rotation.ts` 把池选择、下一张与定时调度拆成纯函数 + 可注入定时器；`failed` 是内存 Set（硬失败本会话跳过、不落盘），手动选择清空并重置计时，`paused` / `pauseOnHidden` 清表停走。
4. **属性面板 v0.8 只做 bool 可见性**：host 的 `user-props.ts` 取 `project.json general.properties`（`type=bool`、非 `editable=false`）与 `scene.json` 中 `visible.user` 引用键的**交集**；面板写 `we:userprop:<key>` 后触发当前壁纸重装配才生效，slider / color / combo 留 v0.9。

视频壁纸的编码兜底是**另一条更短的链**（video → preview → 空态），失败记忆在 `media-health.ts` 内存里，只用于面板提示。

相关决策：设置字段双写沿用 [dsh-settings-dual-path](2026-09-23-dsh-settings-dual-path.md)；抓帧与「帧内快照」不是一回事（后者是段渲染用的每帧临时纹理，见 [frame-snapshot-segmented-render](2026-10-13-frame-snapshot-segmented-render.md)）。

## Affected repositories

- `dsh-use-wallpaper` 分支 `feat/v0.8-productization` commits `4027471` `f54038a` `5f51f47` `61ac3c1`

## Alternatives considered

**抓帧优先于内嵌 MP4。** 抓帧是「当前这张壁纸实际渲染出来的画面」，构图比作者工坊封面更接近用户刚看到的画面。但它始终是静态图：把它排在 MP4 前面，会让所有带内嵌视频的场景永久退化成静图，丢掉作者本来提供的动态内容；而且冷启动首次失败时抓帧还不存在，这一层实际上经常落空。故 MP4 在前、抓帧在后。

**做一个独立的「播放列表」数据结构。** 显式列表能让用户精确编排顺序、集合和启停，表达力比收藏强。代价是新的 schema、面板编辑 UI、空态与导入导出，而 v0.8 的产品目标是「可日常使用」而不是「可编排」。收藏已经是用户表达「想常看」的现成语义，先把它当轻量播放列表；显式列表与导入导出留 v0.9。

**属性面板一次做全类型（slider / color / combo）。** 这样能覆盖 WE 属性面板的大部分用法，也更接近桌面端。但每种类型都要渲染器消费对应绑定（数值范围、颜色空间、combo 选项），还要真机素材逐类验收；而 bool 的 `visible.user` 已有现成读取通道，成本小、可验证。v0.8 先交付 bool，其余类型等渲染器语义补齐再开。

**抓帧存客户端 IndexedDB。** 不占宿主磁盘，也不碰 Node 文件权限，看起来更「前端友好」。但 IndexedDB 按 origin 隔离：换端口或从桌面壳访问 GUI 就看不到旧帧，容量配额与淘汰策略也不可控。宿主数据目录跨刷新/端口稳定，能按文件大小与数量做确定的限额淘汰，故选择 host 落盘。

**在 scanner 阶段全量扫 pkg 找内嵌 MP4。** 列表一次就能带回「有没有视频」，客户端不必额外请求。但 37 个 pkg 里最大 336MB，全量扫会让 `/wallpapers/list` 明显变慢；改为 scene 失败时按需探测，并用 `(pkgPath, mtime)` 缓存结果，只有真正需要降级时才付探测代价。

**引入 host ffmpeg 做 HEVC → H.264 转码。** 这是唯一能让缺解码扩展的浏览器真正播出 HEVC 的方案。但会引入 ffmpeg 二进制依赖、CPU/磁盘开销、许可与 Windows-only 维护面；v0.8 只做「检测 → 回退 preview → 面板提示」，把转码留给远期。

## Consequences

**收益：** scene 失败不再只剩封面：有内嵌视频就先播视频，没有就用上次的真实画面；视频编码问题从「黑屏无提示」变成「回退 + 可操作提示」；轮播、库管理和布尔属性让插件具备日常使用的基本产品面，且全部状态都有明确归属（settings / localStorage / host 数据目录）。

**代价：** 每个 scene 首次成功渲染会多一次 `readPixels` + PNG 编码 + 最多 12MB 写盘（每个 id 一次，已有缓存则跳过）；轮播切 scene 会重建播放器，4K 壁纸可能闪黑/卡顿，只能真机观察；属性面板仅 bool，slider/color/combo 用户暂时仍无入口；轮播失败跳过与视频失败记忆都不跨会话；抓帧没有亮度门禁，无 GPU / 上下文异常的极端情况下可能把黑帧写进缓存（已知风险，见 `AGENT.md` §7.41 与 `TESTING.md` §2.13 待真机项）。
