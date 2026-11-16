# Agent Note: 对话区文字列毛玻璃（issue #7）

Status: implemented

## Problem

用户希望"把对话框和背景壁纸隔离、呈现毛玻璃特效"，并明确反对用「遮罩不透明度」压暗壁纸换可读性（issue #7 作者：遮罩会让背景亮度降低、失去美感）。插件当时只有全局 scrim + 背景模糊 + 文字反色，没有"文字面"这一层。竞品 `elysia395/dsh-wallpaper-engine` 的玻璃铺在「本来就有底的面」上（用户气泡 / 输入卡 / 工具卡 / 设置窗 / 侧栏），助理长文仍贴壁纸，靠 `scrim 0.25–0.6` 兜可读性——即"照抄竞品"会回到用户反对的压暗。设计过程见 `research/glass-mock/`（一次性 mock，未入库）。

## Decision

- **只给消息列加玻璃**：选择器 `body[data-we-wallpaper][data-we-glass] [data-conversation-scroll] [class*="_column"]`。DSH 的 `.V4vHZW_column` 是 `max-width: var(--dsh-chat-content-width)`（920px）的居中列，在滚动区内、输入框外——标题栏/侧栏/输入框天然不参与，且它是**一个连续面**，不产生"每条消息一个框"的接缝。
- **默认关、零回归**：新增 `chatGlassEnabled`（默认 false）与 `chatGlassStrength`（默认 45）。未挂 `data-we-glass` 时新规则零命中；强度 45 = 底色不透明度 48% + 模糊 14px（映射 `0.20 + 0.62×v`、`round(32×v)`）。
- **不压暗壁纸**：遮罩仍是独立旋钮，不自动联动；面板在「开启且遮罩 > 0」时给一行提示 + 「设为 0」按钮，只改用户主动点击的那一次。
- **文字色回主题**：玻璃上文字不再按壁纸亮度反色/描边——`setChatGlass` 清 `--wp-chat-fg` / `--wp-chat-outline`，且开启期间 `setChatFg` / `setChatOutline` 变空操作；关闭后由 `controller.applyTextStyle()` 恢复。
- **不做每条消息框**：mock 实测"每条消息一个框"在长对话里是"一条条玻璃页 + 硬缝"，工具卡/代码块会出现盒中盒，用户自己也反馈过效果不好；仅给用户气泡加玻璃（F2）虽好看但助理侧仍碎，最终否决。对比图见 mock `compare-current.jpg` / `compare-tool-turn.jpg`。

## Alternatives considered

**整块主区/整个对话框玻璃（含标题栏）**：把壁纸几乎全糊掉，用户明确说"看不清背景"；否决。

**每条消息一个框**：缝隙 + 盒中盒 + 阴影叠加 + N 个 backdrop-filter 采样区；否决，见 mock。

**只给用户气泡加玻璃（竞品做法）+ 助理框**：用户气泡侧好看，但助理侧仍是一块块整屏玻璃，且需额外排除 tooltip（`_bubble_` 类名与提示框共享）；否决。

**自动把遮罩降到 0**：会改用户已设的值、滑杆跳变；改为提示 + 一键按钮。

## Consequences

**收益：** 文字列有稳定的磨砂底，壁纸两侧/标题栏保持原亮度；短对话是一张卡片，长对话是一条连续的玻璃页（滚动时玻璃看起来静止，只有文字在动）。

**代价：** 玻璃列宽 920px，宽屏下两侧壁纸只剩窄边；强度 45% 在亮壁纸 + 浅色主题下偏轻（滑杆可调）；`[class*="_column"]` 是 DSH CSS 模块的后缀约定，DSH 改列结构时静默失效（退化为无玻璃，不影响可读性兜底）；一个大面积 `backdrop-filter` 的每帧重采样成本需真机验证（只有一个面，比每条消息框可测）。

**已知边界：** 玻璃只覆盖聊天视图的 `.V4vHZW_column`，trajectory 等其它视图不生效；列内已有底的面（气泡、代码块、工具卡）仍是原生材质，因此玻璃上会看到"两层材质"（刻意保留，避免二次改色）。

## Affected repositories

- `dsh-use-wallpaper`：`src/client/{types,settings,background-layer,index,styles,settings-section}`、`src/host/settings.ts`、测试 4 个文件、README/CHANGELOG/AGENT.md。
