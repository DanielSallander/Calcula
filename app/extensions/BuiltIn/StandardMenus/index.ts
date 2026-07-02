//! FILENAME: app/extensions/BuiltIn/StandardMenus/index.ts
// PURPOSE: Standard Menus extension module.
// CONTEXT: Registers Edit menu. File, View, Insert are handled by StandardMenus.tsx hooks.
// NOTE: Default exports an ExtensionModule object per the contract.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { registerMenu, registerShellComponent, unregisterShellComponent, showDialog, type MenuDefinition } from "@api/ui";
import { CoreCommands } from "@api/commands";
import {
  IconUndo, IconRedo, IconCut, IconCopy, IconPaste, IconPasteValues,
  IconPasteFormulas, IconPasteFormatting, IconPasteLink, IconPasteSpecial,
  IconClear, IconClearFormatting, IconClearContents, IconClearComments,
  IconClearHyperlinks, IconFind, IconReplace,
} from "@api";
import { registerFormatMenu } from "./FormatMenu";
import { fileNew, fileOpen, fileSave, fileSaveAs } from "./FileMenu";
import { StandardMenus } from "./StandardMenus";

const SHELL_COMPONENT_ID = "standard-menus";

// Commands for the hook-based File/Insert/View menu items that previously had
// only an `action` (no commandId) and no keybinding — so they were dispatchable
// ONLY by the MenuBar accelerator handler. Registering them here makes them
// reachable by the centralized keybinding dispatcher (see DEFAULT_KEYBINDINGS),
// which is the prerequisite for removing MenuBar's own keydown handler.
const MENU_ACTION_COMMANDS = "core.file.new core.file.open core.file.save core.file.saveAs insert.table view.goToSpecial".split(" ");

// ============================================================================
// Extension State
// ============================================================================

let isActivated = false;
let activeContext: ExtensionContext | null = null;

function registerMenuActionCommands(context: ExtensionContext): void {
  context.commands.register("core.file.new", () => fileNew());
  context.commands.register("core.file.open", () => fileOpen());
  context.commands.register("core.file.save", () => fileSave());
  context.commands.register("core.file.saveAs", () => fileSaveAs());
  // Stateless dialog openers (same one-liners the menu items' actions use).
  context.commands.register("insert.table", () => showDialog("table:createDialog"));
  context.commands.register("view.goToSpecial", () => showDialog("go-to-special"));
}

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
      { id: "edit:undo", label: "Undo", shortcut: "Ctrl+Z", commandId: CoreCommands.UNDO, icon: IconUndo },
      { id: "edit:redo", label: "Redo", shortcut: "Ctrl+Y", commandId: CoreCommands.REDO, icon: IconRedo },
      { id: "edit:sep1", label: "", separator: true },
      { id: "edit:cut", label: "Cut", shortcut: "Ctrl+X", commandId: CoreCommands.CUT, icon: IconCut },
      { id: "edit:copy", label: "Copy", shortcut: "Ctrl+C", commandId: CoreCommands.COPY, icon: IconCopy },
      {
        id: "edit:paste",
        label: "Paste",
        icon: IconPaste,
        children: [
          { id: "edit:paste:paste", label: "Paste", commandId: CoreCommands.PASTE, shortcut: "Ctrl+V", icon: IconPaste },
          { id: "edit:paste:values", label: "Paste Values", commandId: CoreCommands.PASTE_VALUES, icon: IconPasteValues },
          { id: "edit:paste:formulas", label: "Paste Formulas", commandId: CoreCommands.PASTE_FORMULAS, icon: IconPasteFormulas },
          { id: "edit:paste:formatting", label: "Paste Formatting", commandId: CoreCommands.PASTE_FORMATTING, icon: IconPasteFormatting },
          { id: "edit:paste:link", label: "Paste Link", commandId: CoreCommands.PASTE_LINK, icon: IconPasteLink },
          { id: "edit:paste:sep", label: "", separator: true },
          { id: "edit:paste:special", label: "Paste Special...", commandId: CoreCommands.PASTE_SPECIAL, shortcut: "Ctrl+Alt+V", icon: IconPasteSpecial },
        ],
      },
      { id: "edit:sep2", label: "", separator: true },
      {
        id: "edit:clear",
        label: "Clear",
        icon: IconClear,
        children: [
          { id: "edit:clear:all", label: "Clear All", commandId: CoreCommands.CLEAR_ALL, icon: IconClear },
          { id: "edit:clear:formatting", label: "Clear Formatting", commandId: CoreCommands.CLEAR_FORMATTING, icon: IconClearFormatting },
          { id: "edit:clear:contents", label: "Clear Contents", commandId: CoreCommands.CLEAR_CONTENTS, shortcut: "Del", icon: IconClearContents },
          { id: "edit:clear:comments", label: "Clear Comments", commandId: CoreCommands.CLEAR_COMMENTS, icon: IconClearComments },
          { id: "edit:clear:hyperlinks", label: "Clear Hyperlinks", commandId: CoreCommands.CLEAR_HYPERLINKS, icon: IconClearHyperlinks },
        ],
      },
      { id: "edit:sep3", label: "", separator: true },
      {
        id: "edit:find",
        label: "Find...",
        shortcut: "Ctrl+F",
        commandId: CoreCommands.FIND,
        icon: IconFind,
        action: () => context.commands.execute(CoreCommands.FIND),
      },
      {
        id: "edit:replace",
        label: "Replace...",
        shortcut: "Ctrl+H",
        commandId: CoreCommands.REPLACE,
        icon: IconReplace,
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
  registerMenuActionCommands(context);
  activeContext = context;

  // Contribute the hook-based File/View/Insert menus component to the shell frame
  // via the @api shell-component registry — the Shell no longer hard-imports it.
  registerShellComponent({ id: SHELL_COMPONENT_ID, component: StandardMenus });

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
  unregisterShellComponent(SHELL_COMPONENT_ID);
  for (const id of MENU_ACTION_COMMANDS) activeContext?.commands.unregister(id);
  activeContext = null;
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