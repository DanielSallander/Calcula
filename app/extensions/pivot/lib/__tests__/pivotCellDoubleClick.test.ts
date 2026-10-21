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
//          - Anything else means nothing (false, no request).

import { describe, it, expect, vi, beforeEach } from "vitest";

const api = vi.hoisted(() => ({
  showToast: vi.fn(),
  emitAppEvent: vi.fn(),
  setActiveSheet: vi.fn(async () => undefined),
  togglePivotGroup: vi.fn(async () => ({})),
  getPivotDataFormula: vi.fn(),
  drillThroughToSheet: vi.fn(),
  getPivotDrillBehavior: vi.fn(),
  getScript: vi.fn(),
  isScriptMounted: vi.fn(),
  mountedScriptHasHook: vi.fn(),
}));

vi.mock("@api", () => ({
  AppEvents: { SHEET_CHANGED: "app:sheet-changed" },
  showToast: api.showToast,
  ObjectScriptManager: { getScript: api.getScript, isScriptMounted: api.isScriptMounted },
  mountedScriptHasHook: api.mountedScriptHasHook,
}));

vi.mock("@api/events", () => ({ emitAppEvent: api.emitAppEvent }));
vi.mock("@api/lib", () => ({ setActiveSheet: api.setActiveSheet }));

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
  api.setActiveSheet.mockImplementation(async () => undefined);
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
    expect(api.setActiveSheet).toHaveBeenCalledWith(4);
    expect(api.emitAppEvent).toHaveBeenCalledWith("app:sheet-changed", { sheetIndex: 4 });
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
    expect(api.emitAppEvent).toHaveBeenCalledWith("app:sheet-changed", { sheetIndex: 4 });
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
