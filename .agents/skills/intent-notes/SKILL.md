---
name: intent-notes
description: 在交付项目或工作目录里留下并维护决策笔记（Agent Notes）。当一次改动改了行为、架构、跨文件契约、流程与工具链、测试策略、需求方向或范围，或落盘/网络/配置格式时，就在当前项目的 .agents/notes/ 下新建或更新一篇笔记；也用于在已有项目里初始化这套笔记体系（用户说「给这个项目建决策笔记」或「给这个项目建笔记体系」时）。需求 / 文档类工作目录即使不是 git 仓库也适用（由 agent 代劳版本控制，见 references/plain-directory-mode.md）。纯机械改动（格式化、无歧义重命名、不改行为的样式或依赖补丁、照已有契约的常规 CRUD）不写。
---

# Intent Notes

把决策的「为什么」和「放弃了什么」留在仓库里，供下一个改这段代码的人——无论人或 AI——读。

**本 skill 自包含**：目录结构、笔记格式、门禁校验、「何时写」的判定都不依赖任何其他方法论或工具链。装了 superpowers 之类的流程框架只是让触发更顺手，没装也照常工作。

## 零、会话开始先查改动

**工作目录里存在 `.agents/notes/` 时，会话开始先做三件事**：

1. `git status --short` —— 有未提交改动，说明产物被改过，必须走第一节判定
2. `git log --oneline -5` —— 有 agent 未记录的新提交，同样走第一节判定
3. `node "<skill-dir>/scripts/verify-note-anchors.ts" "<工作目录>"` —— 红了先按报错处理，再谈本次任务

门禁不会自己启动：没有这一步，「该写却没写」没有任何机制能发现。

## 一、先判要不要写

**命中以下任一项 → 必须写：**改了行为、改了架构、改了跨文件契约、改了流程与工具链、改了测试策略、改了落盘 / 网络 / 配置格式。

**机械改动 → 禁止写。** 纯排版格式化、错别字、无歧义重命名、不改行为的样式调整、不改行为的依赖补丁、版本打标、**照已有契约**的常规 CRUD（按现有类型与接口写的增删改查）、单模块内看 diff 即懂的显式逻辑修复。

**看着像机械、其实是契约决策**：新建此前不存在的类型、字段集或接口形状。哪怕只写十几行，它决定了别人以后要照着写什么，必须写笔记。判据：**这次改动有没有为别人定下新的"必须这样写"？**

判不准时从严。但记住：**过度留痕和完全不记，是同一个错误的两种样子。**

## 二、写之前判方向

- **往前看**：立新规——跨模块契约、状态流转规则、访问边界、运行时不变量
- **往回看**：记妥协——为看不见的约束放弃了更主流或更直觉的解法
- **做减法**：收窄——删代码、砍 API、下线流程的退出条件与迁移边界

## 三、目录即状态

`.agents/notes/{lifecycle}/{class}/yyyy-mm-dd-topic-title.md`（文件名日期 = **首次提出日**）

`topic-title` 是文件名里唯一的自由位：**英文小写、连字符分词、2–7 词**，写决策或机制名（如 `capability-seams`），不写动作与整句。

生命周期四个状态：`proposed`（待评审）、`implemented`（已交付，与代码同步）、`rejected`（被否决）、`archived`（冻结的历史）。合法迁移只有三条：`proposed → implemented`、`proposed → rejected`、`implemented → archived`——`implemented` 不会变成 `rejected`（见 `references/archiving.md`）。
分类闭集（不许自造）：`feature`、`bug-fix`、`simplification`、`architecture`、`process`、`testing`。

**禁止 `INDEX.md`**：集中式索引会与笔记树同时腐化，找笔记靠搜索与链接，不靠索引（门禁 1 在 `.agents/notes/` 根见到 `INDEX.md` 即判红）。

## 四、硬规则

**骨架标记不可翻译、不可改写。** 第 1 / 3 / 4 行与各生命周期的**必备段头**由门禁按字面匹配（标题只校验前缀 `# Agent Note: `，段头允许 ≤3 空格缩进、`##` 后空格或制表符），一律照抄：`# Agent Note: `、`Status: `、`Archived: `、`## Problem`、`## Proposal`、`## Decision`、`## Alternatives considered`、`## Acceptance criteria`、`## Risks`、`## Consequences` 保持英文，`## 涉及仓库` 保持中文。**…自由节…** 的段头和全部正文才用中文写——把 `## Problem` 译成 `## 问题` 会直接判红。

1. 前三行严格为 `# Agent Note: <标题>`、空行、`Status: <状态>`；`Status` 必须与所在目录一致——**唯一例外是 `archived/`**：它保持 `Status: implemented`，并在第 4 行写 `Archived: YYYY-MM-DD`（其余生命周期的第 4 行必须为空）。
2. `## Alternatives considered` **必写**：每个真考虑过的备选，先写它最强的理由，再解释为什么不用。没有过的选项不要编。存量收割的笔记若原始材料确实未记录备选，写 `<!-- alternatives: not-recorded -->`。
3. 一条笔记**永远不被改写成另一个决定**；决定或理由翻转 → 新开一篇并互链。
4. `implemented` 描述**已交付事实**（现在时）；路径、符号、默认值变了就地改，**不要追加变更流水账**。
5. 每篇必须声明**涉及仓库**（`## 涉及仓库` 一节）：polyrepo 项目列出所有相关子仓库，单仓库项目也列出那唯一一个；锚点由门禁实时校验，**本节缺失会被锚点门禁直接判红**——没有逃生标记，「没有涉及仓库」也要写成一行 `` - `仓库名` 不涉及 ``（仓库名照抄 `config.yml` 里的声明），不是省略本节——整行只写「不涉及」两个字会被判「无法解析」（`archived/` 豁免，见 `references/archiving.md`）。
6. 代码与笔记在**同一次改动**里落地（不是"同一次提交"）：笔记在项目根、代码在子仓库时，按「子仓库先提交代码 → 容器仓库提交笔记」成批提交——笔记的 commit 锚点只能指向**已存在**的 commit。别让笔记漂到下一个需求。同一仓库内（含非代码工作目录）同理：**先提交产物 → 再写笔记 → 最后提交笔记**。
7. 新建前先搜同主题旧笔记，命中就就地更新或互链，不留重复记录。
8. 本次改动若暴露了**会挡住后来者的既有问题**（例如项目约定的验证命令在当前基线就跑不通），在本次这篇笔记的自由节或 `## Risks` 里写一行并标明"既有、本次未修"——只留在会话里，下一个人会撞同一面墙。

## 五、详细规则（按需读取）

- **填空模板**：`templates/proposed.md`、`implemented.md`、`archived.md`、`rejected.md` —— 新建笔记时以对应模板起步，把 `{{...}}` 占位替换为真实内容，**项目里没有对应实体的占位行整行删掉**（如单仓库项目下模板里的 ``- `{{不涉及的仓库名}}` 不涉及`` 必须删，替换成不存在的仓库名会被门禁 3 报「仓库 `X` 未在项目声明中」）
- 格式细则：`references/note-format.md`
- 六分类判据：`references/classification.md`
- 何时新建 / 就地改 / 归档 / 不该写：`references/when-to-write.md`
- 取代与归档：`references/archiving.md`
- 写完自检：`references/quality-gate.md`
- 存量项目初始化：`references/bootstrap-existing-project.md`
- 非代码工作目录（需求 / PRD 文件夹，由 agent 代劳版本控制）：`references/plain-directory-mode.md`
- **笔记与 spec 的分工**：接口 / 格式 / 流程的**契约**归项目文档（`docs/`、下游改造说明等），**理由与取舍**归笔记；两者互链。写契约不等于写笔记，写笔记也不代替契约。

## 六、交给人之前

**先跑脚本门禁，再做人看的那五项。** 写完笔记立刻跑门禁 1、门禁 2（两者都在本 skill 基目录下的 `scripts/`）：

```bash
node "<skill-dir>/scripts/verify-note-tree.ts"   "<项目根>/.agents/notes"   # 门禁 1：结构
node "<skill-dir>/scripts/verify-note-format.ts" "<项目根>/.agents/notes"   # 门禁 2：格式
```

**门禁 1 / 2 接 notes 根，门禁 3 接项目根**——参数语义不同，别把项目根喂给门禁 1（门禁 3 见第零节那条 `verify-note-anchors.ts` 命令）。红了**就地修完再向用户报告**，不要带着红门禁交付。

再按 `references/quality-gate.md` 过五项人工自检（全是语义判断，脚本替不了），只向用户报告**缺口与写得好的地方**（≤5 行），缺口给具体修法。
