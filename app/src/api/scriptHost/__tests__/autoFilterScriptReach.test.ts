//! FILENAME: app/src/api/scriptHost/__tests__/autoFilterScriptReach.test.ts
// PURPOSE: Cover for the three G4 gaps that are broker methods — column
//          filtering (§2.6), sheet move/copy (§2.4) and split panes (§6.6).
// CONTEXT: Two kinds of assertion, deliberately mixed:
//
//   (1) THE 5-FILE PATTERN, derived from source. A shim with no ALLOWLIST row
//       fails CLOSED with UnknownMethod — a bug that has shipped twice here —
//       and a row with no shim inflates the consent text the transparency panel
//       shows the user. Both directions are checked, including the GENERATED
//       typings, which are the authoring surface and the layer most often
//       forgotten.
//
//   (2) THE ROUTING AND THE ABSENCES, because those are where this feature can
//       corrupt a workbook rather than merely fail:
//         - filtering behind the AutoFilter extension's cached range leaves the
//           next chevron click aimed at a DIFFERENT column (the cache stores the
//           filter's start column and clicks send indexes relative to it);
//         - `Table.autoFilterId` is DERIVED state recomputed in Rust
//           (relink_autofilter_owner) and must never be written from here;
//         - moveSheet/copySheet renumber sheets, so a silent clamp would leave
//           a script believing a sheet went somewhere it did not.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { ALLOWLIST } from "../allowlist";
import {
  vAutoFilterRange,
  vAutoFilterColumn,
  vAutoFilterClear,
  vAutoFilterCriteria,
  vMoveSheet,
  vCopySheet,
  vSplit,
  MAX_AUTOFILTER_COLUMNS,
  MAX_AUTOFILTER_VALUES,
} from "../validators";
import {
  registerAutoFilterController,
  resetAutoFilterController,
  hasAutoFilterController,
  requireAutoFilterController,
  type AutoFilterController,
  type AutoFilterSnapshot,
} from "../../autoFilterService";
import { executeAutoFilter } from "../host";

const HOST_DIR = path.resolve(__dirname, "..");
const read = (rel: string): string => fs.readFileSync(path.join(HOST_DIR, rel), "utf8");

const hostSrc = read("host.ts");
const shimSrc = read("worker/contextShims.ts");
const serviceSrc = fs.readFileSync(
  path.resolve(__dirname, "../../autoFilterService.ts"),
  "utf8",
);
const typingsSrc = fs.readFileSync(
  path.resolve(__dirname, "../../../../extensions/ScriptableObjects/objectContexts.d.ts"),
  "utf8",
);
const filterStoreSrc = fs.readFileSync(
  path.resolve(__dirname, "../../../../extensions/AutoFilter/lib/filterStore.ts"),
  "utf8",
);
const autoFilterIndexSrc = fs.readFileSync(
  path.resolve(__dirname, "../../../../extensions/AutoFilter/index.ts"),
  "utf8",
);

const AUTOFILTER_METHODS = [
  "api.autoFilterGet",
  "api.autoFilterListValues",
  "api.autoFilterApply",
  "api.autoFilterSetColumn",
  "api.autoFilterClear",
  "api.autoFilterRemove",
] as const;

const NEW_METHODS = [
  ...AUTOFILTER_METHODS,
  "api.moveSheet",
  "api.copySheet",
  "api.splitPanes",
] as const;

// ============================================================================
// (1) The 5-file pattern
// ============================================================================

describe("G4 broker methods: the 5-file pattern", () => {
  it("every new method has an ALLOWLIST row", () => {
    for (const method of NEW_METHODS) {
      expect(ALLOWLIST[method], `${method} has no policy row`).toBeDefined();
    }
  });

  it("every new method has a validator that actually REFUSES something", () => {
    // vAny would satisfy "has a validator" while checking nothing. Each row is
    // handed an argument list it must reject, so a row wired to vAny by
    // accident fails here instead of shipping an unchecked broker method.
    const mustReject: Record<string, unknown[]> = {
      "api.autoFilterGet": ["unexpected"],
      "api.autoFilterRemove": ["unexpected"],
      "api.autoFilterListValues": [-1],
      "api.autoFilterApply": [10, 0, 0, 4],
      "api.autoFilterSetColumn": [0, { kind: "nonsense" }],
      "api.autoFilterClear": [-2],
      "api.moveSheet": ["a", 1],
      "api.copySheet": [0, "Bad/Name"],
      "api.splitPanes": [-1, null],
    };
    for (const method of NEW_METHODS) {
      const verdict = ALLOWLIST[method].validate(mustReject[method]);
      expect(typeof verdict, `${method} accepted an invalid argument list`).toBe("string");
    }
  });

  it("every new method has a host executor case", () => {
    const cases = new Set([...hostSrc.matchAll(/case\s+"([^"]+)"\s*:/g)].map((m) => m[1]));
    for (const method of NEW_METHODS) {
      expect(cases.has(method), `host.ts has no case for ${method}`).toBe(true);
    }
  });

  it("every new method is called by a worker shim", () => {
    const called = new Set(
      [...shimSrc.matchAll(/\b(?:call|callFire)\(\s*rt\s*,\s*"([^"]+)"/g)].map((m) => m[1]),
    );
    for (const method of NEW_METHODS) {
      expect(called.has(method), `no shim calls ${method}`).toBe(true);
    }
  });

  it("the GENERATED typings declare every new authoring surface", () => {
    // The layer that is routinely forgotten. objectContexts.d.ts is generated
    // from the template, so a missing entry here means the template was not
    // updated and no script author can discover the feature.
    expect(typingsSrc).toContain("splitPanes(splitRow: number | null");
    expect(typingsSrc).toContain("moveSheet(fromIndex: number, toIndex: number)");
    expect(typingsSrc).toContain("copySheet(sourceIndex: number, newName?: string)");
    expect(typingsSrc).toContain("filter: {");
    for (const member of ["listValues(", "setColumn(", "apply(", "remove()"]) {
      expect(typingsSrc).toContain(member);
    }
    expect(typingsSrc).toContain("ScriptAutoFilterCriteria");
    expect(typingsSrc).toContain("app:writeback-submission-received");
  });

  it("all nine rows are unlocked-tier with NO capability", () => {
    // Filtering, reordering sheets and splitting the window all act INSIDE the
    // document the script already rewrites cell by cell. Inventing a capability
    // for them would be theatre, and a capability id that buys nothing is how
    // this program has previously shipped ungrantable ids.
    for (const method of NEW_METHODS) {
      expect(ALLOWLIST[method].tier, method).toBe("unlocked");
      expect(ALLOWLIST[method].capability, method).toBeUndefined();
    }
  });

  it("classes are honest: reads read, mutations mutate", () => {
    expect(ALLOWLIST["api.autoFilterGet"].class).toBe("read");
    expect(ALLOWLIST["api.autoFilterListValues"].class).toBe("read");
    for (const method of [
      "api.autoFilterApply",
      "api.autoFilterSetColumn",
      "api.autoFilterClear",
      "api.autoFilterRemove",
      "api.moveSheet",
      "api.copySheet",
      "api.splitPanes",
    ]) {
      expect(ALLOWLIST[method].class, method).toBe("mutate");
    }
  });

  it("consent text is written for a non-programmer and never names an internal", () => {
    for (const method of NEW_METHODS) {
      const desc = ALLOWLIST[method].desc;
      expect(desc.length, method).toBeGreaterThan(20);
      expect(desc, method).not.toMatch(/autoFilterId|relink|EntityId|regionId|invoke/i);
    }
  });

  it("declared limits are the ones the validator ENFORCES", () => {
    // A limit that exists only in the policy table is worse than none: it tells
    // the transparency panel a bound that nothing checks.
    expect(ALLOWLIST["api.autoFilterApply"].limits).toEqual({
      maxColumns: MAX_AUTOFILTER_COLUMNS,
    });
    expect(vAutoFilterRange([0, 0, 10, MAX_AUTOFILTER_COLUMNS])).toMatch(/too wide/);
    expect(ALLOWLIST["api.autoFilterSetColumn"].limits).toEqual({
      maxValues: MAX_AUTOFILTER_VALUES,
    });
    expect(
      vAutoFilterCriteria([0, { kind: "values", values: new Array(MAX_AUTOFILTER_VALUES + 1).fill("x") }]),
    ).toMatch(/at most/);
  });
});

// ============================================================================
// (2) Validators
// ============================================================================

describe("AutoFilter validators", () => {
  it("accepts the two criteria shapes and nothing else", () => {
    expect(vAutoFilterCriteria([0, { kind: "values", values: ["a", "b"] }])).toBe(true);
    expect(vAutoFilterCriteria([0, { kind: "values", values: [], includeBlanks: true }])).toBe(true);
    expect(vAutoFilterCriteria([2, { kind: "custom", criterion1: ">=100" }])).toBe(true);
    expect(
      vAutoFilterCriteria([2, { kind: "custom", criterion1: ">1", criterion2: "<9", operator: "and" }]),
    ).toBe(true);
    expect(vAutoFilterCriteria([0, { kind: "color", color: "#fff" }])).toMatch(/kind must be/);
    expect(vAutoFilterCriteria([0, { kind: "values" }])).toMatch(/values must be an array/);
    expect(vAutoFilterCriteria([0, { kind: "custom", criterion1: "  " }])).toMatch(/non-empty/);
    expect(vAutoFilterCriteria([0, { kind: "custom", criterion1: ">1", operator: "xor" }])).toMatch(
      /"and" or "or"/,
    );
    expect(vAutoFilterCriteria([0, null])).toMatch(/criteria must be an object/);
  });

  it("refuses an unknown criteria key rather than ignoring it", () => {
    // Silently dropping "sheetIndex" would let an author believe a filter had
    // been aimed at another sheet.
    expect(
      vAutoFilterCriteria([0, { kind: "values", values: [], sheetIndex: 2 }]),
    ).toMatch(/unknown criteria option "sheetIndex"/);
  });

  it("column indexes are non-negative integers", () => {
    expect(vAutoFilterColumn([0])).toBe(true);
    expect(vAutoFilterColumn([-1])).toMatch(/non-negative/);
    expect(vAutoFilterColumn([1.5])).toMatch(/non-negative/);
    expect(vAutoFilterColumn(["1"])).toMatch(/non-negative/);
  });

  it("clear accepts null (every column) but not a bad index", () => {
    expect(vAutoFilterClear([null])).toBe(true);
    expect(vAutoFilterClear([])).toBe(true);
    expect(vAutoFilterClear([3])).toBe(true);
    expect(vAutoFilterClear([-2])).toMatch(/non-negative/);
  });

  it("apply rejects an inverted rectangle", () => {
    expect(vAutoFilterRange([0, 0, 10, 4])).toBe(true);
    expect(vAutoFilterRange([10, 0, 0, 4])).toMatch(/endRow must be >= startRow/);
    expect(vAutoFilterRange([0, 4, 10, 0])).toMatch(/endCol must be >= startCol/);
  });
});

describe("sheet move/copy and split validators", () => {
  it("moveSheet takes two non-negative integers", () => {
    expect(vMoveSheet([0, 2])).toBe(true);
    expect(vMoveSheet([-1, 2])).toMatch(/fromIndex/);
    expect(vMoveSheet([0, "2"])).toMatch(/toIndex/);
  });

  it("copySheet validates the optional name with the SHEET rules", () => {
    expect(vCopySheet([0])).toBe(true);
    expect(vCopySheet([0, "February"])).toBe(true);
    expect(vCopySheet([0, "Bad/Name"])).toMatch(/may not contain/);
    expect(vCopySheet([0, "   "])).toMatch(/non-empty/);
  });

  it("splitPanes reports its OWN argument names, not freezePanes'", () => {
    // Same shape as vFreeze, separate validator: "freezeRow must be..." on a
    // splitPanes() call sends an author looking in the wrong place.
    expect(vSplit([null, null])).toBe(true);
    expect(vSplit([5, 2])).toBe(true);
    expect(vSplit([-1, null])).toBe("splitRow must be a non-negative integer or null");
    expect(vSplit([null, 1.5])).toBe("splitCol must be a non-negative integer or null");
  });
});

// ============================================================================
// (3) The routing: through the extension's seam, never around it
// ============================================================================

function makeSnapshot(overrides: Partial<AutoFilterSnapshot> = {}): AutoFilterSnapshot {
  return {
    id: "af-1",
    startRow: 0,
    startCol: 0,
    endRow: 10,
    endCol: 3,
    enabled: true,
    isDataFiltered: false,
    columns: [null, null, null, null],
    hiddenRows: [],
    ...overrides,
  };
}

function makeController() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const controller: AutoFilterController = {
    get: vi.fn(async () => {
      calls.push({ method: "get", args: [] });
      return makeSnapshot();
    }),
    listValues: vi.fn(async (columnIndex: number) => {
      calls.push({ method: "listValues", args: [columnIndex] });
      return { values: [{ value: "North", count: 3 }], hasBlanks: true };
    }),
    apply: vi.fn(async (a: number, b: number, c: number, d: number) => {
      calls.push({ method: "apply", args: [a, b, c, d] });
      return makeSnapshot({ startRow: a, startCol: b, endRow: c, endCol: d });
    }),
    setColumn: vi.fn(async (columnIndex: number, criteria: unknown) => {
      calls.push({ method: "setColumn", args: [columnIndex, criteria] });
      return makeSnapshot({ isDataFiltered: true, hiddenRows: [3, 4] });
    }),
    clear: vi.fn(async (columnIndex: number | null) => {
      calls.push({ method: "clear", args: [columnIndex] });
      return makeSnapshot();
    }),
    remove: vi.fn(async () => {
      calls.push({ method: "remove", args: [] });
    }),
  };
  return { controller, calls };
}

describe("the AutoFilter executor", () => {
  afterEach(() => {
    resetAutoFilterController();
  });

  it("REFUSES loudly when no provider is registered", async () => {
    resetAutoFilterController();
    expect(hasAutoFilterController()).toBe(false);
    await expect(executeAutoFilter("api.autoFilterGet", [])).rejects.toThrow(
      /AutoFilter provider is registered/i,
    );
    // Not "returns null", not "returns an empty filter" — a caller cannot tell
    // "the feature is off" from "nothing matched" if the answer is empty.
    expect(() => requireAutoFilterController()).toThrow();
  });

  it("passes each method's arguments through in order", async () => {
    const { controller, calls } = makeController();
    registerAutoFilterController(controller);

    await executeAutoFilter("api.autoFilterGet", []);
    await executeAutoFilter("api.autoFilterListValues", [2]);
    await executeAutoFilter("api.autoFilterApply", [1, 2, 30, 6]);
    await executeAutoFilter("api.autoFilterSetColumn", [
      3,
      { kind: "custom", criterion1: ">=100" },
    ]);
    await executeAutoFilter("api.autoFilterRemove", []);

    expect(calls).toEqual([
      { method: "get", args: [] },
      { method: "listValues", args: [2] },
      // The order that matters: startRow, startCol, endRow, endCol — four bare
      // integers, so a transposition would be invisible without this.
      { method: "apply", args: [1, 2, 30, 6] },
      { method: "setColumn", args: [3, { kind: "custom", criterion1: ">=100" }] },
      { method: "remove", args: [] },
    ]);
  });

  it("clear() with no argument means EVERY column, not column 0", async () => {
    const { controller, calls } = makeController();
    registerAutoFilterController(controller);
    await executeAutoFilter("api.autoFilterClear", []);
    await executeAutoFilter("api.autoFilterClear", [undefined]);
    await executeAutoFilter("api.autoFilterClear", [0]);
    expect(calls.map((c) => c.args[0])).toEqual([null, null, 0]);
  });

  it("returns what the controller returned, unmodified", async () => {
    const { controller } = makeController();
    registerAutoFilterController(controller);
    const result = (await executeAutoFilter("api.autoFilterSetColumn", [
      1,
      { kind: "values", values: ["North"] },
    ])) as AutoFilterSnapshot;
    expect(result.hiddenRows).toEqual([3, 4]);
    expect(result.isDataFiltered).toBe(true);
  });

  it("re-registration wins, and the STALE cleanup cannot blank the live one", async () => {
    const first = makeController();
    const second = makeController();
    const disposeFirst = registerAutoFilterController(first.controller);
    registerAutoFilterController(second.controller);
    disposeFirst(); // the old extension instance's cleanup, running late
    expect(hasAutoFilterController()).toBe(true);
    await executeAutoFilter("api.autoFilterGet", []);
    expect(second.calls).toHaveLength(1);
    expect(first.calls).toHaveLength(0);
  });
});

// ============================================================================
// (4) The absences, read out of source so they stay justified
// ============================================================================

describe("AutoFilter: what the script path must NOT do", () => {
  it("host.ts never calls an AutoFilter backend command directly", () => {
    // Going straight to the backend would leave the extension's cached range
    // stale, and a chevron click sends a column index RELATIVE to that cache —
    // so the next click would filter a different column than the one pressed.
    for (const command of [
      "applyAutoFilter",
      "removeAutoFilter",
      "clearAutoFilterCriteria",
      "clearColumnCriteria",
      "setColumnFilterValues",
      "setColumnCustomFilter",
      "getFilterUniqueValues",
      "setHiddenRows",
    ]) {
      expect(hostSrc, `host.ts reaches past the seam via ${command}`).not.toContain(command);
    }
  });

  it("nothing on the script path touches the DERIVED table-ownership link", () => {
    // Table.autoFilterId is recomputed by Rust (relink_autofilter_owner) inside
    // the same commands the controller calls, after releasing the auto_filters
    // guard (canonical lock order: tables -> auto_filters). Maintaining it from
    // the frontend would both duplicate that rule and get it wrong.
    for (const [name, src] of [
      ["host.ts", hostSrc],
      ["autoFilterService.ts", serviceSrc],
      ["filterStore.ts", filterStoreSrc],
    ] as const) {
      expect(src, `${name} writes derived ownership state`).not.toMatch(
        /autoFilterId\s*[:=]/,
      );
    }
  });

  it("the seam is feature-neutral: @api never imports the AutoFilter extension", () => {
    expect(serviceSrc).not.toMatch(/from\s+["'].*extensions\//);
    expect(hostSrc).not.toMatch(/from\s+["'].*extensions\/AutoFilter/);
  });

  it("the extension registers the controller and tears it down on deactivate", () => {
    expect(autoFilterIndexSrc).toContain("registerAutoFilterController(createAutoFilterController())");
    // Pushed onto cleanupFns, which deactivate() drains — a controller that
    // outlived its extension would drive a store that had reset its state.
    expect(autoFilterIndexSrc).toMatch(
      /cleanupFns\.push\(registerAutoFilterController\(/,
    );
  });

  it("the script surface offers no sheetIndex it cannot honour", () => {
    // Every AutoFilter backend command acts on the ACTIVE sheet and takes no
    // sheet parameter. Accepting one here and ignoring it is the exact shape of
    // "answers wrong": the caller would believe another sheet had been filtered.
    for (const validator of [vAutoFilterRange, vAutoFilterColumn, vAutoFilterClear]) {
      expect(validator.toString()).not.toContain("sheetIndex");
    }
    expect(ALLOWLIST["api.autoFilterApply"].desc).not.toMatch(/sheet/i);
  });
});

// ============================================================================
// (5) Sheet move/copy: the guards that keep an index honest
// ============================================================================

describe("sheet move/copy host guards", () => {
  it("moveSheet refuses an unknown source and an out-of-range destination", () => {
    // move_sheet clamps out-of-range indexes silently; the executor checks the
    // live list first so a script is never told a sheet moved where it did not.
    expect(hostSrc).toContain("No sheet with index ${fromIndex}");
    expect(hostSrc).toContain("is past the last position");
  });

  it("copySheet identifies the new sheet by DIFFING the list, not by arithmetic", () => {
    // The backend inserts the duplicate after its source today. Deriving the new
    // index from that assumption would silently return the wrong sheet the day
    // it changes.
    expect(hostSrc).toContain("const beforeNames = new Set(before.sheets.map((s) => s.name))");
    expect(hostSrc).toContain("result.sheets.find((s) => !beforeNames.has(s.name))");
    expect(hostSrc).toContain("the new sheet could not be identified");
  });

  it("copySheet rejects a duplicate name BEFORE the backend does", () => {
    expect(hostSrc).toMatch(/case "api\.copySheet"[\s\S]*?assertSheetNameFree\(lib, newName, null\)/);
  });

  it("the typings warn that both renumber the other sheets", () => {
    expect(typingsSrc).toMatch(/RENUMBERED|RENUMBERS/);
  });
});

describe("split panes", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("uses the @api/grid orchestrator, not the raw backend command", () => {
    // grid.splitWindow persists AND emits SPLIT_CHANGED, which the Shell bridges
    // into Core's split config. Calling set_split_window directly would store a
    // split nothing on screen honoured.
    expect(hostSrc).toContain("grid.splitWindow(splitRow ?? null, splitCol ?? null)");
    expect(hostSrc).not.toContain("setSplitWindow");
  });

  it("is a view change, and the consent text says so without promising more", () => {
    const desc = ALLOWLIST["api.splitPanes"].desc;
    expect(desc).toMatch(/split/i);
    expect(desc).toMatch(/pass nothing to remove/i);
  });
});
