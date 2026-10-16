/**
 * 门禁 4：归档封印。校验 `archived/` 下每篇笔记与 `Archived:` 行之外的内容是否与封印一致。
 *
 * 三种写模式（都只由人显式触发）：
 *   --write                     封印全部未记录产物；既有条目一律不重录
 *   --reseal <rel> --reason <文本>   修改已封存内容（留痕）
 *   --forget <rel> --reason <文本>   撤销一次误归档（文件需先删除，留痕）
 *
 * `--first-seal` 只与 `--write` 连用：HEAD 里曾有 manifest 而磁盘上没有时，默认判红
 * （否则「删掉整棵归档树 / 删掉 manifest 再重封」即可洗白），确认要重新起封印才显式放行。
 *
 * 纯 CLI、不导出任何东西，因此不需要 `import.meta.url === argv[1]` 入口守卫——
 * 那个守卫在脚本路径经 symlink/junction 到达时会 fail-open，整段 CLI 被跳过并 exit 0。
 *
 * 用法：node scripts/verify-note-seal.ts [notes 根] [--write [--first-seal] | --reseal <rel> --reason <文本> | --forget <rel> --reason <文本>]
 * （省略 notes 根则取 <cwd>/.agents/notes；门禁 4 与门禁 1/2 同口径接 notes 根）
 */
import { readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  archiveRoot, checkSeal, forgetOne, resealOne, writeSeal, SEAL_MANIFEST,
} from './seal-core.ts'

const USAGE =
  '用法：node scripts/verify-note-seal.ts [notes 根] [--write [--first-seal] | --reseal <rel> --reason <文本> | --forget <rel> --reason <文本>]'

const args = process.argv.slice(2)
const flags = new Set(args.filter(a => a.startsWith('--')))

/** 取 `--x` 紧跟的值；也接受 `--x=值`（理由可能带空格）。 */
function valueOf(name: string): string | undefined {
  const inline = args.find(a => a.startsWith(`${name}=`))
  if (inline !== undefined) return inline.slice(name.length + 1)
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

/**
 * HEAD 里是否已有 `archived/manifest.json`。
 *
 * 读不到（不在 git 仓库内、git 不可用、notes 根在仓库外）一律当 false——退化为「从不曾封印」，
 * 不因为探测失败就拒绝真正的首次启用。git 探测必须在 CLI 层：`seal-core.ts` 保持纯模块。
 */
function headHasSeal(notesRoot: string): boolean {
  const top = spawnSync('git', ['-C', notesRoot, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' })
  const repo = top.status === 0 ? top.stdout.trim() : ''
  if (repo === '') return false
  const rel = relative(resolve(repo), join(archiveRoot(notesRoot), SEAL_MANIFEST)).replace(/\\/g, '/')
  if (rel === '' || rel.startsWith('..')) return false
  const probe = spawnSync('git', ['-C', repo, 'cat-file', '-e', `HEAD:${rel}`], { encoding: 'utf8' })
  return probe.status === 0
}

// 拼错的 flag 不能被静默当成 notes 根：那会报「根不存在」，离真正原因很远
const KNOWN_FLAGS = ['--write', '--reseal', '--forget', '--reason', '--first-seal']
// 模式旗标只认裸形式：`--write=1` 曾被白名单放行、又匹配不到 flags.has('--write')，
// 于是退 0 且打印校验文案，只看退出码的调用方会以为已经封印
const BARE_FLAGS = ['--write', '--reseal', '--forget', '--first-seal']
for (const f of flags) {
  if (!KNOWN_FLAGS.some(k => f === k || f.startsWith(`${k}=`))) {
    console.error(`verify-note-seal: 未知参数 ${f}\n${USAGE}`)
    process.exit(1)
  }
  const valued = BARE_FLAGS.find(k => f.startsWith(`${k}=`))
  if (valued !== undefined) {
    console.error(`verify-note-seal: ${valued} 不接受值；理由请写成 --reason=<文本>\n${USAGE}`)
    process.exit(1)
  }
}
if (flags.has('--first-seal') && !flags.has('--write')) {
  console.error(`verify-note-seal: --first-seal 只能与 --write 连用\n${USAGE}`)
  process.exit(1)
}

const resealPath = valueOf('--reseal')
const forgetPath = valueOf('--forget')
const reasonValue = valueOf('--reason')
// flag 的值不以 `--` 开头，会被当成位置参数；先剔除它们，剩下的第一个才是 notes 根
const consumed = new Set([resealPath, forgetPath, reasonValue].filter((v): v is string => v !== undefined))
const positional = args.filter(a => !a.startsWith('--') && !consumed.has(a))
const notesRoot = resolve(positional[0] ?? join(process.cwd(), '.agents', 'notes'))
const target = resealPath ?? forgetPath

if (flags.has('--write') && (flags.has('--reseal') || flags.has('--forget'))) {
  console.error('verify-note-seal: --write 不能与 --reseal / --forget 同时使用')
  process.exit(1)
}
if (flags.has('--reseal') && flags.has('--forget')) {
  console.error('verify-note-seal: --reseal 与 --forget 不能同时使用')
  process.exit(1)
}
// notes 根必须是可读目录：只判 existsSync 会把「给了普通文件」当成空归档树而静默退 0，readdirSync 同时兜住不存在、非目录与不可读
try {
  readdirSync(notesRoot)
} catch {
  console.error(`verify-note-seal: ${notesRoot} — 不存在、不是目录或不可读`)
  process.exit(1)
}

if (flags.has('--write')) {
  const { errors, added } = writeSeal(notesRoot, {
    headHasSeal: headHasSeal(notesRoot),
    firstSeal: flags.has('--first-seal'),
  })
  if (errors.length > 0) {
    console.error('verify-note-seal --write 拒绝执行：')
    for (const e of errors) console.error(`  ${e}`)
    process.exit(1)
  }
  console.log(
    added.length === 0
      ? 'verify-note-seal --write: 无新增产物，封印清单未改动。'
      : `verify-note-seal --write: 已封印 ${added.length} 篇新产物。`,
  )
  process.exit(0)
}

if (flags.has('--reseal') || flags.has('--forget')) {
  if (target === undefined) {
    console.error(`${USAGE}\nverify-note-seal: --reseal / --forget 需要 <class>/<file>.md 路径`)
    process.exit(1)
  }
  const at = new Date().toLocaleDateString('sv-SE') // sv-SE 即 YYYY-MM-DD 本地日期
  const { errors } = flags.has('--reseal')
    ? resealOne(notesRoot, target, reasonValue ?? '', at)
    : forgetOne(notesRoot, target, reasonValue ?? '', at)
  if (errors.length > 0) {
    for (const e of errors) console.error(e)
    process.exit(1)
  }
  console.log(`verify-note-seal: 已${flags.has('--reseal') ? '重新封印' : '撤销封存'} archived/${target}`)
  process.exit(0)
}

const { errors, sealed } = checkSeal(notesRoot, { headHasSeal: headHasSeal(notesRoot) })
if (errors.length === 0) {
  console.log(
    sealed === 0
      ? 'verify-note-seal: 未发现归档笔记，请确认根目录正确（archived/ 为空属正常，封印无需校验，仍退 0）。'
      : `verify-note-seal: 检查 ${sealed} 篇归档笔记，封印全部一致。`,
  )
  process.exit(0)
}
console.error('verify-note-seal: 发现违规：')
for (const e of errors) console.error(`  ${e}`)
process.exit(1)
