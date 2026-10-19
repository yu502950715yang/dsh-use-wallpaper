# 取代与归档

## 归档的对象

**只有 `implemented` 能归档**，所以归档路径里刻意没有 `implemented` 层：`archived/{class}/yyyy-mm-dd-topic-title.md`。

## 归档笔记的格式

归档**不是**改状态，而是冻结：`Status:` 保持 `implemented`，并在**第 4 行**（紧接状态行之后）插入归档日期：

```markdown
# Agent Note: <标题>

Status: implemented
Archived: YYYY-MM-DD
```

其余骨架与 `implemented` 相同（`## Problem` → `## Decision` → `## Alternatives considered` → `## Consequences`）。门禁会校验第 4 行的存在与格式，也会拒绝归档笔记里的提案用语。**归档只移动既有笔记，不要用模板新建**；`templates/archived.md` 仅供对照格式。

**归档笔记豁免锚点校验。** 锚点门禁（`verify-note-anchors.ts`）整篇跳过 `archived/` 下的笔记——归档已冻结、不再作为当前行为的权威依据，分支与 commit 不再实时核对；格式门禁的必备节里也不含 `## Affected repositories`。所以从 `implemented` 冻结成 `archived` 时，该段**可以省略，也可以保留原样**：段内的分支、commit 随代码漂移不算失效，不必为它更新锚点，也不会因此判红（`templates/archived.md` 仍带该段，照抄或删掉都合规）。

## 归档会改路径：入站链接要同批修完

归档把文件从 `implemented/{class}/` 挪到 `archived/{class}/`，**活跃笔记里指向旧路径的相对链接随即断链**，门禁 1 会判红（`archived/` 自己豁免链接校验，问题只出在引用方）。所以归档动作是三件事，缺一不可：移文件并插 `Archived:` 行 → 修入站链接 → 跑封印。

修入站链接按引用意图分三种处置：

- 引用的是**当前权威**（大多数情况）→ 重定向到取代它的新篇；
- 引用的是**历史快照本身**（"当初这么做，因为…"）→ 保留，改写为 `archived/` 下的路径；
- 只是顺带提到 → 删掉这句引用。

先搜再改：`grep -rn "<topic-title>" .agents/notes`。指向归档笔记的链接本身是允许的：活跃笔记里这些链接的**目标存在性仍由门禁 1 校验**，只有归档笔记自身的链接被豁免（不再跟着目标改名），所以重定向到新篇之前要确认新篇确实承载了那条理由。

**归档笔记自己不再改**（冻结自归档时刻起）。`SKILL.md` 硬规则 3 要求「新开一篇并互链」，在归档场景下的落地方式是：在把旧篇移进 `archived/` 的**同一次改动**里，先在旧篇加一行指向新篇的说明，再连同 `Archived:` 行一起冻结；此后旧篇一个字都不动。

## 封印：归档不可变的机械保证

归档后**永久冻结**不是一句约定——`archived/` 下每篇笔记的内容都有 SHA-256 封印存在 `archived/manifest.json` 里（哈希按归一化行尾后的文本算，跨平台 checkout / clone 不会误报），由**门禁 4**（`verify-note-seal.ts`）校验。**是否装 `pre-commit`（`install-hook.ts`）由你决定**：装了也只在这个提交碰到 `archived/` 时才查封印，碰到 `.agents/notes/` 时才查结构格式，只改代码的提交零开销（与 `SKILL.md` 第六节同口径）。

归档一篇笔记时必须**在同一次改动里**完成封印：

```bash
node "<skill-dir>/scripts/verify-note-seal.ts" "<项目根>/.agents/notes" --write   # 门禁 4：封印新产物
node "<skill-dir>/scripts/verify-note-seal.ts" "<项目根>/.agents/notes"           # 只校验
```

**清单只追加**：`--write` 先证明既有条目一条未变，再加入新产物；任何既有条目哈希不符即整体拒绝。所以「改文件 + 重跑 `--write`」洗不白改动。封印进过版本控制之后，**删掉整棵 `archived/`、删掉 `manifest.json`、或把它改写成空 `artifacts` 后再跑 `--write`** 也一律判红（不留痕的重封等于没有封印）——只有 `--write --first-seal` 显式放行。

封印产物要进版本控制才有意义：提交时**把 `archived/manifest.json` 与笔记一起 `git add`**（装了 hook 的话，漏 add manifest 会被直接拦下）。

**要改已封存的内容**（唯一的例外通道，会留痕在 `manifest.json` 的 `history` 里）：

```bash
node "<skill-dir>/scripts/verify-note-seal.ts" "<notes 根>" --reseal <class>/<file>.md --reason "<为什么必须改>"
```

**误归档**（整篇都不该存在）时，先删文件、再撤销封存：

```bash
node "<skill-dir>/scripts/verify-note-seal.ts" "<notes 根>" --forget <class>/<file>.md --reason "<为什么撤销>"
```

门禁 4 只认 `artifacts`：`--reseal` 把哈希更新为新值，`--forget` 删掉条目，`history` 仅供审计、不参与判定——否则「有人回滚了 manifest 而文件是新内容」这类真实的不一致也会被放行。

**存量项目首次启用**：项目里已有归档笔记、且版本控制里**从没有过** `archived/manifest.json` 时，先跑一次 `--write` 把整棵树封上（见 `bootstrap-existing-project.md`）。若版本控制里有过 manifest 而磁盘上没有，说明封印是被删的：默认判红，确认要重新起封印再补 `--first-seal`。notes 根不在 git 仓库内（非代码工作目录形态）时探测不到 HEAD，退化为按磁盘判断。

## 删除，而不是归档

纯机械或仅描述小 UI 调整的 implemented 笔记，**直接删除**（含它的入站链接修复）。删除判据先于保留/归档判断。

**不要**为了凑数归档；字数与存续时间只是发现线索，**从来不是判据**。

## 该保留还是该归档

保留活跃，当以下任一项仍有可能指导未来的改动：

- 决策依据（rationale）
- 备选方案
- **否定性保证**（"这里绝不能做 X"）
- 持久化语义或协议语义
- 归属边界
- 安全规则
- **重新引入条件**（"将来若支持 Y，就该把这个加回来"）

否则归档。归档后**永久冻结**：不再编辑、翻译、重格式化、移动或删除，也不作为当前行为的权威依据。

归档时一次性定稿；**此后即使路径、符号或默认值变了也不再改**——`SKILL.md` 硬规则 4 的「就地改」只适用于活跃笔记，与本条不冲突。需要修正归档笔记里的内容就新开一篇并互链（见下节「被部分取代」）。

**怎么发现候选**：会话开始时跑 `audit-notes.ts`，它会列出 `implemented/` 全部笔记的存续天数、字数与入链数。清单只提供线索——**字数与存续时间从来不是判据**，是否归档仍是读一遍内容后的语义判断（判据就是本节那七条）。

## 被完全取代

新笔记必须**先继承旧篇的全部独有内容**——决策依据、备选方案、后果、必需验证、明确指出的覆盖缺口——然后才允许把旧篇**归档并封印**（仅纯机械或小 UI 调整的旧篇按「删除，而不是归档」直接删除）。**不得让 git 历史成为决策依据的唯一副本。**

## 被部分取代

两篇都留，互相加相对链接，只更新仍然成立的事实。

## implemented 不会变成 rejected

`rejected/` 只收**从未落地**的提案。已交付的决定被推翻时，不要把它改成 `rejected`：新开一篇 `implemented/` 记录新决定，与旧篇互链，旧篇按上文归档（或按删除判据直接删）。

## proposed 不归档

过时的提案转 `rejected`，并写清为什么否决——**绝不归档**。

已被某个 `implemented` 方案取代的提案同样转 `rejected`（`Status:` 行点明它败给了哪一篇，并与新篇互链）：留在 `proposed/` 会显得仍在评审中（目录即状态），直接删则丢掉「当初为什么看好它」。只有当它连「诱人的错误」都算不上时才删（判据见上文「删除，而不是归档」）。

## rejected 的取舍

只在这个败选方案仍然是**一个诱人且影响重大的错误**时保留；否则整篇删除。
