//! FILENAME: app/extensions/BuiltIn/StandardMenus/InsertMenu.ts
import { useCallback } from 'react';
import type { MenuDefinition } from '../../../src/api/ui';
import { showDialog } from '../../../src/api/ui';

const TABLE_DIALOG_ID = 'table:createDialog';
const PIVOT_DIALOG_ID = 'pivot:createDialog';
const TABLIX_DIALOG_ID = 'tablix:createDialog';
const CHART_DIALOG_ID = 'chart:createDialog';

export function useInsertMenu(): { menu: MenuDefinition } {
  const handleInsertTable = useCallback(() => {
    showDialog(TABLE_DIALOG_ID);
  }, []);

  const handleInsertPivotTable = useCallback(() => {
    showDialog(PIVOT_DIALOG_ID);
  }, []);

  const handleInsertTablix = useCallback(() => {
    showDialog(TABLIX_DIALOG_ID);
  }, []);

  const handleInsertChart = useCallback(() => {
    showDialog(CHART_DIALOG_ID);
  }, []);

  const menu: MenuDefinition = {
    id: 'insert',
    label: 'Insert',
    order: 40,
    items: [
      { id: 'insert.table', label: 'Table...', shortcut: 'Ctrl+T', action: handleInsertTable },
      { id: 'insert.sep1', label: '', separator: true },
      { id: 'insert.pivot', label: 'PivotTable...', action: handleInsertPivotTable },
      { id: 'insert.tablix', label: 'Tablix...', action: handleInsertTablix },
      { id: 'insert.sep2', label: '', separator: true },
      { id: 'insert.chart', label: 'Chart...', action: handleInsertChart },
    ],
  };

  return { menu };
}
