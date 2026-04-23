//! FILENAME: app/src/api/keybindings.ts
// PURPOSE: Centralized, user-configurable keybinding registry.
// CONTEXT: Replaces ad-hoc keyboard shortcut registrations with a single
//          registry that supports user customization, conflict detection,
//          and a settings UI.

import { CommandRegistry } from "./commands";

// ============================================================================
// Types
// ============================================================================

export interface KeyBinding {
  /** Unique ID: "core.copy", "ext.autofilter.toggle", etc. */
  id: string;
  /** Key combination: "Ctrl+C", "Ctrl+Shift+L", "F2" */
  combo: string;
  /** Command to execute */
  commandId: string;
  /** Display name: "Copy", "Toggle AutoFilter" */
  label: string;
  /** Category: "Clipboard", "Editing", "Formatting", "Navigation", etc. */
  category: string;
  /** When active */
  context?: "always" | "editing" | "not-editing";
  /** Who defined it */
  source: "built-in" | "extension" | "user";
  /** Extension that registered it */
  extensionId?: string;
}

export interface ParsedCombo {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

/** Contract for the keybindings API on ExtensionContext */
export interface IKeybindingsAPI {
  register(binding: Omit<KeyBinding, "source">): () => void;
  getAll(): KeyBinding[];
  getEffectiveCombo(id: string): string;
}

// ============================================================================
// State
// ============================================================================

const STORAGE_KEY = "calcula.keybindings.overrides";
const CUSTOM_BINDINGS_KEY = "calcula.keybindings.custom";

/** All registered keybindings (built-in + extension) */
const registry: Map<string, KeyBinding> = new Map();

/** User overrides: id -> custom combo */
let userOverrides: Map<string, string> = new Map();

/** Change listeners */
type ChangeListener = () => void;
const changeListeners: Set<ChangeListener> = new Set();

/** Whether the centralized keydown listener has been installed */
let listenerInstalled = false;

// ============================================================================
// Default Built-In Keybindings
// ============================================================================

const DEFAULT_KEYBINDINGS: KeyBinding[] = [
  // Clipboard
  { id: "core.cut", combo: "Ctrl+X", commandId: "core.clipboard.cut", label: "Cut", category: "Clipboard", source: "built-in" },
  { id: "core.copy", combo: "Ctrl+C", commandId: "core.clipboard.copy", label: "Copy", category: "Clipboard", source: "built-in" },
  { id: "core.paste", combo: "Ctrl+V", commandId: "core.clipboard.paste", label: "Paste", category: "Clipboard", source: "built-in" },
  { id: "core.pasteSpecial", combo: "Ctrl+Shift+V", commandId: "core.clipboard.pasteSpecial", label: "Paste Special", category: "Clipboard", source: "built-in" },

  // Edit
  { id: "core.undo", combo: "Ctrl+Z", commandId: "core.edit.undo", label: "Undo", category: "Editing", source: "built-in" },
  { id: "core.redo", combo: "Ctrl+Y", commandId: "core.edit.redo", label: "Redo", category: "Editing", source: "built-in" },
  { id: "core.find", combo: "Ctrl+F", commandId: "core.edit.find", label: "Find", category: "Editing", source: "built-in" },
  { id: "core.replace", combo: "Ctrl+H", commandId: "core.edit.replace", label: "Replace", category: "Editing", source: "built-in" },
  { id: "core.clearContents", combo: "Delete", commandId: "core.edit.clearContents", label: "Clear Contents", category: "Editing", context: "not-editing", source: "built-in" },

  // Fill
  { id: "core.fillDown", combo: "Ctrl+D", commandId: "core.edit.fillDown", label: "Fill Down", category: "Editing", source: "built-in" },
  { id: "core.fillRight", combo: "Ctrl+R", commandId: "core.edit.fillRight", label: "Fill Right", category: "Editing", source: "built-in" },

  // Format
  { id: "core.formatCells", combo: "Ctrl+1", commandId: "core.format.cells", label: "Format Cells", category: "Formatting", source: "built-in" },
  { id: "core.formatPainter", combo: "Ctrl+Shift+C", commandId: "core.format.painter", label: "Format Painter", category: "Formatting", source: "built-in" },

  // Navigation / View
  { id: "ext.search.findReplace", combo: "Ctrl+Shift+H", commandId: "search.openFindReplace", label: "Find and Replace", category: "Navigation", source: "built-in" },
  { id: "ext.fileExplorer.toggle", combo: "Ctrl+Shift+E", commandId: "fileExplorer.toggle", label: "Toggle File Explorer", category: "Navigation", source: "built-in" },
  { id: "ext.extensionsManager.toggle", combo: "Ctrl+Shift+X", commandId: "extensionsManager.toggle", label: "Toggle Extensions Manager", category: "Navigation", source: "built-in" },
  { id: "ext.settings.toggle", combo: "Ctrl+,", commandId: "settings.toggle", label: "Open Settings", category: "Navigation", source: "built-in" },

  // Data
  { id: "ext.autofilter.toggle", combo: "Ctrl+Shift+L", commandId: "autofilter.toggle", label: "Toggle AutoFilter", category: "Data", source: "built-in" },
  { id: "ext.flashFill", combo: "Ctrl+E", commandId: "flashFill.execute", label: "Flash Fill", category: "Data", source: "built-in" },

  // Print
  { id: "ext.print", combo: "Ctrl+P", commandId: "print.preview", label: "Print", category: "File", source: "built-in" },

  // Hyperlinks
  { id: "ext.hyperlinks.insert", combo: "Ctrl+K", commandId: "hyperlinks.insert", label: "Insert Hyperlink", category: "Editing", source: "built-in" },

  // Bookmarks
  { id: "ext.bookmarks.toggle", combo: "Ctrl+Shift+B", commandId: "bookmarks.toggle", label: "Toggle Bookmark", category: "Navigation", source: "built-in" },
  { id: "ext.bookmarks.next", combo: "Ctrl+]", commandId: "bookmarks.next", label: "Next Bookmark", category: "Navigation", source: "built-in" },
  { id: "ext.bookmarks.prev", combo: "Ctrl+[", commandId: "bookmarks.prev", label: "Previous Bookmark", category: "Navigation", source: "built-in" },

  // Grouping
  { id: "ext.grouping.group", combo: "Alt+Shift+ArrowRight", commandId: "grouping.group", label: "Group Rows/Columns", category: "Data", source: "built-in" },
  { id: "ext.grouping.ungroup", combo: "Alt+Shift+ArrowLeft", commandId: "grouping.ungroup", label: "Ungroup Rows/Columns", category: "Data", source: "built-in" },

  // Review
  { id: "ext.review.newComment", combo: "Ctrl+Alt+M", commandId: "review.newComment", label: "New Comment", category: "Review", source: "built-in" },

  // Select Visible Cells
  { id: "ext.selectVisible", combo: "Alt+;", commandId: "selectVisibleCells.execute", label: "Select Visible Cells", category: "Editing", source: "built-in" },

  // Script Notebook
  { id: "ext.scriptNotebook.toggle", combo: "Ctrl+Shift+N", commandId: "scriptNotebook.toggle", label: "Toggle Script Notebook", category: "Navigation", source: "built-in" },
];

// ============================================================================
// Persistence
// ============================================================================

function loadUserOverrides(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, string>;
      userOverrides = new Map(Object.entries(parsed));
    }
  } catch {
    userOverrides = new Map();
  }
}

function saveUserOverrides(): void {
  const obj: Record<string, string> = {};
  userOverrides.forEach((combo, id) => {
    obj[id] = combo;
  });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
}

// ============================================================================
// Key Combo Parsing & Matching
// ============================================================================

/** Cache of parsed combos to avoid repeated string splitting on every keypress. */
const comboCache = new Map<string, ParsedCombo>();

/**
 * Get a parsed combo from cache, or parse and cache it.
 */
function getCachedParsedCombo(combo: string): ParsedCombo {
  let parsed = comboCache.get(combo);
  if (!parsed) {
    parsed = parseCombo(combo);
    comboCache.set(combo, parsed);
  }
  return parsed;
}

/**
 * Parse a combo string like "Ctrl+Shift+B" into structured form.
 * The last token is always the key, everything before is modifiers.
 */
export function parseCombo(combo: string): ParsedCombo {
  const parts = combo.split("+").map((p) => p.trim());
  const result: ParsedCombo = { key: "", ctrl: false, shift: false, alt: false, meta: false };

  for (let i = 0; i < parts.length - 1; i++) {
    const mod = parts[i].toLowerCase();
    if (mod === "ctrl" || mod === "control") result.ctrl = true;
    else if (mod === "shift") result.shift = true;
    else if (mod === "alt") result.alt = true;
    else if (mod === "meta" || mod === "cmd") result.meta = true;
  }

  result.key = parts[parts.length - 1];
  return result;
}

/**
 * Check if a KeyboardEvent matches a combo string.
 * Uses cached parsed combos to avoid repeated string splitting.
 */
export function matchesEvent(combo: string, event: KeyboardEvent): boolean {
  const parsed = getCachedParsedCombo(combo);
  if (parsed.ctrl !== event.ctrlKey) return false;
  if (parsed.shift !== event.shiftKey) return false;
  if (parsed.alt !== event.altKey) return false;
  if (parsed.meta !== event.metaKey) return false;
  return event.key.toLowerCase() === parsed.key.toLowerCase();
}

/**
 * Format a combo string for display.
 * Normalizes casing: "ctrl+shift+b" -> "Ctrl+Shift+B"
 */
export function formatCombo(combo: string): string {
  const parsed = getCachedParsedCombo(combo);
  const parts: string[] = [];
  if (parsed.ctrl) parts.push("Ctrl");
  if (parsed.alt) parts.push("Alt");
  if (parsed.shift) parts.push("Shift");
  if (parsed.meta) parts.push("Meta");

  // Capitalize single-char keys, leave multi-char keys (F1, ArrowRight, etc.) as-is
  let key = parsed.key;
  if (key.length === 1) {
    key = key.toUpperCase();
  } else {
    // Capitalize first letter
    key = key.charAt(0).toUpperCase() + key.slice(1);
  }
  parts.push(key);
  return parts.join("+");
}

/**
 * Convert a KeyboardEvent into a combo string.
 */
export function eventToCombo(event: KeyboardEvent): string | null {
  // Skip pure modifier keys
  const modifierKeys = ["Control", "Shift", "Alt", "Meta"];
  if (modifierKeys.includes(event.key)) return null;

  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Meta");

  let key = event.key;
  if (key.length === 1) {
    key = key.toUpperCase();
  }
  parts.push(key);
  return parts.join("+");
}

// ============================================================================
// Editing State Detection
// ============================================================================

function isEditing(): boolean {
  const active = document.activeElement;
  if (!active) return false;
  const tag = active.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea") return true;
  if ((active as HTMLElement).contentEditable === "true") return true;
  return false;
}

// ============================================================================
// Registry Operations
// ============================================================================

/**
 * Get all registered keybindings.
 */
export function getAllKeybindings(): KeyBinding[] {
  return Array.from(registry.values());
}

/**
 * Get a keybinding by ID.
 */
export function getKeybinding(id: string): KeyBinding | undefined {
  return registry.get(id);
}

/**
 * Get all keybindings for a given category.
 */
export function getKeybindingsForCategory(category: string): KeyBinding[] {
  return getAllKeybindings().filter((b) => b.category === category);
}

/**
 * Get all distinct categories.
 */
export function getCategories(): string[] {
  const categories = new Set<string>();
  registry.forEach((b) => categories.add(b.category));
  return Array.from(categories).sort();
}

/**
 * Get the effective combo for a keybinding (user override or default).
 */
export function getEffectiveCombo(id: string): string {
  const override = userOverrides.get(id);
  if (override !== undefined) return override;
  const binding = registry.get(id);
  return binding ? binding.combo : "";
}

/**
 * Check if a keybinding has a user override.
 */
export function hasUserOverride(id: string): boolean {
  return userOverrides.has(id);
}

/**
 * Get the default combo for a keybinding (ignoring overrides).
 */
export function getDefaultCombo(id: string): string {
  const binding = registry.get(id);
  return binding ? binding.combo : "";
}

// ============================================================================
// User Customization
// ============================================================================

/**
 * Set a user override for a keybinding.
 */
export function setUserKeybinding(id: string, combo: string): void {
  userOverrides.set(id, combo);
  saveUserOverrides();
  notifyChange();
}

/**
 * Reset a single keybinding to its default.
 */
export function resetUserKeybinding(id: string): void {
  userOverrides.delete(id);
  saveUserOverrides();
  notifyChange();
}

/**
 * Reset all keybindings to defaults.
 */
export function resetAllKeybindings(): void {
  userOverrides.clear();
  saveUserOverrides();
  notifyChange();
}

// ============================================================================
// Custom (User-Created) Keybindings
// ============================================================================

interface StoredCustomBinding {
  id: string;
  combo: string;
  commandId: string;
  label: string;
  category: string;
  context?: "always" | "editing" | "not-editing";
}

function loadCustomBindings(): void {
  try {
    const raw = localStorage.getItem(CUSTOM_BINDINGS_KEY);
    if (raw) {
      const bindings = JSON.parse(raw) as StoredCustomBinding[];
      for (const b of bindings) {
        const binding: KeyBinding = {
          ...b,
          source: "user",
        };
        registry.set(binding.id, binding);
      }
    }
  } catch {
    // ignore
  }
}

function saveCustomBindings(): void {
  const custom: StoredCustomBinding[] = [];
  registry.forEach((b) => {
    if (b.source === "user") {
      custom.push({
        id: b.id,
        combo: b.combo,
        commandId: b.commandId,
        label: b.label,
        category: b.category,
        context: b.context,
      });
    }
  });
  localStorage.setItem(CUSTOM_BINDINGS_KEY, JSON.stringify(custom));
}

/**
 * Add a new custom keybinding created by the user.
 * @returns The created keybinding, or null if the ID already exists.
 */
export function addCustomKeybinding(
  combo: string,
  commandId: string,
  label: string,
  category?: string,
  context?: "always" | "editing" | "not-editing",
): KeyBinding {
  const id = `user.custom.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
  const binding: KeyBinding = {
    id,
    combo,
    commandId,
    label: label || commandId,
    category: category || "Custom",
    context: context ?? "always",
    source: "user",
  };
  registry.set(id, binding);
  saveCustomBindings();
  notifyChange();
  return binding;
}

/**
 * Remove a user-created custom keybinding.
 * Only works for bindings with source === "user".
 */
export function removeCustomKeybinding(id: string): boolean {
  const binding = registry.get(id);
  if (!binding || binding.source !== "user") return false;
  registry.delete(id);
  userOverrides.delete(id);
  saveCustomBindings();
  saveUserOverrides();
  notifyChange();
  return true;
}

/**
 * Get all available command IDs from the CommandRegistry.
 */
export function getAvailableCommands(): string[] {
  return CommandRegistry.getAll().filter((cmd): cmd is string => typeof cmd === "string");
}

// ============================================================================
// Conflict Detection
// ============================================================================

/**
 * Find conflicts for a given combo (excluding a specific binding id).
 */
export function findConflicts(combo: string, excludeId?: string): KeyBinding[] {
  const parsed = getCachedParsedCombo(combo);
  const conflicts: KeyBinding[] = [];

  registry.forEach((binding) => {
    if (excludeId && binding.id === excludeId) return;
    const effectiveCombo = getEffectiveCombo(binding.id);
    const otherParsed = getCachedParsedCombo(effectiveCombo);

    if (
      parsed.key.toLowerCase() === otherParsed.key.toLowerCase() &&
      parsed.ctrl === otherParsed.ctrl &&
      parsed.shift === otherParsed.shift &&
      parsed.alt === otherParsed.alt &&
      parsed.meta === otherParsed.meta
    ) {
      conflicts.push(binding);
    }
  });

  return conflicts;
}

// ============================================================================
// Extension Registration
// ============================================================================

/**
 * Register a keybinding. Returns an unregister function.
 */
export function registerKeybinding(binding: KeyBinding): () => void {
  installListener();

  if (registry.has(binding.id)) {
    console.warn(`[Keybindings] Overwriting keybinding: ${binding.id}`);
  }
  registry.set(binding.id, binding);

  // Log conflicts
  const effectiveCombo = getEffectiveCombo(binding.id);
  const conflicts = findConflicts(effectiveCombo, binding.id);
  if (conflicts.length > 0) {
    console.warn(
      `[Keybindings] Shortcut conflict for '${effectiveCombo}': ` +
        `${binding.id} vs ${conflicts.map((c) => c.id).join(", ")}`
    );
  }

  notifyChange();

  return () => {
    registry.delete(binding.id);
    notifyChange();
  };
}

// ============================================================================
// Change Notification
// ============================================================================

export function subscribeToKeybindingChanges(callback: ChangeListener): () => void {
  changeListeners.add(callback);
  return () => changeListeners.delete(callback);
}

function notifyChange(): void {
  // Invalidate parsed combo cache — bindings may have changed
  comboCache.clear();

  changeListeners.forEach((cb) => {
    try {
      cb();
    } catch (e) {
      console.error("[Keybindings] Error in change listener:", e);
    }
  });
}

// ============================================================================
// Centralized Keyboard Dispatcher
// ============================================================================

/**
 * Handle a global keydown event against all registered keybindings.
 * Returns true if a keybinding was matched and the command was executed.
 */
export function handleGlobalKeyDown(event: KeyboardEvent): boolean {
  if (registry.size === 0) return false;

  // Skip pure modifier keys
  const modifierKeys = ["Control", "Shift", "Alt", "Meta"];
  if (modifierKeys.includes(event.key)) return false;

  const editing = isEditing();

  // Find matching keybindings
  const matches: KeyBinding[] = [];
  registry.forEach((binding) => {
    const effectiveCombo = getEffectiveCombo(binding.id);
    if (!matchesEvent(effectiveCombo, event)) return;

    const ctx = binding.context ?? "always";
    if (ctx === "editing" && !editing) return;
    if (ctx === "not-editing" && editing) return;

    matches.push(binding);
  });

  if (matches.length === 0) return false;

  // If multiple matches, prefer extension over built-in (extension-registered
  // commands are more specific). Among same source, first registered wins.
  const winner = matches[0];

  event.preventDefault();
  event.stopPropagation();

  CommandRegistry.execute(winner.commandId).catch((err) => {
    console.error(`[Keybindings] Error executing command '${winner.commandId}':`, err);
  });

  return true;
}

function installListener(): void {
  if (listenerInstalled) return;
  listenerInstalled = true;

  window.addEventListener(
    "keydown",
    (event: KeyboardEvent) => {
      handleGlobalKeyDown(event);
    },
    { capture: true }
  );
}

// ============================================================================
// Initialization
// ============================================================================

/**
 * Initialize the keybinding system: load user overrides and register defaults.
 * Called once at app startup from the shell.
 */
export function initKeybindings(): void {
  loadUserOverrides();

  // Register all default keybindings
  for (const binding of DEFAULT_KEYBINDINGS) {
    registry.set(binding.id, binding);
  }

  // Load user-created custom keybindings
  loadCustomBindings();

  installListener();
  const customCount = getAllKeybindings().filter((b) => b.source === "user").length;
  console.log(`[Keybindings] Initialized with ${DEFAULT_KEYBINDINGS.length} built-in + ${customCount} custom keybindings`);
}
