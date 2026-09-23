//! FILENAME: app/src/shell/TaskPane/TaskPane.styles.ts
// PURPOSE: Styled components for the Task Pane frame
// CONTEXT: CSS-in-JS via styled-components. Calcula Clusters redesign: the pane
//          shares the side panel's header recipe (40px row, 12px/600 sentence-
//          case title, 16px view-icon slot, @api IconButtons) and paints only
//          with tokens — `var(--token, #lightFallback)`, the fallback being the
//          light baseline (eslint.boundaries.js, chromeColorConfigs). The
//          hand-rolled tab strip, tab and close-button styles are gone: several
//          open views switch through the @api SegmentedTabs pill instead.

import styled from "styled-components";
import { FONT_FAMILY, HEADER_FONT_SIZE } from "../../api/layout";

/** Header row height, shared with the side panel. */
export const TASK_PANE_HEADER_HEIGHT = 40;

/** Side of the view-icon slot in the header and in each tab. */
export const TASK_PANE_TAB_ICON_SIZE = 16;

export const TaskPaneWrapper = styled.div<{
  $width: number;
  $isOpen: boolean;
  $dockMode: "docked" | "floating";
}>`
  /* Always positioned absolute - floats over content */
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  z-index: 100;

  display: flex;
  flex-direction: column;
  height: 100%;
  background-color: var(--panel-bg, #f9fafb);
  border-left: 1px solid var(--border-default, #d1d5db);
  overflow: hidden;

  /* Fixed width */
  width: ${({ $width }) => $width}px;

  /* Slide animation using right offset instead of transform.
     transform (even translateX(0)) creates a containing block that traps
     position:fixed elements (e.g. Monaco suggest widget) inside the pane,
     where overflow:hidden clips them.  Using right avoids this. */
  right: ${({ $isOpen, $width }) => ($isOpen ? "0" : `-${$width}px`)};
  transition: right var(--motion-panel, 180ms cubic-bezier(0.2, 0, 0, 1));

  /* Shadow only when open */
  box-shadow: ${({ $isOpen }) =>
    $isOpen ? "var(--shadow-raised, 0 6px 16px rgba(16, 24, 40, 0.14))" : "none"};

  /* Prevent interaction when closed */
  pointer-events: ${({ $isOpen }) => ($isOpen ? "auto" : "none")};
`;

export const TaskPaneContent = styled.div<{ $isVisible: boolean }>`
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  opacity: ${({ $isVisible }) => ($isVisible ? 1 : 0)};
  transition: opacity 0.1s ease-out;
  transition-delay: ${({ $isVisible }) => ($isVisible ? "0.05s" : "0s")};
`;

/** 4px grab area on the left edge; a 2px accent line shows on hover and
 *  while dragging (the side panel's handle, mirrored). */
export const ResizeHandle = styled.div`
  position: absolute;
  left: 0;
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
    left: 0;
    width: 2px;
    background: var(--state-accent, #047857);
    opacity: 0;
    transition: opacity var(--motion-hover, 120ms cubic-bezier(0.2, 0, 0, 1));
    pointer-events: none;
  }

  &:hover::after,
  &:active::after,
  &[data-resizing="true"]::after {
    opacity: 1;
  }
`;

export const Header = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  box-sizing: border-box;
  height: ${TASK_PANE_HEADER_HEIGHT}px;
  min-height: ${TASK_PANE_HEADER_HEIGHT}px;
  padding: 0 8px 0 12px;
  background: var(--side-panel-header-bg, var(--panel-bg, #f9fafb));
  border-bottom: 1px solid var(--border-default, #d1d5db);
  flex-shrink: 0;
`;

/** Single open view: its title, in the sidebar's one header recipe. */
export const HeaderTitle = styled.span`
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

/** Several open views: the SegmentedTabs pill takes the free width. */
export const TabsSlot = styled.div`
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
`;

/** The view's icon in a 16px box, whatever size its author drew. */
export const TabIcon = styled.span`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: ${TASK_PANE_TAB_ICON_SIZE}px;
  height: ${TASK_PANE_TAB_ICON_SIZE}px;
  overflow: hidden;

  & svg {
    width: ${TASK_PANE_TAB_ICON_SIZE}px;
    height: ${TASK_PANE_TAB_ICON_SIZE}px;
    flex: none;
  }
`;

export const HeaderActions = styled.div`
  display: flex;
  align-items: center;
  gap: 2px;
  flex: none;
`;

/** Hairline between "close this view" and "close the pane". */
export const HeaderDivider = styled.span`
  width: 1px;
  height: 16px;
  margin: 0 4px;
  background: var(--control-divider, #e5e7eb);
  flex: none;
`;

export const Content = styled.div`
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
`;

export const EmptyState = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  height: 100%;
  padding: 24px;
  color: var(--text-tertiary, #888888);
  text-align: center;
  font-family: ${FONT_FAMILY};
  font-size: 13px;
`;

export const EmptyStateIcon = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary, #888888);
`;

export const EmptyStateText = styled.p`
  margin: 0;
`;
