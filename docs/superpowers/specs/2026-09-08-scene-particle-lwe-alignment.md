# Scene 粒子完整对齐 lwe/WE（方案 A，四壁纸先）设计

- 日期：2026-09-08
- 状态：待用户评审（brainstorming → 待实现）
- 范围：方案 A（完整对齐 linux-wallpaperengine / WE 粒子），四壁纸先（黑神话 / EVA / DK WOTLK / Crimson）

## 背景

wasm 简化粒子管线（`SceneParticleSim` + billboard）经多轮补丁后，与 Windows 实机仍有巨大差距（粒子的数量/密度/尺寸/材质/纹理形状/运动均不对齐）。根本原因是**架构级简化近似**，不是参数。用户决定换**彻底方案**：完整对齐 lwe/Wallpaper Engine 的粒子语义（`research/.lwe/src/WallpaperEngine/Render/Objects/CParticle.*`），不做简化近似。范围：先做四壁纸，证明能对齐，再通用化。

## 目标（成功标准）

1. 四壁纸粒子（黑神话花瓣/球壳、EVA 光柱/盒子、DK 雪片/多粒子、Crimson）在**数量/密度/尺寸/材质混合/纹理形状/运动**上对齐 Windows 实机（以用户提供的 DK 实机截图为准：粒子稀疏、有纹理形状、半透明、不遮背景）。
2. 每壁纸的 `scene.pkg` 粒子 spec 被**完整消费**（emitter/initializer/operator 全字段），不再有硬编码近似。
3. **不破坏背景/图层**（EVA/DK/Crimson 背景正常）——第一版关键门禁。
4. `cargo test` + token 截图回归（四壁纸）通过。

## 架构（对齐 lwe `CParticle`，保留完整模拟语义）

### 1. 粒子模拟（CPU，对齐 lwe）
- **状态**（对齐 `ParticleInstance`）：`position/velocity/acceleration`、`rotation/angularVelocity/angularAcceleration`、`color/alpha/size/frame`、`lifetime/age`、`initial`（复位基准）、`oscillateAlpha/Size/Position`（振荡状态）、`alive`；`getLifetimePos()=age/lifetime`。
- **Emitters**（`setupEmitters`）：`createBoxEmitter`（boxrandom 体积 ±翻 ×directions）、`createSphereEmitter`（sphererandom 球壳 cosθ+cbrt ×directions）；`rate` 精确发射、`maxParticles`（DEFAULT_MAX_PARTICLES=1000 或 spec.maxcount）；`emissionTimer += dt*rate`。
- **Initializers**（`setupInitializers`）：colorRandom/sizeRandom(`min+t^exp*(max-min)`)/alphaRandom/lifetimeRandom/velocityRandom/rotationRandom/angularVelocityRandom/turbulentVelocityRandom/mapSequenceAroundControlPoint。
- **Operators**（`setupOperators`）：movement（`vel+=accel*dt; pos+=vel*dt`，重量/阻力/重力/`velocity` 精确）、angularMovement（`rot+=angularVel*dt`）、alphaFade（梯形 fadein/out）、sizeChange/alphaChange/colorChange、turbulence、vortex、controlPointAttract、oscillateAlpha/Size/Position。
- **每帧**：对每个粒子跑 operators（积分），`age+=dt`，`isAlive()=alive && age<lifetime`；死亡/复位。

### 2. 粒子渲染（GPU，对齐 lwe `renderSprites` 核心）
- **坐标/矩阵**：`m_modelMatrix = translate(m_transformedOrigin)`（对象 origin，`we_to_three` scene、y 不翻、与背景一致）+ `applyParallaxToModelMatrix`；`m_viewProjectionMatrix`（场景正交，cover/contain）；`m_mvpMatrix = viewProj * model`；`m_mvpMatrixInverse`。发射点经对象变换（含对象 scale，非零 origin 需乘 scale——黑神话顶部偏左即由此来）。
- **billboard 渲染**（`renderSprites`/sprite 顶点）：每粒子 4 顶点展开为 `SPRITE_FLOATS_PER_VERTEX`(17) 顶点流（含 mvp 变换、uv、颜色、size 等）；`m_spritesheetCols/Rows/Frames/Duration`（多帧随机帧/序列）；材质 `blend`（additive/alpha 按材质）、纹理（含 alpha 遮罩——lightshaft/雪片**真实形状**）、softness、`overbright`/`refractAmount`。
- **CPass 渲染**（材质 pass 路径：绑定纹理/FBO/材质 shader——为四壁纸先实现基础 pass，效果链 pass override 超出范围则走原始材质).
- **顶点流**：`fillVertices` 产出 `SPRITE_FLOATS_PER_VERTEX`(17) 每顶点（位置变换＋uv＋color＋size 等），索引为每粒子两个三角形。

### 3. 对齐 lwe 的坐标/投影关键点（此前错位根因）
- `m_transformedOrigin = we_to_three(obj_origin, scene_w, scene_h)`（scene、y 不翻、与背景一致）。
- **发射点 = 对象变换 × emitter 局部偏移**（`origin×对象scale`），黑神话 `emitter.origin=(350,750)×对象scale(-2.05,2.12)` → 顶部偏左。
- `viewProjection = ortho(-viewW/2..viewW/2)`（cover/contain 尺寸）；`mvp = viewProj * model`。
- 粒子**世界位置**经 `mvp` 到 NDC；材质/纹理/混合完整。

### 4. 数据流（每帧）
1. JS（raf）→ `update_particles(dt)`（CPU 模拟：emitter 发射 + initializers 初始化 + operators 积分）。
2. `build_vertices()` 产出 `[SPRITE_FLOATS_PER_VERTEX]` 顶点流 → GPU `draw`（mvp+材质+纹理+blend）→ canvas（背景之后叠加）。
3. 每壁纸 spec（emitter/initializer/operator/材质/纹理/多帧）完整映射，无硬编码近似。

## 错误处理
- 粒子 spec 缺失字段 → 默认值（对齐 lwe 默认）；渲染 pass 失败只丢该粒子对象（log warning），其余图层继续。
- 纹理缺失（TEXV0005 解码失败）→ 1×1 白兜底；材质 blend 缺失 → 默认 additive。
- `maxcount/rate` 异常 → clamp；绝不白屏/崩。

## 测试与回归
- **单元（`cargo test`）**：emitter（球壳/box 分布精确）、initializer（sizerandom exponent/velocity/turbulent）、operator（movement/angular/alphafade 精确积分）、坐标/矩阵（mvp、发射点×scale、顶部偏左）。
- **渲染/集成（token 截图）**：四壁纸（黑神话/EVA/DK/Crimson）——粒子对齐 Windows（数量/尺寸/形状/材质/运动），背景不破坏。
- 逐壁纸回归"不破坏背景"为最高门禁。

## 非目标（本版不做，四壁纸先）
- rope/ropetail/trail 渲染器、refract、效果链过程（effects pass）完整、SceneScript 脚本动画、多显示器/高级材质；这些超范围，后续 B+（前提：先把四壁纸粒子核心对齐跑通）。
- 完整通用化整个粒子系统（先在四壁纸上验证对齐，再铺开）。

## 参考（权威基准）
- `research/.lwe/src/WallpaperEngine/Render/Objects/CParticle.h` / `CParticle.cpp`（逐行基准）。
- 四壁纸 `scene.pkg` 提取的粒子 spec（黑神话 `research/2851992662-particles-presets-leaves5.json`、EVA `fixtures/eva/...lightshafts.json`、DK/Crimson 提取文件）。
