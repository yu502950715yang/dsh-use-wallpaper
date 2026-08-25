use we_scene_wasm::render::effect;

#[test]
fn compiles_we_dialect_glsl_to_wgsl() {
    // 一个 WE 方言 fragment（fade 语义，已由 JS 转成 desktop 450 的样子）。
    let glsl = "#version 450\nlayout(location=0) out vec4 o_Color;\nlayout(binding=0) uniform vec3 color;\nvoid main(){ o_Color = vec4(color*0.7, 1.0); }";
    let wgsl = effect::glsl_to_wgsl(glsl, effect::Stage::Fragment);
    assert!(wgsl.is_ok());
}

#[test]
fn validates_wgsl() {
    let wgsl = "struct O { @location(0) c: vec4<f32>, };\n@fragment fn main() -> O { return O(vec4f(0.0)); }";
    assert!(effect::validate_wgsl(wgsl));
}
