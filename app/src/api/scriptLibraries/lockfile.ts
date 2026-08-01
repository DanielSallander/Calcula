//! FILENAME: app/src/api/scriptLibraries/lockfile.ts
// PURPOSE: The workbook's dependency lockfile (`.calcula/script-deps.json`) and
//          the content-addressed source cache beside it
//          (`.calcula/script-libs/<sha256>.js`).
// CONTEXT: Both live in the .cala virtual filesystem next to
//          `.calcula/script-consent.json`, so a workbook carries its own
//          dependency graph AND the exact bytes it will execute.
// SECURITY: Two properties, both load-bearing:
//   1. RESOLUTION AT MOUNT IS FROM THE LOCKFILE, NEVER FROM THE REGISTRY. The
//      registry is consulted only on an explicit install or update check. A
//      workbook opened on a machine whose registry has drifted therefore
//      resolves identically or fails loudly — a remote version bump can never
//      silently change what a workbook executes. (That is the same failure mode
//      the per-source-hash consent store exists to prevent, which is also why
//      auto-update is not offered anywhere in this feature.)
//   2. THE SOURCE IS CACHED BY HASH AND RE-VERIFIED ON READ. Every module body
//      is stored under its own SHA-256 and the lockfile records that hash; a
//      cache file whose content stops hashing to its name is refused. So a hand-
//      edited .cala cannot swap a library body for a consented one, and the
//      workbook still runs offline with byte-identical behaviour.

import { readVirtualFile, createVirtualFile, deleteVirtualFile } from "../backend";
import { sha256Hex } from "../distributedConsent";
import type { LibraryLockfile, LockedLibrary } from "./types";
import { LibraryLinkError } from "./types";

const LOCKFILE_PATH = ".calcula/script-deps.json";
const BLOB_DIR = ".calcula/script-libs";

/** Path of the content-addressed cache entry for a source hash. */
export function blobPath(sourceHash: string): string {
  return `${BLOB_DIR}/${sourceHash}.js`;
}

const EMPTY: LibraryLockfile = { version: 1, libraries: [] };

/** Read the lockfile. A missing/unparseable file means "no dependencies". */
export async function loadLockfile(): Promise<LibraryLockfile> {
  try {
    const text = await readVirtualFile(LOCKFILE_PATH);
    const parsed = JSON.parse(text) as LibraryLockfile;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.libraries)) {
      return { version: 1, libraries: parsed.libraries };
    }
  } catch {
    /* missing or unreadable — treat as empty */
  }
  return { version: 1, libraries: [] };
}

// The lockfile is a read-modify-write of ONE shared file and there are two
// writers (install and remove). Serialize on a module-level promise so a
// concurrent pair cannot lose an update, exactly as distributedConsent.ts does
// for the consent store.
let writeQueue: Promise<unknown> = Promise.resolve();

function serialize<T>(run: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(run, run);
  writeQueue = next.catch(() => undefined);
  return next;
}

/** Overwrite the lockfile with `libraries` (sorted for a stable diff). */
async function writeLockfileNow(libraries: LockedLibrary[]): Promise<void> {
  const file: LibraryLockfile = {
    version: 1,
    libraries: [...libraries].sort((a, b) => a.package.localeCompare(b.package)),
  };
  await createVirtualFile(LOCKFILE_PATH, JSON.stringify(file, null, 2));
}

/**
 * Insert/replace `entries` in the lockfile and write their module sources into
 * the content-addressed cache. Called ONLY after consent has been recorded.
 */
export function commitLockedLibraries(
  entries: LockedLibrary[],
  sources: Map<string, string>,
): Promise<void> {
  return serialize(async () => {
    for (const [hash, source] of sources) {
      // Defensive: never write a blob under a name it does not hash to.
      if ((await sha256Hex(source)) !== hash) {
        throw new LibraryLinkError(
          "integrity",
          `Refusing to cache a library source under a hash it does not match (${hash}).`,
        );
      }
      await createVirtualFile(blobPath(hash), source);
    }
    const current = await loadLockfile();
    const replaced = new Set(entries.map((e) => e.package));
    const merged = current.libraries.filter((l) => !replaced.has(l.package)).concat(entries);
    await writeLockfileNow(merged);
  });
}

/**
 * Remove a package (and any transitive node no longer required by anything)
 * from the lockfile. Orphaned source blobs are deleted best-effort; a leftover
 * blob is inert (nothing can reach a source the lockfile does not name).
 */
export function removeLockedLibrary(packageName: string): Promise<LockedLibrary[]> {
  return serialize(async () => {
    const current = await loadLockfile();
    let keep = current.libraries.filter((l) => l.package !== packageName);
    // Drop transitive nodes whose only requirer just went away. Iterate to a
    // fixed point so a chain a -> b -> c collapses in one call.
    for (;;) {
      const names = new Set(keep.map((l) => l.package));
      const next = keep.filter(
        (l) => l.requiredBy.length === 0 || l.requiredBy.some((r) => names.has(r)),
      );
      if (next.length === keep.length) break;
      keep = next;
    }
    const removed = current.libraries.filter((l) => !keep.some((k) => k.package === l.package));
    await writeLockfileNow(keep);
    const liveHashes = new Set(keep.flatMap((l) => l.modules.map((m) => m.sourceHash)));
    for (const lib of removed) {
      for (const mod of lib.modules) {
        if (liveHashes.has(mod.sourceHash)) continue;
        try {
          await deleteVirtualFile(blobPath(mod.sourceHash));
        } catch {
          /* best-effort: an orphaned blob is unreachable, not dangerous */
        }
      }
    }
    return keep;
  });
}

/**
 * Read a cached library source and RE-VERIFY it against its hash. A mismatch is
 * a hard error — the workbook was edited outside Calcula, and a body the user
 * never consented to must not be mounted.
 */
export async function readLockedSource(sourceHash: string): Promise<string> {
  let text: string;
  try {
    text = await readVirtualFile(blobPath(sourceHash));
  } catch {
    throw new LibraryLinkError(
      "integrity",
      `The cached source for library module ${sourceHash.slice(0, 12)} is missing from this workbook. Reinstall the library.`,
    );
  }
  const actual = await sha256Hex(text);
  if (actual !== sourceHash) {
    throw new LibraryLinkError(
      "integrity",
      `The cached source for library module ${sourceHash.slice(0, 12)} does not match its recorded hash. Refusing to run it.`,
    );
  }
  return text;
}

/** Find a locked library by package name. */
export function findLocked(
  lockfile: LibraryLockfile,
  packageName: string,
): LockedLibrary | undefined {
  return lockfile.libraries.find((l) => l.package === packageName);
}
