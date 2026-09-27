import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

// File slices are read one at a time. HTTP LAN pages do not require Web Crypto.
const CHUNK_BYTES = 8 * 1024 * 1024;
self.onmessage = async (event: MessageEvent<{ file: File }>) => {
  try {
    const file = event.data.file;
    const whole = sha256.create();
    const hashes: string[] = [];
    for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
      const bytes = new Uint8Array(await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer());
      whole.update(bytes); hashes.push(bytesToHex(sha256(bytes)));
      self.postMessage({ type: "progress", bytes: Math.min(offset + CHUNK_BYTES, file.size) });
    }
    self.postMessage({ type: "done", hashes, sha256: bytesToHex(whole.digest()) });
  } catch (failure) { self.postMessage({ type: "error", error: failure instanceof Error ? failure.message : "读取文件失败" }); }
};
