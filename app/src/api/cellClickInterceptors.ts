//! FILENAME: app/src/api/cellClickInterceptors.ts
// PURPOSE: API facade for cell click interceptors.
// CONTEXT: Re-exports the Core's cell click interceptor primitives for use by Extensions.
// Extensions must import from here, NOT from core/lib directly.

export {
  type CellClickEvent,
  type CellClickInterceptorFn,
  registerCellClickInterceptor,
  checkCellClickInterceptors,
  // The AFTER-press announcement. Its `notifyGridCellPressed` is Core's alone
  // and is deliberately not re-exported: an extension listens, never presses.
  type GridCellPress,
  type GridCellPressListener,
  onGridCellPressed,
  type CellCursorInterceptorFn,
  registerCellCursorInterceptor,
  getCellCursorOverride,
} from "../core/lib/cellClickInterceptors";