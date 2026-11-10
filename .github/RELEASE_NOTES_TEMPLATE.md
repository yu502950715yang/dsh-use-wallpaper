# 发布说明模板（GitHub Release）

> **怎么用**：发布前把下面「模板正文」里 `---` 分隔的两段之间内容复制到临时文件（例如 `e2e/.out/release-notes-vX.Y.Z.md`），
> 按「填写规则」改完，再执行：
>
> ```bash
> gh release create vX.Y.Z --title "vX.Y.Z：<主题>" --notes-file <临时文件> --verify-tag
> ```
>
> 本文件不随版本改动；标题与正文里的 `vX.Y.Z` / `X.Y.Z` 都是占位符。

---

## 模板正文（复制这一段）

```markdown
# vX.Y.Z：<一句话主题>

<可选背景段：1–3 句，说明这版为什么发、面向谁。没有就删掉整段。>

## ✨ 新增功能

### <子主题>
- <用户可感知的变化：在哪个界面/命令、做了什么、结果有什么不同>

## ✨ 改进

- <已有功能的体验调整；与「新增功能」二选一或都保留，没有就删掉整节>

## 🐛 修复与加固

- <原现象 → 现在行为；涉及具体壁纸/路径/命令时带 ID 或示例>

## ⚠️ 破坏性变更（0.x → 1.0）

<!-- 1.0.0 必选节；后续 major（2.0.0）改标题为「破坏性变更（X → Y）」，minor/patch 删掉整节。 -->
- <旧行为 → 新行为；用户需要做什么；不迁移会怎样>
- 支持范围：DSH `>=X.Y.Z`（`engines.dsh`）；更低版本 DSH 会在安装/加载时被拦截
- 设置字段 / `localStorage` 键 / 数据目录 / `exports` 的变更清单：<逐条列出，或写「无」>

## ⚠️ 兼容性 / 已知限制

- <行为、设置字段、默认值或接口契约有变更时，写清旧用户要不要做什么；没有就删掉整节>

## 升级步骤

1. npm：`dsh plugin add @dsh-use/wallpaper-engine@X.Y.Z`（或 `npm i -g`；发布后为 `latest`）
2. 桌面版：完全退出 DSH 再启动（client bundle 才会重新加载）；`dsh web` 刷新页面即可
3. <配置迁移 / 旧数据清理 / 重新选择壁纸等需要用户动手的步骤；没有就写「无，直接升级即可」>
4. <回滚方式：`dsh plugin add @dsh-use/wallpaper-engine@<上一版>` + 重启>
```

---

## 填写规则

1. **标题**：固定 `# vX.Y.Z：<主题>`。主题 ≤ 20 字、只写用户能感知的变化（不要写「若干修复」「多项改进」）；major 版本的主题要写明不兼容点（如「v1.0.0：DSH 0.2 起、移除旧设置兼容层」）。
2. **分组**：只允许下面六节，顺序固定；不要新造分组标题：
   - `## ✨ 新增功能`（有用户可见的新能力时）
   - `## ✨ 改进`（只有体验调整时；两节都有内容就都保留）
   - `## 🐛 修复与加固`
   - `## ⚠️ 破坏性变更（0.x → 1.0）`（**1.0.0 必选**；后续 major 改标题为「破坏性变更（X → Y）」；minor/patch 不出现）
   - `## ⚠️ 兼容性 / 已知限制`（可选）
   - `## 升级步骤`（必选）
   **禁用「其它 / 杂项 / 其他」兜底标题**——不确定放哪的条目，要么拆出子主题，要么删掉。
3. **子主题**：只有 `## ✨` 两节允许 `### <子主题>`；子主题名 ≤ 12 字，一个子主题 ≤ 5 条。
4. **每条 bullet**：
   - 讲「用户看到什么 / 怎么变」，不写实现细节（不贴文件路径、函数名、内部数据结构）；
   - 涉及具体素材 / 命令 / 路径时带标识（壁纸 ID、`npm run e2e:xxx`、`steamapps/workshop/content/431960`）；
   - 一条只讲一件事；不要用「并 / 同时」把两件不相关的事串在一条里。
5. **破坏性变更条目**必须能对应到「升级步骤」里的某个动作；只写「不兼容」不给迁移路径不算完成。
6. **粒度**：正文一般 6–20 条；超过 20 条说明该拆子主题或考虑拆版本。
7. **版本号**只出现在标题、`## 升级步骤`、`## ⚠️ 破坏性变更` 与必要的兼容性条目里；正文不写「相比 0.10.0」这类对比（要写就放背景段）。
8. **语言**：中文，与 README / AGENT.md 一致；技术词保留原文；句末可省句号。
9. **不回填旧 release**：格式统一从本模板启用后开始（1.0.0 起），历史版本的标题与正文保持原样，不改写。

## 版本语义（1.x，1.0.0 起生效）

1. **版本号规则**（semver，机械可推导）：
   - 破坏性 / 不兼容变更 → **major**：`1.x.y` → `2.0.0`
   - 新增用户可感知能力 → **minor**：`1.A.B` → `1.(A+1).0`
   - 修复 / 体验微调 → **patch**：`1.A.B` → `1.A.(B+1)`
   - 版本唯一性以 npm 为准（`npm view @dsh-use/wallpaper-engine versions`）。
2. **1.x 内不允许破坏**（以下任一都算 major）：设置字段重命名/删除、设置默认值改变、降级链语义变化、`localStorage` / 数据目录键变更、host HTTP 路由契约变更、`exports` / `files` 收窄、DSH 最低版本抬高、卸载/升级需要用户手工清理的场景。
3. **什么算「用户可感知」**（用于 minor/patch 判定）：设置面板的控件与文案、设置默认值、降级链行为（scene → video → 缓存帧 → preview → 空态）、e2e 判据语义、市场索引/安装方式（包名、安装命令、`engines` 范围）。纯内部重构、注释、测试改动不计。
4. **废弃窗口**：计划删除的能力先用一个 **minor** 在 README 与发布说明标 `deprecated`（并打运行日志），至少保留一个 minor 周期；**下一个 major 才能删**。没有废弃公告就直接删 = 违规。
5. **DSH 兼容策略**（`engines.dsh`，`package.json` 与 `index.json` 必须一致）：
   - **抬上界**（如 `<0.3.0` → `<0.4.0`，不改行为）→ **minor**；
   - **抬下界 / 删旧适配层 / 改最低支持 DSH 版本** → **major**（`1.0.0` 的破坏性变更 ✅）；
   - DSH 自身出现不兼容变更时，优先「插件 1.x 内抬上界」解决；只有插件行为必须随 DSH 改变时才发 major。
6. **预发布通道**：承载破坏性变更或 DSH 大版本适配时先发 `X.Y.Z-rc.N`：`npm publish --tag next` + GitHub Pre-release；冷却 ≥ 3 天（或至少覆盖 1 次 DSH 真机全量验收）后 `npm dist-tag add @dsh-use/wallpaper-engine@X.Y.Z latest` 晋升。
7. **回滚**：发现严重问题时 `npm dist-tag add @dsh-use/wallpaper-engine@<上一版> latest`，并在 GitHub Release 标记 `deprecated` 说明原因；不删除已发布版本（不可变）。

## 发布流程 checklist

1. **定版本号**：按上面「版本语义（1.x）」判定 major/minor/patch；**1.0.0 必须带迁移说明**（模板的「破坏性变更」「升级步骤」两节）。bump：`pnpm version X.Y.Z --no-git-tag-version`（只维护 pnpm lockfile；同步 README 的「npm registry 当前最新为」一行与兼容矩阵）。
2. **同步发布元数据**（与 bump 在同一个 release commit 里）：`package.json` 的 `version` / `engines.dsh` / `dsh.bundle.platforms`；`index.json` 新版本条目（`engines.dsh` 与包清单**逐字一致**）；README 兼容矩阵；CHANGELOG（有则更新）。
3. **构建 + 一条命令验收**：
   - `pnpm run build && pnpm run build:client`（wasm 改过时先 `pnpm run build:wasm` 再 `pnpm run gen:wasm-manifest`）
   - **`pnpm run verify:local`**（CI 三门禁 + 卫生检查；**含 `check:release`**）
   - 单独跑发布检查：`pnpm run check:release`（产物新鲜度 / wasm 溯源 / `npm pack` 内容体积 / `engines` 一致性；必须 4/4 PASS）
   - 结束后 `git status` 必须干净（含 `lib/`、`dist/`、`dist/static/`）。
4. **提交 release**：`chore(release): vX.Y.Z`（只含版本号 / README / `index.json` / 索引等发布相关文件；功能改动必须在更早的提交里）。CHANGELOG / 迁移文档 / `engines.dsh` 变更都在这一个 commit 里。
5. **tag 必须打在 CI 已绿的 SHA 上**：先等该 SHA 的 master CI（arch / typecheck / test / e2e）全绿；`git tag -a vX.Y.Z -m "vX.Y.Z"` → `git push origin master && git push origin vX.Y.Z`。
6. **等 Release workflow 绿**：`.github/workflows/release.yml` 由 tag 触发，跑全量门禁 + 发布检查，通过后自动 `npm publish --provenance --tag latest`；记录 run URL。**workflow 未绿不得手工发布**（手工兜底见第 8 步）。
7. **写发布说明**：复制本模板正文 → 按填写规则写完 → 存成临时文件（建议 `e2e/.out/`，gitignore）。
8. **创建 GitHub Release**：`gh release create vX.Y.Z --title "vX.Y.Z：<主题>" --notes-file <临时文件> --verify-tag`；RC 用 `--prerelease`，正式版确认 `gh release view` 的 `isPrerelease=false`。
9. **npm 发布的兜底路径**（CI OIDC 不可用时）：一次性 token（2FA）写临时 `.npmrc`（`//registry.npmjs.org/:_authToken=<token>`）→ `npm publish --provenance --tag latest --userconfig=<临时文件>` → **立即删除临时文件**；token 不入库、不提交。RC 用 `--tag next`。
10. **更新插件市场索引**：等 npm 元数据生效后取真实发布时间（`npm view @dsh-use/wallpaper-engine time --json` 的 `time[X.Y.Z]`），写进 `index.json` 的 `plugins[0].versions`（`publishTimestamp` = 该 unix 秒，`engines.dsh` 与 `package.json` 一致）→ `pnpm run check:release` 复验 → **官方校验**：用 `@deepseek-ai/dsh-plugin-market-index` 的 `parseMarketIndex(index.json)` 确认 `VALID` → 提交 `chore(release): 插件市场索引补 X.Y.Z` 并推送。
11. **发布后验证（含安装冒烟）**：
    - `npm view @dsh-use/wallpaper-engine version dist-tags.latest`、`gh release list --limit 3`、`git ls-remote origin refs/tags/vX.Y.Z`；
    - **从 npm 全新 profile 安装冒烟**：新 DSH profile 里 `dsh plugin add @dsh-use/wallpaper-engine@X.Y.Z` → `dsh web` → 设置页出现、选中一张壁纸生效、刷新后恢复；
    - 抓一次 jsDelivr URL（`https://cdn.jsdelivr.net/npm/@dsh-use/wallpaper-engine@X.Y.Z/package.json`）确认 CDN 已生效。

## 参照

- 结构范例：[v0.11.0 Release](https://github.com/yu502950715yang/dsh-use-wallpaper/releases/tag/v0.11.0)（历史格式，供分组与语感参考；1.0.0 起以本模板为准）。
- 历史版本对比：v0.8.0 / v0.8.1 / v0.8.2 / v0.9.0 / v0.10.0 的标题层级与分组各不相同——这正是本模板要消除的漂移；**历史 Release 不按新模板回填**。
