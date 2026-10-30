# @dsh-use/wallpaper-engine

[![dsh-plugin](https://img.shields.io/badge/GitHub%20topic-dsh--plugin-1f6feb)](https://github.com/topics/dsh-plugin)
[![DeepSeek Harness](https://img.shields.io/badge/DSH-DeepSeek%20Harness-4b8bbe)](https://github.com/deepseek-ai/deepseek-harness)
[![npm version](https://img.shields.io/npm/v/@dsh-use/wallpaper-engine)](https://www.npmjs.com/package/@dsh-use/wallpaper-engine)
[![npm downloads](https://img.shields.io/npm/dt/@dsh-use/wallpaper-engine)](https://www.npmjs.com/package/@dsh-use/wallpaper-engine)
[![CI](https://github.com/yu502950715yang/dsh-use-wallpaper/actions/workflows/ci.yml/badge.svg)](https://github.com/yu502950715yang/dsh-use-wallpaper/actions/workflows/ci.yml)
[![stars](https://img.shields.io/github/stars/yu502950715yang/dsh-use-wallpaper)](https://github.com/yu502950715yang/dsh-use-wallpaper/stargazers)
![license](https://img.shields.io/badge/license-MIT-green)

**把 Wallpaper Engine 的 scene（场景）壁纸搬进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Web GUI** —— 在浏览器里实时渲染粒子、水波、云卷、布料摆动，让动态壁纸成为你写代码时的背景。

不需要 Wallpaper Engine 在后台运行，不需要 WebGPU，不重新分发任何第三方素材。

```bash
# 一行安装（dsh web；桌面版 App 请用侧边栏「插件」页，不能用 CLI）
dsh plugin --profile web add "@dsh-use/wallpaper-engine" && dsh plugin --profile web install
```

> ⭐ **如果它让你的界面好看了，点个 [Star](https://github.com/yu502950715yang/dsh-use-wallpaper/stargazers) 就是最大的支持。**
> 发现哪张壁纸渲染不正常，欢迎[提 Issue](https://github.com/yu502950715yang/dsh-use-wallpaper/issues/new) —— 壁纸写法千差万别，你的反馈是项目改进的主要来源。

---

## 🎬 在 DSH 里的真实效果

下面两段动图都是**在 DSH Web GUI 的真实页面上**录的（不是离线贴图，也不是设计稿）：壁纸由插件在浏览器里实时渲染 / 播放，DSH 界面叠加在其上。

<table>
<tr>
<td width="50%" align="center">

**yuki恋冢爱**
<sub>Video · Girls</sub>

![yuki恋冢爱 在 DSH 中的效果](docs/videos/yuki-koizuka-dsh.gif)

<sub>[▶ 完整视频（9s / mp4）](docs/videos/yuki-koizuka-dsh.mp4)</sub>

</td>
<td width="50%" align="center">

**Knight in a red cloak · 红披风骑士**
<sub>Anime</sub>

![Knight in a red cloak 在 DSH 中的效果](docs/videos/knight-red-cloak-dsh.gif)

<sub>[▶ 完整视频（9s / mp4）](docs/videos/knight-red-cloak-dsh.mp4)</sub>

</td>
</tr>
</table>

> **录制方式（如实说明）**：两段动图与视频都是在**真实运行的 DSH 页面**上、由本插件的生产构建（`lib/`）实时渲染本机 workshop 壁纸后录制的浏览器画面，未做后期合成；壁纸通过插件自身的切换入口 `window.__wallpaperEngine.select(id)` 切换，因此画面里只有 DSH 界面与壁纸本身。画面已裁掉浏览器窗口边框（地址栏 / 标题栏）。**yuki恋冢爱 是 HEVC（H.265）视频壁纸，这段用 Chrome 录制** —— 浏览器能否**解码播放**视频壁纸取决于它自身的解码能力：同一系统上 Edge 缺少 HEVC 解码会回退到预览图并提示（v0.8 起），Chrome 正常播放。壁纸素材版权归原作者所有，此处仅作效果展示，不再分发。

---

## ✨ 能做什么

| | 能力 | 说明 |
|---|---|---|
| 🎨 | **Scene 动态壁纸** | 在浏览器里实时算出来，不是静态图贴上去：背景图层与粒子系统各司其职，背景的缩放、透明度、亮度按原作者的设定还原 |
| 🌊 | **粒子效果基本完整** | 雪、雨、花瓣、火星、雾、气泡等都按壁纸里的原始参数运动：重力、风向、湍流、寿命、颜色与大小渐变；**沿速度方向拉伸的拖尾**（雨丝、风痕、余烬，即 WE 的 `spritetrail`）也已实现；**起播相位（`starttime`）按原设定预推进**，对象级实例覆盖（`instanceoverride`，含编辑器的 `{user|script,value}` 包装）同样生效 —— 加色雪层不再变黑；**子粒子（子发射器）与绳索类拖尾（`ropetrail`）尚未支持**，见「使用前请了解」 |
| 🖼️ | **各种纹理都能解** | 主流压缩格式（DXT1/3/5、RGBA、R8、RG88）与多帧精灵动画（火把、雾、光晕）都能正确解出原图，不糊、不露黑边；**标记为精灵表的 image 只显示当前帧**：有作者脚本的按脚本帧（可 `pause` / `setFrame`），无脚本的按约 1 帧/秒自动循环，不再把整张帧表压进一个图标 |
| 🎞️ | **视频 / 网页 / 图片壁纸** | 视频循环播放（编码不支持时自动回退预览并提示；**视频壁纸暂不播放音频**）；网页壁纸在沙箱里加载；图片壁纸用预览图 + 缓慢缩放动效 |
| 🪜 | **多级降级链** | scene 渲染失败时依次尝试 **内嵌 MP4 → 抓帧 PNG → 作者预览图 → 空态**；每级失败只跳过，不白屏、不黑屏卡死 |
| 🎬 | **视频编码兜底** | HEVC / H.265 等浏览器解不了的编码会**回退到预览图**，并在面板提示原因与自救建议，不再停在黑背景 |
| 🧩 | **常见特效会动** | 水波、涟漪、水流、云飘、植物摆动、抖动、脉冲、淡入淡出，以及模糊、泛光、光轴、局部对比度这类需要多趟渲染的特效（少数特效仍然看不到，见下节） |
| 🌟 | **壁纸级 bloom** | 作者在 scene 里开的泛光（`general.bloom*`，阈值/强度按原参数）会叠加到画面上，亮部外溢；与面板「光晕」是两个独立开关 |
| 🔉 | **音效音量与播放模式** | 音效对象的音量按原设定生效；`single` 播一次、`random` 随机选一首，多文件不再同时叠播 |
| 🖌️ | **场景底色** | 纯文本/透明场景按作者的 `general.clearcolor` 铺底（兼容 WE 的 0-1 色值），不再是恒黑 |
| 🕒 | **文本对象会显示** | 壁纸里的时间/日期文本会实时走字（如 VHS 时间与日期），不再是空一块；作者挂在文字上的效果链（模糊、VHS、水波）现在也会执行；带脚本的文本写法差异见下节 |
| 🔋 | **省电与画质档位** | 一键暂停壁纸；切到后台自动暂停；渲染分辨率可降到 0.5× 省显存、提流畅 |
| 🔁 | **自动轮播** | 收藏 ≥2 张时只轮播收藏，否则轮播全部非隐藏壁纸；1 / 5 / 10 / 30 分钟、顺序或随机；暂停联动、手动选择重置计时、本轮失败跳过 |
| 🔎 | **壁纸库管理** | 标题搜索、类型筛选、仅收藏、隐藏 / 恢复、最近使用排序；收藏与隐藏只存本地，不改壁纸文件、不打断当前播放 |
| 🎛️ | **显示效果面板** | 遮罩不透明度、背景模糊、Ken Burns、画面适配（裁剪铺满 / 完整显示 / 拉伸铺满）都在面板里直接调，改完立即生效 |
| 🎚️ | **用户属性面板** | 壁纸自带的属性（**bool / slider / color / combo** 可调，**只显示当前壁纸真正引用的属性**，不出现假控件）在面板里直接调；切换/调整后自动重装配生效，滑块与取色**防抖提交**（不逐帧重建） |
| 🎵 | **系统媒体集成** | 在 Windows 上读取系统媒体会话（SMTC），让壁纸的专辑封面 / 歌名 / 歌手 / 主色与播放状态实时联动；仅内存、不落盘，面板可关 |
| 🎥 | **开机动画** | 打开 DSH / 新窗口时全屏播一段片头：素材可用 WE 库的视频 / 图片壁纸或本地视频文件，四种展示方式，播完或到上限淡出；固定静音、每次会话只播一次，8 秒未就绪静默跳过 |
| 🛡️ | **失败不砸界面** | scene 渲染失败走**多级降级链**（内嵌 MP4 → 抓帧 → 预览图）；video 解码失败 / 首帧超时回退预览图并提示。**web 壁纸目前没有失败回退**（跨源 iframe 探测不到子帧错误，失败会停在空白）；界面本身始终可用 |
| ⚙️ | **开箱即用** | 自动探测 Steam 壁纸目录（注册表 + Steam 库配置 + 常见路径），也可手动填写；改设置立刻生效，不用重启 |
| 🚫 | **不依赖运行时** | 不需要 Wallpaper Engine 在后台运行；所需的引擎内置素材在你本机读取，不随插件分发第三方素材 |

> 💬 **换了几张壁纸却发现某张显示不正常？** 那是我们需要知道的——请按下方「使用前请了解」末尾的说明提交 Issue，附上壁纸名称与 ID 即可。

---

## 🚀 快速开始

### 1. 安装插件

**桌面版 App：用侧边栏「插件」页**

> ⚠️ 桌面版**不能**用下面那几条 `dsh plugin` 命令 —— 桌面版 profile（`desktop`）由 App 独占管理，CLI 会直接拒绝：`profile "desktop" is managed exclusively by the Electron application`。

1. 打开桌面版，点左侧栏的 **插件** 页。「设置 → 内置插件」是只读清单，装不了东西。
2. 点 **添加插件**，在包名框里填下面任一种 —— 写法就是 `dsh plugin add` 后面那一段：

   | 装法 | 填什么 |
   |---|---|
   | npm（稳定版） | `@dsh-use/wallpaper-engine` |
   | GitHub（最新） | `github:yu502950715yang/dsh-use-wallpaper` |
   | 本地仓库（改码即时生效） | `E:\code\dsh-use-wallpaper`（绝对路径即可，不必写 `link:`；装好后记为 `link:`） |

   输入框下方的 **插件安装引导和示例** 给出这三种形式的示例，**填入示例** 可一键填入（GitHub 与本地路径记得替换成实际值）。
3. 点 **安装**。首次使用会先探测 npm 官方源与国内镜像、选最先响应者；GitHub 连不上时会提示 **无法访问 GitHub**，可点 **改用国内镜像**。
4. 装完**刷新页面**即可生效（新装插件会即时挂载，不必重启 App）。

   例外：装的是**本地仓库**、且随后改了它的 `dist/client.js` 时，**必须整个 App 重启**（托盘退出再启动）—— 桌面版 host 在启动时就把客户端 bundle 拍成内存快照，刷新页面拿不到新代码。

5. 接着做下面的「2. 启用并选择壁纸」。

> 可能挡住你的两个环节：① 插件声明的 DSH 版本不兼容时会被拦下，放行等于接受「可能崩溃或损坏数据」的风险，需要你明确确认；② 插件带 `prepare` / `postinstall` 安装脚本时 pnpm 会拦下，插件页会问你是否允许执行这些脚本。
> 卸载也在这一页（会二次确认）；「官方」分组里随安装提供的组合包是锁定的，不可卸载。

**以下三条适用于 `dsh web`（npm 版 CLI，profile 名 `web`）**

**从 GitHub 安装（推荐，最新）**

```bash
dsh plugin --profile web add github:yu502950715yang/dsh-use-wallpaper
dsh plugin --profile web install
```

**从 npm 安装**

```bash
dsh plugin --profile web add "@dsh-use/wallpaper-engine"
dsh plugin --profile web install
```

> npm registry 当前最新为 **[0.9.0](https://www.npmjs.com/package/@dsh-use/wallpaper-engine)**（发布包只含 `lib` + `dist` + `cordis.patch.yml`，构建产物已随包提交，**装完无需本地构建**）。
> 
> npm 版与 GitHub 版的差别：npm 走版本发布，**更新节奏慢于仓库 `master`**；想第一时间拿到修复请用上面的 GitHub 方式。

**本地开发（`link:` 符号链接，改码即时生效）**

```bash
# 必须在**本仓库根目录**执行：link:. 会被锚定到当前目录
dsh plugin --profile web add link:E:/code/dsh-use-wallpaper
```

> 仓库根 `package.json` 已声明 `dsh.bundle`，bundle 由 `cordis.patch.yml` 自动注册 —— **不要**手动改 profile 的 `package.json`，也**不要**往 profile 的 `cordis.patch.yml` 插条目（重复 insert 会报 `duplicate loader entry id`）。

### 2. 启用并选择壁纸

1. 重启 `dsh web`，打开 GUI。
2. 进入 **设置 → 侧边栏「Wallpaper 壁纸」**。
3. 填写**壁纸目录（workshop）**与**引擎目录（particle 纹理）**，或点 **自动探测** 采用探测结果。典型路径：
   - 壁纸目录：`D:/Steam/steamapps/workshop/content/431960`
   - 引擎目录：`D:/Steam/steamapps/common/wallpaper_engine`
4. 在缩略图网格中点选壁纸即可生效。

### 3. 验证

- `GET /wallpapers/list` 返回 JSON 壁纸数组。
- 浏览器 Console 出现 `[three] scene loaded id=… background=N particleLayers=M`（`M ≥ 1` 表示粒子层已建）。

### 4. 用插件市场索引源订阅（可选）

本仓库根目录提供一份 **format-1 插件市场索引**（[`index.json`](./index.json)，已用官方 `@deepseek-ai/dsh-plugin-market-index` 校验）。DSH 0.2.1 起可以把它加成一个索引源，之后在「插件 → 发现」里浏览与安装：

1. **插件 → 发现 → 索引源 → 添加**
2. 粘贴：`https://cdn.jsdelivr.net/gh/yu502950715yang/dsh-use-wallpaper@master/index.json`
3. 回到「发现」，搜索 **Wallpaper Engine**

> 也可以直接用上面的 `dsh plugin add` 命令安装，两条路径等价；索引源只是让插件在客户端里「可被逛到」。

---

## 🧰 配置项

下表的**设置字段**都能写进 profile `cordis.patch.yml` 的 `config`（面板里改过的值优先）。面板按分区暴露的是：

- **当前壁纸 / 壁纸目录**：`selectedWallpaperId`（缩略图点选）、`wallpaperDir` / `weAssetsDir`（手填 +「自动探测」）。
- **显示效果**：`overlayOpacity`、`blurEnabled` / `blurRadius`、`kenBurns`、`fitMode`、`glowEnabled` / `glowThreshold` / `glowStrength`。
- **性能与省电**：`paused`、`pauseOnHidden`、`qualityScale`、`soundEnabled`。
- **轮播**：`rotationEnabled`、`rotationIntervalMs`、`rotationOrder`。
- **文字可读性**：`textColorMode`、`textColor`、`textOutline`。
- **开机动画**（设置页顶部 tab「日常壁纸 / 开机动画」切换，与壁纸设置互不影响）：`bootAnimationEnabled`、`bootAnimationSource`、`bootAnimationWallpaperId` / `bootAnimationWallpaperKind`、`bootAnimationLocalPath`、`bootAnimationFitMode`、`bootAnimationMaxDurationMs`。

`frameCacheEnabled` **没有面板控件**（默认 `true`；要改只能写 profile `config`）。壁纸库的**收藏 / 隐藏 / 最近使用**与用户属性不是设置字段，只存 localStorage（见本节末尾）；**搜索 / 类型 / 排序是面板临时状态**，刷新即恢复默认。

| 字段 | 默认 | 说明 |
|---|---|---|
| `selectedWallpaperId` | 空 | 选中的壁纸（空 = 恢复 DSH 默认背景） |
| `wallpaperDir` | 空 | Steam workshop 壁纸目录 |
| `weAssetsDir` | 空 | Wallpaper Engine 安装目录（读内置粒子/效果纹理） |
| `overlayOpacity` | `0.35` | 壁纸层上方遮罩的不透明度；面板「显示效果」可调 |
| `blurEnabled` / `blurRadius` | `false` / `12` | 背景模糊与半径；面板「显示效果」可调 |
| `kenBurns` | `true` | 图片壁纸的缓慢缩放动效；面板「显示效果」可调 |
| `fitMode` | `cover` | 画面适配：`cover` 裁剪铺满 / `contain` 完整显示（可能留边）/ `stretch` 拉伸铺满；面板可调 |
| `glowEnabled` | `true` | 应用级光晕（全屏后处理，仅 scene 壁纸） |
| `glowThreshold` | `0.65` | 光晕亮度门槛（0–0.99，越低发光区域越多） |
| `glowStrength` | `0.35` | 光晕强度（0–4；2026-09-21 由 `1.0` 下调，防亮部过曝 —— 旧值在亮部多的壁纸上 `luma>200` 占比会涨 1.5 倍以上） |
| `paused` | `false` | 暂停壁纸渲染（省电；视频壁纸同时停播） |
| `pauseOnHidden` | `true` | 页面切到后台/最小化时自动暂停，回到前台恢复 |
| `qualityScale` | `1` | 画质档位：渲染像素比倍率（0.5–1，越小越省显存） |
| `soundEnabled` | `true` | 壁纸音效（sound 对象播放 + 驱动频谱类效果）；面板有开关，改完立即生效 |
| `rotationEnabled` | `false` | 自动轮播开关 |
| `rotationIntervalMs` | `300000` | 轮播间隔（1–30 分钟；面板档位为 1 / 5 / 10 / 30 分钟） |
| `rotationOrder` | `sequential` | 轮播顺序：`sequential` 顺序 / `random` 随机 |
| `frameCacheEnabled` | `true` | scene 首帧抓帧缓存（写入数据目录 `frames/`，供降级链使用）；面板无控件 |
| `bootAnimationEnabled` | `false` | 开机动画总开关（设置 →「Wallpaper 壁纸」→「开机动画」tab，默认关闭；默认不记忆 tab） |
| `bootAnimationSource` | `we` | 素材来源：`we` = WE 库壁纸 / `local` = 本地视频文件 |
| `bootAnimationWallpaperId` | 空 | WE 素材的壁纸 id（面板选择时与 kind 一起写入） |
| `bootAnimationWallpaperKind` | 空 | 素材类型：`video` / `image`（启动时免拉列表判断） |
| `bootAnimationLocalPath` | 空 | 本地视频的绝对路径（host 仅回环来源流式读取，拒绝 UNC / 网络路径） |
| `bootAnimationFitMode` | `cover` | 展示方式：`tile` 平铺（仅图片）/ `contain` 居中 / `stretch` 挤压 / `cover` 裁切填满 |
| `bootAnimationMaxDurationMs` | `6000` | 最长播放（0–30000 ms；0 = 视频播完为止，图片固定约 4 秒） |

优先级：用户设置 > profile `cordis.patch.yml` 的 `config` > 缺省。

> **DSH 版本兼容（2026-09-23）**：0.1.7-alpha.1 起 DSH 换了设置系统（命名空间 = profile **条目 id**，表单只认插件 `Config` 的 volatile 字段，改动写进 profile `cordis.patch.yml`）。本插件已做双路径适配，**同时支持 0.1.5-rc.3 / 0.1.6-alpha.2 与 0.1.7-alpha.2**（三版均真机验证：列表、面板读写、选中壁纸刷新后自动恢复）。
> 
> 想手工预置配置（两版通吃），写 profile `cordis.patch.yml`：
> 
> ```yaml
> - id: dsh-wallpaper-engine
>   config:
>     wallpaperDir: D:/Steam/steamapps/workshop/content/431960
>     weAssetsDir: D:/Steam/steamapps/common/wallpaper_engine
>     selectedWallpaperId: "3789244610"
> ```
> 
> 旧版（≤0.1.6）的 `~/.dsh/settings.yaml` 若被 0.1.7 启动过一次，会被改名为 `settings.yaml.imported`，其中的壁纸段不会再被读取 —— 把值抄进上面的 `config` 即可。
> 
> 说明：旧版兼容层是过渡性的。待 DSH 新版本稳定、本插件不再需要支持 ≤0.1.6 时，按 [迁移文档 §9「后续清理清单」](docs/superpowers/plans/2026-09-23-dsh-settings-compat-migration.md) 逐项移除（清单区分了可删的旧版专用代码、可简化的兼容技巧与**必须保留的 0.1.7 适配**）。

> 💡 **设置字段与本地状态**：上表的都是**设置字段**，可写进 profile `cordis.patch.yml` 的 `config`；面板改动除用户属性（提交后重装配当前壁纸才生效）外都**立即生效**。其中 `fitMode` / Ken Burns 只对图片 / 视频壁纸生效（scene 由渲染器自绘；Ken Burns 仅图片）。壁纸库的**收藏 / 隐藏 / 最近使用**（`we:fav` / `we:hidden` / `we:recent`）与**用户属性**（`we:userprop:<wallpaperId>:<key>`）是浏览器侧 UI 状态，**只存 localStorage**，不能写进 profile config，也不跨浏览器 / 端口同步。
> 
> ⚠️ 光晕默认值 `0.65` / `0.35` 是 **2026-09-21 由用户在真机面板上试出来的**（先按「亮部不过曝」把强度从 `1.0` 下调，阈值保持 `0.65` 以保留光晕感；6 张壁纸的参数网格数据见 `AGENT.md` §7.1）。它只保证「亮部不过曝 + 光晕仍可感」，**不是**与桌面 WE 逐像素对齐的结果 —— 你觉得还要更亮/更暗，面板两个滑杆可即时微调。

---

## 💡 效果为什么值得期待

- **动态是真的，不是贴图**：粒子会按原作者的设定运动（重力、风向、湍流、寿命、闪烁），水会流动起波纹，云会缓缓飘。不是拿一张静态图做位移。
- **尽量还原原版观感**：混合方式、粒子大小、发光叠加、色调都照着 Wallpaper Engine 的规则来，并对可复现样本做过桌面版逐像素对拍校准。
- **支持格式够全**：主流 scene 壁纸的纹理压缩格式（DXT1/3/5、RGBA、R8、RG88）与多帧精灵动画（火把、雾、光晕）都能解出原图，不会糊成一片或露黑边。
- **高清屏不浪费**：按设备像素比渲染，Retina / 高 DPI 屏上线条依然锐利。
- **出问题也不会砸掉你的界面**：scene 渲染失败或算不出可见内容时按**多级降级链**逐级回退（内嵌 MP4 → 抓帧 → 预览图）；视频壁纸解码失败或首帧超时会回退预览图并提示。**web 壁纸没有失败回退**（跨源 iframe 探测不到子帧错误），但界面本身始终可用。
- **换来这些的代价很小**：纯浏览器原生能力 + WebGL，**不需要 Wallpaper Engine 在后台运行**，也不需要 WebGPU。

---

## ⚠️ 使用前请了解

这一节帮你判断**自己的壁纸能不能正常显示**。壁纸库越冷门、效果越复杂，越可能命中下面几条。

> **如果你的壁纸出现异常，请务必拉到本节末尾** —— 那里写了反馈方式。壁纸写法千差万别，你的反馈是项目改进的主要来源。

**画面表现**

- **少数壁纸可能出现黑块或整体偏暗**：带复杂遮罩或特殊混合方式的壁纸会这样，**不是你没配好**。
- **粒子的旋转、拖尾（雨丝 / 风痕）、近大远小都已支持**，但**能不能看出来取决于壁纸本身** —— 只有规格里给了对应参数的粒子才会动。绳索类拖尾（`ropetrail`）尚未支持，会退化成普通贴图；**子粒子（子发射器，如火焰火星、雷电二次放电）尚未支持**。**起播相位（`starttime`）按原作者设定预推进，最多 15 秒**；对象级实例覆盖（`instanceoverride`）也按原设定生效。
- **时间 / 日期类文字会实时走字，作者挂在文字上的模糊 / VHS / 水波效果也会执行**；隔离渲染的文本尺寸在装配时固定，**跨分钟变宽时可能轻微裁边或拉伸**。壁纸自带的脚本跑不通时，退回内置时钟或跳过该层，**不会**把作者的占位文字画到屏幕上。
- **闪烁类粒子（火花、雨滴溅开等）已按桌面端表现对齐**：桌面上不显示的，这里也不画。
- **模糊、泛光、光轴、局部对比度会在本地实时执行**，挂在这些效果上的对象越简单越容易看出效果；极少数（如光轴）目前只确认到已执行，画面观感待确认。
- **壁纸音效默认播放**（设置 → 壁纸可关），音量与单次/循环模式按原设定生效；多文件音效每对象只播一首（OWE 的多文件轮播 / 播完重随机未实现）。随声音变化的效果也会跟着动；**包内音效驱动的频谱竖条已支持**（`Simple_Audio_Bars` 等效果；v0.8.2 起 `Simple Visualizer` 也会代建 64 条；v0.9 起其它 visualizer 家族按脚本参数代建、静音也有最小高度）。**系统音频（`supportsaudioprocessing`）已支持浏览器模式**：用浏览器打开 GUI → 面板「系统音频」→ 授权共享系统音频即可驱动视觉条；**桌面版 App 因宿主权限策略不可用**（面板会提示改用浏览器）。
- **应用级光晕默认开启**（设置 → 壁纸 → 「光晕」，阈值 / 强度可调、改完立即生效）：这是"桌面更亮"的主要来源。**嫌亮就调低强度或调高阈值；觉得偏暗就把强度调到 1~1.5。** 仅对 scene 壁纸生效。
- **壁纸级 bloom 也会按作者设定生效**（`general.bloom*`，阈值 / 强度原样）：与上面的「光晕」互相独立，同时开启时顺序固定为「壁纸 bloom → 应用级光晕」；`hdr` 未实现。
- **精灵表图标由作者脚本控制帧**：调用 `pause`/`setFrame` 的壁纸（如 `3765967112` 的日/夜图标）静止在脚本帧；无脚本的仍约 1 帧/秒自动循环。生产 GUI 里背景层不吃点击（`pointer-events:none`），按产品决策不做点击转发 ⇒ **点击切帧为已知边界**（e2e/harness 内可触发）。
- **纯文本 / 透明场景会铺作者设定的底色**（`general.clearcolor`，WE 多为 0-1 色值）；`clearenabled` 开关未消费。
- **输入框用半透明玻璃底**（不模糊），避免桌面端在输出回复时出现滚动条抖动。
- **视频壁纸能不能播，取决于浏览器的解码能力**：视频壁纸直接交给浏览器的 `<video>` 解码 —— HEVC / H.265 需要系统装有对应的解码扩展。**缺解码扩展时不再停在黑背景**：解码失败或 1.5 秒内没有首帧，会自动回退到预览图，并在设置 →「Wallpaper 壁纸」面板里提示原因（没有预览图则回退空态并同样提示）。想真正播放 HEVC，请换 Chrome 等能解该编码的浏览器，或把视频转成 H.264。
- **scene 渲染失败时按多级降级链回退**：见下方「降级链（scene 渲染失败时）」小节。
- **抓帧缓存放在本机数据目录**：scene 首帧渲染成功后会抓一张 PNG 存到 `~/.dsh-use-wallpaper/frames/`；设环境变量 `DSH_USE_WALLPAPER_DATA_DIR` 可整体搬走。单张 ≤ 12MB、最多 200 张（按修改时间淘汰最旧），随时可删 —— 删掉只会让下次渲染成功时重新抓，不影响画面。
- **Workshop 里的「预设壁纸」（preset）也能用**：这类项只有预览图和 `dependency`（依赖的主壁纸）+ 你保存的参数，自己不含场景；选中后会按依赖壁纸渲染，并套用预设里的参数值（例：`3163840671` = 3118949804 的预设版，标签显示 PRESET）。
- **越大的壁纸越吃显存**：4K 分辨率下单张壁纸可能占用数百 MB 显存。追求省电/流畅可以用小分辨率或选择简单的壁纸。

**环境要求**

- **仅 Windows 实测**，macOS 未测试。
- **多个 Steam 库都能探测到**：自动探测读 `steamapps/libraryfolders.vdf`（新版 Steam 的实际位置）与 `config/` 副本；此前只读安装根，装在第二个库里的壁纸会探测不到。
- **需要本机装有 Wallpaper Engine**：插件要从中读取内置的粒子与特效素材。没装或路径没配对时，粒子会退化为纯色圆点（画面仍在，不会白屏）。
- **浏览器需支持 WebGL2**（Chrome / Edge 均可）；**为了更接近 Wallpaper Engine 的效果，推荐使用 Chrome**。不支持 WebGL2 时自动退回预览图。

### 降级链（scene 渲染失败时）

scene 壁纸是实时算出来的，素材写法又千差万别，所以渲染失败是正常可能出现的情况。此时画面按下面的顺序逐级回退，**每一级失败只跳过、不弹错、不白屏**：

```
实时渲染（three.js 播放器：背景图层 + 粒子）
    │ 模块加载 / 装配失败，或渲染出 0 个可见对象 / 渲染异常
    ▼
① 内嵌 MP4 —— 作者打包在 .tex 里的视频纹理（动态画面优先）
    │ 没有内嵌视频 / 解码失败 / 1.5s 内无首帧
    ▼
② 抓帧 PNG —— 上次成功渲染时缓存的当前画面（最接近作者构图）
    │ 还没有抓到 / 帧文件已被删除
    ▼
③ 作者预览图 —— Wallpaper Engine 工坊页的封面（图片或 GIF）
    │ 作者没有提供 preview
    ▼
④ 空态 —— 恢复 DSH 默认背景
```

- 顺序的理由：**动态优先于静态**（内嵌 MP4 是作者原意），**当前构图优先于封面**（抓帧比工坊封面更接近实际画面）。
- 视频壁纸（非 scene）走另一条更短的链：`<video>` 解码 → 失败 / 首帧超时 → 预览图 → 空态，并在面板提示编码问题。
- 抓帧缓存目录是 `~/.dsh-use-wallpaper/frames/`（可用 `DSH_USE_WALLPAPER_DATA_DIR` 覆盖），详见上面的「画面表现」。

**发现壁纸有问题？欢迎反馈**

上面几条是已知情况，但壁纸库非常庞杂（每张壁纸都是原作者自己搭的效果，写法千奇百怪），**没被覆盖到的异常一定还有**。如果你发现某张壁纸渲染不对，请提 issue —— 这类反馈是项目最主要的改进来源。

👉 **[提交 Issue](https://github.com/yu502950715yang/dsh-use-wallpaper/issues/new)**

为了能快速定位，麻烦带上这几项（第一项最关键）：

1. **壁纸名称与 Workshop ID** —— 例如「Crimson Horizon，ID `3765967112`」。ID 可以在设置面板的壁纸目录里找到（`workshop/content/431960/<ID>/`）。
2. **现象描述** —— 是整屏黑掉、局部黑块、某个效果不动、粒子消失，还是画面偏色/过暗？
3. **对比信息（如果方便）** —— 同一张壁纸在桌面版 Wallpaper Engine 上的表现（截图对比最好）。有对比就能立刻区分「我们的缺陷」和「原作者的设定」。
4. **环境** —— 浏览器与版本、是否装了 Wallpaper Engine、显示器分辨率。
5. **Console 报错（可选但很有用）** —— 打开开发者工具 Console，搜 `[three]` 或 `[warn]` 相关的行，贴出来。

> 若某张壁纸能稳定复现问题，把它设为**唯一变量**（其他设置保持默认）会让排查快很多。

> 想看实现细节、效果链覆盖率和工程现状（如显存实测、性能门槛状态、未接入的备用路径），见 **[docs/technical-notes.md](docs/technical-notes.md)**。

---

## 🏗️ 架构一览

<sub>面向开发者与贡献者 —— 只想用的话可以跳过这一节。</sub>

<details>
<summary>展开目录结构与降级链</summary>

```
src/host/     Node 侧（Cordis 插件）：扫描壁纸目录、解包 PKGV0001、HTTP 路由、Steam 路径探测、settings
              ├─ data-dir / scene-frame-store  插件数据目录与抓帧 PNG 存储（原子写 + 限额淘汰）
              ├─ scene-media-probe             从 .tex 头探测内嵌 MP4（video-probe / embedded-video）
              └─ user-props                    project.json × scene.json 的四类型用户属性聚合（只返回被引用的键）
src/client/   浏览器侧（esbuild → dist/client.js），渲染主路径在这里
              ├─ threejs-player.ts    three.js 播放器（背景 Mesh + 粒子 billboard）
              ├─ three-renderer.ts    生产接线（loadSceneToThree + resize/dpr + 材质混合解析）
              ├─ tex-loader.ts        TEXV0005 解码（RGBA/DXT/RG88/R8 + 幂填充裁剪 + sprite 帧 + 行序）
              ├─ object-effects.ts    对象级效果链编排（ObjectEffectStage）
              ├─ effect-runner.ts     效果执行器（uniform 绑定 / 纹理槽 / pass 推进）
              ├─ scene-json / scene-assets / scene-graph / visibility  场景解析与几何
              ├─ scene-fallback / frame-export  scene 降级链（内嵌 MP4 → 抓帧 → 预览）与首帧 PNG 导出
              ├─ rotation / library-view / local-store  轮播调度、库筛选/收藏/隐藏、localStorage 封装
              ├─ wallpaper-properties / media-health  用户属性读写、视频解码失败提示
              ├─ wasm-loader.ts       wasm 引擎加载（只服务 CPU 粒子模拟）
              └─ index / wallpaper-controller / background-layer / settings / styles  引导、控制、背景层、设置
src/shared/   跨 host/client 类型（WallpaperInfo、SceneDescription、SceneObject 等）
wasm/         Rust 引擎（wasm-bindgen）：particle（CPU 粒子模拟）—— 旧 WebGPU 渲染器已删除
scripts/      build-client.mjs（esbuild 打包 + wasm 复制）；check-known-failures.mjs（CI 失败基线门禁）
tests/        vitest 单测（node + jsdom 双环境）
e2e/          端到端渲染验证（headless Edge + 生产 lib/ 逐像素判定，可上 CI）
.github/      CI：tsc + lib/ 产物新鲜度 / vitest 新增失败 / Windows 渲染 e2e
docs/         开发配置（dev-setup.md）；设计文档与实施计划（superpowers/*）；技术细节（technical-notes.md）；效果视频（videos/*）
```

**降级链**

```
scene 壁纸：
three.js 播放器（背景图层 + 粒子）
    │ 模块加载/创建失败，或渲染出 0 个可见对象
    ▼
内嵌 MP4（.tex 里的 Video 纹理）
    │ 无 / 播放失败 / 1.5s 无首帧
    ▼
抓帧 PNG（<dataDir>/frames/<id>.png；默认 ~/.dsh-use-wallpaper）
    │ 无缓存
    ▼
作者 preview 图 + Ken Burns
    │ 无 preview
    ▼
空态（DSH 默认背景）

video 壁纸：<video> 解码 → 失败 / 首帧超时 → preview 图 → 空态（面板提示编码问题）
```

</details>

---

## 🛠️ 构建与开发

```bash
pnpm install
pnpm run build          # tsc -p tsconfig.json → lib/（host 编译，strict）
pnpm run build:wasm     # cd wasm && wasm-pack build --target web --release --features cpu-sim → wasm/pkg/
pnpm run build:client   # node scripts/build-client.mjs → dist/client.js
pnpm test               # vitest run（node + jsdom 双环境）

# 端到端渲染验证（headless Edge + 生产 lib/，逐像素判定；失败置非零退出码）
pnpm run e2e:colorblend # 不依赖本机素材，CI 里跑的就是它
pnpm run e2e:hidpi      # 需本机 Wallpaper Engine 壁纸库
pnpm run e2e:compare    # A/B 截图逐像素对拍（零回归验收）
```

- **改过 `wasm/`（Rust）必须先 `build:wasm` 再 `build:client`** —— client 复制的是 `wasm/pkg` 的现成产物，顺序反了会复制旧 wasm。
- **client 侧改动（`dist/`）通常自动热重载**：web profile 始终挂载 `@deepseek-ai/dsh-client-hmr`，轮询 bundle 的 `mtime`/`size` 变化并推 `rebuilt` 帧。（**桌面版除外**：桌面版 host 在启动时就把客户端 bundle 拍成内存快照，改完 `dist/` 必须整个 App 重启 —— 见上面「1. 安装插件」的桌面版说明。）
- **host 侧改动（`lib/`）必须重启 `dsh web`**（host 模块热重载默认 `disabled`）。
- **CI**（`.github/workflows/ci.yml`）：`tsc` + `lib/` 产物新鲜度守卫、`vitest` 只对**新增**失败判红（基线在 `scripts/known-failures.json`）、Windows 上跑渲染 e2e（软件光栅化，不需要 GPU）。

---

## 🧹 卸载

```bash
dsh plugin --profile web remove "@dsh-use/wallpaper-engine"
dsh plugin --profile web install
# 重启 dsh web
```

> 桌面版在侧边栏 **插件** 页卸载（会二次确认）；`dsh plugin` 同样不适用于桌面版 profile（见「1. 安装插件」）。

---

## 📄 许可与致谢

- 代码：**MIT**。
- 壁纸、纹理等素材版权归原作者 / Wallpaper Engine 所有；本插件只在其上渲染，**不重新分发第三方素材**（WE 内置纹理在运行时从你本机安装目录读取）。
- 格式与行为语义对齐自 [linux-wallpaperengine](https://github.com/Almamu/linux-wallpaperengine) 及开源 Wallpaper Engine 逆向实现。
- 感谢[Linux.do](https://linux.do)社区对本项目的推广。
- README 中的效果视频由本插件的生产渲染代码在本机实测录制，仅用于展示。

---

## 🔗 相关链接

- [GitHub 仓库](https://github.com/yu502950715yang/dsh-use-wallpaper)
- [插件市场索引源 `index.json`](./index.json)（可粘贴到「插件 → 发现 → 索引源」）
- [dsh-plugin 主题页](https://github.com/topics/dsh-plugin)
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- [开发环境配置（docs/dev-setup.md）](docs/dev-setup.md)

## ⭐ Star History

[![Star History Chart](https://api.star-history.com/svg?repos=yu502950715yang/dsh-use-wallpaper&type=Date)](https://star-history.com/#yu502950715yang/dsh-use-wallpaper&Date)

