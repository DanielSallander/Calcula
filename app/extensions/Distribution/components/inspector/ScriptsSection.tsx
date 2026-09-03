// FILENAME: app/extensions/Distribution/components/inspector/ScriptsSection.tsx
// PURPOSE: Full-source transparency for every line of code the application
//          carries: object scripts (with the SIGNED capability ceiling),
//          module scripts, notebooks, and the Custom Functions library.
//          A FORM script additionally offers "Preview layout": the same code,
//          painted, because a reviewer deciding whether to trust a form is
//          deciding about a DIALOG and cannot see one in a wall of emitted
//          JavaScript.

import React, { useEffect, useState, useSyncExternalStore } from "react";
import {
  inspectorScripts,
  type InspectorObjectScriptDetail,
  type InspectorOverview,
  type InspectorScripts,
} from "@api/distribution";
import type { CapabilityId } from "@api";
import {
  inspectorPreviewKey,
  inspectorPreviewStateFor,
  requestInspectorFormPreview,
  subscribeToInspectorPreviews,
} from "../../lib/inspectorFormPreview";
import type { InspectorContext } from "./ApplicationInspectorApp";
import {
  Badge,
  ERR_RED,
  MUTED,
  StatusLine,
  WARN_AMBER,
  buttonStyle,
  cardHeaderStyle,
  cardStyle,
  mutedStyle,
  preStyle,
  sectionTitleStyle,
} from "./shared";

/**
 * Short human phrase for a declared capability id (R19). Typed
 * `Record<CapabilityId, string>` so a new capability that forgets its phrase
 * fails the build instead of showing the user a bare id.
 */
const CAPABILITY_PHRASE: Record<CapabilityId, string> = {
  "net.fetch": "fetch data from the web",
  "bi.query": "run read-only BI queries",
  "bi.sql": "run raw read-only SQL against the BI database",
  // bi.model is a MUTATION capability (upsert/delete definitions) — reading the
  // model is what bi.query buys. Saying "read" here understated the reach.
  "bi.model": "change the BI model definitions (measures, relationships, ...)",
  // NOT "store data on this device": the store is the workbook's own virtual
  // filesystem (.calcula/script-data/<scriptId>.json — scriptHost/host.ts), so
  // it travels inside the .cala to everyone the file is sent to. Word for word
  // the same phrase as @api/scriptHost/capabilities.ts and SubscribeDialog.tsx.
  storage:
    "store its own private data inside this workbook file (up to 256 KB; it travels with the file if you share it)",
  "ui.html": "render custom HTML UI",
  "formula.udf": "define formula functions",
  "bi.connector": "feed external data into the BI model",
  "ui.dialog": "interrupt you with a dialog and read your answer",
  // Both halves of the .calp collection loop. The publisher half (read
  // everyone's answers, approve/reject them) additionally needs the application's
  // signing key, but the phrase must not understate what the grant covers.
  "distribution.writeback":
    "fill in and send the input cells of a subscribed application — and, for an application it can sign, read and approve everyone else's answers",
  // The only capability whose effects OUTLIVE the session that consented to it:
  // the job is saved in the workbook and resumes on reopen. The phrase must say
  // both halves (unattended + persisted) or the inspector understates the reach.
  schedule:
    "run itself on a schedule while Calcula is open, without anyone starting it — saved in this workbook, so it resumes after a reload",
  // Both directions, and the limit that bounds them. Saying only "read and
  // write files" would describe ambient filesystem access; the picker is what
  // makes this not that, so it belongs in the same sentence.
  "file.picker":
    "ask you to pick a file to save data into or to read — one file per ask, chosen by you, and it is never told where your files are",
  // The inspector is read WITHOUT running anything, so this line is often the
  // only warning a reviewer gets that an application installs a key hook at all.
  // It therefore names the taking AND the two bounds that keep it from being
  // Application.OnKey: it cannot take keys the app needs, and it sees nothing
  // else you type.
  "ui.shortcut":
    "take over one Ctrl+Shift+letter keyboard shortcut so pressing it runs its code — never a shortcut Calcula needs or something else already uses, and it never sees anything else you type",
  // Reviewed WITHOUT running anything, so this line may be the only warning
  // that an application hands somebody else's code the contents of the workbook it
  // lands in. It names the push ("is shown"), because nothing in the code reads
  // as a cell read: the host volunteers the values.
  "grid.read":
    "be shown the contents of your cells — the displayed value of every cell on screen when it styles them, and the old value, new value and formula of every cell that changes",
  "distribution.publish":
    "publish workbooks to your workspaces, signed with YOUR publisher key — only to workspaces you added, and only if you already have a publisher identity",
  "distribution.subscribe":
    "pull other applications into the workbook and refresh the ones it subscribes to — only from workspaces you added, verified exactly as an interactive subscribe is",
};

function CapabilityBadges({ capabilities }: { capabilities: string[] }): React.ReactElement {
  if (capabilities.length === 0)
    return <span style={{ ...mutedStyle, fontSize: 11 }}>no capabilities — grid access only</span>;
  return (
    <span>
      {capabilities.map((c) => (
        <Badge key={c} color={WARN_AMBER}>
          {c}
          {CAPABILITY_PHRASE[c as CapabilityId] ? ` — ${CAPABILITY_PHRASE[c as CapabilityId]}` : ""}
        </Badge>
      ))}
    </span>
  );
}

function SourceBlock({ source }: { source: string }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const lines = source.split("\n").length;
  return (
    <div style={{ marginTop: 6 }}>
      <a
        style={{ fontSize: 12, color: "#0f6cbd", cursor: "pointer", textDecoration: "underline" }}
        onClick={() => setOpen(!open)}
      >
        {open ? "Hide source" : `Show source (${lines} lines)`}
      </a>
      {open && <pre style={preStyle}>{source || "(empty)"}</pre>}
    </div>
  );
}

// ============================================================================
// "Preview layout" — for a FORM script only
// ============================================================================

/**
 * WHAT THE REVIEWER IS TOLD BEFORE THEY CLICK.
 *
 * Three earlier sentences were replaced here, each because it was false or
 * incomplete in a way that mattered:
 *
 *  1. "Nothing is run" was not true. Drawing the layout means EXECUTING this
 *     application's `setup` — unconsented code — in the preview rung. What is
 *     true is the surrounding sentence: it runs with an empty capability
 *     ceiling, nothing is mounted, the backend is a throwaway copy of the
 *     active sheet, and no grant, write or audit row survives it. A reviewer
 *     told "nothing is run" would have been consenting to something they were
 *     told was not happening.
 *  2. It never said WHERE the dialog appears. It appears in the main Calcula
 *     window, behind this one — an unexplained form surfacing behind the window
 *     you are reading is worse than no feature at all.
 *  3. It let the "form" label carry the safety argument. It does not; see the
 *     gate's own comment at the call site.
 */
const PREVIEW_IDLE_HINT =
  "Draws the dialog this script would open — in the main Calcula window, behind this one. " +
  "To draw it, this application's setup code IS RUN, in the sandboxed preview realm: no " +
  "capabilities, nothing mounted, and a throwaway copy of your active sheet. Nothing is " +
  "granted, written or saved.";

/**
 * Ask the MAIN window to paint a distributed form's layout, and report inline.
 *
 * THE CALL DOES NOT HAPPEN HERE, AND CANNOT. This component runs in the
 * standalone Application Inspector window, which mounts no Shell and therefore
 * activates no extensions — so nothing in it listens for the form-request app
 * event that `previewFormLayout` ends in. Calling it from this window painted
 * nothing and then failed on the renderer's ack timeout. The request crosses to
 * the main window instead (lib/inspectorFormPreview.ts), which runs the preview,
 * paints it, and sends the outcome back.
 *
 * Every refusal lands INLINE beside the action — a held modal slot, a script
 * that never called `form.define`, a realm that threw, a main window that never
 * answered. Never a dialog (this window is a reader, and a modal about a modal
 * is absurd), and never silence.
 */
function FormPreviewAction({
  script,
  packageName,
}: {
  script: InspectorObjectScriptDetail;
  packageName: string;
}): React.ReactElement {
  const key = inspectorPreviewKey(packageName, script.id);
  // The status lives in the module store, not in this component: the run
  // outlives a section switch (two passes through a Worker realm in another
  // window) and the inspector unmounts sections freely.
  const state = useSyncExternalStore(subscribeToInspectorPreviews, () =>
    inspectorPreviewStateFor(key),
  );
  const busy = state.phase === "running";

  return (
    <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
      <button
        type="button"
        style={busy ? { ...buttonStyle, cursor: "default", opacity: 0.6 } : buttonStyle}
        disabled={busy}
        onClick={() => {
          if (busy) return;
          requestInspectorFormPreview({
            packageName,
            scriptId: script.id,
            scriptName: script.name,
            source: script.source,
          });
        }}
      >
        {busy ? "Previewing…" : "Preview layout"}
      </button>
      {state.phase !== "idle" && (
        <span
          style={{
            fontSize: 11,
            color: state.phase === "failed" ? ERR_RED : MUTED,
            flex: "1 1 240px",
          }}
        >
          {state.message}
        </span>
      )}
      {state.phase === "idle" && (
        <span style={{ ...mutedStyle, fontSize: 11, flex: "1 1 240px" }}>{PREVIEW_IDLE_HINT}</span>
      )}
    </div>
  );
}

export function ScriptsSection({
  ctx,
  overview,
}: {
  ctx: InspectorContext;
  overview: InspectorOverview;
}): React.ReactElement {
  const [data, setData] = useState<InspectorScripts | null>(null);
  const [error, setError] = useState<string | null>(null);

  const hasAny =
    overview.objectScripts.length +
      overview.moduleScripts.length +
      overview.notebooks.length +
      overview.customFunctionCount >
    0;

  useEffect(() => {
    if (!hasAny) return;
    inspectorScripts(ctx.registryPath, ctx.packageName, ctx.version)
      .then(setData)
      .catch((err) => setError(String(err)));
  }, [ctx, hasAny]);

  if (!hasAny) {
    return (
      <div>
        <h2 style={sectionTitleStyle}>Scripts &amp; Code</h2>
        <StatusLine empty emptyText="This application carries no scripts, notebooks, or custom functions." />
      </div>
    );
  }

  return (
    <div>
      <h2 style={sectionTitleStyle}>Scripts &amp; Code</h2>
      <StatusLine error={error} loading={!data && !error} />
      {data && (
        <>
          {data.objectScripts.length > 0 && (
            <div style={cardStyle}>
              <div style={cardHeaderStyle}>Object scripts ({data.objectScripts.length})</div>
              <div style={{ ...mutedStyle, fontSize: 11, marginBottom: 8 }}>
                Pulled scripts always run Restricted and consent-gated; their capability
                ceiling comes from the signed manifest shown here, never from the source.
                The &ldquo;on &lt;type&gt;&rdquo; label below is the publisher&apos;s own
                declaration about a script, not a boundary Calcula enforces on it.
              </div>
              {data.objectScripts.map((s) => (
                <div key={s.id} style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 13 }}>
                    <b>{s.name}</b>{" "}
                    <span style={mutedStyle}>
                      on {s.objectType}
                      {s.instanceId ? ` (${s.instanceId})` : ""}
                    </span>
                  </div>
                  {s.description && (
                    <div style={{ ...mutedStyle, fontSize: 12 }}>{s.description}</div>
                  )}
                  <div style={{ marginTop: 4 }}>
                    <CapabilityBadges capabilities={s.capabilities} />
                  </div>
                  <SourceBlock source={s.source} />
                  {/*
                    FORMS ONLY — AND THIS IS A RELEVANCE FILTER, NOT A SECURITY
                    BOUNDARY. `objectType` is a field the PUBLISHER wrote into
                    their own manifest; a package that wants its setup code run
                    in the preview rung need only spell "form" here. So nothing
                    downstream may rely on this test having been true.

                    What actually bounds the run is the rung itself
                    (`previewFormLayout` -> `previewObjectScript` ->
                    `buildPreviewHandle`): an EMPTY declared-capability ceiling
                    and empty grants, so every capability-bearing call is
                    refused before the grant check is even reached; no mount, no
                    registration, no persisted grants inherited from an earlier
                    "Always"; a throwaway copy of the active sheet as the entire
                    backend; and no audit rows, because a preview is not
                    something the workbook had done to it. Those hold for ANY
                    source, whatever it calls itself.

                    The gate is here because a preview is only WORTH offering
                    for the one object type whose whole product is a picture the
                    reviewer cannot otherwise see. Every other type keeps
                    exactly the source block it has always had.
                  */}
                  {s.objectType === "form" && (
                    <FormPreviewAction script={s} packageName={ctx.packageName} />
                  )}
                </div>
              ))}
            </div>
          )}

          {data.moduleScripts.length > 0 && (
            <div style={cardStyle}>
              <div style={cardHeaderStyle}>Module scripts ({data.moduleScripts.length})</div>
              <div style={{ ...mutedStyle, fontSize: 11, marginBottom: 8 }}>
                Inert data — never auto-executed; they run only on explicit user action in
                the sandboxed interpreter.
              </div>
              {data.moduleScripts.map((s) => (
                <div key={s.id} style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 13 }}>
                    <b>{s.name}</b> <span style={mutedStyle}>scope: {s.scope}</span>
                  </div>
                  {s.description && (
                    <div style={{ ...mutedStyle, fontSize: 12 }}>{s.description}</div>
                  )}
                  <SourceBlock source={s.source} />
                </div>
              ))}
            </div>
          )}

          {data.notebooks.length > 0 && (
            <div style={cardStyle}>
              <div style={cardHeaderStyle}>Notebooks ({data.notebooks.length})</div>
              <div style={{ ...mutedStyle, fontSize: 11, marginBottom: 8 }}>
                Source only — execution outputs are stripped at publish.
              </div>
              {data.notebooks.map((n) => (
                <div key={n.id} style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 13 }}>
                    <b>{n.name}</b>{" "}
                    <span style={mutedStyle}>({n.cells.length} cells)</span>
                  </div>
                  <SourceBlock
                    source={n.cells
                      .map((c, i) => `// --- cell ${i + 1} ---\n${c.source}`)
                      .join("\n\n")}
                  />
                </div>
              ))}
            </div>
          )}

          {data.customFunctions && (
            <div style={cardStyle}>
              <div style={cardHeaderStyle}>
                Custom Functions library ({data.customFunctions.functionNames.length})
              </div>
              <div style={{ fontSize: 12 }}>
                Functions:{" "}
                <span style={{ fontFamily: "Consolas, monospace", fontSize: 11 }}>
                  {data.customFunctions.functionNames.join(", ") || "(none)"}
                </span>
              </div>
              <div style={{ marginTop: 4 }}>
                <CapabilityBadges capabilities={data.customFunctions.capabilities} />
              </div>
              <div style={{ ...mutedStyle, fontSize: 11, marginTop: 4 }}>
                Merged per-function at pull; an application can never widen the subscriber&apos;s
                capability ceiling. Full library JSON: Artifacts &amp; Integrity.
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
