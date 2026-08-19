# Scene 播放完整方案空间（2026-08-19 汇总）

- 前置：`route-comparison.md`（A vs B 路线对比）、`wasm-port-feasibility.md`（WASM 移植否决）、`scene-play-research.md`（24 壁纸实测与根因清单）
- 目标场景：DSH Web GUI（浏览器环境）播放 Wallpaper Engine 全库 scene 壁纸，效果尽量接近 WE 真机。

## 方案总览

| 编号 | 方案 | 视觉保真 | 交互(鼠标/音频) | 成本 | 风险 | 扩展性 |
|---|---|---|---|---|---|---|
| A1 | 修路线 A（WebGL+JS 解析，继续按根因清单修） | 高（受 shader 兼容制约） | ✅ 可实现 | ~10 人日 | 低 | ✅ 新壁纸自动支持 |
| A2 | 渲染层升级 WebGPU（保留 JS 解析） | 更高（BC 压缩纹理原生、compute 粒子） | ✅ 可实现 | 2-4 周 | 中 | ✅ |
| B1 | WASM 移植 we-layerd（C++/Vulkan） | 最高 | ✅ | 数周-月 | 高 | ✅（一次性） |
| C1 | 本地原生渲染服务 + WebRTC/WS 推帧 | 最高（原生引擎） | ✅ 桥接 | 数周 | 高 | ⚠️ 需常驻进程 |
| C2 | WE 真机 + 虚拟显示器抓帧 | 最高 | ❌ 不稳定 | 高 | 高 | ❌ hacky |
| D1 | WE 编辑器导出视频（pkg2mp4） | **100%（WE 真机渲染）** | ❌ 静态 | 每壁纸手动 ~10-20 分钟 | 低 | ❌ 库更新需重做 |
| D2 | linux-wallpaperengine headless 录制 | ~100%（引擎语义相同） | ❌ 静态 | 需 Linux 环境 | 中 | ⚠️ 可脚本化批量 |
| D3 | Steam 官方预览视频兜底 | 中（预览质量非完整壁纸） | ❌ | 极低（抓视频 URL） | 低 | ✅ 自动 |

## 各方案要点

### A1 修路线 A（当前推荐）
- 差距根因已全部定位（`scene-play-research.md` §4）：shader 编译失败 3717 条（CAST3/int 等 3 类）、粒子 A2 未实施、text 不支持、R8/RG88 mask、2 个回归壁纸渲染语义。
- 修复路径：编译失败明细收集 → 粒子 A2 → text A5 → RG88/R8。
- 优点：已运行（24/24 不黑屏、15 动态），增量修复，一次投入全库生效。

### A2 渲染层升级 WebGPU
- 保留 JS 端解析（scene.json/粒子/效果链），渲染从 WebGL2 换 WebGPU（Three.js WebGPURenderer 或原生）。
- 收益：DXT/BC 压缩纹理原生支持（解决 P2 的 DXT 翻转/RG88/R8）；compute shader 粒子（解决 CPU 粒子上限与 operator）；WebGPU 现代管线减少部分 GLSL 兼容问题。
- 注意：WE shader 是 HLSL 风格被预处理成 GLSL，WebGPU 需 GLSL→WGSL 转换（naga/glslang wasm），CAST3/int 等方言问题不会自动消失。

### B1 WASM 移植（已否决，见 wasm-port-feasibility.md）
- we-layerd 的 Rust 壳可编译，但渲染引擎是 C++/Vulkan 11.5 万行 → 渲染后端必须重写为 WebGPU，成本数周-月。

### C1 本地渲染服务 + 推帧
- 本地伴生进程（Windows 编译 wallpaper-engine-renderer C++ 引擎，或 Linux 容器跑 we-layerd）渲染 scene，帧经 WebRTC/WebCodecs 推给 DSH 页面。
- 视觉 100%（原生引擎语义）、鼠标/音频可桥接回传。
- 成本：C++ 引擎 Windows 编译适配（Vulkan 离屏渲染）或容器化 + 帧管道开发，数周级；架构复杂度高（常驻进程、生命周期管理）。

### D1 WE 编辑器导出视频（pkg2mp4，fantascene 文档实证）
- 链路：RePKG-GUI 解包 scene.pkg → WE 编辑器导入素材重做壁纸 → 右键"导出 .mpkg 文件" → 重命名 .pkg → RePKG 再解包得到 .mp4（无 BGM，可剪辑合成 sounds/*.mp3）。
- 参考：GXDE-OS/fantascene-dynamic-wallpaper `md/pkg2mp4.md`。
- 视觉 = WE 真机渲染（100% 保真）；缺点：每壁纸手动 GUI 操作、无交互、固定分辨率、库更新需重做。
- 适用：只对 7 个"应动未动"壁纸做兜底，其余保持 A1 实时。

### D2 linux-wallpaperengine headless 录制
- 用 linux-wallpaperengine 无头渲染 + ffmpeg 录帧成视频，可脚本化批量（24 个壁纸一次性处理）。
- 本机无 Linux 环境（WSL E_ACCESSDENIED、Docker 引擎不可用），需先解决环境。

### D3 Steam 官方预览视频兜底
- Steam 商店/workshop 页面每个壁纸有官方预览视频（WE 官方渲染）。
- 对渲染失败的壁纸回退到预览视频（比静态 preview 图好得多），实现成本极低（抓视频 URL + <video> 播放）。
- 局限：预览分辨率/时长有限，非完整壁纸效果；但可作为 P1-3（失败兜底）的增强项立即落地。

## 推荐组合（务实路径）

1. **A1 为主**：按根因清单继续修路线 A（成本最低、全库实时、可交互）。
2. **D3 立即可做**：失败壁纸回退官方预览视频，替换现有静态 preview 兜底（一行级改动量级，视觉提升明显）。
3. **D1 作为"应动未动"壁纸的兜底备选**：若 A1 修复后仍有壁纸效果不达标（如 2011060960/3743126786 渲染语义债务），对个别壁纸走 pkg2mp4 视频化。
4. **A2/C1 为远期选项**：若 A1 到达上限仍不满足，优先考虑 A2（WebGPU 升级，成本 2-4 周），C1（本地服务推流）作为最后手段。

## 参考仓库

- fantascene-dynamic-wallpaper（pkg2mp4 教程）：https://github.com/GXDE-OS/fantascene-dynamic-wallpaper
- waywe-rs（Rust/Wayland 新实现）：https://github.com/hack3rmann/waywe-rs
- RePKG-GUI（解包工具）：https://github.com/M0rtzz/RePKG-GUI
