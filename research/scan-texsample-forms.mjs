// 统计 texSample2D/ApplyComposite 的全部调用形态（研究用）
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const WALLPAPER_DIR = 'D:/Steam/steamapps/workshop/content/431960';
function unpack(id) {
  const buf = readFileSync(join(WALLPAPER_DIR, id, 'scene.pkg'));
  const entries = [];
  let pos = 16, dataStart = -1;
  while (pos + 8 <= buf.length) {
    const nameLen = buf.readUInt32LE(pos);
    if (nameLen <= 0 || nameLen > 1024) { dataStart = pos; break; }
    const nameStart = pos + 4;
    const name = buf.toString('utf8', nameStart, nameStart + nameLen);
    const off = buf.readUInt32LE(nameStart + nameLen);
    const size = buf.readUInt32LE(nameStart + nameLen + 4);
    entries.push({ name, off, size });
    pos = nameStart + nameLen + 8;
  }
  const files = new Map();
  for (const e of entries) files.set(e.name, buf.subarray(dataStart + e.off, dataStart + e.off + e.size));
  return files;
}

const forms = {};
const applyCompositeForms = {};
const texSampleForms = {};
for (const id of readdirSync(WALLPAPER_DIR)) {
  const pkgPath = join(WALLPAPER_DIR, id, 'scene.pkg');
  if (!existsSync(pkgPath)) continue;
  const files = unpack(id);
  for (const [name, data] of files) {
    if (!/\.(frag|vert)$/.test(name)) continue;
    const src = Buffer.from(data).toString('utf8');
    // 提取 texSample2D 调用参数形态
    const re = /texSample2D\s*\(([^)]*)\)/g;
    let m;
    while ((m = re.exec(src))) {
      const args = m[1].split(',').map(s => s.trim());
      const key = args.length + 'arg:' + args.map(a => /^g_Texture\d+$/.test(a) ? 'tex' : (/^vec[234]/.test(a) ? 'vec' : 'expr')).join(',');
      texSampleForms[key] = (texSampleForms[key] ?? 0) + 1;
    }
    const re2 = /ApplyComposite(?:Offset)?\s*\(([^)]*)\)/g;
    while ((m = re2.exec(src))) {
      const args = m[1].split(',').map(s => s.trim());
      const key = args.length + 'arg:' + args.map(a => /^g_Texture\d+$/.test(a) ? 'tex' : (/^vec[234]/.test(a) ? 'vec' : 'expr')).join(',');
      applyCompositeForms[key] = (applyCompositeForms[key] ?? 0) + 1;
    }
  }
}
console.log('texSample2D 调用形态:', JSON.stringify(texSampleForms, null, 1));
console.log('ApplyComposite 调用形态:', JSON.stringify(applyCompositeForms, null, 1));
