/**
 * backfill：从单个漏写的 commit 提取补写笔记所需的上下文。
 *
 * 与初始化阶段的「历史收割」共用同一条链路：
 *   commit → 涉及文件 → 分支 → 版本前缀 → 所属需求
 * 「版本前缀」是**可选增强**：只从提交主题提取，没有就不出该行，无此约定的项目照常工作。
 * 刻意不用分支名兜底提取版本——分支可随时改名或合并，不适合当需求标识；所属需求改用分支/目录/文档归组。
 *
 * 采集与渲染的逻辑在 backfill-core.ts；本文件是**纯 CLI**、不导出任何东西，
 * 因此不需要 `import.meta.url === argv[1]` 入口守卫——那个守卫在脚本路径经
 * symlink/junction 到达时会 fail-open，整段 CLI 被跳过并 exit 0。
 *
 * 只读：除 stdout/stderr 外不写任何文件。
 * 用法：node scripts/backfill.ts <commit> [项目根]
 * 输出一段 markdown，交给 AI 据此写出一篇符合格式的笔记。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { checkRepoRoots, git, parseRepoList } from './note-anchors.ts'
import { walkAgentNoteTree } from './note-tree.ts'
import { collectCommitContext, renderBackfill, type CommitContext } from './backfill-core.ts'

const sha = process.argv[2]
if (sha === undefined) {
  console.error('用法：node scripts/backfill.ts <commit> [项目根]')
  process.exit(1)
}
const projectRoot = resolve(process.argv[3] ?? process.cwd())
const configPath = join(projectRoot, '.agents', 'intent-notes', 'config.yml')
if (!existsSync(configPath)) {
  console.error(`backfill: ${configPath} 不存在`)
  process.exit(1)
}
// config 里存的是相对路径，而 checkRepoRoots 与后续探测都要绝对路径
const repos = new Map<string, string>()
for (const [name, rel] of parseRepoList(readFileSync(configPath, 'utf8'))) repos.set(name, resolve(projectRoot, rel))
// 每个 path 必须是独立仓库根：git 会向上寻找仓库，path 只是上层仓库里的普通目录时
// cat-file 会命中上层仓库，渲染出的锚点行把外层 commit 记在子仓库名下（错锚点进永久笔记）。
// 例外只有容器根自身「完全不在任何仓库内」：笔记可以先于首次提交存在，那不算配置错。
const containerNames = new Set([...repos].filter(([, path]) => path === projectRoot).map(([name]) => name))
const rootIssues = checkRepoRoots(repos, { allowNonRepo: containerNames })
if (rootIssues.length > 0) {
  console.error('backfill: 仓库清单预检失败（每个 path 必须是独立仓库根）：')
  for (const i of rootIssues) console.error(`  repos: ${i.name}（${i.path}）— ${i.reason}`)
  process.exit(1)
}
const notesRoot = join(projectRoot, '.agents', 'notes')

let ctx: CommitContext | undefined
let repoName = ''
// cat-file 失败有三种成因——git 不在 PATH、路径不是仓库、commit 确实不在——
// 只用「都找不到」一句话盖住会让真正的原因（配置写错、git 缺失）无从下手，
// 所以逐仓库带上 git 自己的 stderr（note-anchors 的 git() 已保留它）。
const probeErrors: string[] = []
for (const [name, repoPath] of repos) {
  const probe = git(repoPath, ['cat-file', '-e', `${sha}^{commit}`])
  if (probe.ok) {
    ctx = collectCommitContext(name, repoPath, sha)
    repoName = name
    break
  }
  probeErrors.push(`  - ${name}（${repoPath}）：${probe.stderr === '' ? 'git 无 stderr，但退出非 0' : probe.stderr}`)
}
if (ctx === undefined) {
  console.error(`backfill: 在声明的 ${repos.size} 个仓库里都找不到 commit ${sha}`)
  for (const e of probeErrors) console.error(e)
  process.exit(1)
}

const matched: string[] = []
if (existsSync(notesRoot)) {
  const { notes, errors } = walkAgentNoteTree(notesRoot)
  // note-tree 规定调用方把非空 errors 视为致命：静默会漏报相关笔记，诱导 AI 新建重复笔记
  if (errors.length > 0) {
    // note-tree 的契约是「调用方把非空 errors 视为致命」：结构不可信时相关笔记会漏报，
    // 照常产出片段等于诱导 AI 新建重复笔记
    console.error('backfill: 笔记树结构有问题，可能漏报相关笔记：')
    for (const e of errors) console.error(`  ${e}`)
    process.exit(1)
  }
  // basename 命中是提示性启发式，只要求命中处两侧都不是名字字符——
  // 否则 `data.ts` 会因为含子串 `a.ts` 而误报。不给 index.ts/package.json 这类通用名加白名单：
  // 漏报会诱导 AI 新建重复笔记，代价高于多看几篇（输出已标「可能相关，请先查重」）。
  const baseRes = ctx.files
    .map(f => f.split('/').at(-1) ?? '') // `?? ''` 只为满足类型：上游已滤掉空行
    .filter(base => base !== '')
    .map(base => new RegExp(`(?<![\\w.-])${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`))
  for (const note of notes) {
    if (note.lifecycle === 'archived') continue
    let text: string
    try {
      text = readFileSync(join(notesRoot, note.rel), 'utf8')
    } catch {
      console.error(`backfill: 笔记不可读，已跳过：${note.rel}`)
      continue
    }
    if (baseRes.some(re => re.test(text))) matched.push(note.rel)
  }
}

console.log(renderBackfill(ctx, matched))
console.error(`backfill: 命中仓库 ${repoName}，改动 ${ctx.files.length} 个文件，疑似相关笔记 ${matched.length} 篇`)
