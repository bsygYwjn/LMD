import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { AlertTriangle, Check, LoaderCircle } from "lucide-react";
import {
  PLAYBACK_SETTING_FIELDS,
  playbackSettingsInputRange,
  playbackSettingsToDraft,
  validatePlaybackSettingsDraft,
  type PlaybackSettingsErrors,
  type PlaybackSettingsValues,
} from "./playback-settings-form";

type PlaybackSettingsStatus = { cacheBytes: number; cacheMaxBytes: number; sessions: number; pipelines: number };

function formatStorage(bytes: number) {
  if (!bytes) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** unit).toFixed(unit > 2 ? 1 : 0)} ${units[unit]}`;
}

export function PlaybackSettingsCard({ settings, status, onSave }: {
  settings: PlaybackSettingsValues | null;
  status: PlaybackSettingsStatus | null;
  onSave: (patch: PlaybackSettingsValues) => Promise<void>;
}) {
  const id = useId();
  const [draft, setDraft] = useState(() => playbackSettingsToDraft(settings));
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [showValidation, setShowValidation] = useState(false);
  const [saveError, setSaveError] = useState("");
  // A refreshed response object with identical values must not discard edits.
  const savedDraft = useMemo(() => settings ? playbackSettingsToDraft(settings) : null, [
    settings?.cacheMaxBytes, settings?.cacheTtlSeconds, settings?.aheadSeconds,
    settings?.backBufferSeconds, settings?.heartbeatSeconds, settings?.leaseSeconds,
    settings?.initialLeaseSeconds, settings?.noOutputSeconds,
  ]);
  useEffect(() => {
    if (!savedDraft) return;
    setDraft(savedDraft);
    setShowValidation(false);
    setSaveError("");
  }, [savedDraft]);

  const validation = validatePlaybackSettingsDraft(draft);
  const errors: PlaybackSettingsErrors = showValidation && !validation.ok ? validation.errors : {};
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving.current || !settings) return;
    setShowValidation(true);
    setSaveError("");
    if (!validation.ok) {
      const field = PLAYBACK_SETTING_FIELDS.find(item => validation.errors[item.key]);
      if (field) (event.currentTarget.elements.namedItem(field.key) as HTMLInputElement | null)?.focus();
      return;
    }
    saving.current = true;
    setBusy(true);
    try {
      await onSave(validation.value);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "无法保存播放设置，请重试。");
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };

  return <section className="adm-section playback-settings-card" aria-labelledby={`${id}-title`}>
    <div className="adm-section-head"><div>
      <h2 id={`${id}-title`}>视频播放缓存与会话</h2>
      <p>设置兼容播放的缓存容量与回收时间，保存后对新播放会话生效。</p>
    </div></div>
    <p className="playback-settings-status">{status
      ? `缓存占用 ${formatStorage(status.cacheBytes)} / ${formatStorage(status.cacheMaxBytes)} · 活跃会话 ${status.sessions} 个 · 处理进程 ${status.pipelines} 个`
      : "正在读取播放状态…"}</p>
    <form className="playback-settings-form" onSubmit={submit} onInvalid={() => setShowValidation(true)} aria-busy={busy}>
      <div className="setting-fields playback-settings-fields">
        {PLAYBACK_SETTING_FIELDS.map(field => <label key={field.key} htmlFor={`${id}-${field.key}`}>
          <span>{field.label}</span>
          <input id={`${id}-${field.key}`} name={field.key} type="number" required step="any"
            {...playbackSettingsInputRange(field, draft)} value={draft[field.key]} disabled={busy || !settings}
            aria-invalid={Boolean(errors[field.key])}
            aria-describedby={errors[field.key] ? `${id}-${field.key}-error` : undefined}
            onChange={event => { setDraft(current => ({ ...current, [field.key]: event.target.value })); setSaveError(""); }} />
          {errors[field.key] && <small className="field-error" id={`${id}-${field.key}-error`}>{errors[field.key]}</small>}
        </label>)}
      </div>
      {saveError && <div className="banner banner--warning" role="alert"><AlertTriangle size={14} /><span>{saveError}</span></div>}
      <div className="setting-card-actions">
        <button type="submit" className="btn btn--primary btn--sm" disabled={busy || !settings}>
          {busy ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}{busy ? "正在保存" : "保存播放设置"}
        </button>
      </div>
      <p className="setting-hint">无心跳租约和首次心跳前回收窗口都须至少为心跳间隔的两倍，首次心跳前回收窗口不能超过无心跳租约。</p>
    </form>
  </section>;
}
