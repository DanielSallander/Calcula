// FILENAME: app/extensions/ModelEditor/components/theme.ts
// PURPOSE: The Model Editor's design tokens — colour, density, type, radius,
//          elevation, motion — in ONE place, resolved from the app's skin.
// CONTEXT: This window was styled with 856 inline style objects and 362
//          hardcoded hex literals against 18 var() usages, spread across three
//          independent palettes. That is the mechanism behind "it doesn't feel
//          smooth": nothing shared a spacing rhythm, a radius, or a grey.
//
//          WHY A `--me-*` LAYER AND NOT THE APP TOKENS DIRECTLY. The app's
//          ~130 semantic tokens are Excel-chrome shaped: grid, formula bar,
//          name box, sheet tabs, dialog, menu bar. There is no workbench
//          vocabulary in there — no tree row, no rail, no sunken panel, no
//          dock. So this file is the ADAPTER: every value is
//          `var(<a real app token>, <literal fallback>)`, which means the
//          window follows the user's skin (including Dark) while still
//          rendering correctly if a token is ever missing.
//          `__tests__/themeTokenContract.test.ts` asserts every `--` name
//          referenced below actually exists in THEME_TOKENS, because a typo
//          here is invisible: it silently takes the fallback and only shows up
//          in Dark.
//
//          WHY NOT @api/layout. Its primitives read a SurfaceLayoutContext
//          supplied by Shell renderers this window does not have, and its
//          heights (FIELD_HEIGHT 24, CONTROL_HEIGHT_MD 26) are RIBBON BAND
//          sizes. Adopting them would have made this surface tighter, not
//          smoother. We share the skin tokens instead, so the two surfaces
//          stay recognisably one product without sharing components.

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

export const ME = {
  /** Page ground: the rail, the dock, the area behind cards. */
  canvas: "var(--canvas-bg, #fafafb)",
  /** Raised content: cards, the detail pane, the inspector. */
  surface: "var(--bg-surface, #ffffff)",
  /** Recessed content: master lists, table headers, inputs at rest. */
  sunken: "var(--panel-bg, #f4f5f7)",
  /** Modals, popovers, the command palette. */
  overlay: "var(--dialog-bg, #ffffff)",
  scrim: "var(--dialog-overlay-bg, rgba(0, 0, 0, 0.32))",

  border: "var(--border-default, #e4e7ec)",
  /** Hairlines between scroll regions. The ONLY border that survives the
   *  border-to-whitespace pass. */
  borderSubtle: "color-mix(in srgb, var(--border-default, #e4e7ec) 55%, transparent)",

  text: "var(--text-primary, #101828)",
  text2: "var(--text-secondary, #475467)",
  text3: "var(--text-tertiary, #667085)",
  textOff: "var(--text-disabled, #98a2b3)",

  accent: "var(--accent-color, #2f6fce)",
  accentSoft: "color-mix(in srgb, var(--accent-color, #2f6fce) 10%, transparent)",
  /** Focus ring colour. There is no focus ring anywhere in this window today. */
  focus: "color-mix(in srgb, var(--accent-color, #2f6fce) 45%, transparent)",
  /** Selected row/item fill. Deliberately NOT --grid-selection-bg: that token
   *  is the SPREADSHEET's selection, which is Excel-green, and borrowing it
   *  painted every selected table in this window green for no reason anyone
   *  could have explained. A selection here is an accent wash. */
  select: "color-mix(in srgb, var(--accent-color, #2f6fce) 14%, transparent)",

  ctlBg: "var(--dialog-input-bg, #ffffff)",
  ctlBorder: "var(--dialog-input-border, #d0d5dd)",
  ctlBorderFocus: "var(--dialog-input-border-focus, #2f6fce)",
  btnBg: "var(--button-bg, #ffffff)",
  btnHover: "var(--button-hover-bg, #f2f4f7)",
  /**
   * DERIVED, not borrowed. A wash of the text colour over whatever is beneath:
   * a faint grey on a white card, a faint lift on a charcoal one, correct by
   * construction in any skin.
   *
   * THE RULE THIS ENCODES: a token's name says WHERE it is used, not what it
   * MEANS, so borrowing one across surfaces is a coin flip. This layer got it
   * wrong twice in a row — `--grid-selection-bg` painted every selected table
   * Excel-GREEN because it is the spreadsheet's selection, and
   * `--menu-item-hover-bg` is `#094771` in BOTH baselines (the dark
   * menu-dropdown hover, white text on navy), which put a dark navy band with
   * dark text under the cursor on a white grid. When no token means the thing
   * you need, derive it from one that does.
   */
  rowHover: "color-mix(in srgb, var(--text-primary, #101828) 6%, transparent)",

  // Status tones. Added to the app's own token set in this same change,
  // because it had --text-error and nothing else semantic — which is why a
  // validation ERROR rendered in warning yellow.
  dangerFg: "var(--tone-danger-fg, #b42318)",
  dangerBg: "var(--tone-danger-bg, #fef3f2)",
  warnFg: "var(--tone-warn-fg, #b54708)",
  warnBg: "var(--tone-warn-bg, #fffaeb)",
  okFg: "var(--tone-ok-fg, #067647)",
  okBg: "var(--tone-ok-bg, #ecfdf3)",
  infoFg: "var(--tone-info-fg, #175cd3)",
  infoBg: "var(--tone-info-bg, #eff8ff)",

  // The BORDER of a toned banner: the tone's own foreground, thinned.
  //
  // These are new because they were missing, and what filled the gap was seven
  // hardcoded ambers and greens across six files (#e2b04a, #ecdfa8, #f0d98c,
  // #b7d9bc) that the hex ban could not see — its selector was anchored, so
  // "1px solid #e2b04a" was not a hex literal as far as it was concerned.
  // DERIVED rather than picked, for the reason `select` and `rowHover` are: a
  // hand-picked amber is a fourth opinion about what "warning" looks like, and
  // it does not follow the skin.
  dangerBorder: "color-mix(in srgb, var(--tone-danger-fg, #b42318) 35%, transparent)",
  warnBorder: "color-mix(in srgb, var(--tone-warn-fg, #b54708) 35%, transparent)",
  okBorder: "color-mix(in srgb, var(--tone-ok-fg, #067647) 35%, transparent)",
  infoBorder: "color-mix(in srgb, var(--tone-info-fg, #175cd3) 35%, transparent)",

  /**
   * Text and icons ON a filled accent or danger ground (a primary button, a
   * selected toggle, the recording pill). Deliberately a LITERAL and
   * deliberately named: the filled ground stays saturated in both themes, so
   * this must NOT become a surface token — that is precisely how "white text
   * on blue" turns into "charcoal text on blue" the moment the skin flips.
   * Having a name means the lint rule can forbid bare `#fff` without forbidding
   * the one case where white is correct.
   */
  onAccent: "#ffffff",

  /**
   * CATEGORICAL hues. These identify a KIND, not a surface, so they stay fixed
   * across themes the way a chart series does. Both are mid-tone and clear the
   * 4.5:1 bar on the light and dark surfaces alike. They live here rather than
   * inline so there is one definition to change.
   */
  calculatedHue: "#8a5cf6",
  /** The macro-recording pill: an always-loud alert, like a record light. */
  recordingBg: "#c0392b",

  font: 'var(--font-family-sans, "Segoe UI", system-ui, sans-serif)',
  mono: 'var(--font-family-cell, "Cascadia Code", Consolas, monospace)',
} as const;

// ---------------------------------------------------------------------------
// Density
// ---------------------------------------------------------------------------
// One full step looser than before and STOP. 28px controls, not 32: a 32px
// control costs ~120px of vertical on the busiest screen and this window opens
// at 780px tall. 28 reads as a modern data tool and stays within one step of
// the ribbon's 24-26, so the two surfaces still look like one product.

export const SIZE = {
  /** Buttons, selects, inputs. Was 22-24. */
  control: 28,
  /** Table body rows. Was ~22. */
  row: 32,
  /** Rail items. Was ~24. */
  railRow: 30,
  /** Tree rows are tighter than table rows — depth needs the density. */
  treeRow: 26,
  topBar: 44,
  statusStrip: 24,
  dockTabs: 30,
  railWidth: 190,
  masterWidth: 260,
} as const;

/** Strict 4/8 grid. Nothing outside this set. */
export const SPACE = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const PAD = {
  /** Inputs and selects. Was "4px 6px". */
  control: "6px 10px",
  /** Buttons. Was "4px 12px". */
  button: "6px 12px",
  /** Table cells. Was "4px 8px". */
  cell: "7px 10px",
  /** Cards. Was 12. */
  card: 16,
} as const;

export const RADIUS = {
  /** Controls and cards. Was 3. */
  control: 6,
  /** Panels, popovers, modals. */
  panel: 8,
  /** Pills and chips. */
  pill: 999,
} as const;

// ---------------------------------------------------------------------------
// Type
// ---------------------------------------------------------------------------

export const FONT = {
  /** Body. */
  base: 13,
  /** Secondary text and meta. */
  sm: 12,
  /** Badges, the status strip, group headings. */
  xs: 11,
  sectionTitle: 15,
  pageTitle: 18,
} as const;

export const LINE = {
  base: 1.5,
  code: 1.55,
  tight: 1.3,
} as const;

/** Counts and numeric cells, so a changing number does not reflow or shimmer. */
export const TABULAR = { fontVariantNumeric: "tabular-nums" } as const;

// ---------------------------------------------------------------------------
// Elevation — three levels, no fourth
// ---------------------------------------------------------------------------
// Cards trade their 1px border for the first level. A hairline survives only
// where two independent SCROLL REGIONS meet (rail/main, master/detail,
// body/dock), because there the line is telling you something real.

export const SHADOW = {
  card: "0 1px 2px rgba(16, 24, 40, 0.06), 0 1px 3px rgba(16, 24, 40, 0.10)",
  popover: "0 8px 24px rgba(16, 24, 40, 0.12)",
  modal: "0 16px 48px rgba(16, 24, 40, 0.18)",
  /** A column pinned to the trailing edge, casting LEFTWARD over the cells
   *  sliding beneath it (Strategy's `reviewed`). Not one of the three
   *  elevations — it is directional, and its job is to say "this column is
   *  floating, the ones under it are moving" rather than to raise a surface. */
  stickyLeft: "-6px 0 6px -6px rgba(16, 24, 40, 0.25)",
} as const;

// ---------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------
// Tree expand is deliberately 0ms: instant reads as faster than correct.

export const MOTION = {
  hover: "120ms ease-out",
  panel: "160ms cubic-bezier(0.2, 0, 0, 1)",
  overlay: "200ms cubic-bezier(0.2, 0, 0, 1)",
  none: "0ms",
} as const;

/** The one focus ring in the window. Applied via `:focus-visible` in the
 *  stylesheet below so it never fires on a mouse click. */
export const FOCUS_RING = `0 0 0 2px ${ME.focus}`;

// ---------------------------------------------------------------------------
// The stylesheet
// ---------------------------------------------------------------------------
// Inline styles cannot express :hover, :focus-visible, ::placeholder or
// scrollbars, and this window is styled almost entirely with inline styles —
// which is precisely why it has no hover feedback and no focus ring anywhere.
// One small stylesheet, injected once, covers what inline styles structurally
// cannot.

const STYLE_ELEMENT_ID = "calcula-model-editor-base";

// ONE definition, in _shared, because both command panels need it too.
export { surfaceIsDark } from "../../_shared/lib/surfaceTheme";
import { surfaceIsDark as isDark } from "../../_shared/lib/surfaceTheme";

/**
 * Native controls — checkboxes, radios, `<select>` popups, spinners, the
 * scrollbar gutter — are painted by the BROWSER, not by CSS, and they follow
 * `color-scheme` alone. Without this a dark Model Editor still renders a stark
 * white checkbox and a white dropdown list, which is the single most obvious
 * "half-themed" tell.
 */
export function syncColorScheme(): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.colorScheme = isDark() ? "dark" : "light";
}

export const MODEL_EDITOR_CSS = `
/* Tint the browser-painted parts of native controls (the check, the radio dot,
   the range track) with the app accent. color-scheme, set by syncColorScheme,
   handles their light/dark base. */
input[type="checkbox"], input[type="radio"], input[type="range"], progress {
  accent-color: ${ME.accent};
}
body {
  margin: 0;
  background: ${ME.canvas};
  color: ${ME.text};
  font-family: ${ME.font};
  font-size: ${FONT.base}px;
  line-height: ${LINE.base};
  -webkit-font-smoothing: antialiased;
}
*, *::before, *::after { box-sizing: border-box; }

/* No focus ring existed anywhere in this window. :focus-visible so it appears
   for keyboard users and never on a mouse press. */
:focus-visible {
  outline: none;
  box-shadow: ${FOCUS_RING};
  border-radius: ${RADIUS.control}px;
}

button:not(:disabled), [role="tab"]:not([aria-disabled="true"]) { transition: background ${MOTION.hover}, border-color ${MOTION.hover}; }
button:not(:disabled):hover { background: ${ME.btnHover}; }
button:disabled { opacity: 0.55; cursor: default; }

input::placeholder, textarea::placeholder { color: ${ME.textOff}; }
input:focus, select:focus, textarea:focus { border-color: ${ME.ctlBorderFocus}; }

/* Rows separate by spacing and a hover tint rather than a rule per row. */
[data-me-row]:hover { background: ${ME.rowHover}; }

::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background: var(--scrollbar-thumb-bg-default, #c9ced6);
  border-radius: ${RADIUS.pill}px;
  border: 2px solid transparent;
  background-clip: content-box;
}
::-webkit-scrollbar-thumb:hover { background: var(--scrollbar-thumb-bg-hover, #aab1bb); background-clip: content-box; }

/* Strategy measure-column groups.
   Eleven columns cannot fit a 1150px window, and sideways scrolling in a grid
   you work DOWN is the worst of both directions. Driven by nth-child against
   the table's data-cols rather than by making eleven hand-written <td>s
   conditional — the header is a map and the body is eleven literals, so a JSX
   split would be eleven chances for the two to disagree about which column is
   which. Columns 1 (measure) and 11 (reviewed) are never hidden.
   Keep in step with MEASURE_GROUP_COLUMNS in StrategySection.tsx; a test
   asserts the two agree. */
table[data-cols="meaning"] :is(th, td):nth-child(3),
table[data-cols="meaning"] :is(th, td):nth-child(6),
table[data-cols="meaning"] :is(th, td):nth-child(7),
table[data-cols="meaning"] :is(th, td):nth-child(9),
table[data-cols="meaning"] :is(th, td):nth-child(10) { display: none; }

table[data-cols="aggregation"] :is(th, td):nth-child(2),
table[data-cols="aggregation"] :is(th, td):nth-child(4),
table[data-cols="aggregation"] :is(th, td):nth-child(5),
table[data-cols="aggregation"] :is(th, td):nth-child(8),
table[data-cols="aggregation"] :is(th, td):nth-child(9),
table[data-cols="aggregation"] :is(th, td):nth-child(10) { display: none; }

table[data-cols="slicing"] :is(th, td):nth-child(2),
table[data-cols="slicing"] :is(th, td):nth-child(3),
table[data-cols="slicing"] :is(th, td):nth-child(4),
table[data-cols="slicing"] :is(th, td):nth-child(5),
table[data-cols="slicing"] :is(th, td):nth-child(6),
table[data-cols="slicing"] :is(th, td):nth-child(7),
table[data-cols="slicing"] :is(th, td):nth-child(8) { display: none; }

/* A row spanning every column (the empty state) must not be chopped up by the
   rules above — it has one cell, not eleven. */
table[data-cols] :is(th, td)[colspan] { display: table-cell !important; }

/* THERE IS DELIBERATELY NO EXEMPTION FOR THE FOLDER HEADER ROWS.
   A folder row carries the same eleven cells as every other row (nine of them
   empty), precisely so the rules above apply to it identically and its pinned
   trailing cell lands ON the reviewed column rather than beside it. An earlier
   version gave the folder a spanning cell plus a pinned one and exempted the
   pair from these rules; a colspan is counted in DECLARED columns while these
   rules remove cells from the column structure entirely, so the folder row
   asked for eleven slots while the body occupied six — measured at 24px, 44px
   and 45px of misalignment in three of the four groups, and correct only in
   All columns. If you are tempted to add an exemption here, the row shape is
   the thing to fix instead.
   (NO BACKTICKS IN HERE. This whole stylesheet is a template literal, so a
   backtick in a comment ends the string and the next words become code — the
   first draft of this very comment did exactly that.) */

@keyframes me-palette-in {
  from { opacity: 0; transform: scale(0.98); }
  to   { opacity: 1; transform: scale(1); }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; }
}
`;

/** Idempotent: safe to call from every entry point and on every hot reload. */
export function installModelEditorStyles(): void {
  if (typeof document === "undefined") return;
  let el = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ELEMENT_ID;
    document.head.appendChild(el);
  }
  if (el.textContent !== MODEL_EDITOR_CSS) el.textContent = MODEL_EDITOR_CSS;

  syncColorScheme();
  // The skin loader rewrites the contents of ONE persistent <style> element, so
  // watching it catches every skin change without importing Core (which an
  // extension may not do) or inventing an event for it.
  if (typeof MutationObserver !== "undefined") {
    const skinEl = document.getElementById("calcula-skin-vars");
    if (skinEl && !skinEl.hasAttribute("data-me-observed")) {
      skinEl.setAttribute("data-me-observed", "1");
      new MutationObserver(syncColorScheme).observe(skinEl, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }
  }
}
