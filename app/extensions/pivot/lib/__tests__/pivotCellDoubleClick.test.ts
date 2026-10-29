//! FILENAME: app/extensions/Pivot/lib/__tests__/pivotCellDoubleClick.test.ts
// PURPOSE: The ONE double-click implementation both pivot surfaces call
//          (worksheet interceptor, canvas box `onDoubleClick`), WP-A S8:
//          - TOGGLE. An expandable row header toggles by its GROUP PATH (the
//            identity the backend matches exactly), with the item KEY as the
//            fallback name (`pivotCellItemKey`: member.key, else the raw value
//            as invariant text -- a numeric year header with an empty
//            formattedValue sends "2013", BUG-0454, and a formatted one sends
//            its key, never its display); a failure is a TOAST, never console-only (BUG-0457,
//            BUG-0096). The refresh follows the toggle, never a failed one.
//          - DRILL. A data / total cell runs `runPivotDrillThrough`, the
//            extracted drill: drill_through_to_sheet with the cell's groupPath,
//            the new sheet activated and announced; a script-mode pivot whose
//            mounted script handles the drill gets the hook instead; a failure
//            is a toast.
//          - DESIGN-QUERY DRILL (model-drillthrough.md 2.9). A behaviour with
//            a `designQuery` WINS over its kind: the cell's group path goes to
//            the backend's `pivotContext` op for member KEYS, and the shared
//            runner gets the pivot as the source over this extension's bound
//            channel -- never drill_through_to_sheet, never the script hook.
//            The answer's clicked PATH and the pivot's STANDING filters go to
//            the runner apart, exactly as answered (never re-split by the
//            groupPath's length), and its notices go only into the datum: the
//            runner tells them once, after the sheet landed, so nothing here
//            toasts them before the run. A failed op is a toast and nothing else.
//          - Anything else means nothing (false, no request).

import { describe, it, expect, vi, beforeEach } from "vitest";

const api = vi.hoisted(() => ({
  showToast: vi.fn(),
  emitAppEvent: vi.fn(),
  activateSheet: vi.fn(async () => undefined),
  togglePivotGroup: vi.fn(async () => ({})),
  getPivotDataFormula: vi.fn(),
  drillThroughToSheet: vi.fn(),
  getPivotDrillBehavior: vi.fn(),
  getScript: vi.fn(),
  isScriptMounted: vi.fn(),
  mountedScriptHasHook: vi.fn(),
  // The design-query drill's doors: the Pivot channel, the shared runner,
  // the notice surfacing, the active sheet and the cached regions.
  invoke: vi.fn(),
  runDrillThrough: vi.fn(),
  surfacePivotNotices: vi.fn(),
  regions: [] as Array<{ pivotId: string; name: string }>,
  activeSheetIndex: 2,
}));

vi.mock("@api", () => ({
  AppEvents: { SHEET_CHANGED: "app:sheet-changed" },
  showToast: api.showToast,
  ObjectScriptManager: { getScript: api.getScript, isScriptMounted: api.isScriptMounted },
  mountedScriptHasHook: api.mountedScriptHasHook,
}));

vi.mock("@api/events", () => ({ emitAppEvent: api.emitAppEvent }));
// THROUGH THE SEAM: a backend-only switch left the pivot's cells painted
// on the new sheet (owner, 2026-10-29).
vi.mock("@api/sheetSwitch", () => ({ activateSheet: api.activateSheet }));
vi.mock("@api/grid", () => ({
  getGridStateSnapshot: () => ({ sheetContext: { activeSheetIndex: api.activeSheetIndex } }),
}));
vi.mock("@api/pivotNotices", () => ({ surfacePivotNotices: api.surfacePivotNotices }));
vi.mock("../pivotBackend", () => ({ pivotBackend: { invoke: api.invoke } }));
vi.mock("../../handlers/selectionHandler", () => ({ getCachedRegions: () => api.regions }));
vi.mock("../../../_shared/drillThrough/runDrillThrough", () => ({ runDrillThrough: api.runDrillThrough }));

vi.mock("../pivot-api", () => ({
  togglePivotGroup: api.togglePivotGroup,
  getPivotDataFormula: api.getPivotDataFormula,
  drillThroughToSheet: api.drillThroughToSheet,
  getPivotDrillBehavior: api.getPivotDrillBehavior,
  getCellDisplayValue: (v: unknown) =>
    v == null ? "" : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v),
  isTotalCell: (t: string) =>
    ["RowSubtotal", "ColumnSubtotal", "GrandTotal", "GrandTotalRow", "GrandTotalColumn"].includes(t),
}));

import { runPivotCellDoubleClick, runPivotDrillThrough } from "../pivotCellDoubleClick";
import { pivotCellItemKey } from "@api/pivotMembers";
import type { PivotCellData } from "../pivot-api";

function cell(extra: Partial<PivotCellData>): PivotCellData {
  return { cellType: "Data", value: null, backgroundStyle: "Normal", ...extra } as PivotCellData;
}

/** Let the background async work (toggle / drill IIFE) run to its end. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

let refreshes = 0;
const onRefresh = (): void => {
  refreshes += 1;
};

beforeEach(() => {
  vi.clearAllMocks();
  api.togglePivotGroup.mockImplementation(async () => ({}));
  api.activateSheet.mockImplementation(async () => undefined);
  api.getPivotDrillBehavior.mockResolvedValue({ kind: "builtin" });
  api.drillThroughToSheet.mockResolvedValue({ sheetName: "Details1", sheetIndex: 4, rowCount: 3 });
  refreshes = 0;
  window.removeEventListener("pivot:refresh", onRefresh);
  window.addEventListener("pivot:refresh", onRefresh);
});

describe("pivotCellItemKey (the identity a toggle names; pivotCellLabel is deleted)", () => {
  it("is the member KEY when the backend attached one, never the formatted or localised text", () => {
    expect(pivotCellItemKey(cell({ cellType: "RowHeader", value: 2013, formattedValue: "FY2013" }))).toBe("2013");
    expect(
      pivotCellItemKey(cell({ cellType: "RowHeader", value: 1234.5, member: { key: "1234.5", label: "1234,5" } })),
    ).toBe("1234.5");
    // The blank member: key "" (ruling Q8), whatever its label reads.
    expect(pivotCellItemKey(cell({ cellType: "RowHeader", value: "(blank)", member: { key: "", label: "(Blank)" } }))).toBe("");
  });

  it("falls back to the raw value: a text label and an unformatted numeric header (BUG-0454)", () => {
    expect(pivotCellItemKey(cell({ cellType: "RowHeader", value: "Europe", formattedValue: "" }))).toBe("Europe");
    expect(pivotCellItemKey(cell({ cellType: "RowHeader", value: 2013 }))).toBe("2013");
    expect(pivotCellItemKey(cell({ cellType: "RowHeader", value: null }))).toBe("");
  });
});

describe("double-click toggle on an expandable row header", () => {
  it("toggles by the cell's GROUP PATH with the label fallback for a numeric header, then refreshes", async () => {
    const header = cell({
      cellType: "RowHeader",
      isExpandable: true,
      value: 2013,
      formattedValue: "",
      indentLevel: 1,
      groupPath: [
        [0, 3],
        [1, 7],
      ],
    });

    expect(runPivotCellDoubleClick("p1", header, 5, 0, 0)).toBe(true);
    await settle();

    expect(api.togglePivotGroup).toHaveBeenCalledTimes(1);
    expect(api.togglePivotGroup).toHaveBeenCalledWith({
      pivotId: "p1",
      isRow: true,
      fieldIndex: 1,
      value: "2013",
      groupPath: [
        [0, 3],
        [1, 7],
      ],
    });
    expect(refreshes).toBe(1);
    expect(api.showToast).not.toHaveBeenCalled();
    expect(api.drillThroughToSheet).not.toHaveBeenCalled();
  });

  it("a text header with an empty formattedValue sends its text; indentLevel 0 takes the view column", async () => {
    const header = cell({
      cellType: "RowHeader",
      isExpandable: true,
      value: "Europe",
      formattedValue: "",
      groupPath: [[2, 0]],
    });

    runPivotCellDoubleClick("p1", header, 5, 1, 1);
    await settle();

    expect(api.togglePivotGroup).toHaveBeenCalledWith(
      expect.objectContaining({ fieldIndex: 1, value: "Europe", groupPath: [[2, 0]] }),
    );
  });

  it("an EMPTY group path is not sent (the backend would toggle the key \"\"); the label names the item", async () => {
    const header = cell({ cellType: "RowHeader", isExpandable: true, value: "Asia", groupPath: [] });

    runPivotCellDoubleClick("p1", header, 5, 0, 0);
    await settle();

    const request = api.togglePivotGroup.mock.calls[0][0] as Record<string, unknown>;
    expect(request.value).toBe("Asia");
    expect(request.groupPath).toBeUndefined();
  });

  it("a failed toggle is a TOAST naming the reason, and nothing refreshes", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    api.togglePivotGroup.mockRejectedValueOnce(new Error("Field index 4 out of range (max 1)"));
    const header = cell({ cellType: "RowHeader", isExpandable: true, value: "Europe", groupPath: [[0, 1]] });

    expect(runPivotCellDoubleClick("p1", header, 5, 0, 0)).toBe(true);
    await settle();

    expect(api.showToast).toHaveBeenCalledTimes(1);
    expect(api.showToast).toHaveBeenCalledWith("Expand/Collapse failed: Field index 4 out of range (max 1)", {
      variant: "error",
    });
    expect(refreshes).toBe(0);
  });

  it("a row header that is not expandable means nothing", async () => {
    const header = cell({ cellType: "RowHeader", value: "Leaf", groupPath: [[0, 1]] });
    expect(runPivotCellDoubleClick("p1", header, 5, 0, 0)).toBe(false);
    await settle();
    expect(api.togglePivotGroup).not.toHaveBeenCalled();
    expect(api.drillThroughToSheet).not.toHaveBeenCalled();
  });
});

describe("double-click drill on a data / total cell (runPivotDrillThrough)", () => {
  it("a data cell drills with ITS group path into a new sheet that becomes active", async () => {
    const data = cell({ cellType: "Data", value: 125, groupPath: [[0, 2], [1, 5]] });

    expect(runPivotCellDoubleClick("p1", data, 6, 1025, 1)).toBe(true);
    await settle();

    expect(api.getPivotDrillBehavior).toHaveBeenCalledWith("p1");
    expect(api.drillThroughToSheet).toHaveBeenCalledWith({ pivotId: "p1", groupPath: [[0, 2], [1, 5]] });
    // The seam announces the switch itself (SHEET_CHANGED after the grid moved).
    expect(api.activateSheet).toHaveBeenCalledWith(4, { record: false });
    expect(api.emitAppEvent).not.toHaveBeenCalledWith("app:sheet-changed", { sheetIndex: 4 });
    expect(api.togglePivotGroup).not.toHaveBeenCalled();
    expect(api.showToast).not.toHaveBeenCalled();
  });

  it("a grand total drills with an empty path (the whole source)", async () => {
    expect(runPivotCellDoubleClick("p1", cell({ cellType: "GrandTotal", value: 900 }), 9, 3, 3)).toBe(true);
    await settle();
    expect(api.drillThroughToSheet).toHaveBeenCalledWith({ pivotId: "p1", groupPath: [] });
  });

  it("is exported on its own: the same drill without a double-click", async () => {
    runPivotDrillThrough("p2", cell({ cellType: "RowSubtotal", value: 40, groupPath: [[0, 1]] }), 3, 2);
    await settle();
    expect(api.drillThroughToSheet).toHaveBeenCalledWith({ pivotId: "p2", groupPath: [[0, 1]] });
    expect(api.activateSheet).toHaveBeenCalledWith(4, { record: false });
  });

  it("a refused drill is a TOAST (BUG-0096), and no sheet is announced", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    api.drillThroughToSheet.mockRejectedValueOnce("Drill-through refused: column hidden for this role");

    runPivotDrillThrough("p1", cell({ cellType: "Data", value: 1, groupPath: [[0, 0]] }), 1, 1);
    await settle();

    expect(api.showToast).toHaveBeenCalledWith("Drill-through refused: column hidden for this role", { type: "error" });
    expect(api.emitAppEvent).not.toHaveBeenCalled();
  });

  it("a script-mode pivot whose MOUNTED script handles the drill gets the hook, with the cell's field/item pairs", async () => {
    api.getPivotDrillBehavior.mockResolvedValue({ kind: "script" });
    api.getScript.mockReturnValue({ id: "s1", name: "Drill script" });
    api.isScriptMounted.mockReturnValue(true);
    api.mountedScriptHasHook.mockReturnValue(true);
    api.getPivotDataFormula.mockResolvedValue({
      fieldItemPairs: [
        ["Sales.Region", "Europe"],
        ["Year", "2013"],
      ],
    });

    runPivotDrillThrough("p1", cell({ cellType: "Data", value: 1, groupPath: [[0, 0]] }), 7, 1026);
    // The script branch imports "@api" dynamically: more turns than settle() waits.
    await vi.waitFor(() => expect(api.emitAppEvent).toHaveBeenCalled());

    expect(api.getPivotDataFormula).toHaveBeenCalledWith(7, 1026);
    expect(api.emitAppEvent).toHaveBeenCalledWith("pivot:drillThrough", {
      pivotId: "p1",
      cell: [
        { table: "Sales", column: "Region", value: "Europe" },
        { table: "", column: "Year", value: "2013" },
      ],
    });
    expect(api.drillThroughToSheet).not.toHaveBeenCalled();
  });
});

describe("cells that mean nothing", () => {
  it.each(["ColumnHeader", "Corner", "RowLabelHeader", "Blank", "FilterLabel"])("%s -> false, no request", async (t) => {
    expect(runPivotCellDoubleClick("p1", cell({ cellType: t as PivotCellData["cellType"], value: "x" }), 0, 0, 0)).toBe(false);
    await settle();
    expect(api.togglePivotGroup).not.toHaveBeenCalled();
    expect(api.drillThroughToSheet).not.toHaveBeenCalled();
    expect(api.getPivotDrillBehavior).not.toHaveBeenCalled();
  });
});

describe("design-query drill (model-drillthrough.md 2.9): a behaviour with a designQuery WINS", () => {
  const def = {
    dslText: "ROWS: Geo.Region\nVALUES: [Revenue]",
    presentation: { kind: "table" as const },
    name: "Region detail",
  };
  // The C3 answer: the CLICKED PATH (`filters`) and the pivot's own STANDING
  // filters (`standing`) apart.
  const context = {
    op: "pivotContext",
    connectionId: "c1",
    filters: [{ field: "Product.Category", includedKeys: ["Bikes"], labels: ["Bikes"] }],
    standing: [{ field: "Date.Year", hiddenKeys: ["2021", "2022"] }],
    notices: [
      { kind: "degraded", message: "the filter on Geo.City was carried only in part: 1 of its 3 items name no member" },
    ],
  };

  beforeEach(() => {
    api.getPivotDrillBehavior.mockResolvedValue({ kind: "builtin", designQuery: def });
    api.invoke.mockResolvedValue(context);
    api.runDrillThrough.mockResolvedValue({ ok: true, sheetIndex: 5, sheetId: "S5", sheetName: "Region detail" });
    api.regions = [{ pivotId: "p1", name: "Sales by Region" }];
    api.activeSheetIndex = 2;
  });

  it("asks the backend for the cell's member KEYS (pivotContext) and hands the runner the pivot source, the definition, the path, the standing filters, the notices and the Pivot channel -- never drill_through_to_sheet", async () => {
    // SABOTAGE: drop the `behavior?.designQuery` branch -- drillThroughToSheet runs and the runner never does.
    runPivotDrillThrough("p1", cell({ cellType: "Data", value: 125, groupPath: [[0, 2], [1, 5]] }), 6, 1025);
    await settle();

    expect(api.invoke).toHaveBeenCalledTimes(1);
    expect(api.invoke).toHaveBeenCalledWith("drill_through", {
      request: { op: "pivotContext", pivotId: "p1", groupPath: [[0, 2], [1, 5]] },
    });
    expect(api.runDrillThrough).toHaveBeenCalledTimes(1);
    const [source, definition, datum, io] = api.runDrillThrough.mock.calls[0];
    expect(source).toEqual({ kind: "pivot", id: "p1", sheetIndex: 2, connectionId: "c1", name: "Sales by Region" });
    expect(definition).toBe(def);
    expect(datum).toEqual({
      filters: context.filters,
      standing: context.standing,
      notices: [context.notices[0].message],
    });
    expect(io.invoke).toBe(api.invoke);
    expect(api.drillThroughToSheet).not.toHaveBeenCalled();
    expect(api.activateSheet).not.toHaveBeenCalled();
    expect(api.emitAppEvent).not.toHaveBeenCalled();
    expect(api.showToast).not.toHaveBeenCalled();
  });

  it("the path and the standing filters go to the runner APART, so the runner can keep a workbook-wide standing copy out of a chart -- never the clicked path", async () => {
    // SABOTAGE: pass `{ filters: [...context.filters, ...context.standing] }`
    // (the pre-split datum) -- the runner cannot tell a standing copy of a
    // live ribbon filter from the clicked member, and bakes it into a chart.
    runPivotDrillThrough("p1", cell({ cellType: "Data", value: 125, groupPath: [[0, 2]] }), 6, 1025);
    await settle();
    const datum = api.runDrillThrough.mock.calls[0][2] as { filters: unknown[]; standing?: unknown[] };
    expect(datum.filters).toEqual(context.filters);
    expect(datum.standing).toEqual(context.standing);
  });

  it("a measure-only pivot's synthetic 'Total' coordinate gives NO path spec: the answer is passed as answered, never re-split by the groupPath's length", async () => {
    // SABOTAGE: split one combined list at groupPath.length
    // (`filters.slice(0, groupPath.length)`) -- the first standing filter is
    // taken for the clicked member and baked as if the user had clicked it.
    const measureOnly = {
      ...context,
      filters: [],
      standing: [
        { field: "Date.Year", includedKeys: ["2024"], labels: ["2024"] },
        { field: "Geo.Region", hiddenKeys: ["West"] },
      ],
    };
    api.invoke.mockResolvedValue(measureOnly);
    runPivotDrillThrough("p1", cell({ cellType: "Data", value: 900, groupPath: [[0, 0]] }), 6, 1025);
    await settle();
    const datum = api.runDrillThrough.mock.calls[0][2] as { filters: unknown[]; standing?: unknown[] };
    expect(datum.filters).toEqual([]);
    expect(datum.standing).toEqual(measureOnly.standing);
  });

  it("the notices are NOT told before the run: a drill that then fails shows the runner's refusal alone (the runner tells notices only after the sheet landed)", async () => {
    // SABOTAGE: put back the pre-run `surfacePivotNotices(context)` -- a
    // refused drill shows "the filter on Geo.City was carried only in part"
    // for a drill that never ran, then the refusal: two toasts for one click.
    api.runDrillThrough.mockResolvedValue({ ok: false, reason: "The drill-through query has errors." });
    runPivotDrillThrough("p1", cell({ cellType: "Data", value: 1, groupPath: [[0, 0]] }), 1, 1);
    await settle();
    expect(api.runDrillThrough).toHaveBeenCalledTimes(1);
    expect(api.surfacePivotNotices).not.toHaveBeenCalled();
    expect(api.showToast).not.toHaveBeenCalled();
    // The notices still reach the runner, which writes them into the
    // caption and tells them once a sheet has landed.
    expect((api.runDrillThrough.mock.calls[0][2] as { notices: string[] }).notices).toEqual([
      context.notices[0].message,
    ]);
  });

  it("wins over kind 'script': the hook is never dispatched, getPivotDataFormula never asked", async () => {
    api.getPivotDrillBehavior.mockResolvedValue({ kind: "script", designQuery: def });
    api.getScript.mockReturnValue({ id: "s1", name: "Drill script" });
    api.isScriptMounted.mockReturnValue(true);
    api.mountedScriptHasHook.mockReturnValue(true);

    runPivotDrillThrough("p1", cell({ cellType: "Data", value: 1, groupPath: [[0, 0]] }), 7, 1026);
    await settle();

    expect(api.runDrillThrough).toHaveBeenCalledTimes(1);
    expect(api.getPivotDataFormula).not.toHaveBeenCalled();
    expect(api.emitAppEvent).not.toHaveBeenCalled();
    expect(api.drillThroughToSheet).not.toHaveBeenCalled();
  });

  it("a caller's sheet index and name are used as given (the value-cell menu's door); the defaults are the active sheet and the cached region", async () => {
    runPivotDrillThrough("p1", cell({ cellType: "Data", value: 1, groupPath: [[0, 0]] }), 1, 1, {
      sheetIndex: 7,
      name: "Boxed pivot",
    });
    await settle();
    expect(api.runDrillThrough.mock.calls[0][0]).toEqual(
      expect.objectContaining({ sheetIndex: 7, name: "Boxed pivot" }),
    );

    api.regions = [];
    runPivotDrillThrough("p9", cell({ cellType: "Data", value: 1, groupPath: [[0, 0]] }), 1, 1);
    await settle();
    expect(api.runDrillThrough.mock.calls[1][0]).toEqual(
      expect.objectContaining({ id: "p9", sheetIndex: 2, name: "PivotTable" }),
    );
  });

  it("a grand total drills the whole source: an empty path to pivotContext", async () => {
    runPivotCellDoubleClick("p1", cell({ cellType: "GrandTotal", value: 900 }), 9, 3, 3);
    await settle();
    expect(api.invoke).toHaveBeenCalledWith("drill_through", {
      request: { op: "pivotContext", pivotId: "p1", groupPath: [] },
    });
  });

  it("a failed pivotContext op (a non-model pivot, an unresolvable coordinate) is a TOAST and nothing else runs -- never the built-in drill on another datum", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    api.invoke.mockRejectedValueOnce(
      "Pivot p1 is not a data-model pivot: only a data-model pivot has a design-query drill-through",
    );

    runPivotDrillThrough("p1", cell({ cellType: "Data", value: 1, groupPath: [[0, 0]] }), 1, 1);
    await settle();

    expect(api.showToast).toHaveBeenCalledTimes(1);
    expect(api.showToast).toHaveBeenCalledWith(
      "Pivot p1 is not a data-model pivot: only a data-model pivot has a design-query drill-through",
      { type: "error" },
    );
    expect(api.runDrillThrough).not.toHaveBeenCalled();
    expect(api.drillThroughToSheet).not.toHaveBeenCalled();
    expect(api.emitAppEvent).not.toHaveBeenCalled();
  });

  it("the runner toasts its own failures: a { ok: false } answer is not toasted a second time", async () => {
    api.runDrillThrough.mockResolvedValue({ ok: false, reason: "Open the model's connection first." });
    runPivotDrillThrough("p1", cell({ cellType: "Data", value: 1, groupPath: [[0, 0]] }), 1, 1);
    await settle();
    expect(api.runDrillThrough).toHaveBeenCalledTimes(1);
    expect(api.showToast).not.toHaveBeenCalled();
    expect(api.drillThroughToSheet).not.toHaveBeenCalled();
  });

  it("without a designQuery the behaviour runs as before: the built-in drill, no pivotContext", async () => {
    api.getPivotDrillBehavior.mockResolvedValue({ kind: "builtin" });
    runPivotDrillThrough("p1", cell({ cellType: "Data", value: 1, groupPath: [[0, 0]] }), 1, 1);
    await settle();
    expect(api.invoke).not.toHaveBeenCalled();
    expect(api.runDrillThrough).not.toHaveBeenCalled();
    expect(api.drillThroughToSheet).toHaveBeenCalledWith({ pivotId: "p1", groupPath: [[0, 0]] });
  });
});
