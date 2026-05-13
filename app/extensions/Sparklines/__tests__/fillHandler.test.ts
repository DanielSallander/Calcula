//! FILENAME: app/extensions/Sparklines/__tests__/fillHandler.test.ts
// PURPOSE: Tests for sparkline fill handle propagation.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createSparklineGroup,
  updateSparklineGroup,
  getSparklineForCell,
  hasSparkline,
  getAllGroups,
  resetSparklineStore,
} from "../store";
import { handleFillCompleted } from "../handlers/fillHandler";
import type { FillCompletedPayload } from "@api/events";

// Mock the emitAppEvent to prevent actual event emission
vi.mock("@api/events", async () => {
  const actual = await vi.importActual("@api/events");
  return {
    ...actual,
    emitAppEvent: vi.fn(),
  };
});

// ============================================================================
// Setup
// ============================================================================

beforeEach(() => {
  resetSparklineStore();
});

// ============================================================================
// Tests
// ============================================================================

describe("handleFillCompleted", () => {
  describe("vertical fill (down)", () => {
    it("creates sparklines for filled cells with shifted data ranges", () => {
      // Source: sparkline at (0, 5) with data from A1:D1
      createSparklineGroup(
        { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
        { startRow: 0, startCol: 0, endRow: 0, endCol: 3 },
        "line",
      );
      expect(getAllGroups()).toHaveLength(1);

      handleFillCompleted({
        sourceRange: { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
        targetRange: { startRow: 0, startCol: 5, endRow: 2, endCol: 5 },
        direction: "down",
      });

      // Should have 3 groups now: original + 2 filled
      expect(getAllGroups()).toHaveLength(3);
      expect(hasSparkline(1, 5)).toBe(true);
      expect(hasSparkline(2, 5)).toBe(true);

      // Check data ranges are shifted
      const entry1 = getSparklineForCell(1, 5)!;
      expect(entry1.group.dataRange.startRow).toBe(1);
      expect(entry1.group.dataRange.endRow).toBe(1);

      const entry2 = getSparklineForCell(2, 5)!;
      expect(entry2.group.dataRange.startRow).toBe(2);
      expect(entry2.group.dataRange.endRow).toBe(2);
    });

    it("copies new visual properties (axis, empty cell handling)", () => {
      const result = createSparklineGroup(
        { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
        { startRow: 0, startCol: 0, endRow: 0, endCol: 3 },
        "line",
      );
      updateSparklineGroup(result.group!.id, {
        showAxis: true,
        axisScaleType: "custom",
        axisMinValue: -10,
        axisMaxValue: 100,
        emptyCellHandling: "connect",
        plotOrder: "rightToLeft",
        showHighPoint: true,
      });

      handleFillCompleted({
        sourceRange: { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
        targetRange: { startRow: 0, startCol: 5, endRow: 1, endCol: 5 },
        direction: "down",
      });

      const filled = getSparklineForCell(1, 5)!.group;
      expect(filled.showAxis).toBe(true);
      expect(filled.axisScaleType).toBe("custom");
      expect(filled.axisMinValue).toBe(-10);
      expect(filled.axisMaxValue).toBe(100);
      expect(filled.emptyCellHandling).toBe("connect");
      expect(filled.plotOrder).toBe("rightToLeft");
      expect(filled.showHighPoint).toBe(true);
    });
  });

  describe("horizontal fill (right)", () => {
    it("creates sparklines with shifted data ranges", () => {
      createSparklineGroup(
        { startRow: 5, startCol: 0, endRow: 5, endCol: 0 },
        { startRow: 0, startCol: 0, endRow: 4, endCol: 0 },
        "column",
      );

      handleFillCompleted({
        sourceRange: { startRow: 5, startCol: 0, endRow: 5, endCol: 0 },
        targetRange: { startRow: 5, startCol: 0, endRow: 5, endCol: 2 },
        direction: "right",
      });

      expect(getAllGroups()).toHaveLength(3);
      expect(hasSparkline(5, 1)).toBe(true);
      expect(hasSparkline(5, 2)).toBe(true);

      const entry1 = getSparklineForCell(5, 1)!;
      expect(entry1.group.dataRange.startCol).toBe(1);
      expect(entry1.group.dataRange.endCol).toBe(1);
    });
  });

  describe("edge cases", () => {
    it("handles null payload gracefully", () => {
      handleFillCompleted(null as unknown as FillCompletedPayload);
      // Should not throw
    });

    it("does nothing when source has no sparklines", () => {
      handleFillCompleted({
        sourceRange: { startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
        targetRange: { startRow: 0, startCol: 0, endRow: 2, endCol: 0 },
        direction: "down",
      });
      expect(getAllGroups()).toHaveLength(0);
    });
  });
});
