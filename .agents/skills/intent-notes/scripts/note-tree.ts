/**
 * Agent Note 树的结构真源：生命周期与分类都是闭集，被全部门禁 import。
 *
 * 移植自 DeepSeek Harness 的 scripts/agent-note-tree.ts（MIT, Copyright (c) 2026 DeepSeek），
 * 两处改造：① 改由调用方传入根目录，以便在任意目标项目上运行；
 * ② 去掉中英双语的 .zh.md 旁路，本体系为中文单语。
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/** 活跃生命周期闭集（`.agents/notes/` 下的一级目录）。 */
export const AGENT_NOTE_LIFECYCLES = ['proposed', 'implemented', 'rejected'] as const

/**
 * 分类闭集（生命周期下的二级目录）。新增分类是刻意行为：必须同时改这里
 * 与 `references/classification.md`，门禁会拒绝任何未列出的目录。
 */
export const AGENT_NOTE_CLASSES = [
  'feature',
  'bug-fix',
  'simplification',
  'architecture',
  'process',
  'testing',
] as const

/** 归档目录：已实施的笔记冻结于此，路径中刻意不含 `implemented` 层。 */
export const ARCHIVE_DIR = 'archived'

/** 允许直接放在生命周期根下的非笔记 Markdown。 */
const LIFECYCLE_ROOT_ALLOWLIST = new Set(['AGENTS.md', 'CLAUDE.md'])

/** 允许直接放在 notes 根下的 Markdown：`README.md` 由 init 写入，另两个是项目级约定文件。 */
const NOTES_ROOT_ALLOWLIST = new Set(['README.md', 'AGENTS.md', 'CLAUDE.md'])

/** 非常规条目（链接/特殊文件）的报错措辞：静默跳过等于让笔记凭空消失。 */
const UNVERIFIABLE = '无法校验（符号链接/junction/特殊文件）'

/** 文件名必须形如 `yyyy-mm-dd-topic-title.md`。 */
const NOTE_FILENAME = /^\d{4}-\d{2}-\d{2}-.+\.md$/

/** 一棵树里的一篇 Agent Note。 */
export interface AgentNote {
  /** 所在生命周期目录名，可能是 `archived`。 */
  lifecycle: string
  /** 相对 root 的路径，正斜杠分隔。 */
  rel: string
  /** 文件名里的 `yyyy-mm-dd`。 */
  date: string
}

/**
 * 递归列出某目录下全部 `.md`（扩展名大小写不敏感）。
 *
 * 只把「不存在」当空；「不可读」与「非常规条目（链接/特殊文件）」必须报错，否则门禁会假绿。
 */
function listMarkdown(root: string, dir: string, errors: string[]): string[] {
  const out: string[] = []
  let entries
  try {
    entries = readdirSync(join(root, dir), { withFileTypes: true })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      errors.push(`structure: ${dir}/ — 目录不可读（${(e as NodeJS.ErrnoException).code ?? 'unknown'}）`)
    }
    return out
  }
  for (const entry of entries) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) out.push(...listMarkdown(root, rel, errors))
    else if (entry.isFile()) {
      if (entry.name.toLowerCase().endsWith('.md')) out.push(rel)
    } else {
      // junction 的 Dirent 是 isDir=false / isSymlink=true，旧写法把它连笔记一起丢掉
      errors.push(`structure: ${rel} — ${UNVERIFIABLE}`)
    }
  }
  return out
}

/**
 * 遍历 Agent Note 树并校验结构，覆盖 `proposed` / `implemented` / `rejected` / `archived`。
 * 返回全部合法笔记与逐条违规；调用方把非空 `errors` 视为致命。
 *
 * `notes` 为空**不是**违规（init 刚建完的空骨架必须能通过），
 * 但调用方打印摘要时应提示「未发现任何笔记」，否则「路径写错」与「合法空树」不可区分。
 */
export function walkAgentNoteTree(root: string): { notes: AgentNote[]; errors: string[] } {
  const notes: AgentNote[] = []
  const errors: string[] = []

  let topLevel
  try {
    topLevel = readdirSync(root, { withFileTypes: true })
  } catch (e) {
    // EACCES（权限）与 ENOENT（路径写错）必须能分辨，否则「根目录不对」与「没权限」都是同一句话
    const code = (e as NodeJS.ErrnoException).code ?? 'unknown'
    return { notes, errors: [`structure: ${root} — 不存在或不可读（${code}）`] }
  }

  for (const entry of topLevel) {
    if (entry.name === 'INDEX.md') {
      errors.push('structure: INDEX.md — 集中式索引被禁止；请浏览 lifecycle/class 目录树或检索仓库')
      continue
    }
    if (entry.isDirectory()) {
      const isKnown = (AGENT_NOTE_LIFECYCLES as readonly string[]).includes(entry.name)
      if (entry.name !== ARCHIVE_DIR && !isKnown) {
        errors.push(
          `structure: ${entry.name}/ — 未知生命周期目录（允许：${AGENT_NOTE_LIFECYCLES.join(', ')}，外加 ${ARCHIVE_DIR}/）`,
        )
      }
      continue
    }
    if (entry.isFile()) {
      // 根级散落的笔记不属于任何生命周期：不报错就没有任何门禁看得见它
      if (entry.name.toLowerCase().endsWith('.md') && !NOTES_ROOT_ALLOWLIST.has(entry.name)) {
        errors.push(
          `structure: ${entry.name} — 笔记必须放在 {lifecycle}/{class}/ 下；notes 根下只允许 ${[...NOTES_ROOT_ALLOWLIST].join(', ')}`,
        )
      }
      continue
    }
    // 顶层 junction/symlink（如 drafts → 别处）既不是目录也不是文件，曾连闭集报错都不触发
    errors.push(`structure: ${entry.name} — ${UNVERIFIABLE}`)
  }

  // 分类目录名先单独校验：空的自造分类目录不含 .md，listMarkdown 看不见它，
  // 「门禁拒绝闭集之外的目录」就会对空目录失效。按目录报一条，含笔记时不再逐篇重复。
  const unknownClassDirs = new Set<string>()
  for (const lifecycle of [...AGENT_NOTE_LIFECYCLES, ARCHIVE_DIR]) {
    try {
      for (const entry of readdirSync(join(root, lifecycle), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue // 链接/特殊文件由 listMarkdown 报「无法校验」
        if ((AGENT_NOTE_CLASSES as readonly string[]).includes(entry.name)) continue
        const rel = `${lifecycle}/${entry.name}`
        unknownClassDirs.add(rel)
        errors.push(`structure: ${rel}/ — 未知分类目录 "${entry.name}"（允许：${AGENT_NOTE_CLASSES.join(', ')}）`)
      }
    } catch {
      continue // 生命周期目录缺失/不可读：listMarkdown 会按原有口径报错
    }
  }

  for (const lifecycle of [...AGENT_NOTE_LIFECYCLES, ARCHIVE_DIR]) {
    for (const match of listMarkdown(root, lifecycle, errors).sort()) {
      const segs = match.split('/')
      // 深度 2 单独给一条消息：走「深度不是 3」会让「生命周期根下塞了个 md」显得像路径写错
      if (segs.length === 2) {
        if (LIFECYCLE_ROOT_ALLOWLIST.has(segs[1] ?? '')) continue
        errors.push(
          `structure: ${match} — 生命周期根下只允许白名单文件（${[...LIFECYCLE_ROOT_ALLOWLIST].join(', ')}）；笔记必须放在 {class}/ 下`,
        )
        continue
      }
      const cls = segs[1]
      const base = segs[2]
      if (segs.length !== 3 || cls === undefined || base === undefined) {
        errors.push(`structure: ${match} — 期望 {lifecycle}/{class}/file.md（实际深度 ${segs.length}）`)
        continue
      }
      if (!(AGENT_NOTE_CLASSES as readonly string[]).includes(cls)) {
        // 目录级错误已在上面报过（含笔记时也只保留一条），避免同一问题刷屏
        if (!unknownClassDirs.has(`${lifecycle}/${cls}`)) {
          errors.push(`structure: ${match} — 未知分类目录 "${cls}"（允许：${AGENT_NOTE_CLASSES.join(', ')}）`)
        }
        continue
      }
      if (!NOTE_FILENAME.test(base)) {
        errors.push(`structure: ${match} — 文件名必须为 yyyy-mm-dd-topic-title.md`)
        continue
      }
      notes.push({ lifecycle, rel: match, date: base.slice(0, 10) })
    }
  }

  return { notes, errors }
}
