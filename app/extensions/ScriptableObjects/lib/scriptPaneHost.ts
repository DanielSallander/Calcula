//! FILENAME: app/extensions/ScriptableObjects/lib/scriptPaneHost.ts
// PURPOSE: The renderer half of script TASK PANES (M2 S4): the listeners that
//          turn the host registry's data-only events into panels the Shell
//          hosts, and carry the user's input back. One PanelDefinition per
//          pane, registered through the `registerPanel` seam the extension
//          already uses for its transparency panels; the section component is
//          the trusted ScriptPaneSection closed over the pane's store.
//
// THE FOUR EXCHANGES:
//   REQUEST -> registerPanel, openPanel ONLY IF the request says so, then
//              acknowledge "docked" with the EFFECTIVE placement (the registry
//              answers reveal() honestly from it: openPanel is a no-op on the
//              ribbon);
//   PATCH   -> the pane's store (values / controls / seeds / message / focus),
//              the panel badge, or a reveal (openPanel again);
//   input   -> the store's change / click / visible / hidden / close leave as
//              SCRIPT_PANE_INPUT_EVENT for the registry;
//   CLOSE   -> unregisterPanel and forget the store.
//
// A USER-OWNED CLOSE is a design point: the pane's own close affordance tells
// the REGISTRY (kind "close"), the registry ends the session and answers with
// CLOSE, and only then does the panel come down — so the script's onPaneClose
// fires with reason "user" and its mirror says the pane is gone. If no session
// answers (the registry has already forgotten the id), the panel is an orphan
// and comes down anyway: a pane nobody owns must not stay on screen.
//
// WHY `registerPanel` AND NOT `registerTaskPane`: the panel system is the one
// seam that lets the USER decide where a surface lives (sidebar or ribbon) and
// that carries a badge; `registerPanel` UPSERTS silently, which is why a panel
// id is built from the pane's STABLE KEY — unique among a script's live panes,
// and the same again on the next dock so the user's placement choice holds —
// never from the per-session pane id (see `scriptPanePanelId`).

import type { IPanelAPI } from "@api/contract";
import { emitAppEvent, onAppEvent } from "@api/events";
import { showToast } from "@api/notifications";
import {
  SCRIPT_PANE_CLOSE_EVENT,
  SCRIPT_PANE_INPUT_EVENT,
  SCRIPT_PANE_PATCH_EVENT,
  SCRIPT_PANE_REQUEST_EVENT,
  // The DOCKED placements only. `PanePlacement` gained "embedded" with M3c
  // (a form the user placed on a sheet), and this wiring hosts PANELS: an
  // embedded surface never reaches `registerPanel`, and `defaultPlacement`
  // below would not type-check if it could.
  type DockedPanePlacement,
  type ScriptPaneClosePayload,
  type ScriptPaneInputPayload,
  type ScriptPanePatchPayload,
  type ScriptPaneRequestPayload,
} from "@api/scriptHost/scriptPaneSpec";
import { createScriptPaneSection } from "../components/scriptPane/createScriptPaneSection";
import { scriptGlyph } from "../components/scriptForm/hostChrome";
import { createScriptPaneStore, type ScriptPaneStore } from "./scriptPaneStore";

// ============================================================================
// Wire
// ============================================================================

/**
 * Emitted by the Shell's panel registry (`panelRegistry.setPlacement`) when
 * the user moves a panel: `{ panelId, oldPlacement, newPlacement }`. The
 * registry learns a pane's placement from this, never by guessing.
 */
export const PANEL_PLACEMENT_CHANGED_EVENT = "panel:placementChanged";

interface PanelPlacementChangedDetail {
  panelId: string;
  oldPlacement: DockedPanePlacement;
  newPlacement: DockedPanePlacement;
}

/**
 * The panel id one pane is registered under: the script and the pane's STABLE
 * KEY (`ScriptPaneRequestPayload.paneKey`), never its per-session `paneId`.
 * The Shell persists the user's placement choice by panel id
 * (`usePanelPlacementStore`, localStorage), so an id built from `pane-<n>` —
 * one global counter, never reused — lost "put it on the ribbon" on every
 * re-dock and left a dead entry behind each time. The key is unique among a
 * script's LIVE panes (the registry refuses a duplicate), so two panels never
 * share an id at once, and the script id keeps one script's "0" from being
 * another's.
 *
 * The key is the SCRIPT's to choose, though, so it cannot be the only thing a
 * placement is remembered by: a script that rotates keys reaches a fresh id and
 * the registry's default every time, which is how "put it on the ribbon" was
 * defeated. `lastPlacementByScript` is the answer to that.
 */
export function scriptPanePanelId(scriptId: string, paneKey: string): string {
  return `scriptable-objects.pane.${scriptId}.${paneKey}`;
}

/** What the wiring needs from the panel system; `context.ui.panels` provides it. */
export interface ScriptPaneHostDeps {
  panels: Pick<IPanelAPI, "register" | "unregister" | "open" | "getPlacement">;
  /** Badge on the pane's tab / icon; null clears it. */
  setBadge(panelId: string, text: string | null): void;
}

interface LivePane {
  store: ScriptPaneStore;
  panelId: string;
  /** Whose pane it is — the key the placement fall-back below is remembered under. */
  scriptId: string;
}

// ============================================================================
// Install
// ============================================================================

/**
 * Subscribe the renderer to the registry's events. Returns the teardown,
 * which takes every live panel down (the extension is deactivating; the host
 * resets its pane sessions on the same path).
 */
export function installScriptPaneHost(deps: ScriptPaneHostDeps): () => void {
  const panes = new Map<string, LivePane>();
  /**
   * scriptId -> where the user last put a pane of THAT SCRIPT (whatever its
   * key), which becomes the `defaultPlacement` of its next pane that has no
   * choice of its own recorded.
   *
   * WHY IT EXISTS. The Shell remembers a placement per PANEL ID
   * (`usePanelPlacementStore`), and a pane's panel id carries its key. So the
   * user's one escape from a pane they did not want in the sidebar — move it to
   * the ribbon, where `openPanel` does nothing — was defeated by a single
   * character: the script docked under a different key, `getPlacement` found no
   * override for that new id, fell through to `defaultPlacement: "sidebar"`,
   * and the takeover resumed. Nothing caps how many keys a script may use.
   *
   * WHY THE FALL-BACK AND NOT A WRITE. This never calls `setPlacement`: it does
   * not invent a preference the user did not express, and it writes nothing to
   * the persisted store under a key the script chose (a key-rotating script
   * would otherwise fill it). It only supplies the DEFAULT the Shell reaches
   * for when the user has expressed nothing for that exact id — an explicit
   * choice for this pane still wins, in both directions.
   *
   * WHY HERE AND NOT IN THE SHELL. The Shell's placement store knows panel ids;
   * "these panels belong to one script" is knowledge of this wiring alone, and
   * `defaultPlacement` on `registerPanel` is the seam the panel system already
   * offers for exactly this. Reaching into `usePanelPlacementStore` from an
   * extension would be the boundary violation, and teaching the Shell about
   * script ids would be a second one.
   */
  const lastPlacementByScript = new Map<string, DockedPanePlacement>();

  const takeDown = (paneId: string): void => {
    const live = panes.get(paneId);
    if (!live) return;
    panes.delete(paneId);
    // Disposed BEFORE the unregister unmounts the component, so its unmount
    // effect has nothing to say about a pane that is already gone.
    live.store.dispose();
    deps.panels.unregister(live.panelId);
  };

  const emitInput = (payload: ScriptPaneInputPayload): void => {
    emitAppEvent(SCRIPT_PANE_INPUT_EVENT, payload);
    // The registry answers a "close" with SCRIPT_PANE_CLOSE_EVENT in the same
    // tick, which takes the panel down above. If nothing answered, no session
    // owns this pane any more, and an orphaned panel must not stay on screen.
    if (payload.kind === "close" && panes.has(payload.paneId)) takeDown(payload.paneId);
  };

  const offs: Array<() => void> = [];

  offs.push(
    onAppEvent<ScriptPaneRequestPayload>(SCRIPT_PANE_REQUEST_EVENT, (request) => {
      if (!request || typeof request.paneId !== "string" || typeof request.paneKey !== "string" || !request.spec) {
        return;
      }
      // Ids are host-minted and unique; a repeat would be the same session
      // twice, and upserting the panel underneath a live store would orphan it.
      if (panes.has(request.paneId)) return;
      const panelId = scriptPanePanelId(request.scriptId, request.paneKey);
      // The same guard by PANEL id: the registry refuses a duplicate live key,
      // so this fires only if that guard is gone — and `registerPanel` upserts
      // silently, so without it the older pane's panel would be replaced under
      // its store with nothing to say so.
      for (const live of panes.values()) if (live.panelId === panelId) return;

      const store = createScriptPaneStore(request, emitInput);
      panes.set(request.paneId, { store, panelId, scriptId: request.scriptId });

      deps.panels.register({
        id: panelId,
        // Host-derived chrome: the script's name is the tab / icon label; the
        // band inside says where it came from.
        title: request.scriptName,
        icon: scriptGlyph(24),
        sections: [
          {
            id: `${panelId}.pane`,
            label: request.scriptName,
            component: createScriptPaneSection(store),
            // A widget tree is tall: on the ribbon it is always a launcher
            // whose flyout hosts the pane vertically, never a probe render.
            ribbonPresentation: "launcher",
            flyoutWidth: 360,
          },
        ],
        // Where this script's panes went last, before the registry's own
        // "sidebar" — see `lastPlacementByScript`. An explicit choice recorded
        // against THIS panel id still overrides it (`panelRegistry.getPlacement`
        // reads the store first), so this only decides a pane the user has
        // never placed by name.
        defaultPlacement: lastPlacementByScript.get(request.scriptId) ?? "sidebar",
        // A soft hint on the move affordance; the user may still park it on
        // the ribbon, and reveal() then answers honestly.
        supportedPlacements: ["sidebar"],
        priority: 0,
      });
      // REGISTERING IS NOT OPENING. `openPanel` forces the sidebar open and
      // switches the active view away from whatever the user had there, so it
      // happens only when the registry says this dock is a response to the user
      // (`ScriptPaneRequestPayload.open`). Otherwise the pane is registered and
      // listed — it exists, it carries its badge, the script's `pane.dock`
      // resolves — and the user opens it when they want it.
      if (request.open) deps.panels.open(panelId);

      // The dock is acknowledged from HERE, not from the component's mount:
      // on the ribbon (or in a closed sidebar) the component is not mounted
      // yet the pane exists. The component reports "visible" when it paints.
      const placement = deps.panels.getPlacement(panelId);
      // Seed the script's remembered placement from the first pane of it we
      // see: that read-back IS the user's persisted choice for this panel id
      // when they have made one (a previous session's "put it on the ribbon"),
      // and the registry's default otherwise. Only when nothing is remembered
      // yet, so a later pane can never overwrite a move the user just made.
      if (!lastPlacementByScript.has(request.scriptId)) {
        lastPlacementByScript.set(request.scriptId, placement);
      }
      emitInput({
        paneId: request.paneId,
        kind: "docked",
        placement,
        values: store.getSnapshot().values,
      });
    }),
  );

  offs.push(
    onAppEvent<ScriptPanePatchPayload>(SCRIPT_PANE_PATCH_EVENT, (detail) => {
      if (!detail) return;
      const live = panes.get(detail.paneId);
      if (!live) return;
      if (detail.patch || detail.seeds) live.store.applyPatch(detail);
      // Each host notice takes its OWN door into the store: a script's
      // `message` (inside `patch`) reaches neither, and clearing either one
      // leaves the script's message alone.
      if (detail.hostBanner !== undefined) live.store.setHostBanner(detail.hostBanner);
      if (detail.hostBindingNotice !== undefined) live.store.setHostBindingNotice(detail.hostBindingNotice);
      if (detail.badge !== undefined) deps.setBadge(live.panelId, detail.badge);
      // A reveal is `openPanel` and nothing more: the sidebar opens onto the
      // pane, and keyboard focus stays where the user has it (the grid, a
      // cell editor). The section takes no focus on mount either.
      if (detail.reveal) deps.panels.open(live.panelId);
    }),
  );

  offs.push(
    onAppEvent<ScriptPaneClosePayload>(SCRIPT_PANE_CLOSE_EVENT, (detail) => {
      if (!detail) return;
      const live = panes.get(detail.paneId);
      // A forced close (S6: the script's third throttle cooldown in ten
      // minutes) must reach the USER, not only the script's onPaneClose — the
      // pane simply vanishing would read as a crash. The band is gone with
      // the pane, so the one surface left is a toast.
      // The wording is deliberately kind-NEUTRAL: three different refusals
      // climb the throttle ladder (a dropped update or badge, a refused
      // reveal), the CLOSE event carries only the reason, and a script that
      // only ever looped `pane.reveal()` must not be told off here for
      // "updating its pane too fast" — the same lie the host banner used to
      // tell (see PaneRefusalKind in scriptPanes.ts). "More calls than
      // allowed" is true of every route into this close.
      if (live && detail.reason === "throttled") {
        showToast(
          `"${live.store.request.scriptName}" was making more task-pane calls than Calcula allows and did not stop, ` +
            "so the pane was closed. Run the script again to open it.",
          { type: "warning", duration: 8000 },
        );
      }
      takeDown(detail.paneId);
    }),
  );

  offs.push(
    onAppEvent<PanelPlacementChangedDetail>(PANEL_PLACEMENT_CHANGED_EVENT, (detail) => {
      if (!detail || typeof detail.panelId !== "string") return;
      for (const [paneId, live] of panes) {
        if (live.panelId !== detail.panelId) continue;
        // The user moved THIS script's pane: that choice now stands for the
        // script's next pane too, whatever key it docks under. `setPlacement`
        // is the only emitter of this event and it is reached only from the
        // move affordances, so this is a person's decision, never a script's.
        lastPlacementByScript.set(live.scriptId, detail.newPlacement);
        emitInput({
          paneId,
          kind: "placement",
          placement: detail.newPlacement,
          values: live.store.getSnapshot().values,
        });
        return;
      }
    }),
  );

  return () => {
    for (const off of offs) off();
    for (const paneId of [...panes.keys()]) takeDown(paneId);
  };
}
