//! FILENAME: app/src/shell/Ribbon/PanelContextMenu.tsx
// PURPOSE: Context menu for moving panels between sidebar and ribbon
// CONTEXT: Shown on right-click of ribbon tab headers, activity bar icons,
// and side panel headers. Part of the location-agnostic panel system.

import React, { useEffect, useRef } from "react";
import type { PanelPlacement } from "../../api/uiTypes";
import { emitAppEvent } from "../../api/events";

export interface PanelContextMenuProps {
  /** Screen coordinates where the menu should appear */
  position: { x: number; y: number };
  /** Current placement of the panel */
  currentPlacement: PanelPlacement;
  /** The panel ID (for scriptable objects) */
  panelId: string;
  /** The panel display title (for script editor) */
  panelTitle: string;
  /** Whether the panel may be moved to the opposite surface (movable panels
   *  only — placement itself is total freedom). Defaults to true. */
  canMoveToTarget?: boolean;
  /** Soft product hint shown under the move item (e.g. "Works best in the
   *  sidebar") when the target surface is outside the panel's declared
   *  supportedPlacements. Never blocks the move. */
  moveHint?: string | null;
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
  panelId,
  panelTitle,
  canMoveToTarget = true,
  moveHint,
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

  const handleMoveClick = () => {
    onMove(targetPlacement);
    onClose();
  };

  const handleEditScript = () => {
    emitAppEvent("scriptable-objects:edit-script", {
      objectType: "panel",
      instanceId: panelId,
      objectName: panelTitle,
    });
    onClose();
  };

  const menuItemStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    width: "100%",
    padding: "6px 16px",
    border: "none",
    backgroundColor: "transparent",
    cursor: "pointer",
    fontSize: "12px",
    color: "var(--ctx-menu-text)",
    fontFamily: "'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif",
    textAlign: "left",
  };

  const handleMouseEnter = (e: React.MouseEvent) => {
    (e.target as HTMLElement).style.backgroundColor = "var(--ctx-menu-item-hover-bg)";
  };
  const handleMouseLeave = (e: React.MouseEvent) => {
    (e.target as HTMLElement).style.backgroundColor = "transparent";
  };

  return (
    <div
      ref={menuRef}
      style={{
        position: "fixed",
        left: position.x,
        top: position.y,
        zIndex: 10000,
        backgroundColor: "var(--ctx-menu-bg)",
        border: "1px solid var(--ctx-menu-border)",
        borderRadius: 4,
        boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
        padding: "4px 0",
        minWidth: 160,
      }}
    >
      {canMoveToTarget && (
        <>
          <button
            onClick={handleMoveClick}
            style={menuItemStyle}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
          >
            {targetPlacement === "sidebar" ? (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--text-secondary)" strokeWidth="1.2">
                <rect x="1" y="2" width="14" height="12" rx="1" />
                <line x1="5" y1="2" x2="5" y2="14" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--text-secondary)" strokeWidth="1.2">
                <rect x="1" y="2" width="14" height="12" rx="1" />
                <line x1="1" y1="5" x2="15" y2="5" />
              </svg>
            )}
            <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
              {label}
              {moveHint && (
                <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>{moveHint}</span>
              )}
            </span>
          </button>

          {/* Separator */}
          <div style={{ height: 1, backgroundColor: "var(--ctx-menu-separator)", margin: "4px 0" }} />
        </>
      )}

      <button
        onClick={handleEditScript}
        style={menuItemStyle}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--text-secondary)" strokeWidth="1.2">
          <path d="M2 12l1-4 7-7 3 3-7 7-4 1z" />
          <path d="M10 4l3 3" />
        </svg>
        Edit Script...
      </button>
    </div>
  );
}
