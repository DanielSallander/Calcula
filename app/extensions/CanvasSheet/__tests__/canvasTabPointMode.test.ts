//! FILENAME: app/extensions/CanvasSheet/__tests__/canvasTabPointMode.test.ts
// PURPOSE: The contextual Canvas tab follows the sheet ON SCREEN -- including
//          while a floating grid's cell edit is PARKED on a worksheet to pick a
//          reference there (open-items 2.af row 5, "the Canvas tab stays up").
// CONTEXT: The tab followed the canvas store's ACTIVE index, which the store
//          re-reads on SHEET_CHANGED. A point-mode sheet switch
//          (core/lib/pointModeSheetSwitch.ts) changes the viewed sheet WITHOUT
//          announcing SHEET_CHANGED, so the tab kept offering page size, snap
//          and arrange for a canvas nobody could see. Core announces the flip
//          through `onPointModeViewChanged` (@api/gridOverlays); the tab now
//          listens to it and asks which sheet is VIEWED.
//          Driven through the real external-edit store (a real registered
//          session), the REAL point-mode sheet switch (@api/externalEdit, its
//          backend call answered here) and the real point-mode signal.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CanvasLayout, SheetsResult } from "@api";

const getSheets = vi.fn<() => Promise<SheetsResult>>();
const registerPanel = vi.fn();
const unregisterPanel = vi.fn();
vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  getSheets: () => getSheets(),
  registerPanel: (...a: unknown[]) => registerPanel(...a),
  unregisterPanel: (...a: unknown[]) => unregisterPanel(...a),
}));

// The point-mode switch reaches the backend's `set_active_sheet`, answered here.
const tauri = vi.hoisted(() => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
    if (cmd === "set_active_sheet") {
      return {
        activeIndex: args?.index as number,
        sheets: [
          { index: 0, name: "Data", visibility: "visible", sheetId: "ws-0" },
          { index: 1, name: "Dashboard", visibility: "visible", sheetId: "cv-1", kind: "canvas" },
          { index: 2, name: "Report", visibility: "visible", sheetId: "cv-2", kind: "canvas" },
          { index: 3, name: "Notes", visibility: "visible", sheetId: "ws-3" },
        ],
      };
    }
    return null;
  }),
}));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: (cmd: string, args?: Record<string, unknown>) => tauri.invoke(cmd, args),
}));

// Core's own snapshot (what `@api/grid` re-exports AND what Core's point-mode
// predicate reads), so both sides see the same grid.
let gridSnapshot: Record<string, unknown> | null = null;
vi.mock("../../../src/core/state/GridContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/state/GridContext")>()),
  getGridStateSnapshot: () => gridSnapshot,
}));

import { onPointModeViewChanged } from "@api/gridOverlays";
import { defaultCanvasLayout } from "@api/canvasSheet";
import { registerExternalFormulaTarget } from "@api/editing";
import { notifyExternalEditChanged, switchSheetForPointMode, type ExternalEditSession } from "@api/externalEdit";
import { refreshCanvasSheets, resetCanvasSheetStore } from "../lib/canvasSheetStore";
import {
  installCanvasTabFollowsView,
  isCanvasTabRegistered,
  resetCanvasTab,
  viewedSheetIsCanvas,
} from "../lib/canvasTab";

const CANVAS = 1;
const WORKSHEET = 0;
/** A second canvas and a second worksheet, for moves between two FOREIGN sheets. */
const OTHER_CANVAS = 2;
const OTHER_WORKSHEET = 3;

function layout(): CanvasLayout {
  return defaultCanvasLayout();
}

function sheets(activeIndex: number): SheetsResult {
  return {
    activeIndex,
    sheets: [
      { index: 0, name: "Data", visibility: "visible", sheetId: "ws-0" },
      { index: 1, name: "Dashboard", visibility: "visible", sheetId: "cv-1", kind: "canvas", canvasLayout: layout() },
      { index: 2, name: "Report", visibility: "visible", sheetId: "cv-2", kind: "canvas", canvasLayout: layout() },
      { index: 3, name: "Notes", visibility: "visible", sheetId: "ws-3" },
    ],
  };
}

/** A floating grid's edit session hosted on the canvas. */
function session(): ExternalEditSession {
  return {
    address: "Float1!A1",
    hostSheetIndex: CANVAS,
    anchor: { row: 0, col: 0 },
    getText: () => "=",
    getCursor: () => 1,
    getView: () => "cell",
    setText: () => {},
    setCursor: () => {},
    adoptBarView: () => {},
    focusCellView: () => {},
    commit: async () => true,
    cancel: () => {},
    onParkedChanged: () => {},
  };
}

/** Open a floating-grid edit on the canvas; returns the session's teardown. */
function startFloatingGridEdit(): () => void {
  return registerExternalFormulaTarget({
    isExpectingReference: () => true,
    insertReference: () => {},
    session: session(),
  });
}

const cleanups: (() => void)[] = [];

beforeEach(async () => {
  registerPanel.mockClear();
  unregisterPanel.mockClear();
  resetCanvasTab();
  resetCanvasSheetStore();
  // The canvas is the ACTIVE sheet, as the store last read it.
  getSheets.mockResolvedValue(sheets(CANVAS));
  await refreshCanvasSheets();
  gridSnapshot = { surface: "canvas", sheetContext: { activeSheetIndex: CANVAS, activeSheetName: "Dashboard" } };
  cleanups.push(installCanvasTabFollowsView());
});

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  resetCanvasTab();
  resetCanvasSheetStore();
  gridSnapshot = null;
});

describe("the Canvas tab while a floating-grid edit is parked on a worksheet", () => {
  it("is up on the canvas, goes when the edit parks on a worksheet, and comes back on the return", async () => {
    expect(isCanvasTabRegistered(), "the tab is not up on the canvas").toBe(true);

    // A floating grid's cell edit starts on the canvas...
    cleanups.push(startFloatingGridEdit());
    expect(isCanvasTabRegistered()).toBe(true);

    // ...and a tab click parks it on the worksheet (no SHEET_CHANGED).
    await switchSheetForPointMode(WORKSHEET, vi.fn());
    expect(viewedSheetIsCanvas()).toBe(false);
    expect(isCanvasTabRegistered(), "the Canvas tab stayed up over a worksheet").toBe(false);

    // Back on the canvas (the session's host): the tab returns.
    await switchSheetForPointMode(CANVAS, vi.fn());
    expect(isCanvasTabRegistered()).toBe(true);
  });

  it("a Core cross-sheet edit viewing a worksheet is a worksheet on screen too", () => {
    // Core's own edit keeps its SOURCE sheet in `editing.sourceSheetIndex`; the
    // grid shows another sheet once the snapshot's active index differs.
    gridSnapshot = {
      surface: "grid",
      sheetContext: { activeSheetIndex: WORKSHEET, activeSheetName: "Data" },
      editing: { sourceSheetIndex: CANVAS },
    };
    expect(viewedSheetIsCanvas()).toBe(false);
  });

  it("control: with no edit open, the tab follows the store's active sheet as before", async () => {
    expect(viewedSheetIsCanvas()).toBe(true);
    getSheets.mockResolvedValue(sheets(WORKSHEET));
    await refreshCanvasSheets();
    expect(viewedSheetIsCanvas()).toBe(false);
    expect(isCanvasTabRegistered()).toBe(false);
  });

  it("control: the point-mode signal is the one the tab listens to", async () => {
    const heard: boolean[] = [];
    cleanups.push(onPointModeViewChanged((foreign) => heard.push(foreign)));
    cleanups.push(startFloatingGridEdit());
    await switchSheetForPointMode(WORKSHEET, vi.fn());
    expect(heard).toEqual([true]);
  });
});

describe("a point-mode move from one FOREIGN sheet to another (wave A review)", () => {
  // `onPointModeViewChanged` fires only when "the grid shows a foreign sheet"
  // FLIPS. Parked on one foreign sheet and moving to another keeps it true, so
  // a tab that listened only to that signal never re-synced.

  it("parked on another CANVAS, then a WORKSHEET: the tab goes", async () => {
    cleanups.push(startFloatingGridEdit());
    await switchSheetForPointMode(OTHER_CANVAS, vi.fn());
    expect(isCanvasTabRegistered(), "precondition: a canvas is on screen").toBe(true);

    await switchSheetForPointMode(WORKSHEET, vi.fn());
    expect(viewedSheetIsCanvas()).toBe(false);
    expect(isCanvasTabRegistered(), "the Canvas tab stayed up over a worksheet").toBe(false);
  });

  it("parked on a WORKSHEET, then another CANVAS: the tab comes back", async () => {
    cleanups.push(startFloatingGridEdit());
    await switchSheetForPointMode(WORKSHEET, vi.fn());
    expect(isCanvasTabRegistered(), "precondition: a worksheet is on screen").toBe(false);

    await switchSheetForPointMode(OTHER_CANVAS, vi.fn());
    expect(viewedSheetIsCanvas()).toBe(true);
    expect(isCanvasTabRegistered(), "the Canvas tab did not come back over a canvas").toBe(true);
  });

  it("Core's own cross-sheet edit: worksheet source -> a canvas -> another worksheet", async () => {
    // Core re-evaluates the point-mode view AFTER the render that made its
    // snapshot current (Spreadsheet.tsx). The same re-evaluation runs on every
    // external-edit store notification, which is how this test reaches it
    // through @api.
    const notifyPointModeViewChanged = (): void => notifyExternalEditChanged();
    // No external session: Core's edit on a worksheet (its source), the store
    // naming that worksheet as active.
    getSheets.mockResolvedValue(sheets(WORKSHEET));
    await refreshCanvasSheets();
    const onSource = { activeSheetIndex: WORKSHEET, activeSheetName: "Data" };
    gridSnapshot = { surface: "grid", sheetContext: onSource, editing: { sourceSheetIndex: WORKSHEET } };
    notifyPointModeViewChanged();
    expect(isCanvasTabRegistered(), "precondition: the edit's own worksheet").toBe(false);

    // A tab click on a canvas: the switch, then the render that makes the
    // snapshot current, then Core's post-render notify.
    await switchSheetForPointMode(CANVAS, vi.fn());
    gridSnapshot = {
      surface: "canvas",
      sheetContext: { activeSheetIndex: CANVAS, activeSheetName: "Dashboard" },
      editing: { sourceSheetIndex: WORKSHEET },
    };
    notifyPointModeViewChanged();
    expect(isCanvasTabRegistered(), "a canvas is on screen").toBe(true);

    // Then a click on another worksheet: still foreign, so no flip.
    await switchSheetForPointMode(OTHER_WORKSHEET, vi.fn());
    gridSnapshot = {
      surface: "grid",
      sheetContext: { activeSheetIndex: OTHER_WORKSHEET, activeSheetName: "Notes" },
      editing: { sourceSheetIndex: WORKSHEET },
    };
    notifyPointModeViewChanged();
    expect(isCanvasTabRegistered(), "the Canvas tab stayed up over the second worksheet").toBe(false);
  });
});

describe("activate() wires it", () => {
  it("installs the view-following tab, with cleanup, and no second store-only sync", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(__dirname, "../index.ts"), "utf8");
    expect(src).toContain("cleanupFns.push(installCanvasTabFollowsView());");
    expect(src, "a store-only sync would put the tab back over a worksheet").not.toMatch(/syncCanvasTab\(/);
  });
});
