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
 * Both methods are anchor-addressed: one cell holds at most one control, which
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
