//! FILENAME: app/extensions/BuiltIn/StandardMenus/InsertMenu.ts
import { useCallback } from 'react';
import type { MenuDefinition } from '../../../src/api/ui';
import { showDialog } from '../../../src/api/ui';

const TABLE_DIALOG_ID = 'table:createDialog';
const PIVOT_DIALOG_ID = 'pivot:createDialog';

export function useInsertMenu(): { menu: MenuDefinition } {
  const handleInsertTable = useCallback(() => {
    showDialog(TABLE_DIALOG_ID);
  }, []);

  const handleInsertPivotTable = useCallback(() => {
    showDialog(PIVOT_DIALOG_ID);
  }, []);

  const menu: MenuDefinition = {
    id: 'insert',
    label: 'Insert',
    order: 40,
    items: [
      { id: 'insert.table', label: 'Table...', shortcut: 'Ctrl+T', action: handleInsertTable },
      { id: 'insert.sep1', label: '', separator: true },
      { id: 'insert.pivot', label: 'PivotTable...', action: handleInsertPivotTable },
    ],
  };

  return { menu };
}
