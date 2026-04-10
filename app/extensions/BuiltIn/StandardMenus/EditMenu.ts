//! FILENAME: app/extensions/BuiltIn/StandardMenus/EditMenu.ts
// PURPOSE: Edit menu registration using the Command Pattern.
// CONTEXT: This extension registers menu items with commandIds from CoreCommands.
//          The Shell executes commands via the Command Registry — no direct callbacks.

import { CoreCommands } from '@api/commands';
import { registerMenu } from '@api/ui';
import type { MenuDefinition } from '@api/ui';
import {
  IconUndo,
  IconRedo,
  IconCut,
  IconCopy,
  IconPaste,
  IconClear,
  IconFill,
  IconFind,
  IconReplace,
  IconMergeCells,
  IconUnmergeCells,
} from '@api';

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
      { id: 'edit.undo', label: 'Undo', icon: IconUndo, commandId: CoreCommands.UNDO, shortcut: 'Ctrl+Z' },
      { id: 'edit.redo', label: 'Redo', icon: IconRedo, commandId: CoreCommands.REDO, shortcut: 'Ctrl+Y' },
      { id: 'edit.sep1', label: '', separator: true },
      { id: 'edit.cut', label: 'Cut', icon: IconCut, commandId: CoreCommands.CUT, shortcut: 'Ctrl+X' },
      { id: 'edit.copy', label: 'Copy', icon: IconCopy, commandId: CoreCommands.COPY, shortcut: 'Ctrl+C' },
      {
        id: 'edit.paste',
        label: 'Paste',
        icon: IconPaste,
        children: [
          { id: 'edit.paste.paste', label: 'Paste', commandId: CoreCommands.PASTE, shortcut: 'Ctrl+V' },
          { id: 'edit.paste.values', label: 'Paste Values', commandId: CoreCommands.PASTE_VALUES },
          { id: 'edit.paste.formulas', label: 'Paste Formulas', commandId: CoreCommands.PASTE_FORMULAS },
          { id: 'edit.paste.formatting', label: 'Paste Formatting', commandId: CoreCommands.PASTE_FORMATTING },
          { id: 'edit.paste.link', label: 'Paste Link', commandId: CoreCommands.PASTE_LINK },
          { id: 'edit.paste.sep', label: '', separator: true },
          { id: 'edit.paste.special', label: 'Paste Special...', commandId: CoreCommands.PASTE_SPECIAL, shortcut: 'Ctrl+Alt+V' },
        ],
      },
      { id: 'edit.sep2', label: '', separator: true },
      {
        id: 'edit.clear',
        label: 'Clear',
        icon: IconClear,
        children: [
          { id: 'edit.clear.all', label: 'Clear All', commandId: CoreCommands.CLEAR_ALL },
          { id: 'edit.clear.formatting', label: 'Clear Formatting', commandId: CoreCommands.CLEAR_FORMATTING },
          { id: 'edit.clear.contents', label: 'Clear Contents', commandId: CoreCommands.CLEAR_CONTENTS, shortcut: 'Del' },
          { id: 'edit.clear.comments', label: 'Clear Comments', commandId: CoreCommands.CLEAR_COMMENTS },
          { id: 'edit.clear.hyperlinks', label: 'Clear Hyperlinks', commandId: CoreCommands.CLEAR_HYPERLINKS },
        ],
      },
      {
        id: 'edit.fill',
        label: 'Fill',
        icon: IconFill,
        children: [
          { id: 'edit.fill.down', label: 'Down', commandId: CoreCommands.FILL_DOWN, shortcut: 'Ctrl+D' },
          { id: 'edit.fill.right', label: 'Right', commandId: CoreCommands.FILL_RIGHT, shortcut: 'Ctrl+R' },
          { id: 'edit.fill.up', label: 'Up', commandId: CoreCommands.FILL_UP },
          { id: 'edit.fill.left', label: 'Left', commandId: CoreCommands.FILL_LEFT },
        ],
      },
      { id: 'edit.sep4', label: '', separator: true },
      { id: 'edit.find', label: 'Find...', icon: IconFind, commandId: CoreCommands.FIND, shortcut: 'Ctrl+F' },
      { id: 'edit.replace', label: 'Replace...', icon: IconReplace, commandId: CoreCommands.REPLACE, shortcut: 'Ctrl+H' },
      { id: 'edit.sep5', label: '', separator: true },
      { id: 'edit.merge', label: 'Merge Cells', icon: IconMergeCells, commandId: CoreCommands.MERGE_CELLS, shortcut: 'Ctrl+M' },
      { id: 'edit.unmerge', label: 'Unmerge Cells', icon: IconUnmergeCells, commandId: CoreCommands.UNMERGE_CELLS },
    ],
  };

  registerMenu(menu);
}
