//! FILENAME: app/src/shell/ActivityBar/SidePanel.tsx
// PURPOSE: Expandable side panel that renders the active Activity View
// CONTEXT: Sits to the right of the Activity Bar, shows registered view content.
//          Calcula Clusters header (approved mockup, calcula.css `.cal-panel-h`):
//          40px row = the view's icon at 20px + a 12px/600 sentence-case title
//          (the one header recipe the sidebar sections and Group share) + two
//          @api IconButtons: "More" (the same PanelContextMenu the header's
//          right-click opens) and "Close panel". The right-edge resize handle is
//          a 4px hit area that paints a 2px --state-accent line on hover and
//          while dragging.

import React, { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { css } from "@emotion/css";
import { useActivityBarStore } from "./useActivityBarStore";
import { ActivityBarExtensions } from "../registries/activityBarExtensions";
import type { ActivityViewDefinition } from "../../api/uiTypes";
import type { PanelPlacement } from "../../api/uiTypes";
import { panelRegistry } from "../registries/panelRegistry";
import { PanelContextMenu } from "../Ribbon/PanelContextMenu";
import { IconButton, FONT_FAMILY, HEADER_FONT_SIZE, ICON_SIZE_SM } from "../../api/layout";
import { RibbonIcon } from "../../api/ribbonIcons";

/** Header row height (the mockup's `.cal-panel-h`). */
export const SIDE_PANEL_HEADER_HEIGHT = 40;

/** Glyph size inside the header's 28px icon buttons (the mockup draws 18). */
const HEADER_ACTION_ICON_SIZE = 18;

/**
 * Side Panel - the expandable content area next to the Activity Bar.
 * Renders the currently active activity view's component.
 */
export function SidePanel(): React.ReactElement | null {
  const { isOpen, activeViewId, width, setWidth, close, viewData } = useActivityBarStore();
  const [isResizing, setIsResizing] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const moreButtonRef = useRef<HTMLButtonElement>(null);

  // Re-render when the registry changes (a view registered, replaced, or
  // unprojected by a move to the ribbon). The active view is then READ during
  // render rather than mirrored into state by an effect, so it can never lag
  // one render behind activeViewId.
  const [, bumpRegistry] = useReducer((n: number) => n + 1, 0);
  useEffect(() => ActivityBarExtensions.onRegistryChange(bumpRegistry), []);
  const activeView: ActivityViewDefinition | undefined = activeViewId
    ? ActivityBarExtensions.getView(activeViewId)
    : undefined;

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

  /** The movable panel behind the active view, or null when the view has no
   *  panel (a bare activity view) or the panel refuses to move. The header's
   *  right-click and the More button offer the menu for exactly these. */
  const movablePanel = useCallback(() => {
    if (!activeViewId) return null;
    const panel = panelRegistry.getPanelByDownstreamId(activeViewId);
    if (!panel || panel.movable === false) return null;
    return panel;
  }, [activeViewId]);

  const handleHeaderContextMenu = useCallback((e: React.MouseEvent) => {
    const panel = movablePanel();
    if (!panel) return;
    e.preventDefault();
    setContextMenu({ position: { x: e.clientX, y: e.clientY }, panelId: panel.id, panelTitle: panel.title });
  }, [movablePanel]);

  // "More": the same menu, anchored under the button instead of the pointer.
  const handleMoreClick = useCallback(() => {
    if (contextMenu) {
      setContextMenu(null);
      return;
    }
    const panel = movablePanel();
    if (!panel) return;
    const rect = moreButtonRef.current?.getBoundingClientRect();
    setContextMenu({
      position: { x: rect ? rect.left : 0, y: rect ? rect.bottom + 2 : 0 },
      panelId: panel.id,
      panelTitle: panel.title,
    });
  }, [contextMenu, movablePanel]);

  // While the menu is open, a press on More must not reach the menu's
  // document-level outside-press listener: that would close the menu and the
  // click that follows would open it again. The click toggles it instead.
  const handleMoreMouseDown = useCallback((e: React.MouseEvent) => {
    if (contextMenu) e.stopPropagation();
  }, [contextMenu]);

  const handlePanelMove = useCallback((placement: PanelPlacement) => {
    if (contextMenu) {
      panelRegistry.setPlacement(contextMenu.panelId, placement);
    }
  }, [contextMenu]);

  if (!isOpen || !activeView) {
    return null;
  }

  const ViewComponent = activeView.component;
  const hasIcon =
    activeView.icon !== null && activeView.icon !== undefined && activeView.icon !== false && activeView.icon !== "";
  const canShowMenu = movablePanel() !== null;

  return (
    <div className={container} style={{ width }} data-side-panel="">
      {/* Header */}
      <div className={header} onContextMenu={handleHeaderContextMenu}>
        {hasIcon && (
          <span className={headerIcon} aria-hidden>
            {activeView.icon}
          </span>
        )}
        <span className={title}>{activeView.title}</span>
        {canShowMenu && (
          <IconButton
            ref={moreButtonRef}
            size="md"
            label="More"
            icon={<RibbonIcon.MoreHorizontal size={HEADER_ACTION_ICON_SIZE} />}
            aria-haspopup="menu"
            aria-expanded={contextMenu !== null}
            onMouseDown={handleMoreMouseDown}
            onClick={handleMoreClick}
          />
        )}
        <IconButton
          size="md"
          label="Close panel"
          icon={<RibbonIcon.Close size={HEADER_ACTION_ICON_SIZE} />}
          onClick={close}
        />
      </div>

      {/* Content */}
      <div className={content}>
        <ViewComponent onClose={close} data={viewData} />
      </div>

      {/* Resize handle on right edge: 4px to grab, a 2px accent line to see. */}
      <div
        className={resizeHandle}
        data-resizing={isResizing ? "true" : undefined}
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
          moveHint={panelRegistry.getMoveHint(contextMenu.panelId, "ribbon")}
          onMove={handlePanelMove}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

// ============================================================================
// Styles — tokens only (var(--token, #lightFallback)); see ActivityBar.styles.ts
// ============================================================================

const container = css`
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--panel-bg, #f9fafb);
  border-right: 1px solid var(--border-default, #d1d5db);
  flex-shrink: 0;
  position: relative;
  overflow: hidden;
`;

const header = css`
  display: flex;
  align-items: center;
  gap: 9px;
  box-sizing: border-box;
  height: ${SIDE_PANEL_HEADER_HEIGHT}px;
  min-height: ${SIDE_PANEL_HEADER_HEIGHT}px;
  padding: 0 8px 0 12px;
  flex-shrink: 0;
  background: var(--side-panel-header-bg, var(--panel-bg, #f9fafb));
  border-bottom: 1px solid var(--border-default, #d1d5db);
`;

/** The view's icon, normalised to 20px whatever size its author drew. */
const headerIcon = css`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: ${ICON_SIZE_SM}px;
  height: ${ICON_SIZE_SM}px;
  color: var(--text-primary, #111827);

  & svg {
    width: ${ICON_SIZE_SM}px;
    height: ${ICON_SIZE_SM}px;
    flex: none;
  }
`;

/** One header recipe across the sidebar: 12px/600, sentence case. */
const title = css`
  flex: 1;
  min-width: 0;
  font-family: ${FONT_FAMILY};
  font-size: ${HEADER_FONT_SIZE}px;
  font-weight: 600;
  line-height: 1;
  color: var(--text-primary, #111827);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const content = css`
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
`;

const resizeHandle = css`
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: 4px;
  cursor: ew-resize;
  background: transparent;
  z-index: 10;

  &::after {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    right: 0;
    width: 2px;
    background: var(--state-accent, #047857);
    opacity: 0;
    transition: opacity var(--motion-hover, 120ms cubic-bezier(0.2, 0, 0, 1));
    pointer-events: none;
  }

  &:hover::after,
  &[data-resizing="true"]::after {
    opacity: 1;
  }
`;
