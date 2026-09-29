//! FILENAME: app/src/api/lifecycleGuards.ts
// PURPOSE: Public workbook-lifecycle API for extensions — the cancellable
//          Before* verdict for save and close, and the AWAITED close
//          preparation (work a closing workbook must finish before it is
//          written or the window goes).
// CONTEXT: Extensions import lifecycle guards from here instead of
//          core/lib/lifecycleGuards (facade rule). Mirrors commitGuards.ts.

export {
  registerLifecycleGuard,
  registerLifecycleCancelReporter,
  checkLifecycleGuards,
  reportLifecycleCancellation,
  lifecycleCancelMessage,
  lifecycleGuardCount,
  resetLifecycleGuards,
} from "../core/lib/lifecycleGuards";

export type {
  LifecycleAction,
  LifecycleDetail,
  LifecycleGuardResult,
  LifecycleGuardFn,
  LifecycleCancelReporter,
} from "../core/lib/lifecycleGuards";

// ============================================================================
// Close preparation (E8, BUG-0200 close parts)
// ============================================================================
//
// BEFORE_CLOSE is an EVENT: its subscribers are called and not awaited. Three
// of them start ASYNC work that belongs in the file the close-prompt's Save is
// about to write -- the Macro Recorder stores the recording it was taking, the
// Animation driver restores the transient frame it left in the cells, and the
// script host re-protects every sheet a script lifted protection from -- and
// the save went ahead the moment the event returned. The human wait on the old
// prompt hid the race; a close-then-Save could write the file without the
// recording, with an animation frame in the cells, or with a sheet left open.
//
// A close preparation is that work, AWAITED: the shell broadcasts BEFORE_CLOSE
// (the synchronous teardown) and then awaits every registered preparation
// before it writes the file or destroys the window. Each is bounded -- a
// preparation that hangs or throws must not trap the user in the app (the
// lifecycle guards' own rule) -- and reported on the console when it does.

/** Work a closing workbook must FINISH before it is written or the window goes. */
export type ClosePreparationFn = () => Promise<void> | void;

interface ClosePreparation {
  label: string;
  prepare: ClosePreparationFn;
}

const closePreparations = new Set<ClosePreparation>();

/** How long ONE preparation may take before the close goes on without it. */
export const CLOSE_PREPARATION_TIMEOUT_MS = 10_000;

/**
 * Register work the close must await. `label` names it in the console when it
 * throws or overruns. Returns the cleanup (it removes THIS registration only).
 */
export function registerClosePreparation(label: string, prepare: ClosePreparationFn): () => void {
  const entry: ClosePreparation = { label, prepare };
  closePreparations.add(entry);
  return () => {
    closePreparations.delete(entry);
  };
}

/**
 * Run every registered preparation, concurrently, and resolve when each has
 * finished, thrown or overrun `timeoutMs`. Never rejects: a close must not be
 * refused by the teardown of the workbook it closes. Called by the shell AFTER
 * it broadcast BEFORE_CLOSE (whose synchronous listeners may start the very
 * work a preparation awaits).
 */
export async function runClosePreparations(timeoutMs: number = CLOSE_PREPARATION_TIMEOUT_MS): Promise<void> {
  const entries = Array.from(closePreparations);
  await Promise.all(
    entries.map(async (entry) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const overrun = new Promise<"overrun">((resolve) => {
        timer = setTimeout(() => resolve("overrun"), timeoutMs);
      });
      try {
        const outcome = await Promise.race([
          Promise.resolve()
            .then(() => entry.prepare())
            .then(() => "done" as const),
          overrun,
        ]);
        if (outcome === "overrun") {
          console.warn(
            `[lifecycle] close preparation "${entry.label}" did not finish within ${timeoutMs} ms; closing without it.`,
          );
        }
      } catch (err) {
        console.error(`[lifecycle] close preparation "${entry.label}" failed; closing anyway:`, err);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }),
  );
}

/** How many preparations are registered (tests and diagnostics). */
export function closePreparationCount(): number {
  return closePreparations.size;
}

/** Test seam: forget every registration. */
export function resetClosePreparations(): void {
  closePreparations.clear();
}
