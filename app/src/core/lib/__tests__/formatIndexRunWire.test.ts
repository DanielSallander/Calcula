//! FILENAME: app/src/core/lib/__tests__/formatIndexRunWire.test.ts
// PURPOSE: BUG-0354 at the bridge -- what `applyFormatting` and
//          `applyFormattingToSheets` send for a whole column, a whole row and
//          Select All.
// CONTEXT: Select All built all 1,048,576 row indices and sent them as one
//          JSON array (about 7 MB per call, a million values for the backend
//          to parse) for what is two numbers; a whole column's Left Border --
//          the Borders split's edge presets go through applyFormatting -- sent
//          the same million. `encodeIndexList` now sends a long ascending run
//          as `{ first, last }` (`IndexRun`, mirrored by api_types.rs, which
//          expands it back: `formatting_params_take_a_run_or_a_list` pins that
//          side). Everything else -- a short list, a list with a gap, a list
//          with the active cell first -- keeps the plain shape. The macro
//          recorder still hears the caller's lists. Only Tauri's `invoke` is
//          doubled; the module under test is real.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const calls: Array<{ cmd: string; args: Record<string, unknown> | undefined }> = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === "apply_formatting") return Promise.resolve({ cells: [], styles: [] });
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(),
  listen: vi.fn(async () => () => {}),
}));

import {
  INDEX_RUN_MIN_LENGTH,
  applyFormatting,
  applyFormattingToSheets,
  encodeIndexList,
  setGridRecorderHook,
  type RecordedGridEvent,
} from "../tauri-api";
import { clearSheetGrouping } from "../../state/sheetGrouping";

const EVERY_ROW = 1_048_576;
const EVERY_COL = 16_384;

function span(first: number, last: number): number[] {
  const out: number[] = [];
  for (let i = first; i <= last; i++) out.push(i);
  return out;
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

function sentParams(): Record<string, unknown> {
  expect(calls).toHaveLength(1);
  return calls[0].args?.params as Record<string, unknown>;
}

describe("encodeIndexList", () => {
  it("sends a long ascending contiguous run as { first, last }", () => {
    expect(encodeIndexList(span(0, EVERY_ROW - 1))).toEqual({ first: 0, last: EVERY_ROW - 1 });
    expect(encodeIndexList(span(5, 5 + INDEX_RUN_MIN_LENGTH - 1))).toEqual({
      first: 5,
      last: 5 + INDEX_RUN_MIN_LENGTH - 1,
    });
  });

  it("keeps every other list as it is", () => {
    const short = span(0, INDEX_RUN_MIN_LENGTH - 2);
    expect(encodeIndexList(short)).toBe(short);
    expect(encodeIndexList([])).toEqual([]);
    const gap = [...span(0, 99), 101];
    expect(encodeIndexList(gap)).toBe(gap);
    // The decimal step and the Home tab put the ACTIVE cell first: not ascending.
    const activeFirst = [50, ...span(0, 49), ...span(51, 199)];
    expect(encodeIndexList(activeFirst)).toBe(activeFirst);
    const repeated = [...span(0, 99), 99];
    expect(encodeIndexList(repeated)).toBe(repeated);
  });
});

describe("applyFormatting sends whole lines as runs, not million-element arrays", () => {
  it("Select All + Bold crosses the bridge as two runs", async () => {
    const rows = span(0, EVERY_ROW - 1);
    const cols = span(0, EVERY_COL - 1);
    await applyFormatting(rows, cols, { bold: true });
    const params = sentParams();
    expect(calls[0].cmd).toBe("apply_formatting");
    expect(params.rows).toEqual({ first: 0, last: EVERY_ROW - 1 });
    expect(params.cols).toEqual({ first: 0, last: EVERY_COL - 1 });
    expect(params.bold).toBe(true);
    // The whole payload is small: the million indices never left the page.
    expect(JSON.stringify(calls[0].args).length).toBeLessThan(2_000);
  });

  it("Left Border on a whole column sends a row run and the one column; one cell stays plain", async () => {
    await applyFormatting(span(0, EVERY_ROW - 1), [2], { borderLeft: { style: "thin", color: "#000000" } });
    const params = sentParams();
    expect(params.rows).toEqual({ first: 0, last: EVERY_ROW - 1 });
    expect(params.cols).toEqual([2]);
    expect(params.borderLeft).toEqual({ style: "thin", color: "#000000" });

    calls.length = 0;
    await applyFormatting([3], [4], { italic: true });
    const one = sentParams();
    expect(one.rows).toEqual([3]);
    expect(one.cols).toEqual([4]);
  });

  it("the macro recorder still hears the caller's lists", async () => {
    const rows = span(0, 199);
    await applyFormatting(rows, [0], { bold: true });
    expect(sentParams().rows).toEqual({ first: 0, last: 199 });
    expect(recorded).toEqual([{ kind: "formatting", rows, cols: [0], formatting: { bold: true } }]);
  });
});

describe("applyFormattingToSheets uses the same wire shape", () => {
  it("sends a whole row as a column run", async () => {
    await applyFormattingToSheets([1], [4], span(0, EVERY_COL - 1), { bold: true });
    expect(calls[0].cmd).toBe("apply_formatting_to_sheets");
    const params = sentParams();
    expect(params.rows).toEqual([4]);
    expect(params.cols).toEqual({ first: 0, last: EVERY_COL - 1 });
    expect(calls[0].args?.sheetIndices).toEqual([1]);
  });
});
