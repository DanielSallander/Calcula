//! FILENAME: app/extensions/DataValidation/lib/__tests__/commitGuardHandler.test.ts
// PURPOSE: Tests for the data validation commit guard handler.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the @api module
vi.mock("@api", () => ({
  validatePendingValue: vi.fn(),
  showDialog: vi.fn(),
  hideDialog: vi.fn(),
}));

import {
  resolveErrorAlert,
  clearErrorAlertResolver,
  validationCommitGuard,
} from "../../handlers/commitGuardHandler";

import {
  validatePendingValue,
  showDialog,
  hideDialog,
} from "@api";

const mockValidate = vi.mocked(validatePendingValue);
const mockShowDialog = vi.mocked(showDialog);
const mockHideDialog = vi.mocked(hideDialog);

// ============================================================================
// Setup
// ============================================================================

beforeEach(() => {
  vi.clearAllMocks();
  // Clear any leftover resolver state from previous tests
  clearErrorAlertResolver();
});

// ============================================================================
// validationCommitGuard Tests
// ============================================================================

describe("validationCommitGuard", () => {
  it("returns null when validation succeeds (value is valid)", async () => {
    mockValidate.mockResolvedValue({ isValid: true });
    const result = await validationCommitGuard(0, 0, "42");
    expect(result).toBeNull();
  });

  it("returns null when backend call throws", async () => {
    mockValidate.mockRejectedValue(new Error("Backend error"));
    const result = await validationCommitGuard(0, 0, "bad");
    expect(result).toBeNull();
  });

  it("returns null when isValid is false but no errorAlert", async () => {
    mockValidate.mockResolvedValue({ isValid: false });
    const result = await validationCommitGuard(0, 0, "bad");
    expect(result).toBeNull();
  });

  it("returns null when isValid is false and showAlert is false", async () => {
    mockValidate.mockResolvedValue({
      isValid: false,
      errorAlert: {
        showAlert: false,
        title: "Error",
        message: "Invalid",
        style: "stop",
      },
    });
    const result = await validationCommitGuard(0, 0, "bad");
    expect(result).toBeNull();
  });

  it("shows error dialog when validation fails with alert", async () => {
    mockValidate.mockResolvedValue({
      isValid: false,
      errorAlert: {
        showAlert: true,
        title: "Validation Error",
        message: "Must be a number",
        style: "stop",
      },
    });

    // Start the guard - it will show dialog and wait for resolution
    const guardPromise = validationCommitGuard(0, 0, "abc");

    // Allow the async validatePendingValue to resolve
    await vi.waitFor(() => {
      expect(mockShowDialog).toHaveBeenCalled();
    });

    // Dialog should be shown
    expect(mockShowDialog).toHaveBeenCalledWith(
      "data-validation-error",
      expect.objectContaining({
        title: "Validation Error",
        message: "Must be a number",
        style: "stop",
      }),
    );

    // Resolve the alert
    resolveErrorAlert({ action: "block" });

    const result = await guardPromise;
    expect(result).toEqual({ action: "block" });
  });

  it("uses default title and message when not provided", async () => {
    mockValidate.mockResolvedValue({
      isValid: false,
      errorAlert: {
        showAlert: true,
        title: "",
        message: "",
        style: "warning",
      },
    });

    const guardPromise = validationCommitGuard(0, 0, "xyz");

    await vi.waitFor(() => {
      expect(mockShowDialog).toHaveBeenCalled();
    });

    expect(mockShowDialog).toHaveBeenCalledWith(
      "data-validation-error",
      expect.objectContaining({
        title: "Calcula",
        message: expect.stringContaining("not valid"),
      }),
    );

    resolveErrorAlert({ action: "allow" });
    const result = await guardPromise;
    expect(result).toEqual({ action: "allow" });
  });

  it("calls validatePendingValue with correct row, col, value", async () => {
    mockValidate.mockResolvedValue({ isValid: true });
    await validationCommitGuard(5, 10, "hello");
    expect(mockValidate).toHaveBeenCalledWith(5, 10, "hello");
  });
});

// ============================================================================
// resolveErrorAlert Tests
// ============================================================================

describe("resolveErrorAlert", () => {
  it("hides dialog and resolves with action", async () => {
    mockValidate.mockResolvedValue({
      isValid: false,
      errorAlert: {
        showAlert: true,
        title: "Error",
        message: "Bad value",
        style: "stop",
      },
    });

    const guardPromise = validationCommitGuard(0, 0, "bad");

    await vi.waitFor(() => {
      expect(mockShowDialog).toHaveBeenCalled();
    });

    resolveErrorAlert({ action: "allow" });

    const result = await guardPromise;
    expect(result).toEqual({ action: "allow" });
    expect(mockHideDialog).toHaveBeenCalledWith("data-validation-error");
  });

  it("does nothing when called with no pending resolver", () => {
    // Should not throw
    resolveErrorAlert({ action: "block" });
    expect(mockHideDialog).not.toHaveBeenCalled();
  });
});

// ============================================================================
// clearErrorAlertResolver Tests
// ============================================================================

describe("clearErrorAlertResolver", () => {
  it("resolves pending resolver with block action", async () => {
    mockValidate.mockResolvedValue({
      isValid: false,
      errorAlert: {
        showAlert: true,
        title: "Error",
        message: "Bad",
        style: "stop",
      },
    });

    const guardPromise = validationCommitGuard(0, 0, "bad");

    await vi.waitFor(() => {
      expect(mockShowDialog).toHaveBeenCalled();
    });

    clearErrorAlertResolver();

    const result = await guardPromise;
    expect(result).toEqual({ action: "block" });
  });

  it("does nothing when there is no pending resolver", () => {
    // Should not throw
    clearErrorAlertResolver();
  });
});
