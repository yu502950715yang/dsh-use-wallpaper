# 效果遮罩 UV 被 NPOT padding 比错误缩放（「波动位置不对」）设计

**日期：** 2026-10-12
**状态：** **已实现并生效**（2026-10-12；分支 `fix/mask-uv-npot`：`b8df5e2`…`cdbdd56`；`npm test` 55 files / 1115 passed，e2e **8/8**（A2 扩清单后）exit 0，反向验证 exit 1）。✅ **`lib/`、`dist/` 已重建并提交（`d7f6ec3`）**，运行中的插件已切到新行为；真机目视 `1922570576` 魔兽之门（主诉）、`2011060960` Eva 01、`2132420420` 守望先锋-Dva女警 三张均无异常（见 §9 的合并/发布边界）
**触发：** 用户报告「魔兽之门」湖水应有波动，实际波动出现在湖水上方的树木处；另有其它 scene 壁纸同类现象

## 1. 现象

「魔兽之门」（`1922570576`）的 `waterripple` 效果：遮罩（水域蒙版）本应把波动限制在湖面，实际落点整体上移到湖水上方的树线/山坡。

## 2. 根因

**壁纸自带 shader（`scene.pkg` 内 `shaders/effects/waterripple.vert`）**

```glsl
v_TexCoord.zw = vec2(v_TexCoord.x * g_Texture1Resolution.z / g_Texture1Resolution.x,
                     v_TexCoord.y * g_Texture1Resolution.w / g_Texture1Resolution.y);
```

`g_Texture1` 是遮罩。该式把「对象 UV」映射到遮罩纹理空间；乘数 `z/x`、`w/y` 在 **WE（按 padding 上传）语义**里是 **内容宽高 / 分配尺寸**（≤1：图像只占分配区的一角）。而插件上传的是**未 padding 的图**（内容占满整张纹理）⇒ 该乘数必须是 **1**。

**本插件修复前的取值（`src/client/tex-loader.ts:478`；修复后为 `:475`）**

```ts
ud.fxRes = [mip.width, mip.height, info.textureWidth, info.textureHeight];   // 修复前
```

`.zw` 填的是 **`.tex` 头里的 padding 分配尺寸**，而插件上传的是 **未 padding 的 mip0 图**（`createImageBitmap` 解出的原始尺寸）。魔兽之门遮罩：分配 **4096×2048**、图像 **2500×1200** ⇒ 乘数 **1.6384 / 1.7067**（正确值是 **1**）。修复后为 `ud.fxRes = [mip.width, mip.height, mip.width, mip.height]`（`tex-loader.ts:475`），即「**四分量一律同值（= mip0 记录的 w/h）** ⇒ `.z/.x` 恒为 1」。

**几何验算（`output/blur-analysis/mask_placement.py`，从 pkg 直接读遮罩图）**

| 遮罩 | 水域在遮罩内的位置 | 修复前口径落到对象 UV | 修复后（比值=1，应为） |
|---|---|---|---|
| `waterripple_mask_c5b9…` | v ∈ [0.784, 0.862] | v ∈ **[0.459, 0.505]** | v ∈ [0.784, 0.862] |
| `waterripple_mask_7413…` | v ∈ [0.828, 0.992] | v ∈ **[0.485, 0.581]** | v ∈ [0.828, 0.992] |

即遮罩被整体向**左上**压缩约 1.64×/1.71×：水域（画面底部 v≈0.78–0.99）被搬到画面中部 v≈0.46–0.58 —— 正是树线一带。叠加图 `output/blur-analysis/mask_placement.png`（红带 = 修复前口径落点，绿带 = 比值 1 落点）与现象完全一致。

**与「隔离对象 RT 分辨率」特性无关：** 该特性从未触碰 `tex-loader`/`effect-runner`/任何 shader；遮罩 UV 只由遮罩自身 `.tex` 头推导；`waterripple.vert` 中唯一依赖 RT 尺寸的项是 `g_Texture0Resolution.x / .y`（RT 宽高比），而 RT 是等比收口，宽高比不变（2.0833 → 2.0834）。该缺陷一直存在；分辨率提升让背景不再糊，才让它显形。

## 3. 全库 shader 审计（`output/blur-analysis/shader_audit.py`；实现后复核，2026-10-12 复审按大小写不敏感口径重扫）

按**库级口径 `type.lower() == "scene"`**：**21/33 张** scene 壁纸自带 shader 文本源，`g_TextureNResolution` **命中 471 行**，归一化后 **40 种**不同表达式（含本仓库自身 `src/` 的 5 行）。按对 `.z/.w` 的**语义需求**分类（括号内为出现行数；**粗体 = 本轮重扫新增**，四类合计 **471**）：

> **口径订正（定域）**：初稿的 376 行 / 32 种 / 17-of-28 是**只扫 `type == "scene"`（大小写精确匹配）的 28 张**得到的 —— 本机库另有 **5 张 `type == "Scene"`**（`2236329190` / `2911105183` / `2937346640` / `3765967112` / `3780477933`；`AGENT.md` §5.31 早已记过 `type` 实测有 `"Scene"`）被整批漏掉。其中 **4 张带 shader 文本源**，贡献 **95 行**（`2911105183` 47 / `2937346640` 18 / `3765967112` 16 / `3780477933` 14）与 **8 种新表达式**。初稿另记的 380 行 / 33 种含 `src/` 注释里后来被删掉的 4 行引文、1 种表达式，不是 shader 用法。

| 类 | 表达式（归一化） | 出现（库级 / 旧 28 张） | 需要哪个量 |
|---|---|---|---|
| **A 遮罩/纹理 UV 缩放** | `v_TexCoord.zw = vec2(uv.x * z/x, uv.y * w/y)`（86+98）；`a_TexCoord` 版（20+38）；`v_TexCoordMask.zw = vec2(z/x, w/y)`（32）；`v_TexCoordMask.xy = …`（16+12+2）；`v_TexCoord.z *= z/x`（14）；`v_TexCoord.w *= w/y`（14）；**`vec2 t2 = .xy / .zw`（2）** | **334** / 268 | **比值**（现口径恒为 1） |
| **B 尺寸（texel 步长 / 顶点偏移 / 归一化基准）** | `blurredCoords += 0.75 / zw`（6）；`offsetX/offsetY = g_Scale.x/y / z/w`（8+8）；`v_TexCoord.z/w = g_Scale.x/y / z/w`（9+9）；**`x / min(w, z)`（3）**；**`y / min(w, z)`（3）**；**`textureScale = .zw * g_TextureReductionScale`（1）** | **47** / 34 | **真实上传尺寸**（现口径 = mip0 记录的 w/h） |
| **C `.xy` 当尺寸** | `1.0 / xy`（10）；`0.5 / xy`（5）；`v_TexCoord.zw += 0.5 / xy`（5）；`v_StepSize = 1/vec4(-xy, xy)`（4）；`ApplyCompositeOffset(…, xy)`（4）；`v_PointerUV.xy *= 0.5 / xy`（1）；**`#define pixelSize (1.0 / .xy)`（2）** | **31** / 25 | **真实上传尺寸**（`.xy` 历来 = mip0 记录的 w/h） |
| **D 宽高比 + 注释行** | 共 **14** 种表达式 / **59** 行 = **非注释 9 种 / 48 行**（`.x/.y` 4 种 14+4+2+2；`.z/.w` 2 种 14+6；`.y/.x` 1 种 2；`.zw/.xy` 1 种 2；**`.xy / .y` 1 种 2**）+ **注释行 5 种 / 11 行**（`.x/.y` 2 种 2+2；`.z/.w` 1 种 4；`.y/.x` 2 种 2+1）—— **48 + 11 = 59**，逐条清单见 `docs/fixes/conventions-details.md` §5.17 | **59** / 49 | 图像长宽比（同源） |

四类合计 334+47+31+59 = **471**（旧口径 268+34+25+49 = 376）。

**结论（限定表述，勿再写成全称）**：在**已审计的全部 40 种用法**中，需要的是①**比值**（A 类 334 行：遮罩/纹理 UV 缩放；D 类 59 行：宽高比）与②**真实上传尺寸**（B 类 47 行 + C 类 31 行：texel 步长 / 顶点偏移 / 归一化基准）；**未发现**需要「分配尺寸」这个量的用法。其中 **8 种表达式显式把 `.z`/`.w` 当尺寸用**（B 类，如 `0.75/.zw`、`g_Scale.x/.z`、`min(w, z)`、`.zw * g_TextureReductionScale`），其正确值是**实际上传的纹理尺寸**：新口径对 `mip0 记录 == image` 的 **44** 个为**修正**，对 `mip0 记录 == 分配` 的 **51** 个**逐分量不变**、其 `.x/.y` / `.z/.w` 作为 texel 步长仍偏约 1.6×（**既有状态、非本次回归**，见 §7）。**新增的 8 种表达式对本机库当前零行为影响**（逐条上下文见 `docs/fixes/conventions-details.md` §5.17 归档表）：4 种只用 `.xy` / `.y` 或本身是注释行（本次修复只改 `.z/.w`）；另 4 种涉及 `.z/.w` —— `3780477933` 的 `min(w, z)` 两式与 `t2 = .xy / .zw`（该槽位 `g_Texture1` / `g_Texture2` 是材质默认 `util/clouds_256` / `util/white`，且该壁纸不在 23 张 NPOT 清单内）、`2911105183` 的 `skew.vert:25` `textureScale`（在 `#if MODE == 1` 内，而该壁纸 3 个 `skew` pass 全用默认 `MODE=0` ⇒ 不参与编译）。**没有任何一种属「真的需要分配尺寸」**（本机库内不存在按 padding 分配的纹理 —— 编码图像类按原图上传、原始像素载荷类经 `cropToMap` 裁到内容宽高后上传；⚠️ **若将来出现「raw 像素载荷 + sprite 位 + header padding」的纹理，`.z/.x = 1` 对它不再成立**，因为 `cropToMap` 对 `flags & 4` 刻意不裁剪，`src/client/tex-loader.ts:285`）。两条必须如实区分（勿再合写成一句）：

- **A 类**要的是**比值** `.z/.x`，必须为 1 ⇒ 现口径（四分量同值）下退化为恒等 —— 这正是本次修复的目标。
- **B 类**「texel 步长偏小 **1.64×**」**只在本次会变的那一类（44 个）成立**：它们 `mip0 记录 == image` ⇒ `.zw` 由分配尺寸回到 mip0 记录的 w/h = 实际上传尺寸，步长随之正确。**不变的那一类（51 个，原始像素载荷（带 padding））逐分量零改动**，其 `.x/.y` 作为 texel 步长仍偏约 1.6×（`fxRes` ≠ `cropToMap` 后的上传尺寸；**既有状态、非本次回归**，见 §7 的 follow-up）。

C 类（`.xy`）历来是 mip0 记录的 w/h：对 44 类等于上传尺寸、对 51 类仍是分配尺寸（同上的既有偏差）。D 类内部还自相矛盾（`x/y` = 内容比 2.083、`z/w` = 分配比 2.0，同一文件两个「宽高比」相差 4%）；现口径下两者都取 mip0 记录的 w/h。

## 4. 影响面（`output/blur-analysis/mask_scope.py`、`tex_padding_scope.py`、`fxres_npot_miprecord_scan.py`；**库级口径 `type.lower() == "scene"`，本机壁纸库快照 33 张**）

- 全库 **218** 个 `.tex` 中 **95 个（44%）** `header ≠ image`（NPOT padding），分布 **23 张壁纸**。这 95 个必须按「载荷是否 padding」二分（新值与旧值**逐分量相等 iff `mip0 记录 == 分配`**，库级头部扫描无第三类）：
  - **44 个会变** —— **编码图像类（NPOT 集合内无视频样本）**（`mip0 记录 == image`，载荷未 padding；`imageFormat=13` 31 + `=2` 13，含遮罩 15）：旧 `.zw` = 分配尺寸 ⇒ `z/x = 分配/内容 ≠ 1`，本次修复真正改到它们（「魔兽之门」的 3 张 2500×1200 遮罩属此类）。
  - **51 个不变** —— **原始像素载荷（带 padding）**（`mip0 记录 == 分配`；TEXB0003 `imageFormat=-1` 49 + TEXB0002 1 + TEXB0004 1，含遮罩 26）：上传前经 `cropToMap` 裁成 image 尺寸 ⇒ 旧 `z/x` 本就是 1，逐分量相同。⚠️ 这类成因一律写「**原始像素载荷（带 padding）**」，**不要**写成「全部 `imageFormat=-1`」（那 1 个 TEXB0002 的 `imageFormat` 为 None，机制相同）；会变的 44 类**不要**写成「视频类」：**NPOT 集合内无视频样本** —— 库内另有 2 个视频样本（`2911105183` 的 `materials/CP_ads_01/02.tex`，`flags=35`、`alloc == image == 1280×720`、载荷含 `ftyp`），是 POT ⇒ **不在** 44/51 二分内。
  - **口径来源对照**：初稿记的 175 `.tex` / 88 NPOT / 21 张壁纸，是**只扫 `type == "scene"` 的 28 张**（大小写精确匹配漏掉 5 张 `type == "Scene"`）得到的结果；补全审计域后新增的 7 个 NPOT 落在 `2911105183`（6 个，均会变）与 `2236329190`（1 个，不变）。
- 效果遮罩侧不受口径影响：`materials/masks/` 下 `header ≠ image` 的遮罩仍是 **41** 个（涉及 5 张：`1429403119` 21、`1922570576` 3、`1968789468` 4、`2011060960` 12、`2132420420` 1），其中**会变 15 个**（`1922570576` 3 + `2011060960` 11 + `2132420420` 1）、**不变 26 个**（`1429403119` 21 + `1968789468` 4 + `2011060960` 1）—— 用户报告的「魔兽之门」属会变那批。
- 尺寸为 2 的幂的纹理 `header == image`，比值本就是 1 ⇒ 不受影响（这解释了「只有**有的**壁纸出问题」）。

## 5. 决策：方案 A —— `fxRes` 四分量一律同值（= mip0 记录的 w/h）

```ts
ud.fxRes = [mip.width, mip.height, mip.width, mip.height];
```

理由：
1. **本机库内不存在**按 padding 分配的纹理 —— 上传的纹理被内容占满（44 类 = mip0 全图；51 类 = `cropToMap` 裁出的内容宽高）⇒ UV 缩放乘数必须是 1。⚠️ 代码层唯一例外是 `cropToMap` 对 `flags & 4`（sprite）**刻意不裁剪**（`src/client/tex-loader.ts:285`）：**若将来出现「raw 像素载荷 + sprite 位 + header padding」的纹理，`.z/.x = 1` 对它不再成立**（本机库 0 实例）。这与 `.xy`（历来是 mip0 记录的 w/h）以及 `resolveTextureResolution4` 的**回退口径**（RT / 无 `fxRes` 纹理返回 `{x:w,y:h,z:w,w:h}`，见 `effect-runner.ts:330-332`）完全一致 —— 代码里早已存在「四分量同值 ⇒ `.z/.x === 1`」的先例。
2. 审计（§3）的 **40 种用法中没有任何一处需要分配尺寸**（需要的是①比值、②真实上传尺寸）⇒ 不破坏任何现有意图。**只有会变的那一类（44 个）**顺带修正了 B 类（texel 步长偏小 1.64×）与 D 类的内部不一致；51 类逐分量零改动（其 `.x/.y` 仍 ≠ 上传尺寸，见 §7）。
3. 成本：一行；不增加显存。

被否决：
- **B（真按 padding 上传）**：不用改 shader，但每张遮罩按 4096×2048 分配 ≈ +24 MB、超大背景图 +80~130 MB，与刚完成的显存优化直接冲突。
- **C（混合）**：只对「按 padding 语义使用 `.z/.x`」的纹理走 B —— 库级重扫的 40 种用法中**仍未发现**这样的纹理，纯增复杂度。

## 6. 验收（2026-10-12 实测，分支 `fix/mask-uv-npot`：`b8df5e2`…`cdbdd56`）

1. **单测（断言）**：`textureFromTex` 对 NPOT `.tex`（图像 100×50 / 分配 256×128 的 fixture）产出 `fxRes === [100,50,100,50]`；2 的幂纹理保持 `[w,h,w,h]`；不变量 `.z/.x === 1`、`.w/.y === 1`（`tests/tex-loader.test.ts:815-844`，**唯一守卫生产代码的三条断言** —— `tex-loader.ts:475` 一回退即红，尤其 `:824-827`、`:839-842`，不得削弱/删除）。`tests/effect-runner.test.ts:608-628` 是消费者侧契约钉（合成字面量、不调用 `textureFromTex`，第 3 条仅灵敏度自证）。全量 `npm test` = **55 files / 1115 passed**，exit 0。
2. **反向验证**：临时把 `src/client/tex-loader.ts` 回退到修复前提交（`git checkout 7ba4eca -- src/client/tex-loader.ts`；任务已提交 ⇒ `git stash` 是 no-op）⇒ 单测必红（实测 `expected [ 100, 50, 256, 128 ] to deeply equal [ 100, 50, 100, 50 ]`、`expected 2.56 to be 1`），e2e 亦红（见 3）。
3. **e2e 真机口径**：harness 探针（`e2e/harness/harness-text-clock-entry.mjs:228-260`）读 `__player.objectEffectStage` 内各 pass 材质的 `g_TextureNResolution` / `g_TextureN`（TS `private` 运行期可读，与既有 `__isoInfo` 同法）；判据在 `e2e/verify/verify-isolated-rt-sharpness.mjs:798-841`。实测（`--gpu`，串行）：单张 `1922570576` → 探针 **21 槽 `bad=0`**、遮罩 `obj=13 slot=1 tex=[2500,1200] z/x=1.0000`、**exit 0**；全清单 **8 张 → 8/8、exit 0**（判据①覆盖 **357** 槽 = 21+65+8+88+80+58+10+27，零样本判 FAIL；判据②只对 `1922570576` 断言，其它 7 张打印**显式 SKIP**）。⚠️ **清单已扩展（A2，2026-10-12）**：上句的 8 张 / 357 槽是扩清单后的实测值，扩清单前为 5 张 / 262 槽（21+65+8+88+80）；新增的 3 张是本次审计里遮罩受累的 `2011060960`（11 个遮罩变更 + NPOT 背景 3440×1440）、`2132420420`（1 个变更）、`1968789468`（4 个遮罩不变，作对照）。回退版本（`1922570576`）→ **exit 1**，`FAIL 遮罩槽分辨率口径 z/x === 1 ← 3/21 处异常，例：obj=13 slot=1 z/x=1.6384`（= 4096/2500，与该张 3 个 NPOT 遮罩条数、比值吻合）。
   - **A2 新增壁纸的反向验证（同一次实测）**：`git checkout 7ba4eca -- src/client/tex-loader.ts` ⇒ `--id=2011060960` **exit 1**、`FAIL 遮罩槽分辨率口径 z/x === 1 ← 11/58 处异常，例：obj=634 slot=2 z/x=1.1907`（= 2048/1720；11 处与该张审计的「12 个 NPOT 遮罩 = **11 会变** + 1 不变」逐数吻合）；`git checkout HEAD -- src/client/tex-loader.ts` 恢复后同一命令 **exit 0**、`58 槽坏 0`。⇒ 新加入的壁纸判据**有牙**，不是靠素材恰好对齐而假绿。
   - 附：oracle 的 `--selftest`（只跑纯函数，不需要素材/GPU）覆盖 A2 订正的四条语义（`{value:"…"}` 解析 / kind 兜底不隔离 / 精灵表回退屏占位 / 视频两态 mip），16 条断言；把任一条改回旧语义即 exit 1（已实测三条各自变红）。
4. **人眼对照**：`output/blur-analysis/mask_placement.png` 的叠加带（红 = 修复前口径落点 v≈0.46–0.58，绿 = 比值 1 落点 v≈0.78–0.99）与用户现象吻合；真机复看（重建 `lib/`、`dist/` 后）**已确认**：`1922570576` 魔兽之门（湖面波动回位、树线不再波动）、`2011060960` Eva 01、`2132420420` 守望先锋-Dva女警 三张均无异常。

## 7. 边界与非目标

- **follow-up（R4，未做）**：`g_TextureNResolution` 只保证「四分量同值 ⇒ `.z/.x` 为 1」，**不保证取到实际上传尺寸** —— **原始像素载荷类**（`mip0 记录 == 分配`，51 个）上传前经 `cropToMap` 裁到 image 尺寸，故其 `.x/.y` 与真实纹理尺寸仍差约 1.6×，凡把 `.x/.y` / `.z/.w` 当 texel 步长用的用法（§3 的 B/C 类）仍偏小（**既有状态、非本次回归**，其中 `1429403119` 的 `.xy` 例：`x=2048` 而 `texImage=[1280,720]`）。要彻底对齐需让 `fxRes` 等于各分支最终上传尺寸（RGBA/DXT 用 `cropped.width/height`、编码图像用 bitmap、视频用 mip），属**独立行为变更、需单独 A/B 验证**。已记入 `AGENT.md` §7.37。
- **不做真 padding 上传**（方案 B）。若将来要做，`.zw` 必须恢复为分配尺寸，并重新审计 §3 的 A/B 两类用法（届时不能再假设「四分量同值」）。
- 不动 shader（shader 来自壁纸包，属 WE 官方实现）。
- 不扩大本轮范围：`.tex` 的 `TEXV0005` padding 元数据接入、其它格式（TEXB0002/4、DXT）的 padding 语义留作后续。
- 与本特性同源的隐患已随本次一并订正：`AGENT.md §5.17` 原注释把 `.z/.x` 描述为「内容/分配」但取值填反 ⇒ 现统一为「**四分量一律同值（= mip0 记录的 w/h）⇒ `.z/.x` 恒为 1**」（`AGENT.md:130`、`effect-runner.ts:315-317`、`tex-loader.ts:473-474`、`tests/tex-loader.test.ts:815` 四处措辞同口径）。

## 8. 涉及文件

| 文件 | 改动 |
|---|---|
| `src/client/tex-loader.ts:473-475` | `fxRes` 取值改「四分量同值（= mip0 记录的 w/h）」+ 注释订正（`fxRes` 的唯一生产者） |
| `src/client/effect-runner.ts:315-317` | `resolveTextureResolution4` 口径注释订正（逻辑零改动；函数体 `:318-333`，回退 `return { x: w, y: h, z: w, w: h }` 在 `:330-332`） |
| `tests/tex-loader.test.ts:815-844` | NPOT / POT / 不变量三条用例（**唯一守卫生产代码**） |
| `tests/effect-runner.test.ts:608-628` | 回退口径一致性用例（消费者侧契约钉，第 3 条仅灵敏度自证） |
| `e2e/harness/harness-text-clock-entry.mjs:228-260` | 新增只读探针 `window.__fxResProbe()`（紧接 `__isoInfo`，仅 e2e） |
| `e2e/verify/verify-isolated-rt-sharpness.mjs:798-841` | 新增遮罩槽口径两条判据（采样 `:696-701`、原始样本打印 `:724`、写入 metrics `:869`、文件头判据 [8] `:20-22`） |
| `e2e/verify/verify-isolated-rt-sharpness.mjs:82-100` | **A2**：清单 5 张 → 8 张（+ `2011060960` / `2132420420` / `1968789468`）、`--id=` 空值报错退出 1 |
| `e2e/verify/verify-isolated-rt-sharpness.mjs:112-346,348-386` | **A2**：oracle 与 src 同语义（`transformString`/`size2`/`scale3`/`kindOf`/精灵表/视频两态 mip）+ `--selftest` 自检（文件头判据 [9] `:23-26`） |
| `AGENT.md` §5.17 / §7.37 | 口径订正 + follow-up 遗留条目 |
| `docs/fixes/conventions-details.md` §5.17 | 归档审计数据（几何验算 / 表达式分类 / 影响面 / e2e 实测 / 生产守卫口径） |
| `TESTING.md` §2.5 | 判据清单补两条 + 专属素材判据的 SKIP 语义；**A2**：清单 5 张 → 8 张（含逐张加入理由）+ 判据①/②作用域 + `--selftest` |

## 9. 合并 / 发布边界（勿误判「合并即修复」）

- 本分支 `fix/mask-uv-npot` **从 `feat/isolated-object-rt-resolution` 切出**（切出点 = 该特性 HEAD `22e6fb4`）⇒ **合并本分支即同时并入该特性**（该特性 24 个提交 + 本遮罩修复 14 个提交，收尾文档提交另计；总数以 `git rev-list --count master..HEAD` 为准）。两个关注点耦合是 R1 的既定裁决（代价：回滚需分开处理）。
- **合并本身不改变运行时行为**：`lib/`、`dist/` 是提交进仓库的构建产物，合并只改源码与文档。修复生效**必须**执行 Task 5（`npm run build && npm run build:client`）并**真机复看「湖面波动 / 树线不波动」**；⚠️ profile 符号链接到本仓库，重建会经 client-hmr 重挂正在运行的会话 ⇒ 需用户确认时机。
