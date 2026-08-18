// 严格验证：以 16 字节头部布局（version(4)+magic(8)+unknown(4)）解析全部 scene.pkg，
// 校验 scene.json 是否真正可解析、条目偏移是否有效。
// 输出每包的：魔数版本 / 条目数 / scene.json 是否合法 JSON / 可疑名称
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const WALLPAPER_DIR = 'D:/Steam/steamapps/workshop/content/431960';
const dirs = readdirSync(WALLPAPER_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name);

let ok = 0, fail = 0;
for (const id of dirs) {
  const pkgPath = join(WALLPAPER_DIR, id, 'scene.pkg');
  if (!existsSync(pkgPath)) continue;
  const buf = readFileSync(pkgPath);
  const version = buf.readUInt32LE(0);
  const magic = buf.toString('ascii', 4, 12);

  // 严格解析：16 字节头部
  const entries = [];
  let pos = 16, tableEnd = -1;
  let parseOk = true;
  try {
    while (pos + 8 <= buf.length) {
      const nameLen = buf.readUInt32LE(pos);
      if (nameLen <= 0 || nameLen > 1024) { tableEnd = pos; break; }
      const nameStart = pos + 4;
      const name = buf.toString('utf8', nameStart, nameStart + nameLen);
      if (/[\x00-\x08\x0e-\x1f]/.test(name)) { parseOk = false; break; } // 名字含控制字符 → 布局不对
      const off = buf.readUInt32LE(nameStart + nameLen);
      const size = buf.readUInt32LE(nameStart + nameLen + 4);
      if (off > buf.length || size > buf.length) { parseOk = false; break; }
      entries.push({ name, off, size });
      pos = nameStart + nameLen + 8;
      if (entries.length > 10000) break;
    }
  } catch { parseOk = false; }
  const dataStart = tableEnd < 0 ? pos : tableEnd;

  let scJson = false, scInfo = '';
  const sc = entries.find(e => e.name.endsWith('scene.json'));
  if (parseOk && sc) {
    const abs = dataStart + sc.off;
    if (abs + sc.size <= buf.length) {
      const head = buf.toString('utf8', abs, abs + Math.min(sc.size, 32)).trimStart();
      scJson = head.startsWith('{');
      if (!scJson) scInfo = ` 内容开头=${JSON.stringify(head.slice(0, 24))}`;
    } else {
      scInfo = ' scene.json 越界';
    }
  } else if (!sc) {
    scInfo = ' 未找到 scene.json';
  }

  const status = (parseOk && scJson) ? 'OK' : 'FAIL';
  if (status === 'OK') ok++; else fail++;
  console.log(`[${status}] ${id}  ${magic}  条目=${parseOk ? entries.length : '?'}  scene.json=${scJson ? '合法' : '失败'}` + scInfo);
  if (!parseOk) {
    // 打印头部 64 字节帮助判断布局差异
    const hex = Array.from(buf.subarray(0, 64)).map(b => b.toString(16).padStart(2, '0')).join(' ');
    console.log('        头部64B: ' + hex);
  }
}
console.log(`\n共 ${ok + fail} 个 scene.pkg：可解析 ${ok}，失败 ${fail}`);
