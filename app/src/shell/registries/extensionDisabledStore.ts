//! FILENAME: app/src/shell/registries/extensionDisabledStore.ts
// PURPOSE: Persist the set of user-disabled third-party extensions (C7).
// CONTEXT: Disabling an extension must survive restarts, so the disabled set is
//          stored in localStorage. Kept as a tiny standalone module (no heavy
//          ExtensionManager imports) so it is trivially unit-testable.

/** localStorage key holding a JSON array of disabled extension ids. */
export const DISABLED_STORAGE_KEY = "calcula.extensions.disabled";

/** Read the persisted disabled-extension id set. Tolerates a missing key,
 *  corrupt JSON, or a non-array/non-string payload (returns an empty set). */
export function loadDisabledIds(): Set<string> {
  try {
    const raw = localStorage.getItem(DISABLED_STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr)
      ? new Set(arr.filter((x): x is string => typeof x === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

/** Persist the disabled-extension id set as a JSON array. Never throws. */
export function persistDisabledIds(ids: Set<string>): void {
  try {
    localStorage.setItem(DISABLED_STORAGE_KEY, JSON.stringify([...ids]));
  } catch (e) {
    console.warn("[ExtensionManager] Failed to persist disabled extensions:", e);
  }
}
