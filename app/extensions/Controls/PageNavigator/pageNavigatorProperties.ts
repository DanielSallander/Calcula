//! FILENAME: app/extensions/Controls/PageNavigator/pageNavigatorProperties.ts
// PURPOSE: The Properties-pane rows of a Page Navigator (WP-B, D-NAV).
// CONTEXT: Its own file, and `PAGE_NAVIGATOR_PROPERTIES` its LAST export, on
//          purpose: two census tests read this SOURCE text --
//            - app/src/api/scriptHost/__tests__/mediaHandles.test.ts slices from
//              the array's name to the END of the file and collects every
//              four-space-indented `key: "..."` row, then asserts the script
//              gate (validators.ts SCRIPT_SHAPE_PROPERTY_KEYS) admits each one;
//            - app/src-tauri/src/held_button_code_tests.rs asserts every such
//              row is a navigator key or a geometry key, never code.
//          Put after BUTTON_PROPERTIES in lib/types.ts, these keys would be
//          folded silently into the BUTTON census. Keep every `key:` line
//          indented exactly four spaces.
//
//          No default is typed here: each row's `defaultValue` is read from
//          PAGE_NAVIGATOR_DEFAULTS (pageNavigatorRecipe.ts) or the seam's
//          PAGE_NAVIGATOR_DEFAULT_SIZE, so the pane, the recipe and the reader
//          cannot disagree (pageNavigatorRecipe.test.ts).
//
//          The group holding fill / colour / border / font is "Button style",
//          never "Buttons": the pane renders one section per group name, and
//          "Buttons" is the per-page overrides section (`pageOverrides` is
//          deliberately not a row here; it has its own UI).
//
//          Every row is `supportsFormula: true` (WP-D S8d, D §3.18a): each key
//          has a row in the binding catalog, so the pane offers fx on it and a
//          binding (never a formula-typed value) carries the live value. The
//          per-page settings bind per button in PageNavigatorButtonsSection.

import { PAGE_NAVIGATOR_DEFAULT_SIZE, PAGE_NAVIGATOR_ORIENTATIONS } from "@api/buttonControlService";
import type { PropertyDefinition } from "../lib/types";
import { PAGE_NAVIGATOR_DEFAULTS } from "./pageNavigatorRecipe";

/** The words the Orientation menu shows, by stored value. */
const ORIENTATION_LABELS: Readonly<Record<(typeof PAGE_NAVIGATOR_ORIENTATIONS)[number], string>> = {
  horizontal: "Horizontal",
  vertical: "Vertical",
};

/** The Orientation menu, in the seam's order. */
const ORIENTATION_OPTIONS: ReadonlyArray<{ value: string; label: string }> = PAGE_NAVIGATOR_ORIENTATIONS.map(
  (value) => ({ value, label: ORIENTATION_LABELS[value] }),
);

/** All property rows of a Page Navigator, in pane order. KEEP THIS THE LAST EXPORT. */
export const PAGE_NAVIGATOR_PROPERTIES: PropertyDefinition[] = [
  {
    key: "orientation",
    label: "Orientation",
    inputType: "select",
    options: ORIENTATION_OPTIONS,
    defaultValue: PAGE_NAVIGATOR_DEFAULTS.orientation,
    supportsFormula: true,
    group: "Navigator",
  },
  {
    key: "gap",
    label: "Gap",
    inputType: "number",
    defaultValue: PAGE_NAVIGATOR_DEFAULTS.gap,
    supportsFormula: true,
    group: "Navigator",
    min: 0,
    max: 64,
    step: 1,
  },
  {
    key: "padding",
    label: "Padding",
    inputType: "number",
    defaultValue: PAGE_NAVIGATOR_DEFAULTS.padding,
    supportsFormula: true,
    group: "Navigator",
    min: 0,
    max: 64,
    step: 1,
  },
  {
    key: "fill",
    label: "Fill",
    inputType: "color",
    defaultValue: PAGE_NAVIGATOR_DEFAULTS.fill,
    supportsFormula: true,
    group: "Button style",
  },
  {
    key: "color",
    label: "Text colour",
    inputType: "color",
    defaultValue: PAGE_NAVIGATOR_DEFAULTS.color,
    supportsFormula: true,
    group: "Button style",
  },
  {
    key: "borderColor",
    label: "Border colour",
    inputType: "color",
    defaultValue: PAGE_NAVIGATOR_DEFAULTS.borderColor,
    supportsFormula: true,
    group: "Button style",
  },
  {
    key: "fontSize",
    label: "Font size",
    inputType: "number",
    defaultValue: PAGE_NAVIGATOR_DEFAULTS.fontSize,
    supportsFormula: true,
    group: "Button style",
    min: 6,
    max: 72,
    step: 1,
  },
  {
    key: "selectedFill",
    label: "Selected fill",
    inputType: "color",
    defaultValue: PAGE_NAVIGATOR_DEFAULTS.selectedFill,
    supportsFormula: true,
    group: "Selected page",
  },
  {
    key: "selectedColor",
    label: "Selected text colour",
    inputType: "color",
    defaultValue: PAGE_NAVIGATOR_DEFAULTS.selectedColor,
    supportsFormula: true,
    group: "Selected page",
  },
  {
    key: "showHiddenPages",
    label: "Show hidden pages",
    inputType: "boolean",
    defaultValue: PAGE_NAVIGATOR_DEFAULTS.showHiddenPages,
    supportsFormula: true,
    group: "Pages",
  },
  {
    key: "showTooltipPages",
    label: "Show tooltip pages",
    inputType: "boolean",
    defaultValue: PAGE_NAVIGATOR_DEFAULTS.showTooltipPages,
    supportsFormula: true,
    group: "Pages",
  },
  {
    key: "width",
    label: "Width",
    inputType: "number",
    defaultValue: String(PAGE_NAVIGATOR_DEFAULT_SIZE.width),
    supportsFormula: true,
    group: "Size",
    inline: true,
  },
  {
    key: "height",
    label: "Height",
    inputType: "number",
    defaultValue: String(PAGE_NAVIGATOR_DEFAULT_SIZE.height),
    supportsFormula: true,
    group: "Size",
    inline: true,
  },
];
