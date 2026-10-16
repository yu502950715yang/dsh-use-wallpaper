/**
 * backfill 的纯逻辑：commit 上下文采集与 markdown 渲染。
 *
 * 拆出来是为了让 backfill.ts 成为**无导出的纯 CLI**——旧写法靠
 * `fileURLToPath(import.meta.url) === resolve(process.argv[1])` 判断主入口，
 * 经 symlink/junction 到达时两侧不等，整个 CLI 被静默跳过（exit 0、零输出）。
 * 本模块无模块级副作用，spec 直接 import 它。
 */
import { git } from './note-anchors.ts'

export interface CommitContext {
  repo: string
  sha: string
  subject: string
  /** 包含该 commit 的分支（本地与远程，已清洗前缀）。 */
  branches: string[]
  files: string[]
  versionPrefix?: string
}

/**
 * 从提交主题提取形如 `v14：` / `v1400:` 的版本前缀。
 *
 * 位数 2–4：`v14` 这种两位版本必须认（旧写法 `\d{3,4}` 漏掉），5 位以上是单号而非版本
 * （`v14001：` 不命中）。`(?!\d)` 把「数字串到此为止」写明，免得日后放宽分隔符时只吃前几位。
 */
export function extractVersionPrefix(subject: string): string | undefined {
  return /^\s*([vV]\d{2,4})(?!\d)\s*[：:]/.exec(subject)?.[1]
}

/**
 * 清洗 `git branch -a --contains` 的输出。
 *
 * 标记恒为「标记字符 + 空格」两字符：`* ` 是当前分支、`+ ` 是链接 worktree。
 * 真名可以以 `+` 开头（`+work`、`+` 都是合法 refname，`*work` 不是），
 * 所以只剥带空格的前缀；而 refname 禁止空格，`+ ` 不可能属于真名本身。
 */
export function parseBranchLines(stdout: string): string[] {
  return stdout.split('\n')
    .map(s => s.trim().replace(/^[+*] /, '').replace(/^remotes\/origin\//, ''))
    // 除 detached 的两种拼写（at/from）外，symref 行（`HEAD -> origin/main`）也不是可用分支名
    // 只滤带空格的箭头：git 允许分支名含 `->`（check-ref-format 通过），不能一概滤掉
    .filter(s => s !== '' && !s.startsWith('(HEAD detached ') && !s.includes(' -> '))
}

/** 采集一个 commit 的上下文。sha 可以是全哈希或短哈希。 */
export function collectCommitContext(repoName: string, repoPath: string, sha: string): CommitContext {
  const full = git(repoPath, ['rev-parse', sha])
  if (!full.ok) throw new Error(`仓库 ${repoName} 中找不到 commit ${sha}`)
  const commit = full.stdout
  // 直接取全哈希前 7 位：用户侧 core.abbrev < 7 时 `--short` 会给不足 7 位的哈希，
  // 而锚点门禁要求 ^[0-9a-f]{7,40}$
  const short = commit.slice(0, 7)

  const subjectRes = git(repoPath, ['log', '-1', '--format=%s', commit])
  if (!subjectRes.ok) throw new Error(`仓库 ${repoName} 无法读取 commit ${short} 的提交信息：${subjectRes.stderr}`)

  // merge commit 下 `git show --name-only` 默认返回空；--first-parent 对非 merge 输出完全一致
  const filesRes = git(repoPath, ['show', '--name-only', '--format=', '--first-parent', commit])
  if (!filesRes.ok) throw new Error(`仓库 ${repoName} 无法列出 commit ${short} 的改动文件：${filesRes.stderr}`)
  const files = filesRes.stdout.split('\n')
    .map(s => s.trim())
    .filter(s => s !== '')

  // --no-color 必须在子命令之后（git 的全局选项里没有 --no-color，放前面直接 unknown option 退出 129）。
  // 用户设了 color.branch=always 时标记无色而名字带 ANSI，不清掉就会得到假分支名。
  const branchesRes = git(repoPath, ['branch', '--no-color', '-a', '--contains', commit])
  if (!branchesRes.ok) throw new Error(`仓库 ${repoName} 无法列出包含 commit ${short} 的分支：${branchesRes.stderr}`)
  const branches = parseBranchLines(branchesRes.stdout)

  const ctx: CommitContext = { repo: repoName, sha: short, subject: subjectRes.stdout, branches, files }
  const prefix = extractVersionPrefix(subjectRes.stdout)
  if (prefix !== undefined) ctx.versionPrefix = prefix
  return ctx
}

/** 片段用法。整段粘贴会让笔记出现第二个 `## Affected repositories` 段头，门禁 3 判「重复段」。 */
const USAGE = [
  '> 这是补写笔记的素材**片段，不是笔记**：不要整段粘贴。',
  '> `## Affected repositories` 段里只有锚点行要搬进笔记的锚点段（段头不要重复），其余事实据此重写正文。',
]

/**
 * 列出改动文件。空提交（`--allow-empty`、纯 merge）没有文件可列，
 * 留下悬空冒号会被读成「内容被截断」，必须点明原因。
 */
function pushFiles(lines: string[], files: string[]): void {
  if (files.length === 0) {
    lines.push('- 改动文件：该提交没有任何文件改动（很可能是空提交），不能据此补写笔记')
    return
  }
  lines.push(`- 改动文件（${files.length} 个）：`)
  for (const f of files) lines.push(`  - \`${f}\``)
}

/** 渲染成可贴进笔记的 markdown 片段。 */
export function renderBackfill(ctx: CommitContext, matchedNotes: string[]): string {
  const primaryBranch = ctx.branches[0]
  // 没有分支就整段不出：段内写 `(未知分支)` 或提示行都会被自家门禁判红
  // （前者过不了 verifyAnchors，后者过不了 parseAnchors），等于制造必红片段。
  // 但事实载荷仍要给出——AI 补写笔记靠的就是它，丢了它这条命令在无分支场景下几乎没用。
  if (primaryBranch === undefined) {
    const facts: string[] = [
      ...USAGE,
      '',
      '> 未找到包含该提交的分支，无法生成锚点行；请确认分支后手动补写仓库段。',
      '',
      `- 提交：\`${ctx.sha}\` ${ctx.subject}`,
    ]
    if (ctx.versionPrefix !== undefined) facts.push(`- 版本前缀：\`${ctx.versionPrefix}\``)
    pushFiles(facts, ctx.files)
    if (matchedNotes.length > 0) {
      facts.push('', '## 可能相关的既有笔记（请先查重，命中的就地更新或互链）', '')
      for (const n of matchedNotes) facts.push(`- \`${n}\``)
    }
    // 两条路径给出同等行动指引：缺了尾注，AI 拿到片段也不知道要产出笔记
    facts.push('', '> 请依据以上事实补写一篇笔记：Problem 写清动机，Decision 用现在时写已交付事实，', '> Alternatives considered 写当时真考虑过的备选（原始材料没记录则写 `<!-- alternatives: not-recorded -->`）。')
    return facts.join('\n')
  }

  const lines: string[] = []
  lines.push(...USAGE, '')
  lines.push('## Affected repositories', '')
  lines.push(`- \`${ctx.repo}\` 分支 \`${primaryBranch}\` commits \`${ctx.sha}\``)
  lines.push('', '## 待补写的事实', '')
  lines.push(`- 提交：\`${ctx.sha}\` ${ctx.subject}`)
  if (ctx.versionPrefix !== undefined) lines.push(`- 版本前缀：\`${ctx.versionPrefix}\``)
  lines.push(`- 包含该提交的分支：${ctx.branches.map(b => `\`${b}\``).join('、') || '（未找到）'}`)
  pushFiles(lines, ctx.files)
  if (matchedNotes.length > 0) {
    lines.push('', '## 可能相关的既有笔记（请先查重，命中的就地更新或互链）', '')
    for (const n of matchedNotes) lines.push(`- \`${n}\``)
  }
  lines.push('', '> 请依据以上事实补写一篇笔记：Problem 写清动机，Decision 用现在时写已交付事实，', '> Alternatives considered 写当时真考虑过的备选（原始材料没记录则写 `<!-- alternatives: not-recorded -->`）。')
  return lines.join('\n')
}
