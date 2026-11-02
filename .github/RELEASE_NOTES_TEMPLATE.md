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

## ⚠️ 兼容性 / 已知限制

- <行为、设置字段、默认值或接口契约有变更时，写清旧用户要不要做什么；没有就删掉整节>

## 升级说明

- npm：`@dsh-use/wallpaper-engine@X.Y.Z`（发布后为 `latest`）
- 桌面版：完全退出 DSH 再启动（client bundle 才会重新加载）；`dsh web` 刷新页面即可
- <配置迁移 / 新默认值 / 需要重装插件的场景；没有就删掉这一条>
```

---

## 填写规则

1. **标题**：固定 `# vX.Y.Z：<主题>`。主题 ≤ 20 字、只写用户能感知的变化（不要写「若干修复」「多项改进」）。
2. **分组**：只允许下面五节，顺序固定；不要新造分组标题：
   - `## ✨ 新增功能`（有用户可见的新能力时）
   - `## ✨ 改进`（只有体验调整时；两节都有内容就都保留）
   - `## 🐛 修复与加固`
   - `## ⚠️ 兼容性 / 已知限制`（可选）
   - `## 升级说明`（必选）
   **禁用「其它 / 杂项 / 其他」兜底标题**——不确定放哪的条目，要么拆出子主题，要么删掉。
3. **子主题**：只有 `## ✨` 两节允许 `### <子主题>`；子主题名 ≤ 12 字，一个子主题 ≤ 5 条。
4. **每条 bullet**：
   - 讲「用户看到什么 / 怎么变」，不写实现细节（不贴文件路径、函数名、内部数据结构）；
   - 涉及具体素材 / 命令 / 路径时带标识（壁纸 ID、`npm run e2e:xxx`、`steamapps/workshop/content/431960`）；
   - 一条只讲一件事；不要用「并 / 同时」把两件不相关的事串在一条里。
5. **粒度**：正文一般 6–20 条；超过 20 条说明该拆子主题或考虑拆版本。
6. **版本号**只出现在标题、`## 升级说明` 与必要的兼容性条目里；正文不写「相比 0.10.0」这类对比（要写就放背景段）。
7. **语言**：中文，与 README / AGENT.md 一致；技术词保留原文；句末可省句号。
8. **不回填旧 release**：格式统一从本模板启用后开始，历史版本保持原样。

## 发布流程 checklist

1. **定版本号**（0.x 阶段）：
   - 新增用户可见能力 → minor：`0.A.B` → `0.(A+1).0`
   - 修复 / 体验微调 → patch：`0.A.B` → `0.A.(B+1)`
   - 不引入 major；版本唯一性以 npm 为准（`npm view <pkg> versions`）。
2. **bump**：`npm version X.Y.Z --no-git-tag-version`；同步 README「npm registry 当前最新为」一行。
3. **构建 + 门禁**：`npm run build && npm run build:client`；`npm test`、`npm run typecheck:tests`、`npm run verify:arch`（见 AGENT.md §3.3）。
4. **提交 release**：`chore(release): vX.Y.Z`（只含版本号 / README / 索引等发布相关文件；功能改动必须在更早的提交里）。
5. **打 tag 并推送**：`git tag -a vX.Y.Z -m "vX.Y.Z"` → `git push origin master && git push origin vX.Y.Z`。
6. **写发布说明**：复制本模板正文 → 按填写规则写完 → 存成临时文件（建议 `e2e/.out/`，gitignore）。
7. **创建 GitHub Release**：`gh release create vX.Y.Z --title "vX.Y.Z：<主题>" --notes-file <临时文件> --verify-tag`。
8. **npm 发布**：`npm publish`。登录过期或需要显式认证时用一次性 token：
   写临时 `.npmrc`（`//registry.npmjs.org/:_authToken=<token>`）→ `npm publish --userconfig=<临时文件>` → **删除临时文件**；token 不入库、不提交。
9. **更新插件市场索引**：等 npm 元数据生效后取真实发布时间（`time[version]`），把版本项写进 `index.json` 的 `plugins[0].versions`（`publishTimestamp` = 该 unix 秒），提交 `chore(release): 插件市场索引补 X.Y.Z` 并推送。
10. **验证**：`npm view <pkg> version dist-tags.latest`、`gh release list --limit 3`、`git ls-remote origin refs/tags/vX.Y.Z`。

## 参照

- 结构范例：[v0.11.0 Release](https://github.com/yu502950715yang/dsh-use-wallpaper/releases/tag/v0.11.0)（标题带主题；`## ✨ 改进` 下三个子主题；`## 🐛 修复与加固`；`## 升级说明`）。
- 历史版本对比：v0.8.0 / v0.8.1 / v0.8.2 / v0.9.0 / v0.10.0 的标题层级与分组各不相同——这正是本模板要消除的漂移。
