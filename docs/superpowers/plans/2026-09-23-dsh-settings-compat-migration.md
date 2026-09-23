# DSH 设置系统兼容迁移（0.1.5-rc.3 / 0.1.6-alpha.2 ↔ 0.1.7-alpha.2 双路径）

- 日期：2026-09-23
- 状态：**已实施并验收通过**（分支 `fix/dsh-017-settings-compat`；实施记录见 §8）
- 触发：用户 DSH 升到 0.1.7-alpha.2 后设置面板全空、壁纸列表为空（当前故障）

## 1. 根因（已定位，含实测证据）

DSH 0.1.7-alpha.1 把设置子系统从「动态注册命名空间」换成「profile 条目 Config 表单」：

| | ≤ 0.1.6-alpha.2（旧） | ≥ 0.1.7-alpha.1（新） |
|---|---|---|
| dsh-settings 导出 | `SettingsProvider` + `settingsNamespace`（实为 0.1.2-rc.1 起已无此导出） | `SettingsForms` |
| 注册方式 | `ctx.settings.register(ns, schema, {base})` | 无 `register`；表单来自插件导出的 `Config` 的 `.volatile()` 字段 |
| ns 语义 | 插件短名 `wallpaper-engine` | **profile 条目 id** `dsh-wallpaper-engine` |
| 持久化 | `$DSH_HOME/settings.yaml` | 当前 profile 的 `cordis.patch.yml` |
| observe/热更新 | `scope.watch` | loader `_commitVolatile`（schemastery/loader 需 ≥3.18.4 / ≥1.0.5） |

本插件的四个断点（现状）：

1. `src/host/index.ts` 调 `settings.register(...)` → 新版服务无此方法 → `ctx.inject` 子 fiber 内 TypeError（被吞，仅服务端日志）。
2. `src/client/settings.ts` 只找 `ns === 'wallpaper-engine'` → 新版条目 id 是 `dsh-wallpaper-engine` → 永远匹配不到 → 静默回退 `DEFAULTS`（面板空、当前壁纸"无"）。
3. host 未导出 `Config` → 新版 `describe()` 因 `schema === undefined` 直接跳过该条目。
4. profile `package.json` 的 `dsh.profile.config` 两版都不读（旧 `profile-boot` 同样只认 `dsh.profile.bundles` + `cordis.patch.yml`）→ `wallpaperDir` 为空 → `/wallpapers/list` 返回 `[]`。

附带：旧 `$DSH_HOME/settings.yaml` 的 `wallpaper-engine:` 段已被 0.1.7 改名为 `settings.yaml.imported`，且因「同名条目不存在」未导入（用户原有的 `selectedWallpaperId` / 光晕参数只留在改名文件里）。

两个"真会崩"的点（迁移必须规避）：

- `import { settingsNamespace } from '@deepseek-ai/dsh-settings'`：该导出自 0.1.2-rc.1 起不存在，静态命名导入会 **SyntaxError 链接失败**（现在没炸只因解析到插件自带的 `0.1.0-rc.8` 副本）。
- `schema.volatile()`：插件本地 `schemastery@3.18.1`（lockfile 钉住）**没有**该 API（3.18.2 也没有，3.18.4 才有）。

## 2. 兼容性实测矩阵（本次实机验证）

| DSH 版本 | 实测方式 | 结果 |
|---|---|---|
| **0.1.5-rc.3** | `npm i` 到临时目录 + 独立 `DSH_HOME` + 独立 profile（junction 链本仓库）+ profile patch 配 config | `--dump-config` 条目带 config ✓；`dsh web` 无报错；`GET /wallpapers/list` → 200 / 5660B 真实列表 ✓；headless Edge 打开 GUI → `window.__wallpaperEngine` ✓、`.wp-background-layer` ✓；`select('1280029027')` → `.wp-scene-canvas` **1280×720** ✓；console `[three] scene loaded id=1280029027 background=1 particleLayers=5` ✓、粒子逐层产出 ✓ |
| **0.1.6-alpha.2** | 同上 | `--dump-config` ✓；`/wallpapers/list` → 200 / 5660B ✓（与 0.1.5-rc.3 同代码世代） |
| **0.1.7-alpha.2** | 本机在用实例（3080） | 面板全默认、list `[]`（当前故障） |

关键结论（旧版行为）：

- 旧版**渲染链路完全正常**，壁纸能生效 —— 前提是 host 拿得到目录（profile patch 的 config 即可）。
- 旧版**不会自动恢复"上次选中的壁纸"**：实测 `select()` 之前 `.wp-scene-canvas` 为 0。原因是旧路径 `register()` 未传 `base: config`，settings scope 只解析 schema 默认值 + `settings.yaml`；面板里目录框也会是空的。
- 旧版 `settings.yaml` 已空（被改名），用户设置要么写进 profile patch config，要么在面板里重设一次。

跨版本安全性（实测）：`schemastery@3.18.4` 生成的含 `"volatile":true` 的 schema JSON，被 3.18.2 `new Schema(json)` 反序列化 + 校验 **正常**；旧 loader（1.0.3）代码里完全不含 volatile 逻辑。⇒ 导出 `Config` 对旧版无害。

## 3. 目标

- 同一份产物同时支持 **0.1.5-rc.3 / 0.1.6-alpha.2（旧模型）** 与 **0.1.7-alpha.2（新模型）**；
- 两版都不崩（消除上述两个硬崩点）；
- 两版行为一致：面板读到 profile config 值、`selectedWallpaperId` 自动恢复、面板读写持久化；
- 新版恢复当前故障；旧版回归不退化。

## 4. 改动清单

### 4.1 依赖（package.json + lockfile）

- `@deepseek-ai/schemastery`：`^3.18.1` → **`^3.18.4`**（`.volatile()` 必需），更新 lockfile。
- `@deepseek-ai/dsh-settings`：降为**类型/开发依赖**或直接移除（迁移后不再静态导入任何符号）。

### 4.2 host（`src/host/settings.ts`、`src/host/index.ts`）

- `settings.ts`：导出 `Config`，全部字段标记 volatile（`z.object({...}).volatile()`，对象级一次到位；`volatileForm` 对对象级 volatile 直接整体成表单）。
- `index.ts`：
  - **删除** `settingsNamespace` 静态导入与 `settings.register(...)` 的无条件调用；
  - `ctx.inject(['settings'], …)` 内做**特性探测**：
    - `typeof settings.register === 'function'` → 旧路径：`register('wallpaper-engine', schema, { base: config })` + `scope.get()` / `scope.watch()`（`base` 让 profile config 进入解析链，旧版面板/自动恢复才正确）；
    - 否则 → 新路径：`typeof settings.configure === 'function' && settings.configure({ auto: false }, ctx.fiber)`（插件自带面板，关闭自动生成页），配置值直接读 loader 传入的 `config`。
  - **配置值不要快照**：新路径下 volatile 字段是活引用，`state` 改为惰性读取（保存 config 对象引用，路由每次读取时取值），对齐官方插件写法（构造时存 config、使用时读取）；旧路径沿用 `scope.watch` 更新 state。
- 解析优先级两版统一：**schema 默认值 → profile config（entry config）→ 用户设置**。

### 4.3 client（`src/client/settings.ts`、`src/client/settings-section.tsx`、`src/client/index.ts`）

- ns 候选 `['dsh-wallpaper-engine', 'wallpaper-engine']`：`describe()` 后取**实际存在**的那一行（并记住命中的 ns，写回时用它）；两版都没有时按 value 形状兜底（含 `selectedWallpaperId` 字段）。
- 写入失败不再静默：至少 `console.warn('[wallpaper-engine] 设置写入失败', ns, error)`，并在面板给出提示（当前 `.catch(() => {})` 会导致"提示已保存但没生效"）。
- 其余（slots 注册、渲染、路由）无需改动。

### 4.4 用户侧配置（迁移动作）

profile `cordis.patch.yml`（新旧通吃的位置）：

```yaml
- id: dsh-wallpaper-engine
  config:
    wallpaperDir: D:/Steam/steamapps/workshop/content/431960
    weAssetsDir: D:/Steam/steamapps/common/wallpaper_engine
    selectedWallpaperId: "3789244610"
```

其余字段（overlayOpacity / blur / kenBurns / glow / paused / pauseOnHidden / qualityScale）从 `$DSH_HOME/settings.yaml.imported` 的 `wallpaper-engine:` 段抄入；同时删掉 profile `package.json` 里已失效的 `dsh.profile.config`（避免误导）。

## 5. 测试与验收

### 5.1 单测（`tests/`）

- `tests/client-settings.test.ts`：改为三组用例 —— 只存在旧 ns、只存在新 ns、两个都在（取候选顺序）；写入使用命中的 ns；`describe ok:false` 仍沿用上次成功值。
- host 新增用例：`settings.register` 不存在（新形状 service）时不抛错、`configure` 被调用、config 值可从 loader config 读出；`register` 存在（旧形状）时走注册且传了 `base`。
- 断言口径统一到「真实新版/旧版 service 形状」，删除现有只打旧形状桩的写法（这正是 CI 漏掉本次故障的原因）。

### 5.2 实机验收（环境已就绪）

- 旧版 0.1.5-rc.3：`%TEMP%\dsh015-install` + `%TEMP%\dsh015-home`（profile `web`，junction 链本仓库）。验收：`/wallpapers/list` 非空；playwright 打开 GUI → `.wp-scene-canvas` 存在且 `[three] scene loaded`；**面板目录框显示 config 值、刷新后自动恢复 `3789244610`**；改一次目录保存 → 写入 `settings.yaml` 成功。
- 旧版 0.1.6-alpha.2：`%TEMP%\old-dsh-install` + `%TEMP%\old-dsh-home`（同流程，作为第二旧版样本）。
- 新版 0.1.7-alpha.2：本机 profile——面板显示 config 值；保存"壁纸目录"→ 落到 `~/.dsh/profiles/web/cordis.patch.yml` 的条目 config；点选壁纸 → 刷新后仍保留。
- 构建/回归：`npm test`、`npm run build`、`npm run build:client`；`npm run e2e:compare` 零回归（最大差 ≤1 且差≥2 像素为 0）。

## 6. 风险与回滚

- 升 schemastery 到 3.18.4：已实测旧版反序列化/校验安全；唯一代价是旧版把配置变更当普通重挂载（与现状一致）。
- 特性探测的兜底：若两版 service 形状都不匹配（未来再改），host 仍需能启动（只是设置不可用），不得让 `apply` 抛错 —— 用 `try/catch` 包住注册分支并 `logger.warn`。
- 回滚点：迁移前 commit；`lib/`、`dist/` 必须随源码重建后一起提交/发布。
- 可选简化：若决定只支持新版，则方案退化为"新路径 + README 声明最低 DSH 0.1.7-alpha.1"，旧版不崩但设置失效（不推荐，用户已在旧版上用）。

## 7. 实施顺序（建议提交切分）

1. 依赖升级 + lockfile。
2. host 双路径 + `Config`（含惰性读 config）。
3. client 双 ns + 写失败可见。
4. 单测改/补。
5. 实机验收：旧 0.1.5-rc.3 → 旧 0.1.6-alpha.2 → 新 0.1.7-alpha.2 → e2e 零回归。
6. 重建 `lib/` + `dist/`；更新 `README.md`（配置位置、最低版本）与 `AGENT.md`（本节结论 + §3.2 集成说明）。

## 8. 实施记录（2026-09-23）

**实现与方案的两处偏差**（均由真机测试逼出）：

1. **对象级 volatile**（`Config = WallpaperSettingsSchema.volatile()`）而非字段级：`volatileForm` 对对象级 volatile 直接整体成表单；旧路径继续用非 volatile 的 `WallpaperSettingsSchema`。
2. **volatile 读值必须 `.get()`**：0.1.7 loader 交给插件的 `config` 是活引用，直接 `config.wallpaperDir` 得到 `undefined`（真机表现 = `/wallpapers/list` 返回 `[]`）。新增 `configValue()` 统一解引用，`state` 用 getter 惰性读。该缺陷先写成失败的回归测试（`config` 带 `get()` 的用例），再修。
3. `Config` **挂在默认导出的 `apply` 上**：loader 的 `unwrapExports` 在存在 default 导出时丢弃命名导出（源码确认），只导出命名 `Config` 不生效。

**验收证据**：

| 项 | 结果 |
|---|---|
| `vitest run` | **945 / 945 通过**，`known-failures` 门禁「无新增失败」 |
| `npm run build` / `build:client` | 通过；`lib/`、`dist/client.js`、`dist/client.js.map` 已随源码重建 |
| `npm run e2e:colorblend` | PASS（渲染零回归） |
| 真机 0.1.7-alpha.2（`%TEMP%\dsh017-home`） | list 200/5660B；面板目录框显示 config 值；点选壁纸 → 写入 scratch profile `cordis.patch.yml` 的 `selectedWallpaperId`；刷新后**自动恢复渲染**（canvas 1280×720，截图 `output/playwright/dsh017-rc2-wallpaper-restored.png`） |
| 真机 0.1.5-rc.3（`%TEMP%\dsh015-home`） | list 200/5660B；面板目录框显示 config 值；`当前壁纸：Night City Rain (Kiroshi Boulevard)`；刷新后自动恢复；**面板保存目录 → 写入 `settings.yaml` 的 `wallpaper-engine:` 段**（旧版持久化路径正确，profile patch 未被改动） |
| 真机 0.1.6-alpha.2（`%TEMP%\old-dsh-home`） | list 200/5660B；自动恢复渲染 ✓ |

**未做**：`e2e:compare` 逐像素 A/B 未跑（改动不触碰渲染路径，已用 CI 门禁 `e2e:colorblend` 替代）；旧版 0.1.6-alpha.2 的面板读写未单独点验（与 0.1.5-rc.3 同一 `dsh-settings` 世代，代码路径相同）。

## 9. 后续清理清单（等 DSH 发布新版本后执行；用户 2026-09-23 要求记录）

**触发条件**：DSH 新版本稳定发布、且**本插件声明的最低支持版本 ≥ `0.1.7-alpha.1`**（即不再需要兼容 ≤0.1.6）。执行前先确认新版上设置与右侧栏行为无变化。

### A. 可直接删除（旧版专用代码，含配套测试）

1. `src/host/settings.ts`：`WallpaperSettingsSchema`（非 volatile）只为旧路径 `register` 而留。删掉它，`Config` 直接由 `z.object({...}).volatile()` 定义。
2. `src/host/index.ts`：删除 `typeof settings?.register === 'function'` 的旧分支（`register(WALLPAPER_NS, WallpaperSettingsSchema, { base })` + `scope.watch`）与 `userWallpaperDir / userWeAssetsDir` 两个变量；`state` 的两个 getter 直接读 `configValue(config)`。保留 `try/catch` 降级。
3. `src/client/settings.ts`：`NS_CANDIDATES` 与「逐个候选重试」收敛为单一 ns（`dsh-wallpaper-engine`，即本包 `cordis.patch.yml` 的条目 id）；删除旧短名 `wallpaper-engine` 回退。
4. 测试：`tests/host-apply.test.ts` 的 `SettingsMode = 'legacy' | 'none'` 与三个旧路径用例；`tests/client-settings.test.ts` 的旧短名用例、重试阶梯用例（**保留**「写入失败 → `console.warn` + 返回 `false`」）。
5. 文档：本文件 §1–§4 的旧版分支说明、`AGENT.md` §5.34 的旧版分支段、§5.36 里旧版对照段、`README.md` 的「同时支持 0.1.5-rc.3 / 0.1.6-alpha.2 与 0.1.7-alpha.2」表述。

### B. 可简化（仅为不破坏旧版而写的技巧，删旧版后可还原）

6. `src/client/styles.ts` 的 `body[data-we-wallpaper] :where([data-sidebar-right-panel="fullscreen"][data-sidebar-right-open]){z-index:15}`：`:where()` 只为**不覆盖旧版 DSH 自己的 `z-index:40`** 而存在。不再支持旧版后可改回普通具体度（例如并回全屏底那条规则）。**保留亦无副作用**；若简化，同步改 `tests/styles.test.ts` 中「z-index 规则具体度必须低于 `.P3OORG_panel[data-sidebar-right-panel=fullscreen]`」的断言。

### C. 必须保留（属 **0.1.7 适配**，不是旧版适配，删了会在新版回归）

7. `Config = schema.volatile()` + `(apply as any).Config = Config`（loader 的 `unwrapExports` 只认默认导出）。
8. `configValue()` 的 volatile 解引用 + `state` getter 惰性读（0.1.7 的 `config` 是活引用，快照会导致面板保存不生效）。
9. 右侧栏全部 CSS：`[data-sidebar-right-open]` 限定（收起态容器常驻）、`:not([data-sidebar-right-panel="fullscreen"])`、全屏不透明底 + z-index、以及**全屏也必须带 open 限定**（收起按钮不改 mode，「全屏+未展开」可达）。
10. 依赖 `@deepseek-ai/schemastery ^3.18.4`（`.volatile()` 必需，**不要降回** 3.18.1/3.18.2）。

### D. 执行时的验证

11. `npm test`（应为全绿；删用例后总数下降属预期）+ `npm run build` + `npm run build:client` + `npm run e2e:colorblend`；真机新版四态右栏（push 收起/展开、fullscreen 展开/收起）+ 面板读写 + 刷新自动恢复。
12. 完成后把本清单改写为「已完成（日期 / commit）」，并在 `AGENT.md` §7 第 13 条标注已办结。

