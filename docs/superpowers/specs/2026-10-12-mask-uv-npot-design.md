# 效果遮罩 UV 被 NPOT padding 比错误缩放（「波动位置不对」）设计

**日期：** 2026-10-12
**状态：** 根因已确认，待实施（方案 A）
**触发：** 用户报告「魔兽之门」湖水应有波动，实际波动出现在湖水上方的树木处；另有其它 scene 壁纸同类现象

## 1. 现象

「魔兽之门」（`1922570576`）的 `waterripple` 效果：遮罩（水域蒙版）本应把波动限制在湖面，实际落点整体上移到湖水上方的树线/山坡。

## 2. 根因

**壁纸自带 shader（`scene.pkg` 内 `shaders/effects/waterripple.vert`）**

```glsl
v_TexCoord.zw = vec2(v_TexCoord.x * g_Texture1Resolution.z / g_Texture1Resolution.x,
                     v_TexCoord.y * g_Texture1Resolution.w / g_Texture1Resolution.y);
```

`g_Texture1` 是遮罩。该式把「对象 UV」映射到遮罩纹理空间，乘数 `z/x`、`w/y` 在 WE 语义里是 **内容尺寸 / 分配尺寸**（≤1：图像只占分配区的一角）。

**本插件的取值（`src/client/tex-loader.ts:478`）**

```ts
ud.fxRes = [mip.width, mip.height, info.textureWidth, info.textureHeight];
```

`.zw` 填的是 **`.tex` 头里的 padding 分配尺寸**，而插件上传的是 **未 padding 的 mip0 图**（`createImageBitmap` 解出的原始尺寸）。魔兽之门遮罩：分配 **4096×2048**、图像 **2500×1200** ⇒ 乘数 **1.6384 / 1.7067**（正确值是 **1**）。

**几何验算（`output/blur-analysis/mask_placement.py`，从 pkg 直接读遮罩图）**

| 遮罩 | 水域在遮罩内的位置 | 现口径落到对象 UV | 比值=1（应为） |
|---|---|---|---|
| `waterripple_mask_c5b9…` | v ∈ [0.784, 0.862] | v ∈ **[0.459, 0.505]** | v ∈ [0.784, 0.862] |
| `waterripple_mask_7413…` | v ∈ [0.828, 0.992] | v ∈ **[0.485, 0.581]** | v ∈ [0.828, 0.992] |

即遮罩被整体向**左上**压缩约 1.64×/1.71×：水域（画面底部 v≈0.78–0.99）被搬到画面中部 v≈0.46–0.58 —— 正是树线一带。叠加图 `output/blur-analysis/mask_placement.png`（红带=现口径落点，绿带=应为落点）与现象完全一致。

**与「隔离对象 RT 分辨率」特性无关：** 该特性从未触碰 `tex-loader`/`effect-runner`/任何 shader；遮罩 UV 只由遮罩自身 `.tex` 头推导；`waterripple.vert` 中唯一依赖 RT 尺寸的项是 `g_Texture0Resolution.x / .y`（RT 宽高比），而 RT 是等比收口，宽高比不变（2.0833 → 2.0834）。该缺陷一直存在；分辨率提升让背景不再糊，才让它显形。

## 3. 全库 shader 审计（`output/blur-analysis/shader_audit.py`）

17/28 张 scene 壁纸自带 shader 文本源，`g_TextureNResolution` 共 **380 处**引用，归一化后 **33 种**不同表达式。按对 `.z/.w` 的**语义需求**分类：

| 类 | 表达式（归一化） | 出现 | 需要哪个量 |
|---|---|---|---|
| **A 遮罩/纹理 UV 缩放** | `v_TexCoord.zw = vec2(uv.x * z/x, …)`；`v_TexCoordMask.zw = vec2(z/x, w/y)`；`v_TexCoord.z *= z/x` | 72+80+32+28+16+14+8+8+8+2 | **比值** = 内容/分配 |
| **B texel 步长（尺寸）** | `0.75 / zw`；`offsetX = g_Scale.x / z`；`v_TexCoord.z = g_Scale.x / z` | 6+8+8+6+6 | **内容尺寸** |
| **C `.xy` 当尺寸** | `1.0 / xy`；`0.5 / xy`；`v_StepSize = 1/vec4(-xy, xy)`；`ApplyCompositeOffset(…, xy)` | 8+4+4+4+1 | **内容尺寸**（当前已对） |
| **D 宽高比** | `x/y`；`z/w`；`y/x` | 14+4 / 14+2 / 2+2 | 图像长宽比（内容） |

**结论：33 种用法中没有任何一处需要「分配尺寸」这个量。** 两类需要 `.z/.w` 的用法（A 的比值、B 的 texel 步长）要的都是**内容尺寸**；当前口径把分配尺寸塞进 `.zw`，于是 A 类错位、B 类步长偏小 1.64×。C 类（`.xy`）已经是内容尺寸，D 类内部还自相矛盾（`x/y` = 内容比 2.083、`z/w` = 分配比 2.0，同一文件两个「宽高比」相差 4%）。

## 4. 影响面（`output/blur-analysis/mask_scope.py`、`tex_padding_scope.py`）

- 全库 175 个 `.tex` 中 **88 个（50%）** `header ≠ image`（NPOT padding），分布 **21 张壁纸**；其中效果遮罩 92 个里 41 个受影响（涉及 5 张：`1429403119` 21、`1922570576` 3、`1968789468` 4、`2011060960` 12、`2132420420` 1）。
- 尺寸为 2 的幂的纹理 `header == image`，比值本就是 1 ⇒ 不受影响（这解释了「只有**有的**壁纸出问题」）。

## 5. 决策：方案 A —— `.zw` 填内容尺寸

```ts
ud.fxRes = [mip.width, mip.height, mip.width, mip.height];
```

理由：
1. 插件**从不 padding 上传**（`createImageBitmap` 解出即上传）⇒ 内容占满整张纹理 ⇒ UV 缩放乘数必须是 1。这与 `.xy`（本来就是内容尺寸）以及 `resolveTextureResolution4` 的**回退口径**（RT / 无 `fxRes` 纹理返回 `{x:w,y:h,z:w,w:h}`，见 `effect-runner.ts:334-336`）完全一致 —— 代码里早已存在「未 padding ⇒ 四分量同值」的先例。
2. 审计（§3）中没有任何用法需要分配尺寸 ⇒ A 不破坏任何现有意图，并顺带修正 B 类（texel 步长偏小 1.64×）与 D 类的内部不一致。
3. 成本：一行；不增加显存。

被否决：
- **B（真按 padding 上传）**：不用改 shader，但每张遮罩按 4096×2048 分配 ≈ +24 MB、超大背景图 +80~130 MB，与刚完成的显存优化直接冲突。
- **C（混合）**：只对「按 padding 语义使用 `.z/.x`」的纹理走 B —— 审计已证明不存在这样的纹理，纯增复杂度。

## 6. 验收

1. **单测（断言）**：`textureFromTex` 对 NPOT `.tex`（图像 2500×1200 / 分配 4096×2048）产出 `fxRes === [2500,1200,2500,1200]`；对 2 的幂纹理保持 `[w,h,w,h]`；不变量 `.z/.x === 1`（⇒ A 类缩放退化为恒等、B 类步长按内容尺寸）。
2. **反向验证**：临时恢复旧口径（`.zw = header`）⇒ 上述断言必红（证明判据有牙）。
3. **e2e 真机口径**：harness 探针读 `__player.objectEffectStage` 内各 pass 材质的 `g_Texture1Resolution`/`g_Texture1`（TS `private` 运行期可读，与既有 `__isoInfo` 同法），对 `1922570576` 断言遮罩槽 `z/x === 1`；靠 `verify-isolated-rt-sharpness.mjs --id=1922570576` 复核。
4. **人眼对照**：修复后重跑该脚本采图，波动应落在湖面（可用 `mask_placement.py` 出前后叠加图）。

## 7. 边界与非目标

- **不做真 padding 上传**（方案 B）。若将来要做，`.zw` 必须恢复为分配尺寸，并重新审计 §3 的 A/B 两类用法 —— 届时不能再假设「四分量同值」。
- 不动 shader（shader 来自壁纸包，属 WE 官方实现）。
- 不扩大本轮范围：`.tex` 的 `TEXV0005` padding 元数据接入、其它格式（TEXB0002/4、DXT）的 padding 语义留作后续。
- 与本特性无关但与本次改动同源的隐患已记录：`AGENT.md §5.17` 原注释把 `.z/.x` 描述为「内容/分配」但取值填反，需一并订正为「未 padding 上传 ⇒ `.zw == .xy`」。

## 8. 涉及文件

| 文件 | 改动 |
|---|---|
| `src/client/tex-loader.ts:471-478` | `fxRes` 取值改内容尺寸 + 注释订正 |
| `src/client/effect-runner.ts:315-321` | `resolveTextureResolution4` 口径注释订正（不改逻辑） |
| `tests/tex-loader.test.ts` | NPOT/POT/不变量用例 |
| `tests/effect-runner.test.ts` | 回退口径一致性用例 |
| `e2e/harness/harness-text-clock-entry.mjs` | 新增只读探针 `window.__fxResProbe()`（仅 e2e） |
| `e2e/verify/verify-isolated-rt-sharpness.mjs` | 新增遮罩槽口径判据 |
| `AGENT.md` §5.17 / §7 | 口径订正 + 遗留条目 |
| `docs/fixes/conventions-details.md` | 归档审计数据 |
