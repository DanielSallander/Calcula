//! FILENAME: app/extensions/BuiltIn/HomeTab/components/styles/CellStylesButton.tsx
// PURPOSE: Home > Styles > Cell Styles (CONTRACT 3.10): Excel's large
//          "Cell / Styles v" button, opening the shared Cell Styles gallery.
// CONTEXT: Rendered for the catalog item "cellStyles". Moved here from
//          HomeTabGroupComponent.renderHero, where it was the one hero with a
//          popover of its own; the behaviour is kept, and so are the hooks the
//          journeys hold: `fmt-cellStyles` on the button, `cell-styles-gallery`
//          and its `cell-style-<id>` options (CellStylesGallery's own).
//
//          WHY NOT THE REGISTERED-MENU SEAM its two neighbours use. The
//          gallery is not another extension's: it lives in extensions/_shared
//          (the sanctioned shared code), and its pick must go down THIS group's
//          formatting door -- state.handleCellStyleApply -> applyFormat, which
//          refuses while something else owns the selection (a floating grid's
//          cell, BUG-0185) and refreshes the ribbon after -- not the Format
//          menu's copy of the handler.
//
//          HOW IT OPENS. A wrapper <div> is the popover's anchor (a callback
//          ref into state, so the anchor is never read from a ref during
//          render), and the gallery portals to <body> because the band clips
//          overflow. A PLAIN popover: CellStylesGallery draws its own card
//          chrome outside a menu, and forces the grid layout itself -- inside a
//          popover portalled out of the band it would otherwise inherit the
//          band's 61px strip through React context.
//
//          WHAT CHANGED WITH THE MOVE -- brought in line with Conditional
//          Formatting and Format as Table beside it, which behave this way
//          through the kit (RegisteredMenuButton):
//          - Opened from the KEYBOARD (Enter/Space send a click with detail
//            0), focus goes into the gallery, as Excel moves focus into a
//            drop-down. The gallery is portalled to the END of <body>, so
//            before this a keyboard user's Tab from the button went to the
//            next ribbon control and never reached it.
//          - A pick hands focus back to the button. The option that held
//            focus unmounts with the gallery, and focus used to fall to
//            <body>, where the next key reached nothing a keyboard user could
//            see.
//          - `aria-controls` names the open gallery's popover.
//          - ArrowDown / ArrowUp open it with focus inside (or step into it
//            when a pointer opened it), as they open every other popup hero
//            in the tab (review finding, 2026-10-04: two of the three Styles
//            heroes ignored them).
//          - Escape NESTS: inside a collapsed group's flyout, Escape in the
//            gallery closes the gallery only and focus returns to the button;
//            the next Escape closes the flyout. The kit's Popover does this
//            for every plain popover (its "ESCAPE NESTS" rule) -- nothing
//            here handles Escape itself, and nothing should.
//          - A refusal that escapes the formatting door (a rejection, or a
//            throw) reaches the user through alertAsync, as handleItemClick's
//            do -- never an unhandled promise rejection from the gallery's
//            fire-and-forget call.

import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { RibbonIcon } from "@api";
import { alertAsync } from "@api/dialogs";
import { CommandButton, Popover, HERO_ICON_SIZE, ICON_SIZE_SM } from "@api/layout";
import {
  CellStylesGallery,
  type CellStyleDefinition,
} from "../../../../_shared/components/CellStylesGallery";
import type { HomeItemProps } from "../homeItemProps";
import { homeTabIcon } from "../homeTabIcons";
import { itemTooltip } from "../itemTooltip";

/** What can take focus inside the gallery: StyleGallery's roving option
 *  (tabindex 0) comes first. The kit's own query, which it does not export. */
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Focus `el`, retrying on the next frame. Popover renders its content with
 * `visibility: hidden` for one pass, measures it, then shows it -- and
 * Chromium silently refuses to focus a hidden element. jsdom does not model
 * visibility, so the retry is what the app needs and the first attempt is
 * what a unit test sees (the kit's focusWhenVisible, which it does not export).
 */
function focusWhenShown(el: HTMLElement | null): void {
  if (!el) return;
  el.focus();
  if (document.activeElement === el || typeof requestAnimationFrame !== "function") return;
  requestAnimationFrame(() => {
    if (el.isConnected) el.focus();
  });
}

/** A refusal's words, for the user. */
function reportRefusal(err: unknown): void {
  void alertAsync(err instanceof Error ? err.message : String(err));
}

export function CellStylesButton({ item, state, band }: HomeItemProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  // Opened from the keyboard: move focus into the gallery once it is shown.
  const [focusOnOpen, setFocusOnOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const bodyId = `${useId()}-gallery`;

  useEffect(() => {
    if (!open || !focusOnOpen || !bodyRef.current) return;
    focusWhenShown(bodyRef.current.querySelector<HTMLElement>(FOCUSABLE));
  }, [open, focusOnOpen]);

  /** Escape and an outside press: the Popover already returns focus where it
   *  belongs (the button on Escape; wherever the user pressed otherwise). */
  const dismiss = useCallback(() => setOpen(false), []);

  /** The gallery's own close, after a pick: back to the button. */
  const close = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, []);

  /** ArrowDown / ArrowUp open the gallery with focus inside, as they open
   *  every other popup hero (MenuButton's trigger rule, and the kit's
   *  ContentTrigger for Conditional Formatting and Format as Table beside
   *  it); a gallery has no "last item", so both arrows open it the same way.
   *  Already open (a pointer open left focus here): step in. */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.defaultPrevented) return;
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    if (open) {
      focusWhenShown(bodyRef.current?.querySelector<HTMLElement>(FOCUSABLE) ?? null);
      return;
    }
    setFocusOnOpen(true);
    setOpen(true);
  };

  const handleItemApply = state.handleCellStyleApply;
  const apply = useCallback(
    (formatting: CellStyleDefinition["formatting"]) => {
      // The gallery calls this and then closes, without awaiting: a rejection
      // here would be unhandled, and a throw would skip its close.
      let pending: unknown;
      try {
        pending = handleItemApply(formatting);
      } catch (err) {
        reportRefusal(err);
        return;
      }
      Promise.resolve(pending).catch(reportRefusal);
    },
    [handleItemApply],
  );

  const tip = itemTooltip(item);
  const label = item.shortLabel ?? item.label;
  // 30px in the band's hero slot; outside the band CommandButton is a standard
  // 28px button whose icon is the standard 20. The Home icon map decides the
  // picture (the Customize Home Tab palette shows the same one).
  const size = band ? HERO_ICON_SIZE : ICON_SIZE_SM;
  const icon = homeTabIcon(item.id, size) ?? <RibbonIcon.CellStyles size={size} />;

  return (
    <div ref={setAnchor} style={{ display: "flex" }}>
      <CommandButton
        ref={buttonRef}
        icon={icon}
        label={label}
        chevron
        labelLines={2}
        tooltip={tip.tooltip}
        shortcut={tip.shortcut}
        commandId={tip.commandId}
        data-testid={`fmt-${item.id}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onKeyDown={handleKeyDown}
        onClick={(e) => {
          // detail 0: Enter, Space or assistive technology pressed it.
          setFocusOnOpen(e.detail === 0);
          setOpen((was) => !was);
        }}
      />
      {/* Named for assistive technology: a role="dialog" with no name is
          announced as just "dialog". Its neighbours' cards are named by their
          registered item's label the same way. */}
      <Popover anchorEl={anchor} open={open} onClose={dismiss} ariaLabel={label}>
        <div ref={bodyRef} id={bodyId}>
          <CellStylesGallery onApplyStyle={apply} onClose={close} />
        </div>
      </Popover>
    </div>
  );
}
