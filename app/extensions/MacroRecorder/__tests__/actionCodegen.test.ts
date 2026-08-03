//! FILENAME: app/extensions/MacroRecorder/__tests__/actionCodegen.test.ts
// PURPOSE: Exhaustive tests for the macro code generator.
// CONTEXT: The generator is the part of the recorder that must be exactly
//          right — a macro that runs cleanly and does the wrong thing is worse
//          than one that fails. It is a pure function precisely so it can be
//          pinned here without an app, a backend or a clock.

import { describe, it, expect } from "vitest";
import {
  colLetter,
  consecutiveRuns,
  generateMacroSource,
  jsString,
  localizeInvariantNumber,
  mergeWrites,
  toIdentifier,
} from "../lib/actionCodegen";
import type { RecordedAction, RecordedEvent } from "../lib/types";
// The REAL broker validator, so "the generated sort call is accepted by the
// script API" is a fact this suite checks rather than a claim it makes.
import { vSortRange } from "@api/scriptHost/validators";

// ============================================================================
// Fixtures
// ============================================================================

let seq = 0;
function act(event: RecordedEvent, sheetIndex = 0): RecordedAction {
  seq += 1;
  return { seq, sheetIndex, event };
}

function writes(
  list: Array<[number, number, string]>,
  invariant = false,
): RecordedEvent {
  return {
    kind: "cellWrites",
    writes: list.map(([row, col, value]) => ({ row, col, value, invariant })),
  };
}

const OBJ = { target: "objectScript" as const, header: false, recordedAt: "T" };
const NB = { target: "notebook" as const, header: false, recordedAt: "T" };

/** Generate with the undo wrapper off, so tests assert on the body. */
function gen(actions: RecordedAction[], opts: Record<string, unknown> = {}) {
  return generateMacroSource(actions, {
    ...OBJ,
    undoBatch: false,
    emitInitialSheetActivate: false,
    ...opts,
  } as Parameters<typeof generateMacroSource>[1]);
}

// ============================================================================
// Literal helpers
// ============================================================================

describe("jsString", () => {
  it("quotes plain text", () => {
    expect(jsString("hello")).toBe('"hello"');
  });

  it("escapes quotes and backslashes", () => {
    expect(jsString('say "hi"')).toBe('"say \\"hi\\""');
    expect(jsString("C:\\temp")).toBe('"C:\\\\temp"');
  });

  it("escapes newlines, carriage returns and tabs", () => {
    expect(jsString("a\nb")).toBe('"a\\nb"');
    expect(jsString("a\r\nb")).toBe('"a\\r\\nb"');
    expect(jsString("a\tb")).toBe('"a\\tb"');
  });

  it("escapes the JS line terminators U+2028 / U+2029", () => {
    expect(jsString("a\u2028b")).toBe('"a\\u2028b"');
    expect(jsString("a\u2029b")).toBe('"a\\u2029b"');
  });

  it("escapes other control characters numerically", () => {
    expect(jsString("a\u0001b")).toBe('"a\\u0001b"');
    expect(jsString("a\u007fb")).toBe('"a\\u007fb"');
  });

  it("leaves ordinary unicode alone", () => {
    expect(jsString("ÅÄÖ ok")).toBe('"ÅÄÖ ok"');
  });

  it("produces a literal that evaluates back to the input", () => {
    const nasty = 'a"b\\c\nd\te\u2028f\u0007g åäö';
    // eslint-disable-next-line no-new-func
    const roundTripped = new Function(`return ${jsString(nasty)};`)();
    expect(roundTripped).toBe(nasty);
  });
});

describe("colLetter", () => {
  it("maps 0-based indices to spreadsheet letters", () => {
    expect(colLetter(0)).toBe("A");
    expect(colLetter(25)).toBe("Z");
    expect(colLetter(26)).toBe("AA");
    expect(colLetter(701)).toBe("ZZ");
    expect(colLetter(702)).toBe("AAA");
  });
});

describe("toIdentifier", () => {
  it("camel-cases a human name", () => {
    expect(toIdentifier("Monthly close")).toBe("monthlyClose");
    expect(toIdentifier("Macro 1")).toBe("macro1");
  });

  it("prefixes a leading digit so the result is a legal identifier", () => {
    expect(toIdentifier("2026 rollforward")).toBe("_2026Rollforward");
  });

  it("falls back when nothing usable is left", () => {
    expect(toIdentifier("***")).toBe("recordedMacro");
    expect(toIdentifier("   ")).toBe("recordedMacro");
    expect(toIdentifier("", "fallbackName")).toBe("fallbackName");
  });
});

describe("consecutiveRuns", () => {
  it("collapses consecutive indices and splits at gaps", () => {
    expect(consecutiveRuns([0, 1, 2])).toEqual([[0, 2]]);
    expect(consecutiveRuns([0, 1, 5, 6, 9])).toEqual([
      [0, 1],
      [5, 6],
      [9, 9],
    ]);
  });

  it("sorts and de-duplicates first", () => {
    expect(consecutiveRuns([3, 1, 2, 2])).toEqual([[1, 3]]);
  });

  it("handles the empty case", () => {
    expect(consecutiveRuns([])).toEqual([]);
  });
});

describe("localizeInvariantNumber", () => {
  it("is a no-op for a dot locale", () => {
    expect(localizeInvariantNumber("1.5", ".")).toBe("1.5");
  });

  it("re-spells decimals for a comma locale", () => {
    expect(localizeInvariantNumber("1.5", ",")).toBe("1,5");
    expect(localizeInvariantNumber("-0.25", ",")).toBe("-0,25");
    expect(localizeInvariantNumber("1.5e3", ",")).toBe("1,5e3");
  });

  it("leaves integers, text and formulas alone", () => {
    expect(localizeInvariantNumber("42", ",")).toBe("42");
    expect(localizeInvariantNumber("hello", ",")).toBe("hello");
    expect(localizeInvariantNumber("=SUM(A1,B1)", ",")).toBe("=SUM(A1,B1)");
  });
});

describe("mergeWrites", () => {
  it("keeps the last value per cell in first-appearance order", () => {
    const merged = mergeWrites([
      { row: 0, col: 0, value: "a" },
      { row: 1, col: 0, value: "b" },
      { row: 0, col: 0, value: "c" },
    ]);
    expect(merged).toEqual([
      { row: 0, col: 0, value: "c" },
      { row: 1, col: 0, value: "b" },
    ]);
  });
});

// ============================================================================
// Cell writes
// ============================================================================

describe("cell writes", () => {
  it("emits a single setCellValue for one cell (object script)", () => {
    const { source } = gen([act(writes([[0, 0, "hello"]]))]);
    expect(source).toContain('await api.setCellValue(0, 0, "hello"); // A1');
    expect(source).not.toContain("updateCellsBatch");
  });

  it("emits a single Calcula.setCellValue for one cell (notebook)", () => {
    const { source } = gen([act(writes([[2, 1, "x"]]))], NB);
    expect(source).toContain('Calcula.setCellValue(2, 1, "x"); // B3');
  });

  it("batches MANY cells into one updateCellsBatch, not one line each", () => {
    const many: Array<[number, number, string]> = [];
    for (let r = 0; r < 40; r++) many.push([r, 0, `v${r}`]);
    const { source } = gen([act(writes(many))]);
    expect(source.match(/updateCellsBatch/g) ?? []).toHaveLength(1);
    expect(source.match(/setCellValue/g)).toBeNull();
    expect(source).toContain('{ row: 39, col: 0, value: "v39" },');
  });

  it("MERGES consecutive cell-write actions into ONE call", () => {
    const { source } = gen([
      act(writes([[0, 0, "a"]])),
      act(writes([[1, 0, "b"]])),
      act(writes([[2, 0, "c"]])),
    ]);
    expect(source.match(/updateCellsBatch/g) ?? []).toHaveLength(1);
    expect(source).toContain('{ row: 0, col: 0, value: "a" },');
    expect(source).toContain('{ row: 2, col: 0, value: "c" },');
  });

  it("does not merge across a non-write action", () => {
    const { source } = gen([
      act(writes([[0, 0, "a"]])),
      act({ kind: "insertRows", startRow: 5, count: 1 }),
      act(writes([[1, 0, "b"]])),
    ]);
    expect(source.match(/setCellValue/g) ?? []).toHaveLength(2);
    expect(source).toContain("await api.insertRows(5, 1);");
  });

  it("does not merge across a sheet switch", () => {
    const { source } = gen([
      act(writes([[0, 0, "a"]]), 0),
      act(writes([[0, 0, "b"]]), 1),
    ]);
    expect(source).toContain("await api.setActiveSheet(1);");
    expect(source.match(/setCellValue/g) ?? []).toHaveLength(2);
  });

  it("chunks a long batch at batchChunkSize", () => {
    const many: Array<[number, number, string]> = [];
    for (let r = 0; r < 25; r++) many.push([r, 0, "v"]);
    const { source } = gen([act(writes(many))], { batchChunkSize: 10 });
    expect(source.match(/updateCellsBatch/g) ?? []).toHaveLength(3);
  });

  it("uses one array + one loop on the notebook runtime", () => {
    const many: Array<[number, number, string]> = [];
    for (let r = 0; r < 5; r++) many.push([r, 0, "v"]);
    const { source } = gen([act(writes(many))], NB);
    expect(source).toContain("const writes1 = [");
    expect(source).toContain(
      "for (const w of writes1) Calcula.setCellValue(w.row, w.col, w.value);",
    );
  });

  it("re-localizes invariant decimals to the recording locale", () => {
    const { source } = gen([act(writes([[0, 0, "1.5"]], true))], {
      decimalSeparator: ",",
    });
    expect(source).toContain('"1,5"');
  });

  it("leaves NON-invariant values untouched whatever the locale", () => {
    const { source } = gen([act(writes([[0, 0, "1.5"]], false))], {
      decimalSeparator: ",",
    });
    expect(source).toContain('"1.5"');
  });

  it("warns once when invariant FORMULAS are recorded", () => {
    const { source } = gen([
      act(writes([[0, 0, "=SUM(A1,B1)"], [1, 0, "=A1*2"]], true)),
    ]);
    expect(source.match(/invariant \(US\) form/g) ?? []).toHaveLength(1);
    expect(source).toContain('"=SUM(A1,B1)"');
  });
});

// ============================================================================
// Sheet handling
// ============================================================================

describe("sheet handling", () => {
  it("activates the first action's sheet by default", () => {
    const { source } = generateMacroSource([act(writes([[0, 0, "x"]]), 2)], {
      ...OBJ,
      undoBatch: false,
    });
    expect(source).toContain("await api.setActiveSheet(2);");
  });

  it("can be asked NOT to pin the sheet", () => {
    const { source } = gen([act(writes([[0, 0, "x"]]), 2)]);
    expect(source).not.toContain("setActiveSheet");
    expect(source).toContain("Runs on the active sheet (recorded on sheet 2)");
  });

  it("emits a switch only when the sheet actually changes", () => {
    const { source } = gen([
      act(writes([[0, 0, "a"]]), 0),
      act({ kind: "insertRows", startRow: 0, count: 1 }, 1),
      act({ kind: "insertRows", startRow: 1, count: 1 }, 1),
      act(writes([[0, 0, "b"]]), 0),
    ]);
    expect(source.match(/setActiveSheet/g) ?? []).toHaveLength(2);
  });

  it("treats an activateSheet marker as sheet context, not a statement", () => {
    const { source } = generateMacroSource([act({ kind: "activateSheet", index: 3 }, 3)], {
      ...OBJ,
      undoBatch: false,
    });
    expect(source).toContain("await api.setActiveSheet(3);");
    // Exactly one — the marker must not emit a second, redundant activate.
    expect(source.match(/setActiveSheet/g) ?? []).toHaveLength(1);
  });
});

// ============================================================================
// Formatting
// ============================================================================

describe("formatting", () => {
  it("emits setRangeFormat over the recorded rectangle", () => {
    const { source } = gen([
      act({
        kind: "formatting",
        rows: [0, 1, 2],
        cols: [0, 1],
        formatting: { bold: true, fontSize: 14 },
      }),
    ]);
    expect(source).toContain(
      "await api.setRangeFormat(0, 0, 2, 1, { bold: true, fontSize: 14 }); // A1:B3",
    );
  });

  it("splits non-contiguous rows into separate calls", () => {
    const { source } = gen([
      act({
        kind: "formatting",
        rows: [0, 1, 5],
        cols: [0],
        formatting: { bold: true },
      }),
    ]);
    expect(source).toContain("await api.setRangeFormat(0, 0, 1, 0,");
    expect(source).toContain("await api.setRangeFormat(5, 0, 5, 0,");
  });

  it("reports properties the script format surface does not accept", () => {
    const { source } = gen([
      act({
        kind: "formatting",
        rows: [0],
        cols: [0],
        formatting: { bold: true, checkbox: true, locked: true },
      }),
    ]);
    expect(source).toContain("// Dropped (not part of the script format surface): checkbox, locked");
    expect(source).toContain("{ bold: true }");
  });

  it("renders a border side as an object literal", () => {
    const { source } = gen([
      act({
        kind: "formatting",
        rows: [0],
        cols: [0],
        formatting: { borderTop: { style: "thin", color: "#000000" } },
      }),
    ]);
    expect(source).toContain('borderTop: { style: "thin", color: "#000000" }');
  });

  it("is not expressible on the notebook runtime", () => {
    const result = gen(
      [act({ kind: "formatting", rows: [0], cols: [0], formatting: { bold: true } })],
      NB,
    );
    expect(result.unsupported).toHaveLength(1);
    expect(result.source).toContain("NOT REPLAYABLE (notebook)");
  });
});

// ============================================================================
// Clear / fill
// ============================================================================

describe("clear range", () => {
  it("clears contents with a bounded loop and one batch call", () => {
    const { source } = gen([
      act({
        kind: "clearRange",
        startRow: 0,
        startCol: 0,
        endRow: 9,
        endCol: 2,
        applyTo: "contents",
      }),
    ]);
    expect(source).toContain("for (let r = 0; r <= 9; r++)");
    expect(source).toContain("for (let c = 0; c <= 2; c++)");
    expect(source).toContain("await api.updateCellsBatch(updates);");
  });

  it('"all" clears both contents and formats', () => {
    const { source } = gen([
      act({
        kind: "clearRange",
        startRow: 0,
        startCol: 0,
        endRow: 1,
        endCol: 1,
        applyTo: "all",
      }),
    ]);
    expect(source).toContain("await api.updateCellsBatch(updates);");
    expect(source).toContain("await api.clearRangeFormat(0, 0, 1, 1); // A1:B2");
  });

  it("reports clear kinds with no script API", () => {
    const result = gen([
      act({
        kind: "clearRange",
        startRow: 0,
        startCol: 0,
        endRow: 0,
        endCol: 0,
        applyTo: "hyperlinks",
      }),
    ]);
    expect(result.unsupported[0]).toContain('clear "hyperlinks"');
  });
});

describe("fill range", () => {
  const down: RecordedEvent = {
    kind: "fillRange",
    sourceStartRow: 0,
    sourceStartCol: 0,
    sourceEndRow: 0,
    sourceEndCol: 1,
    targetStartRow: 1,
    targetStartCol: 0,
    targetEndRow: 9,
    targetEndCol: 1,
  };

  it("maps a downward fill onto Calcula.fillDown (notebook)", () => {
    const { source } = gen([act(down)], NB);
    expect(source).toContain("Calcula.fillDown(0, 0, 9, 1);");
  });

  it("maps a rightward fill onto Calcula.fillRight (notebook)", () => {
    const right: RecordedEvent = {
      kind: "fillRange",
      sourceStartRow: 0,
      sourceStartCol: 0,
      sourceEndRow: 5,
      sourceEndCol: 0,
      targetStartRow: 0,
      targetStartCol: 1,
      targetEndRow: 5,
      targetEndCol: 4,
    };
    const { source } = gen([act(right)], NB);
    expect(source).toContain("Calcula.fillRight(0, 0, 5, 4);");
  });

  it("reports an upward fill (no matching op)", () => {
    const up: RecordedEvent = {
      kind: "fillRange",
      sourceStartRow: 9,
      sourceStartCol: 0,
      sourceEndRow: 9,
      sourceEndCol: 0,
      targetStartRow: 0,
      targetStartCol: 0,
      targetEndRow: 8,
      targetEndCol: 0,
    };
    const result = gen([act(up)], NB);
    expect(result.unsupported).toHaveLength(1);
  });

  it("reports that the object-script API cannot fill at all", () => {
    const result = gen([act(down)]);
    expect(result.unsupported[0]).toContain("has no fill");
  });
});

// ============================================================================
// Structural / sheet / search actions
// ============================================================================

describe("structural actions (object script)", () => {
  const cases: Array<[RecordedEvent, string]> = [
    [{ kind: "insertRows", startRow: 3, count: 2 }, "await api.insertRows(3, 2);"],
    [{ kind: "deleteRows", startRow: 1, count: 4 }, "await api.deleteRows(1, 4);"],
    [{ kind: "insertColumns", startCol: 2, count: 1 }, "await api.insertColumns(2, 1);"],
    [{ kind: "deleteColumns", startCol: 0, count: 3 }, "await api.deleteColumns(0, 3);"],
    [
      { kind: "mergeCells", startRow: 0, startCol: 0, endRow: 0, endCol: 3 },
      "await api.mergeCells(0, 0, 0, 3); // A1:D1",
    ],
    [{ kind: "unmergeCells", row: 0, col: 0 }, "await api.unmergeCells(0, 0); // A1"],
    [{ kind: "rowHeight", row: 4, height: 32 }, "await api.setRowHeight(4, 32);"],
    [{ kind: "columnWidth", col: 2, width: 140 }, "await api.setColumnWidth(2, 140);"],
    [
      { kind: "freezePanes", freezeRow: 1, freezeCol: null },
      "await api.freezePanes(1, null);",
    ],
    [{ kind: "addSheet", index: 2, name: "Summary" }, 'await api.addSheet("Summary");'],
    [{ kind: "deleteSheet", index: 1 }, "await api.deleteSheet(1);"],
    [
      { kind: "renameSheet", index: 0, newName: "Data" },
      'await api.renameSheet(0, "Data");',
    ],
  ];

  for (const [event, expected] of cases) {
    it(`emits ${expected}`, () => {
      expect(gen([act(event)]).source).toContain(expected);
    });

    it(`reports ${event.kind} as unavailable on the notebook runtime`, () => {
      expect(gen([act(event)], NB).unsupported).toHaveLength(1);
    });
  }

  it("emits replaceAll with its options", () => {
    const { source } = gen([
      act({
        kind: "replaceAll",
        search: "old",
        replacement: "new",
        caseSensitive: true,
        matchEntireCell: false,
      }),
    ]);
    expect(source).toContain(
      'await api.replaceAll("old", "new", { caseSensitive: true, matchEntireCell: false });',
    );
  });

  it("reports border presets on both runtimes", () => {
    const event: RecordedEvent = {
      kind: "borderPreset",
      startRow: 0,
      startCol: 0,
      endRow: 2,
      endCol: 2,
      preset: "allBorders",
      style: "solid",
      color: "#000000",
      width: 1,
    };
    expect(gen([act(event)]).unsupported).toHaveLength(1);
    expect(gen([act(event)], NB).unsupported).toHaveLength(1);
  });
});

// ============================================================================
// Sort / remove duplicates
// ============================================================================
//
// Sort is the action a recorder MUST NOT miss: a macro that replays the writes
// around a sort but not the sort itself runs cleanly and leaves the workbook in
// a different order than the user saw. These tests pin both the emitted call
// and the fact that the broker would accept it.

/** A sort event over A1:C10, ascending on the second column. */
function sortEvent(
  overrides: Partial<Extract<RecordedEvent, { kind: "sort" }>> = {},
): RecordedEvent {
  return {
    kind: "sort",
    startRow: 0,
    startCol: 0,
    endRow: 9,
    endCol: 2,
    fields: [{ key: 1, ascending: true }],
    matchCase: false,
    hasHeaders: true,
    orientation: "rows",
    ...overrides,
  };
}

/**
 * Run generated object-script source against a recording `api` double.
 *
 * This is the only way to prove the emitted text is a working call and not just
 * a plausible-looking string: the source is compiled and executed, so a syntax
 * error or a wrong arity fails the test instead of shipping.
 */
async function runGenerated(
  actions: RecordedAction[],
): Promise<Array<{ method: string; args: unknown[] }>> {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record =
    (method: string) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      return 0;
    };
  const api = {
    sortRange: record("sortRange"),
    setCellValue: record("setCellValue"),
    updateCellsBatch: record("updateCellsBatch"),
    setActiveSheet: record("setActiveSheet"),
  };

  const { source } = generateMacroSource(actions, {
    target: "objectScript",
    wrapper: "objectScript",
    header: false,
    undoBatch: false,
    emitInitialSheetActivate: false,
    recordedAt: "T",
    name: "Sort check",
  });

  const factory = new Function(`${source}\nreturn sortCheck;`) as () => (
    api: unknown,
  ) => Promise<void>;
  await factory()(api);
  return calls;
}

describe("sort", () => {
  it("emits a sortRange call with the recorded rectangle, fields and options", () => {
    const { source, unsupported } = gen([act(sortEvent())]);
    expect(unsupported).toEqual([]);
    expect(source).toContain(
      "await api.sortRange(0, 0, 9, 2, [{ key: 1, ascending: true }], " +
        '{ matchCase: false, hasHeaders: true, orientation: "rows" }); // A1:C10',
    );
  });

  it("emits every criterion of a multi-field sort, in order", () => {
    const { source } = gen([
      act(
        sortEvent({
          fields: [
            { key: 0, ascending: false, sortOn: "value" },
            { key: 2, ascending: true, dataOption: "textAsNumber" },
          ],
        }),
      ),
    ]);
    expect(source).toContain(
      '[{ key: 0, ascending: false, sortOn: "value" }, ' +
        '{ key: 2, ascending: true, dataOption: "textAsNumber" }]',
    );
  });

  it("emits colour and custom-order criteria the script API understands", () => {
    const { source } = gen([
      act(
        sortEvent({
          fields: [
            { key: 1, sortOn: "cellColor", color: "#FF0000" },
            { key: 0, customOrder: "months" },
          ],
        }),
      ),
    ]);
    expect(source).toContain('{ key: 1, sortOn: "cellColor", color: "#FF0000" }');
    expect(source).toContain('{ key: 0, customOrder: "months" }');
  });

  it("drops properties the broker validator would reject", () => {
    // A recorded field can carry more than the script API accepts (an older
    // recording, a future backend field). The broker rejects an UNKNOWN
    // property outright, so emitting it would generate a macro that throws.
    const field = { key: 1, ascending: true, weight: 3 } as unknown as {
      key: number;
      ascending: boolean;
    };
    const { source } = gen([act(sortEvent({ fields: [field] }))]);
    expect(source).toContain("[{ key: 1, ascending: true }]");
    expect(source).not.toContain("weight");
  });

  it("respects matchCase and column orientation", () => {
    const { source } = gen([
      act(sortEvent({ matchCase: true, hasHeaders: false, orientation: "columns" })),
    ]);
    expect(source).toContain(
      '{ matchCase: true, hasHeaders: false, orientation: "columns" }',
    );
  });

  it("reports a sort as unavailable on the notebook runtime", () => {
    const { unsupported, source } = gen([act(sortEvent())], NB);
    expect(unsupported).toHaveLength(1);
    expect(unsupported[0]).toContain("A1:C10");
    expect(source).not.toContain("sortRange");
  });

  it("refuses to emit a sort with no criteria", () => {
    const { unsupported, source } = gen([act(sortEvent({ fields: [] }))]);
    expect(unsupported).toHaveLength(1);
    expect(unsupported[0]).toContain("no sort criteria");
    expect(source).not.toContain("api.sortRange");
  });

  it("refuses to emit a sort whose key is not a range-relative offset", () => {
    const { unsupported, source } = gen([
      act(sortEvent({ fields: [{ key: -1, ascending: true }] })),
    ]);
    expect(unsupported).toHaveLength(1);
    expect(unsupported[0]).toContain("offset from the range start");
    expect(source).not.toContain("api.sortRange");
  });

  it("generates source that runs and calls api.sortRange with the right arguments", async () => {
    const calls = await runGenerated([act(sortEvent())]);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("sortRange");
    expect(calls[0].args).toEqual([
      0,
      0,
      9,
      2,
      [{ key: 1, ascending: true }],
      { matchCase: false, hasHeaders: true, orientation: "rows" },
    ]);
  });

  it("generates a sort call the REAL broker validator accepts", async () => {
    const calls = await runGenerated([
      act(
        sortEvent({
          fields: [
            { key: 1, ascending: false, sortOn: "fontColor", color: "#00FF00" },
            { key: 2, dataOption: "textAsNumber", customOrder: "weekdays" },
          ],
          matchCase: true,
          orientation: "columns",
        }),
      ),
    ]);
    expect(vSortRange(calls[0].args)).toBe(true);
  });
});

describe("remove duplicates", () => {
  const event: RecordedEvent = {
    kind: "removeDuplicates",
    startRow: 0,
    startCol: 0,
    endRow: 99,
    endCol: 4,
    keyColumns: [0, 2],
    hasHeaders: true,
  };

  it("is reported on both runtimes rather than silently dropped", () => {
    for (const opts of [{}, NB]) {
      const { unsupported, source } = gen([act(event)], opts);
      expect(unsupported).toHaveLength(1);
      expect(source).toContain("NOT REPLAYABLE");
    }
  });

  it("names the range and the key columns so the user can redo it", () => {
    const { unsupported } = gen([act(event)]);
    expect(unsupported[0]).toContain("A1:E100");
    expect(unsupported[0]).toContain("key columns A, C");
  });

  it("uses the singular for a single key column", () => {
    const { unsupported } = gen([act({ ...event, keyColumns: [3] })]);
    expect(unsupported[0]).toContain("key column D");
  });
});

// ============================================================================
// Commands (slice 2)
// ============================================================================

describe("commands", () => {
  it("emits executeCommand for a recorded command", () => {
    const { source } = gen([act({ kind: "command", commandId: "flashfill.execute" })]);
    expect(source).toContain('api.executeCommand("flashfill.execute");');
    expect(source).toContain("acts on the workbook state at replay time");
  });

  it("passes JSON args through", () => {
    const { source } = gen([
      act({ kind: "command", commandId: "bookmarks.add", args: { color: "blue" } }),
    ]);
    expect(source).toContain('api.executeCommand("bookmarks.add", {"color":"blue"});');
  });

  it("drops args that are not representable", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const { source } = gen([
      act({ kind: "command", commandId: "x.y", args: cyclic }),
    ]);
    expect(source).toContain('api.executeCommand("x.y");');
  });

  it("has no equivalent on the notebook runtime", () => {
    const result = gen([act({ kind: "command", commandId: "x.y" })], NB);
    expect(result.unsupported[0]).toContain("command x.y");
  });
});

// ============================================================================
// Wrappers, header, options
// ============================================================================

describe("wrappers", () => {
  it("emits the macro function AND the setup() that invokes it", () => {
    const { source } = generateMacroSource([act(writes([[0, 0, "x"]]))], {
      target: "objectScript",
      wrapper: "objectScript",
      name: "Monthly close",
      header: false,
      undoBatch: false,
    });
    expect(source).toContain("async function monthlyClose(api) {");
    expect(source).toContain("function setup(context) {");
    // THE REGRESSION THAT SHIPPED: the stored module used to end in a COMMENT
    // describing how one might call the macro, so running it defined a function
    // and stopped. The last statement must be an INVOCATION.
    expect(source).toContain("return monthlyClose(context.api);");
    expect(source.trimEnd().endsWith("}")).toBe(true);
  });

  it("the same setup() wires a click when the context is a button", () => {
    const { source } = generateMacroSource([act(writes([[0, 0, "x"]]))], {
      target: "objectScript",
      wrapper: "objectScript",
      name: "Refresh",
      header: false,
      undoBatch: false,
    });
    expect(source).toContain('if (typeof context.onClick === "function") {');
    expect(source).toContain("context.onClick(async () => {");
    expect(source).toContain("await refresh(context.api);");
    expect(source).toContain("needs an UNLOCKED script");
  });

  it("setup() RUNS the macro when the context is not a button", async () => {
    const { source } = generateMacroSource([act(writes([[3, 4, "hi"]]))], {
      target: "objectScript",
      wrapper: "objectScript",
      name: "Direct run",
      header: false,
      undoBatch: false,
      emitInitialSheetActivate: false,
    });
    const calls: Array<[number, number, string]> = [];
    const api = {
      setCellValue: (row: number, col: number, value: string) => {
        calls.push([row, col, value]);
        return Promise.resolve();
      },
    };
    // eslint-disable-next-line no-new-func
    const factory = new Function(`${source}
return setup;`) as () => (
      ctx: unknown,
    ) => Promise<void> | void;
    await factory()({ api, notify: () => {} });
    expect(calls).toEqual([[3, 4, "hi"]]);
  });

  it("setup() refuses, out loud, when the tier gives it no api", () => {
    const { source } = generateMacroSource([act(writes([[0, 0, "x"]]))], {
      target: "objectScript",
      wrapper: "objectScript",
      name: "Needs api",
      header: false,
      undoBatch: false,
    });
    const messages: string[] = [];
    // eslint-disable-next-line no-new-func
    const factory = new Function(`${source}
return setup;`) as () => (
      ctx: unknown,
    ) => void;
    factory()({ api: null, notify: (m: string) => messages.push(m) });
    expect(messages.join(" ")).toContain("UNLOCKED");
  });

  it("wraps the body in a single undo transaction by default", () => {
    const { source } = generateMacroSource([act(writes([[0, 0, "x"]]))], {
      target: "objectScript",
      name: "Tidy",
      header: false,
    });
    expect(source).toContain('await api.beginBatch("Tidy");');
    expect(source).toContain("await api.commitBatch();");
    expect(source).toContain("await api.cancelBatch();");
  });

  it("the notebook target emits bare statements (no function wrapper)", () => {
    const { source } = generateMacroSource([act(writes([[0, 0, "x"]]))], {
      ...NB,
      emitInitialSheetActivate: false,
    });
    expect(source).toContain('Calcula.setCellValue(0, 0, "x"); // A1');
    expect(source).not.toContain("function ");
    expect(source).not.toContain("await ");
  });

  it("rejects an object-script wrapper on the notebook target", () => {
    expect(() =>
      generateMacroSource([], { target: "notebook", wrapper: "objectScript" }),
    ).toThrow(/notebook target only emits/);
  });

  it("rejects the notebook wrapper on the object-script target", () => {
    expect(() =>
      generateMacroSource([], { target: "objectScript", wrapper: "notebookCell" }),
    ).toThrow(/notebook shape/);
  });
});

describe("header", () => {
  it("names the macro, the runtime and the action count", () => {
    const { source } = generateMacroSource([act(writes([[0, 0, "x"]]))], {
      target: "objectScript",
      name: "Monthly close",
      recordedAt: "2026-07-31T09:00:00.000Z",
    });
    expect(source).toContain("// Macro: Monthly close");
    expect(source).toContain("// Recorded: 2026-07-31T09:00:00.000Z  (1 action)");
    expect(source).toContain("// Target runtime: Calcula object script");
    expect(source).toContain("// Requires an UNLOCKED script");
  });

  it("lists the actions the target cannot express", () => {
    const { source } = generateMacroSource(
      [act({ kind: "formatting", rows: [0], cols: [0], formatting: { bold: true } })],
      { target: "notebook", name: "M", recordedAt: "T" },
    );
    expect(source).toContain("// 1 action(s) could not be expressed on this target:");
  });
});

describe("edge cases", () => {
  it("says so when nothing was recorded", () => {
    const { source } = gen([]);
    expect(source).toContain("// Nothing was recorded.");
  });

  it("is deterministic", () => {
    const actions = [
      act(writes([[0, 0, "a"]])),
      act({ kind: "insertRows", startRow: 1, count: 1 }),
    ];
    const a = generateMacroSource(actions, { ...OBJ, recordedAt: "T" });
    const b = generateMacroSource(actions, { ...OBJ, recordedAt: "T" });
    expect(a.source).toBe(b.source);
  });

  it("produces syntactically valid JavaScript for every runtime", () => {
    const actions = [
      act(writes([[0, 0, 'weird "value"\nline2\\end']])),
      act(writes([[1, 0, "a"], [2, 0, "b"]])),
      act({ kind: "formatting", rows: [0, 1], cols: [0], formatting: { bold: true } }),
      act({ kind: "clearRange", startRow: 0, startCol: 0, endRow: 3, endCol: 3, applyTo: "all" }),
      act({ kind: "insertRows", startRow: 0, count: 1 }),
      act({ kind: "command", commandId: "x.y", args: { a: 1 } }, 1),
    ];
    for (const opts of [
      { target: "objectScript" as const, wrapper: "objectScript" as const },
      { target: "notebook" as const },
    ]) {
      const { source } = generateMacroSource(actions, { ...opts, recordedAt: "T" });
      // eslint-disable-next-line no-new-func
      expect(() => new Function(source)).not.toThrow();
    }
  });
});
