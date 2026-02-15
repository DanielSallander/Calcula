//! FILENAME: app/extensions/BuiltIn/StandardMenus/index.ts
// PURPOSE: Standard Menus extension module.
// CONTEXT: Registers Edit menu. File, View, Insert are handled by StandardMenus.tsx hooks.
// NOTE: Default exports an ExtensionModule object per the contract.

import type { ExtensionModule, ExtensionContext } from "../../../src/api/contract";
import { registerMenu, type MenuDefinition } from "../../../src/api/ui";
import { CoreCommands } from "../../../src/api/commands";
import { registerFormatMenu } from "./FormatMenu";

// ============================================================================
// Extension State
// ============================================================================

let isActivated = false;

// ============================================================================
// Menu Definitions
// ============================================================================

// NOTE: File, View, and Insert menus are handled by StandardMenus.tsx component
// which uses React hooks for reactive state (checkmarks, dynamic items).
// Only Edit menu is registered here since it's purely command-based.

function registerEditMenu(context: ExtensionContext): void {
  const editMenu: MenuDefinition = {
    id: "edit",
    label: "Edit",
    order: 20,
    items: [
      { id: "edit:undo", label: "Undo", shortcut: "Ctrl+Z", commandId: CoreCommands.UNDO },
      { id: "edit:redo", label: "Redo", shortcut: "Ctrl+Y", commandId: CoreCommands.REDO },
      { id: "edit:sep1", label: "", separator: true },
      { id: "edit:cut", label: "Cut", shortcut: "Ctrl+X", commandId: CoreCommands.CUT },
      { id: "edit:copy", label: "Copy", shortcut: "Ctrl+C", commandId: CoreCommands.COPY },
      { id: "edit:paste", label: "Paste", shortcut: "Ctrl+V", commandId: CoreCommands.PASTE },
      { id: "edit:sep2", label: "", separator: true },
      {
        id: "edit:find",
        label: "Find...",
        shortcut: "Ctrl+F",
        commandId: CoreCommands.FIND,
        action: () => context.commands.execute(CoreCommands.FIND),
      },
      {
        id: "edit:replace",
        label: "Replace...",
        shortcut: "Ctrl+H",
        commandId: CoreCommands.REPLACE,
        action: () => context.commands.execute(CoreCommands.REPLACE),
      },
    ],
  };
  registerMenu(editMenu);
}

// ============================================================================
// Activation
// ============================================================================

function activate(context: ExtensionContext): void {
  if (isActivated) {
    console.warn("[StandardMenusExtension] Already activated, skipping.");
    return;
  }

  console.log("[StandardMenusExtension] Activating...");

  // Only register Edit and Format menus here
  // File, View, Insert are handled by StandardMenus.tsx component (hook-based)
  registerEditMenu(context);
  registerFormatMenu();

  isActivated = true;
  console.log("[StandardMenusExtension] Activated successfully.");
}

// ============================================================================
// Deactivation
// ============================================================================

function deactivate(): void {
  if (!isActivated) {
    return;
  }

  console.log("[StandardMenusExtension] Deactivating...");
  isActivated = false;
  console.log("[StandardMenusExtension] Deactivated.");
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.builtin.standard-menus",
    name: "Standard Menus",
    version: "1.0.0",
    description: "Provides standard application menus.",
  },
  activate,
  deactivate,
};

export default extension;