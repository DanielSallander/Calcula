//! FILENAME: app/src/api/scriptHost/scriptPreview/__tests__/snapshotAndReport.test.ts
// PURPOSE: Pin the two halves of the rung that can be wrong SILENTLY — how the
//          workbook copy is taken, and how the result is reported.
// CONTEXT: docs/design/local-model-script-authoring.md §5c.
//
//          The realm half fails loudly (a script throws, a worker dies). These
//          two fail quietly: a snapshot that stores the formatted display as
//          the input makes the diff report changes nothing made, and a report
//          that clips its own count tells a reviewer a 10,000-cell rewrite
//          touched 200.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PreviewGrid } from "../grid";
import { MAX_SNAPSHOT_CELLS, inputStringOf, snapshotActiveSheet, type SnapshotSource } from "../snapshot";
import { buildReport, declined, diffGrid, summarize, MAX_REPORTED_CHANGES } from "../report";
import { previewSkipLine, unexercisedHookNote } from "../unexercisedHooks";

type Cell = Awaited<ReturnType<SnapshotSource["getRangeCells"]>>[number];

function source(opts: {
  cells: Cell[];
  used?: { startRow: number; startCol: number; endRow: number; endCol: number; empty: boolean };
  onRead?: (r1: number, c1: number, r2: number, c2: number) => void;
}): SnapshotSource {
  return {
    getSheetNames: async () => ["Sheet1", "Data"],
    getActiveSheet: async () => 0,
    getUsedRange: async () =>
      opts.used ?? { startRow: 0, startCol: 0, endRow: 1, endCol: 1, empty: false },
    getRangeCells: async (r1, c1, r2, c2) => {
      opts.onRead?.(r1, c1, r2, c2);
      return opts.cells.filter((c) => c.row >= r1 && c.row <= r2 && c.col >= c1 && c.col <= c2);
    },
  };
}

const cell = (row: number, col: number, value: Cell["value"], display: string, formula: string | null = null): Cell =>
  ({ row, col, value, display, formula });

describe("the workbook copy", () => {
  it("derives the INPUT string from the value, never from the formatted display", () => {
    // The trap: `display` is formatted text. Storing "$42.00" as the input makes
    // the diff report a change the instant anything rewrites the cell with the
    // number 42 it already held.
    expect(inputStringOf({ value: 42, formula: null })).toBe("42");
    expect(inputStringOf({ value: true, formula: null })).toBe("TRUE");
    expect(inputStringOf({ value: null, formula: null })).toBe("");
    expect(inputStringOf({ value: 5050, formula: "=SUM(A1:A9)" })).toBe("=SUM(A1:A9)");
    // A formula the backend hands back unprefixed still stores as a formula.
    expect(inputStringOf({ value: 1, formula: "SUM(A1:A9)" })).toBe("=SUM(A1:A9)");
  });

  it("carries both halves of a cell: the input to diff, the display to read", async () => {
    const snap = await snapshotActiveSheet(
      source({
        cells: [cell(0, 0, 42, "$42.00"), cell(0, 1, 5050, "5 050", "=SUM(A1:A9)")],
      }),
    );
    expect(snap.grid.input(0, 0)).toBe("42");
    expect(snap.grid.cachedDisplay(0, 0)).toBe("$42.00");
    expect(snap.grid.input(0, 1)).toBe("=SUM(A1:A9)");
    expect(snap.grid.cachedDisplay(0, 1), "a formula's computed value comes from the workbook").toBe("5 050");
    expect(snap.sheetNames).toEqual(["Sheet1", "Data"]);
    expect(snap.truncated).toBe(false);
  });

  it("copies nothing, and claims nothing, for an empty sheet", async () => {
    const snap = await snapshotActiveSheet(
      source({ cells: [], used: { startRow: 0, startCol: 0, endRow: 0, endCol: 0, empty: true } }),
    );
    expect(snap.grid.entries()).toEqual([]);
    expect(snap.copied).toBeNull();
    expect(snap.truncated).toBe(false);
  });

  it("clamps a huge sheet by whole ROWS, and says that it did", async () => {
    // Halving a row instead would hand a script a record missing its own
    // columns, which reads as data corruption rather than as a bound.
    let asked: [number, number, number, number] | null = null;
    const width = 10;
    const snap = await snapshotActiveSheet(
      source({
        cells: [],
        used: { startRow: 0, startCol: 0, endRow: 999_999, endCol: width - 1, empty: false },
        onRead: (r1, c1, r2, c2) => {
          asked = [r1, c1, r2, c2];
        },
      }),
    );
    expect(snap.truncated).toBe(true);
    const [, , endRow, endCol] = asked!;
    expect(endCol, "the full width is kept").toBe(width - 1);
    expect((endRow + 1) * width).toBeLessThanOrEqual(MAX_SNAPSHOT_CELLS);
    expect((endRow + 2) * width, "and it takes as many rows as it can").toBeGreaterThan(MAX_SNAPSHOT_CELLS);
  });

  it("keeps at least one row even when a single row exceeds the cap", async () => {
    const snap = await snapshotActiveSheet(
      source({
        cells: [],
        used: { startRow: 0, startCol: 0, endRow: 5, endCol: MAX_SNAPSHOT_CELLS * 2, empty: false },
      }),
    );
    expect(snap.copied).toMatchObject({ startRow: 0, endRow: 0 });
    expect(snap.truncated).toBe(true);
  });
});

describe("the diff", () => {
  const before = new Map([
    ["0,0", "a"],
    ["1,0", "b"],
  ]);

  it("reports writes, clears and additions in row-major order", () => {
    const after = new PreviewGrid();
    after.setInput(0, 0, "a"); // unchanged
    after.setInput(1, 0, "B"); // rewritten
    after.setInput(2, 0, "c"); // added
    expect(diffGrid(before, after)).toEqual([
      { row: 1, col: 0, before: "b", after: "B" },
      { row: 2, col: 0, before: "", after: "c" },
    ]);
  });

  it("sees a cell the run removed from the map entirely", () => {
    const after = new PreviewGrid();
    after.setInput(0, 0, "a");
    expect(diffGrid(before, after)).toEqual([{ row: 1, col: 0, before: "b", after: "" }]);
  });

  it("ignores a rewrite with the value the cell already held", () => {
    // This is exactly why `readBack` exists beside the diff: a cell the script
    // rewrote identically is absent here, and grading on the diff alone would
    // read "unchanged" as "wrong".
    const after = new PreviewGrid();
    after.setInput(0, 0, "a");
    after.setInput(1, 0, "b");
    expect(diffGrid(before, after)).toEqual([]);
  });
});

describe("the report", () => {
  const change = (row: number) => ({ row, col: 0, before: "", after: "x" });

  it("caps the LIST but never the COUNT", () => {
    const report = buildReport({
      ok: true,
      durationMs: 4,
      changes: Array.from({ length: 1000 }, (_, r) => change(r)),
      output: [],
      readBack: [],
      unexercisedHooks: [],
    });
    expect(report.truncated).toBe(true);
    expect(report.changes.length).toBe(MAX_REPORTED_CHANGES);
    expect(report.totalChanges).toBe(1000);
    expect(summarize(report)).toContain("1000 cells");
    expect(summarize(report)).toContain("showing the first 200");
  });

  it("says a capped COPY out loud, because a bounded preview is a bounded claim", () => {
    const report = buildReport({
      ok: true,
      durationMs: 1,
      changes: [],
      output: ["hello"],
      readBack: [],
      unexercisedHooks: [],
      note: "only the first 20000 cells of the sheet were copied for this preview",
    });
    expect(report.output).toEqual(["hello", "[preview] only the first 20000 cells of the sheet were copied for this preview"]);
  });

  it("reports the ran-but-changed-nothing case as the signal it is", () => {
    const report = buildReport({
      ok: true,
      durationMs: 3,
      changes: [],
      output: [],
      readBack: [],
      unexercisedHooks: [],
    });
    expect(report.ok).toBe(true);
    expect(report.totalChanges).toBe(0);
    expect(summarize(report)).toBe("The script ran without error but changed no cells.");
  });

  it("keeps a DECLINE from reading as either a pass or a failure", () => {
    const report = declined("the preview cannot serve api.createChart");
    expect(report.applicable).toBe(false);
    // `ok` stays true so a caller reading only `ok` sees "no objection" — the
    // safe direction. This rung never invents a rejection.
    expect(report.ok).toBe(true);
    expect(report.error).toBeNull();
    expect(report.totalChanges).toBe(0);
    expect(summarize(report)).toMatch(/^No preview:/);
  });

  it("reports a real failure as a failure, with its error", () => {
    const report = buildReport({
      ok: false,
      error: "TypeError: x is not a function",
      durationMs: 3,
      changes: [],
      output: [],
      readBack: [],
      unexercisedHooks: [],
    });
    expect(report.applicable, "a run that FAILED still produced a verdict").toBe(true);
    expect(summarize(report)).toContain("failed when run against a copy");
    expect(summarize(report)).toContain("TypeError");
  });
});

/**
 * THE ZERO THAT IS NOT ABOUT THE SCRIPT.
 *
 * A run that fired every handler it was offered and changed nothing is evidence
 * about the DRAFT. A run whose only handler was skipped — because the preview
 * cannot synthesize the payload the product's forwarder delivers — produces the
 * identical zero and is evidence about the PREVIEW. The bare sentence reads as a
 * finding either way, which is how a model came to spend repair rounds rewriting
 * correct code.
 */
describe("a report says when a handler was never fired", () => {
  const report = (totalChanges: number, unexercisedHooks: string[]) =>
    buildReport({
      ok: true,
      durationMs: 2,
      changes: Array.from({ length: totalChanges }, (_, r) => ({
        row: r,
        col: 0,
        before: "",
        after: "x",
      })),
      output: [],
      readBack: [],
      unexercisedHooks,
    });

  it("qualifies 'changed no cells' when one handler was skipped", () => {
    const summary = summarize(report(0, ["onSelectionChange"]));
    // The control is :176 — the same call with an empty list must still be the
    // byte-identical sentence every existing consumer reads.
    expect(summary).not.toBe("The script ran without error but changed no cells.");
    expect(summary).toContain("The script ran without error but changed no cells.");
    expect(summary).toContain("onSelectionChange");
    expect(summary).toContain("never fired it");
  });

  it("says two handlers as a sentence, not as an array", () => {
    const summary = summarize(report(0, ["onSelectionChange", "onCellChange"]));
    expect(summary).toContain("onSelectionChange and onCellChange");
    expect(summary).toContain("never fired any of them");
    expect(summary).not.toContain("[");
  });

  it("keeps the count clause intact when a run BOTH changed cells and skipped a hook", () => {
    // Both facts are true at once and both matter: the reviewer needs to know
    // three cells changed AND that the biggest handler never ran.
    const summary = summarize(report(3, ["onSelectionChange"]));
    expect(summary).toContain("The script would change 3 cells.");
    expect(summary).toContain("never fired it");
  });

  it("reports an empty list on a DECLINE, which is not a claim that everything ran", () => {
    expect(declined("no realm").unexercisedHooks).toEqual([]);
  });

  it("COPIES the list, because a report is a statement about a moment", () => {
    // The realm's own array keeps being pushed to while a run is in flight.
    const live = ["onSelectionChange"];
    const built = report(0, live);
    live.push("onCellChange");
    expect(built.unexercisedHooks).toEqual(["onSelectionChange"]);
  });
});

describe("unexercisedHookNote", () => {
  it("says nothing when there is nothing to say", () => {
    // `undefined` is tolerated on purpose: test doubles and third-party
    // assistant providers hand-build this shape, and several RENDER paths reach
    // this function — a TypeError there would blank a panel.
    expect(unexercisedHookNote(undefined)).toBe("");
    expect(unexercisedHookNote([])).toBe("");
  });

  it("is singular for one handler and plural for several", () => {
    expect(unexercisedHookNote(["onSelectionChange"])).toContain("never fired it");
    expect(unexercisedHookNote(["a", "b"])).toContain("never fired any of them");
  });

  it("writes three names as English, not as JSON", () => {
    expect(unexercisedHookNote(["a", "b", "c"])).toContain("a, b and c");
  });
});

describe("previewSkipLine says WHY the handler was not fired", () => {
  // Two genuinely different reasons. A hook the run OFFERED and skipped has an
  // unsynthesizable payload; a hook that was never offered — anything hanging
  // off a sub-object, like a shape's `render.onMessage` — has no payload
  // problem at all and simply cannot be dispatched. Telling an author the first
  // about the second sends them hunting a bug that does not exist.
  it("blames the payload only for a hook that was offered", () => {
    const line = previewSkipLine("onSelectionChange", true);
    expect(line).toContain("registered but not exercised");
    expect(line).toContain("cannot synthesize the payload");
  });

  it("says the preview has no way to fire one that was never offered", () => {
    const line = previewSkipLine("render.onMessage", false);
    expect(line).toContain("registered but not exercised");
    expect(line).toContain("no way to fire it");
    expect(line).not.toContain("synthesize the payload");
  });

  it("defaults to the offered wording, which the E2E spec matches on", () => {
    expect(previewSkipLine("onClick")).toBe(previewSkipLine("onClick", true));
  });

  it("is not called point-free anywhere — map would pass the INDEX as `offered`", () => {
    // The defect this pins was caught by the compiler once and would not be
    // next time if someone widened the parameter: `hooks.map(previewSkipLine)`
    // hands hook 0 `offered = 0` (falsy) and hook 1 `offered = 1` (truthy), so
    // the reason flips with position.
    // cwd-relative: `import.meta.url` is not a file:// URL under this vitest
    // config, and vitest runs from `app/`.
    const source = readFileSync("src/api/scriptHost/scriptPreview/index.ts", "utf8");
    expect(source, "the file must actually be read for this guard to mean anything")
      .toContain("previewSkipLine");
    // COMMENTS STRIPPED FIRST. The comment at the call site quotes the bad form
    // in order to warn about it, so matching raw source makes this pin fail on
    // its own documentation — and "fixing" that by deleting the warning is the
    // worst available outcome.
    const code = source.replace(/^[ \t]*\/\/.*$/gm, "");
    expect(code).not.toMatch(/\.map\(\s*previewSkipLine\s*\)/);
  });
});
