//! FILENAME: app/extensions/MacroRecorder/__tests__/groupedFormatSheetReplay.test.ts
// PURPOSE: A format that reached MORE than the active sheet -- a grouped
//          gesture's group, a script's off-sheet format -- and a merge
//          addressed to ANOTHER sheet are recorded with their sheets and replay
//          on them. Record and replay, end to end.
// CONTEXT: Round 2's follow-up FU1 (item NEW-recorder-drops-sheet-group, parts 2
//          and 3). `applyFormatting`, `applyBorderPreset` and
//          `adjustNumberFormatDecimals` send the group as `sheetIndices` to ONE
//          command, but recorded one event with no group, and the recorder
//          stamps every action with the ACTIVE sheet: a recorded grouped Bold
//          replayed on the active sheet alone. `applyFormattingToSheets` (a
//          script's off-sheet `setRangeFormat`) recorded nothing at all.
//          `mergeCells` / `unmergeCells` with a `sheetIndex` (a script's
//          off-sheet merge) recorded the regions with no sheet, so they replayed
//          on the active sheet. The events now carry their sheets and the
//          generator replays through the script API's sheet-addressable calls
//          (`api.setRangeFormat(..., sheet)`, `api.mergeCells(..., sheet)`,
//          `api.unmergeCells(..., sheet)`), the shape round 2 gave the
//          `clearRange` arm (clearRangeSheetReplay.test.ts). Driven through the
//          REAL bridge wrappers and the REAL recording session (only Tauri's
//          `invoke` and `listen` are doubled), then the generated source is RUN
//          against a recording fake of the script API, each call checked by the
//          broker's own allowlist validator.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const MERGED = { startRow: 0, startCol: 0, endRow: 1, endCol: 1 };

const invokeMock = vi.fn(async (cmd: string, _args?: unknown): Promise<unknown> => {
  if (cmd === "get_active_sheet") return 0;
  if (cmd === "apply_formatting" || cmd === "apply_border_preset") return { cells: [], styles: [] };
  if (cmd === "adjust_number_format_decimals") {
    return { cells: [], styles: [{ index: 7, style: { numberFormat: "0.00" } }] };
  }
  if (cmd === "apply_formatting_to_sheets") return null;
  if (cmd === "merge_cells") {
    return { success: true, mergedRegions: [MERGED], updatedCells: [], createdRegions: [MERGED], removedRegions: [] };
  }
  if (cmd === "unmerge_cells") {
    return { success: true, mergedRegions: [], updatedCells: [], createdRegions: [], removedRegions: [MERGED] };
  }
  return null;
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => undefined),
  listen: vi.fn(async () => () => {}),
}));
// The sheet ON SCREEN is Sheet1 (index 0), a member of every group set below:
// the formatting wrappers send a group only when the sheet on screen belongs to
// it (review G#4, `groupArgs` in core/lib/tauri-api.ts).
vi.mock("../../../src/core/state/GridContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/state/GridContext")>()),
  getGridStateSnapshot: () => ({ sheetContext: { activeSheetIndex: 0 } }),
}));

import {
  adjustNumberFormatDecimals,
  applyBorderPreset,
  applyFormatting,
  applyFormattingToSheets,
  mergeCells,
  unmergeCells,
  type RecordedGridEvent,
} from "@api/lib";
import { clearSheetGrouping, setSelectedSheetIndices } from "@api";
import { ALLOWLIST } from "@api/scriptHost/allowlist";
import { resetRecorderForTests, startRecording, stopRecording } from "../lib/actionRecorder";
import { macroRecorderBackend } from "../lib/macroRecorderBackend";
import { generateMacroSource } from "../lib/actionCodegen";
import type { RecordedAction } from "../lib/types";

macroRecorderBackend.set(async <T,>(command: string): Promise<T> =>
  (command === "bi_get_connections" ? [] : undefined) as unknown as T,
);

beforeEach(() => {
  resetRecorderForTests();
  clearSheetGrouping();
  invokeMock.mockClear();
});
afterEach(() => {
  resetRecorderForTests();
  clearSheetGrouping();
});

/** Record whatever `gesture` does, on the active Sheet1 (index 0). */
async function record(gesture: () => Promise<unknown>): Promise<RecordedAction[]> {
  await startRecording("Format check");
  await gesture();
  return stopRecording();
}

type Call = { method: string; args: unknown[] };

/** Run the generated object-script macro against a recording fake `api`. */
async function replayObjectScript(actions: RecordedAction[]): Promise<{ calls: Call[]; unsupported: string[] }> {
  const calls: Call[] = [];
  const api = new Proxy({} as Record<string, unknown>, {
    get: (_t, method: string) => async (...args: unknown[]) => {
      calls.push({ method, args });
      return undefined;
    },
  });
  const { source, unsupported } = generateMacroSource(actions, {
    target: "objectScript",
    wrapper: "objectScript",
    header: false,
    undoBatch: false,
    emitInitialSheetActivate: false,
    recordedAt: "T",
    name: "Format check",
  });
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${source}\nreturn formatCheck;`) as () => (api: unknown) => Promise<void>;
  await factory()(api);
  return { calls, unsupported };
}

/** Every replayed call passes the broker's own validator for its method. */
function expectValid(calls: Call[]): void {
  for (const c of calls) {
    const policy = ALLOWLIST[`api.${c.method}`];
    expect(policy, `api.${c.method} is not on the allowlist`).toBeDefined();
    expect(policy.validate(c.args), `api.${c.method}(${JSON.stringify(c.args)}) fails its validator`).toBe(true);
  }
}

describe("a grouped format: recorded with the group, replayed on every grouped sheet", () => {
  // SABOTAGE: drop `...recordedSheets(placement.sheetIndices)` from
  // applyFormatting's recorded event (core/lib/tauri-api.ts) -> no group on
  // the event, and the replay formats the active sheet alone.
  it("Bold on Sheet1 + Sheet3: ONE event naming the group; the replay formats both, never switching sheets", async () => {
    setSelectedSheetIndices([0, 2]);
    const actions = await record(() => applyFormatting([0, 1], [0, 1], { bold: true }));
    expect(actions.map((a) => a.sheetIndex)).toEqual([0]);
    expect(actions[0].event as RecordedGridEvent).toEqual({
      kind: "formatting",
      rows: [0, 1],
      cols: [0, 1],
      formatting: { bold: true },
      sheetIndices: [0, 2],
    });
    // SABOTAGE: make formattedSheets answer [null] (MacroRecorder/lib/actionCodegen.ts)
    // -> the sheet-addressed call is missing.
    const { calls, unsupported } = await replayObjectScript(actions);
    expect(unsupported).toEqual([]);
    expect(calls).toEqual([
      { method: "setRangeFormat", args: [0, 0, 1, 1, { bold: true }] },
      { method: "setRangeFormat", args: [0, 0, 1, 1, { bold: true }, 2] },
    ]);
    expect(calls.some((c) => c.method === "setActiveSheet"), "the active sheet never moves").toBe(false);
    expectValid(calls);
  });

  it("Increase Decimal on the group: the resulting number format, on every grouped sheet", async () => {
    setSelectedSheetIndices([0, 1, 3]);
    const actions = await record(() => adjustNumberFormatDecimals([0], [0], 1));
    expect((actions[0].event as RecordedGridEvent & { kind: "formatting" }).sheetIndices).toEqual([0, 1, 3]);
    const { calls } = await replayObjectScript(actions);
    expect(calls).toEqual([
      { method: "setRangeFormat", args: [0, 0, 0, 0, { numberFormat: "0.00" }] },
      { method: "setRangeFormat", args: [0, 0, 0, 0, { numberFormat: "0.00" }, 1] },
      { method: "setRangeFormat", args: [0, 0, 0, 0, { numberFormat: "0.00" }, 3] },
    ]);
    expectValid(calls);
  });

  it("a grouped border preset (not replayable on any sheet) names every sheet it reached in the note", async () => {
    setSelectedSheetIndices([0, 2]);
    const actions = await record(() => applyBorderPreset(0, 0, 1, 1, "outside", "solid", "#000000", 1));
    expect((actions[0].event as RecordedGridEvent & { kind: "borderPreset" }).sheetIndices).toEqual([0, 2]);
    const { calls, unsupported } = await replayObjectScript(actions);
    expect(calls).toEqual([]);
    expect(unsupported).toHaveLength(1);
    expect(unsupported[0]).toContain("on sheets 0, 2");
  });

  it("control: no group -- the event carries no sheets and replays as one ordinary call, as before", async () => {
    const actions = await record(() => applyFormatting([4], [2], { italic: true }));
    expect(actions[0].event).toEqual({ kind: "formatting", rows: [4], cols: [2], formatting: { italic: true } });
    const { calls } = await replayObjectScript(actions);
    expect(calls).toEqual([{ method: "setRangeFormat", args: [4, 2, 4, 2, { italic: true }] }]);
  });

  it("a notebook cannot format, and says which sheets it would have", () => {
    const actions: RecordedAction[] = [
      { seq: 1, sheetIndex: 0, event: { kind: "formatting", rows: [0], cols: [0], formatting: { bold: true }, sheetIndices: [0, 2] } },
    ];
    const { unsupported } = generateMacroSource(actions, {
      target: "notebook",
      header: false,
      emitInitialSheetActivate: false,
      recordedAt: "T",
    });
    expect(unsupported).toHaveLength(1);
    expect(unsupported[0]).toContain("on sheets 0, 2");
  });
});

describe("a script's off-sheet format: recorded, replayed on THAT sheet only", () => {
  // SABOTAGE: drop the recordGridEvent from applyFormattingToSheets -> nothing
  // is recorded and the macro omits the format.
  it("applyFormattingToSheets([2]): one event naming sheet 2; the replay never formats the active sheet", async () => {
    const actions = await record(() => applyFormattingToSheets([2], [0], [0, 1], { textColor: "#ff0000" }));
    expect(actions.map((a) => a.event)).toEqual([
      { kind: "formatting", rows: [0], cols: [0, 1], formatting: { textColor: "#ff0000" }, sheetIndices: [2] },
    ]);
    const { calls } = await replayObjectScript(actions);
    expect(calls).toEqual([{ method: "setRangeFormat", args: [0, 0, 0, 1, { textColor: "#ff0000" }, 2] }]);
    expectValid(calls);
  });
});

describe("a merge addressed to another sheet: recorded with it, replayed there", () => {
  // SABOTAGE: drop `...onSheet` from recordMergeResult's mergeCells event
  // (core/lib/tauri-api.ts) -> the region replays on the active sheet.
  it("mergeCells(..., sheet 2): the region carries its sheet, and replays through the sheet-addressed merge", async () => {
    const actions = await record(() => mergeCells(0, 0, 1, 1, 2));
    expect(actions.map((a) => a.event)).toEqual([{ kind: "mergeCells", ...MERGED, sheetIndex: 2 }]);
    // SABOTAGE: make otherSheet answer null (actionCodegen.ts) -> the replayed
    // merge has no sheet argument.
    const { calls } = await replayObjectScript(actions);
    expect(calls).toEqual([{ method: "mergeCells", args: [0, 0, 1, 1, 2] }]);
    expectValid(calls);
  });

  it("unmergeCells(..., sheet 2): the same, through the sheet-addressed unmerge", async () => {
    const actions = await record(() => unmergeCells(0, 0, 2));
    expect(actions.map((a) => a.event)).toEqual([{ kind: "unmergeCells", row: 0, col: 0, sheetIndex: 2 }]);
    const { calls } = await replayObjectScript(actions);
    expect(calls).toEqual([{ method: "unmergeCells", args: [0, 0, 2] }]);
    expectValid(calls);
  });

  it("control: an on-sheet merge carries no sheet and replays as before", async () => {
    const actions = await record(() => mergeCells(0, 0, 1, 1));
    expect(actions.map((a) => a.event)).toEqual([{ kind: "mergeCells", ...MERGED }]);
    const { calls } = await replayObjectScript(actions);
    expect(calls).toEqual([{ method: "mergeCells", args: [0, 0, 1, 1] }]);
  });

  it("a sheet named that IS the action's sheet replays as an ordinary merge", async () => {
    const { calls } = await replayObjectScript([
      { seq: 1, sheetIndex: 3, event: { kind: "mergeCells", ...MERGED, sheetIndex: 3 } },
    ]);
    expect(calls).toEqual([{ method: "mergeCells", args: [0, 0, 1, 1] }]);
  });
});
