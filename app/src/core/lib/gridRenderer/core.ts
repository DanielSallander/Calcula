// FILENAME: app/src/lib/gridRenderer/core.ts
// PURPOSE: Main rendering orchestration function
// CONTEXT: Coordinates all rendering phases for the grid
// Updated: Added insertionAnimation parameter for smooth row/column insertion

import type {
  GridConfig,
  Viewport,
  Selection,
  EditingCell,
  CellDataMap,
  FormulaReference,
  DimensionOverrides,
  StyleDataMap,
  ClipboardMode,
  InsertionAnimation,
} from "../../../core/types";
import type { GridTheme, RenderState } from "./types";
import { DEFAULT_THEME } from "./types";
import { drawCorner, drawColumnHeaders, drawRowHeaders } from "./rendering/headers";
import { drawGridLines } from "./rendering/grid";
import { drawCellText } from "./rendering/cells";
import { drawSelection, drawFillPreview, drawClipboardSelection } from "./rendering/selection";
import { drawFormulaReferences } from "./rendering/references";

/**
 * Main render function for the grid.
 * Orchestrates all rendering phases in the correct order.
 *
 * @param ctx - Canvas 2D rendering context
 * @param width - Canvas width in CSS pixels
 * @param height - Canvas height in CSS pixels
 * @param config - Grid configuration
 * @param viewport - Current viewport position
 * @param selection - Current selection (or null)
 * @param editing - Cell being edited (or null)
 * @param cells - Map of cell data for visible cells
 * @param theme - Theme configuration (defaults to DEFAULT_THEME)
 * @param formulaReferences - Array of formula references to highlight
 * @param dimensions - Custom column/row dimensions
 * @param styleCache - Style cache for cell formatting (Phase 6)
 * @param fillPreviewRange - Fill preview range during fill handle drag
 * @param clipboardSelection - Selection that was copied/cut (for dotted border)
 * @param clipboardMode - Current clipboard mode (none, copy, cut)
 * @param clipboardAnimationOffset - Animation offset for marching ants (0-8 range)
 * @param insertionAnimation - Active insertion animation for smooth row/column insertion
 */
export function renderGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  config: GridConfig,
  viewport: Viewport,
  selection: Selection | null,
  editing: EditingCell | null,
  cells: CellDataMap,
  theme: GridTheme = DEFAULT_THEME,
  formulaReferences: FormulaReference[] = [],
  dimensions?: DimensionOverrides,
  styleCache?: StyleDataMap,
  fillPreviewRange?: Selection | null,
  clipboardSelection?: Selection | null,
  clipboardMode?: ClipboardMode,
  clipboardAnimationOffset?: number,
  insertionAnimation?: InsertionAnimation | null
): void {
  // Create render state object with all parameters
  const state: RenderState = {
    ctx,
    width,
    height,
    config,
    viewport,
    selection,
    editing,
    theme,
    cells,
    formulaReferences,
    dimensions: dimensions || {
      columnWidths: new Map(),
      rowHeights: new Map(),
    },
    styleCache: styleCache || new Map(),
    fillPreviewRange: fillPreviewRange || null,
    clipboardSelection: clipboardSelection || null,
    clipboardMode: clipboardMode || "none",
    clipboardAnimationOffset: clipboardAnimationOffset || 0,
    insertionAnimation: insertionAnimation || undefined,
  };

  // Clear canvas
  ctx.fillStyle = theme.cellBackground;
  ctx.fillRect(0, 0, width, height);

  // Render layers in order (back to front):
  // 1. Grid lines (background)
  drawGridLines(state);

  // 2. Cells (content)
  drawCellText(state);

  // 3. Formula references (before selection so selection appears on top)
  if (formulaReferences.length > 0) {
    drawFormulaReferences(state);
  }

  // 4. Fill preview (if dragging fill handle)
  if (fillPreviewRange) {
    drawFillPreview(state);
  }

  // 5. Selection (highlight layer)
  if (selection) {
    drawSelection(state);
  }

  // 6. Clipboard selection (marching ants for copy/cut)
  if (clipboardSelection && clipboardMode && clipboardMode !== "none") {
    drawClipboardSelection(state);
  }

  // 7. Headers (overlay, drawn last so they appear on top)
  drawColumnHeaders(state);
  drawRowHeaders(state);

  // 8. Corner cell (top-left intersection)
  drawCorner(state);
}