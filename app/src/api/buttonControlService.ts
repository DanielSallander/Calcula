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
