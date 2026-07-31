//! FILENAME: app/src/api/lifecycleGuards.ts
// PURPOSE: Public workbook-lifecycle guard API for extensions — the cancellable
//          Before* verdict for save and close.
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
