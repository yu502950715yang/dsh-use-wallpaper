#!/usr/bin/env node
// 本地复刻 CI 三门禁 + 仓库卫生检查，逐条打印 PASS/FAIL 并以非零码退出（可直接当验收命令）。
// 用法：node scripts/verify-local.mjs [--with-library]；--with-library 额外复扫本机 WE 壁纸库的特性分布。
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';

const WITH_LIBRARY = process.argv.includes('--with-library');
const rows = [];

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { stdio: opts.quiet ? 'pipe' : 'inherit', shell: process.platform === 'win32', encoding: 'utf8' });
}
function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf8', shell: process.platform === 'win32' });
  return { code: r.status ?? 1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}
function gate(name, fn) {
  process.stdout.write(`\n=== ${name} ===\n`);
  const detail = fn();
  const ok = detail === true || (detail && detail.ok);
  rows.push({ name, ok, detail: typeof detail === 'object' && detail ? detail.detail : '' });
}

// ① tsc strict
gate('门禁 1a：tsc --noEmit', () => {
  const r = sh('pnpm', ['exec', 'tsc', '-p', 'tsconfig.json', '--noEmit']);
  return { ok: r.status === 0, detail: `exit ${r.status}` };
});

// ② lib/ 产物新鲜度（与 CI 同口径：重跑 tsc 后逐字节零差异）
gate('门禁 1b：lib/ 新鲜度', () => {
  sh('pnpm', ['exec', 'tsc', '-p', 'tsconfig.json'], { quiet: true });
  git(['add', '-A', '--', 'lib/']);
  const d = git(['diff', '--cached', '--exit-code', '--', 'lib/']);
  git(['reset', '-q']); // 本地还原索引；CI 不需要
  if (d.code !== 0) process.stdout.write(d.out + '\n');
  return { ok: d.code === 0, detail: d.code === 0 ? '0 diff' : '产物与 src 不同步' };
});

// ③ dist/client.js 产物新鲜度（与 CI 同口径：先删入库副本再构建，避免"构建失败⇒文件没变⇒误判同步"）
gate('门禁 1c：dist/client.js 新鲜度', () => {
  const files = ['dist/client.js', 'dist/client.js.map'];
  for (const f of files) if (existsSync(f)) rmSync(f);
  sh('node', ['scripts/build-client.mjs'], { quiet: true }); // 缺 wasm/pkg 时可能 exit 1，但 client.js 已写出
  const d = git(['diff', '--exit-code', '--', 'dist/client.js']);
  if (d.code !== 0) {
    process.stdout.write(d.out.slice(0, 2000) + '\n');
    sh('git', ['checkout', '--', ...files], { quiet: true }); // 失败时把入库副本还原，别把工作树留在缺文件状态
  }
  return { ok: d.code === 0, detail: d.code === 0 ? '0 diff' : '产物与 src 不同步（已还原入库副本）' };
});

// ④ vitest + 已知失败基线（新增失败/套件级错误才判红）
gate('门禁 2：vitest + 已知失败基线', () => {
  const r = sh('pnpm', ['exec', 'vitest', 'run', '--reporter=default', '--reporter=json', '--outputFile=.vitest-report.json']);
  const k = sh('node', ['scripts/check-known-failures.mjs', '.vitest-report.json']);
  if (existsSync('.vitest-report.json')) rmSync('.vitest-report.json');
  return { ok: k.status === 0, detail: `vitest exit ${r.status} / 基线检查 exit ${k.status}` };
});

// ⑤ e2e colorblend（真实 headless Edge 逐像素判据）
gate('门禁 3：e2e colorblend', () => {
  const r = sh('node', ['e2e/verify/verify-colorblend.mjs']);
  return { ok: r.status === 0, detail: `exit ${r.status}` };
});

// ⑥ 仓库卫生：不得有未提交的**已跟踪**改动（未跟踪文件只提示）
gate('卫生：工作树无未提交的已跟踪改动', () => {
  const s = git(['status', '--porcelain']);
  const tracked = s.out.split('\n').filter((l) => l && !l.startsWith('??'));
  if (s.out) process.stdout.write(s.out + '\n');
  return { ok: tracked.length === 0, detail: tracked.length ? `${tracked.length} 处已跟踪改动` : '干净' };
});

// ⑦ 可选项：复扫本机壁纸库（验证"本机只有 1 张开视差 / 没有骨骼动画样本"这类数据结论）
if (WITH_LIBRARY) {
  process.stdout.write('\n=== 数据复扫：本机 WE 壁纸库特性分布 ===\n');
  try {
    const [{ readdirSync, existsSync: ex, statSync }, { join }, { PkgReader }] = await Promise.all([
      import('node:fs'), import('node:path'), import('../lib/host/pkg-reader.js'),
    ]);
    const ROOT = process.env.WE_WORKSHOP_DIR || 'D:/Steam/steamapps/workshop/content/431960';
    let total = 0, camTrue = [], depth = 0, depthKind = {}, mdl = 0, mdlWithBones = 0, animLayers = 0;
    for (const id of readdirSync(ROOT)) {
      const dir = join(ROOT, id);
      try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
      let json = null;
      try {
        if (ex(join(dir, 'scene.pkg'))) {
          const b = new PkgReader(join(dir, 'scene.pkg')).readEntry('scene.json');
          if (b) json = JSON.parse(b.toString('utf8'));
        } else if (ex(join(dir, 'scene.json'))) json = JSON.parse((await import('node:fs')).readFileSync(join(dir, 'scene.json'), 'utf8'));
      } catch { continue; }
      if (!json) continue;
      total++;
      if ((json.general || {}).cameraparallax === true) camTrue.push(id);
      for (const o of (json.objects || [])) {
        if (typeof o.parallaxDepth === 'string') {
          depth++;
          const k = o.particle ? 'particle' : o.image ? 'image' : (o.text !== undefined ? 'text' : 'other');
          depthKind[k] = (depthKind[k] || 0) + 1;
        }
      }
      if (/animationlayers/.test(JSON.stringify(json))) animLayers++;
      try {
        const r = new PkgReader(join(dir, 'scene.pkg'));
        for (const e of r.listEntries()) {
          if (!/\.mdl$/.test(e.name)) continue;
          mdl++;
          const buf = r.readEntry(e.name);
          if (buf && (buf.indexOf('MDLS', 0, 'ascii') >= 0 || buf.indexOf('MDLA', 0, 'ascii') >= 0)) mdlWithBones++;
        }
      } catch { /* pkg 无骨架样本时忽略 */ }
    }
    console.log(JSON.stringify({ scene壁纸: total, cameraparallax_true: camTrue, parallaxDepth: depth, 按kind: depthKind, mdl文件: mdl, 含MDLS或MDLA: mdlWithBones, 含animationlayers: animLayers }, null, 2));
    rows.push({ name: '数据复扫', ok: true, detail: `${total} 张 / 开视差 ${camTrue.length} 张` });
  } catch (e) {
    console.log('复扫失败（需要本机 WE 壁纸库与本仓 lib/ 产物）：' + (e && e.message));
    rows.push({ name: '数据复扫', ok: true, detail: '跳过' });
  }
}

// 汇总
console.log('\n================ 验收汇总 ================');
const head = git(['log', '--oneline', '-1']).out;
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).out;
const ab = git(['rev-list', '--left-right', '--count', 'master...origin/master']).out;
console.log(`分支 ${branch} · HEAD ${head}`);
console.log(`master vs origin/master（本地独有 / 远端独有）：${ab}`);
for (const r of rows) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  —— ' + r.detail : ''}`);
const failed = rows.filter((r) => !r.ok);
console.log(failed.length === 0 ? '\n结论：全部通过 ✅' : `\n结论：${failed.length} 项未通过 ❌`);
process.exit(failed.length === 0 ? 0 : 1);
