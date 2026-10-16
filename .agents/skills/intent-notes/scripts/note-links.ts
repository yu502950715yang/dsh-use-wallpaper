/**
 * 一行 Markdown 正文里的本地链接目标提取：门禁 1 的断链检查与 audit 的入链统计共用一份。
 *
 * 拆出来是为了让 audit 不必复制粘贴一套链接解析——两份实现漂移会让「断链」与「入链」
 * 对同一篇笔记给出不同答案。
 *
 * 纯模块：无模块级副作用，调用方可安全 import。
 */

/** `##` 前缩进 ≥4 且自成一段的行是缩进代码块；列表续行前面不是空行，不会被误判。 */
export function isIndentedCodeBlock(line: string, prev: string | undefined): boolean {
  return /^ {4,}\S/.test(line) && (prev === undefined || prev.trim() === '')
}

/**
 * 提取一行的**本地**链接目标（行内链接 + 引用式定义）。
 *
 * - 行内代码 span 与 HTML 注释里的示例链接不算真链接（与代码围栏豁免同口径）
 * - 任意 scheme（`mailto:` 等）与协议相对 URL（`//host/x`）不是仓库内路径，跳过
 * - 目标先 %XX 解码、再去锚点与查询串，才能与磁盘上的真实文件名对齐
 */
export function localLinkTargets(line: string): string[] {
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
