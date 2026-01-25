import { useCallback, useEffect, useState } from 'react';
import { setFreezePanes, getFreezePanes } from '../../../core/lib/tauri-api';
import { setFreezeConfig } from '../../../core/state/gridActions';
import type { Menu } from '../MenuBar.types';
import { MenuEvents, emitMenuEvent } from '../MenuBar.events';

export interface ViewMenuHandlers {
  handleFreezeTopRow: () => Promise<void>;
  handleFreezeFirstColumn: () => Promise<void>;
  handleFreezeBoth: () => Promise<void>;
  handleUnfreeze: () => Promise<void>;
}

export interface ViewMenuDependencies {
  // Use 'any' here to allow passing Dispatch<GridAction> or other specific action types
  dispatch: React.Dispatch<any>;
}

export interface FreezeState {
  row: boolean;
  col: boolean;
}

export function useViewMenu(deps: ViewMenuDependencies): { menu: Menu; handlers: ViewMenuHandlers; freezeState: FreezeState } {
  const { dispatch } = deps;
  const [freezeState, setFreezeState] = useState<FreezeState>({ row: false, col: false });

  useEffect(() => {
    const loadFreezeState = async () => {
      console.log('[ViewMenu] Loading freeze state...');
      try {
        const config = await getFreezePanes();
        console.log('[ViewMenu] Loaded freeze config:', config);
        const hasRow = config.freezeRow !== null && config.freezeRow > 0;
        const hasCol = config.freezeCol !== null && config.freezeCol > 0;
        setFreezeState({
          row: hasRow,
          col: hasCol,
        });
        dispatch(setFreezeConfig(
          hasRow ? config.freezeRow : null,
          hasCol ? config.freezeCol : null
        ));
      } catch (error) {
        console.error('[ViewMenu] Failed to load freeze state:', error);
      }
    };
    loadFreezeState();
  }, [dispatch]);

  const handleFreezeTopRow = useCallback(async () => {
    console.log('[ViewMenu] handleFreezeTopRow called, current state:', freezeState);
    try {
      const newRowState = !freezeState.row;
      const freezeRow = newRowState ? 1 : null;
      const freezeCol = freezeState.col ? 1 : null;
      console.log('[ViewMenu] Calling setFreezePanes with:', { freezeRow, freezeCol });
      const result = await setFreezePanes(freezeRow, freezeCol);
      console.log('[ViewMenu] setFreezePanes result:', result);
      setFreezeState(prev => ({ ...prev, row: newRowState }));
      dispatch(setFreezeConfig(freezeRow, freezeCol));
      emitMenuEvent(MenuEvents.FREEZE_CHANGED, { freezeRow, freezeCol });
      window.dispatchEvent(new CustomEvent('grid:refresh'));
    } catch (error) {
      console.error('[ViewMenu] handleFreezeTopRow error:', error);
    }
  }, [freezeState, dispatch]);

  const handleFreezeFirstColumn = useCallback(async () => {
    console.log('[ViewMenu] handleFreezeFirstColumn called, current state:', freezeState);
    try {
      const newColState = !freezeState.col;
      const freezeRow = freezeState.row ? 1 : null;
      const freezeCol = newColState ? 1 : null;
      console.log('[ViewMenu] Calling setFreezePanes with:', { freezeRow, freezeCol });
      const result = await setFreezePanes(freezeRow, freezeCol);
      console.log('[ViewMenu] setFreezePanes result:', result);
      setFreezeState(prev => ({ ...prev, col: newColState }));
      dispatch(setFreezeConfig(freezeRow, freezeCol));
      emitMenuEvent(MenuEvents.FREEZE_CHANGED, { freezeRow, freezeCol });
      window.dispatchEvent(new CustomEvent('grid:refresh'));
    } catch (error) {
      console.error('[ViewMenu] handleFreezeFirstColumn error:', error);
    }
  }, [freezeState, dispatch]);

  const handleFreezeBoth = useCallback(async () => {
    console.log('[ViewMenu] handleFreezeBoth called, current state:', freezeState);
    try {
      const bothFrozen = freezeState.row && freezeState.col;
      const newState = !bothFrozen;
      const freezeRow = newState ? 1 : null;
      const freezeCol = newState ? 1 : null;
      console.log('[ViewMenu] Calling setFreezePanes with:', { freezeRow, freezeCol });
      const result = await setFreezePanes(freezeRow, freezeCol);
      console.log('[ViewMenu] setFreezePanes result:', result);
      setFreezeState({ row: newState, col: newState });
      dispatch(setFreezeConfig(freezeRow, freezeCol));
      emitMenuEvent(MenuEvents.FREEZE_CHANGED, { freezeRow, freezeCol });
      window.dispatchEvent(new CustomEvent('grid:refresh'));
    } catch (error) {
      console.error('[ViewMenu] handleFreezeBoth error:', error);
    }
  }, [freezeState, dispatch]);

  const handleUnfreeze = useCallback(async () => {
    console.log('[ViewMenu] handleUnfreeze called');
    try {
      console.log('[ViewMenu] Calling setFreezePanes with:', { freezeRow: null, freezeCol: null });
      const result = await setFreezePanes(null, null);
      console.log('[ViewMenu] setFreezePanes result:', result);
      setFreezeState({ row: false, col: false });
      dispatch(setFreezeConfig(null, null));
      emitMenuEvent(MenuEvents.FREEZE_CHANGED, { freezeRow: null, freezeCol: null });
      window.dispatchEvent(new CustomEvent('grid:refresh'));
    } catch (error) {
      console.error('[ViewMenu] handleUnfreeze error:', error);
    }
  }, [dispatch]);

  const menu: Menu = {
    label: 'View',
    items: [
      { label: 'Freeze Top Row', action: handleFreezeTopRow, checked: freezeState.row },
      { label: 'Freeze First Column', action: handleFreezeFirstColumn, checked: freezeState.col },
      { separator: true, label: '' },
      { label: 'Freeze Top Row and First Column', action: handleFreezeBoth, checked: freezeState.row && freezeState.col },
      { separator: true, label: '' },
      { label: 'Unfreeze Panes', action: handleUnfreeze, disabled: !freezeState.row && !freezeState.col },
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