//! FILENAME: app/extensions/__tests__/analysisDoorsSelectionOwner.test.ts
// PURPOSE: More doors whose TARGET is Core's selection -- Data > What-If >
//          Solver (objective cell), Formulas > Ask for a Formula and the
//          formulaAssist.open command (writes a formula into the active cell),
//          Model > Report from Design Query (anchored at the active cell) and
//          Writeback > Designate Writeback Region (the selected range) --
//          refuse with ONE toast and open nothing while a selection owner holds
//          the selection; they act when nothing does. Scenario Manager is a
//          workbook-level list and is not refused.
// CONTEXT: D4 (wa-keys fixup, "audit for others"; BUG-0185 class). With a
//          floating grid's cell selected, Core's selection is HIDDEN under the
//          floating grid, and each of these started from THAT selection. TEST
//          owner (@api/selectionOwner).

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  effects: [] as string[],
  menuItems: [] as { id: string; action?: () => unknown; children?: unknown[] }[],
  commands: new Map<string, (args?: unknown) => unknown>(),
  selectionSubs: new Set<(sel: unknown) => void>(),
}));
const SELECTION = { startRow: 3, startCol: 1, endRow: 5, endCol: 2, type: "cells" };

vi.mock("@api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@api")>();
  return {
    ...real,
    showDialog: (id: string) => h.effects.push(`showDialog:${id}`),
    registerMenuItem: (_menu: string, item: { id: string }) => {
      h.menuItems.push(item);
    },
    getSheets: vi.fn(async () => ({ sheets: [], activeIndex: 0 })),
    // eslint-disable-next-line @typescript-eslint/naming-convention -- the real export name
    ExtensionRegistry: {
      ...real.ExtensionRegistry,
      onSelectionChange: (cb: (sel: unknown) => void) => {
        h.selectionSubs.add(cb);
        return () => h.selectionSubs.delete(cb);
      },
    },
  };
});
vi.mock("@api/lib", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/lib")>()),
  getSheets: vi.fn(async () => ({ sheets: [], activeIndex: 0 })),
}));
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => ({
    selection: SELECTION,
    sheetContext: { activeSheetIndex: 0, activeSheetName: "Sheet1" },
    surface: "grid",
  }),
}));
vi.mock("../FormulaAssist/lib/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../FormulaAssist/lib/store")>()),
  openAssist: () => h.effects.push("openAssist"),
}));

import { registerSolverMenuItems, setCurrentSelection as setSolverSelection } from "../Solver/handlers/dataMenuBuilder";
import {
  registerScenarioMenuItems,
  setCurrentSelection as setScenarioSelection,
} from "../ScenarioManager/handlers/dataMenuBuilder";
import FormulaAssistExtension from "../FormulaAssist";
import ReportsExtension from "../Reports";
import { designateWritebackRegion } from "../Collaboration/lib/designateWritebackRegion";
import { registerSelectionOwner } from "@api/selectionOwner";
import { registerToastSink, type ToastPayload } from "@api/notifications";

const toasts: ToastPayload[] = [];
let owns = false;
let release: () => void = () => {};

/** Every door inert, except menus / commands (recorded) and dialogs.show (an effect). */
function recordingContext(): never {
  const inert = (path: string): unknown =>
    new Proxy(() => () => {}, {
      get: (_t, prop) => (prop === "then" ? undefined : inert(`${path}.${String(prop)}`)),
      apply: (_t, _this, args: unknown[]) => {
        if (path === ".ui.menus.registerItem") h.menuItems.push(args[1] as { id: string });
        if (path === ".ui.dialogs.show") h.effects.push(`dialogs.show:${String(args[0])}`);
        if (path === ".commands.register") h.commands.set(args[0] as string, args[1] as () => unknown);
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

const writebackContext = recordingContext();

beforeAll(async () => {
  const ctx = recordingContext();
  registerSolverMenuItems(ctx);
  registerScenarioMenuItems(ctx);
  await FormulaAssistExtension.activate(recordingContext());
  await ReportsExtension.activate(recordingContext());
  const sel = { ...SELECTION, activeRow: 3, activeCol: 1 };
  setSolverSelection(sel);
  setScenarioSelection(sel);
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
  ["Data > What-If > Solver...", () => action("data:whatIf:solver")(), "dialogs.show:solver"],
  ["Formulas > Ask for a Formula...", () => action("formulaAssist.menu")(), "openAssist"],
  ["formulaAssist.open", () => h.commands.get("formulaAssist.open")!(), "openAssist"],
  ["Model > Report from Design Query...", () => action("model:createReport")(), "showDialog:create-report-dialog"],
  [
    "Writeback > Designate Writeback Region...",
    () => designateWritebackRegion(writebackContext, SELECTION, async () => "sheet-1"),
    "dialogs.show:collaboration:designateWritebackDialog",
  ],
];

describe("selection doors while a selection owner holds the selection", () => {
  for (const [label, open] of DOORS) {
    it(`${label}: nothing opened on Core's hidden selection; one toast`, async () => {
      owns = true;
      await open();
      await settle();
      expect(h.effects, `${label} acted on Core's hidden selection`).toEqual([]);
      expect(refusals().length).toBe(1);
    });
  }

  it("Scenario Manager is a workbook-level list: not refused", async () => {
    owns = true;
    await action("data:whatIf:scenarioManager")();
    await settle();
    expect(h.effects).toEqual(["dialogs.show:scenario-manager"]);
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
