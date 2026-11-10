export declare class PointerPostBridge {
    private token;
    private fn;
    private target;
    /** 挂到可见帧；重复 attach（resize 重建）前先摘旧监听。 */
    attach(frame: HTMLIFrameElement): void;
    /** 卸载：摘监听并作废在途 token（幂等）。 */
    detach(): void;
}
