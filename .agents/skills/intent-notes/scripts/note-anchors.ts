/**
 * 解析并校验笔记的「涉及仓库」声明。
 *
 * 与 DSH 的差别：DSH 是 monorepo，笔记不需要声明涉及哪个仓库；
 * 本体系面向 polyrepo，声明必须锚定到真实的仓库、分支与 commit，
 * 且事实一律实时查 git，不信任文档里的声明。
 *
 * 纯模块：无模块级副作用（CLI 在 verify-note-anchors.ts），backfill 也会 import 本模块。
 */
import { spawnSync } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fenceAwareLines } from './note-text.ts'

export interface DeclaredRepo {
  name: string
  /** 声明涉及时必填。 */
  branch?: string
  commits: string[]
  notInvolved: boolean
  /** 在笔记中的行号，从 1 开始，用于报错定位。 */
  line: number
}

export interface ParseResult {
  repos: DeclaredRepo[]
  errors: string[]
}

const SECTION = '## 涉及仓库'
const NOT_INVOLVED = /^-\s+`([^`]+)`\s+不涉及\s*$/
/** 段头允许 ≤3 空格缩进，`##` 后至少一个空白（空格或制表符）；段内遇到任何二级标题即结束。 */
const SECTION_HEADER = /^ {0,3}##[ \t]+涉及仓库[ \t]*$/
const ANY_H2 = /^ {0,3}##[ \t]/

/**
 * 从笔记正文解析「涉及仓库」段。
 *
 * 代码围栏内的 `##` 不算文档结构（围栏判定见 note-text.ts，两处门禁共用）——
 * 否则记录本格式的笔记会把围栏里的示例段头当成真段头，既误红合法笔记、又漏掉真锚点。
 *
 * 只校验**第一个**段：出现第二个 `## 涉及仓库` 即报错，否则重复段会整段逃过校验（假绿）。
 */
export function parseAnchors(text: string): ParseResult {
  const prose = fenceAwareLines(text)
  const headers = prose.filter(l => SECTION_HEADER.test(l.text))
  const first = headers[0]
  if (first === undefined) {
    return { repos: [], errors: [`缺少 \`${SECTION}\` 段`] }
  }

  const errors: string[] = []
  const duplicate = headers[1]
  if (duplicate !== undefined) {
    errors.push(
      `第 ${duplicate.index + 1} 行：重复的 \`${SECTION}\` 段（第 ${first.index + 1} 行已出现）——只校验第一个，请合并成一个`,
    )
  }

  const repos: DeclaredRepo[] = []
  for (const line of prose) {
    if (line.index <= first.index) continue
    const raw = line.text
    if (ANY_H2.test(raw)) break
    const body = raw.trimEnd()
    if (body === '') continue

    const notInvolved = NOT_INVOLVED.exec(body)
    if (notInvolved !== null) {
      repos.push({ name: notInvolved[1] ?? '', commits: [], notInvolved: true, line: line.index + 1 })
      continue
    }

    const m = /^-\s+`([^`]+)`\s+分支\s+`([^`]+)`\s+commits\s+(.+)$/.exec(body)
    if (m === null) {
      errors.push(`第 ${line.index + 1} 行无法解析：期望「- \`仓库\` 分支 \`分支名\` commits \`短哈希\`…」或「- \`仓库\` 不涉及」`)
      continue
    }
    // commits 后可列多个短哈希：全部提取并逐个校验格式，否则第二个起会被静默放过
    const commitMatches = [...(m[3] ?? '').matchAll(/`([^`]+)`/g)].map(x => x[1] ?? '')
    if (commitMatches.length === 0) {
      errors.push(`第 ${line.index + 1} 行没有列出任何 commit 短哈希`)
      continue
    }
    const bad = commitMatches.filter(c => !/^[0-9a-f]{7,40}$/.test(c))
    if (bad.length > 0) {
      errors.push(`第 ${line.index + 1} 行的 commit 短哈希格式不对：${bad.map(c => `\`${c}\``).join(' ')}`)
      continue
    }
    repos.push({ name: m[1] ?? '', branch: m[2] ?? '', commits: commitMatches, notInvolved: false, line: line.index + 1 })
  }

  // 只有在段内确实没有内容时才报「空」；已有逐行错误时再报「空」会掩盖真正原因
  if (repos.length === 0 && errors.length === 0) errors.push(`${SECTION} 段为空：至少列出一个仓库，或写明「不涉及」`)
  return { repos, errors }
}

export interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
  /** 仅当 spawn 本身失败（典型：git 不在 PATH）时有值，用于与「命令跑起来但退出非 0」区分。 */
  error?: NodeJS.ErrnoException
}

export function git(repoPath: string, args: string[]): GitResult {
  // core.quotepath 默认开启会把非 ASCII 路径输出成八进制转义（`"\344\270\255..."`）：
  // backfill 会把这种假路径写进笔记，basename 启发式也永远匹配不上旧笔记。
  // `-c` 必须在子命令之前，放后面会被 git 当成子命令的参数。
  const r = spawnSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: repoPath, encoding: 'utf8' })
  // 保留 stderr：出问题时能区分「git 不在 PATH」「路径不是仓库」与「分支确实不存在」
  const out: GitResult = {
    ok: r.status === 0,
    stdout: (r.stdout ?? '').trim(),
    stderr: (r.stderr ?? r.error?.message ?? '').trim(),
  }
  if (r.error !== undefined) out.error = r.error
  return out
}

interface RepoListItem {
  name?: string
  path?: string
  /** config.yml 里的 1-based 行号。 */
  line: number
}

/**
 * 解析 `.agents/intent-notes/config.yml` 的 `repos:` 段，返回 仓库名 → 路径 与配置错误。
 *
 * 按「`- ` 开新条目、累积 `path`/`name`、下一条目或段末提交」解析：YAML 键序对写的人
 * 没有约束（bootstrap 阶段 2 就是人工补条目），只认 `path` 在前会让 `name` 在前的条目静默消失。
 * 重复仓库名记入 errors 而不是静默覆盖——覆盖后只校验最后一条路径，写错的那条永远查不出来。
 */
export function parseRepoListChecked(configText: string): { repos: Map<string, string>; errors: string[] } {
  const repos = new Map<string, string>()
  const errors: string[] = []
  const unquote = (s: string): string => s.replace(/^["']|["']$/g, '')
  const lines = configText.replace(/\r\n?/g, '\n').split('\n')

  let inRepos = false
  let pending: RepoListItem | null = null

  const assign = (key: string | undefined, value: string): void => {
    if (pending === null) return
    if (key === 'path') pending.path = value
    else if (key === 'name') pending.name = value
  }

  const commit = (): void => {
    if (pending === null) return
    const item = pending
    pending = null
    if (item.name === undefined || item.path === undefined) {
      errors.push(`config.yml 第 ${item.line} 行：repos 条目必须同时有 name 与 path（键序不限）`)
      return
    }
    if (repos.has(item.name)) {
      errors.push(`config.yml 第 ${item.line} 行：仓库名 \`${item.name}\` 重复（已声明路径 \`${repos.get(item.name) ?? ''}\`）`)
      return
    }
    repos.set(item.name, item.path)
  }

  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trimEnd()
    // 顶层键后面允许跟 YAML 注释；flow 风格（`repos: [...]`）不支持，会落到「没解析出任何仓库」的配置错
    if (/^repos:\s*(#.*)?$/.test(line)) {
      inRepos = true
      continue
    }
    // 注释行既不是顶层键也不是条目：顶格注释曾让旧写法直接 break，
    // 其后的仓库条目被静默丢弃（不报任何错）
    if (inRepos && /^\s*#/.test(line)) continue
    // 遇到下一个顶层键（sources: 等）即结束；`- ` 序列行与 `repos:` 同缩进也是合法 YAML，不能当成顶层键
    if (inRepos && /^\S/.test(line) && !/^-\s/.test(line)) break
    if (!inRepos) continue

    const item = /^\s*-\s*(.*)$/.exec(line)
    if (item !== null) {
      commit()
      pending = { line: i + 1 }
      const inline = /^(path|name):\s*(.+?)\s*$/.exec(item[1] ?? '')
      if (inline === null) {
        // `- ` 后面什么都没有的条目留给下面 `path:`/`name:` 行补齐；有内容但解析不了的直接报错、不再叠一条「缺 name/path」
        const rest = (item[1] ?? '').trim()
        if (rest !== '') {
          errors.push(`config.yml 第 ${i + 1} 行：无法解析的 repos 条目「${rest}」`)
          pending = null
        }
      } else {
        assign(inline[1], unquote(inline[2] ?? ''))
      }
      continue
    }

    // 值取整行剩余（而非首个非空白词）：Windows 上路径/仓库名含空格很常见，
    // 用 (\S+) 会把这类条目静默丢弃，进而让锚点门禁对每篇笔记恒红
    const kv = /^\s*(path|name):\s*(.+?)\s*$/.exec(line)
    if (kv !== null && pending !== null) assign(kv[1], unquote(kv[2] ?? ''))
  }
  commit()

  return { repos, errors }
}

/** `parseRepoListChecked` 的简化包装：只要映射，供 init/backfill 这类不报配置错的老调用方使用。 */
export function parseRepoList(configText: string): Map<string, string> {
  return parseRepoListChecked(configText).repos
}

export interface RepoRootIssue {
  name: string
  path: string
  reason: string
}

/** 归一为可直接比较的形式：解析符号链接/junction、统一分隔符，并忽略大小写（Windows 路径大小写不敏感）。 */
function canonicalPath(p: string): string {
  let real: string
  try {
    real = realpathSync(p)
  } catch {
    real = resolve(p)
  }
  return real.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * 预检配置里的每个仓库路径都必须是**独立仓库根**。
 *
 * git 会向上寻找仓库：path 只是上层仓库里的普通目录时，`git -C path` 会把上层仓库的分支与
 * commit 判为有效，锚点事实层随即假绿（子仓库被删掉 .git、人工补条目补错层级都会这样）。
 * 同一次预检吃掉四义诊断：git 不在 PATH / 路径不存在 / 不是仓库 / 属于上层仓库。
 */
/** `checkRepoRoots` 的可选放宽条件。 */
export interface CheckRepoRootsOptions {
  /** 允许「不在任何 git 仓库内」的仓库名：容器根可以先于首次提交存在（见 backfill）。 */
  allowNonRepo?: ReadonlySet<string>
}

export function checkRepoRoots(repos: Map<string, string>, options: CheckRepoRootsOptions = {}): RepoRootIssue[] {
  const issues: RepoRootIssue[] = []
  for (const [name, path] of repos) {
    let isDir = false
    try {
      isDir = statSync(path).isDirectory()
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      issues.push({ name, path, reason: code === 'ENOENT' ? '路径不存在' : `路径不可访问（${code ?? 'unknown'}）` })
      continue
    }
    if (!isDir) {
      issues.push({ name, path, reason: '路径不是目录' })
      continue
    }
    const top = git(path, ['rev-parse', '--show-toplevel'])
    if (!top.ok) {
      // git 不可用（top.error）不豁免：那是环境问题，不是「容器根还没首次提交」
      if (top.error === undefined && options.allowNonRepo?.has(name) === true) continue
      issues.push({
        name,
        path,
        reason: top.error !== undefined
          ? `git 不可用（${top.error.code ?? top.error.message}），无法校验仓库根`
          : '不是 git 仓库',
      })
      continue
    }
    if (canonicalPath(top.stdout) !== canonicalPath(path)) {
      issues.push({ name, path, reason: `不是独立仓库根：实际属 ${top.stdout}` })
    }
  }
  return issues
}

/** 仓库里是否存在该分支（本地或远程）。 */
export function gitHasBranch(repoPath: string, branch: string): boolean {
  const local = git(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
  if (local.ok) return true
  const remote = git(repoPath, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`])
  return remote.ok
}

/** 仓库里是否存在该 commit（任意分支）。 */
export function gitHasCommit(repoPath: string, sha: string): boolean {
  return git(repoPath, ['cat-file', '-e', `${sha}^{commit}`]).ok
}

/** 该 commit 是否为指定分支的祖先。 */
export function gitBranchContains(repoPath: string, branch: string, sha: string): boolean {
  const candidates = [branch, `origin/${branch}`]
  for (const ref of candidates) {
    // 本地分支与远程分支可能只有一处存在，先确认 ref 本身可解析再判祖先关系
    if (!git(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).ok) continue
    if (git(repoPath, ['merge-base', '--is-ancestor', sha, ref]).ok) return true
  }
  return false
}

/** 仓库是否跟踪该文件。 */
export function gitTracksFile(repoPath: string, file: string): boolean {
  return git(repoPath, ['cat-file', '-e', `HEAD:${file}`]).ok
}

/**
 * 校验单篇笔记的锚点。`repos` 为 仓库名 → 绝对路径。
 * 返回违规清单（空数组即通过）。调用方应先跑 checkRepoRoots 确认每个路径都是独立仓库根。
 */
export function verifyAnchors(noteRel: string, text: string, repos: Map<string, string>): string[] {
  const { repos: declared, errors } = parseAnchors(text)
  const out = errors.map(e => `anchors: ${noteRel} — ${e}`)
  for (const d of declared) {
    const path = repos.get(d.name)
    if (path === undefined) {
      out.push(`anchors: ${noteRel} — 仓库 ${d.name} 未在项目声明中（检查 .agents/intent-notes/config.yml）`)
      continue
    }
    if (d.notInvolved) continue
    const branch = d.branch ?? ''
    if (!gitHasBranch(path, branch)) {
      out.push(`anchors: ${noteRel} — 仓库 ${d.name} 的分支 ${branch} 不存在`)
      continue
    }
    for (const sha of d.commits) {
      if (!gitHasCommit(path, sha)) {
        out.push(`anchors: ${noteRel} — 仓库 ${d.name} 中不存在 commit ${sha}`)
        continue
      }
      if (!gitBranchContains(path, branch, sha)) {
        out.push(`anchors: ${noteRel} — 仓库 ${d.name} 的 commit ${sha} 不在分支 ${branch} 上`)
      }
    }
  }
  return out
}
