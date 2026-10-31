//! FILENAME: app/extensions/Collaboration/__tests__/refreshDataEndsClipboard.test.ts
// PURPOSE: Data > Refresh Data ends the clipboard mode -- a copy's and a cut's
//          -- once the refresh RAN, whatever it found, as Excel's Data >
//          Refresh All does [LIVE, Excel 16 COM 2026-10-31,
//          clip7/probe-refresh.ps1: ExecuteMso("RefreshAll") sets CutCopyMode
//          to 0 even with nothing to refresh]. It announced only SHEET_CHANGED
//          (and only when a source was verified), so a copy stayed pasteable
//          (round 17, rev15B). A refresh that failed ends nothing. Core's
//          clipboard ends the mode on DATA_COMMAND_APPLIED (pinned in
//          src/core/hooks/__tests__/clipboardRecalcAndEndings.test.tsx and
//          src/api/__tests__/dataAftermath.test.ts).
// CONTEXT: @api/collaboration's refreshData and @api/events' emitAppEvent are
//          doubled; the command is the real one the menu item runs.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  refreshData: vi.fn(),
  emitted: [] as Array<[string, unknown]>,
}));

vi.mock("@api/collaboration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/collaboration")>()),
  refreshData: () => h.refreshData(),
}));
vi.mock("@api/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/events")>()),
  emitAppEvent: (name: string, p: unknown) => h.emitted.push([name, p]),
}));

import { AppEvents } from "@api/events";
import { runRefreshDataCommand } from "../lib/refreshDataCommand";

const ui = () => ({ showConnectionDialog: vi.fn(), showToast: vi.fn() });

function endings(): unknown[] {
  return h.emitted.filter(([name]) => name === AppEvents.DATA_COMMAND_APPLIED).map(([, p]) => p);
}

beforeEach(() => {
  h.emitted = [];
  h.refreshData.mockReset();
});

describe("Data > Refresh Data ends the clipboard mode as Excel's Refresh All does", () => {
  it("with nothing to refresh: one DATA_COMMAND_APPLIED {command:'refresh'}", async () => {
    h.refreshData.mockResolvedValue({ sourcesRefreshed: 0, needsConfiguration: [] });
    const u = ui();
    await runRefreshDataCommand(u);
    expect(endings(), "Refresh Data kept the clipboard mode (Excel's Refresh All ends it)").toEqual([
      { command: "refresh" },
    ]);
    expect(u.showToast).toHaveBeenCalledWith("No data sources found in subscriptions", expect.anything());
  });

  it("with sources verified, and with sources that need setup: one ending each", async () => {
    h.refreshData.mockResolvedValue({ sourcesRefreshed: 2, needsConfiguration: [] });
    await runRefreshDataCommand(ui());
    expect(endings()).toEqual([{ command: "refresh" }]);
    expect(h.emitted.map(([n]) => n)).toContain(AppEvents.SHEET_CHANGED);

    h.emitted = [];
    const needs = [{ id: "ds1" }];
    h.refreshData.mockResolvedValue({ sourcesRefreshed: 0, needsConfiguration: needs });
    const u = ui();
    await runRefreshDataCommand(u);
    expect(endings()).toEqual([{ command: "refresh" }]);
    expect(u.showConnectionDialog).toHaveBeenCalledWith(needs);
  });

  it("control: a refresh that failed ends nothing", async () => {
    h.refreshData.mockRejectedValue(new Error("offline"));
    const u = ui();
    await runRefreshDataCommand(u);
    expect(endings(), "a failed refresh ended the clipboard mode").toEqual([]);
    expect(u.showToast).toHaveBeenCalledWith(expect.stringContaining("Refresh failed"), expect.anything());
  });
});
