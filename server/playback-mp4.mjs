// Minimal ISO-BMFF timing reader. It never decodes or rewrites media samples.
// Full boxes are validated before access, including extended-size boxes.
export function boxes(buffer) {
  const result = [];
  for (let offset = 0; offset < buffer.length;) {
    if (buffer.length - offset < 8) throw new Error("Truncated MP4 box");
    let size = buffer.readUInt32BE(offset), header = 8;
    if (size === 1) { if (buffer.length - offset < 16) throw new Error("Truncated MP4 size"); size = Number(buffer.readBigUInt64BE(offset + 8)); header = 16; }
    if (!size) size = buffer.length - offset;
    if (!Number.isSafeInteger(size) || size < header || offset + size > buffer.length) throw new Error("Invalid MP4 box size");
    result.push({ type: buffer.toString("ascii", offset + 4, offset + 8), data: buffer.subarray(offset + header, offset + size), offset, header });
    offset += size;
  }
  return result;
}
const child = (data, type) => boxes(data).find(box => box.type === type)?.data;

export function parseInitialization(buffer) {
  const moov = child(buffer, "moov");
  if (!moov) throw new Error("Missing MP4 initialization");
  const defaults = new Map();
  const mvex = child(moov, "mvex");
  for (const box of mvex ? boxes(mvex) : []) if (box.type === "trex") defaults.set(box.data.readUInt32BE(4), box.data.readUInt32BE(12));
  const tracks = new Map();
  for (const box of boxes(moov).filter(box => box.type === "trak")) {
    const tkhd = child(box.data, "tkhd"), mdia = child(box.data, "mdia");
    const mdhd = child(mdia, "mdhd"), hdlr = child(mdia, "hdlr");
    const id = tkhd.readUInt32BE(tkhd[0] === 1 ? 20 : 12);
    const scale = mdhd.readUInt32BE(mdhd[0] === 1 ? 20 : 12);
    if (!scale) throw new Error("Invalid MP4 timescale");
    tracks.set(id, { id, scale, kind: hdlr.toString("ascii", 8, 12), defaultDuration: defaults.get(id) || 0 });
  }
  return tracks;
}

export function fragmentTiming(moofBuffer, tracks) {
  const moof = child(moofBuffer, "moof");
  const timings = [];
  for (const traf of boxes(moof).filter(box => box.type === "traf")) {
    const tfhd = child(traf.data, "tfhd"), tfdt = child(traf.data, "tfdt");
    const track = tracks.get(tfhd.readUInt32BE(4));
    if (!track || !tfdt) throw new Error("Missing fragment track clock");
    const flags = tfhd.readUIntBE(1, 3);
    let offset = 8 + ((flags & 1) ? 8 : 0) + ((flags & 2) ? 4 : 0);
    const defaultDuration = flags & 8 ? tfhd.readUInt32BE(offset) : track.defaultDuration;
    let dts = tfdt[0] === 1 ? Number(tfdt.readBigUInt64BE(4)) : tfdt.readUInt32BE(4);
    let start = Infinity, end = -Infinity;
    for (const { data } of boxes(traf.data).filter(box => box.type === "trun")) {
      const flags = data.readUIntBE(1, 3), count = data.readUInt32BE(4);
      if (count > 2000000) throw new Error("Excessive MP4 sample count");
      offset = 8 + ((flags & 1) ? 4 : 0) + ((flags & 4) ? 4 : 0);
      for (let i = 0; i < count; i++) {
        const duration = flags & 0x100 ? data.readUInt32BE(offset) : defaultDuration;
        if (flags & 0x100) offset += 4;
        if (flags & 0x200) offset += 4;
        if (flags & 0x400) offset += 4;
        const composition = flags & 0x800 ? (data[0] === 1 ? data.readInt32BE(offset) : data.readUInt32BE(offset)) : 0;
        if (flags & 0x800) offset += 4;
        start = Math.min(start, dts + composition); end = Math.max(end, dts + composition + duration); dts += duration;
      }
    }
    if (Number.isFinite(start) && end > start) timings.push({ ...track, start: start / track.scale, end: end / track.scale });
  }
  const primary = timings.find(track => track.kind === "vide") || timings[0];
  if (!primary) throw new Error("Empty MP4 media fragment");
  return { start: primary.start, end: primary.end, tracks: timings };
}

export async function* readMp4Boxes(readable, maxBytes = 128 * 1024 ** 2) {
  let pending = Buffer.alloc(0);
  for await (const chunk of readable) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= 8) {
      let size = pending.readUInt32BE(0);
      if (size === 1) { if (pending.length < 16) break; size = Number(pending.readBigUInt64BE(8)); }
      if (!Number.isSafeInteger(size) || size < 8 || size > maxBytes) throw new Error("MP4 fragment exceeds safety limit");
      if (pending.length < size) break;
      yield { type: pending.toString("ascii", 4, 8), buffer: pending.subarray(0, size) };
      pending = pending.subarray(size);
    }
    if (pending.length > maxBytes) throw new Error("MP4 buffer exceeds limit");
  }
  if (pending.length) throw new Error("Incomplete MP4 fragment");
}

// Progressive output cannot carry a complete timeline: FFmpeg writes an
// unknown-duration moov, so a media element can only guess the length from the
// segments it has. Because the original file's exact duration is already known,
// it is written into the initialization segment instead of letting the browser
// infer a shorter timeline from the fragments produced so far.
export function rewriteInitializationDuration(buffer, seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return buffer;
  try {
    const target = Buffer.from(buffer);
    const moov = boxes(target).find(box => box.type === "moov");
    if (!moov) return buffer;
    const mvhd = boxes(moov.data).find(box => box.type === "mvhd");
    // tkhd durations use the movie timescale from mvhd (mvhd v1 shifts the
    // creation/modification fields to 64 bits), mdhd carries its own timescale.
    const movieScale = mvhd && mvhd.data.length >= 24 ? mvhd.data.readUInt32BE(mvhd.data[0] === 1 ? 20 : 12) : 0;
    // `base` is the absolute index of the container payload in `target`, so no
    // byteOffset arithmetic is needed and every write stays verifiable.
    const patch = (data, base) => {
      for (const box of boxes(data)) {
        const payloadStart = base + box.offset + box.header;
        if (box.type === "tkhd" && movieScale > 0) {
          const version = box.data[0], length = version === 1 ? 8 : 4;
          if (payloadStart + 16 + length <= target.length) writeDuration(target, payloadStart + 16, version, seconds * movieScale);
        } else if (box.type === "mdhd") {
          const version = box.data[0], scale = box.data.readUInt32BE(version === 1 ? 20 : 12);
          if (scale > 0) writeDuration(target, payloadStart + (version === 1 ? 24 : 16), version, seconds * scale);
        } else if (box.type === "mvhd") {
          const version = box.data[0], scale = box.data.readUInt32BE(version === 1 ? 20 : 12);
          if (scale > 0) writeDuration(target, payloadStart + (version === 1 ? 24 : 16), version, seconds * scale);
        } else if (box.type === "trak" || box.type === "mdia") {
          patch(box.data, payloadStart);
        }
      }
    };
    patch(moov.data, moov.offset + moov.header);
    return target;
  } catch { return buffer; }
}

function writeDuration(buffer, offset, version, value) {
  const length = version === 1 ? 8 : 4;
  if (offset < 0 || offset + length > buffer.length) return;
  const scaled = Math.max(0, Math.round(value));
  if (version === 1) buffer.writeBigUInt64BE(BigInt(scaled), offset);
  else buffer.writeUInt32BE(Math.min(0xfffffffe, scaled), offset);
}
