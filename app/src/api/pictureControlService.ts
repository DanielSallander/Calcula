//! FILENAME: app/src/api/pictureControlService.ts
// PURPOSE: The feature-neutral seam through which any extension — or the script
//          broker — can place a real, visible PICTURE on the grid without
//          knowing that a Controls extension exists.
// CONTEXT: Inversion of Control, the exact shape buttonControlService.ts uses,
//          and for the exact reason that one exists. The Controls extension OWNS
//          on-grid controls: the backend control metadata, the floating-control
//          store the canvas renders from, the overlay hit-test regions, and the
//          image renderer that turns a `media:` handle into pixels. @api owns
//          nothing about pictures except this one contract.
//
// WHY THIS EXISTS RATHER THAN A DIRECT `set_control_metadata` CALL.
// The Macro Recorder already taught this lesson once, for buttons: it wrote the
// backend metadata itself with `{ label }` and nothing appeared on the grid,
// because the property Controls renders a caption from is `text`, because a
// control also needs geometry derived from the anchor cell's ACTUAL column width
// and row height plus explicit `pinToGrid: "false"`, and because nothing renders
// at all until the control is added to the floating-control store and the
// overlay regions are re-synced — while the backend cheerfully reported success.
// A picture has the same three-part recipe and one more part on top: resolving
// its handle to paintable pixels. Copying that into a second caller is a second
// source of truth that drifts on the first default change. So the seam hands the
// whole job to the extension that already does it for a picture the user
// inserts from the ribbon, and callers say only WHAT they want, never HOW.
//
// WHAT A CALLER CANNOT SAY, AND WHY THAT IS THE POINT. The only image argument
// is `mediaRef` — a `media:{sha256}` handle naming bytes that are ALREADY inside
// this document. There is no `bytes`, no `dataUrl` and no `path` on this
// interface, so a caller cannot introduce binary content through it however it
// is called. Bytes enter the document by exactly one route: the user picks a
// file in a native dialog, and the host (`read_media_file`, MAIN-window gated,
// magic-byte validated, byte- and pixel-capped) reads, validates and stores it.
// This seam is the PLACEMENT half of that story and nothing else.

/** Where a picture sits: the anchor cell it is attached to. */
export interface PictureControlAnchor {
  sheetIndex: number;
  row: number;
  col: number;
}

/** What a caller may ASK for. Everything else — the pixel geometry defaults,
 *  the pin/embed flags, the floating-store registration — is the provider's
 *  business, exactly as it is for a picture the user inserts from the ribbon. */
export interface CreatePictureControlRequest extends PictureControlAnchor {
  /**
   * The document handle for the image: `media:` followed by 64 lowercase hex
   * characters, as returned by `read_media_file` / `importImageViaPicker`.
   *
   * NOT a data: URI, NOT a path and NOT a URL. Providers must treat a value
   * that is not a well-formed handle as a programming error and refuse it,
   * rather than storing it and letting the CSP be the only thing standing
   * between a control property and a tracking beacon.
   */
  mediaRef: string;
  /** Rendered width in pixels. Omitted = the provider's own default, derived
   *  from the image's natural size (which the host knows from the header it
   *  already parsed — never from a decode in the WebView). */
  width?: number;
  /** Rendered height in pixels. Omitted = as for `width`. */
  height?: number;
  /** A display name for the object list. Optional; the provider auto-names. */
  name?: string;
}

/** A created picture, as the provider actually placed it. */
export interface PictureControlHandle extends PictureControlAnchor {
  /** The control's instance id — the object-script / api.listObjects key. */
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
 * Anchor-addressed, because one cell holds at most one control — the same
 * identity rule the backend's control metadata enforces.
 */
export interface PictureControlProvider {
  /** Create a real, visible picture at an anchor cell and return its handle.
   *  Creating over an existing control at the same anchor REPLACES it. */
  createPicture(request: CreatePictureControlRequest): Promise<PictureControlHandle>;
  /** Delete the control at an anchor cell (no-op when there is none). Used to
   *  roll back a half-made picture when a later step fails. */
  removePicture(anchor: PictureControlAnchor): Promise<void>;
}

let provider: PictureControlProvider | null = null;

/**
 * Register the picture driver. Called once by the Controls extension at
 * activation; returns the unregister function for its cleanup list.
 *
 * Last registration wins, and unregistering only clears the provider if it is
 * still the one that was registered — so a re-activation followed by the OLD
 * cleanup running cannot blank out the live provider.
 */
export function registerPictureControlProvider(
  next: PictureControlProvider,
): () => void {
  provider = next;
  return () => {
    if (provider === next) provider = null;
  };
}

/** Whether on-grid pictures can currently be created. */
export function hasPictureControlProvider(): boolean {
  return provider !== null;
}

/**
 * The registered provider.
 *
 * THROWS when none is registered (the Controls extension is disabled, or has
 * not yet adopted this seam). Refusing loudly is the point, and the silent
 * alternative has shipped here before: a caller that writes control metadata
 * itself gets a successful backend response and no picture, and the user is
 * told the operation succeeded while the grid stays empty.
 */
export function requirePictureControlProvider(): PictureControlProvider {
  if (!provider) {
    throw new Error(
      "On-grid pictures are unavailable: no picture provider is registered (the Controls extension is not loaded, or has not registered one). Enable it and try again.",
    );
  }
  return provider;
}

/** Test/reset hook: forget the registered provider. */
export function resetPictureControlProvider(): void {
  provider = null;
}
