//! FILENAME: app/src/api/layout/primitives/disabled.ts
// PURPOSE: THE disabled idiom of the Calcula Clusters control grammar, written
//          once. Every @api/layout primitive that can be disabled (Button and
//          everything built on its recipe, Chip, ColorSwatch, Dropdown, the
//          field chrome, list rows, SplitMenuButton, Select, Slider, Checkbox
//          and Switch) interpolates DISABLED_LOOK into the rule that matches
//          its own disabled state, so the look cannot drift between them.
// CONTEXT: Until 2026-10-02 the idiom was `opacity: .5; cursor: default`,
//          hand-copied into ten rules. The owner found a disabled Redo beside
//          an enabled Undo "only slightly lighter", and the measurement agreed:
//          opacity alone leaves the duotone ACCENT green (Light #036448 paints
//          #7aab9e at .5, Dark #34d399 paints #2f7f63), and green beside green
//          reads as the same state. Two changes, measured in Chromium against
//          the real icon drawings in all six skins:
//
//          - The ICONS lose their colour: `filter: grayscale(1)` on every svg
//            and img inside the disabled control. A disabled icon is then grey
//            in every skin (largest channel spread 3, against 49-80 for the
//            green it replaces), which is what Excel does too.
//          - The whole control fades to DISABLED_OPACITY (.4, was .5). The
//            enabled-to-disabled separation of the Undo head goes from 2.79 to
//            3.32 in Light and 2.52 to 3.31 in Dark. .4 is set by the LABEL,
//            not the icon: a disabled 12px label must stay legible, and it
//            measures 2.53:1 on the Light cluster (2.51 Soft, 2.55 Contrast,
//            2.98 Dark), above Excel's ~2.3 for disabled text. .35 drops it to
//            2.2 and .3 to 2.0, which also turns the soft-only drawings (Undo,
//            Redo, Find) into ghosts.
//
//          Why the filter is on the icons and not on the whole control. A
//          filter on an ancestor cannot be undone by a descendant, and a
//          disabled control still carries colour that is not decoration:
//          ColorSwatch's colour bar is DATA (the colour that WOULD be applied,
//          a <span> with a background: it fades with the control but keeps its
//          hue), a pressed toggle keeps its pressed fill on purpose (Excel shows
//          Merge & Center pressed but disabled on a protected sheet), a checked
//          Checkbox keeps its fill. A whole-element filter would also turn the
//          focus ring of an aria-disabled (still focusable) SplitMenuButton half
//          grey, and would make the control the containing block of any
//          position:fixed child.
//
//          The same reason exempts an svg or img marked `data-colour-data`,
//          the marker this codebase already puts on colour that is data (the
//          ColorSwatch bar and chip, PaletteStrip bars, ThemeGallery dots). No
//          such svg exists today, but a Dropdown option's `icon` or `preview`
//          may be a colour sample, and a disabled trigger shows the selected
//          option's icon: a sample drawn as an svg carries the marker.
//
//          Only a class rule can grey the icons: an inline style cannot reach
//          descendants. An inline-styled control can fade (DISABLED_OPACITY),
//          which is enough only when its icons are already monochrome
//          (currentColor); a duotone RibbonIcon would keep its green accent,
//          which is the defect this file exists to fix.
//
//          Opacity multiplies, so a disabled element must not sit inside
//          another disabled element that dims too: Chip's halves and Select's
//          inner <select> deliberately leave the dimming to their wrapper.
//          grayscale(1) applied twice is idempotent, so the icon rule needs no
//          such care.
//
//          A TypeScript constant rather than a skin token: no skin tunes it,
//          and the value is read by tests through getComputedStyle, which in
//          jsdom returns a var() string verbatim rather than resolving it.
//
//          Colours: none. This file must never carry a colour literal; the
//          layout tests scan what the primitives render.

/** How far a disabled control fades (the whole control: chrome, label, icon). */
export const DISABLED_OPACITY = 0.4;

/**
 * The disabled look, as declarations for the rule that matches a primitive's
 * own disabled state (`:disabled`, `[aria-disabled="true"]` or
 * `[data-disabled="true"]`, whichever that primitive uses):
 *
 * ```ts
 * const control = css`
 *   &:disabled {
 *     ${DISABLED_LOOK}
 *   }
 * `;
 * ```
 *
 * The control fades to DISABLED_OPACITY with a default cursor, and every svg
 * or img inside it is drawn without colour, except one marked
 * `data-colour-data` (a colour sample is data, not decoration). An extension
 * that hand-rolls a disabled control (rather than composing one from
 * @api/layout) interpolates the same string, so its disabled icons match the
 * ribbon's.
 */
export const DISABLED_LOOK = `
  opacity: ${DISABLED_OPACITY};
  cursor: default;

  & svg:not([data-colour-data]),
  & img:not([data-colour-data]) {
    filter: grayscale(1);
  }
`;
