//! FILENAME: app/src/shell/Ribbon/PanelContextMenu.tsx
// PURPOSE: Context menu for moving panels between sidebar and ribbon
// CONTEXT: Shown on right-click of ribbon tab headers, activity bar icons,
//          and side panel headers. Part of the location-agnostic panel system.
//
//          Wears the Clusters card chrome (the same recipe as a card Popover:
//          --bg-surface, a 1px --ribbon-cluster-border hairline, --radius-popover,
//          --shadow-popover, 8px padding) with 30px rows, so it reads as one of
//          the ribbon's own overlays. Tokens only.
//
//          CONTRACT: the items stay PLAIN <button> elements with the exact
//          labels "Move to Sidebar" / "Move to Ribbon" / "Edit Script..." —
//          e2e/tests/panel-placement.spec.ts drives them with
//          getByRole("button", { name: /Move to .../ }). Do not give them a
//          menuitem role.
//
//          Rendered in a body portal at the pointer, clamped into the
//          viewport: it opens from the ribbon, whose frame is its own stacking
//          context, and from the rail and the side panel.

import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import ReactDOM from "react-dom";
import { css, cx } from "@emotion/css";
import type { PanelPlacement } from "../../api/uiTypes";
import { emitAppEvent } from "../../api/events";
import { LT, FONT_FAMILY, ICON_SIZE_SM, MENU_ROW_HEIGHT } from "../../api/layout";
import { RibbonIcon } from "../../api/ribbonIcons";
import {
  getRibbonLabelMode,
  setRibbonLabelMode,
  subscribeToAppearance,
} from "../../api/appearance";

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

/** Keep the menu this far from the viewport edge. */
const VIEWPORT_MARGIN = 4;

const styles = {
  menu: css`
    position: fixed;
    z-index: 10000;
    box-sizing: border-box;
    min-width: 200px;
    padding: 8px;
    background: ${LT.surface};
    border: 1px solid ${LT.clusterBorder};
    border-radius: ${LT.radiusPopover};
    box-shadow: ${LT.shadowPopover};
    font-family: ${FONT_FAMILY};
    color: ${LT.text};
  `,
  item: css`
    display: flex;
    align-items: center;
    gap: 9px;
    box-sizing: border-box;
    width: 100%;
    min-height: ${MENU_ROW_HEIGHT}px;
    padding: 0 9px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: ${LT.text};
    cursor: pointer;
    font-family: ${FONT_FAMILY};
    font-size: 12px;
    line-height: 1.2;
    text-align: left;
    transition: background-color ${LT.motionHover};

    &:hover {
      background: ${LT.hover};
    }

    &:active {
      background: ${LT.active};
    }

    &:focus-visible {
      outline: none;
      box-shadow: ${LT.focusRing};
    }
  `,
  /** A row that carries a hint line grows past 30px instead of clipping it. */
  itemWithHint: css`
    padding-top: 5px;
    padding-bottom: 5px;
  `,
  icon: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: ${ICON_SIZE_SM}px;
    height: ${ICON_SIZE_SM}px;
  `,
  text: css`
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    min-width: 0;
  `,
  hint: css`
    font-size: 11px;
    color: ${LT.textSecondary};
  `,
  separator: css`
    height: 1px;
    margin: 5px 6px;
    background: ${LT.controlDivider};
  `,
};

function readLabelsShown(): boolean {
  return getRibbonLabelMode() === "show";
}

/**
 * "Move to Sidebar" / "Move to Ribbon", the ribbon's group-label toggle, and
 * "Edit Script...".
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
  const [placed, setPlaced] = useState<{ left: number; top: number }>({
    left: position.x,
    top: position.y,
  });
  const labelsShown = useSyncExternalStore(subscribeToAppearance, readLabelsShown, () => true);

  // Clamp into the viewport once the menu's real size is known (before paint).
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const maxLeft = window.innerWidth - rect.width - VIEWPORT_MARGIN;
    const maxTop = window.innerHeight - rect.height - VIEWPORT_MARGIN;
    const left = Math.max(VIEWPORT_MARGIN, Math.min(position.x, maxLeft));
    const top = Math.max(VIEWPORT_MARGIN, Math.min(position.y, maxTop));
    setPlaced((prev) => (prev.left === left && prev.top === top ? prev : { left, top }));
  }, [position.x, position.y]);

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
  // Group captions are a ribbon preference: offered where the ribbon is.
  const showLabelToggle = currentPlacement === "ribbon";

  const handleMoveClick = () => {
    onMove(targetPlacement);
    onClose();
  };

  const handleToggleLabels = () => {
    setRibbonLabelMode(labelsShown ? "hide" : "show");
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

  const hasLayoutItems = canMoveToTarget || showLabelToggle;

  const menu = (
    <div
      ref={menuRef}
      className={styles.menu}
      style={{ left: placed.left, top: placed.top }}
      data-panel-context-menu=""
    >
      {canMoveToTarget && (
        <button
          type="button"
          onClick={handleMoveClick}
          className={cx(styles.item, moveHint && styles.itemWithHint)}
        >
          <span className={styles.icon} aria-hidden>
            {targetPlacement === "sidebar" ? (
              <RibbonIcon.Sidebar size={ICON_SIZE_SM} />
            ) : (
              <RibbonIcon.Ribbon size={ICON_SIZE_SM} />
            )}
          </span>
          <span className={styles.text}>
            {label}
            {moveHint && <span className={styles.hint}>{moveHint}</span>}
          </span>
        </button>
      )}

      {showLabelToggle && (
        <button type="button" onClick={handleToggleLabels} className={styles.item}>
          <span className={styles.icon} aria-hidden>
            <RibbonIcon.Text size={ICON_SIZE_SM} />
          </span>
          {labelsShown ? "Hide group labels" : "Show group labels"}
        </button>
      )}

      {hasLayoutItems && <div className={styles.separator} role="separator" />}

      <button type="button" onClick={handleEditScript} className={styles.item}>
        <span className={styles.icon} aria-hidden>
          <RibbonIcon.Pencil size={ICON_SIZE_SM} />
        </span>
        Edit Script...
      </button>
    </div>
  );

  return typeof document === "undefined" ? menu : ReactDOM.createPortal(menu, document.body);
}
