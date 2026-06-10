//! FILENAME: app/src/shell/Ribbon/PanelContextMenu.tsx
// PURPOSE: Context menu for moving panels between sidebar and ribbon
// CONTEXT: Shown on right-click of ribbon tab headers, activity bar icons,
// and side panel headers. Part of the location-agnostic panel system.

import React, { useEffect, useRef } from "react";
import type { PanelPlacement } from "../../api/uiTypes";

export interface PanelContextMenuProps {
  /** Screen coordinates where the menu should appear */
  position: { x: number; y: number };
  /** Current placement of the panel */
  currentPlacement: PanelPlacement;
  /** Called when the user selects a new placement */
  onMove: (placement: PanelPlacement) => void;
  /** Called to close the menu */
  onClose: () => void;
}

/**
 * Minimal context menu with "Move to Sidebar" / "Move to Ribbon" option.
 */
export function PanelContextMenu({
  position,
  currentPlacement,
  onMove,
  onClose,
}: PanelContextMenuProps): React.ReactElement {
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };

    // Delay to avoid catching the right-click that opened this menu
    const timeoutId = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
    }, 0);
    document.addEventListener("keydown", handleEscape);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [onClose]);

  const targetPlacement: PanelPlacement = currentPlacement === "ribbon" ? "sidebar" : "ribbon";
  const label = currentPlacement === "ribbon" ? "Move to Sidebar" : "Move to Ribbon";

  const handleClick = () => {
    onMove(targetPlacement);
    onClose();
  };

  return (
    <div
      ref={menuRef}
      style={{
        position: "fixed",
        left: position.x,
        top: position.y,
        zIndex: 10000,
        backgroundColor: "#fff",
        border: "1px solid #d0d0d0",
        borderRadius: 4,
        boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
        padding: "4px 0",
        minWidth: 160,
      }}
    >
      <button
        onClick={handleClick}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          width: "100%",
          padding: "6px 16px",
          border: "none",
          backgroundColor: "transparent",
          cursor: "pointer",
          fontSize: "12px",
          color: "#333",
          fontFamily: "'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif",
          textAlign: "left",
        }}
        onMouseEnter={(e) => {
          (e.target as HTMLElement).style.backgroundColor = "#f0f0f0";
        }}
        onMouseLeave={(e) => {
          (e.target as HTMLElement).style.backgroundColor = "transparent";
        }}
      >
        {targetPlacement === "sidebar" ? (
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#555" strokeWidth="1.2">
            <rect x="1" y="2" width="14" height="12" rx="1" />
            <line x1="5" y1="2" x2="5" y2="14" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#555" strokeWidth="1.2">
            <rect x="1" y="2" width="14" height="12" rx="1" />
            <line x1="1" y1="5" x2="15" y2="5" />
          </svg>
        )}
        {label}
      </button>
    </div>
  );
}
