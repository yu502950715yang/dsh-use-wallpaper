# Agent Note: web 壁纸指针直传（宿主 postMessage → iframe shim）

Status: implemented

## Problem

web 壁纸的「跟随鼠标」在插件里**整类失效**，且症状看不出原因：壁纸自己的脚本（`jquery.parallax` 等）在 iframe 里正常初始化、每帧都在写 `transform`，只是写出来的永远是 `translate3d(0,0,0)`。

根因是**两条各自都正确的设计撞在一起**：

- 背景层必须是 `pointer-events:none`（`styles.ts`）—— 否则一个 `position:fixed;inset:0` 的层会吞掉整个 GUI 的点击；
- web 壁纸必须挂在**跨源** iframe 里（隔离 + WebGL 贴图同源，`background-layer.ts`），而这类壁纸普遍把视差绑在**自己 window 的 `mousemove`** 上。

`pointer-events:none` 的子树永远不是事件目标 ⇒ iframe 永远收不到 `mousemove`；跨源又让宿主无法转发事件进去。于是「隔离」与「交互」直接互斥，而 scene 壁纸不受影响（它的视差读 `general.cameraparallax*`，走完全另一条通路）—— 这个不对称正是排查时最容易走错的地方。

## Decision

**宿主 → iframe 的单向指针直传**，两侧都不动 `pointer-events`、也不碰壁纸文件：

- **host 注入**：`/wallpapers/web` 对 `.html` 响应在 `<head>` 后内联插入 `src/shared/pointer-shim.ts` 的 `POINTER_SHIM_SOURCE`（转义 `</script` 与 `<!--`；无锚点返回 null ⇒ 原样返回，绝不改坏）。放 `shared/` 而不是 `client/`：host 要把它内联进响应，客户端与测试要按同一契约断言，它本来就不属于任何一侧。
- **shim 的手段是「直接调用」而非「派发」**：patch `EventTarget.prototype.addEventListener` 记下壁纸注册的 mouse 类 handler，收 `postMessage` 后**直接调用它**（`new MouseEvent` 仍然构造，作为 event 参数）。`pointer-events:none` 下恰恰**不存在可派发的目标**，所以事件转发这条路本来就是死的 —— 这是整个方案的关键取舍。
- **坐标给两份**：宿主按 iframe 盒子算的像素 `px/py`（避开屏幕坐标 / `object-fit` / 缩放折算链）优先，缺失或越界时回退归一化 `nx/ny × iframe 自身视口`（桌面壳的宿主视口可以比 iframe 视口大，此时只有归一化值正确）。
- **生命周期**：指针监听只在 web 帧存活期间挂着，并跟着**可见帧**重挂（resize 重建会换帧）、用 token 作废旧闭包；`detachPointerPost` 在切背景 / 清空时摘掉。
- **范围**：对所有 web 壁纸生效，不做开关，不写死壁纸 id。

## Affected repositories

- `dsh-use-wallpaper` 分支 `master` commits `6a62e0f` `746ad1b`

## Alternatives considered

**把背景层改成可交互（去掉 `pointer-events:none`）。** 最省事，一行 CSS 就能让壁纸自己收到真实 `mousemove`，且不需要 shim、不需要 postMessage。不用它是因为背景层是 `inset:0` 的固定层：点击会被它吃掉，GUI 面板、按钮、文本选择全部受影响 —— 用「GUI 不可用」换「壁纸会动」不是可接受的交易。

**宿主把真实事件转发进 iframe。** 语义最干净（壁纸收到的是真事件）。不用它有两个独立理由：跨源 iframe 拿不到子帧的 `EventTarget`；且 `pointer-events:none` 意味着宿主自己在壁纸区域**也**收不到事件，源头上就没有可转发的事件。

**改壁纸自己的 HTML/JS（加监听、改库）。** 最直接。不用它是因为**壁纸目录只读**（用户明令，`AGENT.md` §6）—— 那是用户自己的创作。同理，`document.write` 加载 jQuery 的壁纸也不能靠「改它一行」解决。

**让 shim 遍历 DOM 找 `data-depth` 之类的壁纸特征去驱动动画。** 只对 `jquery.parallax` 这一类有效。不用它是因为那等于在插件里重写每种视差库，而 shim 只认「mouse 监听」这一个通用契约，对任何自绘 `mousemove` 视差的壁纸都成立。

**把 shim 做成独立的 `/wallpapers/web/<id>/__wp-pointer.js` 外链脚本。** 比内联干净。不用它有两个理由：外链会多一次请求、且在 `file://` 或异常 base 下可能解析失败；更关键的是内联脚本在 `document.write` 期间会**静默不执行**，而外链脚本不会 —— 本仓当前没有 `document.write` 路径，一旦将来有，shim 必须改走外链。这条已写进 `AGENT.md` §5.48 作为约束。

## Consequences

**收益：** 本机样本 `1184182304` 从「五层静态图」变成与桌面 WE 同形的鼠标视差（真机 headless Edge 实测：raw 模式零位移零像素变化，shim 模式位移 > 100px、像素变化 > 90%）；这条路对**任何**监听 `mousemove` 的 web 壁纸都成立，不需要逐库适配；`pointer-events` 与沙箱设计都没被动过，scene 路径零改动。

**代价：** ① shim 只保留**最后一个** mouse 类监听（单个 handler 无法重复注册，记多个也无从同时调用）—— 真实用法（一个 `window.mousemove`）落在契约内，但一个壁纸同时挂多个 mousemove 监听时只有最后一个会动；② 只合成 mouse 事件，**不合成 wheel / click / 键盘** ⇒ 依赖滚轮或点击的 web 壁纸仍不可交互（`pointer-events:none` 的前提没变，这属于本方案的能力边界，不是回归）；③ 注入是**改写响应**：任何对 `/wallpapers/web` 响应体的字节级假设都不再成立（非 HTML 与非锚点文件逐字节原样，已有测试钉住）；④ 无手动开关，「web 壁纸跟随鼠标」在极端情况下（壁纸自身的 mousemove 行为很怪）不能关掉；⑤ 视觉终验仍是真机人工项（`TESTING.md` §2.12），自动化只覆盖到「像素确实动了」。

约束与判据见 `AGENT.md` §5.48；与 scene 视差（§5.47 / §7.39）是两条互不相干的通路。
