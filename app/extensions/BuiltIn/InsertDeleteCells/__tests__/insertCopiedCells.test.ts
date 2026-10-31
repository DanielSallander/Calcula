//! FILENAME: app/extensions/BuiltIn/InsertDeleteCells/__tests__/insertCopiedCells.test.ts
// PURPOSE: With a COPY pending, Insert is Excel's "Insert Copied Cells": the
//          commands decide what Excel decides -- the room the copy needs, the
//          two-choice dialog, the copied lines without a dialog, the
//          "This selection isn't valid" refusal -- and the menus say so.
// CONTEXT: Bug-ledger fix programme round 12 (lane clip4), round 11 clip3's
//          NEW item. Live Excel 16 [2026-10-30, clip4/probe-insert.ps1 and
//          probe-insert2.ps1, fresh visible instances]: with F6 copied,
//          GetLabelMso("CellsInsertDialog") reads "Insert Copied Cells..."
//          ("Insert Copied Cells" over whole rows); Ctrl+Plus opens "Insert"
//          and Enter shifts right, {DOWN} Enter shifts down; A1:B1 copied into
//          F2 makes room F2:G2; F6:F7 copied into F2:F4 makes room F2:F3; row 6
//          copied into row 2 inserts the copied row with no dialog; F6 copied
//          into row 2 is refused ("Microsoft Excel" error, nothing changes).
//          Drives the real activation and command registry; the clipboard
//          primitive (@api/lib insertCopiedCells), the dialogs and the grid
//          snapshot are doubles.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  selection: null as Record<string, unknown> | null,
  clip: null as Record<string, unknown> | null,
  inserted: [] as unknown[],
  plain: [] as unknown[],
  alerts: [] as string[],
  shown: [] as Array<{ id: string; data: Record<string, unknown> | undefined }>,
  refreshed: 0,
}));

vi.mock("@api/lib", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/lib")>()),
  pendingCopyOfSheetCells: () => h.clip,
  insertCopiedCellsLabel: (wholeLines: boolean) =>
    h.clip ? (wholeLines ? "Insert Copied Cells" : "Insert Copied Cells...") : null,
  insertCopiedCells: vi.fn(async (request: unknown) => {
    h.inserted.push(request);
    return { inserted: true };
  }),
  insertCellsRange: vi.fn(async (...args: unknown[]) => {
    h.plain.push(args);
    return { applied: true, confirm: null, wholeLines: false };
  }),
}));
vi.mock("@api/dialogs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/dialogs")>()),
  alertAsync: async (message: string) => {
    h.alerts.push(message);
  },
  confirmAsync: () => Promise.resolve(true),
}));
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => (h.selection ? { selection: h.selection } : null),
  refreshGridData: () => {
    h.refreshed += 1;
  },
}));
vi.mock("@api/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/ui")>()),
  showDialog: (id: string, data?: Record<string, unknown>) => h.shown.push({ id, data }),
}));

import extension, { CONTEXT_INSERT_ID, INSERT_CELLS_DIALOG_ID, resetRememberedChoices } from "../index";
import { COPY_AREA_MISMATCH } from "../lib/cellShift";
import { CommandRegistry, CoreCommands } from "@api/commands";
import { gridExtensions } from "@api";
import { registerGridExtensionsService, type GridContextMenuItem } from "@api/extensions";
import { INSERT_MENU_ROWS } from "../../HomeTab/components/cells/InsertSplitButton";

/** The grid right-click items, as Core's service would hold them. */
const contextItems = new Map<string, GridContextMenuItem>();
registerGridExtensionsService({
  registerContextMenuItem: (item) => void contextItems.set(item.id, item),
  registerContextMenuItems: (items) => items.forEach((item) => contextItems.set(item.id, item)),
  unregisterContextMenuItem: (id) => void contextItems.delete(id),
  getContextMenuItems: () => [...contextItems.values()],
  getContextMenuItemsForContext: () => [...contextItems.values()],
  onChange: () => () => {},
});

const LAST_COL = 16_383;
const LAST_ROW = 1_048_575;

const cells = (startRow: number, startCol: number, endRow: number, endCol: number) => ({
  startRow,
  startCol,
  endRow,
  endCol,
  type: "cells",
});
const rows = (startRow: number, endRow: number) => ({ startRow, startCol: 0, endRow, endCol: LAST_COL, type: "rows" });

/** A pending copy of `sourceSelection` holding `height` rows. */
function copyOf(sourceSelection: Record<string, unknown>, height: number): Record<string, unknown> {
  return {
    sourceSelection,
    cells: Array.from({ length: height }, () => [null]),
    sourceRows: Array.from({ length: height }, (_, r) => (sourceSelection.startRow as number) + r),
    isCut: false,
    sourceSheetIndex: 0,
    sourceSheetName: "Sheet1",
    text: "x",
  };
}

beforeAll(() => {
  extension.activate({
    commands: {
      register: (id: string, fn: (...a: unknown[]) => unknown, opts?: unknown) =>
        CommandRegistry.register(id, fn, opts as never),
      unregister: (id: string) => CommandRegistry.unregister(id),
      execute: (id: string, args?: unknown) => CommandRegistry.execute(id, args),
    },
    ui: { dialogs: { register: () => {}, unregister: () => {}, show: () => {} } },
  } as never);
});
afterAll(() => {
  extension.deactivate?.();
});

beforeEach(() => {
  h.selection = cells(1, 5, 1, 5); // F2
  h.clip = copyOf(cells(5, 5, 5, 5), 1); // F6
  h.inserted = [];
  h.plain = [];
  h.alerts = [];
  h.shown = [];
  h.refreshed = 0;
  resetRememberedChoices();
});

describe("[LIVE] Insert with a COPY pending is Insert Copied Cells", () => {
  it("Ctrl+Plus / Insert Copied Cells... opens Excel's two-choice Insert dialog, Shift cells right first", async () => {
    await CommandRegistry.execute(CoreCommands.INSERT_CELLS);
    expect(h.shown).toHaveLength(1);
    expect(h.shown[0].id).toBe(INSERT_CELLS_DIALOG_ID);
    expect(h.shown[0].data).toMatchObject({ mode: "insert", copied: true, initial: "right" });
    expect(h.inserted, "inserted before the dialog was answered").toEqual([]);
    const onChoose = h.shown[0].data?.onChoose as (choice: string) => void;
    onChoose("down");
    await vi.waitFor(() => expect(h.inserted).toHaveLength(1));
    expect(h.inserted[0]).toEqual({ kind: "cells", startRow: 1, startCol: 5, endRow: 1, endCol: 5, shift: "down" });
    expect(h.plain, "a BLANK cell was inserted instead of the copied one").toEqual([]);
    await vi.waitFor(() => expect(h.refreshed).toBe(1));
  });

  it("the room is the COPY's size at the selection's top-left: A1:B1 copied into F2 -> F2:G2", async () => {
    h.clip = copyOf(cells(0, 0, 0, 1), 1);
    await CommandRegistry.execute(CoreCommands.INSERT_CELLS, { shift: "right" });
    expect(h.shown, "a named shift opened the dialog").toEqual([]);
    expect(h.inserted).toEqual([{ kind: "cells", startRow: 1, startCol: 5, endRow: 1, endCol: 6, shift: "right" }]);
  });

  it("F6:F7 copied into F2:F4 -> the room is two cells, F2:F3 (the copy's size again)", async () => {
    h.clip = copyOf(cells(5, 5, 6, 5), 2);
    h.selection = cells(1, 5, 3, 5);
    await CommandRegistry.execute(CoreCommands.INSERT_CELLS, { shift: "down" });
    expect(h.inserted).toEqual([{ kind: "cells", startRow: 1, startCol: 5, endRow: 2, endCol: 5, shift: "down" }]);
  });

  // Round 13 (lane clip5, NEW-paste-does-not-tile) [LIVE 2026-10-30,
  // clip5/probe-insert-tile.ps1]: a selection that is an exact MULTIPLE of the
  // copy is filled with the copy tiled -- F6 into F2:F3 inserts f6 twice, F6:F7
  // into F2:F5 inserts f6,f7,f6,f7, rows 6:7 into rows 2:5 the pair twice --
  // and anything else takes the copy's size (rows 6:7 into rows 2:4: once).
  it("[LIVE] F6 copied into F2:F3 (a multiple): the room is the whole selection, the copy fills it twice", async () => {
    h.selection = cells(1, 5, 2, 5);
    await CommandRegistry.execute(CoreCommands.INSERT_CELLS, { shift: "down" });
    expect(h.inserted, "the room was the copy's size, not the multiple Excel fills").toEqual([
      { kind: "cells", startRow: 1, startCol: 5, endRow: 2, endCol: 5, shift: "down" },
    ]);
  });

  it("[LIVE] F6:F7 copied into F2:F5: the room is F2:F5", async () => {
    h.clip = copyOf(cells(5, 5, 6, 5), 2);
    h.selection = cells(1, 5, 4, 5);
    await CommandRegistry.execute(CoreCommands.INSERT_CELLS, { shift: "down" });
    expect(h.inserted).toEqual([{ kind: "cells", startRow: 1, startCol: 5, endRow: 4, endCol: 5, shift: "down" }]);
  });

  it("[LIVE] rows 6:7 copied into rows 2:5: four rows (the pair twice); into rows 2:4: two rows (once)", async () => {
    h.clip = copyOf(rows(5, 6), 2);
    h.selection = rows(1, 4);
    await CommandRegistry.execute(CoreCommands.INSERT_CELLS);
    expect(h.inserted, "the copied rows were inserted once into a multiple").toEqual([{ kind: "rows", start: 1, count: 4 }]);
    h.inserted = [];
    h.selection = rows(1, 3);
    await CommandRegistry.execute(CoreCommands.INSERT_CELLS);
    expect(h.inserted).toEqual([{ kind: "rows", start: 1, count: 2 }]);
  });

  // Round 15 (lane clip7, rev13B minor): the room was sized over a 1-wide (or
  // 1-high) strip, so the paste's 5,000,000-cell tiling cap never applied to
  // it, while the copy's own paste into the room asks the cap over the REAL
  // area -- five columns inserted, one filled. The room now asks the same
  // question over the same area, so the two agree.
  it("the room agrees with the paste: column A copied into C:G (5.2M cells, past the paste's cap) inserts ONE column; into C:D, two", async () => {
    const colsSel = (startCol: number, endCol: number) => ({ startRow: 0, startCol, endRow: LAST_ROW, endCol, type: "columns" });
    h.clip = copyOf(colsSel(0, 0), LAST_ROW + 1);
    h.selection = colsSel(2, 6);
    await CommandRegistry.execute(CoreCommands.INSERT_CELLS);
    expect(h.inserted, "five columns made for a paste that fills one").toEqual([{ kind: "columns", start: 2, count: 1 }]);
    h.inserted = [];
    h.selection = colsSel(2, 3);
    await CommandRegistry.execute(CoreCommands.INSERT_CELLS);
    expect(h.inserted, "control: a multiple under the cap is still tiled").toEqual([{ kind: "columns", start: 2, count: 2 }]);
  });

  it("the room agrees with the paste: row 6 (16,384 wide) copied into 306 rows (past the cap) inserts ONE row; into 305, 305", async () => {
    h.clip = copyOf(rows(5, 5), 1);
    h.selection = rows(1, 306);
    await CommandRegistry.execute(CoreCommands.INSERT_CELLS);
    expect(h.inserted, "306 rows made for a paste that fills one").toEqual([{ kind: "rows", start: 1, count: 1 }]);
    h.inserted = [];
    h.selection = rows(1, 305);
    await CommandRegistry.execute(CoreCommands.INSERT_CELLS);
    expect(h.inserted, "control: a multiple under the cap is still tiled").toEqual([{ kind: "rows", start: 1, count: 305 }]);
  });

  it("row 6 copied, row 2 selected: the copied row is inserted at row 2, no dialog", async () => {
    h.clip = copyOf(rows(5, 5), 1);
    h.selection = rows(1, 1);
    await CommandRegistry.execute(CoreCommands.INSERT_CELLS);
    expect(h.shown).toEqual([]);
    expect(h.inserted).toEqual([{ kind: "rows", start: 1, count: 1 }]);
  });

  it("F6 copied, row 2 selected: refused with Excel's words, nothing inserted", async () => {
    h.selection = rows(1, 1);
    await CommandRegistry.execute(CoreCommands.INSERT_CELLS);
    expect(h.alerts).toEqual([COPY_AREA_MISMATCH]);
    expect(h.inserted).toEqual([]);
    expect(h.plain).toEqual([]);
  });

  it("a whole row copied into a block of cells is refused too", async () => {
    h.clip = copyOf(rows(5, 5), 1);
    await CommandRegistry.execute(CoreCommands.INSERT_CELLS);
    expect(h.alerts).toEqual([COPY_AREA_MISMATCH]);
    expect(h.inserted).toEqual([]);
  });

  it("a copied block that would run past the sheet's last row is refused", async () => {
    h.clip = copyOf(cells(5, 5, 7, 5), 3);
    h.selection = cells(LAST_ROW - 1, 5, LAST_ROW - 1, 5);
    await CommandRegistry.execute(CoreCommands.INSERT_CELLS, { shift: "down" });
    expect(h.alerts).toEqual([COPY_AREA_MISMATCH]);
    expect(h.inserted).toEqual([]);
  });

  it("the Insert button's main half inserts the copied cells too (the shape rule picks the shift, no dialog)", async () => {
    await CommandRegistry.execute(CoreCommands.INSERT);
    expect(h.shown).toEqual([]);
    expect(h.inserted).toEqual([{ kind: "cells", startRow: 1, startCol: 5, endRow: 1, endCol: 5, shift: "down" }]);
  });

  it("control: with no copy pending, Insert Cells... opens the four-choice dialog and inserts BLANK cells", async () => {
    h.clip = null;
    await CommandRegistry.execute(CoreCommands.INSERT_CELLS);
    expect(h.shown).toHaveLength(1);
    expect(h.shown[0].data?.copied).toBeUndefined();
    await CommandRegistry.execute(CoreCommands.INSERT_CELLS, { shift: "down" });
    expect(h.plain).toHaveLength(1);
    expect(h.inserted).toEqual([]);
  });

  it("Delete is unchanged by a pending copy (a delete ENDS the copy instead)", async () => {
    await CommandRegistry.execute(CoreCommands.DELETE_CELLS, { shift: "up" });
    expect(h.inserted).toEqual([]);
  });
});

describe("[LIVE] the menus say Insert Copied Cells while a copy is pending", () => {
  it("the cell right-click item reads Insert Copied Cells... (Insert... without a copy)", () => {
    const item = gridExtensions.getContextMenuItems().find((i) => i.id === CONTEXT_INSERT_ID);
    expect(item, "no Insert... item on the cell right-click menu").toBeDefined();
    const label = item!.label as (ctx: unknown) => string;
    expect(label({})).toBe("Insert Copied Cells...");
    h.clip = null;
    expect(label({})).toBe("Insert...");
  });

  it("Home > Insert's Cells... row reads Insert Copied Cells... (no dots over whole rows)", () => {
    const row = INSERT_MENU_ROWS.find((r) => r.slug === "cells")!;
    expect(row.liveLabel?.()).toBe("Insert Copied Cells...");
    h.selection = rows(1, 1);
    expect(row.liveLabel?.()).toBe("Insert Copied Cells");
    h.clip = null;
    expect(row.liveLabel?.() ?? row.label).toBe("Insert Cells...");
  });
});

// Round 14 (lane clip6), reviewer rev12A's minor finding: the header menu with
// a copy pending still offered Core's blank-line Insert and ended the copy.
// Live Excel 16 [2026-10-30, clip6/probe-menu.ps1: Shift+F10 on a fresh
// visible instance, the open menu read through UI Automation]:
//   nothing copied, row 2 selected       -> "Insert"
//   row 6 copied, row 2 selected          -> "Insert Copied Cells"
//   F6 copied, row 2 selected             -> "Insert Copied Cells"
//   row 6 copied, B2 selected             -> "Insert Copied Cells" (no dots)
//   F6 copied, B2 selected                -> "Insert Copied Cells..."
//   column F / row 6 copied, column B     -> "Insert Copied Cells"
describe("[LIVE] the right-click Insert item over headers and cells with a copy pending", () => {
  const ctx = (selection: Record<string, unknown>) => ({ selection }) as never;
  const cols = (startCol: number, endCol: number) => ({ startRow: 0, startCol, endRow: LAST_ROW, endCol, type: "columns" });
  function contextItem(): GridContextMenuItem {
    const item = gridExtensions.getContextMenuItems().find((i) => i.id === CONTEXT_INSERT_ID);
    expect(item, "no Insert item on the right-click menu").toBeDefined();
    return item!;
  }
  const visibleOn = (selection: Record<string, unknown>): boolean => {
    const v = contextItem().visible;
    return typeof v === "function" ? v(ctx(selection)) : v !== false;
  };
  const labelOn = (selection: Record<string, unknown>): string => {
    const l = contextItem().label;
    return typeof l === "function" ? l(ctx(selection)) : l;
  };

  it("a row header with row 6 copied: Insert Copied Cells, which inserts the copied row at row 2", async () => {
    h.clip = copyOf(rows(5, 5), 1);
    h.selection = rows(1, 1);
    expect(visibleOn(rows(1, 1)), "the row header offers no Insert Copied Cells").toBe(true);
    expect(labelOn(rows(1, 1))).toBe("Insert Copied Cells");
    // Round 16 (rev14A): it takes the place of Core's header Insert Row /
    // Column through the registry (`replaces`), not by Core guessing.
    expect(contextItem().replaces, "Core's blank Insert Row is offered beside it").toEqual(["core:insertRow", "core:insertColumn"]);
    await contextItem().onClick(ctx(rows(1, 1)));
    expect(h.inserted).toEqual([{ kind: "rows", start: 1, count: 1 }]);
    expect(h.shown, "a dialog opened over whole rows").toEqual([]);
  });

  it("a row header with F6 copied reads Insert Copied Cells too -- and is refused, as Excel refuses it", async () => {
    h.selection = rows(1, 1);
    expect(labelOn(rows(1, 1))).toBe("Insert Copied Cells");
    await contextItem().onClick(ctx(rows(1, 1)));
    expect(h.inserted).toEqual([]);
    expect(h.alerts).toEqual([COPY_AREA_MISMATCH]);
  });

  it("a column header with column F copied: Insert Copied Cells", () => {
    h.clip = copyOf(cols(5, 5), LAST_ROW + 1);
    expect(visibleOn(cols(1, 1))).toBe(true);
    expect(labelOn(cols(1, 1))).toBe("Insert Copied Cells");
  });

  it("cells with copied whole rows read Insert Copied Cells (no dialog follows); a copied block reads Insert Copied Cells...", () => {
    h.clip = copyOf(rows(5, 5), 1);
    expect(labelOn(cells(1, 1, 1, 1))).toBe("Insert Copied Cells");
    h.clip = copyOf(cells(5, 5, 5, 5), 1);
    expect(labelOn(cells(1, 1, 1, 1))).toBe("Insert Copied Cells...");
  });

  it("control: no copy pending -- the headers keep Core's Insert Row / Column (this item stands down); cells keep Insert...", () => {
    h.clip = null;
    expect(visibleOn(rows(1, 1))).toBe(false);
    expect(visibleOn(cols(1, 1))).toBe(false);
    expect(visibleOn(cells(1, 1, 1, 1))).toBe(true);
    expect(labelOn(cells(1, 1, 1, 1))).toBe("Insert...");
  });
});
