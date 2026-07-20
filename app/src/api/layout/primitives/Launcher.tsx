//! FILENAME: app/src/api/layout/primitives/Launcher.tsx
// PURPOSE: The universal ribbon fallback — a compact labeled button that opens
//          its content in an anchored, scrollable flyout at sidebar geometry.
// CONTEXT: This is Excel's collapsed-group idiom generalized: content that has
//          no sensible 92px horizontal form is demoted exactly one level of
//          directness instead of being refused or clipped. ItemList/Tall/Gallery
//          emit it declaratively; the Shell's SectionCell emits it for measured
//          overflow. The flyout re-provides SurfaceLayoutContext as a vertical
//          "popover" container, so primitives inside it render sidebar-style.

import React, { useCallback, useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom";
import { css } from "@emotion/css";
import { SurfaceLayoutProvider, popoverLayout } from "../context";
import {
  FONT_FAMILY,
  LAUNCHER_MIN_WIDTH,
  clampFlyoutWidth,
} from "../tokens";

const styles = {
  button: css`
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    padding: 6px 10px;
    border: 1px solid transparent;
    border-radius: 4px;
    background: transparent;
    cursor: pointer;
    font-family: ${FONT_FAMILY};
    min-width: ${LAUNCHER_MIN_WIDTH}px;
    height: 100%;
    box-sizing: border-box;
    white-space: nowrap;
    color: var(--text-primary, #333);

    &:hover {
      background: var(--button-hover-bg, rgba(0, 0, 0, 0.06));
    }

    &:active {
      background: var(--button-active-bg, rgba(0, 0, 0, 0.1));
    }
  `,
  icon: css`
    font-size: 20px;
    line-height: 1;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--accent-color, #1a6b3c);
  `,
  label: css`
    display: flex;
    align-items: center;
    gap: 3px;
    font-size: 11px;
    font-weight: 500;
    white-space: nowrap;
    max-width: 110px;
    overflow: hidden;
    text-overflow: ellipsis;
  `,
  arrow: css`
    font-size: 8px;
    color: var(--text-tertiary, #666);
    margin-left: 1px;
    flex-shrink: 0;
  `,
  flyout: css`
    position: fixed;
    z-index: 1100;
    background: var(--bg-surface, #ffffff);
    border: 1px solid var(--border-default, #d0d0d0);
    border-radius: 6px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
    padding: 10px 12px;
    max-height: 70vh;
    overflow: auto;
    box-sizing: border-box;
  `,
};

export interface LauncherProps {
  /** Button label (and flyout tooltip). */
  label: string;
  /** Icon shown above the label; falls back to a generic glyph. */
  icon?: React.ReactNode;
  /** Flyout width in px, clamped to the sidebar's own 240-480 range. */
  flyoutWidth?: number;
  /** Content hosted in the flyout, rendered at vertical popover geometry. */
  children: React.ReactNode;
  /** Rendered as data-testid on the launcher button. */
  testId?: string;
}

/**
 * Compact icon+label+chevron button opening a portal flyout. The flyout is
 * tagged `data-ribbon-content` (so the minimized-ribbon outside-click guard
 * treats it as ribbon content) and `data-section-flyout` (so nested outside-
 * click checks can recognize it).
 */
export function Launcher({
  label,
  icon,
  flyoutWidth,
  children,
  testId,
}: LauncherProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const width = clampFlyoutWidth(flyoutWidth);

  const handleToggle = useCallback(() => {
    if (buttonRef.current) {
      setAnchorRect(buttonRef.current.getBoundingClientRect());
    }
    setOpen((prev) => !prev);
  }, []);

  // Close on Escape and on mousedown outside both the button and the flyout.
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest("[data-section-flyout]")) return;
      if (buttonRef.current && buttonRef.current.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("keydown", handleKey);
    document.addEventListener("mousedown", handleMouseDown);
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.removeEventListener("mousedown", handleMouseDown);
    };
  }, [open]);

  const left = anchorRect
    ? Math.max(4, Math.min(anchorRect.left, window.innerWidth - width - 4))
    : 4;
  const top = anchorRect ? anchorRect.bottom + 2 : 0;

  return (
    <>
      <button
        ref={buttonRef}
        className={styles.button}
        onClick={handleToggle}
        title={label}
        data-testid={testId}
        aria-expanded={open}
        aria-haspopup="true"
      >
        <span className={styles.icon}>{icon ?? "☰"}</span>
        <span className={styles.label}>
          {label} <span className={styles.arrow}>{"▼"}</span>
        </span>
      </button>

      {open &&
        anchorRect &&
        ReactDOM.createPortal(
          <div
            className={styles.flyout}
            style={{ top, left, width }}
            data-ribbon-content=""
            data-section-flyout=""
            role="dialog"
            aria-label={label}
          >
            <SurfaceLayoutProvider value={popoverLayout(width - 24)}>
              {children}
            </SurfaceLayoutProvider>
          </div>,
          document.body,
        )}
    </>
  );
}
