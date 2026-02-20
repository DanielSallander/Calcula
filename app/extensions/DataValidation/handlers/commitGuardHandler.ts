//! FILENAME: app/extensions/DataValidation/handlers/commitGuardHandler.ts
// PURPOSE: Commit guard function for data validation.
// CONTEXT: Registered via registerCommitGuard(). Validates pending values
// before they are committed to the grid. Shows error alerts when invalid.

import {
  validatePendingValue,
  showDialog,
  hideDialog,
  type CommitGuardResult,
  type CellValidationResult,
} from "../../../src/api";
import type { ErrorAlertData } from "../types";

// ============================================================================
// Module-level resolver for the error alert modal
// ============================================================================

let errorAlertResolver: ((result: CommitGuardResult) => void) | null = null;

/**
 * Called by the ErrorAlertModal when the user clicks a button.
 * Resolves the pending commit guard Promise.
 */
export function resolveErrorAlert(result: CommitGuardResult): void {
  if (errorAlertResolver) {
    const resolver = errorAlertResolver;
    errorAlertResolver = null;
    hideDialog("data-validation-error");
    resolver(result);
  }
}

/**
 * Clear the resolver (e.g., on extension unload).
 */
export function clearErrorAlertResolver(): void {
  if (errorAlertResolver) {
    // If there's a pending resolver, resolve with "block" to unblock commitEdit
    errorAlertResolver({ action: "block" });
    errorAlertResolver = null;
  }
}

// ============================================================================
// Commit Guard Function
// ============================================================================

/**
 * The commit guard function for data validation.
 * Called by the core commitEdit() before writing a cell value.
 *
 * Returns null to allow the commit (no objection).
 * Returns a Promise that resolves when the user interacts with the error alert.
 */
export async function validationCommitGuard(
  row: number,
  col: number,
  value: string
): Promise<CommitGuardResult | null> {
  // 1. Call Rust backend to validate the pending value
  let result: CellValidationResult;
  try {
    result = await validatePendingValue(row, col, value);
  } catch (error) {
    console.error("[DataValidation] Failed to validate pending value:", error);
    return null; // On error, allow the commit
  }

  // 2. If valid, allow the commit
  if (result.isValid) {
    return null;
  }

  // 3. If no error alert configured or show_alert is false, allow anyway
  if (!result.errorAlert || !result.errorAlert.showAlert) {
    return null;
  }

  // 4. Show the error alert modal and wait for user response
  const alert = result.errorAlert;

  return new Promise<CommitGuardResult>((resolve) => {
    errorAlertResolver = resolve;

    const dialogData: ErrorAlertData = {
      title: alert.title || "Calcula",
      message: alert.message || "The value you entered is not valid.\nA user has restricted values that can be entered into this cell.",
      style: alert.style,
    };

    showDialog("data-validation-error", dialogData as unknown as Record<string, unknown>);
  });
}
