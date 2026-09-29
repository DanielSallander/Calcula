//! FILENAME: app/src/core/lib/__tests__/sheetSwitchViewPrime.test.ts
// PURPOSE: The switch's own flush carries the target sheet's VIEW state
//          (gridlines, headings and the other display flags, zoom, split,
//          freeze) as well as its cells, so a tab click from a canvas to a
//          worksheet paints the worksheet with ITS headings, gridlines and zoom
//          in the first frame (open-items 2.af, "One-frame flash on a tab click
//          from a canvas to a worksheet").
// CONTEXT: The view state was hydrated AFTER the context switch -- three IPCs
//          issued from an effect of the render that switched -- so the first
//          frame(s) of the worksheet showed the canvas's headings-off,
//          gridlines-off and zoom. `primeSheetSwitch` already runs after the
//          backend switch and before the synchronous dispatch sequence; it now
//          reads the view too, and the active-sheet hydration effect
//          (Spreadsheet.tsx) takes it in the SAME flush.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const calls: string[] = [];
const answers: Record<string, unknown> = {};
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    calls.push(cmd);
    if (cmd in answers) {
      const a = answers[cmd];
      if (a instanceof Error) throw a;
      return a;
    }
    throw new Error(`unexpected command ${cmd}`);
  }),
}));

import {
  primeSheetSwitch,
  registerSheetSwitchPrefetcher,
  resetSheetSwitchPrefetchForTests,
  takePrefetchedSheetView,
} from "../sheetSwitchPrefetch";

function worksheetView(): void {
  answers.get_show_gridlines = true;
  answers.get_sheet_zoom = 125;
  answers.get_split_window = { splitRow: null, splitCol: null };
  answers.get_freeze_panes = { freezeRow: 2, freezeCol: null };
  answers.get_sheet_display_flags = {
    displayZeros: true,
    showFormulas: false,
    viewMode: "normal",
    displayHeadings: true,
  };
}

beforeEach(() => {
  resetSheetSwitchPrefetchForTests();
  calls.length = 0;
  for (const k of Object.keys(answers)) delete answers[k];
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  resetSheetSwitchPrefetchForTests();
  vi.restoreAllMocks();
});

describe("the prime carries the target sheet's view state", () => {
  it("reads gridlines, zoom/split/freeze and the display flags BEFORE the switch dispatches", async () => {
    worksheetView();
    registerSheetSwitchPrefetcher(async () => null);

    await primeSheetSwitch(0);

    expect(calls, "the prime did not read the view state: it is hydrated after the swap").toEqual(
      expect.arrayContaining([
        "get_show_gridlines",
        "get_sheet_zoom",
        "get_split_window",
        "get_freeze_panes",
        "get_sheet_display_flags",
      ]),
    );
    expect(takePrefetchedSheetView(0)).toEqual({
      showGridlines: true,
      view: { zoomFactor: 1.25, splitRow: null, splitCol: null, freezeRow: 2, freezeCol: null },
      flags: { displayZeros: true, showFormulas: false, viewMode: "normal", displayHeadings: true },
    });
  });

  it("is taken exactly once, and only by the switch it was primed for", async () => {
    worksheetView();
    registerSheetSwitchPrefetcher(async () => null);

    await primeSheetSwitch(2);
    expect(takePrefetchedSheetView(3)).toBeNull();
    // The refusal cleared the slot rather than leaving a trap armed.
    expect(takePrefetchedSheetView(2)).toBeNull();

    await primeSheetSwitch(2);
    expect(takePrefetchedSheetView(2)).not.toBeNull();
    expect(takePrefetchedSheetView(2)).toBeNull();
  });

  it("an abandoned prime is not handed to a LATER switch", async () => {
    worksheetView();
    registerSheetSwitchPrefetcher(async () => null);
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(1_000);
    await primeSheetSwitch(1);
    now.mockReturnValue(1_000 + 60_000);
    expect(takePrefetchedSheetView(1)).toBeNull();
  });

  it("a gridlines read that fails leaves gridlines to the fallback, the rest still primes", async () => {
    worksheetView();
    answers.get_show_gridlines = new Error("command missing");
    registerSheetSwitchPrefetcher(async () => null);

    await primeSheetSwitch(0);

    const primed = takePrefetchedSheetView(0);
    expect(primed?.showGridlines).toBeNull();
    expect(primed?.view.zoomFactor).toBe(1.25);
  });

  it("primes no view when the grid is not mounted (no prefetcher registered)", async () => {
    worksheetView();
    await primeSheetSwitch(0);
    expect(calls).toEqual([]);
    expect(takePrefetchedSheetView(0)).toBeNull();
  });

  it("a new prime replaces the old one (never two sheets' views at once)", async () => {
    worksheetView();
    registerSheetSwitchPrefetcher(async () => null);
    await primeSheetSwitch(1);
    await primeSheetSwitch(4);
    expect(takePrefetchedSheetView(1)).toBeNull();
  });
});
