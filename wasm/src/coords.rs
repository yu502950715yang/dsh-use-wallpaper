//! WE 场景坐标（左下原点、y 向上；origin.y 是距底部的距离）→ 中心原点、y 向上。
//! 公式：three.x = we.x - vw/2；three.y = we.y - vh/2（两系 y 同向，**不做翻转**）。
//!
//! ⚠️ 这条「y 不翻」是硬约定（AGENT.md §2.3）：旧实现 `vh/2 - we_y` 会把非居中对象上下镜像
//! （NERV logo origin.y=150 官方在右下角、被镜像到右上角；EVA 主图 oy=sh/2 恰为 0 故验收漏过）。
//! 2026-09-08 起 CPU 粒子发射点也统一用本函数（scene 尺寸、y 不翻），不再有独立的 Y 翻层。
//!
//! 2026-09-22：原 `origin_to_center` / `particle_scale` / `image_center_ndc` / `image_half_ndc`
//! 只服务已删除的 WebGPU 渲染器（NDC 数学），随之移除；只留 `we_to_three`（`particle/sim.rs` 在用）。

pub fn we_to_three(we_x: f32, we_y: f32, vw: f32, vh: f32) -> (f32, f32) {
    (we_x - vw / 2.0, we_y - vh / 2.0)
}
