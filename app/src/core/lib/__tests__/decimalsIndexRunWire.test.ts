//! FILENAME: app/src/core/lib/__tests__/decimalsIndexRunWire.test.ts
// PURPOSE: BUG-0354 follow-up at the bridge -- what `adjustNumberFormatDecimals`
//          (Home > Increase / Decrease Decimal) sends for Select All, a whole
//          column and an ordinary selection.
// CONTEXT: The backend was bounded, but the wrapper still sent Select All's
//          1,048,576 row indices and 16,384 columns as JSON arrays. And
//          `encodeIndexList` alone cannot shorten them: the Home tab puts the
//          ACTIVE cell's line FIRST (`activeCellFirst`), and Ctrl+A leaves the
//          active cell on the LAST row, so the list is `[1048575, 0, 1, ...]`
//          -- not ascending. `encodeActiveFirstIndexList` sends such a list as
//          the run it covers plus the active line on its own (`activeRow` /
//          `activeCol`), which the Rust command reads before `rows[0]`
//          (`the_decimal_step_takes_a_run_and_decides_from_the_named_active_cell`
//          pins that side). Only Tauri's `invoke` is doubled.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const calls: Array<{ cmd: string; args: Record<string, unknown> | undefined }> = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === "adjust_number_format_decimals") {
      return Promise.resolve({
        cells: [],
        styles: [{ index: 3, style: { numberFormat: "Number (2 decimals)" } }],
      });
    }
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(),
  listen: vi.fn(async () => () => {}),
}));

import {
  INDEX_RUN_MIN_LENGTH,
  adjustNumberFormatDecimals,
  encodeActiveFirstIndexList,
  setGridRecorderHook,
  type RecordedGridEvent,
} from "../tauri-api";
import { clearSheetGrouping } from "../../state/sheetGrouping";

const LAST_ROW = 1_048_575;
const LAST_COL = 16_383;

function span(first: number, last: number): number[] {
  const out: number[] = [];
  for (let i = first; i <= last; i++) out.push(i);
  return out;
}

/** The Home tab's `activeCellFirst`: the active line, then every other line ascending. */
function activeFirst(active: number, first: number, last: number): number[] {
  return [active, ...span(first, last).filter((i) => i !== active)];
}

const recorded: RecordedGridEvent[] = [];

beforeEach(() => {
  calls.length = 0;
  recorded.length = 0;
  clearSheetGrouping();
  setGridRecorderHook((event) => recorded.push(event));
});

afterEach(() => {
  setGridRecorderHook(null);
  clearSheetGrouping();
});

describe("encodeActiveFirstIndexList", () => {
  it("the active line LAST (Ctrl+A) or inside the run: the run, with the active line as lead", () => {
    expect(encodeActiveFirstIndexList(activeFirst(LAST_ROW, 0, LAST_ROW))).toEqual({
      wire: { first: 0, last: LAST_ROW },
      lead: LAST_ROW,
    });
    expect(encodeActiveFirstIndexList(activeFirst(50, 0, 199))).toEqual({ wire: { first: 0, last: 199 }, lead: 50 });
  });

  it("an ascending run is already led by the active line: the run, no lead", () => {
    expect(encodeActiveFirstIndexList(span(0, LAST_ROW))).toEqual({ wire: { first: 0, last: LAST_ROW } });
  });

  it("keeps every other list as it is", () => {
    const short = activeFirst(3, 0, INDEX_RUN_MIN_LENGTH - 2);
    expect(encodeActiveFirstIndexList(short).wire).toBe(short);
    const gap = [50, ...span(0, 49), ...span(52, 199)];
    expect(encodeActiveFirstIndexList(gap)).toEqual({ wire: gap });
    const outside = [500, ...span(0, 199)];
    expect(encodeActiveFirstIndexList(outside)).toEqual({ wire: outside });
    const repeated = [50, ...span(0, 199)];
    expect(encodeActiveFirstIndexList(repeated)).toEqual({ wire: repeated });
    const unordered = [50, ...span(0, 49), 52, 51, ...span(53, 199)];
    expect(encodeActiveFirstIndexList(unordered)).toEqual({ wire: unordered });
  });
});

describe("adjustNumberFormatDecimals sends whole lines as runs", () => {
  // SABOTAGE: send `rows` / `cols` as given in adjustNumberFormatDecimals
  // (tauri-api.ts) -> the million-element arrays cross the bridge again.
  it("Ctrl+A (the active cell on the last row and column) crosses the bridge as two runs and the active cell", async () => {
    const rows = activeFirst(LAST_ROW, 0, LAST_ROW);
    const cols = activeFirst(LAST_COL, 0, LAST_COL);
    await adjustNumberFormatDecimals(rows, cols, 1);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("adjust_number_format_decimals");
    expect(calls[0].args).toEqual({
      rows: { first: 0, last: LAST_ROW },
      cols: { first: 0, last: LAST_COL },
      delta: 1,
      activeRow: LAST_ROW,
      activeCol: LAST_COL,
    });
    // The million indices never left the page.
    expect(JSON.stringify(calls[0].args).length).toBeLessThan(500);
    // The macro recorder still hears the caller's lists.
    expect(recorded).toEqual([{ kind: "formatting", rows, cols, formatting: { numberFormat: "Number (2 decimals)" } }]);
  });

  it("a whole column from its first row: a row run (already led by the active row), the one column as a list", async () => {
    await adjustNumberFormatDecimals(span(0, LAST_ROW), [4], -1);
    expect(calls[0].args).toEqual({ rows: { first: 0, last: LAST_ROW }, cols: [4], delta: -1 });
  });

  it("an ordinary selection keeps its plain lists, active cell first, and names no active line", async () => {
    await adjustNumberFormatDecimals([4, 3, 5], [2], 1);
    expect(calls[0].args).toEqual({ rows: [4, 3, 5], cols: [2], delta: 1 });
  });
});
