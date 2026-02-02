//! FILENAME: app/extensions/pivot/components/ValueFieldContextMenu.tsx
// PURPOSE: Context menu for value field items in the pivot editor
// CONTEXT: Shown on right-click, provides options for field settings and number format

import React, { useEffect, useRef } from "react";
import { css } from "@emotion/css";

export interface ValueFieldContextMenuProps {
  position: { x: number; y: number };
  onValueFieldSettings: () => void;
  onNumberFormat: () => void;
  onRemove: () => void;
  onClose: () => void;
}

const menuStyles = {
  container: css`
    position: fixed;
    background: #fff;
    border: 1px solid #d0d0d0;
    border-radius: 4px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    z-index: 10000;
    min-width: 180px;
    padding: 4px 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
      sans-serif;
    font-size: 12px;
  `,
  menuItem: css`
    display: flex;
    align-items: center;
    width: 100%;
    padding: 8px 12px;
    text-align: left;
    background: none;
    border: none;
    cursor: pointer;
    color: #333;
    gap: 8px;

    &:hover {
      background: #f0f0f0;
    }

    &:focus {
      outline: none;
      background: #e8e8e8;
    }
  `,
  separator: css`
    height: 1px;
    background: #e0e0e0;
    margin: 4px 0;
  `,
  icon: css`
    width: 16px;
    text-align: center;
    color: #666;
    font-size: 14px;
  `,
  label: css`
    flex: 1;
  `,
  danger: css`
    color: #d32f2f;

    &:hover {
      background: #ffebee;
    }
  `,
};

export function ValueFieldContextMenu({
  position,
  onValueFieldSettings,
  onNumberFormat,
  onRemove,
  onClose,
}: ValueFieldContextMenuProps): React.ReactElement {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    // Delay adding listener to prevent immediate close
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

  // Adjust position to keep menu in viewport
  const adjustedPosition = {
    x: Math.min(position.x, window.innerWidth - 200),
    y: Math.min(position.y, window.innerHeight - 150),
  };

  return (
    <div
      ref={menuRef}
      className={menuStyles.container}
      style={{
        left: adjustedPosition.x,
        top: adjustedPosition.y,
      }}
    >
      <button
        className={menuStyles.menuItem}
        onClick={() => {
          onValueFieldSettings();
          onClose();
        }}
      >
        <span className={menuStyles.icon}>&#9881;</span>
        <span className={menuStyles.label}>Value Field Settings...</span>
      </button>
      <button
        className={menuStyles.menuItem}
        onClick={() => {
          onNumberFormat();
          onClose();
        }}
      >
        <span className={menuStyles.icon}>#</span>
        <span className={menuStyles.label}>Number Format...</span>
      </button>
      <div className={menuStyles.separator} />
      <button
        className={`${menuStyles.menuItem} ${menuStyles.danger}`}
        onClick={() => {
          onRemove();
          onClose();
        }}
      >
        <span className={menuStyles.icon}>&#10005;</span>
        <span className={menuStyles.label}>Remove Field</span>
      </button>
    </div>
  );
}
