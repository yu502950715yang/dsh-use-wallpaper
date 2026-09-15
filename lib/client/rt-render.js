/**
 * 把 `scene` 渲染进 `target`：渲染前把清屏 alpha 置 0（透明黑），渲染后恢复。
 *
 * 退出时渲染目标被复位为 null（与既有调用点一致：调用方随后都渲染主场景 → 画布）。
 * 返回值为渲染前的清屏 alpha（供诊断/测试断言；renderer 不支持时为 null）。
 */
export function renderIntoRenderTarget(renderer, target, scene, camera) {
    const caps = renderer;
    const canToggle = typeof caps.getClearAlpha === 'function' && typeof caps.setClearAlpha === 'function';
    const prevAlpha = canToggle ? caps.getClearAlpha() : null;
    const needToggle = canToggle && prevAlpha !== 0;
    if (needToggle)
        caps.setClearAlpha(0);
    try {
        renderer.setRenderTarget(target);
        renderer.render(scene, camera);
    }
    finally {
        renderer.setRenderTarget(null);
        if (needToggle)
            caps.setClearAlpha(prevAlpha);
    }
    return prevAlpha;
}
