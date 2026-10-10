# docs/fixes —— 历史归档（AGENT.md 精简的搬迁目标）

2026-10-10 精简 `AGENT.md` 时，把**已修记录、实验数据、一次性扫描结果、审计轨迹**从这里对应的文件搬出，`AGENT.md` 只保留现状、硬约束与真遗留。

- **入口文档**：仓库根的 [`AGENT.md`](../../AGENT.md)（§5 硬约束 / §7 当前遗留 / §8 归档索引）。
- **精简前的完整版**：`git show 0734406:AGENT.md`（含 §1–§4 / §6 的旧措辞与所有长段实验记录）—— 本目录只搬了下列内容，其余靠 git 历史。
- **规则**：归档文件只作查阅，**不要往这里追加新内容**；新的结论、边界与遗留写回 `AGENT.md` 的 §5 / §7。

| 文件 | 来源 | 内容 |
|---|---|---|
| [`conventions-details.md`](conventions-details.md) | AGENT.md §5（原第 122–314 行） | §5 全部条目的**原文**（实测数据、推导、历史事故、订正痕迹）；编号与 `AGENT.md` 的 §5.x 一一对应（`### §5.N` 小节） |
| [`threejs-path-fixes.md`](threejs-path-fixes.md) | AGENT.md §7 组一（原第 331–574 行） | three.js 主路径的修复过程与遗留：对象效果链验收表、Glow 网格标定与显存/性能实测、text/脚本/动态网格/自旋等各条记录，以及「备用 wasm/JS 路径已删除」节 |
| [`web-wallpaper-history.md`](web-wallpaper-history.md) | AGENT.md §7 组二（原第 576–582 行） | web 壁纸的定位过程与已修记录（opaque origin、resize 自适应、首帧空白） |
| [`verification-ci-history.md`](verification-ci-history.md) | AGENT.md §7 组三 + §3.3（原第 584–599 行与第 93 行） | 验证手段、CI 三个坑的排查过程、测试基线的历史记录、e2e harness 的漏检分析 |

## 编号约定

- **§5.x / §7.x 的编号沿用历史**（多处代码注释与 `docs/superpowers/` 按这些编号引用）：`AGENT.md` 的 §7 有**空号**，表示该条已结案、记录在本目录里；`AGENT.md` §7.30+ 是本次精简新增的续号。
- 归档文件里的条目保留**搬迁时的原编号**（§7 组一 1–28、组二 13–16、组三 9–13 曾各自从 1 起算），因此跨文件看编号会重号 —— 以标题为准。
