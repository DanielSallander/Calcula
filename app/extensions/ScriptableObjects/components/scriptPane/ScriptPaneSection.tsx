//! FILENAME: app/extensions/ScriptableObjects/components/scriptPane/ScriptPaneSection.tsx
// PURPOSE: The TRUSTED renderer for a script TASK PANE (M2) — the MODELESS
//          sibling of ScriptFormDialog.tsx. It paints the SAME data-only widget
//          tree (FormWidgetTree, one module, no second copy) inside a panel
//          section the Shell hosts through `registerPanel`, so the pane lives
//          in the sidebar or on the ribbon like any extension panel and never
//          blocks the grid. The script sends DATA only; this component paints
//          it with app tokens and reports what the user did through the pane
//          store, which the host wiring (lib/scriptPaneHost.ts) carries to the
//          registry over ONE data-only event.
//
// SECURITY: the identity band is chrome the script cannot address — it states
// which script is asking and where it came from (local, or the application it
// arrived in), and which sheet its bindings are pinned to. A script-supplied
// title is body content below that band, so a pane can never present itself
// as the application or as another script.
//
// WHAT A PANE DOES NOT DO THAT THE FORM DOES: it takes no focus when it opens
// (the user is working in the grid; a modeless surface must not pull them out
// of it), reports no "interaction" (there is no idle deadline to re-arm), and
// has no submit — a button with `role: "cancel"` closes the pane as the user
// would, every other button is a "click". A script's `focus` patch moves focus
// ONLY while focus is already inside the pane: a script may steer the user
// between its own widgets, never pull them out of a cell they are editing.

import React, { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useSurfaceLayout } from "@api/layout";
import { dirtySet, type ScriptFormValue, type WidgetOf } from "../../lib/scriptFormState";
import type { ScriptPaneStore } from "../../lib/scriptPaneStore";
import { FormWidgetTree, type FormRenderContext } from "../scriptForm/FormWidgetTree";
import { HostNoticeBanner, ScriptGlyphSvg, findFormWidgetFocusable, originPhrase } from "../scriptForm/hostChrome";
import * as S from "./ScriptPaneSection.styles";

/** The widget-tree width when the surface has not reported one yet (jsdom, first paint). */
const DEFAULT_PANE_CONTENT_WIDTH = 296;
/** The narrowest column the primitives are laid out against. */
const MIN_PANE_CONTENT_WIDTH = 200;
/** PaneBody's horizontal padding, both sides. */
const PANE_BODY_PADDING = 24;

const NO_ERRORS: Record<string, string> = {};
const noop = (): void => {};

// The host's own notices (S6 throttle ladder, the bindings notice) are painted
// by `HostNoticeBanner` in hostChrome.tsx — ONE definition for every modeless
// surface, so the pane and the form embedded on a sheet cannot drift on the one
// rule that matters here: a script can neither clear the sentence that says
// what it is doing nor have the host's clear delete the message it put up.

// ============================================================================
// The view
// ============================================================================

export interface ScriptPaneViewProps {
  store: ScriptPaneStore;
  /** The panel host's close (forwarded in the sidebar); called AFTER the registry is told. */
  onHostClose?: () => void;
}

export function ScriptPaneView({ store, onHostClose }: ScriptPaneViewProps): React.ReactElement {
  const { request, spec, paneId } = store;
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const layout = useSurfaceLayout();
  const rootRef = useRef<HTMLDivElement>(null);

  // On screen <-> off screen is what the host's visibility-gated cell watch
  // keys on, and this component is mounted exactly while the pane is painted.
  useEffect(() => {
    store.mounted();
    return () => store.unmounted();
  }, [store]);

  const width = useMemo(() => {
    if (layout.width > 0) return Math.max(MIN_PANE_CONTENT_WIDTH, layout.width - PANE_BODY_PADDING);
    return DEFAULT_PANE_CONTENT_WIDTH;
  }, [layout.width]);

  const dirty = useMemo(
    () => dirtySet(snapshot.values, snapshot.seeds, spec),
    [snapshot.values, snapshot.seeds, spec],
  );

  const onValueChange = useCallback(
    (name: string, value: ScriptFormValue) => {
      store.change(name, value);
    },
    [store],
  );

  // The one user-owned close: tell the registry FIRST (it ends the session and
  // the wiring takes the panel down on the CLOSE it answers with), then let
  // the panel host collapse the sidebar view.
  const closeByUser = useCallback(() => {
    store.close();
    onHostClose?.();
  }, [store, onHostClose]);

  const onButton = useCallback(
    (widget: WidgetOf<"button">) => {
      if (store.isClosed()) return;
      if ((widget.role ?? "default") === "cancel") closeByUser();
      else store.click(widget.name);
    },
    [store, closeByUser],
  );

  // ---- Focus requests (script patch) — contained ----
  // Runs after EVERY render while a request is outstanding: the widget may sit
  // on a tab page that TabStrip is only now bringing forward. Consumed through
  // a ref (its sequence number), never by setting state from inside the effect.
  const consumedFocusSeq = useRef(0);
  useEffect(() => {
    const req = snapshot.focusRequest;
    if (!req || req.seq === consumedFocusSeq.current) return;
    const root = rootRef.current;
    if (!root) return;
    // CONTAINMENT: a modeless pane may move focus between its own widgets,
    // never pull it out of the grid or another surface. The request is
    // consumed either way so it cannot lie in wait for the user's next click.
    const active = typeof document !== "undefined" ? document.activeElement : null;
    if (!active || !root.contains(active)) {
      consumedFocusSeq.current = req.seq;
      return;
    }
    const lookup = findFormWidgetFocusable(root, req.name);
    if (lookup.kind === "unsafe") {
      consumedFocusSeq.current = req.seq;
      return;
    }
    if (lookup.kind === "missing") return;
    lookup.focusable?.focus();
    consumedFocusSeq.current = req.seq;
  });

  // THE ONE LINE A PANE MUST NOT BE ABLE TO CHOOSE: the branch is on `kind`,
  // never on a name (see ScriptFormDialog.tsx for the impersonation it stops).
  const provenance = `A task pane from ${originPhrase(request.origin)}`;
  const bandId = `script-pane-band-${paneId}`;

  const ctx: FormRenderContext = {
    showId: paneId,
    values: snapshot.values,
    controls: snapshot.controls,
    seeds: snapshot.seeds,
    errors: NO_ERRORS,
    dirty,
    stale: snapshot.stale,
    // Never on open: the user is working in the grid.
    autoFocusName: null,
    focusRequest: snapshot.focusRequest,
    // A pane is never "pending": there is no submit for the host to decide on.
    locked: false,
    onValueChange,
    onButton,
    // No idle deadline to re-arm.
    onInteraction: noop,
  };

  const message = snapshot.message;

  return (
    <S.PaneRoot ref={rootRef} role="region" aria-labelledby={bandId} data-script-pane={paneId}>
      {/* Attribution band — chrome, and the one thing a script cannot
          influence: every line here is host-derived. */}
      <S.Band>
        <S.ScriptGlyph>{ScriptGlyphSvg}</S.ScriptGlyph>
        <S.HeaderText id={bandId} data-script-pane-band="">
          <S.AskedBy>{request.scriptName}</S.AskedBy>
          <S.Provenance>{provenance}</S.Provenance>
          {request.pinnedSheetName ? <S.Provenance>{`Sheet: ${request.pinnedSheetName}`}</S.Provenance> : null}
        </S.HeaderText>
        <S.CloseButton
          type="button"
          onClick={closeByUser}
          title="Close pane"
          aria-label="Close pane"
          data-script-pane-close=""
        >
          X
        </S.CloseButton>
      </S.Band>

      <S.PaneBody>
        {/* Host chrome, like the band: the script's own message is BELOW it
            and cannot displace it (its own store slot, its own patch field). */}
        {snapshot.hostBanner ? (
          <HostNoticeBanner
            key={snapshot.hostBanner.until ?? "steady"}
            banner={snapshot.hostBanner}
            slot="host-banner"
            surface="pane"
          />
        ) : null}
        {snapshot.hostBindingNotice ? (
          <HostNoticeBanner banner={snapshot.hostBindingNotice} slot="binding-notice" surface="pane" />
        ) : null}
        {spec.title ? <S.ScriptTitle data-script-pane-title="">{spec.title}</S.ScriptTitle> : null}
        {spec.description ? <S.Message>{spec.description}</S.Message> : null}
        {message ? (
          <S.MessageBanner
            $kind={message.kind ?? "info"}
            role={message.kind === "error" ? "alert" : "status"}
            data-script-pane-message=""
          >
            {message.text}
          </S.MessageBanner>
        ) : null}
        <FormWidgetTree widgets={spec.children} ctx={ctx} width={width} />
      </S.PaneBody>
    </S.PaneRoot>
  );
}
