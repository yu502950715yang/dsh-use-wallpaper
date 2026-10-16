# 非代码工作目录

适用：需求 / PRD / 资料这类**非代码**的工作目录。使用者往往不使用 git，所以由 **agent 代劳版本控制**：agent 建仓库、提交产物、写笔记；使用者只说需求。

本模式**不改任何程序**：它复用现有的 git 锚点链路（`init` 建仓库、笔记锚定 commit、门禁 3 实时校验）。锚点比自研快照更强——保留完整历史，`backfill` 也可用。

## 前提（不满足就不要开始）

| 前提 | 检查 |
|---|---|
| Node ≥ 22.18 | `node --version` |
| git 可用 | `git --version` |
| 提交身份已配 | `git config user.email`、`git config user.name` |
| 目录在**本地磁盘** | 同步盘（OneDrive、企业网盘）的同步会损坏 `.git`，**不要**在这种目录上使用 |
| 目录**不在**任何 git 仓库内 | `git -C "<工作目录>" rev-parse --show-toplevel` 报 `not a git repository` 才是本形态 |

**目录已经在上层仓库里**（常见如代码仓库的 `docs/prd/`）时：直接用那个仓库走常规形态，**不要再嵌套 `init`**——嵌套的 `.git` 会被上层仓库当成 gitlink，两边的 `git status` 互相看不见对方的改动。

**git 不可用时：不要下载或安装任何软件。** 停止初始化，如实报告原始错误，让使用者决定（自己安装 git，或改走备选方案）。本 skill 的职责是记录决策，不是管理系统依赖。

**提交身份缺失时，在该目录内配，不要改全局配置**（免得用别人的名字污染全机提交）：

```bash
git -C "<工作目录>" config user.email "<你的邮箱>"
git -C "<工作目录>" config user.name "<你的名字>"
```

先自检、再 `init`：这样失败信息是人话，而不是一行裸命令错误。

## 初始化

本节是 `SKILL.md` 第零节 git 命令的**前置动作**：工作目录还没有 `.git` 时，先跑 `init`（它会 `git init`）；**在那之前**，第零节的 `git status --short` 与 `git log --oneline -5` 在该目录只会报 `fatal: not a git repository`，那是预期结果、不是故障。

```bash
node "<skill-dir>/scripts/init.ts" "<工作目录>"
git -C "<工作目录>" branch --show-current     # 记下分支名，笔记要照抄（可能是 master）
```

`init` 会：`git init`（目标无 `.git` 时）→ 建 `.agents/notes/` 四生命周期 × 六分类 → 写 `.agents/intent-notes/config.yml`（`repos: - path: .`）与 `.agents/notes/README.md` → 追加 `.gitignore` 片段。

**必补 `.gitignore`**（Office 锁文件不排除，每次打开文档都会产生假改动）：

```gitignore
~$*
.~lock.*
*.tmp
```

**先写工作目录自己的 `AGENTS.md`**：本形态没有子仓库指针，只需一条「重要改动需在本项目 `.agents/notes/` 留笔记」（见 `references/bootstrap-existing-project.md` 阶段 2）。

**然后做首次提交，把上面这些都纳入**——否则 `.agents/` 与 `.gitignore` 会永久停在 `git status` 里，第零节「有未提交改动」的判据每个会话都会被它们误触发一次（`.gitignore` 要先补好、`AGENTS.md` 要先写出来，否则首次提交要么漏掉规则、要么因 `pathspec did not match` 整条失败）：

```bash
git -C "<工作目录>" add .agents .gitignore AGENTS.md
git -C "<工作目录>" commit -m "chore: 建立 Agent Notes 骨架"
```

## 每次改动的流程

1. 改产物（PRD、需求文档）
2. `git status --short` 看改动范围
3. 按 `SKILL.md` 第一节判**要不要写笔记**
4. `git add` **指定文件**（不要 `git add -A`，免得把密码、原始素材、临时文件带进去）
5. `git commit`：中文，一句话说清改了什么
6. 写笔记（若需要）：在 `## 涉及仓库` 段写锚点行，格式真源是 `references/note-format.md` 的「涉及仓库」一节。这里只说两点最容易踩的：

   - 锚点行必须**顶格写、不要缩进**：门禁按行首匹配，缩进会被判「无法解析」
   - 三个占位换真值：仓库名用工作目录名（即 `config.yml` 里 `path: .` 那条的 `name`），分支名用 `git branch --show-current` 的结果，短哈希用上一步 commit 的短哈希

   以 `templates/implemented.md` 起步时，模板里 ``- `{{不涉及的仓库名}}` 不涉及`` 那一行**若没有对应仓库就整行删掉**——留着会被门禁 3 报「仓库 `占位内容` 未在项目声明中」，而本形态的首篇笔记没有第二个仓库，必然命中。
7. 跑**门禁 1、2**：本形态没有 CI、没有子仓库，这两条脚本是唯一的机检兜底——

   ```bash
   node "<skill-dir>/scripts/verify-note-tree.ts"   "<工作目录>/.agents/notes"   # 门禁 1：结构
   node "<skill-dir>/scripts/verify-note-format.ts" "<工作目录>/.agents/notes"   # 门禁 2：格式
   ```

   参数语义：门禁 1 / 2 接 **notes 根**（`<工作目录>/.agents/notes`），门禁 3 接**项目根**（即 `SKILL.md` 第零节那条 `verify-note-anchors.ts`）。红了就地修完再提交笔记。
8. 提交笔记，**产物先提交、笔记后提交**（笔记的 commit 锚点只能指向已存在的 commit）：

   ```bash
   git add ".agents/notes/{lifecycle}/{class}/<笔记文件名>"
   git commit -m "notes: <一句话说清这篇笔记记的是什么>"
   ```

## 三个坑

- **第一篇笔记之前必须先有一次提交**：空仓库还没有分支 ref，此时写笔记会让门禁 3 报「分支不存在」
- **commit 前先看 `git status`**：由 agent 代劳提交，意味着可能把不该进仓库的东西提交进去
- **中文文件名会被转义**：默认 `core.quotepath=true` 下 `git status --short` 把中文名显示成 `"PRD-\347\231\273..."`。这只影响**显示**：未提交改动的信号完好，也能从 `git diff --stat` 看出是哪个文件；想让名字可读就 `git config core.quotepath false`

## 代价

Word / Excel / PPT 是二进制，每次改动全量入库，仓库会膨胀。PRD 这种量级可接受，但要知情。

## 不做的

只在本地做最小提交：不推远端、不开分支工作流、不配置 CI。
