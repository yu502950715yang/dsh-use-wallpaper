/**
 * 归档候选清单：列出 implemented/ 全部笔记的存续天数、字数与入链数。
 *
 * 只读、不判红、不写文件。它的存在是为了让「有没有该归档的」变成每次会话开始看得见的
 * 一张表，而不是凭记忆——**清单只提供线索**，是否归档仍是读一遍内容后的语义判断。
 *
 * 用法：node scripts/audit-notes.ts [notes 根]
 *   环境变量 INTENT_NOTES_TODAY=YYYY-MM-DD 覆盖「今天」（供测试固定时间）
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { ARCHIVE_DIR, walkAgentNoteTree } from './note-tree.ts'
import { fenceAwareLines, proseLines, toLines } from './note-text.ts'
import { isIndentedCodeBlock, localLinkTargets } from './note-links.ts'

const notesRoot = resolve(process.argv[2] ?? join(process.cwd(), '.agents', 'notes'))
const { notes, errors } = walkAgentNoteTree(notesRoot)

if (errors.length > 0) {
  console.error('audit-notes: 笔记树结构有问题，先按门禁 1 修完再看清单：')
  for (const e of errors) console.error(`  ${e}`)
  process.exit(1)
}

/** 本地日期 YYYY-MM-DD；`INTENT_NOTES_TODAY` 供测试注入。 */
function today(): string {
  const injected = process.env.INTENT_NOTES_TODAY
  return injected !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(injected)
    ? injected
    : new Date().toLocaleDateString('sv-SE')
}

/** 两个 YYYY-MM-DD 之间的整天数（后者减前者）。 */
function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`)
  const b = Date.parse(`${to}T00:00:00Z`)
  return Math.round((b - a) / 86_400_000)
}

const counts = { proposed: 0, implemented: 0, rejected: 0, [ARCHIVE_DIR]: 0 } as Record<string, number>
for (const note of notes) counts[note.lifecycle] = (counts[note.lifecycle] ?? 0) + 1

/** 活跃笔记的绝对路径集合，用于把一条链接解析回目标笔记。 */
const active = notes.filter(n => n.lifecycle !== ARCHIVE_DIR)
const absOf = (rel: string): string => resolve(join(notesRoot, rel))

const inbound = new Map<string, number>()
for (const note of active) {
  let text: string
  try {
    text = readFileSync(join(notesRoot, note.rel), 'utf8')
  } catch {
    continue // 不可读由门禁 1 报，清单不重复报
  }
  const rawLines = toLines(text)
  const hit = new Set<string>()
  for (const line of fenceAwareLines(text)) {
    if (isIndentedCodeBlock(line.text, rawLines[line.index - 1])) continue
    for (const target of localLinkTargets(line.text)) {
      const resolved = resolve(dirname(join(notesRoot, note.rel)), target)
      if (resolved !== absOf(note.rel)) hit.add(resolved)
    }
  }
  for (const target of hit) inbound.set(target, (inbound.get(target) ?? 0) + 1)
}

/** 非空白字符数：中英文混排下比 split(/\s+/) 更接近「有多少内容」。 */
function wordCount(text: string): number {
  return proseLines(text).join('\n').replace(/\s/g, '').length
}

const now = today()
const rows = notes
  .filter(n => n.lifecycle === 'implemented')
  .map(n => {
    let text = ''
    try {
      text = readFileSync(join(notesRoot, n.rel), 'utf8')
    } catch {
      // 不可读由门禁 1 报
    }
    return { rel: n.rel, days: daysBetween(n.date, now), words: wordCount(text), links: inbound.get(absOf(n.rel)) ?? 0 }
  })
  .sort((a, b) => b.days - a.days)

console.log(
  `audit-notes: implemented ${counts.implemented ?? 0} 篇 · ${ARCHIVE_DIR} ${counts[ARCHIVE_DIR] ?? 0} 篇 · proposed ${counts.proposed ?? 0} 篇 · rejected ${counts.rejected ?? 0} 篇`,
)
console.log('')
console.log('字数与存续时间只是发现线索，从来不是归档判据（见 references/archiving.md）。')
if (rows.length === 0) {
  console.log('implemented/ 下没有笔记，无候选。')
} else {
  console.log('按存续天数降序：')
  for (const r of rows) console.log(`  ${r.days}天  ${r.words}字  ${r.links}入链  ${r.rel}`)
}
