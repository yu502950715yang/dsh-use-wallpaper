/**
 * 归档封印的纯逻辑：SHA-256 manifest 的读写与只追加校验。
 *
 * 只追加是这套机制成立的前提——若允许重录既有条目，「改文件 + 重录」就成了自洽的合法
 * 操作，manifest 随即失去意义。唯一的例外通道是 reseal（改内容）与 forget（撤销误归档），
 * 两者都直接改写 artifacts，并在 history 留痕供审计；history 不参与判定。
 *
 * 只追加 manifest 的语义移植自 DeepSeek Harness 的 `verify-archived-agent-notes.ts`（MIT,
 * Copyright (c) 2026 DeepSeek）。
 *
 * 纯模块：无模块级副作用，CLI 与 spec 都可安全 import；不 spawn 子进程——「HEAD 里是否有封印」
 * 由 CLI 层用 git 算好，经 `SealOptions` 注入。
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync, existsSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { ARCHIVE_DIR } from './note-tree.ts'
import { toLines } from './note-text.ts'

/** 封印清单文件名，位于 `archived/` 根下。 */
export const SEAL_MANIFEST = 'manifest.json'

/** 清单结构版本，将来改结构时递增。 */
export const SEAL_VERSION = 1

/** 例外通道的审计记录；不参与门禁判定。 */
export interface SealHistoryEntry {
  action: 'reseal' | 'forget'
  path: string
  at: string
  reason: string
  from: string
  to?: string
}

export interface SealManifest {
  version: number
  artifacts: Record<string, string>
  history: SealHistoryEntry[]
}

/** 由调用方（CLI 层）用 git 探测后注入的事实；省略即退化为「从不曾封印」。 */
export interface SealOptions {
  /** HEAD 里已存在 `archived/manifest.json`：封印一旦进过版本控制，磁盘上没有 manifest 就是被删。 */
  headHasSeal?: boolean
  /** `--first-seal`：仅在确实要在一棵曾被封印的树上重新起封印时显式放行。 */
  firstSeal?: boolean
}

/**
 * 「manifest 被删 / 被重置」的守卫。
 *
 * 只看磁盘分不清「从来没有过归档」与「归档被删光了」，所以要靠 HEAD 里是否有过封印来判定；
 * 同理，把 manifest 改写成 `{"artifacts":{}}` 后重跑 `--write` 会按被篡改的字节重封、毫无痕迹，
 * 因此「一条磁盘产物都没记录」也算被重置。
 */
function manifestResetError(
  manifest: SealManifest | undefined,
  files: string[],
  opts: SealOptions,
): string | undefined {
  if (opts.headHasSeal !== true || opts.firstSeal === true) return undefined
  if (manifest === undefined) {
    return `seal: ${ARCHIVE_DIR} — 归档封印曾存在于版本控制中，现在磁盘上没有 ${ARCHIVE_DIR}/${SEAL_MANIFEST}；确需重新封印请显式加 --first-seal`
  }
  if (files.length > 0 && files.every(rel => manifest.artifacts[rel] === undefined)) {
    return `seal: ${ARCHIVE_DIR} — ${ARCHIVE_DIR}/${SEAL_MANIFEST} 不再记录任何磁盘上的产物（疑似被重置）；确需重新封印请显式加 --first-seal`
  }
  return undefined
}

/** archived/ 的绝对路径。 */
export function archiveRoot(notesRoot: string): string {
  return join(notesRoot, ARCHIVE_DIR)
}

/**
 * 列出 archived/ 下的全部笔记，返回相对 `archived/` 的路径（字典序）。
 *
 * 与门禁 1 同口径：只认普通目录与普通文件，链接（含指向目录的 junction/symlink）与特殊
 * 文件一律报错——跟随它们既会封印扫描根之外的目录，又可能让递归成环而无终止。
 */
export function listSealedFiles(notesRoot: string): { files: string[]; errors: string[] } {
  const root = archiveRoot(notesRoot)
  const files: string[] = []
  const errors: string[] = []
  if (!existsSync(root)) return { files, errors }
  const walk = (rel: string): void => {
    const abs = rel === '' ? root : join(root, rel)
    let entries: Dirent[]
    try {
      entries = readdirSync(abs, { withFileTypes: true })
    } catch (e) {
      errors.push(`seal: ${ARCHIVE_DIR}/${rel} — 目录不可读（${(e as NodeJS.ErrnoException).code ?? 'unknown'}）`)
      return
    }
    for (const entry of entries) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) {
        walk(childRel)
        continue
      }
      if (entry.isFile()) {
        // 清单自身不是封存产物
        if (childRel !== SEAL_MANIFEST && entry.name.toLowerCase().endsWith('.md')) files.push(childRel)
        continue
      }
      errors.push(`seal: ${ARCHIVE_DIR}/${childRel} — 无法校验（符号链接/junction/特殊文件）`)
    }
  }
  walk('')
  return { files: files.sort(), errors }
}

/**
 * 文件内容的 sha256（小写 hex），哈希对象是**归一化行尾后**的文本。
 *
 * 与门禁 2 同口径：`core.autocrlf=true` 的机器上，同一篇笔记在 checkout/clone 后会变成
 * CRLF；按原始字节哈希会把普通检出误报成「内容已改动」。
 */
export function hashFile(abs: string): string {
  return createHash('sha256').update(toLines(readFileSync(abs, 'utf8')).join('\n')).digest('hex')
}

/** 读清单。不存在时 manifest 为 undefined 且无 error；存在但不可解析时报 error。 */
export function readManifest(notesRoot: string): { manifest?: SealManifest; error?: string } {
  const abs = join(archiveRoot(notesRoot), SEAL_MANIFEST)
  if (!existsSync(abs)) return {}
  let raw: string
  try {
    raw = readFileSync(abs, 'utf8')
  } catch {
    return { error: `seal: ${ARCHIVE_DIR}/${SEAL_MANIFEST} — 不可读` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { error: `seal: ${ARCHIVE_DIR}/${SEAL_MANIFEST} — 无法解析（不是合法 JSON）` }
  }
  const m = parsed as Partial<SealManifest> | null
  if (m === null || typeof m !== 'object' || typeof m.artifacts !== 'object' || m.artifacts === null) {
    return { error: `seal: ${ARCHIVE_DIR}/${SEAL_MANIFEST} — 无法解析（缺少 artifacts 对象）` }
  }
  return {
    manifest: {
      version: typeof m.version === 'number' ? m.version : SEAL_VERSION,
      artifacts: m.artifacts as Record<string, string>,
      history: Array.isArray(m.history) ? (m.history as SealHistoryEntry[]) : [],
    },
  }
}

/** 序列化：固定 2 空格缩进与结尾换行，让 diff 稳定。 */
export function renderManifest(m: SealManifest): string {
  return `${JSON.stringify({ version: m.version, artifacts: m.artifacts, history: m.history }, null, 2)}\n`
}

function writeManifest(notesRoot: string, m: SealManifest): void {
  writeFileSync(join(archiveRoot(notesRoot), SEAL_MANIFEST), renderManifest(m), 'utf8')
}

/** 门禁 4 的核心：逐条比对磁盘与清单，返回全部违规。 */
export function checkSeal(notesRoot: string, opts: SealOptions = {}): { errors: string[]; sealed: number } {
  const { files, errors } = listSealedFiles(notesRoot)
  const { manifest, error } = readManifest(notesRoot)
  if (error !== undefined) return { errors: [...errors, error], sealed: 0 }
  if (manifest === undefined) {
    const reset = manifestResetError(manifest, files, opts)
    if (reset !== undefined) return { errors: [...errors, reset], sealed: 0 }
    // 空归档树 + 无清单是正常状态；有文件却没清单才是漏了 --write
    if (files.length === 0) return { errors, sealed: 0 }
    errors.push(
      `seal: ${ARCHIVE_DIR} — 归档树未封存（缺少 ${ARCHIVE_DIR}/${SEAL_MANIFEST}）；先跑 verify-note-seal.ts --write`,
    )
    return { errors, sealed: 0 }
  }
  const onDisk = new Set(files)
  for (const rel of files) {
    const recorded = manifest.artifacts[rel]
    if (recorded === undefined) {
      errors.push(`seal: ${ARCHIVE_DIR}/${rel} — 未封存；归档后请跑 verify-note-seal.ts --write`)
      continue
    }
    if (recorded !== hashFile(join(archiveRoot(notesRoot), rel))) {
      errors.push(`seal: ${ARCHIVE_DIR}/${rel} — 内容已改动（归档已冻结）；确需修正请跑 --reseal --reason=…`)
    }
  }
  for (const rel of Object.keys(manifest.artifacts)) {
    if (!onDisk.has(rel)) {
      errors.push(`seal: ${ARCHIVE_DIR}/${rel} — 已删除（归档不得删除）；误归档请跑 --forget --reason=…`)
    }
  }
  return { errors, sealed: files.length }
}

/**
 * `--write`：封印全部未记录产物。
 *
 * 先证明既有条目一条未变，再仅追加——任何既有条目哈希不符即整体报错且**不做任何写入**，
 * 否则「先改文件再 --write」就会静默把改动洗成合法。HEAD 里曾有封印时，manifest 被删/被重置
 * 同样报错（需 `--first-seal` 显式放行），否则「删掉整棵归档树重跑 --write」即可洗白。
 */
export function writeSeal(notesRoot: string, opts: SealOptions = {}): { errors: string[]; added: string[] } {
  const { files, errors } = listSealedFiles(notesRoot)
  const { manifest, error } = readManifest(notesRoot)
  if (error !== undefined) return { errors: [...errors, error], added: [] }
  const reset = manifestResetError(manifest, files, opts)
  if (reset !== undefined) return { errors: [...errors, reset], added: [] }
  const current: SealManifest = manifest ?? { version: SEAL_VERSION, artifacts: {}, history: [] }
  const added: string[] = []
  for (const rel of files) {
    const abs = join(archiveRoot(notesRoot), rel)
    const hash = hashFile(abs)
    const recorded = current.artifacts[rel]
    if (recorded === undefined) {
      added.push(rel)
      continue
    }
    if (recorded !== hash) {
      errors.push(
        `seal: ${ARCHIVE_DIR}/${rel} — 既有封存条目已改动，--write 只追加不重录；确需修正请跑 --reseal --reason=…`,
      )
    }
  }
  const onDisk = new Set(files)
  for (const rel of Object.keys(current.artifacts)) {
    if (!onDisk.has(rel)) {
      errors.push(`seal: ${ARCHIVE_DIR}/${rel} — 已封存产物消失；误删请跑 --forget --reason=…`)
    }
  }
  if (errors.length > 0) return { errors, added: [] }
  if (added.length === 0) return { errors: [], added: [] }
  for (const rel of added) current.artifacts[rel] = hashFile(join(archiveRoot(notesRoot), rel))
  writeManifest(notesRoot, current)
  return { errors: [], added }
}

/**
 * `--reseal`：更新单篇已封存产物的哈希，并在 history 留痕。
 *
 * 这是唯一的「改已封存内容」通道，因此要求路径已封存、内容确已变化、理由非空。
 */
export function resealOne(notesRoot: string, rel: string, reason: string, at: string): { errors: string[] } {
  if (reason.trim() === '') return { errors: [`seal: --reseal 必须带 --reason=<理由>`] }
  const { manifest, error } = readManifest(notesRoot)
  if (error !== undefined) return { errors: [error] }
  if (manifest === undefined) return { errors: [`seal: ${ARCHIVE_DIR} — 尚未封存，先跑 --write`] }
  const recorded = manifest.artifacts[rel]
  if (recorded === undefined) return { errors: [`seal: ${ARCHIVE_DIR}/${rel} — 未封存，不能 --reseal`] }
  const abs = join(archiveRoot(notesRoot), rel)
  if (!existsSync(abs)) return { errors: [`seal: ${ARCHIVE_DIR}/${rel} — 文件不存在`] }
  const hash = hashFile(abs)
  if (hash === recorded) return { errors: [`seal: ${ARCHIVE_DIR}/${rel} — 内容未变，无需 --reseal`] }
  manifest.artifacts[rel] = hash
  manifest.history.push({ action: 'reseal', path: rel, at, reason, from: recorded, to: hash })
  writeManifest(notesRoot, manifest)
  return { errors: [] }
}

/** `--forget`：撤销一次误归档。要求文件已删除——「删掉再声明」比「声明即消失」更难误用。 */
export function forgetOne(notesRoot: string, rel: string, reason: string, at: string): { errors: string[] } {
  if (reason.trim() === '') return { errors: [`seal: --forget 必须带 --reason=<理由>`] }
  const { manifest, error } = readManifest(notesRoot)
  if (error !== undefined) return { errors: [error] }
  if (manifest === undefined) return { errors: [`seal: ${ARCHIVE_DIR} — 尚未封存，先跑 --write`] }
  const recorded = manifest.artifacts[rel]
  if (recorded === undefined) return { errors: [`seal: ${ARCHIVE_DIR}/${rel} — 未封存，不能 --forget`] }
  if (existsSync(join(archiveRoot(notesRoot), rel))) {
    return { errors: [`seal: ${ARCHIVE_DIR}/${rel} — 文件仍在，请先删除该文件再跑 --forget`] }
  }
  delete manifest.artifacts[rel]
  manifest.history.push({ action: 'forget', path: rel, at, reason, from: recorded })
  writeManifest(notesRoot, manifest)
  return { errors: [] }
}
