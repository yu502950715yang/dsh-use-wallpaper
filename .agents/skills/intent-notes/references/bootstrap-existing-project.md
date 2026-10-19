# 存量项目初始化

存量项目**不补齐历史**：很多决策的理由已不可考，硬补只会产出似是而非的推测。

原则：**建骨架 + 选择性收割 + 从今天开始记。**

## 阶段 1：建骨架（程序做，零判断）

```bash
# <skill-dir> = 本 skill 的基目录（加载时给出的 Base directory），<项目根> 换成实际路径
node "<skill-dir>/scripts/init.ts" "<项目根>"
```

`<skill-dir>` 随安装形态变：skill 随项目走时它就在项目内（DSH 的落点如 `<项目根>/.agents/skills/intent-notes`，换 harness 可能是别的根）；skill 还留在独立开发仓库里时是 `<仓库>/skills/intent-notes`。**该放哪由 harness 的扫描根决定，不归本 skill 规定**；本文只约定一件事：**对自身文件的引用一律相对本 skill 基目录**——写死某一种形态的路径，换一种就 `ERR_MODULE_NOT_FOUND`。

它做这些事：探测 git 子仓库清单 → 项目根 `git init`（若尚未）→ 建 `.agents/notes/` 四生命周期 × 六分类目录 → 写 `.agents/intent-notes/config.yml`（锚点门禁的仓库清单输入）与 `.agents/notes/README.md`（子仓库指针的落点）→ 追加 `.gitignore` 片段（只排除探测到的子仓库）。**本阶段不提交**：首次提交放到阶段 2 写完 `AGENTS.md` 之后（见阶段 2 第 6 步）。此后每次改动的提交顺序是**子仓库先提交代码 → 容器仓库提交笔记**（笔记的 commit 锚点只能指向已存在的 commit，见 `SKILL.md` 硬规则 6）。

**skill 文件本身不在 `init` 的职责内**：它必须整目录位于目标项目的某个 skill 扫描根下（DSH 项目级如 `<项目根>/.agents/skills/intent-notes/`）——`SKILL.md`、`references/`、`templates/`、`scripts/` **全部**（含 `scripts/note-text.ts` 这类被别的脚本 import 的模块，以及 `init.ts`、`backfill.ts`、`note-tree.ts` 等）。脚本彼此按同目录相对导入，只挑部分文件会在运行时 `ERR_MODULE_NOT_FOUND`；复制时**整目录搬，不要手挑**。

## 阶段 2：重建项目 AGENTS.md（AI + 人确认）—— 最关键

1. 读现有 `AGENTS.md` 与各仓库内的模块 `AGENT.md`
2. 提取当前真正生效的规矩：构建命令、代码风格、提交规范、子仓库边界、跨仓库协作规则
3. **修正漂移**：把子仓库清单与磁盘实际目录对齐。清单来自 `.agents/intent-notes/config.yml` 的 `repos:` 段——比 `init` 探测到的更深层仓库，手工往这里补条目（`path:` / `name:` 键序不限；注释行任意缩进都安全）。**不要写行内注释**：`#` 会被当成值的一部分，该条 path 随即判「路径不存在」
4. 每条规矩挂链接，指向对应笔记；笔记尚未写就时先指向已有的 spec / plan
5. 在**每个子仓库的 `AGENT.md`** 追加一条指针（相对路径按该 `AGENT.md` 到项目根的深度换算：`init` 探测到的直接子仓库用 `../`；更深的仓库按其深度调整）：

   > 重要改动需在本项目 `.agents/notes/` 留笔记；规则见 `../AGENTS.md` 与 `../.agents/notes/README.md`。

6. **首次提交（由人确认）**：把 `.agents/`、`.gitignore` 与写好的 `AGENTS.md` 一起纳入容器仓库的第一次提交。

## 阶段 3：选择性收割（AI 筛选 + AI 判断）

先由 **AI 遍历筛候选**：按 `.agents/intent-notes/config.yml` 的 `sources:` 段列出的目录（`init` 写入 `docs/superpowers/specs`、`plans`、`sdd`），连同根目录需求文档一起读，挑出含取舍、方案对比、根因分析的；再用「文档声明的文件 → `git log --all` → commit」标记其代码是否仍在。`scripts/` 下**没有**候选筛选程序，`config.yml` 的 `sources:` 段除 `init` 写入（`scripts/init-core.ts`）外**没有消费者**——它只是 AI 的遍历入口。

再由 AI 逐份判断：

| 存量文档类型 | 处置 |
|---|---|
| 架构级决策（包结构、模块边界、跨服务契约） | 高优先收割 |
| 已约定的规范（版本前缀、提交格式、目录约定） | 高优先收割 |
| 根因修复 | 中优先 |
| 功能设计（已实现且稳定） | 选择性，只挑仍可能被推翻的 |
| 一次性排查脚本、临时方案、已被取代的实现 | 不收割 |
| 已被后续决策取代 | 不收割，或改写为 `rejected/` |

**版本前缀是可选增强，不是收割前提**：它只从提交主题提取（`extractVersionPrefix`），没有这个约定的项目该行自动省略、`backfill` 照常工作；这类项目的「所属需求」改用分支名、目录结构或文档标题归组。**不用分支名兜底提取版本**：分支可随时改名或合并，不适合当需求标识。

判据：**它还会不会指导未来的改动？** 预期产出远少于文档总数。

收割出的笔记若原始材料确实没记录备选方案，在 `## Alternatives considered` 位置写 `<!-- alternatives: not-recorded -->`。

## 阶段 4：给已有归档上封印

存量项目往往已有 `archived/` 笔记（本 skill 之前没有封印机制）。在阶段 3 结束后跑一次全量封印，把整棵归档树记进 `archived/manifest.json`：

```bash
node "<skill-dir>/scripts/verify-note-seal.ts" "<项目根>/.agents/notes" --write
```

**必须在开始用 hook 之前做**：没有 manifest 时门禁 4 会把每篇归档笔记都报成「未封存」。这一步是一次性的——此后每归档一篇跑 `--write` 只追加。

## 阶段 5：转入日常

之后所有命中 `SKILL.md` 第一节清单的改动由 AI 顺手写新笔记。**初始化是一次性的，运行是持续的。**

## 分工

| 角色 | 职责 |
|---|---|
| 程序 | 探测、建骨架、查锚点、跑门禁 |
| AI | 重建 `AGENTS.md`、按 `sources:` 段遍历筛候选、逐份判断存量文档、写笔记、挂锚点 |
| 人 | **只做确认**：AI 抛出收割清单，人划掉不需要的 |

## 分批

初始化的候选文档可能很多。**AI 先筛、分批交付**，或用 subagent 并行处理，不交给单个会话硬啃。

## 非代码工作目录（另一种形态）

目标不是代码仓库，而是需求 / PRD / 资料文件夹时，流程按 `references/plain-directory-mode.md` 走。与上面五个阶段的差别：

- **阶段 1**：同一个 `init`，但由 agent 代劳版本控制（`init` 会 `git init`）；目录必须在**本地磁盘**
- **阶段 2**：**不需要**给子仓库铺指针（没有子仓库），只需写工作目录自己的 `AGENTS.md`
- **阶段 3**：**不适用**——没有 commit 历史可收割，从今天开始记
- **前提**：那台机器有 git。没有时**不要自行安装**，报告后由人决定
