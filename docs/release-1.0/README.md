# 1.0.0 发布差距分析（2026-11-10 重新分析，基准 v0.13.1）

> **本文档已于 2026-11-10 重新分析**，基准从 v0.13.0（HEAD `0056109`）更新为 **v0.13.1（HEAD `6069b26`）**。
> 支撑材料：三份 v0.13.0 基线审计（[rendering-gaps.md](./rendering-gaps.md) / [release-engineering.md](./release-engineering.md) / [product-platform-gaps.md](./product-platform-gaps.md)）+ 两份 v0.13.1 增量复测（[rendering-gaps-delta.md](./rendering-gaps-delta.md) / [release-engineering-delta.md](./release-engineering-delta.md)）。
>
> **进展更新（2026-11-10 晚）**：本文档列出的 P0 已**全部落地**（执行记录见 [p0-summary.md](./p0-summary.md)，5 个 commit、`verify:local` 9/9 PASS）；**29 项真机验收经作者确认通过**。1.0.0 现在只差「发布动作」（bump / tag / CI / Release / npm publish / 补索引 / 安装冒烟）。

---

## 0. 一句话结论

**3 天前指出的「1.0 短板是对外承诺」依然成立，而且这 3 天的开发活动恰好印证了它：** 作者做了 18 个提交、+2556 行，**全部是渲染正确性修复**（puppet 全链路、shimmer、云/雾 tint），把上一轮仅有的两个「用户可感知整层缺失」补掉了；但 **1.0 的阻塞项——契约声明、质量验证、发布工程——零进展**。

**1.0 需要的不是再修几个渲染 bug，而是画一条线并执行发布收口。** 当前还差：**4 项渲染小活（S+S+S+S）+ 29 项真机验收 + 6 类契约/发布工程配置**，约 **12–15 人日**。若继续按「修一批功能 → 发 patch」的节奏，项目会一直在 0.x 循环。

---

## 1. 相比 3 天前（v0.13.0 → v0.13.1）的变化

### 1.1 已解决（渲染侧，均为真实素材驱动的真修）

| 项 | 上一轮 | 现在 |
|---|---|---|
| **A10 puppet 对象级效果链** | 不挂链，2 张壁纸效果整层缺失 | **已修**：贴图空间合成 + v 约定；覆盖 **3 张 / 4 对象 / 12 条链** |
| **A11 `.mdl` MDLA 动画** | 解析 failed，角色动画静止 | **已修**：按真实 MDLS0004/MDLA0006 布局重写，**3 张真实样本可播**（含新样本 3828798871 两人物 5 骨 / 动画 80·104 / 60fps·360 帧） |
| shimmer 效果 | 编译失败整 pass 跳过 | 已修（HLSL 隐式向量截断 + sampler `default` 默认资产），命中 294 个 shader 中 1 个 |
| 云/雾 colorBlendMode tint | cb≠0 的静态作者色被跳过 ⇒ 比桌面亮白 | 已修（雾带亮度 55.3→45.4，WE 真机 48.8） |
| puppet 链清晰度 | 被隔离预算压到 2704×1521 ⇒ 比桌面糊 | 已修（按源分辨率；Laplacian 5.60→7.32，WE 7.16） |
| `index.json` 0.13.1 时间戳 | 0.12/0.13.0 曾错 16h/8h | 本条**录对了**（0 偏差），但历史错误未修、仍无自动校验 |

> 结果：上一轮「3 类整层缺失」收窄到 **1 类**（A16 util 无 effects，3 对象/3 张，上一轮即判「预计无可见差、待定性」）。

### 1.2 新增风险 / 边界（v0.13.1 引入或首次出现）

| # | 项 | 影响 |
|---|---|---|
| R1 | **puppet 链 RT 不参与隔离预算** | 2 个 4K puppet ≈ **200MB** 显存（`3828798871`），`ISOLATED_RT_BUDGET_BYTES=384MB` 不含它；性能门槛若只测旧素材会漏掉最重样本 |
| R2 | 多可见动画层只应用第一条 | `blend`/`additive` 不混合（leon 4 层命中） |
| R3 | MDLE 不消费 / MDLS>1 扩展块不解析 | 动画/绑定姿势的进一步对齐边界 |
| R7 | **首个 `hdr:true` 真实样本出现**（`3830466015`） | 上一轮「hdr 全 false ⇒ 0 影响」**失效**；HDR/bloomhdr 未实现，该张 bloom 按 LDR 语义执行 |
| R8 | 两张新素材带**有效视差**（0.34/0.40） | 上一轮「唯一有效 0.08」过时；新参数未验收（传播组仍缺，但新素材无父容器命中，当前风险低） |
| R11 | README 举例的 preset `3163840671` 本机已不存在 | 文档滞后（功能仍支持） |

### 1.3 没变的（上一次报告的核心判断全部成立）

- **发布工程 0 项解决**：`engines.dsh` / `engines.node` / `packageManager` / `dsh.bundle.platforms` / `types` 仍全缺；双 lockfile 仍并存；`tag` 仍不触发 CI；无 release workflow；`master` 保护仍 404；cargo 仍 exit 101（同一根因）；`npm ci` 仍 exit 1。
- **契约 0 项解决**：README 兼容矩阵仍停在 0.1.7-alpha.2（2026-09-23），无升级章节、无支持矩阵、无数据契约；旧 DSH 适配层原样；无 CHANGELOG/CONTRIBUTING/SECURITY/THIRD-PARTY/ISSUE_TEMPLATE/icon；面板仍无版本展示与诊断复制。
- **渲染 P0 4 项一项没动**：A9 自旋轴序（9 张）、A18 copybackground 定性（22 张）、文档口径同步（过时点从 3 处增到 7 处）、A21 性能量化。
- **真机验收**：26 项仍未做，且 TESTING §2.11 因 puppet 增强**新增 3 项待补**（P4/P5/P7）⇒ 现在共 **29 项**。→ **2026-11-10 作者已全部验收通过**（TESTING.md 勾选记录已回填）。

---

## 2. 现状基线（本次实测，v0.13.1 / HEAD `6069b26`）

| 维度 | 事实 |
|---|---|
| 版本节奏 | **26** 个 npm 版本 / 26 tag，v0.1.0（2026-08-24）→ v0.13.1（2026-11-09），≈3 天/版，**0 个预发布**；22 个 Release（4 个历史 tag 无 Release） |
| 门禁（本地复现） | `verify:arch` 🟢 · `tsc`+`lib/` 新鲜度 🟢 · `dist/client.js` 新鲜度 🟢 · `typecheck:tests` 🟢 · **vitest 106 文件 / 2181 项全过**（+20）🟢 · `e2e:colorblend` 5/5 🟢 · `verify:local` 8/8 🟢 |
| 门禁（红项，均与上轮同根因） | `cargo test` **exit 101**（`particle_stagger_test.rs` 引用 gitignore 的 `research/` 夹具 ⇒ 干净克隆编不过；`cargo test --lib` 43 passed；`override_rate_keeps_duty_cycle` 仍 7P/1F）；`npm ci` **exit 1**（lock 陈旧 cosmokit 1.8.2）；`master` 保护 **404** |
| CI | 全量 56 run = 48 绿 / 8 红（红全在 2026-10-10）；v0.13.1 后 run 全绿；**tag ref 无任何 CI run** |
| 测试债 | known-type-errors **495 条 / 33 键**（与上轮完全相同，未恶化）；**84.6% 在 `tests/three-renderer.test.ts`（419 条）** |
| npm 包 | 191 entries，tarball **2,069,439 B**（+0.74%），unpacked **7,980,212 B**；sourcemap 占 **51.4%**；`lib/client` 1.45 MB 疑似运行时不读；wasm 3 件齐 |
| 宿主 | 本机 DSH **0.2.0-rc.1**；DSH latest **0.2.2-rc.1**（3 天无新版本）；插件包**仍无任何 DSH 版本约束** |
| 生态 | GitHub **11★**（+2）/ **0 open issue**；已上 awesome-dsh-plugin 市场（homepage 已指向） |
| 壁纸库 | 50 → **51 条目**（44 scene + 4 web + 3 video）；preset `3163840671` 消失，新增 `3828798871`、`3830466015` |

---

## 3. 1.0.0 还差什么（P0）

### A. 契约与元数据（~3 人日，0 进展）

`engines.dsh` + `dsh.bundle.platforms`（或显式「仅 win32」）；DSH 0.2.x 真机矩阵（0.2.0-rc.1 / 0.2.2-rc.1）写入 README；README 升级章节 + 支持矩阵 + 数据/设置兼容承诺 + 卸载清理；三处兼容声明统一；index.json 历史时间戳修正 + 校验进 CI。

### B. 质量验证（~4 人日，0 进展）

修 cargo 编译失败（`include_str!` 改入库夹具）+ 处置 `override_rate_keeps_duty_cycle`；**29 项真机验收**（P4/P5/P7 + P8–P10 + M1–M8 + B1–B9 + C1–C6）；性能/显存量化（**必测 `3828798871`**，puppet 链 ≈200MB）；类型债收紧（至少 `--update` 2 键 + release notes 披露）。

### C. 渲染收口（~2 人日，全是 S 级小活，0 进展）

1. **A9 粒子自旋轴序**（WE `common_particles.h` 为 `mul(mul(Rz,Rx),Ry)`，本项目 `Rz·Ry·Rx`；9 张多轴自旋）——同时修正 2 处代码注释与 AGENT §7.3 的「官方 order」文字
2. **A18 copybackground 定性 A/B**（22 张 / 94 对象；唯一真实消费点已生效）
3. **文档口径同步**（范围比上轮扩大）：`technical-notes.md:78`、**4 处**称快照门控关闭的过时注释（`three-renderer.ts:1395-1396`、`object-effects.ts:68`、`:244-245`、`effect-runner.ts:55-57`）、README 补披露 4 项（puppet effects 已支持及边界 / puppet 动画解析边界 / vortex·link_mouse·mapsequence / `getLayer(name)`·hover 不可用）、preset 举例更新
4. **A21 性能/显存量化**（只测量，不改代码）

> 另：A16 util 无 effects（3 对象/3 张）需一次定性，可并入 C-2 的 A/B 一起做。

### D. 发布工程（~3 人日，0 进展）

1.0 版本语义（模板仍写「0.x 阶段」「不引入 major」）+ 破坏性变更节 + RC 通道；`tag` 触发 release workflow + `master` 分支保护 + publish 前门禁 + 安装冒烟；删 ≤0.1.6 旧适配层（1.0 唯一 breaking 点，**若删则下界建议 `>=0.2.0-rc.1 <0.3.0`**）；wasm 产物溯源/新鲜度守卫；CHANGELOG。

### E. 文档与合规（~2 人日，0 进展）

CHANGELOG/CONTRIBUTING/SECURITY/THIRD-PARTY/ISSUE_TEMPLATE/icon；面板版本展示 + 「复制诊断信息」；环境失败提示（WebGL2 / WE 缺失 / web 跨源）；13 处文档漂移。

---

## 4. 明确**不**阻塞 1.0（留 1.x）

子粒子 `children`（14 张，L）、`link_mouse`（**7 张**，1.x 第一优先）、ropetrail（5 张）、vortex/worldspace/mapsequence、boids/remapvalue、web 壁纸失败回退、i18n、HDR（1 张，新样本，写进 release notes 即可）、MSAA、Glow 覆盖 video、多动画层 blend、MDLE 等。

---

## 5. 路线（与上轮一致）

**`1.0.0` 直接发布**（P0 已全部落地、真机验收已通过）。发布动作按 `.github/RELEASE_NOTES_TEMPLATE.md` 的 11 步 checklist：bump → 更新 CHANGELOG → tag → 等 release workflow 绿 → GitHub Release → npm publish → 补 index 条目 → 安装冒烟。可选：补性能/显存量化数字（不影响发布）。

**2026-11-10 发布前准备已就位**（本次已完成）：

- [x] `package.json` bump 到 `1.0.0`；CHANGELOG 定稿为 `[1.0.0] - 2026-11-10`（含本轮安全/稳定性/门禁全部条目）
- [x] 发布说明定稿：`release-notes-1.0.0-draft.md`（含「安全审查修复」章节）
- [x] `index.json` 已预置 1.0.0 条目（`publishTimestamp: 0` **待 npm 发布后回填**）
- [x] `release.yml` 的 publish job 已加 `npm install -g npm@11`（Trusted Publisher 要求 ≥ 11.5.1，否则首次 publish 401）
- [x] `ci.yml` 已加 `rust` job（`cargo test`；Rust 回归此前只在本地跑）
- [ ] **仓库设置（需人工在 GitHub 操作）**：① `master` required checks 勾选 `gate-baseline` / `test` / `e2e` / `rust`；② `v*` tag 保护（仅维护者）；③ npm Trusted Publisher 绑定仓库 + workflow 文件名（`release.yml`）；④ 仓库 Settings → Environments 建 `npm`（需要审批时配置 reviewer）
- [ ] 发布后：回填 `index.json` 的 `publishTimestamp`（npm 的 `time["1.0.0"]` 转 unix 秒）；安装冒烟（全新 profile `dsh plugin add @dsh-use/wallpaper-engine@1.0.0`）

可选：补性能/显存量化数字（不影响发布）。

- 第 1 周：A–E 的代码与工程项（约 8 人日）→ 发 rc.1
- 第 2 周：rc 验证（DSH 0.2.0-rc.1 + 0.2.2-rc.1、29 项验收清单、`3828798871` 人眼验收）→ 修问题 → 发 `1.0.0` + Release + 索引 + 安装冒烟

**若真机验收排不进本期 → 本次发 `0.14.0`**，把 major 留给验证完成后。这不是失败，而是把 1.0 的承诺做实。

---

## 6. 需要拍板的 3 个决策（与上轮相同）

1. `engines.dsh` 下界定在哪（删旧适配后建议 `>=0.2.0-rc.1 <0.3.0`）
2. 1.0 是否删 ≤0.1.6 旧适配层（推荐删——唯一自然 breaking 窗口）
3. 真机验收能否排进本周（排不进 → 0.14.0）

---

## 7. 报告索引

| 报告 | 基准 | 内容 |
|---|---|---|
| [rendering-gaps.md](./rendering-gaps.md) | v0.13.0 | 渲染缺口 A1–A25 全表、F1–F21 对照、P0/P1 分档 |
| [release-engineering.md](./release-engineering.md) | v0.13.0 | 门禁实测、发布流程 17 步、包内容、风险与回滚 |
| [product-platform-gaps.md](./product-platform-gaps.md) | v0.13.0 | 1.0 三方案定义、G1–G12 DoD、26 项未验收、13 处漂移 |
| [rendering-gaps-delta.md](./rendering-gaps-delta.md) | **v0.13.1** | A10/A11 已修核实、新边界 R1–R11、P0 仍 4 项、门槛清单修正 |
| [release-engineering-delta.md](./release-engineering-delta.md) | **v0.13.1** | 门禁前后对比（2181 项全绿）、红项同根因、P0 6/6 未动、上轮数字更正 |

**交叉核对结论**：两份 delta 报告的更正与 Lead 实测一致——`index.json` 0.13.0 为 **−8h**、0.12.0 为 **−16h**（上轮 release-engineering 记为「一致」有误）；0.13.1 条目 0 偏差（个案正确，机制未解决）。

---

## 8. 未覆盖（如实）

DSH 0.1.x 未复验；DSH 0.2.x GUI 逐项冒烟未做；`build:wasm` 未重跑（wasm 与源码同 commit 是事实，但仍无门禁）；未做真实 FPS 基准（软件光栅化除外）；未做视觉验收；未执行任何发布动作。
