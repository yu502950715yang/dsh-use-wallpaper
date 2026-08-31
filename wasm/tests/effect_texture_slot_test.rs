//! Task-wasm-effect-texture-slots：效果链纹理槽加载真实 mask/normal 纹理。
//!
//! 根因：wasm 效果链 `build_bind_group` 对「提供了独立纹理槽」（`texture_slots[i]` 为 `Some`）
//! 绑定纯白 1×1 占位，从未加载真实遮罩/法线/flow 纹理 → waterwaves/waterflow/shake 的 mask 恒为 1，
//! 对整个对象内容做统一位移 → 头发/裙子/电线/背景位置错乱、拉伸、撕裂。
//!
//! 本测试验证 native 可测部分：
//!  1. `EffectPassDesc` 能从 chainDesc JSON 反序列化 `texture_bytes`（`Vec<Option<Vec<u8>>>`，
//!     与 `texture_slots` 逐槽对齐；缺字段向后兼容为默认空）。
//!  2. 纯决策函数 `texture_slot_has_bytes`：某槽是否提供了真实纹理字节（决定绑真实纹理 vs 白占位）。
//!     （`build_bind_group` 是 render-gated、需 wgpu Device，native 无法构造，故以该纯逻辑做前提验证。）

use we_scene_wasm::render::effect::{self, EffectPassDesc};

/// 反序列化：chainDesc JSON（含 texture_bytes 与 texture_slots 对齐）→ EffectPassDesc。
#[test]
fn effect_pass_desc_deserializes_texture_bytes_aligned_with_slots() {
    // 模拟 JS buildEffectChainDesc 产出的链：1 个 pass，2 个纹理槽。
    // slot0 = null（无独立纹理，previous 语义）；slot1 = "masks/waterwaves_mask_xxx"（独立纹理）。
    // texture_bytes 与 texture_slots 等长：slot0 无字节(null)、slot1 有字节([1,2,3,4])。
    let json = r#"{
        "vert_spv": [0,1,2,3],
        "frag_spv": [4,5,6,7],
        "uniforms": [],
        "texture_slots": [null, "masks/waterwaves_mask_abc"],
        "texture_bytes": [null, [1,2,3,4]],
        "blend_mode": "normal"
    }"#;
    let desc: EffectPassDesc = serde_json::from_str(json).expect("应能反序列化");
    assert_eq!(desc.texture_slots, vec![None, Some("masks/waterwaves_mask_abc".into())]);
    assert_eq!(desc.texture_bytes.len(), 2);
    assert_eq!(desc.texture_bytes[0], None);
    assert_eq!(desc.texture_bytes[1], Some(vec![1, 2, 3, 4]));
    // 槽决策：slot0 无字节 → false；slot1 有字节 → true。
    assert!(!effect::texture_slot_has_bytes(&desc, 0));
    assert!(effect::texture_slot_has_bytes(&desc, 1));
}

/// 向后兼容：无 texture_bytes 字段的旧 chainDesc（演示 pass）反序列化为默认空 Vec，不报错。
#[test]
fn effect_pass_desc_defaults_texture_bytes_when_absent() {
    let json = r#"{
        "vert_spv": [0],
        "frag_spv": [1],
        "texture_slots": [null, "util/white"],
        "blend_mode": "normal"
    }"#;
    let desc: EffectPassDesc = serde_json::from_str(json).expect("缺 texture_bytes 字段应默认空");
    assert_eq!(desc.texture_bytes.len(), 0, "缺字段应默认空 Vec");
    // 槽决策对空 texture_bytes：任何槽都视为无字节 → 白占位。
    assert!(!effect::texture_slot_has_bytes(&desc, 0));
    assert!(!effect::texture_slot_has_bytes(&desc, 1));
}

/// `g_TextureNResolution` smooth 布局（权威对齐 WE WPSceneParser.cpp ResolutionVector：
///   = { width, height, width, height }，.xy/.zw 均为像素尺寸，非 texel 倒数）。
/// - name 的索引 N=0（输入对象内容）→ 用对象 RT 尺寸 `base_w/base_h`；
/// - N≥1（独立 mask/normal/flow 槽）→ 用该槽纹理的真实尺寸 `slot_w/slot_h`；
///   slot 尺寸无效（≤0，即未加载）→ None（保持 block 原值，不填充造成错乱）。
#[test]
fn texture_resolution_for_uses_authoritative_layout_and_per_slot_size() {
    // g_Texture0Resolution：输入（对象 RT），用 base 尺寸，布局 (w,h,w,h)。
    assert_eq!(
        effect::texture_resolution_for("g_Texture0Resolution", 265.0, 768.0, 1280.0, 720.0),
        Some([265.0, 768.0, 265.0, 768.0]),
        "N=0 用对象 RT 尺寸 base_w/base_h，布局 (w,h,w,h)"
    );
    // g_Texture1Resolution：独立 mask 槽，用槽纹理尺寸（如 mask 1280×720），布局 (w,h,w,h)。
    assert_eq!(
        effect::texture_resolution_for("g_Texture1Resolution", 265.0, 768.0, 1280.0, 720.0),
        Some([1280.0, 720.0, 1280.0, 720.0]),
        "N=1 用槽纹理尺寸（mask 1280×720），布局 (w,h,w,h)"
    );
    // g_Texture2Resolution：同 N≥1。
    assert_eq!(
        effect::texture_resolution_for("g_Texture2Resolution", 265.0, 768.0, 64.0, 64.0),
        Some([64.0, 64.0, 64.0, 64.0]),
        "N=2 用槽纹理尺寸"
    );
    // 槽尺寸无效（未加载，≤0）→ None（保持 block 原值，不填充导致采样错乱）。
    assert_eq!(
        effect::texture_resolution_for("g_Texture1Resolution", 265.0, 768.0, 0.0, 0.0),
        None,
        "槽未加载尺寸无效 → None"
    );
    // 非 resolution 名称 → None。
    assert_eq!(
        effect::texture_resolution_for("g_Time", 265.0, 768.0, 1280.0, 720.0),
        None,
        "非 g_TextureNResolution 名称 → None"
    );
}


