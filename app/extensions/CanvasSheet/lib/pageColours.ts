//! FILENAME: app/extensions/CanvasSheet/lib/pageColours.ts
// PURPOSE: What the Page group's two colour SPLIT buttons (Page Background,
//          Wallpaper) apply from their face: the colour picked LAST from that
//          button this session, else the page's own, else a first colour.
// CONTEXT: Excel's Fill Color rule: a split colour button's face applies the
//          colour on its bar, and the bar shows the last colour applied from
//          it -- per button, for the session. These colours are DATA the user
//          applies to the page (the layout's `background` / `wallpaper`), not
//          styling, which is why they live in a data module and not in the
//          component that paints with the skin's tokens.

/** The layout fields the two splits write. */
export type PageColourField = "background" | "wallpaper";

/**
 * What a split applies before anything was picked from it and when the page
 * has no colour of its own: Power BI's white page, and its light grey
 * wallpaper.
 */
export const FIRST_FACE_COLOUR: Readonly<Record<PageColourField, string>> = {
  background: "#FFFFFF",
  wallpaper: "#EAEAEA",
};

const lastPicked = new Map<PageColourField, string>();

/** The colour picked last from `field`'s split this session, or null. */
export function lastPickedPageColour(field: PageColourField): string | null {
  return lastPicked.get(field) ?? null;
}

/** Remember a pick from `field`'s split. */
export function rememberPageColour(field: PageColourField, hex: string): void {
  lastPicked.set(field, hex);
}

/** The face colour: the session's last pick, else the page's own, else the first. Pure over its inputs. */
export function pageColourFace(field: PageColourField, picked: string | null, pageColour: string): string {
  return picked ?? (pageColour || FIRST_FACE_COLOUR[field]);
}

/** Test hook: forget the session's picks. */
export function resetPageColourMemory(): void {
  lastPicked.clear();
}
