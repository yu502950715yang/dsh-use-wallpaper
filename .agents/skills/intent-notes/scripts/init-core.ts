/**
 * init 的纯逻辑：探测子仓库、渲染待写入的两份文本。
 *
 * 拆出来是为了让 init.ts 成为**无导出的纯 CLI**——旧写法靠
 * `fileURLToPath(import.meta.url) === resolve(process.argv[1])` 判断主入口，
 * 经 symlink/junction 到达时两侧不等，骨架静默不落盘（exit 0、零输出）。
 * 本模块只读文件系统、无模块级副作用，spec 直接 import 它。
 */
import { existsSync, readdirSync, statSync, type Dirent } from 'node:fs'
import { join } from 'node:path'

export const MARKER = '# --- Intent Notes ---'

/** junction/symlink 的 Dirent 是 isDirectory()=false（与 note-tree.ts 同口径）：跟随一次再判断。 */
function isRealDir(entry: Dirent, abs: string): boolean {
  if (entry.isDirectory()) return true
  if (!entry.isSymbolicLink()) return false
  try {
    return statSync(abs).isDirectory()
  } catch {
    return false
  }
}

/** 找出项目根下含 .git 的直接子目录，即 polyrepo 的子仓库。 */
export function detectSubRepos(projectRoot: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(projectRoot, { withFileTypes: true })) {
    // 漏掉 junction 子仓库，它既不被 .gitignore 排除、也不进 config.yml，首次 git add 会硬失败
    if (!isRealDir(entry, join(projectRoot, entry.name))) continue
    if (existsSync(join(projectRoot, entry.name, '.git'))) out.push(entry.name)
  }
  return out.sort()
}

/**
 * 找出**更深层**的 git 仓库（第一层子仓库内部不算：那属于该子仓库自己）。
 *
 * 只用于在计划里提示、不自动纳入：自动写进 `repos:` 与 `.gitignore` 等于替使用者猜项目结构，
 * 深层目录里也可能有依赖包自带的 `.git`。人工补条目本来就是 bootstrap 阶段 2 的分工。
 */
export function detectNestedRepos(projectRoot: string, known: readonly string[], maxDepth = 3): string[] {
  const found: string[] = []
  const walk = (rel: string, depth: number): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(join(projectRoot, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue // 隐藏目录（含 .git）不进
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (!isRealDir(entry, join(projectRoot, childRel))) continue
      if (existsSync(join(projectRoot, childRel, '.git'))) {
        if (!known.includes(childRel)) found.push(childRel)
        continue // 命中即止：仓库内部的仓库不归容器仓库管
      }
      if (depth < maxDepth) walk(childRel, depth + 1)
    }
  }
  walk('', 1)
  return found.sort()
}

/** 生成 .gitignore 片段：只排除探测到的子仓库，不掺入某个特定项目的模式。 */
export function renderGitignore(subRepos: string[]): string {
  const lines = [MARKER, ...subRepos.map(r => `/${r}/`), '']
  return lines.join('\n')
}

/**
 * YAML 双引号标量。目录名可能含 `#` 或 `: `：裸值会被 YAML 当注释或映射，
 * 值随即变空或截断——自家解析器读得动，别的工具读不动。
 */
function yamlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** 生成 .agents/intent-notes/config.yml。仓库名默认取其目录名。 */
export function renderConfig(project: string, subRepos: string[]): string {
  const lines = [`project: ${yamlString(project)}`, 'repos:']
  // 项目根自身也是一个仓库：单仓库项目下它就是唯一仓库，polyrepo 下它承载 .agents/ 与笔记。
  // 不写入它会让单仓库项目的 repos 为空，锚点门禁对每篇笔记恒报「仓库未在项目声明中」。
  lines.push(`  - path: ${yamlString('.')}`, `    name: ${yamlString(project)}`)
  for (const r of subRepos) lines.push(`  - path: ${yamlString(r)}`, `    name: ${yamlString(r)}`)
  lines.push('sources:', '  - docs/superpowers/specs', '  - docs/superpowers/plans', '  - docs/superpowers/sdd')
  return `${lines.join('\n')}\n`
}
