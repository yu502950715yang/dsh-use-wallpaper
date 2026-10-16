# 写完自检

结构靠脚本，意思靠人点头。先跑门禁 1、2 拿到机检结论，再过下面五项人工判断，最后向用户报告**缺口与写得好的地方**，总量 ≤5 行。

## 0. 先跑门禁 1、2

```bash
node "<skill-dir>/scripts/verify-note-tree.ts"   "<notes 根>"   # 门禁 1：结构、目录深度、文件名、相对链接
node "<skill-dir>/scripts/verify-note-format.ts" "<notes 根>"   # 门禁 2：头块、Status、必备节、Alternatives
```

**门禁 1 / 2 接 notes 根（`<项目根>/.agents/notes`），门禁 3 接项目根**——参数语义不同是这里最容易踩的坑；门禁 3（`verify-note-anchors.ts`）查什么见第 4 项。红了**就地修完再往下走**，不要带着红门禁交给人。

## 1. Problem 能独立成立吗

只看 `## Problem` 一节，读者能否明白为什么非做不可？如果必须读了方案才懂动机，**动机还没写清**。

## 2. 备选是真考虑过的吗

`## Alternatives considered` 里每一条：
- 先写了它**最强的理由**吗（不是稻草人）
- 解释清楚为什么不用了吗
- 有没有编造从没考虑过的选项（有则删）

## 3. Consequences 两面都写了吗

`## Consequences` 必须**同时**写收益与代价。**没有代价的决定是挑选过的**，读者会怀疑。

## 4. 事实挂锚点了吗

路径、符号、默认值、分支、commit——是否都真实？**仓库、分支、commit** 由本 skill 基目录下的 `scripts/verify-note-anchors.ts`（DSH 项目级部署即 `<项目根>/.agents/skills/intent-notes/scripts/verify-note-anchors.ts`，换 harness 换成对应扫描根）实时查 git 校验；**文件是否存在由人工自检**（路径写成 `<仓库名>:<仓库内相对路径>`），本门禁不校验（`gitTracksFile` 为预留能力，尚未接入），但写的时候就要自检，不要留给门禁擦屁股。

笔记里的**相对 Markdown 链接**另由门禁 1（本 skill 基目录下的 `scripts/verify-note-tree.ts`）做**断链检查**：链接目标在磁盘上不存在即判红——别链到还没写的笔记，也别写错相对层级。

## 5. 时态与位置对吗

- `implemented` 全现在时；出现"计划""将要""待实现"就是放错地方了
- 决定了就放对生命周期目录，别把 `proposed` 的骨架留在 `implemented` 里

## 报告形态

只报缺口与亮点，每行一条，缺口带具体修法。不要复述笔记内容，不要客套。
