//! FILENAME: app/src/api/__tests__/reportPages.test.ts
// PURPOSE: @api/reportPages -- the live canvas page list a Page Navigator
//          derives its items from (D-NAV). Pins: only canvases are pages, in
//          TAB order (true index, not list position); THE one membership rule
//          (veryHidden never, hidden / tooltip only on request); every one of
//          the nine refresh triggers re-reads, and triggers in one task are
//          ONE read (the Shell's "sheets" domain fires two events at once); an
//          older answer arriving last never overwrites a newer one; a failed
//          read keeps the snapshot; an unchanged list publishes nothing; the
//          lifetime is reference-counted; `sheetIdAt` names ANY sheet by true
//          index.
// CONTEXT: `getSheets` is doubled; each read either answers the current
//          hoisted workbook at once or is held back as a deferred the test
//          resolves (or rejects) in the order it chooses.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SheetInfo, SheetsResult } from "../../core/lib/tauri-api";

interface Deferred {
  resolve: (r: SheetsResult) => void;
  reject: (e: unknown) => void;
}

const h = vi.hoisted(() => ({
  sheets: [] as SheetInfo[],
  activeIndex: 0,
  calls: 0,
  /** When true, each read is parked here instead of answering. */
  hold: false,
  held: [] as Deferred[],
}));

vi.mock("../../core/lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSheets: () => {
    h.calls += 1;
    if (h.hold) {
      return new Promise<SheetsResult>((resolve, reject) => {
        h.held.push({ resolve, reject });
      });
    }
    return Promise.resolve({ sheets: h.sheets.map((s) => ({ ...s })), activeIndex: h.activeIndex });
  },
}));

import { AppEvents, emitAppEvent } from "../events";
import {
  getReportPagesSnapshot,
  onReportPagesChanged,
  refreshReportPages,
  reportPageById,
  reportPagesFrom,
  resetReportPages,
  selectReportPages,
  sheetIdAt,
  startReportPages,
} from "../reportPages";
import type { ReportPage } from "../reportPages";

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function layout(pagePreset: string): SheetInfo["canvasLayout"] {
  return {
    snapToGrid: true,
    gridSizePx: 16,
    showGrid: true,
    pagePreset,
    pageWidth: 1280,
    pageHeight: 720,
  } as SheetInfo["canvasLayout"];
}

function canvas(index: number, name: string, extra: Partial<SheetInfo> = {}): SheetInfo {
  return {
    index,
    name,
    visibility: "visible",
    sheetId: `id-${name}`,
    kind: "canvas",
    canvasLayout: layout("16:9"),
    ...extra,
  };
}

function worksheet(index: number, name: string, extra: Partial<SheetInfo> = {}): SheetInfo {
  return { index, name, visibility: "visible", sheetId: `id-${name}`, kind: "worksheet", ...extra };
}

function names(pages: readonly ReportPage[]): string[] {
  return pages.map((p) => p.name);
}

let stops: Array<() => void> = [];

function start(): () => void {
  const stop = startReportPages();
  stops.push(stop);
  return stop;
}

beforeEach(() => {
  resetReportPages();
  h.sheets = [worksheet(0, "Data"), canvas(1, "Overview"), canvas(2, "Details")];
  h.activeIndex = 0;
  h.calls = 0;
  h.hold = false;
  h.held = [];
  stops = [];
});

afterEach(() => {
  for (const stop of stops) stop();
  resetReportPages();
  vi.restoreAllMocks();
});

describe("reportPagesFrom: canvases only, in tab order", () => {
  it("keeps canvases, drops worksheets, and orders by TRUE index rather than list position", () => {
    const result: SheetsResult = {
      sheets: [canvas(3, "Last"), worksheet(0, "Data"), canvas(1, "First"), worksheet(2, "Calc")],
      activeIndex: 0,
    };
    const pages = reportPagesFrom(result);
    expect(names(pages)).toEqual(["First", "Last"]);
    expect(pages.map((p) => p.index)).toEqual([1, 3]);
  });

  it("carries id, visibility and the tooltip flag; a missing id is the empty string", () => {
    const pages = reportPagesFrom({
      sheets: [
        canvas(0, "Tip", { canvasLayout: layout("tooltip") }),
        canvas(1, "NoId", { sheetId: undefined, visibility: "hidden" }),
        canvas(2, "Full", { canvasLayout: layout("16:9-fhd") }),
      ],
      activeIndex: 0,
    });
    expect(pages).toEqual([
      { sheetId: "id-Tip", name: "Tip", index: 0, visibility: "visible", isTooltipPage: true },
      { sheetId: "", name: "NoId", index: 1, visibility: "hidden", isTooltipPage: false },
      { sheetId: "id-Full", name: "Full", index: 2, visibility: "visible", isTooltipPage: false },
    ]);
  });

  it("treats a sheet with no kind as a worksheet (an older backend)", () => {
    const pages = reportPagesFrom({ sheets: [{ index: 0, name: "Old", visibility: "visible" }], activeIndex: 0 });
    expect(pages).toEqual([]);
  });
});

describe("selectReportPages: THE one membership rule", () => {
  const pages = reportPagesFrom({
    sheets: [
      canvas(0, "Shown"),
      canvas(1, "Hidden", { visibility: "hidden" }),
      canvas(2, "VeryHidden", { visibility: "veryHidden" }),
      canvas(3, "Tip", { canvasLayout: layout("tooltip") }),
      canvas(4, "HiddenTip", { visibility: "hidden", canvasLayout: layout("tooltip") }),
    ],
    activeIndex: 0,
  });

  it("by default lists only visible, non-tooltip pages", () => {
    expect(names(selectReportPages(pages))).toEqual(["Shown"]);
    expect(names(selectReportPages(pages, {}))).toEqual(["Shown"]);
  });

  it("showHiddenPages adds user-hidden pages but NEVER veryHidden ones", () => {
    expect(names(selectReportPages(pages, { showHiddenPages: true }))).toEqual(["Shown", "Hidden"]);
  });

  it("showTooltipPages adds tooltip pages", () => {
    expect(names(selectReportPages(pages, { showTooltipPages: true }))).toEqual(["Shown", "Tip"]);
  });

  it("both flags together still never list a veryHidden page", () => {
    expect(names(selectReportPages(pages, { showHiddenPages: true, showTooltipPages: true }))).toEqual([
      "Shown",
      "Hidden",
      "Tip",
      "HiddenTip",
    ]);
  });
});

describe("the live snapshot", () => {
  it("starts empty, and the first start reads the workbook once", async () => {
    expect(getReportPagesSnapshot().pages).toEqual([]);
    expect(getReportPagesSnapshot().version).toBe(0);
    start();
    await flush();
    expect(h.calls).toBe(1);
    const snap = getReportPagesSnapshot();
    expect(names(snap.pages)).toEqual(["Overview", "Details"]);
    expect(snap.activeIndex).toBe(0);
    expect(snap.version).toBe(1);
  });

  const TRIGGERS: Array<[string, () => void]> = [
    ["SHEET_ADDED", () => emitAppEvent(AppEvents.SHEET_ADDED, { sheetIndex: 3, sheetName: "New" })],
    ["SHEET_DELETED", () => emitAppEvent(AppEvents.SHEET_DELETED, { sheetIndex: 2, sheetName: "Details" })],
    ["SHEET_RENAMED", () => emitAppEvent(AppEvents.SHEET_RENAMED, { oldName: "Details", newName: "More" })],
    ["SHEET_CHANGED", () => emitAppEvent(AppEvents.SHEET_CHANGED, { sheetIndex: 1, sheetName: "Overview" })],
    ["CANVAS_LAYOUT_CHANGED", () => emitAppEvent(AppEvents.CANVAS_LAYOUT_CHANGED, {})],
    ["AFTER_OPEN", () => emitAppEvent(AppEvents.AFTER_OPEN, {})],
    ["AFTER_NEW", () => emitAppEvent(AppEvents.AFTER_NEW, {})],
    ["PACKAGE_UPDATED", () => emitAppEvent(AppEvents.PACKAGE_UPDATED, {})],
    ["sheets:refresh", () => window.dispatchEvent(new CustomEvent("sheets:refresh"))],
  ];

  it.each(TRIGGERS)("%s causes exactly one re-read", async (_name, fire) => {
    start();
    await flush();
    expect(h.calls).toBe(1);
    fire();
    await flush();
    expect(h.calls).toBe(2);
  });

  it("covers all nine triggers (the table above is the whole list)", () => {
    expect(TRIGGERS).toHaveLength(9);
  });

  it("coalesces triggers in one task into ONE read (the 'sheets' domain fires two events at once)", async () => {
    start();
    await flush();
    expect(h.calls).toBe(1);
    // Exactly what the Shell's MUTATION_REFRESH translator does for "sheets".
    window.dispatchEvent(new CustomEvent("sheets:refresh"));
    window.dispatchEvent(new CustomEvent(AppEvents.SHEET_CHANGED));
    emitAppEvent(AppEvents.SHEET_ADDED, {});
    await flush();
    expect(h.calls).toBe(2);
    // A trigger in a LATER task is a new read.
    emitAppEvent(AppEvents.SHEET_ADDED, {});
    await flush();
    expect(h.calls).toBe(3);
  });

  it("a page added later appears, and listeners hear the new snapshot", async () => {
    start();
    await flush();
    const heard: string[][] = [];
    onReportPagesChanged((s) => heard.push(names(s.pages)));
    h.sheets = [...h.sheets, canvas(3, "Added")];
    emitAppEvent(AppEvents.SHEET_ADDED, { sheetIndex: 3, sheetName: "Added" });
    await flush();
    expect(heard).toEqual([["Overview", "Details", "Added"]]);
    expect(getReportPagesSnapshot().version).toBe(2);
  });

  it("an OLDER answer arriving last never overwrites a newer one", async () => {
    h.hold = true;
    const first = refreshReportPages();
    const second = refreshReportPages();
    expect(h.held).toHaveLength(2);
    // The newer read answers first ...
    h.held[1].resolve({ sheets: [canvas(0, "Newer")], activeIndex: 0 });
    expect(await second).toBe(true);
    // ... then the older one lands, and is dropped.
    h.held[0].resolve({ sheets: [canvas(0, "Older")], activeIndex: 0 });
    expect(await first).toBe(false);
    expect(names(getReportPagesSnapshot().pages)).toEqual(["Newer"]);
  });

  it("a failed read keeps the previous snapshot and warns", async () => {
    start();
    await flush();
    const before = getReportPagesSnapshot();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const listener = vi.fn();
    onReportPagesChanged(listener);
    h.hold = true;
    const pending = refreshReportPages();
    h.held[0].reject(new Error("ipc down"));
    expect(await pending).toBe(false);
    expect(getReportPagesSnapshot()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("a MALFORMED answer is a failed read: the previous snapshot is kept, nothing is thrown", async () => {
    start();
    await flush();
    const before = getReportPagesSnapshot();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const listener = vi.fn();
    onReportPagesChanged(listener);
    h.hold = true;
    const pending = refreshReportPages();
    h.held[0].resolve(null as never);
    expect(await pending).toBe(false);
    expect(getReportPagesSnapshot()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("an unchanged list publishes nothing and does not bump the version", async () => {
    start();
    await flush();
    const before = getReportPagesSnapshot();
    const listener = vi.fn();
    onReportPagesChanged(listener);
    expect(await refreshReportPages()).toBe(true);
    expect(listener).not.toHaveBeenCalled();
    expect(getReportPagesSnapshot()).toBe(before);
    expect(getReportPagesSnapshot().version).toBe(before.version);
  });

  it("renaming a WORKSHEET alone publishes nothing (worksheet names are not in the snapshot)", async () => {
    start();
    await flush();
    const listener = vi.fn();
    onReportPagesChanged(listener);
    h.sheets = h.sheets.map((s) => (s.name === "Data" ? { ...s, name: "Inputs" } : s));
    emitAppEvent(AppEvents.SHEET_RENAMED, { oldName: "Data", newName: "Inputs" });
    await flush();
    expect(h.calls).toBe(2);
    expect(listener).not.toHaveBeenCalled();
  });

  it("renaming a PAGE publishes once with the new name", async () => {
    start();
    await flush();
    const listener = vi.fn();
    onReportPagesChanged(listener);
    h.sheets = h.sheets.map((s) => (s.name === "Details" ? { ...s, name: "More" } : s));
    emitAppEvent(AppEvents.SHEET_RENAMED, { oldName: "Details", newName: "More" });
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(names(getReportPagesSnapshot().pages)).toEqual(["Overview", "More"]);
  });

  it("moving a WORKSHEET (its id now sits at another index) publishes once", async () => {
    start();
    await flush();
    const listener = vi.fn();
    onReportPagesChanged(listener);
    // Data moves from 0 to 2: the canvases shift down one.
    h.sheets = [canvas(0, "Overview"), canvas(1, "Details"), worksheet(2, "Data")];
    window.dispatchEvent(new CustomEvent("sheets:refresh"));
    window.dispatchEvent(new CustomEvent(AppEvents.SHEET_CHANGED));
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
    const snap = getReportPagesSnapshot();
    expect(sheetIdAt(snap, 2)).toBe("id-Data");
    expect(snap.pages.map((p) => p.index)).toEqual([0, 1]);
  });

  it("a worksheet move that leaves every canvas in place still publishes once (the ids moved)", async () => {
    h.sheets = [worksheet(0, "A"), worksheet(1, "B"), canvas(2, "Page")];
    start();
    await flush();
    const listener = vi.fn();
    onReportPagesChanged(listener);
    h.sheets = [worksheet(0, "B"), worksheet(1, "A"), canvas(2, "Page")];
    window.dispatchEvent(new CustomEvent("sheets:refresh"));
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(sheetIdAt(getReportPagesSnapshot(), 0)).toBe("id-B");
  });

  it("an active-sheet switch publishes (the current page is part of the snapshot)", async () => {
    start();
    await flush();
    const listener = vi.fn();
    onReportPagesChanged(listener);
    h.activeIndex = 2;
    emitAppEvent(AppEvents.SHEET_CHANGED, { sheetIndex: 2, sheetName: "Details" });
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getReportPagesSnapshot().activeIndex).toBe(2);
  });

  it("hiding a page through the 'sheets' domain shows up as its visibility", async () => {
    start();
    await flush();
    h.sheets = h.sheets.map((s) => (s.name === "Details" ? { ...s, visibility: "hidden" } : s));
    window.dispatchEvent(new CustomEvent("sheets:refresh"));
    await flush();
    const snap = getReportPagesSnapshot();
    expect(reportPageById(snap, "id-Details")?.visibility).toBe("hidden");
    expect(names(selectReportPages(snap.pages))).toEqual(["Overview"]);
  });

  it("AFTER_NEW re-reads the NEW document's pages", async () => {
    start();
    await flush();
    h.sheets = [worksheet(0, "Sheet1")];
    h.activeIndex = 0;
    emitAppEvent(AppEvents.AFTER_NEW, {});
    await flush();
    const snap = getReportPagesSnapshot();
    expect(snap.pages).toEqual([]);
    expect(sheetIdAt(snap, 0)).toBe("id-Sheet1");
    expect(sheetIdAt(snap, 1)).toBeNull();
  });

  it("a page re-sized to Tooltip (CANVAS_LAYOUT_CHANGED) leaves the default list", async () => {
    start();
    await flush();
    h.sheets = h.sheets.map((s) => (s.name === "Details" ? { ...s, canvasLayout: layout("tooltip") } : s));
    emitAppEvent(AppEvents.CANVAS_LAYOUT_CHANGED, {});
    await flush();
    const snap = getReportPagesSnapshot();
    expect(reportPageById(snap, "id-Details")?.isTooltipPage).toBe(true);
    expect(names(selectReportPages(snap.pages))).toEqual(["Overview"]);
  });

  it("a listener that throws is logged and does not stop the others", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const after = vi.fn();
    onReportPagesChanged(() => {
      throw new Error("boom");
    });
    onReportPagesChanged(after);
    expect(await refreshReportPages()).toBe(true);
    expect(after).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("an unsubscribed listener hears nothing more", async () => {
    const listener = vi.fn();
    const off = onReportPagesChanged(listener);
    off();
    await refreshReportPages();
    expect(listener).not.toHaveBeenCalled();
  });

  it("the snapshot is frozen (a consumer cannot edit the shared copy)", async () => {
    await refreshReportPages();
    const snap = getReportPagesSnapshot();
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.pages)).toBe(true);
    expect(Object.isFrozen(snap.pages[0])).toBe(true);
  });
});

describe("lifetime: reference-counted", () => {
  it("two starters, one stop keeps listening; the second stop removes the listeners", async () => {
    const stopA = start();
    const stopB = start();
    await flush();
    expect(h.calls).toBe(1); // the second start makes no extra first read
    stopA();
    stopA(); // idempotent: a double stop does not steal the other starter's count
    emitAppEvent(AppEvents.SHEET_ADDED, {});
    await flush();
    expect(h.calls).toBe(2);
    stopB();
    emitAppEvent(AppEvents.SHEET_ADDED, {});
    window.dispatchEvent(new CustomEvent("sheets:refresh"));
    await flush();
    expect(h.calls).toBe(2);
  });

  it("starting again after the last stop installs the listeners and reads again", async () => {
    const stop = start();
    await flush();
    stop();
    start();
    await flush();
    expect(h.calls).toBe(2);
    emitAppEvent(AppEvents.SHEET_DELETED, {});
    await flush();
    expect(h.calls).toBe(3);
  });

  it("reset forgets the snapshot, the listeners and a read already queued", async () => {
    start();
    await flush();
    expect(getReportPagesSnapshot().pages).toHaveLength(2);
    const listener = vi.fn();
    onReportPagesChanged(listener);
    emitAppEvent(AppEvents.SHEET_ADDED, {}); // queued, not yet read
    resetReportPages();
    await flush();
    expect(h.calls).toBe(1);
    expect(getReportPagesSnapshot().pages).toEqual([]);
    expect(getReportPagesSnapshot().version).toBe(0);
    await refreshReportPages();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("sheetIdAt / reportPageById", () => {
  it("sheetIdAt answers a WORKSHEET's and a hidden sheet's id by true index", async () => {
    h.sheets = [
      worksheet(0, "Data"),
      canvas(1, "Overview"),
      worksheet(2, "Secret", { visibility: "hidden" }),
      canvas(3, "NoId", { sheetId: undefined }),
    ];
    await refreshReportPages();
    const snap = getReportPagesSnapshot();
    expect(sheetIdAt(snap, 0)).toBe("id-Data");
    expect(sheetIdAt(snap, 1)).toBe("id-Overview");
    expect(sheetIdAt(snap, 2)).toBe("id-Secret");
    expect(sheetIdAt(snap, 3), "a sheet with no id").toBeNull();
    expect(sheetIdAt(snap, 9), "no sheet at that index").toBeNull();
    expect(sheetIdAt(snap, undefined)).toBeNull();
    expect(sheetIdAt(snap, Number.NaN)).toBeNull();
  });

  it("reportPageById finds a canvas page by id, and never a worksheet or the empty id", async () => {
    h.sheets = [worksheet(0, "Data"), canvas(1, "Overview"), canvas(2, "NoId", { sheetId: undefined })];
    await refreshReportPages();
    const snap = getReportPagesSnapshot();
    expect(reportPageById(snap, "id-Overview")?.name).toBe("Overview");
    expect(reportPageById(snap, "id-Data")).toBeNull();
    expect(reportPageById(snap, "")).toBeNull();
    expect(reportPageById(snap, "nope")).toBeNull();
  });
});

describe("the @api barrel", () => {
  it("re-exports the seam's functions, as the same live module", async () => {
    const barrel = await import("../index");
    for (const name of [
      "startReportPages",
      "getReportPagesSnapshot",
      "onReportPagesChanged",
      "refreshReportPages",
      "reportPagesFrom",
      "selectReportPages",
      "reportPageById",
      "sheetIdAt",
    ]) {
      expect(typeof (barrel as Record<string, unknown>)[name], name).toBe("function");
    }
    h.sheets = [canvas(0, "Only")];
    await refreshReportPages();
    expect(barrel.getReportPagesSnapshot()).toBe(getReportPagesSnapshot());
  });
});
