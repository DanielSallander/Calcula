// FILENAME: app/extensions/Collaboration/lib/__tests__/writebackTab.test.tsx
// PURPOSE: The contextual "Writeback" ribbon tab: it follows Core's ACTIVE
//          cell into and out of a writeback region, re-derives when the sheet
//          changes or the region list changes under a cursor that did not move,
//          stands aside while a selection owner holds the selection, badges the
//          unsent count, disables Submit/Discard WITH a reason, and runs Submit
//          as preview -> confirm -> send -> re-read -> toast. A refused confirm
//          sends nothing: confirmAsync is doubled in its TAURI shape
//          (Promise.resolve(false)), the shape that lets a `!confirm(...)` bug
//          through when a synchronous boolean double is used instead.

import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { WritebackRegionSummary } from "../writebackStore";

type Region = {
  regionId: string;
  sheetId: string;
  rowStart: number;
  rowEnd: number;
  colStart: number;
  colEnd: number;
};

type Summary = WritebackRegionSummary;

const h = vi.hoisted(() => ({
  registerPanel: vi.fn(),
  unregisterPanel: vi.fn(),
  setBadge: vi.fn(),
  openTaskPane: vi.fn(),
  showTaskPaneContainer: vi.fn(),
  refreshGridData: vi.fn(),
  owned: false,
  refuseIfSelectionOwned: vi.fn(() => false),
  /** Core's grid snapshot selection (null: not mounted). */
  selection: null as null | { startRow: number; startCol: number; endRow: number; endCol: number },
  /** Which sheet is active, as the store resolves it. */
  activeSheetId: "local-2",
  regions: [] as Region[],
  summaries: new Map<string, Summary>(),
  totalUnsent: 0,
  refreshWriteback: vi.fn(async () => {}),
  previewRegionSubmission: vi.fn(),
  submitRegion: vi.fn(),
  submitAllRegions: vi.fn(),
  discardWritebackDrafts: vi.fn(),
  reconcileWriteback: vi.fn(),
  /** What the store says about its last read's reconcile / read. */
  reconcileError: null as string | null,
  refreshError: null as string | null,
  confirmAsync: vi.fn(),
  alertAsync: vi.fn(async () => {}),
  showToast: vi.fn(),
  emitAppEvent: vi.fn(),
}));

vi.mock("@api/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/ui")>()),
  registerPanel: (...a: unknown[]) => h.registerPanel(...a),
  unregisterPanel: (...a: unknown[]) => h.unregisterPanel(...a),
  PanelExtensions: { setBadge: (...a: unknown[]) => h.setBadge(...a) },
  openTaskPane: (...a: unknown[]) => h.openTaskPane(...a),
  showTaskPaneContainer: () => h.showTaskPaneContainer(),
}));
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => (h.selection ? { selection: h.selection } : null),
  refreshGridData: () => h.refreshGridData(),
}));
vi.mock("@api/selectionOwner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/selectionOwner")>()),
  isSelectionOwned: () => h.owned,
  refuseIfSelectionOwned: (...a: unknown[]) => h.refuseIfSelectionOwned(...(a as [])),
}));
vi.mock("@api/collaboration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/collaboration")>()),
  previewRegionSubmission: (...a: unknown[]) => h.previewRegionSubmission(...a),
  submitRegion: (...a: unknown[]) => h.submitRegion(...a),
  submitAllRegions: (...a: unknown[]) => h.submitAllRegions(...a),
  discardWritebackDrafts: (...a: unknown[]) => h.discardWritebackDrafts(...a),
  reconcileWriteback: (...a: unknown[]) => h.reconcileWriteback(...a),
}));
vi.mock("@api/dialogs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/dialogs")>()),
  confirmAsync: (...a: unknown[]) => h.confirmAsync(...a),
  alertAsync: (...a: unknown[]) => h.alertAsync(...(a as [])),
}));
vi.mock("@api/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/notifications")>()),
  showToast: (...a: unknown[]) => h.showToast(...a),
}));
vi.mock("@api/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/events")>()),
  emitAppEvent: (...a: unknown[]) => h.emitAppEvent(...a),
}));
vi.mock("../writebackStore", () => {
  const inRegion = (r: Region, row: number, col: number) =>
    row >= r.rowStart && row <= r.rowEnd && col >= r.colStart && col <= r.colEnd;
  return {
    subscribeWritebackSnapshot: () => () => {},
    getWritebackSnapshotVersion: () => 0,
    hasWritebackRegions: () => h.regions.length > 0,
    getActiveRegionAt: (row: number, col: number) =>
      h.regions.find((r) => r.sheetId === h.activeSheetId && inRegion(r, row, col)) ?? null,
    getRegionSummary: (id: string) => h.summaries.get(id) ?? null,
    listRegionSummaries: () => Array.from(h.summaries.values()),
    totalUnsentDrafts: () => h.totalUnsent,
    refreshWriteback: () => h.refreshWriteback(),
    getWritebackReconcileError: () => h.reconcileError,
    getWritebackRefreshError: () => h.refreshError,
  };
});

import {
  handleWritebackSelectionChange,
  syncWritebackTabToRegions,
  resetWritebackTab,
  isWritebackTabShown,
} from "../writebackTab";
import {
  resetWritebackTabModel,
  setWritebackTabRegionId,
  getWritebackTabRegionId,
  submitButtonState,
  submitAllButtonState,
  discardButtonState,
  statusLinesFor,
  outboundConfirmText,
  submitWritebackRegion,
  submitAllWriteback,
  discardWritebackRegionDrafts,
  checkWritebackStatus,
} from "../writebackTabModel";
import {
  WritebackPanelDefinition,
  WRITEBACK_TAB_ID,
  WRITEBACK_MENU_ID,
  WRITEBACK_PANE_ID,
} from "../../manifest";
import { WritebackSubmitSection, WritebackDraftsSection } from "../../components/WritebackTabSections";

const REGION: Region = {
  regionId: "r1",
  sheetId: "local-2",
  rowStart: 2,
  rowEnd: 4,
  colStart: 1,
  colEnd: 1,
};

function summary(over: Partial<Summary> = {}): Summary {
  return {
    regionId: "r1",
    applicationName: "writeback-test",
    registryUrl: "C:/ws",
    sheetId: "local-2",
    sheetName: "Report",
    rangeA1: "B3:B5",
    draftCount: 2,
    submittedCount: 0,
    approvedCount: 0,
    rejectedCount: 0,
    emptyCount: 1,
    visibility: "own_plus_aggregate",
    submissionPolicy: "on_submit",
    region: REGION as unknown as WritebackRegionSummary["region"],
    ...over,
  };
}

function preview(over: Record<string, unknown> = {}) {
  return {
    regionId: "r1",
    packageName: "writeback-test",
    resolvedVersion: "1.0.0",
    registryPath: "C:/ws",
    submitterId: "u1",
    submitterName: "Dana",
    values: [
      { cellRow: 2, cellCol: 1, valueDisplay: "1", valueKind: "number" },
      { cellRow: 3, cellCol: 1, valueDisplay: "2", valueKind: "number" },
    ],
    ...over,
  };
}

const lastRegisterCount = () => h.registerPanel.mock.calls.length;

beforeEach(() => {
  resetWritebackTab();
  resetWritebackTabModel();
  vi.clearAllMocks();
  h.owned = false;
  h.selection = null;
  h.activeSheetId = "local-2";
  h.regions = [REGION];
  h.summaries = new Map([["r1", summary()]]);
  h.totalUnsent = 2;
  h.refuseIfSelectionOwned.mockImplementation(() => false);
  h.refreshWriteback.mockImplementation(async () => {});
  h.reconcileError = null;
  h.refreshError = null;
});

// ===========================================================================
// Visibility
// ===========================================================================

describe("the Writeback tab follows Core's active cell", () => {
  it("appears inside a region, once, and leaves outside it", () => {
    handleWritebackSelectionChange({ endRow: 3, endCol: 1 });
    expect(h.registerPanel).toHaveBeenCalledTimes(1);
    expect(h.registerPanel.mock.calls[0][0]).toBe(WritebackPanelDefinition);
    expect(isWritebackTabShown()).toBe(true);
    expect(getWritebackTabRegionId()).toBe("r1");

    // Moving within the region registers nothing twice.
    handleWritebackSelectionChange({ endRow: 4, endCol: 1 });
    expect(h.registerPanel).toHaveBeenCalledTimes(1);

    handleWritebackSelectionChange({ endRow: 0, endCol: 0 });
    expect(h.unregisterPanel).toHaveBeenCalledWith(WRITEBACK_TAB_ID);
    expect(isWritebackTabShown()).toBe(false);
    expect(getWritebackTabRegionId()).toBeNull();
  });

  it("a sheet change re-derives for the same coordinates on the new sheet", () => {
    h.selection = { startRow: 3, startCol: 1, endRow: 3, endCol: 1 };
    handleWritebackSelectionChange({ endRow: 3, endCol: 1 });
    expect(isWritebackTabShown()).toBe(true);

    // B4 on ANOTHER sheet: the cursor's coordinates did not change.
    h.activeSheetId = "local-1";
    syncWritebackTabToRegions();
    expect(isWritebackTabShown()).toBe(false);
    expect(h.unregisterPanel).toHaveBeenCalledWith(WRITEBACK_TAB_ID);

    h.activeSheetId = "local-2";
    syncWritebackTabToRegions();
    expect(isWritebackTabShown()).toBe(true);
  });

  it("re-derives when the region list changes under a cursor that did not move", () => {
    // A subscribe has not landed yet: no regions, no tab.
    h.regions = [];
    h.selection = { startRow: 2, startCol: 1, endRow: 2, endCol: 1 };
    handleWritebackSelectionChange({ endRow: 2, endCol: 1 });
    expect(isWritebackTabShown()).toBe(false);

    // The subscribe's snapshot arrives; the cursor is still on B3.
    h.regions = [REGION];
    syncWritebackTabToRegions();
    expect(isWritebackTabShown()).toBe(true);

    // A detach takes the regions away again; the tab must not outlive them.
    h.regions = [];
    syncWritebackTabToRegions();
    expect(isWritebackTabShown()).toBe(false);
  });

  it("with no readable cursor at all, no tab is shown and no region is addressed", () => {
    // Before the grid mounted and before Core announced any cell: a stale
    // region id must not survive for the tab's buttons to act on.
    setWritebackTabRegionId("r1");
    h.selection = null;
    syncWritebackTabToRegions();
    expect(isWritebackTabShown()).toBe(false);
    expect(h.registerPanel).not.toHaveBeenCalled();
    expect(getWritebackTabRegionId()).toBeNull();
  });

  it("the grid's own cursor wins over the last announced cell", () => {
    handleWritebackSelectionChange({ endRow: 2, endCol: 1 });
    expect(isWritebackTabShown()).toBe(true);
    // Core moved to A1 without this handler hearing it (an owner's claim
    // ended on another cell): the snapshot is the truth.
    h.selection = { startRow: 0, startCol: 0, endRow: 0, endCol: 0 };
    syncWritebackTabToRegions();
    expect(isWritebackTabShown()).toBe(false);
  });

  it("stands aside while a selection owner holds the selection, and returns when it ends", () => {
    h.selection = { startRow: 3, startCol: 1, endRow: 3, endCol: 1 };
    handleWritebackSelectionChange({ endRow: 3, endCol: 1 });
    expect(isWritebackTabShown()).toBe(true);

    h.owned = true; // a floating grid's cell took the selection
    syncWritebackTabToRegions();
    expect(isWritebackTabShown()).toBe(false);
    expect(h.unregisterPanel).toHaveBeenCalledWith(WRITEBACK_TAB_ID);

    const before = lastRegisterCount();
    h.owned = false;
    syncWritebackTabToRegions();
    expect(isWritebackTabShown()).toBe(true);
    expect(lastRegisterCount()).toBe(before + 1);
  });
});

describe("the tab badge counts unsent values across the workbook", () => {
  it("shows the count, and clears at zero and when the tab leaves", () => {
    h.totalUnsent = 3;
    handleWritebackSelectionChange({ endRow: 2, endCol: 1 });
    expect(h.setBadge).toHaveBeenLastCalledWith(WRITEBACK_TAB_ID, "3");

    h.totalUnsent = 0;
    h.selection = { startRow: 2, startCol: 1, endRow: 2, endCol: 1 };
    syncWritebackTabToRegions();
    expect(h.setBadge).toHaveBeenLastCalledWith(WRITEBACK_TAB_ID, null);

    h.totalUnsent = 5;
    syncWritebackTabToRegions();
    expect(h.setBadge).toHaveBeenLastCalledWith(WRITEBACK_TAB_ID, "5");

    handleWritebackSelectionChange({ endRow: 0, endCol: 0 });
    expect(h.setBadge).toHaveBeenLastCalledWith(WRITEBACK_TAB_ID, null);
  });
});

// ===========================================================================
// Disabled with a reason
// ===========================================================================

describe("Submit and Discard are disabled with a reason", () => {
  it("Submit: enabled with how many and to which application; disabled at zero and with no region", () => {
    expect(submitButtonState(summary())).toEqual({
      disabled: false,
      tooltip: 'Send 2 values in B3:B5 to "writeback-test"',
    });
    const none = submitButtonState(summary({ draftCount: 0 }));
    expect(none.disabled).toBe(true);
    expect(none.tooltip).toMatch(/^Nothing to send/);
    const away = submitButtonState(null);
    expect(away.disabled).toBe(true);
    expect(away.tooltip).toMatch(/Select a cell in a writeback region/);
    expect(submitAllButtonState(0).disabled).toBe(true);
    expect(submitAllButtonState(4)).toEqual({
      disabled: false,
      tooltip: "Send all 4 values not yet sent, in every writeback region",
    });
  });

  it("Discard: disabled with the reason at zero", () => {
    expect(discardButtonState(summary()).disabled).toBe(false);
    const none = discardButtonState(summary({ draftCount: 0 }));
    expect(none.disabled).toBe(true);
    expect(none.tooltip).toBe("Nothing to discard: B3:B5 has no unsent values");
  });

  it("the rendered heroes carry `disabled` and the reason as their title", () => {
    h.summaries = new Map([["r1", summary({ draftCount: 0 })]]);
    h.totalUnsent = 0;
    setWritebackTabRegionId("r1");
    const submit = renderToStaticMarkup(<WritebackSubmitSection placement="ribbon" />);
    expect(submit).toMatch(/data-testid="writeback-tab-submit"[^>]*disabled|disabled[^>]*data-testid="writeback-tab-submit"/);
    expect(submit).toContain("Nothing to send");
    const drafts = renderToStaticMarkup(<WritebackDraftsSection placement="ribbon" />);
    expect(drafts).toContain("Nothing to discard: B3:B5 has no unsent values");

    h.summaries = new Map([["r1", summary({ draftCount: 2 })]]);
    h.totalUnsent = 2;
    const live = renderToStaticMarkup(<WritebackSubmitSection placement="ribbon" />);
    expect(live).toContain("Send 2 values in B3:B5 to &quot;writeback-test&quot;");
    expect(live).not.toMatch(/data-testid="writeback-tab-submit"[^>]*disabled=""/);
  });
});

// ===========================================================================
// Status words
// ===========================================================================

describe("Status lines", () => {
  it("say what the region's state is and who sees the input", () => {
    expect(statusLinesFor(summary())).toEqual([
      { tone: "warn", text: "2 not sent" },
      // NOT "others see only totals": the read side gives other subscribers
      // every value, with the name replaced (apply_gather_governance).
      {
        tone: "info",
        text: "The publisher sees your values; other subscribers see each value without your name",
      },
    ]);
    // on_submit: a sent value counts at once -- there is no review to wait for.
    expect(statusLinesFor(summary({ draftCount: 0, submittedCount: 3, emptyCount: 0 }))[0]).toEqual({
      tone: "ok",
      text: "Sent - the publisher can see them",
    });
    // on_approval: it waits for the publisher.
    expect(
      statusLinesFor(
        summary({ draftCount: 0, submittedCount: 3, emptyCount: 0, submissionPolicy: "on_approval" }),
      )[0],
    ).toEqual({ tone: "info", text: "Sent - waiting for the publisher's approval" });
    // "All sent" is never said while cells are still empty.
    expect(statusLinesFor(summary({ draftCount: 0, submittedCount: 1, emptyCount: 2 }))[0].text).toBe(
      "Sent - the publisher can see them (1 of 3 filled)",
    );
    // immediate: typing sends.
    expect(
      statusLinesFor(summary({ draftCount: 0, emptyCount: 3, submissionPolicy: "immediate" }))[0].text,
    ).toBe("Nothing entered yet - values are sent as you type");
    expect(statusLinesFor(summary({ draftCount: 0, rejectedCount: 1 }))[0]).toEqual({
      tone: "danger",
      text: "1 rejected - fix and submit again",
    });
    expect(statusLinesFor(summary({ draftCount: 0, approvedCount: 3, emptyCount: 0 }))[0]).toEqual({
      tone: "ok",
      text: "All approved",
    });
    expect(statusLinesFor(summary({ visibility: "own_only" }))[1].text).toBe(
      "Only the publisher sees your values",
    );
    expect(statusLinesFor(summary({ visibility: "transparent" }))[1].text).toBe(
      "Everyone subscribed can see your values",
    );
    const due = statusLinesFor(summary({ deadline: "2026-10-30T12:00:00Z" }))[0].text;
    expect(due).toMatch(/^2 not sent - due .+/);
  });

  it("the submit confirm lists the values, the workspace and who sends them", () => {
    const text = outboundConfirmText([preview() as never]);
    expect(text).toContain('Send 2 values to "writeback-test"?');
    expect(text).toContain("Workspace: C:/ws");
    expect(text).toContain("Sent as: Dana");
    expect(text).toContain("  B3 = 1");
    expect(text).toContain("  B4 = 2");
  });
});

// ===========================================================================
// Actions
// ===========================================================================

describe("Submit", () => {
  it("previews, asks, sends, re-reads, then toasts -- in that order", async () => {
    h.previewRegionSubmission.mockResolvedValue(preview());
    h.confirmAsync.mockReturnValue(Promise.resolve(true));
    h.submitRegion.mockResolvedValue(2);

    await submitWritebackRegion("r1");

    expect(h.confirmAsync).toHaveBeenCalledTimes(1);
    expect(String(h.confirmAsync.mock.calls[0][0])).toContain("B3 = 1");
    expect(h.submitRegion).toHaveBeenCalledWith("r1");
    expect(h.refreshWriteback).toHaveBeenCalledTimes(1);
    const confirmAt = h.confirmAsync.mock.invocationCallOrder[0];
    const submitAt = h.submitRegion.mock.invocationCallOrder[0];
    const refreshAt = h.refreshWriteback.mock.invocationCallOrder[0];
    expect(confirmAt).toBeLessThan(submitAt);
    expect(submitAt).toBeLessThan(refreshAt);
    expect(h.showToast).toHaveBeenCalledWith(
      "2 values sent to writeback-test. The publisher can now see them.",
      expect.objectContaining({ type: "success" }),
    );
  });

  it("a refused confirm (the Tauri shape: a Promise of false) sends nothing", async () => {
    h.previewRegionSubmission.mockResolvedValue(preview());
    h.confirmAsync.mockReturnValue(Promise.resolve(false));

    await submitWritebackRegion("r1");

    expect(h.confirmAsync).toHaveBeenCalledTimes(1);
    expect(h.submitRegion).not.toHaveBeenCalled();
    expect(h.showToast).not.toHaveBeenCalled();
  });

  it("a backend refusal is toasted, and the snapshot is still re-read", async () => {
    h.previewRegionSubmission.mockResolvedValue(preview());
    h.confirmAsync.mockReturnValue(Promise.resolve(true));
    h.submitRegion.mockRejectedValue(new Error("Value in B4 is not a number"));

    await submitWritebackRegion("r1");

    expect(h.showToast).toHaveBeenCalledWith(
      "Could not submit: Value in B4 is not a number",
      expect.objectContaining({ type: "error" }),
    );
    expect(h.refreshWriteback).toHaveBeenCalledTimes(1);
  });

  it("an unapproved publisher check stops before the confirm and opens the pane", async () => {
    h.previewRegionSubmission.mockResolvedValue(
      preview({ validator: { name: "range", source: "", sourceHash: "x", consented: false } }),
    );

    await submitWritebackRegion("r1");

    expect(h.alertAsync).toHaveBeenCalledTimes(1);
    expect(h.confirmAsync).not.toHaveBeenCalled();
    expect(h.submitRegion).not.toHaveBeenCalled();
    expect(h.openTaskPane).toHaveBeenCalledWith(WRITEBACK_PANE_ID);
  });

  it("a failed preview sends nothing (fail closed)", async () => {
    h.previewRegionSubmission.mockRejectedValue(new Error("workspace offline"));

    await submitWritebackRegion("r1");

    expect(h.confirmAsync).not.toHaveBeenCalled();
    expect(h.submitRegion).not.toHaveBeenCalled();
    expect(h.showToast).toHaveBeenCalledWith(
      expect.stringContaining("workspace offline"),
      expect.objectContaining({ type: "error" }),
    );
  });

  it("is refused while a selection owner holds the selection", async () => {
    h.refuseIfSelectionOwned.mockImplementation(() => true);
    await submitWritebackRegion("r1");
    expect(h.previewRegionSubmission).not.toHaveBeenCalled();
    expect(h.submitRegion).not.toHaveBeenCalled();
  });

  it("Submit All confirms once over every region with drafts, then sends", async () => {
    h.previewRegionSubmission.mockResolvedValue(preview());
    h.confirmAsync.mockReturnValue(Promise.resolve(true));
    h.submitAllRegions.mockResolvedValue(2);

    await submitAllWriteback();

    expect(h.confirmAsync).toHaveBeenCalledTimes(1);
    expect(h.submitAllRegions).toHaveBeenCalledTimes(1);
    expect(h.refreshWriteback).toHaveBeenCalledTimes(1);
    expect(h.showToast).toHaveBeenCalledWith(
      "2 values sent to writeback-test. The publisher can now see them.",
      expect.objectContaining({ type: "success" }),
    );
  });

  it("Submit All refused sends nothing", async () => {
    h.previewRegionSubmission.mockResolvedValue(preview());
    h.confirmAsync.mockReturnValue(Promise.resolve(false));
    await submitAllWriteback();
    expect(h.submitAllRegions).not.toHaveBeenCalled();
  });
});

describe("Discard Drafts and Check Status", () => {
  it("Discard asks first, then discards, re-fetches the cells and re-reads", async () => {
    h.confirmAsync.mockReturnValue(Promise.resolve(true));
    h.discardWritebackDrafts.mockResolvedValue({ discarded: 2, restoredCells: [] });

    await discardWritebackRegionDrafts("r1");

    expect(String(h.confirmAsync.mock.calls[0][0])).toContain("cannot be undone");
    expect(h.discardWritebackDrafts).toHaveBeenCalledWith("r1");
    expect(h.refreshGridData).toHaveBeenCalledTimes(1);
    expect(h.refreshWriteback).toHaveBeenCalledTimes(1);
    expect(h.showToast).toHaveBeenCalledWith("2 values discarded.", expect.objectContaining({ type: "success" }));
  });

  it("a refused Discard (Promise of false) discards nothing", async () => {
    h.confirmAsync.mockReturnValue(Promise.resolve(false));
    await discardWritebackRegionDrafts("r1");
    expect(h.discardWritebackDrafts).not.toHaveBeenCalled();
    expect(h.refreshGridData).not.toHaveBeenCalled();
  });

  it("Check Status is ONE re-read (the store's read reconciles), and says so", async () => {
    await checkWritebackStatus();
    // No reconcile of its own: the store's read already asks the workspace,
    // so a second call was a second (HTTP) round-trip.
    expect(h.reconcileWriteback).not.toHaveBeenCalled();
    expect(h.refreshWriteback).toHaveBeenCalledTimes(1);
    expect(h.showToast).toHaveBeenCalledWith("Status updated", expect.objectContaining({ type: "success" }));
  });

  it("Check Status with the workspace unreachable warns instead of claiming an update", async () => {
    h.refreshWriteback.mockImplementation(async () => {
      h.reconcileError = "offline";
    });
    await checkWritebackStatus();
    expect(h.showToast).toHaveBeenCalledWith(
      expect.stringContaining("Could not reach the workspace"),
      expect.objectContaining({ type: "warning" }),
    );
    expect(h.showToast).not.toHaveBeenCalledWith("Status updated", expect.anything());
  });
});

// ===========================================================================
// Identity of the panel
// ===========================================================================

function svgOf(node: React.ReactNode): string {
  return renderToStaticMarkup(<>{node}</>);
}

describe("WritebackPanelDefinition", () => {
  it("keeps its identity: id, label, order, accent, section ids", () => {
    expect(WritebackPanelDefinition.id).toBe("writeback-tab");
    expect(WRITEBACK_TAB_ID).not.toBe(WRITEBACK_MENU_ID);
    expect(WritebackPanelDefinition.title).toBe("Writeback");
    expect(WritebackPanelDefinition.defaultPlacement).toBe("ribbon");
    expect(WritebackPanelDefinition.ribbonOrder).toBe(512);
    expect(WritebackPanelDefinition.ribbonColor).toBe("var(--tab-accent-writeback, #4338ca)");
    expect(WritebackPanelDefinition.ribbonActivateOnRegister).toBeUndefined();
    expect(WritebackPanelDefinition.sections.map((s) => [s.id, s.label])).toEqual([
      ["writeback-tab.submit", "Submit"],
      ["writeback-tab.drafts", "Drafts"],
      ["writeback-tab.status", "Status"],
      ["writeback-tab.responses", "Responses"],
    ]);
  });

  it("has a 20px panel icon and a 24px icon on every section, all from the 24-grid set", () => {
    const panel = svgOf(WritebackPanelDefinition.icon);
    expect(panel).toContain('viewBox="0 0 24 24"');
    expect(panel).toContain('width="20"');
    for (const section of WritebackPanelDefinition.sections) {
      const svg = svgOf(section.icon);
      expect(svg, section.id).toContain('viewBox="0 0 24 24"');
      expect(svg, section.id).toContain('width="24"');
    }
  });

  it("the soak/invariant walk knows the tab's label (it skips labels it does not know)", () => {
    const invariants = fs.readFileSync(
      path.resolve(__dirname, "../../../../e2e/invariants/invariants.ts"),
      "utf8",
    );
    expect(invariants).toContain("\n  Writeback: {");
  });
});
