/**
 * 把 `scene` 渲染进 `target`（缺省透明清屏），退出时把渲染目标复位为 null。
 * 返回渲染前的清屏 alpha（供测试断言；renderer 不支持时为 null）。
 */
export function renderIntoRenderTarget(renderer, target, scene, camera, options) {
    const caps = renderer;
    const canToggle = typeof caps.getClearAlpha === 'function' && typeof caps.setClearAlpha === 'function';
    const prevAlpha = canToggle ? caps.getClearAlpha() : null;
    const needToggle = options?.preserveClearAlpha !== true && canToggle && prevAlpha !== 0;
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
