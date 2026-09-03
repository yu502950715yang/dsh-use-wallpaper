# DSH 壁纸插件「文字颜色跟随壁纸亮度自适应」设计文档

- 日期：2026-09-03
- 目标插件：`@dsh-use/wallpaper-engine`（src/client/）
- 状态：**待定稿**——只让消息列文字颜色跟随壁纸亮度自动切换；不动背景、不加玻璃/遮罩/描边
- 前置：用户明确此方案（"切换壁纸时只需让消息列内文字跟随壁纸切换颜色"），取代此前多轮背景类方案

---

## 1. 目标（用户的方案）

**不动背景、不改壁纸可见度**（壁纸 100% 清晰），只让**消息列（DSH 的 `EvIC1a_column` 即聊天消息列）内的文字颜色**跟随当前壁纸亮度自动切换：

- 壁纸**暗** → 文字用**浅色**（白/近白）；
- 壁纸**亮** → 文字用**深色**（黑/近黑）。

即「亮度自适应文字反色」。核心是**读壁纸亮度 → 选文字色**，不依赖主题、不遮挡壁纸。

---

## 2. 实证：壁纸亮度检测可行性（2026-09-03 浏览器实测）

结论：**4 类壁纸都可通过 preview 图测亮度**。关键实测数据：

| 壁纸类型 | 检测手段 | 实测结果 |
|---|---|---|
| scene（WebGPU wasm，主路径） | **preview 图测亮度** | ✅ `previewUrl` 加载成功，读像素算出 `avgLuma=96`（偏暗）。**WebGPU canvas 本身 `drawImage`→2d 读像素返回全黑（`avgLuma=0`），读不到**，故必须走 preview 图 |
| image | 实际 `<img>` 元素 drawImage 测量 | ✅ 容易 |
| video | `<video>` 帧 drawImage 测量 | ✅ 可以（偶发采样） |
| web（iframe） | 跨域 opaque origin，读不到 | ❌ 读不到；可回退 preview 图或固定策略 |

> **决定性洞察**：`wallpaper-controller` 在渲染失败时本就回退 preview（`showImage(info.previewUrl)`），且 `WallpaperInfo.previewUrl` 对 scene 壁纸始终可用。所以统一用 **preview 图测亮度** 是跨壁纸类型最稳的方案（scene/video/image/web 都有 preview 或可用实测替代）。

---

## 3. 方案设计

### 3.1 核心链路

```
切换壁纸 → 加载 preview 图 → 采样缩略图到小 canvas → 算平均亮度(0-255)
        → 亮度 < 阈值 → 文字浅色；否则 → 文字深色
        → 把颜色写为 CSS 变量（如 --wp-chat-fg）
```

静态化：**在切换壁纸时检测一次**（非实时），把结果写成一个 CSS 变量，供消息列文字消费。

### 3.2 亮度→文字色映射

| 平均亮度 | 文字色 | `--wp-chat-fg` |
|---|---|---|
| `< 128`（暗） | 浅色（白） | `#f9fafb` |
| `>= 128`（亮） | 深色（黑） | `#0f1115` |

阈值 128 是 RGB 亮度中点，可调；过渡可用 `--wp-chat-fg` 平滑（CSS 变量无动画，需 JS 或渐变，见 §5）。

### 3.3 施加作用域（用户指定 `EvIC1a_column`）

用户指定消息列容器 `EvIC1a_column`（DSH CSS module 哈希类）。但**哈希会随 DSH 前端构建变化**——为确保稳健，用**复合选择器**同时覆盖：
- 目标容器：`[class*="flowItem"]` 的父级链 / 或直接 `[class*="EvIC1a_column"]`（用户指定）；
- 更稳：给消息列文字统一 `color: var(--wp-chat-fg)`。

> ⚠ `EvIC1a_` 前缀是构建哈希，DSH 升级可能变化。设计用 `[class*="flowItem"]`（消息气泡，已有稳定选择器）及其文本子元素作为 fallback，`EvIC1a_column` 仅作当前精确目标。

### 3.4 强度/过渡

为避突兀：文字色切换用 CSS `transition: color .3s`（DSH 文字元素本身可能无此 transition，需给目标元素加），或将亮度量化成几个档位（暗/中/亮 → 三档色）避免单点跳变。

---

## 4. 涉及文件

| 文件 | 改动 |
|---|---|
| `src/client/luma.ts`（**新增**） | `measureLuma(url): Promise<number>` —— 加载图→小 canvas→平均亮度；纯函数，node 可测 |
| `src/client/wallpaper-controller.ts` | 切换壁纸后调 `measureLuma(previewUrl)`（或实际元素），把结果写 CSS 变量 `--wp-chat-fg` |
| `src/client/background-layer.ts` | 新增 `setChatFg(color)` 写 body/documentElement CSS 变量；或由 controller 直接写 |
| `src/client/styles.ts` | 给消息列文字加 `color: var(--wp-chat-fg, <主题默认>)`；`EvIC1a_column`/`flowItem` 文本 consumer |
| `src/client/index.ts` | 传递 preview 亮度应用逻辑 |
| `tests/luma.test.ts`（**新增**） | mock canvas/Image，测亮度计算与阈值映射 |
| `tests/styles.test.ts` | 补 `--wp-chat-fg` consumer 断言 |
| `docs/superpowers/specs/` | 本设计文档 |

---

## 5. 对现有测试的影响

1. 新增 `luma.test.ts`：`measureLuma` 亮度计算（mock `Image`+`canvas.getContext`+`getImageData`）；亮度→文字色映射（<128 白 / ≥128 黑）。
2. `styles.test.ts`：补消息列文字 `color: var(--wp-chat-fg)` 断言。
3. `background-layer.test.ts` / `wallpaper-controller.test.ts`：若 controller 写变量，补相关断言。
4. 现有"消息区透明、无玻璃"等断言**不冲突**（本方案不改背景，只在文字上着色）。

---

## 6. 非目标

- **不改**背景层/壁纸可见度/遮罩/玻璃/描边（本方案只动文字颜色）。
- **不做**实时逐帧亮度跟随（只切换壁纸时检测一次，性能友好）。
- 不处理 `web` iframe 无法读像素的 case（回退 preview 图；若无 preview 则用主题默认色）。

---

## 7. 待定项（2026-09-03 定稿）

| # | 项 | 定稿 |
|---|---|---|
| 1 | 亮度数据源 | **preview 图测亮度**（跨类型最稳；scene WebGPU canvas 实测读不到，preview 实测 avgLuma=96 可行） |
| 2 | 亮度阈值 | **阈值 128 分两档**（<128 白字 / ≥128 黑字） |
| 3 | 文字色值 | 暗→`#f9fafb`（白）/ 亮→`#0f1115`（黑），经 `--wp-chat-fg` CSS 变量 |
| 4 | 作用域选择器 | **`[class*="flowItem"]` 子元素**（稳，不怕 DSH 升级哈希） |
| 5 | 过渡动画 | **不加**（简单；切换壁纸时一次性设置颜色） |

> 实现基线：preview 图测亮度 + 阈值 128 分两档 + 暗白/亮黑经 `--wp-chat-fg` + `[class*="flowItem"]` 文本子元素消费 + 不加动画。
