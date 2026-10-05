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
//          which the shell's placement journeys rely on. Its Escape follows
//          Popover's ESCAPE NESTS rule: an Escape already handled inside the
//          flyout, or one while an overlay opened from inside it is still
//          open, is not the flyout's -- the innermost overlay closes first.
//
//          Colours come only from LT (../theme).
//
//          THE DIALOG LAUNCHER lives here too, and is a different thing with a
//          confusingly similar name. Excel calls the small corner arrow under a
//          group (Font, Alignment, Number) its "dialog box launcher"; Calcula
//          already called the collapsed-group button a "launcher". The corner
//          arrow is therefore always the DIALOG launcher in code, tests and test
//          ids (`dialog-launcher-<sectionId>`, never `section-launcher-*`, which
//          the width probes match as "this group is collapsed"). It is declared
//          by a section (PanelSection.dialogLauncher, ../../uiTypes) and drawn
//          by the shell in three places: the group's caption cell, the sidebar
//          section header, and — because a collapsed group has no caption row
//          worth the room — the heading of THIS flyout. That last one is why
//          the button is kit chrome in this file rather than shell chrome: the
//          kit cannot import the shell, and one drawing must serve all three.

import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import ReactDOM from "react-dom";
import { css, cx, keyframes } from "@emotion/css";
import { SurfaceLayoutProvider, popoverLayout } from "../context";
import { LT } from "../theme";
import {
  CONTROL_HEIGHT_MD,
  DIALOG_LAUNCHER_GLYPH_SIZE,
  DIALOG_LAUNCHER_HEIGHT,
  DIALOG_LAUNCHER_WIDTH,
  FONT_FAMILY,
  HERO_ICON_SLOT,
  LABEL_FONT_SIZE,
  LAUNCHER_ICON_SIZE,
  LAUNCHER_MIN_WIDTH,
  TALL_CONTROL_HEIGHT,
  clampFlyoutWidth,
} from "../tokens";
import { RibbonIcon } from "../../ribbonIcons";
import type { PanelSectionDialogLauncher } from "../../uiTypes";
import { DropdownChevron } from "./Button";
import { laterFlyoutIsOpen } from "./Popover";
import { Tooltip } from "./Tooltip";
import { focusWhenVisible } from "./roving";

// ============================================================================
// Dialog launcher (Excel's corner arrow) — geometry
// ============================================================================

// The geometry is band geometry -- the shell lays a caption out by it -- so it
// lives in ../tokens.ts with the rest (and reaches the @api/layout barrel
// through it). These names are re-exported here, unchanged, because the shell
// (SectionChrome.tsx, its tests) imported them from this file first.
export {
  DIALOG_LAUNCHER_WIDTH,
  DIALOG_LAUNCHER_HEIGHT,
  DIALOG_LAUNCHER_GLYPH_SIZE,
  DIALOG_LAUNCHER_CAPTION_PAD,
  DIALOG_LAUNCHER_HIDDEN_INSET,
} from "../tokens";
/** The sidebar header row is 36px tall; there the launcher is a standard 28px
 *  control so its target matches the header's other controls. */
const DIALOG_LAUNCHER_HEADER_BOX = CONTROL_HEIGHT_MD;
const DIALOG_LAUNCHER_HEADER_GLYPH = 12;

/**
 * Excel's dialog-launcher picture, drawn as kit chrome on the duotone set's
 * 24-unit grid (like DropdownChevron) rather than as a RibbonIcon key: it is
 * part of the group frame, not a command's picture, and an icon key would put
 * it in the customisable icon set where a skin or an add-in could repaint the
 * frame. The drawing: the top-left corner of a small square, and a diagonal
 * arrow running from inside it to the bottom-right, whose head is the square's
 * missing bottom-right corner. Stroked in currentColor so the button's token
 * colour (and its hover) paints it.
 */
export function DialogLauncherGlyph({
  size = DIALOG_LAUNCHER_GLYPH_SIZE,
}: {
  size?: number;
}): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      style={{ display: "block", flex: "none" }}
      aria-hidden
      data-dialog-launcher-glyph=""
    >
      <path
        d="M3.5 13V3.5H13"
        stroke="currentColor"
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9 9L20 20M20 11.5V20H11.5"
        stroke="currentColor"
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const dialogLauncherStyles = {
  /** Flat at rest like every ribbon control; the glyph is secondary text so
   *  the arrow never outweighs the caption it sits beside, and goes primary on
   *  hover, the way Excel's darkens. */
  button: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    box-sizing: border-box;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: ${LT.buttonBg};
    color: ${LT.textSecondary};
    cursor: pointer;
    transition:
      background-color ${LT.motionHover},
      color ${LT.motionHover};

    &:hover {
      background: ${LT.hover};
      color: ${LT.text};
    }

    &:active {
      background: ${LT.active};
    }

    &:focus-visible {
      outline: none;
      box-shadow: ${LT.focusRing};
    }
  `,
  caption: css`
    width: ${DIALOG_LAUNCHER_WIDTH}px;
    height: ${DIALOG_LAUNCHER_HEIGHT}px;
  `,
  header: css`
    width: ${DIALOG_LAUNCHER_HEADER_BOX}px;
    height: ${DIALOG_LAUNCHER_HEADER_BOX}px;
    border-radius: ${LT.radiusControl};
  `,
};

export interface DialogLauncherButtonProps {
  /** The dialog's name: aria-label and tooltip. */
  label: string;
  /** Runs on click (and so on Enter / Space: it is a native button). */
  onClick: () => void;
  /** Live shortcut chip for the tooltip (resolved by Tooltip at open time). */
  commandId?: string;
  /** data-testid. */
  testId?: string;
  /** "caption" (default): the 16x13 corner button of a caption row or a
   *  flyout heading. "header": a 28px square for the 36px sidebar header. */
  size?: "caption" | "header";
  /** Positioning hooks for the host (the shell anchors the caption one). */
  className?: string;
  style?: React.CSSProperties;
}

/**
 * The dialog-launcher button: a real <button> (so Tab reaches it and Enter /
 * Space press it), named by its label, explained by the shared Tooltip with
 * the live shortcut of `commandId`, tagged `data-dialog-launcher` so tests and
 * journeys can find every one without knowing its test id. Its only content is
 * the glyph: no text, so a host's textContent (a caption, a heading) is never
 * changed by its presence.
 */
export function DialogLauncherButton({
  label,
  onClick,
  commandId,
  testId,
  size = "caption",
  className,
  style,
}: DialogLauncherButtonProps): React.ReactElement {
  return (
    <Tooltip content={label} commandId={commandId}>
      <button
        type="button"
        className={cx(
          dialogLauncherStyles.button,
          size === "header" ? dialogLauncherStyles.header : dialogLauncherStyles.caption,
          className,
        )}
        style={style}
        aria-label={label}
        data-testid={testId}
        data-dialog-launcher=""
        onClick={onClick}
      >
        <DialogLauncherGlyph
          size={size === "header" ? DIALOG_LAUNCHER_HEADER_GLYPH : DIALOG_LAUNCHER_GLYPH_SIZE}
        />
      </button>
    </Tooltip>
  );
}

/** Every element that CAN sit in the Tab order; firstTabStop keeps the ones
 *  that do. */
const TAB_STOP_CANDIDATES =
  'button, [href], input:not([type="hidden"]), select, textarea, [tabindex], [contenteditable="true"]';

/**
 * The first element inside `root` that Tab would reach: not disabled, tabIndex
 * 0 or more. Deliberately not Popover's firstFocusable, which also accepts the
 * items a roving group (Segmented, a palette, SegmentedChoice) parks at
 * tabIndex -1 -- focusable by script, skipped by Tab -- and would enter a pill
 * on its FIRST item instead of its current one.
 */
function firstTabStop(root: HTMLElement | null): HTMLElement | null {
  if (!root) return null;
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(TAB_STOP_CANDIDATES))) {
    if (el.tabIndex < 0) continue;
    if ((el as HTMLButtonElement).disabled === true) continue;
    return el;
  }
  return null;
}

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
  /** The heading as a row: label left, dialog launcher right. Only while a
   *  launcher is declared, so a heading without one stays the plain text box
   *  it always was. The ellipsis moves to the text's own span (a flex
   *  container cannot truncate its anonymous text), and the row stops
   *  clipping so the launcher's focus ring is not cut off. */
  headingRow: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    overflow: visible;
  `,
  headingText: css`
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
  /** The collapsed group's DIALOG launcher (Excel's corner arrow), drawn at
   *  the right of the flyout's heading. Its `testId` is used as given (the
   *  shell resolves the `dialog-launcher-<sectionId>` default before passing
   *  it). Choosing it closes the flyout, returns focus to this launcher
   *  button (so a dialog that restores focus on close lands somewhere real)
   *  and then runs `onLaunch`. */
  dialogLauncher?: PanelSectionDialogLauncher;
}

/**
 * Icon + label + chevron button opening a portal flyout. The flyout is tagged
 * `data-ribbon-content` (so the minimized-ribbon outside-click guard treats it
 * as ribbon content) and `data-section-flyout` (so nested outside-click checks
 * can recognize it). Opened from the keyboard (Enter / Space) it moves focus
 * to the content's first tab stop; opened by the pointer it leaves focus
 * alone. Escape closes it and, when focus was inside the flyout or on the
 * launcher, returns focus to the launcher.
 */
export function Launcher({
  label,
  icon,
  flyoutWidth,
  children,
  testId,
  dialogLauncher,
}: LauncherProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Whether the toggle that opened the flyout came from the keyboard. A ref,
  // not state: it is read once, by the effect that runs after that open.
  const openedFromKeys = useRef(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const width = clampFlyoutWidth(flyoutWidth);
  const flyoutId = `${useId()}-flyout`;

  const handleToggle = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    if (buttonRef.current) {
      setAnchorRect(buttonRef.current.getBoundingClientRect());
    }
    // detail 0: Enter or Space on this native button, or an assistive
    // technology's click -- never a pointer press, which counts its clicks.
    openedFromKeys.current = e.detail === 0;
    setOpen((prev) => !prev);
  }, []);

  // KEYBOARD OPEN MOVES FOCUS IN (Excel: a collapsed group's drop-down opened
  // from the keyboard takes focus). The flyout is a body portal at the END of
  // the document, so a keyboard user left on the group button would reach it
  // only by tabbing through the whole rest of the window. Focus goes to the
  // first TAB STOP of the content -- the section's first control, not the
  // heading's dialog launcher, which Excel puts last in its drop-down (the
  // caption row is at the bottom there) -- and to the heading's launcher only
  // when the content has nothing to focus. A pointer open moves nothing: the
  // pointer is where the user is working. Content that took focus itself while
  // mounting (an autoFocus field) keeps it. Escape still hands focus back to
  // this button (the listener below).
  useEffect(() => {
    if (!open || !openedFromKeys.current) return;
    openedFromKeys.current = false;
    const flyout = flyoutRef.current;
    if (!flyout || flyout.contains(document.activeElement)) return;
    focusWhenVisible(firstTabStop(bodyRef.current) ?? firstTabStop(flyout));
  }, [open]);

  // Close on Escape and on mousedown outside both the button and any flyout.
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // ESCAPE NESTS (Popover.tsx): Escape closes the INNERMOST open overlay.
      // A key something inside the flyout already handled is not ours, and
      // neither is one while an overlay opened from inside the flyout is
      // still open (a gallery, a palette, the Cell Styles popover, a menu):
      // that overlay closes on this Escape, and the flyout on the next. This
      // listener was registered first (the flyout opened first), so without
      // the check it closed the flyout too, and the inner overlay then sent
      // focus to a trigger that was unmounting -- onto <body>.
      if (e.defaultPrevented || laterFlyoutIsOpen(flyoutRef.current)) return;
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

  // Close first (Excel's drop-down closes when its dialog launcher is chosen),
  // put focus back on the group button while the flyout that held it is
  // unmounting, then open the dialog — which takes focus, and gives it back to
  // the group button on close instead of to <body>.
  const onLaunch = dialogLauncher?.onLaunch;
  const handleDialogLaunch = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
    onLaunch?.();
  }, [onLaunch]);

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
            {dialogLauncher ? (
              <div className={cx(styles.heading, styles.headingRow)}>
                <span className={styles.headingText}>{label}</span>
                <DialogLauncherButton
                  label={dialogLauncher.label}
                  onClick={handleDialogLaunch}
                  commandId={dialogLauncher.commandId}
                  testId={dialogLauncher.testId}
                />
              </div>
            ) : (
              <div className={styles.heading}>{label}</div>
            )}
            <div ref={bodyRef} className={styles.body}>
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
