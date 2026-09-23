//! FILENAME: app/src/shell/ActivityBar/ActivityBar.tsx
// PURPOSE: Thin vertical icon strip on the left edge (VS Code-style Activity Bar)
// CONTEXT: Shell component that renders registered activity view icons.
//          Chrome lives in ActivityBar.styles.ts on the --activity-bar-* tokens
//          (Calcula Clusters: 48px cells, 40px chips, a 3px accent indicator);
//          the count and the design-mode "JS" pill are the shared @api Badge.

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
import { Badge } from "../../api/layout";
import {
  ACTIVITY_BAR_WIDTH,
  railBadge,
  railBottom,
  railButton,
  railChip,
  railContainer,
  railScriptBadge,
  railTop,
} from "./ActivityBar.styles";

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

  const renderIcon = (view: ActivityViewDefinition) => (
    <ActivityBarIcon
      key={view.id}
      view={view}
      isActive={isOpen && activeViewId === view.id}
      badge={panelRegistry.getBadge(view.id)}
      hasScript={viewHasScript(view.id)}
      onClick={handleIconClick}
      onContextMenu={handleIconContextMenu}
    />
  );

  return (
    <div className={railContainer} data-activity-bar="">
      {/* Top section */}
      <div className={railTop}>{views.top.map(renderIcon)}</div>

      {/* Bottom section */}
      <div className={railBottom}>{views.bottom.map(renderIcon)}</div>

      {/* Panel context menu */}
      {contextMenu && (
        <PanelContextMenu
          position={contextMenu.position}
          currentPlacement="sidebar"
          panelId={contextMenu.panelId}
          panelTitle={contextMenu.panelTitle}
          canMoveToTarget={panelRegistry.canMoveTo(contextMenu.panelId, "ribbon")}
          moveHint={panelRegistry.getMoveHint(contextMenu.panelId, "ribbon")}
          onMove={handlePanelMove}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

/**
 * Single icon button in the Activity Bar: a 48px hit target hosting a 40px
 * chip. Hover, active and focus are pure CSS (see ActivityBar.styles.ts); the
 * active item is announced with `aria-current="true"`, which is also what
 * paints it, so the two cannot drift apart.
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
  return (
    <button
      type="button"
      className={railButton}
      onClick={() => onClick(view.id)}
      onContextMenu={(e) => onContextMenu?.(e, view.id)}
      title={view.title}
      aria-label={view.title}
      aria-current={isActive ? "true" : undefined}
      data-activity-view={view.id}
    >
      {/* Chip: carries the hover/active wash and the focus ring; the icon
          inherits the button's colour through currentColor. */}
      <span className={railChip} data-rail-chip="" aria-hidden>
        {view.icon}
      </span>

      {/* Notification badge (panelRegistry.setBadge) */}
      {badge && (
        <Badge className={railBadge} aria-hidden data-rail-badge="">
          {badge}
        </Badge>
      )}

      {/* T4: script-presence badge (design mode) — this panel has a script. */}
      {hasScript && (
        <Badge
          className={railScriptBadge}
          tone="accent"
          title="This panel has a script"
          data-rail-script-badge=""
        >
          JS
        </Badge>
      )}
    </button>
  );
}

export { ACTIVITY_BAR_WIDTH };
