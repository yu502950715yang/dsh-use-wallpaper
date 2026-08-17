// PKGV0001 格式试探解析器（research 用，后续可演化为插件模块）
// 校验标准：解析出的 scene.json 内容必须是合法 JSON
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pkgPath = process.argv[2] ?? 'D:/Steam/steamapps/workshop/content/431960/1280029027/scene.pkg';
const buf = readFileSync(pkgPath);
console.log('file size:', buf.length);

const version = buf.readUInt32LE(0);
const magic = buf.toString('ascii', 4, 12);
console.log('version:', version, 'magic:', JSON.stringify(magic));
if (magic !== 'PKGV0001') { console.log('unknown magic'); process.exit(1); }

// 试探布局: nameLen(u32) + name + [\0?] + offset(u32) + size(u32)
// 从 12 字节处开始，解析全部条目，输出条目表并验证 scene.json
function tryParse(label, headerSize, nameTerminated, fieldOrder) {
  let pos = headerSize;
  const entries = [];
  try {
    while (pos + 4 <= buf.length) {
      const nameLen = buf.readUInt32LE(pos);
      if (nameLen <= 0 || nameLen > 512) break; // 保护
      const nameStart = pos + 4;
      let nameEnd = nameStart + nameLen;
      if (nameTerminated) {
        // 名字后可能带 \0：如果 nameLen 包含 \0 则减一
        if (nameEnd <= buf.length && buf[nameEnd] === 0) nameEnd++; // 跳过 \0
      }
      const name = buf.toString('utf8', nameStart, nameStart + nameLen).replace(/\0+$/, '');
      let off = 0, size = 0;
      if (fieldOrder === 'offset-size') {
        off = buf.readUInt32LE(nameEnd);
        size = buf.readUInt32LE(nameEnd + 4);
      } else {
        size = buf.readUInt32LE(nameEnd);
        off = buf.readUInt32LE(nameEnd + 4);
      }
      entries.push({ name, off, size });
      pos = nameEnd + 8;
      if (entries.length > 5000) break;
    }
  } catch (e) { console.log(label, 'parse error:', e.message); return null; }

  // 验证：条目数合理 + scene.json 内容可解析 + 无重叠且 offset 不指向头部
  const n = entries.length;
  if (n < 5 || n > 500) { console.log(label, `n=${n} 不合理`); return null; }
  const sc = entries.find(e => e.name.endsWith('scene.json'));
  if (!sc) { console.log(label, '无 scene.json'); return null; }
  if (sc.off + sc.size > buf.length) { console.log(label, 'scene.json 越界'); return null; }
  const data = buf.toString('utf8', sc.off, sc.off + Math.min(sc.size, 64));
  if (!data.trimStart().startsWith('{')) { console.log(label, `scene.json 非JSON开头: ${JSON.stringify(data.slice(0,48))}`); return null; }
  // 连续性检查
  const sorted = [...entries].sort((a, b) => a.off - b.off);
  let contiguous = true;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].off < sorted[i - 1].off + sorted[i - 1].size) { contiguous = false; break; }
  }
  console.log(`\n[${label}] OK  n=${n}  scene.json@${sc.off} size=${sc.size}  连续存储=${contiguous}`);
  for (const e of entries.slice(0, 12)) console.log('  ', e.off.toString().padStart(8), e.size.toString().padStart(8), e.name);
  if (entries.length > 12) console.log('   ... 共', entries.length, '条');
  return entries;
}

// 新布局：header(12) + entries[ nameLen(u32) + name + off(u32) + size(u32) ]，数据段紧跟文件表，off 为相对数据段偏移
function tryParse2(label) {
  let pos = 16; // 头部: version(4) + magic(8) + 未知(4)
  const entries = [];
  let tableEnd = -1;
  try {
    while (pos + 8 <= buf.length) {
      const nameLen = buf.readUInt32LE(pos);
      if (nameLen <= 0 || nameLen > 1024) { tableEnd = pos; break; } // 非法则视为文件表结束
      const nameStart = pos + 4;
      const name = buf.toString('utf8', nameStart, nameStart + nameLen);
      const off = buf.readUInt32LE(nameStart + nameLen);
      const size = buf.readUInt32LE(nameStart + nameLen + 4);
      entries.push({ name, off, size });
      pos = nameStart + nameLen + 8;
      if (entries.length > 10000) break;
    }
  } catch (e) { console.log(label, 'parse error:', e.message); return null; }
  if (tableEnd < 0) tableEnd = pos;
  const dataStart = tableEnd;
  console.log(`\n[${label}] 条目=${entries.length} 文件表结束@0x${tableEnd.toString(16)} 数据段起点=0x${dataStart.toString(16)}`);

  // 连续性: 按文件表顺序 off 应连续递增
  let contiguous = true;
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].off !== entries[i - 1].off + entries[i - 1].size) { contiguous = false; break; }
  }
  console.log(`按表序连续=${contiguous}`);
  const sc = entries.find(e => e.name.endsWith('scene.json'));
  if (!sc) { console.log('无 scene.json'); return null; }
  const abs = dataStart + sc.off;
  if (abs + sc.size > buf.length) { console.log('scene.json 越界'); return null; }
  const data = buf.toString('utf8', abs, abs + Math.min(sc.size, 64));
  const okJson = data.trimStart().startsWith('{');
  console.log(`scene.json 绝对偏移=0x${abs.toString(16)} size=${sc.size} 内容开头: ${JSON.stringify(data.slice(0, 40))} JSON开头=${okJson}`);

  for (const e of entries.slice(0, 10)) console.log('  ', (dataStart + e.off).toString(16).padStart(8), e.size.toString().padStart(8), e.name);
  if (entries.length > 10) console.log('   ... 共', entries.length, '条');
  return { entries, dataStart };
}

const r = tryParse2('PKGV0001 布局验证');
if (r) {
  // 统计类型
  const ext = {};
  for (const e of r.entries) {
    const m = e.name.match(/\.([a-z0-9]+)$/i);
    const k = m ? m[1].toLowerCase() : '(none)';
    ext[k] = 1 + (ext[k] ?? 0);
  }
  console.log('\n文件类型统计:', JSON.stringify(ext, null, 2));
}
