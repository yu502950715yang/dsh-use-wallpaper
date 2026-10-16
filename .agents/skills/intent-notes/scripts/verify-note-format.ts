/**
 * 门禁 2：格式。校验头块、状态语法、必备节、implemented 禁提案用语、Alternatives 必写。
 * 结构与文件名属于 verify-note-tree，本脚本不重复。
 *
 * 移植自 DeepSeek Harness 的 scripts/verify-agent-note-format.ts（MIT, Copyright (c) 2026 DeepSeek），
 * 去掉其针对旧格式的 grandfather 注释分支与中英双语配对检查。
 *
 * 解析逻辑（含围栏感知）在 note-text.ts；本文件是**纯 CLI**、不导出任何东西，
 * 因此不需要 `import.meta.url === argv[1]` 入口守卫——那个守卫在脚本路径经
 * symlink/junction 到达时会 fail-open，整段 CLI 被跳过并 exit 0。
 *
 * 用法：node scripts/verify-note-format.ts [notes 根]（省略则取 <cwd>/.agents/notes；门禁 3 接的是项目根）
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { walkAgentNoteTree } from './note-tree.ts'
import { parseNote, toLines } from './note-text.ts'

/** 状态行语法，按生命周期区分。注意 rejected 用 em dash。 */
const STATUS: Record<string, RegExp> = {
  proposed: /^Status: proposed$/,
  implemented: /^Status: implemented$/,
  rejected: /^Status: rejected — .+$/,
  // 归档笔记由 implemented 冻结而来，状态必须保持 implemented，并另起一行 Archived: YYYY-MM-DD
  archived: /^Status: implemented$/,
}

/** 各生命周期在 ## Problem 之外必须具备的二级标题。 */
const REQUIRED: Record<string, string[]> = {
  proposed: ['## Proposal', '## Acceptance criteria', '## Risks'],
  implemented: ['## Decision', '## Consequences'],
  // rejected 是冻结的提案形态：验收标准与风险正是「为什么否决」的依据，与 proposed 同骨架
  rejected: ['## Proposal', '## Acceptance criteria', '## Risks'],
  archived: ['## Decision', '## Consequences'],
}

/** implemented 中禁止出现的提案用语（规格用语混进已交付记录）。 */
const BANNED_IMPLEMENTED = /^## (?:Proposal\b|Plan\b|Migration plan\b|Acceptance criteria\b)/i

/** 归档笔记第 4 行的归档日期标记；其余生命周期的第 4 行必须为空。 */
const ARCHIVED_LINE = /^Archived: \d{4}-\d{2}-\d{2}$/

/** 备选方案未记录的显式标记：仅用于从存量文档收割、原始材料确实没写备选的笔记。 */
const ALTERNATIVES_NOT_RECORDED = '<!-- alternatives: not-recorded -->'

/** 未替换的模板占位。`prose` 已剔代码围栏，引用模板语法的笔记不会被误伤。 */
const PLACEHOLDER = /\{\{[^}]*\}\}/

const root = resolve(process.argv[2] ?? join(process.cwd(), '.agents', 'notes'))
const { notes, errors } = walkAgentNoteTree(root)

for (const note of notes) {
  const fail = (msg: string): void => {
    errors.push(`format: ${note.rel} — ${msg}`)
  }
  let raw: string
  try {
    raw = readFileSync(join(root, note.rel), 'utf8')
  } catch {
    fail('不可读')
    continue
  }
  const lines = toLines(raw)
  const { firstH2, h2s, statusLine, prose } = parseNote(raw)

  if (!/^# Agent Note: \S/.test(lines[0] ?? '')) fail('line 1 must be `# Agent Note: <title>`')
  if (lines[1] !== '') fail('line 2 must be blank')
  const statusRe = STATUS[note.lifecycle]
  if (statusRe !== undefined && !statusRe.test(statusLine ?? '')) {
    fail(`line 3 must match the ${note.lifecycle} status grammar (${String(statusRe)})`)
  }
  // 第 4 行：归档笔记必须是 `Archived: YYYY-MM-DD`，其余生命周期必须为空
  if (note.lifecycle === 'archived') {
    if (!ARCHIVED_LINE.test(lines[3] ?? '')) fail('line 4 must be `Archived: YYYY-MM-DD` for an archived note')
  } else if (lines[3] !== '') {
    fail('line 4 must be blank')
  }

  const otherStatus = prose.filter(l => l.startsWith('Status:') && l !== statusLine)
  // statusLine 为空时不能拿它去统计空行，否则会叠一条与真实原因无关的误报
  if (otherStatus.length > 0 || (statusLine !== '' && prose.filter(l => l === statusLine).length > 1)) {
    fail('the line-3 `Status:` line must be the only one in the file')
  }

  if (firstH2 !== '## Problem') {
    fail(`first section must be \`## Problem\` (got ${JSON.stringify(firstH2 ?? '<none>')})`)
  }
  for (const required of REQUIRED[note.lifecycle] ?? []) {
    if (!h2s.includes(required)) fail(`missing the required \`${required}\` section`)
  }
  if (note.lifecycle === 'implemented' || note.lifecycle === 'archived') {
    for (const h2 of h2s.filter(h => BANNED_IMPLEMENTED.test(h))) {
      fail(`\`${h2}\` is a proposal-era heading; a delivered note states what is (fold it into Decision/Consequences)`)
    }
  }

  const hasAlternatives = h2s.includes('## Alternatives considered')
  // 行尾空白是编辑器留下的，不该让标记失效：整行 trim 后相等即认
  const marked = prose.some(l => l.trim() === ALTERNATIVES_NOT_RECORDED)
  if (hasAlternatives && marked) fail('同时带有 `## Alternatives considered` 与 not-recorded 标记，请删掉标记')
  if (!hasAlternatives && !marked) {
    fail('missing `## Alternatives considered`（存量收割的笔记若原始材料确实未记录备选，写 `<!-- alternatives: not-recorded -->`）')
  }
  // 模板占位没填完等于没写：门禁 3 能抓到锚点段里的占位，正文里的必须在这里抓
  if (prose.some(l => PLACEHOLDER.test(l))) {
    fail('正文仍有未替换的模板占位 `{{...}}`；占位要么填成真实内容，要么整行删掉')
  }
}

if (errors.length === 0) {
  // 0 篇不能说「全部合规」：根目录写错与 init 刚建完的空骨架会输出同一句话（与门禁 1 同口径）
  console.log(
    notes.length === 0
      ? 'verify-note-format: 未发现任何笔记，请确认根目录正确（init 刚建完的空骨架属正常，仍退 0）。'
      : `verify-note-format: 检查 ${notes.length} 篇笔记，格式全部合规。`,
  )
  process.exit(0)
}
console.error('verify-note-format: 发现违规：')
for (const e of errors) console.error(`  ${e}`)
process.exit(1)
