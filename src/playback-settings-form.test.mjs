import assert from "node:assert/strict";
import { PLAYBACK_DEFAULTS, normalizePlaybackSettings } from "../server/playback-planner.mjs";
import { PLAYBACK_SETTING_FIELDS, playbackSettingsInputRange, playbackSettingsToDraft, validatePlaybackSettingsDraft } from "./playback-settings-form.ts";

const defaults = playbackSettingsToDraft(PLAYBACK_DEFAULTS);
const parse = changes => validatePlaybackSettingsDraft({ ...defaults, ...changes });

{
  const result = parse({ initialLease: "35" });
  assert.equal(result.ok, true);
  assert.equal(result.value.initialLeaseSeconds, 35, "the editable initial lease must be included in the save payload");
  const accepted = normalizePlaybackSettings({ ...PLAYBACK_DEFAULTS, ...result.value });
  for (const field of PLAYBACK_SETTING_FIELDS) assert.equal(accepted[field.setting], result.value[field.setting]);
}

{
  const minimums = parse({ cacheGib: String(64 * 1024 ** 2 / 1024 ** 3), ttlHours: String(60 / 3600) });
  assert.equal(minimums.ok, true);
  assert.equal(minimums.value.cacheMaxBytes, 64 * 1024 ** 2);
  assert.equal(minimums.value.cacheTtlSeconds, 60);
  assert.doesNotThrow(() => normalizePlaybackSettings(minimums.value));
  assert.equal(parse({ cacheGib: "0.06" }).ok, false, "the previous 0.06 GiB minimum is below the server limit");
  assert.equal(parse({ ttlHours: "0.01" }).ok, false);
}

{
  const stored = { ...PLAYBACK_DEFAULTS, cacheMaxBytes: 65 * 1024 ** 2, cacheTtlSeconds: 60.5, heartbeatSeconds: 3.5, leaseSeconds: 15.5, initialLeaseSeconds: 10.25 };
  const result = validatePlaybackSettingsDraft(playbackSettingsToDraft(stored));
  assert.equal(result.ok, true, "valid fractional settings must not be rejected by the editor");
  for (const field of PLAYBACK_SETTING_FIELDS) assert.equal(result.value[field.setting], stored[field.setting]);
  assert.doesNotThrow(() => normalizePlaybackSettings(result.value));
}

{
  for (const empty of ["", " ", "NaN", "Infinity"]) {
    const result = parse({ back: empty });
    assert.equal(result.ok, false);
    assert.ok(result.errors.back, "blank or non-finite values must not silently become zero");
  }
  assert.equal(parse({ back: "0" }).ok, true, "zero is valid for the back buffer");
  assert.equal(parse({ ahead: "121" }).ok, false);
  assert.equal(parse({ noOutput: "4" }).ok, false);
}

{
  const lease = parse({ heartbeat: "20", lease: "30" });
  assert.equal(lease.ok, false);
  assert.match(lease.errors.lease, /两倍/);
  const initialShort = parse({ initialLease: "19" });
  assert.equal(initialShort.ok, false);
  assert.match(initialShort.errors.initialLease, /两倍/);
  const initialLong = parse({ initialLease: "46" });
  assert.equal(initialLong.ok, false);
  assert.match(initialLong.errors.initialLease, /不能超过/);
  assert.equal(parse({ initialLease: "45" }).ok, true);
  const initialField = PLAYBACK_SETTING_FIELDS.find(field => field.key === "initialLease");
  assert.deepEqual(playbackSettingsInputRange(initialField, defaults), { min: 20, max: 45 });
}

console.log("Playback settings form: save payload, server limits, fractional round trips, empty fields and lease constraints passed");
