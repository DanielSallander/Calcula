//! FILENAME: app/extensions/Table/handlers/__tests__/designTabSelectionOwner.test.ts
// PURPOSE: The contextual Table Design tab stands aside while a selection owner
//          (a floating grid's selected cell) holds the selection, and comes
//          back when the claim ends -- with Core's selection never moving in
//          between.
// CONTEXT: W22 (wave C). The tab followed Core's ACTIVE cell only. Clicking a
//          floating grid's cell leaves Core's selection where it was -- on a
//          table cell now HIDDEN under the floating grid -- so the tab stayed
//          up, every button on it addressing a table the user could not see
//          (Resize Table even refused, D4). The claim is announced the way a
//          floating grid really announces it: its OBJECT selection changing
//          (@api/objectSelection notifyObjectSelectionChanged), heard by
//          @api/selectionOwner onSelectionOwnershipChanged. The extension is
//          ACTIVATED for real, so the subscription is part of what is tested.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  registerPanel: vi.fn(),
  unregisterPanel: vi.fn(),
  /** Core's grid state, as @api/grid's snapshot reads it (null: no grid mounted). */
  snapshot: null as { selection: { startRow: number; startCol: number; endRow: number; endCol: number; type: string } } | null,
  tables: [] as {
    id: string;
    name: string;
    sheetIndex: number;
    startRow: number;
    startCol: number;
    endRow: number;
    endCol: number;
    columns: { name: string }[];
    styleOptions: Record<string, boolean>;
  }[],
}));

vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  listenForEvent: vi.fn(async () => () => {}),
  listenTauriEvent: vi.fn(async () => () => {}),
}));
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => h.snapshot,
}));
vi.mock("@api/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/ui")>()),
  registerPanel: (...a: unknown[]) => h.registerPanel(...a),
  unregisterPanel: (...a: unknown[]) => h.unregisterPanel(...a),
}));
vi.mock("../../lib/tableStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/tableStore")>()),
  refreshCache: vi.fn(async () => undefined),
  getAllTables: () => h.tables,
  getTableAtCell: (row: number, col: number) =>
    h.tables.find((t) => row >= t.startRow && row <= t.endRow && col >= t.startCol && col <= t.endCol) ?? null,
}));

import { registerExtensionRegistryService, type ExtensionRegistryService } from "@api/extensions";
import type { Selection } from "@api";
import { registerSelectionOwner } from "@api/selectionOwner";
import { notifyObjectSelectionChanged } from "@api/objectSelection";
import { TABLE_DESIGN_TAB_ID } from "../../manifest";
import extension from "../../index";
import { recheckDesignTabAfterSheetChange } from "../selectionHandler";
import * as fs from "fs";
import * as path from "path";

// Core's selection, delivered the way the shell delivers it.
const selectionListeners = new Set<(sel: Selection | null) => void>();
registerExtensionRegistryService({
  registerAddIn: () => {},
  unregisterAddIn: () => {},
  registerCommand: () => {},
  getCommand: () => undefined,
  getAllCommands: () => [],
  registerRibbonTab: () => {},
  unregisterRibbonTab: () => {},
  registerRibbonGroup: () => {},
  getRibbonTabs: () => [],
  getRibbonGroupsForTab: () => [],
  notifySelectionChange: (sel: Selection | null) => selectionListeners.forEach((l) => l(sel)),
  onSelectionChange: (cb: (sel: Selection | null) => void) => {
    selectionListeners.add(cb);
    return () => selectionListeners.delete(cb);
  },
  onCellChange: () => () => {},
  onRegistryChange: () => () => {},
} as ExtensionRegistryService);

/** Core's selection moves -- and its own ownership prompt settles, so each
 *  step below is heard for the event it is (not a later one's). */
async function moveCoreSelectionTo(row: number, col: number): Promise<void> {
  const sel = { startRow: row, startCol: col, endRow: row, endCol: col, type: "cells" } as Selection;
  selectionListeners.forEach((l) => l(sel));
  await settle();
}

/** Is the contextual tab registered right now, per the calls made? */
function tabIsShown(): boolean {
  const events = [
    ...h.registerPanel.mock.calls
      .map((c, i) => ({ id: (c[0] as { id: string }).id, n: h.registerPanel.mock.invocationCallOrder[i], on: true })),
    ...h.unregisterPanel.mock.calls
      .map((c, i) => ({ id: c[0] as string, n: h.unregisterPanel.mock.invocationCallOrder[i], on: false })),
  ]
    .filter((e) => e.id === TABLE_DESIGN_TAB_ID)
    .sort((a, b) => a.n - b.n);
  return events.length > 0 ? events[events.length - 1].on : false;
}

/** Let the ownership re-ask (one microtask) and anything it starts settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await Promise.resolve();
}

/** Every door of the context inert. */
function inertContext(): never {
  const inert = (): unknown =>
    new Proxy(() => () => {}, {
      get: (_t, prop) => (prop === "then" ? undefined : inert()),
      apply: () => () => {},
    });
  return inert() as never;
}

let owns = false;
let releaseOwner: () => void = () => {};

/** A floating grid's cell takes (or gives back) the selection: its OBJECT selection changes. */
async function ownerClaims(claim: boolean): Promise<void> {
  owns = claim;
  notifyObjectSelectionChanged();
  await settle();
}

beforeEach(() => {
  h.registerPanel.mockClear();
  h.unregisterPanel.mockClear();
  h.snapshot = null;
  h.tables = [
    {
      id: "t1",
      name: "Table1",
      sheetIndex: 0,
      startRow: 0,
      startCol: 0,
      endRow: 3,
      endCol: 2,
      columns: [{ name: "A" }, { name: "B" }, { name: "C" }],
      styleOptions: { headerRow: true, totalRow: false },
    },
  ];
  owns = false;
  releaseOwner = registerSelectionOwner({
    id: "test-floating-grid",
    label: "a floating grid's cells",
    ownsSelection: () => owns,
  });
  extension.activate(inertContext());
});

afterEach(() => {
  extension.deactivate?.();
  releaseOwner();
});

describe("Table Design stands aside while a selection owner holds the selection", () => {
  it("hides when the claim starts and returns when it ends, Core's selection unmoved", async () => {
    await moveCoreSelectionTo(1, 1);
    expect(tabIsShown(), "positive control: the active cell is in a table").toBe(true);

    await ownerClaims(true);
    expect(tabIsShown(), "the tab stayed up for a table cell hidden under the owner").toBe(false);

    await ownerClaims(false);
    expect(tabIsShown(), "the tab did not come back when the claim ended").toBe(true);
  });

  it("stays hidden while claimed, even if Core's selection moves inside a table meanwhile", async () => {
    await moveCoreSelectionTo(1, 1);
    await ownerClaims(true);
    await moveCoreSelectionTo(2, 2);
    expect(tabIsShown()).toBe(false);
  });

  it("a table created while claimed does not bring the tab up", async () => {
    await moveCoreSelectionTo(10, 10);
    await ownerClaims(true);
    window.dispatchEvent(new Event("app:table-created"));
    await settle();
    expect(tabIsShown()).toBe(false);
  });

  // Wave C review of W22 (the Sparkline finding, same class here): the
  // re-derive after a claim asked only the handler's last-checked cell. A table
  // CREATE shows the tab without the handler ever having heard Core's selection
  // (the extension activated after it was set), so the tab stayed hidden after
  // the claim ended, until the user moved the cursor.
  it("the tab a table CREATE showed comes back when the claim ends (Core's active cell from the grid state)", async () => {
    h.snapshot = { selection: { startRow: 1, startCol: 1, endRow: 1, endCol: 1, type: "cells" } };
    window.dispatchEvent(new Event("app:table-created"));
    await settle();
    expect(tabIsShown(), "positive control: the create shows the tab").toBe(true);

    await ownerClaims(true);
    expect(tabIsShown()).toBe(false);
    await ownerClaims(false);
    expect(tabIsShown(), "the tab a table create showed did not come back when the claim ended").toBe(true);
  });

  it("positive control: a claim while the active cell is NOT in a table changes nothing", async () => {
    await moveCoreSelectionTo(10, 10);
    expect(tabIsShown()).toBe(false);
    await ownerClaims(true);
    await ownerClaims(false);
    expect(tabIsShown()).toBe(false);
  });

  it("after deactivate an ownership change no longer reaches the tab", async () => {
    await moveCoreSelectionTo(1, 1);
    extension.deactivate?.();
    h.registerPanel.mockClear();
    h.unregisterPanel.mockClear();
    await ownerClaims(true);
    await ownerClaims(false);
    expect(h.registerPanel).not.toHaveBeenCalled();
    extension.activate(inertContext());
  });
});

// Found live 2026-09-29 (e2e fixall-pivot CTX): the handler skips the cell it
// checked last, keyed on row and column ALONE, so coming back to B2 on a sheet
// with no table -- the same coordinates, a different cell -- asked nothing and
// Sheet1's Table Design tab stayed up on a pivot's sheet.
describe("Table Design follows the SHEET, not only the coordinates", () => {
  it("the same coordinates on a sheet without the table hide the tab once the new sheet is checked", async () => {
    h.snapshot = { selection: { startRow: 1, startCol: 1, endRow: 1, endCol: 1, type: "cells" } };
    await moveCoreSelectionTo(1, 1);
    expect(tabIsShown(), "positive control: B2 is in Sheet1's table").toBe(true);

    // The other sheet: its table cache holds none, and Core's cell is B2 again.
    h.tables = [];
    await moveCoreSelectionTo(1, 1);
    expect(tabIsShown(), "precondition: the same-cell skip alone keeps the stale tab").toBe(true);
    recheckDesignTabAfterSheetChange();
    expect(tabIsShown(), "Sheet1's Table Design tab stayed up on a sheet with no table under B2").toBe(false);
  });

  it("the same coordinates on a sheet WITH a table there show it", async () => {
    await moveCoreSelectionTo(10, 10);
    expect(tabIsShown()).toBe(false);
    h.snapshot = { selection: { startRow: 10, startCol: 10, endRow: 10, endCol: 10, type: "cells" } };
    h.tables = [{ ...h.tables[0], id: "t2", name: "Table2", sheetIndex: 1, startRow: 9, startCol: 9, endRow: 12, endCol: 11 }];
    recheckDesignTabAfterSheetChange();
    expect(tabIsShown(), "the new sheet's table under the same cell did not bring the tab up").toBe(true);
  });

  it("a sheet with no cell selection at all (a canvas) hides it", async () => {
    await moveCoreSelectionTo(1, 1);
    expect(tabIsShown()).toBe(true);
    h.snapshot = null;
    recheckDesignTabAfterSheetChange();
    expect(tabIsShown()).toBe(false);
  });

  it("the SHEET_CHANGED handler re-derives AFTER the new sheet's tables are cached", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../index.ts"), "utf8");
    const at = src.indexOf("AppEvents.SHEET_CHANGED");
    expect(at, "the extension no longer listens for SHEET_CHANGED").toBeGreaterThan(0);
    const block = src.slice(at, at + 400);
    expect(block).toMatch(/refreshCache\(\)\s*\.then\(\(\) => recheckDesignTabAfterSheetChange\(\)\)/);
  });
});
