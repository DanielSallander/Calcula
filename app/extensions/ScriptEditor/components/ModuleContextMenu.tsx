//! FILENAME: app/extensions/ScriptEditor/components/ModuleContextMenu.tsx
// PURPOSE: Right-click context menu for script modules in the navigation pane.
// CONTEXT: Provides Rename, Duplicate, and Delete actions for a module.

import React, { useEffect, useRef, useCallback } from "react";

// ============================================================================
// Types
// ============================================================================

export interface ModuleContextMenuProps {
  /** Screen X position */
  x: number;
  /** Screen Y position */
  y: number;
  /** The module ID this context menu targets */
  moduleId: string;
  /** Whether this is the only module (disables Delete) */
  isLastModule: boolean;
  /** Callbacks */
  onRename: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onClose: () => void;
}

// ============================================================================
// Styles
// ============================================================================

const menuStyle: React.CSSProperties = {
  position: "fixed",
  zIndex: 1000,
  minWidth: 160,
  backgroundColor: "#252526",
  border: "1px solid #454545",
  borderRadius: 4,
  padding: "4px 0",
  boxShadow: "0 4px 12px rgba(0, 0, 0, 0.5)",
  fontFamily: "'Segoe UI', Tahoma, sans-serif",
  fontSize: 13,
};

const menuItemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  padding: "6px 16px",
  color: "#CCCCCC",
  cursor: "pointer",
  userSelect: "none",
};

const menuItemHoverStyle: React.CSSProperties = {
  ...menuItemStyle,
  backgroundColor: "#094771",
};

const menuItemDisabledStyle: React.CSSProperties = {
  ...menuItemStyle,
  color: "#666666",
  cursor: "default",
};

const separatorStyle: React.CSSProperties = {
  height: 1,
  backgroundColor: "#454545",
  margin: "4px 0",
};

// ============================================================================
// MenuItem Sub-Component
// ============================================================================

function MenuItem({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
}): React.ReactElement {
  const [hovered, setHovered] = React.useState(false);

  const style = disabled
    ? menuItemDisabledStyle
    : hovered
      ? menuItemHoverStyle
      : menuItemStyle;

  return React.createElement("div", {
    style,
    onMouseEnter: () => !disabled && setHovered(true),
    onMouseLeave: () => setHovered(false),
    onClick: disabled ? undefined : onClick,
    role: "menuitem",
    "aria-disabled": disabled,
  }, label);
}

// ============================================================================
// Component
// ============================================================================

export function ModuleContextMenu({
  x,
  y,
  isLastModule,
  onRename,
  onDuplicate,
  onDelete,
  onClose,
}: ModuleContextMenuProps): React.ReactElement {
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  const handleClickOutside = useCallback(
    (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    },
    [onClose],
  );

  // Close on Escape
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    },
    [onClose],
  );

  useEffect(() => {
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [handleClickOutside, handleKeyDown]);

  // Adjust position to stay within viewport
  const adjustedX = Math.min(x, window.innerWidth - 180);
  const adjustedY = Math.min(y, window.innerHeight - 120);

  return React.createElement(
    "div",
    {
      ref: menuRef,
      style: { ...menuStyle, left: adjustedX, top: adjustedY },
      role: "menu",
    },
    React.createElement(MenuItem, {
      label: "Rename",
      onClick: () => { onRename(); onClose(); },
    }),
    React.createElement(MenuItem, {
      label: "Duplicate",
      onClick: () => { onDuplicate(); onClose(); },
    }),
    React.createElement("div", { style: separatorStyle }),
    React.createElement(MenuItem, {
      label: "Delete",
      disabled: isLastModule,
      onClick: () => {
        if (!isLastModule) {
          onDelete();
          onClose();
        }
      },
    }),
  );
}
