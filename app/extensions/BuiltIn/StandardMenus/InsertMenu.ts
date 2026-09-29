//! FILENAME: app/extensions/BuiltIn/StandardMenus/InsertMenu.ts
import { useCallback } from 'react';
import type { MenuDefinition } from '@api/ui';
import { showDialog } from '@api/ui';
import { IconInsertTable, IconInsertPivot, IconInsertSlicer, IconInsertChart } from '@api';
import { openInsertTableDialog } from './selectionDoors';
import { isSelectionOwned } from '@api/selectionOwner';

/**
 * Open a create dialog whose source DEFAULTS from Core's selection (the
 * PivotTable and Chart dialogs detect the data region around it). While a
 * selection owner holds the selection -- a floating grid's selected cell --
 * Core's selection is a cell HIDDEN under it, so the dialog opens with no
 * prefill at all (`suppressAutoRange`, the opener's word both dialogs take;
 * the canvas insert uses it too). It does not refuse: the user names the
 * source in the dialog (owner default, W24).
 */
function showCreateDialog(dialogId: string): void {
  if (isSelectionOwned()) {
    showDialog(dialogId, { suppressAutoRange: true });
  } else {
    showDialog(dialogId);
  }
}

const PIVOT_DIALOG_ID = 'pivot:createDialog';
const CHART_DIALOG_ID = 'chart:createDialog';
const SLICER_DIALOG_ID = 'slicer:insertDialog';

export function useInsertMenu(): { menu: MenuDefinition } {
  // The insert.table command's own opener: it refuses while a selection
  // owner holds the selection (the dialog prefills Core's selection).
  const handleInsertTable = useCallback(() => {
    openInsertTableDialog();
  }, []);

  const handleInsertPivotTable = useCallback(() => {
    showCreateDialog(PIVOT_DIALOG_ID);
  }, []);

  const handleInsertChart = useCallback(() => {
    showCreateDialog(CHART_DIALOG_ID);
  }, []);

  const handleInsertSlicer = useCallback(() => {
    showDialog(SLICER_DIALOG_ID);
  }, []);

  const menu: MenuDefinition = {
    id: 'insert',
    label: 'Insert',
    order: 40,
    items: [
      { id: 'insert.table', label: 'Table...', icon: IconInsertTable, shortcut: 'Ctrl+T', action: handleInsertTable },
      { id: 'insert.sep1', label: '', separator: true },
      { id: 'insert.pivot', label: 'PivotTable...', icon: IconInsertPivot, action: handleInsertPivotTable },
      { id: 'insert.slicer', label: 'Slicer...', icon: IconInsertSlicer, action: handleInsertSlicer },
      { id: 'insert.sep2', label: '', separator: true },
      { id: 'insert.chart', label: 'Chart...', icon: IconInsertChart, action: handleInsertChart },
    ],
  };

  return { menu };
}
