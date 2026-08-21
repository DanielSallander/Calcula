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
import { PreviewGrid, cellShape, shapeOf } from "../grid";
import { PreviewGapError, createPreviewBackend, createPreviewState, respond } from "../backend";

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
