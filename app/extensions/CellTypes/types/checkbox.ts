//! FILENAME: app/extensions/CellTypes/types/checkbox.ts
// PURPOSE: The "calcula.checkbox" cell type — a real TRUE/FALSE cell rendered
//          as a checkbox. Click and Space toggle (undoable via the normal
//          update path); formulas keep working (=IF(A1;...)) and formula cells
//          render as a read-only checkbox.

import type { CellTypeDefinition, CellTypeRenderContext } from "@api/cellTypes";

export const CHECKBOX_TYPE_ID = "calcula.checkbox";

function isBooleanish(display: string): boolean {
  const upper = display.toUpperCase();
  return upper === "" || upper === "TRUE" || upper === "FALSE";
}

/** Draw the checkbox glyph (geometry shared with the legacy style-flag checkbox). */
function renderCheckbox(context: CellTypeRenderContext): boolean {
  const { ctx, cellLeft, cellTop, cellRight, cellBottom, value, styleIndex, styleCache } = context;

  // Incompatible value (e.g. text): fall through to plain text rendering so
  // nothing is hidden; the assignment stays for when the value is boolean again.
  if (!isBooleanish(value)) {
    return false;
  }

  const cellWidth = cellRight - cellLeft;
  const cellHeight = cellBottom - cellTop;
  if (cellWidth < 8 || cellHeight < 8) {
    return true; // Too small to draw, but still "handled" (no TRUE/FALSE text)
  }

  const style = styleCache.get(styleIndex) ?? styleCache.get(0);
  const isChecked = value.toUpperCase() === "TRUE";
  const isGhost = value === "";

  const fontSize = style?.fontSize || 11;
  const checkSize = Math.min(
    Math.max(Math.round(fontSize * 1.2), 10),
    cellHeight - 4,
    cellWidth - 4,
    18
  );
  const halfSize = checkSize / 2;
  const centerX = (cellLeft + cellRight) / 2;
  const centerY = (cellTop + cellBottom) / 2;
  const boxLeft = Math.round(centerX - halfSize);
  const boxTop = Math.round(centerY - halfSize);

  let strokeColor = style?.textColor || "#000000";
  if (strokeColor === "#000000" || strokeColor === "rgb(0, 0, 0)") {
    strokeColor = "#404040";
  }

  const previousAlpha = ctx.globalAlpha;
  if (isGhost) {
    ctx.globalAlpha = 0.3;
  }

  const borderRadius = 2;
  ctx.beginPath();
  ctx.roundRect(boxLeft + 0.5, boxTop + 0.5, checkSize - 1, checkSize - 1, borderRadius);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = strokeColor;
  ctx.stroke();

  if (isChecked) {
    ctx.fillStyle = strokeColor;
    ctx.beginPath();
    ctx.roundRect(boxLeft + 0.5, boxTop + 0.5, checkSize - 1, checkSize - 1, borderRadius);
    ctx.fill();

    ctx.beginPath();
    const pad = checkSize * 0.2;
    ctx.moveTo(boxLeft + pad, boxTop + checkSize * 0.5);
    ctx.lineTo(boxLeft + checkSize * 0.4, boxTop + checkSize - pad);
    ctx.lineTo(boxLeft + checkSize - pad, boxTop + pad);
    ctx.lineWidth = Math.max(1.5, checkSize * 0.15);
    ctx.strokeStyle = "#ffffff";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
  }

  if (isGhost) {
    ctx.globalAlpha = previousAlpha;
  }
  return true;
}

/**
 * Toggle the checkbox value of a cell through the normal (undoable) write
 * path. Formula cells are read-only: the gesture is claimed but no write
 * happens. Returns whether the gesture was handled.
 */
async function toggleCheckbox(row: number, col: number): Promise<boolean> {
  const { getCell, updateCell } = await import("../../../src/api/lib");
  const { dispatchGridAction } = await import("../../../src/api/gridDispatch");
  const { setSelection } = await import("../../../src/api/grid");

  const cellData = await getCell(row, col);
  const display = cellData?.display ?? "";
  if (!isBooleanish(display)) {
    return false; // Incompatible value renders as text; let defaults apply.
  }

  // Select the cell so the gesture also moves the cursor (like the legacy
  // checkbox), even for read-only formula cells.
  dispatchGridAction(
    setSelection({ startRow: row, startCol: col, endRow: row, endCol: col, type: "cells" })
  );

  if (cellData?.formula) {
    return true; // Display-only: the formula owns the value.
  }

  const next = display.toUpperCase() === "TRUE" ? "FALSE" : "TRUE";
  await updateCell(row, col, next);
  window.dispatchEvent(new CustomEvent("grid:refresh"));
  return true;
}

export const checkboxCellType: CellTypeDefinition = {
  id: CHECKBOX_TYPE_ID,
  render: renderCheckbox,
  editor: "default",
  onClick: async ({ row, col }) => toggleCheckbox(row, col),
  onKeyDown: async ({ row, col, key }) => {
    if (key !== " ") return false;
    return toggleCheckbox(row, col);
  },
  coerce: (value) => {
    if (value === "" || value.startsWith("=")) return null;
    const lower = value.trim().toLowerCase();
    if (lower === "true" || lower === "yes" || lower === "1") return "TRUE";
    if (lower === "false" || lower === "no" || lower === "0") return "FALSE";
    return null;
  },
  validate: (value) => {
    if (value === "" || value.startsWith("=")) return null;
    const upper = value.trim().toUpperCase();
    return upper === "TRUE" || upper === "FALSE" ? null : "retry";
  },
  getCursor: () => "pointer",
  displayText: (value) => value,
};
