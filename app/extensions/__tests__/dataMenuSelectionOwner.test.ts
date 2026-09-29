//! FILENAME: app/extensions/__tests__/dataMenuSelectionOwner.test.ts
// PURPOSE: The Data- and Insert-menu doors whose TARGET is Core's selection --
//          Sort A to Z / Z to A / Custom Sort, Remove Duplicates, Text to
//          Columns, Subtotals, Consolidate, Data Form, What-If Data Table, Goal
//          Seek, Data Validation, Advanced Filter, Insert Sparklines -- refuse
//          with ONE toast and open/sort nothing while a selection owner holds
//          the selection; they act when nothing does. The sheet-level items of
//          the same menus (Circle Invalid Data) are not refused.
// CONTEXT: D4 (wa-keys fixup, "audit for others"; BUG-0185 class). With a
//          floating grid's cell selected, Core's selection is HIDDEN under the
//          floating grid, and every one of these derived its range, its active
//          cell or its dialog's prefilled target from THAT selection -- Sort
//          A to Z sorted the data around a cell the user could not see. TEST
//          owner (@api/selectionOwner). One file for the family: each door is
//          one menu action over its extension's own selection tracker.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  effects: [] as string[],
  menuItems: [] as { id: string; action?: () => unknown; children?: unknown[] }[],
  selectionSubs: new Set<(sel: unknown) => void>(),
}));
vi.mock("@api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@api")>();
  return {
    ...real,
    showDialog: (id: string) => h.effects.push(`showDialog:${id}`),
    registerMenuItem: (_menu: string, item: { id: string }) => {
      h.menuItems.push(item);
    },
    getCurrentRegion: vi.fn(async () => {
      h.effects.push("getCurrentRegion");
      return { empty: true, startRow: 0, startCol: 0, endRow: 0, endCol: 0 };
    }),
    detectDataRegion: vi.fn(async () => {
      h.effects.push("detectDataRegion");
      return null;
    }),
    // eslint-disable-next-line @typescript-eslint/naming-convention -- the real export name
    DialogExtensions: {
      ...real.DialogExtensions,
      openDialog: (id: string) => h.effects.push(`openDialog:${id}`),
    },
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
  detectDataRegion: vi.fn(async () => {
    h.effects.push("detectDataRegion");
    return null;
  }),
}));

import { registerSortMenuItems, setCurrentSelection as setSortSelection } from "../Sorting/handlers/dataMenuBuilder";
import {
  registerRemoveDuplicatesMenuItem,
  setCurrentSelection as setRemoveDuplicatesSelection,
} from "../RemoveDuplicates/handlers/dataMenuBuilder";
import {
  registerTextToColumnsMenuItem,
  setCurrentSelection as setTextToColumnsSelection,
} from "../TextToColumns/handlers/dataMenuBuilder";
import { registerSubtotalsMenuItem, setCurrentSelection as setSubtotalsSelection } from "../Subtotals/handlers/dataMenuBuilder";
import { registerConsolidateMenuItem, setCurrentSelection as setConsolidateSelection } from "../Consolidate/handlers/dataMenuBuilder";
import { registerDataFormMenuItem, setCurrentSelection as setDataFormSelection } from "../DataForm/handlers/dataMenuBuilder";
import { registerDataTableMenuItems, setCurrentSelection as setDataTableSelection } from "../DataTables/handlers/dataMenuBuilder";
import { registerGoalSeekMenuItem, setCurrentSelection as setGoalSeekSelection } from "../GoalSeek/handlers/dataMenuBuilder";
import { registerDataValidationMenuItems } from "../DataValidation/handlers/dataMenuBuilder";
import AdvancedFilterExtension from "../AdvancedFilter";
import SparklinesExtension from "../Sparklines";
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

/** Find a menu action anywhere in the recorded items (children included). */
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
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

beforeAll(async () => {
  const ctx = recordingContext();
  registerSortMenuItems(ctx);
  registerRemoveDuplicatesMenuItem(ctx);
  registerTextToColumnsMenuItem(ctx);
  registerSubtotalsMenuItem();
  registerConsolidateMenuItem(ctx);
  registerDataFormMenuItem(ctx);
  registerDataTableMenuItems(ctx);
  registerGoalSeekMenuItem(ctx);
  registerDataValidationMenuItems(ctx);
  await AdvancedFilterExtension.activate(recordingContext());
  await SparklinesExtension.activate(recordingContext());

  const sel = { startRow: 2, endRow: 6, startCol: 1, endCol: 3, activeRow: 2, activeCol: 1 };
  setSortSelection(sel);
  setRemoveDuplicatesSelection(sel);
  setTextToColumnsSelection(sel);
  setSubtotalsSelection(sel);
  setConsolidateSelection(sel);
  setDataFormSelection(sel);
  setDataTableSelection(sel);
  setGoalSeekSelection(sel);
  for (const cb of h.selectionSubs) cb({ ...sel, type: "cells" });
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

/** [label, menu item id, the effect its door has when it acts] */
const DOORS: [string, string, string][] = [
  ["Data > Sort A to Z", "data:sort:ascending", "detectDataRegion"],
  ["Data > Sort Z to A", "data:sort:descending", "detectDataRegion"],
  ["Data > Custom Sort...", "data:sort:custom", "dialogs.show:sort-dialog"],
  ["Data > Remove Duplicates...", "data:removeDuplicates", "dialogs.show:remove-duplicates"],
  ["Data > Text to Columns...", "data:textToColumns", "dialogs.show:text-to-columns"],
  ["Data > Outline > Subtotals...", "data:outline:subtotals", "openDialog:subtotals"],
  ["Data > Consolidate...", "data:consolidate", "dialogs.show:consolidate"],
  ["Data > Data Form...", "data:dataForm", "getCurrentRegion"],
  ["Data > What-If > Data Table...", "data:whatIf:dataTable", "dialogs.show:data-table"],
  ["Data > What-If > Goal Seek...", "data:whatIf:goalSeek", "dialogs.show:goal-seek"],
  ["Data > Validation > Data Validation...", "data:validation:dataValidation", "showDialog:data-validation-dialog"],
  ["Data > Advanced...", "data:advancedFilter", "showDialog:advanced-filter-dialog"],
  ["Insert > Sparklines > Line", "insert.sparklines.line", "dialogs.show:sparkline:createDialog"],
  ["Insert > Sparklines > Column", "insert.sparklines.column", "dialogs.show:sparkline:createDialog"],
  ["Insert > Sparklines > Win/Loss", "insert.sparklines.winloss", "dialogs.show:sparkline:createDialog"],
];

describe("Data / Insert menu doors while a selection owner holds the selection", () => {
  for (const [label, id] of DOORS) {
    it(`${label}: nothing opened, read or sorted from Core's hidden selection; one toast`, async () => {
      owns = true;
      await action(id)();
      await settle();
      expect(h.effects, `${label} acted on Core's hidden selection`).toEqual([]);
      expect(refusals().length).toBe(1);
    });
  }

  it("a sheet-level item of the same menu is not refused: Circle Invalid Data", async () => {
    owns = true;
    await action("data:validation:circleInvalidData")();
    await settle();
    expect(refusals()).toEqual([]);
  });
});

describe("positive controls: nothing owns the selection", () => {
  for (const [label, id, effect] of DOORS) {
    it(`${label}: acts (${effect}), no refusal`, async () => {
      await action(id)();
      await settle();
      expect(h.effects[0]).toBe(effect);
      expect(refusals()).toEqual([]);
    });
  }
});
