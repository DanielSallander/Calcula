//! FILENAME: app/extensions/ControlsPane/components/paneChrome.ts
// PURPOSE: The Controls pane's shared chrome recipes — the rounded chip-card
//          every filter and control renders as, the popover section heading,
//          and the one primary-action button — painted with LT tokens only.
// CONTEXT: Before the Calcula Clusters redesign RibbonFilterCard, ControlCard
//          and CustomControlHost each carried a private copy of the same card
//          (#c0c0c0 border, #fff fill, 3px radius), so in Dark the whole
//          Controls tab stayed a strip of white boxes. One recipe here means the
//          cards follow the skin together and cannot drift apart again.
//
//          The card keeps its 56px band height: the section declares
//          ribbonPresentation "inline" on exactly that promise (a fixed-height
//          strip that fits the cluster's 61px content box without a probe), and
//          the HTML5 drag wrapper in ControlsPaneSection lays the cards out by it.

import type React from "react";
import { css } from "@emotion/css";
import { LT } from "@api/layout";

/** Band card height. Fits the 61px cluster content box with room to spare. */
export const PANE_CARD_HEIGHT = 56;
/** Band card width bounds (the card sizes to its content between them). */
export const PANE_CARD_MIN_WIDTH = 120;
export const PANE_CARD_MAX_WIDTH = 220;

/**
 * The chip-card: cluster radius, surface fill, a 1px control border. An
 * `active` card (a filter that is filtering) takes the pressed wash, layered
 * over the surface because the wash is translucent and the cluster behind the
 * card would otherwise tint it. Band: fixed 56px tall, width between the
 * bounds; sidebar: the full row, at least 56px.
 */
export function paneCardStyle(band: boolean, active = false): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "4px 4px 4px 10px",
    border: `1px solid ${active ? LT.pressedBorder : LT.controlBorder}`,
    borderRadius: LT.radiusCluster,
    background: active ? `linear-gradient(${LT.pressed}, ${LT.pressed}), ${LT.surface}` : LT.surface,
    color: LT.text,
    cursor: "default",
    boxSizing: "border-box",
    transition: `background-color ${LT.motionHover}, border-color ${LT.motionHover}`,
    ...(band
      ? {
          height: PANE_CARD_HEIGHT,
          flexShrink: 0,
          minWidth: PANE_CARD_MIN_WIDTH,
          maxWidth: PANE_CARD_MAX_WIDTH,
        }
      : { width: "100%", minHeight: PANE_CARD_HEIGHT }),
  };
}

/** The card's title line (control name / filter field). */
export const cardTitleStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  lineHeight: "14px",
  color: LT.text,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  minWidth: 0,
};

/** The one pane heading recipe of the redesign: 12px/600, sentence case. */
export const sectionHeadingStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  lineHeight: "16px",
  color: LT.text,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

/**
 * Focus an element inside a freshly opened @api Popover. The Popover renders
 * its first, measuring pass with `visibility: hidden`, and a hidden element
 * refuses focus — so `autoFocus` (and a plain focus() in a mount effect) are
 * silently lost. Try now; if focus did not land, try again next frame, when
 * the positioned popover is visible. Returns a cancel for effect cleanup.
 */
export function focusWhenVisible(
  get: () => HTMLElement | null,
  select = false,
): () => void {
  const focus = (): void => {
    const el = get();
    if (!el || !el.isConnected) return;
    el.focus();
    if (select && el instanceof HTMLInputElement) el.select();
  };
  focus();
  const el = get();
  if (!el || document.activeElement === el) return () => undefined;
  if (typeof requestAnimationFrame !== "function") return () => undefined;
  const raf = requestAnimationFrame(focus);
  return () => cancelAnimationFrame(raf);
}

/**
 * A popover's single primary action (OK, Save, Apply filter) on the state
 * accent — the same recipe the Home-tab customize dialog uses. Applied as a
 * className on an `outlined` @api Button; `&&` out-ranks the Button's own
 * outlined rule, which is declared in the same stylesheet order.
 */
export const primaryButtonClass = css`
  && {
    background: ${LT.stateAccent};
    border-color: ${LT.stateAccent};
    color: ${LT.onAccent};
  }

  &&:hover:not(:disabled) {
    background: linear-gradient(${LT.active}, ${LT.active}), ${LT.stateAccent};
  }
`;
