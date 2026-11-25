# Agent Note: 粒子 controlpointattract 的力模型与覆盖值口径

Status: implemented

## Problem

`3825702259`「Where the World Falls Asleep」的 birds 粒子与桌面有两处不一致：

1. **方向被拽回**：桌面是「一群从右侧飞入、穿到左侧消失」，插件里鸟群飞到左半屏又被拽回右侧来回摆。
2. **鸟群扇开、飘高**：修完方向后鸟群在左半屏散成一大片，且整体比桌面高约 200 px。

追下来是 `controlpointattract` 的两处实现偏差：

- 力漏了官方的线性衰减：旧实现整段 `threshold` 半径内都是满力（`scale·dt`），而 WE/OWE 是
  `impulse = scale·dt·(1 − d/threshold)`（OWE `ParticleParser.cpp:1368-1386`）。鸟群是**高速掠过半径边缘**
  （进入时已 300–700 px/s），真实施加的力只有几 px/s²，满力实现把它当成了强力弹簧。
- `instanceoverride.controlpointN` 被**累加**到 spec 的 offset 上：吸引点被推到发射点外 4~7k px
  （局部 4321/1195），差动力把鸟群扇开、还让鸟群继续往天空上缘飘。OWE `ParticleRuntime.cpp::UpdateControlpoints`
  是 **replace**（`controlpoint.offset = position`）。

另一处独立偏差：镜像粒子对象的精灵朝向。WE 把对象 model 矩阵（含负 scale）乘到**每个 quad 顶点**上
（`assets/shaders/genericparticle.vert:88-89`、`common_particles.h:54-59`），旧实现角点用 `abs(objScale)`
（只缩放不镜像）⇒ 精灵表朝右的鸟在桌面上「朝左飞、朝左看」，插件里「朝左飞、朝右看」。

用户提供的桌面截图给出了几何真值：鸟群包围盒 **582×657**、中心 **(1099,1003)**（scene 坐标，2560×1440）。

## Decision

- `wasm/src/particle/sim.rs`：attract 力改为 `k = scale·dt·(1 − dist/threshold)/dist`（线性衰减；`threshold`
  仍不折半 —— lwe 那个 `/2` 是它的偏差）。
- `wasm/src/particle/sim.rs::resolve_controlpoint_attract`：覆盖过的控制点用 **override 替换** spec 的 offset，
  未覆盖的才用 spec offset（都以发射点为基准）。
- `src/client/particle-assets.ts`：quad 角点与 spritetrail 偏移改用**带符号** `objScale`（正 scale 位级不变）。
- 判据：`wasm` 单测（衰减、replace）＋ `tests/threejs-player.test.ts` 的 shader 契约（带符号 scale、不含 `abs`）。

## Consequences

- 方向：世界 vx 变号 7 → **0**，单向穿屏；鸟群被按在天空中段（8 次连跑：包围盒 549×399、中心 (1169,1088)，
  桌面 582×657 / (1099,1003)）。
- **仍有已知偏差**：纵向比桌面紧（399 vs 657 px）—— cp1 的 2048 半径覆盖整条路径、持续把鸟群压向 y≈974。
  lwe 的 `threshold/2` 实测会松到 912 px（过头），本库没有第二张同类素材可定标，**先不调参**，等样本再定。
- 影响面：本库只有这张壁纸会真正生成 attract 算子（其余目标都是 mouse/worldspace，本实现本来跳过）；
  精灵镜像影响 10 张壁纸 / 22 个镜像粒子对象。
- 取证与复现产物（gitignored）：`output/birds-direction/`（桌面/插件对照图、轨迹、散布脚本）。

## Alternatives considered

- **被覆盖的控制点直接不生成算子**（曾临时采用）：能同时消掉掉头与扇群，但桌面截图证明两个吸引点**确实在作用**
  （鸟群到 cp2 中位 735 < 1024、到 cp1 1118 < 2048，且中心正好落在两点 y 之间），所以放弃。
- **只用 spec 偏移、不消费 override**（lwe 口径）：鸟群被钉在屏外右侧，与桌面「有鸟穿屏」矛盾。
- **把力整体调小 / threshold 折半**：前者没有依据；后者实测 450×912，纵向过头。
