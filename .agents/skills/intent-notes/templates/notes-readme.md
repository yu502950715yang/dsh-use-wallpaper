# Agent Notes

本目录存放本项目的**决策笔记**：代码与文档承载不了的**为什么**，以及**放弃了什么**。

规则（何时写、怎么写、何时归档）见本项目的 `intent-notes` skill——位置由 harness 的扫描根决定（DSH 项目级为 `.agents/skills/intent-notes/`）。

本目录可能不是代码仓库：需求 / 资料类工作目录由 agent 代劳版本控制，见该 skill 的 `references/plain-directory-mode.md`。

## 布局与命名

`{lifecycle}/{class}/yyyy-mm-dd-topic-title.md`——路径同时编码**状态**与**分类**。

文件名日期是主题**首次提出**的日期，不是完成日期。`topic-title` 用英文小写、连字符分词、2–7 词，写决策或机制名。

### 生命周期（一级目录）

笔记随状态在目录之间移动：

| 目录 | 含义 |
|---|---|
| `proposed/` | 实施前评审的提案，尚未构建（或仅部分构建） |
| `implemented/` | 已交付，并与代码保持同步：路径、符号、默认值变了就**就地改**（只改事实，不改决策） |
| `rejected/` | 讨论后被否决；仅当它仍能避免一个诱人的错误时保留 |
| `archived/` | 冻结的历史。只有 `implemented/` 能进这里，路径中刻意不含 `implemented` 层。内容由 `archived/manifest.json` 的 SHA-256 封印保护：单篇改动、删除，以及**删掉 `manifest.json` / 删掉整棵归档树后重跑 `--write`** 都判红（封印清单只追加）。要改内容跑 `--reseal` 并写明理由，误归档先删文件再跑 `--forget`；确实要重新起封印才用 `--write --first-seal` |

`Status:` 行必须与所在目录一致。**唯一例外是 `archived/`**：它保持 `Status: implemented`，另在紧接的一行写 `Archived: YYYY-MM-DD`。

### 分类（二级目录）

分类是**决策的性质**，不是代码的形态。门禁拒绝闭集之外的目录：

| 分类 | 覆盖范围 |
|---|---|
| `feature` | 用户或模型看得见的新能力 |
| `bug-fix` | 修正缺陷，或补上事故复盘暴露的缺口 |
| `simplification` | **只删不增**：删代码、删行为、收窄对外范围 |
| `architecture` | **交付源码**怎么组织：包之间关系、模块边界、运行时词汇 |
| `process` | 围着代码转的工具、策略、工作流：门禁、包管理器、提交规范 |
| `testing` | 测试基础设施与策略 |

本表仅供速查，**判据以 skill 的 `references/classification.md` 为准**。

## 怎么找

浏览 `{lifecycle}/{class}/` 目录树，或直接检索仓库。**不要建 `INDEX.md`**：集中式索引会与笔记树同时腐化，找笔记靠搜索与链接。

笔记之间用相对 Markdown 链接互引，不要写编号。
