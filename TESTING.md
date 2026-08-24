# @dsh-use/wallpaper-engine 测试与卸载文档

本文档用于插件安装后的验收测试，以及不好使时的完整卸载。适用环境：DSH Web GUI（`http://127.0.0.1:3080`）、Node ≥ 18、ESM-only、pnpm。

---

## 1. 前置条件

| 项目 | 要求 |
|---|---|
| 安装 | 已在 profile 的 `package.json` 登记依赖与 bundles，已在 `cordis.patch.yml` 写入 insert 配置，并执行过 `pnpm install` |
| Wallpaper Engine 资源 | `wallpaperDir`（cordis.patch.yml 的 `config.wallpaperDir`）指向真实 workshop 目录（默认 `D:/Steam/steamapps/workshop/content/431960`），且目录下有至少一个壁纸（含 `project.json`） |
| 浏览器 | 支持 WebGL 的现代浏览器（Chrome/Edge 推荐），DevTools 可开 Performance |
| 已重启 harness | 修改 bundle / cordis.patch.yml 后必须**重启 harness 进程**（仅刷新页面不生效，host 侧组合在启动时确定） |

---

## 2. 测试文档（验收用例）

### 2.1 启动冒烟测试

| # | 步骤 | 期望结果 | 失败表现 |
|---|---|---|---|
| S1 | 重启 harness，打开 `http://127.0.0.1:3080` | 页面正常进入，**不出现** "Failed to load plugins" | 出现红色加载失败页 → 见 §2.4 排查表 |
| S2 | 观察页面右下角 | 出现标题为「切换壁纸」的 `WP` 浮动按钮 | 没有按钮 → 客户端 `apply → bootstrap` 未跑通 |
| S3 | 打开 DevTools Console | 无未捕获异常；无 `invalid plugin ... received object` 类报错 | 有该报错 → 客户端 bundle 仍是旧版（未重新打包/未 install） |

### 2.2 功能验收用例

| # | 用例 | 步骤 | 期望结果 |
|---|---|---|---|
| F1 | 壁纸列表 | 点击 `WP` 按钮展开面板 | 显示壁纸缩略图网格（含 EVA / 视频 / 图片等）；面板默认收起，点击展开、再点收起 |
| F2 | scene 壁纸（Three.js 实时渲染） | 选择 EVA（workshop id `1280029027`） | 背景由 Three.js 实时渲染动态粒子（灰烬 / 光柱 / 雾在动），主图铺满视口 |
| F3 | 视频壁纸 | 选择任意 `type: video` 壁纸 | mp4 循环播放 |
| F4 | 图片壁纸 | 选择 `type: image` 壁纸 | preview 图显示，Ken Burns 缓慢缩放位移 |
| F5 | scene 渲染失败回退 | 人为断开 `/wallpapers/scene/...` 资源或选渲染失败的场景 | 自动回退 preview 图，不白屏、不抛错 |
| F6 | 透明度 / 模糊设置 | 修改透明度、模糊开关/半径 | 背景实时生效 |
| F7 | 设置持久化 | 修改透明度/模糊/选中壁纸后**刷新页面** | 设置保持；已保存的选中壁纸自动恢复（列表先 load 再 select） |
| F8 | REST 路由 | 直接访问 `GET /wallpapers/list` | 返回 JSON 壁纸列表（非 404） |
| F9 | 资源穿越防护 | 访问 `/wallpapers/media/<id>/...` 或 `/wallpapers/scene/<id>/asset?name=../...` 越界路径 | 拒绝 / 空，不泄露任意文件 |

### 2.3 性能验收

| # | 步骤 | 通过标准 |
|---|---|---|
| P1 | 选中 EVA 后打开 DevTools → Performance，录制 ≥ 10s | 1080p 下 FPS ≥ 30 |
| P2 | 长时间停留 EVA 场景 5 分钟 | 无内存持续上涨导致的卡死 / 页面崩溃 |

### 2.4 故障排查对照表

| 现象 | 可能原因 | 处理 |
|---|---|---|
| `Failed to load plugins` + `invalid plugin ... received object` | 客户端 bundle 返回的是 `{ bootstrap }` 而非 `{ apply }`（旧版 dist） | 重新 `npm run build:client`（或 `node scripts/build-client.mjs`），再 `pnpm add "@dsh-use/wallpaper-engine@file:<绝对路径>"` 强制重链，重启 harness |
| 页面正常但无 `WP` 按钮 | 插件不在 `dsh.profile.bundles`，或 cordis.patch.yml 未 insert | 检查 package.json 与 cordis.patch.yml |
| 壁纸列表为空 | `wallpaperDir` 路径不对 / 无 `project.json` | 核对 config 路径；手动访问 `/wallpapers/list` 看返回值 |
| scene 一直回退 preview | 渲染链路异常 / 资源拉取失败 | Console 看 `/wallpapers/scene/...` 请求与 `renderScene` 报错 |
| 设置刷新后丢失 | settings RPC 失败（`/api/settings.describe` / `settings.update`） | 检查 host 侧 settings 命名空间是否注册（`wallpaper-engine`） |
| 端口占用 / 起不来 | harness 未正常重启 | 杀掉旧进程后重启 |

---

## 3. 卸载方法

### 3.1 标准卸载（推荐）

> 以下路径以 `C:\Users\0009\.dsh\profiles\web` 为例，换成你的 profile 目录。

**第 1 步：编辑 `C:\Users\0009\.dsh\profiles\web\package.json`**

- 从 `dependencies` 删除这一行：

  ```json
  "@dsh-use/wallpaper-engine": "file:E:/code/dsh-use-wallpaper/packages/dsh-wallpaper-engine"
  ```

- 从 `dsh.profile.bundles` 数组删除 `"@dsh-use/wallpaper-engine"` 这一项。

**第 2 步：编辑 `C:\Users\0009\.dsh\profiles\web\cordis.patch.yml`**

- 删除 `- insert:` 那一整块（`id: dsh-wallpaper-engine` 的数组项），恢复为：

  ```yaml
  []
  ```

  （顶部注释可以保留。）

**第 3 步：重新 install，清掉依赖链接**

```powershell
cd C:\Users\0009\.dsh\profiles\web
pnpm install
```

**第 4 步：确认符号链接已删除**

```powershell
Test-Path "C:\Users\0009\.dsh\profiles\web\node_modules\@dsh-use\wallpaper-engine"
```

- 返回 `False` → 已干净卸载。
- 仍返回 `True` → pnpm 未主动删残留，手动删除：

  ```powershell
  Remove-Item "C:\Users\0009\.dsh\profiles\web\node_modules\@dsh-use\wallpaper-engine" -Force -Recurse
  ```

  （若整个 `@dsh-use` 目录为空，一并删除 `node_modules\@dsh-use`。）

**第 5 步：重启 harness**

重启后打开 `http://127.0.0.1:3080`，页面应不再出现 `WP` 按钮、无壁纸背景，即卸载完成。

### 3.2 验证卸载成功

| 检查点 | 期望 |
|---|---|
| 页面无 `WP` 浮动按钮、无壁纸背景 | 客户端插件已卸载 |
| 访问 `GET /wallpapers/list` | 404（host 路由已移除） |
| `node_modules\@dsh-use\wallpaper-engine` | 不存在 |
| Console | 无 wallpaper-engine 相关报错 |

### 3.3 彻底清理（可选）

标准卸载后通常已无影响，以下为「追求零残留」的清理项，按需执行：

| 残留物 | 位置 | 处理 | 风险 |
|---|---|---|---|
| 客户端设置数据 | DSH settings 存储的 `wallpaper-engine` 命名空间（由 host 的 `dsh-settings` 注册） | 一般无害，卸载后不再读取；如需清除，在 DSH 设置面板删除该命名空间数据 | 低 |
| 本地仓库 | `E:\code\dsh-use-wallpaper`（及 `packages\dsh-wallpaper-engine`） | 确认不再需要后整目录删除 | 中：删了就无法再本地重装，需保留源码请勿删 |
| 备份文件 | `C:\Users\0009\.dsh\profiles\web\package.json.bak` | 若为安装时遗留，可删 | 低 |
| 安装时产生的锁文件条目 | `pnpm-lock.yaml`（`package.json` 无该依赖后，`pnpm install` 会自动清理） | 无需手动改 | — |

### 3.4 卸载后如何回滚 / 重新安装

- 卸载只影响 profile 配置与 node_modules 链接，**不会删除**本地仓库 `E:\code\dsh-use-wallpaper`。
- 想重新装：按 README「安装与集成」重新加依赖 + bundles + cordis.patch.yml，再 `pnpm add "@dsh-use/wallpaper-engine@file:E:/code/dsh-use-wallpaper/packages/dsh-wallpaper-engine"` 强制重链即可。
