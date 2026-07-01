//! FILENAME: app/src/shell/ActivityBar/SidePanel.tsx
// PURPOSE: Expandable side panel that renders the active Activity View
// CONTEXT: Sits to the right of the Activity Bar, shows registered view content

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useActivityBarStore } from "./useActivityBarStore";
import { ActivityBarExtensions } from "../registries/activityBarExtensions";
import type { ActivityViewDefinition } from "../../api/uiTypes";
import type { PanelPlacement } from "../../api/uiTypes";
import { panelRegistry } from "../registries/panelRegistry";
import { PanelContextMenu } from "../Ribbon/PanelContextMenu";

/**
 * Side Panel - the expandable content area next to the Activity Bar.
 * Renders the currently active activity view's component.
 */
export function SidePanel(): React.ReactElement | null {
  const { isOpen, activeViewId, width, setWidth, close, viewData } = useActivityBarStore();
  const [activeView, setActiveView] = useState<ActivityViewDefinition | undefined>();
  const [isResizing, setIsResizing] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  // Keep activeView in sync with activeViewId
  useEffect(() => {
    if (activeViewId) {
      const view = ActivityBarExtensions.getView(activeViewId);
      setActiveView(view);
    } else {
      setActiveView(undefined);
    }
  }, [activeViewId]);

  // Also update when registry changes
  useEffect(() => {
    return ActivityBarExtensions.onRegistryChange(() => {
      if (activeViewId) {
        setActiveView(ActivityBarExtensions.getView(activeViewId));
      }
    });
  }, [activeViewId]);

  // Handle resize drag (from right edge)
  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsResizing(true);
      startXRef.current = e.clientX;
      startWidthRef.current = width;
    },
    [width]
  );

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const deltaX = e.clientX - startXRef.current;
      setWidth(startWidthRef.current + deltaX);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing, setWidth]);

  // Prevent text selection during resize
  useEffect(() => {
    if (isResizing) {
      document.body.style.userSelect = "none";
      document.body.style.cursor = "ew-resize";
    } else {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    }
  }, [isResizing]);

  // Panel context menu state
  const [contextMenu, setContextMenu] = useState<{
    position: { x: number; y: number };
    panelId: string;
    panelTitle: string;
  } | null>(null);

  const handleHeaderContextMenu = useCallback((e: React.MouseEvent) => {
    if (!activeViewId) return;
    const panel = panelRegistry.getPanelByDownstreamId(activeViewId);
    if (!panel || panel.movable === false) return;
    e.preventDefault();
    setContextMenu({ position: { x: e.clientX, y: e.clientY }, panelId: panel.id, panelTitle: panel.title });
  }, [activeViewId]);

  const handlePanelMove = useCallback((placement: PanelPlacement) => {
    if (contextMenu) {
      panelRegistry.setPlacement(contextMenu.panelId, placement);
    }
  }, [contextMenu]);

  if (!isOpen || !activeView) {
    return null;
  }

  const ViewComponent = activeView.component;

  return (
    <div style={{ ...styles.container, width }}>
      {/* Header */}
      <div style={styles.header} onContextMenu={handleHeaderContextMenu}>
        <span style={styles.title}>{activeView.title}</span>
        <button
          style={styles.closeButton}
          onClick={close}
          title="Close panel"
          aria-label="Close panel"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>

      {/* Content */}
      <div style={styles.content}>
        <ViewComponent onClose={close} data={viewData} />
      </div>

      {/* Resize handle on right edge */}
      <div
        style={styles.resizeHandle}
        onMouseDown={handleResizeStart}
      />

      {/* Panel context menu */}
      {contextMenu && (
        <PanelContextMenu
          position={contextMenu.position}
          currentPlacement="sidebar"
          panelId={contextMenu.panelId}
          panelTitle={contextMenu.panelTitle}
          canMoveToTarget={panelRegistry.canMoveTo(contextMenu.panelId, "ribbon")}
          onMove={handlePanelMove}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    backgroundColor: "var(--panel-bg)",
    borderRight: "1px solid var(--border-default)",
    flexShrink: 0,
    position: "relative",
    overflow: "hidden",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    height: 35,
    minHeight: 35,
    padding: "0 12px",
    backgroundColor: "var(--panel-bg)",
    borderBottom: "1px solid var(--border-default)",
    flexShrink: 0,
  },
  title: {
    fontSize: 11,
    fontWeight: 600,
    textTransform: "uppercase" as const,
    letterSpacing: "0.5px",
    color: "var(--text-secondary)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  closeButton: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 24,
    height: 24,
    padding: 0,
    border: "none",
    borderRadius: 4,
    background: "transparent",
    color: "var(--text-tertiary)",
    cursor: "pointer",
  },
  content: {
    flex: 1,
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
  },
  resizeHandle: {
    position: "absolute" as const,
    right: 0,
    top: 0,
    bottom: 0,
    width: 4,
    cursor: "ew-resize",
    background: "transparent",
    zIndex: 10,
  },
};
