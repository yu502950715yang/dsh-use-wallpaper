# DSH 壁纸插件「主题切换文字可读性」设计文档（最终定稿 · 复刻竞品 scrim 暗化）

- 日期：2026-09-03（多次修订：B 方案 → A3 玻璃 → 无玻璃双色描边 → **最终：复刻竞品 scrim 暗化**）
- 目标插件：`@dsh-use/wallpaper-engine`（src/client/styles.ts 主题覆盖层）
- 状态：**已定稿（最终）**——复刻 `elysia395/dsh-wallpaper-engine` 的 scrim 暗化体系
- 蓝本：**`elysia395/dsh-wallpaper-engine`（本地 `research/competitor/`）**——它的 scrim 暗化 + 文字压黑体系经用户实测确认有效

> **最终定稿（2026-09-03 晚，用户指示参考 elysia395 竞品）**：
> 用户反馈前几轮（A3 玻璃 / 无玻璃双色描边）要么遮壁纸、要么文字更糊。参考竞品 `elysia395/dsh-wallpaper-engine` 后，确定其核心方案：
> **壁纸层 + 可调 scrim 暗化遮罩**（`--wp-scrim-alpha`，默认 0.25，设置面板「暗化」滑杆 0-85% 用户可调）压暗壁纸，让 **DSH 原生的黑/白文字自然可读**；**不用 text-shadow 描边**（会糊）；浅色主题文字压黑对齐竞品。
> 浏览器实测（明亮 EVA 壁纸）：25% 轻压暗（壁纸亮、文字可读）、50% 清晰（文字完全可读、壁纸仍可见）。**用户可自定义压暗程度**是竞品方案的核心价值。
>
> 以下正文仍保留 A3 玻璃 / 双色描边方案的历史记录（作为探索过程），**最终实现以本头部"最终定稿"为准**。

---


## 1. 问题与实测根因（Phase 1 证据）

DSH 通过给 `<body>` 加/去 `data-ds-dark-theme` 切换深/浅主题。插件（`styles.ts`）在有壁纸（`body[data-we-wallpaper]`）时把 `--dsw-alias-bg-base` 覆写为 `transparent` 让壁纸透出，并把浅色分支文字 token 压成纯黑（`--dsw-alias-label-primary:#000`）。

**浏览器实测（2026-09-03，用真实 DSH 会话 + 亮色 EVA 壁纸）：**

消息气泡及父链背景**全部为 `rgba(0,0,0,0)` 全透明**：

```
DIV EvIC1a_flowItem  bg: rgba(0,0,0,0)   ← 文字直接贴壁纸，无底衬
DIV EvIC1a_column    bg: rgba(0,0,0,0)
DIV EvIC1a_scroll    bg: rgba(0,0,0,0)
DIV EvIC1a_root      bg: rgba(0,0,0,0)
```

消息滚动区 `[class*="scrollBody"]` 同样 `bg: rgba(0,0,0,0)`、无 `backdrop-filter`。

**根因**：浅色主题下文字被压成**纯黑** `#000`，而消息区**没有任何不透明底衬**（气泡及父链全透明），黑字直接贴在壁纸上。**明亮/高饱和壁纸**（EVA 橙黄机甲）下，黑字被亮底"吃掉"→ 对比崩。此为结构性缺陷。

**为何 B 方案（保留壁纸纯可见 + scrim/text-shadow 补偿）失败**：
- 白 halo `text-shadow 0 0 1.5px #fff` 对"黑字 + 亮底"无效（halo 混进亮背景）；
- scrim `.18`（浅色）压 18%，对高亮壁纸无作用；
- 黑字在任何亮底上都看不清，scrim + text-shadow 这两个补偿手段对"黑字+亮底"组合本身失效。

---

## 2. 已选方案：A3 玻璃托底（区分浅/深玻璃）

**核心**：给消息区（聊天滚动区）加一层**半透明玻璃托底**（`background: rgba(...)` + `backdrop-filter: blur`），让所有消息/代码块/引用内容有一个稳定的底色，文字不再直接贴壁纸。壁纸在玻璃下及两侧壁纸区域（侧边栏、页面边缘）仍可见。

### 2.1 玻璃层

| 主题 | `[class*="scrollBody"]` 玻璃 |
|---|---|
| 浅色 | `background: rgba(255,255,255,.35)` + `backdrop-filter: blur(12px) saturate(1.2)` |
| 深色 | `background: rgba(24,26,30,.44)` + `backdrop-filter: blur(12px) saturate(1.2)` |

玻璃透明度、blur 半径经 CSS 变量（`--wp-glass-bg` / `--wp-glass-blur`），设置面板可调。

> **浏览器已验证可行**：注入 `[class*=scrollBody]{background:rgba(255,255,255,.35);backdrop-filter:blur(12px)}` 实测截图——黑字在玻璃上完全可读，壁纸在底部/两侧透出，效果符合预期。

### 2.2 文字色

- **浅色主题**：保持黑（玻璃是白色半透明，黑字清晰）；**不再压成 `#000` 强行改色**——由 DSH 原生近黑即可，玻璃托底已足够。
- **深色主题**：保持白（DSH 原生近白）。
- 移除 B 方案的冲突源：**不再给文字加 `text-shadow` halo**（黑字+白halo 无效问题随之消除）。

### 2.3 壁纸层 scrim

壁纸层的 `.wp-bg-overlay` 遮罩保留，但归为伴随项（玻璃已托底，scrim 可调低或不强制）：浅色 `.12` / 深色 `.22`。是否保留 scrim 待视觉定。

### 2.4 侧边栏

保持现状（`--dsw-specific-sidebar-fill` 半透明让壁纸透出）。侧边栏文字对比靠半透明底即可，不在本次改动。

---

## 3. 涉及文件

| 文件 | 改动 |
|---|---|
| `src/client/styles.ts` | ① `[class*="scrollBody"]` 加玻璃：浅 `rgba(255,255,255,.35)` / 深 `rgba(24,26,30,.44)` + blur；② **移除** B 方案 `text-shadow` halo 规则；③ 浅色分支不再强行压 `--dsw-alias-label-primary:#000`（保留 DSH 原生近黑，或将调整）；④ scrim 双值调整（浅 `.12` / 深 `.22`，可选）；⑤ 玻璃层随 `--wp-glass-*` 变量 |
| `src/client/types.ts` | `ClientSettings` 调整为可调玻璃强度字段（`glassEnabled` + `glassOpacity`/`glassBlur`），替代 `textContrastEnabled`+`textShadowStrength` |
| `src/client/settings.ts` | `DEFAULTS` 补新字段缺省 |
| `src/client/background-layer.ts` | `setTextContrast` 改为 `setGlass`（设 body CSS 变量/类）；移除 text-shadow 相关 |
| `src/client/index.ts` | `applySettingsToLayer` 追加玻璃字段 |
| `src/client/settings-section.tsx` | 设置面板「文字对比」改为「玻璃托底」开关 + 透明度/模糊滑块 |
| `tests/styles.test.ts` | **更新** 多条冲突断言（见 §4） |
| `tests/client-settings.test.ts` | 更新新字段读写断言 |
| `tests/background-layer.test.ts` | 若 `setTextContrast`→`setGlass`，更新断言 |

---

## 4. 对现有测试的影响（评审重点）

以下几处 `styles.test.ts` 断言与 A3 **必然冲突**，须同步更新：

1. `it('整区 scrollBody 不 blur（壁纸在气泡间清晰可见）')` → **断言 `not.toMatch(/scrollBody/.+backdrop-filter/)` 失效**——A3 恰恰给 `scrollBody` 加 blur。改为断言存在玻璃 blur。
2. `it('壁纸层不透明化：… 无 text-shadow')`（含 `not.toMatch(/text-shadow:/)`）→ A3 移除 text-shadow，此断言可保留/改为断言 **不包含** text-shadow（若确定移除）；若保留字段则改为断言新玻璃。
3. `it('文字可读性补偿（B 方案）：…text-shadow…')` → 整条删除/改写为玻璃托底断言。
4. `it('消息气泡改回 DSH 原生（无液态玻璃覆盖）…')` → A3 给 `scrollBody` 而非 `flowItem` 加玻璃，`flowItem` 原生不受影响，此断言可保留；但需确认不误伤。
5. `it('scrim 遮罩：主题感知双值（浅色浅、深色深）')` → 保留，但 scrim 值改为浅 `.12` / 深 `.22`。

> 结论：A3 会改写 `styles.test.ts` 的核心断言（scrollBody blur / text-shadow），需整体重写相关用例，并附视觉走查。

---

## 5. 非目标

- **不做**亮度自适应检测（scene readback 等）——玻璃托底不依赖壁纸亮度，天然通吃三类壁纸。
- 不重构为 DSH 官方 `overrideTokens` 接缝（维持现有 `<style>` 注入 + body 属性分支；迁移为独立议题）。
- 不动侧边栏、输入框、提问弹窗的现有液态玻璃（`data-composer-card`/`data-question-key` 已在用玻璃，本次不重复处理）。

---

## 6. 实现基线

1. `styles.ts`：给 `[class*="scrollBody"]` 加玻璃（浅/深双值），移除 text-shadow halo，浅色分支文字色保持 DSH 原生近黑（不强行压 `#000`），scrim 调低。
2. 设置面板：玻璃托底开关（默认开）+ 透明度/模糊滑块，随设置持久化。
3. 移除 `textContrastEnabled`/`textShadowStrength` 字段（或其字段语义改为玻璃），更新 types/settings/background-layer/index。
4. 更新 tests（styles 核心断言 + client-settings + background-layer）。
5. 重建 `dist/client.js` + 同步 profile。
6. 浏览器视觉走查：**浅色 + 亮色 EVA 壁纸**（用户截图场景）必须通过；再验深色 + 暗壁纸。

---

## 7. 待视觉确认项

| # | 项 | 初值 |
|---|---|---|
| 1 | 浅色玻璃透明度 | `rgba(255,255,255,.35)` |
| 2 | 深色玻璃透明度 | `rgba(24,26,30,.44)` |
| 3 | blur 半径 | `12px` |
| 4 | scrim 是否保留 | 浅 `.12` / 深 `.22`（可去掉） |
| 5 | 设置面板控件 | 玻璃开关 + 透明度滑块（模糊可固定） |
