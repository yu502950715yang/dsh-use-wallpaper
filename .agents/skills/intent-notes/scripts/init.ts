/**
 * 在目标项目建立 Agent Notes 骨架（存量项目初始化阶段 1）。
 *
 * 探测与渲染的逻辑在 init-core.ts；本文件是**纯 CLI**、不导出任何东西，
 * 因此不需要 `import.meta.url === argv[1]` 入口守卫——那个守卫在脚本路径经
 * symlink/junction 到达时会 fail-open，整段 CLI 被跳过、骨架静默不落盘。
 *
 * 用法：node scripts/init.ts <项目根> [--dry-run]
 *
 * 只做机械动作，不含任何判断：探测子仓库、根目录 git init（若尚未）、
 * 建目录、写 .gitignore 片段与 .agents/intent-notes/config.yml。
 * 不提交、不修改任何既有文件的内容（.gitignore 仅追加缺失段）。
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, appendFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { AGENT_NOTE_CLASSES, AGENT_NOTE_LIFECYCLES, ARCHIVE_DIR } from './note-tree.ts'
import { MARKER, detectNestedRepos, detectSubRepos, renderConfig, renderGitignore } from './init-core.ts'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const target = args.find(a => a !== '--dry-run')
// 少敲一个参数不能变成「对当前目录动工」
if (target === undefined) {
  console.error('用法：node scripts/init.ts <项目根> [--dry-run]')
  process.exit(1)
}
if (target.startsWith('--')) {
  // 拼错的 flag 不能被当成路径：否则报「项目根不存在」，离真正原因很远
  console.error(`init: 未知参数 ${target}；用法：node scripts/init.ts <项目根> [--dry-run]`)
  process.exit(1)
}
const projectRoot = resolve(target)

if (!existsSync(projectRoot)) {
  console.error(`init: 项目根不存在：${projectRoot}`)
  process.exit(1)
}

const subRepos = detectSubRepos(projectRoot)
// 更深层仓库只给线索、不自动纳入（理由见 init-core.ts 的 detectNestedRepos 注释）
const nestedRepos = detectNestedRepos(projectRoot, subRepos)
const project = projectRoot.split(/[\\/]/).filter(Boolean).pop() ?? 'project'

// 本 skill 基目录：只用于读自带模板，不代表它该放在哪（放哪由 harness 的扫描根决定）
const skillDir = dirname(import.meta.dirname)
// 模板缺失说明 skill 没整目录复制；静默跳过会让 notes/README.md 缺失、子仓库指针悬空
const readmeTemplate = join(skillDir, 'templates', 'notes-readme.md')
if (!existsSync(readmeTemplate)) {
  console.error(`init: 缺少模板 ${readmeTemplate}（skill 需整目录复制）`)
  process.exit(1)
}

const configPath = join(projectRoot, '.agents', 'intent-notes', 'config.yml')
const gitignorePath = join(projectRoot, '.gitignore')
// 读之前先验类型：`.gitignore` 是目录时 readFileSync 会抛 EISDIR，用户看到的是裸栈
if (existsSync(gitignorePath) && !lstatSync(gitignorePath).isFile()) {
  console.error(`init: ${gitignorePath} 已存在但不是普通文件，拒绝继续`)
  process.exit(1)
}
const existingGitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : ''
// config 已存在就跳过：bootstrap 把「更深层子仓库」解法定为人工往 repos 补条目，
// 覆盖会静默抹掉那些条目，相关笔记随即回到「未在项目声明中」
const configExists = existsSync(configPath)
const needsRootGit = !existsSync(join(projectRoot, '.git'))
// 标记必须是独立整行：includes() 会被「注释里提到它」的一行骗到，排除规则静默不写
const ignoreLines = existingGitignore.split(/\r?\n/)
const needsMarker = !ignoreLines.includes(MARKER)
// marker 在只说明「写过片段」，不代表规则齐全：bootstrap 期间会陆续 clone 进新子仓库
const missingIgnore = subRepos.filter(r => !ignoreLines.includes(`/${r}/`))

// 写盘目标不能是指向别处的链接：.agents 或 .agents/notes 做成 junction 时，
// 整份骨架会落到项目外（同步盘还会损坏 .git），而文案只说「骨架已建立」
for (const rel of ['.agents', join('.agents', 'notes'), join('.agents', 'intent-notes'), join('.agents', 'intent-notes', 'config.yml')]) {
  const abs = join(projectRoot, rel)
  if (!existsSync(abs)) continue
  if (lstatSync(abs).isSymbolicLink()) {
    console.error(`init: ${abs} 是符号链接/junction（→ ${realpathSync(abs)}），拒绝把骨架写到项目外；请改用真实目录`)
    process.exit(1)
  }
}

// 骨架要写的两处路径必须是可写目标：'.agents' 是普通文件时会在写入阶段抛 ENOTDIR，
// 那时 git init 已经执行，留下「仓库建好、目录一个没建」的半截状态
for (const rel of ['.agents', join('.agents', 'notes'), join('.agents', 'intent-notes')]) {
  const abs = join(projectRoot, rel)
  if (existsSync(abs) && !lstatSync(abs).isDirectory()) {
    console.error(`init: ${abs} 已存在但不是目录，拒绝继续（骨架会写不完整）`)
    process.exit(1)
  }
}

// git 会向上寻找仓库：目标在上层仓库里时再 init 会造出嵌套仓库，
// 上层仓库对内部改动视而不见（只看到 `?? 目录/`）
if (needsRootGit) {
  const enclosing = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: projectRoot, encoding: 'utf8' })
  if (enclosing.status === 0) {
    console.error(`init: ${projectRoot} 已在 git 仓库 ${(enclosing.stdout ?? '').trim()} 内，不能在此建立嵌套仓库；请以该仓库根作为项目根`)
    process.exit(1)
  }
} else {
  // `.git` 存在不等于「是仓库」：悬空 gitdir（子模块/worktree 残留）会让 git 全面失败，
  // 而骨架照写不误，此后门禁 3 对每篇笔记恒红
  const inside = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: projectRoot, encoding: 'utf8' })
  if (inside.status !== 0) {
    console.error(`init: ${projectRoot}/.git 存在但 git 无法识别（悬空 gitdir？），拒绝在假仓库上建骨架`)
    process.exit(1)
  }
}

const actions: string[] = []
actions.push(`项目根：${projectRoot}`)
actions.push(`探测到 ${subRepos.length} 个子仓库：${subRepos.join(', ') || '（无，可能是单仓库项目）'}`)
actions.push(needsRootGit ? '项目根将 git init' : '项目根已是 git 仓库，跳过 init')
actions.push(`将确保 ${AGENT_NOTE_LIFECYCLES.length + 1} 个生命周期 × ${AGENT_NOTE_CLASSES.length} 个分类目录存在`)
actions.push(configExists
  ? '`.agents/intent-notes/config.yml` 已存在，跳过（手工补过 repos 条目的项目尤其不要覆盖）'
  : '将写入 `.agents/intent-notes/config.yml`')
const readmeExists = existsSync(join(projectRoot, '.agents', 'notes', 'README.md'))
actions.push(readmeExists
  ? '`.agents/notes/README.md` 已存在，跳过'
  : '将写入 `.agents/notes/README.md`')
actions.push(
  needsMarker
    ? `将追加 .gitignore 片段（标记：${MARKER}）`
    : missingIgnore.length > 0
      ? `.gitignore 已含片段，将补 ${missingIgnore.length} 条子仓库排除：${missingIgnore.join(', ')}`
      : '.gitignore 已含 Intent Notes 段，跳过',
)
if (nestedRepos.length > 0) {
  // 只提示不自动写：深层目录里可能有依赖包自带的 .git，自动纳入等于替使用者猜项目结构
  actions.push(
    `注意：探测到 ${nestedRepos.length} 个更深层仓库（${nestedRepos.join(', ')}），不自动纳入——请手工往 .agents/intent-notes/config.yml 的 repos 段与 .gitignore 补条目`,
  )
}

// 写入前如实打印计划：dry-run 与真实执行走同一份清单
console.log(dryRun ? 'init --dry-run，未做任何改动：' : 'init: 将执行以下动作：')
for (const a of actions) console.log(`  ${a}`)
if (dryRun) process.exit(0)

if (needsRootGit) {
  const r = spawnSync('git', ['init', '-q'], { cwd: projectRoot, encoding: 'utf8' })
  if (r.status !== 0) {
    console.error(`init: git init 失败：${r.stderr}`)
    process.exit(1)
  }
}

for (const lifecycle of [...AGENT_NOTE_LIFECYCLES, ARCHIVE_DIR]) {
  for (const cls of AGENT_NOTE_CLASSES) {
    mkdirSync(join(projectRoot, '.agents', 'notes', lifecycle, cls), { recursive: true })
  }
}

mkdirSync(join(projectRoot, '.agents', 'intent-notes'), { recursive: true })
if (!configExists) writeFileSync(configPath, renderConfig(project, subRepos), 'utf8')

// 子仓库 AGENT.md 里的指针会引用这个文件，必须真的创建它，否则指针悬空。
// 已存在则跳过：文件头承诺「不修改任何既有文件的内容」，人工改过的说明不该被模板覆盖
if (!readmeExists) {
  writeFileSync(join(projectRoot, '.agents', 'notes', 'README.md'), readFileSync(readmeTemplate, 'utf8'), 'utf8')
}

const ignoreLead = existingGitignore === '' || existingGitignore.endsWith('\n') ? '' : '\n'
if (needsMarker) {
  appendFileSync(gitignorePath, `${ignoreLead}${renderGitignore(subRepos)}`, 'utf8')
} else if (missingIgnore.length > 0) {
  // marker 已在时只补缺失行：整段重写会把标记与既有规则再写一遍
  appendFileSync(gitignorePath, `${ignoreLead}${missingIgnore.map(r => `/${r}/`).join('\n')}\n`, 'utf8')
}

console.log('init: 骨架已建立。')
console.log('下一步：按 references/bootstrap-existing-project.md 的阶段 2 重建项目 AGENTS.md。')
