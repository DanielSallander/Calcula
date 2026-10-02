//! FILENAME: app/src/api/layoutSurface.ts
// PURPOSE: Public facade for the LAYOUT SURFACE seam (snap grid, page bounds,
//          editability of floating objects on a sheet -- and
//          `objectGeometryEditable`, the one per-object answer families
//          publish `movable`/`resizable` from).
// CONTEXT: Core consults the registered provider from its floating-object move
//          and resize handlers and from the scrollbar extent; an extension (the
//          canvas sheet extension) registers the provider. Re-exported from Core
//          the way `pointerClaims` is, so there is ONE registry and Core never
//          imports an extension. See app/src/core/lib/layoutSurface.ts.

export {
  registerLayoutSurfaceProvider,
  getLayoutSurface,
  notifyLayoutSurfaceChanged,
  onLayoutSurfaceChanged,
  snapValue,
  snapRectEdges,
  clampMoveToPage,
  clampResizeToPage,
  applySurfaceToMove,
  applySurfaceToResize,
  LAYOUT_PAGE_MARGIN,
  GRID_SCROLLBAR_GUTTER_PX,
  pageScrollExtent,
  isRegionLocked,
  objectGeometryEditable,
} from "../core/lib/layoutSurface";

export type {
  LayoutSurface,
  LayoutSurfaceProvider,
  LayoutRect,
  DraggedEdges,
} from "../core/lib/layoutSurface";
