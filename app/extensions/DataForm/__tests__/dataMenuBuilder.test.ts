//! FILENAME: app/extensions/DataForm/__tests__/dataMenuBuilder.test.ts
// PURPOSE: Tests for DataForm menu builder selection tracking.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @api before importing
vi.mock("@api", () => ({
  getCurrentRegion: vi.fn(),
}));

import { setCurrentSelection } from "../handlers/dataMenuBuilder";

// ============================================================================
// setCurrentSelection Tests
// ============================================================================

describe("setCurrentSelection", () => {
  it("accepts a selection with activeRow and activeCol", () => {
    // Should not throw
    setCurrentSelection({ activeRow: 5, activeCol: 3 });
  });

  it("accepts null to clear selection", () => {
    setCurrentSelection({ activeRow: 1, activeCol: 1 });
    setCurrentSelection(null);
    // No error means it works; internal state is private but the function is exercised
  });

  it("overwrites previous selection", () => {
    setCurrentSelection({ activeRow: 0, activeCol: 0 });
    setCurrentSelection({ activeRow: 10, activeCol: 20 });
    // The function is a simple setter; we verify no errors on repeated calls
  });
});
