//! FILENAME: app/extensions/_shared/scriptFrame/frameBridge.ts
// PURPOSE: The HOST end of the script-frame protocol — one router that both
//          `ui.html` hosts (the on-grid shape overlay and the Controls-pane
//          card) install, plus the budget that stops a hostile app holding an
//          unbounded number of frames alive.
// CONTEXT: See frameDocument.ts's header for the duplication this collapses and
//          for why the frame's own half of the bridge probably does not execute
//          in a shipped build. This half DOES execute — it is ordinary host
//          code in the app's own realm — so it is worth getting right
//          independently of when the other half starts working.
//
//          THE INTEGRITY CHECK IS THE POINT. `e.data` is attacker-controlled:
//          any frame in the window, and any script inside any of them, can post
//          `{ source: "shape-html", instanceId: "<someone else's>" }` to the
//          parent. `e.source` is not — the browser sets it to the posting
//          window. So a message is accepted only when its claimed instanceId
//          resolves to a frame the host itself registered AND that frame's
//          `contentWindow` is the window the message actually came from. Both
//          hosts had this check; both had their own copy of it.
//
//          WHY NOT A MessageChannel PER FRAME (the obvious hardening). A
//          `MessagePort` would make the identity structural instead of checked,
//          but the port has to be TRANSFERRED INTO the frame and picked up by
//          the frame's own script — which is precisely the half that cannot run
//          under the shipped CSP. Adopting it now would replace a check that
//          works with a mechanism that cannot be tested end-to-end until the
//          document is served from somewhere with its own policy. The
//          `e.source` check gives the same frame-identity guarantee; it is kept
//          deliberately, and the swap is an item for whoever lands the custom
//          URI scheme.

import {
  SCRIPT_FRAME_MESSAGE_TAG,
  SCRIPT_FRAME_RESERVED_TYPE_PREFIX,
  SCRIPT_FRAME_SIZE_MESSAGE,
} from "./frameDocument";

/** A frame -> host message that survived the integrity check. */
export interface ScriptFrameMessage {
  instanceId: string;
  type: string;
  data: unknown;
}

/** The intrinsic size a frame's own content settled at, in CSS pixels. */
export interface ScriptFrameIntrinsicSize {
  instanceId: string;
  width: number;
  height: number;
}

/** What a host has to supply to route its frames' messages. */
export interface ScriptFrameRouterOptions {
  /**
   * The frame this host registered for `instanceId`, or null when the id
   * belongs to the OTHER host (both routers see every `message` event, because
   * both listen on the same window). Returning null is how a router says "not
   * mine" — it must never be how it says "not recognised", or the two hosts
   * would fight over the same id.
   */
  resolveFrame: (instanceId: string) => HTMLIFrameElement | null;
  /** Deliver an ordinary script message. Reserved types never reach here. */
  deliver: (message: ScriptFrameMessage) => void;
  /**
   * Size negotiation: the frame reporting what its content actually needs.
   * Optional — a host that cannot resize (the on-grid overlay is the size the
   * user drew the shape) simply does not pass one, and the report is dropped
   * rather than forwarded to the script as if it were page content.
   */
  onIntrinsicSize?: (size: ScriptFrameIntrinsicSize) => void;
}

/** Why a message was not delivered. Returned so tests can assert the reason
 *  rather than "nothing happened", which is also what a working refusal and a
 *  broken router look like. */
export type ScriptFrameRouteResult =
  | "delivered"
  | "resized"
  | "not-a-frame-message"
  | "not-this-host"
  | "source-mismatch";

/**
 * Build the `message` handler for one host. Install it with
 * `window.addEventListener("message", router)` and remove the same reference
 * on teardown.
 */
export function createScriptFrameRouter(
  options: ScriptFrameRouterOptions,
): (event: MessageEvent) => ScriptFrameRouteResult {
  return (event: MessageEvent): ScriptFrameRouteResult => {
    const data = event.data as
      | { source?: unknown; instanceId?: unknown; type?: unknown; data?: unknown }
      | null
      | undefined;
    if (
      !data ||
      typeof data !== "object" ||
      data.source !== SCRIPT_FRAME_MESSAGE_TAG ||
      typeof data.instanceId !== "string"
    ) {
      return "not-a-frame-message";
    }
    const instanceId = data.instanceId;
    const frame = options.resolveFrame(instanceId);
    if (!frame) return "not-this-host";
    // THE CHECK. Anything can claim an instanceId; only the frame the host
    // itself created can BE that instanceId's window.
    if (event.source !== frame.contentWindow) return "source-mismatch";

    const type = typeof data.type === "string" ? data.type : "";
    if (type.startsWith(SCRIPT_FRAME_RESERVED_TYPE_PREFIX)) {
      if (type === SCRIPT_FRAME_SIZE_MESSAGE && options.onIntrinsicSize) {
        const payload = data.data as { width?: unknown; height?: unknown } | undefined;
        const width = typeof payload?.width === "number" ? payload.width : NaN;
        const height = typeof payload?.height === "number" ? payload.height : NaN;
        if (Number.isFinite(width) && Number.isFinite(height)) {
          options.onIntrinsicSize({ instanceId, width, height });
        }
      }
      // Reserved either way: bridge plumbing is never forwarded to the script,
      // even when this host has no use for it.
      return "resized";
    }

    options.deliver({ instanceId, type, data: data.data });
    return "delivered";
  };
}

/** Post a host -> frame message in the envelope the bridge listens for. */
export function postToScriptFrame(
  frame: HTMLIFrameElement | null,
  instanceId: string,
  type: string,
  data: unknown,
): boolean {
  const target = frame?.contentWindow;
  if (!target) return false;
  target.postMessage(
    { target: SCRIPT_FRAME_MESSAGE_TAG, instanceId, type, data },
    // The frame has an opaque origin (sandbox without allow-same-origin), so
    // "*" is the only targetOrigin that can ever match. The confidentiality
    // this gives up is nil: the payload is the script's own message going back
    // to the script's own frame.
    "*",
  );
  return true;
}

/**
 * The KEYBOARD half of "paint only", for every host of a script's document.
 *
 * `pointer-events: none` was the whole gate, and it stops the MOUSE and nothing
 * else. An `<iframe>` stays in the sequential focus order however it is styled,
 * so Tab walks out of the grid, into the frame's document and onto the first
 * focusable thing the script drew — and the next keystroke is the script's. A
 * `<input type=password>` painted under `ui.html` alone was therefore typeable
 * on every host, which is the same defect the pointer gate was added to close,
 * arriving by the other input device.
 *
 * `tabindex="-1"` does NOT fix it: it takes the frame ELEMENT out of the order
 * while the nested document keeps its own focusable areas, so Tab still lands
 * inside. `inert` is the one that travels — a document whose browsing-context
 * container is inert is itself inert, and an inert document has no focusable
 * areas at all, no text selection and no hit testing. It leaves script
 * execution, `postMessage` and painting untouched, so a paint-only frame still
 * paints and a claimed frame still hears the on-grid host's synthesized pointer
 * events.
 *
 * Written as an ATTRIBUTE rather than the IDL property: the two are equivalent
 * in the browser (the property reflects the attribute), and the attribute is
 * the form a host's DOM can be asserted on — an environment that has not
 * implemented `inert` accepts `el.inert = true` as a plain expando and reports
 * it back happily, which would let a test pass over a frame the real user can
 * still tab into.
 */
export function setScriptFrameInert(
  frame: HTMLIFrameElement | null,
  inert: boolean,
): void {
  if (!frame) return;
  frame.toggleAttribute("inert", inert);
}

// ============================================================================
// The frame budget — a cap on COUNT and on BYTES
// ============================================================================

/**
 * How many script frames may be alive at once, across BOTH hosts.
 *
 * A frame is a whole document with its own event loop. Nothing in the product
 * limits how many shapes a workbook may hold, and a script can call
 * `render.setHtmlContent` on every shape it owns, so without a cap a
 * distributed app can spend the user's memory until the app dies — and it
 * looks like Calcula being slow, not like an app misbehaving.
 *
 * 24 is chosen to be far above any honest design (a dashboard sheet with a
 * dozen live tiles still fits) and far below the point where WebView2 struggles.
 */
export const MAX_LIVE_SCRIPT_FRAMES = 24;

/**
 * How many bytes of frame DOCUMENT may be alive at once, across both hosts.
 *
 * The per-call validator already caps ONE document at 5 MB (`vHtml`), which
 * says nothing about twenty of them. This is the watchdog for the aggregate:
 * 16 MB total, i.e. a handful of large apps or many small ones.
 */
export const MAX_LIVE_SCRIPT_FRAME_BYTES = 16 * 1024 * 1024;

/** Live frames, by instanceId -> the document size charged for it. */
const liveFrameBytes = new Map<string, number>();
/** Running total, kept alongside the map so a claim is O(1). */
let liveBytesTotal = 0;

/**
 * PARKED frames: still alive, still charged, but PREEMPTIBLE.
 *
 * The on-grid host deliberately keeps a departing sheet's frames rather than
 * removing them, because re-assigning `srcdoc` reloads the document and throws
 * away whatever state its own scripts built (see
 * `releaseUnpaintedShapeOverlays`). That is the right call for the user — and it
 * is also how the budget stopped meaning anything: 24 hidden frames from a sheet
 * nobody is looking at refused every frame on the sheet the user IS looking at,
 * and no lifecycle ever gave them back.
 *
 * So a parked frame keeps its charge — the memory really is still held, and
 * pretending otherwise would be the same lie in the other direction — but it is
 * the first thing spent when a claim would otherwise be refused. Parking is
 * free while there is room, and costs a reload only under actual pressure.
 *
 * The value is the host's teardown for that frame: the budget does not own DOM,
 * so it cannot drop a charge without telling somebody to remove the thing the
 * charge stood for. It is passed the id it is being called FOR rather than
 * closing over one, because `migrateScriptFrameSlot` re-keys a parked control
 * and a closure would then tear down an id that no longer exists — dropping the
 * charge while the frame lived on, which is the exact lie this all exists to
 * stop. Insertion order is PARK order, so the frame hidden longest ago is the
 * first one evicted.
 */
const parkedFrames = new Map<string, (instanceId: string) => void>();

/** A refusal names WHICH budget was hit; a caller that cannot say why it did
 *  not paint leaves the user staring at an empty shape. */
export type ScriptFrameSlotRefusal = "too-many-frames" | "too-many-bytes";

export interface ScriptFrameSlotResult {
  granted: boolean;
  refusal?: ScriptFrameSlotRefusal;
  /** A sentence for the log/status line, naming the budget and the number. */
  message?: string;
}

/**
 * Mark a live frame as parked: hidden by its host, still alive, and from now on
 * the first thing spent when the budget runs out.
 *
 * `evict` is called when that happens, AFTER the charge has already been
 * dropped, and must remove the frame's DOM — the charge and the element go
 * together or the budget is measuring fiction. A host that never parks anything
 * (the pane card releases on unmount instead) never needs this.
 *
 * A no-op for an id holding no slot: there is nothing to preempt, and inventing
 * an entry here would make the eviction loop tear down a frame nobody charged
 * for.
 */
export function parkScriptFrameSlot(
  instanceId: string,
  evict: (instanceId: string) => void,
): void {
  if (!liveFrameBytes.has(instanceId)) return;
  // `Map.set` on an existing key keeps its original position, so re-parking an
  // already-parked frame does NOT make it look freshly hidden. That is what
  // keeps "oldest parked" honest across the repeated region publications a
  // scroll produces.
  parkedFrames.set(instanceId, evict);
}

/** The frame is being painted again — it is no longer preemptible. Called on
 *  every paint of a live frame, so it must stay cheap and idempotent. */
export function unparkScriptFrameSlot(instanceId: string): void {
  parkedFrames.delete(instanceId);
}

/** How many live frames are currently parked. For tests and diagnosis. */
export function parkedScriptFrameCount(): number {
  return parkedFrames.size;
}

/**
 * Spend parked frames, oldest first, until `fits()` is true or none are left.
 *
 * The books are cleared BEFORE the host's teardown runs, so an evictor that
 * releases its own slot (every honest teardown does) is a no-op rather than a
 * second subtraction driving the total negative.
 */
function evictParkedFrames(fits: () => boolean): void {
  for (const [instanceId, evict] of [...parkedFrames]) {
    if (fits()) return;
    parkedFrames.delete(instanceId);
    const bytes = liveFrameBytes.get(instanceId);
    if (bytes !== undefined) {
      liveFrameBytes.delete(instanceId);
      liveBytesTotal -= bytes;
    }
    try {
      evict(instanceId);
    } catch (err) {
      // A host that throws while tearing down must not take the claim with it:
      // the charge is already gone, so the room is real either way.
      console.error(`[scriptFrame] Evicting parked frame ${instanceId} failed:`, err);
    }
  }
}

/**
 * Claim (or re-price) the budget slot for one frame.
 *
 * Re-entrant on purpose: a host calls this every time the frame's document
 * changes, and an instanceId that already holds a slot is RE-PRICED rather than
 * counted twice — that is what makes it safe to call from a render loop.
 *
 * A claim that does not fit spends PARKED frames before it refuses. That is the
 * whole reason parking is a budget concept and not just a `display: none` in the
 * host: without it, the sheet the user is looking at loses to the sheet they
 * left.
 */
export function claimScriptFrameSlot(
  instanceId: string,
  documentBytes: number,
): ScriptFrameSlotResult {
  // A frame being claimed is being painted, so it is not parked — and must
  // never be a candidate for its own eviction.
  parkedFrames.delete(instanceId);

  if (!liveFrameBytes.has(instanceId) && liveFrameBytes.size >= MAX_LIVE_SCRIPT_FRAMES) {
    evictParkedFrames(() => liveFrameBytes.size < MAX_LIVE_SCRIPT_FRAMES);
  }
  if (!liveFrameBytes.has(instanceId) && liveFrameBytes.size >= MAX_LIVE_SCRIPT_FRAMES) {
    return {
      granted: false,
      refusal: "too-many-frames",
      message:
        `at most ${MAX_LIVE_SCRIPT_FRAMES} HTML frames can be live at once ` +
        `(this workbook already has ${liveFrameBytes.size}); close or clear one before opening another`,
    };
  }

  const project = (): number =>
    liveBytesTotal - (liveFrameBytes.get(instanceId) ?? 0) + documentBytes;
  // Eviction is only worth doing when the document could fit AT ALL. One larger
  // than the whole aggregate would spend every parked frame in the workbook and
  // then be refused anyway — destroying other sheets' frames to make room for
  // something that was never going to be granted. (`vHtml` caps one document at
  // 5 MB against a 16 MB aggregate, so this is a guard, not a live case.)
  if (project() > MAX_LIVE_SCRIPT_FRAME_BYTES && documentBytes <= MAX_LIVE_SCRIPT_FRAME_BYTES) {
    evictParkedFrames(() => project() <= MAX_LIVE_SCRIPT_FRAME_BYTES);
  }
  const projected = project();
  if (projected > MAX_LIVE_SCRIPT_FRAME_BYTES) {
    return {
      granted: false,
      refusal: "too-many-bytes",
      message:
        `live HTML frames may hold at most ${MAX_LIVE_SCRIPT_FRAME_BYTES} bytes of document in total ` +
        `(this one would take the total to ${projected}); make the content smaller or clear another frame`,
    };
  }
  liveFrameBytes.set(instanceId, documentBytes);
  liveBytesTotal = projected;
  return { granted: true };
}

/** Give the slot back (frame removed, script unmounted, content cleared). */
export function releaseScriptFrameSlot(instanceId: string): void {
  // Unconditionally, before the early return: a parked entry left behind for an
  // id that no longer holds a charge would hand the eviction loop a teardown for
  // a frame nothing is paying for.
  parkedFrames.delete(instanceId);
  const previous = liveFrameBytes.get(instanceId);
  if (previous === undefined) return;
  liveFrameBytes.delete(instanceId);
  liveBytesTotal -= previous;
}

/**
 * Move a slot when a structural edit re-keys a control (see
 * `migrateShapeInstanceId`). Without this the old id's bytes are charged forever
 * and the new id is uncounted — the budget leaks in both directions.
 *
 * THE DESTINATION IS NOT GUARANTEED TO BE FREE, and the move is a DISPLACEMENT
 * rather than a merge. A control id encodes its anchor cell, and re-anchoring
 * has no collision check: an unpinned shape at row 8 does not move when rows 8-9
 * are deleted, while the pinned shape at row 10 re-keys straight onto its id —
 * and a cascade of pinned shapes walks over its own destinations one rename at a
 * time. Overwriting the map entry while its bytes stayed in the running total
 * left a charge no key names any more: `releaseScriptFrameSlot` subtracts only
 * the entry that survived, so the surplus was UNRECOVERABLE, and every later
 * claim re-priced off the poisoned total. The end state is a budget refusing
 * frames while `scriptFrameBudgetUsage` reports a frames/bytes pair that cannot
 * both be true — two live frames holding sixteen megabytes of document between
 * them. Two 400 KB shapes and one row delete were enough to strand 400 KB for
 * the rest of the session.
 *
 * The displaced frame's DOM belongs to the HOST, which removes it in the same
 * overwrite (`migrateShapeInstanceId`). Nothing is torn down from here: the
 * parked teardown is keyed by id, and by the time this returns that id names the
 * frame that just ARRIVED.
 */
export function migrateScriptFrameSlot(oldId: string, newId: string): void {
  if (oldId === newId) return;
  const bytes = liveFrameBytes.get(oldId);
  // Only what is actually overwritten is displaced. A migration that moves no
  // charge (the control never had an html frame) must leave the destination's
  // own slot exactly as it found it.
  if (bytes !== undefined) {
    const displaced = liveFrameBytes.get(newId);
    if (displaced !== undefined) {
      liveBytesTotal -= displaced;
      // The parked registration goes with the charge it stood for. Left behind
      // it would name the ARRIVING frame, and the next claim that ran short of
      // room would spend a frame the user is looking at — tearing down live DOM
      // to collect a charge that is no longer the one it was registered for.
      parkedFrames.delete(newId);
    }
  }
  // The parked entry moves next, and only when it exists: a re-keyed control
  // that was parked stays parked (its frame is still hidden), and one that was
  // not must not become parked by the migration.
  const evict = parkedFrames.get(oldId);
  if (evict !== undefined) {
    parkedFrames.delete(oldId);
    parkedFrames.set(newId, evict);
  }
  if (bytes === undefined) return;
  liveFrameBytes.delete(oldId);
  liveFrameBytes.set(newId, bytes);
}

/** What the budget currently holds. For tests and the transparency surfaces. */
export function scriptFrameBudgetUsage(): { frames: number; bytes: number } {
  return { frames: liveFrameBytes.size, bytes: liveBytesTotal };
}

/**
 * Drop every claim WITHOUT tearing anything down. Test isolation only.
 *
 * It used to say "workbook closed, extension deactivated" as well, and nothing
 * in the product ever called it — the only caller in the repo was the budget's
 * own test — so a document change carried the previous workbook's charges into
 * the next one and the refusal sentence's "this workbook already has N" was
 * false. BOTH hosts are wired to File > New / File > Open and to their own
 * deactivate now, and none of those four goes through here: they tear the frames
 * DOWN (`releaseAllShapeHtmlOverlays` on the grid, `releaseAllPaneControlFrames`
 * in the pane) and release each slot as they go. Forgetting a charge whose frame
 * is still in the DOM is the same fiction as keeping a charge whose frame is
 * gone, so this one stays where a test can prove the books start empty and
 * nowhere else.
 */
export function resetScriptFrameBudget(): void {
  liveFrameBytes.clear();
  parkedFrames.clear();
  liveBytesTotal = 0;
}
