//! FILENAME: app/src/shell/ActivityBar/SidePanel.tsx
// PURPOSE: Expandable side panel that renders the active Activity View
// CONTEXT: Sits to the right of the Activity Bar, shows registered view content

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useActivityBarStore } from "./useActivityBarStore";
import { ActivityBarExtensions } from "../registries/activityBarExtensions";
import type { ActivityViewDefinition } from "../../api/uiTypes";

/**
 * Side Panel - the expandable content area next to the Activity Bar.
 * Renders the currently active activity view's component.
 */
export function SidePanel(): React.ReactElement | null {
  const { isOpen, activeViewId, width, setWidth, close } = useActivityBarStore();
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

  if (!isOpen || !activeView) {
    return null;
  }

  const ViewComponent = activeView.component;

  return (
    <div style={{ ...styles.container, width }}>
      {/* Header */}
      <div style={styles.header}>
        <span style={styles.title}>{activeView.title}</span>
        <button
          style={styles.closeButton}
          onClick={close}
          title="Close panel"
          aria-label="Close panel"
        >
          x
        </button>
      </div>

      {/* Content */}
      <div style={styles.content}>
        <ViewComponent onClose={close} />
      </div>

      {/* Resize handle on right edge */}
      <div
        style={styles.resizeHandle}
        onMouseDown={handleResizeStart}
      />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    backgroundColor: "#f8f9fa",
    borderRight: "1px solid #e0e0e0",
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
    backgroundColor: "#f8f9fa",
    borderBottom: "1px solid #e0e0e0",
    flexShrink: 0,
  },
  title: {
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase" as const,
    letterSpacing: "0.8px",
    color: "#444444",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  closeButton: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 22,
    height: 22,
    padding: 0,
    border: "none",
    borderRadius: 4,
    background: "transparent",
    color: "#666",
    fontSize: 14,
    cursor: "pointer",
    fontFamily: "system-ui, -apple-system, sans-serif",
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
