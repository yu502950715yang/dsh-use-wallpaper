/**
 * 门禁 3：锚点。跨仓库校验每篇笔记「涉及仓库」段里的仓库、分支、commit。
 *
 * 事实一律实时查 git —— 已验证的教训：文档里声明的分支基线会与现实脱节。
 * 启动时先预检每个 config path 都是独立仓库根：git 会向上寻找仓库，
 * 不预检就会把上层仓库的分支与 commit 判为有效（事实层假绿）。
 *
 * 用法：node scripts/verify-note-anchors.ts [项目根]（省略则取 cwd；门禁 1/2 接的是 notes 根）
 * 项目根省略时取 cwd；仓库映射读 <项目根>/.agents/intent-notes/config.yml 的 repos 段。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { walkAgentNoteTree } from './note-tree.ts'
import { checkRepoRoots, parseRepoListChecked, verifyAnchors } from './note-anchors.ts'

const projectRoot = resolve(process.argv[2] ?? process.cwd())
const notesRoot = join(projectRoot, '.agents', 'notes')
const configPath = join(projectRoot, '.agents', 'intent-notes', 'config.yml')

if (!existsSync(notesRoot)) {
  console.error(`verify-note-anchors: ${notesRoot} 不存在`)
  process.exit(1)
}
if (!existsSync(configPath)) {
  console.error(`verify-note-anchors: ${configPath} 不存在，无法得知仓库清单`)
  process.exit(1)
}

// 受控报错：config.yml 是目录（EISDIR）或不可读时，Node 的裸栈不会说清读的是哪个文件
let configText: string
try {
  configText = readFileSync(configPath, 'utf8')
} catch (e) {
  console.error(`verify-note-anchors: ${configPath} 不可读（${(e as NodeJS.ErrnoException).code ?? 'unknown'}）`)
  process.exit(1)
}
const { repos: rawRepos, errors: configErrors } = parseRepoListChecked(configText)
if (configErrors.length > 0) {
  console.error('verify-note-anchors: 仓库清单配置有误：')
  for (const e of configErrors) console.error(`  ${e}`)
  process.exit(1)
}
if (rawRepos.size === 0) {
  // 逐篇刷「未在项目声明中」会把真正原因（配置里一个仓库都没有）埋掉
  console.error(
    `verify-note-anchors: ${configPath} 的 repos 段没有解析出任何仓库；至少要写上项目根自身（- path: .），否则每篇笔记都会报「未在项目声明中」`,
  )
  process.exit(1)
}

const repos = new Map<string, string>()
for (const [name, rel] of rawRepos) repos.set(name, resolve(projectRoot, rel))

const rootIssues = checkRepoRoots(repos)
if (rootIssues.length > 0) {
  console.error('verify-note-anchors: 仓库清单预检失败（每个 path 必须是独立仓库根）：')
  for (const i of rootIssues) console.error(`  repos: ${i.name}（${i.path}）— ${i.reason}`)
  process.exit(1)
}

const { notes, errors } = walkAgentNoteTree(notesRoot)
let checked = 0
for (const note of notes) {
  if (note.lifecycle === 'archived') continue // 归档笔记已冻结，锚点不再实时校验
  checked++
  let text: string
  try {
    text = readFileSync(join(notesRoot, note.rel), 'utf8')
  } catch {
    // 单篇不可读只该让这一篇红，不能整体中断、把其余笔记的结论一起吞掉
    errors.push(`anchors: ${note.rel} — 不可读`)
    continue
  }
  errors.push(...verifyAnchors(note.rel, text, repos))
}

if (errors.length === 0) {
  // 0 篇时「锚点全部有效」是无信息的断言：与门禁 1/2 同口径，点明根目录可能写错
  console.log(
    checked === 0
      ? 'verify-note-anchors: 未发现任何笔记，请确认根目录正确（init 刚建完的空骨架属正常，仍退 0）。'
      : `verify-note-anchors: 检查 ${checked} 篇笔记（归档已冻结，不计入），锚点全部有效（${repos.size} 个仓库）。`,
  )
  process.exit(0)
}
console.error('verify-note-anchors: 发现违规：')
for (const e of errors) console.error(`  ${e}`)
process.exit(1)
