import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
export function kindFromProjectJson(pj) {
    const t = String(pj.type ?? '');
    if (t === 'scene' || t === 'video' || t === 'web' || t === 'image')
        return t;
    return 'unknown';
}
export async function scanWallpapers(dir) {
    const out = [];
    let ids;
    try {
        ids = readdirSync(dir, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name);
    }
    catch {
        return out;
    }
    for (const id of ids) {
        const pjPath = join(dir, id, 'project.json');
        if (!existsSync(pjPath))
            continue;
        let pj;
        try {
            // 顶层非对象 JSON（null/数组/标量）视为损坏，跳过该目录（I5）
            const parsed = JSON.parse(readFileSync(pjPath, 'utf8'));
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
                continue;
            pj = parsed;
        }
        catch {
            continue;
        }
        const hasScene = existsSync(join(dir, id, 'scene.pkg'));
        const preview = existsSync(join(dir, id, 'preview.gif')) ? 'gif' : existsSync(join(dir, id, 'preview.jpg')) ? 'jpg' : null;
        out.push({
            id,
            title: String(pj.title ?? id),
            type: kindFromProjectJson(pj),
            file: typeof pj.file === 'string' ? pj.file : undefined,
            hasPreviewGif: preview === 'gif',
            hasScene,
            previewUrl: preview ? `/wallpapers/media/${id}/preview` : '',
        });
    }
    return out;
}
