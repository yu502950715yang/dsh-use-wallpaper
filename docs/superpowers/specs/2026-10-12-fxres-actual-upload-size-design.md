# `g_TextureNResolution` 改为「各分支实际上传尺寸」设计

**日期：** 2026-10-12
**状态：** 已实现（分支 `fix/fxres-actual-upload-size`：`51a3b4f`（实现）、`687b038`（e2e 判据））
**事实依据：** `.superpowers/sdd/2026-10-12-plugin-hygiene/a1-research.md`（11 条分支的逐条实测）

## 1. 问题

`g_TextureNResolution` 的 vec4 在改动前四分量一律等于 **mip0 记录的 w/h**（`tex-loader.ts` 的 `withSprite` 写入 `ud.fxRes`）。这对遮罩 UV 缩放是必需且正确的（`.z/.x === 1`），但它**不总是「实际上传尺寸」**：

| 分支 | 实际上传尺寸 | 现口径（mip0 记录） | 差异 |
|---|---|---|---|
| 编码图像（ImageBitmap） | 解码 bitmap 尺寸 | == 解码尺寸 | 无（本机库 44/44） |
| raw 早返回（sprite / 无 padding） | `cropToMap` 的 `(mipW,mipH)` | 同 | 无 |
| **raw + 行裁剪**（51 例主体） | `cropRowsToMap` 的 `(cw,ch) = floor(min(image,mip))` | `(mipW,mipH)` | **偏 分配/内容 ≈ 1.6×** |
| **DXT + 块裁剪** | `(ceil4(cw), ceil4(ch))` | `(mipW,mipH)` | 块对齐差（本机库 0 实例） |
| 视频就绪 | `video.videoWidth/Height` | 同（alloc==image==mip0） | 无 |
| 视频失败 1×1 | 无 `fxRes` ⇒ 回退 `(1,1,1,1)` | — | 无 |

## 2. 为什么这不是可观测缺陷（承重事实）

审计出的「把 `.x/.y` / `.z/.w` 当尺寸/texel 步长」的用法（B/C/D 类）**逐条都落在 `g_Texture0`**，而 `effect-runner.ts:780-783` 每帧把 slot 0 无条件绑成 **pass 输入 RT**（RT 无 `fxRes` ⇒ 回退为 RT 自身尺寸 = 其实际上传尺寸）⇒ **本项目前数值影响为 0**，唯一 slot≥1 的尺寸用法（`3780477933` 的 `min(.w,.z)`）落在 POT 的 `util/clouds_256` 上、比值本就为 1。

因此本设计的价值是**语义正确性 + 对未来素材的健壮性**（padded raw、DXT `ceil4`、任何在非零槽上把 `.zw` 当尺寸的新 shader），而非观感修复。**预期观感零变化**。

## 3. 设计

`withSprite()` 增参：`withSprite(tex, w, h)` —— 由**各分支自己**给出「即将上传的宽高」，写入 `ud.fxRes = [w, h, w, h]`（**必须四分量同值**，否则 `.z/.x` 不再是 1，遮罩会再次错位；每个分支只报一个 `(w,h)` 对即自动满足）。

4 个调用点都已知最终尺寸（研究已核实）：

| 调用点 | `(w,h)` 取值 |
|---|---|
| `tex-loader.ts:513`（视频） | `video.videoWidth/videoHeight` |
| `:544`（编码图像） | 解码 bitmap 的 `width/height` |
| `:567`（raw） | `cropRowsToMap(...)` 的 `{width,height}` |
| `:619`（DXT） | `cropCompressedToMap(...)` 的 `{width,height}` |

**不做**：真 padding 上传；`g_Texture0` 的 RT 回退口径；粒子世界尺寸建模。

## 4. 验收

1. **单测逐分支**（现有 3 条 fixture 恰好 A1 前后同值，覆盖不到 51 类，必须补）：
   - padded-raw：alloc 256×128 / image 100×50 / mip 256×128 ⇒ `fxRes === [100,50,100,50]`；
   - DXT 块对齐：60×30 ⇒ `fxRes === [60,32,60,32]`（`ceil4`）；
   - 视频：`mip0 ≠ 视频尺寸` 时以视频尺寸为准；
   - 既有 3 条（`[100,50,100,50]`、2 的幂、`.z/.x === 1`）**不得削弱**。
2. **不变量**：所有分支 `fxRes` 四分量仍彼此相等 ⇒ 判据① `z/x === 1` 在 e2e 8 张 / 357 槽保持全绿。
3. **e2e 观察量收口并升级为判据**：`verify-isolated-rt-sharpness.mjs` 现有非判定观察量「`x/texImage[0] ≠ 1`」在 8 张清单上应为 **0**（A1 前 `1429403119` 是 21/56）⇒ 改为**判定项**（不可比的行——未绑纹理 `texImage: null`——按既有规则排除）。
4. **回归**：`npm test` 全绿；`--selftest` 16/16；`verify-text-clock-layer --id=1922570576 --gpu` 11 项 PASS。
5. **目视**（预期无差异）：魔兽之门、GTR（DXT）、In the Mountains（sprite）。
6. 发布：`npm run build` + `build:client`（需用户确认时机；本改动无观感变化，不急于上线）。

**实测（实现后，2026-10-12）**：

- `npm test`：**55 files / 1117 passed**（Task 1/2 收尾基线；Task 3 补 1 条 dom 用例后 **1118**）。
- `node e2e/verify/verify-isolated-rt-sharpness.mjs --gpu`（8 张清单）：**8/8、0 FAIL、exit 0**；判据 [8]① 全槽 `|z/x − 1| < 1e-6` 全绿；判据 [8]② **234 个可比槽偏离 0**（357 槽中 **123 槽无 `texImage`** 不可比）。
- **反向验证**（把 `src/client/tex-loader.ts` 回退到 A1 前）：`1429403119` 的 [8]② **21/56 → 0**、**exit 1 → 0**；恢复后 `git diff --stat` 为空。
- 单测逐分支：padded-raw `[100,50,100,50]`；DXT 块对齐 **60×30 → 60×32**（仅 fixture，本机库 0 实例）；视频以 `videoWidth/Height` 为准；视频内在尺寸 0 ⇒ 回退 mip0 记录。

## 5. 边界与文档订正

- `AGENT.md §5.17` 已订正为「不变量**恒成立**」：真实残留是 `fxRes` **无法表达「内容域偏移」**（WE 的 `(内容宽,内容高,打包宽,打包高)`，`mesh-shaders.ts:26-32`）—— `cropToMap` 对 sprite 位（`flags & 4`）刻意不裁**不构成反例**（每分支只报一个 `(w,h)` 对）。
- `AGENT.md §7.37`（原 follow-up）应改写为「已实现：`fxRes` = 各分支实际上传尺寸；**当前库内数值影响为 0**（B/C/D 类用法全在 slot 0 的 RT 回退）；DXT 块对齐（`ceil4`）是唯一代码层第三类，本机库 0 实例」。
- `docs/fixes/conventions-details.md §5.17` 与设计文档同步。
- 视频 1×1 兜底「故意不带 `fxRes`」加一行注释。

## 6. 涉及文件

| 文件 | 改动 |
|---|---|
| `src/client/tex-loader.ts` | `withSprite` 增参 + 4 个调用点 + 注释 |
| `src/client/effect-runner.ts` | `resolveTextureResolution4` 口径注释（逻辑不动） |
| `tests/tex-loader.test.ts` | 补 padded-raw / DXT / 视频 3 条 |
| `e2e/verify/verify-isolated-rt-sharpness.mjs` | 观察量 → 判定项（含不可比行排除规则） |
| `AGENT.md`、`docs/fixes/conventions-details.md`、本设计与 RT 设计文档 | 口径与事实订正 |
