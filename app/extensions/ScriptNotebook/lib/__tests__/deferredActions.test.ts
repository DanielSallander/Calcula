//! FILENAME: app/extensions/ScriptNotebook/lib/__tests__/deferredActions.test.ts
// PURPOSE: Tests for the deferred-action wire normalization + host dispatch map.
// CONTEXT: The Rust engine queues 17 DeferredAction variants; these lock down
//          that each one reaches a host call, in queue order, with validated
//          payloads — and that the struct-variant FIELDS arrive camelCased
//          (the Rust enum carries a per-variant rename_all; a regression to
//          snake_case must fail here rather than silently drop the payload).

import { describe, it, expect, vi } from "vitest";

vi.mock("@api/backend", () => ({ invokeBackend: vi.fn() }));

import { normalizeDeferredActions } from "@api/workbookScripts";
import type { DeferredAction } from "@api/workbookScripts";
import { applyDeferredActions } from "../deferredActions";
import type { DeferredActionHost } from "../deferredActions";

// ============================================================================
// Recording host
// ============================================================================

type Call = [string, ...unknown[]];

interface RecordingHost extends DeferredActionHost {
  calls: Call[];
}

function createHost(activeSheetIndex = 0): RecordingHost {
  const calls: Call[] = [];
  const record = (name: string, ...args: unknown[]): void => {
    calls.push([name, ...args]);
  };
  return {
    calls,
    getActiveSheetIndex: () => activeSheetIndex,
    activateSheet: async (sheetIndex) => record("activateSheet", sheetIndex),
    gotoCell: (row, col, select, endRow, endCol) =>
      record("gotoCell", row, col, select, endRow, endCol),
    recalculate: async () => record("recalculate"),
    setStatusBar: (message) => record("setStatusBar", message),
    setViewMode: (mode) => record("setViewMode", mode),
    setZoomPercent: (percent) => record("setZoomPercent", percent),
    setReferenceStyle: async (style) => record("setReferenceStyle", style),
    setDisplayZeros: (value) => record("setDisplayZeros", value),
    setDisplayGridlines: (value) => record("setDisplayGridlines", value),
    setDisplayHeadings: (value) => record("setDisplayHeadings", value),
    setDisplayFormulas: (value) => record("setDisplayFormulas", value),
    fillDown: async (sr, sc, er, ec) => record("fillDown", sr, sc, er, ec),
    fillRight: async (sr, sc, er, ec) => record("fillRight", sr, sc, er, ec),
    applyNamedStyle: async (name, row, col, endRow, endCol) =>
      endRow !== undefined
        ? record("applyNamedStyle", name, row, col, endRow, endCol)
        : record("applyNamedStyle", name, row, col),
    setScrollArea: async (area) => record("setScrollArea", area),
    setIterationSettings: async (enabled, maxIterations, maxChange) =>
      record("setIterationSettings", enabled, maxIterations, maxChange),
    setSheetVisibility: async (sheetIndex, visibility) =>
      record("setSheetVisibility", sheetIndex, visibility),
  };
}

/** Normalize + apply in one step, the way the extension's listener does. */
async function run(raw: unknown, host: RecordingHost): Promise<Call[]> {
  await applyDeferredActions(normalizeDeferredActions(raw), host);
  return host.calls;
}

// ============================================================================
// Normalization
// ============================================================================

describe("normalizeDeferredActions", () => {
  it("decodes the camelCase struct-variant fields the Rust enum emits", () => {
    const actions = normalizeDeferredActions([
      { action: "goto", row: 3, col: 4, sheetIndex: 2, select: false },
      { action: "activateSheet", sheetIndex: 1 },
      { action: "fillDown", startRow: 1, startCol: 2, endRow: 5, endCol: 6 },
      { action: "fillRight", startRow: 0, startCol: 0, endRow: 1, endCol: 9 },
      { action: "setIterationSettings", enabled: true, maxIterations: 50, maxChange: 0.01 },
      { action: "setSheetVisibility", sheetIndex: 3, visibility: "veryHidden" },
    ]);

    expect(actions).toEqual([
      { action: "goto", row: 3, col: 4, endRow: null, endCol: null, sheetIndex: 2, select: false },
      { action: "activateSheet", sheetIndex: 1 },
      { action: "fillDown", startRow: 1, startCol: 2, endRow: 5, endCol: 6 },
      { action: "fillRight", startRow: 0, startCol: 0, endRow: 1, endCol: 9 },
      { action: "setIterationSettings", enabled: true, maxIterations: 50, maxChange: 0.01 },
      { action: "setSheetVisibility", sheetIndex: 3, visibility: "veryHidden" },
    ]);
  });

  it("does NOT accept snake_case fields — the wire contract is camelCase", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // If a per-variant rename_all is ever dropped from the Rust enum, these are
    // the payloads that would arrive; they must be rejected, not half-decoded.
    expect(
      normalizeDeferredActions([
        { action: "fillDown", start_row: 1, start_col: 2, end_row: 5, end_col: 6 },
        { action: "setIterationSettings", enabled: true, max_iterations: 50, max_change: 0.01 },
        { action: "setSheetVisibility", sheet_index: 3, visibility: "hidden" },
        { action: "activateSheet", sheet_index: 3 },
      ]),
    ).toEqual([]);
    // goto survives (row/col are spelled the same) but without a target sheet.
    const [goto] = normalizeDeferredActions([
      { action: "goto", row: 1, col: 1, sheet_index: 2, select: true },
    ]);
    expect(goto).toEqual({
      action: "goto",
      row: 1,
      col: 1,
      endRow: null,
      endCol: null,
      sheetIndex: NaN,
      select: true,
    });
    warn.mockRestore();
  });

  it("defaults goto.select to true (serde default_true) and keeps null payloads", () => {
    expect(normalizeDeferredActions([{ action: "goto", row: 0, col: 0, sheetIndex: 0 }])).toEqual([
      { action: "goto", row: 0, col: 0, endRow: null, endCol: null, sheetIndex: 0, select: true },
    ]);
    expect(normalizeDeferredActions([{ action: "setStatusBar", message: null }])).toEqual([
      { action: "setStatusBar", message: null },
    ]);
    expect(normalizeDeferredActions([{ action: "setScrollArea", area: null }])).toEqual([
      { action: "setScrollArea", area: null },
    ]);
  });

  it("drops unusable entries instead of poisoning the queue", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const actions = normalizeDeferredActions([
      { action: "goto", row: "nope", col: 1, sheetIndex: 0 },
      { action: "whoKnows" },
      null,
      42,
      { action: "fillDown", startRow: 1, startCol: 1, endRow: 2 },
      { action: "calculate" },
    ]);
    expect(actions).toEqual([{ action: "calculate" }]);
    warn.mockRestore();
  });

  it("returns an empty queue for a non-array payload", () => {
    expect(normalizeDeferredActions(undefined)).toEqual([]);
    expect(normalizeDeferredActions({ action: "calculate" })).toEqual([]);
  });
});

// ============================================================================
// Dispatch mapping
// ============================================================================

describe("applyDeferredActions", () => {
  it("maps every Rust DeferredAction variant onto a host call", async () => {
    const cases: Array<{ action: DeferredAction; expected: Call }> = [
      {
        action: {
          action: "goto",
          row: 7,
          col: 2,
          endRow: null,
          endCol: null,
          sheetIndex: 0,
          select: true,
        },
        expected: ["gotoCell", 7, 2, true, 7, 2],
      },
      { action: { action: "calculate" }, expected: ["recalculate"] },
      {
        action: { action: "activateSheet", sheetIndex: 3 },
        expected: ["activateSheet", 3],
      },
      {
        action: { action: "setStatusBar", message: "Working..." },
        expected: ["setStatusBar", "Working..."],
      },
      {
        action: { action: "setDisplayZeros", value: false },
        expected: ["setDisplayZeros", false],
      },
      {
        action: { action: "setViewMode", mode: "pageBreakPreview" },
        expected: ["setViewMode", "pageBreakPreview"],
      },
      { action: { action: "setZoom", percent: 150 }, expected: ["setZoomPercent", 150] },
      {
        action: { action: "setReferenceStyle", style: "R1C1" },
        expected: ["setReferenceStyle", "R1C1"],
      },
      {
        action: { action: "setDisplayGridlines", value: false },
        expected: ["setDisplayGridlines", false],
      },
      {
        action: { action: "setDisplayHeadings", value: true },
        expected: ["setDisplayHeadings", true],
      },
      {
        action: { action: "setDisplayFormulas", value: true },
        expected: ["setDisplayFormulas", true],
      },
      {
        action: { action: "fillDown", startRow: 1, startCol: 2, endRow: 5, endCol: 3 },
        expected: ["fillDown", 1, 2, 5, 3],
      },
      {
        action: { action: "fillRight", startRow: 1, startCol: 2, endRow: 1, endCol: 8 },
        expected: ["fillRight", 1, 2, 1, 8],
      },
      {
        action: {
          action: "applyNamedStyle",
          name: "Heading 1",
          row: 0,
          col: 0,
          endRow: null,
          endCol: null,
        },
        expected: ["applyNamedStyle", "Heading 1", 0, 0],
      },
      {
        action: { action: "setScrollArea", area: "A1:Z100" },
        expected: ["setScrollArea", "A1:Z100"],
      },
      {
        action: {
          action: "setIterationSettings",
          enabled: true,
          maxIterations: 200,
          maxChange: 0.001,
        },
        expected: ["setIterationSettings", true, 200, 0.001],
      },
      {
        action: { action: "setSheetVisibility", sheetIndex: 2, visibility: "hidden" },
        expected: ["setSheetVisibility", 2, "hidden"],
      },
    ];

    // Guard: the Rust enum has 17 variants; a new one must land in this table.
    expect(cases).toHaveLength(17);

    for (const { action, expected } of cases) {
      const host = createHost();
      await applyDeferredActions([action], host);
      expect(host.calls).toEqual([expected]);
    }
  });

  it("applies the queue in order", async () => {
    const host = createHost();
    const calls = await run(
      [
        { action: "setDisplayGridlines", value: false },
        { action: "fillDown", startRow: 0, startCol: 0, endRow: 4, endCol: 0 },
        { action: "calculate" },
        { action: "goto", row: 4, col: 0, sheetIndex: 0, select: true },
      ],
      host,
    );

    expect(calls).toEqual([
      ["setDisplayGridlines", false],
      ["fillDown", 0, 0, 4, 0],
      ["recalculate"],
      ["gotoCell", 4, 0, true, 4, 0],
    ]);
  });

  it("switches sheets before a cross-sheet goto, and only then", async () => {
    const onSheet0 = createHost(0);
    await run([{ action: "goto", row: 1, col: 1, sheetIndex: 2, select: true }], onSheet0);
    expect(onSheet0.calls).toEqual([
      ["activateSheet", 2],
      ["gotoCell", 1, 1, true, 1, 1],
    ]);

    const onSheet2 = createHost(2);
    await run([{ action: "goto", row: 1, col: 1, sheetIndex: 2, select: true }], onSheet2);
    expect(onSheet2.calls).toEqual([["gotoCell", 1, 1, true, 1, 1]]);
  });

  it("follows a script that switched sheets, and skips a redundant switch", async () => {
    const onSheet0 = createHost(0);
    await run([{ action: "activateSheet", sheetIndex: 2 }], onSheet0);
    expect(onSheet0.calls).toEqual([["activateSheet", 2]]);

    const onSheet2 = createHost(2);
    await run([{ action: "activateSheet", sheetIndex: 2 }], onSheet2);
    expect(onSheet2.calls).toEqual([]);
  });

  it("stays on the current sheet when the script named none", async () => {
    const host = createHost(1);
    // No sheetIndex at all -> normalizes to NaN -> no sheet switch.
    await run([{ action: "goto", row: 2, col: 2 }], host);
    expect(host.calls).toEqual([["gotoCell", 2, 2, true, 2, 2]]);
  });

  it("scrolls without selecting when select is false", async () => {
    const host = createHost();
    await run([{ action: "goto", row: 9, col: 9, sheetIndex: 0, select: false }], host);
    expect(host.calls).toEqual([["gotoCell", 9, 9, false, 9, 9]]);
  });

  it("selects the whole range for an A1-form goto with endRow/endCol", async () => {
    const host = createHost();
    await run(
      [{ action: "goto", row: 1, col: 1, endRow: 4, endCol: 2, sheetIndex: 0, select: true }],
      host,
    );
    expect(host.calls).toEqual([["gotoCell", 1, 1, true, 4, 2]]);
  });

  it("rejects a half-set or inverted goto range", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const halfSet = createHost();
    await run([{ action: "goto", row: 1, col: 1, endRow: 4, sheetIndex: 0 }], halfSet);
    expect(halfSet.calls).toEqual([]);

    const inverted = createHost();
    await run(
      [{ action: "goto", row: 5, col: 5, endRow: 2, endCol: 2, sheetIndex: 0 }],
      inverted,
    );
    expect(inverted.calls).toEqual([]);
    warn.mockRestore();
  });

  it("passes the zoom percent through verbatim and rejects the old factor form", async () => {
    const host = createHost();
    await run([{ action: "setZoom", percent: 75 }], host);
    expect(host.calls).toEqual([["setZoomPercent", 75]]);

    // 0.75 was the pre-Wave-4 factor spelling of 75% — out of the [10, 400]
    // percent range, so it is rejected rather than misread as "0.75%".
    const stale = createHost();
    await run([{ action: "setZoom", percent: 0.75 }], stale);
    expect(stale.calls).toEqual([]);

    const tooBig = createHost();
    await run([{ action: "setZoom", percent: 500 }], tooBig);
    expect(tooBig.calls).toEqual([]);
  });

  it("applies a named style to a rect and rejects a half-set range", async () => {
    const host = createHost();
    await run(
      [{ action: "applyNamedStyle", name: "Good", row: 1, col: 1, endRow: 3, endCol: 4 }],
      host,
    );
    expect(host.calls).toEqual([["applyNamedStyle", "Good", 1, 1, 3, 4]]);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const halfSet = createHost();
    await run(
      [{ action: "applyNamedStyle", name: "Good", row: 1, col: 1, endRow: 3 }],
      halfSet,
    );
    expect(halfSet.calls).toEqual([]);
    warn.mockRestore();
  });

  it("clears the scroll area when the script passes an empty range", async () => {
    const host = createHost();
    await run([{ action: "setScrollArea", area: "   " }], host);
    expect(host.calls).toEqual([["setScrollArea", null]]);
  });

  it("ignores values the host cannot honor", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = createHost();
    const calls = await run(
      [
        { action: "setViewMode", mode: "hologram" },
        { action: "setReferenceStyle", style: "L1O1" },
        { action: "setSheetVisibility", sheetIndex: -1, visibility: "hidden" },
        { action: "setSheetVisibility", sheetIndex: 1, visibility: "invisible" },
        { action: "activateSheet", sheetIndex: -2 },
        { action: "setZoom", percent: 0 },
        { action: "applyNamedStyle", name: "", row: 0, col: 0 },
        { action: "fillDown", startRow: 1.5, startCol: 0, endRow: 3, endCol: 0 },
        { action: "setIterationSettings", enabled: true, maxIterations: -5, maxChange: 0.1 },
      ],
      host,
    );
    expect(calls).toEqual([]);
    warn.mockRestore();
  });

  it("keeps applying the queue after one action throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const host = createHost();
    host.fillDown = async () => {
      throw new Error("backend offline");
    };
    const calls = await run(
      [
        { action: "fillDown", startRow: 0, startCol: 0, endRow: 3, endCol: 0 },
        { action: "setStatusBar", message: "done" },
      ],
      host,
    );
    expect(calls).toEqual([["setStatusBar", "done"]]);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
