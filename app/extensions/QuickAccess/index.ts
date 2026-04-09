//! FILENAME: app/extensions/QuickAccess/index.ts
// PURPOSE: Quick Access extension entry point.
// CONTEXT: Registers the "Quick Access" top-level menu with user-pinned commands
//          and a searchable "More..." submenu for discovering and pinning commands.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { CommandRegistry } from "@api";
import { registerMenu, getMenus, subscribeToMenus } from "@api/ui";
import type { MenuItemDefinition } from "@api/uiTypes";
import React from "react";
import { CommandPalette, PinIcon } from "./components/CommandPalette";
import type { CommandEntry } from "./components/CommandPalette";

// ============================================================================
// Constants
// ============================================================================

const MENU_ID = "quickAccess";
const MENU_ORDER = 90; // Far right, after other menus
const STORAGE_KEY = "calcula:quickAccess:pinnedIds";

// ============================================================================
// State
// ============================================================================

/** Set of pinned command IDs, persisted to localStorage. */
let pinnedIds: Set<string> = new Set();

/** Cached command entries for pinned items (rebuilt on menu change). */
let pinnedEntries: CommandEntry[] = [];

let menuUnsubscribe: (() => void) | null = null;

// ============================================================================
// Persistence
// ============================================================================

function loadPinnedIds(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        return new Set(arr.filter((id: unknown) => typeof id === "string"));
      }
    }
  } catch {
    // Ignore corrupt data
  }
  return new Set();
}

function savePinnedIds(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(pinnedIds)));
  } catch {
    // Ignore quota errors
  }
}

// ============================================================================
// Menu Builder
// ============================================================================

/** Recursively find a menu item by ID across all menus. */
function findMenuItemById(id: string): MenuItemDefinition | null {
  const menus = getMenus();
  function walk(items: MenuItemDefinition[]): MenuItemDefinition | null {
    for (const item of items) {
      if (item.id === id) return item;
      if (item.children) {
        const found = walk(item.children);
        if (found) return found;
      }
    }
    return null;
  }
  for (const menu of menus) {
    if (menu.id === MENU_ID) continue;
    const found = walk(menu.items);
    if (found) return found;
  }
  return null;
}

/** Build the pinned entries list from the current menu state. */
function rebuildPinnedEntries(): void {
  pinnedEntries = [];
  for (const id of pinnedIds) {
    const item = findMenuItemById(id);
    if (item && (item.action || item.commandId)) {
      pinnedEntries.push({
        id: item.id,
        label: item.label,
        shortLabel: item.label,
        action: item.action,
        commandId: item.commandId,
        shortcut: item.shortcut,
      });
    }
  }
}

/** Execute a command entry. */
function executeCommand(entry: CommandEntry): void {
  if (entry.action) {
    entry.action();
  } else if (entry.commandId) {
    CommandRegistry.execute(entry.commandId).catch((err) => {
      console.error(`[QuickAccess] Failed to execute command ${entry.commandId}:`, err);
    });
  }
}

/** Toggle pin state for a command. */
function togglePin(entry: CommandEntry): void {
  if (pinnedIds.has(entry.id)) {
    pinnedIds.delete(entry.id);
  } else {
    pinnedIds.add(entry.id);
  }
  savePinnedIds();
  rebuildPinnedEntries();
  registerQuickAccessMenu();
}

/** Register/re-register the Quick Access menu with current pinned items. */
function registerQuickAccessMenu(): void {
  const items: MenuItemDefinition[] = [];

  // Add pinned command items (with blue pin icon to unpin)
  for (const entry of pinnedEntries) {
    const capturedEntry = entry;
    items.push({
      id: `quickAccess:pinned:${entry.id}`,
      label: entry.shortLabel,
      shortcut: entry.shortcut,
      action: () => executeCommand(capturedEntry),
      rightAction: {
        icon: React.createElement(PinIcon),
        title: "Unpin from Quick Access",
        onClick: () => {
          pinnedIds.delete(capturedEntry.id);
          savePinnedIds();
          rebuildPinnedEntries();
          registerQuickAccessMenu();
        },
      },
    });
  }

  // Add separator before "More..." if there are pinned items
  if (items.length > 0) {
    items.push({
      id: "quickAccess:separator",
      label: "",
      separator: true,
    });
  }

  // Add "More..." item with custom content (the searchable command palette)
  items.push({
    id: "quickAccess:more",
    label: "More...",
    customContent: (onClose: () => void) =>
      React.createElement(CommandPalette, {
        onClose,
        pinnedIds,
        onTogglePin: togglePin,
        onExecute: (entry: CommandEntry) => {
          executeCommand(entry);
        },
      }),
  });

  registerMenu({
    id: MENU_ID,
    label: "Quick Access",
    order: MENU_ORDER,
    items,
  });
}

// ============================================================================
// Lifecycle
// ============================================================================

function activate(_context: ExtensionContext): void {
  console.log("[QuickAccess] Activating...");

  // Load persisted pins
  pinnedIds = loadPinnedIds();
  rebuildPinnedEntries();

  // Register menu
  registerQuickAccessMenu();

  // Subscribe to menu changes so we can rebuild pinned entries
  // when other extensions register/update their menu items
  menuUnsubscribe = subscribeToMenus(() => {
    rebuildPinnedEntries();
    // Don't re-register here to avoid infinite loop — the pinned items
    // reference actions from the current menu state, so they stay current.
  });

  console.log("[QuickAccess] Activated successfully.");
}

function deactivate(): void {
  console.log("[QuickAccess] Deactivating...");
  if (menuUnsubscribe) {
    menuUnsubscribe();
    menuUnsubscribe = null;
  }
  pinnedIds.clear();
  pinnedEntries = [];
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.quick-access",
    name: "Quick Access",
    version: "1.0.0",
    description: "Customizable Quick Access menu with pinnable commands",
  },
  activate,
  deactivate,
};

export default extension;
