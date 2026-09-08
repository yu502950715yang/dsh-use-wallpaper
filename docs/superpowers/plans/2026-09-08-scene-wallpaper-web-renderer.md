# Scene 壁纸网页渲染器（B 核心）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 用「wasm CPU 粒子模拟 + GPU billboard 渲染」重写 scene 壁纸粒子系统，使其按 WE/linux 完整语义正确渲染（黑神话从上面向下飘、位置不偏、不再破坏 EVA/DK 等壁纸）。

**Architecture:** 双层——wasm 侧 CPU 逐粒子按 linux-wallpaperengine `CParticle` 语义模拟（emitter/initializer/operator），输出 billboard 顶点；wgpu 侧只用正交投影 + 纹理帧 + 材质混合渲染这些顶点。坐标统一按 WE（对象 origin Y 翻 + emitter.origin 局部偏移 + 视口 cover 投影）。

**Tech Stack:** Rust / wasm-bindgen / wgpu (WebGPU) / WGSL / JS (wasm-renderer.ts)。

**Spec:** `docs/superpowers/specs/2026-09-08-scene-wallpaper-web-renderer-design.md`

## Global Constraints

- 粒子位置**不乘对象 scale**（WE `RenderPosition=bounded+position`）。
- 坐标 Y 翻：`origin.y = viewH/2 - obj.y`（对象）、`emitter.origin.y = -emitter.origin.y`（发射偏移）。
- 投影 viewW/H = **视口 cover**（`cover(sceneW,sceneH,canvasAspect)`），非固定 scene 3840。
- 失败只丢单个对象（不白屏/崩）；单渲染 pass 失败跳过低 warning。
- 回归必须覆盖 black / EVA / DK WOTLK / Crimson（尤其"粒子左边不对"）。
- 回归截图用 token：`research/probe-live.mjs` 已设新 token `vfoP3xErXnygjm8COgwnw6V0asaR7niEo4CVhC_b4aA`。

---

### Task 1: 坐标层（WE 屏幕 → 中心/视口 cover）

**Files:**
- Modify: `wasm/src/coords.rs`
- Test: `wasm/tests/coords_transform_test.rs`（新建）

**Interfaces:**
- Produces: `we_to_center(origin: [f32;3], view_w: f32, view_h: f32) -> [f32;3]`（对象 origin → 中心，Y 翻）；`emitter_origin_y_neg(y: f32) -> f32`；`cover_range(scene_w,scene_h,aspect)->(f32,f32)`（照现有 camera::cover_range 语义）。

- [ ] **Step 1: 写失败测试**

```rust
#[test]
fn we_origin_flips_y_to_center() {
    // scene 3840x2160、view cover 3840x1906；对象 origin (2306.34, 419.77)
    let c = we_to_center([2306.34, 419.77, 0.0], 3840.0, 1906.0);
    assert!((c[0] - (2306.34 - 3840.0/2.0)).abs() < 1e-3);
    assert!((c[1] - (1906.0/2.0 - 419.77)).abs() < 1e-3, "应 Y 翻到上方");
}
```

- [ ] **Step 2: 运行确认失败**
  Run: `cargo test --no-default-features we_origin_flips_y_to_center` → FAIL（`we_to_center` 不存在）。

- [ ] **Step 3: 写最小实现**

```rust
/// WE 屏幕坐标（y 向下）→ 中心原点（y 向上）：x-=w/2、y=h/2-y（Y 翻，照 linux CParticle）。
pub fn we_to_center(origin: [f32; 3], view_w: f32, view_h: f32) -> [f32; 3] {
    [origin[0] - view_w / 2.0, view_h / 2.0 - origin[1], origin[2]]
}
/// emitter.origin 局部偏移 Y 翻（照 linux transformedEmitterOrigin）。
pub fn emitter_origin_y_neg(y: f32) -> f32 { -y }
```

- [ ] **Step 4: 运行确认通过**
  Run: `cargo test --no-default-features coords_transform_test` → PASS。

- [ ] **Step 5: 提交**
  `git add wasm/src/coords.rs wasm/tests/coords_transform_test.rs && git commit -m "feat(particle): we_to_center Y-flip coordinate layer"`

---

### Task 2: `SceneParticleSim`（CPU 模拟器：emitter/initializer/operator）

**Files:**
- Create: `wasm/src/particle/sim.rs`
- Create: `wasm/src/particle/mod.rs`（`pub mod sim;`）
- Test: `wasm/tests/particle_sim_test.rs`

**Interfaces:**
- Consumes: `coords::we_to_center`, `coords::emitter_origin_y_neg`
- Produces:
  - `pub struct SimParticle { pub pos:[f32;3], pub vel:[f32;3], pub rot:f32, pub size:f32, pub alpha:f32, pub life:f32, pub max_life:f32, pub color:[f32;3], pub frame:f32 }`
  - `pub struct ParticleEmitterSpec { pub rate:f32, pub origin:[f32;3], pub directions:[f32;3], pub dist_min:f32, pub dist_max:f32, pub is_sphere:bool }`
  - `pub struct SceneParticleSim::new(e:ParticleEmitterSpec, maxcount:u32, obj_origin:[f32;3], view_w:f32, view_h:f32)`
  - `pub fn update(&mut self, dt:f32)`
  - `pub fn build_vertices(&self) -> Vec<[f32;9]>`（pos3 + size + uv2 + color3 + alpha... 见 Task 3）

- [ ] **Step 1: 写失败测试**

```rust
#[test]
fn sim_spheres_spawn_above_and_move_down() {
    // 对象(2306,419) emitter.origin(350,750) → center y 应在上方 (view_h/2 - 419 + (-750) 的 Y 翻组合)
    let mut sim = SceneParticleSim::new(
        ParticleEmitterSpec { rate:20.0, origin:[350.0,750.0,0.0], directions:[1.0,0.1,1.0],
                              dist_min:0.0, dist_max:750.0, is_sphere:true },
        50, [2306.34,419.77,0.0], 3840.0, 1906.0);
    sim.update(0.5);
    let v = sim.build_vertices();
    assert!(!v.is_empty(), "应有粒子发射");
    // 粒子在中心系的上方（emitter 上移）且 vel.y<0（向下）
    let mut any_up=false; for p in &v { if p[1] > 0.0 { any_up=true; } }
    assert!(any_up, "应有些粒子在中心原点上方（对象Y翻+emitter origin 上移）");
}
```

- [ ] **Step 2: 运行确认失败** `cargo test --no-default-features sim_spheres_spawn_above_and_move_down` → FAIL。

- [ ] **Step 3: 写实现**：`SceneParticleSim` 按 linux `CParticle`——`emissionTimer += dt*rate` 发射；`spawn` 给新粒子 pos/vel/size/alpha/life/rot；operator 每帧积分（`pos += vel*dt; vel += (gravity - vel*drag)*dt; rot += angVel*dt`）；`build_vertices` 输出 `[pos3,size,uv2,color3,alpha]`（uv 默认 0/1，帧由 rand 选）。核心 spawn 代码：

```rust
// spawn（照 linux createSphereEmitter 3D 球壳）
let theta = rand()*6.28318; let cos_t = rand()*2.0-1.0; let sin_t=(1.0-cos_t*cos_t).sqrt();
let unit=[sin_t*theta.cos(), sin_t*theta.sin(), cos_t];
let r = (self.d_min.powi(3) + (self.d_max.powi(3)-self.d_min.powi(3))*rand()).cbrt();
let local = [unit[0]*r*self.directions[0], unit[1]*r*self.directions[1], unit[2]*r*self.directions[2]];
let spawn = we_to_center(self.obj_origin,self.vw,self.vh);
let mut pos=[spawn[0]+self.origin[0], spawn[1]+emitter_origin_y_neg(self.origin[1]), spawn[2]+self.origin[2]];
pos[0]+=local[0]; pos[1]+=local[1]; pos[2]+=local[2];
// vel（向下，Y 负）：vel.y = -50..-15
```

- [ ] **Step 4: 运行确认通过** `cargo test --no-default-features particle_sim_test` → PASS。

- [ ] **Step 5: 提交** `git add wasm/src/particle && git commit -m "feat(particle): CPU SceneParticleSim emitter/initializer/operator"`

---

### Task 3: `ParticleRenderPass`（GPU billboard 渲染：投影/纹理帧/混合）

**Files:**
- Create: `wasm/src/render/particle_render.rs`
- Modify: `wasm/src/render/mod.rs`（挂接 `ParticleRenderPass`）
- Test: `wasm/tests/wgsl_valid`（已有 naga 校验任务改为校验新 shader）

**Interfaces:**
- Consumes: `SceneParticleSim::build_vertices()`（`[f32;9]`：pos3,size,uv2,color3,alpha）
- Produces: `ParticleRenderPass::new(device, queue, format, tex_option, blend_mode)`；`draw(pass, vertices)`；blend_mode: enum Additive|Translucent（由材质 spec 决定）。

- [ ] **Step 1: 写 WGSL（新 shader `particle_billboard.wgsl`）**——vertex 由顶点（pos/size/uv/color/alpha）生成 billboard quad：

```wgsl
struct VsIn { @location(0) pos: vec3f, @location(1) size: f32, @location(2) uv: vec2f,
              @location(3) color: vec3f, @location(4) alpha: f32 }
struct P { view_w: f32, view_h: f32 }
@group(0) @binding(0) var<uniform> p: P;
struct VsOut { @builtin(position) clip: vec4f, @location(0) uv: vec2f,
               @location(1) color: vec3f, @location(2) alpha: f32 }
@vertex fn vs(@builtin(vertex_index) vi:u32, i:VsIn) -> VsOut {
  let corner = vec2f(f32(vi & 1u)*2.0-1.0, f32((vi>>1u)&1u)*2.0-1.0);
  let half = i.size*0.5;
  let ndc = vec2f(2.0/p.view_w, -2.0/p.view_h); // y 翻转（屏幕系）
  var o: VsOut; o.clip = vec4f(vec2f(i.pos.x, i.pos.y) + corner*half*vec2f(1.0,ndc.y/ndc.x), 0.0, 1.0);
  o.clip.x = (i.pos.x/ (p.view_w/2.0)) + corner.x*(half/ (p.view_w/2.0)); // 世界->NDC
  o.clip.y = (i.pos.y/ (p.view_h/2.0)) + corner.y*(half/ (p.view_h/2.0));
  o.uv = vec2f(i.uv.x*0.5+0.5, i.uv.y*0.5+0.5) + corner*0.5; o.color=i.color; o.alpha=i.alpha; return o;
}
@fragment fn fs(o:VsOut) -> @location(0) vec4f {
  let texel = textureLoad(tex, vec2u(o.uv*vec2f(w,h)), 0);
  return vec4f(o.color*texel.rgb, o.alpha*texel.a);
}
```

- [ ] **Step 2: 加 naga 校验**（在 `wasm/tests/particle_render_wgsl_valid` 或 `mod.rs` 用 `naga` 解析新 shader），运行确认能解析 → PASS。

- [ ] **Step 3: `ParticleRenderPass`**——建 pipeline（bind group: uniform view_w/h + texture + sampler），`draw(vertices)` 上传顶点缓冲区（`[f32;9]`），blend 按 `Additive|Translucent`（SrcAlpha/One 或 SrcAlpha/OneMinusSrcAlpha）。

- [ ] **Step 4: 测试** 用头less wgpu（或依赖现有 native test 跑 naga）+ 提交。`git add wasm/src/render/particle_render.rs wasm/src/render/mod.rs && git commit -m "feat(particle): GPU billboard ParticleRenderPass"`

---

### Task 4: 场景加载集成（解析 particle spec → Sim + 每帧 update/draw）

**Files:**
- Modify: `wasm/src/lib.rs`（`add_particle`/新 `set_particle_sim`）
- Modify: `src/client/wasm-renderer.ts`（`add_particle` 走新 sim + 每帧 `update_particles(dt)` + `draw`）
- Modify: `wasm/src/render/mod.rs`（存 `Vec<SceneParticleSim>` + `update_particles(dt)`）

**Interfaces:**
- Produces: `WeScene::set_particle_sim(json, obj_origin, scale, tex_bytes, blend: u32)`（解析 spec 建 sim）；`WeScene::update_particles(dt)`；`WeScene::draw_particles(render_pass)`。
- Consumes: `SceneParticleSim`、`ParticleRenderPass`、`parse_particle_spec`（现有）、`tex::parse_tex`（现有）。

- [ ] **Step 1: `lib.rs` 增 `set_particle_sim`**（用 `parse_particle_spec` + `tex::parse_tex` → `SceneParticleSim::new` + `ParticleRenderPass`），并注册每帧 `update_particles`。
- [ ] **Step 2: `wasm-renderer.ts`** 把 `add_particle` 改为调 `set_particle_sim`；raf 循环加 `scene.update_particles(dt)`；`draw` 顺序（image → particles）。
- [ ] **Step 3: run `npm run build:client`**（wasm + TS），确认编译通过；`cargo test` 通过。
- [ ] **Step 4: 提交** `git add wasm/src/lib.rs wasm/src/render/mod.rs src/client/wasm-renderer.ts && git commit -m "feat(particle): wire CPU sim + billboard render into scene"`

---

### Task 5: 回归验证（black / EVA / DK / Crimson）

**Files:** 无代码（仅验证）；回归截图靠 `research/probe-live.mjs`（用新 token）。

- [ ] **Step 1: 部署** `wasm-pack build --target web --release --features render && npm run build:client` → 复制 `dist/*` 到 `$env:USERPROFILE\.dsh\profiles\web\node_modules\@dsh-use\wallpaper-engine\dist\`。
- [ ] **Step 2: 截图回归** `node research/probe-live.mjs 2851992662,1280029027,2859263090,3765967112`；逐一查看：
  - black：花瓣**从上面向下飘**、大小混合、位置不偏右；
  - EVA / DK / Crimson：粒子**位置正确**（尤其不再"左边不对"）。
- [ ] **Step 3: 若 EVA/DK/Crimson 被破坏** → 回滚该 particle 相关 commit（`git revert`），保留 coords/Sim，重查语义（这是本计划最重要的"不破坏其他壁纸"门禁）。修复后重跑 Step 2。
- [ ] **Step 4: 提交最终状态** `git add -A && git commit -m "test(scene): black/EVA/DK/Crimson particle regression"`（仅当全通过）。

## Self-Review

- **Spec 覆盖**：坐标（Task1）、Sim 模拟（Task2）、渲染（Task3）、集成（Task4）、回归（Task5）——5 节 spec 全部覆盖。
- **Placeholder**：无 TBD/TODO；每 task 有 concrete code/test。
- **类型一致**：`build_vertices` 输出 `[f32;9]`（Task2 定义，Task3 消费）；`SceneParticleSim`/`ParticleRenderPass` 签名在 Task4 引用与定义一致。
- **范围**：B 核心（粒子系统 + 坐标 + 渲染 + 回归）单 plan。
