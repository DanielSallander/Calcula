//! FILENAME: app/extensions/Pivot/handlers/__tests__/hasDesignQueryDrill.test.ts
// PURPOSE: "Has this pivot a design-query drill?" -- the fact the value-cell
//          menu's run row is labelled by ("Drill through" / "Show Details",
//          docs/design/model-drillthrough.md 2.9) -- over the REAL
//          selectionHandler and, for the label, the REAL pivotContextMenu
//          registration (only the actions and the backend channel are doubled):
//          - REGION-FIRST. The answer is the cached region's
//            `hasDesignQueryDrill`, which rides the region transport beside
//            `isModel` (Rust fills it where the regions are built). It is
//            synchronous and needs NO backend read, so the very first
//            right-click on a pivot that was never selected -- a canvas box,
//            whose menu is built once from static DOM; a worksheet pivot the
//            cursor is not in -- already says "Drill through". The review
//            finding this pins (first-right-click-label-cold-cache): a
//            read-through cache, cleared on every region update and filled
//            only for the ACTIVE pivot, answered "Show Details" there.
//          - A dialog SAVE overrides the region at once (without changing the
//            region object the regions event handed every other listener),
//            and the next region update brings back what Rust reports.
//          - No region (never synced, another sheet, after deactivate) is no
//            answer, and no answer reads "Show Details": a range pivot never
//            promises a drill it does not have.
//          - Selecting a pivot reads nothing: the per-selection
//            `get_pivot_drill_behavior` IPC is gone with the cache.
//          - The wire name mirrors Rust (`has_design_query_drill` ->
//            `hasDesignQueryDrill`, always sent, so required in TS), read as
//            TEXT the way pivotTransportMirror.test.ts reads its pins.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import type { GridContextMenuItem, GridMenuContext } from "@api";

const h = vi.hoisted(() => ({
  items: [] as GridContextMenuItem[],
  surface: "grid" as string,
  invoke: vi.fn(),
}));

vi.mock("@api", () => ({
  // pivotContextMenu's registration door: the items are captured here.
  gridExtensions: {
    registerContextMenuItems: (items: GridContextMenuItem[]) => {
      h.items = items;
    },
    unregisterContextMenuItem: vi.fn(),
  },
  showDialog: vi.fn(),
  showToast: vi.fn(),
  openTaskPane: vi.fn(),
  closeTaskPane: vi.fn(),
  markTaskPaneManuallyClosed: vi.fn(),
  clearTaskPaneManuallyClosed: vi.fn(),
  getTaskPaneManuallyClosed: () => [] as string[],
  addTaskPaneContextKey: vi.fn(),
  removeTaskPaneContextKey: vi.fn(),
  registerPanel: vi.fn(),
  unregisterPanel: vi.fn(),
  emitAppEvent: vi.fn(),
  getReportPagesSnapshot: () => ({}),
  sheetIdAt: () => null,
  isSheetSubscribed: () => false,
}));
// pivot-api registers itself into the facade at load, so the facade stays
// real; only the `pivot` object the selection probe calls is doubled.
vi.mock("@api/pivot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/pivot")>()),
  pivot: { getAtCell: vi.fn(async () => null) },
}));
vi.mock("@api/layoutSurface", () => ({ getLayoutSurface: () => null }));
vi.mock("@api/events", () => ({ emitAppEvent: vi.fn() }));
vi.mock("@api/dialogs", () => ({ confirmAsync: vi.fn(), promptAsync: vi.fn() }));
vi.mock("@api/grid", () => ({ getGridStateSnapshot: () => ({ surface: h.surface, selection: null }) }));
vi.mock("@api/commands", () => ({
  CommandRegistry: { has: () => false, execute: vi.fn(() => Promise.resolve()) },
}));
vi.mock("../../manifest", () => ({
  PIVOT_GROUP_DIALOG_ID: "g",
  PIVOT_FIELD_SETTINGS_DIALOG_ID: "fs",
  PIVOT_OPTIONS_DIALOG_ID: "o",
  PIVOT_DRILL_BEHAVIOR_DIALOG_ID: "d",
  PIVOT_PANE_ID: "pivot-pane",
  PIVOT_ANALYZE_TAB_ID: "pivot-analyze",
  PIVOT_DESIGN_TAB_ID: "pivot-design",
  PivotAnalyzePanelDefinition: { id: "pivot-analyze", title: "Analyze" },
  PivotDesignPanelDefinition: { id: "pivot-design", title: "Design" },
}));
// The Pivot channel: every backend read this test could cause lands here.
vi.mock("../../lib/pivotBackend", () => ({
  pivotBackend: { invoke: (...a: unknown[]) => h.invoke(...a) },
}));
vi.mock("../../lib/pivotCellDoubleClick", () => ({ runPivotDrillThrough: vi.fn() }));
vi.mock("../../lib/valueFieldEdits", () => ({ editPivotValueField: vi.fn(() => Promise.resolve()) }));
vi.mock("../../lib/valueFieldDialogRequest", () => ({ requestValueFieldDialog: vi.fn(() => Promise.resolve()) }));

import { registerPivotContextMenuItems, DRILL_THROUGH_LABEL, SHOW_DETAILS_LABEL } from "../pivotContextMenu";
import {
  getActivePivotId,
  getCachedRegions,
  handleSelectionChange,
  hasDesignQueryDrill,
  noteDrillBehaviorSaved,
  resetSelectionHandlerState,
  selectPivotVisual,
  updateCachedRegions,
} from "../selectionHandler";
import type { PivotRegionData } from "../../types";

const DEF = { dslText: "ROWS: Geo.Region\nVALUES: [Revenue]", presentation: { kind: "table" as const } };

/** A model pivot at rows 10..14, cols 2..5; `hasDesignQueryDrill` as Rust reports it. */
function region(pivotId: string, extra: Partial<PivotRegionData> = {}): PivotRegionData {
  return {
    pivotId,
    name: pivotId,
    startRow: 10,
    startCol: 2,
    endRow: 14,
    endCol: 5,
    isEmpty: false,
    isModel: true,
    hasDesignQueryDrill: false,
    ...extra,
  };
}

/** A right-click on the pivot's value cell (row 12, col 4), on the current surface. */
function ctxAt(row = 12, col = 4): GridMenuContext {
  return {
    selection: { startRow: row, startCol: col, endRow: row, endCol: col, type: "cells" },
    clickedCell: { row, col },
    isWithinSelection: true,
    sheetIndex: 0,
    sheetName: "Sheet1",
    dimensions: {} as GridMenuContext["dimensions"],
  } as GridMenuContext;
}

/** The run row's label exactly as the menu resolves it (the registered item's own label function). */
function runRowLabel(ctx: GridMenuContext): string {
  const item = h.items.find((i) => i.id === "pivot:showDetails");
  if (!item) throw new Error("the value-cell run row is not registered");
  return typeof item.label === "function" ? item.label(ctx) : item.label;
}

/** The `get_pivot_drill_behavior` reads the Pivot channel was asked for. */
function drillBehaviorReads(): unknown[][] {
  return h.invoke.mock.calls.filter((c) => c[0] === "get_pivot_drill_behavior");
}

beforeEach(() => {
  resetSelectionHandlerState();
  vi.clearAllMocks();
  h.invoke.mockResolvedValue(null);
  h.surface = "grid";
  h.items = [];
  registerPivotContextMenuItems();
});

afterEach(() => {
  // Clears the selection probe's debounce timer, so nothing runs into the next test.
  resetSelectionHandlerState();
});

describe("region-first: the fact rides the region transport beside isModel", () => {
  it("a pivot that was NEVER selected reads 'Drill through' on its first right-click, with no backend read", () => {
    // SABOTAGE: answer from a read-through cache filled only for the active
    // pivot (the pre-fix shape) -- this first right-click reads "Show Details".
    updateCachedRegions([region("p1", { hasDesignQueryDrill: true })]);
    expect(getActivePivotId(), "precondition: nothing selected the pivot").toBeNull();

    expect(hasDesignQueryDrill("p1")).toBe(true);
    expect(runRowLabel(ctxAt())).toBe(DRILL_THROUGH_LABEL);
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("a canvas box's once-built menu gets the same answer from the same region", () => {
    h.surface = "canvas";
    updateCachedRegions([region("cp1", { startCol: 1024, endCol: 1027, hasDesignQueryDrill: true })]);
    expect(runRowLabel(ctxAt(12, 1025))).toBe(DRILL_THROUGH_LABEL);
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("a pivot whose region says false -- a model pivot without a definition, a range pivot -- reads 'Show Details'", () => {
    updateCachedRegions([region("p1", { hasDesignQueryDrill: false })]);
    expect(hasDesignQueryDrill("p1")).toBe(false);
    expect(runRowLabel(ctxAt())).toBe(SHOW_DETAILS_LABEL);

    updateCachedRegions([region("r1", { isModel: false, hasDesignQueryDrill: false })]);
    expect(hasDesignQueryDrill("r1")).toBe(false);
    expect(runRowLabel(ctxAt())).toBe(SHOW_DETAILS_LABEL);
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("each pivot answers for itself: two boxes on one sheet are told apart by their own regions", () => {
    updateCachedRegions([
      region("a", { hasDesignQueryDrill: true }),
      region("b", { startRow: 30, endRow: 34, hasDesignQueryDrill: false }),
    ]);
    expect(runRowLabel(ctxAt(12, 4))).toBe(DRILL_THROUGH_LABEL);
    expect(runRowLabel(ctxAt(32, 4))).toBe(SHOW_DETAILS_LABEL);
  });

  it("no region is no answer, and no answer reads 'Show Details' -- never a promised drill", () => {
    // SABOTAGE: treat an unknown pivot as having a drill -- a range pivot's
    // value cell would promise a drill it does not have.
    expect(hasDesignQueryDrill("ghost")).toBeUndefined();
    expect(runRowLabel(ctxAt())).toBe(SHOW_DETAILS_LABEL);
    // A region that does not carry the fact is no answer either.
    updateCachedRegions([{ ...region("p1"), hasDesignQueryDrill: undefined } as unknown as PivotRegionData]);
    expect(hasDesignQueryDrill("p1")).toBeUndefined();
    expect(runRowLabel(ctxAt())).toBe(SHOW_DETAILS_LABEL);
  });

  it("selecting a pivot -- a cursor inside it, a selected canvas box -- reads nothing from the backend", () => {
    updateCachedRegions([region("p1", { hasDesignQueryDrill: true })]);
    handleSelectionChange({ endRow: 12, endCol: 4 });
    expect(getActivePivotId()).toBe("p1");
    selectPivotVisual("p1");
    expect(drillBehaviorReads()).toEqual([]);
    expect(runRowLabel(ctxAt())).toBe(DRILL_THROUGH_LABEL);
  });
});

describe("a dialog save overrides the cached region until the next region update", () => {
  it("Save with a design query makes the label 'Drill through' at once; Save without one makes it 'Show Details'", () => {
    // SABOTAGE: make noteDrillBehaviorSaved a no-op -- the menu keeps the
    // region's stale answer until something refreshes the regions.
    updateCachedRegions([region("p1", { hasDesignQueryDrill: false })]);

    noteDrillBehaviorSaved("p1", { kind: "builtin", designQuery: DEF });
    expect(hasDesignQueryDrill("p1")).toBe(true);
    expect(runRowLabel(ctxAt())).toBe(DRILL_THROUGH_LABEL);

    noteDrillBehaviorSaved("p1", null);
    expect(hasDesignQueryDrill("p1")).toBe(false);
    expect(runRowLabel(ctxAt())).toBe(SHOW_DETAILS_LABEL);

    noteDrillBehaviorSaved("p1", { kind: "query", query: { limit: 10 } });
    expect(hasDesignQueryDrill("p1")).toBe(false);
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("the save patches a COPY: the region object the regions event handed every listener is unchanged", () => {
    const shared = region("p1", { hasDesignQueryDrill: false });
    const sibling = region("p2", { startRow: 30, endRow: 34, hasDesignQueryDrill: true });
    updateCachedRegions([shared, sibling]);

    noteDrillBehaviorSaved("p1", { kind: "builtin", designQuery: DEF });

    expect(hasDesignQueryDrill("p1")).toBe(true);
    expect(shared.hasDesignQueryDrill, "the event's region object is not mutated").toBe(false);
    // The other pivot keeps its own region, untouched.
    expect(getCachedRegions()[1]).toBe(sibling);
    // Bounds and identity survive the patch: the cell still finds the pivot.
    expect(getCachedRegions()[0]).toEqual({ ...shared, hasDesignQueryDrill: true });
  });

  it("the next region update replaces the override with what Rust reports", () => {
    updateCachedRegions([region("p1", { hasDesignQueryDrill: false })]);
    noteDrillBehaviorSaved("p1", { kind: "builtin", designQuery: DEF });
    expect(hasDesignQueryDrill("p1")).toBe(true);

    updateCachedRegions([region("p1", { hasDesignQueryDrill: false })]);
    expect(hasDesignQueryDrill("p1")).toBe(false);

    updateCachedRegions([region("p1", { hasDesignQueryDrill: true })]);
    expect(hasDesignQueryDrill("p1")).toBe(true);
  });

  it("a save for a pivot with no cached region (not on this sheet) patches nothing and invents no region", () => {
    updateCachedRegions([region("p1", { hasDesignQueryDrill: false })]);
    noteDrillBehaviorSaved("elsewhere", { kind: "builtin", designQuery: DEF });
    expect(hasDesignQueryDrill("elsewhere")).toBeUndefined();
    expect(getCachedRegions().map((r) => r.pivotId)).toEqual(["p1"]);
    expect(hasDesignQueryDrill("p1")).toBe(false);
  });
});

describe("reset on deactivate", () => {
  it("resetSelectionHandlerState forgets the answer, a saved override included", () => {
    // SABOTAGE: keep the cached regions across a reset -- a reloaded
    // extension (or the next document's pivot with the same id) inherits the
    // previous pivot's label.
    updateCachedRegions([region("p1", { hasDesignQueryDrill: true })]);
    noteDrillBehaviorSaved("p1", { kind: "builtin", designQuery: DEF });
    expect(hasDesignQueryDrill("p1")).toBe(true);

    resetSelectionHandlerState();

    expect(hasDesignQueryDrill("p1")).toBeUndefined();
    expect(runRowLabel(ctxAt())).toBe(SHOW_DETAILS_LABEL);
  });
});

describe("the wire: Rust PivotRegionData.has_design_query_drill is the facade's hasDesignQueryDrill", () => {
  const APP = path.resolve(__dirname, "../../../..");
  const read = (rel: string) => fs.readFileSync(path.join(APP, rel), "utf8").replace(/\r\n/g, "\n");

  /** The text between the `{` after `head` and its matching `}`. */
  function bodyAfter(source: string, head: string): string {
    const start = source.indexOf(head);
    if (start < 0) throw new Error(`\`${head}\` not found`);
    const open = source.indexOf("{", start);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}" && --depth === 0) return source.slice(open + 1, i);
    }
    throw new Error(`unterminated body after \`${head}\``);
  }

  /**
   * Whether Rust's PivotRegionData sends `has_design_query_drill` ALWAYS:
   * the struct renames at the struct level (camelCase), the field is a
   * `bool` with `#[serde(default)]`, and it carries neither
   * `skip_serializing_if` (a false answer would then be ABSENT on the wire
   * and read as "not known") nor a per-field rename.
   */
  function sentAlways(rustSrc: string): boolean {
    const head = "pub struct PivotRegionData";
    const before = rustSrc.slice(Math.max(0, rustSrc.indexOf(head) - 200), rustSrc.indexOf(head));
    if (!/#\[serde\(rename_all = "camelCase"\)\]\s*$/.test(before)) return false;
    const lines = bodyAfter(rustSrc, head).split("\n");
    const at = lines.findIndex((l) => /^\s*pub\s+has_design_query_drill\s*:\s*bool\s*,/.test(l));
    if (at < 0) return false;
    const attrs: string[] = [];
    for (let i = at - 1; i >= 0; i--) {
      const t = lines[i].trim();
      if (t.startsWith("#[")) attrs.push(t);
      else if (t.startsWith("///") || t === "") continue;
      else break;
    }
    return (
      attrs.some((a) => /serde\(\s*default\s*\)/.test(a)) &&
      !attrs.some((a) => a.includes("skip_serializing_if")) &&
      !attrs.some((a) => /rename\s*=/.test(a))
    );
  }

  it("Rust sends the field ALWAYS (a default, never skipped) under the struct-level camelCase rename", () => {
    expect(sentAlways(read("src-tauri/src/pivot/types.rs"))).toBe(true);
  });

  it("non-vacuity: the scan refuses a skipped, renamed, defaultless or missing field", () => {
    const struct = (field: string) =>
      `#[derive(Debug)]\n#[serde(rename_all = "camelCase")]\npub struct PivotRegionData {\n    pub is_model: bool,\n${field}    pub style: Option<u8>,\n}\n`;
    expect(sentAlways(struct("    #[serde(default)]\n    pub has_design_query_drill: bool,\n"))).toBe(true);
    expect(
      sentAlways(struct('    #[serde(default, skip_serializing_if = "std::ops::Not::not")]\n    pub has_design_query_drill: bool,\n')),
    ).toBe(false);
    expect(sentAlways(struct('    #[serde(default)]\n    #[serde(rename = "drill")]\n    pub has_design_query_drill: bool,\n'))).toBe(false);
    expect(sentAlways(struct("    pub has_design_query_drill: bool,\n"))).toBe(false);
    expect(sentAlways(struct(""))).toBe(false);
  });

  it("the facade's PivotRegionData carries hasDesignQueryDrill as a REQUIRED boolean (the Pivot extension re-exports it)", () => {
    const ts = bodyAfter(read("src/api/pivotTypes.ts"), "export interface PivotRegionData")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(ts).toMatch(/^\s*hasDesignQueryDrill\s*:\s*boolean\s*;/m);
    expect(ts).not.toMatch(/^\s*hasDesignQueryDrill\?\s*:/m);
    expect(read("extensions/Pivot/types.ts")).toMatch(/export\s+type\s*\{\s*PivotRegionData\s*\}/);
  });
});
