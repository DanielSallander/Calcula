//! FILENAME: app/src/api/cellClickInterceptors.ts
// PURPOSE: API facade for cell click interceptors.
// CONTEXT: Re-exports the Core's cell click interceptor primitives for use by Extensions.
// Extensions must import from here, NOT from core/lib directly.

export {
  type CellClickEvent,
  type CellClickInterceptorFn,
  type CellClickAnswer,
  registerCellClickInterceptor,
  checkCellClickInterceptors,
  // RELEASE CLAIMS (BUG-0258 design phase 4): an interceptor that answers a
  // press with one of these acts when the press is RELEASED over the same
  // target, and sliding off cancels. Core holds the press; the family says
  // what the target is and what the release does. Core's session that runs a
  // claim is deliberately not re-exported: an extension answers a press, it
  // never releases one.
  type CellPressPoint,
  type CellReleaseClaim,
  type CellReleaseClaimSpec,
  actOnRelease,
  actOnCellRelease,
  isCellReleaseClaim,
  isCellPressed,
  // The AFTER-press announcement. Its `notifyGridCellPressed` is Core's alone
  // and is deliberately not re-exported: an extension listens, never presses.
  type GridCellPress,
  type GridCellPressListener,
  onGridCellPressed,
  type CellCursorInterceptorFn,
  registerCellCursorInterceptor,
  getCellCursorOverride,
} from "../core/lib/cellClickInterceptors";