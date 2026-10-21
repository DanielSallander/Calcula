//! FILENAME: app/src/api/scriptHost/__tests__/crossFilterScriptRows.test.ts
// PURPOSE: The script surface of a visual's cross-filter selection (P4 S12):
//          api.getCrossFilters / api.setCrossFilter / api.clearCrossFilters.
// COVERS:  (1) the ALLOWLIST rows: unlocked, no capability, `read` for the
//              getter and `emit` -- never `ui` -- for both writers, so their
//              deadline is the MACHINE deadline, not UI_DIALOG_DEADLINE_MS;
//          (2) the validators, and the vSetState refusal of every
//              `crossFilter.*` aspect (the `return true` tail lesson);
//          (3) the HOST executors over @api/reportPages' snapshot and
//              @api/modelVisuals: an unknown ref and a non-source are refused,
//              a source's selection lands in @api/reportFilters with the
//              seam's own name and connection, and NO backend command is
//              invoked at all (view state);
//          (4) the audit-ring entry: the source ref and the tuple count, never
//              a member key;
//          (5) the WORKER shims: the exact broker tuples they send.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  snapshot: {
    pages: [] as Array<{ sheetId: string; name: string; index: number; visibility: string; isTooltipPage: boolean }>,
    sheetIdByIndex: new Map<number, string>(),
    activeIndex: 0,
    version: 1,
  },
  invoke: vi.fn(async () => {
    throw new Error("no backend in this suite");
  }),
}));

vi.mock("@tauri-apps/api/core", async (orig) => ({
  ...(await orig<typeof import("@tauri-apps/api/core")>()),
  invoke: h.invoke,
}));
vi.mock("../../grid", () => ({
  refreshGridData: vi.fn(),
  refreshGridDimensions: vi.fn(),
  setActiveSheet: vi.fn(),
}));
vi.mock("../../gridDispatch", () => ({ dispatchGridAction: vi.fn() }));
vi.mock("../../reportPages", async (orig) => ({
  ...(await orig<typeof import("../../reportPages")>()),
  getReportPagesSnapshot: () => h.snapshot,
}));

import { executeClearCrossFilters, executeGetCrossFilters, executeSetCrossFilter } from "../host";
import {
  MAX_CROSS_FILTER_FIELDS,
  MAX_CROSS_FILTER_TUPLES,
  vClearCrossFilters,
  vCrossFilterQuery,
  vObjectAspect,
  vSetCrossFilter,
  vSetState,
} from "../validators";
import { ALLOWLIST } from "../allowlist";
import { brokerCall, buildHandleFromDefinition } from "../broker";
import { clearAudit, getAuditTail } from "../auditRing";
import { CALL_TIMEOUT_MS, CLASS_DEADLINES_MS, UI_DIALOG_DEADLINE_MS, callDeadlineMs } from "../protocol";
import { buildWorkerContext, type WorkerRuntime } from "../worker/contextShims";
import type { MountSpec, W2H } from "../protocol";
import { registerModelVisualProvider, type ModelVisualInfo } from "../../modelVisuals";
import { clearCrossFilters, getCrossFilters, setCrossFilter } from "../../reportFilters";

const ROWS = ["api.getCrossFilters", "api.setCrossFilter", "api.clearCrossFilters"] as const;

// Sheets: 0 "Data" (a worksheet), 1 "Board" (canvas, page-1), 2 "Other" (canvas, page-2).
function setPages(activeIndex = 1): void {
  h.snapshot = {
    pages: [
      { sheetId: "page-1", name: "Board", index: 1, visibility: "visible", isTooltipPage: false },
      { sheetId: "page-2", name: "Other", index: 2, visibility: "visible", isTooltipPage: false },
    ],
    sheetIdByIndex: new Map([
      [0, "ws-0"],
      [1, "page-1"],
      [2, "page-2"],
    ]),
    activeIndex,
    version: 2,
  };
}

function visual(
  kind: "chart" | "pivot" | "slicer",
  id: string,
  sheetId: string,
  sheetIndex: number,
  over: Partial<ModelVisualInfo> = {},
): ModelVisualInfo {
  return {
    ref: { kind, id },
    name: `${kind}-${id}`,
    sheetIndex,
    sheetId,
    connectionId: "conn-1",
    role: { source: true, target: true, canHighlight: kind === "chart", reason: null },
    label: kind === "chart" ? "Column chart" : "PivotTable",
    ...over,
  };
}

let offProvider: () => void = () => {};

beforeEach(() => {
  setPages();
  clearCrossFilters();
  clearAudit();
  h.invoke.mockClear();
  offProvider = registerModelVisualProvider({
    kind: "chart",
    list: () => [
      visual("chart", "c1", "page-1", 1),
      visual("pivot", "p1", "page-1", 1),
      visual("chart", "range", "page-1", 1, {
        connectionId: null,
        role: { source: false, target: false, canHighlight: false, reason: "Reads cells, not the model" },
      }),
      visual("chart", "card", "page-1", 1, {
        role: { source: false, target: true, canHighlight: false, reason: "This visual does not filter others" },
        label: "Card",
      }),
      visual("chart", "far", "page-2", 2),
    ],
  });
});

afterEach(() => {
  offProvider();
  clearCrossFilters();
});

// ============================================================================
// (1) Allowlist rows
// ============================================================================

describe("cross-filter allowlist rows", () => {
  it("are unlocked with no capability; the getter reads, the writers EMIT", () => {
    expect(ALLOWLIST["api.getCrossFilters"].class).toBe("read");
    expect(ALLOWLIST["api.setCrossFilter"].class).toBe("emit");
    expect(ALLOWLIST["api.clearCrossFilters"].class).toBe("emit");
    for (const m of ROWS) {
      expect(ALLOWLIST[m].tier, m).toBe("unlocked");
      expect(ALLOWLIST[m].capability, m).toBeUndefined();
    }
    expect(ALLOWLIST["api.getCrossFilters"].validate).toBe(vCrossFilterQuery);
    expect(ALLOWLIST["api.setCrossFilter"].validate).toBe(vSetCrossFilter);
    expect(ALLOWLIST["api.clearCrossFilters"].validate).toBe(vClearCrossFilters);
  });

  it("their deadline is the machine deadline, never the dialog deadline", () => {
    for (const m of ROWS) {
      const cls = ALLOWLIST[m].class;
      expect(cls, m).not.toBe("ui");
      expect(CLASS_DEADLINES_MS[cls], m).toBeLessThan(UI_DIALOG_DEADLINE_MS);
      expect(callDeadlineMs(m), m).toBe(CALL_TIMEOUT_MS);
    }
  });

  it("setCanvasLayout's consent text says it reaches interactions", () => {
    expect(ALLOWLIST["api.setCanvasLayout"].desc).toMatch(/interactions/);
  });
});

// ============================================================================
// (2) Validators
// ============================================================================

describe("vSetCrossFilter", () => {
  const src = { kind: "chart", id: "c1" };

  it("accepts a selection, a null clear, and an optional sheet", () => {
    expect(vSetCrossFilter([src, { fields: ["Geo.Region"], tuples: [["Pacific"]] }])).toBe(true);
    expect(vSetCrossFilter([src, { fields: ["Geo.Region", "Cal.Year"], tuples: [["Pacific", "2024"], ["", "2023"]] }, "Board"])).toBe(true);
    expect(vSetCrossFilter([src, { fields: ["Geo.Region"], tuples: [] }, 1])).toBe(true);
    expect(vSetCrossFilter([src, null])).toBe(true);
  });

  it("refuses a malformed source ref", () => {
    expect(vSetCrossFilter([null, null])).toMatch(/source must be an object/);
    expect(vSetCrossFilter([{ kind: "shape", id: "s" }, null])).toMatch(/source\.kind must be one of chart, pivot, slicer/);
    expect(vSetCrossFilter([{ kind: "chart", id: "" }, null])).toMatch(/source\.id/);
  });

  it("refuses an undefined selection (clearing is an explicit null)", () => {
    expect(vSetCrossFilter([src])).toMatch(/selection must be/);
    expect(vSetCrossFilter([src, []])).toMatch(/selection must be/);
  });

  it("refuses bad fields: none, too many, blank, twice", () => {
    expect(vSetCrossFilter([src, { fields: [], tuples: [] }])).toMatch(/non-empty array/);
    const many = Array.from({ length: MAX_CROSS_FILTER_FIELDS + 1 }, (_x, i) => `T.c${i}`);
    expect(vSetCrossFilter([src, { fields: many, tuples: [] }])).toMatch(
      new RegExp(`${MAX_CROSS_FILTER_FIELDS + 1} fields; the limit is ${MAX_CROSS_FILTER_FIELDS}`),
    );
    expect(vSetCrossFilter([src, { fields: [""], tuples: [] }])).toMatch(/non-empty "Table.Column"/);
    expect(vSetCrossFilter([src, { fields: ["A.b", "A.b"], tuples: [] }])).toMatch(/names a field twice/);
    expect(vSetCrossFilter([src, { fields: ["A.b"], tuples: [], extra: 1 }])).toMatch(/unknown key "extra"/);
  });

  it("refuses bad tuples: too many, wrong length, non-string keys", () => {
    const tuples = Array.from({ length: MAX_CROSS_FILTER_TUPLES + 1 }, (_x, i) => [`k${i}`]);
    expect(vSetCrossFilter([src, { fields: ["A.b"], tuples }])).toMatch(
      new RegExp(`${MAX_CROSS_FILTER_TUPLES + 1} tuples; the limit is ${MAX_CROSS_FILTER_TUPLES}`),
    );
    expect(vSetCrossFilter([src, { fields: ["A.b"], tuples: tuples.slice(1) }])).toBe(true);
    expect(vSetCrossFilter([src, { fields: ["A.b", "A.c"], tuples: [["x"]] }])).toMatch(/one member key per field \(2\)/);
    expect(vSetCrossFilter([src, { fields: ["A.b"], tuples: [[2024]] }])).toMatch(/member KEYS as strings/);
    expect(vSetCrossFilter([src, { fields: ["A.b"], tuples: "x" }])).toMatch(/tuples must be an array/);
  });

  it("refuses a malformed sheet", () => {
    expect(vSetCrossFilter([src, null, -1])).toMatch(/sheet/);
  });
});

describe("vCrossFilterQuery / vClearCrossFilters", () => {
  it("accept an omitted sheet, an index or a name; refuse a malformed one", () => {
    for (const v of [vCrossFilterQuery, vClearCrossFilters]) {
      expect(v([])).toBe(true);
      expect(v([null])).toBe(true);
      expect(v([1])).toBe(true);
      expect(v(["Board"])).toBe(true);
      expect(v([-1])).toMatch(/sheet/);
      expect(v([{}])).toMatch(/sheet/);
    }
  });
});

describe("vSetState -- a cross-filter is not an object aspect", () => {
  it("refuses every crossFilter.* aspect by name, pointing at the dedicated row", () => {
    for (const aspect of ["crossFilter.set", "crossFilter.selection", "crossFilter.clear"]) {
      const verdict = vSetState([aspect, [{ fields: ["A.b"], tuples: [["x"]] }]]);
      expect(verdict, aspect).toMatch(/cross-filter is not an object aspect/);
      expect(verdict, aspect).toMatch(/api\.setCrossFilter\(source, selection, sheet\?\)/);
    }
  });

  it("refuses it through the api.objectSetState door too", () => {
    expect(vObjectAspect(["chart", "c1", "crossFilter.set", [{}]])).toMatch(/api\.setCrossFilter/);
  });

  it("leaves unrelated aspects alone (the prefix is exact)", () => {
    expect(vSetState(["crossFilterish.thing", []])).toBe(true);
  });
});

// ============================================================================
// (3) Host executors
// ============================================================================

describe("executeSetCrossFilter", () => {
  it("lands a source's selection in @api/reportFilters with the seam's own name, page and connection", () => {
    executeSetCrossFilter({ kind: "chart", id: "c1" }, { fields: ["Geo.Region"], tuples: [["Pacific"], ["Pacific"]] });
    expect(getCrossFilters()).toEqual([
      {
        source: { kind: "chart", id: "c1" },
        sourceName: "chart-c1",
        pageSheetId: "page-1",
        connectionId: "conn-1",
        fields: ["Geo.Region"],
        tuples: [["Pacific"]],
      },
    ]);
  });

  it("is VIEW STATE: no backend command is invoked at all", () => {
    executeSetCrossFilter({ kind: "pivot", id: "p1" }, { fields: ["Geo.Region"], tuples: [["Pacific"]] }, "Board");
    executeSetCrossFilter({ kind: "pivot", id: "p1" }, null, 1);
    executeGetCrossFilters();
    executeClearCrossFilters("Board");
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("refuses an UNKNOWN ref, listing the page's visuals", () => {
    expect(() =>
      executeSetCrossFilter({ kind: "chart", id: "ghost" }, { fields: ["Geo.Region"], tuples: [["Pacific"]] }),
    ).toThrow(/setCrossFilter: no visual chart "ghost" on canvas page 'Board' \(visuals there: chart "c1", pivot "p1"/);
    expect(getCrossFilters()).toEqual([]);
  });

  it("refuses a visual that lives on ANOTHER canvas page", () => {
    expect(() =>
      executeSetCrossFilter({ kind: "chart", id: "far" }, { fields: ["Geo.Region"], tuples: [["Pacific"]] }, "Board"),
    ).toThrow(/no visual chart "far" on canvas page 'Board'/);
    // ... but it is a source on its own page.
    executeSetCrossFilter({ kind: "chart", id: "far" }, { fields: ["Geo.Region"], tuples: [["Pacific"]] }, "Other");
    expect(getCrossFilters("page-2")).toHaveLength(1);
  });

  it("refuses a visual that is not a source, with its reason", () => {
    expect(() =>
      executeSetCrossFilter({ kind: "chart", id: "card" }, { fields: ["Geo.Region"], tuples: [["Pacific"]] }),
    ).toThrow(/Card "chart-card" cannot filter other visuals \(This visual does not filter others\)/);
    expect(() =>
      executeSetCrossFilter({ kind: "chart", id: "range" }, { fields: ["Geo.Region"], tuples: [["Pacific"]] }),
    ).toThrow(/cannot filter other visuals \(Reads cells, not the model\)/);
    expect(getCrossFilters()).toEqual([]);
  });

  it("refuses a model slicer as a source: its selection is its own items, never a hidden cross-filter", () => {
    const off = registerModelVisualProvider({
      kind: "slicer",
      list: () => [visual("slicer", "s1", "page-1", 1, { label: "Slicer" })],
    });
    try {
      expect(() =>
        executeSetCrossFilter({ kind: "slicer", id: "s1" }, { fields: ["Geo.Region"], tuples: [["Pacific"]] }),
      ).toThrow(/Slicer "slicer-s1" filters through its own items/);
      expect(getCrossFilters()).toEqual([]);
    } finally {
      off();
    }
  });

  it("null, or no tuples, clears the source's selection", () => {
    executeSetCrossFilter({ kind: "chart", id: "c1" }, { fields: ["Geo.Region"], tuples: [["Pacific"]] });
    executeSetCrossFilter({ kind: "chart", id: "c1" }, null);
    expect(getCrossFilters()).toEqual([]);
    executeSetCrossFilter({ kind: "chart", id: "c1" }, { fields: ["Geo.Region"], tuples: [["Pacific"]] });
    executeSetCrossFilter({ kind: "chart", id: "c1" }, { fields: ["Geo.Region"], tuples: [] });
    expect(getCrossFilters()).toEqual([]);
  });

  it("refuses a worksheet, an unknown index, and an active sheet that is not a canvas", () => {
    const sel = { fields: ["Geo.Region"], tuples: [["Pacific"]] };
    expect(() => executeSetCrossFilter({ kind: "chart", id: "c1" }, sel, 0)).toThrow(
      /sheet 0 is not a canvas page; cross-filter works on canvas pages only/,
    );
    expect(() => executeSetCrossFilter({ kind: "chart", id: "c1" }, sel, 9)).toThrow(/no sheet with index 9/);
    expect(() => executeSetCrossFilter({ kind: "chart", id: "c1" }, sel, "Data")).toThrow(/no canvas page named "Data"/);
    setPages(0);
    expect(() => executeSetCrossFilter({ kind: "chart", id: "c1" }, sel)).toThrow(/the active sheet is not a canvas page/);
  });

  it("names a sheet case-insensitively when unique", () => {
    executeSetCrossFilter({ kind: "chart", id: "c1" }, { fields: ["Geo.Region"], tuples: [["Pacific"]] }, "board");
    expect(getCrossFilters("page-1")).toHaveLength(1);
  });
});

describe("executeGetCrossFilters / executeClearCrossFilters", () => {
  beforeEach(() => {
    setCrossFilter({
      source: { kind: "chart", id: "c1" },
      sourceName: "chart-c1",
      pageSheetId: "page-1",
      connectionId: "conn-1",
      fields: ["Geo.Region", "Cal.Year"],
      tuples: [["Pacific", "2024"]],
    });
    setCrossFilter({
      source: { kind: "chart", id: "far" },
      sourceName: "chart-far",
      pageSheetId: "page-2",
      connectionId: "conn-1",
      fields: ["Geo.Region"],
      tuples: [[""]],
    });
  });

  it("omitted sheet = every page; each selection names its page by index and name", () => {
    expect(executeGetCrossFilters()).toEqual([
      {
        source: { kind: "chart", id: "c1" },
        sourceName: "chart-c1",
        sheetIndex: 1,
        sheetName: "Board",
        fields: ["Geo.Region", "Cal.Year"],
        tuples: [["Pacific", "2024"]],
      },
      {
        source: { kind: "chart", id: "far" },
        sourceName: "chart-far",
        sheetIndex: 2,
        sheetName: "Other",
        fields: ["Geo.Region"],
        tuples: [[""]],
      },
    ]);
  });

  it("a sheet narrows the read to that page", () => {
    expect(executeGetCrossFilters("Other").map((s) => s.source.id)).toEqual(["far"]);
    expect(executeGetCrossFilters(1).map((s) => s.source.id)).toEqual(["c1"]);
  });

  it("the answer is a copy: mutating it changes nothing", () => {
    const [first] = executeGetCrossFilters(1);
    first.tuples.push(["x", "y"]);
    expect(getCrossFilters("page-1")[0].tuples).toEqual([["Pacific", "2024"]]);
  });

  it("clear with a sheet clears that page only; omitted clears every page", () => {
    executeClearCrossFilters("Board");
    expect(getCrossFilters().map((s) => s.source.id)).toEqual(["far"]);
    executeClearCrossFilters();
    expect(getCrossFilters()).toEqual([]);
  });

  it("refuses a worksheet instead of reading 'every page'", () => {
    expect(() => executeGetCrossFilters(0)).toThrow(/not a canvas page/);
    expect(() => executeClearCrossFilters("Data")).toThrow(/no canvas page named "Data"/);
    expect(getCrossFilters()).toHaveLength(2);
  });
});

// ============================================================================
// (4) The audit-ring entry
// ============================================================================

describe("the audit-ring entry", () => {
  const handle = buildHandleFromDefinition({
    id: "xf-script",
    name: "Cross-filter script",
    objectType: "sheet",
    instanceId: null,
    accessLevel: "unlocked",
    declaredCapabilities: [],
  });

  it("names the source and the tuple count, class emit, and never a member key", async () => {
    const args = [{ kind: "chart", id: "c1" }, { fields: ["Geo.Region"], tuples: [["SecretRegionA"], ["SecretRegionB"]] }];
    await brokerCall(handle, "api.setCrossFilter", args, async () =>
      executeSetCrossFilter(args[0] as never, args[1] as never),
    );
    const [entry] = getAuditTail().filter((e) => e.method === "api.setCrossFilter");
    expect(entry).toMatchObject({ method: "api.setCrossFilter", class: "emit", ok: true, detail: "chart:c1, 2 tuple(s)" });
    expect(JSON.stringify(entry)).not.toMatch(/SecretRegion/);
  });

  it("a clear says so; a refusal is the ring's ordinary refusal entry, still without keys", async () => {
    await brokerCall(handle, "api.setCrossFilter", [{ kind: "chart", id: "c1" }, null], async () =>
      executeSetCrossFilter({ kind: "chart", id: "c1" }, null),
    );
    const args = [{ kind: "chart", id: "ghost" }, { fields: ["Geo.Region"], tuples: [["SecretRegionC"]] }];
    await expect(
      brokerCall(handle, "api.setCrossFilter", args, async () => executeSetCrossFilter(args[0] as never, args[1] as never)),
    ).rejects.toThrow(/no visual chart "ghost"/);
    const rows = getAuditTail().filter((e) => e.method === "api.setCrossFilter");
    expect(rows.map((r) => [r.ok, r.error, r.detail])).toEqual([
      [true, undefined, "chart:c1, cleared"],
      [false, "ValidationError", "chart:ghost, 1 tuple(s)"],
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/SecretRegion/);
  });

  it("a malformed call the validator refuses is audited without throwing from the summary", async () => {
    await expect(brokerCall(handle, "api.setCrossFilter", [7, 8], async () => undefined)).rejects.toThrow();
    const [entry] = getAuditTail().filter((e) => e.method === "api.setCrossFilter");
    expect(entry.ok).toBe(false);
    expect(entry.error).toBe("ValidationError");
  });

  it("only rows that declare a summary carry a detail", async () => {
    await brokerCall(handle, "api.clearCrossFilters", [], async () => executeClearCrossFilters());
    const [entry] = getAuditTail().filter((e) => e.method === "api.clearCrossFilters");
    expect(entry).toMatchObject({ class: "emit", ok: true });
    expect(entry.detail).toBeUndefined();
  });
});

// ============================================================================
// (5) Worker shims
// ============================================================================

function makeContext(): { api: Record<string, unknown>; rt: WorkerRuntime; calls: Array<{ method: string; args: unknown[] }>; drain: () => void } {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const spec = {
    protocolVersion: 1,
    scriptId: "xf-test",
    objectType: "sheet",
    instanceId: null,
    tier: "unlocked",
    capabilities: [],
    apiVersion: "1.0.0",
    scriptName: "XF",
    packageInfo: null,
    snapshot: {},
    source: "",
  } as unknown as MountSpec;
  const { context, rt } = buildWorkerContext(spec, (msg: W2H) => {
    if (msg.t === "call") calls.push({ method: msg.method, args: msg.args });
  });
  const drain = (): void => {
    for (const entry of rt.pending.values()) clearTimeout(entry.timer);
    rt.pending.clear();
  };
  return { api: context.api as Record<string, unknown>, rt, calls, drain };
}

describe("worker shims", () => {
  it("send the exact broker tuples", () => {
    const { api, calls, drain } = makeContext();
    const fn = (name: string) => api[name] as (...a: unknown[]) => Promise<unknown>;
    void fn("getCrossFilters")();
    void fn("getCrossFilters")("Board");
    void fn("setCrossFilter")({ kind: "chart", id: "c1" }, { fields: ["A.b"], tuples: [["x"]] });
    void fn("setCrossFilter")({ kind: "chart", id: "c1" }, null, 1);
    void fn("clearCrossFilters")();
    expect(calls.map((c) => [c.method, c.args])).toEqual([
      ["api.getCrossFilters", [undefined]],
      ["api.getCrossFilters", ["Board"]],
      ["api.setCrossFilter", [{ kind: "chart", id: "c1" }, { fields: ["A.b"], tuples: [["x"]] }, undefined]],
      ["api.setCrossFilter", [{ kind: "chart", id: "c1" }, null, 1]],
      ["api.clearCrossFilters", [undefined]],
    ]);
    drain();
  });
});
