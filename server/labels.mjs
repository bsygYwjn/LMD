import path from 'node:path';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const canonicalPaths = new Map();
const key = value => {
  const resolved = path.resolve(value);
  if (canonicalPaths.has(resolved)) return canonicalPaths.get(resolved);
  try { const canonical = realpathSync.native(resolved).toLowerCase(); canonicalPaths.set(resolved, canonical); return canonical; }
  catch { return resolved.toLowerCase(); }
};
const inside = (child, parent) => {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
const hasTitle = r => Boolean(r?.title || r?.originalTitle);
const fields = (obj, allowed) => {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('需要 JSON 对象');
  for (const field of Object.keys(obj)) if (!allowed.includes(field)) throw new Error(`不允许字段：${field}`);
};
const text = (value, max = 160) => {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f]/u.test(value)) throw new Error('标题或证据格式无效');
  return value.trim();
};
function titles(value, evidence = false) {
  fields(value, ['title', 'originalTitle', 'episodeTitle', 'originalEpisodeTitle', 'sources', 'evidence']);
  const result = {};
  for (const field of ['title', 'originalTitle', 'episodeTitle', 'originalEpisodeTitle']) if (value[field] !== undefined) result[field] = text(value[field]);
  if (value.sources !== undefined) {
    if (!Array.isArray(value.sources) || value.sources.length > 8) throw new Error('来源需为最多 8 个真实网页链接');
    result.sources = value.sources.map(link => {
      const url = new URL(text(link, 2000));
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !url.hostname.includes('.')) throw new Error('来源链接无效');
      return url.href;
    });
  }
  if (value.evidence !== undefined) result.evidence = text(value.evidence, 600);
  if (evidence && (!result.sources?.length || !result.evidence)) throw new Error('缺少来源或简短证据；搜索失败请 release，歧义请标 review');
  return result;
}

// Records are keyed by canonical location, independently of scan-generated IDs.
// A transaction becomes visible only after atomic replacement succeeds.
export async function createLabelService({ directory, getState, folderForMedia, stableId, episodeForMedia, now = Date.now, leaseMs = 30 * 60 * 1000 }) {
  const file = path.join(directory, 'display-labels.json');
  await mkdir(directory, { recursive: true });
  let state = { schema: 1, records: {}, batches: {} };
  try { state = JSON.parse(await readFile(file, 'utf8')); if (state.schema !== 1 || !state.records || !state.batches) throw new Error('打标记录格式无效'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const [p, record] of Object.entries(state.records)) {
    const canonical = key(p);
    if (canonical !== p && !state.records[canonical]) state.records[canonical] = record;
  }
  for (const legacy of getState().displayGroups) {
    const p = key(legacy.path);
    if (!Object.hasOwn(state.records, p) && legacy.title) state.records[p] = { title: legacy.title, source: 'manual', version: legacy.updatedAt || hash(legacy) };
  }
  let queue = Promise.resolve();
  const transaction = fn => {
    const run = queue.then(async () => {
      const draft = structuredClone(state);
      const result = fn(draft);
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(draft), 'utf8');
      await rename(temporary, file);
      state = draft;
      return result;
    });
    queue = run.catch(() => {});
    return run;
  };
  function own(p, s = state) {
    const k = key(p);
    if (Object.hasOwn(s.records, k)) return s.records[k];
    const legacy = getState().displayGroups.find(g => key(g.path) === k);
    return legacy ? { title: legacy.title, source: 'manual', version: legacy.updatedAt || hash(legacy) } : null;
  }
  function inherited(p, s = state) {
    let current = key(p);
    while (true) {
      const record = own(current, s);
      if (hasTitle(record)) return record;
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
  function targets() {
    const app = getState(), folders = new Map(), videos = [];
    for (const media of app.media) {
      const folder = path.resolve(folderForMedia(media));
      const root = path.resolve(app.libraries.find(l => l.id === media.libraryId)?.path || folder);
      let current = folder;
      while (inside(key(current), key(root))) {
        const k = key(current);
        if (!folders.has(k)) folders.set(k, { id: stableId(current), kind: 'folder', path: current, name: path.basename(current), members: [] });
        folders.get(k).members.push(media);
        if (key(current) === key(root)) break;
        current = path.dirname(current);
      }
      videos.push({ id: media.id, kind: 'video', path: media.path, name: media.fileName, members: [media] });
    }
    return [...folders.values(), ...videos];
  }
  function version(target, s) {
    return hash([target.kind, key(target.path), own(target.path, s), inherited(path.dirname(target.path), s), target.members.map(m => [m.id, key(m.path), m.size, m.modifiedAt, own(m.path, s), inherited(folderForMedia(m), s)])]);
  }
  function protectedTarget(target, s) {
    return hasTitle(inherited(target.path, s)) || target.members.some(m => hasTitle(inherited(m.path, s)));
  }
  function active(s) { return Object.values(s.batches).filter(b => !b.closed && b.expiresAt > now()); }
  function available(target, s) {
    if (protectedTarget(target, s) || Object.entries(s.records).some(([p, r]) => r.status === 'review' && (inside(key(target.path), p) || inside(p, key(target.path))))) return false;
    const members = new Set(target.members.map(m => key(m.path)));
    return !active(s).some(b => b.groups.some(g => g.members.some(p => members.has(p))));
  }
  function defaultGroups(all) {
    const groups = new Map();
    for (const t of all.filter(t => t.kind === 'folder' && t.members.some(m => key(folderForMedia(m)) === key(t.path)))) {
      const isSeason = /^(?:s\d+|season[ ._-]*\d+|第[一二三四五六七八九十\d]+季)$/iu.test(t.name);
      const parent = isSeason && all.find(p => p.kind === 'folder' && key(p.path) === key(path.dirname(t.path)));
      const work = parent || t;
      groups.set(work.id, work);
    }
    return [...groups.values()];
  }
  function publicTarget(t, s) {
    const record = own(t.path, s);
    const { groupPath, ...safeRecord } = { ...inherited(t.kind === 'video' ? folderForMedia(t.members[0]) : t.path), ...record };
    return { ...safeRecord, id: t.id, kind: t.kind, name: t.name, version: version(t, s), protected: protectedTarget(t, s), status: protectedTarget(t, s) ? 'completed' : record?.status === 'review' ? 'review' : available(t, s) ? 'pending' : 'claimed' };
  }
  function status() {
    const all = targets(), groups = defaultGroups(all), counts = { pending: 0, completed: 0, review: 0, claimed: 0 };
    for (const t of groups) counts[publicTarget(t, state).status]++;
    return { ...counts, batches: active(state).map(b => ({ id: b.id, expiresAt: b.expiresAt, groups: b.groups.length })) };
  }
  function claim(body) {
    fields(body, ['id', 'ids', 'scope', 'limit', 'retry']);
    if (body.id && body.ids) throw new Error('id 与 ids 不可同时指定');
    const scope = body.scope || 'direct';
    if (!['direct', 'children', 'recursive'].includes(scope)) throw new Error('范围应为 direct、children 或 recursive');
    const limit = body.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('每批 1–10 个作品组');
    return transaction(s => {
      const all = targets(), ids = body.ids || (body.id ? [body.id] : []);
      if (!Array.isArray(ids) || ids.length > 100) throw new Error('范围 ID 无效');
      const roots = ids.map(id => { const t = all.find(t => t.id === id); if (!t) throw new Error(`目标不存在：${id}`); return t; });
      let candidates = roots.length ? all.filter(t => roots.some(r => t.id === r.id && (scope === 'direct' || r.kind === 'video') || r.kind === 'folder' && t.kind === 'folder' && (scope === 'children' ? key(path.dirname(t.path)) === key(r.path) : scope === 'recursive' && inside(key(t.path), key(r.path))))) : defaultGroups(all);
      // Recursive scopes claim leaf/direct-media works, never one mixed library as a work.
      if (scope === 'recursive') {
        const works = defaultGroups(all);
        candidates = roots.length ? works.filter(t => roots.some(r => r.kind === 'folder' && inside(key(t.path), key(r.path)) || r.id === t.id)) : works;
        for (const r of roots.filter(r => r.kind === 'video')) candidates.push(r);
      }
      const selected = [], used = new Set();
      for (const t of candidates) {
        if (selected.length >= limit) break;
        if (body.retry === true) for (const [p, record] of Object.entries(s.records)) {
          if (record.status === 'review' && inside(p, key(t.path))) s.records[p] = { version: randomUUID(), status: 'pending' };
        }
        if (!available(t, s) || t.members.some(m => used.has(key(m.path)))) continue;
        selected.push(t); t.members.forEach(m => used.add(key(m.path)));
      }
      if (!selected.length) return { batchId: null, groups: [] };
      const batch = { id: randomUUID(), expiresAt: now() + leaseMs, groups: selected.map(t => ({ id: t.id, kind: t.kind, path: key(t.path), version: version(t, s), members: t.members.map(m => key(m.path)) })) };
      s.batches[batch.id] = batch;
      return { batchId: batch.id, expiresAt: batch.expiresAt, groups: selected.map(t => ({ id: t.id, version: version(t, s), kind: t.kind, directory: t.kind === 'folder' ? t.name : path.basename(folderForMedia(t.members[0])), representative: t.members[0].fileName, episodes: t.members.map((m, i) => ({ slot: i + 1, episode: episodeForMedia(m), seasonHint: m.fileName.match(/s(\d+)e\d+/i)?.[1] || path.basename(folderForMedia(m)) })) })) };
    });
  }
  function batchFor(s, id) {
    if (typeof id !== 'string' || !Object.hasOwn(s.batches, id)) throw new Error('批次不存在');
    return s.batches[id];
  }
  function check(body, s) {
    fields(body, ['batchId', 'groups']);
    const batch = batchFor(s, body.batchId);
    const digest = hash(body);
    if (batch.result) { if (batch.digest !== digest) throw new Error('已提交批次内容不可改变'); return { batch, duplicate: true, digest }; }
    if (batch.closed || batch.expiresAt <= now()) throw new Error('批次已释放或过期，请重新领取');
    if (!Array.isArray(body.groups) || body.groups.length > batch.groups.length) throw new Error('作品组范围无效');
    const all = targets(), seen = new Set(), changes = [];
    for (const g of body.groups) {
      fields(g, ['id', 'version', 'status', 'reason', 'titles', 'episodes']);
      const claimed = batch.groups.find(t => t.id === g.id);
      if (!claimed || seen.has(g.id)) throw new Error('目标越界或重复');
      seen.add(g.id);
      const target = all.find(t => t.id === g.id && key(t.path) === claimed.path);
      if (!target || claimed.version !== g.version || version(target, s) !== claimed.version || protectedTarget(target, s)) throw new Error('目标已改变或已有标题；手动修改优先，请释放批次');
      if (g.status === 'review') {
        if (g.titles || g.episodes) throw new Error('待确认项目不能提交标题');
        const reason = text(g.reason, 400);
        if (!reason) throw new Error('待确认需要简短原因');
        changes.push([claimed.path, { status: 'review', reason }]);
        continue;
      }
      if (g.status !== 'completed') throw new Error('状态应为 completed 或 review');
      const record = titles(g.titles, true);
      if (!hasTitle(record) || !record.originalTitle) throw new Error('请提供作品标题及首映正式原名');
      changes.push([claimed.path, { ...record, status: 'completed' }]);
      if (g.episodes !== undefined) {
        if (!Array.isArray(g.episodes)) throw new Error('集名应为数组');
        const slots = new Set();
        for (const e of g.episodes) {
          fields(e, ['slot', 'episodeTitle', 'originalEpisodeTitle']);
          if (!Number.isInteger(e.slot) || !claimed.members[e.slot - 1] || slots.has(e.slot)) throw new Error('集名 slot 越界或重复');
          slots.add(e.slot);
          const { slot, ...names } = e;
          const episode = titles(names);
          if (!episode.episodeTitle && !episode.originalEpisodeTitle) throw new Error('集名为空');
          changes.push([claimed.members[slot - 1], { ...record, ...episode, status: 'completed', groupPath: claimed.path }]);
        }
      }
    }
    return { batch, digest, changes };
  }
  return {
    status, targets: () => targets().map(t => publicTarget(t, state)),
    folder: p => inherited(p), own,
    media: m => {
      const override = own(m.path);
      const { groupPath, ...record } = hasTitle(override) ? { ...override } : { ...inherited(folderForMedia(m)), ...override };
      return record;
    },
    claim,
    validate: body => { const c = check(body, state); return { valid: true, duplicate: !!c.duplicate, groups: body.groups.length }; },
    apply: body => transaction(s => {
      const c = check(body, s);
      if (c.duplicate) return { ...c.batch.result, duplicate: true };
      for (const [p, r] of c.changes) s.records[p] = { ...r, source: 'agent', version: randomUUID(), updatedAt: new Date(now()).toISOString() };
      const result = { success: body.groups.filter(g => g.status === 'completed').length, review: body.groups.filter(g => g.status === 'review').length, skipped: c.batch.groups.length - body.groups.length, errors: 0 };
      Object.assign(c.batch, { closed: true, digest: c.digest, result });
      return result;
    }),
    release: body => {
      fields(body, ['batchId']);
      return transaction(s => { const b = batchFor(s, body.batchId); b.closed = true; return { released: true }; });
    },
    manual: (id, body) => transaction(s => {
      fields(body, ['title', 'originalTitle', 'episodeTitle', 'originalEpisodeTitle', 'clear']);
      const target = targets().find(t => t.id === id);
      if (!target) throw new Error('目标不存在');
      const p = key(target.path);
      if (body.clear === true) {
        // Explicit group clearing also clears its episode overrides and review state.
        for (const t of targets().filter(t => inside(key(t.path), p))) s.records[key(t.path)] = { version: randomUUID(), status: 'pending' };
      } else {
        const { clear, ...values } = body;
        s.records[p] = { ...titles(values), source: 'manual', version: randomUUID(), updatedAt: new Date(now()).toISOString() };
      }
      return { ok: true };
    }),
  };
}
