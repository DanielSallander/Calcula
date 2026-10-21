//! FILENAME: app/extensions/Protection/handlers/__tests__/protectionCommands.test.ts
// PURPOSE: The Protection extension's two commands, the doors Excel's Home >
//          Cells > Format > Protection rows run:
//            protection.toggleProtectSheet -- Protect Sheet... / Unprotect Sheet...
//            protection.toggleLockCell     -- Lock Cell (checked when the active
//                                             cell is locked)
// CONTEXT: The extension registered NO commands: Protect Sheet lived only as a
//          Review-menu action, and Lock Cell existed nowhere (only the Cell
//          Protection dialog could change the flag). The Home tab says WHAT it
//          wants by command id; this extension decides HOW (the Seam Rule).

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  state: null as null | Record<string, unknown>,
  sheetProtected: false,
  hasPassword: false,
  showDialog: vi.fn(),
  getCellProtection: vi.fn(async (_r: number, _c: number) => ({ locked: true, formulaHidden: false })),
  setCellProtection: vi.fn(async (_p: Record<string, unknown>) => ({ success: true, error: null as string | null })),
  unprotectSheet: vi.fn(async () => ({ success: true })),
  begin: vi.fn(async (_label: string): Promise<number | null> => 11),
  commit: vi.fn(async (_t?: number | null) => undefined),
  cancel: vi.fn(async (_t?: number | null) => undefined),
  refreshState: vi.fn(async () => undefined),
  refreshGridData: vi.fn(),
  // P3: a floating grid's cells take the flag through their target.
  applyFormatting: vi.fn(async (..._a: unknown[]) => ({ cells: [], styles: [] })),
  getStyle: vi.fn(async (_i: number) => ({ locked: true })),
  readTargetCell: vi.fn(async (..._a: unknown[]) => ({ row: 4, col: 2, styleIndex: 6, display: "", valueKind: "empty" })),
}));

vi.mock("@api/lib", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/lib")>()),
  applyFormatting: (...a: unknown[]) => h.applyFormatting(...a),
  getStyle: (i: number) => h.getStyle(i),
}));
vi.mock("@api/cellTarget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/cellTarget")>()),
  readTargetCell: (...a: unknown[]) => h.readTargetCell(...a),
}));

vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  showDialog: (...a: unknown[]) => h.showDialog(...a),
  getCellProtection: (r: number, c: number) => h.getCellProtection(r, c),
  setCellProtection: (p: Record<string, unknown>) => h.setCellProtection(p),
  unprotectSheet: () => h.unprotectSheet(),
  beginUndoTransaction: (label: string) => h.begin(label),
  commitUndoTransaction: (t?: number | null) => h.commit(t),
  cancelUndoTransaction: (t?: number | null) => h.cancel(t),
}));
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => h.state,
  refreshGridData: () => h.refreshGridData(),
}));
vi.mock("../../lib/protectionStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/protectionStore")>()),
  isCurrentSheetProtected: () => h.sheetProtected,
  currentSheetHasPassword: () => h.hasPassword,
  isCurrentWorkbookProtected: () => false,
  refreshProtectionState: () => h.refreshState(),
}));

import { CommandRegistry, ExtensionCommands } from "@api/commands";
import { registerToastSink, type ToastPayload } from "@api/notifications";
import { registerSelectionOwner } from "@api/selectionOwner";
import type { Selection } from "@api/types";
import { registerProtectionCommands } from "../protectionCommands";

const toasts: ToastPayload[] = [];
let release: () => void = () => {};

function select(selection: Selection | null): void {
  h.state = { selection, sheetContext: { activeSheetIndex: 0, activeSheetName: "Sheet1" } };
}

const fakeContext = { commands: CommandRegistry } as never;

beforeAll(() => {
  registerToastSink((t) => toasts.push(t));
  release = registerProtectionCommands(fakeContext);
});
afterAll(() => release());

beforeEach(() => {
  vi.clearAllMocks();
  toasts.length = 0;
  h.sheetProtected = false;
  h.hasPassword = false;
  select({ startRow: 1, startCol: 1, endRow: 3, endCol: 2, type: "cells" });
});

describe("registration", () => {
  it("registers both commands; the cleanup takes them back", () => {
    expect(CommandRegistry.has(ExtensionCommands.PROTECT_SHEET_TOGGLE)).toBe(true);
    expect(CommandRegistry.has(ExtensionCommands.LOCK_CELL_TOGGLE)).toBe(true);
    const local = registerProtectionCommands(fakeContext);
    local();
    expect(CommandRegistry.has(ExtensionCommands.PROTECT_SHEET_TOGGLE)).toBe(false);
    expect(CommandRegistry.has(ExtensionCommands.LOCK_CELL_TOGGLE)).toBe(false);
    release = registerProtectionCommands(fakeContext);
  });

  it("neither is script-safe: a script must not be able to unprotect a sheet or unlock cells", () => {
    expect(CommandRegistry.isScriptSafe(ExtensionCommands.PROTECT_SHEET_TOGGLE)).toBe(false);
    expect(CommandRegistry.isScriptSafe(ExtensionCommands.LOCK_CELL_TOGGLE)).toBe(false);
  });
});

describe("Protect Sheet... / Unprotect Sheet...", () => {
  it("re-reads the protection state first (the cache is only refreshed on events)", async () => {
    await CommandRegistry.execute(ExtensionCommands.PROTECT_SHEET_TOGGLE);
    expect(h.refreshState).toHaveBeenCalled();
  });

  it("an unprotected sheet opens Protect Sheet", async () => {
    await CommandRegistry.execute(ExtensionCommands.PROTECT_SHEET_TOGGLE);
    expect(h.showDialog).toHaveBeenCalledWith("protect-sheet-dialog", {});
  });

  it("a password-protected sheet opens Unprotect Sheet (asks for the password)", async () => {
    h.sheetProtected = true;
    h.hasPassword = true;
    await CommandRegistry.execute(ExtensionCommands.PROTECT_SHEET_TOGGLE);
    expect(h.showDialog).toHaveBeenCalledWith("unprotect-sheet-dialog", {});
    expect(h.unprotectSheet).not.toHaveBeenCalled();
  });

  it("a sheet protected without a password is unprotected at once (Excel)", async () => {
    h.sheetProtected = true;
    await CommandRegistry.execute(ExtensionCommands.PROTECT_SHEET_TOGGLE);
    expect(h.unprotectSheet).toHaveBeenCalledTimes(1);
    expect(h.showDialog).not.toHaveBeenCalled();
  });
});

describe("Lock Cell", () => {
  it("unlocks the selection when the ACTIVE cell is locked -- `locked` only, one undo step", async () => {
    select({ startRow: 3, startCol: 2, endRow: 1, endCol: 1, type: "cells" });
    await CommandRegistry.execute(ExtensionCommands.LOCK_CELL_TOGGLE);
    // The active cell is (endRow, endCol) in Calcula's selection model.
    expect(h.getCellProtection).toHaveBeenCalledWith(1, 1);
    expect(h.setCellProtection).toHaveBeenCalledTimes(1);
    expect(h.setCellProtection).toHaveBeenCalledWith({
      startRow: 1,
      startCol: 1,
      endRow: 3,
      endCol: 2,
      locked: false,
    });
    expect(h.begin).toHaveBeenCalledTimes(1);
    expect(h.commit).toHaveBeenCalledWith(11);
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it("locks the selection when the active cell is unlocked", async () => {
    h.getCellProtection.mockResolvedValueOnce({ locked: false, formulaHidden: true });
    await CommandRegistry.execute(ExtensionCommands.LOCK_CELL_TOGGLE);
    expect(h.setCellProtection.mock.calls[0][0]).toMatchObject({ locked: true });
    // The Hidden flag is NOT this command's: it must not be sent at all.
    expect(h.setCellProtection.mock.calls[0][0]).not.toHaveProperty("formulaHidden");
  });

  it("a multi-area selection is every area, still ONE undo step", async () => {
    select({
      startRow: 0,
      startCol: 0,
      endRow: 0,
      endCol: 0,
      type: "cells",
      additionalRanges: [{ startRow: 5, startCol: 5, endRow: 6, endCol: 6 }],
    });
    await CommandRegistry.execute(ExtensionCommands.LOCK_CELL_TOGGLE);
    expect(h.setCellProtection).toHaveBeenCalledTimes(2);
    expect(h.begin).toHaveBeenCalledTimes(1);
    expect(h.commit).toHaveBeenCalledTimes(1);
  });

  it("is refused on a protected sheet (Excel greys it) -- one toast, nothing read or written", async () => {
    h.sheetProtected = true;
    await CommandRegistry.execute(ExtensionCommands.LOCK_CELL_TOGGLE);
    expect(toasts.length).toBe(1);
    expect(toasts[0].message).toMatch(/protected/i);
    expect(h.getCellProtection).not.toHaveBeenCalled();
    expect(h.setCellProtection).not.toHaveBeenCalled();
    expect(h.begin).not.toHaveBeenCalled();
  });

  it("a backend refusal is shown, and the empty transaction is cancelled", async () => {
    h.setCellProtection.mockResolvedValueOnce({ success: false, error: "Cannot change cell locking on a protected sheet" });
    await CommandRegistry.execute(ExtensionCommands.LOCK_CELL_TOGGLE);
    expect(toasts.map((t) => t.message)).toContain("Cannot change cell locking on a protected sheet");
    expect(h.cancel).toHaveBeenCalledWith(11);
    expect(h.commit).not.toHaveBeenCalled();
  });

  it("refreshes the grid's cached cells after a change (the lock lives in the cell's style)", async () => {
    await CommandRegistry.execute(ExtensionCommands.LOCK_CELL_TOGGLE);
    expect(h.refreshGridData).toHaveBeenCalled();
  });

  it("is refused while a selection owner holds the selection (BUG-0185 class)", async () => {
    const releaseOwner = registerSelectionOwner({ id: "t", label: "the test object's cells", ownsSelection: () => true });
    try {
      await CommandRegistry.execute(ExtensionCommands.LOCK_CELL_TOGGLE);
    } finally {
      releaseOwner();
    }
    expect(toasts.length).toBe(1);
    expect(h.setCellProtection).not.toHaveBeenCalled();
  });

  it("no selection, nothing", async () => {
    select(null);
    await CommandRegistry.execute(ExtensionCommands.LOCK_CELL_TOGGLE);
    expect(h.setCellProtection).not.toHaveBeenCalled();
  });
});

describe("Lock Cell on a floating grid's cells (P3)", () => {
  const REF = { kind: "floatingRange" as const, id: "fr-5" };
  const floatingGrid = (actsOn?: readonly "format"[]): (() => void) =>
    registerSelectionOwner({
      id: "floatingRange",
      label: "a floating grid's cells",
      ownsSelection: () => true,
      cellTarget: () => ({
        ref: REF,
        selection: { startRow: 3, startCol: 2, endRow: 4, endCol: 2, activeRow: 4, activeCol: 2, type: "cells" },
        bounds: { rows: 10, cols: 5 },
        label: "Float1",
        wholeObject: false,
      }),
      ...(actsOn ? { actsOn } : {}),
    });

  it("reads the grid's ACTIVE cell's flag through the target and writes the opposite to ITS cells", async () => {
    const releaseOwner = floatingGrid(["format"]);
    try {
      await CommandRegistry.execute(ExtensionCommands.LOCK_CELL_TOGGLE);
    } finally {
      releaseOwner();
    }
    expect(toasts).toEqual([]);
    expect(h.readTargetCell).toHaveBeenCalledWith(REF, 4, 2);
    expect(h.getStyle).toHaveBeenCalledWith(6);
    expect(h.applyFormatting.mock.calls).toEqual([[[3, 4], [2], { locked: false }, { target: REF }]]);
    // The active sheet's protection command is never asked about them.
    expect(h.getCellProtection).not.toHaveBeenCalled();
    expect(h.setCellProtection).not.toHaveBeenCalled();
    expect(h.commit).toHaveBeenCalledWith(11);
  });

  it("is still refused on a protected host (Excel greys it)", async () => {
    h.sheetProtected = true;
    const releaseOwner = floatingGrid(["format"]);
    try {
      await CommandRegistry.execute(ExtensionCommands.LOCK_CELL_TOGGLE);
    } finally {
      releaseOwner();
    }
    expect(toasts.length).toBe(1);
    expect(h.applyFormatting).not.toHaveBeenCalled();
  });

  it("inert until S8: a floating grid that admits nothing refuses, once, writing nothing", async () => {
    const releaseOwner = floatingGrid(undefined);
    try {
      await CommandRegistry.execute(ExtensionCommands.LOCK_CELL_TOGGLE);
    } finally {
      releaseOwner();
    }
    expect(toasts.length).toBe(1);
    expect(h.applyFormatting).not.toHaveBeenCalled();
    expect(h.setCellProtection).not.toHaveBeenCalled();
  });
});
