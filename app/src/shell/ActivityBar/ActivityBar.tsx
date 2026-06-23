//! FILENAME: app/src/shell/ActivityBar/ActivityBar.tsx
// PURPOSE: Thin vertical icon strip on the left edge (VS Code-style Activity Bar)
// CONTEXT: Shell component that renders registered activity view icons

import React, { useCallback, useEffect, useState } from "react";
import { useActivityBarStore } from "./useActivityBarStore";
import { ActivityBarExtensions } from "../registries/activityBarExtensions";
import type { ActivityViewDefinition } from "../../api/uiTypes";
import type { PanelPlacement } from "../../api/uiTypes";
import { panelRegistry } from "../registries/panelRegistry";
import { PanelContextMenu } from "../Ribbon/PanelContextMenu";
import { emitAppEvent } from "../../api/events";
import { hasObjectScript, onObjectScriptPresenceChange } from "../../api/objectScriptBadge";
import { getDesignMode, onDesignModeChange } from "../../api/designMode";

const ACTIVITY_BAR_WIDTH = 48;

/**
 * Activity Bar - the thin vertical icon strip on the left.
 * Icons are split into top (main) and bottom sections.
 * Clicking an icon toggles the side panel.
 */
export function ActivityBar(): React.ReactElement {
  const { isOpen, activeViewId, toggle } = useActivityBarStore();
  const [views, setViews] = useState<{
    top: ActivityViewDefinition[];
    bottom: ActivityViewDefinition[];
  }>({ top: [], bottom: [] });
  // Bumped to re-render when script presence or design mode changes (T4 badge).
  const [, setScriptTick] = useState(0);

  // Subscribe to registry changes
  useEffect(() => {
    const update = () => {
      setViews({
        top: ActivityBarExtensions.getTopViews(),
        bottom: ActivityBarExtensions.getBottomViews(),
      });
    };
    update();
    const unsub1 = ActivityBarExtensions.onRegistryChange(update);
    // Also re-render on panelRegistry changes (badge updates, etc.)
    const unsub2 = panelRegistry.onRegistryChange(update);
    // T4: re-render the script-presence badge when scripts or design mode change.
    const bump = () => setScriptTick((t) => t + 1);
    const unsub3 = onObjectScriptPresenceChange(bump);
    const unsub4 = onDesignModeChange(bump);
    return () => { unsub1(); unsub2(); unsub3(); unsub4(); };
  }, []);

  // Whether a panel-backed activity view has a script attached (design mode only) —
  // the T4 "code on the object" badge, mirroring slicers/charts/shapes.
  const viewHasScript = useCallback((viewId: string): boolean => {
    if (!getDesignMode()) return false;
    const panelId = panelRegistry.getPanelByDownstreamId(viewId)?.id;
    return !!panelId && hasObjectScript("panel", panelId);
  }, []);

  const handleIconClick = useCallback(
    (viewId: string) => {
      const prevViewId = activeViewId;
      const wasOpen = isOpen;
      toggle(viewId);

      // Emit panel events for scriptable objects
      emitAppEvent("panel:clicked", { panelId: viewId, placement: "sidebar" });

      if (wasOpen && prevViewId === viewId) {
        // Toggling off: panel is being hidden
        emitAppEvent("panel:deactivated", { panelId: viewId, placement: "sidebar" });
        emitAppEvent("panel:hidden", { panelId: viewId });
      } else {
        // Switching or opening
        if (prevViewId && prevViewId !== viewId && wasOpen) {
          emitAppEvent("panel:deactivated", { panelId: prevViewId, placement: "sidebar" });
        }
        emitAppEvent("panel:activated", { panelId: viewId, placement: "sidebar" });
        if (!wasOpen) {
          emitAppEvent("panel:shown", { panelId: viewId });
        }
      }
    },
    [toggle, activeViewId, isOpen]
  );

  // Panel context menu state
  const [contextMenu, setContextMenu] = useState<{
    position: { x: number; y: number };
    panelId: string;
    panelTitle: string;
  } | null>(null);

  const handleIconContextMenu = useCallback((e: React.MouseEvent, viewId: string) => {
    const panel = panelRegistry.getPanelByDownstreamId(viewId);
    if (!panel || panel.movable === false) return;
    e.preventDefault();
    setContextMenu({ position: { x: e.clientX, y: e.clientY }, panelId: panel.id, panelTitle: panel.title });
  }, []);

  const handlePanelMove = useCallback((placement: PanelPlacement) => {
    if (contextMenu) {
      panelRegistry.setPlacement(contextMenu.panelId, placement);
    }
  }, [contextMenu]);

  return (
    <div style={styles.container}>
      {/* Top section */}
      <div style={styles.topSection}>
        {views.top.map((view) => (
          <ActivityBarIcon
            key={view.id}
            view={view}
            isActive={isOpen && activeViewId === view.id}
            badge={panelRegistry.getBadge(view.id)}
            hasScript={viewHasScript(view.id)}
            onClick={handleIconClick}
            onContextMenu={handleIconContextMenu}
          />
        ))}
      </div>

      {/* Bottom section */}
      <div style={styles.bottomSection}>
        {views.bottom.map((view) => (
          <ActivityBarIcon
            key={view.id}
            view={view}
            isActive={isOpen && activeViewId === view.id}
            badge={panelRegistry.getBadge(view.id)}
            hasScript={viewHasScript(view.id)}
            onClick={handleIconClick}
            onContextMenu={handleIconContextMenu}
          />
        ))}
      </div>

      {/* Panel context menu */}
      {contextMenu && (
        <PanelContextMenu
          position={contextMenu.position}
          currentPlacement="sidebar"
          panelId={contextMenu.panelId}
          panelTitle={contextMenu.panelTitle}
          onMove={handlePanelMove}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

/**
 * Single icon button in the Activity Bar.
 */
function ActivityBarIcon({
  view,
  isActive,
  badge,
  hasScript,
  onClick,
  onContextMenu,
}: {
  view: ActivityViewDefinition;
  isActive: boolean;
  badge?: string;
  hasScript?: boolean;
  onClick: (viewId: string) => void;
  onContextMenu?: (e: React.MouseEvent, viewId: string) => void;
}): React.ReactElement {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <button
      style={{
        ...styles.iconButton,
        ...(isActive ? styles.iconButtonActive : {}),
        ...(isHovered && !isActive ? styles.iconButtonHover : {}),
      }}
      onClick={() => onClick(view.id)}
      onContextMenu={(e) => onContextMenu?.(e, view.id)}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      title={view.title}
      aria-label={view.title}
    >
      {/* Active indicator bar */}
      {isActive && <div style={styles.activeIndicator} />}

      {/* Icon */}
      <div style={{
        ...styles.iconWrapper,
        opacity: isActive ? 1 : isHovered ? 0.8 : 0.6,
      }}>
        {view.icon}
      </div>

      {/* Badge */}
      {badge && (
        <div style={styles.badge}>
          {badge}
        </div>
      )}

      {/* T4: script-presence badge (design mode) — this panel has a script. */}
      {hasScript && (
        <div style={styles.scriptBadge} title="This panel has a script">
          JS
        </div>
      )}
    </button>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    width: ACTIVITY_BAR_WIDTH,
    minWidth: ACTIVITY_BAR_WIDTH,
    height: "100%",
    backgroundColor: "#333333",
    flexShrink: 0,
  },
  topSection: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    paddingTop: 4,
    flex: 1,
  },
  bottomSection: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    paddingBottom: 4,
  },
  iconButton: {
    position: "relative" as const,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: ACTIVITY_BAR_WIDTH,
    height: ACTIVITY_BAR_WIDTH,
    padding: 0,
    border: "none",
    background: "transparent",
    cursor: "pointer",
    color: "#ffffff",
  },
  iconButtonActive: {
    // Active state is indicated by the left bar, not background
  },
  iconButtonHover: {
    // Hover opacity is handled inline
  },
  activeIndicator: {
    position: "absolute" as const,
    left: 0,
    top: 8,
    bottom: 8,
    width: 2,
    backgroundColor: "#ffffff",
    borderRadius: "0 1px 1px 0",
  },
  iconWrapper: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 24,
    height: 24,
    transition: "opacity 0.1s",
  },
  badge: {
    position: "absolute" as const,
    bottom: 6,
    right: 6,
    minWidth: 16,
    height: 16,
    padding: "0 4px",
    borderRadius: 8,
    backgroundColor: "var(--accent-color)",
    color: "#fff",
    fontSize: 9,
    fontWeight: 600,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    lineHeight: 1,
    fontFamily: "'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif",
  },
  // Script-presence pill (top-right, distinct from the bottom-right notification badge).
  scriptBadge: {
    position: "absolute" as const,
    top: 5,
    right: 5,
    minWidth: 13,
    height: 13,
    padding: "0 3px",
    borderRadius: 3,
    backgroundColor: "rgba(0, 120, 212, 0.9)",
    color: "#fff",
    fontSize: 8,
    fontWeight: 700,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    lineHeight: 1,
    letterSpacing: "0.03em",
    pointerEvents: "none" as const,
  },
};

export { ACTIVITY_BAR_WIDTH };
