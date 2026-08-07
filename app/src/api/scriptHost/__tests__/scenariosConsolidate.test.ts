//! FILENAME: app/src/api/scriptHost/__tests__/scenariosConsolidate.test.ts
// PURPOSE: The two pure-wiring clusters of the VBA-parity tail —
//          api.scenarios/scenarioAdd/scenarioShow/scenarioDelete/
//          scenarioSummary/scenarioMerge over the six shipped scenario_*
//          commands, and api.consolidate over consolidate_data.
// COVERS:  (1) validator matrices, including the two spellings of
//              `changingCells` and the refusal to mix them;
//          (2) allowlist wiring: unlocked tier, no capability, `scenarios` is
//              the only READ of the seven rows;
//          (3) the executors dispatch to the RIGHT backend command with the
//              right params — in particular scenarioShow CALLS scenario_show
//              rather than re-implementing the transient-write pattern;
//          (4) VBA's `ChangingCells:="B2:B4", Values:=Array(...)` expands
//              row-major and refuses a length mismatch NAMING BOTH COUNTS;
//          (5) consolidate resolves every argument shape — sheet-qualified A1
//              sources, boxes, the `sheet` default, A1 and coordinate
//              destinations — and resolves them ALL before writing anything.

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

vi.mock("../../grid", () => ({
  refreshGridData: vi.fn(),
  refreshGridDimensions: vi.fn(),
  convertFormulaStyle: vi.fn(async (f: string) => f),
  getGridStateSnapshot: vi.fn((): unknown => null),
}));
vi.mock("../../../core/lib/cellEvents", () => ({
  cellEvents: { emitBatch: vi.fn() },
  cellToChange: vi.fn((c: unknown) => c),
}));

import {
  executeScenarios,
  executeScenarioAdd,
  executeScenarioShow,
  executeScenarioDelete,
  executeScenarioSummary,
  executeScenarioMerge,
  executeConsolidate,
  resolveScenarioChangingCells,
  resolveScenarioResultCells,
} from "../host";
import { ALLOWLIST } from "../allowlist";
import {
  vScenarios,
  vScenarioAdd,
  vScenarioByName,
  vScenarioSummary,
  vScenarioMerge,
  vConsolidate,
  CONSOLIDATION_FUNCTIONS,
} from "../validators";

const hostSrc = fs.readFileSync(path.resolve(__dirname, "../host.ts"), "utf8");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asLib = (l: unknown) => l as any;

const SHEETS = [
  { index: 0, name: "Sheet1" },
  { index: 1, name: "Q1" },
  { index: 2, name: "Q2" },
  { index: 3, name: "Summary" },
];

function makeLib(activeIndex = 0) {
  return {
    getActiveSheet: vi.fn(async () => activeIndex),
    getSheets: vi.fn(async () => ({ sheets: SHEETS, activeIndex })),
    scenarioList: vi.fn(async () => ({
      scenarios: [
        {
          name: "Best Case",
          changingCells: [{ row: 1, col: 1, value: "1200" }],
          comment: "optimistic",
          createdBy: "dsallander",
          sheetIndex: 0,
        },
      ],
    })),
    scenarioAdd: vi.fn(async () => ({ success: true, error: null })),
    scenarioDelete: vi.fn(async () => ({ success: true, error: null })),
    scenarioShow: vi.fn(async () => ({
      updatedCells: [
        { row: 1, col: 1, display: "1200" },
        { row: 9, col: 1, display: "48000" },
      ],
      error: null,
    })),
    scenarioSummary: vi.fn(async () => ({
      scenarioNames: ["Best Case", "Worst Case"],
      rows: [
        {
          cellRef: "$B$2",
          currentValue: "1000",
          scenarioValues: ["1200", "800"],
          isChangingCell: true,
        },
      ],
      error: null,
    })),
    scenarioMerge: vi.fn(async () => ({ success: true, error: null })),
    consolidateData: vi.fn(async () => ({
      success: true,
      rowsWritten: 3,
      colsWritten: 4,
      updatedCells: [{ row: 0, col: 0, display: "10" }],
      error: null,
    })),
  };
}

beforeEach(() => vi.clearAllMocks());

// ============================================================================
// (1) validators
// ============================================================================

describe("scenario validators", () => {
  it("vScenarios takes only an optional sheet ref", () => {
    expect(vScenarios([])).toBe(true);
    expect(vScenarios([0])).toBe(true);
    expect(vScenarios(["Q1"])).toBe(true);
    expect(vScenarios([true])).not.toBe(true);
  });

  it("vScenarioAdd accepts both spellings of changingCells", () => {
    expect(
      vScenarioAdd([{ name: "Best", changingCells: "B2:B4", values: [1, 2, 3] }]),
    ).toBe(true);
    expect(
      vScenarioAdd([
        { name: "Best", changingCells: [{ row: 1, col: 1, value: 1200 }] },
      ]),
    ).toBe(true);
    expect(
      vScenarioAdd([
        { name: "Best", changingCells: "B2", values: [true], comment: "why", sheet: "Q1" },
      ]),
    ).toBe(true);
  });

  it("vScenarioAdd refuses the A1 spelling without values, and mixing the two", () => {
    expect(String(vScenarioAdd([{ name: "Best", changingCells: "B2:B4" }]))).toMatch(
      /needs a parallel `values` array/,
    );
    expect(
      String(
        vScenarioAdd([
          { name: "Best", changingCells: [{ row: 1, col: 1, value: 1 }], values: [1] },
        ]),
      ),
    ).toMatch(/values belongs with the A1 spelling/);
  });

  it("vScenarioAdd rejects a blank name, unknown keys and bad cells", () => {
    expect(vScenarioAdd([{ name: "  ", changingCells: "B2", values: [1] }])).not.toBe(true);
    expect(
      String(vScenarioAdd([{ name: "x", changingCells: "B2", values: [1], sheetIndex: 0 }])),
    ).toMatch(/unknown scenarioAdd key "sheetIndex"/);
    expect(
      vScenarioAdd([{ name: "x", changingCells: [{ row: -1, col: 0, value: 1 }] }]),
    ).not.toBe(true);
    expect(vScenarioAdd([{ name: "x", changingCells: [] }])).not.toBe(true);
    expect(vScenarioAdd(["Best"])).not.toBe(true);
  });

  it("vScenarioByName wants a non-empty name and an optional sheet", () => {
    expect(vScenarioByName(["Best Case"])).toBe(true);
    expect(vScenarioByName(["Best Case", "Q1"])).toBe(true);
    expect(vScenarioByName([""])).not.toBe(true);
    expect(vScenarioByName(["  "])).not.toBe(true);
    expect(vScenarioByName([7])).not.toBe(true);
  });

  it("vScenarioSummary accepts nothing, an A1 range, and a mixed list", () => {
    expect(vScenarioSummary([])).toBe(true);
    expect(vScenarioSummary([undefined])).toBe(true);
    expect(vScenarioSummary([{}])).toBe(true);
    expect(vScenarioSummary([{ resultCells: "B10:B12" }])).toBe(true);
    expect(vScenarioSummary([{ resultCells: ["B10", { row: 11, col: 1 }], sheet: 0 }])).toBe(true);
    expect(vScenarioSummary([{ resultCells: 42 }])).not.toBe(true);
    expect(String(vScenarioSummary([{ cells: "B1" }]))).toMatch(/unknown scenarioSummary key/);
  });

  it("vScenarioMerge wants a REQUIRED source and an optional target", () => {
    expect(vScenarioMerge([0])).toBe(true);
    expect(vScenarioMerge(["Q1", "Q2"])).toBe(true);
    expect(vScenarioMerge([])).not.toBe(true);
    expect(vScenarioMerge([null, 1])).not.toBe(true);
  });
});

describe("vConsolidate", () => {
  const base = {
    function: "sum",
    sources: ["Q1!A1:D10", "Q2!A1:D10"],
    destination: "Summary!A1",
  };

  it("accepts the documented shapes", () => {
    expect(vConsolidate([base])).toBe(true);
    expect(vConsolidate([{ ...base, useTopRow: true, useLeftColumn: true, sheet: 0 }])).toBe(true);
    expect(
      vConsolidate([
        {
          function: "average",
          sources: [{ startRow: 0, startCol: 0, endRow: 9, endCol: 3, sheet: "Q1" }],
          destination: { row: 0, col: 0, sheet: "Summary" },
        },
      ]),
    ).toBe(true);
  });

  it("its function list matches the backend enum, camelCase", () => {
    expect([...CONSOLIDATION_FUNCTIONS]).toEqual([
      "sum", "count", "average", "max", "min", "product", "countNums",
      "stdDev", "stdDevP", "var", "varP",
    ]);
    for (const fn of CONSOLIDATION_FUNCTIONS) {
      expect(vConsolidate([{ ...base, function: fn }]), fn).toBe(true);
    }
  });

  it("rejects an unknown function, empty sources, and a malformed destination", () => {
    expect(String(vConsolidate([{ ...base, function: "median" }]))).toMatch(/must be one of/);
    expect(String(vConsolidate([{ ...base, function: "Sum" }]))).toMatch(/must be one of/);
    expect(vConsolidate([{ ...base, sources: [] }])).not.toBe(true);
    expect(vConsolidate([{ ...base, sources: "Q1!A1:D10" }])).not.toBe(true);
    expect(vConsolidate([{ ...base, destination: 0 }])).not.toBe(true);
    expect(vConsolidate([{ ...base, destination: { row: 0 } }])).not.toBe(true);
    expect(vConsolidate([{ ...base, useTopRow: "yes" }])).not.toBe(true);
    expect(String(vConsolidate([{ ...base, destSheetIndex: 0 }]))).toMatch(/unknown consolidate key/);
    expect(vConsolidate(["sum"])).not.toBe(true);
  });
});

// ============================================================================
// (2) allowlist wiring
// ============================================================================

describe("the scenario + consolidate rows", () => {
  const rows = [
    "api.scenarios", "api.scenarioAdd", "api.scenarioShow", "api.scenarioDelete",
    "api.scenarioSummary", "api.scenarioMerge", "api.consolidate",
  ];

  it("are all unlocked-tier with no capability", () => {
    for (const m of rows) {
      expect(ALLOWLIST[m], m).toBeDefined();
      expect(ALLOWLIST[m].tier, m).toBe("unlocked");
      expect(ALLOWLIST[m].capability, m).toBeUndefined();
    }
  });

  it("classify honestly: only the listing is a read", () => {
    expect(ALLOWLIST["api.scenarios"].class).toBe("read");
    for (const m of rows.filter((r) => r !== "api.scenarios")) {
      expect(ALLOWLIST[m].class, m).toBe("mutate");
    }
  });

  it("scenarioShow and scenarioSummary are MUTATIONS — their writes are saved", () => {
    // scenario_show has no scenario_restore: the values it writes stay in the
    // cells and go into the file. Classing it a read would tell the user the
    // opposite of the truth at consent time.
    expect(ALLOWLIST["api.scenarioShow"].class).toBe("mutate");
    expect(ALLOWLIST["api.scenarioSummary"].class).toBe("mutate");
  });

  it("bind the validators they document", () => {
    expect(ALLOWLIST["api.scenarios"].validate).toBe(vScenarios);
    expect(ALLOWLIST["api.scenarioAdd"].validate).toBe(vScenarioAdd);
    expect(ALLOWLIST["api.scenarioShow"].validate).toBe(vScenarioByName);
    expect(ALLOWLIST["api.scenarioDelete"].validate).toBe(vScenarioByName);
    expect(ALLOWLIST["api.scenarioSummary"].validate).toBe(vScenarioSummary);
    expect(ALLOWLIST["api.scenarioMerge"].validate).toBe(vScenarioMerge);
    expect(ALLOWLIST["api.consolidate"].validate).toBe(vConsolidate);
  });
});

// ============================================================================
// (3)+(4) scenario executors
// ============================================================================

describe("executeScenarios", () => {
  it("lists the active sheet's scenarios by default", async () => {
    const lib = makeLib();
    const out = await executeScenarios(asLib(lib));
    expect(lib.scenarioList).toHaveBeenCalledWith(0);
    expect(out).toEqual([
      {
        name: "Best Case",
        changingCells: [{ row: 1, col: 1, value: "1200" }],
        comment: "optimistic",
        createdBy: "dsallander",
        sheetIndex: 0,
      },
    ]);
  });

  it("resolves a sheet NAME to its index (Wave-1 rules)", async () => {
    const lib = makeLib();
    await executeScenarios(asLib(lib), "Q2");
    expect(lib.scenarioList).toHaveBeenCalledWith(2);
  });

  it("names the workbook's sheets when the ref does not resolve", async () => {
    const lib = makeLib();
    await expect(executeScenarios(asLib(lib), "Nope")).rejects.toThrow(/no sheet named "Nope"/);
  });
});

describe("executeScenarioAdd", () => {
  it("passes the explicit cells straight through, stringifying the values", async () => {
    const lib = makeLib();
    const out = await executeScenarioAdd(asLib(lib), {
      name: "Best Case",
      changingCells: [
        { row: 1, col: 1, value: 1200 },
        { row: 2, col: 1, value: true },
        { row: 3, col: 1, value: "text" },
        { row: 4, col: 1, value: null },
      ],
      comment: "optimistic",
    });
    expect(lib.scenarioAdd).toHaveBeenCalledWith({
      name: "Best Case",
      changingCells: [
        { row: 1, col: 1, value: "1200" },
        { row: 2, col: 1, value: "TRUE" },
        { row: 3, col: 1, value: "text" },
        { row: 4, col: 1, value: "" },
      ],
      comment: "optimistic",
      sheetIndex: 0,
    });
    expect(out).toEqual({ name: "Best Case", changingCells: 4 });
  });

  it("expands the VBA spelling ChangingCells:=\"B2:B4\", Values:=Array(...) row-major", async () => {
    const lib = makeLib();
    await executeScenarioAdd(asLib(lib), {
      name: "Best Case",
      changingCells: "B2:B4",
      values: [1200, 0.15, 48],
    });
    expect(lib.scenarioAdd.mock.calls[0][0].changingCells).toEqual([
      { row: 1, col: 1, value: "1200" },
      { row: 2, col: 1, value: "0.15" },
      { row: 3, col: 1, value: "48" },
    ]);
  });

  it("walks a MULTI-COLUMN A1 range row by row, like Excel reads it", () => {
    expect(
      resolveScenarioChangingCells({
        name: "x",
        changingCells: "A1:B2",
        values: [1, 2, 3, 4],
      }),
    ).toEqual([
      { row: 0, col: 0, value: "1" },
      { row: 0, col: 1, value: "2" },
      { row: 1, col: 0, value: "3" },
      { row: 1, col: 1, value: "4" },
    ]);
  });

  it("refuses a cells/values length mismatch NAMING BOTH COUNTS, before writing", async () => {
    const lib = makeLib();
    await expect(
      executeScenarioAdd(asLib(lib), { name: "x", changingCells: "B2:B4", values: [1, 2] }),
    ).rejects.toThrow(/covers 3 cell\(s\) but 2 value\(s\)/);
    expect(lib.scenarioAdd).not.toHaveBeenCalled();
  });

  it("refuses a sheet-qualified changingCells — the sheet slot is `sheet`", async () => {
    const lib = makeLib();
    await expect(
      executeScenarioAdd(asLib(lib), { name: "x", changingCells: "Q1!B2", values: [1] }),
    ).rejects.toThrow(/must not name a sheet/);
    expect(lib.scenarioAdd).not.toHaveBeenCalled();
  });

  it("surfaces the backend's own refusal (the allowEditScenarios gate)", async () => {
    const lib = makeLib();
    lib.scenarioAdd.mockResolvedValueOnce({
      success: false,
      error: "Sheet is protected: cannot edit scenarios",
    });
    await expect(
      executeScenarioAdd(asLib(lib), { name: "x", changingCells: "B2", values: [1] }),
    ).rejects.toThrow(/cannot edit scenarios/);
  });
});

describe("executeScenarioShow", () => {
  it("CALLS scenario_show with the resolved sheet and reports the cell count", async () => {
    const lib = makeLib();
    const out = await executeScenarioShow(asLib(lib), "s1", "Best Case", "Q1");
    expect(lib.scenarioShow).toHaveBeenCalledWith({ name: "Best Case", sheetIndex: 1 });
    expect(out).toEqual({ cellsUpdated: 2 });
  });

  it("a missing scenario is the backend's error, surfaced verbatim", async () => {
    const lib = makeLib();
    lib.scenarioShow.mockResolvedValueOnce({
      updatedCells: [],
      error: "Scenario 'Nope' not found.",
    });
    await expect(executeScenarioShow(asLib(lib), "s1", "Nope")).rejects.toThrow(/not found/);
  });

  it("does NOT re-implement the transient-write pattern (source pin)", () => {
    // scenario_show carries the writeback-region skips, the GET.CONTROLVALUE
    // snapshot and the dependent recalculation. A second implementation here
    // would be a second set of rules for the same act.
    const start = hostSrc.indexOf("export async function executeScenarioShow");
    const body = hostSrc.slice(start, hostSrc.indexOf("\n}\n", start));
    expect(body).toContain("lib.scenarioShow(");
    for (const forbidden of ["setCellValue", "setRangeValues", "setCellValues"]) {
      expect(body, `executeScenarioShow must not write cells itself`).not.toContain(forbidden);
    }
  });
});

describe("executeScenarioDelete", () => {
  it("deletes by name on the resolved sheet", async () => {
    const lib = makeLib();
    await expect(executeScenarioDelete(asLib(lib), "Best Case", 2)).resolves.toEqual({
      deleted: true,
    });
    expect(lib.scenarioDelete).toHaveBeenCalledWith({ name: "Best Case", sheetIndex: 2 });
  });

  it("a not-found delete rejects with the backend's words", async () => {
    const lib = makeLib();
    lib.scenarioDelete.mockResolvedValueOnce({
      success: false,
      error: "Scenario 'Nope' not found.",
    });
    await expect(executeScenarioDelete(asLib(lib), "Nope")).rejects.toThrow(/not found/);
  });
});

describe("executeScenarioSummary", () => {
  it("passes resolved result cells and returns names + rows", async () => {
    const lib = makeLib();
    const out = await executeScenarioSummary(asLib(lib), { resultCells: "B10:B11" });
    expect(lib.scenarioSummary).toHaveBeenCalledWith({
      sheetIndex: 0,
      resultCells: [
        { row: 9, col: 1, value: "" },
        { row: 10, col: 1, value: "" },
      ],
    });
    expect(out.scenarioNames).toEqual(["Best Case", "Worst Case"]);
    expect(out.rows[0].cellRef).toBe("$B$2");
  });

  it("no options at all is a changing-cells-only report on the active sheet", async () => {
    const lib = makeLib();
    await executeScenarioSummary(asLib(lib));
    expect(lib.scenarioSummary).toHaveBeenCalledWith({ sheetIndex: 0, resultCells: [] });
  });

  it("accepts a MIXED list of addresses and coordinates", () => {
    expect(resolveScenarioResultCells(["B10", { row: 20, col: 3 }, "A1:A2"])).toEqual([
      { row: 9, col: 1 },
      { row: 20, col: 3 },
      { row: 0, col: 0 },
      { row: 1, col: 0 },
    ]);
  });

  it("repaints the visible sheet — the report leaves the LAST scenario's values behind", async () => {
    // scenario_summary applies each scenario in turn and never restores, but
    // answers with rows rather than cells: without an explicit announce the
    // canvas would keep showing numbers the workbook no longer holds.
    const start = hostSrc.indexOf("export async function executeScenarioSummary");
    const body = hostSrc.slice(start, hostSrc.indexOf("\n}\n", start));
    expect(body).toContain("announceNonCellMutation(t.offSheet)");
  });

  it("surfaces 'no scenarios defined' rather than answering an empty report", async () => {
    const lib = makeLib();
    lib.scenarioSummary.mockResolvedValueOnce({
      scenarioNames: [],
      rows: [],
      error: "No scenarios defined for this sheet.",
    });
    await expect(executeScenarioSummary(asLib(lib))).rejects.toThrow(/No scenarios defined/);
  });
});

describe("executeScenarioMerge", () => {
  it("resolves both sheets by name and defaults the target to the active sheet", async () => {
    const lib = makeLib();
    await expect(executeScenarioMerge(asLib(lib), "Q1")).resolves.toEqual({ merged: true });
    expect(lib.scenarioMerge).toHaveBeenCalledWith(1, 0);
  });

  it("takes an explicit target", async () => {
    const lib = makeLib();
    await executeScenarioMerge(asLib(lib), "Q1", "Q2");
    expect(lib.scenarioMerge).toHaveBeenCalledWith(1, 2);
  });

  it("refuses merging a sheet into itself before calling the backend", async () => {
    const lib = makeLib();
    await expect(executeScenarioMerge(asLib(lib), "Q1", 1)).rejects.toThrow(/must be different/);
    expect(lib.scenarioMerge).not.toHaveBeenCalled();
  });

  it("surfaces 'nothing to merge'", async () => {
    const lib = makeLib();
    lib.scenarioMerge.mockResolvedValueOnce({
      success: false,
      error: "No scenarios to merge from source sheet.",
    });
    await expect(executeScenarioMerge(asLib(lib), "Q1", "Q2")).rejects.toThrow(/No scenarios/);
  });
});

// ============================================================================
// (5) consolidate
// ============================================================================

describe("executeConsolidate", () => {
  it("resolves sheet-qualified A1 sources and an A1 destination", async () => {
    const lib = makeLib();
    const out = await executeConsolidate(asLib(lib), "s1", {
      function: "sum",
      sources: ["Q1!A1:D10", "Q2!A1:D10"],
      destination: "Summary!A1",
      useTopRow: true,
      useLeftColumn: true,
    });
    expect(lib.consolidateData).toHaveBeenCalledWith({
      function: "sum",
      sourceRanges: [
        { sheetIndex: 1, startRow: 0, startCol: 0, endRow: 9, endCol: 3 },
        { sheetIndex: 2, startRow: 0, startCol: 0, endRow: 9, endCol: 3 },
      ],
      destSheetIndex: 3,
      destRow: 0,
      destCol: 0,
      useTopRow: true,
      useLeftColumn: true,
    });
    expect(out).toEqual({ rowsWritten: 3, colsWritten: 4, cellsUpdated: 1 });
  });

  it("unqualified sources fall back to `sheet`, and `sheet` to the active sheet", async () => {
    const lib = makeLib(2);
    await executeConsolidate(asLib(lib), "s1", {
      function: "average",
      sources: ["A1:B2"],
      destination: "D1",
    });
    const args = lib.consolidateData.mock.calls[0][0];
    expect(args.sourceRanges[0].sheetIndex).toBe(2);
    expect(args.destSheetIndex).toBe(2);

    lib.consolidateData.mockClear();
    await executeConsolidate(asLib(lib), "s1", {
      function: "average",
      sources: ["A1:B2"],
      destination: "D1",
      sheet: "Q1",
    });
    const args2 = lib.consolidateData.mock.calls[0][0];
    expect(args2.sourceRanges[0].sheetIndex).toBe(1);
    expect(args2.destSheetIndex).toBe(1);
  });

  it("a source's own qualifier beats the `sheet` default", async () => {
    const lib = makeLib();
    await executeConsolidate(asLib(lib), "s1", {
      function: "sum",
      sources: ["Q2!A1:B2", "A1:B2"],
      destination: "A1",
      sheet: "Q1",
    });
    const args = lib.consolidateData.mock.calls[0][0];
    expect(args.sourceRanges.map((r: { sheetIndex: number }) => r.sheetIndex)).toEqual([2, 1]);
  });

  it("takes explicit boxes, normalizing a reversed rectangle", async () => {
    const lib = makeLib();
    await executeConsolidate(asLib(lib), "s1", {
      function: "max",
      sources: [{ startRow: 9, startCol: 3, endRow: 0, endCol: 0, sheet: "Q1" }],
      destination: { row: 5, col: 2, sheet: 3 },
    });
    expect(lib.consolidateData.mock.calls[0][0]).toMatchObject({
      sourceRanges: [{ sheetIndex: 1, startRow: 0, startCol: 0, endRow: 9, endCol: 3 }],
      destSheetIndex: 3,
      destRow: 5,
      destCol: 2,
    });
  });

  it("an A1 RANGE destination collapses to its top-left corner", async () => {
    const lib = makeLib();
    await executeConsolidate(asLib(lib), "s1", {
      function: "sum",
      sources: ["A1:B2"],
      destination: "D5:Z99",
    });
    expect(lib.consolidateData.mock.calls[0][0]).toMatchObject({ destRow: 4, destCol: 3 });
  });

  it("useTopRow / useLeftColumn default to false (position-based consolidation)", async () => {
    const lib = makeLib();
    await executeConsolidate(asLib(lib), "s1", {
      function: "sum",
      sources: ["A1:B2"],
      destination: "D1",
    });
    expect(lib.consolidateData.mock.calls[0][0]).toMatchObject({
      useTopRow: false,
      useLeftColumn: false,
    });
  });

  it("ONE bad address refuses the whole call — nothing is half-written", async () => {
    const lib = makeLib();
    await expect(
      executeConsolidate(asLib(lib), "s1", {
        function: "sum",
        sources: ["Q1!A1:D10", "Nope!A1:D10"],
        destination: "Summary!A1",
      }),
    ).rejects.toThrow(/no sheet named "Nope"/);
    expect(lib.consolidateData).not.toHaveBeenCalled();

    await expect(
      executeConsolidate(asLib(lib), "s1", {
        function: "sum",
        sources: ["Q1!not-a-range"],
        destination: "Summary!A1",
      }),
    ).rejects.toThrow(/is not an A1 range/);
    expect(lib.consolidateData).not.toHaveBeenCalled();
  });

  it("surfaces the backend's refusal", async () => {
    const lib = makeLib();
    lib.consolidateData.mockResolvedValueOnce({
      success: false,
      rowsWritten: 0,
      colsWritten: 0,
      updatedCells: [],
      error: "Source range 2 has dimensions 3x4, but range 1 has 10x4.",
    });
    await expect(
      executeConsolidate(asLib(lib), "s1", {
        function: "sum",
        sources: ["Q1!A1:D10", "Q2!A1:D3"],
        destination: "Summary!A1",
      }),
    ).rejects.toThrow(/must have the same size|has dimensions/);
  });
});
