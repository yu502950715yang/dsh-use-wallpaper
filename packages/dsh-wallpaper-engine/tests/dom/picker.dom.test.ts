import { describe, expect, it, vi } from 'vitest';
import { mountPicker } from '../../src/client/picker.js';

describe('mountPicker', () => {
  it('renders thumbnails and click selects wallpaper', async () => {
    document.body.innerHTML = '';
    const root = document.createElement('div');
    document.body.appendChild(root);
    const selected: string[] = [];
    const controller = {
      load: async () => ([
        { id: '1', title: 'EVA', type: 'scene', hasScene: true, hasPreviewGif: false, previewUrl: '/p1' },
        { id: '2', title: 'Video', type: 'video', file: 'a.mp4', hasScene: false, hasPreviewGif: false, previewUrl: '/p2' },
      ] as any),
      select: async (id: string) => { selected.push(id); },
    };
    await mountPicker(root, controller as any, { currentId: '1', onSelect: (id) => controller.select(id) });
    const thumbs = root.querySelectorAll('.wp-thumb');
    expect(thumbs.length).toBe(2);
    expect((root.querySelector('.wp-thumb-title') as HTMLElement).textContent).toBe('EVA');
    (thumbs[1] as HTMLElement).click();
    expect(selected).toEqual(['2']);
  });
  it('marks current selection', async () => {
    document.body.innerHTML = '';
    const root = document.createElement('div');
    document.body.appendChild(root);
    await mountPicker(root, { load: async () => ([{ id: '1', title: 'A', type: 'unknown' }] as any), select: async () => {} } as any, { currentId: '1' });
    expect(root.querySelector('.wp-thumb')!.classList.contains('wp-selected')).toBe(true);
  });
});
