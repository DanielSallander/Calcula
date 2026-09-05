//! FILENAME: app/extensions/ScriptableObjects/lib/scriptPaneStore.ts
// PURPOSE: The live state of ONE script task pane (M2), held OUTSIDE React.
//          A pane's section component mounts only while the pane is painted —
//          the sidebar shows it, the ribbon tab is selected, its launcher
//          flyout is open — and unmounts the moment the user looks elsewhere.
//          If the values lived in the component, closing the sidebar would
//          throw away what the user typed and a script patch arriving while
//          the pane is hidden would land on nothing. So the state lives here,
//          the component subscribes (useSyncExternalStore), and the host
//          wiring (scriptPaneHost.ts) feeds patches in and carries inputs out.
// CONTEXT: DOM-free and React-free, so every rule is testable headless. The
//          rules themselves are the FORM's: a patch lands through
//          `landFormPatch` (scriptFormState.ts), the one body the modal form
//          also uses, so the two surfaces cannot disagree about what a patch
//          means. What a pane deliberately lacks is the modal's terminal
//          events: there is no submit and no cancel, only change / click /
//          close — a pane has no answer to give.

import type { FormPatch, FormSeed, FormSpec } from "@api/scriptHost/scriptFormSpec";
import type {
  PaneHostBanner,
  ScriptPaneInputKind,
  ScriptPaneInputPayload,
  ScriptPaneRequestPayload,
} from "@api/scriptHost/scriptPaneSpec";
import {
  collectInputs,
  initialFormValues,
  landFormPatch,
  type FormControlOverride,
  type FormInputWidget,
  type ScriptFormValue,
  type ScriptFormValues,
} from "./scriptFormState";

// ============================================================================
// Types
// ============================================================================

/** The banner a script's `pane.update({ message })` puts above the widgets. */
export type ScriptPaneMessage = { text: string; kind?: "info" | "warning" | "error" };

/** What the section component renders from. Replaced wholesale on every change. */
export interface ScriptPaneSnapshot {
  values: ScriptFormValues;
  controls: Record<string, FormControlOverride>;
  seeds: Record<string, FormSeed>;
  /** Dirty names whose bound cell changed underneath (re-seeded while edited). */
  stale: ReadonlySet<string>;
  message: ScriptPaneMessage | null;
  /** A pending script focus request; `seq` rises per request. */
  focusRequest: { name: string; seq: number } | null;
  /**
   * The HOST's banner (the throttle notice, S6). Its own slot on purpose: it
   * is set only by `setHostBanner`, and `applyPatch` — the one door a script
   * patch comes through — never reads or writes it, so a script that is being
   * slowed down cannot paint "all good" over the sentence that says it is.
   */
  hostBanner: PaneHostBanner | null;
  /**
   * The HOST's BINDINGS notice: why the bound widgets are read-only right now
   * (today, the user has left the sheet the bindings are pinned to). A THIRD
   * slot, for the same reason the second one exists — a script's `message`
   * must not be able to replace it, and clearing it must not delete the
   * script's message — plus one more: it can be up at the same time as the
   * throttle banner, so the two cannot share a slot either.
   */
  hostBindingNotice: PaneHostBanner | null;
}

export interface ScriptPaneStore {
  readonly paneId: string;
  readonly request: ScriptPaneRequestPayload;
  readonly spec: FormSpec;
  readonly inputsByName: ReadonlyMap<string, FormInputWidget>;
  /** useSyncExternalStore pair. */
  subscribe(listener: () => void): () => void;
  getSnapshot(): ScriptPaneSnapshot;
  /** True once the host closed the pane or the user did: nothing leaves after. */
  isClosed(): boolean;
  /** Host -> pane: a script patch and/or refreshed seeds. Emits NOTHING back. */
  applyPatch(detail: { patch?: FormPatch; seeds?: Record<string, FormSeed> }): void;
  /** Host -> pane: the host's OWN banner (a throttle notice); null clears it. Not reachable through a script patch. */
  setHostBanner(banner: PaneHostBanner | null): void;
  /**
   * Host -> pane: the host's BINDINGS notice (off the pinned sheet); null
   * clears it. Not reachable through a script patch either, and clearing it
   * leaves the script's `message` exactly where the script put it. A clear
   * that changes nothing publishes nothing: the host clears unconditionally
   * on every reveal back on the pinned sheet.
   */
  setHostBindingNotice(banner: PaneHostBanner | null): void;
  /** User typed / picked: the widget is touched, the value kept, "change" leaves. */
  change(name: string, value: ScriptFormValue): void;
  /** User pressed a button: "click" leaves with every current value. */
  click(name: string): void;
  /**
   * The surface is ON SCREEN: "visible" leaves. Who decides that differs by
   * surface and deliberately so — a docked pane's section component is mounted
   * exactly while the pane is painted, while an embedded surface's element
   * survives being hidden, so its LAYER reports both edges instead
   * (lib/embeddedFormLayer.ts).
   */
  mounted(): void;
  /** The surface stopped being painted: "hidden" leaves. */
  unmounted(): void;
  /** The USER closed the pane: "close" leaves exactly once. */
  close(): void;
  /** The HOST closed the pane: nothing further leaves, in either direction. */
  dispose(): void;
}

// ============================================================================
// Store
// ============================================================================

/**
 * Build the store for one pane request. `onInput` is where every renderer ->
 * host payload goes (the wiring emits it as SCRIPT_PANE_INPUT_EVENT); the
 * store never emits an app event itself, so it can be driven headless.
 */
export function createScriptPaneStore(
  request: ScriptPaneRequestPayload,
  onInput: (payload: ScriptPaneInputPayload) => void,
): ScriptPaneStore {
  const spec = request.spec;
  const inputsByName = new Map<string, FormInputWidget>();
  for (const { widget } of collectInputs(spec)) inputsByName.set(widget.name, widget);

  // Names the USER has changed — what decides whether a refreshed seed may
  // overwrite a widget. A script patch is not a user edit.
  const touched = new Set<string>();
  const listeners = new Set<() => void>();
  let focusSeq = 0;
  let closed = false;
  let userCloseSent = false;

  let snapshot: ScriptPaneSnapshot = {
    values: initialFormValues(spec, request.seeds),
    controls: {},
    seeds: { ...request.seeds },
    stale: new Set<string>(),
    message: null,
    focusRequest: null,
    hostBanner: null,
    hostBindingNotice: null,
  };

  const publish = (next: ScriptPaneSnapshot): void => {
    snapshot = next;
    for (const l of [...listeners]) l();
  };

  const send = (kind: ScriptPaneInputKind, extra: { name?: string; value?: ScriptFormValue } = {}): void => {
    if (closed) return;
    const payload: ScriptPaneInputPayload = {
      paneId: request.paneId,
      kind,
      ...extra,
      values: snapshot.values,
    };
    onInput(payload);
  };

  return {
    paneId: request.paneId,
    request,
    spec,
    inputsByName,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    isClosed: () => closed,

    applyPatch(detail) {
      if (closed) return;
      const landed = landFormPatch(
        { values: snapshot.values, controls: snapshot.controls, seeds: snapshot.seeds, stale: snapshot.stale },
        detail,
        inputsByName,
        touched,
      );
      let message = snapshot.message;
      let focusRequest = snapshot.focusRequest;
      if (detail.patch) {
        if (detail.patch.message !== undefined) message = detail.patch.message;
        if (detail.patch.focus) {
          focusSeq += 1;
          focusRequest = { name: detail.patch.focus, seq: focusSeq };
        }
      }
      publish({
        values: landed.values,
        controls: landed.controls,
        seeds: landed.seeds,
        stale: landed.stale,
        message,
        focusRequest,
        // Both carried, never derived from the patch: see
        // ScriptPaneSnapshot.hostBanner / .hostBindingNotice.
        hostBanner: snapshot.hostBanner,
        hostBindingNotice: snapshot.hostBindingNotice,
      });
    },

    setHostBanner(banner) {
      if (closed) return;
      publish({ ...snapshot, hostBanner: banner });
    },

    setHostBindingNotice(banner) {
      if (closed) return;
      if (banner === null && snapshot.hostBindingNotice === null) return;
      publish({ ...snapshot, hostBindingNotice: banner });
    },

    change(name, value) {
      if (closed) return;
      touched.add(name);
      let stale = snapshot.stale;
      if (stale.has(name)) {
        const rest = new Set(stale);
        rest.delete(name);
        stale = rest;
      }
      publish({ ...snapshot, values: { ...snapshot.values, [name]: value }, stale });
      send("change", { name, value });
    },

    click(name) {
      send("click", { name });
    },

    mounted() {
      send("visible");
    },

    unmounted() {
      send("hidden");
    },

    close() {
      if (closed || userCloseSent) return;
      userCloseSent = true;
      send("close");
    },

    dispose() {
      closed = true;
      listeners.clear();
    },
  };
}
