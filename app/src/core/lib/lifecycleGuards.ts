//! FILENAME: app/src/core/lib/lifecycleGuards.ts
// PURPOSE: Generic workbook-lifecycle guard registry (the cancellable Before*
//          verdict). Save and Close ASK before they act, so a script or an
//          extension can enforce completeness before a save, autoversion on
//          save, or clean up on close — VBA's Workbook_BeforeSave(Cancel:=True).
// CONTEXT: This is a Core primitive, deliberately shaped like commitGuards.ts:
//          Core owns the choke point, everyone else registers into it. The API
//          layer re-exports it (api/lifecycleGuards.ts) and the script host
//          registers ONE guard per mounted script that declared onBeforeSave /
//          onBeforeClose.

// ============================================================================
// Types
// ============================================================================

/** The workbook operation a guard may cancel. */
export type LifecycleAction = "save" | "close";

/** Detail handed to guards. `path` is present for saves. */
export interface LifecycleDetail {
  /** Target path of the save (absent for close). */
  path?: string;
}

/** A guard's objection. Returning `null` from a guard means "no objection". */
export interface LifecycleGuardResult {
  /** Who objected — a script or extension NAME, shown to the user verbatim.
   *  A cancelled save must always be attributable; "nothing happened" is the
   *  failure mode this whole registry exists to avoid. */
  by: string;
  /** Optional explanation supplied by the guard ("Fill in the total first"). */
  reason?: string;
}

/**
 * An async veto function. Return a {@link LifecycleGuardResult} to CANCEL the
 * operation, or `null` to allow it.
 *
 * A guard may show UI and await the user. It MUST, however, bound its own wait:
 * {@link checkLifecycleGuards} does not impose a deadline, because the only
 * caller that needs one (the script host, whose guards run untrusted code)
 * already applies a per-script deadline with a default-ALLOW fallback.
 */
export type LifecycleGuardFn = (
  action: LifecycleAction,
  detail: LifecycleDetail,
) => Promise<LifecycleGuardResult | null>;

/**
 * How a cancellation is TOLD to the user. Core cannot render a toast (layering
 * is shell -> api -> core), so it inverts the dependency exactly like
 * registerPasswordPrompt in file-api.ts: the Shell registers the reporter at
 * startup and every emitter gets attributable feedback for free.
 */
export type LifecycleCancelReporter = (
  action: LifecycleAction,
  result: LifecycleGuardResult,
) => void;

// ============================================================================
// Internal state
// ============================================================================

const guards = new Set<LifecycleGuardFn>();
let cancelReporter: LifecycleCancelReporter | null = null;

// ============================================================================
// Registry API
// ============================================================================

/**
 * Register a guard that can cancel a workbook save or close.
 * @returns A cleanup function that unregisters the guard.
 */
export function registerLifecycleGuard(guard: LifecycleGuardFn): () => void {
  guards.add(guard);
  return () => {
    guards.delete(guard);
  };
}

/** Registered by the Shell at startup. Pass `null` to unregister. */
export function registerLifecycleCancelReporter(
  reporter: LifecycleCancelReporter | null,
): void {
  cancelReporter = reporter;
}

/** How many guards are currently registered (lets emitters skip the await). */
export function lifecycleGuardCount(): number {
  return guards.size;
}

/**
 * Ask every guard whether `action` may proceed. Returns the FIRST objection
 * (and reports it through the registered reporter, so no caller can turn a
 * cancellation into a silent no-op), or `null` when every guard allows it.
 *
 * A guard that THROWS is treated as no objection: the operation the user asked
 * for wins over a broken guard.
 */
export async function checkLifecycleGuards(
  action: LifecycleAction,
  detail: LifecycleDetail = {},
): Promise<LifecycleGuardResult | null> {
  for (const guard of guards) {
    let result: LifecycleGuardResult | null = null;
    try {
      result = await guard(action, detail);
    } catch (error) {
      console.error("[lifecycleGuards] guard threw; allowing the operation:", error);
      continue;
    }
    if (result) {
      reportLifecycleCancellation(action, result);
      return result;
    }
  }
  return null;
}

/** Tell the user an operation was cancelled, and by whom. */
export function reportLifecycleCancellation(
  action: LifecycleAction,
  result: LifecycleGuardResult,
): void {
  const message = lifecycleCancelMessage(action, result);
  if (cancelReporter) {
    cancelReporter(action, result);
  } else {
    console.warn(`[lifecycleGuards] ${message}`);
  }
}

/** The user-facing sentence for a cancellation (shared by every reporter). */
export function lifecycleCancelMessage(
  action: LifecycleAction,
  result: LifecycleGuardResult,
): string {
  const verb = action === "save" ? "save" : "close";
  const base = `Script "${result.by}" cancelled the ${verb}`;
  return result.reason ? `${base}: ${result.reason}` : `${base}.`;
}

/** Drop every guard and the reporter (tests / full app teardown). */
export function resetLifecycleGuards(): void {
  guards.clear();
  cancelReporter = null;
}
