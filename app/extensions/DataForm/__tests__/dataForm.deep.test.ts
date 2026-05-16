//! FILENAME: app/extensions/DataForm/__tests__/dataForm.deep.test.ts
// PURPOSE: Deep tests for DataForm - menu builder, selection tracking, region detection.

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
// setCurrentSelection - deep
// ============================================================================

describe("setCurrentSelection deep", () => {
  it("accepts large row/col values", () => {
    setCurrentSelection({ activeRow: 999999, activeCol: 16383 });
    // No throw
  });

  it("accepts zero row/col", () => {
    setCurrentSelection({ activeRow: 0, activeCol: 0 });
  });

  it("can be called many times rapidly", () => {
    for (let i = 0; i < 1000; i++) {
      setCurrentSelection({ activeRow: i, activeCol: i % 10 });
    }
    setCurrentSelection(null);
    // No throw, no memory issues
  });
});

// ============================================================================
// registerDataFormMenuItem - menu registration
// ============================================================================

describe("registerDataFormMenuItem", () => {
  it("registers with correct menu id and label", () => {
    const { context } = makeContext();
    registerDataFormMenuItem(context);

    expect(context.ui.menus.registerItem).toHaveBeenCalledWith(
      "data",
      expect.objectContaining({
        id: "data:dataForm",
        label: "Data Form...",
      }),
    );
  });

  it("action opens dialog with region when data exists", async () => {
    const { context, showFn, state } = makeContext();
    registerDataFormMenuItem(context);

    setCurrentSelection({ activeRow: 5, activeCol: 2 });
    mockGetCurrentRegion.mockResolvedValue({
      empty: false,
      startRow: 0,
      startCol: 0,
      endRow: 100,
      endCol: 5,
    });

    await state.action!();

    expect(mockGetCurrentRegion).toHaveBeenCalledWith(5, 2);
    expect(showFn).toHaveBeenCalledWith("data-form", {
      startRow: 0,
      startCol: 0,
      endRow: 100,
      endCol: 5,
    });
  });

  it("action opens dialog at single cell when region is empty", async () => {
    const { context, showFn, state } = makeContext();
    registerDataFormMenuItem(context);

    setCurrentSelection({ activeRow: 3, activeCol: 7 });
    mockGetCurrentRegion.mockResolvedValue({ empty: true });

    await state.action!();

    expect(showFn).toHaveBeenCalledWith("data-form", {
      startRow: 3,
      startCol: 7,
      endRow: 3,
      endCol: 7,
    });
  });

  it("defaults to row 0, col 0 when no selection is set", async () => {
    const { context, showFn, state } = makeContext();
    registerDataFormMenuItem(context);

    setCurrentSelection(null);
    mockGetCurrentRegion.mockResolvedValue({ empty: true });

    await state.action!();

    expect(mockGetCurrentRegion).toHaveBeenCalledWith(0, 0);
    expect(showFn).toHaveBeenCalledWith("data-form", {
      startRow: 0,
      startCol: 0,
      endRow: 0,
      endCol: 0,
    });
  });

  it("uses latest selection when action is called", async () => {
    const { context, state } = makeContext();
    registerDataFormMenuItem(context);

    setCurrentSelection({ activeRow: 1, activeCol: 1 });
    setCurrentSelection({ activeRow: 50, activeCol: 10 });
    mockGetCurrentRegion.mockResolvedValue({ empty: true });

    await state.action!();

    expect(mockGetCurrentRegion).toHaveBeenCalledWith(50, 10);
  });

  it("passes region bounds directly from getCurrentRegion", async () => {
    const { context, showFn, state } = makeContext();
    registerDataFormMenuItem(context);

    setCurrentSelection({ activeRow: 0, activeCol: 0 });
    mockGetCurrentRegion.mockResolvedValue({
      empty: false,
      startRow: 5,
      startCol: 2,
      endRow: 500,
      endCol: 12,
    });

    await state.action!();

    expect(showFn).toHaveBeenCalledWith("data-form", {
      startRow: 5,
      startCol: 2,
      endRow: 500,
      endCol: 12,
    });
  });
});
