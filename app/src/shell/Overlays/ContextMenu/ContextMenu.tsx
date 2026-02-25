//! FILENAME: app/src/shell/Overlays/ContextMenu/ContextMenu.tsx
// PURPOSE: Reusable context menu component for grid and other areas
// CONTEXT: Shell-level UI overlay. Core emits events; Shell renders this.
//          Supports sub-menus (children) and optional search input.

import React, { useEffect, useRef, useCallback, useState } from "react";
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
  /** Sub-menu items. When present, this item acts as a sub-menu trigger. */
  children?: ContextMenuItem[];
}

export interface ContextMenuProps {
  position: ContextMenuPosition;
  items: ContextMenuItem[];
  onClose: () => void;
  /** When true, shows a search input at the top of the menu. */
  showSearch?: boolean;
  /** Internal: marks this as a nested sub-menu (skips outside-click handling). */
  isSubMenu?: boolean;
}

// ---------------------------------------------------------------------------
// Search filter helper
// ---------------------------------------------------------------------------

/**
 * Recursively filter items by search query (case-insensitive substring match).
 * An item is kept if its own label matches OR any child's label matches.
 */
function filterItemsBySearch(
  items: ContextMenuItem[],
  query: string,
): ContextMenuItem[] {
  if (!query) return items;
  const lower = query.toLowerCase();

  return items.reduce<ContextMenuItem[]>((acc, item) => {
    const labelMatches = item.label.toLowerCase().includes(lower);
    const filteredChildren = item.children
      ? filterItemsBySearch(item.children, query)
      : undefined;
    const childMatches = filteredChildren && filteredChildren.length > 0;

    if (labelMatches || childMatches) {
      acc.push({
        ...item,
        children: childMatches ? filteredChildren : item.children,
      });
    }
    return acc;
  }, []);
}

// ---------------------------------------------------------------------------
// Sub-menu item component
// ---------------------------------------------------------------------------

function MenuItemWithSubMenu({
  item,
  onClose,
}: {
  item: ContextMenuItem;
  onClose: () => void;
}): React.ReactElement {
  const itemRef = useRef<HTMLButtonElement>(null);
  const [subMenuOpen, setSubMenuOpen] = useState(false);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (openTimerRef.current) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  // Clean up timers on unmount
  useEffect(() => clearTimers, [clearTimers]);

  const handleMouseEnter = useCallback(() => {
    clearTimers();
    openTimerRef.current = setTimeout(() => setSubMenuOpen(true), 200);
  }, [clearTimers]);

  const handleMouseLeave = useCallback(() => {
    clearTimers();
    closeTimerRef.current = setTimeout(() => setSubMenuOpen(false), 150);
  }, [clearTimers]);

  // Compute sub-menu position relative to this item
  const getSubMenuPosition = (): ContextMenuPosition => {
    if (!itemRef.current) return { x: 0, y: 0 };
    const rect = itemRef.current.getBoundingClientRect();
    const viewportWidth = window.innerWidth;

    // Position to the right by default; flip to left if not enough space
    let x = rect.right;
    if (x + 180 > viewportWidth) {
      x = rect.left - 180;
    }
    return { x, y: rect.top };
  };

  return (
    <div onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}>
      <S.MenuItem
        ref={itemRef}
        type="button"
        role="menuitem"
        aria-haspopup="true"
        aria-expanded={subMenuOpen}
        disabled={item.disabled}
      >
        {item.icon && <S.IconWrapper>{item.icon}</S.IconWrapper>}
        <S.Label>{item.label}</S.Label>
        <S.SubMenuIndicator>&#9656;</S.SubMenuIndicator>
      </S.MenuItem>
      {item.separatorAfter && <S.Separator />}
      {subMenuOpen && item.children && item.children.length > 0 && (
        <ContextMenu
          position={getSubMenuPosition()}
          items={item.children}
          onClose={onClose}
          isSubMenu
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main ContextMenu component
// ---------------------------------------------------------------------------

export function ContextMenu({
  position,
  items,
  onClose,
  showSearch = false,
  isSubMenu = false,
}: ContextMenuProps): React.ReactElement {
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [searchQuery, setSearchQuery] = useState("");

  // Close on outside click or Escape (only for root menu, not sub-menus)
  useEffect(() => {
    if (isSubMenu) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (searchQuery) {
          setSearchQuery("");
        } else {
          onClose();
        }
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
  }, [onClose, isSubMenu, searchQuery]);

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

  // Auto-focus search input when showing search
  useEffect(() => {
    if (showSearch && searchRef.current) {
      searchRef.current.focus();
    }
  }, [showSearch]);

  const handleItemClick = useCallback(
    async (item: ContextMenuItem) => {
      if (item.disabled || item.children) return;
      onClose();
      await item.onClick();
    },
    [onClose]
  );

  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        if (searchQuery) {
          setSearchQuery("");
          e.stopPropagation();
        }
      }
    },
    [searchQuery]
  );

  const filteredItems = showSearch
    ? filterItemsBySearch(items, searchQuery)
    : items;

  if (filteredItems.length === 0 && !showSearch) {
    return <></>;
  }

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
      {showSearch && (
        <>
          <S.SearchInput
            ref={searchRef}
            type="text"
            placeholder="Search the menus"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            onClick={(e) => e.stopPropagation()}
          />
          <S.Separator />
        </>
      )}
      {filteredItems.map((item) => (
        <React.Fragment key={item.id}>
          {item.children && item.children.length > 0 ? (
            <MenuItemWithSubMenu item={item} onClose={onClose} />
          ) : (
            <>
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
            </>
          )}
        </React.Fragment>
      ))}
    </S.MenuContainer>
  );
}
