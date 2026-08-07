//! FILENAME: app/src/api/controlsService.ts
// PURPOSE: The feature-neutral seam through which any extension — or the script
//          broker — can enumerate, CREATE and DELETE cell-anchored on-grid
//          controls (shapes above all) without knowing a Controls extension
//          exists.
// CONTEXT: Inversion of Control, the exact shape buttonControlService.ts and
//          pictureControlService.ts use. The Controls extension OWNS on-grid
//          controls: the backend control metadata, the floating-control store
//          the canvas renders from, the overlay hit-test regions, the shape
//          catalog and every side table keyed by a control's instanceId
//          (object scripts, declared properties, custom canvas renderers, HTML
//          overlays). @api owns nothing about them except this one contract.
//
// WHY THIS IS A SIBLING OF THE BUTTON AND PICTURE SEAMS, NOT AN EXTENSION OF
// THEM. The three control types have DISJOINT property sets — a shape carries
// `shapeType`/`stroke`/`strokeWidth`/`textAlign`, a picture carries `src`, a
// button carries `onSelect`/`macroRef`/`borderColor` — and the button options
// are not merely extra fields: they are BEHAVIOURAL CONTRACTS. `onSelect` is
// inline source the click path feeds to the QuickJS module runtime, and
// `macroRef` is a LINK (not a copy) to a recorded macro that is re-resolved on
// every click. Neither means anything for a rectangle. Folding shapes into
// `CreateButtonControlRequest` would put those contracts in front of callers
// that must never reach them and would make one request type answer to three
// different renderers. Three narrow seams beat one wide one.
//
// WHY A SEAM AT ALL RATHER THAN A DIRECT `set_control_metadata` CALL.
// The Macro Recorder already taught this lesson once, for buttons: it wrote the
// backend metadata itself with `{ label }` and nothing appeared on the grid,
// because the property Controls renders a caption from is `text`; because a
// control also needs pixel geometry derived from the anchor cell's ACTUAL
// column width and row height (widths are irregular — the position is a WALK,
// never a multiplication) plus an explicit `pinToGrid: "false"`, since the
// backend defaults an ABSENT pin property to "moves" and would otherwise shift
// the anchor on the first row insert while the frontend holds its pixels; and
// because nothing renders at all until the control is registered in the
// floating-control store and the overlay regions are re-synced — while the
// backend cheerfully reported success. A shape's recipe is SEVENTEEN property
// keys long. Copying it into a second caller is a second source of truth that
// drifts on the first default change, so the seam hands the whole job to the
// extension that already does it for a shape the user inserts from the ribbon,
// and callers say only WHAT they want, never HOW.
//
// WHAT MOVED HERE, AND WHY. `listControls` used to be the whole of
// `IControlStoreService` in componentStoreRegistry.ts, whose doc comment said
// controls were "read-only: creating a control is a canvas-placement gesture,
// not a data operation". That is exactly the sentence this seam falsifies —
// placing a shape from a script IS a data operation, and the sentence was only
// ever true because no create path existed. Enumeration and creation belong to
// one contract, so the registry keeps the component STORES and this file owns
// the whole control surface.

// ============================================================================
// Identity
// ============================================================================

/** Where a control sits: the anchor cell it is attached to. */
export interface ControlAnchor {
  sheetIndex: number;
  row: number;
  col: number;
}

/** One control, as identity + anchor. Never the property VALUES — those can be
 *  formulas over the user's data, and reading them is a separate call. */
export interface ControlInventoryRow extends ControlAnchor {
  /** "button" | "shape" | "image" | a future type. Deliberately a string: the
   *  set is the Controls extension's business, not the API's. */
  controlType: string;
  /** The control's `name` property, when it has one. */
  name?: string;
}

// ============================================================================
// The shape catalog
// ============================================================================

/**
 * One entry of the shape catalog, flattened out of its category.
 *
 * This exists so the 123 shapes Calcula draws are DISCOVERABLE rather than an
 * unwritable enum in a consent string. A caller that wants a rectangle asks for
 * `"rectangle"`; a caller that wants to know what else there is asks the
 * catalog. The provider also uses it to build the error for an unknown id, so
 * "which ids are accepted?" is answered by the refusal itself.
 */
export interface ShapeCatalogEntry {
  /** The id `createShape` takes as its `shapeType`. */
  id: string;
  /** Human label, as the insert gallery shows it. */
  label: string;
  /** Category id ("lines", "rectangles", "basicShapes", ...). */
  categoryId: string;
  /** Category label, as the gallery groups it. */
  categoryLabel: string;
  /** The width this shape is inserted at when a caller names none. */
  defaultWidth: number;
  /** The height this shape is inserted at when a caller names none. */
  defaultHeight: number;
  /** A line/connector: stroked, never filled. */
  isLine: boolean;
}

// ============================================================================
// Create
// ============================================================================

/** What a caller may ASK for when placing a shape. Everything else — the fill
 *  and stroke defaults, the font, the alignment, the pin/opacity/rotation
 *  flags, the pixel walk, the floating-store registration — is the provider's
 *  business, exactly as it is for a shape the user inserts from the ribbon. */
export interface CreateShapeControlRequest extends ControlAnchor {
  /** A catalog id from `listShapeCatalog()` (e.g. "rectangle", "roundedRectangle",
   *  "rightArrow"). An id the catalog does not hold is a programming error and
   *  providers must THROW, naming the ids they accept — the old behaviour was to
   *  return silently, which is indistinguishable from a shape that failed to
   *  paint. */
  shapeType: string;
  /** Rendered width in pixels. Omitted = the catalog's default for this shape. */
  width?: number;
  /** Rendered height in pixels. Omitted = the catalog's default for this shape. */
  height?: number;
  /** Text drawn inside the shape. Omitted = empty.
   *  NOTE THE SPELLING: the stored property is `text`, never `label` — writing
   *  `label` is the original invisible-control bug, and it is invisible because
   *  the write SUCCEEDS. */
  text?: string;
  /** A display name for the object list. Optional; omitted leaves the property
   *  unwritten rather than storing "". */
  name?: string;
}

/** A created shape, as the provider actually placed it. */
export interface ShapeControlHandle extends ControlAnchor {
  /**
   * The control's instance id — the object-script binding key and the id
   * `api.listObjects("shape")` reports.
   *
   * TAKE IT FROM HERE. It is derived from the anchor inside the extension, and
   * a caller that re-derives the `control-{sheet}-{row}-{col}` format itself
   * produces a control and a script that never meet the day the format changes.
   */
  instanceId: string;
  /** The catalog id the shape was created from. */
  shapeType: string;
  /** Sheet-space pixel position and size the provider chose. */
  x: number;
  y: number;
  width: number;
  height: number;
}

// ============================================================================
// Provider
// ============================================================================

/**
 * What the Controls extension provides.
 *
 * Creation is ANCHOR-addressed (one cell holds at most one control — the
 * identity rule the backend's control storage enforces), deletion is
 * INSTANCE-addressed, because that is the id every other surface already
 * carries: `api.listObjects("shape")` reports it, an object script binds to it,
 * and the click path emits it.
 */
export interface ControlsProvider {
  /** Every shape the insert gallery can draw, flattened out of its categories. */
  listShapeCatalog(): ShapeCatalogEntry[];

  /**
   * Create a real, visible shape at an anchor cell and return its handle.
   *
   * REFUSES rather than overwrites when the anchor already holds a control.
   * `set_control_metadata` is a plain map insert, so creating over an occupied
   * cell would wipe the existing control while its object script — bound to the
   * anchor-derived instanceId — stayed behind for the new control to inherit.
   * A refusal the caller can act on beats a silent swap it cannot see.
   */
  createShape(request: CreateShapeControlRequest): Promise<ShapeControlHandle>;

  /**
   * Delete a control by its instance id, with the full teardown the user's own
   * Delete key performs: object scripts, declared properties, custom renderers,
   * HTML overlays, selection, the Properties pane, the render caches and the
   * backend metadata.
   *
   * Returns false when no control has that id. THROWS when a control exists but
   * cannot be removed through this path.
   */
  deleteControl(instanceId: string): Promise<boolean>;

  /** Every control on ONE sheet, as identity + anchor rows. */
  listControls(sheetIndex: number): Promise<ControlInventoryRow[]>;
}

let provider: ControlsProvider | null = null;

/**
 * Register the controls driver. Called once by the Controls extension at
 * activation; returns the unregister function for its cleanup list.
 *
 * Last registration wins, and unregistering only clears the provider if it is
 * still the one that was registered — so a re-activation followed by the OLD
 * cleanup running cannot blank out the live provider.
 */
export function registerControlsProvider(next: ControlsProvider): () => void {
  provider = next;
  return () => {
    if (provider === next) provider = null;
  };
}

/** Whether on-grid controls can currently be enumerated, created or deleted. */
export function hasControlsProvider(): boolean {
  return provider !== null;
}

/**
 * The registered provider, or null.
 *
 * For ENUMERATION only, where "the Controls extension is not loaded" and "this
 * workbook has no controls" are the same answer to the caller and an empty list
 * is honest. Every MUTATION must go through `requireControlsProvider()`.
 */
export function getControlsProvider(): ControlsProvider | null {
  return provider;
}

/**
 * The registered provider.
 *
 * THROWS when none is registered (the Controls extension is disabled or failed
 * to load). Refusing loudly is the point, and the silent alternative has
 * shipped here before: a caller that writes control metadata itself gets a
 * successful backend response and no control on the grid, so the user is told
 * the operation succeeded while the sheet stays empty.
 */
export function requireControlsProvider(): ControlsProvider {
  if (!provider) {
    throw new Error(
      "On-grid controls are unavailable: no controls provider is registered (the Controls extension is not loaded). Enable it and try again.",
    );
  }
  return provider;
}

/** Test/reset hook: forget the registered provider. */
export function resetControlsProvider(): void {
  provider = null;
}
