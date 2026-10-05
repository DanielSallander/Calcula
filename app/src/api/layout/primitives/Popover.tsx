//! FILENAME: app/src/api/layout/primitives/Popover.tsx
// PURPOSE: Anchored popover host — positions arbitrary dropdown content next to
//          an anchor element via a body portal, escaping any overflow:hidden
//          ancestor (the ribbon band clips its content, so in-band dropdowns
//          must not rely on position:absolute).
// CONTEXT: The positioning/dismissal half of the Launcher flyout, exposed as
//          its own primitive. Popover contributes fixed positioning clamped to
//          the viewport, Escape + outside-mousedown dismissal, and the
//          data-ribbon-content / data-section-flyout tags the shell's
//          outside-click guards recognize.
//
//          Two chromes, one host:
//          - PLAIN (default, `card` false): no chrome at all. Galleries and
//            custom dropdowns that already draw their own background/border/
//            shadow keep doing so. This mode renders BYTE-IDENTICAL DOM to the
//            pre-Clusters Popover — same style attribute, same three
//            attributes, no class — because a dozen callers and the visual
//            goldens were built against it; the popover tests pin the exact
//            style string.
//          - CARD (`card`): the Clusters popover chrome from the approved
//            mockup (surface, cluster border, 12px radius, popover shadow, 8px
//            padding, optional heading) with a short enter animation. Menus,
//            Dropdowns and the Launcher flyout all render through it, so every
//            overlay in the ribbon has the same edge.
//
//          Focus return: a popover dismissed by Escape hands focus back to its
//          anchor (or the first focusable inside it) — keyboard users would
//          otherwise be dropped on <body> and have to Tab from the top of the
//          window. It only does so when focus was inside the popover, on the
//          anchor, or nowhere; Escape pressed while the user is typing in an
//          unrelated field closes the popover but leaves that field focused.
//
//          ESCAPE NESTS (the NESTING rule of Menu.tsx, for every popover, not
//          only menus). A popover is often opened from inside another overlay
//          -- a collapsed group's Launcher flyout, a card -- whose dismissal
//          also listens on `document`. Escape must close the INNERMOST open
//          overlay only, as Excel's does. Two halves:
//          - Escape with focus INSIDE the popover is handled at the popover's
//            own root (close, focus back, preventDefault, stopPropagation), so
//            it never reaches `document` and no outer overlay hears it. Every
//            caller gets this without asking -- a gallery card, a palette, the
//            Home tab's Cell Styles popover -- because the rule is the kit's,
//            not the caller's. An Escape the content already handled
//            (defaultPrevented: a Menu or Dropdown inside, which also stop it)
//            is left alone there, and so is one while an overlay opened from
//            inside this popover is still open (the next half closes that).
//          - Escape with focus OUTSIDE it (on the trigger, after a pointer
//            open) reaches `document`, where every open overlay listens. Each
//            one then defers to an overlay portalled AFTER it -- that one was
//            opened from inside it (laterFlyoutIsOpen) -- so only the last one
//            closes, and the next Escape takes the one below.

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactDOM from "react-dom";
import { css, keyframes } from "@emotion/css";
import { LT } from "../theme";
import { FONT_FAMILY, POPOVER_CARD_BORDER, POPOVER_CARD_PADDING } from "../tokens";

/** Where the popover sits relative to its anchor. The two `top-*` placements
 *  open UPWARD -- for an anchor at the bottom of the window (the status bar),
 *  where a downward popover would start below the screen's edge. */
export type PopoverPlacement = "bottom-start" | "bottom-end" | "right-start" | "top-start" | "top-end";

export interface PopoverProps {
  /** Anchor the popover attaches to (usually the trigger or its wrapper). */
  anchorEl: HTMLElement | null;
  open: boolean;
  /** Called on Escape or mousedown outside both popover and anchor. */
  onClose: () => void;
  children: React.ReactNode;
  /** Draw the Clusters card chrome (surface, border, radius, shadow, padding,
   *  enter animation). Default false: no chrome, the caller draws its own. */
  card?: boolean;
  /** Default "bottom-start": below the anchor, left edges aligned. */
  placement?: PopoverPlacement;
  /** Gap between anchor and popover in px. Default 2. */
  offset?: number;
  /** Shift along the anchor's edge (the cross axis), in px. Default 0. For
   *  "right-start" it moves the popover DOWN from the anchor's top (negative
   *  lifts it: a MenuSub flyout passes SUBMENU_ALIGN_OFFSET so its first row
   *  lines up with the row that opened it); for the bottom-* and top-*
   *  placements it moves it RIGHT. The result is still clamped into the
   *  viewport. */
  alignOffset?: number;
  /** Small caption at the top of the popover (11px/600, secondary). Also the
   *  popover's accessible name when `ariaLabel` is not given. */
  heading?: string;
  /** Return focus to the anchor when dismissed by Escape. Default true. */
  returnFocus?: boolean;
  /** Fixed width in px (content otherwise sizes the popover). */
  width?: number;
  /** Accessible name of the popover. */
  ariaLabel?: string;
  /** ARIA role of the popover root. Default "dialog". */
  role?: string;
  /** Stacking layer. Default 1100, above the ribbon and task panes. A popover
   *  opened from a surface that itself sits higher — the mini format toolbar
   *  rides on the context menu at --z-context-menu (10000) — must pass a
   *  layer above that surface, or it opens behind it. */
  zIndex?: number;
}

// ============================================================================
// Pure helpers (exported for tests)
// ============================================================================

/** Keep this far from the viewport edge. */
const VIEWPORT_MARGIN = 4;

/**
 * Where a popover sits: by its TOP edge (every downward and sideways
 * placement), or by its BOTTOM edge (the upward `top-*` placements).
 */
export type PopoverPosition =
  | { left: number; top: number }
  | { left: number; bottom: number; maxHeight: number };

/**
 * Viewport position for a popover of `width` x `height` at `placement`.
 * "bottom-start" is the historical computation, unchanged: left edge on the
 * anchor's left, clamped into the viewport; top = anchor bottom + offset,
 * unclamped (taller content scrolls inside maxHeight instead).
 *
 * The upward placements are anchored by their BOTTOM edge (`bottom` is the
 * distance from the viewport's bottom), `offset` above the anchor's top, and
 * capped at the room above the anchor. A popover measured once and then
 * placed by its top would grow DOWNWARD when its content changes after it
 * opened -- over its own anchor and, from a status-bar anchor, off the bottom
 * of the window, taking its last rows (its commands) with it. Anchored by the
 * bottom it grows upward, and anything taller than the room scrolls.
 *
 * `alignOffset` shifts the popover along the anchor's edge -- down for
 * "right-start", right for the others -- before the viewport clamp. 0 (the
 * default) computes exactly what this function did before it existed.
 */
export function computePopoverPosition(
  anchor: Pick<DOMRect, "left" | "top" | "right" | "bottom">,
  width: number,
  height: number,
  placement: PopoverPlacement,
  offset: number,
  viewportWidth: number,
  viewportHeight: number,
  alignOffset = 0,
): PopoverPosition {
  const clampLeft = (x: number) =>
    Math.max(VIEWPORT_MARGIN, Math.min(x, viewportWidth - width - VIEWPORT_MARGIN));

  if (placement === "bottom-end") {
    return { left: clampLeft(anchor.right - width + alignOffset), top: anchor.bottom + offset };
  }

  if (placement === "top-start" || placement === "top-end") {
    void height; // the bottom edge does not depend on the content's height
    const left = placement === "top-end" ? anchor.right - width : anchor.left;
    return {
      left: clampLeft(left + alignOffset),
      bottom: viewportHeight - (anchor.top - offset),
      maxHeight: Math.max(0, anchor.top - offset - VIEWPORT_MARGIN),
    };
  }

  if (placement === "right-start") {
    let left = anchor.right + offset;
    // No room on the right: open to the left of the anchor instead.
    if (left + width > viewportWidth - VIEWPORT_MARGIN) {
      left = anchor.left - offset - width;
    }
    return {
      left: Math.max(VIEWPORT_MARGIN, left),
      top: Math.max(
        VIEWPORT_MARGIN,
        Math.min(anchor.top + alignOffset, viewportHeight - height - VIEWPORT_MARGIN),
      ),
    };
  }

  return { left: clampLeft(anchor.left + alignOffset), top: anchor.bottom + offset };
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The anchor itself when it can take focus, else its first focusable descendant. */
export function firstFocusable(anchor: HTMLElement): HTMLElement | null {
  if (anchor.matches(FOCUSABLE)) return anchor;
  return anchor.querySelector<HTMLElement>(FOCUSABLE);
}

/** Focus may be restored only when it sits somewhere this popover owns (or
 *  nowhere at all); never steal it from an unrelated field. */
function focusIsOurs(popover: HTMLElement | null, anchor: HTMLElement): boolean {
  const active = document.activeElement;
  if (!active || active === document.body) return true;
  if (popover && popover.contains(active)) return true;
  return anchor.contains(active);
}

/**
 * Kit-internal (Launcher uses it too): whether a `[data-section-flyout]` other
 * than `own` (and not inside it) sits AFTER `own` in the document. Every kit
 * overlay is a body portal appended when it opens, so a later one was opened
 * from inside this one (or while it was open) -- the INNERMOST overlay, which
 * owns a document-level Escape. The same "later portal = nested" reading
 * Popover's outside-press rule already uses.
 */
export function laterFlyoutIsOpen(own: HTMLElement | null): boolean {
  if (!own) return false;
  for (const other of Array.from(document.querySelectorAll("[data-section-flyout]"))) {
    if (other === own || own.contains(other)) continue;
    if (own.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING) return true;
  }
  return false;
}

// ============================================================================
// Styles (card mode only — plain mode must stay class-free)
// ============================================================================

const cardEnter = keyframes`
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
`;

/** The same entrance for a card that opened UPWARD: it rises out of its anchor. */
const cardEnterUp = keyframes`
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
`;

/** The padding and border are tokens (../tokens.ts) because a MenuSub flyout
 *  is PLACED by them: SUBMENU_ALIGN_OFFSET lifts it by border + padding so its
 *  first row lines up with its parent row. The rendered text is the same
 *  "8px" / "1px", so the class is unchanged. */
const cardChrome = css`
  box-sizing: border-box;
  padding: ${POPOVER_CARD_PADDING}px;
  background: ${LT.surface};
  border: ${POPOVER_CARD_BORDER}px solid ${LT.clusterBorder};
  border-radius: ${LT.radiusPopover};
  box-shadow: ${LT.shadowPopover};
  color: ${LT.text};
  font-family: ${FONT_FAMILY};
  /* backwards: nothing of the enter animation outlives it, so the card is not
     left on a compositor layer with grayscale text (see the ribbon BandContent). */
  animation: ${cardEnter} ${LT.motionPopover} backwards;

  &[data-opens="up"] {
    animation-name: ${cardEnterUp};
  }
`;

const headingStyle = css`
  padding: 4px 6px 8px;
  font-family: ${FONT_FAMILY};
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  color: ${LT.textSecondary};
`;

// ============================================================================
// Component
// ============================================================================

/**
 * Fixed-position dropdown host next to `anchorEl`. Content is measured after
 * mount and positioned into the viewport; taller-than-viewport content
 * scrolls. Renders nothing while closed.
 */
export function Popover({
  anchorEl,
  open,
  onClose,
  children,
  card = false,
  placement = "bottom-start",
  offset = 2,
  alignOffset = 0,
  heading,
  returnFocus = true,
  width,
  ariaLabel,
  role = "dialog",
  zIndex = 1100,
}: PopoverProps): React.ReactElement | null {
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<PopoverPosition | null>(null);
  const opensUp = placement === "top-start" || placement === "top-end";

  // Position after first paint so the content's real size is measurable.
  useLayoutEffect(() => {
    if (!open || !anchorEl) {
      setPos(null); // eslint-disable-line react-hooks/set-state-in-effect -- position is DOM measurement; a closed popover forgets it so the next open measures fresh
      return;
    }
    const w = popRef.current?.offsetWidth ?? 200;
    const h = popRef.current?.offsetHeight ?? 0;
    setPos(
      computePopoverPosition(
        anchorEl.getBoundingClientRect(),
        w,
        h,
        placement,
        offset,
        window.innerWidth,
        window.innerHeight,
        alignOffset,
      ),
    );
  }, [open, anchorEl, placement, offset, alignOffset]);

  /** Close and, when focus was ours, hand it back to the anchor. Decided
   *  BEFORE closing: once the parent re-renders, the popover (and whatever
   *  inside it held focus) is gone. */
  const closeFromEscape = useCallback(() => {
    const restore =
      returnFocus && anchorEl !== null && focusIsOurs(popRef.current, anchorEl)
        ? firstFocusable(anchorEl)
        : null;
    onClose();
    restore?.focus();
  }, [anchorEl, onClose, returnFocus]);

  /** Escape from INSIDE the popover (see ESCAPE NESTS in the header): handled
   *  here and stopped, so no overlay around this one also closes. Only a key
   *  whose target is DOM-inside this popover: React bubbles keys from nested
   *  portals through the component tree, and a nested overlay's key is its
   *  own (it stops a handled one itself). */
  const handleRootKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    if (!popRef.current || !popRef.current.contains(e.target as Node)) return;
    // Focus is in here but an overlay opened from in here is still open (a
    // palette its trigger opened by the pointer): that one is the innermost.
    // Leave the key to the document rule, where it closes that overlay.
    if (laterFlyoutIsOpen(popRef.current)) return;
    e.preventDefault();
    e.stopPropagation();
    closeFromEscape();
  };

  // Close on Escape and on mousedown outside both the popover and the anchor.
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // A popover opened from inside this one is the innermost: the key is
      // its (ESCAPE NESTS). This one closes on the next Escape.
      if (laterFlyoutIsOpen(popRef.current)) return;
      closeFromEscape();
    };
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (popRef.current && popRef.current.contains(target)) return;
      if (anchorEl && anchorEl.contains(target)) return;
      // A press inside a flyout that was portalled AFTER this one is a press
      // inside something this popover opened (a Dropdown or colour picker
      // inside a card). Closing here would unmount the nested surface before
      // its click lands. Launcher already had this tolerance; a flyout that
      // precedes this one in the document is a sibling and still dismisses.
      const other = target.closest("[data-section-flyout]");
      if (
        other &&
        popRef.current &&
        popRef.current.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING
      ) {
        return;
      }
      onClose();
    };
    document.addEventListener("keydown", handleKey);
    document.addEventListener("mousedown", handleMouseDown);
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.removeEventListener("mousedown", handleMouseDown);
    };
  }, [open, anchorEl, onClose, closeFromEscape]);

  if (!open) return null;

  // Upward placements are held by their BOTTOM edge (computePopoverPosition),
  // so content that changes after opening grows the card upward. Every other
  // placement keeps the historical style object -- same keys, same order --
  // because the plain-mode style string is pinned byte for byte.
  const style: React.CSSProperties =
    pos && "bottom" in pos
      ? {
          position: "fixed",
          left: pos.left,
          bottom: pos.bottom,
          zIndex,
          maxHeight: `min(80vh, ${pos.maxHeight}px)`,
          maxWidth: "calc(100vw - 8px)",
          overflow: "auto",
          visibility: "visible",
          ...(width !== undefined ? { width } : {}),
        }
      : {
          position: "fixed",
          left: pos?.left ?? 4,
          top: pos && "top" in pos ? pos.top : 0,
          zIndex,
          maxHeight: "80vh",
          maxWidth: "calc(100vw - 8px)",
          overflow: "auto",
          visibility: pos ? "visible" : "hidden",
          ...(width !== undefined ? { width } : {}),
        };

  return ReactDOM.createPortal(
    <div
      ref={popRef}
      className={card ? cardChrome : undefined}
      style={style}
      data-ribbon-content=""
      data-section-flyout=""
      data-opens={opensUp ? "up" : undefined}
      role={role}
      aria-label={ariaLabel ?? heading}
      onKeyDown={handleRootKeyDown}
    >
      {heading && <div className={headingStyle}>{heading}</div>}
      {children}
    </div>,
    document.body,
  );
}
