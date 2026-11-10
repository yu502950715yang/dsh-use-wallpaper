# 项目全面审查：高层概览与 Lead 自审（2026-11-10）

> 审查方法：`code-review-skill`（Phase 1 上下文 → Phase 2 高层 → Phase 3 逐行由 6 个并行 subagent 分担 → Phase 4 汇总）。
> 本文只记 **Lead 自己做的 Phase 1/2 与自审**；各领域逐行结论见同目录的 `host.md` / `client-runtime.md` / `rendering-correctness.md` / `rust-wasm.md` / `testing-gates.md` / `architecture.md`，汇总见 `summary.md`。
> 基准：HEAD `d5ff886`（1.0 P0 收口后，v0.13.1 + 8 个提交）。

## 1. 规模与复杂度

| 维度 | 数值 |
|---|---|
| TypeScript 源码 | 25,902 行（`src/**/*.ts(x)`，92 → 95 文件） |
| Rust 源码 | 3,334 行（`wasm/src`，sim.rs 单文件 1,905 行） |
| 测试 | 107 文件 / 2,196 项（vitest node + jsdom），e2e 21 文件入库 |
| 最大文件 | `threejs-player.ts` 3,414 · `three-renderer.ts` 1,598 · `settings-section.tsx` 1,499 · `scene-script-vm.ts` 1,098 · `effect-runner.ts` 979 · `routes.ts` 797 |
| `any` 使用 | 52 处（`routes.ts` 22、`client/index.ts` 9、`scene-assets.ts` 6） |
| TODO/FIXME/HACK | 4 处 |
| 最近 7 个 commit | 83 文件 / +4,649 −433（1.0 P0 收口） |

## 2. 依赖与供应链（✅ 基本健康）

- `npm audit`：**0 个已知漏洞**。
- 生产依赖仅 4 个（three / lz4js / quickjs-emscripten / @deepseek-ai/schemastery），peer 1 个（cordis）。
- **P2 依赖范围不一致**：`@deepseek-ai/schemastery` 插件声明 `^3.18.4`，而 DSH 宿主用 `~3.18.4`。若 3.19 发布，插件会装 3.19、宿主用 3.18.x ⇒ 双实例风险（`Config` schema 跨实例判断可能失效）。建议对齐到 `~3.18.4` 或改为 peer。
- **P2 无 `packageManager`**：CI（pnpm 9）与本机（pnpm 12.16）大版本不一致，lockfile 行为有差异（本机 `pnpm-workspace.yaml` 的 `allowBuilds` 在 pnpm 9 被忽略）。

## 3. Lead 自审：本轮 1.0 P0 改动（8 个 commit）

### ✅ 已核对无问题的项

- **旧适配层删除彻底**：`src/**` 中 `WALLPAPER_NS` / `NS_CANDIDATES` / `settings.register` 只剩注释说明；`lib/host/settings.d.ts` 无残留导出；测试全绿。
- **设置字段一致性**：client `DEFAULTS` 33 键 == host `WallpaperSettingsSchema` 33 键（无漂移）。
- **诊断信息隐私**：`diagnostics.ts` 只输出 `wallpaperDirConfigured`/`weAssetsDirConfigured` 布尔，不输出真实路径、曲目、封面；壁纸 title 属非敏感元数据。
- **产物同步**：`verify:local` 的 lib/dist 新鲜度 0 diff；`check-release` ① PASS。
- **wasm 溯源**：`WASM_BUILD.json` 与三件产物 sha256 一致，wasm 源码基线未漂移。

### 🔴 P1：`release.yml` 的 publish job 会在首次发布时 401（npm CLI 版本不足）

- **证据**：`.github/workflows/release.yml:99-130` 的 publish job 只做 `setup-node@v5`（Node 22 自带 **npm 10.9.4**）→ 直接 `npm publish --provenance`。
- **问题**：npm 的 **Trusted Publisher（OIDC 无 token 发布）要求 npm CLI ≥ 11.5.1**；npm 10.x 的 `--provenance` 仍需要 `NODE_AUTH_TOKEN`。workflow 里既没有升级 npm，也没有 `NODE_AUTH_TOKEN` ⇒ 首次 tag 发布大概率 `401 Unauthorized`（gate 会跑完，卡在 publish）。
- **修复**：publish job 增加 `- run: npm install -g npm@^11.5.1`（或 pin 具体版本），并在 README/发布 checklist 标注。
- **影响**：不阻塞 1.0 代码质量，但**阻塞首次自动发布**；手工 `npm publish` 不受影响。

### 🟡 P2：包内 sourcemap 携带全部依赖源码（包体 52%）

- **证据**：`dist/client.js.map` = 4,105,523 B（unpacked 7,980,212 B 的 **51.4%**）；解析后 `sources` 103 个、**`sourcesContent: true`**（含 lz4js / quickjs-emscripten / three 等第三方源码全文）。
- **问题**：① 包含第三方库源码再分发（MIT/ISC 允许，但无必要）；② 包体积一半是 map；③ `sources` 路径暴露 `../node_modules/.pnpm/...` 构建布局（无敏感信息）。
- **建议**：esbuild `sourcemap: 'linked'` 或 `sourcemap: true` + 后处理删 `sourcesContent`；或 `files` 排除 `.map`（调试体验下降，二选一）。属 1.0.x 优化。

### 🟡 P2：README 配置项表漏列 4 个字段

- **证据**：`src/client/settings.ts` 的 `DEFAULTS` 33 字段 vs `README.md` 配置表 28 行：`mediaIntegrationEnabled`、`textColorMode`、`textColor`、`textOutline` 未进表（`blurRadius` 与 `blurEnabled` 合并在一行，不算漏）。
- **影响**：用户想手写 profile `config` 时不知道这 4 个字段可配；「文字可读性」段落虽提到字段名，但不在「可写进 config」的表格里。
- **建议**：补 4 行（1.0 发布前顺手修）。

### 🟡 P2：发布前必须更新的 3 处（发布时才生效，非缺陷）

1. `README.md:132` 的「npm registry 当前最新为 0.13.1」→ 1.0.0。
2. `CHANGELOG.md:9` `[Unreleased] — 目标版本 1.0.0` → `[1.0.0] - <日期>` + 文末 compare 链接。
3. `index.json` 补 1.0.0 条目（`engines.dsh` 与 `package.json` 逐字一致）后复跑 `check:release`。

### 🟢 P2：cargo 未进 CI

- `cargo test` 已从 exit 101 修到 **exit 0**，但 `.github/workflows/ci.yml` / `release.yml` 都不跑 Rust 测试；`wasm/src` 改动只靠「产物溯源 + 人纪律」保证。建议加 job（P1 级工程债，不阻塞 1.0）。

## 4. 待汇总

各领域逐行结论回来后在 `summary.md` 按 🔴/🟡/🟢 分级合并，并标注「是否影响 1.0 发布」。
