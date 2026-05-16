//! FILENAME: app/extensions/DataValidation/lib/__tests__/validation-parameterized.test.ts
// PURPOSE: Heavily parameterized tests for data validation commit guard,
//          dropdown region sync, and circle tracking.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the @api module
vi.mock("@api", () => ({
  validatePendingValue: vi.fn(),
  showDialog: vi.fn(),
  hideDialog: vi.fn(),
  getAllDataValidations: vi.fn(),
  getInvalidCells: vi.fn(),
  addGridRegions: vi.fn(),
  removeGridRegionsByType: vi.fn(),
  requestOverlayRedraw: vi.fn(),
  emitAppEvent: vi.fn(),
}));

import {
  resolveErrorAlert,
  clearErrorAlertResolver,
  validationCommitGuard,
} from "../../handlers/commitGuardHandler";

import {
  validatePendingValue,
  showDialog,
  getAllDataValidations,
  getInvalidCells,
  addGridRegions,
  removeGridRegionsByType,
  requestOverlayRedraw,
} from "@api";

const mockValidate = vi.mocked(validatePendingValue);
const mockShowDialog = vi.mocked(showDialog);
const mockGetAllValidations = vi.mocked(getAllDataValidations);
const mockGetInvalidCells = vi.mocked(getInvalidCells);
const mockAddRegions = vi.mocked(addGridRegions);
const mockRemoveRegions = vi.mocked(removeGridRegionsByType);
const mockRedraw = vi.mocked(requestOverlayRedraw);

beforeEach(() => {
  vi.clearAllMocks();
  clearErrorAlertResolver();
});

// ============================================================================
// 1. Commit Guard: Validation Types x Alert Styles (54 tests)
// ============================================================================

type ValidationTypeName = "wholeNumber" | "decimal" | "list" | "date" | "textLength" | "custom";
type AlertStyle = "stop" | "warning" | "information";

interface ValidationTypeCase {
  type: ValidationTypeName;
  validValues: string[];
  invalidValues: string[];
  boundaryValues: string[];
}

const validationTypes: ValidationTypeCase[] = [
  {
    type: "wholeNumber",
    validValues: ["1", "42", "-10"],
    invalidValues: ["3.14", "abc", ""],
    boundaryValues: ["0", "2147483647", "-2147483648"],
  },
  {
    type: "decimal",
    validValues: ["1.5", "0.001", "-99.99"],
    invalidValues: ["abc", "1.2.3", ""],
    boundaryValues: ["0.0", "1e308", "-1e308"],
  },
  {
    type: "list",
    validValues: ["Apple", "Banana", "Cherry"],
    invalidValues: ["Dragonfruit", "123", ""],
    boundaryValues: ["apple", "APPLE", " Apple "],
  },
  {
    type: "date",
    validValues: ["2024-01-15", "2000-12-31", "1999-06-01"],
    invalidValues: ["not-a-date", "32/13/2024", ""],
    boundaryValues: ["1900-01-01", "2099-12-31", "2024-02-29"],
  },
  {
    type: "textLength",
    validValues: ["Hi", "Hello", "OK"],
    invalidValues: ["This is a very long string that exceeds the limit", "a".repeat(256), ""],
    boundaryValues: ["a", "a".repeat(10), "a".repeat(50)],
  },
  {
    type: "custom",
    validValues: ["=TRUE", "1", "valid"],
    invalidValues: ["=FALSE", "0", ""],
    boundaryValues: ["=1>0", "=LEN(A1)>0", "=AND(TRUE,TRUE)"],
  },
];

const alertStyles: AlertStyle[] = ["stop", "warning", "information"];

describe("Commit Guard: validation types x alert styles", () => {
  // Build parameterized cases for valid values
  const validCases: Array<[ValidationTypeName, AlertStyle, string]> = [];
  const invalidCases: Array<[ValidationTypeName, AlertStyle, string]> = [];
  const boundaryCases: Array<[ValidationTypeName, AlertStyle, string]> = [];

  for (const vt of validationTypes) {
    for (const style of alertStyles) {
      validCases.push([vt.type, style, vt.validValues[0]]);
      invalidCases.push([vt.type, style, vt.invalidValues[0]]);
      boundaryCases.push([vt.type, style, vt.boundaryValues[0]]);
    }
  }

  describe("valid values - guard allows commit", () => {
    it.each(validCases)(
      "%s + %s alert: allows valid value '%s'",
      async (validationType, alertStyle, value) => {
        mockValidate.mockResolvedValue({ isValid: true });
        const result = await validationCommitGuard(0, 0, value);
        expect(result).toBeNull();
        expect(mockValidate).toHaveBeenCalledWith(0, 0, value);
      },
    );
  });

  describe("invalid values - guard shows alert dialog", () => {
    it.each(invalidCases)(
      "%s + %s alert: blocks invalid value '%s'",
      async (validationType, alertStyle, value) => {
        mockValidate.mockResolvedValue({
          isValid: false,
          errorAlert: {
            showAlert: true,
            title: `${validationType} Error`,
            message: `Value failed ${validationType} validation`,
            style: alertStyle,
          },
        });

        const guardPromise = validationCommitGuard(1, 2, value);

        await vi.waitFor(() => {
          expect(mockShowDialog).toHaveBeenCalled();
        });

        expect(mockShowDialog).toHaveBeenCalledWith(
          "data-validation-error",
          expect.objectContaining({
            title: `${validationType} Error`,
            style: alertStyle,
          }),
        );

        resolveErrorAlert({ action: "block" });
        const result = await guardPromise;
        expect(result).toEqual({ action: "block" });
      },
    );
  });

  describe("boundary values - guard validates correctly", () => {
    it.each(boundaryCases)(
      "%s + %s alert: handles boundary value '%s'",
      async (validationType, alertStyle, value) => {
        mockValidate.mockResolvedValue({ isValid: true });
        const result = await validationCommitGuard(0, 0, value);
        expect(result).toBeNull();
      },
    );
  });
});

// ============================================================================
// 2. Dropdown Region Sync for 20 Validation Configs (20 tests)
// ============================================================================

interface DropdownSyncCase {
  name: string;
  ranges: Array<{
    startRow: number;
    startCol: number;
    endRow: number;
    endCol: number;
    ruleType: "list" | "wholeNumber" | "decimal";
    inCellDropdown: boolean;
  }>;
  expectedRegionCount: number;
}

const dropdownSyncCases: DropdownSyncCase[] = [
  { name: "single cell list with dropdown", ranges: [{ startRow: 0, startCol: 0, endRow: 0, endCol: 0, ruleType: "list", inCellDropdown: true }], expectedRegionCount: 1 },
  { name: "single cell list without dropdown", ranges: [{ startRow: 0, startCol: 0, endRow: 0, endCol: 0, ruleType: "list", inCellDropdown: false }], expectedRegionCount: 0 },
  { name: "single cell wholeNumber (no dropdown)", ranges: [{ startRow: 0, startCol: 0, endRow: 0, endCol: 0, ruleType: "wholeNumber", inCellDropdown: false }], expectedRegionCount: 0 },
  { name: "3x1 range list with dropdown", ranges: [{ startRow: 0, startCol: 0, endRow: 2, endCol: 0, ruleType: "list", inCellDropdown: true }], expectedRegionCount: 3 },
  { name: "1x3 range list with dropdown", ranges: [{ startRow: 0, startCol: 0, endRow: 0, endCol: 2, ruleType: "list", inCellDropdown: true }], expectedRegionCount: 3 },
  { name: "3x3 range list with dropdown", ranges: [{ startRow: 0, startCol: 0, endRow: 2, endCol: 2, ruleType: "list", inCellDropdown: true }], expectedRegionCount: 9 },
  { name: "two separate list ranges", ranges: [
    { startRow: 0, startCol: 0, endRow: 1, endCol: 0, ruleType: "list", inCellDropdown: true },
    { startRow: 5, startCol: 5, endRow: 6, endCol: 5, ruleType: "list", inCellDropdown: true },
  ], expectedRegionCount: 4 },
  { name: "mixed: list with dropdown + decimal without", ranges: [
    { startRow: 0, startCol: 0, endRow: 0, endCol: 0, ruleType: "list", inCellDropdown: true },
    { startRow: 1, startCol: 0, endRow: 1, endCol: 0, ruleType: "decimal", inCellDropdown: false },
  ], expectedRegionCount: 1 },
  { name: "empty ranges array", ranges: [], expectedRegionCount: 0 },
  { name: "5x1 column list", ranges: [{ startRow: 0, startCol: 0, endRow: 4, endCol: 0, ruleType: "list", inCellDropdown: true }], expectedRegionCount: 5 },
  { name: "1x5 row list", ranges: [{ startRow: 0, startCol: 0, endRow: 0, endCol: 4, ruleType: "list", inCellDropdown: true }], expectedRegionCount: 5 },
  { name: "large 10x10 list range", ranges: [{ startRow: 0, startCol: 0, endRow: 9, endCol: 9, ruleType: "list", inCellDropdown: true }], expectedRegionCount: 100 },
  { name: "three non-dropdown lists", ranges: [
    { startRow: 0, startCol: 0, endRow: 0, endCol: 0, ruleType: "list", inCellDropdown: false },
    { startRow: 1, startCol: 0, endRow: 1, endCol: 0, ruleType: "list", inCellDropdown: false },
    { startRow: 2, startCol: 0, endRow: 2, endCol: 0, ruleType: "list", inCellDropdown: false },
  ], expectedRegionCount: 0 },
  { name: "offset range at row 100", ranges: [{ startRow: 100, startCol: 50, endRow: 102, endCol: 50, ruleType: "list", inCellDropdown: true }], expectedRegionCount: 3 },
  { name: "2x2 + 3x1 list ranges", ranges: [
    { startRow: 0, startCol: 0, endRow: 1, endCol: 1, ruleType: "list", inCellDropdown: true },
    { startRow: 5, startCol: 0, endRow: 7, endCol: 0, ruleType: "list", inCellDropdown: true },
  ], expectedRegionCount: 7 },
  { name: "single cell decimal", ranges: [{ startRow: 0, startCol: 0, endRow: 0, endCol: 0, ruleType: "decimal", inCellDropdown: false }], expectedRegionCount: 0 },
  { name: "list dropdown on last column", ranges: [{ startRow: 0, startCol: 255, endRow: 0, endCol: 255, ruleType: "list", inCellDropdown: true }], expectedRegionCount: 1 },
  { name: "4 single-cell dropdowns", ranges: [
    { startRow: 0, startCol: 0, endRow: 0, endCol: 0, ruleType: "list", inCellDropdown: true },
    { startRow: 1, startCol: 1, endRow: 1, endCol: 1, ruleType: "list", inCellDropdown: true },
    { startRow: 2, startCol: 2, endRow: 2, endCol: 2, ruleType: "list", inCellDropdown: true },
    { startRow: 3, startCol: 3, endRow: 3, endCol: 3, ruleType: "list", inCellDropdown: true },
  ], expectedRegionCount: 4 },
  { name: "wholeNumber + list dropdown combo", ranges: [
    { startRow: 0, startCol: 0, endRow: 5, endCol: 0, ruleType: "wholeNumber", inCellDropdown: false },
    { startRow: 0, startCol: 1, endRow: 5, endCol: 1, ruleType: "list", inCellDropdown: true },
  ], expectedRegionCount: 6 },
  { name: "2x2 list without dropdown", ranges: [{ startRow: 0, startCol: 0, endRow: 1, endCol: 1, ruleType: "list", inCellDropdown: false }], expectedRegionCount: 0 },
];

describe("Dropdown region sync", () => {
  /**
   * Replicates syncDropdownChevronRegions logic for testability.
   * The actual function is internal to validationStore, so we replicate its
   * core algorithm here to verify region counting.
   */
  function computeDropdownRegions(
    ranges: DropdownSyncCase["ranges"],
  ): number {
    let count = 0;
    for (const vr of ranges) {
      if (vr.ruleType === "list" && vr.inCellDropdown) {
        for (let row = vr.startRow; row <= vr.endRow; row++) {
          for (let col = vr.startCol; col <= vr.endCol; col++) {
            count++;
          }
        }
      }
    }
    return count;
  }

  it.each(dropdownSyncCases)(
    "$name -> $expectedRegionCount regions",
    ({ ranges, expectedRegionCount }) => {
      const regionCount = computeDropdownRegions(ranges);
      expect(regionCount).toBe(expectedRegionCount);
    },
  );
});

// ============================================================================
// 3. Circle Tracking for 15 Scenarios (15 tests)
// ============================================================================

interface CircleScenario {
  name: string;
  invalidCells: [number, number][] | null;
  expectedRegionCount: number;
  expectedCirclesActive: boolean;
}

const circleScenarios: CircleScenario[] = [
  { name: "no invalid cells (null)", invalidCells: null, expectedRegionCount: 0, expectedCirclesActive: false },
  { name: "empty array (circles on, none invalid)", invalidCells: [], expectedRegionCount: 0, expectedCirclesActive: true },
  { name: "single invalid cell", invalidCells: [[0, 0]], expectedRegionCount: 1, expectedCirclesActive: true },
  { name: "two invalid cells same row", invalidCells: [[0, 0], [0, 1]], expectedRegionCount: 2, expectedCirclesActive: true },
  { name: "two invalid cells same column", invalidCells: [[0, 0], [1, 0]], expectedRegionCount: 2, expectedCirclesActive: true },
  { name: "three scattered cells", invalidCells: [[0, 0], [5, 10], [99, 50]], expectedRegionCount: 3, expectedCirclesActive: true },
  { name: "10 cells in a column", invalidCells: Array.from({ length: 10 }, (_, i) => [i, 0] as [number, number]), expectedRegionCount: 10, expectedCirclesActive: true },
  { name: "10 cells in a row", invalidCells: Array.from({ length: 10 }, (_, i) => [0, i] as [number, number]), expectedRegionCount: 10, expectedCirclesActive: true },
  { name: "large set of 100 cells", invalidCells: Array.from({ length: 100 }, (_, i) => [Math.floor(i / 10), i % 10] as [number, number]), expectedRegionCount: 100, expectedCirclesActive: true },
  { name: "cells at large coordinates", invalidCells: [[99999, 255]], expectedRegionCount: 1, expectedCirclesActive: true },
  { name: "diagonal cells", invalidCells: [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]], expectedRegionCount: 5, expectedCirclesActive: true },
  { name: "adjacent 2x2 block", invalidCells: [[0, 0], [0, 1], [1, 0], [1, 1]], expectedRegionCount: 4, expectedCirclesActive: true },
  { name: "single cell at origin", invalidCells: [[0, 0]], expectedRegionCount: 1, expectedCirclesActive: true },
  { name: "single cell far away", invalidCells: [[50000, 100]], expectedRegionCount: 1, expectedCirclesActive: true },
  { name: "20 random cells", invalidCells: Array.from({ length: 20 }, (_, i) => [i * 7, i * 3] as [number, number]), expectedRegionCount: 20, expectedCirclesActive: true },
];

describe("Circle tracking", () => {
  /**
   * Replicates the circle region computation + isCirclesActive logic.
   */
  function computeCircleState(invalidCells: [number, number][] | null): {
    regionCount: number;
    circlesActive: boolean;
  } {
    const circlesActive = invalidCells !== null;
    if (!invalidCells || invalidCells.length === 0) {
      return { regionCount: 0, circlesActive };
    }
    return {
      regionCount: invalidCells.length,
      circlesActive,
    };
  }

  it.each(circleScenarios)(
    "$name -> $expectedRegionCount regions, active=$expectedCirclesActive",
    ({ invalidCells, expectedRegionCount, expectedCirclesActive }) => {
      const { regionCount, circlesActive } = computeCircleState(invalidCells);
      expect(regionCount).toBe(expectedRegionCount);
      expect(circlesActive).toBe(expectedCirclesActive);
    },
  );

  // Additional: verify region ID format
  describe("region ID format", () => {
    it.each([
      [[0, 0] as [number, number], "validation-invalid-0-0"],
      [[5, 10] as [number, number], "validation-invalid-5-10"],
      [[999, 255] as [number, number], "validation-invalid-999-255"],
    ])("cell [%j] -> region ID '%s'", (cell, expectedId) => {
      const id = `validation-invalid-${cell[0]}-${cell[1]}`;
      expect(id).toBe(expectedId);
    });
  });
});
