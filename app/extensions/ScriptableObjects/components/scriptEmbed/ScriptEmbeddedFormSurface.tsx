//! FILENAME: app/extensions/ScriptableObjects/components/scriptEmbed/ScriptEmbeddedFormSurface.tsx
// PURPOSE: The TRUSTED renderer for a form EMBEDDED on a sheet (M3c) — the
//          third surface for the ONE data-only widget tree, beside the modal
//          dialog (ScriptFormDialog.tsx) and the task pane
//          (../scriptPane/ScriptPaneSection.tsx). It paints `FormWidgetTree`
//          from that one module, wears the same host chrome, and reports what
//          the user did through the SAME `ScriptPaneStore` the pane uses, so
//          the three surfaces cannot disagree about what a patch means, what a
//          seed means, or who wrote a sentence on screen.
//
// SECURITY: the identity band is chrome the script cannot address — which
// script is asking, where it came from (local, or the application it arrived
// in), and which sheet its bindings are pinned to. A script-supplied title is
// body content BELOW that band, so a form on the grid can never present itself
// as Calcula or as another script. `originPhrase` branches on `kind`, never on
// a name.
//
// WHAT THIS SURFACE HAS THAT THE OTHER TWO DO NOT:
//   - AN ORPHAN STATE. Its placement is anchored to a cell; when a structural
//     edit deletes that cell the placement is orphaned rather than dropped
//     (`embeddedFormPlacements.ts`), and this paints the orphan — a red-edged
//     card saying what happened and what the user can do — because a surface
//     that simply vanished would take the user's layout with it and say
//     nothing. The colour is the one the cell-behaviour orphan badge already
//     uses (lib/cellBehaviorUx.ts), so an orphan looks the same everywhere.
//   - A REFUSAL STATE. The host answers `openEmbeddedScriptForm` with a
//     sentence when it cannot run the form (the script is not mounted, it has
//     not described a layout yet). An empty box would be indistinguishable from
//     a crashed script.
//   - NO CLOSE AFFORDANCE. A script cannot close this surface (`pane.close` is
//     refused for it) and neither can the band: the object belongs to the
//     sheet, and the user removes it there. A close button that took the
//     surface down but left the object would be two truths in one document.
//   - THE BADGE IN THE BAND. `pane.setBadge` puts a short badge on a docked
//     pane's TAB; an embedded surface has no tab, so the badge is painted here,
//     set apart from the host-derived text and bounded to 8 characters by the
//     wire row.

import React, { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { EMBEDDED_FORM_ORPHAN_REMEDY } from "@api/scriptHost/embeddedFormPlacements";
import { dirtySet, type ScriptFormValue, type WidgetOf } from "../../lib/scriptFormState";
import type { ScriptPaneStore } from "../../lib/scriptPaneStore";
import { FormWidgetTree, type FormRenderContext } from "../scriptForm/FormWidgetTree";
import { HostNoticeBanner, ScriptGlyphSvg, findFormWidgetFocusable, originPhrase } from "../scriptForm/hostChrome";
import * as S from "./ScriptEmbeddedFormSurface.styles";

/** The widget-tree width when the placement has not reported a box yet. */
const DEFAULT_EMBED_CONTENT_WIDTH = 296;
/** The narrowest column the widget primitives are laid out against. */
const MIN_EMBED_CONTENT_WIDTH = 160;
/** EmbedBody's horizontal padding, both sides. */
const EMBED_BODY_PADDING = 20;

const NO_ERRORS: Record<string, string> = {};
const noop = (): void => {};

/**
 * What the surface is showing. THREE states, not one plus two error flags: an
 * orphan and a refusal have no session and therefore no store, and typing them
 * as "a store that might be null" is how a renderer ends up reading values off
 * a surface that never opened.
 */
export type EmbeddedFormViewState =
  /** A live session: the script's widget tree, driven by the shared pane store. */
  | { kind: "open"; store: ScriptPaneStore }
  /** The anchor cell was deleted. The placement survives; nothing runs in it. */
  | { kind: "orphaned"; scriptName: string | null }
  /** The host could not open a session, and said why in a sentence for the user. */
  | { kind: "refused"; scriptName: string | null; reason: string };

export interface ScriptEmbeddedFormViewProps {
  /** The placement this surface paints — its minted UUID, stable across structural edits. */
  placementId: string;
  state: EmbeddedFormViewState;
  /** The badge the script pinned (`pane.setBadge`); an embedded surface has no tab to carry it. */
  badge?: string | null;
  /** The placement's box width in CSS pixels, for the widget tree's layout. */
  width?: number;
}

export function ScriptEmbeddedFormView({
  placementId,
  state,
  badge = null,
  width,
}: ScriptEmbeddedFormViewProps): React.ReactElement {
  if (state.kind === "open") {
    return <OpenEmbeddedForm placementId={placementId} store={state.store} badge={badge} width={width} />;
  }
  const orphaned = state.kind === "orphaned";
  const who = state.scriptName ? `"${state.scriptName}"` : "This form";
  return (
    <S.EmbedRoot $orphaned={orphaned} role="group" data-script-embed={placementId} data-script-embed-inert="">
      {orphaned ? (
        <S.OrphanNotice role="status" data-script-embed-orphan="">
          {/* THE REMEDY IS NOT WRITTEN HERE. It is the one constant the inert
              sentence (`lib/scriptEmbedHost.ts`) and the host's refusal
              (`openEmbeddedScriptForm`) also read — because this card said
              "drag it onto a cell to put it back" while nothing in the app
              could drag it, and the gesture that does work (the grid menu on
              the anchor cell) was named on none of the three. */}
          {`${who} is not running: the cell it was anchored to was deleted. ` +
            `It is still in this workbook. ${EMBEDDED_FORM_ORPHAN_REMEDY}`}
        </S.OrphanNotice>
      ) : (
        <S.RefusalNotice role="status" data-script-embed-refusal="">
          {state.reason}
        </S.RefusalNotice>
      )}
    </S.EmbedRoot>
  );
}

/**
 * The live surface. Deliberately the SAME body as the task pane's, minus the
 * three things a pane has that this cannot: a close affordance, a placement,
 * and a panel around it.
 */
function OpenEmbeddedForm({
  placementId,
  store,
  badge,
  width,
}: {
  placementId: string;
  store: ScriptPaneStore;
  badge: string | null;
  width?: number;
}): React.ReactElement {
  const { request, spec, paneId } = store;
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const rootRef = useRef<HTMLDivElement>(null);

  // NO MOUNT-DRIVEN VISIBILITY REPORT HERE, unlike the task pane's section.
  // The host's cell watch is gated on "visible"/"hidden", and this component is
  // NOT mounted exactly while the placement is painted: the layer hides a
  // surface with `display: none` and keeps the element and this React root
  // alive (lib/embeddedFormLayer.ts), so a `store.mounted()` here armed the
  // watch once and never took it down — a form scrolled out of the viewport
  // went on being fed the user's cell edits, with an audit entry per read, for
  // a surface nobody could see. The layer reports both edges from the same
  // branch that writes `display`.

  const contentWidth = useMemo(() => {
    if (typeof width === "number" && width > 0) {
      return Math.max(MIN_EMBED_CONTENT_WIDTH, width - EMBED_BODY_PADDING);
    }
    return DEFAULT_EMBED_CONTENT_WIDTH;
  }, [width]);

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

  // A `role: "cancel"` button on an embedded surface is a CLICK like any other.
  // On a pane it closes the surface; here there is nothing to close — the object
  // stays on the sheet — so treating it as a close would leave a dead box the
  // user cannot get rid of except by deleting the object. The script hears the
  // click and decides.
  const onButton = useCallback(
    (widget: WidgetOf<"button">) => {
      if (store.isClosed()) return;
      store.click(widget.name);
    },
    [store],
  );

  // ---- Focus requests (script patch) — contained ----
  // Same rule as the pane, and it matters more here: the surface sits ON the
  // grid, so a focus request that could reach out would pull the user out of
  // the cell they are editing, two centimetres away.
  const consumedFocusSeq = useRef(0);
  useEffect(() => {
    const req = snapshot.focusRequest;
    if (!req || req.seq === consumedFocusSeq.current) return;
    const root = rootRef.current;
    if (!root) return;
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

  // THE ONE LINE A SCRIPT MUST NOT BE ABLE TO CHOOSE: the branch is on `kind`,
  // never on a name (see ScriptFormDialog.tsx for the impersonation it stops).
  const provenance = `A form on this sheet from ${originPhrase(request.origin)}`;
  const bandId = `script-embed-band-${paneId}`;

  const ctx: FormRenderContext = {
    showId: paneId,
    values: snapshot.values,
    controls: snapshot.controls,
    seeds: snapshot.seeds,
    errors: NO_ERRORS,
    dirty,
    stale: snapshot.stale,
    // Never on open: the user is working in the grid, and this surface is IN it.
    autoFocusName: null,
    focusRequest: snapshot.focusRequest,
    // Never "pending": there is no submit for the host to decide on.
    locked: false,
    onValueChange,
    onButton,
    // No idle deadline to re-arm.
    onInteraction: noop,
  };

  const message = snapshot.message;

  return (
    <S.EmbedRoot
      ref={rootRef}
      $orphaned={false}
      role="region"
      aria-labelledby={bandId}
      data-script-embed={placementId}
      data-script-embed-pane={paneId}
    >
      {/* Attribution band — chrome, and the one thing a script cannot
          influence: every line here is host-derived. */}
      <S.Band>
        <S.ScriptGlyph>{ScriptGlyphSvg}</S.ScriptGlyph>
        <S.HeaderText id={bandId} data-script-embed-band="">
          <S.AskedBy>{request.scriptName}</S.AskedBy>
          <S.Provenance>{provenance}</S.Provenance>
          {request.pinnedSheetName ? <S.Provenance>{`Sheet: ${request.pinnedSheetName}`}</S.Provenance> : null}
        </S.HeaderText>
        {badge ? <S.Badge data-script-embed-badge="">{badge}</S.Badge> : null}
      </S.Band>

      <S.EmbedBody>
        {/* Host chrome, like the band: the script's own message is BELOW it and
            cannot displace it (its own store slot, its own patch field). */}
        {snapshot.hostBanner ? (
          <HostNoticeBanner
            key={snapshot.hostBanner.until ?? "steady"}
            banner={snapshot.hostBanner}
            slot="host-banner"
            surface="embed"
          />
        ) : null}
        {snapshot.hostBindingNotice ? (
          <HostNoticeBanner banner={snapshot.hostBindingNotice} slot="binding-notice" surface="embed" />
        ) : null}
        {spec.title ? <S.ScriptTitle data-script-embed-title="">{spec.title}</S.ScriptTitle> : null}
        {spec.description ? <S.Message>{spec.description}</S.Message> : null}
        {message ? (
          <S.MessageBanner
            $kind={message.kind ?? "info"}
            role={message.kind === "error" ? "alert" : "status"}
            data-script-embed-message=""
          >
            {message.text}
          </S.MessageBanner>
        ) : null}
        <FormWidgetTree widgets={spec.children} ctx={ctx} width={contentWidth} />
      </S.EmbedBody>
    </S.EmbedRoot>
  );
}
