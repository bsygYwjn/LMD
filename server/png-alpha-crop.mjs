import { deflateSync, inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const CRC_TABLE = new Uint32Array(256);
for (let value = 0; value < 256; value++) {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  CRC_TABLE[value] = crc >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const result = Buffer.allocUnsafe(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  name.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return result;
}

function paeth(left, up, upperLeft) {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left), upDistance = Math.abs(estimate - up), upperLeftDistance = Math.abs(estimate - upperLeft);
  return leftDistance <= upDistance && leftDistance <= upperLeftDistance ? left : upDistance <= upperLeftDistance ? up : upperLeft;
}

/** Decode the exact 8-bit RGBA PNG format emitted by FFmpeg's `format=rgba` path. */
export function decodeRgbaPng(source) {
  const buffer = Buffer.isBuffer(source) ? source : Buffer.from(source);
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("位图字幕 PNG 格式无效");
  let offset = 8, width = 0, height = 0, bitDepth = 0, colorType = -1, interlace = -1;
  const compressed = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset), end = offset + 12 + length;
    if (end > buffer.length) throw new Error("位图字幕 PNG 数据不完整");
    const type = buffer.toString("ascii", offset + 4, offset + 8), data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      if (length !== 13) throw new Error("位图字幕 PNG 头无效");
      width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === "IDAT") compressed.push(data);
    offset = end;
    if (type === "IEND") break;
  }
  if (!width || !height || bitDepth !== 8 || colorType !== 6 || interlace !== 0 || !compressed.length) {
    throw new Error("位图字幕 PNG 必须是非交错 8 位 RGBA 图像");
  }
  const stride = width * 4, expected = (stride + 1) * height;
  if (!Number.isSafeInteger(expected) || expected > 512 * 1024 * 1024) throw new Error("位图字幕 PNG 尺寸异常");
  const filtered = inflateSync(Buffer.concat(compressed));
  if (filtered.length !== expected) throw new Error("位图字幕 PNG 扫描线长度无效");
  const pixels = Buffer.allocUnsafe(stride * height);
  let input = 0;
  for (let y = 0; y < height; y++) {
    const filter = filtered[input++], row = y * stride;
    if (filter > 4) throw new Error("位图字幕 PNG 使用了未知扫描线滤镜");
    for (let x = 0; x < stride; x++) {
      const raw = filtered[input++], left = x >= 4 ? pixels[row + x - 4] : 0;
      const up = y > 0 ? pixels[row - stride + x] : 0, upperLeft = y > 0 && x >= 4 ? pixels[row - stride + x - 4] : 0;
      const predictor = filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : filter === 4 ? paeth(left, up, upperLeft) : 0;
      pixels[row + x] = (raw + predictor) & 0xff;
    }
  }
  return { width, height, pixels };
}

export function encodeRgbaPng(width, height, pixels) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || pixels.length !== width * height * 4) {
    throw new Error("RGBA PNG 像素尺寸无效");
  }
  const stride = width * 4, scanlines = Buffer.allocUnsafe((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const output = y * (stride + 1);
    scanlines[output] = 0;
    pixels.copy(scanlines, output + 1, y * stride, (y + 1) * stride);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6; header[10] = 0; header[11] = 0; header[12] = 0;
  return Buffer.concat([PNG_SIGNATURE, pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(scanlines, { level: 9 })), pngChunk("IEND", Buffer.alloc(0))]);
}

/** Return a true alpha-bounds crop while preserving every RGBA channel exactly. */
export function cropTransparentRgbaPng(source) {
  const decoded = decodeRgbaPng(source);
  let minX = decoded.width, minY = decoded.height, maxX = -1, maxY = -1;
  for (let y = 0; y < decoded.height; y++) {
    for (let x = 0; x < decoded.width; x++) {
      if (decoded.pixels[(y * decoded.width + x) * 4 + 3] === 0) continue;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX || maxY < minY) return { empty: true, x: 0, y: 0, width: 0, height: 0, canvasWidth: decoded.width, canvasHeight: decoded.height, png: null };
  const width = maxX - minX + 1, height = maxY - minY + 1;
  if (width === decoded.width && height === decoded.height) {
    return { empty: false, x: 0, y: 0, width, height, canvasWidth: decoded.width, canvasHeight: decoded.height, png: Buffer.from(source) };
  }
  const cropped = Buffer.allocUnsafe(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sourceStart = ((minY + y) * decoded.width + minX) * 4;
    decoded.pixels.copy(cropped, y * width * 4, sourceStart, sourceStart + width * 4);
  }
  return { empty: false, x: minX, y: minY, width, height, canvasWidth: decoded.width, canvasHeight: decoded.height, png: encodeRgbaPng(width, height, cropped) };
}
