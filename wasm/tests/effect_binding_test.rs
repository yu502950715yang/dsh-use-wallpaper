//! Task16：bind group binding 索引重复修复的 native 验证。
//!
//! 根因：`spirv-webgpu-transform` 拆组合采样器会把一个 `sampler2D` 扩展为 2 个 binding 槽
//! （texture + sampler）并**重排/重编号** binding。故：
//!  - JS 侧 `UniformBindingDesc.binding`（拆前编号，如某 std140 block 在 binding=2）与 WGSL 真实
//!    binding（拆后，如 4）**不一致** → 若 wasm 直接用 JS 的 binding 建 uniform buffer，其 binding
//!    与 WGSL 的 texture/sampler binding 撞号 → `create_bind_group` 报
//!    `binding index (M) was specified by a previous entry`。
//!  - 跨 stage（vert 从 frag.nextBinding 继续编号）也因 transform 扩展而错位 → `collect_bindings`
//!    出现同 binding 不同 kind → `create_bind_group_layout` 报同样错误。
//!
//! 本测试验证 wasm 侧修复：`wgsl_uniform_members` 按成员名还原 transform 后的**真实** uniform
//! binding；`wgsl_bindings` 在「多 sampler + 非不透明 std140 block 混合」下 binding 唯一。
//! （`build_uniform_instances`/`build_bind_group` 为 render 门控、需 wgpu Device，native 无法构造
//! 等价物，故以 member→binding 映射逻辑在 native 做前提验证。）

use we_scene_wasm::render::effect;

/// 混合 frag（2 个 sampler2D + 1 个非不透明 std140 block）：JS 拆前编号 block=2，transform 后 binding=4。
/// 验证 `wgsl_uniform_members` 能把 block 还原到真实 binding=4（非 JS 的 2）→ 避免与 texture binding=2 撞号。
#[test]
fn mixed_frag_uniform_members_resolve_real_binding() {
    let raw = include_bytes!("fixtures/mixed_2sampler_block.spv");
    let wgsl = effect::spv_to_wgsl(raw, effect::Stage::Fragment).expect("应编译出合法 WGSL");
    let bindings = effect::wgsl_bindings(&wgsl).expect("WGSL 应解析");
    let members = effect::wgsl_uniform_members(&wgsl).expect("WGSL 应解析");

    // 结构化 bindings 唯一（无重复 binding 索引）——「多 sampler + std140 block 混合」单 stage 应唯一。
    println!("[mixed_frag] bindings={bindings:?}\nmembers={members:?}");
    let mut seen = std::collections::HashSet::new();
    for (b, _) in &bindings {
        assert!(seen.insert(*b), "binding {b} 重复（bindings={bindings:?}）");
    }
    assert_eq!(
        bindings,
        vec![
            (0, effect::BindKind::Texture),
            (1, effect::BindKind::Sampler),
            (2, effect::BindKind::Texture),
            (3, effect::BindKind::Sampler),
            (4, effect::BindKind::Uniform),
        ],
        "mixed frag 结构化 bindings 应为 4 槽（2 纹理+2 sampler）+ 1 uniform block"
    );

    // WGSL 里该 uniform block 的**真实** binding = 4（transform 重排后），成员名 g_Alpha/color。
    assert_eq!(members, vec![(4, vec!["g_Alpha".to_string(), "color".to_string()])],
        "wgsl_uniform_members 应把 std140 block 还原到真实 binding=4（非 JS 拆分前的 2）");
}

/// 模拟 `build_uniform_instances` 的成员名→真实 binding 映射：JS 拆前提供 block 成员 binding=2，
/// 用 `uniform_members`（来自 WGSL）按成员名解析，应得真实 binding=4（而非 2）。
#[test]
fn uniform_member_match_maps_js_binding_to_wgsl_binding() {
    // JS 侧（拆前）descr.uniforms：g_Alpha/color 同属 block，binding=2（transform 前的旧编号）。
    let js_uniforms: Vec<effect::UniformBinding> = vec![
        effect::UniformBinding {
            name: "g_Alpha".into(),
            value: vec![0.5],
            offset: 0,
            size: 4,
            ty: "float".into(),
            binding: 2,
        },
        effect::UniformBinding {
            name: "color".into(),
            value: vec![1.0, 0.0, 0.0, 1.0],
            offset: 16,
            size: 16,
            ty: "vec4".into(),
            binding: 2,
        },
    ];
    // WGSL（transform 后）收集到的 uniform block 成员名 → 真实 binding=4。
    let uniform_members: Vec<(u32, Vec<String>)> = vec![(4, vec!["g_Alpha".into(), "color".into()])];

    // 成员名 → 真实 binding 表（同 build_uniform_instances 逻辑）。
    let mut member_to_binding: std::collections::HashMap<&str, u32> = std::collections::HashMap::new();
    for (b, names) in &uniform_members {
        for n in names {
            member_to_binding.entry(n.as_str()).or_insert(*b);
        }
    }
    // 对每个 JS block（按 JS binding 分组，成员名保持）解析真实 binding。
    let mut resolved: Vec<u32> = Vec::new();
    let mut i = 0;
    let mut entries: Vec<(u32, &effect::UniformBinding)> =
        js_uniforms.iter().map(|u| (u.binding, u)).collect();
    entries.sort_by_key(|(b, _)| *b);
    while i < entries.len() {
        let js_binding = entries[i].0;
        let mut group: Vec<&effect::UniformBinding> = Vec::new();
        while i < entries.len() && entries[i].0 == js_binding {
            group.push(entries[i].1);
            i += 1;
        }
        let wgsl_binding = group.iter().find_map(|u| member_to_binding.get(u.name.as_str()).copied())
            .unwrap_or(js_binding);
        resolved.push(wgsl_binding);
    }
    assert_eq!(resolved, vec![4],
        "按成员名应把 JS block（binding=2）解析为真实 binding=4，避免与 texture binding=2 撞号");
}

/// 跨 stage（vert+frag）：task-16 JS 修复后 vert 从 frag 拆分后槽数继续编号（binding=5）→ 合并
/// bindings 应**唯一**。对照旧 bug：frag.nextBinding(拆前)=3 → vert MVM block 在 3，与 frag 拆分后
/// sampler binding=3 碰撞。
#[test]
fn cross_stage_bindings_unique_after_jsoffset_fix() {
    let vraw = include_bytes!("fixtures/mixed_vert_b5.spv"); // vert MVM block 在 binding=5（拆后错开）
    let fraw = include_bytes!("fixtures/mixed_2sampler_block.spv"); // frag split 后 0..4
    let vwgsl = effect::spv_to_wgsl(vraw, effect::Stage::Vertex).expect("vert 编译");
    let fwgsl = effect::spv_to_wgsl(fraw, effect::Stage::Fragment).expect("frag 编译");
    let mut merged: Vec<(u32, effect::BindKind)> = Vec::new();
    for src in [&vwgsl, &fwgsl] {
        let mut b = effect::wgsl_bindings(src).expect("WGSL 应解析");
        merged.append(&mut b);
    }
    merged.sort();
    merged.dedup();
    println!("[cross_stage] vert={:?} frag={:?} merged={:?}",
        effect::wgsl_bindings(&vwgsl).unwrap(),
        effect::wgsl_bindings(&fwgsl).unwrap(),
        merged);
    let mut seen = std::collections::HashSet::new();
    for (b, _) in &merged {
        assert!(seen.insert(*b), "跨 stage 合并 binding {b} 重复（merged={merged:?}）");
    }
    assert_eq!(merged, vec![
        (0, effect::BindKind::Texture),
        (1, effect::BindKind::Sampler),
        (2, effect::BindKind::Texture),
        (3, effect::BindKind::Sampler),
        (4, effect::BindKind::Uniform),
        (5, effect::BindKind::Uniform),
    ], "JS 修复后跨 stage 合并 bindings 应为唯一（frag 0..4 + vert 5）");
}
