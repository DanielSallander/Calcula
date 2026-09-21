//! FILENAME: app/extensions/BuiltIn/FormatCellsDialog/FormatCellsDialog.styles.ts
// PURPOSE: Styled-components for the Format Cells dialog.

import styled from "styled-components";

const v = (name: string) => `var(${name})`;

export const Backdrop = styled.div`
  position: fixed;
  inset: 0;
  z-index: 1050;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
`;

/**
 * A property sheet wants ONE stable frame across its six tabs, so the height is
 * DEFINITE rather than a `max-height`. That is both what Excel does and what
 * makes `min-height: 0` safe on TabContent below: with only a max-height the
 * frame had no height to hand down, so a tab could not flex and the box JUMPED
 * as you moved between tabs.
 */
export const DialogContainer = styled.div`
  background: ${v("--panel-bg")};
  border: 1px solid ${v("--border-default")};
  border-radius: 8px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  width: min(680px, 94vw);
  height: min(560px, 88vh);
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  color: ${v("--text-primary")};
  font-family: "Segoe UI", system-ui, sans-serif;
  font-size: 13px;
`;

export const Header = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px 0 16px;
  flex-shrink: 0;
`;

export const Title = styled.span`
  font-weight: 600;
  font-size: 15px;
  color: ${v("--text-primary")};
`;

export const CloseButton = styled.button`
  background: transparent;
  border: none;
  color: ${v("--text-secondary")};
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 14px;
  line-height: 1;

  &:hover {
    background: ${v("--grid-bg")};
    color: ${v("--text-primary")};
  }
`;

export const TabBar = styled.div`
  display: flex;
  padding: 8px 16px 0 16px;
  gap: 0;
  border-bottom: 1px solid ${v("--border-default")};
  flex-shrink: 0;
  overflow-x: auto;

  &::-webkit-scrollbar {
    display: none;
  }
`;

export const Tab = styled.button<{ $active: boolean }>`
  padding: 7px 14px;
  font-size: 12px;
  font-weight: ${(p) => (p.$active ? 600 : 400)};
  background: ${(p) => (p.$active ? v("--panel-bg") : "transparent")};
  color: ${(p) => (p.$active ? v("--accent-primary") : v("--text-secondary"))};
  border: 1px solid ${(p) => (p.$active ? v("--border-default") : "transparent")};
  border-bottom: ${(p) =>
    p.$active ? `2px solid ${v("--accent-primary")}` : "1px solid transparent"};
  border-radius: 4px 4px 0 0;
  cursor: pointer;
  white-space: nowrap;
  margin-bottom: -1px;
  transition: color 0.1s, background 0.1s;

  &:hover {
    color: ${v("--text-primary")};
    background: ${(p) => (p.$active ? v("--panel-bg") : v("--grid-bg"))};
  }
`;

/** `min-height: 0`, not 280px: the frame now has a definite height, so the tab
 *  flexes into whatever is left and scrolls only when its own content exceeds
 *  that. A floor here would push the frame instead. */
export const TabContent = styled.div`
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 16px;

  &::-webkit-scrollbar {
    width: 6px;
  }

  &::-webkit-scrollbar-thumb {
    background: ${v("--text-disabled")};
    border-radius: 3px;
  }
`;

export const Footer = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid ${v("--border-default")};
  flex-shrink: 0;
`;

export const Button = styled.button<{ $primary?: boolean }>`
  padding: 6px 20px;
  font-size: 13px;
  border-radius: 4px;
  cursor: pointer;
  min-width: 80px;
  transition: opacity 0.1s;

  background: ${(p) =>
    p.$primary ? v("--accent-primary") : v("--grid-bg")};
  color: ${(p) => (p.$primary ? "#ffffff" : v("--text-primary"))};
  border: 1px solid
    ${(p) => (p.$primary ? v("--accent-primary") : v("--border-default"))};

  &:hover {
    opacity: 0.85;
  }

  &:active {
    opacity: 0.7;
  }
`;
