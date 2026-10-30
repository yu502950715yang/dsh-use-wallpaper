import type { MediaPropertiesPayload } from '../shared/media.js';
export interface TextScriptBinding {
    /** 调脚本 update(value) 取新文本；抛错/超时 → null（调用方保持上一帧）。 */
    update(): string | null;
    /** 派发 mediaPropertiesChanged（无该 handler 的脚本忽略）；异常只丢该事件。 */
    dispatchMediaProperties(props: MediaPropertiesPayload): void;
    dispose(): void;
}
export interface TextScriptRuntime {
    /** 绑定一个 text 脚本；eval 失败/无 update → null（调用方回退）。 */
    bind(script: string, scriptProperties: Record<string, unknown>, initialValue: string): TextScriptBinding | null;
    /** 向所有活动 binding 广播媒体属性事件。 */
    dispatchMediaProperties(props: MediaPropertiesPayload): void;
    dispose(): void;
}
export declare function getTextScriptRuntime(): Promise<TextScriptRuntime | null>;
/** 单测用：丢弃单例（不销毁已建实例）。 */
export declare function resetTextScriptRuntimeForTest(): void;
