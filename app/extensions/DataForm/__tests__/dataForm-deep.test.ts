//! FILENAME: app/extensions/DataForm/__tests__/dataForm-deep.test.ts
// PURPOSE: Deep tests for DataForm - large field counts, data types,
//          navigation boundaries, region detection edge cases.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ============================================================================
// Mocks
// ============================================================================

const mockGetCurrentRegion = vi.fn();

vi.mock("@api", () => ({
  getCurrentRegion: (...args: unknown[]) => mockGetCurrentRegion(...args),
  ExtensionRegistry: {
    onSelectionChange: vi.fn(() => vi.fn()),
  },
}));

import {
  setCurrentSelection,
  registerDataFormMenuItem,
} from "../handlers/dataMenuBuilder";
import type { ExtensionContext } from "@api/contract";

// ============================================================================
// Helpers
// ============================================================================

function makeContext() {
  const showFn = vi.fn();
  const state: { action: (() => Promise<void>) | null } = { action: null };
  const context = {
    ui: {
      menus: {
        registerItem: vi.fn((_menu: string, item: { action: () => Promise<void> }) => {
          state.action = item.action;
        }),
      },
      dialogs: {
        register: vi.fn(),
        unregister: vi.fn(),
        show: showFn,
      },
    },
  } as unknown as ExtensionContext;
  return { context, showFn, state };
}

// ============================================================================
// Tests
// ============================================================================

describe("DataForm Deep", () => {
  beforeEach(() => {
    mockGetCurrentRegion.mockReset();
    setCurrentSelection(null);
  });

  // --------------------------------------------------------------------------
  // Form with 50+ fields (wide region)
  // --------------------------------------------------------------------------

  describe("form with 50+ fields", () => {
    it("opens dialog with region spanning 50 columns", async () => {
      const { context, showFn, state } = makeContext();
      registerDataFormMenuItem(context);

      setCurrentSelection({ activeRow: 1, activeCol: 0 });
      mockGetCurrentRegion.mockResolvedValue({
        empty: false,
        startRow: 0,
        startCol: 0,
        endRow: 100,
        endCol: 49,
      });

      await state.action!();

      expect(showFn).toHaveBeenCalledWith("data-form", {
        startRow: 0,
        startCol: 0,
        endRow: 100,
        endCol: 49,
      });
    });

    it("handles region with 100 columns", async () => {
      const { context, showFn, state } = makeContext();
      registerDataFormMenuItem(context);

      setCurrentSelection({ activeRow: 0, activeCol: 50 });
      mockGetCurrentRegion.mockResolvedValue({
        empty: false,
        startRow: 0,
        startCol: 0,
        endRow: 500,
        endCol: 99,
      });

      await state.action!();

      expect(showFn).toHaveBeenCalledWith("data-form", {
        startRow: 0,
        startCol: 0,
        endRow: 500,
        endCol: 99,
      });
    });
  });

  // --------------------------------------------------------------------------
  // Various data types per field
  // --------------------------------------------------------------------------

  describe("region detection with various data patterns", () => {
    it("single-row region (header only, no data rows)", async () => {
      const { context, showFn, state } = makeContext();
      registerDataFormMenuItem(context);

      setCurrentSelection({ activeRow: 0, activeCol: 0 });
      mockGetCurrentRegion.mockResolvedValue({
        empty: false,
        startRow: 0,
        startCol: 0,
        endRow: 0,
        endCol: 5,
      });

      await state.action!();

      expect(showFn).toHaveBeenCalledWith("data-form", {
        startRow: 0,
        startCol: 0,
        endRow: 0,
        endCol: 5,
      });
    });

    it("single-cell region", async () => {
      const { context, showFn, state } = makeContext();
      registerDataFormMenuItem(context);

      setCurrentSelection({ activeRow: 10, activeCol: 10 });
      mockGetCurrentRegion.mockResolvedValue({
        empty: false,
        startRow: 10,
        startCol: 10,
        endRow: 10,
        endCol: 10,
      });

      await state.action!();

      expect(showFn).toHaveBeenCalledWith("data-form", {
        startRow: 10,
        startCol: 10,
        endRow: 10,
        endCol: 10,
      });
    });

    it("very large region (10000 rows)", async () => {
      const { context, showFn, state } = makeContext();
      registerDataFormMenuItem(context);

      setCurrentSelection({ activeRow: 500, activeCol: 0 });
      mockGetCurrentRegion.mockResolvedValue({
        empty: false,
        startRow: 0,
        startCol: 0,
        endRow: 9999,
        endCol: 20,
      });

      await state.action!();

      expect(showFn).toHaveBeenCalledWith("data-form", {
        startRow: 0,
        startCol: 0,
        endRow: 9999,
        endCol: 20,
      });
    });
  });

  // --------------------------------------------------------------------------
  // Navigation forward/backward at boundaries
  // --------------------------------------------------------------------------

  describe("navigation boundary conditions", () => {
    it("selection at row 0 (first possible row)", async () => {
      const { context, state } = makeContext();
      registerDataFormMenuItem(context);

      setCurrentSelection({ activeRow: 0, activeCol: 0 });
      mockGetCurrentRegion.mockResolvedValue({ empty: true });

      await state.action!();

      expect(mockGetCurrentRegion).toHaveBeenCalledWith(0, 0);
    });

    it("selection at max row boundary", async () => {
      const { context, state } = makeContext();
      registerDataFormMenuItem(context);

      setCurrentSelection({ activeRow: 1048575, activeCol: 0 });
      mockGetCurrentRegion.mockResolvedValue({ empty: true });

      await state.action!();

      expect(mockGetCurrentRegion).toHaveBeenCalledWith(1048575, 0);
    });

    it("selection at max column boundary", async () => {
      const { context, state } = makeContext();
      registerDataFormMenuItem(context);

      setCurrentSelection({ activeRow: 0, activeCol: 16383 });
      mockGetCurrentRegion.mockResolvedValue({ empty: true });

      await state.action!();

      expect(mockGetCurrentRegion).toHaveBeenCalledWith(0, 16383);
    });

    it("selection at bottom-right corner", async () => {
      const { context, showFn, state } = makeContext();
      registerDataFormMenuItem(context);

      setCurrentSelection({ activeRow: 1048575, activeCol: 16383 });
      mockGetCurrentRegion.mockResolvedValue({ empty: true });

      await state.action!();

      expect(showFn).toHaveBeenCalledWith("data-form", {
        startRow: 1048575,
        startCol: 16383,
        endRow: 1048575,
        endCol: 16383,
      });
    });
  });

  // --------------------------------------------------------------------------
  // Rapid selection changes before action
  // --------------------------------------------------------------------------

  describe("rapid selection changes", () => {
    it("only the last selection is used when action fires", async () => {
      const { context, state } = makeContext();
      registerDataFormMenuItem(context);

      for (let i = 0; i < 100; i++) {
        setCurrentSelection({ activeRow: i, activeCol: i % 10 });
      }
      mockGetCurrentRegion.mockResolvedValue({ empty: true });

      await state.action!();

      expect(mockGetCurrentRegion).toHaveBeenCalledWith(99, 9);
    });
  });

  // --------------------------------------------------------------------------
  // Region at non-zero offset
  // --------------------------------------------------------------------------

  describe("region at non-zero offset", () => {
    it("region starting at row 50, col 5", async () => {
      const { context, showFn, state } = makeContext();
      registerDataFormMenuItem(context);

      setCurrentSelection({ activeRow: 55, activeCol: 7 });
      mockGetCurrentRegion.mockResolvedValue({
        empty: false,
        startRow: 50,
        startCol: 5,
        endRow: 200,
        endCol: 15,
      });

      await state.action!();

      expect(showFn).toHaveBeenCalledWith("data-form", {
        startRow: 50,
        startCol: 5,
        endRow: 200,
        endCol: 15,
      });
    });
  });
});
