# DSH Wallpaper Engine Scene 播放修复 — 阶段 1（效果链 P0）

- 日期：2026-08-19
- 状态：设计中
- 项目根：`E:\code\dsh-use-wallpaper`
- 关联：`2026-08-19-scene-play-fix-and-theme-design.md`（A1-A5 设计稿，本阶段实施其子集并纳入新根因）、`research/scene-play-research.md`（实测判定表 + 根因清单 + §8 引擎头文件权威对照）、`research/route-comparison.md`（路线 A 决策）
- 范围：阶段 1 = 效果链四项 P0 修复（用户已批准"分阶段、先阶段 1、从 P0-1 开始"）。阶段 2/3（粒子/text/纹理质量）另行设计。

## 1. 背景与目标

实测 24 个 scene 壁纸 0 黑屏、15 动态、9 静态（`research/scene-play-research.md` §2）。效果链是最大短板：
- 效果链纹理槽 **404**（每壁纸 2~60 条，全因路径缺 `materials/` 前缀）→ mask/normal 纹理全失效，效果视觉大减；
- 内置/运行时纹理槽（`util/*`、`_rt_*`）无回退 → 加载失败即空；
- 效果 shader 大量编译失败（单壁纸最多 2688 条警告）→ we-headers 缺函数 + `M_PI_2` 常量值错误（§8 权威对照）；
- 7 个壁纸各 1-2 条效果链"解析失败" → 已查明为 fetch 偶发 `TypeError: Failed to fetch`（连接复用竞态），非文件/逻辑问题。

目标：上述四项全部修复，效果链从"大量失败 + 视觉退化"变为"全链加载、mask/normal 生效、编译失败归零（或降至引擎兼容边界）"。

## 2. 设计 P0-1：效果链纹理槽路径推导

**根因**：`effect-runner.ts resolveTextureSlot`（L168）直接用 scene.json pass.textures 原始字符串 fetch；真实路径需推导。实测：`masks/waterwaves_mask_x` 404，而 `materials/masks/waterwaves_mask_x.tex` 200。

**方案**：新增纯函数 `resolveTextureSlotPath(path: string): string | null`（导出供单测）：
```ts
function resolveTextureSlotPath(path: string): string | null {
  if (!path) return null;
  if (path.startsWith('util/')) return path;    // 内置：交给 P0-2 生成分支
  if (path.startsWith('_rt_')) return path;     // 运行时 RT：交给 P0-2 回退分支
  if (path.endsWith('.tex')) return path.startsWith('materials/') ? path : 'materials/' + path;
  return 'materials/' + path + '.tex';
}
```
`resolveTextureSlot` 改用推导后路径 fetch；`util/` 与 `_rt_` 前缀走 P0-2。

**测试**：`effect-runner.test.ts` 补 4 形态断言（`masks/x`→`materials/masks/x.tex`、`effects/waterripplenormal`→`materials/effects/waterripplenormal.tex`、已完整路径不变、`util/white`/`_rt_*` 原样透传）。

## 3. 设计 P0-2：内置/运行时纹理槽回退

**根因**：`util/white`、`util/noise`、`util/clouds_256` 是引擎内置程序纹理（pkg 无文件）；`_rt_imageLayerComposite_*`、`_rt_FullFrameBuffer` 是运行时 RT 引用。当前加载失败 → 纹理槽空 → 效果退化。

**方案**：`resolveTextureSlot` 增加分支（返回 `THREE.Texture`，绝不返回 null 也不警告）：
1. `util/white` → 1×1 白色 `DataTexture`（缓存复用）；
2. `util/noise`、`util/clouds_256` → 256×256 灰阶噪声 `DataTexture`（`mulberry32` 固定种子确定性生成；clouds_256 一期用同款噪声近似，真实 Perlin 云纹理后续精化）；
3. `_rt_*` → 回退 1×1 白色（避免黑屏；真实语义是分层 RT 引用，属 A6 合成层范畴，一期近似）；
4. 其余路径经 P0-1 推导后 fetch，404 → 记一次 warn 后返回 null（保留现状行为，避免掩盖真问题）。

内置纹理缓存于 `textures` Map（key 加 `builtin:` 前缀，切壁纸清空语义不变）。

**测试**：`effect-runner.test.ts` 补 `util/white`/`util/noise`/`_rt_*` 返回非 null 纹理断言（mock fetch 不调用）。

## 4. 设计 P0-3：we-headers 按引擎真实实现补全

**依据**：本机 WE 客户端 `D:\Steam\steamapps\common\wallpaper_engine\assets\shaders\`（权威源码，`research/scene-play-research.md` §8 全文摘录）。

**方案**（`src/client/shader/we-headers.ts`）：
1. **`common.h`**：按真实实现重写（`M_PI`、`M_PI_HALF`、**`M_PI_2 = 6.28318530718`**（修正，原 1.5707 错误）、`SQRT_2/SQRT_3`、`hsv2rgb/rgb2hsv/rotateVec2/greyscale`）；**保留** `frac/saturate/texSample2D/texSample2DLod/mul/CAST2/3/4/DecompressNormal`（GLSL3 语义等价物，引擎靠 HLSL 翻译器内置；`DecompressNormal` 移至真实定义见 4）。
2. **`common_composite.h`**：按真实 50 行完整转写——`g_CompositeAlpha/g_CompositeOffset/g_CompositeColor` 三个 uniform + `ApplyCompositeOffset`（COMPOSITE!=0 时偏移）+ `ApplyComposite`（COMPOSITEMONO→greyscale、×g_CompositeColor、COMPOSITE 0=原样/1=ApplyBlending+alpha/2=mix under/3=cutout）。**依赖** `greyscale`（common.h）与 `ApplyBlending`（common_blending.h），展开顺序已由 preprocess 处理。
3. **`common_blending.h`**：按真实 271 行转写——`Desaturate/RGBToHSL/HSLToRGB/HueToRGB/ContrastSaturationBrightness`、全部 `Blend*` 宏（BlendLinearDodge/BlendOpacity 等 30+）、`ApplyBlending` 改为 **BLENDMODE 宏驱动的 31 分支**（`#if BLENDMODE == N`；preprocess 的 `#if` 裸标识符兜底会注入 `#define BLENDMODE 0`，combos 优先覆盖，安全）。
4. **`common_blur.h`**：按真实权重/偏移重写 `blur13a/blur7a/blur3a`（13-tap 0.1976/0.2960/0.0935/0.0117；blur7a 不对称 4-tap 2.3516/0.4694/1.4092/3）+ 补 `blur13/blur7/blur3`（rgb 版）与 `blurRadial13a/7a/3a`（供未来）。
5. **`common_perspective.h`**：按真实 65 行转写 `squareToQuad`（列主序 + p2/p3 交换 + det==0/sum==0 分支）；`inverse(mat3)` 保持不定义（GLSL3 内置，实测冲突）。
6. **`common_fragment.h`/`common_vertex.h`**：按真实转写（FORMAT_* 宏、`DecompressNormal`（DXT swizzle/RG88/wy 通道版）、`DecompressNormalWithMask`、`ComputeLight*`、`ConvertTexture*`、`BuildTangentSpace` 三重载）——当前全库无调用，但按真实补齐避免占位。

**测试**：`shader-headers.test.ts` 补断言：`M_PI_2` 含 `6.28318530718`；`ApplyComposite/ApplyCompositeOffset/greyscale/BlendOpacity/BlendLinearDodge` 存在；`blur13a` 含真实权重 `0.1976406528809576`；`squareToQuad` 含 `diffy2`（真实实现特征）；`DecompressNormal` 含 `FORMAT_RG88` 分支。

## 5. 设计 P0-4：fetch 偶发失败重试

**根因**：`research/verify-fetch-reject.mjs` 实测 2911105183 阶段 1 次 `fetch → TypeError: Failed to fetch`（6ms 立即失败，非超时）——高并发（200+ 请求/壁纸）下 HTTP keep-alive 连接复用竞态。7 个壁纸的"效果链解析失败"由此而来（内存版 100/100 成功、浏览器静态 fetch 100% 成功）。

**方案**：新建共享工具 `fetchWithRetry(url: string, retries = 2): Promise<Uint8Array | null>`（放 `src/client/fetch-util.ts`）：
```ts
export async function fetchWithRetry(url: string, retries = 2): Promise<Uint8Array | null> {
  for (let i = 0; ; i++) {
    try {
      const resp = await fetch(url);
      return resp.ok ? new Uint8Array(await resp.arrayBuffer()) : null; // 4xx/5xx 确定性失败不重试
    } catch {
      if (i >= retries) return null;
      await new Promise((r) => setTimeout(r, 50 * (i + 1))); // 指数退避
    }
  }
}
```
替换调用点：
- `scene-renderer.ts` renderScene 的 `loadFile`（效果链解析，L277-280）→ 改用 `fetchWithRetry`；
- `effect-runner.ts resolveTextureSlot`（L168）→ 改用 `fetchWithRetry`（404 不重试，`Failed to fetch` 重试 2 次）。

**测试**：`fetch-util.test.ts`（mock 全局 fetch）：reject 1 次后成功 → 返回数据；reject 3 次 → null；404 → 不重试直接 null。

## 6. 测试与验证

1. **单测**：`vitest run`（node + jsdom 双环境全量）+ `tsc --noEmit` + `npm run build` + `node scripts/build-client.mjs`。
2. **安装**：重建 bundle 并装入 `C:\Users\0009\.dsh\profiles\web`，重启 DSH web。
3. **浏览器实测**：headless Edge + CDP（复用 `research/verify-blackout.mjs`）全库 24 壁纸：
   - 目标 A：纹理槽失败归零（P0-1/P0-2 后 404 应全消失）；
   - 目标 B：编译失败显著下降（P0-3 后 vhs/clouds/blur_combine 应编译成功；观察剩余编译失败的 shader 明细）；
   - 目标 C："效果链解析失败"警告归零（P0-4）；
   - 目标 D：STATIC 壁纸减少（效果链生效后 2132420420/2454403969/2597392171/3765967112 应转 OK）；
   - 回归：OK 壁纸不得变差（diff 不显著下降）。

## 7. 非目标（本阶段不做）

- 粒子升级（A2）、text 对象（A5）、失败可视化（A1）→ 阶段 2；
- RG88/R8、DXT 翻转、大纹理降采样（A3）→ 阶段 3；
- A6 合成层（`_rt_*` 真实语义）、音频可视化、util 程序纹理精化（Perlin 云）。

## 8. 涉及文件清单

| 文件 | 改动 |
|---|---|
| `src/client/effect-runner.ts` | P0-1 路径推导 + P0-2 内置回退 + P0-4 fetch 重试 |
| `src/client/fetch-util.ts`（新建） | P0-4 `fetchWithRetry` |
| `src/client/scene-renderer.ts` | P0-4 loadFile 改用重试 |
| `src/client/shader/we-headers.ts` | P0-3 按真实头转写 |
| `tests/effect-runner.test.ts` | P0-1/P0-2 断言 |
| `tests/fetch-util.test.ts`（新建） | P0-4 断言 |
| `tests/shader-headers.test.ts` | P0-3 断言 |
| 临时研究测试 `tests/research-repro.test.ts` | 删除（根因已确认） |
