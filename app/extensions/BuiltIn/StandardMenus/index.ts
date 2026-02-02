//! FILENAME: app/src/extensions/BuiltIn/StandardMenus/index.ts
// PURPOSE: Standard Menus extension module.
// CONTEXT: Registers File, Edit, View, Insert menus.
// NOTE: Default exports an ExtensionModule object per the contract.

import type { ExtensionModule, ExtensionContext } from "../../../src/api/contract";
import { registerMenu, type MenuDefinition } from "../../../src/api/ui";
import { CoreCommands } from "../../../src/api/commands";

// ============================================================================
// Extension State
// ============================================================================

let isActivated = false;

// ============================================================================
// Menu Definitions
// ============================================================================

function registerFileMenu(): void {
  const fileMenu: MenuDefinition = {
    id: "file",
    label: "File",
    order: 10,
    items: [
      { id: "file:new", label: "New", shortcut: "Ctrl+N", commandId: "core.file.new" },
      { id: "file:open", label: "Open...", shortcut: "Ctrl+O", commandId: "core.file.open" },
      { id: "file:save", label: "Save", shortcut: "Ctrl+S", commandId: "core.file.save" },
      { id: "file:saveAs", label: "Save As...", shortcut: "Ctrl+Shift+S", commandId: "core.file.saveAs" },
      { id: "file:sep1", label: "", separator: true },
      { id: "file:export", label: "Export...", commandId: "core.file.export" },
      { id: "file:sep2", label: "", separator: true },
      { id: "file:close", label: "Close", commandId: "core.file.close" },
    ],
  };
  registerMenu(fileMenu);
}

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

function registerViewMenu(): void {
  const viewMenu: MenuDefinition = {
    id: "view",
    label: "View",
    order: 30,
    items: [
      { id: "view:freezePanes", label: "Freeze Panes", commandId: CoreCommands.FREEZE_PANES },
      { id: "view:sep1", label: "", separator: true },
      { id: "view:gridlines", label: "Gridlines", commandId: "core.view.gridlines" },
      { id: "view:headers", label: "Headers", commandId: "core.view.headers" },
      { id: "view:formulaBar", label: "Formula Bar", commandId: "core.view.formulaBar" },
    ],
  };
  registerMenu(viewMenu);
}

function registerInsertMenu(): void {
  const insertMenu: MenuDefinition = {
    id: "insert",
    label: "Insert",
    order: 40,
    items: [
      { id: "insert:row", label: "Row", commandId: CoreCommands.INSERT_ROW },
      { id: "insert:column", label: "Column", commandId: CoreCommands.INSERT_COLUMN },
      { id: "insert:sep1", label: "", separator: true },
      { id: "insert:cells", label: "Cells...", commandId: "core.insert.cells" },
      { id: "insert:sep2", label: "", separator: true },
      { id: "insert:chart", label: "Chart...", commandId: "core.insert.chart" },
      { id: "insert:image", label: "Image...", commandId: "core.insert.image" },
    ],
  };
  registerMenu(insertMenu);
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

  // Register all standard menus
  registerFileMenu();
  registerEditMenu(context);
  registerViewMenu();
  registerInsertMenu();

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
  // Note: Menu unregistration would go here if MenuRegistry supported it
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
    description: "Provides File, Edit, View, and Insert menus.",
  },
  activate,
  deactivate,
};

export default extension;