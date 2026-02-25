//! FILENAME: app/src/api/cellDoubleClickInterceptors.ts
// PURPOSE: API facade for cell double-click interceptors.
// CONTEXT: Re-exports the Core's cell double-click interceptor primitives for use by Extensions.
// Extensions must import from here, NOT from core/lib directly.

export {
  type CellDoubleClickEvent,
  type CellDoubleClickInterceptorFn,
  registerCellDoubleClickInterceptor,
  checkCellDoubleClickInterceptors,
} from "../core/lib/cellDoubleClickInterceptors";
