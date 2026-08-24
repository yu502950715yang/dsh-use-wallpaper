use we_scene_wasm::scene::{parse_scene, ObjectKind};

const EVA_JSON: &str = include_str!("fixtures/eva/scene.json");

#[test]
fn parses_orthogonal_projection() {
    let desc = parse_scene(EVA_JSON);
    assert_eq!(desc.orthogonal, (2400.0, 1555.0));
}

#[test]
fn parses_image_objects() {
    let desc = parse_scene(EVA_JSON);
    let imgs: Vec<_> = desc.objects.iter().filter(|o| o.kind == ObjectKind::Image).collect();
    assert!(!imgs.is_empty());
    // EVA 主图：origin=size/2=(1200,777.5)、scale=(1,1,1)
    let main = imgs.iter().find(|o| o.size == Some([2400.0, 1555.0])).expect("main image");
    assert_eq!(main.origin, [1200.0, 777.5, 0.0]);
    assert!(main.image.as_deref().unwrap().contains("models/"));
}

#[test]
fn parses_particle_objects_with_effects() {
    let desc = parse_scene(EVA_JSON);
    let parts: Vec<_> = desc.objects.iter().filter(|o| o.kind == ObjectKind::Particle).collect();
    assert!(!parts.is_empty());
    assert!(parts.iter().all(|o| o.particle.is_some()));
}

#[test]
fn empty_image_string_classified_as_particle() {
    // 对齐 TS parseSceneJson（scene-json.ts:38 `o.image && ...` falsy 语义）：
    // image 空串与无 image 等价 → 无引用对象按空粒子处理（不渲染）
    let desc = parse_scene(r#"{"objects":[{"image":""}]}"#);
    assert_eq!(desc.objects[0].kind, ObjectKind::Particle);
    assert!(desc.objects[0].image.as_deref().is_some());
}

#[test]
fn util_image_prefix_classified_as_util() {
    // WE 内置合成层/全屏层/项目层（models/util/*.json）：效果链容器，归类 util
    let desc = parse_scene(r#"{"objects":[{"image":"models/util/fullscreen.json"}]}"#);
    assert_eq!(desc.objects[0].kind, ObjectKind::Util);
}
