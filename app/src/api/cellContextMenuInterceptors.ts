//! FILENAME: app/src/api/cellContextMenuInterceptors.ts
// PURPOSE: API facade for cell context-menu (right-click) interceptors.
// CONTEXT: Re-exports the Core's cell context-menu interceptor primitives for
// use by Extensions (and the script host's sheet.onBeforeRightClick hook).
// Extensions must import from here, NOT from core/lib directly.

export {
  type CellContextMenuEvent,
  type CellContextMenuInterceptorFn,
  registerCellContextMenuInterceptor,
  checkCellContextMenuInterceptors,
  cellContextMenuInterceptorCount,
} from "../core/lib/cellContextMenuInterceptors";
