import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { BITMAP_SUBTITLE_FORMATS } from './bitmap-subtitles.mjs';
import { createFontObjectStore } from './font-object-store.mjs';
import { playbackError } from './playback-planner.mjs';

export const videoSourceVersion = media => `${Number(media.size)}:${media.modifiedAt}`;
export const videoCacheSignature = media => createHash('sha256').update(`${media.id}\0${Number(media.size) || 0}\0${media.modifiedAt || ''}`).digest('hex').slice(0, 12);
const digest = text => createHash('sha256').update(text).digest('hex');
const abortError = () => Object.assign(playbackError('RESOURCE_CANCELLED', '字幕准备已取消', 409), { name: 'AbortError' });
const checkAbort = signal => { if (signal?.aborted) throw abortError(); };
const extensionFor = format => ({ ASS: '.ass', SSA: '.ssa', SRT: '.srt', VTT: '.vtt', WEBVTT: '.vtt', PGS: '.sup', VOBSUB: '.sub', DVB: '.sub' }[String(format).toUpperCase()]);
const safeName = name => path.basename(name || 'font').replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(-160);
const sourceLanguage = stream => stream.language || '未标记';
const canonical = value => { const resolved = path.resolve(value).replaceAll('\\', '/'); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; };
const within = (file, root) => { const child = canonical(file), parent = canonical(root); return child === parent || child.startsWith(`${parent}/`); };

export async function validateMediaSourcePath(appState, media) {
  const actual = await realpath(media.path).catch(() => null);
  if (!actual) throw playbackError('SOURCE_MISSING', '原始视频不存在，可能已移动', 404);
  if (canonical(actual) !== canonical(media.sourceIdentity || media.path)) throw playbackError('SOURCE_CHANGED', '视频来源路径已变化，请重新扫描', 409);
  if (Array.isArray(appState.libraries) && media.libraryId) {
    const library = appState.libraries.find(item => item.id === media.libraryId), root = library && await realpath(library.path).catch(() => null);
    if (!root || !within(actual, root)) throw playbackError('SOURCE_CHANGED', '视频已不在授权媒体库中', 409);
  }
  return actual;
}

/** No I/O or extraction: catalogs can expose tracks as soon as probing ends. */
export function describeVideoResources(media, probe = media) {
  const sourceVersion = videoSourceVersion(media);
  const subtitles = (media.subtitles || []).filter(item => item.source !== 'embedded');
  const fonts = (media.fonts || []).filter(item => item.source !== 'embedded');
  for (const stream of probe.embeddedSubtitleStreams || []) {
    const id = `embedded-subtitle-${media.id}-${stream.index}`;
    const previous = media.subtitles?.find(item => item.id === id);
    const current = previous?.sourceVersion === sourceVersion;
    subtitles.push({ ...(current ? previous : {}), id, name: stream.title || `内嵌字幕 ${stream.index}`, format: stream.format,
      language: sourceLanguage(stream), source: 'embedded', streamIndex: stream.index, default: Boolean(stream.default), forced: Boolean(stream.forced),
      sourceVersion, state: current && previous.state === 'ready' ? 'ready' : 'unknown', path: current ? previous.path || null : null });
  }
  for (const stream of probe.embeddedFontStreams || []) {
    const id = `embedded-font-${media.id}-${stream.index}`, previous = media.fonts?.find(item => item.id === id);
    const current = previous?.sourceVersion === sourceVersion;
    fonts.push({ ...(current ? previous : {}), id, name: safeName(stream.fileName), source: 'embedded', streamIndex: stream.index,
      size: stream.size || (current ? previous.size : null) || null, sourceVersion, state: current && previous.state === 'ready' ? 'ready' : 'unknown', path: current ? previous.path || null : null });
  }
  return { subtitles, fonts };
}

export function publicVideoResource(media, item, kind = 'subtitles') {
  if (!item) return null;
  const { path: _path, blobHash: _hash, sourceSignature: _signature, ...visible } = item;
  const ready = item.state === 'ready' || (item.source !== 'embedded' && Boolean(item.path));
  return { ...visible, state: ready ? 'ready' : item.state || 'unknown', url: ready ? (BITMAP_SUBTITLE_FORMATS.has(item.format) && item.url ? item.url : `/api/media/${encodeURIComponent(media.id)}/${kind}/${encodeURIComponent(item.id)}`) : null };
}

export function createVideoResourceService({ appState, cacheDirectory, getMediaTools, runCommand, saveState, readFontAliases = async () => [], findSidecarFiles, scheduler }) {
  const fontDirectory = path.join(cacheDirectory, 'fonts'), subtitleDirectory = path.join(cacheDirectory, 'subtitles');
  const jobs = new Map(), failures = new Map(), executions = new Set(), activePaths = new Set(); let commitGate = Promise.resolve(), stopped = false;
  const metrics = { subtitleExtractions: 0, fontExtractions: 0, cacheHits: 0, failed: 0, cancelled: 0, preparedRequests: 0 };
  const store = createFontObjectStore({ directory: fontDirectory, getBindings: () => appState.media.flatMap(media => (media.fonts || []).filter(font => font.blobHash && font.sourceVersion === videoSourceVersion(media))) });
  const locked = operation => { const result = commitGate.then(operation); commitGate = result.catch(() => {}); return result; };
  const currentMedia = media => appState.media.find(item => item.id === media.id);
  // Jobs are never restarted on boot. Old in-flight descriptors only become
  // eligible for a new explicit selection; the pause setting is untouched.
  for (const media of appState.media) for (const item of [...(media.subtitles || []), ...(media.fonts || [])]) if (['running', 'queued'].includes(item.state)) item.state = 'unknown';
  async function validate(media, version, signal) {
    checkAbort(signal);
    const current = currentMedia(media);
    if (!current || current.path !== media.path || videoSourceVersion(current) !== version || (Array.isArray(appState.libraries) && current.libraryId && !appState.libraries.some(library => library.id === current.libraryId)))
      throw playbackError('SOURCE_CHANGED', '视频来源已变更，请重新打开', 409);
    await validateMediaSourcePath(appState, current);
    const info = await stat(current.path).catch(() => null); checkAbort(signal);
    if (!info?.isFile() || `${info.size}:${info.mtime.toISOString()}` !== version) throw playbackError('SOURCE_CHANGED', '视频文件已更新，请重新打开', 409);
    return current;
  }
  async function commit(media, version, updates, signal) {
    return locked(async () => {
      const current = await validate(media, version, signal), previous = {};
      for (const [field, items] of Object.entries(updates)) {
        previous[field] = current[field];
        const ids = new Set(items.map(item => item.id));
        current[field] = [...(current[field] || []).filter(item => !ids.has(item.id)), ...items];
      }
      try { await saveState(); }
      catch (failure) { for (const field of Object.keys(updates)) current[field] = previous[field]; throw playbackError('RESOURCE_SAVE_FAILED', '字幕资源保存失败，请重试', 503); }
      // Consumers still check their token after this boundary. A valid cache can
      // remain committed even when the last viewer leaves during durable save.
      if (currentMedia(media) !== current || videoSourceVersion(current) !== version) throw playbackError('SOURCE_CHANGED', '视频来源已变更', 409);
      return current;
    });
  }
  async function command(media, args, timeoutMs, options, signal) {
    checkAbort(signal);
    if (!getMediaTools().available) throw playbackError('TOOLS_UNAVAILABLE', 'FFmpeg 尚未就绪', 503);
    let child;
    const abort = () => child?.kill();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      // runCommand resolves only after child close, so the disk slot stays held.
      const result = await runCommand(getMediaTools().ffmpeg, args, timeoutMs, { ...options, onChild: value => { child = value; if (signal?.aborted) child.kill(); } });
      checkAbort(signal); return result;
    } catch (failure) { checkAbort(signal); throw failure; }
    finally { signal?.removeEventListener('abort', abort); }
  }
  async function recordFailure(media, version, failureKey, failure) {
    return locked(async () => {
      const current = currentMedia(media);
      if (!current || videoSourceVersion(current) !== version) return;
      const previous = current.videoResourceFailures;
      const next = Object.fromEntries(Object.entries(previous || {}).filter(([, value]) => value.sourceVersion === version).slice(-127));
      if (failure) next[failureKey] = { sourceVersion: version, implementationVersion: 1, attempts: failure.attempts, retryAt: failure.retryAt, code: failure.error.code || 'RESOURCE_FAILED' };
      else delete next[failureKey];
      current.videoResourceFailures = next;
      try { await saveState(); }
      catch { if (current.videoResourceFailures === next) current.videoResourceFailures = previous; }
    });
  }
  function shared(media, kind, variant, run, { signal, retry = false, onState } = {}) {
    const version = videoSourceVersion(media), key = `video:${media.id}:${version}:${kind}:${variant}:v1`;
    checkAbort(signal);
    if (stopped) return Promise.reject(abortError());
    const failureKey = `${kind}:${variant}:v1`, durableFailure = currentMedia(media)?.videoResourceFailures?.[failureKey];
    const previousFailure = failures.get(key) || (durableFailure?.sourceVersion === version && durableFailure.implementationVersion === 1
      ? { ...durableFailure, error: playbackError(durableFailure.code, '上次字幕资源准备失败，稍后会重试；也可以手动重试', 503) } : null);
    if (previousFailure && !retry && Date.now() < previousFailure.retryAt) return Promise.reject(previousFailure.error);
    let job = jobs.get(key);
    if (!job || job.controller.signal.aborted) {
      const controller = new AbortController(); job = { controller, consumers: new Set(), state: 'queued', promise: null };
      const execute = ({ signal: taskSignal = controller.signal } = {}) => {
        const execution = (async () => {
          await validate(media, version, taskSignal); job.state = 'running'; for (const consumer of job.consumers) consumer.onState?.('running');
          return run(taskSignal, version);
        })();
        executions.add(execution); execution.finally(() => executions.delete(execution)).catch(() => {}); return execution;
      };
      jobs.set(key, job);
      const operation = scheduler ? scheduler.schedule({ key, sourcePath: media.path, kind, priority: kind === 'subtitle' ? 15 : 20, signal: controller.signal, run: execute }) : Promise.resolve().then(() => execute());
      job.promise = operation.then(async value => { failures.delete(key); if (previousFailure) await recordFailure(media, version, failureKey, null); return value; }).catch(async failure => {
        if (controller.signal.aborted) metrics.cancelled++;
        else if (failure.code !== 'SOURCE_CHANGED') { metrics.failed++; const attempts = (previousFailure?.attempts || 0) + 1;
          const record = { error: failure, attempts, retryAt: Date.now() + Math.min(300_000, 5000 * 2 ** Math.min(attempts - 1, 6)) }; failures.set(key, record); await recordFailure(media, version, failureKey, record); }
        throw failure;
      }).finally(() => { if (jobs.get(key) === job) jobs.delete(key); });
    }
    const consumer = { onState }; job.consumers.add(consumer); onState?.(job.state);
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (callback, value) => { if (done) return; done = true; signal?.removeEventListener('abort', abort); job.consumers.delete(consumer); callback(value); };
      const abort = () => { finish(reject, abortError()); if (!job.consumers.size) job.controller.abort(); };
      signal?.addEventListener('abort', abort, { once: true });
      job.promise.then(value => finish(resolve, value), failure => finish(reject, failure));
      if (signal?.aborted) abort();
    });
  }
  async function usable(file, expectedSize, sourceModifiedAt = 0) {
    if (!file) return false;
    const info = await stat(file).catch(() => null);
    return Boolean(info?.isFile() && info.size > 0 && (!expectedSize || info.size === expectedSize) && (!sourceModifiedAt || info.mtimeMs + 2000 >= sourceModifiedAt));
  }
  async function validatedSidecar(media, file) {
    if (!file) throw playbackError('RESOURCE_NOT_READY', '字幕资源尚未准备', 409);
    const actual = await realpath(file).catch(() => null);
    if (!actual || canonical(actual) !== canonical(file)) throw playbackError('RESOURCE_SOURCE_CHANGED', '字幕或字体来源路径已变化', 409);
    if (within(file, cacheDirectory)) {
      const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink()) throw playbackError('RESOURCE_SOURCE_CHANGED', '字幕资源路径无效', 409);
      return actual;
    }
    const library = appState.libraries?.find(item => item.id === media.libraryId);
    if (library) { const root = await realpath(library.path); if (!within(actual, root)) throw playbackError('RESOURCE_SOURCE_CHANGED', '字幕或字体不在授权媒体库中', 409); }
    return actual;
  }
  async function prepareSubtitle(media, trackId, options) {
    return shared(media, 'subtitle', trackId, async (signal, version) => {
      const current = await validate(media, version, signal), track = current.subtitles?.find(item => item.id === trackId);
      if (!track) throw playbackError('SUBTITLE_NOT_FOUND', '所选字幕不存在', 404);
      if (BITMAP_SUBTITLE_FORMATS.has(track.format)) return { ...track, state: 'ready', sourceVersion: version, url: `/api/media/${encodeURIComponent(media.id)}/bitmap-subtitles/${track.streamIndex}` };
      if (track.source !== 'embedded') {
        await validatedSidecar(media, track.path);
        if (!await usable(track.path)) throw playbackError('SUBTITLE_MISSING', '外挂字幕文件不存在', 404);
        metrics.cacheHits++; return { ...track, state: 'ready', sourceVersion: version };
      }
      const extension = extensionFor(track.format);
      if (!extension || !Number.isInteger(track.streamIndex)) throw playbackError('SUBTITLE_UNSUPPORTED', '字幕格式不受支持', 422);
      await mkdir(subtitleDirectory, { recursive: true });
      const output = path.join(subtitleDirectory, `${media.id}-${videoCacheSignature(media)}-${track.streamIndex}${extension}`);
      const legacy = path.join(subtitleDirectory, `${media.id}-${track.streamIndex}${extension}`);
      let cached = await usable(output) ? output : await usable(legacy, null, Date.parse(media.modifiedAt)) ? legacy : null;
      if (!cached && track.sourceVersion === version && track.path && path.dirname(track.path) === subtitleDirectory && await usable(track.path)) cached = track.path;
      activePaths.add(output);
      try {
      if (!cached) {
        const temporary = path.join(cacheDirectory, 'subtitle-extract', randomUUID()); await mkdir(temporary, { recursive: true });
        try {
          const file = path.join(temporary, `selected${extension}`); metrics.subtitleExtractions++;
          await command(media, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', media.path, '-map', `0:${track.streamIndex}`, '-c', 'copy', file], 180_000, {}, signal);
          if (!await usable(file)) throw playbackError('SUBTITLE_EMPTY', '字幕提取没有生成有效文件', 422);
          await validate(media, version, signal); await rename(file, output); cached = output;
        } finally { await rm(temporary, { recursive: true, force: true }).catch(() => {}); }
      } else metrics.cacheHits++;
      const prepared = { ...track, path: cached, sourceVersion: version, state: 'ready', preparedAt: new Date().toISOString(), extractionVersion: 1 };
      await commit(media, version, { subtitles: [prepared] }, signal); metrics.preparedRequests++; return prepared;
      } finally { activePaths.delete(output); }
    }, options);
  }
  async function prepareFonts(media, options) {
    return shared(media, 'font', 'ass', async (signal, version) => {
      let current = await validate(media, version, signal);
      const sidecars = findSidecarFiles ? await findSidecarFiles(media.path) : { fonts: (current.fonts || []).filter(item => item.source !== 'embedded') };
      await validate(media, version, signal);
      const candidates = [...(sidecars.fonts || [])];
      const missing = [], migration = [], pins = [];
      const temporary = path.join(cacheDirectory, 'attachment-extract', randomUUID());
      await mkdir(temporary, { recursive: true });
      try {
        for (const stream of current.embeddedFontStreams || []) {
          checkAbort(signal);
          const id = `embedded-font-${media.id}-${stream.index}`, previous = current.fonts?.find(font => font.id === id), name = safeName(stream.fileName);
          if (previous?.blobHash && previous.sourceVersion === version) {
            const cached = await store.acquire(previous.blobHash, previous.size).catch(() => null);
            if (cached) { pins.push(cached.release); candidates.push({ ...previous, path: cached.path, state: 'ready' }); metrics.cacheHits++; continue; }
          }
          const signed = path.join(fontDirectory, `${media.id}-${videoCacheSignature(media)}-${stream.index}-${name}`), legacy = path.join(fontDirectory, `${media.id}-${stream.index}-${name}`);
          const cached = await usable(signed, stream.size) ? signed : await usable(legacy, stream.size, Date.parse(media.modifiedAt)) ? legacy : null;
          const plan = { stream, id, name, path: cached || path.join(temporary, `${stream.index}.part`) };
          if (cached) migration.push(plan); else missing.push(plan);
        }
        if (missing.length) {
          const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
          // Hundreds of attachments can exceed Windows' command-line limit if
          // every output repeats the full cache path. The private cwd is enough.
          for (const item of missing) args.push(`-dump_attachment:${item.stream.index}`, path.basename(item.path));
          args.push('-i', media.path, '-map', '0:v:0?', '-c', 'copy', '-t', '0', '-f', 'null', '-'); metrics.fontExtractions++;
          await command(media, args, 60_000, { cwd: temporary }, signal);
        }
        for (const item of [...migration, ...missing]) {
          await validate(media, version, signal);
          const object = await store.importFont(item.path, { expectedSize: item.stream.size, originalName: item.name }); pins.push(object.release);
          const aliases = await store.aliasesFor(object.blobHash, readFontAliases);
          candidates.push({ id: item.id, name: item.name, originalName: item.name, aliases, path: object.path, blobHash: object.blobHash,
            size: object.size, format: object.format, validationVersion: object.validationVersion, source: 'embedded', streamIndex: item.stream.index,
            sourceVersion: version, sourceSignature: videoCacheSignature(media), extractionVersion: 1, state: 'ready' });
        }
        current = await commit(media, version, { fonts: candidates }, signal);
        for (const item of migration) {
          const binding = current.fonts.find(font => font.id === item.id);
          await store.removeMigratedCopy(item.path, { mediaId: media.id, ...binding }, async () => {
            const live = await validate(media, version, signal).catch(() => null);
            return Boolean(live && live.fonts?.some(font => font.id === binding.id && font.blobHash === binding.blobHash && font.sourceVersion === version && font.state === 'ready'));
          }).catch(() => {});
        }
        return candidates;
      } finally { for (const release of pins) release(); await rm(temporary, { recursive: true, force: true }).catch(() => {}); }
    }, options);
  }
  async function ensureSubtitle(media, trackId, options = {}) {
    const version = videoSourceVersion(media);
    const current = currentMedia(media), track = current?.subtitles?.find(item => item.id === trackId);
    if (!track) throw playbackError('SUBTITLE_NOT_FOUND', '所选字幕不存在', 404);
    // Font and subtitle reads are independently scheduled; neither is on the
    // audio/video start path. Only the selected ASS/SSA starts attachment work.
    const controller = new AbortController(), abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort();
    const childOptions = { ...options, signal: controller.signal };
    try {
      const [subtitle, fonts] = await Promise.all([prepareSubtitle(media, trackId, childOptions), /^(ASS|SSA)$/i.test(track.format) ? prepareFonts(media, childOptions) : Promise.resolve([])]);
      checkAbort(controller.signal); await validate(media, version, controller.signal);
      return { subtitle: publicVideoResource(media, subtitle), fonts: fonts.map(font => publicVideoResource(media, font, 'fonts')) };
    } catch (failure) { controller.abort(); throw failure; }
    finally { options.signal?.removeEventListener('abort', abort); }
  }
  async function resolveFont(media, id) {
    const version = videoSourceVersion(media); const current = await validate(media, version);
    const font = current.fonts?.find(item => item.id === id);
    if (!font) throw playbackError('FONT_NOT_FOUND', '找不到字体', 404);
    if (font.blobHash) {
      if (font.sourceVersion !== version || font.state !== 'ready') throw playbackError('RESOURCE_NOT_READY', '字体尚未准备', 409);
      return { ...await store.acquire(font.blobHash, font.size), format: font.format };
    }
    if (font.source === 'embedded' || !await usable(font.path)) throw playbackError('RESOURCE_NOT_READY', '字体尚未准备，请选择需要此字体的字幕', 409);
    return { path: await validatedSidecar(media, font.path), release: () => {}, format: font.format };
  }
  async function resolveSubtitle(media, id) {
    const version = videoSourceVersion(media), current = await validate(media, version), subtitle = current.subtitles?.find(item => item.id === id);
    if (!subtitle) throw playbackError('SUBTITLE_NOT_FOUND', '找不到字幕', 404);
    if (!subtitle.path || (subtitle.source === 'embedded' && (subtitle.sourceVersion !== version || subtitle.state !== 'ready')))
      throw playbackError('RESOURCE_NOT_READY', '字幕尚未准备，请先选择字幕', 409);
    return { ...subtitle, path: await validatedSidecar(media, subtitle.path) };
  }
  async function pinFonts(media, fonts) {
    const releases = [];
    try { for (const item of fonts || []) { const resolved = await resolveFont(media, item.id); releases.push(resolved.release); } }
    catch (failure) { for (const release of releases) release(); throw failure; }
    let done = false; return () => { if (done) return; done = true; for (const release of releases) release(); };
  }
  async function stop() { stopped = true; for (const job of jobs.values()) job.controller.abort(); await Promise.allSettled([...jobs.values()].map(job => job.promise)); await Promise.allSettled([...executions]); }
  async function describe(media, probe) {
    const sidecars = findSidecarFiles ? await findSidecarFiles(media.path, null, { prepareFonts: false }) : { subtitles: (media.subtitles || []).filter(item => item.source !== 'embedded'), fonts: (media.fonts || []).filter(item => item.source !== 'embedded') };
    return describeVideoResources({ ...media, subtitles: [...sidecars.subtitles, ...(media.subtitles || []).filter(item => item.source === 'embedded')], fonts: [...sidecars.fonts, ...(media.fonts || []).filter(item => item.source === 'embedded')] }, probe);
  }
  return { ensureSubtitle, resolveSubtitle, resolveFont, pinFonts, describe, stop, collect: store.collect, protectedPaths: () => new Set(activePaths), status: () => ({ ...metrics,
    preparedTracks: appState.media.reduce((count, media) => count + (media.subtitles || []).filter(track => track.state === 'ready' && track.sourceVersion === videoSourceVersion(media)).length, 0),
    active: jobs.size, executing: executions.size, fonts: store.status() }) };
}
