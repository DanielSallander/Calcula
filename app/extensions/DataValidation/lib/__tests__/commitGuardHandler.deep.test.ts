//! FILENAME: app/extensions/DataValidation/lib/__tests__/commitGuardHandler.deep.test.ts
// PURPOSE: Deep tests for commit guard handler covering all validation rule types,
// error alert styles, retry logic, and edge cases.

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

import { validatePendingValue, showDialog, hideDialog } from "@api";

const mockValidate = vi.mocked(validatePendingValue);
const mockShowDialog = vi.mocked(showDialog);
const mockHideDialog = vi.mocked(hideDialog);

// ============================================================================
// Helpers
// ============================================================================

function makeInvalidResult(
  style: "stop" | "warning" | "information",
  opts: { title?: string; message?: string; showAlert?: boolean } = {}
) {
  return {
    isValid: false,
    errorAlert: {
      showAlert: opts.showAlert ?? true,
      title: opts.title ?? "Validation Error",
      message: opts.message ?? "Invalid value",
      style,
    },
  };
}

/**
 * Start a guard call, wait for the dialog to show, resolve it, and return the result.
 */
async function guardWithDialog(
  row: number,
  col: number,
  value: string,
  action: "block" | "allow" | "retry" = "block"
) {
  const guardPromise = validationCommitGuard(row, col, value);
  await vi.waitFor(() => {
    expect(mockShowDialog).toHaveBeenCalled();
  });
  resolveErrorAlert({ action });
  return guardPromise;
}

// ============================================================================
// Setup
// ============================================================================

beforeEach(() => {
  vi.clearAllMocks();
  clearErrorAlertResolver();
});

// ============================================================================
// Whole Number Validation
// ============================================================================

describe("whole number validation rules", () => {
  it("blocks non-integer value with stop alert", async () => {
    mockValidate.mockResolvedValue(
      makeInvalidResult("stop", { message: "Please enter a whole number between 1 and 100" })
    );

    const result = await guardWithDialog(0, 0, "3.14", "block");
    expect(result).toEqual({ action: "block" });
    expect(mockValidate).toHaveBeenCalledWith(0, 0, "3.14");
  });

  it("allows valid whole number (no dialog shown)", async () => {
    mockValidate.mockResolvedValue({ isValid: true });
    const result = await validationCommitGuard(2, 3, "50");
    expect(result).toBeNull();
    expect(mockShowDialog).not.toHaveBeenCalled();
  });

  it("blocks value outside range (between X and Y)", async () => {
    mockValidate.mockResolvedValue(
      makeInvalidResult("stop", { message: "Value must be between 1 and 10" })
    );

    const result = await guardWithDialog(0, 0, "999", "block");
    expect(result).toEqual({ action: "block" });
  });
});

// ============================================================================
// Decimal Validation
// ============================================================================

describe("decimal validation rules", () => {
  it("blocks non-numeric value for decimal between rule", async () => {
    mockValidate.mockResolvedValue(
      makeInvalidResult("stop", { message: "Enter a decimal between 0.0 and 1.0" })
    );

    const result = await guardWithDialog(1, 1, "abc", "block");
    expect(result).toEqual({ action: "block" });
  });

  it("allows valid decimal value", async () => {
    mockValidate.mockResolvedValue({ isValid: true });
    const result = await validationCommitGuard(1, 1, "0.75");
    expect(result).toBeNull();
  });
});

// ============================================================================
// List Validation
// ============================================================================

describe("list validation rules", () => {
  it("blocks value not in allowed list", async () => {
    mockValidate.mockResolvedValue(
      makeInvalidResult("stop", { message: "Value must be one of: Red, Green, Blue" })
    );

    const result = await guardWithDialog(5, 0, "Yellow", "block");
    expect(result).toEqual({ action: "block" });
  });

  it("allows value in list", async () => {
    mockValidate.mockResolvedValue({ isValid: true });
    const result = await validationCommitGuard(5, 0, "Red");
    expect(result).toBeNull();
  });
});

// ============================================================================
// Date Validation
// ============================================================================

describe("date validation rules", () => {
  it("blocks date before allowed range", async () => {
    mockValidate.mockResolvedValue(
      makeInvalidResult("stop", { message: "Date must be after 2024-01-01" })
    );

    const result = await guardWithDialog(0, 2, "2023-06-15", "block");
    expect(result).toEqual({ action: "block" });
  });

  it("blocks date after allowed range", async () => {
    mockValidate.mockResolvedValue(
      makeInvalidResult("stop", { message: "Date must be before 2025-12-31" })
    );

    const result = await guardWithDialog(0, 2, "2026-01-01", "block");
    expect(result).toEqual({ action: "block" });
  });

  it("blocks date outside between range with warning (user can proceed)", async () => {
    mockValidate.mockResolvedValue(
      makeInvalidResult("warning", { message: "Date must be between 2024-01-01 and 2025-12-31" })
    );

    const result = await guardWithDialog(0, 2, "2023-01-01", "allow");
    expect(result).toEqual({ action: "allow" });
  });
});

// ============================================================================
// Text Length Validation
// ============================================================================

describe("text length validation rules", () => {
  it("blocks text shorter than minimum length", async () => {
    mockValidate.mockResolvedValue(
      makeInvalidResult("stop", { message: "Text must be at least 5 characters" })
    );

    const result = await guardWithDialog(3, 0, "Hi", "block");
    expect(result).toEqual({ action: "block" });
  });

  it("blocks text exceeding maximum length", async () => {
    mockValidate.mockResolvedValue(
      makeInvalidResult("stop", { message: "Text must be at most 10 characters" })
    );

    const result = await guardWithDialog(3, 0, "This is way too long", "block");
    expect(result).toEqual({ action: "block" });
  });

  it("blocks text outside between length range", async () => {
    mockValidate.mockResolvedValue(
      makeInvalidResult("stop", { message: "Text length must be between 3 and 10" })
    );

    const result = await guardWithDialog(3, 0, "AB", "block");
    expect(result).toEqual({ action: "block" });
  });
});

// ============================================================================
// Custom Formula Validation
// ============================================================================

describe("custom formula validation", () => {
  it("blocks value when custom formula evaluates to false", async () => {
    mockValidate.mockResolvedValue(
      makeInvalidResult("stop", { message: "Custom validation failed" })
    );

    const result = await guardWithDialog(0, 0, "invalid", "block");
    expect(result).toEqual({ action: "block" });
  });

  it("allows value when custom formula evaluates to true", async () => {
    mockValidate.mockResolvedValue({ isValid: true });
    const result = await validationCommitGuard(0, 0, "valid");
    expect(result).toBeNull();
  });
});

// ============================================================================
// Error Alert Styles
// ============================================================================

describe("error alert styles", () => {
  it("shows stop-style alert (blocks by default)", async () => {
    mockValidate.mockResolvedValue(makeInvalidResult("stop"));

    const result = await guardWithDialog(0, 0, "bad", "block");

    expect(mockShowDialog).toHaveBeenCalledWith(
      "data-validation-error",
      expect.objectContaining({ style: "stop" })
    );
    expect(result).toEqual({ action: "block" });
  });

  it("shows warning-style alert (user can proceed)", async () => {
    mockValidate.mockResolvedValue(makeInvalidResult("warning"));

    const result = await guardWithDialog(0, 0, "questionable", "allow");

    expect(mockShowDialog).toHaveBeenCalledWith(
      "data-validation-error",
      expect.objectContaining({ style: "warning" })
    );
    expect(result).toEqual({ action: "allow" });
  });

  it("shows information-style alert (just a notice)", async () => {
    mockValidate.mockResolvedValue(makeInvalidResult("information"));

    const result = await guardWithDialog(0, 0, "noted", "allow");

    expect(mockShowDialog).toHaveBeenCalledWith(
      "data-validation-error",
      expect.objectContaining({ style: "information" })
    );
    expect(result).toEqual({ action: "allow" });
  });
});

// ============================================================================
// Retry Action
// ============================================================================

describe("retry action", () => {
  it("returns retry result to keep cell in edit mode", async () => {
    mockValidate.mockResolvedValue(makeInvalidResult("stop"));

    const result = await guardWithDialog(0, 0, "wrong", "retry");
    expect(result).toEqual({ action: "retry" });
    expect(mockHideDialog).toHaveBeenCalledWith("data-validation-error");
  });

  it("guard can be called again after retry resolution", async () => {
    mockValidate.mockResolvedValue(makeInvalidResult("stop"));

    // First attempt - retry
    const result1 = await guardWithDialog(0, 0, "wrong", "retry");
    expect(result1).toEqual({ action: "retry" });

    vi.clearAllMocks();

    // Second attempt - block
    mockValidate.mockResolvedValue(makeInvalidResult("stop"));
    const result2 = await guardWithDialog(0, 0, "still-wrong", "block");
    expect(result2).toEqual({ action: "block" });
  });
});

// ============================================================================
// Input Message vs Error Alert
// ============================================================================

describe("validation with input message vs error alert", () => {
  it("allows commit when showAlert is false even if value is invalid", async () => {
    mockValidate.mockResolvedValue({
      isValid: false,
      errorAlert: {
        showAlert: false,
        title: "Hidden Alert",
        message: "This should not show",
        style: "stop",
      },
    });

    const result = await validationCommitGuard(0, 0, "invalid-but-allowed");
    expect(result).toBeNull();
    expect(mockShowDialog).not.toHaveBeenCalled();
  });

  it("allows commit when errorAlert is null", async () => {
    mockValidate.mockResolvedValue({
      isValid: false,
      errorAlert: null,
    });

    const result = await validationCommitGuard(0, 0, "no-alert");
    expect(result).toBeNull();
    expect(mockShowDialog).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Multiple Validations / Priority
// ============================================================================

describe("multiple validations on same cell", () => {
  it("backend resolves which validation rule applies (first match wins)", async () => {
    mockValidate.mockResolvedValue(
      makeInvalidResult("stop", { message: "First validation rule failed" })
    );

    const result = await guardWithDialog(0, 0, "conflict", "block");
    expect(result).toEqual({ action: "block" });
    // The guard calls validate once; the backend determines priority
    expect(mockValidate).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe("edge cases", () => {
  it("handles empty string value", async () => {
    mockValidate.mockResolvedValue({ isValid: true });
    const result = await validationCommitGuard(0, 0, "");
    expect(result).toBeNull();
    expect(mockValidate).toHaveBeenCalledWith(0, 0, "");
  });

  it("handles very long value string", async () => {
    const longValue = "x".repeat(10000);
    mockValidate.mockResolvedValue(makeInvalidResult("stop"));

    const result = await guardWithDialog(0, 0, longValue, "block");
    expect(result).toEqual({ action: "block" });
    expect(mockValidate).toHaveBeenCalledWith(0, 0, longValue);
  });

  it("handles special characters in value", async () => {
    mockValidate.mockResolvedValue({ isValid: true });
    const result = await validationCommitGuard(0, 0, '<script>alert("xss")</script>');
    expect(result).toBeNull();
  });

  it("handles large row/col coordinates", async () => {
    mockValidate.mockResolvedValue({ isValid: true });
    const result = await validationCommitGuard(999999, 16383, "value");
    expect(result).toBeNull();
    expect(mockValidate).toHaveBeenCalledWith(999999, 16383, "value");
  });

  it("second guard call while first is pending replaces resolver", async () => {
    mockValidate.mockResolvedValue(makeInvalidResult("stop"));

    // First guard call
    const promise1 = validationCommitGuard(0, 0, "first");
    await vi.waitFor(() => {
      expect(mockShowDialog).toHaveBeenCalledTimes(1);
    });

    vi.clearAllMocks();
    mockValidate.mockResolvedValue(makeInvalidResult("warning"));

    // Second guard call (overwrites the resolver)
    const promise2 = validationCommitGuard(1, 1, "second");
    await vi.waitFor(() => {
      expect(mockShowDialog).toHaveBeenCalledTimes(1);
    });

    // Resolving now resolves promise2, promise1's resolver was overwritten
    resolveErrorAlert({ action: "allow" });

    const result2 = await promise2;
    expect(result2).toEqual({ action: "allow" });
  });
});
