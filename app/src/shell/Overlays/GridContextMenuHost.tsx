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
  type GridContextMenuItem,
} from "../../api";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

interface ContextMenuState {
  position: { x: number; y: number };
  context: GridMenuContext;
}

/** Minimum item count to show the search input */
const SEARCH_THRESHOLD = 10;

/**
 * Recursively convert a resolved GridContextMenuItem to a ContextMenuItem.
 * Labels are already resolved to strings by the registry layer.
 */
function mapItem(
  item: GridContextMenuItem,
  context: GridMenuContext,
  onClose: () => void,
): ContextMenuItem {
  return {
    id: item.id,
    label: item.label as string, // Already resolved by getContextMenuItemsForContext
    shortcut: item.shortcut,
    icon: item.icon,
    disabled: !!item.disabled,
    separatorAfter: item.separatorAfter,
    onClick: () => item.onClick(context),
    children: item.children?.map((child) => mapItem(child, context, onClose)),
  };
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

  // Convert GridContextMenuItem[] to ContextMenuItem[]
  const getMenuItems = useCallback((): ContextMenuItem[] => {
    if (!menuState) return [];

    const items = gridExtensions.getContextMenuItemsForContext(menuState.context);

    return items.map((item) => mapItem(item, menuState.context, handleClose));
  }, [menuState, handleClose]);

  if (!menuState) {
    return null;
  }

  const items = getMenuItems();

  return (
    <ContextMenu
      position={menuState.position}
      items={items}
      onClose={handleClose}
      showSearch={items.length > SEARCH_THRESHOLD}
    />
  );
}
