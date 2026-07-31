// FILENAME: app/extensions/Distribution/lib/writebackValidatorSync.ts
// PURPOSE: Keep the subscriber's publisher-shipped writeback validators in
//          sync with the current writeback regions: discover which regions
//          declare one, surface the ones awaiting the user's approval, and
//          mount the approved bodies for advisory as-you-type checks.
// CONTEXT: The AUTHORITATIVE gate is the Rust submit path — it reads the same
//          validator body out of the Ed25519-verified manifest, runs it in the
//          embedded QuickJS realm, and refuses the submission when it rejects,
//          errors, or is not consented (see the "Custom writeback validators"
//          section in app/src-tauri/src/calp_commands.rs). Nothing in this file
//          can loosen that. What it buys is (a) the consent surface — the user
//          reviews the exact code before it is allowed to run at all — and
//          (b) immediate in-cell feedback instead of a rejection at submit.
//
//          FAILURE MODES ARE DELIBERATE: a region whose validator is missing a
//          body, or not yet approved, still opens, still accepts typing and
//          still saves drafts. Only SUBMIT is blocked, and `pending` /
//          `blocked` below carry a message naming the package and the
//          validator so the pane can say exactly what to do about it.

import {
  fetchWritebackValidator,
  writebackValidatorsConsented,
  approveWritebackValidators,
  mountWritebackValidator,
  unmountWritebackValidator,
  unmountWritebackValidators,
  type WritebackValidatorDescriptor,
} from "@api/writebackValidators";

/** The only region fields this module needs — structural so it accepts a
 *  `WritebackRegionEntry` from @api/distribution without coupling to it. */
export interface WritebackRegionEntryLike {
  regionId: string;
  customValidator?: string;
}

export type { WritebackValidatorDescriptor };

/** One package's validators awaiting the user's approval. */
export interface PendingValidatorConsent {
  packageName: string;
  validators: WritebackValidatorDescriptor[];
}

/** A region whose declared validator cannot run at all (submission will fail). */
export interface BlockedValidatorRegion {
  regionId: string;
  message: string;
}

/** The outcome of one sync pass. */
export interface WritebackValidatorSyncResult {
  /** Approved validators now mounted for advisory checks. */
  mounted: WritebackValidatorDescriptor[];
  /** Packages whose validators need the user's review + approval. */
  pending: PendingValidatorConsent[];
  /** Regions that cannot be submitted at all until the publisher acts. */
  blocked: BlockedValidatorRegion[];
}

/** Emitted after every sync pass so the WritebackPane can show which packages
 *  are waiting for the user to review a validator, and which regions cannot be
 *  submitted at all. The pane reads `lastWritebackValidatorSync()` — the event
 *  carries no payload so a late subscriber never renders a stale snapshot. */
export const WRITEBACK_VALIDATORS_CHANGED_EVENT = "distribution:writebackValidatorsChanged";

/** Regions currently reflected in the mounted set, so a shrinking region list
 *  tears its validators down instead of leaving stale workers behind. */
let syncedRegions = new Set<string>();

/** The most recent pass's outcome, so a pane mounting later still sees it. */
let lastResult: WritebackValidatorSyncResult = { mounted: [], pending: [], blocked: [] };

/** The outcome of the most recent sync pass (empty before the first one). */
export function lastWritebackValidatorSync(): WritebackValidatorSyncResult {
  return lastResult;
}

/** Serialize passes: two refreshes racing would double-mount and could leave a
 *  torn-down worker recorded as mounted. */
let queue: Promise<unknown> = Promise.resolve();

async function doSync(
  regions: WritebackRegionEntryLike[],
): Promise<WritebackValidatorSyncResult> {
  const result: WritebackValidatorSyncResult = { mounted: [], pending: [], blocked: [] };

  const declaring = regions.filter((r) => !!r.customValidator);
  const live = new Set(declaring.map((r) => r.regionId));
  for (const regionId of syncedRegions) {
    if (!live.has(regionId)) unmountWritebackValidator(regionId);
  }
  syncedRegions = live;

  if (declaring.length === 0) return result;

  // Discover the validator body per region (from the verified manifest).
  const statuses = await Promise.all(
    declaring.map((r) => fetchWritebackValidator(r.regionId)),
  );

  const byPackage = new Map<string, WritebackValidatorDescriptor[]>();
  for (const status of statuses) {
    if (status.error) {
      result.blocked.push({ regionId: status.regionId, message: status.error });
      unmountWritebackValidator(status.regionId);
      continue;
    }
    if (!status.validator) continue;
    const list = byPackage.get(status.validator.packageName) ?? [];
    list.push(status.validator);
    byPackage.set(status.validator.packageName, list);
  }

  for (const [packageName, descriptors] of byPackage) {
    // Dedupe by validator name: several regions may share one validator, and
    // the consent record is per (package, validator), not per region.
    const unique = new Map<string, WritebackValidatorDescriptor>();
    for (const d of descriptors) unique.set(d.name, d);

    const consented = await writebackValidatorsConsented(packageName, [...unique.values()]);
    if (!consented) {
      for (const d of descriptors) unmountWritebackValidator(d.regionId);
      result.pending.push({ packageName, validators: [...unique.values()] });
      continue;
    }
    for (const descriptor of descriptors) {
      try {
        await mountWritebackValidator({ ...descriptor, consented: true });
        result.mounted.push(descriptor);
      } catch (error) {
        // Advisory only: a blocked/faulted mount costs the user the in-cell
        // hint, never the ability to work. The submit gate is unaffected.
        console.warn(
          `[Distribution] Advisory writeback validator "${descriptor.name}" ` +
            `from ${descriptor.packageName} could not be mounted:`,
          error,
        );
      }
    }
  }

  return result;
}

/**
 * Bring mounted validators in line with the given regions. Safe to call after
 * every writeback-snapshot refresh; serialized against itself.
 */
export function syncWritebackValidators(
  regions: WritebackRegionEntryLike[],
): Promise<WritebackValidatorSyncResult> {
  const run = async () => {
    const result = await doSync(regions);
    lastResult = result;
    return result;
  };
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

/**
 * Record the user's approval of a package's validators (after they reviewed the
 * source) and mount them. Returns the descriptors that are now live.
 */
export async function approveAndMountWritebackValidators(
  packageName: string,
  descriptors: WritebackValidatorDescriptor[],
): Promise<WritebackValidatorDescriptor[]> {
  await approveWritebackValidators(packageName, descriptors);
  const live: WritebackValidatorDescriptor[] = [];
  for (const descriptor of descriptors) {
    try {
      await mountWritebackValidator({ ...descriptor, consented: true });
      live.push(descriptor);
    } catch (error) {
      console.warn(
        `[Distribution] Approved validator "${descriptor.name}" could not be mounted:`,
        error,
      );
    }
  }
  return live;
}

/** Tear everything down (extension deactivate / workbook close). */
export function resetWritebackValidators(): void {
  unmountWritebackValidators();
  syncedRegions = new Set();
  lastResult = { mounted: [], pending: [], blocked: [] };
}
