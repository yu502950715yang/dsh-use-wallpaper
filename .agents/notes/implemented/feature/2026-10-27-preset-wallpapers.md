# Agent Note: WE 预设壁纸（preset）支持

Status: implemented

## Problem

`3163840671`（Anime Girl Purple Clean Wallpeaper）在设置面板显示类型 `UNKNOWN`，选中后只显示预览图。解包 project.json 发现它是 **WE 预设项**：没有 `type`/`file`，只有 `dependency: "3118949804"`、`preset`（用户保存的参数组合）与 `preview.jpg`；目录里没有 `scene.pkg`。桌面 WE 选中它时按依赖主壁纸渲染并套用 preset 参数。本仓 `kindFromProjectJson` 只认 `type` 四值 ⇒ 落入 `unknown`，且 scene 资源/属性都按自身目录查找（不存在）。

## Decision

- 类型 `preset`：`kindFromProjectJson` 在 type 未命中时，若 `dependency` 为非空字符串 → `'preset'`；`WallpaperInfo` 新增 `presetOf`（依赖 id），`hasScene` 取依赖目录的 `scene.pkg`。
- host `routes` 新增 `sceneResourceDir(id)`：自身无 scene.pkg 且有合法 dependency → 依赖目录。scene asset/video-probe/embedded-video、particle-texture、properties 全部经它解析；**preview/file 仍取自身目录**（preset 的预览图是自己的）。
- 属性：`collectUserProperties` 用依赖 project.json；`applyPresetDefaults` 再按 preset 同名键覆盖默认值（类型一致才覆盖）；`audioProcessing` 同取依赖。
- 渲染：`resolveBackground` 把 `preset` 与 scene/unknown 一样按场景渲染，**渲染键保留 preset 自身 id**（属性 localStorage、帧缓存、健康记录都按 preset 隔离）；依赖缺失时 `hasScene=false` 回退预览图。
- 面板：类型徽标自动 `PRESET`；类型筛选加「预设」；`selectedIsScene` 把 preset 也当 scene（属性面板/系统音频入口可用）。

## Alternatives considered

**把 preset 的渲染 id 直接映射为 dependency 并共用属性**：预设的独立参数值、per-id 覆盖与帧缓存都会丢失（多张 preset 无法区分），且面板里两张卡会显示同一状态。否决。

**仅在面板显示「预设」并禁用选择**：用户无法使用，与桌面 WE 行为不符。否决。

## Consequences

- preset 的渲染/属性都来自依赖，但行为与缓存按 preset id 隔离；依赖被移除时自动回退预览图。
- 只有 scene 类依赖被支持（preset 的 dependency 为 video/web 时 `hasScene=false` → 预览图）。
- 轮播池按 `type !== 'unknown'` 过滤，preset 自动进入池。

## Affected repositories

- `dsh-use-wallpaper` 分支 `master` commits `a841eea`
