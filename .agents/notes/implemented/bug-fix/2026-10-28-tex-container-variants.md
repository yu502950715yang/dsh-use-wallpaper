# Agent Note: `.tex` 容器布局变体（LUT 的 flags&0x40 与 TEXB0004 逐 mip 扩展）

Status: implemented

## Problem

与 WebWallGL 对照后全库实测发现：引擎自带 `D:\Steam\steamapps\common\wallpaper_engine\assets\materials\lut\*.tex` **28 张在 dsh 下 `parseTex` 全部返回 null**（`bad-container@46`），而 webwallgl 全部解析通过。根因是同一容器格式的两种布局变体，dsh 的解析器都按标准布局硬读：

- `flags & 0x40` 导出器（WE 自带的颜色分级 LUT）：TEXI 头在 `imageWidth` 之前多写一个 = 像素数的 u32（TEXB magic 因此落在 50 而非 46），且**每条 mip 记录前也多一个 u32**。dsh 固定读 `ascii(46,9)` ⇒ 误判为非法容器，整张作废。
- `TEXB0004` 的 `imageCount` 后第二个 u32 是**逐 mip 扩展布局的开关**（不是「是不是 mp4」）：=1 时每条 mip 前有 `param1/param2 + null 结尾 condition JSON + param3`。dsh 直接 `pos += 4` 跳过 ⇒ 把扩展块当 mipCount 读，整张作废。webwallgl 有实测语料（4 张）证明该字段只取 0/1。

影响面：本机壁纸库（47 张 / 40 pkg / 260 张 .tex）当前 0 命中这两类变体；引擎 assets 命中 28 张 LUT（当前 scene 未引用，属潜在失效）。TEXV0004 旧容器本机 0 命中。

## Decision

`src/client/tex-loader.ts` 的 `parseTex`：

- 容器魔数不再固定 @46，改为在 34–64 扫描 `TEXB0001..0004` 定位；`width/height` 由「容器前 12/8 字节」反推（标准落 34/38，变体落 38/42）。
- `TEXB0004`：读 `imageCount` 后第二个 u32，=1 时每条 mip 前跳过 `8B + null 结尾 JSON + 4B`。
- `flags & 0x40`：每条 mip 记录前可能多一个 u32，用**载荷自洽判据**择一（标准记录合法则按标准，标准不合法且偏移 4 字节后合法才跳 4 字节），避免未来出现「带 0x40 但标准布局」的文件被误跳。

测试夹具 `tests/fixtures/make-tex.ts` 增加 `flags40Variant` / `v4MipExtension` 两个选项；`tests/tex-loader.test.ts` 新增 3 个用例（变体解析、扩展解析、扩展=0 回归）。

## Affected repositories

- `dsh-use-wallpaper` 不涉及

## Alternatives considered

**只按 `flags & 0x40` 决定每条 mip 是否跳 4 字节。** 不用它：判据太脆——标准布局文件一旦带该 flag 会被整体读错位；webwallgl 用载荷验证正是为此。

**不做 LUT（当前 scene 不引用）。** 不用它：文件真实存在，解析失败是确定性缺陷；修复成本约 40 行，且与 TEXB0004 扩展同属「按 magic/开关判布局」的同一处逻辑。

**补 TEXV0004 旧容器。** 本次未做：本机 571 张 .tex 全部是 TEXV0005，无样本可验证；待出现真实语料再做。

## Consequences

**收益：** 28 张 LUT 由全失败转为全通过；全库 571 张 .tex（壁纸库 260 + 引擎 assets 310 + 1）修复后 571/571 解析成功（修复前 543/571）。现有标准布局素材零行为变化（回归用例 + 真实库套件验证）。

**代价 / 未覆盖：** `TEXV0004` 旧容器仍不支持（0 命中，记边界）；`imageCount>1` 的多 image .tex 仍只消费首 image（本机 570 张 imageCount 全 = 1，未修）。


