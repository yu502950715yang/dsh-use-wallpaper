# 效果遮罩 UV 被 NPOT padding 比错误缩放（「波动位置不对」）设计

**日期：** 2026-10-12
**状态：** **已实现**（2026-10-12；分支 `fix/mask-uv-npot`：`b8df5e2`…`cdbdd56`；`npm test` 55 files / 1115 passed，e2e 5/5 exit 0，反向验证 exit 1）
**触发：** 用户报告「魔兽之门」湖水应有波动，实际波动出现在湖水上方的树木处；另有其它 scene 壁纸同类现象

## 1. 现象

「魔兽之门」（`1922570576`）的 `waterripple` 效果：遮罩（水域蒙版）本应把波动限制在湖面，实际落点整体上移到湖水上方的树线/山坡。

## 2. 根因

**壁纸自带 shader（`scene.pkg` 内 `shaders/effects/waterripple.vert`）**

```glsl
v_TexCoord.zw = vec2(v_TexCoord.x * g_Texture1Resolution.z / g_Texture1Resolution.x,
                     v_TexCoord.y * g_Texture1Resolution.w / g_Texture1Resolution.y);
```

`g_Texture1` 是遮罩。该式把「对象 UV」映射到遮罩纹理空间；乘数 `z/x`、`w/y` 在 **WE（按 padding 上传）语义**里是 **内容尺寸 / 分配尺寸**（≤1：图像只占分配区的一角）。而插件上传的是**未 padding 的图**（内容占满整张纹理）⇒ 该乘数必须是 **1**。

**本插件修复前的取值（`src/client/tex-loader.ts:478`；修复后为 `:473`）**

```ts
ud.fxRes = [mip.width, mip.height, info.textureWidth, info.textureHeight];   // 修复前
```

`.zw` 填的是 **`.tex` 头里的 padding 分配尺寸**，而插件上传的是 **未 padding 的 mip0 图**（`createImageBitmap` 解出的原始尺寸）。魔兽之门遮罩：分配 **4096×2048**、图像 **2500×1200** ⇒ 乘数 **1.6384 / 1.7067**（正确值是 **1**）。修复后为 `ud.fxRes = [mip.width, mip.height, mip.width, mip.height]`（`tex-loader.ts:473`），即「**四分量一律同值（= mip0 记录尺寸）** ⇒ `.z/.x` 恒为 1」。

**几何验算（`output/blur-analysis/mask_placement.py`，从 pkg 直接读遮罩图）**

| 遮罩 | 水域在遮罩内的位置 | 修复前口径落到对象 UV | 修复后（比值=1，应为） |
|---|---|---|---|
| `waterripple_mask_c5b9…` | v ∈ [0.784, 0.862] | v ∈ **[0.459, 0.505]** | v ∈ [0.784, 0.862] |
| `waterripple_mask_7413…` | v ∈ [0.828, 0.992] | v ∈ **[0.485, 0.581]** | v ∈ [0.828, 0.992] |

即遮罩被整体向**左上**压缩约 1.64×/1.71×：水域（画面底部 v≈0.78–0.99）被搬到画面中部 v≈0.46–0.58 —— 正是树线一带。叠加图 `output/blur-analysis/mask_placement.png`（红带 = 修复前口径落点，绿带 = 比值 1 落点）与现象完全一致。

**与「隔离对象 RT 分辨率」特性无关：** 该特性从未触碰 `tex-loader`/`effect-runner`/任何 shader；遮罩 UV 只由遮罩自身 `.tex` 头推导；`waterripple.vert` 中唯一依赖 RT 尺寸的项是 `g_Texture0Resolution.x / .y`（RT 宽高比），而 RT 是等比收口，宽高比不变（2.0833 → 2.0834）。该缺陷一直存在；分辨率提升让背景不再糊，才让它显形。

## 3. 全库 shader 审计（`output/blur-analysis/shader_audit.py`，实现后复核）

17/28 张 scene 壁纸自带 shader 文本源，`g_TextureNResolution` **命中 376 行**，归一化后 **32 种**不同表达式（初稿记 380 行 / 33 种：多出的 4 行引文与 1 种表达式来自 `src/` 注释里后来被删掉的行，不是 shader 用法）。按对 `.z/.w` 的**语义需求**分类（括号内为出现行数，四类合计 376）：

| 类 | 表达式（归一化） | 出现 | 需要哪个量 |
|---|---|---|---|
| **A 遮罩/纹理 UV 缩放** | `v_TexCoord.zw = vec2(uv.x * z/x, uv.y * w/y)`（72+80+16+32）；`v_TexCoordMask.zw = vec2(z/x, w/y)`（28）；`v_TexCoordMask.xy = …`（14+8+2）；`v_TexCoord.z *= z/x`（8）；`v_TexCoord.w *= w/y`（8） | **268** | **比值** = 内容/分配（现口径恒为 1） |
| **B texel 步长（当尺寸用）** | `blurredCoords += 0.75 / zw`（6）；`offsetX/offsetY = g_Scale.x/y / z/w`（8+8）；`v_TexCoord.z/w = g_Scale.x/y / z/w`（6+6） | **34** | **尺寸**（现口径 = mip0 记录尺寸） |
| **C `.xy` 当尺寸** | `1.0 / xy`（8）；`0.5 / xy`（4）；`v_TexCoord.zw += 0.5 / xy`（4）；`v_StepSize = 1/vec4(-xy, xy)`（4）；`ApplyCompositeOffset(…, xy)`（4）；`v_PointerUV.xy *= 0.5 / xy`（1） | **25** | **尺寸**（`.xy` 历来 = mip0 记录尺寸） |
| **D 宽高比** | `x/y`（14+4+2+2）；`z/w`（14+4+2）；`y/x` 与 `zw/xy`（2+2+2）；注释行（4+2+1） | **49** | 图像长宽比（内容） |

**结论：32 种用法中没有任何一处需要「分配尺寸」这个量。** 两条必须如实区分（勿再合写成一句）：

- **A 类**要的是**比值** `.z/.x`，必须为 1 ⇒ 现口径（四分量同值）下退化为恒等 —— 这正是本次修复的目标。
- **B 类**「texel 步长偏小 **1.64×**」**只在本次会变的那一类（38 个）成立**：它们 `mip0 记录 == image` ⇒ `.zw` 由分配尺寸回到 mip0 记录尺寸 = 实际上传尺寸，步长随之正确。**不变的那一类（50 个，原始像素载荷（带 padding））逐分量零改动**，其 `.x/.y` 作为 texel 步长仍偏约 1.6×（`fxRes` ≠ `cropToMap` 后的上传尺寸；**既有状态、非本次回归**，见 §7 的 follow-up）。

C 类（`.xy`）历来是 mip0 记录尺寸：对 38 类等于上传尺寸、对 50 类仍是分配尺寸（同上的既有偏差）。D 类内部还自相矛盾（`x/y` = 内容比 2.083、`z/w` = 分配比 2.0，同一文件两个「宽高比」相差 4%）；现口径下两者都取 mip0 记录尺寸。

## 4. 影响面（`output/blur-analysis/mask_scope.py`、`tex_padding_scope.py`、`fxres_npot_miprecord_scan.py`）

- 全库 **175** 个 `.tex` 中 **88 个（50%）** `header ≠ image`（NPOT padding），分布 **21 张壁纸**。这 88 个必须按「载荷是否 padding」二分（新值与旧值**逐分量相等 iff `mip0 记录 == 分配`**，库级头部扫描无第三类）：
  - **38 个会变** —— **编码图像 / 视频类**（`mip0 记录 == image`，载荷未 padding；PNG `imageFormat=13` 27 + JPEG `=2` 11，含遮罩 15）：旧 `.zw` = 分配尺寸 ⇒ `z/x = 分配/内容 ≠ 1`，本次修复真正改到它们（「魔兽之门」的 3 张 2500×1200 遮罩属此类）。
  - **50 个不变** —— **原始像素载荷（带 padding）**（`mip0 记录 == 分配`；TEXB0003 `imageFormat=-1` 48 + TEXB0002 1 + TEXB0004 1，含遮罩 26）：上传前经 `cropToMap` 裁成 image 尺寸 ⇒ 旧 `z/x` 本就是 1，逐分量相同。⚠️ 这类成因一律写「**原始像素载荷（带 padding）**」，**不要**写成「全部 `imageFormat=-1`」（那 1 个 TEXB0002 的 `imageFormat` 为 None，机制相同）。
- 效果遮罩侧：`materials/masks/` 下 `header ≠ image` 的遮罩 **41** 个（涉及 5 张：`1429403119` 21、`1922570576` 3、`1968789468` 4、`2011060960` 12、`2132420420` 1），其中**会变 15 个**（`1922570576` 3 + `2011060960` 11 + `2132420420` 1）、**不变 26 个**（`1429403119` 21 + `1968789468` 4 + `2011060960` 1）—— 用户报告的「魔兽之门」属会变那批。
- 尺寸为 2 的幂的纹理 `header == image`，比值本就是 1 ⇒ 不受影响（这解释了「只有**有的**壁纸出问题」）。

## 5. 决策：方案 A —— `fxRes` 四分量一律同值（= mip0 记录尺寸）

```ts
ud.fxRes = [mip.width, mip.height, mip.width, mip.height];
```

理由：
1. 插件**从不 padding 上传** —— 上传的纹理**内容占满整张**（38 类 = mip0 全图；50 类 = `cropToMap` 裁出的内容）⇒ UV 缩放乘数必须是 1。这与 `.xy`（历来是 mip0 记录尺寸）以及 `resolveTextureResolution4` 的**回退口径**（RT / 无 `fxRes` 纹理返回 `{x:w,y:h,z:w,w:h}`，见 `effect-runner.ts:334-336`）完全一致 —— 代码里早已存在「四分量同值 ⇒ `.z/.x === 1`」的先例。
2. 审计（§3）中没有任何用法需要分配尺寸 ⇒ 不破坏任何现有意图。**只有会变的那一类（38 个）**顺带修正了 B 类（texel 步长偏小 1.64×）与 D 类的内部不一致；50 类逐分量零改动（其 `.x/.y` 仍 ≠ 上传尺寸，见 §7）。
3. 成本：一行；不增加显存。

被否决：
- **B（真按 padding 上传）**：不用改 shader，但每张遮罩按 4096×2048 分配 ≈ +24 MB、超大背景图 +80~130 MB，与刚完成的显存优化直接冲突。
- **C（混合）**：只对「按 padding 语义使用 `.z/.x`」的纹理走 B —— 审计已证明不存在这样的纹理，纯增复杂度。

## 6. 验收（2026-10-12 实测，分支 `fix/mask-uv-npot`：`b8df5e2`…`cdbdd56`）

1. **单测（断言）**：`textureFromTex` 对 NPOT `.tex`（图像 100×50 / 分配 256×128 的 fixture）产出 `fxRes === [100,50,100,50]`；2 的幂纹理保持 `[w,h,w,h]`；不变量 `.z/.x === 1`、`.w/.y === 1`（`tests/tex-loader.test.ts:815-844`，**唯一守卫生产代码的三条断言** —— `tex-loader.ts:473` 一回退即红，尤其 `:824-827`、`:839-842`，不得削弱/删除）。`tests/effect-runner.test.ts:608-628` 是消费者侧契约钉（合成字面量、不调用 `textureFromTex`，第 3 条仅灵敏度自证）。全量 `npm test` = **55 files / 1115 passed**，exit 0。
2. **反向验证**：临时把 `src/client/tex-loader.ts` 回退到修复前提交（`git checkout 7ba4eca -- src/client/tex-loader.ts`；任务已提交 ⇒ `git stash` 是 no-op）⇒ 单测必红（实测 `expected [ 100, 50, 256, 128 ] to deeply equal [ 100, 50, 100, 50 ]`、`expected 2.56 to be 1`），e2e 亦红（见 3）。
3. **e2e 真机口径**：harness 探针（`e2e/harness/harness-text-clock-entry.mjs:228-260`）读 `__player.objectEffectStage` 内各 pass 材质的 `g_TextureNResolution` / `g_TextureN`（TS `private` 运行期可读，与既有 `__isoInfo` 同法）；判据在 `e2e/verify/verify-isolated-rt-sharpness.mjs:698-728`。实测（`--gpu`，串行）：单张 `1922570576` → 探针 **21 槽 `bad=0`**、遮罩 `obj=13 slot=1 tex=[2500,1200] z/x=1.0000`、**exit 0**；全清单 5 张 → **5/5、exit 0**（判据①覆盖 **262** 槽 = 21+65+8+88+80，零样本判 FAIL；判据②只对 `1922570576` 断言，其它 4 张打印**显式 SKIP**）；回退版本 → **exit 1**，`FAIL 遮罩槽分辨率口径 z/x === 1 ← 3/21 处异常，例：obj=13 slot=1 z/x=1.6384`（= 4096/2500，与该张 3 个 NPOT 遮罩条数、比值吻合）。
4. **人眼对照**：`output/blur-analysis/mask_placement.png` 的叠加带（红 = 修复前口径落点 v≈0.46–0.58，绿 = 比值 1 落点 v≈0.78–0.99）与用户现象吻合；真机复看「湖面波动 / 树线不波动」属 Task 5（重建 `lib/`、`dist/` 后）确认项。

## 7. 边界与非目标

- **follow-up（R4，未做）**：`g_TextureNResolution` 只保证「四分量同值 ⇒ `.z/.x` 为 1」，**不保证取到实际上传尺寸** —— **原始像素载荷类**（`mip0 记录 == 分配`，50 个）上传前经 `cropToMap` 裁到 image 尺寸，故其 `.x/.y` 与真实纹理尺寸仍差约 1.6×，凡把 `.x/.y` / `.z/.w` 当 texel 步长用的用法（§3 的 B/C 类）仍偏小（**既有状态、非本次回归**，其中 `1429403119` 的 `.xy` 例：`x=2048` 而 `texImage=[1280,720]`）。要彻底对齐需让 `fxRes` 等于各分支最终上传尺寸（RGBA/DXT 用 `cropped.width/height`、编码图像用 bitmap、视频用 mip），属**独立行为变更、需单独 A/B 验证**。已记入 `AGENT.md` §7.37。
- **不做真 padding 上传**（方案 B）。若将来要做，`.zw` 必须恢复为分配尺寸，并重新审计 §3 的 A/B 两类用法 —— 届时不能再假设「四分量同值」。
- 不动 shader（shader 来自壁纸包，属 WE 官方实现）。
- 不扩大本轮范围：`.tex` 的 `TEXV0005` padding 元数据接入、其它格式（TEXB0002/4、DXT）的 padding 语义留作后续。
- 与本特性同源的隐患已随本次一并订正：`AGENT.md §5.17` 原注释把 `.z/.x` 描述为「内容/分配」但取值填反 ⇒ 现统一为「**四分量一律同值（= mip0 记录尺寸）⇒ `.z/.x` 恒为 1**」（`AGENT.md:130`、`effect-runner.ts:315-317`、`tex-loader.ts:471-472`、`tests/tex-loader.test.ts:815` 四处措辞同口径）。

## 8. 涉及文件

| 文件 | 改动 |
|---|---|
| `src/client/tex-loader.ts:471-473` | `fxRes` 取值改「四分量同值（= mip0 记录尺寸）」+ 注释订正（`fxRes` 的唯一生产者） |
| `src/client/effect-runner.ts:315-317` | `resolveTextureResolution4` 口径注释订正（逻辑零改动；函数体 `:318-334`） |
| `tests/tex-loader.test.ts:815-844` | NPOT / POT / 不变量三条用例（**唯一守卫生产代码**） |
| `tests/effect-runner.test.ts:608-628` | 回退口径一致性用例（消费者侧契约钉，第 3 条仅灵敏度自证） |
| `e2e/harness/harness-text-clock-entry.mjs:228-260` | 新增只读探针 `window.__fxResProbe()`（紧接 `__isoInfo`，仅 e2e） |
| `e2e/verify/verify-isolated-rt-sharpness.mjs:698-728` | 新增遮罩槽口径两条判据（采样 `:599-604`、原始样本打印 `:627`、写入 metrics `:756`、文件头判据 [8] `:20-22`） |
| `AGENT.md` §5.17 / §7.37 | 口径订正 + follow-up 遗留条目 |
| `docs/fixes/conventions-details.md` §5.17 | 归档审计数据（几何验算 / 表达式分类 / 影响面 / e2e 实测 / 生产守卫口径） |
| `TESTING.md` §2.5 | 判据清单补两条 + 专属素材判据的 SKIP 语义 |
