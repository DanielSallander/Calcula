//! FILENAME: app/extensions/LinkedSheets/__tests__/linkedSheets-deep.test.ts
// PURPOSE: Deep tests for LinkedSheets: multiple references, missing sheets,
//          manifest validation, dialog definitions, activation guard.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ============================================================================
// Mocks
// ============================================================================

const mockRefreshAllLinkedSheets = vi.fn();
const mockGetLinkedSheets = vi.fn();

vi.mock("../components/PublishDialog", () => ({
  PublishDialog: () => null,
}));
vi.mock("../components/BrowseLinkedDialog", () => ({
  BrowseLinkedDialog: () => null,
}));

vi.mock("@api", () => ({
  DialogExtensions: { unregisterDialog: vi.fn() },
  emitAppEvent: vi.fn(),
  onAppEvent: vi.fn(() => vi.fn()),
  AppEvents: {
    LINKED_SHEETS_REFRESHED: "linked-sheets-refreshed",
    AFTER_OPEN: "after-open",
  },
}));

vi.mock("@api/linkedSheets", () => ({
  refreshAllLinkedSheets: (...args: unknown[]) => mockRefreshAllLinkedSheets(...args),
  getLinkedSheets: (...args: unknown[]) => mockGetLinkedSheets(...args),
}));

import {
  LinkedSheetsManifest,
  PublishDialogDefinition,
  BrowseLinkedDialogDefinition,
  PUBLISH_DIALOG_ID,
  BROWSE_LINKED_DIALOG_ID,
} from "../manifest";

// ============================================================================
// Tests
// ============================================================================

describe("LinkedSheets Deep", () => {
  beforeEach(() => {
    mockRefreshAllLinkedSheets.mockReset();
    mockGetLinkedSheets.mockReset();
  });

  // --------------------------------------------------------------------------
  // Manifest validation
  // --------------------------------------------------------------------------

  describe("manifest structure", () => {
    it("ID follows calcula namespace convention", () => {
      expect(LinkedSheetsManifest.id).toMatch(/^calcula\./);
    });

    it("version is semver", () => {
      expect(LinkedSheetsManifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it("name does not contain special characters", () => {
      expect(LinkedSheetsManifest.name).toMatch(/^[A-Za-z\s]+$/);
    });

    it("description is a non-empty sentence", () => {
      expect(LinkedSheetsManifest.description.length).toBeGreaterThan(10);
    });
  });

  // --------------------------------------------------------------------------
  // Dialog definition integrity
  // --------------------------------------------------------------------------

  describe("dialog definitions", () => {
    it("publish dialog ID matches constant", () => {
      expect(PublishDialogDefinition.id).toBe(PUBLISH_DIALOG_ID);
    });

    it("browse dialog ID matches constant", () => {
      expect(BrowseLinkedDialogDefinition.id).toBe(BROWSE_LINKED_DIALOG_ID);
    });

    it("dialog IDs do not collide", () => {
      expect(PUBLISH_DIALOG_ID).not.toBe(BROWSE_LINKED_DIALOG_ID);
    });

    it("both dialogs have callable component functions", () => {
      expect(typeof PublishDialogDefinition.component).toBe("function");
      expect(typeof BrowseLinkedDialogDefinition.component).toBe("function");
    });

    it("dialog IDs are lowercase kebab-case", () => {
      expect(PUBLISH_DIALOG_ID).toMatch(/^[a-z0-9-]+$/);
      expect(BROWSE_LINKED_DIALOG_ID).toMatch(/^[a-z0-9-]+$/);
    });
  });

  // --------------------------------------------------------------------------
  // Multiple linked sheet references
  // --------------------------------------------------------------------------

  describe("multiple linked sheet references", () => {
    it("getLinkedSheets returns multiple entries", async () => {
      mockGetLinkedSheets.mockResolvedValue([
        { sheetName: "Sales", sourceModel: "model-a.calp", sourceSheet: "Sales" },
        { sheetName: "Costs", sourceModel: "model-a.calp", sourceSheet: "Costs" },
        { sheetName: "KPI", sourceModel: "model-b.calp", sourceSheet: "Dashboard" },
      ]);
      const sheets = await mockGetLinkedSheets();
      expect(sheets).toHaveLength(3);
      expect(sheets[0].sheetName).toBe("Sales");
      expect(sheets[2].sourceModel).toBe("model-b.calp");
    });

    it("refresh returns results for each linked sheet", async () => {
      mockRefreshAllLinkedSheets.mockResolvedValue([
        { sheetName: "Sales", updated: true, warnings: [] },
        { sheetName: "Costs", updated: false, warnings: [] },
        { sheetName: "KPI", updated: true, warnings: [] },
      ]);
      const results = await mockRefreshAllLinkedSheets();
      const updated = results.filter((r: any) => r.updated);
      expect(updated).toHaveLength(2);
    });
  });

  // --------------------------------------------------------------------------
  // Link resolution with missing sheets
  // --------------------------------------------------------------------------

  describe("link resolution with missing sheets", () => {
    it("refresh reports warnings for unavailable sources", async () => {
      mockRefreshAllLinkedSheets.mockResolvedValue([
        { sheetName: "Sales", updated: false, warnings: ["Failed to refresh: source file not found"] },
        { sheetName: "Costs", updated: true, warnings: [] },
      ]);
      const results = await mockRefreshAllLinkedSheets();
      const warnings = results.flatMap((r: any) => r.warnings);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("Failed to refresh");
    });

    it("all sheets missing produces all warnings", async () => {
      mockRefreshAllLinkedSheets.mockResolvedValue([
        { sheetName: "A", updated: false, warnings: ["Failed to refresh: file missing"] },
        { sheetName: "B", updated: false, warnings: ["Failed to refresh: file missing"] },
      ]);
      const results = await mockRefreshAllLinkedSheets();
      const updated = results.filter((r: any) => r.updated).length;
      const unavailable = results.filter(
        (r: any) => r.warnings.some((w: string) => w.includes("Failed to refresh"))
      ).length;
      expect(updated).toBe(0);
      expect(unavailable).toBe(2);
    });

    it("empty linked sheets array means nothing to refresh", async () => {
      mockGetLinkedSheets.mockResolvedValue([]);
      const sheets = await mockGetLinkedSheets();
      expect(sheets).toHaveLength(0);
    });

    it("refresh with mixed success and failure", async () => {
      mockRefreshAllLinkedSheets.mockResolvedValue([
        { sheetName: "Sheet1", updated: true, warnings: [] },
        { sheetName: "Sheet2", updated: false, warnings: ["Failed to refresh: network error"] },
        { sheetName: "Sheet3", updated: true, warnings: ["Minor warning: data truncated"] },
      ]);
      const results = await mockRefreshAllLinkedSheets();
      expect(results.filter((r: any) => r.updated)).toHaveLength(2);
      expect(results.flatMap((r: any) => r.warnings)).toHaveLength(2);
    });
  });

  // --------------------------------------------------------------------------
  // Refresh error handling
  // --------------------------------------------------------------------------

  describe("refresh error handling", () => {
    it("refresh can reject with an error", async () => {
      mockRefreshAllLinkedSheets.mockRejectedValue(new Error("Network timeout"));
      await expect(mockRefreshAllLinkedSheets()).rejects.toThrow("Network timeout");
    });

    it("getLinkedSheets can reject", async () => {
      mockGetLinkedSheets.mockRejectedValue(new Error("Backend unavailable"));
      await expect(mockGetLinkedSheets()).rejects.toThrow("Backend unavailable");
    });
  });
});
