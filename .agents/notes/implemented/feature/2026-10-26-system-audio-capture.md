# Agent Note: 系统音频采集驱动音频可视化（浏览器模式）

Status: implemented

## Problem

桌面 WE 用 WASAPI loopback 采集系统音频（`project.json general.supportsaudioprocessing = true`），驱动 `registerAudioBuffers` 类 visualizer 与音频效果；本仓此前只有包内 sound 的 analyser 输入，`supportsaudioprocessing` 零实现 ⇒ 3118949804（Anime Girl With Purple Eyes）等「无包内音频、只靠系统音频」的壁纸视觉条始终为 0。

## Decision

- **仅浏览器模式实现**：面板「系统音频」按钮（仅 `supportsaudioprocessing: true` 的 scene 壁纸显示）→ `navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })`（video 是 Chromium 弹出「共享音频」选项的前提，捕获后不渲染）→ 独立 `AudioContext`：`MediaStreamAudioSourceNode → AnalyserNode → 静音 Gain(0) → destination`（静音汇点保证图被拉取且不重复出声）。
- 系统音频开启时频谱优先于包内 sound 驱动 `setAudioSpectrum` / `updateVisualizerBars`；停止共享（track `onended`）/切渲染器/卸载时自动清理（停 tracks + close context）。
- 失败开放并按原因回显：`unsupported`（桌面 App 宿主禁用/getDisplayMedia 缺失）、`denied`、`no-audio-track`（未勾共享音频）、`no-web-audio`、`error`；面板文案明确指引。
- host：`/wallpapers/properties` 响应附带 `audioProcessing`（读 project.json），client 据此显示入口。

## Alternatives considered

**桌面 Electron 原生 WASAPI loopback（host 侧 koffi/原生模块）**：跨平台与分发性成本高，且宿主主进程已显式调用 `setPermissionCheckHandler(() => false)`、`setDisplayMediaRequestHandler(callback({}))` 禁用相关权限。否决。

**麦克风 `getUserMedia({audio:true})`**：采集环境声而非系统输出，且桌面 App 同样被权限策略拒绝。否决。

**启动时自动请求系统音频**：浏览器要求用户手势 + 显式选择共享目标，无法自动；且未经同意持续采集系统声音不可接受。否决。

## Consequences

- 仅「浏览器打开同一 GUI 地址」可用；桌面 App 内明确不承诺（面板提示改用浏览器）。
- 每次捕获都需用户手势授权并选择共享目标；共享期间浏览器顶部显示「正在共享」指示（隐私透明）。不落盘、不上传。
- 与包内 sound 分析器隔离（独立 AudioContext），避免回声；`supportsaudioprocessing` 与包内音效同时存在时以系统音频优先。

## Affected repositories

- `dsh-use-wallpaper` 分支 `master` commits `9c17acc`
