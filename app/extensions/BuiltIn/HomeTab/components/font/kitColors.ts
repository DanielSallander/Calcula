//! FILENAME: app/extensions/BuiltIn/HomeTab/components/font/kitColors.ts
// PURPOSE: The Office colours the Font group needs as DATA -- Excel's default
//          Fill (yellow) and Font (red) bars, and the black of an Automatic
//          line or text -- taken from the kit's colour table instead of being
//          spelled as literals here.
// CONTEXT: The Home tab is redesigned chrome: the hard-coded-colour lint
//          (app/eslint.boundaries.js, chromeColorConfigs) refuses a colour
//          literal under extensions/BuiltIn/HomeTab -- a hex string AND a bare
//          colour word such as "red" -- because chrome must follow the user's
//          skin. These are not chrome: they are the colours Excel WRITES into
//          cells, and the rule's own advice is that colour data lives in a
//          data module. @api/layout's colours.ts is that module (the Office
//          Standard Colors row the palette shows, and the quick set), so the
//          values are read from it by POSITION in Excel's fixed order: one
//          copy of the Office values, the same table the user picks from.
//          underline/borders/colour tests pin the resulting hex, so a
//          reordered table fails a test rather than silently changing a
//          default.

import { QUICK_COLORS, STANDARD_COLORS } from "@api/layout";

/** Excel's Standard Colors row, in Excel's order: Dark Red, Red, Orange,
 *  Yellow, Light Green, Green, Light Blue, Blue, Dark Blue, Purple. */
const STANDARD_RED_INDEX = 1;
const STANDARD_YELLOW_INDEX = 3;

/** The quick set's grey ramp starts at black. */
const QUICK_BLACK_INDEX = 0;

/** Excel's default Fill Color bar: the standard yellow. */
export const OFFICE_FILL_DEFAULT: string = STANDARD_COLORS[STANDARD_YELLOW_INDEX];

/** Excel's default Font Color bar: the standard red. */
export const OFFICE_FONT_DEFAULT: string = STANDARD_COLORS[STANDARD_RED_INDEX];

/** The ink of "Automatic" (a border line, the text colour): black. */
export const AUTOMATIC_INK: string = QUICK_COLORS[QUICK_BLACK_INDEX];
