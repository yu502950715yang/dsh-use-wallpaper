const CSS = `
.wp-background-layer{position:fixed;inset:0;z-index:-1;overflow:hidden;pointer-events:none}
.wp-bg-fill{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
.wp-bg-fill img,.wp-bg-fill video,.wp-scene-canvas{width:100%;height:100%;object-fit:cover}
.wp-bg-fill img{user-select:none}
.wp-kenburns{animation:wp-kenburns 24s ease-in-out infinite alternate}
@keyframes wp-kenburns{from{transform:scale(1) translate(0,0)}to{transform:scale(1.12) translate(-2%,-1%)}}
.wp-bg-overlay{position:absolute;inset:0;background:#000;opacity:.35}
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
