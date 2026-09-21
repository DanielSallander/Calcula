//! FILENAME: app/src/api/overlayTextEditor.ts
// PURPOSE: API facade for the in-place text editor over the grid canvas.
// CONTEXT: Re-exports the Core primitive so an extension that lets the user
//          type directly on the canvas — a chart title, an object caption — can
//          do it without owning any of the DOM machinery: the canvas-layer
//          mount, the MANDATORY pointer claim, the per-frame reposition, the
//          header clipping and the three blur traps all live behind this one
//          call. Extensions must import from here (or from `@api`), NOT from
//          core/lib directly. See core/lib/overlayTextEditor.ts for the traps
//          and why each responsibility sits on this side of the seam.

export {
  GRID_CANVAS_LAYER_SELECTOR,
  OVERLAY_TEXT_EDITOR_ATTR,
  BLUR_COMMIT_DELAY_MS,
  SUPPRESS_BLUR_MS,
  DEFAULT_FONT_LOGICAL_PX,
  DEFAULT_FONT_FAMILY,
  type OverlayTextEditorRect,
  type OverlayTextEditorFont,
  type OverlayTextAlign,
  type OverlayTextEditorOptions,
  type OverlayTextEditorHandle,
  openOverlayTextEditor,
  getActiveOverlayTextEditor,
  isOverlayTextEditorOpen,
  isOverlayTextEditorElement,
  getGridCanvasLayer,
} from "../core/lib/overlayTextEditor";
