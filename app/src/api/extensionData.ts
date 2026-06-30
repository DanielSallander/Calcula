//! FILENAME: app/src/api/extensionData.ts
// PURPOSE: Generic per-extension workbook persistence.
// CONTEXT: Any extension (built-in or third-party) can persist arbitrary JSON
//   state in the current workbook, keyed by its extension id. The value
//   round-trips through the .cala `extension-data` part — so an extension can
//   persist state WITHOUT the file format needing a new typed field per
//   feature (Primitives-not-Features / No-First-Class-Citizens). State is
//   cleared on File > New and replaced on open.

import { invokeBackend } from "./backend";

/**
 * Read this extension's persisted state from the current workbook.
 * Returns null if nothing has been stored.
 *
 * @param extensionId - A stable id for your extension (e.g. your manifest id).
 */
export async function getExtensionData<T = unknown>(
  extensionId: string,
): Promise<T | null> {
  const result = await invokeBackend<T | null>("get_extension_data", { extensionId });
  return result ?? null;
}

/**
 * Persist this extension's state into the current workbook. Overwrites any
 * previous value. The value must be JSON-serializable.
 */
export async function setExtensionData(
  extensionId: string,
  value: unknown,
): Promise<void> {
  await invokeBackend<void>("set_extension_data", { extensionId, value });
}

/** Clear this extension's persisted state from the current workbook. */
export async function clearExtensionData(extensionId: string): Promise<void> {
  await invokeBackend<void>("set_extension_data", { extensionId, value: null });
}

/**
 * Persist this extension's state AND record it on the undo stack under
 * `description` (a dedicated, opt-in variant of {@link setExtensionData}). Undo/
 * redo of this entry restores the prior value and fires the workbook's
 * objects-changed refresh, so a subscribing extension can re-sync its view.
 *
 * Use for user-meaningful, low-frequency writes (e.g. saving a named
 * configuration) — NOT high-frequency or transient writes, which should use the
 * plain {@link setExtensionData} to stay off the undo stack. A null value clears.
 */
export async function setExtensionDataUndoable(
  extensionId: string,
  value: unknown,
  description: string,
): Promise<void> {
  await invokeBackend<void>("set_extension_data_undoable", { extensionId, value, description });
}
