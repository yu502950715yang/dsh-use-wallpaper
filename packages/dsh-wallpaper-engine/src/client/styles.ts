const CSS = `
.wp-background-layer{position:fixed;inset:0;z-index:0;overflow:hidden;pointer-events:none}
.wp-bg-fill{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
.wp-bg-fill img,.wp-bg-fill video{width:100%;height:100%;object-fit:cover}
.wp-scene-blur{position:absolute;inset:0;width:100%;height:100%;filter:blur(30px) brightness(.9);transform:scale(1.1)}
.wp-scene-canvas{position:relative;width:100%;height:100%;object-fit:fill}
.wp-bg-fill img{user-select:none}
.wp-kenburns{animation:wp-kenburns 24s ease-in-out infinite alternate}
@keyframes wp-kenburns{from{transform:scale(1) translate(0,0)}to{transform:scale(1.12) translate(-2%,-1%)}}
.wp-bg-overlay{position:absolute;inset:0;background:#000;opacity:.35}
.wp-picker{position:fixed;right:16px;top:16px;z-index:100;width:224px;max-height:80vh;overflow-y:auto;background:rgba(20,22,28,.92);border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:12px;backdrop-filter:blur(8px)}
.wp-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
.wp-thumb{position:relative;display:flex;flex-direction:column;align-items:center;gap:4px;padding:6px;background:transparent;border:1px solid rgba(255,255,255,.1);border-radius:10px;cursor:pointer;color:#eee;font:inherit}
.wp-thumb img{width:96px;height:96px;object-fit:cover;border-radius:8px;display:block}
.wp-thumb-title{font-size:12px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wp-thumb.wp-selected{border-color:#4f8cff;box-shadow:0 0 0 1px #4f8cff}
.wp-badge{position:absolute;top:2px;right:2px;font-size:9px;line-height:1;padding:2px 4px;border-radius:4px;background:rgba(0,0,0,.65);color:#fff}
.wp-fab{position:fixed;right:16px;bottom:16px;z-index:120;width:44px;height:44px;border-radius:50%;border:1px solid rgba(255,255,255,.14);background:rgba(20,22,28,.9);color:#eee;font-size:13px;font-weight:700;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.35);backdrop-filter:blur(8px)}
.wp-fab:hover{background:rgba(40,44,54,.95)}
.wp-picker-panel{position:fixed;right:16px;bottom:72px;top:auto;left:auto;z-index:110}
/* 层级方案（参考 dsh-liang-skin）：壁纸层 z-index:0 + prepend 到 body 最前；
   将 DSH 主内容 #root 提升到 z-index:1 并置透明，让壁纸从 #root 下方透出。 */
#root{position:relative;z-index:1;background:transparent!important}
/* DSH 主布局 frame（三列 grid）默认 background:var(--dsw-alias-bg-base) 不透明，会盖住壁纸层；
   以其内联 grid-template-columns 为唯一锚点置透明（侧栏 sidebarCol 仍保留自身背景）。 */
#root [style*="grid-template-columns"]{background:transparent!important}
/* DSH 深色主题也给 body 设了不透明背景（rgb(21,21,23) 等）；一并置透明。 */
body{background:transparent!important}
/* 覆盖 DSH 大块背景 token（参考 dsh-liang-skin）：对话区根容器 wSkVaW_root 等用
   var(--dsw-alias-bg-base)，深色主题下是不透明 rgb(21,21,23)，会盖住壁纸。
   将其置透明；侧栏 token 改半透明以保留导航可读性。
   内容元素（聊天气泡/代码块）用各自 token（--dsw-specific-bubble 等）保持不透明。 */
body{
  --dsw-alias-bg-base:transparent!important;
  --dsw-specific-sidebar-fill:rgba(20,22,28,.55)!important;
}
`;
export function injectWallpaperStyles(): void {
  const id = 'dsh-wallpaper-engine/styles';
  if (document.querySelector(`style[data-plugin-css="${id}"]`)) return;
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-wallpaper-engine';
  tag.dataset.pluginCss = id;
  tag.textContent = CSS;
  document.head.appendChild(tag);
}
