import { applyMediaSnapshot } from './media-input.js';
export function createMediaOrchestration(opts) {
    const { host, bindings } = opts;
    let started = false;
    let disposed = false;
    let paused = false;
    let input = null;
    // 面板状态：只记 reason/available/enabled；绝不缓存 title/artist（隐私）。
    let status = {
        available: false,
        reason: opts.getEnabled() ? 'no-session' : 'disabled',
        enabled: opts.getEnabled(),
    };
    const report = (error) => {
        try {
            opts.onError?.(error);
        }
        catch { /* 错误消费者异常不阻断媒体链路 */ }
    };
    const safely = (fn) => {
        try {
            fn();
        }
        catch (error) {
            report(error);
        }
    };
    const neutralThumbnail = (payload) => ({
        hasThumbnail: payload.hasThumbnail,
        primaryColor: payload.palette.primary,
        secondaryColor: payload.palette.secondary,
        tertiaryColor: payload.palette.tertiary,
        textColor: payload.palette.text,
        highContrastColor: payload.palette.highContrast,
    });
    const sink = {
        status: (enabled) => safely(() => host.mediaStatus(enabled)),
        playback: (state) => safely(() => host.mediaPlayback(state)),
        properties: (props) => {
            safely(() => host.mediaProperties(props));
            // 文本脚本 binding 逐个隔离：一个脚本异常不影响其余 binding 与后续 thumbnail。
            for (const binding of bindings)
                safely(() => binding.dispatchMediaProperties(props));
        },
        thumbnail: (payload) => safely(() => {
            const mapped = opts.onThumbnail ? opts.onThumbnail(payload) : neutralThumbnail(payload);
            if (mapped)
                host.mediaThumbnail(mapped);
        }),
    };
    const applyDirty = () => safely(() => opts.applyDirty(host.drainDirty(), opts.lookup));
    const ensureInput = () => {
        if (input)
            return input;
        const created = opts.createInput({
            ...opts.inputOptions,
            onSnapshot: (next, prev) => {
                if (disposed)
                    return; // dispose 后迟到响应不得落到已释放的 host/脚本
                // 快照先记状态（reason 只用于面板提示，不含曲目字段）。
                status = { ...status, available: next.available, reason: next.reason };
                applyMediaSnapshot(prev, next, sink);
            },
            onError: report,
        });
        input = created;
        return created;
    };
    return {
        start() {
            if (started || disposed)
                return;
            started = true;
            const enabled = opts.getEnabled();
            status = { available: false, reason: enabled ? 'no-session' : 'disabled', enabled };
            sink.status(enabled);
            sink.playback('stopped');
            applyDirty(); // 必须在首帧前同步落地（否则媒体层先画一帧白色占位）
            if (!enabled)
                return; // 关闭态只派事件、不建轮询
            const active = ensureInput();
            if (!paused)
                active.start();
        },
        setEnabled(enabled) {
            if (disposed)
                return;
            status = { available: false, reason: enabled ? 'no-session' : 'disabled', enabled };
            sink.status(enabled);
            if (!enabled) {
                sink.playback('stopped');
                input?.stop();
                applyDirty();
                return;
            }
            const active = ensureInput();
            // stop() 已清 prev ⇒ 首个 poll 按首帧重放完整快照（status/playback/properties/thumbnail）。
            if (!paused)
                active.start();
        },
        setPaused(value) {
            if (disposed || value === paused)
                return;
            paused = value;
            if (!input)
                return; // 输入尚未创建：启用/start 时按 paused 决定是否启动
            input.setPaused(value);
            if (!value && opts.getEnabled())
                input.start();
        },
        dispose() {
            if (disposed)
                return;
            disposed = true;
            const active = input;
            input = null;
            active?.dispose();
        },
        getStatus() {
            return { ...status };
        },
    };
}
