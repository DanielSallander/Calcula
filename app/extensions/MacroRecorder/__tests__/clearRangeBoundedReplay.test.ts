//! FILENAME: app/extensions/MacroRecorder/__tests__/clearRangeBoundedReplay.test.ts
// PURPOSE: A recorded Clear replays as a bounded number of script calls, never
//          one step per POSITION of the recorded rectangle.
// CONTEXT: The generator used to replay a recorded Clear Contents as a loop
//          pushing one update per position (object script) or calling
//          `setCellValue` once per position (notebook). A recorded Delete on a
//          clicked column header therefore replayed 1,048,576 updates, and
//          Select All about 17 billion, so the macro hung its run or ran out of
//          memory. A rectangle that fits one script call still replays as one
//          call; a bigger one clears contents only where the sheet stores cells
//          (the used range, read at replay time), in calls the script API
//          accepts; its formats replay as ONE call over the rectangle when it is
//          whole lines or fits the script API's format bound (BUG-0616 #1), and
//          are reported, never dropped, when it does not. The action's own
//          sheet keeps `api.updateCellsBatch`, which the cell access of an
//          application's macro run by a person admits (owner decision B).
//
//          Each generated macro is RUN against a recording fake of the script
//          surface, every call checked by the broker's own validator and limit.
//          The fake notebook ops answer as the real QuickJS ops do (JSON text;
//          core/script-engine/src/ops/{worksheet_props,sheets,cells}.rs).
//
//          Round 6 (review rev4A#2): the used range is a BOUNDING BOX, so a
//          sparse sheet (data in A1:D100 plus one cell at XFD1048576) still made
//          the cut the whole sheet and the loop hung. The cut is now READ in row
//          bands and "" is written only where a cell holds a value or a formula;
//          a cut over CLEAR_REPLAY_MAX_SCANNED_CELLS is refused when the macro
//          runs, never looped over. The fakes therefore answer the band reads
//          from a model of the cells the sheet holds (by default: every
//          position of the used range, which is what the round-4 cases meant).

import { describe, it, expect } from "vitest";
import {
  generateMacroSource,
  SCRIPT_RANGE_MAX_CELLS,
  CLEAR_REPLAY_MAX_SCANNED_CELLS,
  SCRIPT_FORMAT_RECT_MAX_CELLS,
  formatCallAccepts,
} from "../lib/actionCodegen";
import type { RecordedAction, RecordedEvent } from "../lib/types";
import {
  MAX_FORMAT_RECT_CELLS,
  MAX_RANGE_CELLS,
  vBatch,
  vClearRange,
  vFormatRangeRef,
  vRangeRef,
  vUsedRange,
} from "@api/scriptHost/validators";
import { ALLOWLIST } from "@api/scriptHost/allowlist";
import { explicitRunAdmits } from "@api/scriptHost/explicitRunGrant";

const LAST_ROW = 1_048_575;
const LAST_COL = 16_383;

type Call = { method: string; args: unknown[] };

interface UsedRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  empty: boolean;
}

const EMPTY: UsedRange = { startRow: 0, startCol: 0, endRow: 0, endCol: 0, empty: true };

function clearEvent(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  applyTo: "contents" | "all" | "formats",
  sheetIndex?: number,
): RecordedEvent {
  return {
    kind: "clearRange",
    startRow,
    startCol,
    endRow,
    endCol,
    applyTo,
    ...(sheetIndex === undefined ? {} : { sheetIndex }),
  };
}

function generate(event: RecordedEvent, target: "objectScript" | "notebook") {
  const actions: RecordedAction[] = [{ seq: 1, sheetIndex: 0, event }];
  return generateMacroSource(actions, {
    target,
    header: false,
    undoBatch: false,
    emitInitialSheetActivate: false,
    recordedAt: "T",
    name: "Clear check",
  });
}

/**
 * The old shape: a loop over the RECORDED rectangle's literal bounds. Checked
 * on the source BEFORE running it -- on Select All that loop would hang this
 * test (about 17 billion iterations).
 */
function assertNoLoopOverTheRecordedRectangle(source: string, endRow: number): void {
  expect(source, "a loop over every position of the recorded rectangle").not.toContain(`r <= ${endRow}; r++`);
}

/** The cell access an application's macro gets when a person runs it (owner decision B). */
const GRANT = { explicitRun: { cells: true } };

/** What a sheet holds at a position: a value, a formula (its result may be ""), or nothing. */
interface Held {
  value: string | number | null;
  formula?: string;
}

/**
 * Which positions hold something, per sheet (null = the active one). The
 * default holds a number at EVERY position of the used range -- the dense
 * sheet the round-4 cases describe.
 */
type Holds = (sheet: number | null, row: number, col: number) => Held | null;

function denseHolds(used: (sheet: number | null) => UsedRange): Holds {
  return (sheet, row, col) => {
    const u = used(sheet);
    if (u.empty || row < u.startRow || row > u.endRow || col < u.startCol || col > u.endCol) return null;
    return { value: 1 };
  };
}

/**
 * The script API's typed cell (api.getRangeValues), built as host.ts
 * readTypedRange does. A formula whose result is empty is typed "empty" here
 * -- the hardest case: only its `formula` says it holds anything.
 */
function scriptCell(held: Held | null) {
  if (held === null) return { value: null, display: "", type: "empty" };
  const type = held.value === null || held.value === "" ? "empty" : typeof held.value === "number" ? "number" : "text";
  return {
    value: held.value === "" ? "" : held.value,
    display: String(held.value ?? ""),
    type,
    ...(held.formula ? { formula: held.formula } : {}),
  };
}

/** Run a generated object-script macro; `used` answers getUsedRange per sheet (null = the active one). */
async function runObjectScript(
  event: RecordedEvent,
  used: (sheet: number | null) => UsedRange,
  holds: Holds = denseHolds(used),
): Promise<{ calls: Call[]; unsupported: string[] }> {
  const { source, unsupported } = generate(event, "objectScript");
  const rect = event as { startRow: number; startCol: number; endRow: number; endCol: number };
  const cells = (rect.endRow - rect.startRow + 1) * (rect.endCol - rect.startCol + 1);
  if (cells > SCRIPT_RANGE_MAX_CELLS) assertNoLoopOverTheRecordedRectangle(source, rect.endRow);
  const calls: Call[] = [];
  const api = new Proxy({} as Record<string, unknown>, {
    get: (_t, method: string) => async (...args: unknown[]) => {
      calls.push({ method, args });
      if (method === "getUsedRange") {
        expect(vUsedRange(args)).toBe(true);
        return used(typeof args[0] === "number" ? args[0] : null);
      }
      if (method === "getRangeValues") {
        // The broker's own check: the shape, a sheet ref, and at most MAX_RANGE_CELLS.
        expect(vRangeRef(args), `api.getRangeValues(${JSON.stringify(args)})`).toBe(true);
        const [r0, c0, r1, c1, sheet] = args as [number, number, number, number, number | undefined];
        const band = [];
        for (let r = r0; r <= r1; r++) {
          const row = [];
          for (let c = c0; c <= c1; c++) row.push(scriptCell(holds(typeof sheet === "number" ? sheet : null, r, c)));
          band.push(row);
        }
        return band;
      }
      if (method === "clearRange") expect(vClearRange(args), `api.clearRange(${JSON.stringify(args)})`).toBe(true);
      if (method === "clearRangeFormat") {
        expect(vFormatRangeRef(args), `api.clearRangeFormat(${JSON.stringify(args)})`).toBe(true);
      }
      if (method === "updateCellsBatch") {
        // The broker's own checks: the shape, and the per-call limit.
        expect(vBatch(args)).toBe(true);
        expect((args[0] as unknown[]).length).toBeLessThanOrEqual(ALLOWLIST["api.updateCellsBatch"].limits!.maxCells!);
      }
      return { count: 0 };
    },
  });
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${source}\nreturn clearCheck;`) as () => (api: unknown) => Promise<void>;
  await factory()(api);
  return { calls, unsupported };
}

type Update = { row: number; col: number; value: string };

/** Every position written by the updateCellsBatch calls, as "row:col" (each once). */
function batchPositions(calls: Call[]): string[] {
  const out: string[] = [];
  for (const c of calls) {
    if (c.method !== "updateCellsBatch") continue;
    for (const u of c.args[0] as Update[]) {
      expect(u.value).toBe("");
      out.push(`${u.row}:${u.col}`);
    }
  }
  expect(new Set(out).size, "a position written twice").toBe(out.length);
  return out;
}

/** "row:col" for every position of a rectangle. */
function positions(r0: number, c0: number, r1: number, c1: number): string[] {
  const out: string[] = [];
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) out.push(`${r}:${c}`);
  return out;
}

/** Cells covered by a list of clearRange calls (each a rectangle). */
function cellsCovered(calls: Call[]): number {
  return calls
    .filter((c) => c.method === "clearRange")
    .reduce((n, c) => {
      const [r0, c0, r1, c1] = c.args as number[];
      return n + (r1 - r0 + 1) * (c1 - c0 + 1);
    }, 0);
}

describe("the generator's one-call limit is the broker's", () => {
  it("SCRIPT_RANGE_MAX_CELLS equals MAX_RANGE_CELLS (vRangeRef refuses more) and updateCellsBatch's limit", () => {
    expect(SCRIPT_RANGE_MAX_CELLS).toBe(MAX_RANGE_CELLS);
    expect(SCRIPT_RANGE_MAX_CELLS).toBe(ALLOWLIST["api.updateCellsBatch"].limits?.maxCells);
  });

  // BUG-0616 #1: a format / clear call takes the backend's bound, not the
  // 100,000 of a read. The generator's restated twin must answer exactly as the
  // broker's validator does.
  it("SCRIPT_FORMAT_RECT_MAX_CELLS equals MAX_FORMAT_RECT_CELLS, and formatCallAccepts is vFormatRangeRef", () => {
    expect(SCRIPT_FORMAT_RECT_MAX_CELLS).toBe(MAX_FORMAT_RECT_CELLS);
    const rects: Array<[number, number, number, number]> = [
      [0, 2, LAST_ROW, 2], // a whole column
      [4, 0, 4, LAST_COL], // a whole row
      [0, 0, LAST_ROW, LAST_COL], // Select All
      [1, 0, LAST_ROW, 3], // almost-whole columns A:D (4,194,300 cells)
      [0, 0, 999_999, 9], // 10 million cells, not lines
      [0, 0, 1999, 1999], // exactly 4,000,000
      [0, 0, 2000, 1999], // one row more
      [100, 0, 300_000, 15], // short of its columns by too much
    ];
    for (const [r0, c0, r1, c1] of rects) {
      expect(formatCallAccepts(r0, c0, r1, c1), JSON.stringify([r0, c0, r1, c1])).toBe(
        vFormatRangeRef([r0, c0, r1, c1]) === true,
      );
    }
  });
});

describe("a recorded whole-column FORMAT replays (BUG-0616 #1)", () => {
  // SABOTAGE: make vFormatRangeRef refuse above MAX_RANGE_CELLS -> the one
  // call the generator emits is refused by the broker's own validator.
  it("a recorded Bold on column C: ONE setRangeFormat over the column, which the broker's validator accepts", () => {
    const rows = Array.from({ length: LAST_ROW + 1 }, (_, i) => i);
    const event = { kind: "formatting", rows, cols: [2], formatting: { bold: true } } as unknown as RecordedEvent;
    const { source, unsupported } = generate(event, "objectScript");
    expect(unsupported).toEqual([]);
    const emitted = [...source.matchAll(/await api\.setRangeFormat\(([^)]*)\)/g)];
    expect(emitted, source).toHaveLength(1);
    // eslint-disable-next-line no-new-func
    const args = new Function(`return [${emitted[0][1]}];`)() as unknown[];
    expect(args.slice(0, 4)).toEqual([0, 2, LAST_ROW, 2]);
    expect(ALLOWLIST["api.setRangeFormat"].validate(args)).toBe(true);
  });
});

describe("object script: a recorded Clear replays as bounded calls", () => {
  // SABOTAGE: emit the small-rectangle loop (emitContentsBatch) for EVERY size
  // in emitClearRange (lib/actionCodegen.ts) -> the source loops over the
  // recorded rectangle and assertNoLoopOverTheRecordedRectangle fails.
  it("a Delete on a clicked column header: only the column's stored rows, in one batch", async () => {
    const { calls, unsupported } = await runObjectScript(clearEvent(0, 2, LAST_ROW, 2, "contents"), () => ({
      startRow: 0,
      startCol: 0,
      endRow: 9,
      endCol: 4,
      empty: false,
    }));
    expect(unsupported).toEqual([]);
    // Round 6 (changed deliberately): the cut is READ before it is written.
    expect(calls.map((c) => c.method)).toEqual(["getUsedRange", "getRangeValues", "updateCellsBatch"]);
    expect(calls[0].args).toEqual([]);
    expect(calls[1].args).toEqual([0, 2, 9, 2]);
    expect(batchPositions(calls)).toEqual(positions(0, 2, 9, 2));
  });

  // SABOTAGE: replay the action's own contents through api.clearRangeFormat ->
  // the grant refuses it (formatting), and every recorded Delete in an
  // application's macro would fail when a person runs it.
  it("an application's macro run by a person may make every call a recorded Delete replays (the explicit-run cell access)", async () => {
    const used = (): UsedRange => ({ startRow: 0, startCol: 0, endRow: 9, endCol: 4, empty: false });
    for (const event of [clearEvent(0, 2, LAST_ROW, 2, "contents"), clearEvent(0, 0, 1, 1, "contents")]) {
      const { calls } = await runObjectScript(event, used);
      expect(calls.length).toBeGreaterThan(0);
      for (const c of calls) expect(explicitRunAdmits(GRANT, `api.${c.method}`), `api.${c.method}`).toBe(true);
    }
  });

  it("Select All over a used range bigger than one call: batches the broker accepts, covering exactly the used range", async () => {
    const used: UsedRange = { startRow: 3, startCol: 1, endRow: 40_002, endCol: 5, empty: false };
    const { calls } = await runObjectScript(clearEvent(0, 0, LAST_ROW, LAST_COL, "contents"), () => used);
    const batches = calls.filter((c) => c.method === "updateCellsBatch");
    expect(batches).toHaveLength(2);
    expect(batchPositions(calls)).toEqual(positions(3, 1, 40_002, 5));
  });

  it("an empty sheet: nothing is cleared", async () => {
    const { calls } = await runObjectScript(clearEvent(0, 0, LAST_ROW, LAST_COL, "contents"), () => EMPTY);
    expect(calls.map((c) => c.method)).toEqual(["getUsedRange"]);
  });

  it("a used range that misses the rectangle: nothing is cleared", async () => {
    const { calls } = await runObjectScript(clearEvent(0, 7, LAST_ROW, 7, "contents"), () => ({
      startRow: 0,
      startCol: 0,
      endRow: 50,
      endCol: 3,
      empty: false,
    }));
    expect(calls.map((c) => c.method)).toEqual(["getUsedRange"]);
  });

  // CHANGED DELIBERATELY (BUG-0616 #1, owner rule "Excel wins"): the whole
  // column's FORMATS replay too, as ONE clearRangeFormat over the column --
  // VBA's Columns("C").Clear clears the column format -- where they were
  // reported as not replayable while the script API refused 100,000+ cells.
  // SABOTAGE: restore `fits` (100,000 cells) as the format condition in
  // emitClearRange -> the formats are reported unsupported again.
  it("Clear All on a whole column: contents bounded, formats as ONE call over the column", async () => {
    const { calls, unsupported } = await runObjectScript(clearEvent(0, 2, LAST_ROW, 2, "all"), () => ({
      startRow: 0,
      startCol: 2,
      endRow: 4,
      endCol: 2,
      empty: false,
    }));
    expect(unsupported).toEqual([]);
    expect(calls.map((c) => c.method)).toEqual(["getUsedRange", "getRangeValues", "updateCellsBatch", "clearRangeFormat"]);
    expect(batchPositions(calls)).toEqual(positions(0, 2, 4, 2));
    expect(calls[3].args).toEqual([0, 2, LAST_ROW, 2]);
  });

  it("a rectangle that fits one call replays as before: one batch, then one clearRangeFormat", async () => {
    const { calls, unsupported } = await runObjectScript(clearEvent(0, 0, 1, 1, "all"), () => EMPTY);
    expect(unsupported).toEqual([]);
    expect(calls.map((c) => c.method)).toEqual(["updateCellsBatch", "clearRangeFormat"]);
    expect(batchPositions(calls)).toEqual(positions(0, 0, 1, 1));
  });

  it("Clear Formats on a whole column: one clearRangeFormat over the column (BUG-0616 #1)", async () => {
    const { calls, unsupported } = await runObjectScript(clearEvent(0, 2, LAST_ROW, 2, "formats"), () => EMPTY);
    expect(unsupported).toEqual([]);
    expect(calls).toEqual([{ method: "clearRangeFormat", args: [0, 2, LAST_ROW, 2] }]);
  });

  it("Clear Formats on a grouped sheet's whole column: one sheet-addressed clear on THAT sheet", async () => {
    const { calls, unsupported } = await runObjectScript(clearEvent(0, 2, LAST_ROW, 2, "formats", 2), () => EMPTY);
    expect(unsupported).toEqual([]);
    expect(calls).toEqual([{ method: "clearRange", args: [0, 2, LAST_ROW, 2, { applyTo: "formats" }, 2] }]);
  });

  it("Clear Formats on 10 million cells that are not whole lines: reported, no call the script API would refuse", async () => {
    const { calls, unsupported } = await runObjectScript(clearEvent(0, 0, 999_999, 9, "formats"), () => EMPTY);
    expect(calls).toEqual([]);
    expect(unsupported).toHaveLength(1);
    expect(unsupported[0]).toContain("clear formats on A1:J1000000");
  });

  it("a grouped sheet's whole-column clear: bounded by THAT sheet's used range, on that sheet", async () => {
    const { calls } = await runObjectScript(clearEvent(0, 0, LAST_ROW, 0, "contents", 2), (sheet) =>
      sheet === 2 ? { startRow: 1, startCol: 0, endRow: 6, endCol: 0, empty: false } : EMPTY,
    );
    expect(calls).toEqual([
      { method: "getUsedRange", args: [2] },
      { method: "getRangeValues", args: [1, 0, 6, 0, 2] },
      { method: "clearRange", args: [1, 0, 6, 0, { applyTo: "contents" }, 2] },
    ]);
  });

  it("a grouped sheet's Select All over a big used range: row bands of the sheet-addressed clear, covering exactly it", async () => {
    const big: UsedRange = { startRow: 0, startCol: 0, endRow: 59_999, endCol: 3, empty: false };
    const { calls } = await runObjectScript(clearEvent(0, 0, LAST_ROW, LAST_COL, "contents", 3), (sheet) =>
      sheet === 3 ? big : EMPTY,
    );
    const clears = calls.filter((c) => c.method === "clearRange");
    expect(clears).toHaveLength(3);
    for (const c of clears) {
      expect(c.args[1]).toBe(0);
      expect(c.args[3]).toBe(3);
      expect(c.args[5], "on the grouped sheet").toBe(3);
    }
    expect(clears[0].args[0]).toBe(0);
    expect(clears.at(-1)!.args[2]).toBe(59_999);
    expect(cellsCovered(calls)).toBe(60_000 * 4);
  });
});

/** A sheet whose cells sit in A1:D100 plus ONE far-away cell at XFD1048576 (review rev4A#2). */
const SPARSE_FULL_SHEET: UsedRange = { startRow: 0, startCol: 0, endRow: LAST_ROW, endCol: LAST_COL, empty: false };
function sparseHolds(row: number, col: number): Held | null {
  if (row <= 99 && col <= 3) return { value: row * 10 + col };
  if (row === LAST_ROW && col === LAST_COL) return { value: "far" };
  return null;
}

describe("object script: the replay reads the cut and writes only the cells that hold something (rev4A#2)", () => {
  // SABOTAGE: drop the scan cap (the `if (scanned > ...) throw` line in
  // pushScanGuardAndStep) -> the fake starts reading a 17-billion-position
  // sheet in bands; the call guard below throws "unbounded band reads".
  it("Select All, Delete on a sheet whose used range is stretched by one far-away cell: refused with the reason, no loop", async () => {
    let reads = 0;
    const holds: Holds = (_sheet, row, col) => {
      reads++;
      if (reads > 1_000_000) throw new Error("unbounded band reads");
      return sparseHolds(row, col);
    };
    const run = runObjectScript(clearEvent(0, 0, LAST_ROW, LAST_COL, "contents"), () => SPARSE_FULL_SHEET, holds);
    await expect(run).rejects.toThrow(/was not replayed: inside it, the sheet's used range covers 17179869184 cells/);
    await expect(run).rejects.toThrow(`more than the ${CLEAR_REPLAY_MAX_SCANNED_CELLS}`);
    expect(reads, "nothing was read").toBe(0);
  });

  // SABOTAGE: write "" to every position of the read band (drop the
  // `type === "empty" && !formula` skip) -> 1,000,000 positions are written.
  it("a Delete on a clicked column header whose used rows are mostly empty: only the cells that hold a value are written", async () => {
    const used: UsedRange = { startRow: 0, startCol: 0, endRow: 999_999, endCol: 3, empty: false };
    const holds: Holds = (_sheet, row, col) => (col === 2 && (row === 7 || row === 500_000 || row === 999_999) ? { value: row } : null);
    const { calls } = await runObjectScript(clearEvent(0, 2, LAST_ROW, 2, "contents"), () => used, holds);
    const reads = calls.filter((c) => c.method === "getRangeValues");
    expect(reads, "ten bands of 100,000 rows of one column").toHaveLength(10);
    expect(calls.filter((c) => c.method === "updateCellsBatch")).toHaveLength(1);
    expect(batchPositions(calls)).toEqual(["7:2", "500000:2", "999999:2"]);
  });

  it("a formula whose result is empty text is cleared; a formatted blank (nothing stored but a format) is not written", async () => {
    const used: UsedRange = { startRow: 0, startCol: 0, endRow: 199_999, endCol: 0, empty: false };
    const holds: Holds = (_sheet, row) => {
      if (row === 3) return { value: "", formula: '=IF(A1>0,"",1)' };
      if (row === 4) return { value: null }; // a formatted blank: stored, holds no value
      if (row === 150_000) return { value: "x" };
      return null;
    };
    const { calls } = await runObjectScript(clearEvent(0, 0, LAST_ROW, 0, "contents"), () => used, holds);
    expect(batchPositions(calls)).toEqual(["3:0", "150000:0"]);
  });

  it("a cut just over the scan cap is refused before anything is read or written", async () => {
    // 100,001 rows x 50 columns = 5,000,050 positions.
    const used: UsedRange = { startRow: 0, startCol: 0, endRow: 100_000, endCol: 49, empty: false };
    let reads = 0;
    const run = runObjectScript(clearEvent(0, 0, LAST_ROW, LAST_COL, "contents"), () => used, () => {
      reads++;
      // A guard, not an assertion: without the cap this would read 5,000,050.
      if (reads > 1_000_000) throw new Error("unbounded band reads");
      return { value: 1 };
    });
    await expect(run).rejects.toThrow("covers 5000050 cells");
    expect(reads).toBe(0);
  });

  // SABOTAGE: clear every band of the other sheet whatever it holds (drop the
  // `if (top >= 0)` test) -> an empty band is cleared too, and the tight boxes
  // below become whole bands.
  it("another sheet's Select All: only the bands that hold a value are cleared, each over the rows and columns that hold one", async () => {
    const used: UsedRange = { startRow: 0, startCol: 0, endRow: 59_999, endCol: 3, empty: false };
    const holds: Holds = (sheet, row, col) => {
      if (sheet !== 3) return null;
      if (row >= 10 && row <= 12 && col >= 1 && col <= 2) return { value: 1 };
      if (row === 55_000 && col === 3) return { value: "", formula: "=T(0)" };
      return null;
    };
    const { calls } = await runObjectScript(
      clearEvent(0, 0, LAST_ROW, LAST_COL, "contents", 3),
      (sheet) => (sheet === 3 ? used : EMPTY),
      holds,
    );
    expect(calls.filter((c) => c.method === "getRangeValues")).toHaveLength(3);
    expect(calls.filter((c) => c.method === "clearRange")).toEqual([
      { method: "clearRange", args: [10, 1, 12, 2, { applyTo: "contents" }, 3] },
      { method: "clearRange", args: [55_000, 3, 55_000, 3, { applyTo: "contents" }, 3] },
    ]);
  });

  it("every call the bounded replay makes on the action's own sheet is one the explicit-run cell access admits", async () => {
    const used: UsedRange = { startRow: 0, startCol: 0, endRow: 199_999, endCol: 1, empty: false };
    const { calls } = await runObjectScript(clearEvent(0, 0, LAST_ROW, LAST_COL, "contents"), () => used);
    expect(calls.map((c) => c.method)).toContain("getRangeValues");
    for (const c of calls) expect(explicitRunAdmits(GRANT, `api.${c.method}`), `api.${c.method}`).toBe(true);
  });
});

describe("notebook: a recorded Clear replays as a bounded loop", () => {
  function runNotebook(
    event: RecordedEvent,
    used: (sheet: number | null) => UsedRange,
    holds: Holds = denseHolds(used),
  ) {
    const { source, unsupported } = generate(event, "notebook");
    const writes: Array<[number, number, number | null]> = [];
    let active = 0;
    let scanned = 0;
    const Calcula = {
      getUsedRange: (sheet?: number) => JSON.stringify(used(sheet ?? null)),
      // As ops/cells.rs: a JSON text grid of display strings ("" = nothing, and
      // also a formula whose result is empty text).
      getRange: (r0: number, c0: number, r1: number, c1: number, sheet?: number) => {
        const rows: string[][] = [];
        for (let r = r0; r <= r1; r++) {
          const row: string[] = [];
          for (let c = c0; c <= c1; c++) {
            scanned++;
            if (scanned > 2_000_000) throw new Error("unbounded band reads");
            const held = holds(sheet ?? null, r, c);
            row.push(held === null || held.value === null ? "" : String(held.value));
          }
          rows.push(row);
        }
        return JSON.stringify(rows);
      },
      getCellFormula: (r: number, c: number, sheet?: number) => holds(sheet ?? null, r, c)?.formula ?? "",
      getActiveSheet: () => JSON.stringify({ index: active, name: `Sheet${active + 1}` }),
      setActiveSheet: (i: unknown) => {
        if (typeof i !== "number") throw new Error(`setActiveSheet: not a sheet: ${String(i)}`);
        active = i;
      },
      setCellValue: (r: number, c: number, v: unknown, sheet?: number) => {
        expect(v).toBe("");
        writes.push([r, c, sheet ?? null]);
        // A guard, not an assertion: the old per-position loop over a column
        // would otherwise run a million times before failing below.
        if (writes.length > 1000) throw new Error("unbounded per-position loop");
      },
    };
    // eslint-disable-next-line no-new-func
    new Function("Calcula", source)(Calcula);
    return { writes, unsupported, active };
  }

  // SABOTAGE: emit the plain per-position loop for every rectangle (drop the
  // used-range bound) -> the column clear throws "unbounded per-position loop".
  it("a Delete on a clicked column header writes only the column's stored rows", () => {
    const { writes } = runNotebook(clearEvent(0, 2, LAST_ROW, 2, "contents"), () => ({
      startRow: 2,
      startCol: 0,
      endRow: 4,
      endCol: 6,
      empty: false,
    }));
    expect(writes).toEqual([
      [2, 2, null],
      [3, 2, null],
      [4, 2, null],
    ]);
  });

  it("an empty sheet: nothing is written", () => {
    const { writes } = runNotebook(clearEvent(0, 0, LAST_ROW, LAST_COL, "contents"), () => EMPTY);
    expect(writes).toEqual([]);
  });

  it("another sheet's whole column: its own used range, written through the sheet argument, no switch", () => {
    const { writes, active } = runNotebook(clearEvent(0, 1, LAST_ROW, 1, "contents", 3), (sheet) =>
      sheet === 3 ? { startRow: 0, startCol: 1, endRow: 1, endCol: 1, empty: false } : EMPTY,
    );
    expect(writes).toEqual([
      [0, 1, 3],
      [1, 1, 3],
    ]);
    expect(active).toBe(0);
  });

  it("a small rectangle keeps the plain loop", () => {
    const { writes } = runNotebook(clearEvent(0, 0, 1, 1, "contents"), () => EMPTY);
    expect(writes).toEqual([
      [0, 0, null],
      [0, 1, null],
      [1, 0, null],
      [1, 1, null],
    ]);
  });

  // rev4A#2. SABOTAGE: drop the scan cap -> the band reads start over the
  // whole sheet and the fake throws "unbounded band reads".
  it("Select All, Delete on a sheet stretched by one far-away cell: refused with the reason, nothing read or written", () => {
    expect(() =>
      runNotebook(clearEvent(0, 0, LAST_ROW, LAST_COL, "contents"), () => SPARSE_FULL_SHEET, (_s, r, c) => sparseHolds(r, c)),
    ).toThrow(/was not replayed: inside it, the sheet's used range covers 17179869184 cells/);
  });

  // SABOTAGE: write "" to every position read (drop the skip) -> the guard in
  // setCellValue throws "unbounded per-position loop".
  it("a column whose used rows are mostly empty: only the cells that hold a value or a formula are written", () => {
    const used: UsedRange = { startRow: 0, startCol: 0, endRow: 299_999, endCol: 2, empty: false };
    const { writes } = runNotebook(clearEvent(0, 1, LAST_ROW, 1, "contents", 2), (sheet) => (sheet === 2 ? used : EMPTY), (sheet, r, c) => {
      if (sheet !== 2 || c !== 1) return null;
      if (r === 5) return { value: 42 };
      if (r === 250_000) return { value: "", formula: '=""' };
      return null;
    });
    expect(writes).toEqual([
      [5, 1, 2],
      [250_000, 1, 2],
    ]);
  });
});
