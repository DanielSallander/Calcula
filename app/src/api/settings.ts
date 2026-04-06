//! FILENAME: app/src/api/settings.ts
// PURPOSE: Extension settings/preferences API.
// CONTEXT: Extensions can store persistent key-value settings using localStorage.
//          Settings are scoped per extension ID to prevent collisions.

// ============================================================================
// Types
// ============================================================================

/** A setting definition with metadata for UI rendering */
export interface SettingDefinition {
  /** Setting key (scoped to extension, e.g., "theme" becomes "ext.my-org.my-ext.theme") */
  key: string;
  /** Display label */
  label: string;
  /** Setting type for UI rendering */
  type: "string" | "number" | "boolean" | "select";
  /** Default value */
  defaultValue: string | number | boolean;
  /** Description shown in settings UI */
  description?: string;
  /** For "select" type: the available options */
  options?: Array<{ label: string; value: string | number }>;
}

/** Contract for the settings API on ExtensionContext */
export interface ISettingsAPI {
  /** Get a setting value (returns default if not set) */
  get<T extends string | number | boolean>(key: string, defaultValue: T): T;
  /** Set a setting value */
  set(key: string, value: string | number | boolean): void;
  /** Remove a setting */
  remove(key: string): void;
  /** Register setting definitions (for future settings UI) */
  registerSettings(definitions: SettingDefinition[]): () => void;
}

// ============================================================================
// State
// ============================================================================

const STORAGE_PREFIX = "ext.";

/** Registered setting definitions from all extensions */
const registeredSettings: Map<string, SettingDefinition & { extensionId: string }> = new Map();

type SettingsChangeListener = () => void;
const settingsListeners: Set<SettingsChangeListener> = new Set();

// ============================================================================
// Implementation
// ============================================================================

function scopedKey(extensionId: string, key: string): string {
  return `${STORAGE_PREFIX}${extensionId}.${key}`;
}

/**
 * Get a setting value for an extension.
 */
export function getSetting<T extends string | number | boolean>(
  extensionId: string,
  key: string,
  defaultValue: T
): T {
  const fullKey = scopedKey(extensionId, key);
  const stored = localStorage.getItem(fullKey);
  if (stored === null) return defaultValue;

  // Parse based on default value type
  if (typeof defaultValue === "boolean") {
    return (stored === "true") as T;
  }
  if (typeof defaultValue === "number") {
    const num = Number(stored);
    return (isNaN(num) ? defaultValue : num) as T;
  }
  return stored as T;
}

/**
 * Set a setting value for an extension.
 */
export function setSetting(
  extensionId: string,
  key: string,
  value: string | number | boolean
): void {
  const fullKey = scopedKey(extensionId, key);
  localStorage.setItem(fullKey, String(value));
  notifySettingsChanged();
}

/**
 * Remove a setting for an extension.
 */
export function removeSetting(extensionId: string, key: string): void {
  const fullKey = scopedKey(extensionId, key);
  localStorage.removeItem(fullKey);
  notifySettingsChanged();
}

/**
 * Register setting definitions for an extension.
 * These are used by the Settings UI to render configuration panels.
 */
export function registerSettingDefinitions(
  extensionId: string,
  definitions: SettingDefinition[]
): () => void {
  for (const def of definitions) {
    const fullKey = scopedKey(extensionId, def.key);
    registeredSettings.set(fullKey, { ...def, extensionId });
  }
  notifySettingsChanged();

  return () => {
    for (const def of definitions) {
      const fullKey = scopedKey(extensionId, def.key);
      registeredSettings.delete(fullKey);
    }
    notifySettingsChanged();
  };
}

/**
 * Get all registered setting definitions.
 */
export function getAllSettingDefinitions(): Array<SettingDefinition & { extensionId: string }> {
  return Array.from(registeredSettings.values());
}

/**
 * Subscribe to settings changes.
 */
export function subscribeToSettings(callback: SettingsChangeListener): () => void {
  settingsListeners.add(callback);
  return () => settingsListeners.delete(callback);
}

function notifySettingsChanged(): void {
  settingsListeners.forEach((cb) => {
    try {
      cb();
    } catch (e) {
      console.error("[Settings] Error in change listener:", e);
    }
  });
}
