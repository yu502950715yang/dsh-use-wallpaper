# web 壁纸的历史与遗留（§7 组二）

> 归档文件（2026-10-10 从 `AGENT.md` 逐字搬出，编号保持原样）。原有编号 13–16（与组一重号），文中以标题为准。
> 精简后的入口文档是仓库根的 `AGENT.md`；本文只作历史与细节查阅。
### web 壁纸（`type: web`）

13. **非回环且非桌面壳的访问仍退回 opaque origin 沙箱**：承载 origin 优先级见 §5.30（桌面壳 transport origin → 回环互换 → 兜底）。局域网 IP / 隧道访问 GUI 时既无回环名、也无 `__DSH_TRANSPORT__` ⇒ 仍退回同源 + `allow-scripts`（opaque origin）⇒ 依赖 WebGL 贴图的 web 壁纸空白（纯 DOM/CSS 的 web 壁纸不受影响）。未做「另起端口」方案（与设计文档「不另起端口」冲突）。
14. **web 壁纸无失败回退**：设计文档承诺的「失败检测回退 preview」未实现（跨源 iframe 拿不到子帧错误，只能靠壁纸自身配合）；web 壁纸渲染失败时背景会停在空白而不是 preview 图。
15. **web 壁纸 resize 自适应已修（2026-09-22，用户报告 `3789244610` 调窗口后不跟随）**：先分三层定位（`research/_q-web-resize.mjs`，未入库）——① 宿主 `.wp-background-layer` / `.wp-bg-fill` / iframe 的 rect **完全跟随**；② iframe 内 `window.innerWidth` / `documentElement.clientWidth` **完全跟随**（1256×628 → 900×520 → 1600×900）；③ **壁纸自己的 `canvas#container` 卡在 1256×628** —— `index.min.js` 初始化时 `W.width = window.innerWidth * dpr` 且 `W.style.width = innerWidth + 'px'` 一次性快照，全 bundle **无 resize 监听**（唯一的 `resize:function(){}` 是空实现）。⇒ 瓶颈在壁纸内部，而跨源 iframe（§5.30 的双回环主机名方案）既不能注入脚本、`contentDocument` 也是 null。**修法**：只对有 `webUrl` 的 web 背景挂 `window.resize`（切走即摘），尺寸**真的变了**才 debounce 300ms 后**按新视口重建 iframe**；新帧 `visibility:hidden` 预载（保留布局 ⇒ 壁纸读到的视口正确），`load` 后 `replaceChildren` 换帧（旧帧留到新帧就绪，不留白），预载 8s 超时则撤掉新帧、保留旧帧（宁可尺寸不对也不留白）；重建复用探活得到的 `altOrigin`，sandbox / `allow` / `scrolling` 与首帧一致。**e2e**（`research/_q-web-resize-e2e.mjs`，gitignore；A/B = `git show HEAD:src/client/background-layer.ts` 打包 vs 当前 `lib/`，宿主编排走真实 `createBackgroundLayer` + CDP `Emulation.setDeviceMetricsOverride`）：视口 1280×720 → 1600×900 后，旧版画面只到 1256×628、右侧与底部出现**标准差 0 的纯色带**（壁纸 body 背景），新版铺满且网格分布与 resize 前一致；新增 7 项 DOM 单测（16 绿）。**边界（如实）**：判变化只看 `innerWidth/innerHeight`，**跨屏拖动导致的 dpr 变化不触发重建**；重建会让壁纸动画/视频从头开始，而 CSS 自适应的 web 壁纸（本库 `1184182304`、`3778198228` 实测都跟随）本不需要重建 —— 跨源探测不到壁纸是否快照了视口，故**统一重建**；未做真机 GUI 目检（与其它条目同一边界）。

16. **web 壁纸「启动首帧空白、resize 才显示」已修（2026-09-30）**：根因 / 修法 / 证据见 §5.40（未挂载就赋 `src` ⇒ 跨源 OOPIF 冷启动视口 0 ⇒ 壁纸把画布快照成 0×0）。与第 15 条是**同一张壁纸的两个不同缺陷**：第 15 条管「窗口变化后不跟随」，本条管「首次装载就画不出来」。单测：`tests/dom/background-layer.dom.test.ts`「showWeb：iframe 先挂载并强制布局，之后才赋 src（否则跨源子帧视口为 0）」。
