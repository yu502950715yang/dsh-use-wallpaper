# Agent Note: 设置页 tab 合并 + 面板设计系统（2026-10-30）

Status: implemented

## Problem

开机动画此前是设置对话框里与「Wallpaper 壁纸」并列的**独立菜单项**（order 20 / 21）：入口分裂、两个面板视觉差距大（壁纸面板有成熟的 hero/卡片/缩略图样式，开机动画面板只有约 10 行朴素 CSS）。用户要求「把开机动画合并到 Wallpaper 壁纸里，用 tab 区分」，并借 `ui-design-system` 统一两个面板的设计语言。

## Decision

- **单 section + 顶部 tab**：新增 `settings-shell.tsx`（`WallpaperSettingsShell`）作为 `settings.section` 唯一注册组件；页内 tab「日常壁纸 / 开机动画」，默认「日常壁纸」且**不记忆**（每次打开行为可预测）。`index.ts` 删除 `wallpaper-engine-boot` 第二个注册；`tests/dom/bootstrap.dom.test.ts` 的 section 断言由 2 改为 1 并断言容器组件名。
- **tab 切换用条件渲染**：切走即卸载另一个面板（避免两个面板同时拉壁纸列表 / 读设置）；tab 容器带 WAI-ARIA 角色（`role=tablist/tab/tabpanel`、`aria-selected`、`aria-controls/labelledby`）与 ←/→ 键盘切换。
- **设计 token（`--we-*`）派生自 DSH 主题 token**：间距（4/8/12/16/24）、圆角（8/10/14/16）、表面/边框、阴影、状态色（ok/warn/danger）、焦点环，浅/深色两套；不新建色板，不硬编码主题色。
- **壁纸面板旧规则保持不动，统一观感走「设计系统覆盖」段**：`tests/styles.test.ts` 有 337 行对 `wss-*` CSS 文本的精确断言（hero 容器查询、grid 列数、按钮分组、token 覆盖等），直接改写规则会打碎契约；因此在样式文件末尾追加覆盖规则（只改外观值、不改选择器/布局契约），旧断言继续成立。代价是同一选择器存在「旧规则 + 覆盖规则」两份（注释已标明契约原因），后续若允许更新契约测试可合并。
- **开机动画面板重设计（`wbs-*`，保留全部既有测试钩子与 props）**：状态 hero（标题/说明/上次播放 tone + 胶囊开关）、素材来源分段控件、WE 选中项 16:9 预览、本地路径 + 校验状态条、展示方式 2×2 卡片（线框示意图，视频时平铺卡片置灰）、时长滑杆 + 数值 chip、primary 试播按钮 + 结果状态条；容器查询 ≤520px 降级单列。
- **行为零变化**：设置字段、host 路由、boot-overlay/player 语义、静音/只播一次/8s 超时全部不动；只改入口结构、DOM 装饰与样式。

## Alternatives considered

**保留两个独立菜单项**：入口分裂、视觉各自为政，正是用户要改掉的；否决。

**重写 `wss-*` 规则以彻底 token 化**：会与 `tests/styles.test.ts` 的 337 行文本契约冲突（hero/grid/按钮分组等精确断言），且壁纸面板样式已成熟、收益低；改为覆盖段 + 保留旧规则；否决「重写」。

**tab 切换用 CSS 隐藏保留两个面板挂载**：切换更顺滑，但两个面板同时读设置/拉列表、且隐藏面板的定时器与轮询继续跑；否决。

**记忆上次 tab（localStorage）**：体验更顺，但用户明确要求「默认日常壁纸且不记忆」（简单可预测）；否决。

## Consequences

**收益：** 设置入口收敛为一个「Wallpaper 壁纸」菜单，日常壁纸与开机动画在页内 tab 切换、设置仍各管各的；两个面板共享同一套间距/圆角/表面/状态色/焦点环；开机动画面板有了 hero、分段来源、素材预览、2×2 展示方式卡片与状态条；既有 58 个 `wss-*` 契约与 337 行样式断言全部保持。

**代价／已知边界：** `wss-*` 存在「旧规则 + 覆盖段」双份样式（契约测试需要旧文本）；tab 切换会重新挂载面板（重新读设置/列表，属可接受成本）；开机动画面板仍固定静音、平铺仅图片；真机视觉验收（浅/深色、窄容器）需在 DSH 设置对话框里人工确认（`TESTING.md` §2.18 的 B 系列未含本次视觉项，可补）。

## Affected repositories

- `dsh-use-wallpaper`（master）：`src/client/settings-shell.tsx`（新）、`boot-settings-section.tsx`（重设计）、`styles.ts`（token/tab/覆盖/wbs 重写）、`index.ts`（单 section 注册）、测试 `settings-shell.dom.test.tsx`（新）/ `boot-settings-section.dom.test.tsx` / `bootstrap.dom.test.ts` / `styles.test.ts`，`lib/`+`dist/` 产物，AGENT.md §1/§2.2 与 README 配置项说明。
