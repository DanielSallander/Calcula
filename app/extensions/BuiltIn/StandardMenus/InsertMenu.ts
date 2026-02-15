//! FILENAME: app/extensions/BuiltIn/StandardMenus/InsertMenu.ts
import { useCallback } from 'react';
import type { MenuDefinition } from '../../../src/api/ui';
import { showDialog } from '../../../src/api/ui';

const PIVOT_DIALOG_ID = 'pivot:createDialog';

export function useInsertMenu(): { menu: MenuDefinition } {
  const handleInsertPivotTable = useCallback(() => {
    showDialog(PIVOT_DIALOG_ID);
  }, []);

  const menu: MenuDefinition = {
    id: 'insert',
    label: 'Insert',
    order: 40,
    items: [
      { id: 'insert.pivot', label: 'PivotTable...', action: handleInsertPivotTable },
    ],
  };

  return { menu };
}
