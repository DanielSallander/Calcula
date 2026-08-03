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

/** What a caller may ASK for. Everything else — geometry, colours, the
 *  pin/embed defaults — is the provider's business, exactly as it is for a
 *  button the user inserts from the ribbon. */
export interface CreateButtonControlRequest extends ButtonControlAnchor {
  /** The caption drawn on the button. */
  label: string;
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
}

/** A created button, as the provider actually placed it. */
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
 * is the same identity rule the backend's control metadata enforces.
 */
export interface ButtonControlProvider {
  /** Create a real, visible button at an anchor cell and return its handle.
   *  Creating over an existing control at the same anchor REPLACES it. */
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
