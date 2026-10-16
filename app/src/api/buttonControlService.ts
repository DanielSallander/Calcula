//! FILENAME: app/src/api/buttonControlService.ts
// PURPOSE: The feature-neutral seam through which any extension can put a real,
//          visible, clickable BUTTON on the grid without knowing that a Controls
//          extension exists.
// CONTEXT: Inversion of Control, the same shape autoFilterService.ts and
//          printService.ts use. The Controls extension OWNS on-grid controls:
//          the backend control metadata, the floating-control store the canvas
//          renders from, the overlay hit-test regions, and the run-mode click
//          dispatch. @api owns nothing about buttons except this one contract.
//
// WHY THIS EXISTS RATHER THAN A DIRECT `set_control_metadata` CALL.
// Writing the backend metadata is only ONE of the three things a button needs.
// The Macro Recorder learned this the hard way: it called set_control_metadata
// with `{ label }` and nothing appeared on the grid, because
//
//   1. the property Controls actually renders a caption from is `text`, not
//      `label` — a "working" write that draws nothing;
//   2. a button also needs `fill` / `color` / `borderColor` / `fontSize` /
//      `embedded` / `pinToGrid` / `x` / `y` / `width` / `height` / `onSelect` /
//      `tooltip`, with geometry derived from the anchor cell's ACTUAL column
//      width and row height; and
//   3. nothing renders until the control is added to the floating-control store
//      and the overlay regions are re-synced.
//
// Copying that property list into every caller is a second source of truth that
// drifts the first time Controls changes a default. `pinToGrid` is the proof: it
// has to be written EXPLICITLY as "false", because the backend defaults an
// absent property to "moves", which silently shifted a floating control's anchor
// on the first row insert. A caller that hand-rolls the list will not know that.
// So the seam hands the whole job to the extension that already does it for a
// user-created button, and callers say only WHAT they want, never HOW.
//
// THE RETURNED `instanceId` IS THE BINDING KEY. It is the id Controls emits on
// the `button:clicked` app event in run mode, and therefore the id an object
// script must carry as `instanceId` for its `button.onClick(...)` to fire. It is
// derived from the anchor (sheet/row/col) inside the extension; callers must
// take it from the handle rather than re-deriving the format, because a caller
// that guesses wrong produces a button and a script that never meet.
//
// FREE POSITIONING (canvas sheets). A request may give an exact `x`/`y` (and
// `width`/`height`) in sheet pixels instead of relying on the anchor cell's
// walked origin and size, and may OMIT the anchor, in which case the PROVIDER
// allocates a free one. It has to be the provider: creating a button REPLACES
// whatever control an occupied anchor holds, so a caller that picked a "free"
// cell itself would race every other insert between its check and the write.
// See `ButtonControlPlacement`.

/**
 * The control property that LINKS a button to a recorded macro by its module id.
 *
 * A button carrying `macroRef` runs the CURRENT macro of that id on each click,
 * resolved through @api/macroRunService — no copied body lives on the button.
 * The name is a shared constant rather than a string literal at each site so the
 * writer (the Macro Recorder), the reader (Controls' click path) and the backend
 * queries (deletion warning, publish guard) can never disagree on the key.
 */
export const MACRO_REF_PROPERTY = "macroRef";

// ============================================================================
// Declarative actions (Canvas contract §3/§4.4, owner decisions 2026-10-08)
// ============================================================================
//
// Power BI's report buttons do not run code: each has ONE "Action" -- Page
// navigation, Back, Clear all slicers, ... -- chosen from a list. Calcula gives
// a button the same three it can honour, as DECLARATIVE PROPERTIES rather than
// as code, for three reasons that are each a rule elsewhere in this codebase:
//
//   1. NOT CODE, SO NOT STRIPPED. Rust's `EXECUTABLE_CONTROL_PROPERTIES`
//      (app/src-tauri/src/controls.rs) is the list a pull STRIPS from a
//      subscriber's buttons, because code from an application must not run on
//      a click without consent. A Back button is not code; listing it there
//      would disarm every navigation button of every published report -- and
//      Power BI's buttons are exactly what a report reader is meant to click.
//      So these keys are deliberately absent from that list: a subscribed
//      canvas keeps them, and its buttons work read-only.
//   2. NOT THROUGH THE SCRIPT DOOR. A click on a button with an action performs
//      it on the page, without `run_control_action` -- a navigation button
//      must work with Script Security off (the door's prompt would otherwise
//      stand between a reader and the next page).
//   3. NOT WRITABLE BY A SCRIPT. An action is the author's decision about
//      where a reader's click goes. The script validator refuses all three keys
//      by THESE spellings (`SCRIPT_REFUSED_BUTTON_ACTION_KEYS`,
//      app/src/api/scriptHost/validators.ts, which imports them from here).
//
// ONE BUTTON, ONE THING. A button with an action has no code (`onSelect` "",
// no `macroRef`): createButton refuses both together, and the Properties pane
// asks before it replaces a button's code with an action. Otherwise which of
// the two a click runs would be a precedence rule nobody can see.
//
// A NAVIGATE TARGET IS NAMED TWICE: by the sheet's stable uuid (`sheetId`,
// survives a rename) and by its name (`sheetName`). The name is the fallback
// the click uses when no sheet here has that id -- which is every subscriber,
// because a pull remaps sheet ids to the subscriber's own while keeping the
// names (core/calp/src/pull.rs).

/** The control property naming a button's declarative action: one of
 *  `BUTTON_ACTION_KINDS`, or "" / absent for "run its code". */
export const BUTTON_ACTION_PROPERTY = "action";

/** A navigate action's target page: the sheet's stable uuid (`SheetInfo.sheetId`). */
export const BUTTON_ACTION_TARGET_PROPERTY = "actionTarget";

/** A navigate action's target page by NAME: the fallback when the uuid is not
 *  known here (a subscriber), and what the Properties pane shows. */
export const BUTTON_ACTION_TARGET_NAME_PROPERTY = "actionTargetName";

/** Every property a declarative action is stored in. The script validator
 *  refuses exactly these; a writer always writes all three (see
 *  `buttonActionProperties`). */
export const BUTTON_ACTION_PROPERTY_KEYS: readonly string[] = [
  BUTTON_ACTION_PROPERTY,
  BUTTON_ACTION_TARGET_PROPERTY,
  BUTTON_ACTION_TARGET_NAME_PROPERTY,
];

/** The actions Calcula honours, in the order a menu lists them. */
export const BUTTON_ACTION_KINDS = ["navigate", "back", "clearSlicers"] as const;

/** One of `BUTTON_ACTION_KINDS`. */
export type ButtonActionKind = (typeof BUTTON_ACTION_KINDS)[number];

/** Power BI's names for the actions, for a menu row or a pane option. */
export const BUTTON_ACTION_LABELS: Readonly<Record<ButtonActionKind, string>> = {
  navigate: "Page navigation",
  back: "Back",
  clearSlicers: "Clear all slicers",
};

/** A button's declarative action. */
export type ButtonAction =
  /** Go to a page (a sheet of this workbook, canvas or worksheet). */
  | { kind: "navigate"; sheetId?: string; sheetName: string }
  /** Go to the page that was active before this one (@api/sheetHistory). */
  | { kind: "back" }
  /** Clear every slicer on the button's own page (@api/slicerClearService). */
  | { kind: "clearSlicers" };

/** A property bag as the backend returns a control's (`ControlMetadata.properties`). */
export type ButtonPropertyBag = Readonly<Record<string, { valueType: string; value: string } | undefined>>;

/**
 * The three action properties for `action` -- ALL three, "" for the unused
 * ones, and all "" for `null` (no action). Writing all three every time is the
 * point: a change from "navigate" to "back" must not leave the old target
 * behind for a later reader to resurrect.
 */
export function buttonActionProperties(action: ButtonAction | null): Record<string, string> {
  return {
    [BUTTON_ACTION_PROPERTY]: action ? action.kind : "",
    [BUTTON_ACTION_TARGET_PROPERTY]: action?.kind === "navigate" ? (action.sheetId ?? "") : "",
    [BUTTON_ACTION_TARGET_NAME_PROPERTY]: action?.kind === "navigate" ? action.sheetName : "",
  };
}

/**
 * The action a button's properties declare, or null for none.
 *
 * Only a STATIC `action` counts: a formula there would let the data decide
 * where a click goes, which no author chose. An unknown kind is no action (a
 * newer build's kind is not guessed at), and so is a navigate with no page.
 */
export function readButtonAction(properties: ButtonPropertyBag | undefined | null): ButtonAction | null {
  const slot = properties?.[BUTTON_ACTION_PROPERTY];
  if (!slot || slot.valueType !== "static") return null;
  const staticValue = (key: string): string => {
    const p = properties?.[key];
    return p && p.valueType === "static" ? p.value.trim() : "";
  };
  switch (slot.value) {
    case "back":
      return { kind: "back" };
    case "clearSlicers":
      return { kind: "clearSlicers" };
    case "navigate": {
      const sheetName = staticValue(BUTTON_ACTION_TARGET_NAME_PROPERTY);
      const sheetId = staticValue(BUTTON_ACTION_TARGET_PROPERTY);
      if (!sheetName) return null;
      return sheetId ? { kind: "navigate", sheetId, sheetName } : { kind: "navigate", sheetName };
    }
    default:
      return null;
  }
}

/**
 * Why a create request's `action` cannot be honoured, or null when it can.
 * The provider THROWS this sentence before writing anything.
 */
export function checkCreateButtonAction(
  request: Pick<CreateButtonControlRequest, "label" | "onSelect" | "macroRef" | "action">,
): string | null {
  if (!("action" in request) || request.action === undefined) return null;
  const action = request.action as unknown;
  if (!action || typeof action !== "object") {
    return "A button's action must be one of: navigate, back, clearSlicers.";
  }
  const kind = (action as { kind?: unknown }).kind;
  if (typeof kind !== "string" || !(BUTTON_ACTION_KINDS as readonly string[]).includes(kind)) {
    return `Unknown button action "${String(kind)}". A button's action is one of: ${BUTTON_ACTION_KINDS.join(", ")}.`;
  }
  if (kind === "navigate") {
    const name = (action as { sheetName?: unknown }).sheetName;
    if (typeof name !== "string" || name.trim() === "") {
      return "A navigation button needs the page it goes to (sheetName).";
    }
  }
  if (request.onSelect && request.onSelect.length > 0) {
    return (
      "A button does one thing: it either runs its code (onSelect) or performs an action, " +
      "never both. Leave onSelect empty for a button with an action."
    );
  }
  if (request.macroRef) {
    return (
      "A button does one thing: it either runs a linked macro (macroRef) or performs an action, " +
      "never both. Leave macroRef out for a button with an action."
    );
  }
  return null;
}

// ============================================================================
// Page Navigator (D-NAV, owner findings 2026-10-15)
// ============================================================================
//
// Power BI's Page navigator is ONE object: a row (or column) of buttons, one
// per report page, that follows the report as pages are added, renamed,
// reordered or hidden. Calcula's is one control of type `pageNavigator`, owned
// by the Controls extension like every other control and created only through
// this seam (`createPageNavigator`), so no caller re-types its recipe.
//
// ITS ITEMS ARE NEVER STORED. Which pages it shows is derived live from
// @api/reportPages at paint, hit-test and press; a page added after the
// navigator was inserted simply appears. What IS stored is how it looks
// (container properties, the Controls extension's defaults table) and, per
// page, an optional override -- `pageOverrides`, a JSON array of
// `PageNavigatorOverride`.
//
// AN OVERRIDE NAMES ITS PAGE TWICE AND AIMS NOTHING. Like a navigate button's
// target, it carries the page's stable id and its name: the id is the match,
// the name is the fallback for a workbook where that id does not exist (a
// subscriber, whose ids a pull remaps -- app/src-tauri/src/controls.rs). It has
// NO target field: one item per page is structural, so no stored value can
// re-aim a reader's click at another page.
//
// THE WIRE FORM IS SHARED WITH RUST. A `.calp` pull rewrites the ids and names
// inside `pageOverrides` (core/calcula-format/src/page_navigator.rs parses and
// re-serialises it), and a push must give the published bytes back unchanged.
// So `serializePageNavigatorOverrides` is CANONICAL -- one fixed key order,
// compact, undefined fields left out -- and a fixture string pinned in both
// languages' tests proves the two serialisers agree byte for byte.

/** The controlType of a Page Navigator. Pinned against Rust by held_button_code_tests. */
export const PAGE_NAVIGATOR_CONTROL_TYPE = "pageNavigator";

/** The per-button override property: a JSON array of PageNavigatorOverride. */
export const PAGE_NAVIGATOR_OVERRIDES_PROPERTY = "pageOverrides";

/** The ways a navigator lays its items out, in the order a menu lists them. */
export const PAGE_NAVIGATOR_ORIENTATIONS = ["horizontal", "vertical"] as const;

/** One of `PAGE_NAVIGATOR_ORIENTATIONS`. */
export type PageNavigatorOrientation = (typeof PAGE_NAVIGATOR_ORIENTATIONS)[number];

/** Most overrides one navigator keeps (a parse drops the rest). */
export const MAX_PAGE_NAVIGATOR_OVERRIDES = 256;

/** Longest override caption, in characters (Unicode scalar values). */
export const MAX_PAGE_NAVIGATOR_CAPTION = 255;

/**
 * Longest serialised `pageOverrides` value, in characters (Unicode scalar values, `[...s].length`) --
 * the MIRROR of Rust's `MAX_CONTROL_PROPERTY_CHARS` (`app/src-tauri/src/controls.rs`, counted with
 * `.chars().count()`), pinned by `held_button_code_tests`. 256 entries x 255-char captions fit the
 * per-entry limits but not this one, so the strict check refuses the TOTAL with a sentence instead of
 * letting the backend door answer with its raw error.
 */
export const MAX_PAGE_NAVIGATOR_OVERRIDES_CHARS = 64 * 1024;

/**
 * THE one source of a navigator's natural size (the provider's default box, the canvas insert's box, the
 * recipe's default `gap`, the Properties defaults for width/height). Nothing re-types 112 / 32 / 8.
 */
export const PAGE_NAVIGATOR_NATURAL_ITEM = { width: 112, height: 32, gap: 8 } as const;

/**
 * Natural box for `itemCount` items, horizontal: n = max(1, itemCount); width = n*item.width +
 * (n-1)*gap; height = item.height. Pure. A navigator with no page to show still gets one item's room,
 * so it never inserts as a box nobody can see or grab.
 */
export function pageNavigatorNaturalSize(itemCount: number): { width: number; height: number } {
  const whole = Number.isFinite(itemCount) ? Math.floor(itemCount) : 1;
  const n = Math.max(1, whole);
  const { width, height, gap } = PAGE_NAVIGATOR_NATURAL_ITEM;
  return { width: n * width + (n - 1) * gap, height };
}

/** The box a navigator gets when nobody asked for a size and no page list is known: four items
 *  (472 x 32). */
export const PAGE_NAVIGATOR_DEFAULT_SIZE: { readonly width: number; readonly height: number } =
  Object.freeze(pageNavigatorNaturalSize(4));

/**
 * One page's override. Names the PAGE twice (id first, name as the fallback --
 * a subscriber's ids are its own) and carries NO target: which page an item
 * opens is structural (one item per page), so no stored value can re-aim a click.
 */
export interface PageNavigatorOverride {
  /** The page's stable sheet uuid; "" when it had none. */
  sheetId: string;
  /** The page's name when the override was written: the fallback match. */
  sheetName: string;
  /** Caption; absent = the page name. */
  text?: string;
  /** true = this page's button is left out. */
  hidden?: boolean;
  /** "#rgb" | "#rrggbb" | "#rrggbbaa"; default state only. */
  fill?: string;
  /** Caption colour, default state only. */
  color?: string;
  /** Border colour, every state. */
  borderColor?: string;
}

/** The colour spellings an override accepts. */
const PAGE_NAVIGATOR_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** The colour fields of an override, in canonical order. */
const PAGE_NAVIGATOR_COLOR_FIELDS = ["fill", "color", "borderColor"] as const;

/** Every field an override may carry, in the canonical (serialised) order. */
const PAGE_NAVIGATOR_OVERRIDE_FIELDS: readonly string[] = [
  "sheetId",
  "sheetName",
  "text",
  "hidden",
  ...PAGE_NAVIGATOR_COLOR_FIELDS,
];

/** Length in characters as Rust counts them (`.chars().count()`): code points, not UTF-16 units. */
function charCount(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const unit = s.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

/** `s` cut to at most `max` characters, never splitting a surrogate pair. */
function clipChars(s: string, max: number): string {
  if (s.length <= max) return s;
  return [...s].slice(0, max).join("");
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Tolerant read (paint, zone, pane): bad JSON -> []; entries missing sheetId AND sheetName dropped;
 *  unknown fields dropped; bad colours dropped field-wise; text clipped to MAX_PAGE_NAVIGATOR_CAPTION;
 *  at most MAX_PAGE_NAVIGATOR_OVERRIDES entries. Never throws. */
export function parsePageNavigatorOverrides(value: string | null | undefined): PageNavigatorOverride[] {
  if (typeof value !== "string" || value.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: PageNavigatorOverride[] = [];
  for (const raw of parsed) {
    if (out.length >= MAX_PAGE_NAVIGATOR_OVERRIDES) break;
    if (!isPlainRecord(raw)) continue;
    const sheetId = typeof raw.sheetId === "string" ? raw.sheetId : "";
    const sheetName = typeof raw.sheetName === "string" ? raw.sheetName : "";
    if (sheetId === "" && sheetName === "") continue;
    const entry: PageNavigatorOverride = { sheetId, sheetName };
    if (typeof raw.text === "string") entry.text = clipChars(raw.text, MAX_PAGE_NAVIGATOR_CAPTION);
    if (typeof raw.hidden === "boolean") entry.hidden = raw.hidden;
    for (const field of PAGE_NAVIGATOR_COLOR_FIELDS) {
      const c = raw[field];
      if (typeof c === "string" && PAGE_NAVIGATOR_COLOR.test(c)) entry[field] = c;
    }
    out.push(entry);
  }
  return out;
}

/** "setting 3 (page "Sales")" -- how a refusal names the entry it is about. */
function describeOverrideEntry(position: number, raw: unknown): string {
  const name =
    isPlainRecord(raw) && typeof raw.sheetName === "string" && raw.sheetName !== ""
      ? raw.sheetName
      : isPlainRecord(raw) && typeof raw.sheetId === "string" && raw.sheetId !== ""
        ? raw.sheetId
        : "";
  return name ? `Page button setting ${position} (page "${name}")` : `Page button setting ${position}`;
}

/** Strict check (script validator, pane before write): null when `value` is a valid overrides array,
 *  else the one-sentence refusal. Checks, in order: total length <= MAX_PAGE_NAVIGATOR_OVERRIDES_CHARS,
 *  JSON array, <= MAX_PAGE_NAVIGATOR_OVERRIDES entries, then each entry (names its position and page). */
export function checkPageNavigatorOverrides(value: string): string | null {
  if (typeof value !== "string") {
    return "The per-page button settings must be text: a JSON array of page entries.";
  }
  const length = charCount(value);
  if (length > MAX_PAGE_NAVIGATOR_OVERRIDES_CHARS) {
    return (
      `The per-page button settings are ${length} characters; the limit is ${MAX_PAGE_NAVIGATOR_OVERRIDES_CHARS}. ` +
      "Shorten some captions or clear settings you no longer need."
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return "The per-page button settings are not valid JSON; they must be a JSON array of page entries.";
  }
  if (!Array.isArray(parsed)) {
    return "The per-page button settings must be a JSON array of page entries.";
  }
  if (parsed.length > MAX_PAGE_NAVIGATOR_OVERRIDES) {
    return (
      `The per-page button settings name ${parsed.length} pages; a page navigator keeps at most ` +
      `${MAX_PAGE_NAVIGATOR_OVERRIDES}.`
    );
  }
  for (let i = 0; i < parsed.length; i++) {
    const raw: unknown = parsed[i];
    const which = describeOverrideEntry(i + 1, raw);
    if (!isPlainRecord(raw)) {
      return `${which} must be an object with sheetId and sheetName.`;
    }
    for (const key of Object.keys(raw)) {
      if (!PAGE_NAVIGATOR_OVERRIDE_FIELDS.includes(key)) {
        return `${which} has an unknown field "${key}"; the fields are ${PAGE_NAVIGATOR_OVERRIDE_FIELDS.join(", ")}.`;
      }
    }
    if (typeof raw.sheetId !== "string" || typeof raw.sheetName !== "string") {
      return `${which} must name its page with a text sheetId and sheetName.`;
    }
    if (raw.sheetId === "" && raw.sheetName === "") {
      return `${which} names no page: give it the page's sheetId or sheetName.`;
    }
    if (raw.text !== undefined) {
      if (typeof raw.text !== "string") return `${which}: the caption (text) must be text.`;
      const textLength = charCount(raw.text);
      if (textLength > MAX_PAGE_NAVIGATOR_CAPTION) {
        return `${which}: the caption is ${textLength} characters; the limit is ${MAX_PAGE_NAVIGATOR_CAPTION}.`;
      }
    }
    if (raw.hidden !== undefined && typeof raw.hidden !== "boolean") {
      return `${which}: hidden must be true or false.`;
    }
    for (const field of PAGE_NAVIGATOR_COLOR_FIELDS) {
      const c = raw[field];
      if (c === undefined) continue;
      if (typeof c !== "string" || !PAGE_NAVIGATOR_COLOR.test(c)) {
        return `${which}: ${field} ${JSON.stringify(c)} is not a colour; use #rgb, #rrggbb or #rrggbbaa.`;
      }
    }
  }
  return null;
}

/** Canonical compact JSON, fixed key order sheetId, sheetName, text, hidden, fill, color, borderColor;
 *  undefined fields omitted; "[]" for none. Byte-stable for the same list. */
export function serializePageNavigatorOverrides(list: readonly PageNavigatorOverride[]): string {
  const canonical = list.map((o) => {
    const out: Record<string, string | boolean> = { sheetId: o.sheetId, sheetName: o.sheetName };
    if (o.text !== undefined) out.text = o.text;
    if (o.hidden !== undefined) out.hidden = o.hidden;
    for (const field of PAGE_NAVIGATOR_COLOR_FIELDS) {
      const c = o[field];
      if (c !== undefined) out[field] = c;
    }
    return out;
  });
  return JSON.stringify(canonical);
}

/**
 * The override that applies to `page` (THE one matching rule):
 *   1. the override whose sheetId === page.sheetId; else
 *   2. an override whose sheetId names NO page in `allPages`, whose sheetName === page.name; else
 *   3. the same, case-folded (toLocaleLowerCase), as sheet names compare.
 * An override whose id matches some OTHER live page never applies by name.
 */
export function matchPageNavigatorOverride(
  overrides: readonly PageNavigatorOverride[],
  page: { sheetId?: string; name: string },
  allPages: ReadonlyArray<{ sheetId?: string }>,
): PageNavigatorOverride | undefined {
  const pageId = page.sheetId ?? "";
  if (pageId !== "") {
    const byId = overrides.find((o) => o.sheetId === pageId);
    if (byId) return byId;
  }
  const liveIds = new Set<string>();
  for (const p of allPages) if (p.sheetId) liveIds.add(p.sheetId);
  const orphans = overrides.filter((o) => o.sheetId === "" || !liveIds.has(o.sheetId));
  const exact = orphans.find((o) => o.sheetName === page.name);
  if (exact) return exact;
  const folded = page.name.toLocaleLowerCase();
  return orphans.find((o) => o.sheetName.toLocaleLowerCase() === folded);
}

/** WHERE a navigator goes and what the caller may ask; everything else (colours,
 *  pin/embed, gap...) is the provider's (Seam Rule). */
export type CreatePageNavigatorRequest = ButtonControlPlacement & {
  /** Rendered width in pixels. Omitted = the natural width for the live page list. */
  width?: number;
  /** Rendered height in pixels. Omitted = the natural height (one item). */
  height?: number;
  /** Default "horizontal". */
  orientation?: PageNavigatorOrientation;
};

function isNonNegativeFiniteNumber(n: unknown): boolean {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

/** Why a create request cannot be honoured (the provider THROWS this before writing), or null. */
export function checkCreatePageNavigator(request: CreatePageNavigatorRequest): string | null {
  if (!isPlainRecord(request)) {
    return "A page navigator request must say where it goes (sheetIndex plus row/col or x/y).";
  }
  const r = request as Record<string, unknown>;
  if (typeof r.sheetIndex !== "number" || !Number.isSafeInteger(r.sheetIndex) || r.sheetIndex < 0) {
    return `A page navigator's sheetIndex must be a non-negative whole number; got ${String(r.sheetIndex)}.`;
  }
  if (
    r.orientation !== undefined &&
    !(PAGE_NAVIGATOR_ORIENTATIONS as readonly unknown[]).includes(r.orientation)
  ) {
    return (
      `Unknown page navigator orientation "${String(r.orientation)}". ` +
      `A page navigator is one of: ${PAGE_NAVIGATOR_ORIENTATIONS.join(", ")}.`
    );
  }
  const hasX = r.x !== undefined;
  const hasY = r.y !== undefined;
  if (hasX !== hasY) {
    return "A page navigator's position needs both x and y (sheet pixels); only one was given.";
  }
  if (hasX && (!isNonNegativeFiniteNumber(r.x) || !isNonNegativeFiniteNumber(r.y))) {
    return `A page navigator's position must be non-negative, finite sheet pixels; got x=${String(r.x)}, y=${String(r.y)}.`;
  }
  const hasRow = r.row !== undefined;
  const hasCol = r.col !== undefined;
  if (hasRow !== hasCol) {
    return "A page navigator's anchor needs both row and col; only one was given. Omit both to have one allocated.";
  }
  if (
    hasRow &&
    (typeof r.row !== "number" || typeof r.col !== "number" ||
      !Number.isSafeInteger(r.row) || !Number.isSafeInteger(r.col) || r.row < 0 || r.col < 0)
  ) {
    return `A page navigator's anchor must be a non-negative whole row and column; got row=${String(r.row)}, col=${String(r.col)}.`;
  }
  if (!hasX && !hasRow) {
    return "A page navigator needs an anchor cell (row + col) or a position (x + y, sheet pixels); the request gave neither.";
  }
  for (const key of ["width", "height"] as const) {
    const v = r[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      return `A page navigator's ${key} must be a positive number of pixels; got ${String(v)}.`;
    }
  }
  return null;
}

/** Where a control sits: the anchor cell it is attached to. */
export interface ButtonControlAnchor {
  sheetIndex: number;
  row: number;
  col: number;
}

/**
 * WHERE a new button goes. A request names an anchor cell, a position, or
 * both — never neither:
 *
 *   * ANCHOR only (`row` + `col`): the historical address, unchanged. The
 *     button sits at the anchor cell's walked origin and is at least the
 *     cell's size.
 *   * POSITION only (`x` + `y`, sheet pixels, no scroll): the button is placed
 *     at exactly that point, and the PROVIDER allocates an anchor no control on
 *     that sheet occupies — in the same serialised step as the write, so two
 *     inserts in flight can never share one.
 *   * BOTH: the named anchor is the identity, the position is where it paints.
 *
 * Always written unpinned (`pinToGrid: "false"`). `x` and `y` go together;
 * one without the other is refused, as is a negative or non-finite coordinate.
 */
export type ButtonControlPlacement =
  | (ButtonControlAnchor & {
      /** Sheet-pixel left edge. Omitted = the anchor cell's walked origin. */
      x?: number;
      /** Sheet-pixel top edge. Omitted = the anchor cell's walked origin. */
      y?: number;
    })
  | {
      sheetIndex: number;
      /** Omitted: the provider allocates a free anchor cell. */
      row?: undefined;
      /** Omitted: the provider allocates a free anchor cell. */
      col?: undefined;
      /** Sheet-pixel left edge the button is placed at, exactly. */
      x: number;
      /** Sheet-pixel top edge the button is placed at, exactly. */
      y: number;
    };

/** What a caller may ASK for. Everything else — colours, the pin/embed
 *  defaults, the geometry nobody named — is the provider's business, exactly
 *  as it is for a button the user inserts from the ribbon. */
export type CreateButtonControlRequest = ButtonControlPlacement & {
  /** The caption drawn on the button. */
  label: string;
  /** Rendered width in pixels. Omitted = the anchor cell's width (at least
   *  80) for an anchored button, 80 for a positioned one. */
  width?: number;
  /** Rendered height in pixels. Omitted = the anchor cell's height (at least
   *  28) for an anchored button, 28 for a positioned one. */
  height?: number;
  /** Hover text. Optional; empty when omitted. */
  tooltip?: string;
  /**
   * Inline script source for the control's OWN click action (the `onSelect`
   * property, run in the isolated QuickJS module runtime).
   *
   * Leave this empty when the click is handled by a mounted OBJECT SCRIPT bound
   * to the returned `instanceId` — the two mechanisms both fire on a run-mode
   * click, so setting both runs the work twice.
   */
  onSelect?: string;
  /**
   * LINK this button to a recorded macro by its module id (`macro-<slug>`).
   *
   * When set, the provider writes it as the `macroRef` control property and the
   * click path resolves+runs the CURRENT macro through @api/macroRunService — no
   * body is copied onto the button. This is the "link, not copy" model: editing
   * the macro changes what every linking button runs, with no re-save. Mutually
   * exclusive with `onSelect` in practice — a macro-linked button has no inline
   * source of its own.
   */
  macroRef?: string;
  /**
   * A DECLARATIVE action instead of code (see "Declarative actions" above):
   * go to a page, go back, or clear the page's slicers. Written as the three
   * `BUTTON_ACTION_PROPERTY_KEYS`; refused together with a non-empty
   * `onSelect` or a `macroRef` (one button, one thing). The click performs it
   * on the page, with no script door, so it also works on a subscribed
   * (read-only) canvas and with Script Security off.
   */
  action?: ButtonAction;
};

/** A created button, as the provider actually placed it. `row`/`col` are the
 *  anchor it got — named by the caller, or allocated by the provider. */
export interface ButtonControlHandle extends ButtonControlAnchor {
  /** The control's instance id — the `button:clicked` / object-script key. */
  instanceId: string;
  /** Sheet-space pixel position and size the provider chose. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * What the Controls extension provides.
 *
 * Every method is anchor-addressed: one cell holds at most one control, which
 * is the same identity rule the backend's control metadata enforces. A create
 * that gives only a position gets an allocated anchor, returned on the handle.
 */
export interface ButtonControlProvider {
  /** Create a real, visible button — at an anchor cell, or at exactly `x`/`y`
   *  — and return its handle. Creating over an existing control at a NAMED
   *  anchor REPLACES it; an allocated anchor is always free. */
  createButton(request: CreateButtonControlRequest): Promise<ButtonControlHandle>;
  /** Delete the control at an anchor cell (no-op when there is none). Used to
   *  roll back a half-made button when the rest of a two-step bind fails. */
  removeButton(anchor: ButtonControlAnchor): Promise<void>;
  /** Create ONE Page Navigator (controlType "pageNavigator") at an anchor or at x/y, and return its
   *  handle. Its items are derived from @api/reportPages; nothing about pages is stored. The provider
   *  THROWS `checkCreatePageNavigator`'s sentence before writing anything. */
  createPageNavigator(request: CreatePageNavigatorRequest): Promise<ButtonControlHandle>;
}

let provider: ButtonControlProvider | null = null;

/**
 * Register the button driver. Called once by the Controls extension at
 * activation; returns the unregister function for its cleanup list.
 *
 * Last registration wins, and unregistering only clears the provider if it is
 * still the one that was registered — so a re-activation followed by the OLD
 * cleanup running cannot blank out the live provider.
 */
export function registerButtonControlProvider(
  next: ButtonControlProvider,
): () => void {
  provider = next;
  return () => {
    if (provider === next) provider = null;
  };
}

/** Whether on-grid buttons can currently be created. */
export function hasButtonControlProvider(): boolean {
  return provider !== null;
}

/**
 * The registered provider.
 *
 * THROWS when none is registered (the Controls extension is disabled or failed
 * to load). Refusing loudly is the point, and this seam exists BECAUSE the
 * silent alternative shipped once: a caller that writes control metadata itself
 * gets a successful backend response and no button, and the user is told the
 * operation succeeded while the grid stays empty. An error the caller can put in
 * front of the user — "buttons are unavailable, the Controls extension is not
 * loaded" — is the only honest outcome.
 */
export function requireButtonControlProvider(): ButtonControlProvider {
  if (!provider) {
    throw new Error(
      "On-grid buttons are unavailable: no button provider is registered (the Controls extension is not loaded). Enable it and try again.",
    );
  }
  return provider;
}

/** Test/reset hook: forget the registered provider. */
export function resetButtonControlProvider(): void {
  provider = null;
}
