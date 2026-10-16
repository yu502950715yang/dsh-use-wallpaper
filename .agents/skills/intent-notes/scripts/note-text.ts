/**
 * 笔记正文的围栏感知提取器：格式门禁的 `parseNote` 与锚点门禁的 `parseAnchors` 共用一份。
 *
 * 必须按 CommonMark 记围栏的**字符与长度**：` ```` ` 外套 ` ``` ` 时，内层开启行若被当成
 * 闭合行，围栏里的示例段就会被当真段解析——示例里的假锚点顶替真段，门禁随即静默放绿。
 *
 * 纯模块：无模块级副作用，`backfill` 等调用方可安全 import。
 */

/** 围栏外的正文行，带原文行号。 */
export interface ProseLine {
  /** 在原文中的 0-based 行号，用于报错定位。 */
  index: number
  /** 整行文本（行尾已归一）。 */
  text: string
}

/** 统一行尾：Windows 上 core.autocrlf=true 会把笔记检出成 CRLF，不归一会让每篇合规笔记都被误判。 */
export function toLines(text: string): string[] {
  // BOM 不是文档结构：Windows 的编辑器与重定向常写它，不剥会让第 1 行与状态行的判定恒失败
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')
}

interface Fence {
  /** 围栏字符：`` ` `` 或 `~`。 */
  char: string
  /** 围栏长度；闭合围栏必须 ≥ 它。 */
  len: number
}

/** 开启围栏：缩进 ≤3 空格、同字符连续 ≥3 个；反引号围栏的 info string 不得再含反引号。 */
function openFence(line: string): Fence | null {
  const m = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line)
  if (m === null) return null
  const run = m[2] ?? ''
  if (run.startsWith('`') && (m[3] ?? '').includes('`')) return null
  return { char: run[0] ?? '', len: run.length }
}

/** 闭合围栏：必须同字符、长度 ≥ 开启围栏，且行尾除空格/制表符外没有别的内容（info string 即非闭合）。 */
function closeFence(line: string, open: Fence): boolean {
  const m = /^( {0,3})(`{3,}|~{3,})[ \t]*$/.exec(line)
  if (m === null) return false
  const run = m[2] ?? ''
  return run[0] === open.char && run.length >= open.len
}

/** 剔除围栏行及其内容，返回围栏外的行（带原行号）。未闭合的围栏一直吃到文末。 */
export function fenceAwareLines(text: string): ProseLine[] {
  const out: ProseLine[] = []
  const lines = toLines(text)
  let open: Fence | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (open === null) {
      const fence = openFence(line)
      if (fence === null) out.push({ index: i, text: line })
      else open = fence
      continue
    }
    // 围栏内的一切（含看起来像 `## 段头` 或更短围栏的行）都不算文档结构
    if (closeFence(line, open)) open = null
  }
  return out
}

/** 只要围栏外的行文本。 */
export function proseLines(text: string): string[] {
  return fenceAwareLines(text).map(l => l.text)
}

export interface ParsedNote {
  /** 首个二级标题。 */
  firstH2: string | undefined
  /** 全部二级标题（按出现顺序，已去尾空白）。 */
  h2s: string[]
  /** 第 3 行状态行。 */
  statusLine: string | undefined
  /** 剔除代码围栏后的正文行。 */
  prose: string[]
}

/** 二级标题：CommonMark 允许 ≤3 空格缩进，`##` 后至少一个空白（空格或制表符）。 */
const H2 = /^ {0,3}##\s+/

/** 解析笔记文本。代码围栏内的 `##` 与 `Status:` 不算文档结构。 */
export function parseNote(text: string): ParsedNote {
  const prose = proseLines(text)
  // 归一掉缩进与 `##` 后的空白：`##  X` 与 `## X` 在 CommonMark 里是同一个标题，
  // 只 trim 首尾会漏掉内部多余空白，既漏判禁用段头、又误判必备节缺失
  const h2s = prose.filter(l => H2.test(l)).map(l => l.replace(/^ {0,3}##\s+/, '## ').trimEnd())
  return { firstH2: h2s[0], h2s, statusLine: toLines(text)[2], prose }
}
