//! FILENAME: app/src/shell/Overlays/GridContextMenuHost.tsx
// PURPOSE: Shell component that listens for context menu events from Core
// CONTEXT: Implements Inversion of Control - Core emits events, Shell renders UI

import React, { useState, useEffect, useCallback } from "react";
import {
  AppEvents,
  onAppEvent,
  restoreFocusToGrid,
  gridExtensions,
  type ContextMenuRequestPayload,
  type GridMenuContext,
} from "../../api";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

interface ContextMenuState {
  position: { x: number; y: number };
  context: GridMenuContext;
}

export function GridContextMenuHost(): React.ReactElement | null {
  const [menuState, setMenuState] = useState<ContextMenuState | null>(null);

  // Listen for context menu requests from Core
  useEffect(() => {
    const cleanup = onAppEvent<ContextMenuRequestPayload>(
      AppEvents.CONTEXT_MENU_REQUEST,
      (payload) => {
        setMenuState({
          position: payload.position,
          context: payload.context,
        });
      }
    );

    return cleanup;
  }, []);

  // Listen for close requests
  useEffect(() => {
    const cleanup = onAppEvent(AppEvents.CONTEXT_MENU_CLOSE, () => {
      setMenuState(null);
    });

    return cleanup;
  }, []);

  const handleClose = useCallback(() => {
    setMenuState(null);
    // Restore focus to grid after menu closes
    setTimeout(() => {
      restoreFocusToGrid();
    }, 0);
  }, []);

  // Convert GridContextMenuItem to ContextMenuItem
  const getMenuItems = useCallback((): ContextMenuItem[] => {
    if (!menuState) return [];

    const items = gridExtensions.getContextMenuItemsForContext(menuState.context);

    return items.map((item) => ({
      id: item.id,
      label: item.label,
      shortcut: item.shortcut,
      icon: item.icon,
      disabled: !!item.disabled,
      separatorAfter: item.separatorAfter,
      onClick: () => item.onClick(menuState.context),
    }));
  }, [menuState]);

  if (!menuState) {
    return null;
  }

  return (
    <ContextMenu
      position={menuState.position}
      items={getMenuItems()}
      onClose={handleClose}
    />
  );
}