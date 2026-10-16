/**
 * 门禁 1：结构。消费 note-tree.ts 的结果并补上它不覆盖的检查（笔记间相对链接）。
 *
 * 检查思路移植自 DeepSeek Harness 的 scripts/verify-agent-note-tree.ts（MIT, Copyright (c) 2026 DeepSeek）；
 * 相对链接的断链检查为本项目新增。
 *
 * 用法：node scripts/verify-note-tree.ts [notes 根]（省略则取 <cwd>/.agents/notes；门禁 3 接的是项目根）
 * root 省略时取 <cwd>/.agents/notes。
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { ARCHIVE_DIR, walkAgentNoteTree } from './note-tree.ts'
import { fenceAwareLines, toLines } from './note-text.ts'

const root = resolve(process.argv[2] ?? join(process.cwd(), '.agents', 'notes'))
const { notes, errors } = walkAgentNoteTree(root)

/** `##` 前缩进 ≥4 且自成一段的行是缩进代码块；列表续行前面不是空行，不会被误判。 */
function isIndentedCodeBlock(line: string, prev: string | undefined): boolean {
  return /^ {4,}\S/.test(line) && (prev === undefined || prev.trim() === '')
}

/**
 * 提取一行的**本地**链接目标（行内链接 + 引用式定义）。
 *
 * - 行内代码 span 与 HTML 注释里的示例链接不算真链接（与代码围栏豁免同口径）
 * - 任意 scheme（`mailto:` 等）与协议相对 URL（`//host/x`）不是仓库内路径，跳过
 * - 目标先 %XX 解码、再去锚点与查询串，才能与磁盘上的真实文件名对齐
 */
function localLinkTargets(line: string): string[] {
  const out: string[] = []
  const push = (raw: string): void => {
    let target = raw.trim().replace(/^</, '').replace(/>$/, '')
    if (target === '' || target.startsWith('#')) return
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) || target.startsWith('//')) return
    try {
      target = decodeURIComponent(target)
    } catch {
      // 非法 %XX：按原样去查，让它照常报断链，而不是静默放过
    }
    target = (target.split('#')[0] ?? '').split('?')[0] ?? ''
    if (target !== '') out.push(target)
  }
  const text = line.replace(/<!--.*?-->/g, '').replace(/`+[^`]*`+/g, '')
  // 行内链接必须容忍空格与 `<...>`；引用式定义（`[ref]: path`）同样是真链接
  for (const re of [/\]\(\s*(<[^>]*>|[^)]*?)\s*\)/g, /^\s*\[[^\]]+\]:\s*(\S+)/g]) {
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) push(m[1] ?? '')
  }
  return out
}

for (const note of notes) {
  // 归档笔记已冻结（不再编辑、移动、重格式化）：与门禁 3 同口径，链接不再实时校验
  if (note.lifecycle === ARCHIVE_DIR) continue
  const abs = join(root, note.rel)
  let text: string
  try {
    text = readFileSync(abs, 'utf8')
  } catch {
    errors.push(`structure: ${note.rel} — 不可读`)
    continue
  }
  // 必须按围栏解析：记录本格式的笔记会在代码块里引示例链接，扫全文会把示例当断链误红
  const rawLines = toLines(text)
  for (const line of fenceAwareLines(text)) {
    if (isIndentedCodeBlock(line.text, rawLines[line.index - 1])) continue
    for (const target of localLinkTargets(line.text)) {
      if (target === '') continue
      const resolved = resolve(dirname(abs), target)
      if (!existsSync(resolved)) {
        errors.push(`structure: ${note.rel}:${line.index + 1} — 相对链接指向不存在的文件：${target}`)
      }
    }
  }
}

if (errors.length === 0) {
  // 0 篇不能说「全部合规」：根目录写错与 init 刚建完的空骨架会输出同一句话（两者都退 0）
  console.log(
    notes.length === 0
      ? 'verify-note-tree: 未发现任何笔记，请确认根目录正确（init 刚建完的空骨架属正常，仍退 0）。'
      : `verify-note-tree: 检查 ${notes.length} 篇笔记，结构全部合规。`,
  )
  process.exit(0)
}
console.error('verify-note-tree: 发现违规：')
for (const e of errors) console.error(`  ${e}`)
process.exit(1)
