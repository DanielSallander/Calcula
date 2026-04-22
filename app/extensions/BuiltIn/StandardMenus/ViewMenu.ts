//! FILENAME: app/extensions/BuiltIn/StandardMenus/ViewMenu.ts
// REFACTORED: All imports now go through app/src/api (The Facade Rule).
// UPDATED: Reorganized into submenus (Sidebar, Panels, Freeze Panes).

import { useCallback, useEffect, useState } from 'react';
import type { MenuDefinition, MenuItemDefinition } from '@api/ui';
import {
  freezePanes,
  loadFreezePanesConfig,
  splitWindow,
  loadSplitWindowConfig,
  removeSplitWindow,
} from '@api/grid';
import { useGridState } from '@api/grid';
import { emitAppEvent, AppEvents } from '@api/events';
import { showDialog } from '@api/ui';
import type { ViewMode } from '@api';
import {
  useIsTaskPaneOpen,
  useOpenTaskPaneAction,
  useCloseTaskPaneAction,
  useTaskPaneOpenPaneIds,
  useTaskPaneManuallyClosed,
  useTaskPaneActiveContextKeys,
  TaskPaneExtensions,
  closeTaskPane as closeTaskPaneById,
  clearTaskPaneManuallyClosed,
  markTaskPaneManuallyClosed,
  useIsActivityBarOpen,
  useActiveActivityViewId,
  toggleActivityView,
  ActivityBarExtensions,
} from '@api/ui';
import {
  IconNormalView,
  IconPageLayoutView,
  IconPageBreakPreview,
  IconSidebar,
  IconPanels,
  IconFreezePanes,
  IconFreezeRow,
  IconFreezeCol,
  IconFreezeBoth,
  IconUnfreeze,
  IconSplitWindow,
  IconGoToSpecial,
  IconShowFormulas,
  IconDisplayZeros,
  IconOtherOptions,
} from '@api';

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
  const [isSplit, setIsSplit] = useState(false);
  const gridState = useGridState();

  // Task pane state via API hooks (no shell import)
  const isTaskPaneOpen = useIsTaskPaneOpen();
  const openTaskPane = useOpenTaskPaneAction();
  const closeTaskPane = useCloseTaskPaneAction();

  // Task pane view state for dynamic Show/Hide items
  const openPaneIds = useTaskPaneOpenPaneIds();
  const manuallyClosed = useTaskPaneManuallyClosed();
  const activeContextKeys = useTaskPaneActiveContextKeys();

  useEffect(() => {
    const loadState = async () => {
      try {
        const config = await loadFreezePanesConfig();
        const hasRow = config.freezeRow !== null && config.freezeRow > 0;
        const hasCol = config.freezeCol !== null && config.freezeCol > 0;
        setFreezeState({ row: hasRow, col: hasCol });

        const splitConfig = await loadSplitWindowConfig();
        const hasSplit = (splitConfig.splitRow !== null && splitConfig.splitRow > 0) ||
                         (splitConfig.splitCol !== null && splitConfig.splitCol > 0);
        setIsSplit(hasSplit);
      } catch (error) {
        console.error('[ViewMenu] Failed to load state:', error);
      }
    };
    loadState();
  }, []);

  const handleFreezeTopRow = useCallback(async () => {
    try {
      const newRowState = !freezeState.row;
      const freezeRow = newRowState ? 1 : null;
      const freezeCol = freezeState.col ? 1 : null;
      await freezePanes(freezeRow, freezeCol);
      setFreezeState(prev => ({ ...prev, row: newRowState }));
    } catch (error) {
      console.error('[ViewMenu] handleFreezeTopRow error:', error);
    }
  }, [freezeState]);

  const handleFreezeFirstColumn = useCallback(async () => {
    try {
      const newColState = !freezeState.col;
      const freezeRow = freezeState.row ? 1 : null;
      const freezeCol = newColState ? 1 : null;
      await freezePanes(freezeRow, freezeCol);
      setFreezeState(prev => ({ ...prev, col: newColState }));
    } catch (error) {
      console.error('[ViewMenu] handleFreezeFirstColumn error:', error);
    }
  }, [freezeState]);

  const handleFreezeBoth = useCallback(async () => {
    try {
      const bothFrozen = freezeState.row && freezeState.col;
      const newState = !bothFrozen;
      const freezeRow = newState ? 1 : null;
      const freezeCol = newState ? 1 : null;
      await freezePanes(freezeRow, freezeCol);
      setFreezeState({ row: newState, col: newState });
    } catch (error) {
      console.error('[ViewMenu] handleFreezeBoth error:', error);
    }
  }, [freezeState]);

  const handleUnfreeze = useCallback(async () => {
    try {
      await freezePanes(null, null);
      setFreezeState({ row: false, col: false });
    } catch (error) {
      console.error('[ViewMenu] handleUnfreeze error:', error);
    }
  }, []);

  // Split Window handler
  const handleSplitWindow = useCallback(async () => {
    try {
      if (isSplit) {
        await removeSplitWindow();
        setIsSplit(false);
      } else {
        const sel = gridState.selection;
        const splitRow = sel && sel.startRow > 0 ? sel.startRow : 5;
        const splitCol = sel && sel.startCol > 0 ? sel.startCol : 3;
        await splitWindow(splitRow, splitCol);
        setIsSplit(true);
      }
    } catch (error) {
      console.error('[ViewMenu] handleSplitWindow error:', error);
    }
  }, [isSplit, gridState.selection]);

  const handleRemoveSplit = useCallback(async () => {
    try {
      await removeSplitWindow();
      setIsSplit(false);
    } catch (error) {
      console.error('[ViewMenu] handleRemoveSplit error:', error);
    }
  }, []);

  // Go To Special handler
  const handleGoToSpecial = useCallback(() => {
    showDialog("go-to-special");
  }, []);

  // View Mode handlers
  const handleNormalView = useCallback(() => {
    emitAppEvent(AppEvents.VIEW_MODE_CHANGED, { viewMode: "normal" as ViewMode });
    emitAppEvent(AppEvents.GRID_REFRESH);
  }, []);

  const handlePageLayoutView = useCallback(() => {
    emitAppEvent(AppEvents.VIEW_MODE_CHANGED, { viewMode: "pageLayout" as ViewMode });
    emitAppEvent(AppEvents.GRID_REFRESH);
  }, []);

  const handlePageBreakPreview = useCallback(() => {
    emitAppEvent(AppEvents.VIEW_MODE_CHANGED, { viewMode: "pageBreakPreview" as ViewMode });
    emitAppEvent(AppEvents.GRID_REFRESH);
  }, []);

  // Show Formulas handler
  const handleToggleShowFormulas = useCallback(() => {
    const newValue = !gridState.showFormulas;
    emitAppEvent(AppEvents.SHOW_FORMULAS_TOGGLED, { showFormulas: newValue });
    emitAppEvent(AppEvents.GRID_REFRESH);
  }, [gridState.showFormulas]);

  // Display Zeros handler
  const handleToggleDisplayZeros = useCallback(() => {
    const newValue = !gridState.displayZeros;
    emitAppEvent(AppEvents.DISPLAY_ZEROS_TOGGLED, { displayZeros: newValue });
    emitAppEvent(AppEvents.GRID_REFRESH);
  }, [gridState.displayZeros]);

  // Activity Bar state
  const isActivityBarOpen = useIsActivityBarOpen();
  const activeActivityViewId = useActiveActivityViewId();

  // ---------------------------------------------------------------------------
  // Dynamic Show/Hide items for task pane views based on active context
  // ---------------------------------------------------------------------------

  const allViews = TaskPaneExtensions.getAllViews();
  const dynamicPaneItems: MenuItemDefinition[] = [];

  for (const view of allViews) {
    if (view.closable === false) continue;

    const isContextActive = view.contextKeys.some(
      (key) => key === "always" || activeContextKeys.includes(key),
    );
    if (!isContextActive) continue;

    const isPaneVisible = isTaskPaneOpen && openPaneIds.includes(view.id);

    dynamicPaneItems.push({
      id: `view.showPane.${view.id}`,
      label: `Show ${view.title}`,
      action: () => {
        clearTaskPaneManuallyClosed(view.id);
        window.dispatchEvent(
          new CustomEvent("taskpane:requestReopen", { detail: { viewId: view.id } }),
        );
      },
      hidden: isPaneVisible,
    });

    dynamicPaneItems.push({
      id: `view.hidePane.${view.id}`,
      label: `Hide ${view.title}`,
      action: () => {
        markTaskPaneManuallyClosed(view.id);
        closeTaskPaneById(view.id);
      },
      hidden: !isPaneVisible,
    });
  }

  // ---------------------------------------------------------------------------
  // Activity Bar (Sidebar) items
  // ---------------------------------------------------------------------------

  const activityBarViews = ActivityBarExtensions.getAllViews();
  const sidebarChildren: MenuItemDefinition[] = activityBarViews.map((view) => ({
    id: `view.activity.${view.id}`,
    label: view.title,
    shortcut: view.id === 'explorer' ? 'Ctrl+Shift+E' :
              view.id === 'search' ? 'Ctrl+Shift+H' :
              view.id === 'extensions' ? 'Ctrl+Shift+X' : undefined,
    action: () => toggleActivityView(view.id),
    checked: isActivityBarOpen && activeActivityViewId === view.id,
  }));

  // ---------------------------------------------------------------------------
  // Panels submenu children (Taskpane toggle + dynamic panes)
  // ---------------------------------------------------------------------------

  const panelsChildren: MenuItemDefinition[] = [
    { id: 'view.showTaskpane', label: 'Show Taskpane', action: openTaskPane, hidden: isTaskPaneOpen },
    { id: 'view.hideTaskpane', label: 'Hide Taskpane', action: closeTaskPane, hidden: !isTaskPaneOpen },
  ];

  if (dynamicPaneItems.length > 0) {
    panelsChildren.push({ id: 'view.panelsSep', label: '', separator: true });
    panelsChildren.push(...dynamicPaneItems);
  }

  // ---------------------------------------------------------------------------
  // Build menu
  // ---------------------------------------------------------------------------

  const currentViewMode = gridState.viewMode || "normal";
  const items: MenuItemDefinition[] = [];

  // View Mode section
  items.push(
    { id: 'view.normalView', label: 'Normal View', icon: IconNormalView, action: handleNormalView, checked: currentViewMode === "normal" },
    { id: 'view.pageLayoutView', label: 'Page Layout View', icon: IconPageLayoutView, action: handlePageLayoutView, checked: currentViewMode === "pageLayout" },
    { id: 'view.pageBreakPreview', label: 'Page Break Preview', icon: IconPageBreakPreview, action: handlePageBreakPreview, checked: currentViewMode === "pageBreakPreview" },
    { id: 'view.sepViews', label: '', separator: true },
  );

  // Sidebar submenu (Activity Bar views)
  if (sidebarChildren.length > 0) {
    items.push({
      id: 'view.sidebar',
      label: 'Sidebar',
      icon: IconSidebar,
      children: sidebarChildren,
    });
  }

  // Panels submenu (Task pane views)
  items.push({
    id: 'view.panels',
    label: 'Panels',
    icon: IconPanels,
    children: panelsChildren,
  });

  items.push({ id: 'view.sep1', label: '', separator: true });

  // Freeze Panes submenu
  items.push({
    id: 'view.freezePanes',
    label: 'Freeze Panes',
    icon: IconFreezePanes,
    children: [
      { id: 'view.freezeRow', label: 'Freeze Top Row', icon: IconFreezeRow, action: handleFreezeTopRow, checked: freezeState.row },
      { id: 'view.freezeCol', label: 'Freeze First Column', icon: IconFreezeCol, action: handleFreezeFirstColumn, checked: freezeState.col },
      { id: 'view.freezeSep', label: '', separator: true },
      { id: 'view.freezeBoth', label: 'Freeze Top Row and First Column', icon: IconFreezeBoth, action: handleFreezeBoth, checked: freezeState.row && freezeState.col },
      { id: 'view.unfreezeSep', label: '', separator: true },
      { id: 'view.unfreeze', label: 'Unfreeze Panes', icon: IconUnfreeze, action: handleUnfreeze, disabled: !freezeState.row && !freezeState.col },
    ],
  });

  // Split Window
  items.push({
    id: 'view.split',
    label: isSplit ? 'Remove Split' : 'Split Window',
    icon: IconSplitWindow,
    action: isSplit ? handleRemoveSplit : handleSplitWindow,
  });

  items.push({ id: 'view.sep2', label: '', separator: true });

  // Go To Special
  items.push({
    id: 'view.goToSpecial',
    label: 'Go To Special...',
    icon: IconGoToSpecial,
    action: handleGoToSpecial,
    shortcut: 'Ctrl+G',
  });

  // Show Formulas
  items.push({
    id: 'view.showFormulas',
    label: 'Show Formulas',
    icon: IconShowFormulas,
    action: handleToggleShowFormulas,
    checked: gridState.showFormulas,
    shortcut: 'Ctrl+`',
  });

  // Display Zeros
  items.push({
    id: 'view.displayZeros',
    label: 'Display Zeros',
    icon: IconDisplayZeros,
    action: handleToggleDisplayZeros,
    checked: gridState.displayZeros,
  });

  const menu: MenuDefinition = {
    id: 'view',
    label: 'View',
    order: 30,
    items,
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
