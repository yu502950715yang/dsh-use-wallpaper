# @dsh-use/wallpaper-engine 测试与卸载文档

本文档用于插件安装后的验收测试，以及不好使时的完整卸载。适用环境：DSH Web GUI（`http://127.0.0.1:3080`）、Node ≥ 18、ESM-only、pnpm。

---

## 1. 前置条件

> 门禁提示：`tests/**` 的类型检查是**棘轮**——`npm run typecheck:tests` 只对新增/加重的类型错误判红；确需放宽时跑 `node scripts/check-known-type-errors.mjs --update` 重建 `scripts/known-type-errors.json`（口径见 AGENT.md §7.11），**只增不放过**。

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

`e2e/verify/verify-text-clock-layer.mjs`：只对「魔兽之门」`1922570576` 的文本层（scene 对象 778「3D Clock」= 右下角 LED 数码时钟，脚本 `showSeconds=true` ⇒ 画面是 `HH:MM:SS`）做真实渲染验证（自起 http server + headless Edge 裸 CDP + esbuild 打包 harness，渲染**入库 `lib/`**）。判据：默认 **20 项**（含牙）、`--teeth` 关掉后 **14 项**。14 项基础判据 = 生产装配产生文本层 / 修复前装配不产生 / quad 落在右下角 / 文本画布画出白字 / 字体命中引擎目录 `<WE>/assets/fonts/CursedTimerUlil-Aznm.ttf` / 字形 alpha 未压淡 / 屏幕能读到白字 / 隐藏后右下角变暗 / **同相位相对分子高于标定下限（[9]，修复轮 4 起为相对口径）** / **同相位基线 ≈0 且内容（墙钟）冻结生效（[10]，修复轮 3 起这一条含两个判定半边）** / 受控推帧生效（[11]） / 强阈值差异不出 quad（[12]，全屏 Δ≥8） / 恢复显示后回到噪声地板（[13]） / 参考区几何有效（[14]）；另 6 项是牙（整层缺失 + 覆盖率 50%/90% + 透明度 50%/90% 各判一次、以及「能检出的最小衰减 ≤50%」）。

| 项 | 说明 |
|---|---|
| 命令 | `npm run e2e:textclock`（= `node e2e/verify/verify-text-clock-layer.mjs --gpu`；**默认已带 `--gpu`**） |
| 参数 | `--id`（缺省 `1922570576`）、`--no-teeth`（关掉牙与衰减扫描，14 项）、`--sweep=<覆盖率列表>` / `--dim=<透明度列表>`（只**追加**扫描档位，牙指定的 0.5/0.1 永远在列）、`--at=HH:MM:SS`（把冻结墙钟钉到该本地时刻 ⇒ 时钟内容可控，用来验尺度无关性；缺省钉在当下）、`--live-wallclock`（**负向对照**，默认不跑：不冻墙钟 + 两次显示帧之间真实前进 1.2 s ⇒ [10] 必须判 FAIL）、`--workshop=`、`--assets=`、`--port=9813`、`--cdp-port=9228` |
| 必须串行 | 端口 9813 / CDP 9228 / `--user-data-dir` 全固定 ⇒ **不得与其它 e2e 并行**；单次约 **29–35 s**（修复轮 4 实测 32.9 / 33.7 / 33.2 / 34.1 s（含牙）+ 29.8 s（`--no-teeth --live-wallclock`）） |
| 依赖 | 本机素材（workshop 壁纸 + WE 安装目录）⇒ **未加进 `ci.yml`**（CI 上只跑 colorBlend） |
| 退出码 | 0 = 本次运行的全部判据（默认 20 项）通过；1 = 有判据失败或脚本异常（整层缺失的整跑版实测 **11 FAIL / 9 PASS / exit 1**，见 `output/final/fix4-whole-run-missing.log`） |

**判据 [9]/[10] 的同相位口径（2026-10-13 修复轮 3 补齐 [10]；**修复轮 4 把 [9] 从绝对阈值改成相对字形足迹口径**）**：`--teeth` 默认跑的那一轮，harness 会把 `requestAnimationFrame` 换进受控队列（只按需推帧）、把动画时钟 `performance.now` 与墙钟 `Date` 一起钉死（生产帧体用 `performance.now()` 差分算 dt、时钟文本用脚本里的 `new Date()` 生成，两者都是逐帧读的）⇒ 「该层显示帧 vs 隐藏帧」除该层可见性外**背景逐像素一致**。**分母** = 同一冻结帧内该层**自身字形足迹** `glyphMask`（`__textGlyphScreenPixels(778)`：把该层纹理按 quad 投影反投到屏幕、按纹理足迹（≈2.7² texel）的 alpha 均值 ≥15 取掩码；只读「纹理 + 几何」⇒ **与覆盖率/透明度注入无关**）；**两个分子**都取**足迹内**的强变化（全屏 Δ≥8 落在足迹外的那部分是它带动的屏幕空间光晕）——① 足迹内 Δ≥8 像素数 ÷ 足迹（**点亮比例**）、② 足迹内亮度总量 ÷ 足迹（**平均亮度**）。阈值 = **`0.65` 且 `88`**；**旧的 `7800 px` / `480000 ink` 绝对阈值已删**（它们随时钟内容整体换挡：最窄内容 `11:11:11` 健康态只有 **4782 px / 338839 ink** ⇒ 双双低于旧阈值、**必然假红**，`output/final/fix4-111111.log`）。实测两帧都隐藏时的**基线 = 0 px**（全屏 Δ≥8 / 全屏 Δ≥2 / 外扩盒 / 三站全为 0），而同一页面里跨帧（相隔数百 ms）测的旧口径背景噪声是 ≈13k px（`samephase-default-*.log` 的 `【对照】跨帧口径（旧）` 行）。**[10] 有两个判定半边（修复轮 3 补齐）**：① 背景残差 `max ≤ 600 px`；② **墙钟冻结生效** `spAA ≤ 60 px`（`spAA` = 两次「显示」帧的 A/A 残差）——修复轮 2 之前第 ② 半只 `console.log` 不进 checks，而墙钟一旦没冻住，内容变化会混进分子（实测 1431 / 2435 px）却顶不穿 7800 px 阈值 ⇒ 可达假绿。**cap = 60 px 的依据**：冻结态 `spAA` 实测恒为 0 px（修复轮 3 连跑 5 次全 0），而**不冻**时实测 **1431 / 2435 px**（修复轮 3 两次）、**4356 px**（修复轮 4 复跑）（`--live-wallclock` 负向对照：不冻 `Date` + 两次显示帧之间真实前进 1.2 s ⇒ 各只跳一个秒位数字；每次都 [10] 判 FAIL、13 PASS / 1 FAIL、exit 1，`output/final/samephase3-live-wallclock{,-2}.log:56`、`output/final/fix4-live-wallclock.log`）⇒ 余量 ≥23.9×（按最小的 1431 px 算）。为什么不是 Δ≥2：该层显示时水面在盒外也有被带动的量化级响应（同一次运行弱阈值 Δ≥2：全屏 39230 px vs 外扩盒内 30221 px，`samephase-default-1.log`），Δ≥8 时盒内值与全屏值**相等**（12813 px = 12813 px ⇒ 盒外 0 px）；修复轮 3 新增 `【对照】盒外` 行给出实测幅度：**盒外逐像素差 maxΔ 3–4**（`samephase3-default-{1,2,3}.log`）⇒ 阈值 8 相对实测 4 是 2×，相对可推上界 7（「Δ≥8 盒外 0 px」）只有 1.14×。**旧「增量口径」（修复轮 1）已废弃**：它的两臂是两次独立渲染，`|W∪T| − |W|` 并不是该层的贡献（实测 16.5k，而该层自身是 30221 px@Δ≥2 / ≈12k px@Δ≥8），阈值被顶到基线之上 ⇒ 部分衰减检不出。**尺度无关性与灵敏度（如实，`--teeth` 每次现算）**：用 `--at` 把冻结墙钟钉到三个差异明显的内容档各跑一次（**同一版本代码**）——`08:08:08`（最宽，足迹 5814 px）/ `10:14:41`（3687 px）/ `11:11:11`（最窄，2559 px）：**全屏分子跨档 3.09×（14752 → 4782 px），而点亮比例只 0.988 → 0.976 → 0.959（跨档 1.03×）、平均亮度 129.8 → 126.7 → 124.3（1.04×）** ⇒ 尺度无关成立，健康态余量 **1.41×–1.52×**（`output/final/fix4-{080808,101441,111111}.log`）。三档下**整层缺失 = 0 px / 0 亮度 ⇒ 必红**（整层缺失的整跑版 **11 FAIL / 9 PASS / exit 1**，`output/final/fix4-whole-run-missing.log`）、**覆盖率 50%**（点亮比例 0.466–0.483）与**透明度 50%**（平均亮度 60.5–62.2）**都判红**（离阈值 1.35× / 1.42×）；透明度衰减靠 ② 抓（像素口径在透明度 0.1 档仍有 0.760–0.776）⇒ 两个半边都不可省。细扫（`--sweep=0.7,…`）只作**边界探索**：本轮三档都给出覆盖率边界 **25%**（0.75 档 0.709–0.733 绿、0.5 档红）⇒ **可靠结论只取牙指定的 50%（覆盖率）/ 50%（亮度）**。判据 [13] 的分母仍是外扩盒内两个「文本可见」帧的差异（分子分母同区域 ⇒ 合法动画天然抵消），倍率 2，并按区域面积**封顶**到 90%（否则 `2·dAA+50` 在 `dAA ≥ 15309 px` 时必然成立 = 恒真）。脚本每次运行都打印 **`lib` 身份摘要**（`lib/client/three-renderer.js`、`lib/client/tex-loader.js`、`lib/host/pkg-reader.js` 的 sha256 前 8 位）⇒ 标定结论可自证是哪份产物。逐次原始数字、扫描表与订正后的历史对照表见 `docs/fixes/conventions-details.md` §5.45 与其引用的 `output/final/fix4-*.log`（修复轮 4 相对口径）与 `output/final/samephase*.log`（轮 2/3 的旧绝对口径，仅作历史对照）。

---

### 2.7 段渲染与帧内快照的验收口径（2026-10-13，未在本轮执行）

本轮的**单测**已覆盖段划分 / 快照时机 / 无消费者零回归（`tests/frame-capture.test.ts`、`tests/threejs-player.test.ts` 的「ThreeScenePlayer 段渲染（frameCapture）」describe 与「最终审查 C2：真实装配链路的帧快照消费者门控（端到端）」describe、`tests/object-effects.test.ts`）；**真机逐像素对拍、9 个叠加次序变化壁纸的目视、性能/显存测量留给 Lead 与用户统一安排**。要跑时的口径：

| 项 | 口径 |
|---|---|
| 改 `src/` 后 | **必须先 `npm run build`**（`e2e/verify/verify-hidpi-object-rt.mjs` 无 src 重定向，否则测的是旧 `lib/`；`verify-isolated-rt-sharpness.mjs` 自带 src 重定向） |
| 零回归对拍 | **同一张壁纸在「注入 `frameCapture` / 不注入」两种配置下对拍**：`--tag=with` → 撤掉 capture 注入 → `--tag=without` → `npm run e2e:compare`；判据 `maxAbs ≤ 1` 且「差 ≥ 2 的像素数 = 0」。⚠️ **旧口径「选不含消费者的壁纸（如 `3793620838`）改动前后对拍」自相矛盾**：`3793620838` 本身在「`renderOrder` 唯一化会改叠加次序」的 9 个 pkg 清单里（`output/blur-analysis/render-order-refactor-survey.md`）⇒ 原理上不可能通过；只有「注入 / 不注入」这条与 `renderOrder` 无关，才对应「**无消费者**零回归」语义。**本轮未执行**（零回归当前只有单测证据，见设计文档附录 A.5） |
| 预期可见变更 | 全库 **9** 个「粒子在前 image 在后」的 pkg（`1429403119` / `2597392171` / `2897292240` / `2911105183` / `2937346640` / `3743126786` / `3765967112` / `3793620838` / `3789452668`）叠加次序改变（对齐 WE，**不得当回归**）；`2897292240` 由白块变水滴。⚠️ **`2597392171` 的 obj#50 不在预期变更内**：效果链的 `_rt_FullFrameBuffer` 消费者按 R6 降级、门控关闭（`ENABLE_CHAIN_FRAME_SNAPSHOT_CONSUMER = false`，见设计文档附录 A.4 ⑧）⇒ 该槽仍留空 + 每槽去重告警，可见效果待 UV 口径验证后再开 |
| 段渲染成本 | **每段一次全场景 `render`**（靠 `visible` 排除其它段）⇒ **O(段数 × 场景）**，不是「每对象只光栅化一次」。实测 `2897292240`（2 个粒子消费者 / 3 段）：每帧 **3 次全场景 render + 2 次 `copyFramebufferToTexture` blit + 1 次 composite 合成**（改动前 1 次 render）；无消费者时仍 1 次（零回归） |
| 性能/显存 | `2897292240`「段渲染开 / 关」的帧时与 `renderer.info.memory.textures/geometries`；退化 > 15% 时把「半分辨率 `frameRT`」列为后续优化 |

---

### 2.8 手工验收清单：scene 实时渲染看护（2026-10-13 Task 5，逐条勾）

> **以下 7 步需要人在运行中的 DSH Web GUI 里操作（DevTools Console + 面板），属于本计划的最后一道人工验收，agent 无法代跑。**
>
> 前置：已 `pnpm run build` + `node scripts/build-client.mjs`，并**重启 harness**（只刷新页面不生效）；壁纸库里至少有一张 `type: scene` 的壁纸。
> 用到的真实入口：`__wallpaperEngine.health()`（当前壁纸的看护快照）、`__wallpaperEngine.retryLive()`（重试实时渲染，等价面板「重试实时渲染」）、`__wallpaperEngine.clearRenderFailures()`（清全部失败记忆，等价面板「清除失败记忆」）；面板位置 = 设置 → 「实时渲染」状态行。

在 DSH Web GUI 里：

1. 选一张 scene 壁纸 → Console 应出现 `[three] scene loaded id=…`，设置面板「实时渲染」状态行显示「实时渲染正常 · 装配 N ms · 首帧 M ms」。
2. 在 Console 执行 `__wallpaperEngine.health()` → 返回 `ok:true` 与 timing。
3. 模拟软失败：Console 执行下面这段（只影响当前页面，不碰磁盘），状态行应显示「上次失败：资源加载中断（本次会话内记忆）」，且 **localStorage 里不应出现 `we:renderfail:` 键**。
   ⚠️ **同一次选择会 render 两次**（首个 canvas 失败后 controller 会用新 canvas 重试一次）⇒ 脚本必须**吃掉两次**：只拦一次的话第二次 render 会成功并清掉软失败，状态行变回「实时渲染正常」，第 4 步的冷却重试也就永不触发（假阴性）。

```js
// 拦两次 scene.json：同一次选择会 render 两次（首个 canvas 失败后 controller 换新 canvas 再试一次）
const raw = window.fetch; let left = 2;
window.fetch = function (u, o) {
  if (left > 0 && String(u).includes('scene.json')) {
    left--; if (left === 0) window.fetch = raw;
    return Promise.reject(new TypeError('Failed to fetch'));
  }
  return raw.call(this, u, o);
};
__wallpaperEngine.select(__wallpaperEngine.health?.()?.wallpaperId || '');
```

4. 冷却后（≥3s）应看到一次自动重选（Console 出现新的 `[three] scene loaded`），且**只重试一次**。
5. 模拟硬失败：Console 执行下面这段（只拦目标壁纸的 `scene.json`，**恒**返回 404；同一次选择会 render 两次，两回都拿到 404）→ 状态行显示「上次失败：拿不到 scene.json（已记忆，重开仍走降级）」，`localStorage.getItem('we:renderfail:<id>')` 有值。

```js
// 硬失败：目标壁纸的 scene.json 恒 404（HTTP 非 2xx = 硬失败，落 localStorage）。把 <id> 换成目标壁纸。
const failId = '<id>';
const raw = window.fetch;
window.fetch = function (u, o) {
  const url = String(u);
  if (url.includes(`/wallpapers/scene/${failId}/asset`) && url.includes('name=scene.json')) {
    return Promise.resolve(new Response('{}', { status: 404, statusText: 'Not Found' }));
  }
  return raw.call(this, u, o);
};
window.__wpHardFailRestore = () => { window.fetch = raw; }; // 第 6 步重试前调用
__wallpaperEngine.select(failId);
```

⚠️ 硬失败记忆与降级结果无关：降级到 `video` / `frame` **不会**清掉 `we:renderfail:` 键（降级成功只代表显示层成功；只有「重试实时渲染」/「清除失败记忆」才会清）。因此第 5 步在任何 scene 上都能看到跨刷新保留的「已记忆」，不必先删帧文件。

6. 先在 Console 执行 `__wpHardFailRestore()` 还原 fetch，再点「重试实时渲染」→ 记忆被清、壁纸重新装配；点「清除失败记忆」→ 所有 `we:renderfail:` 键消失。
7. 重开 App（或强刷页面）→ 若第 6 步没清，仍能看到上次的硬失败记忆。

---

### 2.9 零回归对拍：分支起点 vs 当前工作树（`e2e:compare`）

改动过 `src/client/` 后必须重跑。判据：**两档 dpr 都 `maxAbs ≤ 1` 且「差 ≥ 2」像素数 = 0**（即 `compare-shots` 退出码 0）。

```powershell
# 1) 基准工作树（分支起点 7e30a9f = master 的 v0.7.0）；node_modules 用 junction 共享，不重装
git worktree add .worktrees/before-health 7e30a9f
cmd /c mklink /J E:\code\dsh-use-wallpaper\.worktrees\before-health\node_modules E:\code\dsh-use-wallpaper\node_modules
# 2) 在基准工作树里出 before 截图（缺省壁纸 2683211654、dpr 1,2、冻结相位 5s）
cd .worktrees\before-health; node e2e/verify/verify-hidpi-object-rt.mjs --tag=before; cd ..\..
# 3) 把 before 截图拷回主工作树：compare-shots 只在**一个目录**里找一对同名图
Copy-Item .worktrees\before-health\e2e\.out\hidpi-object-rt\before-*.png e2e\.out\hidpi-object-rt\
# 4) 主工作树先 build 再出 after 截图（verify-hidpi-object-rt 无 src 重定向，用的是**入库 lib/**）
npm run build; node e2e/verify/verify-hidpi-object-rt.mjs --tag=after
# 5) 对拍（两档 dpr 各打一行判据；退出码 0 = 通过）
node e2e/verify/compare-shots.mjs --tag-a=before --tag-b=after
# 6) 收尾：junction 必须先删（否则 worktree remove 会跟着删掉实体 node_modules）
cmd /c rmdir .worktrees\before-health\node_modules
git worktree remove .worktrees\before-health --force
```

- ⚠️ `verify-hidpi-object-rt.mjs` **自身**在该基准上就会 exit 1（它自带的「挂载期 RT 尺寸」断言在 `7e30a9f` 上已 FAIL，前后两轮的值**逐字相同**）⇒ 本项门禁只认 `compare-shots` 的退出码；两个 tag 的退出码应当一致。
- 归档位置：`.superpowers/sdd/2026-10-13-scene-live-watchdog/t5-shots/{before,after}-dpr{1,2}.png`（**本地归档、未入 git**）。
- **视差轮（2026-10-13 Task 5）的基准换成 `6aa5375`**（= `feat/scene-parallax-puppet` 的分支起点，覆盖 Task 1-5 全部改动），worktree 名 `before-parallax`；归档 `.superpowers/sdd/2026-10-13-scene-parallax-puppet/t5-shots/{before,after}-dpr{1,2}.png`。缺省样本 `2683211654` 的 `general.cameraparallax=false` ⇒ 预期逐像素一致（或 ≤1 LSB）。
- **puppet 轮（2026-10-13 Task 8）的基准 = `0a84cbb`**（puppet 特性开工前的最后一个提交），worktree 名 `before-puppet`；归档 `.superpowers/sdd/2026-10-13-scene-parallax-puppet/t8-shots/{before,after}-dpr{1,2}.png`。实测 `dpr=1/2` 均 `maxAbs=1`、「差 ≥ 2」像素 0（`compare-shots` exit 0）；两个 tag 的 `verify-hidpi-object-rt.mjs` 自身都是 exit 1（挂载期 RT 尺寸断言，前后逐字相同）。⚠️ 收尾时该脚本起的 headless Edge **不会自己退出**（profile 落在 `e2e/.out/...` 与 worktree 里）⇒ 删 worktree / 删目录前先按 profile 路径过滤掉这些 e2e 进程（不要动用户自己的 Edge 窗口）。

---

### 2.10 手工验收清单：相机视差（2026-10-13 Task 5，逐条勾）

> **需人在运行中的 DSH Web GUI 里操作（鼠标在窗口内移动 + DevTools），agent 无法代跑。**
>
> 前置：已 `npm run build` + `npm run build:client`，并**重启 harness**（host 侧改动不热重载）后**强刷** GUI。

**验收样本 = `3793620838`**（本机 34 张里**唯一** `general.cameraparallax: true`：`amount=0.08 / delay=0.1 / mouseinfluence=0.5`，22 个对象带 `parallaxDepth`、其中 3 个为 `0 0`）。**其余 33 张 `cameraparallax=false`** ⇒ 在那些壁纸上**视差无可见效果属预期**，不要误判为失败。

| # | 步骤 | 期望结果 | 失败表现 |
|---|---|---|---|
| V1 | 选 `3793620838`，鼠标在窗口内缓慢移动 | 画面**整体**轻微**反向**漂移（鼠标右移 → 内容左移），幅度很小（amount=0.08） | 完全不动 → 接线未生效（Console 看有无 `[three] scene loaded id=3793620838`） |
| V2 | 鼠标停下 | 画面**平滑收尾**（不是立刻停死，也不是过冲）—— `delay=0.1` 的滞后感 | 一停就死 = `delay` 插值未生效（§5.47） |
| V3 | 选一张 `cameraparallax=false` 的壁纸（如缺省样本 `2683211654`） | 画面**完全不动**（零回归） | 动 = 关闭态没走「不写 position」分支 |
| V4 | 切到别的壁纸再切回 `3793620838` | 视差**仍然工作**；Console 里 `getEventListeners(window).pointermove` **切走前后数量不变且 ≥1**（不叠加、也没被提前卸掉；DSH 壳或别的插件也可能挂 window 监听 ⇒ 只比前后差值，不数绝对值） | 失效 → tracker 装/卸不配对；切回后比切走前多 → §5.43 类问题 |
| V5 | 面板「暂停」壁纸后移动鼠标 | 画面**不动**（帧循环停了，视差随之停）；恢复后视差回来 | 还在动 → 暂停没停帧循环 |
| V6 | **交叉观察项**（转交项 6 / §7.39）：在 `3793620838` 上盯住**带脚本位移**的对象（该 pkg 内**无 `.js` 脚本** ⇒ 本机预期看不到该症状） | 有脚本位移的视差壁纸里，脚本位移对象若「不动了」= 每帧写 `position` 盖掉了脚本写入 | 本机无样本可证伪；真遇到须按 §7.39 改叠加语义 |

```js
// V4 的监听计数（Chrome/Edge DevTools Console 专有 API）：切走 / 切回各记一次，比前后差值（≥1 且不变即通过）
getEventListeners(window).pointermove?.length
```

**验收记录**：2026-10-23 用户人眼验收通过（V1–V6 逐条观察无异常；V6 交叉项本机无脚本位移样本，无样本可证伪）。

---

### 2.11 手工验收清单：puppet 静态网格与动画边界（2026-10-13 Task 8，逐条勾）

> **需人在运行中的 DSH Web GUI 里操作（选壁纸 + DevTools Console），agent 无法代跑。**
>
> 前置：已 `npm run build` + `npm run build:client`，并**重启 harness**（host 侧改动不热重载）后**强刷** GUI。
> ⚠️ **先读这条**：本机唯一 `.mdl` 样本（`3303428996` 死亡搁浅-玛玛）是**静态族**（无 `MDLS`/`MDLA`/`MDLE` 段，`bones=0`/`anims=0`）⇒ **动画在本机无法验收**（没有任何带 MDLA 的真实素材，实测 34 个真实 `scene.json` 也**没有一个**含 `animationlayers`）。本机能验收的只有「静态 puppet 网格出图」与「非 puppet 壁纸零回归」；蒙皮与动画只有 `tests/puppet.test.ts` / `tests/threejs-player.test.ts` 的合成夹具覆盖（边界见 `AGENT.md` §7.40）。

| # | 步骤 | 期望结果 | 失败表现 |
|---|---|---|---|
| P1 | 选 `3303428996`，看画面里的角色 | 角色呈**静态网格**形状（轮廓/几何面片，`stride=48 / 1850 顶点 / 10998 索引`），与「只画一张 flat quad」可区分 | 只有一张矩形贴图（退化成背景 quad）/ 角色完全不出现 |
| P2 | 同一次选择看 Console | **不出现** `puppet 解析失败`；出现 `[three] scene loaded id=3303428996 background=N particleLayers=M puppetLayers=1`（`background` 计数把 puppet 图层算进去） | 出现 `puppet 解析失败` ⇒ 记下实际 MDL 段头十六进制，据此决定补段布局还是如实标注未支持（§7.40） |
| P3 | 其它 scene 壁纸（本机 34 张里除 `3303428996` 全是非 puppet） | **逐像素零回归**：按 §2.9 跑 before/after 对拍，判据 `maxAbs ≤ 1` 且「差 ≥ 2」像素 = 0 | 对拍红 ⇒ 帧序/装配被动过（本轮以 `0a84cbb` 为基准实测：dpr1/dpr2 两档 `maxAbs=1`、差 ≥ 2 像素 0、`compare-shots` exit 0） |
| P4 | 动画观察（**本机不可验收**） | 无 MDLA 素材 ⇒ **不要期待**部件随动画动起来（期待落空 ≠ 实现有错）；动画路径只由合成夹具判据覆盖（`animationlayers` 只应用第一条可见层、`(已播秒数 × rate × fps) % frameCount` 回绕落在 `[0, frameCount)`） | 拿「本机 puppet 会动」当判据 = 无依据；真拿到带 MDLA 的素材后再补真机观察项 |

**验收记录**：2026-10-23 用户人眼验收通过（P1/P2 静态网格与 Console、P3 零回归对拍）；P4 本机无 MDLA 素材，动画路径未验收。

---

### 2.12 web 壁纸跟随鼠标（`npm run e2e:web-pointer` + 手工验收，2026-10-15）

> 自动化判据（先跑这个，它已覆盖「像素真的动了」）：`npm run e2e:web-pointer` —— 自起 server + headless Edge，
> 父页复刻 `.wp-background-layer{pointer-events:none}` 与跨源 iframe，用**生产** `injectPointerShim()` 注入，
> 再派发真实鼠标移动，A/B 比较**鼠标进入前**与移动后的图层位移与截图。判据 = raw 模式零位移零像素变化、
> shim 模式位移 > 20px 且像素变化 > 2%（缺本机素材 `1184182304` 时跳过）。口径与遗留见 `AGENT.md` §5.48。

> **以下手工项需人在运行中的 DSH Web GUI 里操作**（agent 无法代跑）。
> 前置：已 `npm run build` + `npm run build:client`，**重启 harness**（host 侧改动不热重载）后**强刷** GUI。

**验收样本 = `1184182304`（EVA初号机暴走-5，`type: web`，五层 `jquery.parallax`）。** 本机其它 web 壁纸若不依赖 `mousemove`，本项**无可见变化属预期**。

| # | 步骤 | 期望结果 | 失败表现 |
|---|---|---|---|
| W1 | 选 `1184182304`，鼠标在窗口内缓慢移动 | 五层图层**跟随鼠标轻微反向偏移**（鼠标右移 → 内容左移），移动越远偏移越大 | 完全不动 → 指针直传未生效（Network 里 index.html 响应应含 `__wpPointerShimInstalled`） |
| W2 | 鼠标停在角落不动 | 偏移**停住**（`friction=0.1` 收敛，无抖动/漂移） | 一直漂 = 每帧重复喂了不同坐标 |
| W3 | 切到非 web 壁纸再切回 `1184182304` | 视差**仍然工作**；Console 里 `getEventListeners(window).pointermove` **切走前后数量不变** | 失效 → 装/卸不配对；数量递增 → §5.43 类问题 |
| W4 | 切换窗口大小（触发 web 帧重建）后移动鼠标 | 视差**仍然工作**（重建后的新帧同样被直传覆盖） | 重建后失效 → 指针监听没跟着新帧重挂 |
| W5 | 在同一张壁纸上确认背景仍然**不吃点击** | GUI 面板/按钮点击、文本选择一切正常 | 点击被背景吞掉 → 有人去掉了 `pointer-events:none`（**不要**用这个办法修视差） |

**验收记录**：2026-10-23 用户人眼验收通过（W1–W5；像素位移自动化判据另见 `npm run e2e:web-pointer`）。

---

### 2.13 手工验收清单：v0.8 产品化（降级链/轮播/库/属性/视频兜底，逐条勾）

> **以下需人在运行中的 DSH Web GUI 里操作（面板 + DevTools + 文件管理器），agent 无法代跑。**
> 前置：已 `npm run build` + `npm run build:client`，**重启 harness**（host 侧改动不热重载）后**强刷** GUI；壁纸库里至少各有 1 张 scene / video 壁纸。
> 数据目录：抓帧默认落 `~/.dsh-use-wallpaper/frames/`；设了 `DSH_USE_WALLPAPER_DATA_DIR` 时落 `<env>/frames/`（换 env 后需重启 harness）。
> **本轮记录**：HEVC 回退与提示、抓帧 PNG 实际内容、轮播切换时的闪黑/卡顿观感，本任务无法在自动化里验证 ⇒ 曾列为「**待真机验收**」；**结果：2026-10-23 已完成人眼验收，全部通过（见下方勾选记录）**。

| # | 用例 | 步骤 | 期望结果 | 失败表现 |
|---|---|---|---|---|
| D1 | scene 失败 → 内嵌 MP4（`2911105183` / `3800645169`） | 1. 先正常选中，Console 出现 `[three] scene loaded id=…`。2. 用 §2.8 第 3 步的 fetch 拦截脚本让 `scene.json` 连续失败两次（把脚本末行 id 换成目标壁纸），重新 select。3. **失败后立刻**看画面与 Network；等 ≥3s 观察自动重试。 | 画面切到壁纸包内的 MP4（Network 出现 `/wallpapers/scene/<id>/embedded-video` → 200 `video/mp4`），不黑屏；面板状态行同时显示「上次失败：资源加载中断（本次会话内记忆）」（降级成功不清记忆）；约 3s 后自动重试一次，属预期 | 仍停在 preview / 空态 → 先看 Network 的 `video-probe` 是否为 `{video:true}`；为 false = `.tex` 内 mp4 探测未命中 |
| D2 | 抓帧生成与回退（无内嵌视频的 scene，如 `3793620838`） | 1. 确认 `frameCacheEnabled` 为开（默认 `true`；**面板没有该开关**，要关只能写 profile `cordis.patch.yml` 的 `config` 后重启 harness）；删除 `<dataDir>/frames/<id>.png`。2. 选中该壁纸，等 `[three] scene loaded` 后再等 1–2s。3. 查文件；再用 D1 的拦截脚本制造 scene 失败，**失败后立刻**看画面。 | 文件出现且是合法 PNG（前 8 字节 `89 50 4E 47 0D 0A 1A 0A`）；`GET /wallpapers/frame/<id>` → 200 `image/png` + `Cache-Control: no-store`；失败后画面先停在**抓帧图**而不是工坊封面，状态行显示软失败（本次会话内记忆）；约 3s 后自动重试可能换回实时渲染，属预期 | 只有封面 → 抓帧没成功（Console 搜 `scene 抓帧失败`（抓帧本身）或 `scene 首帧`（`scene-fallback.ts` 的探测/写入/缓存失败））；帧文件在但回退不到 → HEAD `/wallpapers/frame/<id>` 非 200 |
| D3 | 抓帧目录迁移 | 设 `DSH_USE_WALLPAPER_DATA_DIR=<临时目录>` 后重启 harness，重做 D2；完成后拿掉 env 再重启。 | 帧写到 `<临时目录>/frames/<id>.png`，默认目录不再新增；拿掉 env 后回到 `~/.dsh-use-wallpaper/frames/` | 仍写默认目录 → env 未被读取（`src/host/data-dir.ts`） |
| D4 | HEVC 视频（Edge） | 在 **Edge** 里选 `3802068825`（yuki恋冢爱，HEVC/H.265 视频壁纸）。 | 不再黑屏：回退到预览图；面板提示是两条可接受文案之一 —— `unsupported`：「该视频壁纸解码失败（可能是 HEVC/H.265），已回退到预览图；建议改用 Chrome 或转换编码。」；`timeout`（1.5s 无首帧）：「视频壁纸加载超时：1.5 秒内没有出现首帧，已回退到预览图；建议改用 Chrome 或检查视频文件。」；点「知道了」可收起。Chrome 里同一张应正常播放（解码能力差异，不是插件缺陷） | 仍黑屏且无提示 → `media-health` 未接上 controller 的 `onMediaFailure`；有提示但画面仍黑 → 回退 preview 未显示 |
| D5 | 轮播：1 分钟档 + 暂停 | 1. 保证 ≥2 张可见壁纸；开「自动轮播」、间隔「1 分钟」、顺序「顺序」。2. 等 ≥60s。3. 勾「暂停壁纸（省电）」再等 >60s。4. 取消暂停。 | 状态行 = `每 1 分钟 · 顺序 · 可轮播 N 张`；到点自动切下一张；暂停期间不再切；取消后重新计时 | 不切 → 定时器/池为空；暂停仍切 → 暂停联动失效；状态行说池 <2 但实际 ≥2 → 收藏/隐藏状态未同步 |
| D6 | 轮播：收藏池与手动重置 | 1. 收藏 2 张（其余不收藏），开轮播。2. 等一次切换。3. 手动点选另一张壁纸。 | 只在这 2 张之间轮换，状态行「可轮播 2 张」；手动选择后计时重置（不会立刻又切） | 仍在全库轮换 → 收藏池未生效；手动后立刻切 → 未重置计时 |
| D7 | 轮播：失败跳过（仅本会话） | 1. 只收藏 2 张 scene（其余不收藏；其中一张为目标，如 `3793620838`）。2. 执行 §2.8 第 5 步的硬失败脚本（目标 `scene.json` 恒 404；脚本末尾会选中目标，面板出现「拿不到 scene.json（已记忆）」；降级成功也不清这条记忆）。3. **手动点选**另一张作为轮播起点（手动选择会清空本会话失败集，属预期），再开轮播（1 分钟档）。4. 第一拍轮到目标时它会再次硬失败并进入本会话失败集；之后几拍应跳过它（**中途不要再手动选壁纸**）。5. 刷新页面后再开轮播观察。 | 本会话轮播**跳过**该张（第一拍失败后不再选中它；状态行「可轮播 N 张」只按收藏 / 隐藏算、**不含**失败集，别拿它当判据）；刷新后轮播**会再尝试**该张（脚本已随刷新消失，它会正常渲染），但面板**仍显示**上次失败记忆（`we:renderfail:<id>` 还在）—— `rotation.failed` 已清空，两者同时成立才对 | 反复选中失败项 → `rotation.failed` 未生效；刷新后仍被轮播跳过 → 失败集被误落盘；把「面板仍记得」当成「轮播仍跳过」→ 混淆两套状态 |
| D8 | 库：搜索/类型/收藏/隐藏/恢复/最近 | 1. 搜索标题片段；2. 切类型筛选；3. 收藏 1 张并勾「仅收藏」；4. 隐藏**当前正在播**的壁纸；5. 勾「显示已隐藏」→ 点 ↺ 恢复；6. 排序切「最近使用」。 | 列表即时过滤；星标/隐藏状态刷新后保持（localStorage `we:fav` / `we:hidden` / `we:recent`）；隐藏只从列表消失、不打断当前播放；恢复后回到列表；「最近使用」把刚选过的排前 | 刷新后丢失 → localStorage 键名/读取不对；隐藏当前壁纸导致黑屏 → 隐藏不应改播放 |
| D9 | 属性面板（`3793620838` / `2832263418`） | 选 `3793620838`（有 Birds / Clouds / Light shaft 三个 bool）；在「壁纸属性」里关掉 Clouds，等重装配；再关 Birds。再切到另一张有同名属性键的 scene（本机 `2832263418` 与 `3811798465` 都有 bool `newproperty1`），确认开关互不影响。 | 面板只在当前 scene 有可切换 bool 属性时出现；切换写 `we:userprop:<wallpaperId>:<key>`（**按壁纸隔离**）并**重装配**当前壁纸（Console 出现新的 `[three] scene loaded`）；刷新后开关状态保持；两张壁纸的同名键互不串值（旧全局键只在没有 per-id 键时作读回退） | 没有该 section → `/wallpapers/properties?id=` 返回空或该壁纸不是 scene；切了没变化 → 渲染器未读 `visible.user`；刷新回弹 → localStorage 未写入；关一张影响另一张 → 仍写全局键 |
| D10 | 显示效果面板即时生效 | 在「显示效果」里拖动遮罩不透明度 / 模糊半径、开关背景模糊 / Ken Burns、切画面适配（裁剪铺满 / 完整显示 / 拉伸铺满）。 | 每项**改完立即生效**，无需重选壁纸；刷新后保持；`fitMode` 对 video / image 背景同样生效（拉伸 = `object-fit: fill`） | 需重选才生效 → 未走 runtime handler；刷新丢失 → 未持久化 |

> **D1/D2 注入的是「软失败」**（§2.8 第 3 步，`Promise.reject` → `load-error`）：渲染器只记会话内软失败；降级到 video/frame 成功**不再清**失败记忆（降级成功 ≠ live 渲染恢复），约 3s 后自动重试一次。所以这两项除了画面 / Network / 抓帧文件，也会在面板看到「上次失败：资源加载中断（本次会话内记忆）」，属正确状态。要验持久失败记忆与轮播跳过，用 §2.8 第 5 步的**硬失败**脚本（`scene.json` 恒 404 → `scene-json`，落 `we:renderfail:`），见 D7。
>
> **D7 的两套失败状态别混**：`we:renderfail:<id>` = 渲染看护的**硬失败记忆**（localStorage，跨刷新 / 重开仍在，面板状态行读它）；`rotation.failed` = 轮播调度器内存里的失败集合（**仅本会话**，刷新即清空，手动选壁纸也会清空）。D7 验的是后者 —— 刷新后**轮播会再尝试**该张，但面板**仍显示**上次失败记忆，两者同时成立才是正确行为。

**勾选记录**（2026-10-23 人眼验收，全部通过）：

- [x] D1 / D2 / D3：降级链、抓帧生成与目录迁移
- [x] D4：Edge HEVC 回退 + 提示
- [x] D5 / D6 / D7：轮播切换、暂停、收藏池、失败跳过
- [x] D8：库搜索 / 收藏 / 隐藏 / 恢复 / 最近使用
- [x] D9：属性开关切换后重装配
- [x] D10：显示效果面板即时生效

---

### 2.14 手工验收清单：v0.8.1 缺口修复（bloom / 音效 / text effects / 精灵表 / clearcolor / starttime）

> **独立可勾选清单（含记录表、已知边界、失败上报口径）**：[`docs/2026-10-20-v0.8.1-manual-test-checklist.md`](docs/2026-10-20-v0.8.1-manual-test-checklist.md)；本节为精简版。
> **以下需人在运行中的 DSH Web GUI 里操作（目视 / 试听 + 面板），agent 无法代跑。**
> 前置同 §2.13：已 `npm run build` + `npm run build:client`，**重启 harness** 后**强刷** GUI；壁纸库含下列素材。
> **自动化已覆盖的部分**：`npm run e2e:verify-v081` 对 `2454403969`（bloom 亮部占比，应用级 Glow off + **默认 Glow** 两组 A/B）、`2980088441`（**默认 Glow** 下四角像素 ≈ `#111418`）、`3765967112`（精灵表图标单帧）三项做像素判据，**退出码 0 = 通过**；观感、音量与其余素材**已于 2026-10-23 人眼验收通过**。
> **零回归口径**：`e2e:hidpi` 的挂载期 RT 尺寸断言在 v0.8.0 基线即失败（**已知基线**，非本版引入；2026-10-23 人眼验收确认画面无问题）；`e2e:compare` 对 `2683211654` 会因 F7 预推进出现雾相位差异，属**预期变化**（记录为基线更新），不作为回归判据。

| # | 用例 | 步骤 | 期望结果 | 失败表现 |
|---|---|---|---|---|
| V1 | bloom 观感（`2454403969` / `3790775478` / `2937346640`） | 选中壁纸，分别把面板「光晕」关掉 / 打开对照；再与桌面 WE 的同壁纸并排看。 | 霓虹 / 路灯等亮部有柔和外溢、不整体泛白；`3790775478` 的亮部强度与作者设定相符；`2937346640` 的亮部同样出现作者 bloom；壁纸 bloom 与面板光晕是两个独立效果，关光晕后壁纸 bloom 仍在。 | 亮部完全无变化 → `general.bloom` 未解析或 bloom stage 未装配；整屏过曝/灰雾 → 强度/阈值或两级串联顺序有误。 |
| V2 | 音效音量与多轨（`2011060960` / `2597392171` / `3765967112`） | 选中壁纸听背景音；调面板「壁纸音效」开关；对比桌面 WE 的音量。`3765967112` 是 132MB 大音频，走 `<audio>` 流式播放（首播约 1-2 秒起声）。 | 音量与桌面接近（不再一律满响）；同一对象的多文件只出一首、不叠播 / 不爆音；开关即时静音/恢复；`3765967112` 能听到背景音乐。 | 仍满音量 → `volume` 未消费；两首同时响 → 选曲分支未生效；多文件只播其中一首属**已知边界**（loop 固定首曲 / random 随机）；`3765967112` 无声 → `<audio>` 流式未生效（Console 看 `[wallpaper-engine]` 诊断；`__weAudioDebug` 查 paused/contextState）。 |
| V3 | text effects（`3660373677` / `3814332254` / `2460786246` / `3811655063`） | 选中壁纸，观察时间/日期文字（可等跨分钟）。 | 文字上作者挂的 `blurprecise`（`3660373677` / `3814332254`）/ `vhs`（`2460786246`）/ `waterwaves`（`3811655063`）可见（发虚 / 扫描线 / 水波位移），文字仍可读；文字变宽后允许轻微裁边/拉伸（装配期隔离 RT 固定，属已知边界）。 | 文字清晰无任何效果 → text 未挂链；文字消失 / 明显错位 → 隔离入口或 `update_background` 位移对象有误。 |
| V4 | 精灵表（`3765967112`） | 选中壁纸，观察日/夜切换图标（右下）约 3 秒。 | 图标**静止在 automatic 帧**（上亮下暗的圆），不再每秒自动换帧（脚本 `init` 的 `pause` + `setFrame` 已生效）；点击不切换属**已知边界**（生产背景层 `pointer-events:none`，按产品决策不做点击转发）。 | 仍是整表 → `combos.spritesheet` 或 TEXS 帧网格未消费；图标仍自动换帧 → 脚本 `getTextureAnimation` 的 `pause`/`setFrame` 未生效。 |
| V5 | clearcolor（`2980088441`） | 选中壁纸（保持面板「光晕」默认开启），看文字周围整屏底色。 | 整屏为作者底色 `#111418`（深灰蓝），不是纯黑；默认 Glow 开启时仍为 `#111418`（e2e 已判四角）；与桌面 WE 一致。 | 仍为纯黑 → `clearcolor` 未解析 / 0-1 归一化未生效；仅默认 Glow 下变黑 → Glow baseRT 透明清屏把清屏色预乘成 0（A1 回归）。 |
| V6 | starttime 相位（`3660373677` / `1922570576`） | 选中壁纸，与桌面 WE 同时观察粒子起播相位（雾、闪光、流星类）；或反复重选壁纸看起播是否直接进入稳态相位。 | 起播相位与桌面接近（雾/闪光不再从零相位从头开始）；重选后相位按预推进重新计算。 | 每次从零相位开始 → `starttime` 未预推进；起播明显卡顿 → 900 步预推进成本（`2897292240` maxcount=10000/starttime=10 实测单对象约 155ms、两个对象约 0.3s，见 `AGENT.md` §7.42 ⑤）。 |

**勾选记录**（2026-10-23 人眼验收，全部通过）：

- [x] V1：bloom 观感（`2454403969` / `3790775478` / `2937346640`）
- [x] V2：音效音量与多轨（`2011060960` / `2597392171`）
- [x] V3：text effects（`3660373677` / `3814332254` / `2460786246` / `3811655063`）
- [x] V4：精灵表帧（`3765967112`，图标静止在 automatic 帧；点击为已知边界）
- [x] V5：clearcolor（`2980088441`，默认 Glow 下）
- [x] V6：starttime 相位（`3660373677` / `1922570576`）

**已知边界（2026-10-20 fix 波）**：对象属性脚本（`angles/origin/scale/color` 的 `update(value)`）已按 WE 契约执行并写回；其中 `color` 仍**只记录不应用**（不要求像素生效）。生产 GUI 不做点击转发 ⇒ `3765967112` 的点击循环不可达（V4 只验「图标静止在 automatic 帧」）。

---

### 2.15 手工验收清单：v0.8.2 可见修复包（util 层 / text / image / 指针 uniform / 性能）

> **前置同 §2.13/§2.14**：已 `npm run build` + `npm run build:client`，**重启 harness** 后**强刷** GUI；壁纸库含下列素材。
> **以下需人在运行中的 DSH Web GUI 里目视 / 操作，agent 无法代跑。**
> **自动化已覆盖**：`npm run e2e:verify-v082` 对 2911105183（util 全屏后处理覆盖）、2132420420（pulse 相位）、3765967112（text brightness）、3780477933（指针 uniform 的 asis/defaults 两档）做像素判据，退出码 0 = 通过；`e2e:verify-v081`、`e2e:textclock --gpu`、`e2e:colorblend` 保持 PASS。观感、4K 与真机帧率**已于 2026-10-23 人眼验收通过**（量化 FPS 未记录）。
> **口径**：表中数值来自 e2e/headless 实测（1280×720 或另行注明），**不是真机截图**；V10 的软件光栅化数字不代表真机 GPU。

**素材中文名对照**（本机库 `project.json` 的 title；英文标题给中文习惯叫法）：

| ID | 标题（库内显示） | 中文叫法 |
|---|---|---|
| `2911105183` | Subway Station | 地铁站（英文标题） |
| `2132420420` | 守望先锋 - Dva女警 | 守望先锋 Dva女警 |
| `2597392171` | 克西高达-RX-105 ΞGUNDAM（高达系列126） | 克西高达 RX-105 |
| `3789452668` | Knight in a red cloak | 红衣骑士（英文标题） |
| `2832263418` | EVA 卡农 弦乐四重奏 | EVA 卡农弦乐四重奏 |
| `2937346640` | Lycoris Recoil-锦木千束/Nishikigi Chisato | 锦木千束（Lycoris Recoil） |
| `1922570576` | 魔兽之门 | 魔兽之门 |
| `2460786246` | DVA守望先锋 | DVA 守望先锋 |
| `3780477933` | spider man bnd 2 | 蜘蛛侠 bnd 2（英文标题） |
| `3765967112` | Crimson Horizon | 绯红地平线（英文标题） |
| `3118949804` | Anime Girl With Purple Eyes | 紫眼动漫少女（英文标题） |

| # | 用例 | 步骤 | 期望结果 | 失败表现 |
|---|---|---|---|---|
| V1 | util 全屏后处理 + text/image 字段（`2911105183`） | 选中壁纸等 2–3 秒，与桌面 WE 并排：看整屏灯光/天窗泛光、`88:88` 时钟文字、左中/右侧广告牌；也可对照 e2e 生成的 `v082-291-util-on/off.png`。 | 整屏柔和 bloom（bokeh 次之）向外溢出，**不是**只在中部矩形；无白块/接缝；`88:88`（obj108/144，alpha 0.93）略透、obj148（alpha 0）不可见；两块广告牌偏冷/偏暗（image color）。e2e：`meanAbs 11.410 / 62.10%`、全屏 bbox。 | 完全无泛光 → projectlayer 未挂链/未渲染；只有中央矩形泛光 → cover 映射或 RT 口径错；白块/接缝 → passthrough 占位或合成 quad；广告牌仍原色 → image color 未消费；时钟太实/消失 → text alpha 口径错。 |
| V2 | pulse 暖色脉冲（`2132420420`） | 选中后观察车标/车灯/工牌高光随时间的暖色脉冲；反复重选看相位是否变化；与桌面 WE 对照。 | 局部暖色脉冲（tintlow 白、tinthigh 暖黄），相位随时间变化；**不是**整屏均匀橙色。e2e 冻结相位 A/B：`meanAbs 0.826 / 3.23%`，bbox 约 `[368,27]–[930,431]`。 | 无暖色 → pulse 链未跑；整屏均匀染色 → mask 未生效；相位不动 → `g_Time`/starttime 卡住（v0.8.1 已修，回归时看 Console）。 |
| V3 | 全屏 blur（`2597392171`） | 选中竖构图壁纸（场景 3840×6000），观察整屏模糊；与桌面 WE 并排，检查上下边缘与构图。 | 整屏均匀模糊、构图/方向与清晰版一致；无拉伸/翻转/黑边，平均色基本不变（T3：梯度能量 1.841 vs 2.533，NCC 0.9908，k=1.000）。 | 只有中间一条模糊/上下清晰 → cover 带映射错；画面拉伸/翻转 → UV 或 y 翻转错；黑边/暗角 → 快照内容未覆盖。 |
| V4 | 音频频谱线（`3789452668`） | 选中（不要开声音），观察是否有横贯屏幕的亮线/彩条。该素材**无 sounds/音频文件**，本机无音频输入 ⇒ 只验「无音频」这一半；有音频观感待有音频源时补。 | 无音频时 audioline 层完全不可见：solid `alpha=0`、效果输出 alpha=0（T3 与无效果档逐像素相同，平均差 0）。 | 无音频仍见亮线/彩条 → 对象 alpha 未落合成 quad 或快照内容漏出；有音频后仍不可见 → 频谱 uniform 未接（`__weAudioDebug` 查）。 |
| V5 | image color（`2832263418`） | 选中，观察彩虹层（obj250，color `0 0.45882 1`）与广告牌颜色；与桌面 WE 并排。该素材的 chromatic_aberration 链当前可能编译失败，本版只验 color。 | 彩虹层呈蓝/青偏色而非原白；广告牌 tint 与 WE 接近；无整屏偏色。 | 彩虹层仍原色 → image color 未消费；整屏偏色 → tint 错落到合成 quad/全屏层；色相方向相反 → 0-1/0-255 归一化错。 |
| V6 | image alignment bottomright（`2937346640`） | 选中，观察左下角小方块（obj61 visualizer，alignment=bottomright）；e2e 剥脚本档在 1280×720 下 bbox 约 `[43,665]–[65,687]`；与桌面 WE 并排。 | 小方块相对其 origin 锚在右下角，位置与 WE 一致；位移量很小（e2e 约 ±2.4px）。**注意该对象脚本每帧写 origin/scale，会覆盖静态 alignment** ⇒ 本版可见收益有限，主要确认无半尺寸错位/无回归。 | 整体偏移半个对象尺寸 → alignment 方向/符号错；每帧跳动 → 脚本 origin 与 alignment 叠加顺序错；完全不动 → 脚本路径未带 alignment（已知边界）。 |
| V7 | text anchor（`1922570576`） | 选中，看 3D Clock 文本位置（obj778，`anchor=center`、`verticalalign=top`）；与桌面 WE 并排。 | Clock 以其 origin 为中心（比旧 top 口径上移；e2e:textclock 实测 rect 从 y≈723 → `[930,692,1261,777]` @1600×900 ±2px）。 | 文本整体上移/下移半个字高 → anchor 未生效或回退错；与 WE 明显偏高/偏低 → anchor 语义可能应是屏幕锚，需回改 `textLayerOffset`（2026-10-23 人眼验收未出现该失败表现）。 |
| V8 | text alpha A/B（`2911105183` / `2460786246`） | 选中 `2911105183`（`88:88` 文本 alpha 0.93/0.93/0，挂 skew 链）与 `2460786246`（`12:34` alpha 0.82，挂 vhs 链）；与桌面 WE 并排；e2e 可用服务端把 text alpha 强制 1 的 A/B 截图对照隔离+链路径。 | `291` 的时钟略透、obj148 完全不可见；`246` 的 `12:34` 略透；skew/vhs 链不把对象 alpha 洗成 1 或 0（隔离路径 alpha 在内容材质）。e2e A/B（1600×900）：291 `changed=1107px / maxΔ23`、246 `changed=34366px / maxΔ35`；隔离内容 opacity `0.93/0/0.82 → 1`，合成 quad 恒 `1`。 | 文本比 WE 实（alpha 丢失）或比 WE 更淡/消失（a² 或链重写 alpha）→ 记录素材并回看内容材质/链 shader。 |
| V9 | 指针 uniform（`3780477933`） | 选中，在画面上移动鼠标；与桌面 WE 对比。e2e 已用 defaults 变体（服务端改 `Default Circle Size=0.3` + `opacitymask=util/white`）证明点阵跟随指针；生产素材原样**不能**用 e2e 变体。 | 原样壁纸**无可见变化**（作者常量把效果关成 no-op）；鼠标移动不应出现闪烁/拖影。记录「链路已确认（uniform 读数随指针变）、原样无可见差」。 | 移动鼠标出现异常点阵/闪烁 → uniform 错写到其它对象或 y 方向错；e2e defaults 双簇不跟手 → 注入链路回归。 |
| V10 | 性能（`2911105183` / `2132420420` / `2597392171`） | 1080p 与 4K 各选中三张壁纸，观察 5–10 秒；用 DevTools Performance 或 `requestAnimationFrame` 计数估帧率；记录 GPU/驱动。目标 1080p ≥30fps。 | 1080p ≥30fps、无明显卡顿；4K 允许下降但应可用；与 v0.8.1 同机对比不显著变差。口径与 headless 参考值见本节末「性能实测口径」。 | 1080p <30fps 或明显掉帧/发热 → 记录素材/分辨率/GPU；优先查 util 段数（291 有 6 段/帧）与 RT 尺寸（259 RT 1920×3000、估算 RT 显存约 222.9 MiB）。 |
| V11 | parallax 行为变化（`3118949804`） | 本机库**有**该素材；选中观察是否出现整体位移/waterwaves/depthparallax 异常；与 v0.8.1 或桌面 WE 对比。 | 现解析器把 `cameraparallax={user,value:true}` 视为未启用（`enabled=false`）⇒ `g_ParallaxPosition` 注入中性 `[0.5,0.5]`；旧版未写该 uniform 时驱动缺省 `[0,0]`（shader 当 -1 偏移）⇒ 记录为行为变化。公式本身无法真机校准（该壁纸不会 enabled）。 | 出现整体平移/波纹方向异常 → 记录并对比 v0.8.1；若确认由 `[0,0]→[0.5,0.5]` 引起，后续对「未启用视差」恢复旧默认或补齐 `{user,value}` 解析。 |

**性能实测口径（headless，非真机；V10 参考）**：

- 方法：`e2e/harness/harness-object-effects-entry.mjs` 生产入口 + 真实 `scene.pkg`，1920×1080 视口、dpr=1、`glow=off`、`wasm=none`、不冻结时钟；等暖机后 `__fxResetFrameStamps()`，取 10 帧的帧间隔中位数与 `renderer.render` 累计耗时，另用 3s `requestAnimationFrame` 计数佐证。临时脚本：`node e2e/.out/perf-v082.mjs --ids=2911105183,2132420420,2597392171 --frames=10 --warmup=3 [--swiftshader]`（`e2e/.out/` gitignored）。
- **强制 SwiftShader（软件光栅化）**：291 `404.2 ms/帧 ≈ 2.5 fps`（6 段/帧、RT 估算 162.3 MiB，3s rAF 计数另为 1.8 fps）；213 `222.4 ms ≈ 4.5 fps`（RT 123.0 MiB）；259 `2578.1 ms ≈ 0.4 fps`（RT 222.9 MiB）。软件数字**远低于**真机，只作量级参考。
- **默认 headless 后端（本机落 ANGLE/D3D11、RTX 3060）**：三张均 `16.6–16.7 ms/帧 ≈ 60 fps`（vsync 封顶，测不出余量），`renderer.render` 中位耗时 291/213/259 = `2.0 / 1.0 / 1.2 ms`。⇒ **1080p ≥30fps 的 DoD 仍以真机 V10 为准**，headless 不能替代。

**勾选记录**（2026-10-23 人眼验收，全部通过）：验收人 用户 日期 2026-10-23 GPU/驱动 未记录 分辨率 未记录

- [x] V1：`2911105183` 地铁站 util 全屏 bloom+bokeh / text / image color
- [x] V2：`2132420420` 守望先锋 Dva女警 pulse 暖色脉冲（相位）
- [x] V3：`2597392171` 克西高达 全屏 blur（竖构图无拉伸/翻转）
- [x] V4：`3789452668` 红衣骑士 音频频谱线（无音频不可见；有音频观感待补）
- [x] V5：`2832263418` EVA 卡农 image color（彩虹层偏色）
- [x] V6：`2937346640` 锦木千束 image alignment bottomright（脚本会覆盖 origin）
- [x] V7：`1922570576` 魔兽之门 text anchor（3D Clock 位置，对照 WE）
- [x] V8：`2911105183` 地铁站 / `2460786246` DVA 守望先锋 text alpha A/B（隔离+效果链）
- [x] V9：`3780477933` 蜘蛛侠 bnd 2 指针 uniform（原样无可见差；链路已确认）
- [x] V10：性能（地铁站 / Dva女警 / 克西高达 三张 1080p/4K ≥30fps 目标）
- [x] V11：`3118949804` 紫眼动漫少女 parallax 行为变化记录

**已知边界（v0.8.2）**：anchor/limitwidth 语义**已于 2026-10-23 按 §2.15 V7 人眼验收通过**（`1922570576`/`2937346640`，未发现偏移问题）；`2832263418` 的 chromatic_aberration 链当前可能编译失败（v0.8.2 的 e2e shader 门禁只覆盖四组判据素材）；`3780477933` 原样无可见输出；`3118949804` 的公式无法量化校准（2026-10-23 人眼验收未发现异常）；V10 的 headless 数字不代表真机 GPU。**aliasing**：util 壁纸的段渲染整帧走 frameRT、**无 MSAA**（画布 `antialias` 不作用于 RT）——`2911105183` / `2132420420` / `2597392171` 的边缘锯齿需与 v0.8.1 对照（`3789452668` 仅 solid util、不登记快照消费者 ⇒ 不走段渲染）；若观感不可接受，列入真机验收失败项。

---

### 2.16 手工验收清单：用户属性面板与绑定（v0.9 全类型）

> **需人工验收**：以下需人在运行中的 DSH Web GUI 里操作（面板切换 / 拖动 + 目视），agent 无法代跑。
> **前置同 §2.13/§2.14**：已 `npm run build` + `npm run build:client`，**重启 harness** 后**强刷** GUI；壁纸库含下列素材。
> **自动化已覆盖**：条件语义与属性级表达式（`tests/user-bindings.test.ts`）、对象形态 condition + 父链可见性（`tests/visibility.test.ts`）、host 四类型聚合与 `usedBy`（`tests/user-props.test.ts`）、绑定保留与装配前 resolve（`tests/scene-json.test.ts`）、四类控件与防抖提交（`tests/dom/settings-section.dom.test.tsx`）。**面板观感与真机画面仍需人工验收**。
> **口径**：属性提交后**整壁纸重装配**（4K 可能闪黑一下，属已知边界）；bool/combo 立即提交，slider/color 防抖 300ms 或 `pointerup`/`blur` 后提交一次。color 的 0-1 值首版按 sRGB 直映射，`clockcolor` 与桌面 WE 的色彩空间一致性需目视对照（`docs/superpowers/specs/2026-10-23-user-properties-full-types-design.md` §9）。

**素材中文名对照**（同 §2.15，另加 Leon）：

| ID | 标题（库内显示） | 中文叫法 |
|---|---|---|
| `3812518176` | Leon (Resident Evil; Adjustable) MX | 里昂（生化危机可调版，英文标题） |
| `2911105183` | Subway Station | 地铁站（英文标题） |
| `2937346640` | Lycoris Recoil-锦木千束/Nishikigi Chisato | 锦木千束（Lycoris Recoil） |
| `3118949804` | Anime Girl With Purple Eyes | 紫眼动漫少女（英文标题） |
| `2832263418` | EVA 卡农 弦乐四重奏 | EVA 卡农弦乐四重奏 |

| # | 用例 | 步骤 | 期望结果 | 失败表现 |
|---|---|---|---|---|
| P1 | `3812518176` clock 三档 | 选中壁纸，面板「Clock」依次选 `1` / `2` / `3 off`（默认 `1`）。 | `1` → 只显示样式 A（对象 192/199/209 的日期+时间）；`2` → 只显示样式 B（227/234/245）；`3 off` → 两组都隐藏、画面无时钟文字。任一档**都只有一套时钟**，无叠字/重影。 | 两套同时出现（文字重影）→ 对象形态 condition 或父链可见性回归；切换无反应 → combo 未提交 / 未重装配。 |
| P2 | `3812518176` clockcolor | 面板「clock color」用取色器改成明显颜色（红 / 蓝），松手或点别处失焦。 | 当前时钟文字整体变色；`pointerup` / `blur` 立即提交并重装配，停止操作约 300ms 也会自动提交一次（两条路径都只提交一次）；连续拖动期间**不**逐事件重装配（画面不反复闪黑）。 | 颜色不变 → color 绑定未 resolve；拖动时反复重建/卡顿 → color 防抖失效。 |
| P3 | `3812518176` `_24h` / `leavedspeed` / `ember` | ① 切「24h」开关；② 拖「Leaved Speed」滑块（0–5，默认 1）；③ 切「Ember」开关。 | ① 时钟在 24h（`HH:MM`）与 12h（`AM/PM HH:MM`）之间切换；② 落叶粒子下落速度随滑块变化；③ 余烬粒子出现 / 消失。 | 24h 不变 → `scriptproperties.use24hFormat` 的 `{user}` 未 resolve；落叶速度不变 → `instanceoverride.rate` 未 resolve；余烬不消失 → bool 可见性回归。 |
| P4 | `2911105183` Clock combo + musiccolor | 选中地铁站，面板「Clock」切 `24h` / `12h` / `Hide`；再把「Music color」改色。 | 三个 `88:88` 时钟只显示 1 个：`24h` → obj108、`12h` → obj144、`Hide` → **只显示 obj148**（obj148 的 condition=`2` 命中即显示、与作者 `value` 无关；该分支仍是 24h 时钟——与桌面 WE 一致，不是「三个全隐藏」）；`Music color` 改色后音频条 / 光带颜色变化。 | 三个时钟同时可见 → 对象形态 condition 回归；`Hide` 后没有 obj148 / 仍显示多个钟 → condition 归因错误；钟点格式与所选档不符 → combo 值映射错；颜色不变 → `constantshadervalues` 的 color 绑定未 resolve。 |
| P5 | `2937346640` slider | 选中锦木千束，面板拖「眼动追踪速度」（0–1，默认 0.4）。 | 眼睛/视线动作速度随滑块变化；`pointerup` / `blur` 立即提交并重装配，停止拖动约 300ms 也会自动提交一次。 | 无变化 → effect `constantshadervalues.speed` 的 slider 未 resolve；拖动即重建 → 防抖失效。 |
| P6 | `3118949804` slider + parallax | 选中紫眼动漫少女：① 拖「Hair Speed」（0–4）；② 切「Parralax」；③ 拖「Bar Spacing」/「Bar Transparence」。 | ① 头发摆动速度变化，默认应为 **2**（project.json 的 value，不是 scene 的 3.1300001）；② 开关决定画面是否随鼠标视差；③ 频谱条间距 / 透明度变化。 | 速度仍是 3.13 → 默认值取错（应取 project.json）；视差开关无反应 → `general.cameraparallax` 的 `{user}` 未 resolve。 |
| P7 | `2832263418` color + condition | 选中 EVA 卡农：① 关「音频条开关」；② 重新打开后改「音频律动颜色」。 | ① `audiobar=false` 时音频条对象隐藏，颜色控件**禁用并标灰**（属性级 condition `audiobar.value==true` 不满足）；② 打开后颜色控件可用，改色后音频条呈新颜色。 | 关音频条后颜色控件仍可调 / 重开后颜色无效 → 属性级 condition 或 color 绑定未生效。 |
| P8 | `3118949804` visualizer 条（v0.9 修复） | 选中紫眼动漫少女，观察画面左侧（该壁纸的 64 条音频可视化条）。 | 静音下也能看到左侧一列细条（高度 = 脚本 `minBarHeight`，约 10px，与桌面静音一致）；播放系统音频时不跳动属已知边界（`supportsaudioprocessing` 未接）。 | 左侧完全空白 → pixel-bars 家族布局或 bar 纹理加载回归。 |
| P9 | `3118949804` 系统音频（v0.9 P1） | 用浏览器（Chrome/Edge）打开同一 GUI 地址（桌面 App 内不可用）；选中壁纸 → 面板「系统音频」→ 启用 → 共享弹窗选「整个屏幕」并勾选「共享音频」；播放音乐。 | 授权后按钮变「停止系统音频」；壁纸 visualizer 条随音乐跳动；点停止或浏览器「停止共享」后回到静音最小高度且按钮复位。 | 按钮不出现（非 `supportsaudioprocessing` 素材）、授权后无反应（未勾选共享音频/音频轨未接）、桌面 App 中误报成功。 |
| P10 | `3163840671` 预设壁纸（v0.9） | 选中「Anime Girl Purple Clean Wallpeaper」（预设版），对比主壁纸 3118949804。 | 类型徽标显示 PRESET；画面按依赖主壁纸渲染，且参数采用预设值（speed=2.5、blinkingeyes=false 等）；壁纸属性面板显示依赖的属性。 | 徽标仍 UNKNOWN / 选中后只剩预览图（资源 alias 失败）/ 属性值不是预设值。 |

**勾选记录**（2026-10-23 用户人眼验收，全部通过；验收人 用户 日期 2026-10-23 GPU/分辨率 未记录）：

- [x] P1：`3812518176` clock 三档（1 / 2 / 3 off）
- [x] P2：`3812518176` clockcolor（防抖提交）
- [x] P3：`3812518176` `_24h` / `leavedspeed` / `ember`
- [x] P4：`2911105183` Clock combo + musiccolor
- [x] P5：`2937346640` slider（眼动追踪速度）
- [x] P6：`3118949804` slider + parallax
- [x] P7：`2832263418` color + condition（音频条关闭时禁用）
- [ ] P8：`3118949804` visualizer 条（静音最小高度）
- [ ] P9：`3118949804` 系统音频（浏览器模式，需授权）
- [ ] P10：`3163840671` 预设壁纸（按依赖渲染 + 预设参数）

**已知边界（v0.9）**：`text` 类型本机 0 样本、面板不渲染；`group` 类型不返回（Leon 的 `character`/`weather` 不显示）、面板平铺；属性变更走整壁纸重装配（无就地实时生效）；color 的 0-1 值按 sRGB 直映射，`clockcolor` 色彩空间已按 P2 人眼验收通过（2026-10-23，未做逐像素色差量化）；`3812518176` 的 `bloomhdr*` 仍不支持（另一条缺口）；`2937346640` 的 `_24hourformat` 在 project.json 中不存在，面板不出现该项（`{user}` 引用保留作者值）。

**e2e 自动化复跑（2026-10-23 最终修复轮，本机 headless Edge / SwiftShader）**：

- `npm run e2e:verify-v081` → **exit 0**（PASS）：bloom 亮部占比 A/B（Glow off 2.245% vs 0.604%，Δ1.641pp；默认 Glow 3.759% vs 1.183%，Δ2.577pp）、`2980088441` clearcolor 四角 `#111418`（±8）、`3765967112` spritesheet 方差比 0.742（≤0.8）。
- `npm run e2e:verify-v082` → **exit 0**（四组 PASS）：`2911105183` util 后处理 `meanAbs 11.414 / 62.10%`（全屏 bbox）、`2132420420` pulse `0.826 / 3.23%`、`3765967112` text brightness `910px / maxΔ20`、`3780477933` pointer asis `0.00%` / defaults `3.88%`（双簇质心距 4.3 / 5.8px）。

**默认观感变化对照（2026-10-23 人眼验收通过）**：

- `2911105183` `musiccolor`：`constantshadervalues` 作者值灰 `0.15294 0.15294 0.15294` → project.json 默认蓝 `0.01569 0.31765 0.55294`（0-1 语义），音频条 / 光带默认偏蓝；P4 已覆盖颜色变更，默认色相未发现异常（2026-10-23 人眼验收，未并排逐像素对照）。
- `2980088441` `_24hr`：object 19 的 `use24hFormat` 作者值 `true`（24h），project.json 默认 `false` ⇒ 默认变 12h，时钟小时格式随默认值变化；2026-10-23 人眼验收未发现异常（未与桌面 WE 并排逐项对照）。

---

### 2.17 手工验收清单：媒体集成（Windows SMTC + 时间线属性动画，2026-10-30）

> **需人工验收（当前未验）**：**以下 M1–M8 需真机手动勾选，当前未验** —— 必须由人在运行中的 DSH 桌面 App 里操作（播放器播放/暂停/切歌 + 目视），agent 无法代跑。
> **前置**：已 `npm run build` + `npm run build:client`，重启 harness 后**强刷** GUI；选中 `3797976859`（小作 2(有声)）；本机装有会把会话注册到系统 SMTC 的播放器（Spotify / 网易云 / Groove 等），并**在播放器中实际播放音乐**。
> **自动化已覆盖**：事件 diff / 轮询启停（`tests/media-input.test.ts`）、会话选择 / 行解析 / 空闲退出与退避（`tests/media-session.test.ts`，含 stdout 跨 UTF-8 分块与 watcher 封面迟到强制输出）、VM 事件与 `thisObject.getAnimation`（`tests/scene-script-vm.test.ts`）、时间线解析与求值 + 脚本 init 的 play/setFrame 不被 `applyInitial` 覆盖（`tests/scene-timeline.test.ts`）、面板状态行文案随 getMediaStatus.reason 变化（`tests/dom/settings-section.dom.test.tsx`）、text 层材质不被脚本动态 color 改写（`tests/layer-state.test.ts` / `tests/threejs-player.test.ts`）、封面方向与共享纹理（`tests/media-texture.test.ts`）、端到端 `npm run e2e:media`（13 条：白框 / 文本 / 封面方向 / 主色 / 淡入滑入 / 停止隐藏）与 `node e2e/verify/verify-media-layer.mjs --regression`（5 张回归，含 `2980088441` 文本静态色回归 + `2597392171` Fog loop 复跑）。**真机观感、SMTC 会话选择与隐私仍需人工验收**。
> **隐私口径**：验收记录**不得包含真实曲目信息**（不截图歌名、不把 title/artist 贴进 issue）；日志与数据目录检查只记录「有无」。

| # | 用例 | 步骤 | 期望结果 | 失败表现 |
|---|---|---|---|---|
| M1 | 无媒体会话：白框消失 | 选中 `3797976859`，先停止播放器（或退出）后再选中壁纸。 | 封面框 / 歌名 / 歌手全部隐藏，媒体区**无白色方块**；其余场景画面正常。 | 仍见白框 → 装配期 `playback(STOPPED)` 未派发 / 媒体层未被脚本隐藏。 |
| M2 | 播放：封面/文本/主色/动画 | 桌面 App 中播放音乐。 | ≤2s 内：封面出现且**方向正确**（人像/文字不上下颠倒）、歌名与歌手正确、封面边框主色跟随封面、媒体区**淡入 + 滑入**后停稳。 | 封面倒置 → flipY 约定回归；主色不变 → `mediaThumbnailChanged`/调色板链路；无淡入滑入 → 时间线未播。 |
| M3 | 暂停 / 恢复 | 播放器暂停 → 观察；再恢复播放。 | 暂停时媒体层**保持显示**（暂停事件 = PAUSED ≠ STOPPED，脚本仍可见），封面/文本不消失；恢复后状态照常。 | 暂停即隐藏 → 事件状态映射错（2 被当 0）。 |
| M4 | 切歌：全部更新且不残留 | 播放器中切到下一首（不同封面/歌名/歌手）。 | 封面、歌名、歌手、边框主色在 ≤2s 内整体更新；**旧封面不残留/不闪回**。 | 文本更新但封面不变 → `thumbnailRev` 未变 / 缓存键错；先闪旧图 → 切歌未先清纹理。 |
| M5 | 停止：媒体层再隐藏 | 播放器停止播放（或关闭播放器）。 | ≤2s 内媒体层全部隐藏，无白框、无残留文本，场景继续渲染。 | 文本/封面残留 → `PLAYBACK_STOPPED` 未派发或脚本未收到。 |
| M6 | 面板开关：关闭 / 重开 | 播放中打开设置 →「Wallpaper 壁纸」→「显示效果」→ 关闭「媒体集成（显示本机播放的歌曲封面/歌名）」；再打开。 | 关闭 ⇒ 媒体层**立即**隐藏、后续不再有 `now-playing` 请求；重开 ⇒ ≤2s 内媒体层恢复（曲目未变也要重新出现）。 | 关闭后仍轮询/仍显示 → 运行期开关链路；重开不恢复 → `stop()` 清 `prev` 后首帧未重放。 |
| M7 | 隐私与 watcher 残留 | 停止播放并关闭壁纸（或切到非媒体壁纸）后等待 **>25s**（空闲阈值 20s + 5s 检查周期，最坏 25s 才退出）。 | 浏览器 Console / DSH 日志中**没有** title/artist/album；数据目录 `~/.dsh-use-wallpaper`（或 `DSH_USE_WALLPAPER_DATA_DIR`）内**除 `frames/` 抓帧缓存外无新增文件**：媒体数据（封面/曲目/快照）不得落盘；选中 `3797976859` 时首帧成功会写 `frames/3797976859.png`，属抓帧缓存而非媒体数据（要严格「零新增」可临时关掉 `frameCacheEnabled` 再测）；`Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" \| Where-Object CommandLine -like '*GlobalSystemMediaTransportControls*'` 无输出。 | 日志出现曲目名 → 隐私回归；目录出现 `frames/` 之外的新文件 → 媒体数据落盘；25s 后仍有该 powershell 进程 → 空闲退出未生效。 |
| M8 | 其它平台 / 失败路径（可选） | 浏览器 GUI 中播放音乐（桌面 App 之外），或临时让 PowerShell 不可用（改 PATH / 策略模拟）。打开设置 →「Wallpaper 壁纸」→「显示效果」（媒体集成开关下方状态行）。 | 浏览器 GUI 下可能命中 Chromium 自会话过滤边界（误选/漏选均记边界，不判红）；无 PowerShell / watcher 失败时：媒体层隐藏、状态行显示对应原因（「未找到可用的 PowerShell…」/「媒体会话读取失败（已降级）…」）、不显示曲目；非 Windows 显示「当前系统不支持系统媒体会话（仅 Windows）…」；渲染不受影响。 | 面板无提示 / 仍显示隐私默认文案（说明 reason 未上抛）→ `getMediaStatus`/面板状态行链路回归；渲染被阻塞 → 降级链回归。 |

**勾选记录（当前未验：以下 M1–M8 需真机手动勾选，agent 未代验、未伪造勾选）**：

- [ ] M1：无媒体会话白框消失
- [ ] M2：播放（封面方向 / 歌名歌手 / 主色 / 淡入滑入）
- [ ] M3：暂停保持显示、恢复
- [ ] M4：切歌更新且旧封面不残留
- [ ] M5：停止后媒体层隐藏
- [ ] M6：面板开关关闭 / 重开
- [ ] M7：隐私（日志无曲目）+ 数据目录无媒体落盘（`frames/` 抓帧缓存除外）+ >25s 无 watcher 残留
- [ ] M8：浏览器 GUI / 失败路径（可选）

**e2e 复跑（2026-10-30 final fix wave，本机 headless Edge / 真 GPU）**：`npm run e2e:media` exit 0（13/13 判据；FPS 探针 60.3，GPU=NVIDIA RTX 3060 D3D11）；`node e2e/verify/verify-media-layer.mjs --regression` exit 0（5 张 22/22 判据，含 `2980088441` 的 `[R6]`：text 层材质 color≈[1,1,1]、文本区红像素 539）；`npm run e2e:media-perf` exit 0（10 条动画 `advance+sampleAndWrite+syncWorld` 本机两次实测 13.024 / 14.579µs/帧，N=2000，预算 <50µs）；`verify-colorblend` / `verify-v081-gaps` / `verify-v082` / `verify-text-clock-layer --no-teeth` / `verify-web-pointer-parallax` 均 exit 0。**未通过/未运行（非本次回归）**：`verify-hidpi-object-rt` 挂载期 RT 尺寸断言为 v0.8.0 基线即有的已知红（见本文 §2.16）；`verify-isolated-rt-sharpness` 的 `2132420420`「多隔离 obj37」与 `2911105183` 锐度未达阈为既有素材/基线状态（本次未触 isolate/RT 代码）；`verify-turn-trigger-card` 因本机 DSH asar 缺 `dsh-client-ui-primitives/lib/markdown/CodeBlock.module.css` 无法运行（环境缺失，与插件无关）。

**可复跑性口径**：媒体 e2e 与其它 headless e2e（如 `verify-colorblend`）必须**串行**执行、彼此留 1–2s 间隔 —— 连续紧跑 `e2e:media` 后立刻跑 `verify-colorblend` 可能因 Edge/调试端口尚未完全释放而环境性失败（单跑通过，属环境问题而非判据回归）。回归判据 `[R2]`「`__listObjects() > 0`」与 `[R3]`「截图字节 > 0」是**结构性弱断言**（防静默空跑），画面正确性需人工复看 `e2e/.out/media/regression-<id>.png`；`[R1]` 不含 CDP `Log.entryAdded` 的 error（含 favicon/资源 404、导航期 `net::ERR_ABORTED` 等噪音，纳入易随环境假红，现只诊断打印），页面级 error 由 `__logs` 与 CDP exception 覆盖。

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
