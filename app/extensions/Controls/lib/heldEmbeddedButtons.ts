//! FILENAME: app/extensions/Controls/lib/heldEmbeddedButtons.ts
// PURPOSE: Which IN-CELL (embedded) button controls hold an application's
//          code, known AHEAD of a right-click, so Core's cell menu can offer
//          "Make this my own…" on them (owner question 8, 2026-10-02).
// CONTEXT: A FLOATING button's own object menu asks the backend when it opens
//          and paints the entry when the read answers (refineControlObjectMenu).
//          An IN-CELL button control has no object menu: its right-click is
//          Core's CELL menu, whose `visible()` is synchronous and which is not
//          painted again when a read answers. So the answer is kept here, by
//          cell, and refreshed at the moments it can change:
//            - `loadFloatingControls` notes every in-cell button of the sheet
//              it loads, from the read it makes anyway (no extra read);
//            - a RIGHT press on a cell reads that cell again (a right press is
//              rare, and Core announces it before the menu opens on release);
//            - `controls:metadata-refresh` (an adoption, a property write)
//              reads the cell it names again.
//          Choosing the entry reads the button AGAIN (`makeHeldButtonCodeOwnAt`),
//          so a stale answer can only offer an entry that then says the button
//          no longer holds code -- never adopt code nobody was shown.
//          A button CELL (Cell Type: Button) is not a control and never enters
//          this map: it keeps "give it an action of your own" (owner decision Q4).

import { readHeldButtonCode } from "@api/heldButtonCode";
import { onGridCellPressed } from "@api/cellClickInterceptors";
import { getGridStateSnapshot } from "@api/grid";
import { getControlMetadata } from "./controlApi";
import type { ControlPropertyValue } from "./types";

/**
 * Is this control IN-CELL (part of its cell's formatting) rather than floating?
 *
 * The single definition of the rule, because three places ask it and a
 * disagreement between them is silent: `loadFloatingControls` uses it to decide
 * what enters the floating store, `deleteControlByInstanceId` uses it to tell
 * "in-cell, cannot delete through this path" apart from "floating, but on
 * another sheet", and this module uses it to decide which cells the cell menu
 * may offer "Make this my own…" on. If those ever answered differently, a
 * control would be refused with a reason that does not describe it.
 *
 * Only BUTTONS can be embedded, and only legacy ones are by default — shapes
 * and pictures are always floating.
 */
export function isEmbeddedControl(
  controlType: string,
  properties: Record<string, ControlPropertyValue>,
): boolean {
  return controlType === "button" ? properties.embedded?.value !== "false" : false;
}

/** "sheet:row:col" -> whether the in-cell button control there holds an application's code. */
const inCellButtons = new Map<string, boolean>();
const cellKey = (sheetIndex: number, row: number, col: number) => `${sheetIndex}:${row}:${col}`;

/**
 * Record the control at a cell, from metadata already read: an in-cell BUTTON
 * is noted with whether it holds an application's code; anything else is
 * forgotten.
 */
export function noteControlAt(
  sheetIndex: number,
  row: number,
  col: number,
  controlType: string,
  properties: Record<string, ControlPropertyValue>,
): void {
  const key = cellKey(sheetIndex, row, col);
  if (controlType === "button" && isEmbeddedControl(controlType, properties)) {
    inCellButtons.set(key, readHeldButtonCode(properties) !== null);
  } else {
    inCellButtons.delete(key);
  }
}

/** Forget every noted cell (a sheet or document reload notes them again). */
export function forgetInCellButtons(): void {
  inCellButtons.clear();
}

/**
 * Whether the cell menu may offer "Make this my own…" at this cell: an in-cell
 * button CONTROL there was last seen holding an application's code.
 */
export function inCellButtonHoldsCode(sheetIndex: number, row: number, col: number): boolean {
  return inCellButtons.get(cellKey(sheetIndex, row, col)) === true;
}

/**
 * Read the control at a cell again and note what it is now. A read that fails
 * offers nothing at that cell (said on the console); the Properties pane still
 * shows the code and its own step.
 */
export async function rereadControlAt(sheetIndex: number, row: number, col: number): Promise<void> {
  try {
    const metadata = await getControlMetadata(sheetIndex, row, col);
    if (metadata) noteControlAt(sheetIndex, row, col, metadata.controlType, metadata.properties);
    else inCellButtons.delete(cellKey(sheetIndex, row, col));
  } catch (err) {
    inCellButtons.delete(cellKey(sheetIndex, row, col));
    console.warn("[Controls] The control's code could not be read; its cell menu offers no \"Make this my own\":", err);
  }
}

/**
 * Keep the map current between loads: a RIGHT press on a cell and a
 * `controls:metadata-refresh` each read their cell again. Returns the cleanup.
 */
export function installInCellButtonUpkeep(): () => void {
  const activeSheet = (): number | undefined => {
    const index = getGridStateSnapshot()?.sheetContext?.activeSheetIndex;
    return typeof index === "number" ? index : undefined;
  };
  const offPress = onGridCellPressed((press) => {
    if (press.button !== 2 || press.target !== "cell" || press.row < 0 || press.col < 0) return;
    const sheetIndex = activeSheet();
    if (sheetIndex === undefined) return;
    void rereadControlAt(sheetIndex, press.row, press.col);
  });
  // Most dispatchers name only the cell (the active sheet's); the menu's own
  // adoption names the sheet too.
  const onMetadataRefresh = (event: Event) => {
    const detail = (event as CustomEvent<{ sheetIndex?: unknown; row?: unknown; col?: unknown }>).detail;
    if (!detail) return;
    const { row, col } = detail;
    const sheetIndex = typeof detail.sheetIndex === "number" ? detail.sheetIndex : activeSheet();
    if (sheetIndex === undefined || typeof row !== "number" || typeof col !== "number") return;
    void rereadControlAt(sheetIndex, row, col);
  };
  window.addEventListener("controls:metadata-refresh", onMetadataRefresh);
  return () => {
    offPress();
    window.removeEventListener("controls:metadata-refresh", onMetadataRefresh);
  };
}
