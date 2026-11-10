# Rust / wasm 审查

> 范围：`wasm/src/{lib.rs,coords.rs,particle/{mod.rs,spec_to_emitter.rs,sim.rs}}`、`wasm/tests/**`、`wasm/Cargo.{toml,lock}`、`src/client/wasm-loader.ts`（以及为核对契约而读的 `threejs-player.ts` / `three-renderer.ts`）。
> 方式：**只读**静态审查 + `grep`/`git` 核对；未运行 `cargo build/test`。`git diff --stat 1b7a306..HEAD -- wasm/src wasm/Cargo.toml wasm/Cargo.lock` 为空，`dist/static/WASM_BUILD.json` 的源码基线 `1b7a306` 与当前源码一致。
> 已记录的已知缺口（AGENT.md §7.42⑤ starttime 900 步截断/构造成本、§7.43 `.tex`、不支持 `children` 等）**不重复计入**；`p0-release-done.md` 已修好的 `cargo test`/duty-cycle 期望也不重复。

**结论：P0 × 3，P1 × 3。** 最严重的是三方素材可触发的 wasm trap / 构造期 OOM / 不可中断死循环。

## P0（panic/越界/内存失控/接口契约破坏）

### P0-1 不可信粒子 JSON 解析失败直接 `expect` panic（wasm trap）

- 位置：`wasm/src/particle/mod.rs:390`
  ```rust
  let raw: Value = serde_json::from_str(json).expect("粒子 json 必须可解析");
  ```
  调用链：`wasm/src/lib.rs:41-49` `CpuParticleSim::new` → `particle::parse_particle_spec(json)`。
- 触发：任意**第三方/损坏**的粒子 JSON——截断文件、非法 JSON、超过 serde_json 默认 128 层嵌套（`from_str` 返回 `RecursionLimitExceeded`）都会进入该分支。WE 素材由作者提供，`three-renderer.ts:744-746` 只检查 HTTP `ok`，不预校验 JSON。
- 影响：
  - release wasm（panic=abort/trap）得到 `RuntimeError: unreachable`，不是 `Err`；`three-renderer.ts:857-862` 的 `try/catch` 会兜底成零粒子 sim，因此**该粒子层静默消失**（页面不必然整页崩，但用户只看到「没有粒子」，控制台只有 `unreachable`，没有 panic 位置——见 P2-7 无 `console_error_panic_hook`）；panic 时 wasm 栈不会展开，此前分配的 spec/`Vec` 不走 `Drop`，每次失败都会在 wasm 线性内存里留下垃圾。
  - 接口契约自相矛盾：`CpuParticleSim::new` 声明 `Result<CpuParticleSim, JsValue>`（`lib.rs:41-47`），注释写「返回 `Err`（spec 解析失败）→ JS 侧 Promise reject」（`lib.rs:40`），但解析函数没有 `Result` 通道，`Err` 永远不会产生；`new` 还是**同步**构造器，`.d.ts` 也是同步返回，所谓 Promise reject 不成立。
- 修复：把 `parse_particle_spec` 改为 `Result<ParticleSpec, ParseError>`（`from_str` 的 `?` + 字段校验错误），`CpuParticleSim::new` 用 `map_err(|e| JsValue::from_str(&e))?`；保留测试里的 `.unwrap()`。同时把 `lib.rs:40` 注释改成「构造失败 → throw（Result→JS exception）」。

### P0-2 `maxcount` 无上限：构造期 `prewarm()` 按素材声明值无界分配

- 位置：
  - `wasm/src/particle/mod.rs:450`：`maxcount = scalar(...).max(0.0) as u32`（f64→u32 **饱和**，`"1e39"`/`Infinity`/`1e300` 都变成 `u32::MAX`，负数/NaN 变 0）。
  - `wasm/src/particle/sim.rs:875`：`let steady = ((effective_rate * mean_life).ceil() as u32).clamp(1, self.maxcount);`
  - `wasm/src/particle/sim.rs:892-900`：`for _ in 0..steady { ... self.spawn_with_age_frac(...); }`。
  - 运行期同样无上限：`sim.rs:797-803`（`to_emit as u32` + `min(maxcount - alive)`）。
- 触发：`{"emitter":[{"rate":1e9}],"initializer":[{"name":"lifetimerandom","min":10,"max":10}],"maxcount":1000000000}`。`rate × mean_life = 1e10` → `as u32` 饱和 → `steady` = `maxcount` = 1e9；`CpuParticleSim::new` 在**主线程构造期**连续 push 1e9 个 `SimParticle`（每颗约 0.1–0.2 KB）→ wasm 线性内存增长失败/OOM，标签页卡死或崩溃。即使 `rate` 正常，`maxcount` 也允许 1e9，长期运行会把 `Vec` 无界撑大。
- 跨端契约同时被破坏：
  - `src/client/threejs-player.ts:146-150` 的注释声称「上限与 wasm 粒子池 clamp [16, 2048]（`render/particle_pass.rs`）对齐」——**该文件已删除，Rust 侧现在没有任何 clamp**。
  - `threejs-player.ts:322-325` `particleCapacity()` 虽把 `declared` 收到 `MAX_PARTICLE_CAPACITY=2048`，但 `Math.max(1, cap, aliveAtCreate)` 在 `aliveAtCreate>2048`（正是 `prewarm` 的结果）时**绕过上限**；`writeParticleData` 还会按 count 继续扩容 7 个 instanced attribute（`threejs-player.ts:2824-2864`），GPU/CPU 内存一起涨。
- 影响：第三方素材可用一个字段让壁纸加载 OOM/长时间冻结；这不是「maxcount=10000 的 155ms」那种已记录的合理成本（§7.42⑤），而是没有硬上限的失控分配。
- 修复：在 Rust 侧定义 `MAX_PARTICLES`（建议 10000–16384，与产品实际最大素材 10000 对齐），`parse_particle_spec` 与 `SceneParticleSim::new` 双重 clamp；`prewarm` 的 `steady` 再按硬上限截断并打一条 warn（素材名/原值）；`maxcount` 超出时要么 `Err` 要么明确降级。JS 的 `particleCapacity` 也应以同一常量硬限制，`aliveAtCreate` 不得绕过。

### P0-3 角度 wrap 的 `while` 循环在 `inf`/超大 `rot` 下不终止（页面不可中断地卡死）

- 位置：`wasm/src/particle/sim.rs:440-449`
  ```rust
  p.rot[k] += p.angular_vel[k] * dt;
  ...
  while p.rot[k] > pi { p.rot[k] -= two_pi; }
  while p.rot[k] < -pi { p.rot[k] += two_pi; }
  ```
- 触发（都来自不可信 spec；`maxcount>0` 时 **prewarm 在构造期就会执行 AngularMovement**，`sim.rs:905-914`）：
  - `{"emitter":[{"rate":20}],"initializer":[{"name":"angularvelocityrandom","min":"1e30","max":"1e30"}],"operator":[{"name":"angularmovement"}],"maxcount":20}`：`rot ≈ 1e28`（prewarm 的 `dt=age`），`while` 需约 1e27 次减法；
  - 同结构把 initializer 换成 `{"name":"rotationrandom","min":"inf","max":"inf"}`（或 `"1e39"`，`f32` 解析为 `inf`）：`inf - 2π = inf`，**真正死循环**；
  - `angularmovement` 的 `drag` 取大负值（如 `-1e9`）时 `angular_vel *= (1-drag*dt)` 指数放大；`rot` 增长到 1e6 以上后每帧的 `while` 就已需要十万级迭代，最终到 `inf` 同样死循环。
- 影响：wasm 循环内无法被 JS 的 `try/catch`/`AbortController` 打断，主线程（含渲染 RAF）永久卡死；最坏在 `CpuParticleSim::new` 里就卡住，壁纸加载后整页无响应。
- 修复：不要用循环归一化。用 `rem_euclid` 并先处理非有限值：
  ```rust
  let r = p.rot[k];
  p.rot[k] = if r.is_finite() { (r + PI).rem_euclid(TAU) - PI } else { 0.0 };
  ```
  同时在解析/`spawn` 处拒绝或 clamp `rotationrandom`/`angularvelocityrandom`/`angularmovement.force/drag` 的非有限值与超大值。

## P1（真实缺陷，应修）

### P1-1 `randomframe` 的帧号硬编码为 4，忽略实际精灵表帧数；且 `set_frame_count` 发生在 prewarm 之后

- 位置：
  - `wasm/src/particle/sim.rs:1206`：`let frame = (rand() * DEFAULT_FRAME_COUNT as f32).floor();`（`DEFAULT_FRAME_COUNT=4`，`sim.rs:57`）。
  - `wasm/src/particle/sim.rs:1273-1280` 输出时却用 `self.spritesheet_frames` 计算 uv。
  - 调用顺序：`wasm/src/lib.rs:59` 构造时 `prewarm()` 已 spawn；`src/client/threejs-player.ts:3333-3338` 之后才 `sim.set_frame_count(textureFrameCount(...))`；`wasm/src/lib.rs:81-83` 只改 `spritesheet_frames`，不会重算已 spawn 的 `p.frame`。
- 触发：`"animationmode":"randomframe"` + 纹理超过 4 帧的精灵表（如 8×8=64 帧的 fire/fog；WE 允许任意帧网格）。仓库测试里 leaves5 用的是 512×128（4 帧，`tests/threejs-player.test.ts:1625`）、fireflies 是单帧，所以本机暂无可见回归——但这是实现层错误，不是素材边界。
- 影响：这类素材永远只随机到第 0–3 帧，其余帧永不出现；prewarm 出来的首批粒子也带着错误的固定帧。
- 修复：spawn 时保存 `frame_frac = rand()`（不依赖帧数），`build_instance_vertices` 用 `floor(frame_frac * self.spritesheet_frames as f32)` 现算帧号；或者把 `frame_count` 作为 `CpuParticleSim::new` 参数并在 `prewarm` 前设置。

### P1-2 缺失/为 0 的 `maxcount` 使模拟器永远不发射，文档承诺的 `estimate_max_particles` 回退不存在

- 位置：
  - `wasm/src/particle/mod.rs:257-260` 注释：`0 = 未指定（旧格式），estimate_max_particles 回退 rate×寿命+64 估算`；
  - `wasm/src/particle/mod.rs:450` 缺省确实产出 0；
  - `wasm/src/particle/spec_to_emitter.rs:70` 原样把 0 传给 `SceneParticleSim::new`；
  - `wasm/src/particle/sim.rs:871` `prewarm` 在 `maxcount == 0` 时直接 return；
  - `wasm/src/particle/sim.rs:800` `n = to_emit.min(maxcount.saturating_sub(alive))` → 恒 0。
- 触发：旧格式/第三方粒子 JSON **没有 `maxcount`**，或显式 `"maxcount": 0`/负数（`scalar().max(0.0)` 变 0）。`wasm/tests/particle_test.rs:83-84` 甚至以注释「estimate 回退 rate×寿命+64」断言 `spec.maxcount == 0`，但仓库内并无该估算函数（`grep` 只命中注释与测试）。
- 影响：壁纸层能装配成功、`threejs-player` 还按 `DEFAULT_PARTICLE_CAPACITY=1024` 分配了 GPU 缓冲，但 wasm 永远 0 粒子，且无任何日志；作者只看到「粒子不显示」。
- 修复：在 `parse_particle_spec` 或 `SceneParticleSim::new` 里实现注释承诺的回退：`maxcount = (ceil(rate × max(lifetime, 1e-3)) + 64).clamp(1, MAX_PARTICLES)`；或至少对 0 返回明确错误/告警。同步订正 `particle_test.rs:84` 与 `ParticleSpec` 注释。

### P1-3 `prewarm()` 用 `dt = age` 单步执行全部算子：`oscillateposition` 产生永久位置偏移

- 位置：`wasm/src/particle/sim.rs:905-914`：
  ```rust
  let operators = self.operators.clone();
  for idx in first..self.particles.len() {
      let age = particle_age(&self.particles[idx]);
      ...
      for op in &operators { op.apply(&mut self.particles[idx], age, now); }
  }
  ```
- 数值问题：`OscillatePosition::apply`（`sim.rs:599-628`）的增量是 `-scale * w * sin(w*t + phase) * dt`。真实从 0 到 age 的积分为 `scale * (cos(w*age+phase) - cos(phase))`（振幅 ≈ scale），而单步 `dt=age` 得到 `-scale*w*sin(...)*age`（多乘了 `w*age` 因子）。该偏移写进 `p.pos` 后不会被后续帧重新推导，因此**永久保留**，首帧及整个寿命内粒子都被平移；`age` 可达 lifetime（5–25s），偏移量取决于 `scale/freq/age`，可远大于真实振荡振幅（最坏到数百至数千像素量级）。
- 其它算子也有但通常较轻：`Movement` 的 `pos += v0*age` 缺 `0.5*g*age²`；`Turbulence`/`AngularMovement` 的 force/drag 用单步近似；`AlphaFade`/`SizeChange`/`ColorChange` 只依赖 lifetimePos，基本没问题。
- 触发：任何带 `operator:[{"name":"oscillateposition",...}]` 的素材（`spec_operators_to_sim` 已支持该算子，`sim.rs` 默认所有 `CpuParticleSim::new` 都 prewarm）。
- 影响：首帧观感偏移/粒子位置错，且不会随时间自行恢复；prewarm 的「逐 age 前滚」注释对位置类算子不成立。
- 修复：prewarm 对位置类算子做闭式积分（oscillate 用上面的 cos 差；movement 用 `v0*t + 0.5g t²` 并处理 drag；turbulence 用小子步或跳过），或只对 movement/rotation 做前滚、把 oscillator 留到 age=0；补一条针对 oscillateposition 的 prewarm 数值测试。

## P2（健壮性/性能建议）

1. **解析层不做有限性校验，NaN/Inf 可直接进入模拟与顶点流**：`wasm/src/particle/mod.rs:314-323` 的 `scalar` 对字符串走 `parse::<f32>()`，而 Rust 接受 `"NaN"`/`"inf"`/`"infinity"`；`mod.rs:325-346` 的 `vec3` 同样；JSON 数字经 `as f64 as f32` 溢出为 `inf`。触发 `{"emitter":[{"rate":"inf"}]}`、`{"initializer":[{"name":"rotationrandom","min":"inf","max":"inf"}]}`、`"distancemax":1e300` 等。影响：`p.pos/alpha/size` 变 NaN/Inf，`Float32Array` 把 NaN 交给 three（画面缺失/驱动告警），并直接放大 P0-3。修复：解析后统一 `if !v.is_finite() { reject/clamp }`，或在 `spawn`/`apply` 前 sanitize；`maxcount` 单独按 P0-2 处理。
2. **`update(dt)` 不校验 dt**：`wasm/src/particle/sim.rs:773-824` 直接 `sdt = dt * rate`。JS 侧只做上界 `Math.min(..., 0.1)`（`threejs-player.ts:1300`），没有下界/有限性检查；`dt < 0` 会让 `life -= sdt` **增加**寿命（粒子不死）、`time` 倒退，`dt = NaN` 会让 `time` 永久 NaN（后续 turbulence 采样全 NaN）。触发：直接调用 wasm 的宿主/测试、系统时钟回拨、未来接入的其他播放器。修复：Rust 内先 `if !dt.is_finite() { return }`，再 `dt = dt.clamp(0.0, 0.1)`（或返回显式错误）。
3. **每帧两次堆分配 + 一次拷贝**：`wasm/src/lib.rs:88-91` 每帧 `build_instance_vertices()` 新建 `Vec<f32>`，再 `Float32Array::new_from_slice` 复制到 JS；10000 粒子 = 640 KB/帧、60fps ≈ 38 MB/s 垃圾（`threejs-player.ts:2805` 还会再拆进 7 个 attribute）。**当前复制语义是正确且必要的**（见「逐项核验」），不要改成直接返回 wasm 内存 view；建议加 `vertices_into(&mut Float32Array)` 或复用内部 `Vec`，由 JS 每帧传入目标 buffer，保持显式拷贝。
4. **`instanceoverride.color` 存在但非法时变成纯黑覆盖**：`wasm/src/particle/mod.rs:214-222` 只要 `v.get("color")` 是 `Some`（包括 `null`、`"abc"`、对象）就 `vec3` → `[0,0,0]`，再平方仍是黑；不会回退到 `colorn` 或 `None`。触发 `"color": null` / 序列化占位字段。影响：additive 粒子整层不可见。修复：仅当能解析出至少 3 个有限数值时才应用覆盖，否则按字段缺失处理（继续看 `colorn`）。
5. **`controlpoint.id` 的 `u64 as usize` 在 wasm32 上截断**：`wasm/src/particle/mod.rs:456` `v as usize` 后再判 `idx >= 8`；`2^32+3` 在 wasm32 变成 3（合法槽），在 native 64 位却会被跳过，行为跨平台不一致。影响：恶意/异常 id 把控制点写到错误槽。修复：在 `u64` 上先判 `< 8` 再转换。
6. **`operator` / `initializer` 数组无数量上限**：`wasm/src/particle/mod.rs:399-428` 全量 clone/解析；`sim.rs:815-819` 每帧 `particles × operators` 双层循环。一个含 10^5 个 operator 的 JSON 可让每帧执行数千万次，即使 maxcount 很小也会卡死。修复：对算子数设硬上限（如 64）并对超出部分 warn/忽略；限制 spec 文本长度。
7. **Cargo/profile 与 panic 可观测性**：`wasm/Cargo.toml:1-26` 没有 `[profile.release]`（默认 opt-level 3、无 LTO、无 strip），`wasm-opt = false`；当前产物 171,799 B，体积尚可但可再降。没有 `console_error_panic_hook`，panic 在浏览器只剩 `unreachable`，无法定位（本审查的 P0-1 若真发生几乎不可诊断）。建议：显式 `[profile.release] opt-level="s" / lto=true / codegen-units=1 / panic="abort"`，并加 wasm-only 的 `console_error_panic_hook`；改后记录体积。
8. **构建链溯源缺 `wasm-bindgen` 版本，且本机无法重建**：`dist/static/WASM_BUILD.json` 只记 `rustc/cargo/wasm-pack`，不记 `wasm-bindgen` crate/CLI 版本；`wasm/wasm-pack-build.log:4-7` 显示 `wasm-pack` 在安装 wasm-bindgen 时 `os error 5` 失败，CI 也没有 `build:wasm` 步骤。当前 `pkg/we_scene_wasm.d.ts` 的 `new(json, origin, scene_w, scene_h, override_json)` 与 `lib.rs` 一致，**未发现版本错配证据**；但产物本身不记录 wasm-bindgen CLI 版本，一旦重建时 CLI 与 `Cargo.lock` 的 `wasm-bindgen 0.2.127` 不同，实例化会在 `LinkError` 处整模块失败。建议 manifest 增加 `wasm-bindgen` 版本/哈希，并在发布门禁加一次真实实例化冒烟。
9. **wasm 初始化失败完全静默**：`src/client/wasm-loader.ts:19-26` 的 `catch { return null; }` 不打印原因；`three-renderer.ts:848` 在 `CpuParticleSim` 缺失时也只是跳过粒子。触发：MIME/路径错误、glue 与 wasm 不匹配、浏览器禁用 wasm。影响：用户看到「没有粒子」，控制台无任何线索。建议 `console.warn` 一次（含 error.message），并在面板健康状态中体现。
10. **测试用全局 RNG 且在用例内复位**：`wasm/src/particle/sim.rs:32-51` 的 `RNG_STATE` 是进程级 `static`，`sim.rs:1806-1808` 在测试中 `RNG_STATE.store(...)` 后立刻 `spawn`；libtest 默认多线程并行，其它用例可在 store 与 spawn 之间消费随机数。`sim.rs:1456-1458` 的注释已承认「本测试消耗的随机数会落在并发运行的 `z_only_rotation_keeps_rng_stream_unchanged` 的窗口里」，只是靠减小规模降低概率。影响：`cargo test` 偶发 `assert_eq!(absent, z_only)` 失败。修复：把 RNG 放进 `SceneParticleSim`（或提供 `#[cfg(test)] seed()`），测试不共享全局状态。
11. **`particle_count()` 文档与真实布局不一致**：`wasm/src/lib.rs:70` 写「`vertices()` 长度 = count × 10」，实际 `build_instance_vertices` 是 16 浮点/粒子（`sim.rs:1264-1267`），JS 侧 `PARTICLE_FLOATS_PER_INSTANCE = 16`（`threejs-player.ts:155`）。只是文档错误，但会误导后续按 10 计算 buffer 的调用方；建议改注释并在 wasm-bindgen-test（或导出层测试）加 `particle_count()*16 == vertices().len()` 的契约断言。

### 逐项核验（对应任务 1–7 的无缺陷结论）

- **panic/越界/整数溢出**：生产源码中唯一的 `expect`/`panic` 是 `mod.rs:390`（P0-1）；`lib.rs`/`sim.rs`/`spec_to_emitter.rs` 无 `unwrap()`/`panic!`/`todo!`/`unreachable!`（grep 结果见下节）。所有直接索引要么是固定 `[f32; 3]`，要么在 `0..3`/`0..len` 的循环内（`sim.rs:907,913`），PERM 索引全部 `& 255`；`Value` 的 `cp["offset"]`/`em["rate"]` 对缺失/非对象返回 `Null`，不会 panic。`maxcount`/`to_emit`/`steps` 的浮点→整数转换在 Rust 1.45+ 是**饱和**（不是 wrap）。
- **除零/NaN normalize**：`get_lifetime_pos` 有 `max_life > 0` 守卫（`sim.rs:180-186`）；`fade_value` 除法的区间分支保证 `end != start`（`sim.rs:167-176`）；`ControlPointAttract` 有 `dist > 1e-3`（`sim.rs:459`）；`Turbulence` 有 `len > 1e-4`（`sim.rs:542`）；`normalize3` 有 `1e-8` 守卫（`mod.rs:379-382`）；`frame_center_uv` 的 `n = max(1)`、`sequence_frame` 的 `n >= 1`（`sim.rs:79-100`）。未发现除零或 normalize(0) 导致的 panic/NaN。
- **角度/弧度**：Rust 侧没有度→弧度转换，`rotationrandom`/`angularvelocityrandom`/`turb.offset` 均按弧度处理，`AngularMovement` wrap 到 ±π（`sim.rs:438-449`），与 JS 顶点流约定一致；未发现混用。
- **`vertices()` 与 JS 契约**：Rust 16 浮点/粒子 == `PARTICLE_FLOATS_PER_INSTANCE=16`；JS 用 `floor(len/16)` 取 count（`threejs-player.ts:2805`），逐字段偏移 `b+0..b+15` 与布局一致（只有 `particle_count` 注释写 10，见 P2-11）。
- **wasm 内存 view 失效**：`lib.rs:88-91` 用 `js_sys::Float32Array::new_from_slice`，是**拷贝**，不是返回 wasm 线性内存上的 view；JS 不缓存 `memory.buffer` 视图（`threejs-player.ts:2804` 每次调用 getter），`Vec`/粒子增长不会产生悬垂指针。`sim.free?.()` 在切壁纸时调用（`three-renderer.ts:480`），释放正确。
- **调用顺序**：没有 `initialize` 方法，`CpuParticleSim` 只能经静态 `new` 构造，不存在「未初始化就 step」；重复构造即新对象，除进程级 RNG 外无共享可变状态。唯一顺序假设是 `set_frame_count` 应在 prewarm 前（P1-1）。
- **turbulence / link_mouse**：`link_mouse`/`worldspace` 控制点在 `spec_to_emitter.rs:204-215` 明确跳过（有回归测试 `skips_link_mouse_controlpoint_attract`），不是缺陷；`turb_speed <= 0.0001` 直接 return（`sim.rs:533`），`mask`/`scale` 的极端值只会产生大速度，不会 panic（但见 P2-1 非有限值）。
- **starttime**：`advance_initial` 对 `<=0`/NaN 早退、900 步上限、`1/60/rate` 步长（`sim.rs:829-841`）；上限和 155ms 构造成本已记录在 §7.42⑤，不再重复。仅提示：它与 P0-2 的无界 `maxcount` 叠加时，成本是 `900 × maxcount`，属于 P0-2 的放大器。

## unwrap/expect/panic 清单（位置 → 是否在不可信输入路径 → 风险）

| 位置 | 调用 | 不可信输入路径 | 风险 |
|---|---|---|---|
| `wasm/src/particle/mod.rs:390` | `serde_json::from_str(...).expect(...)` | **是**（第三方粒子 JSON） | **P0-1**：非法/超深/截断 JSON → wasm trap；`Err` 契约不成立 |
| `wasm/src/particle/mod.rs:611-612` | `.expect(...)` / `.unwrap()` | 否（unit test） | 测试断言，可接受 |
| `wasm/src/particle/mod.rs:622` | `.unwrap()` | 否（unit test） | 同上 |
| `wasm/src/particle/mod.rs:634,648,650` | `.expect(...)` | 否（unit test） | 同上 |
| `wasm/src/particle/mod.rs:663,680` | `panic!("应为 spritetrail")` | 否（unit test） | 同上 |
| `wasm/src/particle/mod.rs:689-691` | `.expect` / `.unwrap` | 否（unit test） | 同上 |
| `wasm/src/particle/mod.rs:713-716` | `.expect` / `.unwrap` | 否（unit test） | 同上 |
| `wasm/src/particle/spec_to_emitter.rs:518` | `.expect(...)` | 否（unit test） | 同上 |
| `wasm/src/particle/sim.rs:1587` | `panic!("应仍是 ControlPointAttract")` | 否（unit test） | 同上 |
| `wasm/tests/particle_test.rs:62,70` | `.expect(...)` | 否（集成测试） | 同上 |
| `wasm/tests/particle_override_test.rs:125,181-182,189-190,201` | `.expect(...)` | 否（集成测试） | 同上 |
| `wasm/tests/particle_operators_parse_test.rs:62,73,84,163,174` | `panic!` | 否（集成测试） | 同上 |
| `wasm/src/lib.rs` / `sim.rs` 生产代码 | 无 | — | 无 |

**直接索引 / 溢出核查**：

- `sim.rs:907,913`：`self.particles[idx]`，`idx` 来自 `first..self.particles.len()`，安全。
- `sim.rs:309-311,318-328,457-462,514-520,931-942,971-989,1023-1034,1062-1064,1103-1114,1150-1193`：均为 `[f32;3]` 固定数组的 `0/1/2` 或 `0..3`，无输入下标。
- `sim.rs:268-300`：PERLIN 表索引全部 `& 255`，`PERLIN_PERM[...]` 长度 256，安全。
- `mod.rs:456`：`as_u64 as usize` 在 wasm32 上截断（P2-5，行为错误但不 panic）。
- `mod.rs:450`、`sim.rs:797,875,1146`：浮点→整数为饱和转换；`sim.rs:875` 的 `clamp(1, self.maxcount)` 由 `sim.rs:871` 的 `maxcount == 0` 早退保证 `maxcount >= 1`，不会触发 clamp 的 `min > max` panic。
- 无 `unsafe`、无 `from_raw_parts`、无 `transmute`（`grep` 为空）。

**无限循环核查**：`sim.rs:444-449` 是唯一与输入相关的无界循环（P0-3）；`sim.rs:37-50` 的 `rand()` CAS 循环在单线程 wasm 下不会持续冲突（native 测试多线程理论可活锁，但窗口极小）；`prewarm`/`advance_initial`/`update` 的循环次数均由 `maxcount`/900/发射量界定（`maxcount` 本身见 P0-2）。

## 测试覆盖缺口

Rust native 测试整体质量好：`wasm/tests/` 覆盖了 spec 解析、initializer、emitter、主要 operator（含 11 类）、override、prewarm 相位、坐标、starttime 边界；**没有 `#[ignore]`、没有依赖 `research/` 或本机壁纸库**（`grep include_str!` 只指向 `wasm/tests/fixtures/**`，p0-release-done 的 `research/` 编译问题已修）。仍缺以下边界：

1. **wasm 导出层零测试**：`CpuParticleSim` 整段在 `#[cfg(feature = "cpu-sim")]` 下（`lib.rs:15-32`），native `cargo test` 默认不编译该 feature；`wasm-bindgen-test` 未配置，`tests/three-renderer.test.ts` 的 `CpuParticleSim` 全是 mock（`:144,700` 等）。因此构造器、`update`、`vertices`、`particle_count`、`set_frame_count`、`Result`/panic 出口都**没有被真实执行过**；P0-1/P0-3 这类缺陷无法被现有测试发现。
2. **没有非法 JSON 用例**：所有 `parse_particle_spec` 调用都是合法 JSON；`parse_override_rejects_empty_and_invalid`（`particle_override_test.rs:222-229`）只覆盖 override，未覆盖 spec。至少应加 `#[should_panic]`/`Result` 错误用例（修 P0-1 后改为断言 `Err`）。
3. **没有非有限/极端数值用例**：无 `"inf"`/`"NaN"`/`1e39`/负数 `maxcount`/`u32::MAX`/超长 `starttime` 的解析与运行测试；`particle_test.rs:24-33` 的 `vector_fields_do_not_nan` 只断言两个真实夹具的有限值，不覆盖恶意输入。
4. **没有 `maxcount=0` 的发射路径测试**：`particle_stagger_test.rs:218-231` 只断言 `prewarm` no-op，没有断言/记录「后续 `update` 也永不发射」这一（与文档冲突的）行为；也没有「缺 `maxcount`」的端到端用例。
5. **没有角度 wrap 的极端值测试**：`particle_operator_lwe_test.rs:244` 只测 `rot=3→7→wrap`，没有 `1e30`/`inf`/大负 `drag`；P0-3 不会被抓到。
6. **`randomframe` 帧数没有 >4 的用例**：`sim.rs:1340-1393` 的 `mk()` 虽设 `spritesheet_frames=8`（`:1376`），但只断言 randomframe 帧固定、sequence uv 推进；`sim.rs:1772` 的 `frame` 断言反过来锁死了 `0..4` 的错误行为。也没有 `set_frame_count` 在 prewarm 之后的顺序测试（P1-1）。
7. **没有 `particle_count` 与 `vertices().len()` 的契约测试**：`particle_sim_test.rs:53-55` 只测 `build_instance_vertices().len() == particles.len()*16`，没有从 wasm 导出的 `particle_count()`；`lib.rs:70` 的 ×10 文档错误因此无人发现。
8. **没有 `dt` 边界测试**：`update(0)`、负数、NaN、超大 dt 均无；P2-2 不会被抓到。
9. **`prewarm` 的算子前滚只测了 movement**：`particle_stagger_test.rs:131-160` 用「无重力、固定速度、仅 movement」验证 `pos += vel*age`，没有覆盖 `oscillateposition`/gravity/drag/turbulence，P1-3 无测试。
10. **全局 RNG + 复位导致并行 flake**：见 P2-10；这是测试质量问题，不是产品行为。
11. **CI 不跑 `cargo test`**（已知，`AGENT.md`/p0-release-done 已记）：上述缺口不会在发布门禁暴露；本次不重复计为缺陷，但建议至少把 `cargo test` 与一个 wasm 实例化冒烟加入发布 workflow。
