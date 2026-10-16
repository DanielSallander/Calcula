//! FILENAME: app/extensions/Charts/lib/selectSourcePivot.ts
// PURPOSE: "Select PivotTable" on a pivot-sourced chart's Data tab (WP-C S9c):
//          take the reader to the PivotTable the chart reads, and show its
//          fields.
// CONTEXT: Two routes, decided by where the PivotTable is:
//            - a BOX on a canvas page (shown on screen now, or on the page the
//              route switches to): select the box through @api/objectSelection
//              and open the ONE object pane on its Fields tab -- a DOOR
//              (reason "command"), so it opens even when the reader closed the
//              pane by hand;
//            - a worksheet PivotTable: switch to its sheet through the one
//              sheet-switch door (`activateSheet`) and select its anchor cell,
//              where the Pivot extension's worksheet route (the `pivot-editor`
//              pane) takes over, exactly as a click on the cell does.
//          The Charts extension never imports the Pivot extension (Seam Rule):
//          the box is found as the floating region whose data names the
//          PivotTable and that some family selects, and the PivotTable's sheet
//          and anchor come from the @api/pivot facade.
//
//          Every dependency is injectable so the routes are testable without a
//          grid; the defaults are the real seams.

import {
  activateSheet,
  dispatchGridAction,
  scrollToCell,
  setSelection,
} from "@api";
import { getGridStateSnapshot } from "@api/grid";
import { getGridRegions, onRegionChange, type GridRegion } from "@api/gridOverlays";
import { canSelectObject, selectObject } from "@api/objectSelection";
import { openObjectPane } from "@api/objectPane";
import { pivot } from "@api/pivot";

/** The tab the object pane opens on for a PivotTable box. */
export const PIVOT_FIELDS_TAB = "fields";

/** How long a canvas page has to publish the box after the switch. */
const BOX_PUBLISH_TIMEOUT_MS = 2000;

export interface SelectSourcePivotDeps {
  regions(): GridRegion[];
  onRegionsChanged(cb: () => void): () => void;
  canSelect(region: GridRegion): boolean;
  select(region: GridRegion): boolean;
  openFields(region: GridRegion): boolean;
  activeSheetIndex(): number | null;
  /** The sheet the PivotTable's output is on (the pivot listing), or null. */
  pivotSheetIndex(pivotId: string): Promise<number | null>;
  /** The ACTIVE sheet's PivotTables: their anchors and whether each is a canvas box. */
  activeSheetPivots(): Promise<Array<{ pivotId: string; startRow: number; startCol: number; isBox: boolean }>>;
  activateSheet(index: number): Promise<void>;
  selectCell(row: number, col: number): void;
  timeoutMs?: number;
}

const realDeps: SelectSourcePivotDeps = {
  regions: () => getGridRegions(),
  onRegionsChanged: (cb) => onRegionChange(() => cb()),
  canSelect: (region) => canSelectObject(region),
  select: (region) => selectObject(region),
  openFields: (region) => openObjectPane({ region, tab: PIVOT_FIELDS_TAB, reason: "command" }),
  activeSheetIndex: () => getGridStateSnapshot()?.sheetContext.activeSheetIndex ?? null,
  pivotSheetIndex: async (pivotId) => {
    const all = await pivot.getAll();
    // Ids are compared as text: the backend's pivot id is a number on the wire.
    const hit = all.find((p) => String(p.id ?? p.pivotId) === pivotId);
    return typeof hit?.sheetIndex === "number" ? hit.sheetIndex : null;
  },
  activeSheetPivots: async () => {
    const regions = await pivot.getRegionsForSheet();
    return regions.map((r) => ({
      pivotId: String(r.pivotId),
      startRow: r.startRow,
      startCol: r.startCol,
      isBox: !!r.canvasFrame,
    }));
  },
  activateSheet: async (index) => {
    await activateSheet(index);
  },
  selectCell: (row, col) => {
    dispatchGridAction(setSelection(row, col, row, col));
    dispatchGridAction(scrollToCell(row, col, true));
  },
};

/** The floating box that shows `pivotId`, when one is on screen. */
export function findPivotBox(pivotId: string, deps: Pick<SelectSourcePivotDeps, "regions" | "canSelect"> = realDeps): GridRegion | null {
  return (
    deps.regions().find((r) => {
      if (!r.floating) return false;
      const id = (r.data as { pivotId?: unknown } | undefined)?.pivotId;
      return id !== undefined && String(id) === pivotId && deps.canSelect(r);
    }) ?? null
  );
}

/** Select the box and open its Fields; the sentence when the pane could not open. */
function selectBox(region: GridRegion, deps: SelectSourcePivotDeps): string | null {
  if (!deps.select(region)) return "The PivotTable box could not be selected.";
  if (!deps.openFields(region)) return "The PivotTable is selected, but its fields could not be shown.";
  return null;
}

/** Wait (bounded) for the box to be published after a sheet switch. */
function waitForBox(pivotId: string, deps: SelectSourcePivotDeps): Promise<GridRegion | null> {
  const now = findPivotBox(pivotId, deps);
  if (now) return Promise.resolve(now);
  return new Promise((resolve) => {
    let done = false;
    let off: () => void = () => {};
    const finish = (region: GridRegion | null): void => {
      if (done) return;
      done = true;
      off();
      clearTimeout(timer);
      resolve(region);
    };
    const timer = setTimeout(() => finish(findPivotBox(pivotId, deps)), deps.timeoutMs ?? BOX_PUBLISH_TIMEOUT_MS);
    off = deps.onRegionsChanged(() => {
      const region = findPivotBox(pivotId, deps);
      if (region) finish(region);
    });
  });
}

/**
 * Take the reader to the PivotTable `pivotId` (see the module header). Resolves
 * to null on success, or to the sentence that says why it could not.
 */
export async function selectSourcePivot(pivotId: string, deps: SelectSourcePivotDeps = realDeps): Promise<string | null> {
  try {
    // A box on the page shown now: select it, show its fields.
    const onScreen = findPivotBox(pivotId, deps);
    if (onScreen) return selectBox(onScreen, deps);

    const sheetIndex = await deps.pivotSheetIndex(pivotId);
    if (sheetIndex === null) return "The PivotTable this chart reads could not be found.";
    if (deps.activeSheetIndex() !== sheetIndex) await deps.activateSheet(sheetIndex);

    const here = (await deps.activeSheetPivots()).find((p) => p.pivotId === pivotId);
    if (!here) return "The PivotTable this chart reads could not be found on its sheet.";
    if (here.isBox) {
      const box = await waitForBox(pivotId, deps);
      if (!box) return "The PivotTable box did not appear on its page.";
      return selectBox(box, deps);
    }
    // A worksheet PivotTable: its anchor cell, where the pivot-editor route takes over.
    deps.selectCell(here.startRow, here.startCol);
    return null;
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return `The PivotTable could not be selected: ${why}`;
  }
}
