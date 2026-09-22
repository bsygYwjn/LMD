import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMusicService } from "./music.mjs";

const directory = await mkdtemp(path.join(tmpdir(), "lmd-music-state-safety-"));
try {
  const audioDirectory = path.join(directory, "audio");
  await mkdir(audioDirectory);
  const original = path.join(audioDirectory, "my-original-album.flac");
  const unrelated = path.join(audioDirectory, `${"c".repeat(20)}-original.flac`);
  const orphan = path.join(audioDirectory, `${"a".repeat(20)}-${"b".repeat(16)}.flac`);
  const live = path.join(audioDirectory, `${"d".repeat(20)}-${"e".repeat(16)}.flac`);
  const partial = `${orphan}.job.partial.flac`;
  for (const file of [original, unrelated, orphan, live, partial]) await writeFile(file, "fixture bytes");
  const cleanupService = createMusicService({
    appState: { musicTracks: [{ compatiblePath: live }], musicLibraries: [] },
    cacheDirectory: path.join(directory, "cache"),
    getCompatibleCopyDirectory: () => directory,
  });
  await cleanupService.cleanOrphanedCacheFiles();
  for (const file of [original, unrelated, live, partial]) await access(file);
  await assert.rejects(access(orphan), { code: "ENOENT" });

  const unhandled = [];
  const collectUnhandled = error => unhandled.push(error);
  process.on("unhandledRejection", collectUnhandled);
  try {
    const service = createMusicService({
      appState: { musicTracks: [{ id: "fixture", path: path.join(directory, "fixture.ape"), extension: "APE", lossless: true, size: 1, modifiedAt: "2026-01-01", title: "Fixture" }], musicLibraries: [], jobs: [] },
      cacheDirectory: path.join(directory, "failure-cache"),
      getCompatibleCopyDirectory: () => directory,
      getMediaTools: () => ({ available: true, ffmpeg: "unused" }),
      saveState: async () => { throw new Error("simulated disk failure"); },
      runCommand: async () => { assert.fail("conversion must not run after its initial state save fails"); },
    });
    await assert.rejects(service.queueAutomaticCompatibleCopies(), /simulated disk failure/);
    const deadline = Date.now() + 3000;
    while (service.hasActiveJobs() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(service.hasActiveJobs(), false, "failed background tasks release their queue slot");
    assert.deepEqual(unhandled, [], "background save failures must not terminate the server via unhandled rejection");
  } finally {
    process.off("unhandledRejection", collectUnhandled);
  }
  console.log("Music state safety passed: original files and active copies are preserved, generated orphans are removed, and background save failures are handled.");
} finally {
  assert.equal(path.dirname(directory), path.resolve(tmpdir()));
  assert.ok(path.basename(directory).startsWith("lmd-music-state-safety-"));
  await rm(directory, { recursive: true, force: true });
}
