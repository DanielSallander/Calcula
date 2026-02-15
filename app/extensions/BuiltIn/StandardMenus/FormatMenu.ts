//! FILENAME: app/extensions/BuiltIn/StandardMenus/FormatMenu.ts
// PURPOSE: Format menu registration using the Command Pattern.
// CONTEXT: Registers the Format menu with items for cell formatting.

import { CoreCommands } from '../../../src/api/commands';
import { registerMenu } from '../../../src/api/ui';
import type { MenuDefinition } from '../../../src/api/ui';

/**
 * Register the Format menu with the Menu Registry.
 * Placed between Edit (order=20) and View (order=40).
 */
export function registerFormatMenu(): void {
  const menu: MenuDefinition = {
    id: 'format',
    label: 'Format',
    order: 35,
    items: [
      {
        id: 'format:cells',
        label: 'Format Cells...',
        shortcut: 'Ctrl+1',
        commandId: CoreCommands.FORMAT_CELLS,
      },
    ],
  };

  registerMenu(menu);
}
