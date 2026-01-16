// FILENAME: core/components/ContextMenu/ContextMenu.tsx
// PURPOSE: Reusable context menu component for grid and other areas
// CONTEXT: Used by Spreadsheet to show context menu on right-click.
//          Designed to be extensible and follow the same visual style as SheetTabs context menu.

import React, { useEffect, useRef, useCallback } from "react";

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
    return <></>;
  }

  return (
    <div
      ref={menuRef}
      style={{
        ...styles.menu,
        left: position.x,
        top: position.y,
      }}
      role="menu"
      aria-label="Context menu"
    >
      {items.map((item) => (
        <React.Fragment key={item.id}>
          <button
            type="button"
            role="menuitem"
            style={{
              ...styles.menuItem,
              ...(item.disabled ? styles.menuItemDisabled : {}),
            }}
            onClick={() => handleItemClick(item)}
            disabled={item.disabled}
          >
            {item.icon && <span style={styles.menuItemIcon}>{item.icon}</span>}
            <span style={styles.menuItemLabel}>{item.label}</span>
            {item.shortcut && (
              <span style={styles.menuItemShortcut}>{item.shortcut}</span>
            )}
          </button>
          {item.separatorAfter && <div style={styles.separator} />}
        </React.Fragment>
      ))}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  menu: {
    position: "fixed",
    backgroundColor: "#ffffff",
    border: "1px solid #c0c0c0",
    borderRadius: "4px",
    boxShadow: "0 2px 10px rgba(0, 0, 0, 0.15)",
    padding: "4px 0",
    minWidth: "180px",
    maxWidth: "280px",
    zIndex: 10000,
  },
  menuItem: {
    display: "flex",
    alignItems: "center",
    width: "100%",
    padding: "6px 12px",
    border: "none",
    backgroundColor: "transparent",
    cursor: "pointer",
    fontSize: "12px",
    color: "#333",
    textAlign: "left",
    gap: "8px",
  },
  menuItemDisabled: {
    color: "#999",
    cursor: "default",
  },
  menuItemIcon: {
    width: "16px",
    height: "16px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  menuItemLabel: {
    flex: 1,
  },
  menuItemShortcut: {
    color: "#888",
    fontSize: "11px",
    marginLeft: "auto",
    paddingLeft: "16px",
  },
  separator: {
    height: "1px",
    backgroundColor: "#e0e0e0",
    margin: "4px 0",
  },
};