//! FILENAME: app/src/api/layout/primitives/Launcher.tsx
// PURPOSE: The universal ribbon fallback — a demoted cluster: a 61px
//          icon-over-label button that opens the cluster's content in an
//          anchored card flyout at sidebar geometry.
// CONTEXT: This is Excel's collapsed-group idiom generalized: content that has
//          no sensible horizontal form in the band is demoted exactly one level
//          of directness instead of being refused or clipped. ItemList/Tall/
//          Gallery emit it declaratively; the Shell's SectionCell emits it for
//          measured overflow. The flyout re-provides SurfaceLayoutContext as a
//          vertical "popover" container, so primitives inside it render
//          sidebar-style.
//
//          Under the fill rule (../tokens.ts) a launcher is a tall control like
//          any other: 61px, the height of a cluster's content box, with the
//          same 58px minimum width as a hero, so a cluster demoting to a
//          launcher keeps the band's rhythm instead of leaving a short button
//          floating in a tall card. Its flyout wears the same card chrome as
//          every other Clusters overlay (the recipe of Popover's `card`, from
//          the same LT tokens), headed by the cluster's label — which is also
//          where a label truncated on the button can be read in full.
//
//          WHY IT DOES NOT RENDER THROUGH <Popover>: its outside-press rule is
//          different on purpose. A flyout hosts a whole section, and sections
//          open their own overlays (a Dropdown's list, a plain Popover
//          gallery) as separate body portals. To Popover's rule — "inside me
//          or my anchor, else close" — a press in such a nested overlay is an
//          outside press, and closing the flyout unmounts the nested overlay
//          before its click lands. The launcher therefore ignores any press
//          inside ANY `[data-section-flyout]`, which it has always done and
//          which the shell's placement journeys rely on.
//
//          Colours come only from LT (../theme).

import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import ReactDOM from "react-dom";
import { css, keyframes } from "@emotion/css";
import { SurfaceLayoutProvider, popoverLayout } from "../context";
import { LT } from "../theme";
import {
  FONT_FAMILY,
  HERO_ICON_SLOT,
  LABEL_FONT_SIZE,
  LAUNCHER_ICON_SIZE,
  LAUNCHER_MIN_WIDTH,
  TALL_CONTROL_HEIGHT,
  clampFlyoutWidth,
} from "../tokens";
import { RibbonIcon } from "../../ribbonIcons";
import { DropdownChevron } from "./Button";

/** Longest label the button shows before ellipsis. */
const LAUNCHER_LABEL_MAX_WIDTH = 110;
/** Horizontal inset of the flyout's content, both sides together: a 1px
 *  border, the card's 8px padding and the body's 3px, per side. The flyout
 *  reports its width minus this to the primitives inside it. */
const FLYOUT_CONTENT_INSET = 24;
/** Gap between the launcher and its flyout (Popover's default offset). */
const FLYOUT_OFFSET = 2;
/** Keep this far from the viewport edge. */
const VIEWPORT_MARGIN = 4;

const flyoutEnter = keyframes`
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
`;

const styles = {
  button: css`
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    box-sizing: border-box;
    min-width: ${LAUNCHER_MIN_WIDTH}px;
    height: ${TALL_CONTROL_HEIGHT}px;
    padding: 6px 10px;
    border: none;
    border-radius: ${LT.radiusControl};
    background: ${LT.buttonBg};
    color: ${LT.text};
    cursor: pointer;
    font-family: ${FONT_FAMILY};
    white-space: nowrap;
    transition:
      background-color ${LT.motionHover},
      box-shadow ${LT.motionHover};

    &:hover {
      background: ${LT.hover};
    }

    /* While its flyout is open the launcher stays lit, so the eye can find
       which cluster the flyout belongs to. */
    &[aria-expanded="true"] {
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
  /** 34px slot; an SVG section icon is fitted to 24 whatever size it was
   *  drawn at, so one icon prop serves the rail, the sidebar and here. */
  slot: css`
    display: flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: ${HERO_ICON_SLOT}px;
    height: ${HERO_ICON_SLOT}px;
    font-size: 20px;
    line-height: 1;

    & > svg {
      width: ${LAUNCHER_ICON_SIZE}px;
      height: ${LAUNCHER_ICON_SIZE}px;
    }
  `,
  label: css`
    display: flex;
    align-items: center;
    gap: 3px;
    max-width: ${LAUNCHER_LABEL_MAX_WIDTH}px;
    font-size: ${LABEL_FONT_SIZE}px;
    font-weight: 500;
    line-height: 13px;
  `,
  /** Ellipsis needs its own box: a flex container cannot truncate the
   *  anonymous text item inside it. */
  labelText: css`
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  chevron: css`
    display: inline-flex;
    align-items: center;
    flex: none;
    color: ${LT.textSecondary};
  `,
  flyout: css`
    position: fixed;
    z-index: 1100;
    box-sizing: border-box;
    max-height: 70vh;
    overflow: auto;
    padding: 8px;
    background: ${LT.surface};
    border: 1px solid ${LT.clusterBorder};
    border-radius: ${LT.radiusPopover};
    box-shadow: ${LT.shadowPopover};
    color: ${LT.text};
    font-family: ${FONT_FAMILY};
    /* backwards: nothing of the enter animation outlives it (see BandContent). */
    animation: ${flyoutEnter} ${LT.motionPopover} backwards;
  `,
  heading: css`
    padding: 4px 6px 8px;
    font-family: ${FONT_FAMILY};
    font-size: 11px;
    font-weight: 600;
    line-height: 1;
    color: ${LT.textSecondary};
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  `,
  body: css`
    padding: 0 3px 3px;
  `,
};

export interface LauncherProps {
  /** Button label (and the flyout's heading and accessible name). */
  label: string;
  /** Icon shown above the label (fitted to 24px); falls back to the generic
   *  group glyph. */
  icon?: React.ReactNode;
  /** Flyout width in px, clamped to the sidebar's own 240-480 range. */
  flyoutWidth?: number;
  /** Content hosted in the flyout, rendered at vertical popover geometry. */
  children: React.ReactNode;
  /** Rendered as data-testid on the launcher button. */
  testId?: string;
}

/**
 * Icon + label + chevron button opening a portal flyout. The flyout is tagged
 * `data-ribbon-content` (so the minimized-ribbon outside-click guard treats it
 * as ribbon content) and `data-section-flyout` (so nested outside-click checks
 * can recognize it). Escape closes it and, when focus was inside the flyout
 * or on the launcher, returns focus to the launcher.
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
  const flyoutRef = useRef<HTMLDivElement>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const width = clampFlyoutWidth(flyoutWidth);
  const flyoutId = `${useId()}-flyout`;

  const handleToggle = useCallback(() => {
    if (buttonRef.current) {
      setAnchorRect(buttonRef.current.getBoundingClientRect());
    }
    setOpen((prev) => !prev);
  }, []);

  // Close on Escape and on mousedown outside both the button and any flyout.
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Decide BEFORE closing: the flyout (and whatever in it held focus) is
      // gone after the re-render. Never take focus from an unrelated field.
      const button = buttonRef.current;
      const active = document.activeElement;
      const focusIsOurs =
        !active ||
        active === document.body ||
        active === button ||
        (flyoutRef.current !== null && flyoutRef.current.contains(active));
      setOpen(false);
      if (focusIsOurs) button?.focus();
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
    ? Math.max(VIEWPORT_MARGIN, Math.min(anchorRect.left, window.innerWidth - width - VIEWPORT_MARGIN))
    : VIEWPORT_MARGIN;
  const top = anchorRect ? anchorRect.bottom + FLYOUT_OFFSET : 0;
  const hasIcon = icon !== undefined && icon !== null && icon !== false && icon !== "";

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={styles.button}
        onClick={handleToggle}
        data-testid={testId}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? flyoutId : undefined}
      >
        <span className={styles.slot} aria-hidden>
          {hasIcon ? icon : <RibbonIcon.Group size={LAUNCHER_ICON_SIZE} />}
        </span>
        <span className={styles.label}>
          <span className={styles.labelText}>{label}</span>
          <span className={styles.chevron} aria-hidden>
            <DropdownChevron size={9} />
          </span>
        </span>
      </button>

      {open &&
        anchorRect &&
        ReactDOM.createPortal(
          <div
            ref={flyoutRef}
            id={flyoutId}
            className={styles.flyout}
            style={{ top, left, width }}
            data-ribbon-content=""
            data-section-flyout=""
            role="dialog"
            aria-label={label}
          >
            <div className={styles.heading}>{label}</div>
            <div className={styles.body}>
              <SurfaceLayoutProvider value={popoverLayout(width - FLYOUT_CONTENT_INSET)}>
                {children}
              </SurfaceLayoutProvider>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
