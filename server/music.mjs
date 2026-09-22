import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseFile } from "music-metadata";

const AUDIO_EXTENSIONS = new Set([
  ".mp3", ".aac", ".m4a", ".flac", ".wav", ".wave", ".aif", ".aiff", ".ogg", ".opus", ".ape", ".wv",
]);
const COVER_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const COVER_NAMES = ["cover", "folder", "front", "album", "专辑封面"];
const MAX_TRACKS = 10000;
const MAX_DEPTH = 10;
const MAX_LYRICS_BYTES = 5 * 1024 * 1024;
const STANDARD_SCAN_CONCURRENCY = 3;
const TURBO_SCAN_CONCURRENCY = 24;
const LOSSLESS_COMPATIBLE_CODECS = new Set(["alac", "ape", "wavpack", "tta"]);
const LOSSLESS_COMPATIBLE_EXTENSIONS = new Set(["AIF", "AIFF", "APE", "WV"]);

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function trackNumber(value) {
  const parsed = finiteNumber(value?.no ?? value);
  return parsed === null ? null : Math.max(0, Math.round(parsed));
}

function normalizeArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
}

function normalizeTextBuffer(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString("utf16le");
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.allocUnsafe(buffer.length - 2);
    for (let index = 2; index + 1 < buffer.length; index += 2) {
      swapped[index - 2] = buffer[index + 1];
      swapped[index - 1] = buffer[index];
    }
    return swapped.toString("utf16le");
  }
  return buffer.toString("utf8").replace(/^\uFEFF/, "");
}

function lrcTimestamp(value) {
  const match = /^(\d{1,3}):(\d{2}(?:\.\d{1,3})?)$/.exec(value.trim());
  if (!match) return null;
  return Math.round((Number(match[1]) * 60 + Number(match[2])) * 1000);
}

export function parseLrc(content) {
  const lines = [];
  let offsetMs = 0;
  const metadata = {};
  for (const rawLine of String(content || "").replace(/\r\n?/g, "\n").split("\n")) {
    const offsetMatch = /^\[offset:([+-]?\d+)\]/i.exec(rawLine.trim());
    if (offsetMatch) {
      offsetMs = Number(offsetMatch[1]) || 0;
      continue;
    }
    const metadataMatch = /^\[(ar|al|ti|by):([^\]]*)\]/i.exec(rawLine.trim());
    if (metadataMatch) {
      metadata[metadataMatch[1].toLowerCase()] = metadataMatch[2].trim();
      continue;
    }
    const timestamps = [...rawLine.matchAll(/\[(\d{1,3}:\d{2}(?:\.\d{1,3})?)\]/g)]
      .map((match) => lrcTimestamp(match[1]))
      .filter((value) => value !== null);
    if (!timestamps.length) continue;
    const textWithWordTimes = rawLine.replace(/^(?:\[(?:\d{1,3}:\d{2}(?:\.\d{1,3})?)\])+/, "").trim();
    const wordMatches = [...textWithWordTimes.matchAll(/<(\d{1,3}:\d{2}(?:\.\d{1,3})?)>([^<]*)/g)];
    const plainText = wordMatches.length
      ? wordMatches.map((match) => match[2]).join("").trim()
      : textWithWordTimes.replace(/<\d{1,3}:\d{2}(?:\.\d{1,3})?>/g, "").trim();
    for (const startMs of timestamps) {
      const words = wordMatches.map((match) => ({ startMs: Math.max(0, (lrcTimestamp(match[1]) || 0) + offsetMs), text: match[2] }));
      lines.push({ startMs: Math.max(0, startMs + offsetMs), text: plainText, ...(words.length ? { words } : {}) });
    }
  }
  lines.sort((left, right) => left.startMs - right.startMs);
  for (let index = 0; index < lines.length; index += 1) {
    lines[index].endMs = lines[index + 1]?.startMs ?? lines[index].startMs + 10000;
    if (lines[index].words) {
      for (let wordIndex = 0; wordIndex < lines[index].words.length; wordIndex += 1) {
        const word = lines[index].words[wordIndex];
        word.endMs = lines[index].words[wordIndex + 1]?.startMs ?? lines[index].endMs;
      }
    }
  }
  return {
    synchronized: lines.length > 0,
    wordTimed: lines.some((line) => line.words?.length),
    metadata,
    lines,
    plainText: lines.map((line) => line.text).filter(Boolean).join("\n"),
  };
}

export function embeddedLyrics(commonLyrics) {
  const candidates = Array.isArray(commonLyrics) ? commonLyrics : [];
  const synchronized = candidates.find((item) => Array.isArray(item?.syncText) && item.syncText.length && item.timeStampFormat === 2);
  if (synchronized) {
    const timedItems = synchronized.syncText
      .map((item) => ({ startMs: Math.max(0, Number(item.timestamp) || 0), text: String(item.text || "").trim() }))
      .filter((line) => line.text)
      .sort((left, right) => left.startMs - right.startMs);
    const looksWordTimed = timedItems.length >= 3
      && timedItems.filter((item) => item.text.length <= 6).length / timedItems.length >= 0.75;
    if (looksWordTimed) {
      const lines = [];
      let words = [];
      for (let index = 0; index < timedItems.length; index += 1) {
        const item = timedItems[index];
        const next = timedItems[index + 1];
        words.push({ startMs: item.startMs, endMs: next?.startMs ?? item.startMs + 1000, text: item.text.replace(/\n/g, "") });
        const gap = next ? next.startMs - item.startMs : 0;
        const lineBreak = /[。！？!?；;]$/.test(item.text) || item.text.includes("\n") || words.length >= 12 || gap > 1800 || !next;
        if (lineBreak) {
          const cleanWords = words.filter((word) => word.text);
          if (cleanWords.length) lines.push({
            startMs: cleanWords[0].startMs,
            endMs: cleanWords.at(-1).endMs,
            text: cleanWords.map((word) => word.text).join(""),
            words: cleanWords,
          });
          words = [];
        }
      }
      return { synchronized: true, wordTimed: true, metadata: {}, lines, plainText: lines.map((line) => line.text).join("\n") };
    }
    const lines = timedItems;
    for (let index = 0; index < lines.length; index += 1) lines[index].endMs = lines[index + 1]?.startMs ?? lines[index].startMs + 10000;
    return { synchronized: true, wordTimed: false, metadata: {}, lines, plainText: lines.map((line) => line.text).join("\n") };
  }
  const plain = candidates.map((item) => String(item?.text || "").trim()).find(Boolean);
  if (plain) {
    const parsed = parseLrc(plain);
    if (parsed.synchronized) return parsed;
    return { synchronized: false, wordTimed: false, metadata: {}, lines: [], plainText: plain };
  }
  return null;
}

async function mapWithConcurrency(items, limit, mapper, onSettled = null) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
      onSettled?.(results[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), Math.max(1, items.length)) }, worker));
  return results;
}

async function walkAudioFiles(rootDirectory, depth = 0, output = [], status = { complete: true, errors: [], truncated: false }) {
  if (depth > MAX_DEPTH || output.length >= MAX_TRACKS) {
    status.complete = false;
    status.truncated = true;
    return output;
  }
  let entries;
  try {
    entries = await readdir(rootDirectory, { withFileTypes: true });
  } catch (error) {
    status.complete = false;
    status.errors.push({ path: rootDirectory, message: error.message || "无法读取目录" });
    return output;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(rootDirectory, entry.name);
    if (entry.isDirectory()) await walkAudioFiles(fullPath, depth + 1, output, status);
    else if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) output.push(fullPath);
    if (output.length >= MAX_TRACKS) {
      status.complete = false;
      status.truncated = true;
      break;
    }
  }
  return output;
}

function sourceSignature(item) {
  return createHash("sha256").update(`${item.id}\0${item.size}\0${item.modifiedAt}`).digest("hex");
}

function directPlayMime(track) {
  const extension = track.extension?.toUpperCase();
  if (extension === "MP3") return "audio/mpeg";
  if (["M4A", "AAC"].includes(extension)) return "audio/mp4";
  if (extension === "FLAC") return "audio/flac";
  if (["WAV", "WAVE"].includes(extension)) return "audio/wav";
  if (extension === "OPUS") return "audio/ogg; codecs=opus";
  if (extension === "OGG") return "audio/ogg";
  return "application/octet-stream";
}

function needsFlacCopy(track) {
  const codec = String(track.codec || "").toLowerCase();
  return Boolean(track.lossless && (LOSSLESS_COMPATIBLE_CODECS.has(codec) || LOSSLESS_COMPATIBLE_EXTENSIONS.has(track.extension)));
}

export function createMusicService({
  appState,
  cacheDirectory,
  saveState,
  stableId,
  getMediaTools,
  getCompatibleCopyDirectory,
  runCommand,
  streamFile,
  sendJson,
  readJson,
  requireLocalManagement,
  requireViewerAccess,
  canAccessFolderId,
  pathIsSameOrDescendant,
}) {
  const coverCacheDirectory = path.join(cacheDirectory, "music-covers");
  const lyricsCacheDirectory = path.join(cacheDirectory, "music-lyrics");
  appState.musicLibraries ||= [];
  appState.musicTracks ||= [];
  let libraryRevision = 0;
  let activeScan = null;
  let scanContext = null;
  let lastStartedAt = null;
  let lastCompletedAt = null;
  let lastError = null;
  const flacQueue = [];
  const flacTasks = new Map();
  let activeFlacJobs = 0;

  const ready = Promise.all([mkdir(coverCacheDirectory, { recursive: true }), mkdir(lyricsCacheDirectory, { recursive: true })]);

  function musicFolderId(libraryId, folderPath) {
    return stableId(`music:${libraryId}:${path.resolve(folderPath).toLowerCase()}`);
  }

  function libraryForTrack(track) {
    return appState.musicLibraries.find((library) => library.id === track.libraryId) || null;
  }

  function folderPathForTrack(track) {
    return path.dirname(track.path);
  }

  function ancestorFolderIds(track) {
    const library = libraryForTrack(track);
    const rootPath = path.resolve(library?.path || folderPathForTrack(track));
    const trackFolderPath = path.resolve(folderPathForTrack(track));
    if (!pathIsSameOrDescendant(trackFolderPath, rootPath)) return [musicFolderId(track.libraryId, trackFolderPath)];
    const segments = path.relative(rootPath, trackFolderPath).split(path.sep).filter(Boolean);
    const paths = [rootPath];
    for (const segment of segments) paths.push(path.join(paths.at(-1), segment));
    return paths.map((folderPath) => musicFolderId(track.libraryId, folderPath));
  }

  function accessFolderPathForTrack(track) {
    const library = libraryForTrack(track);
    const trackFolderPath = path.resolve(folderPathForTrack(track));
    const rootPath = path.resolve(library?.path || trackFolderPath);
    if (!pathIsSameOrDescendant(trackFolderPath, rootPath)) return trackFolderPath;
    const segments = path.relative(rootPath, trackFolderPath).split(path.sep).filter(Boolean);
    return segments.length ? path.join(rootPath, ...segments.slice(0, 2)) : rootPath;
  }

  function accessFolderIdForTrack(track) {
    return musicFolderId(track.libraryId, accessFolderPathForTrack(track));
  }

  function canAccessTrack(context, track) {
    if (context?.fullAccess) return true;
    return canAccessFolderId(context, accessFolderIdForTrack(track));
  }

  function accessibleTracks(context) {
    return appState.musicTracks.filter((track) => canAccessTrack(context, track));
  }

  function authorizedTrack(request, response, trackId) {
    const context = requireViewerAccess(request, response);
    if (!context) return null;
    const track = appState.musicTracks.find((item) => item.id === trackId);
    if (!track || !canAccessTrack(context, track)) {
      sendJson(response, 404, { error: "找不到歌曲，或当前用户没有这个音乐文件夹的访问权限。" });
      return null;
    }
    return track;
  }

  function scanStatus() {
    return {
      enabled: true,
      scanning: Boolean(activeScan),
      intervalSeconds: Number(appState.settings.autoScanIntervalSeconds) || 30,
      lastStartedAt,
      lastCompletedAt,
      lastError,
      id: scanContext?.id || null,
      mode: scanContext?.mode || null,
      pendingMode: null,
      phase: scanContext?.phase || "idle",
      progressPercent: scanContext?.progressPercent ?? null,
      discoveredFiles: scanContext?.discoveredFiles || 0,
      processedFiles: scanContext?.processedFiles || 0,
      totalFiles: scanContext?.totalFiles || 0,
      processedLibraries: scanContext?.processedLibraries || 0,
      totalLibraries: scanContext?.totalLibraries || appState.musicLibraries.length,
      maxParallelFiles: scanContext?.maxParallelFiles || 0,
      maxParallelMediaTools: scanContext?.maxParallelFiles || 0,
    };
  }

  async function findLyricsSidecar(filePath) {
    const directory = path.dirname(filePath);
    const wanted = `${path.basename(filePath, path.extname(filePath))}.lrc`.toLowerCase();
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    const entry = entries.find((item) => item.isFile() && item.name.toLowerCase() === wanted);
    if (!entry) return null;
    const fullPath = path.join(directory, entry.name);
    const fileStat = await stat(fullPath).catch(() => null);
    if (!fileStat?.isFile() || fileStat.size > MAX_LYRICS_BYTES) return null;
    return { path: fullPath, size: fileStat.size, modifiedAt: fileStat.mtime.toISOString() };
  }

  async function findFolderCover(trackPath, libraryPath) {
    let currentDirectory = path.dirname(trackPath);
    const rootDirectory = path.resolve(libraryPath || currentDirectory);
    if (!pathIsSameOrDescendant(currentDirectory, rootDirectory)) currentDirectory = rootDirectory;
    while (pathIsSameOrDescendant(currentDirectory, rootDirectory)) {
      const entries = await readdir(currentDirectory, { withFileTypes: true }).catch(() => []);
      const images = entries.filter((entry) => entry.isFile() && COVER_EXTENSIONS.has(path.extname(entry.name).toLowerCase()));
      let selected = null;
      for (const name of COVER_NAMES) {
        selected = images.find((entry) => path.basename(entry.name, path.extname(entry.name)).toLowerCase() === name.toLowerCase());
        if (selected) break;
      }
      if (!selected && images.length === 1) selected = images[0];
      if (selected) {
        const fullPath = path.join(currentDirectory, selected.name);
        const fileStat = await stat(fullPath).catch(() => null);
        if (fileStat?.isFile()) return { path: fullPath, size: fileStat.size, modifiedAt: fileStat.mtime.toISOString() };
      }
      if (path.resolve(currentDirectory).toLowerCase() === rootDirectory.toLowerCase()) break;
      const parent = path.dirname(currentDirectory);
      if (parent === currentDirectory) break;
      currentDirectory = parent;
    }
    return null;
  }

  async function imageVariants(source, cacheKey) {
    await ready;
    const mediaTools = getMediaTools();
    const outputs = {};
    for (const size of [256, 1024]) {
      const outputPath = path.join(coverCacheDirectory, `${cacheKey}-${size}.jpg`);
      const outputStat = await stat(outputPath).catch(() => null);
      if (!outputStat?.isFile() || outputStat.size <= 0) {
        let temporarySource = null;
        try {
          let sourcePath = source.path;
          if (!sourcePath) {
            temporarySource = path.join(coverCacheDirectory, `${cacheKey}-source-${randomUUID()}${source.extension || ".img"}`);
            await writeFile(temporarySource, source.data);
            sourcePath = temporarySource;
          }
          if (mediaTools.available) {
            const partialPath = `${outputPath}.${randomUUID()}.partial.jpg`;
            await runCommand(mediaTools.ffmpeg, [
              "-y", "-v", "error", "-i", sourcePath, "-frames:v", "1",
              "-vf", `scale=${size}:${size}:force_original_aspect_ratio=decrease,pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2:color=black`,
              "-q:v", "2", partialPath,
            ], 60000);
            await rename(partialPath, outputPath);
          } else if (source.path) {
            await copyFile(source.path, outputPath);
          } else {
            await writeFile(outputPath, source.data);
          }
        } catch (error) {
          console.error(`生成音乐封面失败：${error.message}`);
        } finally {
          if (temporarySource) await unlink(temporarySource).catch(() => {});
        }
      }
      const finalStat = await stat(outputPath).catch(() => null);
      if (finalStat?.isFile() && finalStat.size > 0) outputs[size] = outputPath;
    }
    return outputs;
  }

  async function writeLyricsCache(trackId, signature, lyrics, source) {
    if (!lyrics) return null;
    await ready;
    const outputPath = path.join(lyricsCacheDirectory, `${trackId}-${signature.slice(0, 16)}.json`);
    await writeFile(outputPath, JSON.stringify({ ...lyrics, source }), "utf8");
    return outputPath;
  }

  async function scanTrack(filePath, library, previous) {
    const fileStat = await stat(filePath);
    const identityPath = await realpath(filePath).catch(() => filePath);
    const id = stableId(identityPath);
    const modifiedAt = fileStat.mtime.toISOString();
    const signature = sourceSignature({ id, size: fileStat.size, modifiedAt });
    const lyricsSidecar = await findLyricsSidecar(filePath);
    const folderCover = await findFolderCover(filePath, library.path);
    const unchanged = previous && previous.size === fileStat.size && previous.modifiedAt === modifiedAt;
    const sidecarsUnchanged = unchanged
      && previous.lyricsSidecarSignature === (lyricsSidecar ? `${lyricsSidecar.size}:${lyricsSidecar.modifiedAt}` : null)
      && previous.folderCoverSignature === (folderCover ? `${folderCover.path}:${folderCover.size}:${folderCover.modifiedAt}` : null);
    if (sidecarsUnchanged) {
      return {
        ...previous,
        id,
        libraryId: library.id,
        path: filePath,
        fileName: path.basename(filePath),
        title: previous.title || path.basename(filePath, path.extname(filePath)),
        compatiblePath: previous.compatibleSourceSignature === signature ? previous.compatiblePath : null,
        compatibleSourceSignature: previous.compatibleSourceSignature === signature ? previous.compatibleSourceSignature : null,
      };
    }

    let metadata = null;
    if (!unchanged) {
      try {
        metadata = await parseFile(filePath, { duration: true, skipCovers: false });
      } catch (error) {
        console.error(`读取音乐元数据失败 ${filePath}: ${error.message}`);
      }
    }
    const common = metadata?.common || {};
    const format = metadata?.format || {};
    const embeddedPicture = common.picture?.[0] || null;
    let embeddedCoverPaths = previous?.embeddedCoverPaths || {};
    if (embeddedPicture?.data?.length) {
      const pictureHash = createHash("sha256").update(embeddedPicture.data).digest("hex").slice(0, 24);
      const pictureExtension = embeddedPicture.format?.includes("png") ? ".png" : embeddedPicture.format?.includes("webp") ? ".webp" : ".jpg";
      embeddedCoverPaths = await imageVariants({ data: Buffer.from(embeddedPicture.data), extension: pictureExtension }, `embedded-${id}-${pictureHash}`);
    }
    let coverPaths = embeddedCoverPaths;
    if (folderCover) {
      const folderCoverKey = stableId(`folder-cover:${folderCover.path}:${folderCover.size}:${folderCover.modifiedAt}`);
      coverPaths = await imageVariants({ path: folderCover.path }, `folder-${folderCoverKey}`);
    }

    let lyricsPath = previous?.embeddedLyricsPath || null;
    let embeddedLyricsPath = previous?.embeddedLyricsPath || null;
    let lyricsSummary = previous?.lyricsSummary || null;
    if (metadata) {
      const parsedEmbeddedLyrics = embeddedLyrics(common.lyrics);
      embeddedLyricsPath = await writeLyricsCache(id, signature, parsedEmbeddedLyrics, parsedEmbeddedLyrics?.synchronized ? "embedded-synced" : "embedded-plain");
      lyricsPath = embeddedLyricsPath;
      lyricsSummary = parsedEmbeddedLyrics ? { synchronized: parsedEmbeddedLyrics.synchronized, wordTimed: parsedEmbeddedLyrics.wordTimed, source: "embedded" } : null;
    }
    if (lyricsSidecar) {
      const lrcContent = normalizeTextBuffer(await readFile(lyricsSidecar.path));
      const parsed = parseLrc(lrcContent);
      lyricsPath = await writeLyricsCache(id, createHash("sha256").update(lrcContent).digest("hex"), parsed, "sidecar-lrc");
      lyricsSummary = { synchronized: parsed.synchronized, wordTimed: parsed.wordTimed, source: "sidecar" };
    }

    const extension = path.extname(filePath).slice(1).toUpperCase();
    const codec = String(format.codec || previous?.codec || "").toLowerCase() || null;
    const nextTrack = {
      id,
      libraryId: library.id,
      path: filePath,
      fileName: path.basename(filePath),
      extension,
      size: fileStat.size,
      modifiedAt,
      title: String(common.title || previous?.title || path.basename(filePath, path.extname(filePath))).trim(),
      artists: normalizeArray(common.artists?.length ? common.artists : common.artist ? [common.artist] : previous?.artists),
      album: String(common.album || previous?.album || "").trim(),
      albumArtist: String(common.albumartist || previous?.albumArtist || "").trim(),
      year: finiteNumber(common.year ?? previous?.year),
      genres: normalizeArray(common.genre?.length ? common.genre : previous?.genres),
      discNumber: trackNumber(common.disk ?? previous?.discNumber),
      trackNumber: trackNumber(common.track ?? previous?.trackNumber),
      durationSeconds: finiteNumber(format.duration ?? previous?.durationSeconds) || 0,
      bitrate: finiteNumber(format.bitrate ?? previous?.bitrate),
      sampleRate: finiteNumber(format.sampleRate ?? previous?.sampleRate),
      bitDepth: finiteNumber(format.bitsPerSample ?? previous?.bitDepth),
      channels: finiteNumber(format.numberOfChannels ?? previous?.channels),
      codec,
      container: String(format.container || previous?.container || extension).toLowerCase(),
      lossless: Boolean(format.lossless ?? previous?.lossless ?? ["FLAC", "WAV", "WAVE", "AIF", "AIFF", "APE", "WV"].includes(extension)),
      tags: normalizeArray(previous?.tags),
      coverPaths,
      embeddedCoverPaths,
      folderCoverSignature: folderCover ? `${folderCover.path}:${folderCover.size}:${folderCover.modifiedAt}` : null,
      lyricsPath,
      embeddedLyricsPath,
      lyricsSummary,
      lyricsSidecarSignature: lyricsSidecar ? `${lyricsSidecar.size}:${lyricsSidecar.modifiedAt}` : null,
      compatiblePath: previous?.compatibleSourceSignature === signature ? previous.compatiblePath : null,
      compatibleSourceSignature: previous?.compatibleSourceSignature === signature ? previous.compatibleSourceSignature : null,
      compatibleStatus: previous?.compatibleSourceSignature === signature ? previous.compatibleStatus : "not-needed",
      metadataSource: "local",
      externalIds: previous?.externalIds || {},
    };
    if (!nextTrack.compatiblePath && needsFlacCopy(nextTrack)) nextTrack.compatibleStatus = "waiting";
    if (!nextTrack.artists.length && nextTrack.albumArtist) nextTrack.artists = [nextTrack.albumArtist];
    return nextTrack;
  }

  function mostSpecificLibrary(filePath, libraries) {
    return libraries
      .filter((library) => pathIsSameOrDescendant(filePath, library.path))
      .sort((left, right) => path.resolve(right.path).length - path.resolve(left.path).length || left.id.localeCompare(right.id))[0] || null;
  }

  async function scanLibraries({ mode = "standard" } = {}) {
    await ready;
    if (activeScan) return activeScan;
    const normalizedMode = mode === "turbo" ? "turbo" : "standard";
    const revision = libraryRevision;
    const libraries = appState.musicLibraries.map((library) => ({ ...library }));
    scanContext = {
      id: randomUUID(),
      mode: normalizedMode,
      phase: "discovering",
      progressPercent: 0,
      discoveredFiles: 0,
      processedFiles: 0,
      totalFiles: 0,
      processedLibraries: 0,
      totalLibraries: libraries.length,
      maxParallelFiles: normalizedMode === "turbo" ? TURBO_SCAN_CONCURRENCY : STANDARD_SCAN_CONCURRENCY,
      cancelRequested: false,
    };
    lastStartedAt = new Date().toISOString();
    lastError = null;
    activeScan = (async () => {
      const oldTracks = new Map(appState.musicTracks.map((track) => [path.resolve(track.path).toLowerCase(), track]));
      const filesByIdentity = new Map();
      const incompleteLibraries = [];
      for (const library of libraries) {
        const status = { complete: true, errors: [], truncated: false };
        const found = await walkAudioFiles(library.path, 0, [], status);
        if (!status.complete) incompleteLibraries.push({ library, status });
        for (const filePath of found) {
          const identity = await realpath(filePath).catch(() => path.resolve(filePath));
          const owner = mostSpecificLibrary(filePath, libraries) || library;
          filesByIdentity.set(identity.toLowerCase(), { filePath: path.resolve(filePath), library: owner });
        }
        scanContext.discoveredFiles = filesByIdentity.size;
        scanContext.processedLibraries += 1;
      }
      if (revision !== libraryRevision) throw new Error("音乐目录在扫描期间发生变化，请重新扫描。");
      scanContext.phase = "processing";
      const files = [...filesByIdentity.values()];
      scanContext.totalFiles = files.length;
      const scanned = await mapWithConcurrency(files, scanContext.maxParallelFiles, async ({ filePath, library }) => {
        if (scanContext.cancelRequested) throw Object.assign(new Error("音乐扫描已停止"), { code: "MUSIC_SCAN_CANCELLED" });
        return scanTrack(filePath, library, oldTracks.get(path.resolve(filePath).toLowerCase()));
      }, () => {
        scanContext.processedFiles += 1;
        scanContext.progressPercent = scanContext.totalFiles ? Math.min(95, Math.round(scanContext.processedFiles / scanContext.totalFiles * 95)) : 95;
      });
      if (incompleteLibraries.length) throw new Error(`部分音乐目录未能完整读取：${incompleteLibraries.map(({ library }) => library.name).join("、")}`);
      if (revision !== libraryRevision) throw new Error("音乐目录在扫描期间发生变化，请重新扫描。");
      scanContext.phase = "finalizing";
      scanContext.progressPercent = 98;
      const previousTracksBeforeSave = appState.musicTracks;
      appState.musicTracks = scanned;
      try {
        await saveState();
      } catch (error) {
        const liveLibraryIds = new Set(appState.musicLibraries.map((library) => library.id));
        const restored = new Map(appState.musicTracks.map((track) => [track.id, track]));
        for (const track of previousTracksBeforeSave) {
          if (liveLibraryIds.has(track.libraryId) && !restored.has(track.id)) restored.set(track.id, track);
        }
        appState.musicTracks = [...restored.values()];
        await saveState().catch((restoreError) => console.error(`恢复音乐索引失败：${restoreError.message}`));
        throw error;
      }
      await cleanOrphanedCacheFiles();
      await queueAutomaticCompatibleCopies();
      lastCompletedAt = new Date().toISOString();
      scanContext.phase = "completed";
      scanContext.progressPercent = 100;
      return appState.musicTracks;
    })();
    try {
      return await activeScan;
    } catch (error) {
      if (error.code === "MUSIC_SCAN_CANCELLED") {
        scanContext.phase = "cancelled";
        lastError = null;
      } else {
        scanContext.phase = "failed";
        lastError = error.message;
      }
      throw error;
    } finally {
      activeScan = null;
    }
  }

  function folderNodes(tracks = appState.musicTracks) {
    const librariesById = new Map(appState.musicLibraries.map((library) => [library.id, library]));
    const nodes = new Map();
    for (const track of [...tracks].sort((left, right) => left.path.localeCompare(right.path, "zh-CN", { numeric: true, sensitivity: "base" }))) {
      const library = librariesById.get(track.libraryId);
      const trackFolder = path.resolve(folderPathForTrack(track));
      const root = library?.path && pathIsSameOrDescendant(trackFolder, library.path) ? path.resolve(library.path) : trackFolder;
      const segments = path.relative(root, trackFolder).split(path.sep).filter(Boolean);
      const paths = [root];
      for (const segment of segments) paths.push(path.join(paths.at(-1), segment));
      let parentId = null;
      for (const [index, folderPath] of paths.entries()) {
        const id = musicFolderId(track.libraryId, folderPath);
        let node = nodes.get(id);
        if (!node) {
          const name = path.basename(folderPath) || library?.name || "音乐目录";
          node = {
            id,
            parentId,
            name,
            title: index === 0 ? library?.name || name : name,
            configured: false,
            directMediaCount: 0,
            mediaCount: 0,
            childCount: 0,
            coverMediaId: track.id,
            kind: "music",
            path: folderPath,
          };
          nodes.set(id, node);
        }
        node.mediaCount += 1;
        if (index === paths.length - 1) node.directMediaCount += 1;
        parentId = id;
      }
    }
    for (const node of nodes.values()) if (node.parentId && nodes.has(node.parentId)) nodes.get(node.parentId).childCount += 1;
    return [...nodes.values()].sort((left, right) => (left.parentId || "").localeCompare(right.parentId || "") || left.title.localeCompare(right.title, "zh-CN", { numeric: true, sensitivity: "base" }));
  }

  function publicTrack(track, includeLocalPath = false) {
    const signature = sourceSignature(track);
    const compatibleReady = track.compatiblePath && track.compatibleSourceSignature === signature;
    return {
      id: track.id,
      libraryId: track.libraryId,
      title: track.title,
      fileName: track.fileName,
      ...(includeLocalPath ? { path: track.path } : {}),
      extension: track.extension,
      size: track.size,
      modifiedAt: track.modifiedAt,
      artists: track.artists || [],
      album: track.album || "",
      albumArtist: track.albumArtist || "",
      year: track.year,
      genres: track.genres || [],
      discNumber: track.discNumber,
      trackNumber: track.trackNumber,
      durationSeconds: track.durationSeconds || 0,
      bitrate: track.bitrate,
      sampleRate: track.sampleRate,
      bitDepth: track.bitDepth,
      channels: track.channels,
      codec: track.codec,
      container: track.container,
      lossless: Boolean(track.lossless),
      tags: track.tags || [],
      folderId: musicFolderId(track.libraryId, folderPathForTrack(track)),
      streamUrl: `/api/music/tracks/${track.id}/stream?variant=original`,
      compatibleUrl: compatibleReady ? `/api/music/tracks/${track.id}/stream?variant=flac` : null,
      preferredMime: compatibleReady ? "audio/flac" : directPlayMime(track),
      coverUrls: track.coverPaths && Object.keys(track.coverPaths).length ? {
        256: `/api/music/tracks/${track.id}/cover?size=256`,
        1024: `/api/music/tracks/${track.id}/cover?size=1024`,
      } : null,
      lyricsUrl: track.lyricsPath ? `/api/music/tracks/${track.id}/lyrics` : null,
      lyrics: track.lyricsSummary || null,
      compatibleStatus: compatibleReady ? "ready" : needsFlacCopy(track) ? track.compatibleStatus || "waiting" : "not-needed",
      metadataSource: track.metadataSource || "local",
      externalIds: track.externalIds || {},
    };
  }

  async function decodedPcmHash(filePath) {
    const mediaTools = getMediaTools();
    const result = await runCommand(mediaTools.ffmpeg, [
      "-v", "error", "-i", filePath, "-map", "0:a:0", "-vn", "-c:a", "pcm_s32le", "-f", "hash", "-hash", "sha256", "-",
    ], 6 * 60 * 60 * 1000);
    return result.stdout.trim();
  }

  function compatibleOutputPath(track) {
    return path.join(getCompatibleCopyDirectory(), "audio", `${track.id}-${sourceSignature(track).slice(0, 16)}.flac`);
  }

  function drainFlacQueue() {
    if (activeFlacJobs >= 1 || !flacQueue.length) return;
    const task = flacQueue.shift();
    activeFlacJobs += 1;
    void task().catch((error) => {
      console.error(`保存音乐兼容副本任务状态失败：${error.message}`);
    }).finally(() => {
      activeFlacJobs -= 1;
      drainFlacQueue();
    });
  }

  function startFlacJob(track) {
    if (!needsFlacCopy(track)) return null;
    if (flacTasks.has(track.id)) return flacTasks.get(track.id).job;
    const mediaTools = getMediaTools();
    if (!mediaTools.available) {
      track.compatibleStatus = "waiting";
      return null;
    }
    const signature = sourceSignature(track);
    const job = {
      id: randomUUID(),
      mediaId: track.id,
      mediaKind: "music",
      title: track.title,
      type: "lossless-flac",
      status: "queued",
      progress: 0,
      message: "等待生成无损 FLAC 兼容副本",
    };
    appState.jobs.push(job);
    track.compatibleStatus = "queued";
    const taskRecord = { job };
    flacTasks.set(track.id, taskRecord);
    flacQueue.push(async () => {
      const outputPath = compatibleOutputPath(track);
      const partialPath = `${outputPath}.${randomUUID()}.partial.flac`;
      try {
        await mkdir(path.dirname(outputPath), { recursive: true });
        job.status = "running";
        job.progress = 10;
        job.message = "正在无损转换为 FLAC";
        track.compatibleStatus = "running";
        await saveState();
        await runCommand(mediaTools.ffmpeg, [
          "-y", "-v", "error", "-i", track.path, "-map", "0:a:0", "-map_metadata", "0", "-vn", "-c:a", "flac", "-compression_level", "8", partialPath,
        ], 6 * 60 * 60 * 1000);
        job.progress = 80;
        job.message = "正在校验无损音频一致性";
        const [sourceHash, copyHash] = await Promise.all([decodedPcmHash(track.path), decodedPcmHash(partialPath)]);
        if (!sourceHash || sourceHash !== copyHash) throw new Error("FLAC 兼容副本的解码 PCM 校验不一致");
        await rename(partialPath, outputPath);
        const liveTrack = appState.musicTracks.find((item) => item.id === track.id && sourceSignature(item) === signature);
        if (!liveTrack) throw new Error("原音乐文件在转换期间发生变化，已丢弃旧副本");
        liveTrack.compatiblePath = outputPath;
        liveTrack.compatibleSourceSignature = signature;
        liveTrack.compatibleStatus = "ready";
        job.status = "completed";
        job.progress = 100;
        job.message = "无损 FLAC 兼容副本已就绪";
      } catch (error) {
        await unlink(partialPath).catch(() => {});
        const liveTrack = appState.musicTracks.find((item) => item.id === track.id);
        if (liveTrack) liveTrack.compatibleStatus = "failed";
        job.status = "failed";
        job.message = error.message || "无损 FLAC 兼容副本生成失败";
      } finally {
        flacTasks.delete(track.id);
        await saveState();
      }
    });
    void saveState().catch((error) => console.error(`保存音乐兼容副本队列失败：${error.message}`));
    drainFlacQueue();
    return job;
  }

  async function queueAutomaticCompatibleCopies() {
    if (!appState.musicTracks.length) return;
    for (const track of appState.musicTracks) {
      if (!needsFlacCopy(track)) continue;
      const signature = sourceSignature(track);
      const expectedPath = compatibleOutputPath(track);
      const candidatePath = track.compatibleSourceSignature === signature ? track.compatiblePath : expectedPath;
      const candidateStat = candidatePath ? await stat(candidatePath).catch(() => null) : null;
      if (candidateStat?.isFile() && candidateStat.size > 0) {
        track.compatiblePath = candidatePath;
        track.compatibleSourceSignature = signature;
        track.compatibleStatus = "ready";
      } else {
        startFlacJob(track);
      }
    }
    await saveState();
  }

  async function cleanOrphanedCacheFiles() {
    await ready;
    const referenced = new Set();
    for (const track of appState.musicTracks) {
      for (const filePath of Object.values(track.coverPaths || {})) referenced.add(path.resolve(filePath).toLowerCase());
      for (const filePath of Object.values(track.embeddedCoverPaths || {})) referenced.add(path.resolve(filePath).toLowerCase());
      if (track.lyricsPath) referenced.add(path.resolve(track.lyricsPath).toLowerCase());
      if (track.embeddedLyricsPath) referenced.add(path.resolve(track.embeddedLyricsPath).toLowerCase());
    }
    for (const directory of [coverCacheDirectory, lyricsCacheDirectory]) {
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile() || entry.name.includes("partial")) continue;
        const filePath = path.resolve(directory, entry.name);
        if (!referenced.has(filePath.toLowerCase())) await unlink(filePath).catch(() => {});
      }
    }
    const compatibleAudioDirectory = path.join(getCompatibleCopyDirectory(), "audio");
    const compatibleReferences = new Set(appState.musicTracks
      .map((track) => track.compatiblePath)
      .filter(Boolean)
      .map((filePath) => path.resolve(filePath).toLowerCase()));
    const compatibleEntries = await readdir(compatibleAudioDirectory, { withFileTypes: true }).catch(() => []);
    for (const entry of compatibleEntries) {
      // This directory is user-selected and can already contain original music.
      // Only generated copies with our exact ID/signature naming scheme belong
      // to LMD; never treat arbitrary FLAC files as disposable cache entries.
      if (!entry.isFile() || !/^[0-9a-f]{20}-[0-9a-f]{16}\.flac$/i.test(entry.name)) continue;
      const filePath = path.resolve(compatibleAudioDirectory, entry.name);
      if (!compatibleReferences.has(filePath.toLowerCase())) await unlink(filePath).catch(() => {});
    }
  }

  function displayFolderSummaries() {
    return folderNodes().map((folder) => ({
      id: folder.id,
      path: folder.path,
      folderName: folder.name,
      title: folder.title,
      season: 1,
      configured: false,
      mediaCount: folder.mediaCount,
      customTitle: "",
      sampleAlias: "",
      kind: "music",
    }));
  }

  function accessFolderSummaries() {
    const folders = new Map();
    for (const track of appState.musicTracks) {
      const library = libraryForTrack(track);
      const folderPath = accessFolderPathForTrack(track);
      const id = musicFolderId(track.libraryId, folderPath);
      const relativePath = library?.path && pathIsSameOrDescendant(folderPath, library.path)
        ? path.relative(path.resolve(library.path), folderPath).split(path.sep).filter(Boolean).join(" / ")
        : path.basename(folderPath);
      let folder = folders.get(id);
      if (!folder) {
        const title = relativePath || `${library?.name || path.basename(folderPath) || "音乐目录"}（直属文件）`;
        folder = {
          id,
          path: folderPath,
          folderName: relativePath ? path.basename(folderPath) : title,
          title,
          season: 1,
          configured: false,
          mediaCount: 0,
          customTitle: "",
          sampleAlias: "",
          kind: "music",
          libraryName: library?.name || "音乐目录",
          relativePath: relativePath || "直属文件",
        };
        folders.set(id, folder);
      }
      folder.mediaCount += 1;
    }
    return [...folders.values()].sort((left, right) => left.title.localeCompare(right.title, "zh-CN", { numeric: true, sensitivity: "base" }));
  }

  function accessFolderAliases() {
    return appState.musicTracks.flatMap((track) => ancestorFolderIds(track).map((folderId) => [folderId, accessFolderIdForTrack(track)]));
  }

  function compatibleFiles() {
    return appState.musicTracks.map((track) => track.compatiblePath).filter(Boolean);
  }

  function replaceCompatiblePath(sourcePath, destinationPath) {
    for (const track of appState.musicTracks) {
      if (track.compatiblePath && path.resolve(track.compatiblePath).toLowerCase() === path.resolve(sourcePath).toLowerCase()) track.compatiblePath = destinationPath;
    }
  }

  async function handleRequest(request, response, url, pathname) {
    if (!pathname.startsWith("/api/music/")) return false;
    if (request.method === "GET" && pathname === "/api/music/catalog") {
      const context = requireViewerAccess(request, response);
      if (!context) return true;
      const tracks = accessibleTracks(context);
      return sendJson(response, 200, { tracks: tracks.map((track) => publicTrack(track)), folders: folderNodes(tracks).map(({ path: _path, ...folder }) => folder), scan: scanStatus() }), true;
    }
    if (request.method === "POST" && pathname === "/api/music/catalog/scan") {
      const context = requireViewerAccess(request, response);
      if (!context) return true;
      await scanLibraries({ mode: url.searchParams.get("mode") || "standard" });
      return sendJson(response, 200, { count: accessibleTracks(context).length, scan: scanStatus() }), true;
    }
    if (request.method === "GET" && pathname === "/api/music/overview") {
      if (!requireLocalManagement(request, response)) return true;
      return sendJson(response, 200, { libraries: appState.musicLibraries, tracks: appState.musicTracks.map((track) => publicTrack(track, true)), jobs: appState.jobs.filter((job) => job.mediaKind === "music"), scanning: Boolean(activeScan), scan: scanStatus() }), true;
    }
    if (request.method === "POST" && pathname === "/api/music/libraries") {
      if (!requireLocalManagement(request, response)) return true;
      const body = await readJson(request);
      if (!body.folderPath || !path.isAbsolute(body.folderPath)) return sendJson(response, 400, { error: "请输入完整的 Windows 音乐文件夹路径。" }), true;
      const folderPath = path.resolve(body.folderPath);
      const folderStat = await stat(folderPath).catch(() => null);
      if (!folderStat?.isDirectory()) return sendJson(response, 400, { error: "找不到这个音乐文件夹，或当前程序没有读取权限。" }), true;
      let library = appState.musicLibraries.find((item) => item.path.toLowerCase() === folderPath.toLowerCase());
      const added = !library;
      if (added) {
        library = { id: stableId(`music-library:${folderPath.toLowerCase()}`), path: folderPath, name: String(body.name || path.basename(folderPath) || folderPath).trim() };
        appState.musicLibraries.push(library);
        libraryRevision += 1;
        await saveState();
      }
      return sendJson(response, 201, { libraries: appState.musicLibraries, library, added }), true;
    }
    if (request.method === "DELETE" && /^\/api\/music\/libraries\/[^/]+$/.test(pathname)) {
      if (!requireLocalManagement(request, response)) return true;
      const id = pathname.split("/").pop();
      const library = appState.musicLibraries.find((item) => item.id === id);
      if (!library) return sendJson(response, 404, { error: "找不到这个音乐目录，它可能已经被删除。" }), true;
      const removedTracks = appState.musicTracks.filter((track) => track.libraryId === id);
      const removedFolderIds = new Set(removedTracks.flatMap((track) => ancestorFolderIds(track)));
      appState.musicLibraries = appState.musicLibraries.filter((item) => item.id !== id);
      appState.musicTracks = appState.musicTracks.filter((track) => track.libraryId !== id);
      appState.jobs = appState.jobs.filter((job) => !removedTracks.some((track) => track.id === job.mediaId));
      for (const category of appState.accessControl.categories) category.folderIds = category.folderIds.filter((folderId) => !removedFolderIds.has(folderId));
      libraryRevision += 1;
      await saveState();
      await cleanOrphanedCacheFiles();
      return sendJson(response, 200, { ok: true, removedTrackCount: removedTracks.length }), true;
    }
    if (request.method === "POST" && pathname === "/api/music/scan/stop") {
      if (!requireLocalManagement(request, response)) return true;
      if (scanContext) scanContext.cancelRequested = true;
      return sendJson(response, 200, { scan: scanStatus() }), true;
    }
    if ((request.method === "GET" || request.method === "HEAD") && /^\/api\/music\/tracks\/[^/]+\/stream$/.test(pathname)) {
      const trackId = pathname.split("/")[4];
      const track = authorizedTrack(request, response, trackId);
      if (!track) return true;
      const variant = url.searchParams.get("variant");
      const signature = sourceSignature(track);
      if (variant && variant !== "original" && variant !== "flac") return sendJson(response, 400, { error: "不支持这个音频版本。" }), true;
      if (variant === "flac" && (!track.compatiblePath || track.compatibleSourceSignature !== signature)) {
        return sendJson(response, 404, { error: "这首歌的无损 FLAC 兼容副本尚未就绪。" }), true;
      }
      const filePath = variant === "flac" ? track.compatiblePath : track.path;
      await streamFile(request, response, filePath, true);
      return true;
    }
    if ((request.method === "GET" || request.method === "HEAD") && /^\/api\/music\/tracks\/[^/]+\/cover$/.test(pathname)) {
      const trackId = pathname.split("/")[4];
      const track = authorizedTrack(request, response, trackId);
      if (!track) return true;
      const size = url.searchParams.get("size") === "1024" ? 1024 : 256;
      const filePath = track.coverPaths?.[size] || track.coverPaths?.[1024] || track.coverPaths?.[256];
      if (!filePath) return sendJson(response, 404, { error: "这首歌没有可用封面。" }), true;
      await streamFile(request, response, filePath);
      return true;
    }
    if (request.method === "GET" && /^\/api\/music\/tracks\/[^/]+\/lyrics$/.test(pathname)) {
      const trackId = pathname.split("/")[4];
      const track = authorizedTrack(request, response, trackId);
      if (!track) return true;
      if (!track.lyricsPath) return sendJson(response, 404, { error: "这首歌没有可用歌词。" }), true;
      const lyricsStat = await stat(track.lyricsPath).catch(() => null);
      if (!lyricsStat?.isFile() || lyricsStat.size > MAX_LYRICS_BYTES) return sendJson(response, 404, { error: "歌词缓存不存在或无法读取。" }), true;
      const lyrics = JSON.parse(await readFile(track.lyricsPath, "utf8"));
      return sendJson(response, 200, lyrics), true;
    }
    sendJson(response, 404, { error: "没有找到这个音乐地址。" });
    return true;
  }

  return {
    handleRequest,
    scanLibraries,
    scanStatus,
    isScanning: () => Boolean(activeScan),
    requestStopScan: () => { if (scanContext) scanContext.cancelRequested = true; },
    queueAutomaticCompatibleCopies,
    cleanOrphanedCacheFiles,
    folderNodes,
    displayFolderSummaries,
    accessFolderSummaries,
    accessFolderAliases,
    allFolderIds: () => accessFolderSummaries().map((folder) => folder.id),
    compatibleFiles,
    replaceCompatiblePath,
    hasActiveJobs: () => flacTasks.size > 0,
  };
}

/**
 * Future online providers implement this shape. V1 intentionally never invokes one.
 * Remote values may fill local blanks but must never overwrite local tags or source files.
 */
export const MUSIC_METADATA_PROVIDER_INTERFACE = Object.freeze({
  version: 1,
  methods: ["searchAlbums", "getAlbum", "getArtwork", "getLyrics"],
});
