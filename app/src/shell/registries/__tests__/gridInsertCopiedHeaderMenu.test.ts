//! FILENAME: app/src/shell/registries/__tests__/gridInsertCopiedHeaderMenu.test.ts
// PURPOSE: On a row or column header, Core's Insert Row / Insert Column items
//          stand down while a copy is pending: Excel's header menu then reads
//          "Insert Copied Cells" instead (the InsertDeleteCells extension's
//          item), never a blank-line Insert beside it.
// CONTEXT: Bug-ledger fix programme round 14 (lane clip6), reviewer rev12A's
//          minor finding. Live Excel 16 [2026-10-30, clip6/probe-menu.ps1:
//          Shift+F10 on a fresh visible instance, the open menu read through UI
//          Automation]: nothing copied, row 2 selected -> "Insert"; row 6 or F6
//          copied, row 2 selected -> "Insert Copied Cells"; column F copied,
//          column B selected -> "Insert Copied Cells".

import { describe, it, expect, vi, beforeEach } from "vitest";

const clip = vi.hoisted(() => ({ pending: null as unknown }));

vi.mock("../../../core/hooks/useClipboard", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  pendingCopyOfSheetCells: () => clip.pending,
}));

import { gridExtensions, registerCoreGridContextMenu, type GridMenuContext } from "../gridExtensions";
import { createEmptyDimensionOverrides } from "../../../core/types";
import type { Selection } from "../../../core/types";

function context(selection: Selection): GridMenuContext {
  return {
    selection,
    clickedCell: { row: selection.startRow, col: selection.startCol },
    isWithinSelection: true,
    sheetIndex: 0,
    sheetName: "Sheet1",
    dimensions: createEmptyDimensionOverrides(),
  };
}

function isVisible(id: string, ctx: GridMenuContext): boolean {
  const found = gridExtensions.getContextMenuItems().find((i) => i.id === id);
  if (!found) throw new Error(`menu item ${id} not registered`);
  const { visible } = found;
  if (visible === undefined) return true;
  return typeof visible === "function" ? visible(ctx) : visible;
}

const row2: Selection = { startRow: 1, endRow: 1, startCol: 0, endCol: 16_383, type: "rows" };
const colB: Selection = { startRow: 0, endRow: 1_048_575, startCol: 1, endCol: 1, type: "columns" };

beforeEach(() => {
  clip.pending = null;
  gridExtensions.clear();
  registerCoreGridContextMenu();
});

/** The ids the menu SHOWS for this context, as the menu itself resolves them. */
function shown(ctx: GridMenuContext): string[] {
  return gridExtensions.getContextMenuItemsForContext(ctx).map((i) => i.id);
}

/** A stand-in for the InsertDeleteCells extension's item: visible over lines while a copy is pending. */
function registerInsertCopiedStandIn(): void {
  gridExtensions.registerContextMenuItem({
    id: "insertDeleteCells:contextInsert",
    label: "Insert Copied Cells",
    group: "insert",
    order: 5,
    visible: (ctx) => (ctx.selection?.type === "rows" || ctx.selection?.type === "columns") && clip.pending !== null,
    replaces: ["core:insertRow", "core:insertColumn"],
    onClick: () => undefined,
  });
}

describe("[LIVE] the header menu's Insert with a copy pending is Insert Copied Cells, not Core's Insert Row / Column", () => {
  it("no copy pending: Insert Row on a row header, Insert Column on a column header", () => {
    registerInsertCopiedStandIn();
    expect(isVisible("core:insertRow", context(row2))).toBe(true);
    expect(shown(context(row2))).toContain("core:insertRow");
    expect(shown(context(colB))).toContain("core:insertColumn");
    expect(shown(context(row2))).not.toContain("insertDeleteCells:contextInsert");
  });

  it("a copy pending: both stand down for the item that replaces them (the extension's Insert Copied Cells)", () => {
    registerInsertCopiedStandIn();
    clip.pending = { isCut: false, sourceSelection: { startRow: 5, endRow: 5, startCol: 0, endCol: 16_383, type: "rows" } };
    expect(shown(context(row2)), "a blank-row Insert Row is offered beside Insert Copied Cells").not.toContain("core:insertRow");
    expect(shown(context(colB)), "a blank-column Insert Column is offered beside Insert Copied Cells").not.toContain("core:insertColumn");
    expect(shown(context(row2))).toContain("insertDeleteCells:contextInsert");
  });

  // Round 16 (rev14A nit): the shell hid its own item on the clipboard state,
  // ASSUMING the extension would show Insert Copied Cells -- so without that
  // extension a header right-click with a copy pending offered no Insert at all.
  it("a copy pending and NO replacing item (the extension is not active): the header Insert is still offered", () => {
    clip.pending = { isCut: false, sourceSelection: { startRow: 5, endRow: 5, startCol: 0, endCol: 16_383, type: "rows" } };
    expect(shown(context(row2)), "a header right-click offered no Insert at all").toContain("core:insertRow");
    expect(shown(context(colB)), "a header right-click offered no Insert at all").toContain("core:insertColumn");
  });
});
