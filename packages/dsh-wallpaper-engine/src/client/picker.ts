import type { WallpaperInfo } from '../shared/types.js';

export interface PickerOptions {
  currentId: string;
  onSelect: (id: string) => void;
}

export async function mountPicker(
  root: HTMLElement,
  controller: { load(): Promise<WallpaperInfo[]> },
  opts: PickerOptions,
): Promise<void> {
  const list = await controller.load();
  root.classList.add('wp-picker');
  root.replaceChildren();
  const grid = document.createElement('div');
  grid.className = 'wp-grid';
  for (const w of list) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'wp-thumb' + (w.id === opts.currentId ? ' wp-selected' : '');
    item.dataset.id = w.id;
    const img = document.createElement('img');
    if (w.previewUrl) img.src = w.previewUrl;
    img.alt = w.title;
    const badge = document.createElement('span');
    badge.className = 'wp-badge';
    badge.textContent = w.type.toUpperCase();
    const title = document.createElement('span');
    title.className = 'wp-thumb-title';
    title.textContent = w.title;
    item.append(img, badge, title);
    item.addEventListener('click', () => opts.onSelect(w.id));
    grid.appendChild(item);
  }
  root.appendChild(grid);
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.textContent = '刷新壁纸列表';
  refresh.addEventListener('click', () => void mountPicker(root, controller, opts));
  root.appendChild(refresh);
}
