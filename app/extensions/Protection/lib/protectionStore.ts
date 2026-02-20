//! FILENAME: app/extensions/Protection/lib/protectionStore.ts
// PURPOSE: Module-level state management for the Protection extension.
// CONTEXT: Caches protection status fetched from the Rust backend for synchronous access.

import type { SheetProtectionOptions } from "../../../src/api";
import {
  getProtectionStatus,
  isWorkbookProtected as isWorkbookProtectedApi,
  DEFAULT_PROTECTION_OPTIONS,
} from "../../../src/api";

// ============================================================================
// Module State
// ============================================================================

let sheetProtected = false;
let sheetHasPassword = false;
let sheetOptions: SheetProtectionOptions = { ...DEFAULT_PROTECTION_OPTIONS };
let workbookProtected = false;

// ============================================================================
// Sync Getters
// ============================================================================

/** Check if the current sheet is protected (sync, from cache). */
export function isCurrentSheetProtected(): boolean {
  return sheetProtected;
}

/** Check if the current sheet has a password set. */
export function currentSheetHasPassword(): boolean {
  return sheetHasPassword;
}

/** Get the current sheet's protection options (sync, from cache). */
export function getSheetOptions(): SheetProtectionOptions {
  return sheetOptions;
}

/** Check if the workbook structure is protected (sync, from cache). */
export function isCurrentWorkbookProtected(): boolean {
  return workbookProtected;
}

// ============================================================================
// Refresh from Backend
// ============================================================================

/**
 * Refresh the cached protection state from the Rust backend.
 * Should be called on sheet change and after protect/unprotect operations.
 */
export async function refreshProtectionState(): Promise<void> {
  try {
    const status = await getProtectionStatus();
    sheetProtected = status.isProtected;
    sheetHasPassword = status.hasPassword;
    sheetOptions = status.options;
  } catch (error) {
    console.error("[Protection] Failed to refresh sheet protection status:", error);
  }

  try {
    workbookProtected = await isWorkbookProtectedApi();
  } catch (error) {
    console.error("[Protection] Failed to refresh workbook protection status:", error);
  }
}

/**
 * Update cached sheet protection state after a local protect/unprotect operation.
 * Avoids a round-trip to the backend when we already know the new state.
 */
export function setSheetProtectedState(
  isProtected: boolean,
  hasPassword: boolean,
  options: SheetProtectionOptions,
): void {
  sheetProtected = isProtected;
  sheetHasPassword = hasPassword;
  sheetOptions = options;
}

/**
 * Update cached workbook protection state.
 */
export function setWorkbookProtectedState(isProtected: boolean): void {
  workbookProtected = isProtected;
}

// ============================================================================
// Reset
// ============================================================================

/** Reset all protection state to defaults. */
export function resetProtectionState(): void {
  sheetProtected = false;
  sheetHasPassword = false;
  sheetOptions = { ...DEFAULT_PROTECTION_OPTIONS };
  workbookProtected = false;
}
