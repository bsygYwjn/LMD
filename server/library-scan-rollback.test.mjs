import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createReadingService } from "./reading.mjs";
import { createPhotoService } from "./photos.mjs";
import { createMusicService } from "./music.mjs";

const directory = await mkdtemp(path.join(tmpdir(), "lmd-library-rollback-"));
try {
  const library = path.join(directory, "library");
  await mkdir(library);
  for (const [name, createService, librariesKey, itemsKey] of [
    ["reading", createReadingService, "readingLibraries", "readingItems"],
    ["photos", createPhotoService, "photoLibraries", "photoItems"],
    ["music", createMusicService, "musicLibraries", "musicTracks"],
  ]) {
    for (const removeLibraryDuringSave of [false, true]) {
      const previous = { id: "saved", libraryId: "library", path: path.join(library, "offline-file") };
      const appState = { [librariesKey]: [{ id: "library", path: library, name }], [itemsKey]: [previous], jobs: [], settings: {} };
      let saves = 0;
      let persisted = null;
      const service = createService({
        appState,
        cacheDirectory: path.join(directory, `${name}-${removeLibraryDuringSave}`),
        getCompatibleCopyDirectory: () => path.join(directory, "compatible"),
        getMediaTools: () => ({ available: false }),
        stableId: value => value,
        saveState: async () => {
          saves += 1;
          if (saves === 1) {
            if (removeLibraryDuringSave) appState[librariesKey] = [];
            throw new Error("simulated state replacement failure");
          }
          persisted = structuredClone(appState);
        },
      });
      await assert.rejects(service.scanLibraries(), /simulated state replacement failure/);
      assert.equal(service.scanStatus().phase, "failed");
      assert.deepEqual(appState[itemsKey], removeLibraryDuringSave ? [] : [previous], `${name}: failed final save must preserve previous entries without restoring a removed library`);
      assert.deepEqual(persisted[itemsKey], appState[itemsKey], `${name}: recovery state is persisted`);
      await service.scanLibraries();
      assert.deepEqual(appState[itemsKey], [], `${name}: the next successful scan can remove missing files`);
      assert.equal(service.scanStatus().phase, "completed");
    }
  }
  console.log("Library scan rollback passed: reading, photos and music preserve missing entries after save failure, honor concurrent removals and recover on retry.");
} finally {
  assert.equal(path.dirname(directory), path.resolve(tmpdir()));
  assert.ok(path.basename(directory).startsWith("lmd-library-rollback-"));
  await rm(directory, { recursive: true, force: true });
}
