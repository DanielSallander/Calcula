//! FILENAME: app/extensions/BuiltIn/StandardMenus/ViewMenu.ts
// REFACTORED: All imports now go through app/src/api (The Facade Rule).
// - Removed: direct imports from core/lib/tauri-api, core/state/gridActions, shell/task-pane
// - Uses: api/grid.ts for freeze operations, api/ui.ts for task pane hooks
// - The Shell (Layout.tsx) listens for FREEZE_CHANGED events and dispatches to Core state.

import { useCallback, useEffect, useState } from 'react';
import type { MenuDefinition } from '../../../src/api/ui';
import { freezePanes, loadFreezePanesConfig } from '../../../src/api/grid';
import { useIsTaskPaneOpen, useOpenTaskPaneAction, useCloseTaskPaneAction } from '../../../src/api/ui';

export interface ViewMenuHandlers {
  handleFreezeTopRow: () => Promise<void>;
  handleFreezeFirstColumn: () => Promise<void>;
  handleFreezeBoth: () => Promise<void>;
  handleUnfreeze: () => Promise<void>;
}

export interface FreezeState {
  row: boolean;
  col: boolean;
}

export function useViewMenu(): { menu: MenuDefinition; handlers: ViewMenuHandlers; freezeState: FreezeState } {
  const [freezeState, setFreezeState] = useState<FreezeState>({ row: false, col: false });

  // Task pane state via API hooks (no shell import)
  const isTaskPaneOpen = useIsTaskPaneOpen();
  const openTaskPane = useOpenTaskPaneAction();
  const closeTaskPane = useCloseTaskPaneAction();

  useEffect(() => {
    const loadFreezeState = async () => {
      console.log('[ViewMenu] Loading freeze state...');
      try {
        // loadFreezePanesConfig fetches from backend AND emits FREEZE_CHANGED
        // so the Shell bridge in Layout.tsx dispatches setFreezeConfig to Core state.
        const config = await loadFreezePanesConfig();
        console.log('[ViewMenu] Loaded freeze config:', config);
        const hasRow = config.freezeRow !== null && config.freezeRow > 0;
        const hasCol = config.freezeCol !== null && config.freezeCol > 0;
        setFreezeState({
          row: hasRow,
          col: hasCol,
        });
      } catch (error) {
        console.error('[ViewMenu] Failed to load freeze state:', error);
      }
    };
    loadFreezeState();
  }, []);

  const handleFreezeTopRow = useCallback(async () => {
    console.log('[ViewMenu] handleFreezeTopRow called, current state:', freezeState);
    try {
      const newRowState = !freezeState.row;
      const freezeRow = newRowState ? 1 : null;
      const freezeCol = freezeState.col ? 1 : null;
      console.log('[ViewMenu] Calling freezePanes with:', { freezeRow, freezeCol });
      // freezePanes: calls backend + emits FREEZE_CHANGED + emits GRID_REFRESH
      await freezePanes(freezeRow, freezeCol);
      setFreezeState(prev => ({ ...prev, row: newRowState }));
    } catch (error) {
      console.error('[ViewMenu] handleFreezeTopRow error:', error);
    }
  }, [freezeState]);

  const handleFreezeFirstColumn = useCallback(async () => {
    console.log('[ViewMenu] handleFreezeFirstColumn called, current state:', freezeState);
    try {
      const newColState = !freezeState.col;
      const freezeRow = freezeState.row ? 1 : null;
      const freezeCol = newColState ? 1 : null;
      console.log('[ViewMenu] Calling freezePanes with:', { freezeRow, freezeCol });
      await freezePanes(freezeRow, freezeCol);
      setFreezeState(prev => ({ ...prev, col: newColState }));
    } catch (error) {
      console.error('[ViewMenu] handleFreezeFirstColumn error:', error);
    }
  }, [freezeState]);

  const handleFreezeBoth = useCallback(async () => {
    console.log('[ViewMenu] handleFreezeBoth called, current state:', freezeState);
    try {
      const bothFrozen = freezeState.row && freezeState.col;
      const newState = !bothFrozen;
      const freezeRow = newState ? 1 : null;
      const freezeCol = newState ? 1 : null;
      console.log('[ViewMenu] Calling freezePanes with:', { freezeRow, freezeCol });
      await freezePanes(freezeRow, freezeCol);
      setFreezeState({ row: newState, col: newState });
    } catch (error) {
      console.error('[ViewMenu] handleFreezeBoth error:', error);
    }
  }, [freezeState]);

  const handleUnfreeze = useCallback(async () => {
    console.log('[ViewMenu] handleUnfreeze called');
    try {
      console.log('[ViewMenu] Calling freezePanes with:', { freezeRow: null, freezeCol: null });
      await freezePanes(null, null);
      setFreezeState({ row: false, col: false });
    } catch (error) {
      console.error('[ViewMenu] handleUnfreeze error:', error);
    }
  }, []);

  const menu: MenuDefinition = {
    id: 'view',
    label: 'View',
    order: 30,
    items: [
      { id: 'view.showTaskpane', label: 'Show Taskpane', action: openTaskPane, hidden: isTaskPaneOpen },
      { id: 'view.hideTaskpane', label: 'Hide Taskpane', action: closeTaskPane, hidden: !isTaskPaneOpen },
      { id: 'view.sep1', label: '', separator: true },
      { id: 'view.freezeRow', label: 'Freeze Top Row', action: handleFreezeTopRow, checked: freezeState.row },
      { id: 'view.freezeCol', label: 'Freeze First Column', action: handleFreezeFirstColumn, checked: freezeState.col },
      { id: 'view.sep2', label: '', separator: true },
      { id: 'view.freezeBoth', label: 'Freeze Top Row and First Column', action: handleFreezeBoth, checked: freezeState.row && freezeState.col },
      { id: 'view.sep3', label: '', separator: true },
      { id: 'view.unfreeze', label: 'Unfreeze Panes', action: handleUnfreeze, disabled: !freezeState.row && !freezeState.col },
    ],
  };

  return {
    menu,
    handlers: {
      handleFreezeTopRow,
      handleFreezeFirstColumn,
      handleFreezeBoth,
      handleUnfreeze,
    },
    freezeState,
  };
}
