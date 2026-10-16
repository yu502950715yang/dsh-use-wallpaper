/**
 * 把笔记闸门装进目标项目的 .git/hooks/pre-commit。
 *
 * 与 init.ts 分开：init 承诺「不修改任何既有文件的内容」，而装 hook 会动 .git/。
 * 已有 pre-commit 时**拒绝**而不是合并——宁可让人显式处理，也不静默接管别人的钩子。
 *
 * 用法：node scripts/install-hook.ts <项目根> [--dry-run] [--force]
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { isAbsolute, join, relative, resolve } from 'node:path'

const USAGE = '用法：node scripts/install-hook.ts <项目根> [--dry-run] [--force]'

const args = process.argv.slice(2)
// 拼错的 flag 不能被静默忽略：`--forc` 会被当成「没给 --force」，覆盖请求变成拒绝
for (const flag of args.filter(a => a.startsWith('--'))) {
  if (flag !== '--dry-run' && flag !== '--force') {
    console.error(`install-hook: 未知参数 ${flag}\n${USAGE}`)
    process.exit(1)
  }
}
const dryRun = args.includes('--dry-run')
const force = args.includes('--force')
const target = args.find(a => !a.startsWith('--'))
// 少敲一个参数不能变成「对当前目录动工」
if (target === undefined) {
  console.error(USAGE)
  process.exit(1)
}
const projectRoot = resolve(target)

if (!existsSync(projectRoot)) {
  console.error(`install-hook: 项目根不存在：${projectRoot}`)
  process.exit(1)
}
const gitDir = join(projectRoot, '.git')
if (!existsSync(gitDir)) {
  console.error(`install-hook: ${projectRoot} 不是 git 仓库，请先跑 init.ts 建骨架`)
  process.exit(1)
}

// skill 目录：脚本在 <skill>/scripts/ 下，上一级即 skill 根
const skillDir = resolve(import.meta.dirname, '..')
const rel = relative(projectRoot, skillDir)
/** 项目内用相对路径（可随项目迁移），项目外用绝对路径。两种都转正斜杠，避免在 sh 里转义反斜杠。 */
const skillPath = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  ? rel.replace(/\\/g, '/')
  : skillDir.replace(/\\/g, '/')

const hookPath = join(projectRoot, '.git', 'hooks', 'pre-commit')

/** sh 单引号串：路径里可能有 `$` 或反引号，双引号赋值会在 shell 里被展开；内嵌单引号按 `'\''` 转义。 */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

const HOOK = `#!/bin/sh
# Intent Notes pre-commit：笔记闸门（由 install-hook.ts 生成）
# 按路径触发：未触碰 .agents/notes/ 时零开销。
set -e
SKILL=${shQuote(skillPath)}
NOTES=".agents/notes"

if ! command -v node >/dev/null 2>&1; then
  echo "intent-notes: 找不到 node，跳过笔记闸门；请安装 Node >= 22.18 后重跑 install-hook" >&2
  exit 1
fi

if ! git diff --cached --quiet -- "$NOTES/archived"; then
  node "$SKILL/scripts/verify-note-seal.ts" "$NOTES" || exit 1
  # 封印清单必须随本次提交一起进 index，否则 commit 里的 manifest 与笔记不符，新 clone 一律判红
  MANIFEST="$NOTES/archived/manifest.json"
  if ! git diff --quiet -- "$MANIFEST" || { [ -f "$MANIFEST" ] && ! git ls-files --error-unmatch -- "$MANIFEST" >/dev/null 2>&1; }; then
    echo "intent-notes: archived/manifest.json 未 git add，封印不会随本次提交生效" >&2
    exit 1
  fi
fi

if ! git diff --cached --quiet -- "$NOTES"; then
  node "$SKILL/scripts/verify-note-tree.ts" "$NOTES" || exit 1
  node "$SKILL/scripts/verify-note-format.ts" "$NOTES" || exit 1
fi
`

// worktree/子模块的 `.git` 是指针文件，钩子不在那里；照写会抛裸 ENOTDIR。
// 用 statSync（跟随链接）而非 lstatSync：指向真实目录的符号链接/junction 是合法布局，不该误判为指针文件
if (!statSync(gitDir).isDirectory()) {
  console.error(`install-hook: ${gitDir} 是 gitdir 指针文件（worktree/子模块），钩子不在那里，拒绝写入。`)
  console.error('  请改在公共 git 目录（git rev-parse --git-common-dir）的 hooks/ 下手工接入：')
  console.error('')
  console.error(HOOK)
  process.exit(1)
}

// husky / lefthook / pre-commit 框架会把 core.hooksPath 指到别处，那时 git 根本不读 .git/hooks/：
// 写进去只会静默空转，还不如在这里挡住
const hooksPathProbe = spawnSync('git', ['-C', projectRoot, 'config', '--get', 'core.hooksPath'], { encoding: 'utf8' })
const hooksPath = hooksPathProbe.stdout?.trim() ?? ''
if (hooksPath !== '') {
  console.error(`install-hook: 本项目配置了 core.hooksPath=${hooksPath}，git 不会读 .git/hooks/，装在那里等于空转。`)
  console.error('  把 hook 装到该目录（或改用它自己的机制接入），或者先取消配置：git config --unset core.hooksPath')
  process.exit(1)
}

// 读之前先验类型：pre-commit 是目录/链接时 readFileSync 会抛裸 EISDIR；悬空符号链接更危险——
// existsSync 跟随链接、对悬空链接返回 false，会一路 writeFileSync 把 hook 写到项目外
const hookStat = lstatSync(hookPath, { throwIfNoEntry: false })
if (hookStat !== undefined && !hookStat.isFile()) {
  console.error(`install-hook: ${hookPath} 已存在但不是普通文件（含符号链接/junction），拒绝写入`)
  process.exit(1)
}
const hooksDir = join(projectRoot, '.git', 'hooks')
const hooksDirStat = lstatSync(hooksDir, { throwIfNoEntry: false })
if (hooksDirStat !== undefined && !hooksDirStat.isDirectory()) {
  console.error(`install-hook: ${hooksDir} 已存在但不是普通目录（含符号链接/junction），拒绝写入`)
  process.exit(1)
}
const existing = hookStat !== undefined ? readFileSync(hookPath, 'utf8') : undefined
if (existing === HOOK) {
  console.log(`install-hook: 已安装（内容一致），跳过。${hookPath}`)
  process.exit(0)
}
if (existing !== undefined && !force) {
  console.error(`install-hook: ${hookPath} 已存在且内容不同，拒绝覆盖。`)
  console.error('  手动接入：把下面这段并入你现有的 pre-commit，或加 --force 覆盖（会丢掉原有内容）：')
  console.error('')
  console.error(HOOK)
  process.exit(1)
}

if (dryRun) {
  console.log(`install-hook --dry-run：将写入 ${hookPath}`)
  console.log(`  skill 路径：${skillPath}`)
  process.exit(0)
}

mkdirSync(hooksDir, { recursive: true })
writeFileSync(hookPath, HOOK, 'utf8')
// Windows 上 chmod 无效但不报错；Git for Windows 不看权限位
chmodSync(hookPath, 0o755)

console.log(`install-hook: 已安装 ${hookPath}`)
console.log('  改笔记时每次 commit 会跑门禁 4 / 1 / 2；只改代码的 commit 零开销。')
