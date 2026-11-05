//! FILENAME: app/extensions/MacroRecorder/__tests__/clearRangeSheetReplay.test.ts
// PURPOSE: A clear that writes ANOTHER sheet is recorded with that sheet and
//          replays on it -- record and replay, end to end.
// CONTEXT: A grouped Delete / Clear Contents / Clear Formats / Clear All
//          reaches the OTHER grouped sheets through ONE `clearRangeOnSheets`
//          call (clearGestures.ts, review G#1 / G#9), which recorded NOTHING,
//          so a recorded grouped clear replayed on the active sheet only
//          (review G#5); before that, the gesture's per-sheet
//          `clearRangeWithOptions(..., sheetIndex)` calls recorded no sheet and
//          replayed as duplicate ACTIVE-sheet clears. `clearRangeOnSheets` now
//          records one `clearRange` per sheet it wrote per area, with the
//          sheet, and a script's off-sheet `clearRangeWithOptions(...,
//          sheetIndex)` records its sheet. The generator replays such a clear
//          on that sheet: `api.clearRange(..., { applyTo }, sheet)` for an
//          object script (sheet-addressable, so the active sheet never moves),
//          `Calcula.setCellValue(r, c, "", sheet)` for a notebook (the op's own
//          sheet argument; no switch). Driven through the REAL
//          bridge wrappers and the REAL recording session (only Tauri's
//          `invoke` and `listen` are doubled), then the generated source is RUN
//          against a recording fake of the script API, each call checked by the
//          broker's own validator.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/** The sheets the grouped door reports it wrote (every listed sheet but the active one). */
let groupWrote: number[] = [2];

const invokeMock = vi.fn(async (cmd: string, _args?: unknown): Promise<unknown> => {
  if (cmd === "get_active_sheet") return 0;
  if (cmd === "clear_range_with_options") return { count: 4, updatedCells: [] };
  if (cmd === "clear_range_on_sheets") return groupWrote;
  if (cmd === "clear_range") return 4;
  return null;
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => undefined),
  listen: vi.fn(async () => () => {}),
}));

import { clearRangeOnSheets, clearRangeWithOptions, type RecordedGridEvent } from "@api/lib";
import { vClearRange } from "@api/scriptHost/validators";
import { resetRecorderForTests, startRecording, stopRecording } from "../lib/actionRecorder";
import { macroRecorderBackend } from "../lib/macroRecorderBackend";
import { generateMacroSource } from "../lib/actionCodegen";
import type { RecordedAction } from "../lib/types";

macroRecorderBackend.set(async <T,>(command: string): Promise<T> =>
  (command === "bi_get_connections" ? [] : undefined) as unknown as T,
);

beforeEach(() => {
  resetRecorderForTests();
  invokeMock.mockClear();
  groupWrote = [2];
});
afterEach(() => {
  resetRecorderForTests();
});

/** Record a grouped clear on the active Sheet1 (index 0) and the grouped sheet 2. */
async function recordGroupedClear(applyTo: "formats" | "all" | "contents"): Promise<RecordedAction[]> {
  await startRecording("Clear check");
  // What clearGestures.ts writes for a grouped clear: ONE group call listing
  // the active sheet too (it gates every sheet and writes the others), then
  // the active sheet's own clear.
  // (Changed deliberately, NEW-clear-range-record: the contents case used the
  // bare `clearRange` bridge, which the recorder heard as "contents" -- but
  // `clear_range` removes formats too, so it records as "all" now; the
  // gesture's own Clear Contents goes through `clearRangeWithOptions`.)
  await clearRangeOnSheets([0, 2], 0, 0, 1, 1, { applyTo });
  await clearRangeWithOptions(0, 0, 1, 1, applyTo);
  return stopRecording();
}

type Call = { method: string; args: unknown[] };

/** Run the generated object-script macro against a recording fake `api`. */
async function replayObjectScript(actions: RecordedAction[]): Promise<Call[]> {
  const calls: Call[] = [];
  const api = new Proxy({} as Record<string, unknown>, {
    get: (_t, method: string) => async (...args: unknown[]) => {
      calls.push({ method, args });
      return { count: 0 };
    },
  });
  const { source, unsupported } = generateMacroSource(actions, {
    target: "objectScript",
    wrapper: "objectScript",
    header: false,
    undoBatch: false,
    emitInitialSheetActivate: false,
    recordedAt: "T",
    name: "Clear check",
  });
  expect(unsupported).toEqual([]);
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${source}\nreturn clearCheck;`) as () => (api: unknown) => Promise<void>;
  await factory()(api);
  return calls;
}

describe("a clear that writes another sheet: recorded with it", () => {
  // SABOTAGE: drop the recordGridEvent loop from clearRangeOnSheets
  // (core/lib/tauri-api.ts) -> the grouped sheet's clear is not recorded at
  // all and the replay clears the active sheet only.
  it("the grouped sheet's clear carries its sheet; the active sheet's carries none; both actions were on the active sheet", async () => {
    const actions = await recordGroupedClear("formats");
    expect(actions.map((a) => a.sheetIndex)).toEqual([0, 0]);
    const events = actions.map((a) => a.event as RecordedGridEvent);
    expect(events[0]).toEqual({
      kind: "clearRange",
      startRow: 0,
      startCol: 0,
      endRow: 1,
      endCol: 1,
      applyTo: "formats",
      sheetIndex: 2,
    });
    expect(events[1]).toEqual({ kind: "clearRange", startRow: 0, startCol: 0, endRow: 1, endCol: 1, applyTo: "formats" });
  });

  it("every area on every sheet the group door wrote, each with its sheet -- never the active sheet again", async () => {
    groupWrote = [2, 3];
    await startRecording("Areas");
    await clearRangeOnSheets([0, 2, 3], 0, 0, 1, 1, {
      applyTo: "contents",
      moreAreas: [{ startRow: 5, startCol: 5, endRow: 5, endCol: 6 }],
    });
    const events = stopRecording().map((a) => a.event as RecordedGridEvent);
    expect(events).toEqual([
      { kind: "clearRange", startRow: 0, startCol: 0, endRow: 1, endCol: 1, applyTo: "contents", sheetIndex: 2 },
      { kind: "clearRange", startRow: 5, startCol: 5, endRow: 5, endCol: 6, applyTo: "contents", sheetIndex: 2 },
      { kind: "clearRange", startRow: 0, startCol: 0, endRow: 1, endCol: 1, applyTo: "contents", sheetIndex: 3 },
      { kind: "clearRange", startRow: 5, startCol: 5, endRow: 5, endCol: 6, applyTo: "contents", sheetIndex: 3 },
    ]);
  });

  it("a refused group clear records nothing", async () => {
    await startRecording("Refused");
    invokeMock.mockImplementationOnce(async () => {
      throw "The cell is on a protected sheet.";
    });
    await expect(clearRangeOnSheets([0, 2], 0, 0, 1, 1, { applyTo: "all" })).rejects.toBe(
      "The cell is on a protected sheet.",
    );
    expect(stopRecording()).toEqual([]);
  });

  // SABOTAGE: drop the `sheetIndex` from the recorded clearRange event in
  // clearRangeWithOptions -> a script's off-sheet clear replays on the active sheet.
  it("a script's off-sheet clearRangeWithOptions carries the sheet it named", async () => {
    await startRecording("Script");
    await clearRangeWithOptions(0, 0, 1, 1, "formats", 2);
    const events = stopRecording().map((a) => a.event as RecordedGridEvent);
    expect(events).toEqual([
      { kind: "clearRange", startRow: 0, startCol: 0, endRow: 1, endCol: 1, applyTo: "formats", sheetIndex: 2 },
    ]);
  });

  it("an object's cells ({ target }) are still never recorded", async () => {
    await startRecording("Target");
    await clearRangeWithOptions(0, 0, 0, 0, "contents", undefined, { target: { kind: "floatingRange", id: "fr-1" } });
    expect(stopRecording()).toEqual([]);
  });
});

describe("...and replayed on THAT sheet", () => {
  // SABOTAGE: make emitClearRange ignore `ev.sheetIndex` (its `otherSheet`
  // call, MacroRecorder/lib/actionCodegen.ts) -> the first clear replays as
  // clearRangeFormat on the ACTIVE sheet.
  it("grouped Clear Formats: the grouped sheet through the sheet-addressed clear, then the active sheet as before", async () => {
    const calls = await replayObjectScript(await recordGroupedClear("formats"));
    expect(calls).toEqual([
      { method: "clearRange", args: [0, 0, 1, 1, { applyTo: "formats" }, 2] },
      { method: "clearRangeFormat", args: [0, 0, 1, 1] },
    ]);
    expect(calls.some((c) => c.method === "setActiveSheet"), "the active sheet never moves").toBe(false);
    expect(vClearRange(calls[0].args)).toBe(true);
  });

  it("grouped Clear All: ONE sheet-addressed clear of contents and formats on the grouped sheet", async () => {
    const calls = await replayObjectScript(await recordGroupedClear("all"));
    const onSheet2 = calls.filter((c) => c.args[c.args.length - 1] === 2);
    expect(onSheet2).toEqual([{ method: "clearRange", args: [0, 0, 1, 1, { applyTo: "all" }, 2] }]);
    // The active sheet's half replays as before: contents, then formats.
    expect(calls.map((c) => c.method)).toEqual(["clearRange", "updateCellsBatch", "clearRangeFormat"]);
    expect(vClearRange(onSheet2[0].args)).toBe(true);
  });

  // review G#5: a grouped Delete / Clear Contents recorded nothing for the
  // other grouped sheets, so it replayed on the active sheet only.
  it("grouped Clear Contents: the grouped sheet's contents through the sheet-addressed clear, then the active sheet's", async () => {
    const calls = await replayObjectScript(await recordGroupedClear("contents"));
    expect(calls[0]).toEqual({ method: "clearRange", args: [0, 0, 1, 1, { applyTo: "contents" }, 2] });
    expect(calls.map((c) => c.method)).toEqual(["clearRange", "updateCellsBatch"]);
    expect(vClearRange(calls[0].args)).toBe(true);
  });

  it("a sheet named that IS the action's sheet replays as an ordinary clear", async () => {
    const calls = await replayObjectScript([
      {
        seq: 1,
        sheetIndex: 3,
        event: { kind: "clearRange", startRow: 2, startCol: 2, endRow: 2, endCol: 2, applyTo: "formats", sheetIndex: 3 },
      },
    ]);
    expect(calls).toEqual([{ method: "clearRangeFormat", args: [2, 2, 2, 2] }]);
  });

  // CHANGED DELIBERATELY (recorder lane, round 4): this replayed by switching
  // to the named sheet and back through `Calcula.getActiveSheet().index`, and
  // its fake returned an OBJECT -- but the real op returns a JSON STRING
  // (core/script-engine/src/ops/sheets.rs), so `.index` was undefined and the
  // switch back threw. The fake below answers as the real ops do, and the
  // replay writes the named sheet through `setCellValue`'s own sheet argument
  // (core/script-engine/src/ops/cells.rs), never moving the active sheet.
  it("a notebook replays the contents clear on the named sheet without ever switching sheets", () => {
    const actions: RecordedAction[] = [
      { seq: 1, sheetIndex: 0, event: { kind: "clearRange", startRow: 0, startCol: 0, endRow: 0, endCol: 1, applyTo: "all", sheetIndex: 2 } },
    ];
    const { source, unsupported } = generateMacroSource(actions, {
      target: "notebook",
      header: false,
      emitInitialSheetActivate: false,
      recordedAt: "T",
    });
    expect(unsupported, "formats have no notebook op").toHaveLength(1);
    expect(unsupported[0]).toContain("on sheet 2");
    let active = 5;
    const writes: Array<[number, number, number]> = [];
    const Calcula = {
      // As the real op: JSON text.
      getActiveSheet: () => JSON.stringify({ index: active, name: `Sheet${active + 1}` }),
      setActiveSheet: (i: unknown) => {
        if (typeof i !== "number") throw new Error(`setActiveSheet: not a sheet: ${String(i)}`);
        active = i;
      },
      setCellValue: (r: number, c: number, _v: unknown, sheet?: number) => {
        writes.push([sheet ?? active, r, c]);
      },
    };
    // eslint-disable-next-line no-new-func
    new Function("Calcula", source)(Calcula);
    expect(writes).toEqual([
      [2, 0, 0],
      [2, 0, 1],
    ]);
    expect(active, "the active sheet never moved").toBe(5);
  });
});
