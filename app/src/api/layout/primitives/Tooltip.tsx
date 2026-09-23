//! FILENAME: app/src/api/layout/primitives/Tooltip.tsx
// PURPOSE: The one tooltip every @api/layout control shows — the control's
//          name plus its LIVE keyboard shortcut, in a dark chip below it.
// CONTEXT: Icon-only controls are the norm in the Calcula Clusters ribbon, so
//          the name has to be reachable somewhere other than the pixels. The
//          native `title` attribute cannot do it: it shows after an OS-chosen
//          delay, never on keyboard focus, cannot carry a styled shortcut, and
//          ignores the skin. This primitive fixes all four and adds nothing to
//          the DOM of the control it describes:
//
//          - NO WRAPPER ELEMENT. The child is cloned with chained handlers and
//            the anchor is `event.currentTarget`. A wrapping <span> would break
//            every `:first-child`/`> *` rule a Segmented or ControlGrid applies
//            to its children, and would change `button.textContent`, which
//            both unit tests and E2E journeys read.
//          - KEYBOARD FOCUS ONLY. Focus opens it only when the element matches
//            `:focus-visible`. A mouse click also focuses a button; showing a
//            tooltip on THAT focus would pop one up under the pointer after
//            every click, the exact noise the owner asked tooltips to avoid.
//          - NEVER ribbon content. The body portal is deliberately NOT tagged
//            `data-ribbon-content`. That tag exists so the minimized ribbon's
//            outside-click guard can recognise a press inside a flyout, and a
//            tooltip is pointer-events:none, so no press ever lands on it. What
//            the tag WOULD do is add a second match to every
//            `[data-ribbon-content]` query: E2E journeys resolve that selector
//            as a strict Playwright locator (panel-placement.spec.ts reads its
//            boundingBox), and a tooltip left open by the last hover would fail
//            the locator on a page that is otherwise correct.
//          - OFF SWITCH. `html[data-tooltips="off"]` hides every tooltip, so a
//            user setting (and the visual-regression harness, which must not
//            photograph a tooltip that happened to be hovered) can silence them
//            without touching a single control.
//          - LIVE SHORTCUT. `commandId` is resolved through the keybinding
//            registry each time the tooltip opens, so a rebound key updates
//            every tooltip that names it with no subscription to manage.

import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import ReactDOM from "react-dom";
import { css, keyframes } from "@emotion/css";
import { LT } from "../theme";
import { FONT_FAMILY, FONT_MONO, GAP_SM, TOOLTIP_DELAY_MS } from "../tokens";
import { formatCombo, getAllKeybindings, getEffectiveCombo } from "../../keybindings";

// ============================================================================
// Types
// ============================================================================

/** Which side of the anchor the tooltip prefers (it flips when it would clip). */
export type TooltipPlacement = "bottom" | "top" | "right";

export interface TooltipProps {
  /** The control's name (or a short description). Empty/null makes the
   *  tooltip inert: the child renders untouched and nothing ever opens. */
  content: React.ReactNode;
  /** A literal shortcut to show in the chip ("Ctrl+B"). Wins over commandId. */
  shortcut?: string;
  /** Resolve the chip from the live keybinding registry instead. Accepts a
   *  keybinding id ("core.copy") or the command id it runs
   *  ("core.clipboard.copy"). Unknown ids simply show no chip. */
  commandId?: string;
  /** Preferred side. Default "bottom" — the ribbon sits at the top of the
   *  window, so below is where there is always room. */
  placement?: TooltipPlacement;
  /** Hover/focus delay in ms before opening. Default TOOLTIP_DELAY_MS. */
  delay?: number;
  /** Stacking layer of the portalled tip. Default 1200 (above card popovers
   *  at 1100). A control living ABOVE that — the mini format toolbar sits on
   *  the context menu at --z-context-menu — passes a higher layer so its
   *  tooltip is not drawn behind the surface it describes. */
  zIndex?: number;
  /** Exactly one element that forwards mouse/focus handlers to a DOM node. */
  children: React.ReactElement;
}

/** The props the clone chains or sets. The child can be any element that
 *  forwards them to its DOM node. */
type AnchorHandlerProps = Pick<
  React.HTMLAttributes<HTMLElement>,
  "onMouseEnter" | "onMouseLeave" | "onMouseDown" | "onFocus" | "onBlur" | "aria-describedby"
>;

// ============================================================================
// Pure helpers (exported for tests)
// ============================================================================

/** Gap between the anchor's edge and the tooltip. */
const ANCHOR_GAP = GAP_SM;
/** Keep this far from the viewport edge. */
const VIEWPORT_MARGIN = 4;

/** True while the user (or a harness) has switched tooltips off globally. */
export function tooltipsDisabled(): boolean {
  if (typeof document === "undefined") return true;
  return document.documentElement.dataset.tooltips === "off";
}

/**
 * Whether `el` received KEYBOARD focus. `:focus-visible` is the browser's own
 * answer to that question; where the selector engine does not know it (jsdom
 * builds, very old WebViews) `matches` throws a SyntaxError, and a throw is
 * treated as "not keyboard focus" — the failure mode must be a missing
 * tooltip, never one that pops up after every click.
 */
export function isKeyboardFocus(el: Element): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return false;
  }
}

/**
 * The chip text for a tooltip: the literal `shortcut` if given, else the live
 * binding for `commandId`. `getEffectiveCombo` is keyed by KEYBINDING id; a
 * caller naming the command instead ("core.clipboard.copy" rather than
 * "core.copy") is resolved through the binding that runs it. Any failure — an
 * unknown id, a registry that is not initialised in this window — yields no
 * chip rather than an exception inside a hover handler.
 */
export function resolveShortcutLabel(shortcut?: string, commandId?: string): string | null {
  if (shortcut) return shortcut;
  if (!commandId) return null;
  try {
    let combo = getEffectiveCombo(commandId);
    if (!combo) {
      const binding = getAllKeybindings().find((b) => b.commandId === commandId);
      if (binding) combo = getEffectiveCombo(binding.id);
    }
    if (!combo) return null;
    const label = formatCombo(combo);
    return label || null;
  } catch {
    return null;
  }
}

/** Anchor-relative position, flipped to the other side when it would clip and
 *  then clamped into the viewport. */
export function computeTooltipPosition(
  anchor: Pick<DOMRect, "left" | "top" | "right" | "bottom" | "width" | "height">,
  width: number,
  height: number,
  placement: TooltipPlacement,
  viewportWidth: number,
  viewportHeight: number,
): { left: number; top: number } {
  let left: number;
  let top: number;

  if (placement === "right") {
    left = anchor.right + ANCHOR_GAP;
    if (left + width > viewportWidth - VIEWPORT_MARGIN) {
      left = anchor.left - ANCHOR_GAP - width;
    }
    top = anchor.top + anchor.height / 2 - height / 2;
  } else {
    left = anchor.left + anchor.width / 2 - width / 2;
    const below = anchor.bottom + ANCHOR_GAP;
    const above = anchor.top - ANCHOR_GAP - height;
    if (placement === "top") {
      top = above >= VIEWPORT_MARGIN ? above : below;
    } else {
      top =
        below + height > viewportHeight - VIEWPORT_MARGIN && above >= VIEWPORT_MARGIN
          ? above
          : below;
    }
  }

  return {
    left: Math.max(VIEWPORT_MARGIN, Math.min(left, viewportWidth - width - VIEWPORT_MARGIN)),
    top: Math.max(VIEWPORT_MARGIN, Math.min(top, viewportHeight - height - VIEWPORT_MARGIN)),
  };
}

function hasContent(content: React.ReactNode): boolean {
  return content !== null && content !== undefined && content !== false && content !== "";
}

// ============================================================================
// Styles
// ============================================================================

const tipEnter = keyframes`
  from { opacity: 0; }
  to { opacity: 1; }
`;

const styles = {
  tip: css`
    position: fixed;
    z-index: 1200;
    pointer-events: none;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    max-width: 320px;
    box-sizing: border-box;
    padding: 5px 9px;
    border-radius: 7px;
    background: ${LT.tooltipBg};
    color: ${LT.tooltipFg};
    box-shadow: ${LT.shadowPopover};
    font-family: ${FONT_FAMILY};
    font-size: 12px;
    font-weight: 400;
    line-height: 1.2;
    white-space: normal;
    animation: ${tipEnter} ${LT.motionHover} backwards;
  `,
  kbd: css`
    flex: none;
    font-family: ${FONT_MONO};
    font-size: 11px;
    font-weight: 400;
    line-height: 1;
    padding: 3px 6px;
    border-radius: 4px;
    background: ${LT.kbdBg};
    color: inherit;
    white-space: nowrap;
  `,
};

// ============================================================================
// Component
// ============================================================================

/**
 * Attach a tooltip to exactly one element without wrapping it. Opens after
 * `delay` on pointer hover or keyboard focus; closes on leave, blur, press or
 * Escape. While open the anchor carries `aria-describedby` pointing at the
 * tooltip, so a screen reader announces the name and shortcut with it.
 */
export function Tooltip({
  content,
  shortcut,
  commandId,
  placement = "bottom",
  delay = TOOLTIP_DELAY_MS,
  zIndex,
  children,
}: TooltipProps): React.ReactElement {
  const tooltipId = useId();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const active = hasContent(content);

  const cancelTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const close = useCallback(() => {
    cancelTimer();
    setAnchor(null);
  }, [cancelTimer]);

  const schedule = useCallback(
    (el: HTMLElement) => {
      cancelTimer();
      if (tooltipsDisabled()) return;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        // Re-checked at fire time: the switch can flip, and the control can
        // leave the document, during the delay.
        if (tooltipsDisabled() || !el.isConnected) return;
        setAnchor(el);
      }, delay);
    },
    [cancelTimer, delay],
  );

  // A pending timer must never fire into an unmounted component.
  useEffect(() => cancelTimer, [cancelTimer]);

  // Content going empty while open (a caller clearing its tooltip) closes it.
  useEffect(() => {
    if (!active && anchor) close();
  }, [active, anchor, close]);

  // Escape dismisses a tooltip opened by HOVER too, when focus is somewhere
  // else entirely (WCAG 1.4.13: dismissible without moving the pointer). The
  // listener lives only while this tooltip is open, never calls
  // preventDefault, and closes nothing but this tooltip.
  useEffect(() => {
    if (!anchor) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [anchor, close]);

  const open = anchor !== null && active && !tooltipsDisabled();
  const chip = open ? resolveShortcutLabel(shortcut, commandId) : null;

  // Measure after mount so the real size is known, then position. The tooltip
  // renders hidden for that one layout pass, so it never paints at 0,0.
  useLayoutEffect(() => {
    if (!open || !anchor) {
      setPos(null);
      return;
    }
    const tip = tipRef.current;
    if (!tip) return;
    setPos(
      computeTooltipPosition(
        anchor.getBoundingClientRect(),
        tip.offsetWidth,
        tip.offsetHeight,
        placement,
        window.innerWidth,
        window.innerHeight,
      ),
    );
  }, [open, anchor, placement, content, chip]);

  const child = React.Children.only(children);
  const childProps = child.props as AnchorHandlerProps;

  // The returned shape is always [control, portal-or-nothing], open or not
  // and active or not, so opening the tooltip (or a caller clearing its
  // content) never changes the tree shape — a shape change would remount the
  // control and drop its focus.
  const anchorElement = active
    ? // eslint-disable-next-line react-hooks/refs -- the handlers capture timerRef for event-time access; nothing reads a ref during render
      React.cloneElement(child, {
        onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
          childProps.onMouseEnter?.(e);
          schedule(e.currentTarget);
        },
        onMouseLeave: (e: React.MouseEvent<HTMLElement>) => {
          childProps.onMouseLeave?.(e);
          close();
        },
        onMouseDown: (e: React.MouseEvent<HTMLElement>) => {
          childProps.onMouseDown?.(e);
          close();
        },
        onFocus: (e: React.FocusEvent<HTMLElement>) => {
          childProps.onFocus?.(e);
          if (isKeyboardFocus(e.currentTarget)) schedule(e.currentTarget);
        },
        onBlur: (e: React.FocusEvent<HTMLElement>) => {
          childProps.onBlur?.(e);
          close();
        },
        // eslint-disable-next-line @typescript-eslint/naming-convention -- a DOM attribute name, not a Rust-mirrored field
        "aria-describedby": open
          ? [childProps["aria-describedby"], tooltipId].filter(Boolean).join(" ")
          : childProps["aria-describedby"],
      } as AnchorHandlerProps)
    : child;

  return (
    <>
      {anchorElement}
      {open &&
        ReactDOM.createPortal(
          <div
            ref={tipRef}
            id={tooltipId}
            role="tooltip"
            className={styles.tip}
            style={{
              left: pos?.left ?? 0,
              top: pos?.top ?? 0,
              visibility: pos ? "visible" : "hidden",
              ...(zIndex !== undefined ? { zIndex } : {}),
            }}
          >
            <span>{content}</span>
            {chip && <kbd className={styles.kbd}>{chip}</kbd>}
          </div>,
          document.body,
        )}
    </>
  );
}
