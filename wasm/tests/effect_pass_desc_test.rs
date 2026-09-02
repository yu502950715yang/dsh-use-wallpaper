//! 阶段1（wasm RT 图执行器）：EffectPassDesc 反序列化新增 target/fbo_scale/bind 字段。
//! native 可测（无 render feature）：证明 JS chain_desc JSON 能正确携带 RT 图信息。

use we_scene_wasm::render::effect::EffectPassDesc;

#[test]
fn deserializes_target_fbo_scale_bind() {
    // 模拟 JS buildEffectChainDesc 产出的 chain_desc 单 pass（blur_downsample4）：
    // target=_rt_QuarterCompoBuffer1、fbo_scale 含降采样 4、bind 引用 previous。
    let json = r#"{
        "vert_spv": [1,2,3],
        "frag_spv": [4,5,6],
        "uniforms": [],
        "texture_slots": [null],
        "texture_bytes": [null],
        "blend_mode": "normal",
        "target": "_rt_QuarterCompoBuffer1",
        "bind": [{"name": "previous", "index": 0}],
        "fbo_scale": {"_rt_QuarterCompoBuffer1": 4.0, "_rt_QuarterCompoBuffer2": 4.0}
    }"#;
    let desc: EffectPassDesc = serde_json::from_str(json).expect("应反序列化");
    assert_eq!(desc.target.as_deref(), Some("_rt_QuarterCompoBuffer1"));
    assert_eq!(desc.bind.len(), 1);
    assert_eq!(desc.bind[0].name, "previous");
    assert_eq!(desc.bind[0].index, 0);
    assert_eq!(desc.fbo_scale.get("_rt_QuarterCompoBuffer1"), Some(&4.0));
}

#[test]
fn deserializes_target_null_and_empty_bind() {
    // 无 target/bind/fbo_scale（简单单 pass 效果，如 waterripple）→ 缺省空串/空 vec/空 map。
    let json = r#"{
        "vert_spv": [1], "frag_spv": [2],
        "uniforms": [], "texture_slots": [null], "texture_bytes": [null],
        "blend_mode": "add"
    }"#;
    let desc: EffectPassDesc = serde_json::from_str(json).expect("应反序列化");
    // 无 target 字段 → serde default → None（= 最终输出对象 out RT）
    assert!(desc.target.is_none());
    assert!(desc.bind.is_empty());
    assert!(desc.fbo_scale.is_empty());
    assert_eq!(desc.blend_mode, "add");
}

#[test]
fn deserializes_full_chain_pass_order() {
    // blur 链 4 pass 的 target 序列（模拟 resolveEffectChain 产物）：验证逐 pass 顺序与 target。
    let json = r#"[
        {"vert_spv":[1],"frag_spv":[2],"target":"_rt_QuarterCompoBuffer1","bind":[{"name":"previous","index":0}],"fbo_scale":{"_rt_QuarterCompoBuffer1":4}},
        {"vert_spv":[3],"frag_spv":[4],"target":"_rt_QuarterCompoBuffer2","bind":[{"name":"_rt_QuarterCompoBuffer1","index":0}],"fbo_scale":{"_rt_QuarterCompoBuffer1":4}},
        {"vert_spv":[5],"frag_spv":[6],"target":"_rt_QuarterCompoBuffer1","bind":[{"name":"_rt_QuarterCompoBuffer2","index":0}],"fbo_scale":{"_rt_QuarterCompoBuffer2":4}},
        {"vert_spv":[7],"frag_spv":[8],"bind":[{"name":"_rt_QuarterCompoBuffer1","index":0},{"name":"previous","index":2}],"fbo_scale":{}}
    ]"#;
    let passes: Vec<EffectPassDesc> = serde_json::from_str(json).expect("应反序列化");
    assert_eq!(passes.len(), 4);
    assert_eq!(passes[0].target.as_deref(), Some("_rt_QuarterCompoBuffer1"));
    assert_eq!(passes[1].target.as_deref(), Some("_rt_QuarterCompoBuffer2"));
    assert_eq!(passes[2].target.as_deref(), Some("_rt_QuarterCompoBuffer1"));
    // 末 pass 无 target → serde default → None（= 最终输出对象 out RT）
    assert!(passes[3].target.is_none());
    // 末 pass combine 同时引用模糊结果与 previous（index 2）
    assert_eq!(passes[3].bind.len(), 2);
    assert_eq!(passes[3].bind[1].name, "previous");
    assert_eq!(passes[3].bind[1].index, 2);
}
