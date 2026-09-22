# 开发环境配置

本文档用于在**新电脑上继续开发本插件**（`dsh-use-wallpaper`）。它把写代码、编译、运行验证所需的环境分为两层：

- **开发 / 构建环境**：写代码、编译产物（`tsc` / `wasm-pack` / `esbuild`）必需。
- **运行 / 测试环境**：把插件挂到 `dsh web` 里实际验证效果所需。

> 当前项目**只在 Windows 上做过测试**，macOS 未验证。本仓库没有 `.nvmrc` / `rust-toolchain` / `engines` 等版本锁定文件，因此工具**主版本**对齐即可，若构建报错优先核查文末「常见坑」。

---

## 1. 开发 / 构建环境

| 工具 | 版本 | 用途 |
|---|---|---|
| Node.js | ≥ 18（推荐 20/22） | host 侧 ESM 编译；用 nvm 装 |
| pnpm | ≥ 8（推荐 9） | 本项目是 pnpm workspace，**使用 pnpm 而非 npm** |
| TypeScript | devDependency（^5.9） | `pnpm run build`（tsc strict） |
| Rust（cargo） | edition 2021，最新稳定版 | wasm 引擎 `wasm/` 源码 |
| wasm32-unknown-unknown target | Rust 官方 target | **必须可用**，否则无法编译 wasm。⚠️ `rustup target add` 在本机因镜像 403 失败时，可用 `research/install-wasm32-std.py` 把已下载的组件手工放进 toolchain sysroot（**`rustup target list --installed` 不会显示它，但 `cargo check --target wasm32-unknown-unknown` 能通过**） |
| wasm-pack | 最新 | `pnpm run build:wasm`（`--target web --features cpu-sim`） |
| esbuild | devDependency | `pnpm run build:client` 打包 client |

### 1.1 安装命令（按顺序执行）

```bash
# ① Node + pnpm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install 22 && nvm use 22
npm install -g pnpm@latest wasm-pack@latest

# ② Rust + wasm target
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup target add wasm32-unknown-unknown

# ③ 项目
git clone <你的仓库地址>
cd dsh-use-wallpaper
pnpm install
```

> 若 `rustup target add` 因镜像失败，切换源后重试（见 §4）。

### 1.2 构建命令（顺序不可颠倒）

```bash
pnpm run build          # tsc -p tsconfig.json → lib/（host 编译，strict）
pnpm run build:wasm     # cd wasm && wasm-pack build --target web --release --features cpu-sim → wasm/pkg/
pnpm run build:client   # node scripts/build-client.mjs → dist/client.js + 复制 wasm/粒子纹理到 dist/static/
```

> ⚠️ **顺序**：改过 `wasm/`（Rust）必须先 `pnpm run build:wasm` 再 `pnpm run build:client`。`build:client` 复制的是 `wasm/pkg/` 产物——只跑 `build:client` 会复制到**旧 wasm**（行为不更新）；产物缺失时 `build:client` 直接报错并提示先跑 `build:wasm`。

### 1.3 测试

```bash
pnpm test                 # vitest run（node + jsdom 双环境，约 373 个用例）
cd wasm && cargo test     # Rust native 单测（无 render feature，跑解析/数学模块）
```

---

## 2. 运行 / 测试环境

| 项 | 说明 |
|---|---|
| DeepSeek Harness（dsh） | 需 `web` / `web` profile，插件挂载到 DSH Web GUI |
| Wallpaper Engine（Steam） | **建议安装**（提供测试用 scene / 视频 / web 壁纸源 `workshop/content/431960`；未装则壁纸列表为空） |
| 浏览器 | 支持 **WebGPU** 的 Chrome / Edge（scene 壁纸动画需要；不支持时 scene 回退 preview 图，其余类型不受影响） |
| Windows | 当前仅适配 Windows |

---

## 3. 本地集成到 DSH profile

在**仓库根**执行（`dsh plugin` 会把相对路径锚定到调用目录，所以在别处执行会指向错的路径）：

```bash
dsh plugin --profile web add link:E:/code/dsh-use-wallpaper
```

`dsh plugin` 转发给 profile 目录的 pnpm，之后**自动**把本包追加进 `dsh.profile.bundles`（本包声明了 `dsh.bundle`）——**不要**手改 profile 的 `package.json`，也不要往 profile `cordis.patch.yml` 插条目（重复 insert 报 `duplicate loader entry id`）。

`link:` 是**符号链接**（不是 `file:` 快照复制），所以构建产物直接生效：

```powershell
$i = Get-Item "$env:USERPROFILE\.dsh\profiles\web\node_modules\@dsh-use\wallpaper-engine"
$i.LinkType   # 期望 SymbolicLink / Junction；为空 = 落成实体副本，改用下方兜底复制
```

**改代码后如何生效**：

> - host 侧（`lib/`）→ 需**重启 `dsh web`**：host 侧 HMR `@deepseek-ai/cordis-plugin-hmr` 在 `dsh-base` 里默认 `disabled: true`（*opt-in per profile*）。
> - client 侧（`dist/`）→ **自动热重载**：web profile 始终挂载 `@deepseek-ai/dsh-client-hmr`，每 500ms 轮询每个 client bundle 的 `mtime`/`size`，变化即经 SSE `/plugins/events` 通知浏览器加载新 bundle——无需重启，通常也不用手动强刷。

**兜底（HMR 未生效 / 安装落成实体副本）**：

```powershell
$src = "E:\code\dsh-use-wallpaper"
$dst = "$env:USERPROFILE\.dsh\profiles\web\node_modules\@dsh-use\wallpaper-engine"
Copy-Item "$src\lib\*"  "$dst\lib\"  -Recurse -Force
Copy-Item "$src\dist\*" "$dst\dist\" -Recurse -Force
```

---

## 4. 常见坑（新电脑易踩）

1. **Rust 镜像 403**：安装 wasm target 若报 403，切换源：
   ```bash
   $env:RUSTUP_DIST_SERVER="https://rsproxy.cn"
   rustup target add wasm32-unknown-unknown
   ```
2. **esbuild 需放行构建脚本**：`pnpm-workspace.yaml` 中的 `allowBuilds` 保留：
   ```yaml
   allowBuilds:
     esbuild: true
   ```
   否则 `pnpm run build:client` 可能失败。
3. **wasm 必须是 `--target web`**：用成 `--target module` 会导致 wasm 静默失败、运行时一直回退 JS 渲染器。`build:wasm` 已用正确参数，除非手动执行 `wasm-pack` 否则勿改。
4. **构建顺序**：改 Rust 后必须 `build:wasm` 再 `build:client`（见 §1.2）。
5. **测试沙箱**：vitest/esbuild 依赖子进程（命名管道），在受限沙箱下会报 `spawn EPERM`——需完整权限运行。

---

## 5. 相关文档

- `AGENT.md`：仓库结构与踩坑记录（改动代码前先读）。
- `docs/superpowers/`：设计文档与实施计划。
- 本文件：新电脑开发环境初始化。
