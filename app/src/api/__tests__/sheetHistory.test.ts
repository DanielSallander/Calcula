//! FILENAME: app/src/api/__tests__/sheetHistory.test.ts
// PURPOSE: @api/sheetHistory -- the page history a Back button walks (Canvas
//          contract §3/§4.4). Pins: every active-sheet change is a visit, Back
//          goes to the page before and does NOT record its own switch as a new
//          visit (so a second Back keeps walking back, Power BI's behaviour),
//          a renamed page keeps its place, a deleted or hidden page is skipped,
//          File > New / Open starts afresh, and with nothing to go back to Back
//          says so instead of guessing.
// CONTEXT: The switch itself is @api/sheetSwitch's (doubled here); the history
//          is fed by the same AppEvents every tab click emits.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  sheets: [] as Array<{ index: number; name: string; visibility: string; sheetId?: string }>,
  activeIndex: 0,
  activations: [] as number[],
}));

vi.mock("../../core/lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSheets: async () => ({ sheets: h.sheets.map((s) => ({ ...s })), activeIndex: h.activeIndex }),
}));

import { AppEvents, emitAppEvent } from "../events";

vi.mock("../sheetSwitch", () => ({
  activateSheet: async (index: number) => {
    h.activations.push(index);
    h.activeIndex = index;
    const s = h.sheets.find((x) => x.index === index)!;
    // The real switch announces itself exactly like a tab click.
    emitAppEvent(AppEvents.SHEET_CHANGED, { sheetIndex: index, sheetName: s.name });
    return { sheets: h.sheets, activeIndex: index };
  },
}));

import {
  goBackSheet,
  readSheetHistoryForTest,
  resetSheetHistory,
  startSheetHistory,
} from "../sheetHistory";

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** A user's tab click, as the bus sees it. */
async function visit(index: number): Promise<void> {
  h.activeIndex = index;
  emitAppEvent(AppEvents.SHEET_CHANGED, { sheetIndex: index, sheetName: h.sheets.find((s) => s.index === index)!.name });
  await flush();
}

let stop: () => void;

beforeEach(async () => {
  resetSheetHistory();
  h.sheets = [
    { index: 0, name: "Data", visibility: "visible" },
    { index: 1, name: "Overview", visibility: "visible" },
    { index: 2, name: "Details", visibility: "visible" },
    { index: 3, name: "Archive", visibility: "visible" },
  ];
  h.activeIndex = 0;
  h.activations = [];
  stop = startSheetHistory();
  await flush();
});

afterEach(() => {
  stop();
  resetSheetHistory();
});

describe("the page history", () => {
  // SABOTAGE: drop the seed in startSheetHistory -> the first page is never
  // recorded and Back from the second page has nowhere to go.
  it("is seeded with the page that is active when it starts", () => {
    expect(readSheetHistoryForTest()).toEqual(["Data"]);
  });

  it("records each visit once, in order", async () => {
    await visit(1);
    await visit(1);
    await visit(2);
    expect(readSheetHistoryForTest()).toEqual(["Data", "Overview", "Details"]);
  });

  it("Back goes to the page before, and a second Back keeps walking back", async () => {
    await visit(1);
    await visit(2);
    expect(await goBackSheet()).toEqual({ moved: true, sheetName: "Overview" });
    expect(h.activations).toEqual([1]);
    // SABOTAGE: let Back's own switch record a visit -> the history reads
    // [Data, Overview, Overview]... and the next Back goes nowhere new.
    expect(readSheetHistoryForTest()).toEqual(["Data", "Overview"]);
    expect(await goBackSheet()).toEqual({ moved: true, sheetName: "Data" });
    expect(h.activations).toEqual([1, 0]);
  });

  it("with nothing to go back to, says so and switches nothing", async () => {
    expect(await goBackSheet()).toEqual({ moved: false });
    expect(h.activations).toEqual([]);
  });

  it("follows a renamed page", async () => {
    await visit(1);
    await visit(2);
    h.sheets[1].name = "Summary";
    emitAppEvent(AppEvents.SHEET_RENAMED, { sheetIndex: 1, oldName: "Overview", newName: "Summary" });
    expect(await goBackSheet()).toEqual({ moved: true, sheetName: "Summary" });
    expect(h.activations).toEqual([1]);
  });

  it("forgets a deleted page and goes past it", async () => {
    await visit(1);
    await visit(2);
    h.sheets = h.sheets.filter((s) => s.name !== "Overview").map((s) => (s.index > 1 ? { ...s, index: s.index - 1 } : s));
    h.activeIndex = 1;
    emitAppEvent(AppEvents.SHEET_DELETED, { sheetIndex: 1, sheetName: "Overview" });
    expect(await goBackSheet()).toEqual({ moved: true, sheetName: "Data" });
    expect(h.activations).toEqual([0]);
  });

  // The index a page had when it was visited is not its index now (a sheet
  // was inserted before it): Back resolves the NAME against the live list.
  it("resolves the page by name against the LIVE sheet list, not a remembered index", async () => {
    await visit(2);
    h.sheets = [{ index: 0, name: "New", visibility: "visible" }, ...h.sheets.map((s) => ({ ...s, index: s.index + 1 }))];
    h.activeIndex = 3;
    expect(await goBackSheet()).toEqual({ moved: true, sheetName: "Data" });
    expect(h.activations).toEqual([1]);
  });

  it("skips a page that has since been hidden", async () => {
    await visit(1);
    await visit(2);
    h.sheets[1].visibility = "hidden";
    expect(await goBackSheet()).toEqual({ moved: true, sheetName: "Data" });
  });

  it("starts afresh on File > New", async () => {
    await visit(1);
    await visit(2);
    h.sheets = [{ index: 0, name: "Sheet1", visibility: "visible" }];
    h.activeIndex = 0;
    emitAppEvent(AppEvents.AFTER_NEW, {});
    await flush();
    expect(readSheetHistoryForTest()).toEqual(["Sheet1"]);
    expect(await goBackSheet()).toEqual({ moved: false });
  });

  it("when the bus missed a switch, Back still goes to the page the history ends on", async () => {
    await visit(1);
    // Active is now Details, but no SHEET_CHANGED was heard.
    h.activeIndex = 2;
    expect(await goBackSheet()).toEqual({ moved: true, sheetName: "Overview" });
  });

  it("is bounded", async () => {
    for (let i = 0; i < 120; i++) await visit(i % 2 === 0 ? 1 : 2);
    expect(readSheetHistoryForTest().length).toBeLessThanOrEqual(50);
  });

  it("stops listening when its last starter stops", async () => {
    stop();
    await visit(1);
    expect(readSheetHistoryForTest()).toEqual(["Data"]);
    stop = startSheetHistory();
  });
});
