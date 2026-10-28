# Agent Note: 壁纸列表按目录 mtime 缓存 + 内容指纹 ETag

Status: implemented

## Problem

`/wallpapers/list` 每次被调用都会 `readdirSync` + 对每个壁纸目录 `readFileSync project.json` + 若干 `existsSync`（全同步 IO，阻塞 host 事件循环）。设置面板每次挂载、每次点「刷新」都会触发一次全量扫描；壁纸库变大后这段成本线性增长，而列表内容在绝大多数请求之间根本没变。

## Decision

新增 `src/host/list-cache.ts`：以**壁纸根目录 `mtimeMs`** 为指纹缓存 `scanWallpapers` 的结果（按目录隔离，最多 4 个目录，超限淘汰最旧，沿用 `getPkgReader` 的手法）；指纹命中直接返回缓存列表，不再碰各壁纸目录。

`/wallpapers/list` 的响应契约：

- `ETag: W/"<条数>-<sha1(JSON.stringify(list)) 前 12 位>"` —— **内容指纹**，不是 mtime；`refresh` 改了内容而 mtime 未变时它也必须变，否则浏览器带旧 `If-None-Match` 会被误判 304。
- `Cache-Control: no-cache`：允许缓存但每次必须验证（列表是派生数据，不能盲用）。
- 请求 `If-None-Match` 与当前 ETag 弱比较（去掉 `W/` 前缀）命中 → `304` 无 body。
- `?refresh=1` 强制重扫并写回缓存；面板「刷新」按钮走这条（`settings-section.tsx`）。

缓存条目只存 `{ mtimeMs, list, etag }`；目录不可读时不写缓存、ETag 固定 `W/"0-0"`。分页取舍见[默认排序收藏置顶笔记](../feature/2026-10-28-library-favorites-pinned.md)。

## Affected repositories

- `dsh-use-wallpaper` 分支 `master` commits `0b135f8`

## Alternatives considered

**只加 ETag/304、不加扫描缓存。** 改动最小，浏览器第二次请求确实能省 body。不采用：数十条 JSON 的传输成本可以忽略，真正的成本是服务端全量同步扫描；只加 304 会让每次开面板仍然扫一遍目录，收益与改动不匹配。

**ETag 用 mtime 指纹（`W/"<mtimeMs>-<count>"`）。** 实现更简单，缓存命中时连内容哈希都不用算。不采用：`refresh` 重扫可能得到内容变了而 mtime、条数都没变的新列表（例如在 WE 里改了某张壁纸的 title/type），此时 ETag 不变 ⇒ 浏览器带旧 `If-None-Match` 会被误判 304、继续用旧列表。ETag 的语义是「内容版本」，必须由内容决定。

**按每张壁纸目录或 `project.json` 的 mtime 做指纹。** 更精确，能感知 `project.json` 内容修改。不采用：指纹本身要 N 次 `stat`（接近一次扫描的 IO 量级），而「改内容」的场景点一次「刷新」就能覆盖；用 1 次 `statSync` 换掉 N 次同步 IO 的收益更划算。

**把列表接口改成分页/增量。** 不采用：面板依赖全量列表做类型判定与选中项解析，分页会把搜索/排序推给服务端，重构面远大于收益。

## Consequences

**收益：** 面板重复挂载与普通轮询只花 1 次 `statSync`；内容未变时浏览器得到 304 不重传 body；「刷新」仍能拿到最新列表。

**代价：** 只改子目录内 `project.json` 时根目录 mtime 不变，普通 GET 会返回缓存（点「刷新」可更新，已写进 AGENT.md §5.50）；缓存以目录路径为 key，切换目录会各占一个槽位（上限 4）；ETag 多了内容哈希计算（JSON 序列化 + sha1，仅在重扫时发生）。
