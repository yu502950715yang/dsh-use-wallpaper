# 修复记录：GTR 壁纸（粒子方向/亮度 + 图像颜色混合模式）

- 日期：2026-09-11
- 触发：用户报「GTR 壁纸（workshop `3743126786`）效果不对」，对比桌面端截图后定位
- 结论：**四个独立缺陷叠加**，均在本轮修复

| # | 缺陷 | 模块 | 修后实测 |
|---|---|---|---|
| A | `turbulentvelocityrandom` 方向公式错误 | `wasm/src/particle/sim.rs` | 局部 `max\|vx\|` 0.000 → 36.6、`max\|vz\|` 223.1 → 0.0 |
| B | 对象级 `instanceoverride` 全库未实现 | wasm sim + JS 透传 | alpha 均值 0.797 → 0.0239（上限 0.030） |
| C | 对象 `angles`（弧度欧拉角）完全未应用 | `scene-json.ts` + `threejs-player.ts` | 世界速度方向 → **17.6°（向右偏上）** |
| D | 图像 `colorBlendMode`（Screen 等）未实现 | `scene-json.ts` + `threejs-player.ts` | 云层黑底处不再压暗背景（黑块消失） |

## 1. 现象与定位

**第一轮**（A+B）：网页端画面右侧 x≈68.7% 处有一条**贯穿全屏的竖直白色烟串**，桌面端同位置干净。
换算：该位置 = 场景对象 `Струя дыма`（烟柱）的 `origin.x=5101 / 场景宽 7430 = 68.7%`，
即 `particles/presets/smoke2.json` 的粒子层。

**第二轮**（C，用户反馈「桌面是从排气管向右侧，不是向上」）：`Струя дыма` 的
`angles = "0 0 -1.20063"`（≈ -68.8°）。局部 +Y 经 `Rz(-1.20063)` → 世界 `(0.932, 0.362)`
= **向右偏上**；缺这一环时局部方向被直接当世界方向用 → 烟直着向上。

用 node 直接驱动 wasm `CpuParticleSim`（three.js 路径用的就是它）实测：

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 粒子 x 跨度 | 11.3（≈ emitter 球半径 6，无运动） | 113.6 |
| `max\|vx\|` | **0.000** | 36.6 |
| `max\|vz\|` | 223.1（屏幕不可见轴） | **0.0** |
| alpha 均值 | 0.797 | 0.0239（上限 0.030） |

## 2. 根因 A：`turbulentvelocityrandom` 方向公式错误

`wasm/src/particle/sim.rs` 的 spawn 段旧实现：

```rust
dir = forward*cos(θ) + normal*sin(θ)*scale   // ❌ 把 normal 当成"偏转方向"
```

官方语义（`research/open-wallpaper-engine/src/Scene/Pkg/Parse/Particle/ParticleParser.cpp:326-357`
`TurbulentVelocityRandomProgram::Initialize`）：

```cpp
result  = CurlNoise(position + normal*phase);
result -= normal * result.dot(normal);        // 投影到垂直 normal 的平面
angle   = atan2(normal·(forward×result), forward·result);
result  = AngleAxisf(angle*scale + offset, normal) * forward;   // ★ forward 绕 normal 旋转
velocity += result * speed;
```

缺省 `normal=+Z / forward=+Y` 时，正确方向是 `(sinθ, cosθ, 0)`（**x 有分量、z 恒 0**）；
旧式子给出 `(0, cosθ, 0.1sinθ)` —— 恰好把可见的 x 丢光、把不可见的 z 当速度方向，
177 个粒子于是沿竖直方向排成一条线。

**修复**：按官方复刻 —— 复用 sim.rs 既有的 `curl_noise` / `perlin_noise_vec3`，采样位置
`turb_position` **跨 spawn 累积**（对应 `TurbulentVelocityRandomProgram::position` 成员，
使相邻粒子方向连贯），投影到 normal 平面 → 求夹角 → Rodrigues 旋转；`offset / timescale /
phasemin / phasemax` 全部解析并参与。

**影响面**：全库 9 张壁纸的粒子用了该 initializer，且都**没有显式写 normal/forward**：
`2011060960, 2236329190, 2460786246, 2597392171, 2851992662, 2859263090, 2897292240,
3743126786, 3760200530`（火星 / 火把 / 树叶 / 气泡等的横向飘动此前全部丢失）。
GPU（WebGPU）路径的 `turb_velocity` 本来就是球面均匀随机，**不受影响** —— 所以这是
v0.3.0 把 three.js 设为默认渲染路径后**暴露出来的既有 bug**。

## 3. 根因 B：对象级 `instanceoverride` 全库未实现

`src/` 与 `wasm/` 全库 grep 无任何 `instanceoverride` 处理。GTR 恰好重度依赖它：

- `Струя дыма` → `{ alpha: 0.03, size: 2.09 }`
- `Long wind trail` → `{ alpha: 0.02, colorn: "0.75294 …", lifetime: 1.5, rate: 2.5 }`

官方 `OverrideSpawnProgram`（`ParticleParser.cpp:359-384`）把 override 作为**追加在最后**的
spawn initializer：`lifetime/alpha/size/speed` 乘、`color` 覆盖（`UiColorToLinear` = v²），
emitter rate × `Count()`（`SceneParticleObjectParser.cpp:264`）；`UiScalarToLinear(v) = v` 为恒等。

缺了它 → 粒子按材质 alpha 渲染（实测均值 **0.797**，桌面端应 ≈ 0.024）→ 本该几乎不可见的
烟柱被叠成刺眼白串。

**修复**：`instanceoverride` 原始 JSON 文本透传（`scene-json.ts` → `three-renderer.ts` →
`CpuParticleSim.new` 第 5 参）→ Rust `parse_particle_override` → `SceneParticleSim::override_spec`。

## 4. 根因 C：对象 `angles` 完全未应用（用户第二轮反馈）

`grep angles` 在 `src/` 与 `wasm/src/` **零命中** —— 连解析都没有。而全库扫描（`research/scan-object-angles.mjs`）显示：

```
非零 angles 对象数（按类型）: {"particle":75,"text":1,"image":2,"other":1}
总计 79 个对象，涉及 15 张壁纸
```

WE 语义（OWE）：
- `angles` **原文即弧度**（`SceneNode.cpp:15`：`m_rotation is in radians. Static scene.json angles
  are already radians`）
- 对象 model matrix = **T·R·S**，其中 **R = Rz·Ry·Rx**（`ParticleRuntime.cpp:25-28` `ControlpointRotation`）

修复前的粒子顶点 shader 只做了 `S`（`objCenter + objScale * (emitterOrigin + local)`），
**局部运动方向被直接当成世界方向** → GTR 烟柱的 `angles.z=-1.20063` 被丢掉，烟直着向上。

**修复**（三个应用点）：
1. 粒子顶点 shader：加 `uniform vec3 objAngles` + `weObjectRotate`（Rz·Ry·Rx），
   `worldPos = objCenter + R·(S·(emitterOrigin + local))`，quad 角点同样过 `R·S`
2. 背景 `addBackground`：`mesh.rotation.set(angles)`（three 的 Object3D 变换顺序本身就是 T·R·S）
3. `SceneObject.angles` 类型 + `scene-json.ts` 解析（`vec3(o.angles)`，缺省 `[0,0,0]`）

修后实测（烟柱）：世界速度方向 **17.6°（向右偏上）**，世界 x 跨度 1865（向右喷出
≈466 屏幕像素），世界 y 收敛到排气管附近（不再贯穿全屏）。

## 5. 验证
- Rust 单测：`particle_init_lwe_test`（turbulent 3 项改写/新增）+ 新文件
  `particle_override_test`（6 项），native `cargo test` 全绿
- JS 单测：`scene-json` / `three-renderer` / `threejs-player` 共 **114 passed**
  （新增 10 项：override 透传链路 5 + 对象 angles 2 + colorBlendMode 3）
- 端到端（node 驱动真实 wasm + 真实 scene.pkg）：`research/gtr-verify-fix.mjs` 全 PASS
  （8 项断言含「世界速度方向向右偏上」「烟不再贯穿全屏」）
- 端到端（**真实 three 渲染** + 像素采样）：`research/verify-colorblend.mjs` 全 PASS
  （自起 http server + headless Edge + esbuild 打包 harness，用生产代码渲染真实 `clouds.tex`；
  不依赖 DSH token）
- 全量 `vitest run`：失败集合与改动前基线**完全一致**（4 文件 / 15 项既有失败，见 AGENT.md §8）
- ⚠️ 浏览器全库回归 `research/verify-wasm-render.mjs` **未跑**：脚本里的 `?token=` 已过期
  （服务端 401），需从 `dsh web` 启动 URL 取新 token

## 6. 遗留

- **GPU（wasm/WebGPU）路径未消费 `instanceoverride`**，也**未应用对象 `angles`** ——
  本轮只修了 three.js 默认路径（见 AGENT.md §8.6）；备用路径的粒子覆盖/朝向仍与桌面有差
- 粒子 quad 仍不含 `rot`（自旋）——既有限制，与本轮无关
- 浏览器端观感由用户刷新页面确认（产物已同步到 profile）

## 7. 追加修复：图像 `colorBlendMode`（左上角黑块，用户第三轮反馈）

**现象**：GTR 左上角一块黑色。

**定位**：
1. 该区域 = `Clouds Back` 对象覆盖屏幕左上约 67% 宽 × 37% 高（origin `2465.7,3493.0`、size 1920×1080 × scale）
2. 它的纹理 `materials/workshop/2944127259/clouds.tex` 手动解码后是 **DXT1 2048×2048、不透明纯黑 78.26% + 白云 22%**
3. 对象带 `colorBlendMode: 7`，而 `grep colorBlendMode src/ wasm/src/` **零命中** —— 全库未实现

**WE 语义**（WE 明文 shader，`D:\Steam\steamapps\common\wallpaper_engine\assets\shaders\`）：
- `common_blending.h::ApplyBlending`：`7 → mix(A, BlendScreen(A,B), opacity)`，`BlendScreen(A,0) = A`
- `genericimage3.frag`：`ApplyBlending(BLENDMODE, screen.rgb, 自己的颜色, 自己的 alpha)`，
  其中 `screen = texSample2D(g_Texture4)` = **当前帧缓冲**，且 `gl_FragColor.a = screen.a`
- lwe `CImage.cpp:751-767`：`colorBlendMode > 0` 时追加一个 `effectpassthrough`（shader=genericimage3）pass

即：**Screen 混合下纯黑完全不改变背景**，所以桌面端看不到黑底；我们用普通 alpha 混合画，
黑底就以对象自身 alpha(0.5) 盖住了背景。

**实现**（three 侧）：`colorBlendModeToThree` + 预乘片元 shader（`vec4(rgb×tint×a, a)`）+ `CustomBlending`：
`7 → (OneMinusDstColor, One)`、`31 → (One, One)`、`6 → MaxEquation`；alpha 用 `(Zero, One)` 保持背景的。
未实现的模式回退普通 alpha 混合（不静默画错）。全库非零的只有 3 个对象。

**实测**（`research/verify-colorblend.mjs`，真实 three 渲染 + 像素采样）：

| 采样点 | mode=7 (Screen) | mode=0（旧行为） |
|---|---|---|
| 云层内黑底 | **19**（= 云层外纯背景 19） | **10**（被压暗一半） |
| 云层内白云 | 47（被提亮） | 39 |
| 云层外右侧背景 | 81 | 81（不受影响） |

**顺带发现的相邻缺口**（记入 AGENT.md §8）：three 路径未实现对象效果链，全库 17 张壁纸 / 130 条效果失效，
包括该对象自己的 `opacity`（0.26 × mask）与 `scroll`（云滚动）—— 所以云的亮度会比桌面端略偏亮。
