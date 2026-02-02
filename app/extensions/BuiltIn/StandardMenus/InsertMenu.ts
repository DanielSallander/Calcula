//! FILENAME: app/extensions/BuiltIn/StandardMenus/InsertMenu.ts
import { useCallback, useState } from 'react';
import type { MenuDefinition } from '../../../src/api/ui';
import { restoreFocusToGrid } from '../../../src/api/events';

export interface InsertMenuHandlers {
  handleInsertPivotTable: () => void;
  handlePivotDialogClose: () => void;
  handlePivotCreated: (pivotId: number) => void;
}

export function useInsertMenu(): { menu: MenuDefinition; handlers: InsertMenuHandlers; isPivotDialogOpen: boolean } {
  const [isPivotDialogOpen, setIsPivotDialogOpen] = useState(false);

  const handleInsertPivotTable = useCallback(() => {
    console.log('[InsertMenu] handleInsertPivotTable called');
    setIsPivotDialogOpen(true);
  }, []);

  const handlePivotDialogClose = useCallback(() => {
    setIsPivotDialogOpen(false);
    restoreFocusToGrid();
  }, []);

  const handlePivotCreated = useCallback((pivotId: number) => {
    console.log('[InsertMenu] Pivot table created with ID:', pivotId);
    setIsPivotDialogOpen(false);

    // Emit event for Layout to show the PivotEditor sidebar
    window.dispatchEvent(new CustomEvent('pivot:created', {
      detail: { pivotId }
    }));
  }, []);

  const menu: MenuDefinition = {
    id: 'insert',
    label: 'Insert',
    order: 40,
    items: [
      { id: 'insert.pivot', label: 'PivotTable...', action: handleInsertPivotTable },
    ],
  };

  return {
    menu,
    handlers: {
      handleInsertPivotTable,
      handlePivotDialogClose,
      handlePivotCreated,
    },
    isPivotDialogOpen,
  };
}
