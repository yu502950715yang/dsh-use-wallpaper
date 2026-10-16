export interface PointerPostPayload {
    /** 契约命名空间标记，值固定为 1。 */
    __wpPointer: number;
    nx: number;
    ny: number;
    px: number;
    py: number;
}
/** 按「指针落点相对 iframe 可见区」算坐标；在 iframe 盒子外（宿主视口大于 iframe 视口）时为 null。 */
export declare function computePointerPost(ev: {
    clientX: number;
    clientY: number;
}, box: {
    left: number;
    top: number;
    width: number;
    height: number;
}, tag: number): PointerPostPayload | null;
