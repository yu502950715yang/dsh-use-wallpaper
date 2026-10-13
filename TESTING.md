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

### 2.5 渲染 e2e：隔离对象 RT 分辨率（`npm run e2e:isolated-rt`）

`e2e/verify/verify-isolated-rt-sharpness.mjs`：自起 http server + headless Edge（裸 CDP，不用 playwright）+ esbuild 打包 harness，渲染 8 张真实壁纸，逐隔离对象断言**结构性判据**（= 素材侧可独立算出的那批）—— RT 长边 === 素材侧独立算出的期望、`rtPx ≥ 屏占位像素`（只升不降）、满屏背景 `samples=0` / 其余 `samples=4`、mip 与「RT 长边 > 屏占位长边」一致；**运行期量**（同属判据，但不是素材侧算出来的）另有 FPS ≥ 30、无失败类告警；另加**遮罩槽口径**判据（脚本头判据 [8]，探针 `window.__fxResProbe()`）：① 每个效果 pass 材质的 `g_TextureNResolution` 满足 `|z/x − 1| < 1e-6`（**对全部 8 张、全部槽无条件生效**；探针无数据 ⇒ **判 FAIL**，绝不静默跳过）；② `.x` === 探针读到的实际上传尺寸 `texImage[0]`（偏离 1 的槽数必须为 0；不可比的行 —— `texImage` 为 null、`x ≤ 0` 或 `texImage[0] ≤ 0` —— 排除，零可比槽判 FAIL，与 ① 的零样本策略同精神）；另对「魔兽之门」（`1922570576`）断言 2500×1200 遮罩槽已绑定且口径为 1 —— 该素材是该张专属，**其余 7 张打印显式 `SKIP`**（不计 PASS 也不算 FAIL，不是静默跳过）。偏离条数与 1–2 个示例仍写进 `metrics.json` 的 `fxResProbe.xOverTexImage` 供诊断。基线图存在时再判**锐度双判据**：全图 Laplacian 均方比 ≥ 2.0 **且**逐 96×96 块「梯度/对比度」比中位数 ≥ 1.05。

| 项 | 说明 |
|---|---|
| 命令 | `npm run e2e:isolated-rt`（= `node e2e/verify/verify-isolated-rt-sharpness.mjs`） |
| 范围 | 缺省串行跑固定清单 **8 张**：`1922570576`（魔兽之门）/ `3743126786`（GTR）/ `3765967112`（Crimson）/ `2911105183`（Subway）/ `1429403119`（Orange）/ `2011060960`（Eva 01）/ `2132420420`（Dva女警）/ `1968789468`（Fantasy Sky Mantis）；`--id=<id>` 单跑，只接受这 8 个 id（别的 id 直接报错退出 1；`--id=` **空值**同样报错退出 1，不再静默跑全清单） |
| 耗时 | 整脚本约 **80 s**（8 张，含开头把 `src/` 现编成 tsc 产物）；单张 `--id=<id>` 约 **11 s**（页面与素材都在本地） |
| GPU | **必须真 GPU**：`--gpu` 与省略等价；显式 `--swiftshader` 时 FPS 判据降级为 SKIP（软件光栅化的数字无意义） |
| 必须串行 | **不得并行跑多份**（也不要与其它 e2e 同时跑）：harness 的 HTTP 端口（`httpPort(9813)`）、CDP 端口（`9228`）与 Edge `--user-data-dir` 全部固定 ⇒ 并行会连到别的实例的页面（实测过「读到没有 `__ready` 的空页面」） |
| 被测产物 | **当前 `src/` 现场用仓库自己的 `tsc` 编译出的产物**（输出到 gitignored 的 `e2e/.out/isolated-rt/lib`，harness 的 `lib/client/*` import 被 esbuild 重定向过去）—— 入库的 `lib/` 可能落后于 `src`，不重定向就会拿旧实现验收（详见设计文档 §5 的 R31） |
| 其它参数 | `--baseline-dir=<dir>`（缺省 `e2e/.out/isolated-rt/baseline/`）、`--workshop=`、`--assets=`、`--port=`、`--cdp-port=` |
| oracle 自检 | `--selftest`：只跑素材侧 oracle 的纯函数断言（变换字段 `{value:"…"}` 解析、size/scale 缺省、kind 兜底、精灵表回退、视频两态 mip），**不建 tsc 产物、不起 Edge、不需要素材**，16 条全过 exit 0 |
| 产物 | 脚本写 `e2e/.out/isolated-rt/metrics.json` 与 `shots/<id>.png`（gitignore 内）；目录里的 `run-*.log` 是外壳重定向留的档（脚本自己不写日志文件） |
| 退出码 | 0 = 判据全通过；1 = 有判据失败或脚本异常（是门禁，不是日志） |

**清单与判据作用域（A2 扩展，2026-10-12）**：清单从 5 张扩到 **8 张**，新增的 3 张都来自遮罩 UV 修复的逐纹理审计（`docs/superpowers/specs/2026-10-12-mask-uv-npot-design.md` §4）：

| id | 名称 | 为何加入 |
|---|---|---|
| `2011060960` | Eva 01 | 该张 **11 个遮罩**变更（`waterripple` / `pulse` / `shake` 等；该张唯一**不变**的 NPOT 遮罩是 `blur_combine_mask`）+ NPOT 背景 `53.tex`（3440×1440 / alloc 4096×2048）—— 修复前 `.z/.x` 偏 1.1907，是本次修复**覆盖面最大**的受累壁纸 |
| `2132420420` | 守望先锋 - Dva女警 | 1 个遮罩变更 + 全屏 4K 背景（3840×2160 / alloc 4096×4096） |
| `1968789468` | Fantasy Sky Mantis | 背景 `wallhaven-2ew3pm.tex` 变更、**4 个遮罩不变** ⇒ 作为「不变那批」的对照样本 |

- **判据①（所有槽 `|z/x − 1| < 1e-6`，零样本判 FAIL）对全部 8 张、全部槽无条件生效**（实测 357 槽 = 21+65+8+88+80+58+10+27）。
- **判据②（2500×1200 遮罩存在性）只对 `1922570576` 生效**，其余 7 张打印**显式 SKIP**（不计 PASS、不计 FAIL，也不静默）。

**采基线**（锐度判据要和「实现前的同机截图」比；脚本头部注释里的那一行，逐字）：

```powershell
git checkout b21b1ac -- src/; node e2e/verify/verify-isolated-rt-sharpness.mjs --gpu; Copy-Item e2e/.out/isolated-rt/shots/*.png e2e/.out/isolated-rt/baseline/; git checkout HEAD -- src/
```

- `b21b1ac` = 本特性第一个提交 `cab0ab7` 的父提交。撤下实现后结构性判据会**全红、退出码 1**，但截图照出；采完**必须** `git checkout HEAD -- src/` 恢复并重跑一次确认变绿。
- ⚠️ **不要用 `git stash`**：实现已经提交，工作树里 `src/` 没有本地改动，`git stash push -- src/` 是 **no-op**（实测打印 `No local changes to save`，撤不掉实现）。
- 缺 `<id>.png` 时脚本**明确打印 SKIP**（既不计 PASS 也不算 FAIL），此时承重判据仍是结构性那几条。

**`[perf]` FPS 探针怎么读**：`__fpsProbe(5000)` 统计 5000 ms 内真实 rAF 回调次数（返回 `{fps, frames, ms}`）—— `npm run e2e:textclock` 打印成 `[perf] renderer: …` / `[perf] {"fps":60,"frames":301,"ms":5016}`，本脚本打印成 `FPS=60（frames=301）`。本机 60 Hz vsync 是**天花板**（`CurrentRefreshRate 60`）⇒ 这个数字只能当「有没有跌破」的**地板**（判据 30），**测不出 60 以上的余量**，也不覆盖低端 GPU / 4K 屏；`--swiftshader` 时判据自动 SKIP。另外 `e2e` 依赖 service 子进程与 headless Edge，受限沙箱下会起不来（见 `AGENT.md` §5.13）。

### 2.6 渲染 e2e：文本时钟层（`npm run e2e:textclock`）

`e2e/verify/verify-text-clock-layer.mjs`：只对「魔兽之门」`1922570576` 的文本层（scene 对象 778「3D Clock」= 右下角 LED 数码时钟）做真实渲染验证（自起 http server + headless Edge 裸 CDP + esbuild 打包 harness，渲染**入库 `lib/`**）。判据 **11 项**（脚本头 [1]–[5] 展开）：生产装配产生文本层 / 修复前装配不产生 / quad 落在右下角 / 文本画布画出白字 / 字体命中引擎目录 `<WE>/assets/fonts/CursedTimerUlil-Aznm.ttf` / 字形 alpha 未压淡 / 屏幕能读到白字 / 隐藏后右下角变暗 / **文本层贡献显著高于噪声地板（[9]）** / 差异不出 quad / 恢复显示后回到噪声地板（[10]）。

| 项 | 说明 |
|---|---|
| 命令 | `npm run e2e:textclock`（= `node e2e/verify/verify-text-clock-layer.mjs`），真机加 `--gpu` |
| 参数 | `--id`（缺省 `1922570576`）、`--gpu`、`--teeth`、`--workshop=`、`--assets=`、`--port=9813`、`--cdp-port=9228` |
| 必须串行 | 端口 9813 / CDP 9228 / `--user-data-dir` 全固定 ⇒ **不得与其它 e2e 并行**；单次约 15–20 s |
| 依赖 | 本机素材（workshop 壁纸 + WE 安装目录）⇒ **未加进 `ci.yml`**（CI 上只跑 colorBlend） |
| 退出码 | 0 = 11 项全过；1 = 有判据失败或脚本异常 |

**噪声地板口径（2026-10-13 重标定）**：判据 [9] 的分母**不再是文本 quad 自身的逐帧抖动** —— 该 quad 压在会动的水面上（「效果遮罩 UV 修复」把水波纹放回湖面后，quad 内逐帧 `changedRatio` 由 0.12 升到 0.46–0.56），拿它当分母等于把合法背景动画当噪声（实测比值在 1.72×–8.06× 之间跳）。现在地板取自**同 y 带、沿 x 镜像**的等宽等高对照区（脚本内 `floorBox`，无文本、背景同类），且与 A/B **同一跳 / 同一对截图** ⇒ 时空口径与信号对齐；实测量级 **3.4–4.1k px**（quad 自身 13–14k px），阈值 **5×**（沿用原判据、未调；实测 12 次正常态 **7.22–8.54×**、5 次「文本层缺失」态 **3.52–3.75×** ⇒ 它落在两组分布之间，余量 ≥1.44× / ≥1.33×）。判据 [10] 的分母保持 quad 内两个「文本可见」帧的差异（分子分母同区域 ⇒ 合法动画在两边同时出现、天然抵消），倍率 3 → 2。`--teeth` 是标定自检：额外在「文本层缺失」装配下测同一 quad 的 A/B，断言它**仍达不到** [9] 的阈值（该模式 exit 0 时共 12 项全过）。实测证据见 `docs/fixes/conventions-details.md` §5.45。

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
