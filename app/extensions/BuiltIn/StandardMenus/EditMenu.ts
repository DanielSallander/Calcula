//! FILENAME: app/extensions/BuiltIn/StandardMenus/EditMenu.ts
// PURPOSE: Edit menu registration using the Command Pattern.
// CONTEXT: This extension registers menu items with commandIds from CoreCommands.
//          The Shell executes commands via the Command Registry — no direct callbacks.

import { CoreCommands } from '../../../src/api/commands';
import { registerMenu } from '../../../src/api/ui';
import type { MenuDefinition } from '../../../src/api/ui';

/**
 * Register the Edit menu with the Menu Registry.
 * All items use `commandId` — the Shell is a dumb renderer that triggers
 * command strings. The actual handlers are bound in the Command Registry.
 */
export function registerEditMenu(): void {
  const menu: MenuDefinition = {
    id: 'edit',
    label: 'Edit',
    order: 20,
    items: [
      { id: 'edit.undo', label: 'Undo', commandId: CoreCommands.UNDO, shortcut: 'Ctrl+Z' },
      { id: 'edit.redo', label: 'Redo', commandId: CoreCommands.REDO, shortcut: 'Ctrl+Y' },
      { id: 'edit.sep1', label: '', separator: true },
      { id: 'edit.cut', label: 'Cut', commandId: CoreCommands.CUT, shortcut: 'Ctrl+X' },
      { id: 'edit.copy', label: 'Copy', commandId: CoreCommands.COPY, shortcut: 'Ctrl+C' },
      { id: 'edit.paste', label: 'Paste', commandId: CoreCommands.PASTE, shortcut: 'Ctrl+V' },
      { id: 'edit.sep2', label: '', separator: true },
      { id: 'edit.find', label: 'Find...', commandId: CoreCommands.FIND, shortcut: 'Ctrl+F' },
      { id: 'edit.replace', label: 'Replace...', commandId: CoreCommands.REPLACE, shortcut: 'Ctrl+H' },
      { id: 'edit.sep3', label: '', separator: true },
      { id: 'edit.merge', label: 'Merge Cells', commandId: CoreCommands.MERGE_CELLS, shortcut: 'Ctrl+M' },
      { id: 'edit.unmerge', label: 'Unmerge Cells', commandId: CoreCommands.UNMERGE_CELLS },
    ],
  };

  registerMenu(menu);
}
