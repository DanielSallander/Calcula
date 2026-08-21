//! FILENAME: app/src/api/scriptHost/scriptPreview/__tests__/backend.test.ts
// PURPOSE: Pin the substituted backend's two obligations — serve faithfully, or
//          GAP loudly — and the snapshot fidelity that lets it stand in for a
//          real document.
// CONTEXT: docs/design/local-model-script-authoring.md §5c.
//
//          The corpus (scriptEval/__tests__/corpus.test.ts) already proves this
//          backend can grade every reference solution at 1.0. What it cannot
//          prove is the NEGATIVE half: that a member the backend does not serve
//          refuses to answer rather than approximating. A backend that guessed
//          would turn its own gaps into the script's defects, which is the exact
//          failure the whole rung was built to stop.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PreviewGrid, cellShape, shapeOf } from "../grid";
import { PreviewGapError, UNPREVIEWABLE, createPreviewBackend, createPreviewState, respond } from "../backend";

function stateWith(seed: Array<[number, number, string, string?]> = []) {
  const grid = new PreviewGrid();
  for (const [r, c, input, display] of seed) grid.seedFromDocument(r, c, input, display);
  return createPreviewState({ grid, sheetNames: ["Sheet1", "Data"], activeSheet: 0 });
}

describe("the gap discipline", () => {
  it("refuses an unimplemented member instead of answering it", () => {
    const state = stateWith();
    // A real ALLOWLIST method with real semantics this backend does not model.
    expect(() => respond(state, "api.createChart", [0, 0, {}])).toThrow(PreviewGapError);
  });

  it("records the FIRST gap on the state, and rethrows so the script sees the failure", () => {
    // Both halves matter. The rethrow is what makes the script's own catch
    // branch run against the same rejected call the product would give it; the
    // record is what makes the RUN inconclusive rather than the script wrong.
    const state = stateWith();
    const backend = createPreviewBackend(state);
    expect(() => backend("api.createChart", [])).toThrow(/does not implement/);
    expect(state.gap).toBe("api.createChart");
    expect(() => backend("api.createPivot", [])).toThrow();
    expect(state.gap, "the first gap is the one that explains the run").toBe("api.createChart");
  });

  it("gaps on a sheet argument naming a sheet the preview does not hold", () => {
    // The validators ACCEPT this argument, so dropping it silently would answer
    // the active sheet's question as though it were the other sheet's.
    const state = stateWith([[0, 0, "keep"]]);
    expect(() => respond(state, "api.getCellValue", [0, 0, "Data"])).toThrow(PreviewGapError);
    expect(() => respond(state, "api.getCellValue", [0, 0, 1])).toThrow(PreviewGapError);
    // ...but the preview's OWN sheet, by index or by name, is served.
    expect(respond(state, "api.getCellValue", [0, 0, 0])).toBe("keep");
    expect(respond(state, "api.getCellValue", [0, 0, "Sheet1"])).toBe("keep");
    expect(respond(state, "api.getCellValue", [0, 0, undefined])).toBe("keep");
  });

  it("gaps every unqualified call after addSheet moved the active sheet", () => {
    const state = stateWith([[0, 0, "before"]]);
    expect(respond(state, "api.addSheet", ["Fresh"])).toMatchObject({ name: "Fresh" });
    // In the product the new sheet is ACTIVE, so this read would land THERE.
    expect(() => respond(state, "api.getCellValue", [0, 0])).toThrow(PreviewGapError);
  });

  it("gaps a validated-but-unserved OPTION rather than answering the wider question", () => {
    const state = stateWith([[0, 0, "hello"]]);
    expect(() => respond(state, "api.findAll", ["h", { range: { startRow: 0 } }])).toThrow(PreviewGapError);
    expect(() => respond(state, "api.findAll", ["h", { searchFormulas: true }])).toThrow(PreviewGapError);
    // The plain form is served, so the gap is about the option and not the method.
    expect(respond(state, "api.findAll", ["h", {}])).toMatchObject({ totalCount: 1 });
  });
});

describe("snapshot fidelity — what a copied document reads back as", () => {
  it("reports the workbook's FORMATTED display, which is what the product returns", () => {
    // `api.getCellValue` returns `cell.display` in the product (host.ts), so a
    // currency-formatted 42 reads "$42.00" there. A preview that answered "42"
    // would disagree with the product about the workbook's own contents.
    const state = stateWith([[0, 0, "42", "$42.00"]]);
    expect(respond(state, "api.getCellValue", [0, 0])).toBe("$42.00");
    // ...while the INPUT string — what a diff compares — stays the raw value.
    expect(state.grid.input(0, 0)).toBe("42");
  });

  it("reports a snapshotted formula's CACHED value, and never invents one", () => {
    const withValue = stateWith([[0, 0, "=SUM(A1:A9)", "5050"]]);
    expect(respond(withValue, "api.getCellValue", [0, 0])).toBe("5050");
    expect(cellShape(withValue.grid, 0, 0)).toMatchObject({ value: 5050, type: "number", formula: "=SUM(A1:A9)" });

    // No snapshot value: the formula TEXT is truthful, the value is not guessed.
    const noValue = new PreviewGrid();
    noValue.setInput(0, 0, "=SUM(A1:A9)");
    expect(shapeOf(noValue.input(0, 0))).toMatchObject({ value: null, display: "", formula: "=SUM(A1:A9)" });
  });

  it("drops the cached value when the SCRIPT rewrites the cell", () => {
    // The workbook's answer was for the OLD content. Carrying it forward would
    // attribute a stale number to something the script just replaced — and
    // nothing here recalculates, so "unknown" is the only honest answer.
    const state = stateWith([[0, 0, "=A1*2", "84"]]);
    respond(state, "api.setCellValue", [0, 0, 7]);
    expect(state.grid.cachedDisplay(0, 0)).toBeUndefined();
    expect(respond(state, "api.getCellValue", [0, 0])).toBe("7");
  });

  it("drops the cached value when the script CLEARS the cell", () => {
    const state = stateWith([[0, 0, "=A1*2", "84"]]);
    respond(state, "api.clearRange", [0, 0, 0, 0, undefined, undefined]);
    expect(respond(state, "api.getCellValue", [0, 0])).toBe("");
  });
});

describe("the served semantics that were chased from the Rust backend", () => {
  it("canonicalizes a numeric spelling the way the backend types input", () => {
    // `sum.toFixed(2)` writes "36.00"; the product stores the NUMBER 36 whose
    // input string is "36". Storing the author's spelling graded a correct
    // script as wrong-valued.
    const state = stateWith();
    respond(state, "api.setCellValue", [0, 0, "36.00"]);
    expect(state.grid.input(0, 0)).toBe("36");
  });

  it("orders a descending sort by reversing the WHOLE ordering, empties first", () => {
    const state = stateWith([
      [0, 0, "b"],
      [1, 0, "a"],
      [3, 0, "c"],
    ]);
    respond(state, "api.sortRange", [0, 0, 3, 0, [{ key: 0, ascending: false }], {}, undefined]);
    // Row 2 was empty; descending puts empties first, exactly as the backend's
    // ordering.reverse() does.
    expect([0, 1, 2, 3].map((r) => state.grid.input(r, 0))).toEqual(["", "c", "b", "a"]);
  });

  it("spans format-only cells in the used range, as the engine's cell map does", () => {
    const state = stateWith([[0, 0, "x"]]);
    respond(state, "api.setRangeFormat", [5, 5, 5, 5, { bold: true }, undefined]);
    expect(respond(state, "api.getUsedRange", [undefined])).toMatchObject({
      startRow: 0,
      endRow: 5,
      endCol: 5,
      empty: false,
    });
  });
});

describe("the clipboard, formats and named ranges", () => {
  it("copies and pastes values and formats over the preview grid", () => {
    const state = stateWith([
      [0, 0, "a"],
      [0, 1, "b"],
    ]);
    respond(state, "api.setRangeFormat", [0, 0, 0, 1, { bold: true }, undefined]);
    expect(respond(state, "api.copyRange", [0, 0, 0, 1, undefined])).toEqual({ rows: 1, cols: 2 });
    expect(respond(state, "api.pasteRange", [5, 0, undefined])).toEqual({ rows: 1, cols: 2 });
    expect([state.grid.input(5, 0), state.grid.input(5, 1)]).toEqual(["a", "b"]);
    expect(state.grid.format(5, 0)).toMatchObject({ bold: true });
  });

  it("transposes when asked", () => {
    const state = stateWith([
      [0, 0, "a"],
      [0, 1, "b"],
    ]);
    respond(state, "api.copyRange", [0, 0, 0, 1, undefined]);
    expect(respond(state, "api.pasteRange", [5, 0, { transpose: true }])).toEqual({ rows: 2, cols: 1 });
    expect([state.grid.input(5, 0), state.grid.input(6, 0)]).toEqual(["a", "b"]);
  });

  it("GAPS on pasting a formula, because the product SHIFTS its references", () => {
    // The discipline that matters most in this whole file. Pasting `=A1+1`
    // unshifted would write a formula the product would never have written —
    // and then present it as what the script would do. A gap declines and says
    // nothing; an approximation lies.
    const state = stateWith([[0, 0, "=B1+1"]]);
    respond(state, "api.copyRange", [0, 0, 0, 0, undefined]);
    expect(() => respond(state, "api.pasteRange", [5, 0, undefined])).toThrow(PreviewGapError);
    // ...but a formats-only paste moves no formula and is served.
    expect(respond(state, "api.pasteRange", [5, 0, { mode: "formats" }])).toEqual({ rows: 1, cols: 1 });
  });

  it("reproduces the product's own empty-clipboard message", () => {
    // A script with a catch branch around paste must see what it would really
    // see, or the branch is exercised against a fiction.
    expect(() => respond(stateWith(), "api.pasteRange", [0, 0, undefined])).toThrow(/call copyRange/);
  });

  it("reads a range's formats in the SAME shape as a single cell's", () => {
    const state = stateWith([[0, 0, "x"]]);
    respond(state, "api.setRangeFormat", [0, 0, 0, 0, { bold: true }, undefined]);
    const one = respond(state, "api.getCellFormat", [0, 0, undefined]) as Record<string, unknown>;
    const many = respond(state, "api.getRangeFormat", [0, 0, 1, 1, undefined]) as Array<Array<Record<string, unknown>>>;
    expect(many.length).toBe(2);
    expect(many[0].length).toBe(2);
    // Same keys, or a guard written against one breaks against the other.
    expect(Object.keys(many[0][0]).sort()).toEqual(Object.keys(one).sort());
    expect(many[0][0]).toMatchObject({ bold: true });
    expect(many[1][1]).toMatchObject({ bold: false });
  });

  it("clears formats without touching values", () => {
    const state = stateWith([[0, 0, "keep"]]);
    respond(state, "api.setRangeFormat", [0, 0, 0, 0, { bold: true }, undefined]);
    respond(state, "api.clearRangeFormat", [0, 0, 0, 0, undefined]);
    expect(state.grid.format(0, 0)).toEqual({});
    expect(state.grid.input(0, 0)).toBe("keep");
  });

  it("keeps named ranges per-run and refuses the duplicate/missing cases", () => {
    const state = stateWith();
    respond(state, "api.createNamedRange", ["Totals", "A1:B2", undefined]);
    expect(respond(state, "api.getNamedRanges", [])).toEqual([
      { name: "Totals", refersTo: "A1:B2", scope: null },
    ]);
    expect(() => respond(state, "api.createNamedRange", ["Totals", "C1", undefined])).toThrow(/already exists/);
    expect(() => respond(state, "api.deleteNamedRange", ["Nope"])).toThrow(/No named range/);
    respond(state, "api.deleteNamedRange", ["Totals"]);
    expect(respond(state, "api.getNamedRanges", [])).toEqual([]);
  });
});

describe("what the preview declares it can NEVER serve", () => {
  it("names a reason for each, and gaps them", () => {
    // These are not a backlog. Serving any of them means fabricating something
    // the preview does not have — another script's return value, a second
    // sheet, a printer — and reporting the fabrication as the draft's effect.
    for (const method of ["base.callMethod", "api.setActiveSheet", "api.createChart", "api.printPdf"]) {
      expect(UNPREVIEWABLE.has(method), `${method} should be declared unpreviewable`).toBe(true);
      expect(UNPREVIEWABLE.get(method)!.length, `${method} needs a REASON, not just an entry`).toBeGreaterThan(20);
      expect(() => respond(stateWith(), method, [0])).toThrow(PreviewGapError);
    }
  });

  it("does not list anything it actually serves", () => {
    // A method in both places would be a contradiction: the coverage
    // measurement would score it as out of reach while the backend answered it.
    const src = readFileSync(resolve(__dirname, "../backend.ts"), "utf8");
    const body = src.slice(src.indexOf("export function respond("));
    const servedCases = new Set([...body.matchAll(/^\s*case "([a-z]+\.[A-Za-z0-9]+)":/gm)].map((m) => m[1]));
    for (const method of UNPREVIEWABLE.keys()) {
      expect(servedCases.has(method), `${method} is both served and declared unserveable`).toBe(false);
    }
  });
});

describe("capabilities are answered from stubs, never from the machine", () => {
  it("answers cap.fetch from the stub and makes no request", () => {
    const grid = new PreviewGrid();
    const state = createPreviewState({ grid, stubs: { fetchJson: { rate: 1.5 } } });
    expect(respond(state, "cap.fetch", ["https://example.test", {}])).toMatchObject({
      status: 200,
      body: JSON.stringify({ rate: 1.5 }),
    });
  });

  it("defaults a confirm to FALSE — dismissal, as every cancel path resolves", () => {
    expect(respond(stateWith(), "cap.dialogConfirm", ["sure?"])).toBe(false);
  });

  it("keeps storage per-run, so a preview cannot read or write the workbook's", () => {
    const a = stateWith();
    const b = stateWith();
    respond(a, "cap.storageSet", ["k", "v"]);
    expect(respond(a, "cap.storageGet", ["k"])).toBe("v");
    expect(respond(b, "cap.storageGet", ["k"]), "a second run starts empty").toBeNull();
  });
});
