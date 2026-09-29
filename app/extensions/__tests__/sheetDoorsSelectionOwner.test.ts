//! FILENAME: app/extensions/__tests__/sheetDoorsSelectionOwner.test.ts
// PURPOSE: The Formulas / View / Insert menu doors (and their commands) whose
//          TARGET is Core's selection -- Define Name (prefilled from it), Paste
//          Names (writes at it), the page-break, print-area and print-title
//          items, and Insert > Cell Type (plus the cellTypes.* commands) --
//          refuse with ONE toast and write nothing while a selection owner
//          holds the selection; they act when nothing does. The sheet-level
//          items of the same menus (Clear Print Area, Reset All Page Breaks)
//          are not refused, and neither is the Cell Type CONTEXT menu, which
//          acts on the cell the user right-clicked.
// CONTEXT: D4 (wa-keys fixup, "audit for others"; BUG-0185 class). With a
//          floating grid's cell selected, Core's selection is HIDDEN under the
//          floating grid, and each of these wrote to, or started from, THAT
//          selection. TEST owner (@api/selectionOwner).

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  effects: [] as string[],
  menuItems: [] as { id: string; action?: () => unknown; children?: unknown[] }[],
  contextItems: [] as { id: string; children?: { id: string; onClick: (ctx: unknown) => unknown }[] }[],
  commands: new Map<string, () => unknown>(),
  selectionSubs: new Set<(sel: unknown) => void>(),
}));
const SELECTION = { startRow: 3, startCol: 1, endRow: 5, endCol: 2, type: "cells" };

vi.mock("@api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@api")>();
  return {
    ...real,
    showDialog: (id: string) => h.effects.push(`showDialog:${id}`),
    getAllNamedRanges: vi.fn(async () => [{ name: "Total", refersTo: "=Sheet1!$A$1" }]),
    updateCellsBatch: vi.fn(async () => {
      h.effects.push("updateCellsBatch");
    }),
    // eslint-disable-next-line @typescript-eslint/naming-convention -- the real export name
    ExtensionRegistry: {
      ...real.ExtensionRegistry,
      onSelectionChange: (cb: (sel: unknown) => void) => {
        h.selectionSubs.add(cb);
        return () => h.selectionSubs.delete(cb);
      },
      registerCommand: (cmd: { id: string; execute: () => unknown }) => {
        h.commands.set(cmd.id, cmd.execute);
      },
    },
    gridExtensions: {
      ...real.gridExtensions,
      registerContextMenuItems: (items: { id: string }[]) => {
        h.contextItems.push(...items);
      },
      unregisterContextMenuItem: vi.fn(),
    },
  };
});
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => ({ selection: SELECTION, surface: "grid" }),
}));
vi.mock("@api/lib", async (importOriginal) => {
  const real = await importOriginal<typeof import("@api/lib")>();
  const record = (name: string) => vi.fn(async () => {
    h.effects.push(name);
    return "";
  });
  return {
    ...real,
    insertRowPageBreak: record("insertRowPageBreak"),
    removeRowPageBreak: record("removeRowPageBreak"),
    insertColPageBreak: record("insertColPageBreak"),
    removeColPageBreak: record("removeColPageBreak"),
    resetAllPageBreaks: record("resetAllPageBreaks"),
    setPrintArea: record("setPrintArea"),
    clearPrintArea: record("clearPrintArea"),
    setPrintTitleRows: record("setPrintTitleRows"),
    setPrintTitleCols: record("setPrintTitleCols"),
    beginUndoTransaction: vi.fn(async () => {}),
    commitUndoTransaction: vi.fn(async () => {}),
    getCell: vi.fn(async () => ({ display: "x" })),
  };
});
vi.mock("@api/cellTypes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/cellTypes")>()),
  setCellTypeRange: vi.fn(async () => {
    h.effects.push("setCellTypeRange");
  }),
  clearCellTypeRange: vi.fn(async () => {
    h.effects.push("clearCellTypeRange");
  }),
}));
vi.mock("../Print/lib/pageBreakOverlay", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../Print/lib/pageBreakOverlay")>()),
  refreshPageBreakData: vi.fn(async () => {}),
}));
vi.mock("@api/dialogs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/dialogs")>()),
  alertAsync: vi.fn(async () => {}),
}));

import { registerDefinedNamesMenuItems } from "../DefinedNames/handlers/formulasMenuItemBuilder";
import PrintExtension from "../Print";
import CellTypesExtension from "../CellTypes";
import { registerSelectionOwner } from "@api/selectionOwner";
import { registerToastSink, type ToastPayload } from "@api/notifications";

const toasts: ToastPayload[] = [];
let owns = false;
let release: () => void = () => {};

/** Every door inert, except the menus (recorded) and dialogs.show (an effect). */
function recordingContext(): never {
  const inert = (path: string): unknown =>
    new Proxy(() => () => {}, {
      get: (_t, prop) => (prop === "then" ? undefined : inert(`${path}.${String(prop)}`)),
      apply: (_t, _this, args: unknown[]) => {
        if (path === ".ui.menus.registerItem") h.menuItems.push(args[1] as { id: string });
        if (path === ".ui.dialogs.show") h.effects.push(`dialogs.show:${String(args[0])}`);
        if (path === ".invokeBackend") return Promise.resolve(null);
        return () => {};
      },
    });
  return inert("") as never;
}
function action(id: string): () => unknown {
  const walk = (items: { id: string; action?: () => unknown; children?: unknown[] }[]): (() => unknown) | null => {
    for (const item of items) {
      if (item.id === id && item.action) return item.action;
      const inner = item.children ? walk(item.children as never) : null;
      if (inner) return inner;
    }
    return null;
  };
  const found = walk(h.menuItems);
  if (!found) throw new Error(`no menu action ${id}`);
  return found;
}
function refusals(): ToastPayload[] {
  return toasts.filter((t) => t.message.includes("the selection belongs to"));
}
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

beforeAll(async () => {
  registerDefinedNamesMenuItems(recordingContext());
  await PrintExtension.activate(recordingContext());
  await CellTypesExtension.activate(recordingContext());
  for (const cb of h.selectionSubs) cb(SELECTION);
});
beforeEach(() => {
  h.effects.length = 0;
  toasts.length = 0;
  registerToastSink((t) => toasts.push(t));
  owns = false;
  release = registerSelectionOwner({ id: "test-owner", label: "the test object's cells", ownsSelection: () => owns });
});
afterEach(() => {
  release();
});

/** [label, open the door, the effect it has when it acts] */
const DOORS: [string, () => unknown, string][] = [
  ["Formulas > Define Name...", () => action("formulas:defineName")(), "showDialog:define-name"],
  ["Formulas > Paste Names...", () => action("formulas:pasteNames")(), "updateCellsBatch"],
  ["View > Page Breaks > Insert Row Page Break", () => action("view.pageBreaks:insertRow")(), "insertRowPageBreak"],
  ["View > Page Breaks > Insert Column Page Break", () => action("view.pageBreaks:insertCol")(), "insertColPageBreak"],
  ["View > Page Breaks > Remove Row Page Break", () => action("view.pageBreaks:removeRow")(), "removeRowPageBreak"],
  ["View > Page Breaks > Remove Column Page Break", () => action("view.pageBreaks:removeCol")(), "removeColPageBreak"],
  ["View > Print Area > Set Print Area", () => action("view.printArea:set")(), "setPrintArea"],
  ["View > Print Area > Rows to Repeat at Top", () => action("view.printArea:setTitleRows")(), "setPrintTitleRows"],
  ["View > Print Area > Columns to Repeat at Left", () => action("view.printArea:setTitleCols")(), "setPrintTitleCols"],
  ["Insert > Cell Type > Checkbox", () => action("insert.cellTypes.checkbox")(), "setCellTypeRange"],
  ["Insert > Cell Type > Progress Bar", () => action("insert.cellTypes.progress")(), "setCellTypeRange"],
  ["Insert > Cell Type > Button...", () => action("insert.cellTypes.button")(), "dialogs.show:cellTypes.buttonAction"],
  ["Insert > Cell Type > Clear Cell Type", () => action("insert.cellTypes.clear")(), "clearCellTypeRange"],
  ["cellTypes.insertCheckbox", () => h.commands.get("cellTypes.insertCheckbox")!(), "setCellTypeRange"],
  ["cellTypes.insertProgress", () => h.commands.get("cellTypes.insertProgress")!(), "setCellTypeRange"],
  ["cellTypes.insertButton", () => h.commands.get("cellTypes.insertButton")!(), "dialogs.show:cellTypes.buttonAction"],
  ["cellTypes.clear", () => h.commands.get("cellTypes.clear")!(), "clearCellTypeRange"],
];

describe("selection doors while a selection owner holds the selection", () => {
  for (const [label, open] of DOORS) {
    it(`${label}: nothing written or opened on Core's hidden selection; one toast`, async () => {
      owns = true;
      await open();
      await settle();
      expect(h.effects, `${label} acted on Core's hidden selection`).toEqual([]);
      expect(refusals().length).toBe(1);
    });
  }

  it("sheet-level items are not refused: Clear Print Area, Reset All Page Breaks", async () => {
    owns = true;
    await action("view.printArea:clear")();
    await action("view.pageBreaks:resetAll")();
    await settle();
    expect(h.effects).toEqual(["clearPrintArea", "resetAllPageBreaks"]);
    expect(refusals()).toEqual([]);
  });

  it("the Cell Type CONTEXT menu acts on the right-clicked cell: not refused", async () => {
    owns = true;
    const menu = h.contextItems.find((i) => i.id === "cellTypes.menu");
    const checkbox = menu?.children?.find((c) => c.id === "cellTypes.menu.checkbox");
    await checkbox!.onClick({ selection: SELECTION, clickedCell: { row: 9, col: 9 }, isWithinSelection: false });
    await settle();
    expect(h.effects).toEqual(["setCellTypeRange"]);
    expect(refusals()).toEqual([]);
  });
});

describe("positive controls: nothing owns the selection", () => {
  for (const [label, open, effect] of DOORS) {
    it(`${label}: acts (${effect}), no refusal`, async () => {
      await open();
      await settle();
      expect(h.effects[0]).toBe(effect);
      expect(refusals()).toEqual([]);
    });
  }
});
