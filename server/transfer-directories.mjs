import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

export const LIBRARY_KEYS = { video: 'libraries', music: 'musicLibraries', reading: 'readingLibraries', photos: 'photoLibraries', files: 'fileLibraries' };
export function within(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
const fail = (message, statusCode = 403, code = 'UPLOAD_FORBIDDEN') => { throw Object.assign(new Error(message), { statusCode, code }); };

// A filesystem inventory separate from media indexes keeps empty directories
// available. Navigation IDs and permission buckets deliberately stay distinct.
export function createTransferDirectoryService({ getState, stableId, contextForRequest, saveState, protectedPaths = [], shouldHidePath = () => false }) {
  let directories = [];
  let refreshing;
  let refreshedAt = 0;
  let librarySnapshotKey = "";
  let generation = 0;
  let stopped = false;
  const dirtyKinds = new Set(Object.keys(LIBRARY_KEYS));
  const folderId = (kind, libraryId, directory) => kind === 'video'
    ? stableId(`catalog-folder\0${libraryId}\0${path.resolve(directory)}`)
    : stableId(`${kind === 'photos' ? 'photo' : kind}:${libraryId}:${path.resolve(directory).toLowerCase()}`);
  const bucketPath = (library, directory) => path.join(path.resolve(library.path), ...path.relative(library.path, directory).split(path.sep).filter(Boolean).slice(0, 2));
  const bucketId = (kind, library, directory) => kind === 'video' ? stableId(bucketPath(library, directory)) : folderId(kind, library.id, bucketPath(library, directory));
  const isProtectedPath = filePath => protectedPaths.some(p => within(filePath, p));
  const libraries = kind => getState()[LIBRARY_KEYS[kind]] || [];
  const isLiveDirectory = directory => libraries(directory.kind).some(library => library.id === directory.libraryId && path.resolve(library.path) === directory.rootPath);
  const allowed = (context, kind, library, directory) => Boolean(context?.fullAccess || context?.allowedFolderIds?.has(bucketId(kind, library, directory)));

  async function assertSafe(directory, root) {
    if (!within(directory, root) || isProtectedPath(directory) || shouldHidePath(directory)) fail('目标目录不允许写入。');
    const resolvedRoot = path.resolve(root);
    let current = path.parse(resolvedRoot).root;
    for (const segment of path.relative(current, directory).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) fail('不能向链接或重解析目录上传。');
    }
    const actual = await realpath(directory);
    if (actual.toLowerCase() !== path.resolve(directory).toLowerCase()) fail('目标目录实际位置已变化。');
  }

  async function refresh(force = false) {
    const libraryKey = JSON.stringify(Object.keys(LIBRARY_KEYS).map(kind => [kind, libraries(kind).map(library => [library.id, library.path, library.name])]));
    if (refreshing) {
      await refreshing;
      // Library registration is shared by five services. A refresh already in
      // flight may predate a newly registered empty root.
      if (librarySnapshotKey !== libraryKey) return refresh(force);
      return;
    }
    if (librarySnapshotKey !== libraryKey) for (const kind of Object.keys(LIBRARY_KEYS)) dirtyKinds.add(kind);
    if (stopped || (!force && !dirtyKinds.size && Date.now() - refreshedAt < 5 * 60 * 1000)) return;
    refreshing = (async () => {
      const startedGeneration = generation;
      const kinds = force || !refreshedAt ? Object.keys(LIBRARY_KEYS) : dirtyKinds.size ? [...dirtyKinds] : Object.keys(LIBRARY_KEYS);
      const next = directories.filter(directory => !kinds.includes(directory.kind));
      const entriesByPath = new Map();
      const directoryEntries = directory => {
        const key = path.resolve(directory).toLowerCase();
        if (!entriesByPath.has(key)) entriesByPath.set(key, readdir(directory, { withFileTypes: true }));
        return entriesByPath.get(key);
      };
      for (const kind of kinds) for (const library of libraries(kind)) {
        const root = path.resolve(library.path);
        try { await assertSafe(root, root); } catch {
          next.push(...directories.filter(directory => directory.kind === kind && directory.libraryId === library.id));
          continue;
        }
        const visit = async (directory, depth = 0) => {
          if (depth > (kind === 'files' ? 64 : 10) || next.length >= 50000 || isProtectedPath(directory) || shouldHidePath(directory)) return;
          const id = folderId(kind, library.id, directory);
          const relativePath = path.relative(root, directory).split(path.sep).join('/');
          next.push({ id, folderId: id, kind, libraryId: library.id, libraryName: library.name || path.basename(root), path: directory, rootPath: root,
            parentId: depth ? folderId(kind, library.id, path.dirname(directory)) : null, relativePath,
            label: `${library.name || path.basename(root)}${relativePath ? ` / ${relativePath}` : ''}`, bucketId: bucketId(kind, library, directory), depth });
          let entries;
          try { entries = await directoryEntries(directory); }
          catch {
            next.push(...directories.filter(old => old.kind === kind && old.libraryId === library.id && old.path !== directory && within(old.path, directory)));
            return;
          }
          for (const entry of entries) {
            if (entry.isDirectory() && !entry.isSymbolicLink() && (kind === 'files' ? !/^\.(?:git|codex|agents)$/i.test(entry.name) : !entry.name.startsWith('.'))) await visit(path.join(directory, entry.name), depth + 1);
          }
        };
        await visit(root);
      }
      directories = [...new Map(next.map(directory => [directory.id, directory])).values()];
      // A library removed during I/O cannot reappear in a stale snapshot.
      directories = directories.filter(directory => libraries(directory.kind).some(library => library.id === directory.libraryId && path.resolve(library.path) === directory.rootPath));
      refreshedAt = Date.now();
      librarySnapshotKey = libraryKey;
      if (generation === startedGeneration) for (const kind of kinds) dirtyKinds.delete(kind);
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  function markDirty(kind) {
    directories = directories.filter(isLiveDirectory);
    generation += 1;
    for (const entry of kind ? [kind] : Object.keys(LIBRARY_KEYS)) dirtyKinds.add(entry);
    if (!stopped) void refresh().catch(() => {});
  }
  const refreshTimer = setInterval(() => { if (!stopped) void refresh().catch(() => {}); }, 60000);
  refreshTimer.unref?.();
  function close() { stopped = true; clearInterval(refreshTimer); }

  function inventory() {
    const unique = new Map();
    for (const d of directories) {
      if (d.depth > 2 || !isLiveDirectory(d)) continue;
      unique.set(d.bucketId, { id: d.bucketId, path: d.path, folderName: path.basename(d.path), title: d.label, kind: d.kind === 'photos' ? 'photo' : d.kind,
        libraryName: d.libraryName, relativePath: d.relativePath || '直属文件', mediaCount: 0, customTitle: '', sampleAlias: '', season: 1, configured: false });
    }
    return [...unique.values()];
  }
  function identify(request) {
    if (!getState().accessControl.enabled) fail('开启访问控制后才能上传。', 403, 'ACCESS_CONTROL_REQUIRED');
    const context = contextForRequest(request);
    if (!context) fail('请重新登录后继续上传。', 401, 'AUTH_REQUIRED');
    if (!context.localAdmin && context.user?.canUpload !== true) fail('管理员尚未授予上传权限。');
    return { userId: context.localAdmin ? 'local-admin' : context.user.id };
  }
  async function listTargets(request, kind) {
    identify(request);
    await refresh();
    const context = contextForRequest(request);
    return directories.filter(d => (!kind || d.kind === kind) && (context.fullAccess || context.allowedFolderIds.has(d.bucketId)))
      .map(({ path: _path, rootPath: _root, bucketId: _bucket, depth: _depth, ...d }) => ({ ...d, writable: true }));
  }
  async function resolveTarget(request, kind, id) {
    identify(request);
    if (!LIBRARY_KEYS[kind]) fail('未知的共享区。', 400, 'INVALID_KIND');
    await refresh();
    const target = directories.find(d => d.kind === kind && d.id === id);
    const library = target && libraries(kind).find(l => l.id === target.libraryId && path.resolve(l.path) === target.rootPath);
    if (!library || !allowed(contextForRequest(request), kind, library, target.path)) fail('目标目录已移除或没有写入权限。');
    await assertSafe(target.path, target.rootPath);
    return target;
  }
  async function authorizePath(request, kind, target, relativePath, options = {}) {
    identify(request);
    const context = contextForRequest(request);
    const library = libraries(kind).find(l => l.id === target.libraryId);
    if (!library) fail('共享目录已移除。');
    // Validate every existing directory: traversing an allowed ancestor never
    // grants write access to an independently classified first/second level.
    const parts = String(relativePath).replaceAll('\\', '/').split('/');
    const segments = options.directory ? parts : parts.slice(0, -1);
    if (kind !== 'files' && parts.some(segment => segment.startsWith('.'))) fail('媒体库不支持点开头的隐藏文件或目录，请选择其他文件区。', 400, 'UPLOAD_HIDDEN_MEDIA_PATH');
    const relativeDepth = path.relative(library.path, target.path).split(path.sep).filter(Boolean).length + segments.length;
    if (relativeDepth > (kind === 'files' ? 64 : 10)) fail(`目标目录最多支持 ${kind === 'files' ? 64 : 10} 层，请调整上传目标。`, 400, 'UPLOAD_PATH_TOO_DEEP');
    let current = target.path;
    for (const segment of ['', ...segments]) {
      if (segment) current = path.join(current, segment);
      if (!within(current, target.path) || isProtectedPath(current)) fail('无效的目标路径。');
      const info = await lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!info) break;
      if (!info.isDirectory() || info.isSymbolicLink()) fail('不能向链接目录上传。');
      if (!allowed(context, kind, library, current)) fail('目标子目录没有写入权限。');
      for (const overlapping of libraries(kind)) {
        if (within(current, overlapping.path) && !allowed(context, kind, overlapping, current)) fail('重叠共享目录没有写入权限。');
      }
    }
  }
  async function onDirectoriesCreated(request, kind, target, paths) {
    const state = getState();
    // Inherit only directories actually created by this operation. Existing
    // classifications, including sibling and deeper buckets, are untouched.
    for (const directory of [...paths].sort((a, b) => a.length - b.length)) {
      for (const [affectedKind, key] of Object.entries(LIBRARY_KEYS)) for (const library of state[key] || []) {
        if (!within(directory, library.path) || directory === path.resolve(library.path)) continue;
        const id = bucketId(affectedKind, library, directory);
        const parentId = bucketId(affectedKind, library, path.dirname(directory));
        if (id === parentId) continue;
        const category = state.accessControl.categories.find(c => c.folderIds.includes(parentId));
        if (category && !state.accessControl.categories.some(c => c.folderIds.includes(id))) category.folderIds.push(id);
        // Legacy per-folder grants keep exactly the new descendants writable.
        for (const user of state.accessControl.users) if (user.folderIds?.includes(parentId) && !user.folderIds.includes(id)) user.folderIds.push(id);
      }
    }
    await saveState();
    await refresh(true);
  }
  function visibleNodes(context, kind, existing = []) {
    const nodes = new Map(existing.map(node => [node.id, node]));
    const candidates = directories.filter(d => isLiveDirectory(d) && d.kind === kind && !libraries(kind).some(l => l.id !== d.libraryId && path.resolve(l.path).length > d.rootPath.length && within(d.path, l.path)));
    const visible = new Set(candidates.filter(d => context?.fullAccess || context?.allowedFolderIds?.has(d.bucketId)).map(d => d.id));
    const byId = new Map(candidates.map(d => [d.id, d]));
    for (const id of [...visible]) { let node = byId.get(id); while (node?.parentId) { visible.add(node.parentId); node = byId.get(node.parentId); } }
    for (const d of candidates) if (visible.has(d.id) && !nodes.has(d.id)) nodes.set(d.id, {
      id: d.id, parentId: d.parentId, name: path.basename(d.path), title: d.depth ? path.basename(d.path) : d.libraryName,
      kind, directMediaCount: 0, mediaCount: 0, directItemCount: 0, itemCount: 0, directTrackCount: 0, trackCount: 0, childCount: 0, coverMediaId: null, configured: false,
    });
    const children = new Map();
    for (const node of nodes.values()) if (node.parentId) children.set(node.parentId, (children.get(node.parentId) || 0) + 1);
    for (const node of nodes.values()) node.childCount = children.get(node.id) || 0;
    return [...nodes.values()];
  }
  return { refresh, markDirty, close, snapshot: () => ({ refreshedAt, refreshing: Boolean(refreshing), count: directories.length }), inventory, identify, listTargets, resolveTarget, authorizePath, onDirectoriesCreated, isProtectedPath, bucketId, folderId, visibleNodes };
}

export function uploadFormatSupported(kind, relativePath) {
  if (kind !== 'files' && relativePath.replaceAll('\\', '/').split('/').some(segment => segment.startsWith('.'))) return false;
  const extension = path.extname(relativePath).toLowerCase();
  const formats = {
    video: '.mp4 .mkv .mov .m4v .webm .avi .ts .m2ts .mts .mpg .mpeg .flv .ass .ssa .srt .ttf .otf .ttc .woff .woff2',
    music: '.mp3 .aac .m4a .flac .wav .wave .aif .aiff .ogg .opus .ape .wv .lrc .jpg .jpeg .png .webp',
    reading: '.pdf .epub .mobi .azw .azw3 .fb2 .cbz .txt .xlsx .xls .xlsm .xlsb .csv .ods',
    photos: '.jpg .jpeg .jpe .jfif .png .apng .gif .webp .avif .bmp .dib .ico .svg .tif .tiff',
  };
  if (kind === 'files') return true;
  if (kind === 'video' && extension === '.rar') return /fonts?|字体/iu.test(path.basename(relativePath)) || relativePath.replaceAll('\\', '/').split('/').slice(0, -1).some(x => /^(fonts?|字体)$/iu.test(x));
  return Boolean(formats[kind]?.split(' ').includes(extension));
}
