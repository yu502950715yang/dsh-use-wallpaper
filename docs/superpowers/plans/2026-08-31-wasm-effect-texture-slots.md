# Wasm 效果链加载真实 mask/normal 纹理（修复 Orange 等壁纸效果错乱）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 wasm 对象级效果链真正加载并绑定每个 `texture_slots[i]` 对应的真实 mask/normal/flow 纹理（而非纯白 1×1 占位），修复 waterwaves/waterflow/shake 等效果因 mask 恒为 1 导致的"头发/裙子/电线/背景位置错乱、拉伸、撕裂"问题。

**Architecture:** JS 侧 `buildEffectChainDesc` 对每个非空 texture slot 拉取 `.tex` 字节（经 `resolveTextureSlotPath` 解析路径，复用 `/wallpapers/scene/<id>/asset` 路由），作为 `number[]`（与现有 `vert_spv` 同机制）放入 chainDesc JSON 的 `texture_bytes` 字段。wasm 侧 `EffectPassDesc` 增加 `texture_bytes: Vec<Option<Vec<u8>>>`（与 `texture_slots` 等长、逐槽对应）；`set_object_effect`（Renderer 方法，持有 `self.upload_texture`）解码字节 → `tex::parse_tex` → `upload_texture` 上传为 wgpu 纹理，收集成 `slot_textures: Vec<Vec<wgpu::Texture>>` 传入 `EffectChain::new`；`build_bind_group` 对真实上传的槽优先绑定真实纹理视图，缺失才回退白色占位。

**Tech Stack:** Rust (wgpu 24 / wasm-bindgen / naga)、TypeScript (esbuild)、Serde JSON、WebGPU。

**Spec:** `docs/superpowers/specs/2026-08-25-wasm-object-effect-chains-design.md`（对象级效果链设计）；根因见本计划 `## 背景根因`。

## Global Constraints

- wasm 构建必须 `--features render`。构建顺序：改 Rust 必须 `pnpm run build:wasm` 再 `pnpm run build:client`（client 复制 wasm/pkg 产物；产物缺失 build:client 直接报错）。
- `--target web`（wasm-pack 默认），JS 侧 `mod.default(wasmUrl)` 初始化。
- 效果链边界：绝不白屏、绝不 panic；pass 级编译失败跳过该 pass；对象级失败回退原始内容；mask 上传失败回退白色占位（不阻塞渲染）。
- mask/normal 纹理均为 `.tex`（TEXV0005 容器）、RGBA8888、TEXB0003 容器（已验证），`parse_tex` + `upload_texture` 可处理（非 BC/压缩，不会走 texture-compression-bc 跳过路径）。
- `resolveTextureSlotPath(path)`（`src/client/effect-runner.ts` 导出）：`util/`、`_rt_` 前缀原样透传（内置/运行时，不是文件）；否则补 `materials/` 前缀 + `.tex` 后缀。
- `texture_bytes` 用 `Vec<u8>` serde 数字数组（与 `vert_spv`/`frag_spv` 完全同机制），**不用 base64、不加新 crate**。
- `EffectPassDesc` 反序列化必须向后兼容：缺 `texture_bytes` 字段的旧 chainDesc（如演示 pass）反序列化为默认空 Vec（`#[serde(default)]`）。

## 背景根因（本次修复针对的 bug）

`wasm/src/render/effect.rs` 的 `build_bind_group` 对"提供了独立纹理槽"（`texture_slots[bi-1]` 为 `Some(_)`，即 mask/normal/flow 纹理）时，统一绑定纯白 1×1 占位 `self.white_view`——wasm 从未加载真实纹理。结果 `waterwaves.frag` 里 `mask = texSample2D(g_Texture1, ...).r` 恒为 1（纯白遮罩 = 全区域位移），`texCoord += sin(...) * offset * strength * mask` 对整个对象内容做统一位移 → 头发/裙子/电线/背景被整体挤出正确位置、拉伸、撕裂。

---
