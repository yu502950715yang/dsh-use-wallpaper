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

本轮的**单测**已覆盖段划分 / 快照时机 / 无消费者零回归（`tests/frame-capture.test.ts`、`tests/threejs-player.test.ts` 的「ThreeScenePlayer 段渲染（frameCapture）」describe、`tests/object-effects.test.ts`）；**真机逐像素对拍、9 个叠加次序变化壁纸的目视、性能/显存测量留给 Lead 与用户统一安排**。要跑时的口径：

| 项 | 口径 |
|---|---|
| 改 `src/` 后 | **必须先 `npm run build`**（`e2e/verify/verify-hidpi-object-rt.mjs` 无 src 重定向，否则测的是旧 `lib/`；`verify-isolated-rt-sharpness.mjs` 自带 src 重定向） |
| 零回归对拍 | 选**无消费者**的壁纸（如 `3793620838`）：`--tag=before` → 改动 → `--tag=after` → `npm run e2e:compare`；判据 `maxAbs ≤ 1` 且「差 ≥ 2 的像素数 = 0」 |
| 预期可见变更 | 全库 **9** 个「粒子在前 image 在后」的 pkg（`1429403119` / `2597392171` / `2897292240` / `2911105183` / `2937346640` / `3743126786` / `3765967112` / `3793620838` / `3789452668`）叠加次序改变（对齐 WE，**不得当回归**）；`2897292240` 由白块变水滴；`2597392171` 的 obj#50 半透明区不再被压黑 |
| 性能/显存 | `2897292240`「段渲染开 / 关」的帧时与 `renderer.info.memory.textures/geometries`；退化 > 15% 时把「半分辨率 `frameRT`」列为后续优化 |

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
