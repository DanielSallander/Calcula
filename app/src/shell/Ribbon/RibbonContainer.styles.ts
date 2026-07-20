//! FILENAME: app/src/shell/Ribbon/RibbonContainer.styles.ts
// PURPOSE: Styled components for the ribbon frame — the Fluent-style tab strip
//          (flat text tabs, hover pill, accent underline on the active tab)
//          above the fixed-height content band.
// CONTEXT: Contracts relied on by E2E/soak tooling: tabs stay <button> elements
//          with their label as text, the ACTIVE tab computes font-weight 600
//          (invariants/stateSnapshot.ts), and the strip stays the first <div>
//          inside the ribbon container ([data-ribbon-content].parentElement).

import styled, { css } from 'styled-components';
import { FONT_FAMILY } from '../../api/layout/tokens';

const v = (name: string) => `var(${name})`;

/** Outer ribbon frame: tab strip + content band. */
export const RibbonFrame = styled.div`
  background-color: ${v('--panel-bg')};
  border-bottom: 1px solid ${v('--border-default')};
  position: relative;
  z-index: 10;
`;

/** The tab header strip. Fixed height so contextual tabs never shift layout.
 *  35px total = 34px content + 1px bottom border (global border-box sizing);
 *  the 26px TabButton centers with exactly 4px slack, so its underline at
 *  bottom:-4px lands flush on the strip's bottom edge. */
export const TabStrip = styled.div`
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 8px;
  height: 35px;
  border-bottom: 1px solid ${v('--border-default')};
  overflow: hidden;
  user-select: none;
`;

interface TabButtonProps {
  $isActive: boolean;
  /** Contextual-tab accent (e.g. Pivot green); undefined for regular tabs. */
  $accent?: string;
}

/**
 * A flat text tab. Active state = semibold + a rounded accent underline pinned
 * to the strip's bottom edge; hover = subtle rounded pill. Contextual tabs
 * render in their accent color and underline with it too.
 */
export const TabButton = styled.button<TabButtonProps>`
  position: relative;
  display: inline-flex;
  align-items: center;
  height: 26px;
  padding: 0 12px;
  border: none;
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
  font-size: 12px;
  font-family: ${FONT_FAMILY};
  white-space: nowrap;
  font-weight: ${({ $isActive }) => ($isActive ? 600 : 400)};
  color: ${({ $isActive, $accent }) =>
    $accent
      ? $isActive
        ? $accent
        : `color-mix(in srgb, ${$accent} 78%, transparent)`
      : $isActive
      ? v('--text-primary')
      : v('--text-secondary')};

  &:hover {
    background: ${v('--ribbon-button-hover-bg')};
    color: ${({ $accent }) => ($accent ? $accent : v('--text-primary'))};
  }

  &:active {
    background: ${v('--ribbon-button-active-bg')};
  }

  ${({ $isActive, $accent }) =>
    $isActive &&
    css`
      &::after {
        content: '';
        position: absolute;
        left: 10px;
        right: 10px;
        bottom: -4px; /* strip content box is 34px, tab 26px centered -> 4px slack; flush on the strip's bottom edge */
        height: 3px;
        border-radius: 3px 3px 0 0;
        background: ${$accent ?? v('--accent-primary')};
      }
    `}
`;

/** Notification badge bubble on a tab (panel badge counts). */
export const TabBadge = styled.span`
  position: absolute;
  top: 1px;
  right: 1px;
  min-width: 13px;
  height: 13px;
  padding: 0 3px;
  border-radius: 7px;
  background-color: ${v('--accent-color')};
  color: #fff;
  font-size: 9px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  box-sizing: border-box;
  pointer-events: none;
`;

/** Muted italic placeholder shown when no tabs are registered. */
export const EmptyStripNote = styled.div`
  padding: 6px 16px;
  color: ${v('--text-tertiary')};
  font-style: italic;
  font-size: 12px;
`;
