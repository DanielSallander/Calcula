//! FILENAME: app/extensions/ScriptableObjects/lib/scriptEmbedHost.ts
// PURPOSE: The renderer half of forms EMBEDDED on a sheet (M3c) — the mirror of
//          lib/scriptPaneHost.ts. It turns the host registry's data-only pane
//          events into on-grid surfaces, carries the user's input back, and
//          keeps the set of live surfaces in step with the set of PLACEMENTS the
//          user has made (`@api/scriptHost/embeddedFormPlacements`).
//
// ONE WIRE, TWO PLACEMENTS. An embedded surface is a pane SESSION with
// `placement: "embedded"` (see scriptPanes.ts's header for why it is not a
// fourth registry), so the four exchanges are the pane's, filtered to requests
// that carry an `embedPlacementId`:
//   REQUEST -> build the shared `ScriptPaneStore`, paint the surface, then
//              acknowledge "docked" so the registry settles the session and
//              relays the surface's id into the script's shim;
//   PATCH   -> the store (values / controls / seeds / message / focus), the host
//              notices, or the badge (painted in the band — there is no tab);
//   input   -> change / click / visible / hidden leave as SCRIPT_PANE_INPUT_EVENT;
//   CLOSE   -> dispose the store and paint the surface's inert state.
//
// WHAT IS DIFFERENT, AND WHY:
//   - NOTHING HERE OPENS A SESSION ON A SCRIPT'S SAY-SO. The list of surfaces is
//     the list of PLACEMENTS; this module asks the host to run one when a
//     placement exists, is not orphaned AND ITS SHEET IS THE ONE ON SCREEN, and
//     the host refuses with a sentence when it cannot
//     (`openEmbeddedScriptForm`). A script cannot make a placement, so there is
//     no entry here for it to hammer. The sheet condition is on the OPEN only —
//     see `openSurface` for why the session then outlives every tab click.
//   - A CLOSED SESSION DOES NOT TAKE THE SURFACE DOWN. The placement is still on
//     the sheet, so the box stays and says why nothing is running in it. That is
//     also why a close is never followed by a re-open here: a script that faults
//     on every mount would otherwise be restarted forever by its own failure.
//   - THE USER OWNS THE DISMISS. There is no close affordance in the band and
//     `pane.close` is refused for an embedded session (scriptPanes.ts): the
//     surface goes when the user deletes the object from the sheet, and that
//     path comes in here as `forget`. The ONE dismissal that is not the user's
//     is the document itself being replaced — see `forgetEveryPlacement`, which
//     is also the only thing that empties the placement store.

import { AppEvents, emitAppEvent, onAppEvent } from "@api/events";
import {
  SCRIPT_PANE_CLOSE_EVENT,
  SCRIPT_PANE_INPUT_EVENT,
  SCRIPT_PANE_PATCH_EVENT,
  SCRIPT_PANE_REQUEST_EVENT,
  type PaneCloseReason,
  type ScriptPaneClosePayload,
  type ScriptPaneInputPayload,
  type ScriptPanePatchPayload,
  type ScriptPaneRequestPayload,
} from "@api/scriptHost/scriptPaneSpec";
import {
  EMBEDDED_FORM_ORPHAN_REMEDY,
  EMBEDDED_FORM_PLACEMENTS_CHANGED_EVENT,
  listEmbeddedFormPlacements,
  resetEmbeddedFormPlacements,
  type EmbeddedFormPlacement,
} from "@api/scriptHost/embeddedFormPlacements";
import type { EmbeddedFormViewState } from "../components/scriptEmbed";
import { createScriptPaneStore, type ScriptPaneStore } from "./scriptPaneStore";

// ============================================================================
// Deps
// ============================================================================

/**
 * What the wiring needs from whatever actually puts pixels on the grid. Injected
 * so every rule in this module is testable without a canvas: the DOM half
 * (positioning a host element over the sheet, mounting a React root into it)
 * lives in lib/embeddedFormLayer.ts and is the only implementation.
 */
export interface ScriptEmbedHostDeps {
  /** Paint (or repaint) the surface for one placement. */
  paint(placementId: string, view: EmbeddedFormSurfaceView): void;
  /** The placement is gone from the document: drop its surface entirely. */
  forget(placementId: string): void;
  /**
   * Tell me when a surface starts or stops being PAINTED — scrolled into or out
   * of the viewport, or the user moving between sheet tabs. Returns the
   * unsubscribe.
   *
   * WHY THE LAYER OWNS THIS AND THE COMPONENT DOES NOT. The host arms a
   * bound-cell watch while a surface is visible and takes it down when it is
   * not, on the invariant that a surface nobody can see reads nothing. Reading
   * that from the React component's mount was right for the docked pane, whose
   * panel really does unmount it, and wrong for an embedded surface: the layer
   * hides with `display: none` and keeps the element and the React root, so the
   * mount effect never ran again and a form scrolled off screen went on being
   * fed the user's cell edits (with an audit entry per read). The signal has to
   * come from whatever writes `display`, which is the layer.
   */
  onSurfaceVisibility(handler: (placementId: string, visible: boolean) => void): () => void;
  /**
   * Which sheet the user is looking at, right now. READ FRESH at every open
   * rather than cached here: the layer corrects this answer asynchronously at
   * install (a workbook can open on its third sheet), so a copy taken once on
   * this side would be 0 for as long as that first IPC took.
   */
  activeSheetIndex(): number;
  /**
   * Tell me when that answer changes; returns the unsubscribe. This is the only
   * thing that opens the session for a placement on a sheet the user had not
   * visited yet — `onSurfaceVisibility` cannot serve, because a placement on
   * another sheet is never painted and so never reports itself visible.
   */
  onActiveSheetChange(handler: (sheetIndex: number) => void): () => void;
  /** Ask the host to run the form for this placement. Resolves a refusal sentence, never throws. */
  openSession(placementId: string): Promise<{ ok: true; paneId: string } | { ok: false; reason: string }>;
  /** Ask the host to end the session for this placement (the object was removed, or orphaned). */
  closeSession(placementId: string, reason: PaneCloseReason): void;
}

/** Everything the surface component needs, in one value the layer can render. */
export interface EmbeddedFormSurfaceView {
  placementId: string;
  state: EmbeddedFormViewState;
  badge: string | null;
  width: number;
  height: number;
}

interface LiveSurface {
  placementId: string;
  paneId: string;
  store: ScriptPaneStore;
  badge: string | null;
}

// ============================================================================
// Install
// ============================================================================

/**
 * The teardown, plus the two doors a caller outside this module needs.
 *
 * `retry` is the ONE way out of a remembered refusal, and it is deliberately a
 * function someone has to call rather than a timer: an automatic retry turns a
 * script that fails on every mount into a loop. `reconcile` re-reads the
 * placement set on demand — the change event covers every ordinary path, and
 * this is for a caller that has just changed something the event does not carry.
 */
export type ScriptEmbedHostHandle = (() => void) & {
  retry(placementId: string): void;
  reconcile(): void;
};

/**
 * Subscribe the renderer to the registry's events and to the placement set.
 * Returns the teardown, which takes every live surface down (the extension is
 * deactivating; the host resets its pane sessions on the same path).
 */
export function installScriptEmbedHost(deps: ScriptEmbedHostDeps): ScriptEmbedHostHandle {
  /** placementId -> its live session, while one is open. */
  const live = new Map<string, LiveSurface>();
  /** paneId -> placementId, so a patch or a close can be routed without a scan. */
  const byPaneId = new Map<string, string>();
  /**
   * placementId -> the sentence the host refused with, kept so a repaint (a
   * scroll, a resize) does not blank the explanation the user is reading. It is
   * cleared only by a successful open or by the placement going away.
   */
  const refusals = new Map<string, string>();
  /**
   * Placements whose open is in flight. An open is one IPC round trip per bound
   * cell, and the sheet repaints continuously while the user scrolls — without
   * this, one placement would start an open on every frame and the registry's
   * duplicate-key guard would be the only thing standing between the user and a
   * hundred audited reads of the same cells.
   */
  const opening = new Set<string>();
  /**
   * Which placements the layer is PAINTING right now. Held here rather than
   * inferred, because the two facts arrive in either order: a placement is
   * painted (as "Starting this form…") before its session exists, and a session
   * can also open for a placement that is scrolled out of view. Whichever lands
   * second is what tells the store it is on screen.
   */
  const onScreen = new Set<string>();
  let disposed = false;

  const geometryOf = (p: EmbeddedFormPlacement): { width: number; height: number } => ({
    width: p.width,
    height: p.height,
  });

  /** What one placement should be showing right now, given what we know about it. */
  const viewFor = (p: EmbeddedFormPlacement): EmbeddedFormSurfaceView => {
    const surface = live.get(p.id);
    const geometry = geometryOf(p);
    if (p.orphaned) {
      return {
        placementId: p.id,
        state: { kind: "orphaned", scriptName: surface?.store.request.scriptName ?? null },
        badge: null,
        ...geometry,
      };
    }
    if (surface) {
      return { placementId: p.id, state: { kind: "open", store: surface.store }, badge: surface.badge, ...geometry };
    }
    return {
      placementId: p.id,
      state: {
        kind: "refused",
        scriptName: null,
        // "Starting…" is the honest word for the gap between a placement
        // appearing and its session answering: the alternative was an empty box
        // that looks identical to a script that failed.
        reason: refusals.get(p.id) ?? "Starting this form…",
      },
      badge: null,
      ...geometry,
    };
  };

  const repaint = (placementId: string): void => {
    if (disposed) return;
    const p = listEmbeddedFormPlacements().find((x) => x.id === placementId);
    if (!p) return;
    deps.paint(placementId, viewFor(p));
  };

  const emitInput = (payload: ScriptPaneInputPayload): void => {
    emitAppEvent(SCRIPT_PANE_INPUT_EVENT, payload);
  };

  /** Drop a live session's renderer state. The PLACEMENT is untouched. */
  const takeDown = (placementId: string): void => {
    const surface = live.get(placementId);
    if (!surface) return;
    live.delete(placementId);
    byPaneId.delete(surface.paneId);
    surface.store.dispose();
  };

  const offs: Array<() => void> = [];

  // ---- REQUEST: the host opened a session for a placement -------------------
  offs.push(
    onAppEvent<ScriptPaneRequestPayload>(SCRIPT_PANE_REQUEST_EVENT, (request) => {
      // Docked task panes belong to scriptPaneHost.ts; this listener takes only
      // the requests that name a placement on a sheet. Both listeners are
      // installed at once, so the filter is what keeps one pane out of two
      // renderers — and it is a POSITIVE test on a host-supplied field, never
      // an absence, because a request with neither would otherwise be painted
      // twice.
      if (!request || typeof request.embedPlacementId !== "string" || !request.spec) return;
      const placementId = request.embedPlacementId;
      // Ids are host-minted and unique; a repeat would be the same session
      // twice, and replacing the store underneath a painted surface would leave
      // the old one collecting the user's keystrokes for nobody.
      if (live.has(placementId)) return;

      const store = createScriptPaneStore(request, emitInput);
      live.set(placementId, { placementId, paneId: request.paneId, store, badge: null });
      byPaneId.set(request.paneId, placementId);
      refusals.delete(placementId);
      repaint(placementId);

      // Acknowledged from HERE, not from the surface being painted: a placement
      // scrolled off screen is not painted, yet the session exists and the
      // script must be able to prepare it.
      emitInput({
        paneId: request.paneId,
        kind: "docked",
        placement: "embedded",
        values: store.getSnapshot().values,
      });
      // AFTER the acknowledgement, and only if the layer is already painting
      // this placement. "visible" is what arms the bound-cell watch, and the two
      // facts land in either order: the surface is usually painted (as
      // "Starting this form…") before its session exists, but an open can also
      // resolve before the first frame, in which case the layer's own signal
      // below is what arms it.
      if (onScreen.has(placementId)) store.mounted();
    }),
  );

  // ---- PAINTED / NOT PAINTED: the gate on the bound-cell watch --------------
  // The one signal that says a surface is on screen. See
  // `ScriptEmbedHostDeps.onSurfaceVisibility` for why it comes from the layer
  // and not from the React component that paints the widgets.
  offs.push(
    deps.onSurfaceVisibility((placementId, visible) => {
      if (disposed) return;
      if (visible) onScreen.add(placementId);
      else onScreen.delete(placementId);
      // No session yet (the open is still in flight, or was refused): the fact
      // is remembered above and the REQUEST handler applies it.
      const surface = live.get(placementId);
      if (!surface) return;
      if (visible) surface.store.mounted();
      else surface.store.unmounted();
    }),
  );

  // ---- PATCH ---------------------------------------------------------------
  offs.push(
    onAppEvent<ScriptPanePatchPayload>(SCRIPT_PANE_PATCH_EVENT, (detail) => {
      if (!detail) return;
      const placementId = byPaneId.get(detail.paneId);
      if (placementId === undefined) return;
      const surface = live.get(placementId);
      if (!surface) return;
      if (detail.patch || detail.seeds) surface.store.applyPatch(detail);
      // Each host notice takes its OWN door into the store: a script's
      // `message` (inside `patch`) reaches neither, and clearing either one
      // leaves the script's message where the script put it.
      if (detail.hostBanner !== undefined) surface.store.setHostBanner(detail.hostBanner);
      if (detail.hostBindingNotice !== undefined) surface.store.setHostBindingNotice(detail.hostBindingNotice);
      if (detail.badge !== undefined) {
        surface.badge = detail.badge;
        repaint(placementId);
      }
      // `reveal` is deliberately ignored: the registry already refuses it for an
      // embedded session with a reason the script is told, so nothing should
      // arrive here — and if it ever did, scrolling the user's grid on a
      // script's say-so is the one thing this surface must never do.
    }),
  );

  // ---- CLOSE ---------------------------------------------------------------
  offs.push(
    onAppEvent<ScriptPaneClosePayload>(SCRIPT_PANE_CLOSE_EVENT, (detail) => {
      if (!detail) return;
      const placementId = byPaneId.get(detail.paneId);
      if (placementId === undefined) return;
      takeDown(placementId);
      // The BOX STAYS: the placement is still on the sheet. What it says depends
      // on why the session ended, and every one of these is a state the user can
      // act on — which is the difference between this and a surface that simply
      // stopped repainting.
      refusals.set(placementId, closedSentence(detail.reason));
      repaint(placementId);
    }),
  );

  // ---- PLACEMENTS: the set of surfaces IS the set of placements -------------
  const reconcile = (): void => {
    if (disposed) return;
    const placements = listEmbeddedFormPlacements();
    const known = new Set(placements.map((p) => p.id));
    // A placement that has left the DOCUMENT takes its paint state with it. The
    // layer drops such a host outright rather than hiding it (its session is
    // already down), so no visibility signal is coming and nothing else would
    // ever collect the row.
    for (const placementId of [...onScreen]) {
      if (!known.has(placementId)) onScreen.delete(placementId);
    }
    for (const placementId of [...live.keys()]) {
      if (known.has(placementId)) continue;
      // The user deleted the object. Tell the host first so the script's
      // onPaneClose fires and its bound writes flush, then drop the surface.
      deps.closeSession(placementId, "user");
      takeDown(placementId);
      refusals.delete(placementId);
      deps.forget(placementId);
    }
    for (const placementId of [...refusals.keys()]) {
      if (!known.has(placementId)) {
        refusals.delete(placementId);
        deps.forget(placementId);
      }
    }
    for (const p of placements) {
      if (p.orphaned) {
        // A structural edit deleted its anchor. End the session — its bindings
        // are resolved against coordinates that now belong to other cells — and
        // paint the orphan. The placement is kept on purpose (see
        // embeddedFormPlacements.ts): losing it would take the user's layout.
        if (live.has(p.id)) {
          deps.closeSession(p.id, "orphaned");
          takeDown(p.id);
        }
        refusals.delete(p.id);
        repaint(p.id);
        continue;
      }
      if (live.has(p.id) || opening.has(p.id)) {
        repaint(p.id);
        continue;
      }
      // A previous open was refused: do NOT retry on every placement change.
      // The refusal is a state the user has to resolve (start the script, give
      // it a layout), and retrying would hammer the host for as long as it
      // lasted.
      if (refusals.has(p.id)) {
        repaint(p.id);
        continue;
      }
      void openSurface(p.id);
    }
  };

  const openSurface = async (placementId: string): Promise<void> => {
    if (opening.has(placementId)) return;
    // NOT UNTIL THE USER IS STANDING ON ITS SHEET. Opening a session RESOLVES
    // the layout's cell bindings, and an unqualified `bind` means the sheet the
    // placement lives on (`resolveFormBindings`' home sheet, api/scriptHost/
    // host.ts) — which at restricted tier can only be READ while it is the sheet
    // on screen. This loop used to ask for every placement in the workbook the
    // moment the extension installed, so every form on a sheet other than the
    // first resolved its bindings from behind another sheet: unreadable seeds
    // at best, and before the home sheet existed, another sheet's cells
    // outright.
    //
    // THE GATE IS ON THE OPEN, NOT ON THE SESSION. A session opened here
    // SURVIVES every later tab click — its store, its typed values and its
    // bound-cell watch are not the sheet's to take (the layer hides the surface
    // and the host's pin disables its widgets; see lib/embeddedFormLayer.ts).
    // This only decides when it may START.
    const placement = listEmbeddedFormPlacements().find((p) => p.id === placementId);
    if (!placement || placement.sheetIndex !== deps.activeSheetIndex()) {
      // Still paint it, so the surface has something to show the moment its
      // sheet does come up — the sheet change below is what reaches the open.
      repaint(placementId);
      return;
    }
    opening.add(placementId);
    repaint(placementId);
    let answer: { ok: true; paneId: string } | { ok: false; reason: string };
    try {
      answer = await deps.openSession(placementId);
    } catch (e) {
      answer = { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
    opening.delete(placementId);
    if (disposed) return;
    // The placement can go WHILE the open is in flight — the user deleted the
    // object, or the workbook was replaced under it (see `forgetEveryPlacement`).
    // Remembering a refusal against an id nobody holds would leave a row that
    // only a placement change can collect, and `repaint` below would paint
    // nothing anyway: say so once, here, instead of leaking one entry per swap.
    if (!listEmbeddedFormPlacements().some((p) => p.id === placementId)) {
      refusals.delete(placementId);
      return;
    }
    if (!answer.ok) {
      refusals.set(placementId, answer.reason);
      repaint(placementId);
      return;
    }
    // On success the REQUEST event has already built the store (the host emits
    // it before `openEmbeddedScriptForm` resolves), so there is nothing to do
    // but make sure what is on screen matches.
    repaint(placementId);
  };

  offs.push(onAppEvent(EMBEDDED_FORM_PLACEMENTS_CHANGED_EVENT, () => reconcile()));
  // The user clicked a sheet tab: whatever was waiting on that sheet may open
  // now. A full reconcile rather than a targeted open, because the answer to
  // "which placements may run" is the same question the placement set asks and
  // a second, sheet-only copy of it is how the two would drift.
  offs.push(deps.onActiveSheetChange(() => reconcile()));

  // ---- WORKBOOK SWAP: a placement belongs to the DOCUMENT -------------------
  /**
   * File > Open / File > New replaced the document these surfaces were placed
   * on, so every placement made in the old one goes with it.
   *
   * NOTHING SWEPT THEM BEFORE THIS. The host's own sweep (`hostResetAll` ->
   * `resetScriptPanes`) ends the SESSIONS as "reset", so each surface repainted
   * with "The workbook this form belonged to was closed or replaced." — and then
   * STAYED on the grid over the NEW workbook's cells: opaque and click-claiming
   * (lib/embeddedFormLayer.ts gives the host element `pointer-events: auto`
   * outside Design Mode), never retried (a remembered refusal is deliberately
   * never retried — see `reconcile`), and still counted against
   * MAX_EMBEDDED_FORMS_PER_SHEET, so the new workbook's twentieth placement was
   * refused because of the old workbook's ghosts. The only way out was
   * right-clicking each ghost's own anchor cell in turn.
   *
   * THE ORDER INSIDE HERE IS THE WHOLE OF IT, and it is what makes this sweep
   * safe whichever way it races the host's — both run off AFTER_OPEN /
   * AFTER_NEW and neither may assume it goes first:
   *   - the renderer state goes down FIRST, because `resetEmbeddedFormPlacements`
   *     announces and the announce runs `reconcile` synchronously; reconcile
   *     would find live surfaces whose placements had just vanished and close
   *     them as "user" — the one close reason that FLUSHES a pending bound
   *     write, into the workbook that has just replaced the one it was typed
   *     into (the exact hazard `hostResetAll` documents at its `resetScriptPanes`
   *     call);
   *   - and it goes down WITHOUT closing anything, because ending those sessions
   *     is the host's job and it ends them as "reset", which DROPS those pending
   *     writes.
   *
   * BEFORE_CLOSE deliberately does NOT sweep: it is broadcast ahead of the
   * cancellable "save changes?" prompt (shell/Layout.tsx), and a user who
   * answers Cancel must still have the forms they placed.
   */
  const forgetEveryPlacement = (): void => {
    if (disposed) return;
    const abandoned = new Set<string>([
      ...live.keys(),
      ...refusals.keys(),
      ...listEmbeddedFormPlacements().map((p) => p.id),
    ]);
    for (const placementId of [...live.keys()]) takeDown(placementId);
    refusals.clear();
    resetEmbeddedFormPlacements();
    for (const placementId of abandoned) deps.forget(placementId);
  };
  offs.push(onAppEvent(AppEvents.AFTER_OPEN, forgetEveryPlacement));
  offs.push(onAppEvent(AppEvents.AFTER_NEW, forgetEveryPlacement));

  // First pass: a workbook can already carry placements when this installs.
  reconcile();

  /** Re-open a placement the user has fixed — see `ScriptEmbedHostHandle.retry`. */
  const retry = (placementId: string): void => {
    refusals.delete(placementId);
    void openSurface(placementId);
  };

  return Object.assign(
    () => {
      disposed = true;
      for (const off of offs) off();
      for (const placementId of [...live.keys()]) takeDown(placementId);
      refusals.clear();
    },
    { retry, reconcile },
  );
}

/**
 * What an inert surface says, per close reason. Every sentence names a state
 * and, where the user can do something, what — and the something has to EXIST:
 * the orphan arm reads `EMBEDDED_FORM_ORPHAN_REMEDY`, the one constant the card
 * and the host's own refusal read, rather than repeating the gesture in a third
 * spelling (this arm and those two spent M3c telling the user to drag a box that
 * nothing can drag). "unmount" and "orphaned" are the two a user meets in
 * ordinary work.
 */
export function closedSentence(reason: PaneCloseReason): string {
  switch (reason) {
    case "unmount":
      return "The script for this form is not running. Start it from Code in This File.";
    case "orphaned":
      return `The cell this form was anchored to was deleted. ${EMBEDDED_FORM_ORPHAN_REMEDY}`;
    case "throttled":
      return (
        "Calcula stopped this form: the script kept making more calls to it than allowed. " +
        "Run the script again to start it."
      );
    case "reset":
      return "The workbook this form belonged to was closed or replaced.";
    case "failed":
      return "This form did not start.";
    case "script":
      return "The script closed this form.";
    case "user":
      return "This form is closed.";
  }
}
