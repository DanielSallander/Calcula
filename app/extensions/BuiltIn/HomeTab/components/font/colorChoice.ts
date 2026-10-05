//! FILENAME: app/extensions/BuiltIn/HomeTab/components/font/colorChoice.ts
// PURPOSE: What Excel's Fill Color and Font Color split buttons (CONTRACT 3.5)
//          remember and write: the LAST colour applied from each button this
//          session, its defaults, and the formatting a choice sends.
// CONTEXT: The data and rules behind ColorSplitButton.tsx, kept out of the
//          component file so that file exports only the component.
//
//          EXCEL'S BAR IS A MEMORY, NOT A READING. The colour under the "A" and
//          the paint bucket is the colour the FACE will apply -- the one last
//          picked from that button (a fresh Excel: yellow fill, red font) --
//          and never the active cell's colour, which is what Calcula's old
//          one-button swatch showed (so a click on it could only open the
//          palette). Each button remembers its own colour, for the session,
//          shared by every copy of the button (sessionStore.ts).
//
//          A THEME PICK STAYS A THEME COLOUR. The old swatch flattened a theme
//          pick to its hex (survey font.md section 4), so a ribbon fill never
//          followed a later theme change. Here a theme pick is remembered as
//          its slot + tint and sent as `bgColorTheme`/`textColorTheme` + tint
//          (FormattingOptions), with the resolved hex beside it as the
//          fallback the backend uses only when it does not know the slot
//          (styles.rs applies the absolute colour first, the theme slot after,
//          so a known slot always wins).
//
//          "No Fill" removes the fill (`fill: { type: "none" }`); Font Color's
//          "Automatic" writes the default text colour, theme dark 1 with no
//          tint (theme.rs; survey font.md section 4). Both are remembered like
//          any colour: the face then applies them again.

import type { HomeTabState } from "../homeItemProps";
import { applyFontFormat } from "./fontCommand";
import { AUTOMATIC_INK, OFFICE_FILL_DEFAULT, OFFICE_FONT_DEFAULT } from "./kitColors";
import { createSessionValue, type SessionValue } from "./sessionStore";

/** The two catalog items this covers. */
export type ColorItemId = "backgroundColor" | "textColor";

/** A colour as the button remembers it. `automatic` is "No Fill" for the fill
 *  and "Automatic" for the font. */
export type ColorChoice =
  | { kind: "hex"; hex: string }
  | { kind: "theme"; slot: string; tint: number; hex: string }
  | { kind: "automatic" };

/** A fresh Excel's bars: yellow fill, red font. */
export const COLOR_DEFAULTS: Readonly<Record<ColorItemId, ColorChoice>> = Object.freeze({
  backgroundColor: Object.freeze({ kind: "hex", hex: OFFICE_FILL_DEFAULT }) as ColorChoice,
  textColor: Object.freeze({ kind: "hex", hex: OFFICE_FONT_DEFAULT }) as ColorChoice,
});

/** What each button calls its writes (a refusal, the undo step). */
export const COLOR_ACTION: Readonly<Record<ColorItemId, string>> = {
  backgroundColor: "Fill Color",
  textColor: "Font Color",
};

/** Fill's extra row: Format Cells on its Fill tab, through the FORMAT_CELLS
 *  command -- the ONE door to the dialog, which refuses while something else
 *  owns the selection (the review of BUG-0185 found the old row skipping it). */
export const MORE_FILL_OPTIONS = { label: "More Fill Options...", slug: "more" } as const;

/** The default text colour Font Color's Automatic writes. */
export const AUTOMATIC_TEXT_THEME = { slot: "dark1", tint: 0 } as const;

/** The ink a Font Color bar shows for Automatic (the default text colour). */
export const AUTOMATIC_TEXT_INK: string = AUTOMATIC_INK;

const STORES: Record<ColorItemId, SessionValue<ColorChoice>> = {
  backgroundColor: createSessionValue<ColorChoice>(COLOR_DEFAULTS.backgroundColor),
  textColor: createSessionValue<ColorChoice>(COLOR_DEFAULTS.textColor),
};

/** Whether an item id is one of the two colour buttons. */
export function isColorItemId(id: string): id is ColorItemId {
  return id === "backgroundColor" || id === "textColor";
}

/** The remembered colour of one button. */
export function colorChoiceStore(itemId: ColorItemId): SessionValue<ColorChoice> {
  return STORES[itemId];
}

/** Tests: both buttons back to Excel's defaults. */
export function resetColorChoices(): void {
  STORES.backgroundColor.reset();
  STORES.textColor.reset();
}

/** The formatting a choice writes for one button. */
export function colorFormatting(itemId: ColorItemId, choice: ColorChoice): Record<string, unknown> {
  if (itemId === "backgroundColor") {
    switch (choice.kind) {
      case "hex":
        return { backgroundColor: choice.hex };
      case "theme":
        return { backgroundColor: choice.hex, bgColorTheme: choice.slot, bgColorTint: choice.tint };
      case "automatic":
        return { fill: { type: "none" } };
    }
  }
  switch (choice.kind) {
    case "hex":
      return { textColor: choice.hex };
    case "theme":
      return { textColor: choice.hex, textColorTheme: choice.slot, textColorTint: choice.tint };
    case "automatic":
      return { textColorTheme: AUTOMATIC_TEXT_THEME.slot, textColorTint: AUTOMATIC_TEXT_THEME.tint };
  }
}

/** What the bar paints for a choice: the colour, the automatic ink for
 *  Automatic, and nothing (an empty outline) for No Fill. */
export function barColor(itemId: ColorItemId, choice: ColorChoice): string | null {
  if (choice.kind === "automatic") return itemId === "textColor" ? AUTOMATIC_TEXT_INK : null;
  return choice.hex;
}

/** The face: apply the remembered colour. */
export async function applyRememberedColor(state: HomeTabState, itemId: ColorItemId): Promise<void> {
  await applyFontFormat(state, colorFormatting(itemId, STORES[itemId].get()), COLOR_ACTION[itemId]);
}

/** A palette pick: remember it (it becomes the bar and the face), then apply. */
export async function chooseColor(state: HomeTabState, itemId: ColorItemId, choice: ColorChoice): Promise<void> {
  STORES[itemId].set(choice);
  await applyFontFormat(state, colorFormatting(itemId, choice), COLOR_ACTION[itemId]);
}
