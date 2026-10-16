# Agent Note: 设置系统并存新旧两条路径（DSH 0.1.6 ↔ 0.1.7）

Status: implemented

## Problem

DSH `0.1.7-alpha.1` 把设置子系统从「插件动态注册命名空间」换成「profile 条目 Config 表单」，同一个插件的接法整体变了：

| | ≤ 0.1.6-alpha.2 | ≥ 0.1.7-alpha.1 |
|---|---|---|
| 注册 | `ctx.settings.register(ns, schema, { base })` | 无 `register`；表单来自插件导出的 `Config` 的 `.volatile()` 字段 |
| ns 语义 | 插件短名 `wallpaper-engine` | **profile 条目 id** `dsh-wallpaper-engine` |
| 持久化 | `$DSH_HOME/settings.yaml` | 当前 profile 的 `cordis.patch.yml` |

用户升级后症状是**设置面板全空、壁纸列表为空** —— 而且失败全是静默的：host 侧 `settings.register` 不存在只在子 fiber 内抛 TypeError（被吞，仅服务端日志）；client 侧找不到 `wallpaper-engine` 这个 ns 就回退 `DEFAULTS`（面板空、当前壁纸"无"）。

更麻烦的是两个**真会崩**的点：`import { settingsNamespace } from '@deepseek-ai/dsh-settings'` 这个导出自 DSH `0.1.2-rc.1` 起就不存在，静态命名导入会**链接期 SyntaxError**（当时没炸只因解析到了插件自带的旧副本）；`schema.volatile()` 需要 schemastery ≥ `3.18.4`，而 lockfile 钉的是 `3.18.1`。

## Decision

**同一份产物同时支持两版，靠特性探测分流，不靠版本号判定。**

- **host 分流**（`src/host/index.ts`）：删除 `settingsNamespace` 静态导入与无条件 `register` 调用；在 `ctx.inject(['settings'])` 内做 `typeof settings.register === 'function'` 探测 —— 有则是旧路径（`register(ns, schema, { base: config })` + `scope.watch`），没有则是新路径（`settings.configure({ auto: false }, ctx.fiber)` 关掉自动生成页，配置值直接读 loader 传入的 `config`）。特征探测比版本号可靠：`settingsNamespace` 早在 `0.1.2-rc.1` 就没了，版本号反映不出 service 形状。
- **`Config` 三条规定**：① 用**对象级** volatile（`WallpaperSettingsSchema.volatile()`，`volatileForm` 对对象级 volatile 直接整体成表单），旧路径继续用非 volatile 的 schema；② **必须挂在默认导出的 `apply` 上**（loader 的 `unwrapExports` 在存在 default 导出时丢弃命名导出，只导出命名 `Config` 不生效）；③ volatile 读值**必须 `.get()`** —— 0.1.7 交给插件的 `config` 是活引用，`config.wallpaperDir` 直接取到 `undefined`（真机表现 = `/wallpapers/list` 返回 `[]`），落点统一在 `configValue()`，`state` 用 getter 惰性读，**不得在 `apply` 里快照**。
- **依赖**：`@deepseek-ai/schemastery` 升到 `^3.18.4`（`.volatile()` 必需，**不要降回**）；`@deepseek-ai/dsh-settings` 不再静态导入任何符号。已实测 `3.18.4` 生成的含 `"volatile":true` 的 schema JSON 被 `3.18.2` 反序列化与校验都正常，旧 loader 代码里也完全不含 volatile 逻辑 ⇒ 导出 `Config` 对旧版无害。
- **client 双 ns**（`src/client/settings.ts`）：候选 `['dsh-wallpaper-engine', 'wallpaper-engine']`，`describe()` 后取**实际存在**的那一行并记住命中的 ns（写回时用它）；两版都没有时按 value 形状兜底。**写入失败不再静默**：`console.warn` + 返回 `false`（原来的 `.catch(() => {})` 会造成"提示已保存但没生效"）。
- **解析优先级两版统一**：schema 默认值 → profile entry config → 用户设置。手工预置配置一律写 profile `cordis.patch.yml` 里该条目的 `config`（新旧通吃的位置）。

## 涉及仓库

- `dsh-use-wallpaper` 分支 `master` commits `f68d59c` `d397084`

## Alternatives considered

**只支持新版，README 声明最低 DSH `0.1.7-alpha.1`。** 理由：代码最干净，两套分支与两套样式都能删掉，也不用维护特性探测。不用它是因为用户当时就在旧版上用（旧版渲染链路实测完全正常，只是设置接法不同），声明最低版本等于把现有用户挡在门外，而兼容的代价只是两条分支加一份清理清单。

**按 DSH 版本号分支（读版本选路径）。** 理由：比探测 service 形状直观，也容易写文档。不用它是因为版本号**不反映 service 形状**：`settingsNamespace` 导出自 `0.1.2-rc.1` 就已不存在，而 renderer/loader 的版本各有一条独立演进线 —— 探测能力（`typeof register === 'function'`）才与"这一版到底支持哪种接法"一一对应。

**把配置放在 profile `package.json` 的 `dsh.profile.config`。** 理由：看起来是"profile 自己的配置"，位置最自然。不用它是因为**两版都不读它**（旧 `profile-boot` 同样只认 `dsh.profile.bundles` + `cordis.patch.yml`）—— 实测配上 `wallpaperDir` 后列表仍为空。该字段已从 profile 删除以免误导。

**让插件自带一个完整的设置面板、不走 DSH 的 settings 服务。** 理由：绕开两版差异，一次写完后不再受影响。不用它是因为面板本来就依赖 `ctx.remote.settings.describe()` 这一路（`settings-section.tsx`），且 DSH 的 slot 注册与主题 token 都在宿主侧；自建表单等于把宿主的事重做一遍，还要跟着宿主样式变。

## Consequences

**收益：** 同一份产物在两版上行为一致（面板读到 profile config、`selectedWallpaperId` 自动恢复、面板读写各自落到正确位置），既消除了两个硬崩点，也消除了"面板显示已保存但没生效"这种静默失败。真机验收覆盖 `0.1.5-rc.3` / `0.1.6-alpha.2` / `0.1.7-alpha.2` 三档。

**代价：** 插件从此**并存两套代码与样式**，且它们混在三处容易误删。因此把删除判据写进 `AGENT.md` §7.34：**README 声明的最低 DSH 版本 ≥ `0.1.7-alpha.1`，且本机与 CI 都不再跑旧版验收**时才动清理清单（`docs/superpowers/plans/2026-09-23-dsh-settings-compat-migration.md` §9）。清理时**特别注意清单里的三类区分**：可直接删的旧版专用代码、可还原的兼容技巧（右栏 `:where()` 低具体度）、以及**必须保留的 0.1.7 适配**（`Config` 挂 default `apply`、`configValue()` 解引用、依赖 `^3.18.4`、右栏全部 CSS、两条 `--dsw-specific-menu` 覆盖）—— 后者删了会在**新版**上回归。

迁移全过程的版本实测矩阵、两处实现偏差（对象级 volatile、`.get()` 解引用）与清理清单见 [DSH 设置系统兼容迁移](../../../../docs/superpowers/plans/2026-09-23-dsh-settings-compat-migration.md)。
