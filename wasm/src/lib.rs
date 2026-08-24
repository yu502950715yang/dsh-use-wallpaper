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

#[cfg(feature = "render")]
#[wasm_bindgen]
pub struct WeScene {
    renderer: render::Renderer,
    scene: Option<scene::SceneDesc>,
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

    /// 背景模式（cover 铺满）：wasm-renderer 的背景 canvas 用（前景保持 contain）。
    pub fn set_cover(&mut self) {
        self.renderer.set_cover();
    }

    /// 解析 scene.json（结构对齐 src/client/scene-json.ts）；scene_width/height 返回其正交尺寸。
    pub fn load_scene(&mut self, json: &str) {
        let desc = scene::parse_scene(json);
        // Task 9 修复：把场景正交尺寸同步给渲染器（render_frame 的 contain 相机范围计算用）
        self.renderer.set_scene_size(desc.orthogonal.0, desc.orthogonal.1);
        // 场景 clearcolor → 渲染器（cover 背景模式清屏用，对齐 JS 版 bg 层底色）
        self.renderer.set_clear_color(desc.clear_color);
        self.scene = Some(desc);
    }

    /// 解码 .tex 字节并上传纹理（RGBA8888/DXT1/3/5/R8/RG88，TEXV0005 容器），
    /// 登记为图片平面（render_frame 在粒子层之前绘制）。相同 asset_id 重复调用替换旧图。
    /// 失败路径保留 console 诊断（parse/upload 失败是壁纸图片缺失的可观测原因）。
    /// T4.3：color/alpha/brightness 为对象调制输入——空 Vec = 缺省（无调制，向后兼容）：
    ///   color 0-255 量级 r g b（≥3 元素取前 3）；alpha 0-1（单元素）；brightness 乘法系数
    ///   （单元素）。渲染时 image_tint 打包进 ImageUniform.tint（纹理 × tint）。
    pub fn load_image(
        &mut self,
        asset_id: u32,
        tex_bytes: &[u8],
        origin: Vec<f32>,
        scale: Vec<f32>,
        size: Vec<f32>,
        color: Vec<f32>,
        alpha: Vec<f32>,
        brightness: Vec<f32>,
    ) {
        let Some(img) = tex::parse_tex(tex_bytes) else {
            web_sys::console::log_1(&JsValue::from_str(&format!("[wasm] load_image {asset_id}: parse_tex FAILED ({}B)", tex_bytes.len())));
            return;
        };
        if let Some(tex) = self.renderer.upload_texture(&img) {
            let size = if size.len() >= 2 { Some([size[0], size[1]]) } else { None };
            // 空 Vec = 缺省（None）：向后兼容旧调用（仅 5 参数）与无调制对象
            let tint_color = (color.len() >= 3).then(|| [color[0], color[1], color[2]]);
            let tint_alpha = alpha.first().copied();
            let tint_brightness = brightness.first().copied();
            self.renderer.set_image(
                asset_id, tex, arr3(&origin), arr3(&scale), size, img.width, img.height,
                tint_color, tint_alpha, tint_brightness,
            );
        } else {
            web_sys::console::log_1(&JsValue::from_str(&format!("[wasm] load_image {asset_id}: upload_texture FAILED")));
        }
    }

    /// 装载粒子规格（emitter[0] + initializer + operator 解析）并构建 GPU 粒子管线。
    /// tex_bytes 为粒子纹理（TEXV0005，2026-08-21 方案 A：WE 内置 fog/halo 纹理）；
    /// 空字节 = 无纹理（纯色圆盘兜底，向后兼容旧调用）。
    pub fn add_particle(&mut self, json: &str, origin: Vec<f32>, scale: Vec<f32>, tex_bytes: Vec<u8>) {
        let spec = particle::parse_particle_spec(json);
        let tex = if tex_bytes.is_empty() {
            None
        } else {
            tex::parse_tex(&tex_bytes).and_then(|img| self.renderer.upload_texture(&img))
        };
        self.renderer
            .set_particle(&spec, arr3(&origin), arr3(&scale), tex);
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

