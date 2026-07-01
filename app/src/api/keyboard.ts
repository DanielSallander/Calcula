//! FILENAME: app/src/api/keyboard.ts
// PURPOSE: Keyboard shortcut registration API for extensions.
// CONTEXT: Extensions register shortcuts that are dispatched to commands.
//          The system handles conflict detection and priority ordering.

// ============================================================================
// Types
// ============================================================================

/** Modifier keys for a keyboard shortcut */
export interface ShortcutModifiers {
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
}

/** A keyboard shortcut binding */
export interface ShortcutBinding {
  /** The key to bind (e.g., "B", "F5", "Enter", "Escape") — uses KeyboardEvent.key */
  key: string;
  /** Modifier keys */
  modifiers: ShortcutModifiers;
  /** The command ID to execute when the shortcut fires */
  commandId: string;
  /** The extension ID that registered this shortcut */
  extensionId: string;
  /** Priority for conflict resolution (higher = takes precedence). Default: 0 */
  priority?: number;
  /** Human-readable description (e.g., "Toggle Bold") */
  description?: string;
  /** When the shortcut is active. Default: "always" */
  when?: "always" | "editing" | "not-editing";
}

/** Options for registering a keyboard shortcut */
export interface RegisterShortcutOptions {
  /** Priority for conflict resolution (higher = takes precedence). Default: 0 */
  priority?: number;
  /** Human-readable description */
  description?: string;
  /** When the shortcut is active. Default: "always" */
  when?: "always" | "editing" | "not-editing";
}

/** Contract for the keyboard shortcut API on ExtensionContext */
export interface IKeyboardAPI {
  /** Register a keyboard shortcut that executes a command */
  registerShortcut(
    combo: string,
    commandId: string,
    options?: RegisterShortcutOptions
  ): () => void;
  /** Get all registered shortcuts */
  getShortcuts(): ShortcutBinding[];
}

// ============================================================================
// State
// ============================================================================

const bindings: ShortcutBinding[] = [];
let listenerInstalled = false;

// ============================================================================
// Shortcut String Parser
// ============================================================================

/**
 * Parse a shortcut string like "Ctrl+Shift+B" into key + modifiers.
 * Supported modifier tokens: Ctrl, Shift, Alt, Meta/Cmd.
 * The last token is always the key.
 */
function parseCombo(combo: string): { key: string; modifiers: ShortcutModifiers } {
  const parts = combo.split("+").map((p) => p.trim());
  const modifiers: ShortcutModifiers = {};

  for (let i = 0; i < parts.length - 1; i++) {
    const mod = parts[i].toLowerCase();
    if (mod === "ctrl" || mod === "control") modifiers.ctrl = true;
    else if (mod === "shift") modifiers.shift = true;
    else if (mod === "alt") modifiers.alt = true;
    else if (mod === "meta" || mod === "cmd") modifiers.meta = true;
  }

  const key = parts[parts.length - 1];
  return { key, modifiers };
}

/**
 * Check if a keyboard event matches a binding.
 */
function matchesEvent(event: KeyboardEvent, binding: ShortcutBinding): boolean {
  const m = binding.modifiers;
  if (!!m.ctrl !== event.ctrlKey) return false;
  if (!!m.shift !== event.shiftKey) return false;
  if (!!m.alt !== event.altKey) return false;
  if (!!m.meta !== event.metaKey) return false;

  // Case-insensitive key comparison for single characters
  return event.key.toLowerCase() === binding.key.toLowerCase();
}

/**
 * Check if the user is currently in a cell editing state.
 */
function isEditing(): boolean {
  const active = document.activeElement;
  if (!active) return false;
  const tag = active.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea") return true;
  if ((active as HTMLElement).contentEditable === "true") return true;
  return false;
}

/**
 * Check if focus is within the spreadsheet grid container.
 */
function isGridFocused(): boolean {
  const active = document.activeElement;
  if (!active) return false;
  const container = (active as HTMLElement).closest?.('[data-focus-container="spreadsheet"]');
  return container !== null && container !== undefined;
}

/**
 * True if the user has a non-collapsed DOM text selection (toast, dialog, panel).
 * Grid cells are canvas-drawn and never produce a DOM text selection, so this
 * means the user wants to copy/cut that text, not the active cell.
 */
function hasDomTextSelection(): boolean {
  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  return !!sel && sel.rangeCount > 0 && !sel.isCollapsed && sel.toString().trim() !== "";
}

/**
 * Command IDs that should only fire when the grid has focus.
 * Mirrors the set in keybindings.ts.
 */
const GRID_SCOPED_COMMANDS = new Set([
  "core.clipboard.copy",
  "core.clipboard.cut",
  "core.clipboard.paste",
  "core.clipboard.pasteSpecial",
  "core.clipboard.pasteValues",
  "core.clipboard.pasteFormulas",
  "core.clipboard.pasteFormatting",
  "core.clipboard.pasteLink",
  "core.edit.undo",
  "core.edit.redo",
  "core.edit.clearContents",
  "core.edit.fillDown",
  "core.edit.fillRight",
  "core.edit.fillUp",
  "core.edit.fillLeft",
  "core.format.cells",
  "core.format.painter",
]);

// ============================================================================
// Global Keyboard Listener
// ============================================================================

function installListener(): void {
  if (listenerInstalled) return;
  listenerInstalled = true;

  window.addEventListener("keydown", (event: KeyboardEvent) => {
    // Skip if no bindings
    if (bindings.length === 0) return;

    const editing = isEditing();
    const gridFocused = isGridFocused();

    // Find all matching bindings, sorted by priority (highest first)
    const matches = bindings
      .filter((b) => {
        if (!matchesEvent(event, b)) return false;
        const when = b.when ?? "always";
        if (when === "editing" && !editing) return false;
        if (when === "not-editing" && editing) return false;

        // Skip grid-scoped commands when focus is outside the grid
        if (!gridFocused && GRID_SCOPED_COMMANDS.has(b.commandId)) {
          console.debug(
            `[Keyboard] Skipping grid-scoped command '${b.commandId}' ` +
            `— focus is outside grid (active: ${document.activeElement?.tagName})`
          );
          return false;
        }

        // Defer copy/cut to native when the user has a DOM text selection, even
        // if the grid is focused (e.g. copying text out of a toast or panel).
        if (
          (b.commandId === "core.clipboard.copy" || b.commandId === "core.clipboard.cut") &&
          hasDomTextSelection()
        ) {
          return false;
        }

        return true;
      })
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

    if (matches.length === 0) return;

    // Execute the highest-priority match
    const winner = matches[0];
    event.preventDefault();
    event.stopPropagation();

    // Import dynamically to avoid circular dependency
    import("./commands").then(({ CommandRegistry }) => {
      CommandRegistry.execute(winner.commandId);
    });
  }, { capture: true });
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Register a keyboard shortcut that executes a command.
 *
 * @param combo Shortcut string (e.g., "Ctrl+Shift+B", "Alt+F5")
 * @param commandId The command ID to execute
 * @param extensionId The ID of the extension registering this shortcut
 * @param options Additional options (priority, description, when)
 * @returns Cleanup function to unregister the shortcut
 *
 * @example
 * ```ts
 * const unreg = registerShortcut("Ctrl+Shift+B", "bookmarks.toggle", "calcula.bookmarks");
 * cleanupFns.push(unreg);
 * ```
 */
export function registerShortcut(
  combo: string,
  commandId: string,
  extensionId: string,
  options?: RegisterShortcutOptions
): () => void {
  installListener();

  const { key, modifiers } = parseCombo(combo);

  const binding: ShortcutBinding = {
    key,
    modifiers,
    commandId,
    extensionId,
    priority: options?.priority ?? 0,
    description: options?.description,
    when: options?.when ?? "always",
  };

  bindings.push(binding);

  // Log conflicts
  const conflicts = bindings.filter(
    (b) =>
      b !== binding &&
      b.key.toLowerCase() === key.toLowerCase() &&
      !!b.modifiers.ctrl === !!modifiers.ctrl &&
      !!b.modifiers.shift === !!modifiers.shift &&
      !!b.modifiers.alt === !!modifiers.alt &&
      !!b.modifiers.meta === !!modifiers.meta
  );
  if (conflicts.length > 0) {
    console.warn(
      `[Keyboard] Shortcut conflict for '${combo}': ` +
      `${extensionId}:${commandId} vs ${conflicts.map((c) => `${c.extensionId}:${c.commandId}`).join(", ")}. ` +
      `Highest priority wins.`
    );
  }

  return () => {
    const idx = bindings.indexOf(binding);
    if (idx >= 0) bindings.splice(idx, 1);
  };
}

/**
 * Get all registered keyboard shortcuts.
 */
export function getShortcuts(): ShortcutBinding[] {
  return [...bindings];
}
