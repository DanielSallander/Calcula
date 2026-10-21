//! FILENAME: app/extensions/CellTypes/types/progress.ts
// PURPOSE: The "calcula.progress" cell type — renders a numeric cell as a
//          progress bar. The underlying value stays a normal number (formulas
//          keep working); editing is the normal inline editor.
// PARAMS:  max (number, default 1: value 0.42 -> 42%; use 100 for 0-100 data),
//          color (CSS color, default Calcula green), showLabel (boolean).

import type { CellTypeDefinition, CellTypeRenderContext } from "@api/cellTypes";
import { parseNumber } from "@api/locale";

export const PROGRESS_TYPE_ID = "calcula.progress";

const DEFAULT_COLOR = "#217346";
const TRACK_COLOR = "rgba(128, 128, 128, 0.18)";

/**
 * The number a progress bar shows for a cell. The render context carries only
 * the cell's DISPLAY text, which the engine wrote in the app locale, so it is
 * read back STRICTLY in that locale through `parseNumber` (its grouping, its
 * decimal separator, a percent sign, its currency symbol): de-DE "1.234,5"
 * is 1234.5, sv-SE "42 %" is 0.42. A foreign spelling is not a number. An
 * empty cell is 0. Null = not a number (the cell is shown as plain text).
 */
export function progressValueOf(display: string): number | null {
  if (display.trim() === "") return 0;
  return parseNumber(display);
}

function renderProgress(context: CellTypeRenderContext): boolean {
  const { ctx, cellLeft, cellTop, cellRight, cellBottom, value, params } = context;

  const parsed = progressValueOf(value);
  if (parsed === null) {
    return false; // Non-numeric value: show it as plain text.
  }

  const max = typeof params.max === "number" && params.max > 0 ? params.max : 1;
  const fraction = Math.min(Math.max(parsed / max, 0), 1);

  const padding = 3;
  const barLeft = cellLeft + padding;
  const barRight = cellRight - padding;
  const barWidth = barRight - barLeft;
  const barHeight = Math.min(Math.max((cellBottom - cellTop) * 0.5, 6), 14);
  const barTop = (cellTop + cellBottom) / 2 - barHeight / 2;
  if (barWidth < 4) {
    return true;
  }

  const radius = Math.min(3, barHeight / 2);

  // Track
  ctx.beginPath();
  ctx.roundRect(barLeft, barTop, barWidth, barHeight, radius);
  ctx.fillStyle = TRACK_COLOR;
  ctx.fill();

  // Fill
  if (fraction > 0) {
    const fillWidth = Math.max(barWidth * fraction, radius * 2);
    ctx.beginPath();
    ctx.roundRect(barLeft, barTop, fillWidth, barHeight, radius);
    ctx.fillStyle = typeof params.color === "string" && params.color ? params.color : DEFAULT_COLOR;
    ctx.fill();
  }

  // Optional percentage label, centered over the bar
  if (params.showLabel === true) {
    const label = `${Math.round(fraction * 100)}%`;
    ctx.font = `600 ${Math.min(barHeight - 1, 10)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = fraction > 0.55 ? "#ffffff" : "#404040";
    ctx.fillText(label, (barLeft + barRight) / 2, barTop + barHeight / 2 + 0.5);
  }

  return true;
}

export const progressCellType: CellTypeDefinition = {
  id: PROGRESS_TYPE_ID,
  render: renderProgress,
  editor: "default",
  displayText: (value) => value,
};
