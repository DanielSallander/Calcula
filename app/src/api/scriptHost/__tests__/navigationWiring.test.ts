//! FILENAME: app/src/api/scriptHost/__tests__/navigationWiring.test.ts
// PURPOSE: Wave 2 range-discovery wiring + canonical-model sugar.
// COVERS:  (1) the vRangeEdge / vUsedRange / vTabColor validator matrices;
//          (2) the ALLOWLIST rows' tier/class/validator wiring for
//              api.getRangeEdge / api.getCurrentRegion / api.getUsedRange /
//              api.setTabColor;
//          (3) the WORKER SHIM: the flat methods dispatch the right broker
//              methods with the right argument order, and the canonical-model
//              sugar (range.end/currentRegion/select, sheet facet) reaches the
//              same rows through the workbook transport;
//          (4) the RANGE ALGEBRA table — contains / intersect / boundingUnion
//              — mirroring the Rust twin's cases EXACTLY (canonical_model.rs
//              tests range_contains_checks_inclusive_bounds /
//              range_intersect_is_max_starts_min_ends_or_null /
//              range_bounding_union_covers_both_including_the_gap /
//              range_algebra_rejects_a_non_range_argument);
//          (5) the rich ScriptSheet facet: every management delegate passes
//              the sheet's NAME (identity survives a tab re-order), rename
//              re-points the handle, and move's {before/after} arithmetic
//              matches the backend's remove-then-insert semantics.

import { describe, expect, it, vi } from "vitest";
import {
  vRangeEdge,
  vUsedRange,
  vTabColor,
  SCRIPT_EDGE_DIRECTIONS,
} from "../validators";
import { ALLOWLIST } from "../allowlist";
import {
  makeRange,
  makeWorkbook,
  rangeFromAddress,
  sheetRangeTransport,
  type RangeTransport,
  type RegionResult,
  type WorkbookTransport,
  type WorkbookSheetInfo,
} from "../worker/canonicalModel";
import { buildWorkerContext, type WorkerRuntime } from "../worker/contextShims";
import type { MountSpec, W2H } from "../protocol";

// ============================================================================
// (1) validators
// ============================================================================

describe("vRangeEdge", () => {
  it("accepts each direction, with and without a sheet ref", () => {
    for (const direction of SCRIPT_EDGE_DIRECTIONS) {
      expect(vRangeEdge([0, 0, direction]), direction).toBe(true);
      expect(vRangeEdge([5, 3, direction, 1]), direction).toBe(true);
      expect(vRangeEdge([5, 3, direction, "Data"]), direction).toBe(true);
    }
  });

  it("rejects a bad direction with the accepted list (VBA constants included)", () => {
    for (const bad of ["xlUp", "UP", "Down", "", 4, undefined]) {
      const verdict = vRangeEdge([0, 0, bad]);
      expect(verdict, String(bad)).toContain("up, down, left, right");
    }
  });

  it("rejects bad coordinates and bad sheet refs", () => {
    expect(vRangeEdge([-1, 0, "up"])).not.toBe(true);
    expect(vRangeEdge([0, 0.5, "up"])).not.toBe(true);
    expect(vRangeEdge([0, 0, "up", true])).not.toBe(true);
  });
});

describe("vUsedRange", () => {
  it("accepts no argument and an optional sheet ref (index or name)", () => {
    expect(vUsedRange([])).toBe(true);
    expect(vUsedRange([undefined])).toBe(true);
    expect(vUsedRange([2])).toBe(true);
    expect(vUsedRange(["Data"])).toBe(true);
  });

  it("rejects a non-sheet-ref", () => {
    expect(vUsedRange([true])).not.toBe(true);
    expect(vUsedRange([-1])).not.toBe(true);
    expect(vUsedRange([{}])).not.toBe(true);
  });
});

describe("vTabColor", () => {
  it("accepts a hex color (with or without #, with alpha) and null-to-clear", () => {
    expect(vTabColor([0, "#FF0000"])).toBe(true);
    expect(vTabColor(["Data", "00FF00"])).toBe(true);
    expect(vTabColor([1, "#00FF0080"])).toBe(true);
    expect(vTabColor([1, null])).toBe(true);
  });

  it("rejects a missing/invalid sheet ref and a non-hex color", () => {
    expect(vTabColor([undefined, "#FF0000"])).not.toBe(true);
    expect(vTabColor([0, "red"])).toContain("hex color");
    expect(vTabColor([0, "#12"])).toContain("hex color");
    expect(vTabColor([0, undefined])).toContain("hex color");
  });
});

// ============================================================================
// (2) allowlist wiring
// ============================================================================

describe("Wave 2 range-discovery allowlist rows", () => {
  it("the discovery rows are unlocked-tier reads with no capability", () => {
    for (const m of ["api.getRangeEdge", "api.getCurrentRegion", "api.getUsedRange"]) {
      expect(ALLOWLIST[m], m).toMatchObject({ tier: "unlocked", class: "read" });
      expect(ALLOWLIST[m].capability, m).toBeUndefined();
    }
  });

  it("setTabColor is an unlocked-tier mutate with no capability", () => {
    expect(ALLOWLIST["api.setTabColor"]).toMatchObject({ tier: "unlocked", class: "mutate" });
    expect(ALLOWLIST["api.setTabColor"].capability).toBeUndefined();
  });

  it("the validators on the rows are the ones tested above", () => {
    expect(ALLOWLIST["api.getRangeEdge"].validate).toBe(vRangeEdge);
    expect(ALLOWLIST["api.getUsedRange"].validate).toBe(vUsedRange);
    expect(ALLOWLIST["api.setTabColor"].validate).toBe(vTabColor);
    // getCurrentRegion reuses the [row, col, sheet?] cell-ref validator.
    expect(ALLOWLIST["api.getCurrentRegion"].validate).toBe(
      ALLOWLIST["api.getCellValue"].validate,
    );
  });
});

// ============================================================================
// (3) worker shim: flat methods + transport-driven sugar
// ============================================================================

interface PostedCall {
  callId: number;
  method: string;
  args: unknown[];
}

function makeContext(): {
  api: Record<string, unknown>;
  rt: WorkerRuntime;
  calls: PostedCall[];
  drain: () => void;
} {
  const calls: PostedCall[] = [];
  const spec = {
    protocolVersion: 1,
    scriptId: "wave2-nav-test",
    objectType: "sheet",
    instanceId: null,
    tier: "unlocked",
    capabilities: [],
    apiVersion: "1.0.0",
    scriptName: "Wave2Nav",
    packageInfo: null,
    snapshot: {},
    source: "",
  } as unknown as MountSpec;
  const { context, rt } = buildWorkerContext(spec, (msg: W2H) => {
    if (msg.t === "call") calls.push({ callId: msg.callId, method: msg.method, args: msg.args });
  });
  const drain = (): void => {
    for (const entry of rt.pending.values()) clearTimeout(entry.timer);
    rt.pending.clear();
  };
  return { api: context.api as Record<string, unknown>, rt, calls, drain };
}

describe("worker shim: flat range-discovery methods", () => {
  it("getRangeEdge / getCurrentRegion / getUsedRange / setTabColor dispatch verbatim", () => {
    const { api, calls, drain } = makeContext();
    void (api.getRangeEdge as (...a: unknown[]) => Promise<unknown>)(1048575, 0, "up", "Data");
    void (api.getCurrentRegion as (...a: unknown[]) => Promise<unknown>)(3, 2, 1);
    void (api.getUsedRange as (...a: unknown[]) => Promise<unknown>)("Data");
    void (api.getUsedRange as (...a: unknown[]) => Promise<unknown>)();
    void (api.setTabColor as (...a: unknown[]) => Promise<void>)("Data", "#0078D4");
    void (api.setTabColor as (...a: unknown[]) => Promise<void>)(0, null);
    expect(calls.map((c) => [c.method, ...c.args])).toEqual([
      ["api.getRangeEdge", 1048575, 0, "up", "Data"],
      ["api.getCurrentRegion", 3, 2, 1],
      ["api.getUsedRange", "Data"],
      ["api.getUsedRange", undefined],
      ["api.setTabColor", "Data", "#0078D4"],
      ["api.setTabColor", 0, null],
    ]);
    drain();
  });
});

describe("worker shim: canonical-model sugar reaches the same rows (end-to-end)", () => {
  it("sheet.cell(...).end() carries the sheet's index into api.getRangeEdge", async () => {
    const { api, rt, calls } = makeContext();
    const wbPromise = (
      api.workbook as { sheet: (ref: unknown) => Promise<Record<string, unknown> | null> }
    ).sheet("Data");
    // wb.sheet() needs the name list.
    expect(calls[0].method).toBe("api.getSheetNames");
    rt.settleCall(calls[0].callId, true, ["Intro", "Data"]);
    const sheet = await wbPromise;
    expect(sheet).not.toBeNull();
    calls.length = 0;
    const endPromise = (
      (sheet as { cell: (r: number, c: number) => Record<string, unknown> }).cell(9, 1) as {
        end: (d: string) => Promise<{ address: string }>;
      }
    ).end("down");
    expect(calls[0]).toMatchObject({ method: "api.getRangeEdge", args: [9, 1, "down", 1] });
    rt.settleCall(calls[0].callId, true, { row: 41, col: 1 });
    const edge = await endPromise;
    expect(edge.address).toBe("B42");
  });

  it("range.select() goes through api.select with the sheet pre-bound", async () => {
    const { api, rt, calls } = makeContext();
    const wbPromise = (
      api.workbook as { sheet: (ref: unknown) => Promise<Record<string, unknown> | null> }
    ).sheet(0);
    rt.settleCall(calls[0].callId, true, ["Intro", "Data"]);
    const sheet = await wbPromise;
    calls.length = 0;
    const range = (sheet as { range: (a: string) => Record<string, unknown> }).range("A1:B5");
    void (range as { select: (scroll?: boolean) => Promise<void> }).select(false);
    expect(calls[0]).toMatchObject({
      method: "api.select",
      args: [0, 0, 4, 1, { sheetIndex: 0, scroll: false }],
    });
    for (const entry of rt.pending.values()) clearTimeout(entry.timer);
    rt.pending.clear();
  });

  it("the sheet facet's rename dispatches api.renameSheet BY NAME", async () => {
    const { api, rt, calls } = makeContext();
    const wbPromise = (
      api.workbook as { sheet: (ref: unknown) => Promise<Record<string, unknown> | null> }
    ).sheet("Data");
    rt.settleCall(calls[0].callId, true, ["Intro", "Data"]);
    const sheet = await wbPromise;
    calls.length = 0;
    const renamePromise = (sheet as { rename: (n: string) => Promise<void> }).rename("Data 2024");
    expect(calls[0]).toMatchObject({ method: "api.renameSheet", args: ["Data", "Data 2024"] });
    rt.settleCall(calls[0].callId, true, undefined);
    await renamePromise;
    expect((sheet as { name: string }).name).toBe("Data 2024");
  });
});

// ============================================================================
// (4) range algebra — the EXACT table of the Rust twin
//     (core/script-engine/src/ops/canonical_model.rs)
// ============================================================================

const perCellTransport = (): RangeTransport => ({
  readCell: async () => "",
  writeCell: async () => {},
});

describe("range algebra (twin table: canonical_model.rs NotebookRange)", () => {
  // range_contains_checks_inclusive_bounds
  it("contains checks inclusive bounds, negatives outside", () => {
    const r = rangeFromAddress(perCellTransport(), "B2:C4"); // rows 1..3, cols 1..2
    expect([
      r.contains(1, 1), r.contains(3, 2),  // corners
      r.contains(2, 2),                    // inside
      r.contains(0, 1), r.contains(4, 1),  // above / below
      r.contains(1, 3),                    // right of
      r.contains(-1, -1),                  // negative
    ]).toEqual([true, true, true, false, false, false, false]);
  });

  // range_intersect_is_max_starts_min_ends_or_null
  it("intersect is max-starts/min-ends, null when disjoint (touching IS disjoint)", () => {
    const t = perCellTransport();
    const a = rangeFromAddress(t, "A1:C3");
    expect(a.intersect(rangeFromAddress(t, "B2:D4"))?.address).toBe("B2:C3");
    expect(a.intersect(rangeFromAddress(t, "B2"))?.address).toBe("B2");
    expect(a.intersect(rangeFromAddress(t, "E5:F6"))).toBeNull();
    expect(a.intersect(rangeFromAddress(t, "D1:E3"))).toBeNull();
  });

  // range_bounding_union_covers_both_including_the_gap
  it("boundingUnion covers both ranges including the gap", () => {
    const t = perCellTransport();
    const u = rangeFromAddress(t, "A1:B2").boundingUnion(rangeFromAddress(t, "D4:E5"));
    expect([u.address, u.rowCount, u.colCount]).toEqual(["A1:E5", 5, 5]);
  });

  // range_algebra_rejects_a_non_range_argument
  it("rejects a non-range argument, naming the method", () => {
    const r = rangeFromAddress(perCellTransport(), "A1:B2");
    expect(() => r.intersect(42 as never)).toThrow(
      "intersect expects a Range (an object with startRow/startCol/endRow/endCol)",
    );
    expect(() => r.boundingUnion({} as never)).toThrow(
      "boundingUnion expects a Range (an object with startRow/startCol/endRow/endCol)",
    );
  });

  it("intersect/boundingUnion accept any Range-SHAPED object and bind to THIS range's transport", async () => {
    const readCell = vi.fn(async () => "");
    const t: RangeTransport = { readCell, writeCell: async () => {} };
    const a = makeRange(t, { startRow: 0, startCol: 0, endRow: 2, endCol: 2 });
    const out = a.intersect({ startRow: 1, startCol: 1, endRow: 5, endCol: 5 });
    expect(out?.address).toBe("B2:C3");
    await out!.getValue();
    expect(readCell).toHaveBeenCalledWith(1, 1);
  });
});

describe("range navigation sugar over the transport", () => {
  it("end() asks from the TOP-LEFT cell and returns a single-cell range", async () => {
    const rangeEdge = vi.fn(async () => ({ row: 3, col: 0 }));
    const t: RangeTransport = { ...perCellTransport(), rangeEdge };
    const r = rangeFromAddress(t, "A2:C9"); // top-left (1, 0)
    const end = await r.end("up");
    expect(rangeEdge).toHaveBeenCalledWith(1, 0, "up");
    expect(end.isSingleCell).toBe(true);
    expect(end.address).toBe("A4");
  });

  it("currentRegion() returns the discovered rectangle (collapsed seed when empty)", async () => {
    const currentRegion = vi.fn(
      async (): Promise<RegionResult> => ({
        startRow: 0, startCol: 0, endRow: 3, endCol: 2, empty: false,
      }),
    );
    const t: RangeTransport = { ...perCellTransport(), currentRegion };
    const region = await rangeFromAddress(t, "B2").currentRegion();
    expect(currentRegion).toHaveBeenCalledWith(1, 1);
    expect(region.address).toBe("A1:C4");
  });

  it("select() defaults scroll to true and passes false through", async () => {
    const selectRange = vi.fn(async () => {});
    const t: RangeTransport = { ...perCellTransport(), selectRange };
    const r = rangeFromAddress(t, "B2:D5");
    await r.select();
    await r.select(false);
    expect(selectRange).toHaveBeenNthCalledWith(1, 1, 1, 4, 3, true);
    expect(selectRange).toHaveBeenNthCalledWith(2, 1, 1, 4, 3, false);
  });

  it("end/currentRegion/select THROW (never silently no-op) without the transport op", async () => {
    const r = rangeFromAddress(perCellTransport(), "A1");
    await expect(r.end("down")).rejects.toThrow(/end\(\) is not available/);
    await expect(r.currentRegion()).rejects.toThrow(/currentRegion\(\) is not available/);
    await expect(r.select()).rejects.toThrow(/select\(\) is not available/);
  });

  it("sheetRangeTransport forwards the wave-2 ops with the sheet index (and omits absent ones)", async () => {
    const rangeEdge = vi.fn(async () => ({ row: 0, col: 0 }));
    const selectRange = vi.fn(async () => {});
    const wbt = {
      getSheetNames: async () => ["A"],
      getActiveSheet: async () => 0,
      setActiveSheet: async () => {},
      readCell: async () => "",
      writeCell: async () => {},
      readRange: async () => [],
      writeCells: async () => {},
      formatRange: async () => {},
      clearFormatRange: async () => {},
      rangeEdge,
      selectRange,
    } as unknown as WorkbookTransport;
    const t = sheetRangeTransport(wbt, 7);
    await t.rangeEdge!(2, 3, "left");
    expect(rangeEdge).toHaveBeenCalledWith(7, 2, 3, "left");
    await t.selectRange!(0, 0, 1, 1, true);
    expect(selectRange).toHaveBeenCalledWith(7, 0, 0, 1, 1, true);
    // No currentRegion on the workbook transport -> none on the range transport.
    expect(t.currentRegion).toBeUndefined();
  });
});

// ============================================================================
// (5) the rich ScriptSheet facet
// ============================================================================

interface FacetLog {
  renames: Array<[number | string, string]>;
  deletes: Array<number | string>;
  visibilities: Array<[number | string, string]>;
  moves: Array<[number | string, number]>;
  copies: Array<[number | string, string | undefined]>;
  tabColors: Array<[number | string, string | null]>;
  usedRanges: Array<number | string>;
}

/** A workbook transport whose sheet list can be MUTATED between calls, to
 *  simulate the concurrent re-orders the name-identity rule exists for. */
function facetTransport(initialInfos: WorkbookSheetInfo[]): {
  t: WorkbookTransport;
  log: FacetLog;
  state: { infos: WorkbookSheetInfo[]; usedRange: RegionResult };
} {
  const log: FacetLog = {
    renames: [], deletes: [], visibilities: [], moves: [], copies: [],
    tabColors: [], usedRanges: [],
  };
  const state = {
    infos: initialInfos,
    usedRange: { startRow: 1, startCol: 0, endRow: 9, endCol: 3, empty: false } as RegionResult,
  };
  const t: WorkbookTransport = {
    getSheetNames: async () => state.infos.map((s) => s.name),
    getActiveSheet: async () => 0,
    setActiveSheet: async () => {},
    readCell: async (s, r, c) => `${s}:${r}:${c}`,
    writeCell: async () => {},
    readRange: async () => [],
    writeCells: async () => {},
    formatRange: async () => {},
    clearFormatRange: async () => {},
    getSheetInfos: async () => state.infos.map((s) => ({ ...s })),
    renameSheet: async (sheet, newName) => {
      log.renames.push([sheet, newName]);
    },
    deleteSheet: async (sheet) => {
      log.deletes.push(sheet);
    },
    setSheetVisibility: async (sheet, visibility) => {
      log.visibilities.push([sheet, visibility]);
    },
    moveSheet: async (sheet, toIndex) => {
      log.moves.push([sheet, toIndex]);
    },
    copySheet: async (sheet, newName) => {
      log.copies.push([sheet, newName]);
      return { index: 99, name: newName ?? "Copy" };
    },
    setTabColor: async (sheet, color) => {
      log.tabColors.push([sheet, color]);
    },
    usedRange: async (sheet) => {
      log.usedRanges.push(sheet);
      return state.usedRange;
    },
  };
  return { t, log, state };
}

const infos = (names: string[]): WorkbookSheetInfo[] =>
  names.map((name, index) => ({ index, name, visibility: "visible", tabColor: null }));

describe("rich ScriptSheet facet", () => {
  it("every management delegate passes the sheet's NAME, never its index", async () => {
    const { t, log } = facetTransport(infos(["Intro", "Data", "Extra"]));
    const wb = makeWorkbook(t);
    const sheet = (await wb.sheet("Data"))!;
    await sheet.setVisibility("hidden");
    await sheet.setTabColor("#0078D4");
    await sheet.setTabColor(null);
    await sheet.move(0);
    await sheet.copy("Data copy");
    await sheet.copy();
    await sheet.delete();
    expect(log.visibilities).toEqual([["Data", "hidden"]]);
    expect(log.tabColors).toEqual([["Data", "#0078D4"], ["Data", null]]);
    expect(log.moves).toEqual([["Data", 0]]);
    expect(log.copies).toEqual([["Data", "Data copy"], ["Data", undefined]]);
    expect(log.deletes).toEqual(["Data"]);
  });

  it("rename re-points the handle: later calls use the NEW name", async () => {
    const { t, log, state } = facetTransport(infos(["Intro", "Data"]));
    const wb = makeWorkbook(t);
    const sheet = (await wb.sheet("Data"))!;
    await sheet.rename("Data 2024");
    expect(log.renames).toEqual([["Data", "Data 2024"]]);
    expect(sheet.name).toBe("Data 2024");
    // Keep the listing in step, then drive the handle again.
    state.infos = infos(["Intro", "Data 2024"]);
    await sheet.delete();
    expect(log.deletes).toEqual(["Data 2024"]);
  });

  it("visibility()/tabColor() read the sheet's CURRENT entry by name — a re-order cannot redirect them", async () => {
    const { t, state } = facetTransport(infos(["Intro", "Data"]));
    const wb = makeWorkbook(t);
    const sheet = (await wb.sheet("Data"))!; // built at index 1
    // The user drags Data to the front and colours it.
    state.infos = [
      { index: 0, name: "Data", visibility: "veryHidden", tabColor: "#FF0000" },
      { index: 1, name: "Intro", visibility: "visible", tabColor: null },
    ];
    expect(await sheet.visibility()).toBe("veryHidden");
    expect(await sheet.tabColor()).toBe("#FF0000");
  });

  it("visibility() on a deleted sheet throws listing the surviving sheets", async () => {
    const { t, state } = facetTransport(infos(["Intro", "Data"]));
    const wb = makeWorkbook(t);
    const sheet = (await wb.sheet("Data"))!;
    state.infos = infos(["Intro"]);
    await expect(sheet.visibility()).rejects.toThrow(
      'Sheet "Data" no longer exists. Sheets in this workbook: "Intro"',
    );
  });

  it("usedRange() resolves null when empty, else a live range bound to the sheet's CURRENT index", async () => {
    const { t, log, state } = facetTransport(infos(["Intro", "Data"]));
    const wb = makeWorkbook(t);
    const sheet = (await wb.sheet("Data"))!; // built at index 1
    // Re-order: Data now sits at position 0.
    state.infos = infos(["Data", "Intro"]);
    const used = (await sheet.usedRange())!;
    expect(log.usedRanges).toEqual(["Data"]); // asked BY NAME
    expect(used.address).toBe("A2:D10");
    // The returned range reads the FRESH index (0), not the stale one (1).
    expect(await used.getValue()).toBe("0:1:0");
    state.usedRange = { startRow: 0, startCol: 0, endRow: 0, endCol: 0, empty: true };
    expect(await sheet.usedRange()).toBeNull();
  });

  describe("move({before/after}) arithmetic (backend = remove-then-insert at toIndex)", () => {
    // Sheets: A(0) B(1) C(2) D(3).
    const four = () => facetTransport(infos(["A", "B", "C", "D"]));

    it("before a LATER sheet: anchor shifts down once self is removed", async () => {
      const { t, log } = four();
      const sheet = (await makeWorkbook(t).sheet("B"))!;
      await sheet.move({ before: "D" }); // B out -> A C D; before D = position 2
      expect(log.moves).toEqual([["B", 2]]);
    });

    it("after a LATER sheet lands ON the anchor's old position", async () => {
      const { t, log } = four();
      const sheet = (await makeWorkbook(t).sheet("B"))!;
      await sheet.move({ after: "D" }); // B out -> A C D; after D = position 3
      expect(log.moves).toEqual([["B", 3]]);
    });

    it("before an EARLIER sheet uses the anchor's own position", async () => {
      const { t, log } = four();
      const sheet = (await makeWorkbook(t).sheet("C"))!;
      await sheet.move({ before: "A" }); // C lands at 0
      expect(log.moves).toEqual([["C", 0]]);
    });

    it("after an EARLIER sheet lands just past it (numeric anchor form)", async () => {
      const { t, log } = four();
      const sheet = (await makeWorkbook(t).sheet("C"))!;
      await sheet.move({ after: 0 }); // after A -> position 1
      expect(log.moves).toEqual([["C", 1]]);
    });

    it("relative to ITSELF refuses; an unknown anchor throws listing the sheets", async () => {
      const { t, log } = four();
      const sheet = (await makeWorkbook(t).sheet("B"))!;
      await expect(sheet.move({ before: "B" })).rejects.toThrow(/relative to itself/);
      await expect(sheet.move({ after: "Nope" })).rejects.toThrow(/No sheet named "Nope"/);
      await expect(sheet.move({ before: 9 })).rejects.toThrow(/No sheet at position 9/);
      expect(log.moves).toEqual([]);
    });
  });

  it("facet methods THROW an honest error on a transport without the sheet-management ops", async () => {
    // The base transport shape (pre-Wave-2): navigation only.
    const bare: WorkbookTransport = {
      getSheetNames: async () => ["Only"],
      getActiveSheet: async () => 0,
      setActiveSheet: async () => {},
      readCell: async () => "",
      writeCell: async () => {},
      readRange: async () => [],
      writeCells: async () => {},
      formatRange: async () => {},
      clearFormatRange: async () => {},
    };
    const sheet = (await makeWorkbook(bare).sheet("Only"))!;
    await expect(sheet.rename("X")).rejects.toThrow(/rename\(\) is not available/);
    await expect(sheet.usedRange()).rejects.toThrow(/usedRange\(\) is not available/);
    await expect(sheet.visibility()).rejects.toThrow(/visibility\(\) is not available/);
    await expect(sheet.move(0)).rejects.toThrow(/move\(\) is not available/);
  });
});
