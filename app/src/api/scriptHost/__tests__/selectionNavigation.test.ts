//! FILENAME: app/src/api/scriptHost/__tests__/selectionNavigation.test.ts
// PURPOSE: Wave 2 selection + navigation surface.
// COVERS:  (1) normalizeSelection / normalizeSelectionArea — the shape
//              api.getSelection returns, including MULTI-AREA selections and
//              the anchor-after-active drag direction Core stores raw;
//          (2) the vSelect / vScrollTo / vClearRange validator matrices
//              (numbers only — the A1 string form resolves worker-side);
//          (3) the ALLOWLIST rows' tier/class/limits wiring;
//          (4) the WORKER SHIM: api.select's polymorphic forms resolve to the
//              one numeric broker shape, and getSelection / selection() /
//              activeCell() / scrollTo / clearRange / getSheets dispatch the
//              right methods with the right arguments.

import { describe, expect, it } from "vitest";
import { normalizeSelection, normalizeSelectionArea } from "../host";
import {
  vSelect,
  vScrollTo,
  vClearRange,
  MAX_SELECT_AREAS,
  MAX_RANGE_CELLS,
  SCRIPT_CLEAR_APPLY_TO,
} from "../validators";
import { ALLOWLIST } from "../allowlist";
import { buildWorkerContext, type WorkerRuntime } from "../worker/contextShims";
import type { MountSpec, W2H } from "../protocol";

// ============================================================================
// (1) normalizeSelection: Core's raw Selection -> the script shape
// ============================================================================

describe("normalizeSelectionArea", () => {
  it("leaves an already-normalized rectangle alone", () => {
    expect(normalizeSelectionArea({ startRow: 1, startCol: 2, endRow: 5, endCol: 6 })).toEqual({
      startRow: 1, startCol: 2, endRow: 5, endCol: 6,
    });
  });

  it("swaps corners from an up-and-left drag (anchor AFTER the active cell)", () => {
    expect(normalizeSelectionArea({ startRow: 9, startCol: 7, endRow: 2, endCol: 3 })).toEqual({
      startRow: 2, startCol: 3, endRow: 9, endCol: 7,
    });
  });
});

describe("normalizeSelection", () => {
  it("normalizes the primary rectangle but keeps the ACTIVE cell raw", () => {
    // Dragged from (9,7) up to (2,3): the active cell is the END, per Core's
    // Selection convention, and must survive normalization unchanged.
    const out = normalizeSelection(
      { startRow: 9, startCol: 7, endRow: 2, endCol: 3 },
      0,
    );
    expect(out.startRow).toBe(2);
    expect(out.startCol).toBe(3);
    expect(out.endRow).toBe(9);
    expect(out.endCol).toBe(7);
    expect(out.activeRow).toBe(2);
    expect(out.activeCol).toBe(3);
  });

  it("always carries at least the primary area", () => {
    const out = normalizeSelection({ startRow: 0, startCol: 0, endRow: 0, endCol: 0 }, 0);
    expect(out.areas).toEqual([{ startRow: 0, startCol: 0, endRow: 0, endCol: 0 }]);
  });

  it("carries EVERY additional range, normalized, primary first", () => {
    const out = normalizeSelection(
      {
        startRow: 0, startCol: 0, endRow: 1, endCol: 1,
        additionalRanges: [
          { startRow: 5, startCol: 5, endRow: 3, endCol: 2 }, // stored reversed
          { startRow: 8, startCol: 0, endRow: 8, endCol: 4 },
        ],
      },
      0,
    );
    expect(out.areas).toEqual([
      { startRow: 0, startCol: 0, endRow: 1, endCol: 1 },
      { startRow: 3, startCol: 2, endRow: 5, endCol: 5 },
      { startRow: 8, startCol: 0, endRow: 8, endCol: 4 },
    ]);
  });

  it("uses the selection's own sheetIndex when it has one, else the fallback", () => {
    const withOwn = normalizeSelection(
      { startRow: 0, startCol: 0, endRow: 0, endCol: 0, sheetIndex: 4 },
      1,
    );
    expect(withOwn.sheetIndex).toBe(4);
    const withFallback = normalizeSelection(
      { startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
      1,
    );
    expect(withFallback.sheetIndex).toBe(1);
  });

  it("honours explicit activeRow/activeCol aliases when present", () => {
    const out = normalizeSelection(
      { startRow: 0, startCol: 0, endRow: 5, endCol: 5, activeRow: 3, activeCol: 2 },
      0,
    );
    expect(out.activeRow).toBe(3);
    expect(out.activeCol).toBe(2);
  });
});

// ============================================================================
// (2) validators
// ============================================================================

describe("vSelect", () => {
  it("accepts the single-cell, rectangle and options forms", () => {
    expect(vSelect([2, 3])).toBe(true);
    expect(vSelect([0, 0, 9, 3])).toBe(true);
    expect(vSelect([0, 0, 9, 3, {}])).toBe(true);
    expect(vSelect([0, 0, 9, 3, { scroll: false }])).toBe(true);
    expect(vSelect([0, 0, 9, 3, { sheetIndex: 2 }])).toBe(true);
    expect(vSelect([0, 0, 9, 3, { sheetIndex: "Data" }])).toBe(true);
    expect(vSelect([0, 0, undefined, undefined, { scroll: true }])).toBe(true);
  });

  it("accepts a multi-area ranges option", () => {
    expect(
      vSelect([0, 0, 0, 3, { ranges: [{ startRow: 5, startCol: 0, endRow: 5, endCol: 3 }] }]),
    ).toBe(true);
  });

  it("rejects non-coordinate corners", () => {
    expect(vSelect(["A1", 0])).not.toBe(true);
    expect(vSelect([-1, 0])).not.toBe(true);
    expect(vSelect([0, 0.5])).not.toBe(true);
    expect(vSelect([0, 0, "B", 3])).not.toBe(true);
  });

  it("rejects an unknown option key with the accepted list", () => {
    const verdict = vSelect([0, 0, 0, 0, { scrollTo: true }]);
    expect(verdict).toContain("sheetIndex, scroll, ranges");
  });

  it("rejects a non-boolean scroll and a non-array ranges", () => {
    expect(vSelect([0, 0, 0, 0, { scroll: 1 }])).not.toBe(true);
    expect(vSelect([0, 0, 0, 0, { ranges: {} }])).not.toBe(true);
  });

  it("rejects a malformed area, naming which one", () => {
    const verdict = vSelect([0, 0, 0, 0, { ranges: [{ startRow: 0 }] }]);
    expect(verdict).toContain("ranges[0]");
  });

  it("caps the area count at MAX_SELECT_AREAS", () => {
    const areas = Array.from({ length: MAX_SELECT_AREAS + 1 }, (_, i) => ({
      startRow: i, startCol: 0, endRow: i, endCol: 0,
    }));
    expect(vSelect([0, 0, 0, 0, { ranges: areas }])).toContain("too many areas");
    expect(vSelect([0, 0, 0, 0, { ranges: areas.slice(0, MAX_SELECT_AREAS) }])).toBe(true);
  });
});

describe("vScrollTo", () => {
  it("accepts coordinates with an optional sheet ref (index or name)", () => {
    expect(vScrollTo([0, 0])).toBe(true);
    expect(vScrollTo([100, 3, 2])).toBe(true);
    expect(vScrollTo([100, 3, "Data"])).toBe(true);
  });

  it("rejects bad coordinates and bad sheet refs", () => {
    expect(vScrollTo([-1, 0])).not.toBe(true);
    expect(vScrollTo([0, "B"])).not.toBe(true);
    expect(vScrollTo([0, 0, true])).not.toBe(true);
  });
});

describe("vClearRange applyTo matrix", () => {
  it("accepts each of the three script-facing modes, and no options at all", () => {
    expect(vClearRange([0, 0, 9, 3])).toBe(true);
    for (const applyTo of SCRIPT_CLEAR_APPLY_TO) {
      expect(vClearRange([0, 0, 9, 3, { applyTo }]), applyTo).toBe(true);
    }
  });

  it("rejects the backend-only ClearApplyTo refinements and typos, listing the accepted set", () => {
    for (const bad of ["hyperlinks", "removeHyperlinks", "resetContents", "format", "ALL"]) {
      const verdict = vClearRange([0, 0, 9, 3, { applyTo: bad }]);
      expect(verdict, bad).toContain("all, contents, formats");
    }
  });

  it("rejects an unknown option key", () => {
    expect(vClearRange([0, 0, 9, 3, { mode: "all" }])).toContain('unknown clear option "mode"');
  });

  it("shares the bulk-range gates: inverted corners and oversized ranges refuse", () => {
    expect(vClearRange([5, 0, 0, 0])).not.toBe(true);
    expect(vClearRange([0, 0, MAX_RANGE_CELLS, 3])).toContain("range too large");
  });

  it("accepts an optional trailing sheet ref (index or name)", () => {
    expect(vClearRange([0, 0, 9, 3, undefined, "Data"])).toBe(true);
    expect(vClearRange([0, 0, 9, 3, { applyTo: "contents" }, 1])).toBe(true);
  });
});

// ============================================================================
// (3) allowlist wiring
// ============================================================================

describe("Wave 2 allowlist rows", () => {
  it("reads are class read, mutations class mutate, all unlocked tier, no capability", () => {
    expect(ALLOWLIST["api.getSelection"]).toMatchObject({ tier: "unlocked", class: "read" });
    expect(ALLOWLIST["api.getSheets"]).toMatchObject({ tier: "unlocked", class: "read" });
    expect(ALLOWLIST["api.select"]).toMatchObject({ tier: "unlocked", class: "mutate" });
    expect(ALLOWLIST["api.scrollTo"]).toMatchObject({ tier: "unlocked", class: "mutate" });
    expect(ALLOWLIST["api.clearRange"]).toMatchObject({ tier: "unlocked", class: "mutate" });
    for (const m of ["api.getSelection", "api.getSheets", "api.select", "api.scrollTo", "api.clearRange"]) {
      expect(ALLOWLIST[m].capability, m).toBeUndefined();
    }
  });

  it("declared limits match the enforced constants", () => {
    expect(ALLOWLIST["api.select"].limits).toEqual({ maxAreas: MAX_SELECT_AREAS });
    expect(ALLOWLIST["api.clearRange"].limits).toEqual({ maxCells: MAX_RANGE_CELLS });
  });

  it("the validators on the rows are the ones tested above", () => {
    expect(ALLOWLIST["api.select"].validate).toBe(vSelect);
    expect(ALLOWLIST["api.scrollTo"].validate).toBe(vScrollTo);
    expect(ALLOWLIST["api.clearRange"].validate).toBe(vClearRange);
  });
});

// ============================================================================
// (4) worker shim: polymorphic select + selection-bound ranges
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
    scriptId: "wave2-test",
    objectType: "sheet",
    instanceId: null,
    tier: "unlocked",
    capabilities: [],
    apiVersion: "1.0.0",
    scriptName: "Wave2",
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

const SELECTION = {
  sheetIndex: 2,
  startRow: 1,
  startCol: 0,
  endRow: 4,
  endCol: 3,
  activeRow: 4,
  activeCol: 3,
  areas: [{ startRow: 1, startCol: 0, endRow: 4, endCol: 3 }],
};

describe("worker shim: api.select polymorphic forms", () => {
  it("numeric rectangle form forwards verbatim", async () => {
    const { api, calls, drain } = makeContext();
    void (api.select as (...a: unknown[]) => Promise<void>)(0, 1, 9, 3, { scroll: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("api.select");
    expect(calls[0].args).toEqual([0, 1, 9, 3, { scroll: false }]);
    drain();
  });

  it("single-cell numeric form leaves the end corners undefined", () => {
    const { api, calls, drain } = makeContext();
    void (api.select as (...a: unknown[]) => Promise<void>)(2, 3);
    expect(calls[0].args).toEqual([2, 3, undefined, undefined, undefined]);
    drain();
  });

  it("select(r, c, options) treats an object in the endRow slot as the options bag", () => {
    const { api, calls, drain } = makeContext();
    void (api.select as (...a: unknown[]) => Promise<void>)(2, 3, { scroll: false });
    expect(calls[0].args).toEqual([2, 3, undefined, undefined, { scroll: false }]);
    drain();
  });

  it("the A1 string form resolves to NUMBERS before the broker call", () => {
    const { api, calls, drain } = makeContext();
    void (api.select as (...a: unknown[]) => Promise<void>)("B2:D10");
    expect(calls[0].method).toBe("api.select");
    expect(calls[0].args).toEqual([1, 1, 9, 3, {}]);
    drain();
  });

  it("a Sheet! prefix becomes options.sheetIndex (the name still resolves host-side)", () => {
    const { api, calls, drain } = makeContext();
    void (api.select as (...a: unknown[]) => Promise<void>)("Data!A1:B5", { scroll: false });
    expect(calls[0].args).toEqual([0, 0, 4, 1, { scroll: false, sheetIndex: "Data" }]);
    drain();
  });

  it("a quoted sheet prefix unescapes, and WINS over options.sheetIndex", () => {
    const { api, calls, drain } = makeContext();
    void (api.select as (...a: unknown[]) => Promise<void>)("'My ''Q1'' Sheet'!A1", {
      sheetIndex: 0,
    });
    expect(calls[0].args).toEqual([0, 0, 0, 0, { sheetIndex: "My 'Q1' Sheet" }]);
    drain();
  });

  it("string form with a non-object second argument throws without posting", () => {
    const { api, calls } = makeContext();
    expect(() => (api.select as (...a: unknown[]) => Promise<void>)("A1", 5)).toThrow(
      /options must be an object/,
    );
    expect(calls).toHaveLength(0);
  });

  it("an invalid address throws without posting", () => {
    const { api, calls } = makeContext();
    expect(() => (api.select as (...a: unknown[]) => Promise<void>)("not an address")).toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe("worker shim: selection reads and navigation", () => {
  it("getSelection dispatches api.getSelection with no arguments", () => {
    const { api, calls, drain } = makeContext();
    void (api.getSelection as () => Promise<unknown>)();
    expect(calls[0]).toMatchObject({ method: "api.getSelection", args: [] });
    drain();
  });

  it("selection() binds the primary area as a ScriptRange on the selection's sheet", async () => {
    const { api, rt, calls } = makeContext();
    const promise = (api.selection as () => Promise<Record<string, unknown> | null>)();
    rt.settleCall(calls[0].callId, true, SELECTION);
    const range = await promise;
    expect(range).not.toBeNull();
    expect(range).toMatchObject({ startRow: 1, startCol: 0, endRow: 4, endCol: 3 });
    expect((range as { address: string }).address).toBe("A2:D5");
    // The range is LIVE: reading it goes through the sheet-bound transport
    // carrying the selection's own sheetIndex.
    calls.length = 0;
    void (range as { getValue: () => Promise<string> }).getValue();
    expect(calls[0].method).toBe("sheet.getCellValue");
    expect(calls[0].args).toEqual([1, 0, 2]);
    for (const entry of rt.pending.values()) clearTimeout(entry.timer);
    rt.pending.clear();
  });

  it("activeCell() binds a single-cell range at the active cell", async () => {
    const { api, rt, calls } = makeContext();
    const promise = (api.activeCell as () => Promise<Record<string, unknown> | null>)();
    rt.settleCall(calls[0].callId, true, SELECTION);
    const cell = await promise;
    expect(cell).toMatchObject({ startRow: 4, startCol: 3, endRow: 4, endCol: 3 });
    expect((cell as { isSingleCell: boolean }).isSingleCell).toBe(true);
  });

  it("selection() and activeCell() resolve null when nothing is selected", async () => {
    const { api, rt, calls } = makeContext();
    const p1 = (api.selection as () => Promise<unknown>)();
    rt.settleCall(calls[0].callId, true, null);
    expect(await p1).toBeNull();
    const p2 = (api.activeCell as () => Promise<unknown>)();
    rt.settleCall(calls[1].callId, true, null);
    expect(await p2).toBeNull();
  });

  it("scrollTo and clearRange forward their arguments verbatim", () => {
    const { api, calls, drain } = makeContext();
    void (api.scrollTo as (...a: unknown[]) => Promise<void>)(500, 2, "Data");
    void (api.clearRange as (...a: unknown[]) => Promise<unknown>)(
      0, 0, 9, 3, { applyTo: "contents" }, 1,
    );
    expect(calls[0]).toMatchObject({ method: "api.scrollTo", args: [500, 2, "Data"] });
    expect(calls[1]).toMatchObject({
      method: "api.clearRange",
      args: [0, 0, 9, 3, { applyTo: "contents" }, 1],
    });
    drain();
  });

  it("getSheets dispatches api.getSheets and hands the host's shape through", async () => {
    const { api, rt, calls } = makeContext();
    const promise = (api.getSheets as () => Promise<unknown>)();
    expect(calls[0]).toMatchObject({ method: "api.getSheets", args: [] });
    const sheets = [
      { index: 0, name: "Sheet1", visibility: "visible", tabColor: null },
      { index: 1, name: "Hidden", visibility: "veryHidden", tabColor: "#FF0000" },
    ];
    rt.settleCall(calls[0].callId, true, sheets);
    expect(await promise).toEqual(sheets);
  });
});
