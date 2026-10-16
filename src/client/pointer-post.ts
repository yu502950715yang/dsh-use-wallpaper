// 宿主 → web 壁纸 iframe 的指针直传：读**真实 clientX/Y**（不经屏幕坐标/object-fit/缩放的折算链，
// 该链是易错点）与相对 iframe 盒子的归一化值，一起 postMessage 出去。
// 归一化值是兜底：iframe 装在尺寸与宿主视口不同的容器（桌面壳的更大宿主视口）时，iframe 内
// `window.innerWidth` ≠ 宿主视口宽，此时按归一化值乘 iframe 自身视口才是正确映射。

export interface PointerPostPayload {
  /** 契约命名空间标记，值固定为 1。 */
  __wpPointer: number;
  nx: number;
  ny: number;
  px: number;
  py: number;
}

/** 按「指针落点相对 iframe 可见区」算坐标；在 iframe 盒子外（宿主视口大于 iframe 视口）时为 null。 */
export function computePointerPost(
  ev: { clientX: number; clientY: number },
  box: { left: number; top: number; width: number; height: number },
  tag: number,
): PointerPostPayload | null {
  const { width: w, height: h } = box;
  if (!(w > 0) || !(h > 0)) return null;
  const x = Number(ev.clientX) - box.left;
  const y = Number(ev.clientY) - box.top;
  const inside = x >= 0 && x <= w && y >= 0 && y <= h;
  return {
    __wpPointer: tag,
    nx: x / w,
    ny: y / h,
    px: inside ? Math.round(x) : -1,
    py: inside ? Math.round(y) : -1,
  };
}
