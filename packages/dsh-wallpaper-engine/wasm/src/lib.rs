pub mod coords;
pub mod particle;
pub mod render;
pub mod scene;
pub mod tex;

/// wasm 渲染运行时初始化（仅 render feature / wasm 构建可用）：
/// 注册 console_error_panic_hook，浏览器里 Rust panic 打印到 console。
/// JS 侧在模块加载后调用一次。
#[cfg(feature = "render")]
pub fn init_wasm_runtime() {
    console_error_panic_hook::set_once();
}

// ===== wasm-bindgen 导出（WeScene）=====
//
// 仅 render feature（wasm 构建）编译：WeScene 持有 render::Renderer（wgpu），
// native `cargo test`（无 render feature）不编译本段。
//
// 异步初始化（wasm-bindgen 标准做法）：Renderer::new 内部
// request_adapter/request_device 是 async，故导出 `async fn create(...)`，
// wasm-bindgen 自动转 Promise，JS 侧 `await WeScene.create(canvas, w, h)`。

#[cfg(feature = "render")]
use wasm_bindgen::prelude::*;

/// 已上传纹理的变换元数据（load_image 参数；场景绘制在 Task 8/9 消费）。
#[cfg(feature = "render")]
type ImageMeta = (u32, [f32; 3], [f32; 3], Option<[f32; 2]>);

#[cfg(feature = "render")]
#[wasm_bindgen]
pub struct WeScene {
    renderer: render::Renderer,
    scene: Option<scene::SceneDesc>,
    /// 已上传纹理：asset_id → wgpu::Texture（mip0，与 load_image 同序）。
    images: Vec<(u32, wgpu::Texture)>,
    /// load_image 传入的 origin/scale/size 变换（与 images 的 asset_id 对应）。
    image_meta: Vec<ImageMeta>,
    /// 视口像素尺寸（add_particle 的坐标映射用）。
    vw: f32,
    vh: f32,
}

#[cfg(feature = "render")]
#[wasm_bindgen]
impl WeScene {
    /// 异步构造：初始化 WebGPU 渲染器并返回场景运行时。
    /// JS 侧：`const scene = await WeScene.create(canvas, width, height);`
    pub async fn create(
        canvas: web_sys::HtmlCanvasElement,
        width: u32,
        height: u32,
    ) -> Result<WeScene, JsValue> {
        // Task 5 遗留修复：console_error_panic_hook 入 Cargo.toml 后从未调用，
        // 在此注册一次（wasm panic → console.error 而非静默 trap）。
        console_error_panic_hook::set_once();
        let renderer = render::Renderer::new(&canvas, width, height)
            .await
            .map_err(|e| JsValue::from_str(&e))?;
        Ok(WeScene {
            renderer,
            scene: None,
            images: Vec::new(),
            image_meta: Vec::new(),
            vw: width as f32,
            vh: height as f32,
        })
    }

    /// 调整画布尺寸（surface 重建 + 视口尺寸同步）。
    pub fn resize(&mut self, w: u32, h: u32) {
        self.vw = w as f32;
        self.vh = h as f32;
        self.renderer.resize(w, h);
    }

    /// 解析 scene.json（结构对齐 src/client/scene-json.ts）；scene_width/height 返回其正交尺寸。
    pub fn load_scene(&mut self, json: &str) {
        self.scene = Some(scene::parse_scene(json));
    }

    /// 解码 .tex 字节并上传纹理（RGBA8888/DXT1/3/5/R8/RG88，TEXV0005 容器）。
    /// origin/scale/size 为场景变换（当前存储待 Task 8/9 场景绘制消费）；
    /// 相同 asset_id 重复调用替换旧纹理。
    pub fn load_image(
        &mut self,
        asset_id: u32,
        tex_bytes: &[u8],
        origin: Vec<f32>,
        scale: Vec<f32>,
        size: Vec<f32>,
    ) {
        let Some(img) = tex::parse_tex(tex_bytes) else {
            return;
        };
        if let Some(tex) = self.renderer.upload_texture(&img) {
            self.images.retain(|(id, _)| *id != asset_id);
            self.image_meta.retain(|(id, _, _, _)| *id != asset_id);
            let size = if size.len() >= 2 { Some([size[0], size[1]]) } else { None };
            self.images.push((asset_id, tex));
            self.image_meta.push((asset_id, arr3(&origin), arr3(&scale), size));
        }
    }

    /// 装载粒子规格（emitter[0] + initializer + operator 解析）并构建 GPU 粒子管线。
    pub fn add_particle(&mut self, json: &str, origin: Vec<f32>, scale: Vec<f32>) {
        let spec = particle::parse_particle_spec(json);
        self.renderer
            .set_particle(&spec, arr3(&origin), arr3(&scale), self.vw, self.vh);
    }

    /// GPU 粒子模拟一帧（更新 uniform dt + 累计 elapsed + dispatch compute）。
    pub fn step(&mut self, dt: f32) {
        self.renderer.step(dt);
    }

    /// 渲染一帧到 canvas（清屏 + 粒子层）。
    pub fn render(&mut self) {
        self.renderer.render_frame();
    }

    /// 场景正交投影宽度（未 load_scene 时返回视口宽度）。
    pub fn scene_width(&self) -> f32 {
        self.scene.as_ref().map(|s| s.orthogonal.0).unwrap_or(self.vw)
    }

    /// 场景正交投影高度（未 load_scene 时返回视口高度）。
    pub fn scene_height(&self) -> f32 {
        self.scene.as_ref().map(|s| s.orthogonal.1).unwrap_or(self.vh)
    }
}

/// Vec<f32>（JS Float32Array/Array）→ [f32; 3]；缺省补 0（对齐 WE 向量语义）。
#[cfg(feature = "render")]
fn arr3(v: &[f32]) -> [f32; 3] {
    [v.first().copied().unwrap_or(0.0), v.get(1).copied().unwrap_or(0.0), v.get(2).copied().unwrap_or(0.0)]
}
