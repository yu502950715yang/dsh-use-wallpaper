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
.wp-picker{position:fixed;right:16px;top:16px;z-index:100;width:224px;max-height:80vh;overflow-y:auto;background:var(--wp-panel-bg);border:1px solid var(--wp-panel-border);border-radius:12px;padding:12px;backdrop-filter:blur(8px)}
.wp-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
.wp-thumb{position:relative;display:flex;flex-direction:column;align-items:center;gap:4px;padding:6px;background:transparent;border:1px solid var(--wp-panel-border);border-radius:10px;cursor:pointer;color:var(--wp-text);font:inherit}
.wp-thumb img{width:96px;height:96px;object-fit:cover;border-radius:8px;display:block}
.wp-thumb-title{font-size:12px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wp-thumb.wp-selected{border-color:var(--wp-accent);box-shadow:0 0 0 1px var(--wp-accent)}
.wp-badge{position:absolute;top:2px;right:2px;font-size:9px;line-height:1;padding:2px 4px;border-radius:4px;background:var(--wp-badge-bg);color:var(--wp-badge-fg)}
.wp-fab{position:fixed;right:16px;bottom:16px;z-index:120;width:44px;height:44px;border-radius:50%;border:1px solid var(--wp-panel-border);background:var(--wp-panel-bg);color:var(--wp-text);font-size:13px;font-weight:700;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.35);backdrop-filter:blur(8px)}
.wp-fab:hover{filter:brightness(1.1)}
.wp-picker-panel{position:fixed;right:16px;bottom:72px;top:auto;left:auto;z-index:110}
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
