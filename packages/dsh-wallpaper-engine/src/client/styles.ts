const CSS = `
/* ── 壁纸层基础（与主题无关） ── */
.wp-background-layer{position:fixed;inset:0;z-index:0;overflow:hidden;pointer-events:none}
.wp-bg-fill{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
.wp-bg-fill img,.wp-bg-fill video,.wp-bg-fill iframe{width:100%;height:100%;object-fit:cover;border:0}
.wp-scene-blur{position:absolute;inset:0;width:100%;height:100%;filter:blur(30px) brightness(.9);transform:scale(1.1)}
.wp-scene-canvas{position:relative;width:100%;height:100%;object-fit:fill}
.wp-bg-fill img{user-select:none}
.wp-kenburns{animation:wp-kenburns 24s ease-in-out infinite alternate}
@keyframes wp-kenburns{from{transform:scale(1) translate(0,0)}to{transform:scale(1.12) translate(-2%,-1%)}}
/* 遮罩：黑色半透明（alpha 内聚于 background，不叠加 opacity 属性；
   浅色主题下同样为深色遮罩，保证文字可读） */
.wp-bg-overlay{position:absolute;inset:0;background:rgba(0,0,0,.25)}

/* ── 插件 UI 主题变量（随 DSH 主题，无壁纸时同样生效） ── */
body:not([data-ds-dark-theme]){
  --wp-panel-bg:rgba(255,255,255,.9);
  --wp-panel-border:rgba(0,0,0,.12);
  --wp-text:#1a1a1e;
  --wp-badge-bg:rgba(0,0,0,.55);
  --wp-badge-fg:#fff;
  --wp-accent:#4f8cff;
}
body[data-ds-dark-theme]{
  --wp-panel-bg:rgba(20,22,28,.92);
  --wp-panel-border:rgba(255,255,255,.12);
  --wp-text:#eee;
  --wp-badge-bg:rgba(0,0,0,.65);
  --wp-badge-fg:#fff;
  --wp-accent:#4f8cff;
}

/* ── 壁纸激活层级方案（参考 dsh-liang-skin）：壁纸层 z-index:0 + prepend 到 body 最前；
   仅在有壁纸（body[data-we-wallpaper]）时把 DSH 主内容背景透明化让壁纸透出；
   无壁纸时保持 DSH 原有背景（浅色主题不被破坏）。 */
body[data-we-wallpaper] #root{position:relative;z-index:1;background:transparent!important}
body[data-we-wallpaper] #root [style*="grid-template-columns"]{background:transparent!important}
body[data-we-wallpaper]{background:transparent!important}
body[data-we-wallpaper]{--dsw-alias-bg-base:transparent!important}

/* ── 浅色分支：有壁纸 + 非深色主题 ── */
body[data-we-wallpaper]:not([data-ds-dark-theme]){
  /* 浅色主题灰阶按近白底调校，壁纸透出后失去对比 → 压暗整条文字 token（竞品同款） */
  --dsw-alias-label-primary:#000;
  --dsw-alias-label-primary-dimmed:rgb(10,10,12);
  --dsw-alias-label-secondary:rgb(40,42,46);
  --dsw-alias-label-tertiary:rgb(70,73,79);
  --dsw-alias-label-caption:rgb(110,114,120);
  --dsw-alias-label-dimmed:rgb(50,52,56);
  /* 玻璃面板：半透明白（壁纸色透过） */
  --dsw-specific-input-major:rgba(255,255,255,.15);
  --dsw-specific-bubble:rgba(255,255,255,.12);
  /* 侧栏：浅色半透明 */
  --dsw-specific-sidebar-fill:rgba(255,255,255,.55);
}

/* ── 深色分支：有壁纸 + 深色主题 ── */
body[data-ds-dark-theme][data-we-wallpaper]{
  /* 玻璃更透（避免白雾感） */
  --dsw-specific-input-major:rgba(255,255,255,.06);
  --dsw-specific-bubble:rgba(255,255,255,.05);
  /* 侧栏：深色半透明 */
  --dsw-specific-sidebar-fill:rgba(20,22,28,.55);
}

/* ── 插件 UI 组件（变量驱动，随主题） ── */
.wp-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
.wp-thumb{position:relative;display:flex;flex-direction:column;align-items:center;gap:4px;padding:6px;background:transparent;border:1px solid var(--wp-panel-border);border-radius:10px;cursor:pointer;color:var(--wp-text);font:inherit}
.wp-thumb img{width:96px;height:96px;object-fit:cover;border-radius:8px;display:block}
.wp-thumb-title{font-size:12px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wp-thumb.wp-selected{border-color:var(--wp-accent);box-shadow:0 0 0 1px var(--wp-accent)}
.wp-badge{position:absolute;top:2px;right:2px;font-size:9px;line-height:1;padding:2px 4px;border-radius:4px;background:var(--wp-badge-bg);color:var(--wp-badge-fg)}

/* ── 设置对话框 "壁纸" 面板（settings-section，用 DSH 主题变量） ── */
.wss-root{display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary,var(--wp-text));font-size:13px}
.wss-hint{color:var(--dsw-alias-label-secondary,var(--wp-text));margin:0;font-size:12px;line-height:1.6}
.wss-current{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:13px}
.wss-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px;max-height:280px;overflow-y:auto;padding:2px}
.wss-thumb{position:relative;display:flex;flex-direction:column;align-items:center;gap:4px;padding:6px;background:var(--dsw-alias-bg-layer-3,transparent);border:1px solid var(--dsw-alias-border-l2,var(--wp-panel-border));border-radius:10px;cursor:pointer;color:var(--dsw-alias-label-primary,var(--wp-text));font:inherit;min-width:0}
.wss-thumb img{width:84px;height:84px;object-fit:cover;border-radius:8px;display:block}
.wss-thumb .wss-no-preview{width:84px;height:84px;display:flex;align-items:center;justify-content:center;border-radius:8px;background:var(--dsw-alias-bg-module-platform,rgba(0,0,0,.08));font-size:11px;color:var(--dsw-alias-label-tertiary,var(--wp-text))}
.wss-thumb-title{font-size:12px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wss-thumb.wss-selected{border-color:var(--wp-accent);box-shadow:0 0 0 1px var(--wp-accent)}
.wss-badge{position:absolute;top:2px;right:2px;font-size:9px;line-height:1;padding:2px 4px;border-radius:4px;background:var(--wp-badge-bg);color:var(--wp-badge-fg)}
.wss-cancel,.wss-save-dirs,.wss-probe,.wss-adopt{border:1px solid var(--dsw-alias-border-l2,var(--wp-panel-border));background:var(--dsw-alias-bg-layer-3,var(--wp-panel-bg));color:var(--dsw-alias-label-primary,var(--wp-text));border-radius:8px;padding:6px 12px;font:inherit;font-size:12px;cursor:pointer}
.wss-cancel:hover,.wss-save-dirs:hover,.wss-probe:hover,.wss-adopt:hover{filter:brightness(1.08)}
.wss-dirs h4{margin:10px 0 6px;font-size:13px}
.wss-dir-row{display:flex;flex-direction:column;gap:4px;margin-bottom:8px;font-size:12px;color:var(--dsw-alias-label-secondary,var(--wp-text))}
.wss-dir-row input{border:1px solid var(--dsw-alias-border-l2,var(--wp-panel-border));background:var(--dsw-alias-bg-layer-3,var(--wp-panel-bg));color:var(--dsw-alias-label-primary,var(--wp-text));border-radius:8px;padding:6px 10px;font:inherit;font-size:12px}
.wss-dir-actions{display:flex;gap:8px}
.wss-probe-result{border-top:1px solid var(--dsw-alias-border-l2,var(--wp-panel-border));padding-top:10px;margin-top:4px}
.wss-candidate{display:flex;align-items:center;gap:8px;padding:4px 0}
.wss-candidate-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-secondary,var(--wp-text))}
.wss-exists{color:var(--dsw-alias-state-success-primary,#4caf50);font-size:11px;white-space:nowrap}
.wss-missing{color:var(--dsw-alias-label-tertiary,var(--wp-text));font-size:11px;white-space:nowrap}
.wss-message{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary,var(--wp-text))}
`;
export const WALLPAPER_CSS = CSS;
export function injectWallpaperStyles(): void {
  const id = 'dsh-wallpaper-engine/styles';
  if (document.querySelector(`style[data-plugin-css="${id}"]`)) return;
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-wallpaper-engine';
  tag.dataset.pluginCss = id;
  tag.textContent = WALLPAPER_CSS;
  document.head.appendChild(tag);
}
