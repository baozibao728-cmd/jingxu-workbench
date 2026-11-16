import {open} from 'node:fs/promises';
import {crc32, deflateRawSync, inflateRawSync} from 'node:zlib';

// 最小的 ZIP 读写，只为项目导出、导入服务：不加密、不分卷、不支持 ZIP64（单包 4GB 以内）。
const LIMIT = 0xffffffff;
const dosTime = date => ({
  time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
  date: (Math.max(0, date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
});

export class ZipWriter {
  // write(buffer) 可以返回 Promise，用来等下游消化（HTTP 响应的背压）。
  constructor(write, date = new Date()) { this.write = write; this.entries = []; this.offset = 0; this.stamp = dosTime(date); }
  async add(name, data, { compress = false } = {}) {
    const file = Buffer.from(name, 'utf8'), raw = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const packed = compress ? deflateRawSync(raw) : raw, method = compress ? 8 : 0, crc = crc32(raw);
    if (raw.length >= LIMIT || this.offset + packed.length + file.length + 30 >= LIMIT || this.entries.length >= 65535) throw new Error('导出内容超过 4GB，请分几次导出');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6); header.writeUInt16LE(method, 8);
    header.writeUInt16LE(this.stamp.time, 10); header.writeUInt16LE(this.stamp.date, 12); header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(packed.length, 18); header.writeUInt32LE(raw.length, 22); header.writeUInt16LE(file.length, 26);
    this.entries.push({ file, method, crc, packed: packed.length, size: raw.length, offset: this.offset });
    for (const part of [header, file, packed]) { await this.write(part); this.offset += part.length; }
  }
  async finish() {
    const start = this.offset;
    for (const entry of this.entries) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(0x0800, 8); header.writeUInt16LE(entry.method, 10);
      header.writeUInt16LE(this.stamp.time, 12); header.writeUInt16LE(this.stamp.date, 14); header.writeUInt32LE(entry.crc, 16);
      header.writeUInt32LE(entry.packed, 20); header.writeUInt32LE(entry.size, 24); header.writeUInt16LE(entry.file.length, 28); header.writeUInt32LE(entry.offset, 42);
      for (const part of [header, entry.file]) { await this.write(part); this.offset += part.length; }
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(this.entries.length, 8); end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(this.offset - start, 12); end.writeUInt32LE(start, 16);
    await this.write(end); this.offset += end.length;
  }
}

export class ZipReader {
  static async open(path) {
    const handle = await open(path, 'r'), reader = new ZipReader(handle);
    try { await reader.load(); } catch (error) { await handle.close(); throw error; }
    return reader;
  }
  constructor(handle) { this.handle = handle; this.entries = []; }
  async bytes(position, length) {
    const buffer = Buffer.alloc(length); const { bytesRead } = await this.handle.read(buffer, 0, length, position);
    if (bytesRead !== length) throw new Error('压缩包不完整');
    return buffer;
  }
  async load() {
    const { size } = await this.handle.stat();
    if (size < 22) throw new Error('这不是有效的 ZIP 文件');
    const tailLength = Math.min(size, 22 + 65535), tail = await this.bytes(size - tailLength, tailLength);
    let at = -1;
    for (let index = tail.length - 22; index >= 0; index--) if (tail.readUInt32LE(index) === 0x06054b50) { at = index; break; }
    if (at < 0) throw new Error('这不是有效的 ZIP 文件');
    const count = tail.readUInt16LE(at + 10), length = tail.readUInt32LE(at + 12), start = tail.readUInt32LE(at + 16);
    if (count === 0xffff || length === LIMIT || start === LIMIT) throw new Error('不支持超过 4GB 的压缩包');
    if (start + length > size) throw new Error('压缩包不完整');
    const directory = await this.bytes(start, length);
    for (let cursor = 0, index = 0; index < count; index++) {
      if (cursor + 46 > directory.length || directory.readUInt32LE(cursor) !== 0x02014b50) throw new Error('压缩包目录损坏');
      const flags = directory.readUInt16LE(cursor + 8), nameLength = directory.readUInt16LE(cursor + 28);
      const entry = { encrypted: (flags & 1) === 1, method: directory.readUInt16LE(cursor + 10), crc: directory.readUInt32LE(cursor + 16),
        packed: directory.readUInt32LE(cursor + 20), size: directory.readUInt32LE(cursor + 24), offset: directory.readUInt32LE(cursor + 42),
        name: directory.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8') };
      if (entry.packed === LIMIT || entry.size === LIMIT || entry.offset === LIMIT) throw new Error('不支持超过 4GB 的压缩包');
      this.entries.push(entry);
      cursor += 46 + nameLength + directory.readUInt16LE(cursor + 30) + directory.readUInt16LE(cursor + 32);
    }
  }
  async read(entry, maxSize = 1024 * 1024 * 1024) {
    if (entry.encrypted) throw new Error('不支持带密码的压缩包');
    if (entry.size > maxSize) throw new Error(`压缩包里的 ${entry.name} 过大`);
    const local = await this.bytes(entry.offset, 30);
    if (local.readUInt32LE(0) !== 0x04034b50) throw new Error('压缩包内容损坏');
    const packed = await this.bytes(entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28), entry.packed);
    let data;
    if (entry.method === 0) data = packed;
    else if (entry.method === 8) { try { data = inflateRawSync(packed, { maxOutputLength: Math.max(1, entry.size) }); } catch { throw new Error(`压缩包里的 ${entry.name} 无法解压`); } }
    else throw new Error('压缩包使用了不支持的压缩方式');
    if (data.length !== entry.size || crc32(data) !== entry.crc) throw new Error(`压缩包里的 ${entry.name} 校验失败`);
    return data;
  }
  async close() { await this.handle.close(); }
}
