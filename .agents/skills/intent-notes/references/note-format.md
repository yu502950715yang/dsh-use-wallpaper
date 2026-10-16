# 笔记格式

`SKILL.md` 第三节的展开。写或改笔记时对照。

**禁止 `INDEX.md`**：集中式索引会与笔记树同时腐化，找笔记靠搜索与链接，不靠索引（门禁 1 在 `.agents/notes/` 根见到 `INDEX.md` 即判红）。

## 笔记树的结构红线（门禁 1）

除闭集（`{lifecycle}/{class}/`）、文件名 `yyyy-mm-dd-topic-title.md` 与相对链接断链检查外，门禁 1 还拒绝下列形态，实现在 `scripts/note-tree.ts`：

- **notes 根下只允许 `README.md`、`AGENTS.md`、`CLAUDE.md`**。其他 `.md` 判红：根级散落的笔记不属于任何生命周期，不报错就没有任何门禁看得见它。
- **`{lifecycle}/` 根下只允许 `AGENTS.md`、`CLAUDE.md`**：笔记必须落在 `{class}/` 里，直接放在生命周期根下判红。
- **非常规条目不静默跳过**：符号链接 / junction / 特殊文件报「无法校验（符号链接/junction/特殊文件）」，而不是被当成不存在——静默跳过等于让笔记凭空消失。
- **空树仍退 0**：`.agents/notes/` 下一篇笔记都没有时，门禁 1 打印「未发现任何笔记，请确认根目录正确（init 刚建完的空骨架属正常，仍退 0）」并**正常退出**。0 篇不是违规，别把它当错误；这句话只是让「根目录写错」与「合法空树」不至于输出同一行摘要。

## 文件名

`yyyy-mm-dd-topic-title.md`。日期是**首次提出日**（不是建档日、不是交付日）；`topic-title` 是文件名里唯一的自由位。

- **英文、全小写、连字符分词**，2–7 词（常规 3–5）：`2026-06-13-capability-seams`、`2026-06-21-bounded-llm-request-recovery`
- **写决策或机制本身**，不写动作、不写分类名、不写整句：`note-tree-anchor-check` 合格，`fix-note-tree` 不合格
- **不写中文、下划线、大写**：门禁对文件名的正则只有 `` /^\d{4}-\d{2}-\d{2}-.+\.md$/ ``——**不**校验大小写、连字符、词数，也不校验日期是否真实；这几条是**约定而非机检**。中英混排会让「新建前先搜同主题旧笔记」失效——搜索是拿文件名做的
- **取代旧篇的新篇**：日期仍写**该主张首次提出**的日期（通常等于被取代那篇的日期），`topic-title` 写新决定。否则同一条主张的两次记录会有两套日期语义，「按日期搜同主题旧笔记」照样失效

## 头块（前三行，门禁逐字核对）

```markdown
# Agent Note: <标题>

Status: <状态>
```

`Status` 四种形态，必须与所在生命周期目录一致：

- `proposed/` → `Status: proposed`
- `implemented/` → `Status: implemented`
- `rejected/` → `Status: rejected — <一句话原因>`（注意是 em dash，全角破折号门禁不认）
- `archived/` → `Status: implemented`，且**第 4 行必须是** `Archived: YYYY-MM-DD`（其余生命周期的第 4 行必须为空）

**状态行不带日期与括号**：`proposed` / `implemented` / `archived` 是门禁的逐字要求（多写日期或括号会被判红）；`rejected` 只是**约定**——门禁只要求匹配 `/^Status: rejected — .+$/`，理由里带日期或括号不会红，但仍按本约定写。文件名记首次提出日，git 记其余一切。

## 正文骨架

每篇以 `## Problem` 开头——动机要能**脱离方案独立成立**。

| 生命周期 | 骨架 |
|---|---|
| `proposed` | `## Problem` → `## Proposal` → …自由节… → `## Alternatives considered` → `## Acceptance criteria` → `## Risks` |
| `implemented` | `## Problem` → `## Decision` → …自由节… → `## Alternatives considered` → `## Consequences` |
| `rejected` | 与 `proposed` 同骨架（冻结的提案形态），结论在 `Status:` 行；验收标准与风险是「为什么否决」的依据，缺了判红 |
| `archived` | 与 `implemented` 同骨架；`Status:` 保持 `implemented`，第 4 行为 `Archived: YYYY-MM-DD` |

**`implemented` 与 `archived` 都禁止出现**（门禁正则为大小写不敏感）：`## Proposal`、`## Plan`、`## Migration plan`、`## Acceptance criteria` —— 门禁会拒绝，因为这些是提案用语，混进已交付记录会让读者分不清"做了没有"；`archived` 由 `implemented` 冻结而来，同等适用。

`## Alternatives considered` **必写**（门禁 2 校验）。唯一的替代是门禁 2 接受的逃生标记：在正文写一行 `<!-- alternatives: not-recorded -->`，仅用于从存量文档收割、原始材料确实没记录备选的笔记。该标记与 `## Alternatives considered` **不能同时出现**，同时出现门禁判红。

**引入新依赖时**（pom / package.json 里多一条），备选里必须有一条"不引入依赖"的写法——手写最小实现、复用已有能力，或改用它处已有的库——并说明为什么不够。缺了这条等于默认接受了新增的依赖树。

## Affected repositories

**本节缺失会被锚点门禁直接判红**——`verify-note-anchors.ts` 找不到 `## Affected repositories` 段即报错，直接以非零码退出；没有 `<!-- n/a -->` 之类的逃生门；段内为空、行格式不对、出现第二个段头同样判红。所以「没有涉及仓库」也要写成一行 `` - `仓库名` 不涉及 ``，而不是省略本节——门禁的正则是 `` /^-\s+`([^`]+)`\s+不涉及\s*$/ ``（`scripts/note-anchors.ts`），整行只写「不涉及」两个字会被判「无法解析」。**唯一例外是 `archived/`**：归档笔记整篇豁免锚点校验，该段可省可留，见 `references/archiving.md`。

段内形态（**示例**，仓库名 / 分支 / commit 按实际替换）：

```markdown
## Affected repositories

- `cloud` 分支 `v140-order-sync` commits `36a846d` `1ec68fa`
- `uniapp` 不涉及
```

每行一个仓库，两种形态：带分支与 commit，或明确写「不涉及」。**锚点会被实时校验**——分支或 commit 不存在、commit 不在声明的分支上，门禁都会报错。`commits` 后**只列短哈希**，不要在同一行附其他反引号内容（会被判为格式错误）。文件是否存在**由人工自检**，本门禁不校验（`gitTracksFile` 为预留能力，尚未接入）；自检时把路径写成 `<仓库名>:<仓库内相对路径>`，多仓库下才说得清是哪个仓库的文件。

项目根自身也是一个仓库：它的名字是 `.agents/intent-notes/config.yml` 里 `path: .` 对应的 `name`（默认取项目目录名）。单仓库项目下这就是唯一一行。

polyrepo 里笔记自己就住在容器仓库中，通常无法在本次提交里自指尚未产生的 commit：此时容器仓库写成 `` - `仓库名` 不涉及 ``，只锚定真正装了代码的子仓库——**本节仍要列全相关子仓库**，省略容器仓库不算缺项。

**`proposed/` 的提案还没有 commit 可指**：提案阶段把每个相关仓库写成 `` - `仓库名` 不涉及 ``，落地转 `implemented` 时再换成真实的分支与 commit——门禁实时查 git，填不存在的哈希必判红。提案阶段同样不许留假锚点（`templates/proposed.md` 就是按这个形态给的）。

**以 `templates/implemented.md` 起步时**，模板里 ``- `{{不涉及的仓库名}}` 不涉及`` 那一行**若项目里没有第二个仓库就整行删掉**——不要把它替换成一个不存在的仓库名，门禁 3 会报「仓库 `X` 未在项目声明中」。单仓库项目与 `references/plain-directory-mode.md` 的非代码工作目录都适用本条。

## 自由节

包拓扑、协议契约、schema 等放在 `Decision` 与 `Alternatives considered` 之间，保留可检索的机制名与 `must` / `may` / `never` 时序强调。一个事实只在一处讲透，其余用相对链接链过去。

## 时态

`proposed` 可用将来时；`implemented` 一律现在时，描述已落地事实。
