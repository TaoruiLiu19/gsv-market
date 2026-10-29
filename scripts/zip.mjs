// 安全的最小 ZIP 读取器（支持 store / deflate），用于校验投稿包。
// 只接受根目录下的普通文件，拒绝路径穿越、加密条目、超大包。
import { inflateRawSync } from 'node:zlib';

const MAX_ENTRIES = 20;
const MAX_FILE_BYTES = 12 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

function readU16(buf, offset) {
  if (offset < 0 || offset + 2 > buf.length) fail('ZIP 结构损坏（越界读取）');
  return buf.readUInt16LE(offset);
}

function readU32(buf, offset) {
  if (offset < 0 || offset + 4 > buf.length) fail('ZIP 结构损坏（越界读取）');
  return buf.readUInt32LE(offset);
}

function safeName(nameBytes) {
  const name = nameBytes.toString('utf8');
  if (!name || name.length > 200) fail('ZIP 内文件名非法');
  if (name.includes('\0') || name.includes('\\') || name.startsWith('/')) fail('ZIP 内文件名非法');
  const parts = name.split('/');
  if (parts.some((p) => p === '..' || p === '')) fail('ZIP 内文件名非法');
  if (parts.length > 1) fail('ZIP 只允许根目录文件');
  return name;
}

export function readZip(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf.length < 22) fail('不是有效的 ZIP 文件');
  let eocd = -1;
  const stop = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= stop; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) fail('不是有效的 ZIP 文件（缺少目录结尾）');

  const count = readU16(buf, eocd + 10);
  const centralSize = readU32(buf, eocd + 12);
  const centralOffset = readU32(buf, eocd + 16);
  if (count === 0) fail('ZIP 为空');
  if (count > MAX_ENTRIES) fail(`ZIP 条目过多（上限 ${MAX_ENTRIES}）`);
  if (centralOffset + centralSize > buf.length) fail('ZIP 结构损坏（目录越界）');

  const files = new Map();
  let total = 0;
  let offset = centralOffset;
  for (let i = 0; i < count; i++) {
    if (readU32(buf, offset) !== 0x02014b50) fail('ZIP 结构损坏（中央目录）');
    const flags = readU16(buf, offset + 8);
    const method = readU16(buf, offset + 10);
    const compSize = readU32(buf, offset + 20);
    const uncompSize = readU32(buf, offset + 24);
    const nameLen = readU16(buf, offset + 28);
    const extraLen = readU16(buf, offset + 30);
    const commentLen = readU16(buf, offset + 32);
    const localOffset = readU32(buf, offset + 42);
    if (flags & 0x1) fail('不支持加密 ZIP');
    if (method !== 0 && method !== 8) fail(`不支持的压缩方式（${method}）`);
    if (uncompSize > MAX_FILE_BYTES) fail('单个文件过大');
    total += uncompSize;
    if (total > MAX_TOTAL_BYTES) fail('ZIP 解压后总体积过大');
    const name = safeName(buf.subarray(offset + 46, offset + 46 + nameLen));
    if (files.has(name)) fail(`ZIP 内文件重复：${name}`);
    if (readU32(buf, localOffset) !== 0x04034b50) fail('ZIP 结构损坏（本地头）');
    const localNameLen = readU16(buf, localOffset + 26);
    const localExtraLen = readU16(buf, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    if (dataStart + compSize > buf.length) fail('ZIP 结构损坏（数据越界）');
    const raw = buf.subarray(dataStart, dataStart + compSize);
    let data;
    if (method === 8) {
      data = inflateRawSync(raw, { maxOutputLength: MAX_FILE_BYTES });
    } else {
      data = Buffer.from(raw);
    }
    files.set(name, data);
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}
