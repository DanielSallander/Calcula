//! FILENAME: app/src/api/themeGallery.ts
// PURPOSE: The THEME GALLERY seam: the document theme gallery, registered by
//          its owner, so a ribbon tab other than Page Layout -- the Canvas
//          tab's Page group (Canvas contract §1 #5, §4.5) -- can host the SAME
//          gallery without importing the Document Theme extension.
// CONTEXT: A provider registry (the controlsService / pictureControlService
//          pattern): the Document Theme extension registers ONE gallery -- a
//          heading, a width and the body (`render(onClose)`, the very theme
//          rows the Page Layout hero opens, test ids included) -- and a host
//          draws it in a card of its own:
//
//            const gallery = useThemeGallery();
//            ... <Popover card heading={gallery.heading} width={gallery.width}>
//                  {gallery.render(close)}
//                </Popover>
//
//          A copied gallery would be a second source of truth that drifts on
//          the owner's first change (a new built-in theme, a changed preview),
//          and an import of the owner is the Facade Rule's one forbidden move.
//          While nothing is registered (Document Theme is not running) a host
//          greys its trigger and says why.
//
//          WHY NOT A MENU-BAR ITEM. Until 2026-10-08 this seam WAS a Format >
//          Themes menu-bar item hosted through RegisteredMenuButton (the
//          Conditional Formatting precedent). A registered menu item cannot be
//          hidden from the menu bar -- the kit draws a hidden item as disabled
//          -- so the seam could not exist without adding a Format > Themes
//          entry Excel does not have: the product changed as a side effect of
//          a plumbing choice (review finding). This registry has no menu-bar
//          presence at all.
//
//          Feature-neutral: nothing here imports an extension. Not on
//          @api/index.ts; import it as "@api/themeGallery".

import type React from "react";
import { useSyncExternalStore } from "react";

/** The registered theme gallery: what a host draws in its card. */
export interface ThemeGalleryProvider {
  /** The card's heading ("Built-in Themes"). */
  heading?: string;
  /** The card's width in px (the content sizes it otherwise). */
  width?: number;
  /**
   * The gallery's body. `onClose` is called after a pick has been applied; the
   * host closes its card and gives focus back to its trigger.
   */
  render(onClose: () => void): React.ReactNode;
}

let registered: ThemeGalleryProvider | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (err) {
      console.error("[themeGallery] a listener threw:", err);
    }
  }
}

/**
 * Register THE theme gallery (last registration wins). Returns the release,
 * which only removes THIS registration: a stale release after a newer one
 * removes nothing.
 */
export function registerThemeGallery(provider: ThemeGalleryProvider): () => void {
  registered = provider;
  notify();
  return () => {
    if (registered !== provider) return;
    registered = null;
    notify();
  };
}

/** The registered theme gallery, or null while nothing is registered. */
export function getThemeGallery(): ThemeGalleryProvider | null {
  return registered;
}

/** Be told whenever the registration changes. Returns the unsubscribe. */
export function subscribeThemeGallery(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The registered theme gallery, re-rendering the caller whenever it changes. */
export function useThemeGallery(): ThemeGalleryProvider | null {
  return useSyncExternalStore(subscribeThemeGallery, getThemeGallery, getThemeGallery);
}
