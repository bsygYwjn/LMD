const GIB = 1024 ** 3;

// Keep these limits aligned with normalizePlaybackSettings in playback-planner.mjs.
// The server accepts fractional values; step="any" also lets existing values
// round-trip without being rejected by an unrelated input step interval.
export const PLAYBACK_SETTING_FIELDS = [
  { key: "cacheGib", setting: "cacheMaxBytes", label: "缓存上限（GiB）", min: 0.0625, max: 1024, scale: GIB, rangeError: "缓存上限须为 64 MiB 至 1024 GiB。" },
  { key: "ttlHours", setting: "cacheTtlSeconds", label: "缓存保留（小时）", min: 1 / 60, max: 168, scale: 3600, rangeError: "缓存保留时间须为 1 分钟至 7 天。" },
  { key: "ahead", setting: "aheadSeconds", label: "前向准备窗口（秒）", min: 6, max: 120, scale: 1, rangeError: "前向准备窗口须为 6 至 120 秒。" },
  { key: "back", setting: "backBufferSeconds", label: "后向缓冲（秒）", min: 0, max: 120, scale: 1, rangeError: "后向缓冲须为 0 至 120 秒。" },
  { key: "heartbeat", setting: "heartbeatSeconds", label: "心跳间隔（秒）", min: 3, max: 30, scale: 1, rangeError: "心跳间隔须为 3 至 30 秒。" },
  { key: "lease", setting: "leaseSeconds", label: "无心跳租约（秒）", min: 15, max: 180, scale: 1, rangeError: "无心跳租约须为 15 至 180 秒。" },
  { key: "initialLease", setting: "initialLeaseSeconds", label: "首次心跳前回收（秒）", min: 10, max: 180, scale: 1, rangeError: "首次心跳前回收窗口须为 10 至 180 秒。" },
  { key: "noOutput", setting: "noOutputSeconds", label: "FFmpeg 无输出超时（秒）", min: 5, max: 120, scale: 1, rangeError: "FFmpeg 无输出超时须为 5 至 120 秒。" },
] as const;

export type PlaybackSettingsField = (typeof PLAYBACK_SETTING_FIELDS)[number]["key"];
export type PlaybackSettingsValues = Record<(typeof PLAYBACK_SETTING_FIELDS)[number]["setting"], number>;
export type PlaybackSettingsDraft = Record<PlaybackSettingsField, string>;
export type PlaybackSettingsErrors = Partial<Record<PlaybackSettingsField, string>>;
export type PlaybackSettingsValidation =
  | { ok: true; value: PlaybackSettingsValues }
  | { ok: false; errors: PlaybackSettingsErrors };

export function playbackSettingsToDraft(settings: PlaybackSettingsValues | null): PlaybackSettingsDraft {
  return Object.fromEntries(PLAYBACK_SETTING_FIELDS.map(field => [
    field.key, settings ? String(settings[field.setting] / field.scale) : "",
  ])) as PlaybackSettingsDraft;
}

function finiteDraftNumber(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function playbackSettingsInputRange(field: (typeof PLAYBACK_SETTING_FIELDS)[number], draft: PlaybackSettingsDraft) {
  const heartbeat = finiteDraftNumber(draft.heartbeat);
  const lease = finiteDraftNumber(draft.lease);
  return {
    min: (field.key === "lease" || field.key === "initialLease") && heartbeat !== null
      ? Math.max(field.min, heartbeat * 2) : field.min,
    max: field.key === "initialLease" && lease !== null ? Math.min(field.max, lease) : field.max,
  };
}

export function validatePlaybackSettingsDraft(draft: PlaybackSettingsDraft): PlaybackSettingsValidation {
  const errors: PlaybackSettingsErrors = {};
  const value = {} as PlaybackSettingsValues;
  for (const field of PLAYBACK_SETTING_FIELDS) {
    const number = finiteDraftNumber(draft[field.key]);
    if (number === null) {
      errors[field.key] = `请输入有效的${field.label}。`;
    } else if (number < field.min || number > field.max) {
      errors[field.key] = field.rangeError;
    } else {
      value[field.setting] = number * field.scale;
    }
  }
  if (!errors.heartbeat && !errors.lease && value.leaseSeconds < value.heartbeatSeconds * 2) {
    errors.lease = `无心跳租约须至少为心跳间隔的两倍（${value.heartbeatSeconds * 2} 秒）。`;
  }
  if (!errors.initialLease) {
    if (!errors.heartbeat && value.initialLeaseSeconds < value.heartbeatSeconds * 2) {
      errors.initialLease = `首次心跳前回收窗口须至少为心跳间隔的两倍（${value.heartbeatSeconds * 2} 秒）。`;
    } else if (!errors.lease && value.initialLeaseSeconds > value.leaseSeconds) {
      errors.initialLease = `首次心跳前回收窗口不能超过无心跳租约（${value.leaseSeconds} 秒）。`;
    }
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}
