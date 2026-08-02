// FILENAME: app/extensions/Distribution/components/inspector/ScriptsSection.tsx
// PURPOSE: Full-source transparency for every line of code the package
//          carries: object scripts (with the SIGNED capability ceiling),
//          module scripts, notebooks, and the Custom Functions library.

import React, { useEffect, useState } from "react";
import {
  inspectorScripts,
  type InspectorOverview,
  type InspectorScripts,
} from "@api/distribution";
import type { CapabilityId } from "@api";
import type { InspectorContext } from "./PackageInspectorApp";
import {
  Badge,
  StatusLine,
  WARN_AMBER,
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
  storage: "store data on this device",
  "ui.html": "render custom HTML UI",
  "formula.udf": "define formula functions",
  "bi.connector": "feed external data into the BI model",
  "ui.dialog": "interrupt you with a dialog and read your answer",
  // Both halves of the .calp collection loop. The publisher half (read
  // everyone's answers, approve/reject them) additionally needs the package
  // signing key, but the phrase must not understate what the grant covers.
  "distribution.writeback":
    "fill in and send the input cells of a subscribed package — and, for a package it can sign, read and approve everyone else's answers",
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
  // only warning a reviewer gets that a package installs a key hook at all.
  // It therefore names the taking AND the two bounds that keep it from being
  // Application.OnKey: it cannot take keys the app needs, and it sees nothing
  // else you type.
  "ui.shortcut":
    "take over one Ctrl+Shift+letter keyboard shortcut so pressing it runs its code — never a shortcut Calcula needs or something else already uses, and it never sees anything else you type",
  // Reviewed WITHOUT running anything, so this line may be the only warning
  // that a package hands somebody else's code the contents of the workbook it
  // lands in. It names the push ("is shown"), because nothing in the code reads
  // as a cell read: the host volunteers the values.
  "grid.read":
    "be shown the contents of your cells — the displayed value of every cell on screen when it styles them, and the old value, new value and formula of every cell that changes",
  "distribution.publish":
    "publish workbooks to your package registries, signed with YOUR publisher key — only to registries you added, and only if you already have a publisher identity",
  "distribution.subscribe":
    "pull other packages into the workbook and refresh the ones it subscribes to — only from registries you added, verified exactly as an interactive subscribe is",
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
        <StatusLine empty emptyText="This package carries no scripts, notebooks, or custom functions." />
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
                Merged per-function at pull; a package can never widen the subscriber&apos;s
                capability ceiling. Full library JSON: Artifacts &amp; Integrity.
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
