# @dsh-use/wallpaper-engine

[![dsh-plugin](https://img.shields.io/badge/GitHub%20topic-dsh--plugin-1f6feb)](https://github.com/topics/dsh-plugin)
[![DeepSeek Harness](https://img.shields.io/badge/DSH-DeepSeek%20Harness-4b8bbe)](https://github.com/deepseek-ai/deepseek-harness)
![license](https://img.shields.io/badge/license-MIT-green)

把 **Wallpaper Engine 壁纸**带到 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的 Web GUI：扫描 Steam workshop 壁纸库，在浏览器里渲染 **scene（场景）壁纸**、播放**视频壁纸**、加载 **web 壁纸**，其余回退 **preview 图 + Ken Burns**。不依赖 Wallpaper Engine 运行时，纯浏览器原生能力 + three.js + Rust/wasm 粒子模拟。

> **当前主渲染路径 —— three.js 播放器**：scene 壁纸由 **three.js** 在浏览器实时渲染（背景图层 + 粒子系统）；粒子的**模拟**在 Rust/wasm（CPU）里按 linux-wallpaperengine / WE 语义逐帧推进，**渲染**交给 three.js（`InstancedBufferGeometry` + `ShaderMaterial` billboard）。旧的 Rust/wgpu（WebGPU）渲染器（`wasm-renderer` + `particle_pass`）保留为**备用路径**（默认不再走）。其余壁纸类型分别走视频 / web / preview 回退。

---

## ✨ 特性

### Scene 壁纸（three.js 主路径）

- **three.js 播放器**（`src/client/threejs-player.ts`）：
  - **背景图层**：每个 `image` 对象 → `Mesh`（`PlaneGeometry` + `MeshBasicMaterial`），按 `we_to_three`（场景中心化、y 不翻）定位，`scale`/`alpha`/`brightness` 与 WE 语义一致；`renderOrder=0`、`depthWrite=false`。
  - **粒子系统**：每个 `particle` 对象 → `InstancedBufferGeometry`（每粒子 4 角点 billboard，`ShaderMaterial`），实例属性 `particlePosition/Size/Uv/Color/Alpha` 按 **spec 的 `maxcount` 一次性预分配**（避免 three r170 `_maxInstanceCount` 首帧锁存导致层不绘制），运行期只更新 `instanceCount`。
  - **粒子顶点/片元 shader**：billboard（`pos + corner*halfSize`）、`gl_Position.z=0`（2D，避免正交视锥裁剪）、多帧 sprite uv 切片（`frameCount` + cols/rows 网格）、纹理 alpha 遮罩（有纹理 `shape=texel.a`、无纹理软圆盘）、`softness`、additive/alpha 混合。
  - **渲染循环**：`renderer.setAnimationLoop`（`dt` = `performance.now` 差分 clamp 0.1s）→ 逐 `CpuParticleSim.update(dt)` → `updateParticles` 刷新缓冲 → `render`；帧体 `try/catch` **异常自愈**（three 的 RAF 一次异常会永久停摆）。
  - **相机/尺寸**：cover 正交相机（按**窗口宽高比**，非场景比例）`setSceneSize(场景尺寸)`；`canvas.width/height = 视口逻辑尺寸 × devicePixelRatio`（HiDPI 清晰、1:1 不拉伸）。

- **粒子模拟**（Rust/wasm，`wasm/src/particle/`，经 wasm-bindgen 暴露 `CpuParticleSim`）：
  - 照 linux-wallpaperengine `CParticle` 语义实现：`emitter`（`boxrandom` 逐轴 vec3 / `sphererandom` 球壳 cbrt）、`initializer`（sizerandom `min + t^exp*(max-min)`、lifetime/velocity/color/alpha/rotation/angularVelocity/turbulent）、`operator`（movement 重力/阻力、angularMovement 消费 `angular_vel`、alphaFade 梯形、size/alpha/colorChange、turbulence、oscillateAlpha/Size/Position、寿命 compaction）。
  - **错落稳态（`prewarm`）**：启动时按 `min(maxcount, ceil(rate×平均寿命))` 铺入带**随机出生相位**的粒子，避免"一批同时下落、同时消失"。
  - `build_instance_vertices()` 输出每粒子 `[pos3, size, uv2, color3, alpha]`（10 浮点）喂给 three.js。

- **纹理/材质解码**（`src/client/tex-loader.ts`）：
  - `TEXV0005`：LZ4 解压；支持 **RGBA8888 / DXT1/3/5 / RG88 / R8**（RG88→`vec4(r,r,r,g)`、R8→`vec4(1,1,1,r)`，与 wasm 的 `r8_to_rgba_white_alpha` 对齐）。
  - **2 的幂填充裁剪**（`cropToMap`）：mip 记录的是 2 的幂上传尺寸，按头部逻辑内容尺寸裁剪（EVA 4096×2048→2400×1555），避免背景只占左上角、右侧露黑。
  - **DXT 用 mip0 全分辨率 + `LinearFilter`**（不用 mipmap 过滤），避免大尺寸压缩纹理被三线性 mip 过滤糊化。
  - **sprite 精灵表**：解析 `TEXS000x` 段得到帧数与网格（如火把/雾 1024×1024 = 8×8=64 帧），shader 二维网格切片。
  - 行序统一（`flipRows` / DXT 块行 `flipCompressedRows`）。

- **WE 语义对齐**（本轮与桌面 WE 真机逐像素对拍修正）：
  - **混合模式按材质 json 的 `passes[0].blending`**（`add`/`additive` → 加法），不再从材质文件名猜（此前导致 DK 等 additive 层被当普通混合 → 黑方块/全屏泛光）。
  - **粒子按对象 scale**：粒子局部坐标与 quad 尺寸乘**本对象真实 scale**（WE `mvp = viewProj×translate×rotate×scale`）。
  - **`sizerandom` ÷2**：spec 存的是编辑器值的一半（`p.size` 为整宽），不除会全壁纸粒子 2 倍大；`sizerandom.exponent` 缺省 1.0（黑神话显式 2）。
  - **`emitter.directions` 缺省 `(1,1,0)`**（lwe 语义；缺省零向量会让粒子全堆在同一点）；`distancemin/max` 逐轴 vec3。
  - **y 约定**：`origin.y - sceneH/2` + emitter 局部 `+y` 朝上（与桌面 WE 实测一致）。
  - **闪烁**：`oscillatealpha` 等算子接线，星点/火光按 spec 振荡。

- **回退链**：
  ```
  three.js 播放器（背景 + 粒子）
      │ 模块加载/创建失败、渲染 0 内容
      ▼
  预览图回退（preview + Ken Burns，永不白屏）
  ```
  旧的 wasm/WebGPU 渲染器（`wasm-renderer` + `particle_pass`）保留为备用（`createFallbackSceneRenderer`），默认不启用。

### 其余壁纸类型

- **视频壁纸**：`mp4` 循环播放。
- **Web 壁纸**：以沙箱 iframe 加载 `index.html` 及其静态资源。
- **图片壁纸**：preview 图 + Ken Burns 缩放。

### 易用性

- 壁纸目录与引擎目录**不写死**：设置 → 壁纸 面板可自动探测（Steam 注册表 + `libraryfolders.vdf` + 常见路径，`/wallpapers/probe`）或手动填写，settings 热更新，无需重启 harness。
- 壁纸切换入口在 **DSH 设置对话框侧边栏「壁纸」菜单**（`settings.section` slot 注册）。
- 透明度 / 模糊 / Ken Burns 实时调节并持久化（经 DSH settings RPC）。

---

## 🗺 已知限制 / 后续

- **GPU（wgpu）备用粒子路径未同步**若干修正（其 uniform 仍是单标量半径；three/CPU 路径才完整逐轴）。
- **粒子暂不渲染旋转**（three 实例流为 10 浮点、不含 rotation → 花瓣不翻滚/倾斜）。
- **桌面真机亮度差 ~15%**（色彩管线观感，与 `outputColorSpace=LinearSRGB` 相关）。
- **`boxrandom` 之 GPU 路径**、**效果链 / SceneScript / 文本 / 音频可视化**等仍在迁移中（JS 侧源码与单测保留）。
- 平台仅 Windows 实测。

---

## 🚀 安装

插件为**单包仓库**，仓库根 `package.json` 声明 `dsh.bundle`（`cordis.patch.yml` 自动注册）与 `dsh.client`。构建产物 `lib/`、`dist/` 已随仓库提交，安装时无需本地构建。

### 方式一：本地开发调试（`file:`，推荐本地改码）

在 DSH 的 `web` profile 目录（如 `C:\Users\<user>\.dsh\profiles\web`）执行：

```bash
pnpm add "@dsh-use/wallpaper-engine@file:E:/code/dsh-use-wallpaper"
pnpm install
```

### 方式二：从 GitHub 安装（推荐分发）

```bash
dsh plugin --profile web add github:yu502950715yang/dsh-use-wallpaper
dsh plugin --profile web install
```

> 安装后 bundle 由 `cordis.patch.yml` 自动注册，**不要**再手动插入 profile 的 `cordis.patch.yml`（重复 insert 会报 `duplicate loader entry id`）。

### 方式三：npm（若发行到 npm registry）

```bash
dsh plugin --profile web add "@dsh-use/wallpaper-engine"
```

**改代码后刷新到 profile**：profile 以 `file:` 快照复制，pnpm 通常不刷新；可靠方式是把构建产物复制进 profile：

```powershell
$src = "E:\code\dsh-use-wallpaper"
$dst = "$env:USERPROFILE\.dsh\profiles\web\node_modules\@dsh-use\wallpaper-engine"
Copy-Item "$src\lib\*"  "$dst\lib\"  -Recurse -Force
Copy-Item "$src\dist\*" "$dst\dist\" -Recurse -Force
```

> **⚠️ 客户端 bundle 必须重启 DSH**：DSH 在插件激活时把 `dist/client.js` 一次性读入内存快照，`/plugins` 响应带 `Cache-Control: immutable`——**只刷新浏览器不够**，需**重启 `dsh web` 进程** + 浏览器强刷（Ctrl+Shift+R）才会命中新 bundle。

---

## 📦 前置条件

| 项               | 说明                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------- |
| 平台支持         | **当前仅适配 Windows**，macOS 尚未测试                                                   |
| DeepSeek Harness | 需 `dsh web` / `web` profile（插件面向 DSH Web GUI）                                     |
| Wallpaper Engine | **建议**已装上（Steam，workshop 内容目录 `workshop/content/431960`）。提供 scene / 视频来源 |
| 浏览器           | 现代浏览器（Chrome / Edge 推荐，需 WebGL2）。scene 壁纸走 three.js；不支持时回退 preview |
| Node             | ≥ 18（仅开发/构建时用，运行时由 DSH 宿主加载）                                           |

---

## ⚙️ 配置

在 **设置 → 壁纸** 面板（侧边栏「Wallpaper 壁纸」菜单）：

- **壁纸目录 `wallpaperDir`**：Steam workshop 壁纸目录（自动探测或手动填写）。
- **引擎目录 `weAssetsDir`**：Wallpaper Engine 安装目录（供 WE 内置粒子纹理读取）。
- 透明度 `overlayOpacity`、模糊 `blurEnabled` / `blurRadius`、Ken Burns 开关、选中壁纸 `selectedWallpaperId`。

优先级：用户设置 > profile `cordis.patch.yml` 的 `config` > 缺省（空）。

---

## 🖱 使用

1. 重启 `dsh web`，打开 `http://127.0.0.1:3080`。
2. 打开 DSH **设置对话框 → 侧边栏「Wallpaper 壁纸」菜单**，展开缩略图网格并选择。
3. 选择壁纸：scene 壁纸由 three.js 实时渲染（背景 + 粒子）、视频循环播放、图片 Ken Burns。
4. 验证：`GET /wallpapers/list` 返回 JSON 壁纸数组；Console 出现 `[three] scene loaded id=… background=N particleLayers=M`（`M≥1` 表示粒子层已建）。

---

## 🧹 卸载

```bash
dsh plugin --profile web remove "@dsh-use/wallpaper-engine"
dsh plugin --profile web install
# 重启 dsh web
```

---

## 🛠 构建与开发

```bash
cd <本仓库根>
pnpm install
pnpm run build          # tsc -p tsconfig.json → lib/（host 编译，strict）
pnpm run build:wasm     # cd wasm && wasm-pack build --target web --release --features render → wasm/pkg/
pnpm run build:client   # node scripts/build-client.mjs → dist/client.js + 复制 wasm 与粒子纹理到 dist/static/
pnpm test               # vitest run（node + jsdom 双环境）
```

> - 构建顺序：改过 `wasm/`（Rust）必须先 `pnpm run build:wasm` 再 `pnpm run build:client`（client 复制的是 `wasm/pkg` 产物）。
> - `build:client` 会从本机 WE 安装目录（`WE_ASSETS_DIR` 可覆盖）复制内置粒子纹理到 `dist/static/ptex-*.tex`；纹理不入库，运行时缺失则粒子回退纯色/软圆点。

---

## 🧩 架构一览

```
src/host/     Node 侧（Cordis 插件）：扫描壁纸目录、解包 PKGV0001、HTTP 路由、Steam 路径探测、settings
src/client/   浏览器侧（esbuild 打包为 dist/client.js）
              ├─ threejs-player.ts    three.js 播放器（背景 Mesh + 粒子 InstancedBufferGeometry/ShaderMaterial）
              ├─ three-renderer.ts    生产接线（loadSceneToThree + resize/dpr + 材质混合解析）
              ├─ tex-loader.ts        TEXV0005 解码（RGBA/DXT/RG88/R8 + 幂填充裁剪 + sprite 帧 + 行序）
              ├─ wasm-renderer.ts     wasm 渲染胶水（旧 WebGPU 路径，保留备用）+ 生产资产解析
              ├─ scene-json/scene-renderer/scene-assets/alignment/visibility  场景解析与几何
              ├─ effect-runner/scene-script/particles/text-object/audio-input/script-patterns  效果链/脚本（部分迁移中）
              └─ index/wallpaper-controller/background-layer/settings/styles  引导、控制、背景层、设置
src/shared/   跨 host/client 类型（WallpaperInfo、SceneDescription、SceneObject 等）
wasm/         Rust 引擎（wasm-bindgen）：lib / coords / scene / tex / particle{sim,spec_to_emitter} / render(wgpu 备用)
scripts/      build-client.mjs（esbuild 打包 + wasm/粒子纹理复制）
tests/        vitest 单测（node + jsdom 双环境）
docs/         开发环境配置（dev-setup.md）；设计文档与实施计划（superpowers/*）
```

---

## 📄 许可与致谢

- 代码：MIT。
- 壁纸、纹理等素材版权归原作者 / Wallpaper Engine 所有，插件只负责在其上渲染，不重新分发第三方素材。
- 格式与行为语义对齐自 [linux-wallpaperengine](https://github.com/Almamu/linux-wallpaperengine) / 开源 Wallpaper Engine 逆向实现。

---

## 🔗 相关链接

- [GitHub 仓库](https://github.com/yu502950715yang/dsh-use-wallpaper)
- [dsh-plugin 主题页](https://github.com/topics/dsh-plugin)
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- [开发环境配置（docs/dev-setup.md）](docs/dev-setup.md)
