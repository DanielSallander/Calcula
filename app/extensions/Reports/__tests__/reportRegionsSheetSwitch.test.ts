//! FILENAME: app/extensions/Reports/__tests__/reportRegionsSheetSwitch.test.ts
// PURPOSE: A sheet switch refreshes the Reports region cache, so right-clicking
//          (or selecting) a report on the sheet just switched to finds it.
// CONTEXT: Y10 (wave E; wave D shell fix-up NEW defect 1, "suspected"). The
//          cache keeps the ACTIVE sheet index its hit-test (`findReportAt`)
//          compares against, and it was told about sheet switches only by a
//          `sheet:activated` window event -- which NOTHING dispatches (grep:
//          no `sheet:activated` dispatch anywhere in app/). So after a switch
//          the cache still answered for the previous sheet until some edit
//          happened to fire `grid:refresh`: the Report tab and the report's
//          right-click menu did not recognise a report on the new sheet, and a
//          cell on the new sheet at a report's coordinates on the OLD sheet
//          was taken for it. SHEET_CHANGED is the announcement every switch
//          makes (SheetTabs, the Name Box, undo, scripts).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  activeIndex: 0,
  listReports: vi.fn(),
}));

vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  registerDialog: vi.fn(),
  unregisterDialog: vi.fn(),
  showDialog: vi.fn(),
  registerMenuItem: vi.fn(),
  unregisterMenuItem: vi.fn(),
  ExtensionRegistry: { onSelectionChange: () => () => {} },
  getSheets: vi.fn(async () => ({ sheets: [{ name: "S1" }, { name: "S2" }], activeIndex: h.activeIndex })),
}));
vi.mock("../components/CreateReportDialog", () => ({ CreateReportDialog: () => null }));
vi.mock("../components/ManageReportsDialog", () => ({ ManageReportsDialog: () => null }));
vi.mock("../components/EditReportDialog", () => ({ EditReportDialog: () => null }));
vi.mock("../lib/reportsBackend", () => ({ reportsBackend: { set: vi.fn() } }));
vi.mock("../lib/reportRefresh", () => ({
  listReports: (...a: unknown[]) => h.listReports(...a),
  clearReportModelCache: vi.fn(),
}));
vi.mock("../lib/reportQueryProvider", () => ({ registerReportQueryProvider: () => () => {} }));
vi.mock("../lib/reportDistribution", () => ({ registerReportDistribution: () => () => {} }));
vi.mock("../lib/reportContextMenu", () => ({ registerReportContextMenu: () => () => {} }));
vi.mock("../lib/reportSelectionHandler", () => ({
  handleReportSelectionChange: vi.fn(),
  reevaluateActiveReport: vi.fn(),
  resetReportSelectionHandler: vi.fn(),
}));

import extension from "../index";
import { findReportAt } from "../lib/reportRegions";
import { AppEvents, emitAppEvent } from "@api/events";

/** A report at A1:B2 of the SECOND sheet. */
const ON_SHEET_2 = {
  id: "r2",
  name: "Sheet 2 report",
  dslText: "ROWS: Region",
  connectionId: "c1",
  sheetIndex: 1,
  anchorRow: 0,
  anchorCol: 0,
  endRow: 1,
  endCol: 1,
};

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(async () => {
  h.activeIndex = 0;
  h.listReports.mockReset();
  h.listReports.mockResolvedValue([ON_SHEET_2]);
  extension.activate({ invokeBackend: vi.fn() } as never);
  await settle();
});

afterEach(() => {
  extension.deactivate?.();
});

describe("Reports region cache follows the ACTIVE sheet (Y10)", () => {
  it("starts on sheet 1: A1 is not the sheet-2 report (control)", () => {
    expect(findReportAt(0, 0)).toBeNull();
  });

  it("after a switch to sheet 2 (SHEET_CHANGED), A1 IS that sheet's report -- no edit needed", async () => {
    h.activeIndex = 1;
    emitAppEvent(AppEvents.SHEET_CHANGED, { sheetIndex: 1, sheetName: "S2" });
    await settle();
    expect(findReportAt(0, 0)?.id, "the cache still answers for the sheet the user left").toBe("r2");
  });

  it("and back: after switching to sheet 1 again, A1 is no report", async () => {
    h.activeIndex = 1;
    emitAppEvent(AppEvents.SHEET_CHANGED, { sheetIndex: 1, sheetName: "S2" });
    await settle();
    h.activeIndex = 0;
    emitAppEvent(AppEvents.SHEET_CHANGED, { sheetIndex: 0, sheetName: "S1" });
    await settle();
    expect(findReportAt(0, 0), "a sheet-1 cell was taken for the sheet-2 report").toBeNull();
  });

  it("deactivate stops listening: a later switch refreshes nothing", async () => {
    extension.deactivate?.();
    const calls = h.listReports.mock.calls.length;
    h.activeIndex = 1;
    emitAppEvent(AppEvents.SHEET_CHANGED, { sheetIndex: 1, sheetName: "S2" });
    await settle();
    expect(h.listReports.mock.calls.length, "a deactivated Reports still refreshes on a sheet switch").toBe(calls);
    extension.activate({ invokeBackend: vi.fn() } as never);
    await settle();
  });
});
