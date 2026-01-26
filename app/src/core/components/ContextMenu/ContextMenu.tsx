// FILENAME: core/components/ContextMenu/ContextMenu.tsx
// PURPOSE: Reusable context menu component for grid and other areas
// CONTEXT: Used by Spreadsheet to show context menu on right-click.

import React, { useEffect, useRef, useCallback } from "react";
import * as S from "./ContextMenu.styles";

export interface ContextMenuPosition {
  x: number;
  y: number;
}

export interface ContextMenuItem {
  id: string;
  label: string;
  shortcut?: string;
  icon?: React.ReactNode;
  disabled?: boolean;
  separatorAfter?: boolean;
  onClick: () => void | Promise<void>;
}

export interface ContextMenuProps {
  position: ContextMenuPosition;
  items: ContextMenuItem[];
  onClose: () => void;
}

export function ContextMenu({
  position,
  items,
  onClose,
}: ContextMenuProps): React.ReactElement {
  const menuRef = useRef<HTMLDivElement>(null);

  console.log("[ContextMenu] Rendering with", items.length, "items at position", position);

  // Close on outside click or Escape
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    // Use setTimeout to avoid immediate close from the same click
    const timeoutId = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleKeyDown);
    }, 0);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  // Adjust position to keep menu within viewport
  useEffect(() => {
    if (!menuRef.current) return;

    const menu = menuRef.current;
    const rect = menu.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let adjustedX = position.x;
    let adjustedY = position.y;

    // Adjust horizontal position
    if (position.x + rect.width > viewportWidth) {
      adjustedX = viewportWidth - rect.width - 8;
    }

    // Adjust vertical position
    if (position.y + rect.height > viewportHeight) {
      adjustedY = viewportHeight - rect.height - 8;
    }

    // Ensure minimum position
    adjustedX = Math.max(8, adjustedX);
    adjustedY = Math.max(8, adjustedY);

    menu.style.left = `${adjustedX}px`;
    menu.style.top = `${adjustedY}px`;
  }, [position]);

  const handleItemClick = useCallback(
    async (item: ContextMenuItem) => {
      if (item.disabled) return;
      onClose();
      await item.onClick();
    },
    [onClose]
  );

  if (items.length === 0) {
    console.log("[ContextMenu] No items, returning empty");
    return <></>;
  }

  console.log("[ContextMenu] Rendering menu container");

  return (
    <S.MenuContainer
      ref={menuRef}
      role="menu"
      aria-label="Context menu"
      style={{
        left: position.x,
        top: position.y,
      }}
    >
      {items.map((item) => (
        <React.Fragment key={item.id}>
          <S.MenuItem
            type="button"
            role="menuitem"
            onClick={() => handleItemClick(item)}
            disabled={item.disabled}
          >
            {item.icon && <S.IconWrapper>{item.icon}</S.IconWrapper>}
            <S.Label>{item.label}</S.Label>
            {item.shortcut && <S.Shortcut>{item.shortcut}</S.Shortcut>}
          </S.MenuItem>
          {item.separatorAfter && <S.Separator />}
        </React.Fragment>
      ))}
    </S.MenuContainer>
  );
}