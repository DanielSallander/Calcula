//! FILENAME: app/extensions/Protection/lib/__tests__/protectionStore.test.ts
// PURPOSE: Tests for the protection store state management.

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock @api before importing the store
vi.mock("@api", () => ({
  getProtectionStatus: vi.fn(),
  isWorkbookProtected: vi.fn(),
  DEFAULT_PROTECTION_OPTIONS: {
    selectLockedCells: true,
    selectUnlockedCells: true,
    formatCells: false,
    formatColumns: false,
    formatRows: false,
    insertColumns: false,
    insertRows: false,
    insertHyperlinks: false,
    deleteColumns: false,
    deleteRows: false,
    sort: false,
    useAutoFilter: false,
    usePivotTableReports: false,
    editObjects: false,
    editScenarios: false,
  },
}));

import {
  isCurrentSheetProtected,
  currentSheetHasPassword,
  getSheetOptions,
  isCurrentWorkbookProtected,
  setSheetProtectedState,
  setWorkbookProtectedState,
  resetProtectionState,
  refreshProtectionState,
} from "../protectionStore";
import { getProtectionStatus, isWorkbookProtected } from "@api";

// ============================================================================
// Tests
// ============================================================================

describe("protectionStore", () => {
  beforeEach(() => {
    resetProtectionState();
    vi.clearAllMocks();
  });

  describe("initial state", () => {
    it("sheet is not protected by default", () => {
      expect(isCurrentSheetProtected()).toBe(false);
    });

    it("sheet has no password by default", () => {
      expect(currentSheetHasPassword()).toBe(false);
    });

    it("workbook is not protected by default", () => {
      expect(isCurrentWorkbookProtected()).toBe(false);
    });

    it("returns default options", () => {
      const opts = getSheetOptions();
      expect(opts.selectLockedCells).toBe(true);
      expect(opts.selectUnlockedCells).toBe(true);
      expect(opts.formatCells).toBe(false);
    });
  });

  describe("setSheetProtectedState", () => {
    it("sets sheet as protected with password", () => {
      const opts = {
        selectLockedCells: false,
        selectUnlockedCells: true,
        formatCells: true,
        formatColumns: false,
        formatRows: false,
        insertColumns: false,
        insertRows: false,
        insertHyperlinks: false,
        deleteColumns: false,
        deleteRows: false,
        sort: false,
        useAutoFilter: false,
        usePivotTableReports: false,
        editObjects: false,
        editScenarios: false,
      };

      setSheetProtectedState(true, true, opts);

      expect(isCurrentSheetProtected()).toBe(true);
      expect(currentSheetHasPassword()).toBe(true);
      expect(getSheetOptions().selectLockedCells).toBe(false);
      expect(getSheetOptions().formatCells).toBe(true);
    });

    it("can unprotect sheet", () => {
      const defaultOpts = getSheetOptions();
      setSheetProtectedState(true, true, defaultOpts);
      expect(isCurrentSheetProtected()).toBe(true);

      setSheetProtectedState(false, false, defaultOpts);
      expect(isCurrentSheetProtected()).toBe(false);
      expect(currentSheetHasPassword()).toBe(false);
    });
  });

  describe("setWorkbookProtectedState", () => {
    it("sets workbook as protected", () => {
      setWorkbookProtectedState(true);
      expect(isCurrentWorkbookProtected()).toBe(true);
    });

    it("can unprotect workbook", () => {
      setWorkbookProtectedState(true);
      setWorkbookProtectedState(false);
      expect(isCurrentWorkbookProtected()).toBe(false);
    });
  });

  describe("resetProtectionState", () => {
    it("resets all state to defaults", () => {
      const opts = getSheetOptions();
      setSheetProtectedState(true, true, { ...opts, formatCells: true });
      setWorkbookProtectedState(true);

      resetProtectionState();

      expect(isCurrentSheetProtected()).toBe(false);
      expect(currentSheetHasPassword()).toBe(false);
      expect(isCurrentWorkbookProtected()).toBe(false);
      expect(getSheetOptions().formatCells).toBe(false);
    });
  });

  describe("refreshProtectionState", () => {
    it("fetches state from backend APIs", async () => {
      const mockStatus = {
        isProtected: true,
        hasPassword: true,
        options: {
          selectLockedCells: false,
          selectUnlockedCells: true,
          formatCells: true,
          formatColumns: false,
          formatRows: false,
          insertColumns: false,
          insertRows: false,
          insertHyperlinks: false,
          deleteColumns: false,
          deleteRows: false,
          sort: false,
          useAutoFilter: false,
          usePivotTableReports: false,
          editObjects: false,
          editScenarios: false,
        },
      };
      vi.mocked(getProtectionStatus).mockResolvedValue(mockStatus);
      vi.mocked(isWorkbookProtected).mockResolvedValue(true);

      await refreshProtectionState();

      expect(isCurrentSheetProtected()).toBe(true);
      expect(currentSheetHasPassword()).toBe(true);
      expect(getSheetOptions().formatCells).toBe(true);
      expect(isCurrentWorkbookProtected()).toBe(true);
    });

    it("handles sheet protection fetch error gracefully", async () => {
      vi.mocked(getProtectionStatus).mockRejectedValue(new Error("network"));
      vi.mocked(isWorkbookProtected).mockResolvedValue(false);

      // Should not throw
      await refreshProtectionState();

      // State remains at defaults
      expect(isCurrentSheetProtected()).toBe(false);
    });

    it("handles workbook protection fetch error gracefully", async () => {
      vi.mocked(getProtectionStatus).mockResolvedValue({
        isProtected: false,
        hasPassword: false,
        options: getSheetOptions(),
      });
      vi.mocked(isWorkbookProtected).mockRejectedValue(new Error("network"));

      await refreshProtectionState();
      expect(isCurrentWorkbookProtected()).toBe(false);
    });
  });

  describe("options are independent copies", () => {
    it("getSheetOptions returns a copy after reset", () => {
      const opts1 = getSheetOptions();
      resetProtectionState();
      const opts2 = getSheetOptions();
      // Different object references after reset
      expect(opts1).not.toBe(opts2);
    });
  });
});
