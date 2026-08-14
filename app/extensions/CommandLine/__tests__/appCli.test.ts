// FILENAME: app/extensions/CommandLine/__tests__/appCli.test.ts
// PURPOSE: Unit tests for the APP domain of the fused CLI, driven through the
//          REAL shared engine over a recording mock gateway: verbatim cell
//          input, live sheet re-resolution, wildcard refusal for sheets,
//          sort column mapping, batch begin/commit, the kept-partial error
//          path (and that cancelUndoTransaction is NEVER touched), macros,
//          registry commands and strict option validation.

import { describe, expect, it } from "vitest";
import { createCliEngine } from "../../_shared/cli/engine";
import type { CliIo } from "../../_shared/cli/registry";
import { createAppDomain } from "../cli/appDomain";
import { createAppCliSession } from "../cli/appSession";
import type { AppCliGateway } from "../cli/appGateway";

// ---------------------------------------------------------------------------
// Mock gateway
// ---------------------------------------------------------------------------

interface MockCalls {
  gateway: AppCliGateway;
  calls: Record<string, unknown[][]>;
  /** Flat call order across all methods (for begin/commit sequencing). */
  seq: string[];
}

const SHEETS_RESULT = {
  sheets: [
    { index: 0, name: "Sheet1", visibility: "visible" as const },
    { index: 1, name: "Sheet2", visibility: "visible" as const },
    { index: 2, name: "My Sheet", visibility: "visible" as const },
  ],
  activeIndex: 0,
};

const NAMED_RANGE_OK = { success: true, namedRange: null, error: null };
const UNDO_RESULT = { updatedCells: [], canUndo: false, canRedo: false, restoredAnchor: null };

/** Async default results per method; methods absent here resolve undefined. */
const ASYNC_RESULTS: Record<string, unknown> = {
  getSheets: SHEETS_RESULT,
  addSheet: SHEETS_RESULT,
  deleteSheet: SHEETS_RESULT,
  renameSheet: SHEETS_RESULT,
  hideSheet: SHEETS_RESULT,
  unhideSheet: SHEETS_RESULT,
  setTabColor: SHEETS_RESULT,
  setActiveSheet: SHEETS_RESULT,
  getUsedRange: { startRow: 0, startCol: 0, endRow: 2, endCol: 1, empty: false },
  updateCell: { cells: [], dimensionChanges: [] },
  getRangeCellsTyped: [],
  clearRange: {},
  sortRangeByColumn: {},
  calculateNow: [],
  getAllNamedRanges: [{ name: "Total", sheetIndex: null, refersTo: "=Sheet1!$A$1:$B$9" }],
  createNamedRange: NAMED_RANGE_OK,
  renameNamedRange: NAMED_RANGE_OK,
  deleteNamedRange: NAMED_RANGE_OK,
  resolveNamedRangeCoords: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 8, endCol: 1 },
  getAllTables: [],
  getAllPivotTables: [],
  undo: UNDO_RESULT,
  redo: UNDO_RESULT,
  beginUndoTransaction: undefined,
  commitUndoTransaction: undefined,
  listWorkbookScripts: [
    { id: "macro-hello", name: "Hello" },
    { id: "macro-cleanup", name: "Monthly Cleanup" },
  ],
  runMacroByRef: { status: "ran", name: "Hello" },
  executeCommand: undefined,
};

/** Synchronous (non-Promise) methods and their default results. */
const SYNC_RESULTS: Record<string, unknown> = {
  hasMacroRunProvider: true,
  hasCommand: true,
  listCommands: ["core.edit.undo", "format.bold", "my.ext.doThing"],
  navigateToRange: undefined,
};

function mockGateway(overrides: Partial<AppCliGateway> = {}): MockCalls {
  const calls: Record<string, unknown[][]> = {};
  const seq: string[] = [];
  const record = (name: string, args: unknown[]): void => {
    (calls[name] ??= []).push(args);
    seq.push(name);
  };
  const gateway = new Proxy({} as Record<string | symbol, unknown>, {
    get(target, prop) {
      if (typeof prop !== "string") return undefined;
      if (prop in overrides) {
        // Overrides are recorded too, so tests can assert on failing calls.
        if (!(prop in target)) {
          const fn = (overrides as Record<string, (...args: unknown[]) => unknown>)[prop];
          target[prop] = (...args: unknown[]) => {
            record(prop, args);
            return fn(...args);
          };
        }
        return target[prop];
      }
      if (!(prop in target)) {
        target[prop] = (...args: unknown[]) => {
          record(prop, args);
          if (prop in SYNC_RESULTS) return SYNC_RESULTS[prop];
          return Promise.resolve(ASYNC_RESULTS[prop]);
        };
      }
      return target[prop];
    },
  }) as unknown as AppCliGateway;
  return { gateway, calls, seq };
}

function collectIo(): { io: CliIo; lines: Array<{ cls: string; text: string }> } {
  const lines: Array<{ cls: string; text: string }> = [];
  return {
    io: {
      print: (text, cls) => lines.push({ cls: cls ?? "out", text }),
      clear: () => lines.splice(0, lines.length),
    },
    lines,
  };
}

function buildEngine(overrides: Partial<AppCliGateway> = {}) {
  const { gateway, calls, seq } = mockGateway(overrides);
  const session = createAppCliSession(gateway);
  const engine = createCliEngine([{ domain: createAppDomain(), session }], "app");
  return { engine, session, calls, seq };
}

async function runApp(text: string, overrides: Partial<AppCliGateway> = {}) {
  const { engine, session, calls, seq } = buildEngine(overrides);
  const { io, lines } = collectIo();
  const plan = engine.planRun(text);
  const outcome = await engine.executeRun(plan, io);
  return { calls, seq, lines, ok: outcome.ok, session, plan };
}

/** Plan only — for asserting PLAN-time CliErrors. */
function planApp(text: string) {
  const { engine } = buildEngine();
  return engine.planRun(text);
}

const allText = (lines: Array<{ cls: string; text: string }>): string =>
  lines.map((l) => l.text).join("\n");

// ---------------------------------------------------------------------------
// Domain shape
// ---------------------------------------------------------------------------

describe("createAppDomain", () => {
  it("does not claim the model's 'table' kind, and aliases gridtable", () => {
    const domain = createAppDomain();
    const kinds = domain.kinds.map((k) => k.kind);
    expect(kinds).not.toContain("table");
    expect(kinds).toContain("gridtable");
    const gt = domain.kinds.find((k) => k.kind === "gridtable");
    expect(gt?.aliases).toContain("gtable");
  });
});

// ---------------------------------------------------------------------------
// set cell
// ---------------------------------------------------------------------------

describe("set cell", () => {
  it("passes the tail VERBATIM as the cell input (formula)", async () => {
    const { calls } = await runApp("set cell B3 = =SUM(B:B)");
    expect(calls.updateCell).toEqual([[2, 1, "=SUM(B:B)"]]);
  });

  it("passes a literal tail verbatim", async () => {
    const { calls } = await runApp("set cell A1 = 42");
    expect(calls.updateCell).toEqual([[0, 0, "42"]]);
  });

  it("switches to a qualified sheet first (resolved live)", async () => {
    const { calls } = await runApp("set cell Sheet2!B3 = 5");
    expect(calls.getSheets).toBeTruthy();
    expect(calls.setActiveSheet).toEqual([[1]]);
    expect(calls.updateCell).toEqual([[2, 1, "5"]]);
  });

  it("errors without a tail", () => {
    expect(() => planApp("set cell A1")).toThrow(/set cell needs '= <value or formula>'/);
  });

  it("refuses a multi-cell range", () => {
    expect(() => planApp("set cell A1:B2 = 5")).toThrow(/ONE cell/);
  });
});

// ---------------------------------------------------------------------------
// goto
// ---------------------------------------------------------------------------

describe("goto", () => {
  it("navigates to a bare reference without switching sheets", async () => {
    const { calls, plan } = await runApp("goto A1");
    expect(plan.writeLabels).toEqual([]); // navigation is not a write
    expect(calls.setActiveSheet).toBeUndefined();
    expect(calls.navigateToRange).toEqual([[0, 0, 0, 0]]);
  });

  it("switches sheets for a qualified reference", async () => {
    const { calls } = await runApp("goto Sheet2!A1");
    expect(calls.setActiveSheet).toEqual([[1]]);
    expect(calls.navigateToRange).toEqual([[0, 0, 0, 0]]);
  });

  it("resolves a named range live", async () => {
    const { calls, lines } = await runApp("goto Total");
    expect(calls.resolveNamedRangeCoords).toEqual([["Total"]]);
    expect(calls.navigateToRange).toEqual([[0, 0, 8, 1]]);
    expect(allText(lines)).toContain("Total");
  });

  it("reports an unknown reference or name", async () => {
    const { ok, lines } = await runApp("goto Bogus", {
      resolveNamedRangeCoords: () => Promise.reject(new Error("no such name")),
    });
    expect(ok).toBe(false);
    expect(lines.some((l) => l.cls === "err" && l.text.includes("Bogus"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

describe("sheet operations", () => {
  it("adds a sheet by name", async () => {
    const { calls, lines } = await runApp("add sheet Report");
    expect(calls.addSheet).toEqual([["Report"]]);
    expect(allText(lines)).toContain("Report");
  });

  it("renames via ->, bare pair, and 'to' — resolving the index live", async () => {
    for (const text of [
      "rename sheet Sheet2 -> Budget",
      "rename sheet Sheet2 Budget",
      "rename sheet Sheet2 to Budget",
    ]) {
      const { calls } = await runApp(text);
      expect(calls.getSheets, text).toBeTruthy(); // re-resolved at run time
      expect(calls.renameSheet, text).toEqual([[1, "Budget"]]);
    }
  });

  it("deletes a quoted, spaced sheet name", async () => {
    const { calls } = await runApp('delete sheet "My Sheet"');
    expect(calls.deleteSheet).toEqual([[2]]);
  });

  it("errors on an unknown sheet at run time", async () => {
    const { ok, lines, calls } = await runApp("delete sheet Nope");
    expect(ok).toBe(false);
    expect(calls.deleteSheet).toBeUndefined();
    expect(lines.some((l) => l.cls === "err" && l.text.includes("Nope"))).toBe(true);
  });

  it("refuses wildcards for sheet targets at PLAN time", () => {
    expect(() => planApp("delete sheet Sheet*")).toThrow(
      /wildcards are not allowed for sheet operations/,
    );
    expect(() => planApp("rename sheet Sheet? -> X")).toThrow(
      /wildcards are not allowed for sheet operations/,
    );
  });

  it("set sheet maps visibility and tab color", async () => {
    const { calls } = await runApp("set sheet Sheet2 visibility=hidden tabcolor=#ff0000");
    expect(calls.hideSheet).toEqual([[1]]);
    expect(calls.setTabColor).toEqual([[1, "#ff0000"]]);
  });

  it("set sheet visibility=veryhidden uses the veryHidden level", async () => {
    const { calls } = await runApp("set sheet Sheet2 visibility=veryhidden");
    expect(calls.hideSheet).toEqual([[1, "veryHidden"]]);
  });

  it("set sheet with no options errors at plan time", () => {
    expect(() => planApp("set sheet Sheet2")).toThrow(/at least one of/);
  });
});

// ---------------------------------------------------------------------------
// Named ranges
// ---------------------------------------------------------------------------

describe("named ranges", () => {
  it("add name prefixes = when missing and passes the tail through", async () => {
    const { calls } = await runApp("add name Total2 = Sheet1!A1:B9");
    expect(calls.createNamedRange).toEqual([["Total2", null, "=Sheet1!A1:B9"]]);
  });

  it("rename and delete", async () => {
    const r = await runApp("rename name Total -> GrandTotal");
    expect(r.calls.renameNamedRange).toEqual([["Total", "GrandTotal"]]);
    const d = await runApp("delete name Total");
    expect(d.calls.deleteNamedRange).toEqual([["Total"]]);
  });

  it("surfaces a backend refusal as an error", async () => {
    const { ok, lines } = await runApp("delete name Total", {
      deleteNamedRange: () =>
        Promise.resolve({ success: false, namedRange: null, error: "name is in use" }),
    });
    expect(ok).toBe(false);
    expect(lines.some((l) => l.cls === "err" && l.text.includes("name is in use"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// delete range / sort
// ---------------------------------------------------------------------------

describe("delete range", () => {
  it("defaults to contents", async () => {
    const { calls } = await runApp("delete range A1:B2");
    expect(calls.clearRange).toEqual([[0, 0, 1, 1, "contents"]]);
  });

  it("clears formats when asked", async () => {
    const { calls } = await runApp("delete range A1:B2 what=formats");
    expect(calls.clearRange).toEqual([[0, 0, 1, 1, "formats"]]);
  });

  it("rejects an unknown option key, naming the valid ones", () => {
    expect(() => planApp("delete range A1:B2 wat=formats")).toThrow(
      /Unknown option 'wat='.*what=/,
    );
  });
});

describe("sort", () => {
  it("maps a column letter to the ABSOLUTE index the API expects", async () => {
    const { calls } = await runApp("sort A2:C9 by=B order=desc headers=true");
    // sortRangeByColumn(startRow, startCol, endRow, endCol, ABSOLUTE col, asc, headers)
    expect(calls.sortRangeByColumn).toEqual([[1, 0, 8, 2, 1, false, true]]);
  });

  it("maps a numeric by= as a 0-based offset from the range start", async () => {
    const { calls } = await runApp("sort B2:D9 by=2");
    expect(calls.sortRangeByColumn).toEqual([[1, 1, 8, 3, 3, true, false]]);
  });

  it("rejects a sort column outside the range", () => {
    expect(() => planApp("sort A2:C9 by=D")).toThrow(/outside/);
  });
});

// ---------------------------------------------------------------------------
// Batch atomicity
// ---------------------------------------------------------------------------

describe("multi-write runs", () => {
  it("wraps the run in ONE undo transaction (begin … commit)", async () => {
    const { calls, seq, ok } = await runApp("set cell A1 = 1\nset cell A2 = 2");
    expect(ok).toBe(true);
    expect(calls.beginUndoTransaction).toEqual([["Command line run"]]);
    expect(calls.commitUndoTransaction).toHaveLength(1);
    expect(seq.indexOf("beginUndoTransaction")).toBeLessThan(seq.indexOf("updateCell"));
    expect(seq.lastIndexOf("updateCell")).toBeLessThan(seq.indexOf("commitUndoTransaction"));
  });

  it("a mid-run error COMMITS the partial as one undo step — never cancels", async () => {
    let n = 0;
    const { calls, lines, ok } = await runApp("set cell A1 = 1\nset cell A2 = 2", {
      updateCell: () => {
        n++;
        return n === 2
          ? Promise.reject(new Error("boom"))
          : Promise.resolve({ cells: [], dimensionChanges: [] });
      },
    });
    expect(ok).toBe(false);
    expect(calls.beginUndoTransaction).toHaveLength(1);
    expect(calls.commitUndoTransaction).toHaveLength(1); // via onError
    expect(calls.cancelUndoTransaction).toBeUndefined(); // NEVER — see undo.rs
    expect(lines.some((l) => l.cls === "err" && l.text.includes("boom"))).toBe(true);
    expect(allText(lines)).toContain("kept as ONE undo step");
  });

  it("a single write runs without a transaction", async () => {
    const { calls } = await runApp("set cell A1 = 1");
    expect(calls.beginUndoTransaction).toBeUndefined();
    expect(calls.commitUndoTransaction).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Macros
// ---------------------------------------------------------------------------

describe("run <macro>", () => {
  it("resolves by name and runs through the seam", async () => {
    const { calls, lines } = await runApp("run Hello");
    expect(calls.runMacroByRef).toEqual([["macro-hello"]]);
    expect(allText(lines)).toContain("Hello");
  });

  it("resolves a multi-word bare name", async () => {
    const { calls } = await runApp("run Monthly Cleanup");
    expect(calls.runMacroByRef).toEqual([["macro-cleanup"]]);
  });

  it("resolves by id", async () => {
    const { calls } = await runApp("run macro-cleanup");
    expect(calls.runMacroByRef).toEqual([["macro-cleanup"]]);
  });

  it("errors with close matches for an unknown macro", async () => {
    const { ok, lines, calls } = await runApp("run Month");
    expect(ok).toBe(false);
    expect(calls.runMacroByRef).toBeUndefined();
    const err = lines.find((l) => l.cls === "err");
    expect(err?.text).toContain("Month");
    expect(err?.text).toContain("Monthly Cleanup");
  });

  it("reports a failed macro", async () => {
    const { ok, lines } = await runApp("run Hello", {
      runMacroByRef: () =>
        Promise.resolve({ status: "failed" as const, name: "Hello", message: "script threw" }),
    });
    expect(ok).toBe(false);
    expect(lines.some((l) => l.cls === "err" && l.text.includes("script threw"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Registry commands / recalc / undo
// ---------------------------------------------------------------------------

describe("command", () => {
  it("executes with parsed JSON args", async () => {
    const { calls } = await runApp('command my.ext.doThing = {"a": 1}');
    expect(calls.executeCommand).toEqual([["my.ext.doThing", { a: 1 }]]);
  });

  it("executes without args", async () => {
    const { calls, lines } = await runApp("command core.edit.undo");
    expect(calls.executeCommand).toEqual([["core.edit.undo", undefined]]);
    expect(allText(lines)).toContain("Done.");
  });

  it("rejects invalid JSON at plan time", () => {
    expect(() => planApp("command x = {bad")).toThrow(/JSON/);
  });

  it("refuses an unknown command id", async () => {
    const { ok, lines } = await runApp("command no.such.id", {
      hasCommand: () => false,
    });
    expect(ok).toBe(false);
    expect(lines.some((l) => l.cls === "err" && l.text.includes("no.such.id"))).toBe(true);
  });
});

describe("recalc and undo/redo", () => {
  it("recalc calls calculateNow", async () => {
    const { calls, ok } = await runApp("recalc");
    expect(ok).toBe(true);
    expect(calls.calculateNow).toHaveLength(1);
  });

  it("undo goes through the gateway and reports", async () => {
    const { calls, lines } = await runApp("undo");
    expect(calls.undo).toHaveLength(1);
    expect(lines.some((l) => l.cls === "info" && l.text === "Undone.")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

describe("ls / show", () => {
  it("ls sheets filters with a glob", async () => {
    const { lines } = await runApp("ls sheets Sheet*");
    const out = allText(lines);
    expect(out).toContain("Sheet1");
    expect(out).toContain("Sheet2");
    expect(out).not.toContain("My Sheet");
  });

  it("ls commands lists registry ids", async () => {
    const { lines } = await runApp("ls commands format*");
    const out = allText(lines);
    expect(out).toContain("format.bold");
    expect(out).not.toContain("core.edit.undo");
  });

  it("show range prints values and truncates past 50 rows", async () => {
    const cells = Array.from({ length: 50 }, (_, i) => ({
      row: i,
      col: 0,
      value: i,
      display: `v${i}`,
      formula: null,
      type: "number" as const,
    }));
    const { calls, lines } = await runApp("show range A1:A100", {
      getRangeCellsTyped: () => Promise.resolve(cells),
    });
    // The read itself is capped at 50 rows (0..49).
    expect(calls.getRangeCellsTyped).toEqual([[0, 0, 49, 0, undefined]]);
    const out = allText(lines);
    expect(out).toContain("v0");
    expect(out).toContain("v49");
    expect(out).toContain("truncated");
  });

  it("show sheet reports the used range", async () => {
    const { lines } = await runApp("show sheet Sheet1");
    const out = allText(lines);
    expect(out).toContain("Sheet1");
    expect(out).toContain("A1:B3");
  });
});
