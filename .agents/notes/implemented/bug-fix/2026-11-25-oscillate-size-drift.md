# Agent Note: oscillatesize 按「乘到当前值」漂移，对齐桌面星点尺寸

Status: implemented

## Problem

`3819637149`「Somewhere In Nowhere」的大四角星（`Big Stars 1/2`，`sizerandom` 125..180 / 110..160）
在插件里明显比桌面大：同一片天空 1:1 对比，桌面最大星斑 15~16 px，插件 25~31 px。

排查发现尺寸公式本身两边一致（`sizerandom` → 顶点 `w = size×0.5` → shader 四边形宽 = `size/2`，
与我们的 `particleSize` 等价），差异只在 `oscillatesize`：

- 官方/OWE `OscillateScalarOperator::Apply` 是 `values[slot] *= GetScale(t)` —— **乘到当前值上**，
  尺寸随存活时间漂移；
- 我们实现成 `size = base × GetScale(t)` —— 每帧回基准，星一直停在 0.6~1.2× 区间里（偏大端）。

## Decision

按漂移语义实现，但取**连续极限的期望**而不是逐帧相乘：逐帧乘依赖帧率（60 fps 下一两秒就缩没，
与桌面持续可见矛盾），改为包络 `mean^age`，其中 `mean = (scalemin + scalemax)/2`：

```rust
let mean_scale = (scale_min + scale_max) * 0.5;
let drift = mean_scale.powf(t);
p.size = (base * multiplier * drift).max(0.0);
```

- `0.6..1.2` ⇒ 每秒 ×0.9，6 秒后 ≈0.53×；区间均值为 1（如萤火虫 `0.9..1.1`）时 `drift ≡ 1`，不漂移。
- `drift` 夹在 `[0.25, 4.0]`：spec 是第三方数据，均值 >1 会指数放大（上万 px 的 quad 打满填充率），
  均值过小会让粒子几秒内缩到看不见。
- `oscillatealpha` **不加**这个包络：`scalemin 0.2` 的星座若按同样方式漂移会在 1 秒内淡没，
  与桌面「星持续闪烁」矛盾。

## Consequences

- 桌面实测星径 15~16 px，本实现改后 14~17 px（1920 视口、scale 0.4815），两侧一致；
- 全库只有 4 个对象带 `oscillatesize`（`3819637149` 两枚、`3811798465` 两枚萤火虫），
  萤火虫区间均值为 1、行为不变；
- 星点会随存活时间缓慢变小（几秒内 0.9^n），肉眼是「逐渐变暗变小」，与桌面观感一致。

## Alternatives considered

- **照抄 OWE 逐帧相乘**：与帧率强相关，60 fps 下 `0.9^60` 让粒子 1 秒内消失；`alpha` 更极端（`0.2^60`）。
- **全局把粒子尺寸再 /2**：能对上这张壁纸的星，但会把已经对上的鸟群/花瓣/流星一起缩小，且与
  `sizerandom/2` 的既有口径冲突。
- **不动**：星点偏大且不随时间变化，与桌面观感始终有差。
