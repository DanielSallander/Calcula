//! FILENAME: app/src/shell/MenuBar/menus/InsertMenu.ts
import { useCallback, useState } from 'react';
import type { Menu } from '../MenuBar.types';
import { restoreFocusToGrid } from '../MenuBar.events';

export interface InsertMenuHandlers {
  handleInsertPivotTable: () => void;
  handlePivotDialogClose: () => void;
  handlePivotCreated: (pivotId: number) => void;
}

export function useInsertMenu(): { menu: Menu; handlers: InsertMenuHandlers; isPivotDialogOpen: boolean } {
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

  const menu: Menu = {
    label: 'Insert',
    items: [
      { label: 'PivotTable...', action: handleInsertPivotTable },
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