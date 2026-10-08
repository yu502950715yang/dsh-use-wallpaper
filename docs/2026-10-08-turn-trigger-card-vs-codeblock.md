# 「收到任务消息」卡片与代码块配色不一致 —— 根因分析

> §1–§6 是根因分析（截图 1509×852 PNG，原图哈希 7a12386753…），§7 是方案 A 的落地记录（2026-10-08 实施）。

## 一句话结论

两块用的是**两个不同的底色 token**，且这个"不同"是 **DSH 原生**行为（浅色主题下二者同色，只有深色主题才分叉）；本插件的「壁纸透出」方案把原本看不出来的差异放大成了明显差异。

## 1. 两个元素的原生规则

**卡片**（TurnTriggerNodeView，即 `message.trigger.agent` =「收到任务消息」）
`dsh/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js`
（已提取副本 `output/analysis/dsh/chat-client.js`）

```css
.oE-XyW_root{
  border:.5px solid var(--dsw-alias-border-l1);
  border-radius:var(--dsw-radius-xl);
  background:var(--dsw-alias-turn-trigger-bg, var(--dsw-alias-markdown-code-block));
}
.oE-XyW_content{ /* 正文，无自底色 */ }
```

**代码块**（markdown CodeBlock）
`dsh/node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/markdown/CodeBlock.module.css`

```css
.block { --dsl-code-block-background: var(--dsw-alias-markdown-code-block);
         background: var(--dsl-code-block-background); }
```

即：卡片的 fallback 恰好就是代码块的底色，但卡片实际用的是**另一个 token**。

## 2. token 在两个主题下的取值

token 定义来自 `dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js`
（已提取副本 `output/analysis/dsh/theme-bundle.css`）

| token | 浅色 `body` | 深色 `body[data-ds-dark-theme]` |
|---|---|---|
| `--dsw-alias-turn-trigger-bg`（卡片底） | `var(--dsw-alias-markdown-code-block)` | `var(--dsw-alias-interactive-bg-hover)` = **`#ffffff14`**（8% 白，半透明） |
| `--dsw-alias-markdown-code-block`（代码块底） | `var(--dsw-static-neutral-bluish-50)` = **`#f9fafb`** | `var(--dsw-static-neutral-bluish-900)` = **`#1b1b1c`** |
| `--dsw-alias-bg-base`（页面底） | `#fff` | **`#0f1115`** |
| `--dsw-alias-border-l1`（卡片描边） | `#0000000a` | **`#ffffff0f`**（约 6% 白，几乎不可见） |
| `--dsw-alias-label-primary`（正文文字） | neutral-bluish-1000 | **`#f9fafb`** |

- **浅色主题**：卡片底 = 代码块底 = `#f9fafb` → 两块**同色**，看不出问题。
- **深色主题**：卡片底变成 8% 白的 hover 叠加色，代码块仍是 `#1b1b1c` 实色 → **分叉**。

## 3. 截图取色（客观证据）

| 采样 | 结果 |
|---|---|
| 代码块 x400–1200, y585–660 | 众数 **(27,27,28) = `#1B1B1C`**，占比 58512/64800 ≈ **90%** → 不透明实底 |
| 卡片区 x360–1240, y170–480 | 众数 **(20,25,32)/(20,24,32)/(20,25,33)**（深蓝黑，属壁纸）+ 文字亮色 (207,211,214)；**完全没有 `#1b1b1c`** → 卡片底透明，壁纸穿过 |
| 卡片右边缘 x≈1267, y=200 | 出现亮线 (145,153,157) → 那圈可见描边 |

由 `#1b1b1c` 只在 `body[data-ds-dark-theme]` 生效（浅色下该 token 是 `#f9fafb`）可反推：**截图是深色主题**。

## 4. 插件在其中做了什么（放大差异）

`src/client/styles.ts`（已构建 `dist/client.js` 中同样存在，运行版本与源码一致）

1. **`:43`** `body[data-we-wallpaper]{--dsw-alias-bg-base:transparent!important}`
   页面底从 `#0f1115` 变透明 → 卡片那层 8% 白叠加的下面不再是纯色页面底，而是**壁纸**。于是卡片区域颜色随壁纸走（截图里是暗蓝星空/地球，动态壁纸下还会持续变化），而代码块恒定 `#1b1b1c`。这是"不一致"的主因。
2. **`:49-53`** `--dsw-alias-border-l1/l2: rgba(180,180,180,.35)`
   把原生 `#ffffff0f`（几乎看不见）提到明显灰白 → 卡片多出一圈亮描边，观感像"一块浅色玻璃卡片"；代码块无描边。
3. **`:222-234` vs `:265-269`** 文字取色分家
   - flowItem 内 `p/span/li` → `color: var(--wp-chat-fg, …)`（按壁纸亮度自适应反色）；
   - `code`/`pre code` → 显式复位到 `--dsw-alias-label-primary`。
   同一屏里通知文字与代码文字用两套取色逻辑（截图卡片文字实测 (207,211,214) 亮色，与深色主题 + 暗壁纸的结果自洽）。
4. 插件**没有**任何针对 `[data-turn-trigger]` / `oE-XyW_root` 的规则（源码与 `dist/client.js` 中 `turn-trigger` 出现 **0** 次）→ 卡片底色 100% 由 DSH 决定，插件只是没管它、并抽掉了它身下的页面底。

## 5. 因果链

```
DSH 深色主题：卡片底 = --dsw-alias-turn-trigger-bg = #ffffff14（半透明淡叠加）
              代码块底 = --dsw-alias-markdown-code-block = #1b1b1c（实色）
        ↓ 原生差异很小（都压在 #0f1115 页面上）
插件：--dsw-alias-bg-base → transparent（让壁纸透出）
        ↓
卡片：8% 白 + 壁纸 → 蓝黑、透、有纹理、随壁纸变化；边框被插件提亮
代码块：#1b1b1c 不透明实块，挡住壁纸
        ↓
同屏 → “颜色/质感不一致”
```

## 6. 可选处理方向（本次未实施）

| 方向 | 做法 | 影响面 |
|---|---|---|
| A 统一到实色 | 给 `[data-turn-trigger]` 补 `background: var(--dsw-alias-markdown-code-block)` 之类的实底 | 最小，仅该卡片；与代码块观感一致，但挡住壁纸一块 |
| B 接受原生 | 不改，承认这是 DSH 深色主题的原生设计（hover 淡底） | 零风险，但保留当前观感 |
| C 统一到半透明 | 把 `--dsw-alias-markdown-code-block` 也调半透明 | 影响所有代码块/banner/行内 code，且与 `styles.ts:215-221`「实底 code 不参与反色」的既有设计冲突，风险大 |

若走 A，还需一并复核插件 `:49-53` 的描边与 `:222-234` 的文字反色在该卡片上的表现，避免"实底 + 反色白字"打架。

## 附：本次分析用到的脚本（只读）

- `output/analysis/asar-tool.mjs` —— 解析 `E:\DeepseekHarness\resources\app.asar`（list / grep / extract）
- `output/analysis/extract-theme-css.mjs` —— 抽主题内嵌 CSS → `dsh/theme-bundle.css`
- `output/analysis/scan-token.mjs` —— 在压缩 CSS 中定位 token 定义
- `output/analysis/sample.py` / `sample2.py` / `edges.py` / `verify.py` —— 截图取色与边界扫描
- 提取的 DSH 侧文件在 `output/analysis/dsh/`

---

## 7. 实施结果（2026-10-08，方案 A 落地）

| 文件 | 改动 |
|---|---|
| `src/client/styles.ts` | 浅/深两个主题分支各覆盖 `--dsw-alias-turn-trigger-bg` 与 `--dsw-alias-turn-trigger-bg-hover` 为 `var(--dsw-alias-markdown-code-block)`；新增卡片实底文字口径规则（文字 `--dsw-alias-label-primary` + `text-shadow:none`，header 保留 tertiary、说明保留 secondary） |
| `tests/styles.test.ts` | 新增 3 项断言（两分支 token 覆盖、字色复位且**具体度高于反色规则**、层级色保留） |
| `e2e/verify/verify-turn-trigger-card.mjs` | 新增计算样式验收（`npm run e2e:card`）：headless Edge + 从 `app.asar` 现场提取的 DSH 主题/组件 CSS + esbuild 打包的插件 CSS + 真实类名 DOM，含 hover 伪态与反色对照组 |
| `package.json` | 新增 `e2e:card` script |
| `AGENT.md` | §3.1 命令表 + 新增 §5.42（根因/坑/验证） |
| `lib/`、`dist/` | 重建（tsc + esbuild） |

**实测（真实 Chromium 计算样式）**

| 场景 | 卡片底 | 代码块底 | 卡内正文色 |
|---|---|---|---|
| 修复前（无插件 CSS，深色） | `rgba(255,255,255,0.08)` | `rgb(27,27,28)` | — |
| 修复后（深色） | **`rgb(27,27,28)`** | `rgb(27,27,28)` | `rgb(249,250,251)` |
| 修复后（深色，hover） | `rgb(27,27,28)` | — | — |
| 修复后（浅色） | `rgb(249,250,251)` | `rgb(249,250,251)` | `rgb(0,0,0)` |

对照组：同页普通正文仍被 `--wp-chat-fg=#000` 反成黑 ⇒ 证明反色机制正常、卡内不变黑是复位规则的作用（排除假通过）。

**验证**：`npm test` 全量 52 文件 / **1039 项全绿**；`npm run e2e:card` **9 项全 PASS**；`npm run build` + `build:client` 通过。

**过程中新发现的两个坑（已写进 AGENT.md §5.42）**

1. **具体度**：卡内文字复位若只写 `[data-turn-trigger] *`（(0,2,1)）会输给消息列反色规则 `[class*="flowItem"] p`（(0,2,2)，`p` 贡献类型位、`*` 不贡献）⇒ 卡内仍是黑字压深底。**必须带 `[class*="flowItem"]` 前缀**。(0,3,1) 才能压过。纯读 CSS 会以为写对了，是 e2e 实测算出来的。
2. **token 覆盖的位置**：写单条 `body[data-we-wallpaper]`（(0,1,1)）与 DSH 的 `body[data-ds-dark-theme]`（(0,1,1)）同具体度，只能靠样式表插入顺序取胜；写进既有的浅/深分支（(0,2,1)）才稳。
3. 附带踩到一次：`styles.ts` 的 CSS 模板串里**注释也不能出现反引号**（本次误用，esbuild 直接报错）。

**边界（如实标注）**

- 未在真实 GUI 页面里取计算样式：`http://127.0.0.1:19387` 直接访问返回 **401**（需要桌面壳的访问 token，脚本拿不到）。验收用「真实 Chromium + DSH 真实 CSS/真实类名 DOM」等效替代；真机观感请以 GUI 为准（dist 已重建，client HMR 会自动半重载）。
- 方案 A 的既定代价：卡片现在是**不透明** `#1b1b1c` 实底，该区域不再透出壁纸；hover 底色与静态同色（鼠标移上不再透回壁纸）。
- 若 DSH 今后在更具体的选择器上定义 `--dsw-alias-turn-trigger-bg`，插件覆盖会失效、卡片回半透明淡底（降级安全，不影响可读性）。

