# 第三方声明

本文件说明 `@dsh-use/wallpaper-engine` 分发的第三方代码、构建期依赖、**壁纸素材边界**与参考实现致谢。本文件随 npm 包分发（`package.json` 的 `files` 含本文件）。

## 1. 摘要

- 本仓库代码为 **MIT**（见 [`LICENSE`](./LICENSE)）。
- 发布包内**不包含**任何 Wallpaper Engine 壁纸、纹理、shader、音视频等第三方素材；这些文件只在运行时从**用户本机**的 WE 安装目录 / Steam 工坊目录读取。
- 打包进 `dist/client.js` 的第三方库共 3 类（three.js、lz4js、quickjs-emscripten 及其变体），均为宽松许可证（MIT / ISC）；`dist/static/quickjs.wasm` 来自 quickjs-emscripten 的 MIT 变体包。
- host 侧运行时依赖（`@deepseek-ai/schemastery`）与 peer 依赖（`@deepseek-ai/cordis`）由 npm / DSH 提供，不内联进本仓库产物。

## 2. 随客户端分发的第三方代码

以下版本与许可证均**实测自本机 `node_modules`**（`node -e` 读各包 `package.json` 的 `version` / `license` 字段），不是凭记忆填写。

| 组件 | 版本 | 许可证 | 分发形态 | 用途 |
|---|---|---|---|---|
| [three.js](https://github.com/mrdoob/three.js) | 0.170.0 | **MIT**（LICENSE：Copyright © 2010-2024 three.js authors） | 打包进 `dist/client.js` | WebGL2 场景 / 粒子 / 对象效果链渲染 |
| [lz4js](https://github.com/Benzinga/lz4js) | 0.2.0 | **ISC**（作者 John Chadwick；包内无独立 LICENSE 文件，以 `package.json` 的 `license` 字段为准） | 打包进 `dist/client.js` | TEXV0005 纹理的 LZ4 解压 |
| [quickjs-emscripten](https://github.com/justjake/quickjs-emscripten) | 0.32.0 | **MIT**（LICENSE：copyright (c) 2019-2024 Jake Teton-Landis） | JS 部分打包进 `dist/client.js` | 壁纸脚本（SceneScript / 文本脚本）沙箱 |
| quickjs-emscripten-core | 0.32.0 | **MIT**（同上） | 打包进 `dist/client.js` | quickjs-emscripten 的核心运行时 |
| [@jitl/quickjs-wasmfile-release-sync](https://www.npmjs.com/package/@jitl/quickjs-wasmfile-release-sync) | 0.32.0 | **MIT** | `dist/static/quickjs.wasm`（503,134 B） | QuickJS 的 wasm 构建（release/sync 变体） |
| @jitl/quickjs-ffi-types | 0.32.0 | **MIT** | 仅类型，不进入产物 | 变体包的 FFI 类型 |
| [QuickJS](https://bellard.org/quickjs/)（bellard/quickjs） | `2025-09-13+f1139494`（由上述变体 vendored） | **MIT**（上游仓库 LICENSE） | 编译为上面的 `quickjs.wasm` | JS 引擎本体 |

> 复现命令（版本 / 许可证）：
>
> ```bash
> node -e "for (const p of ['three','lz4js','quickjs-emscripten','@deepseek-ai/schemastery','@deepseek-ai/cordis']) { const j = require('./node_modules/' + p + '/package.json'); console.log(p, '|', j.version, '|', j.license) }"
> # 变体包是间接依赖：pnpm 下位于 node_modules/.pnpm/@jitl+quickjs-wasmfile-release-sync@0.32.0/...，版本 / 许可证同上可读
> ```

## 3. 不内联、由宿主或 npm 安装的依赖

| 组件 | 版本 | 许可证 | 说明 |
|---|---|---|---|
| [@deepseek-ai/schemastery](https://github.com/deepseek-ai/deepseek-harness) | 3.18.4 | **MIT**（Copyright (c) 2021-present Shigma） | `dependencies`：host 侧设置 schema，运行时从 `node_modules` 解析 |
| [@deepseek-ai/cordis](https://github.com/deepseek-ai/deepseek-harness) | 4.0.1 | **MIT**（同上） | `peerDependencies`：由 DSH 宿主提供，不随本包分发 |
| [react](https://github.com/facebook/react) / react-dom | 18.3.1 | **MIT** | `devDependencies`；client bundle 中标记为 external，运行时由 DSH 的 `__ModuleLoader__` 提供 |

## 4. 仅用于构建 / 测试的依赖（不进入发布产物）

发布包 `files` 只含 `lib`、`dist`、`cordis.patch.yml`、`icon.svg` 与本文件等文档；以下工具链依赖不会被 npm 打包分发：

| 组件 | 版本 | 许可证 |
|---|---|---|
| esbuild | 0.24.0 | MIT |
| typescript | 5.9.2 | Apache-2.0 |
| vitest | 2.1.0 | MIT |
| jsdom | 25.0.0 | MIT |
| @types/node / @types/react / @types/react-dom / @types/three | 22.20.1 / 18.3.31 / 18.3.0 / 0.170.0 | MIT |

各包许可证全文见 `node_modules/<包名>/LICENSE`（或 `package.json` 的 `license` 字段）。

## 5. 壁纸素材边界（重要）

- **版权归属**：Wallpaper Engine 的壁纸、预览图、纹理（`.tex`）、材质 / shader、模型、音视频等素材，版权归**各壁纸作者**与 Wallpaper Engine 开发方所有。本项目不主张任何权利。
- **不重新分发**：本插件**不重新分发**任何第三方壁纸素材。仓库与 npm 包中不包含 WE 内置纹理或工坊壁纸；运行时通过插件注册的本地 HTTP 路由从用户本机的 `<WE 安装目录>/assets/materials`、Steam 工坊目录 `steamapps/workshop/content/431960/<id>/` 读取，仅在本机浏览器内解码显示。
- **`dist/static/` 内容**：只有本仓库 `wasm/` 构建的引擎产物（`we_scene_wasm.js` / `we_scene_wasm_bg.wasm`，MIT）与第三方 `quickjs.wasm`（MIT，见 §2）。
- **历史说明**：2026-09-11 之前曾把 WE 内置粒子/效果纹理复制进 `dist/static/` 打成 `ptex-*.tex` 随包分发，之后已移除并改为运行时读取；`.gitignore` 保留 `dist/static/ptex-*.tex` 规则作兜底，防止再误入仓库或 npm 包。
- **README 演示动图 / 视频**：`docs/videos/*.gif|mp4` 是本插件生产代码在本机真实渲染 / 播放后录制的画面（壁纸素材版权仍归原作者），仅用于展示插件效果。
- **仓库不含参考实现源码**：用于对齐语义的参考实现源码与逆向资料放在本地 `research/`（`.gitignore`，未入库、可能已清理），本仓库与发布包中不包含它们。
- **贡献注意**：PR 不要提交版权不明或不允许再分发的素材；需要测试素材时用本机已有的 WE 库或自制 fixture。

## 6. 参考实现与致谢

以下项目/资料用于**行为与格式语义**的参考（本仓库重新实现，不包含其源码或二进制）：

- **[linux-wallpaperengine](https://github.com/Almamu/linux-wallpaperengine)**（GPL-3.0）—— 场景渲染顺序、效果链 / pass 语义、粒子与合成行为的参考。该实现为 **GPL-3.0**：本项目只借鉴语义，**不复制其代码**（复制会引入 GPL 义务，与 MIT 不兼容）；将来若引入其代码，必须按其许可证处理并更新本文件。
- **开源 Wallpaper Engine 逆向实现**（如 we-layerd / webwallgl 等，仅本地调研参考、未入库）—— `.mdl` / `.pkg` / `.tex` 段布局与相关语义的交叉验证。
- **Wallpaper Engine 安装目录下的明文 shader / 材质**（`<WE>/assets/shaders`、`<WE>/assets/materials`）—— 作为本机运行时数据用于语义校准；`src/client/shader/we-headers.ts` 是本项目按 WE GLSL 方言重新实现的等价头文件，不是对 WE 文件的再分发。
- **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** —— 插件宿主 API、client bundle 约定与设置系统。
- 感谢 [Linux.do](https://linux.do) 社区对本项目的推广与反馈。

## 7. 许可证全文

发布包内不会内联这些库的 LICENSE 注释（`dist/client.js` 由 esbuild 打包），因此这里收录分发所需的许可证全文与版权行；各包 `node_modules/<包名>/LICENSE` 中的原文与之一致。

**MIT 许可证**（适用于 three.js、quickjs-emscripten、quickjs-emscripten-core、@jitl/quickjs-wasmfile-release-sync、@jitl/quickjs-ffi-types、QuickJS、@deepseek-ai/schemastery、@deepseek-ai/cordis、react/react-dom），版权行分别为：

- three.js：`Copyright © 2010-2024 three.js authors`
- quickjs-emscripten / quickjs-emscripten-core / @jitl 变体：`copyright (c) 2019-2024 Jake Teton-Landis`
- QuickJS：`Copyright (c) 2017-2021 Fabrice Bellard`、`Copyright (c) 2017-2021 Charlie Gordon`
- @deepseek-ai/schemastery、@deepseek-ai/cordis：`Copyright (c) 2021-present Shigma`
- react / react-dom：`Copyright (c) Facebook, Inc. and its affiliates.`

```text
The MIT License

Copyright (c) <上述各版权行>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

**ISC 许可证**（适用于 lz4js）：上游 npm 包只提供 SPDX `ISC` 声明（`package.json` 的 `license` 字段）与作者 `John Chadwick`，包内没有 LICENSE 文件或版权行；以下为该许可证的标准文本。

```text
ISC License

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY
SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER
RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF
CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN
CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

## 8. 维护约定

- 依赖升级、新增内联第三方代码、分发形态变化（如新增打包进 `dist/` 的库）时，必须同步更新本文件。
- 本文件中的版本号以 `pnpm-lock.yaml` / `node_modules` 实测为准；升级依赖后请重新核对，不要照抄旧版本号。
- 如发现本文件与仓库实际内容不符，请按 [`CONTRIBUTING.md`](./CONTRIBUTING.md) 提 issue/PR。
