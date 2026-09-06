// FILENAME: app/extensions/Distribution/components/inspector/OverviewSection.tsx
// PURPOSE: Landing view — application identity, verified publisher + trust state,
//          version history, a content census, and the policy-exclusion
//          disclosure (what a .calp can NEVER carry).

import React, { useEffect, useState } from "react";
import type {
  CalpTrustStatus,
  EnvironmentsResponse,
  InspectorOverview,
} from "@api/distribution";
import { listEnvironments } from "@api/distribution";
import { environmentsAtVersion } from "../../lib/environments";
import {
  Badge,
  KV,
  OK_GREEN,
  WARN_AMBER,
  cardHeaderStyle,
  cardStyle,
  mutedStyle,
  sectionTitleStyle,
  tableStyle,
  tdStyle,
  thStyle,
} from "./shared";

const DANGER_RED = "#c5221f";

/**
 * Trust badge per `CalpTrustStatus`. A TABLE, not a ternary.
 *
 * This used to be `trustStatus === "verified" ? green : amber "first use — key
 * newly pinned"`. Inspecting an application no longer pins anything, so that else
 * branch would now assert a pin that does not exist — telling the user they had
 * trusted a publisher they had not. Worse, the same shape is what let an
 * unrecognised signer render as reassuring elsewhere.
 *
 * Typed `Record<CalpTrustStatus, ...>`: a new Rust `TrustStatus` variant fails
 * type-checking here until it has been given a presentation.
 */
const TRUST_BADGE: Record<CalpTrustStatus, { label: string; color: string; title: string }> = {
  verified: {
    label: "signature verified — publisher trusted",
    color: OK_GREEN,
    title:
      "Signed by the same publisher key you pinned when you subscribed to this application.",
  },
  trustedDelegate: {
    label: "signature verified — co-publisher",
    color: OK_GREEN,
    title:
      "Signed by a co-publisher the publisher you pinned authorized. The authority still traces to the key you trusted; somebody they vouched for did the publishing.",
  },
  firstUse: {
    label: "trusted just now — key pinned",
    color: WARN_AMBER,
    title:
      "This publisher key was recorded as trusted by this operation (trust-on-first-use).",
  },
  firstUseKnownPublisher: {
    label: "trusted just now — same publisher as another workspace",
    color: WARN_AMBER,
    title:
      "This workspace was not trusted for this application before, but the SAME publisher key is " +
      "already trusted for this application name from another workspace — a move, a mirror, or " +
      "the same folder reached by a different path. The key was recorded for this workspace too.",
  },
  firstUseAcceptedNameConflict: {
    label: "trusted DESPITE a name conflict — you accepted a second publisher",
    color: DANGER_RED,
    title:
      "Another workspace already holds this application name under a DIFFERENT publisher key, " +
      "and this key was recorded anyway because you accepted the conflict. Two workspaces " +
      "claiming one name is what an application hijack looks like. Check the other workspace below.",
  },
  notPinned: {
    label: "signature valid — publisher NOT trusted yet",
    color: DANGER_RED,
    title:
      "The application is intact and correctly signed, but nobody on this computer has ever " +
      "agreed to trust this publisher for this application name from this workspace. Anyone can " +
      "generate a signing key, so a valid signature only proves the files were not altered after " +
      "signing — it does not tell you who signed them. Compare the key below against the one the " +
      "publisher gave you, then subscribe to record it as trusted. Inspecting an application " +
      "deliberately does not.",
  },
  notPinnedNameConflict: {
    label: "NAME CONFLICT — another workspace holds this name under a different key",
    color: DANGER_RED,
    title:
      "This application name is already trusted on this computer from a DIFFERENT workspace, " +
      "under a DIFFERENT publisher key. The signature here is valid, but a valid signature says " +
      "nothing about who signed it. Two workspaces claiming one name is exactly what an " +
      "application hijack looks like — compare both workspaces and both keys before trusting this one.",
  },
};

function CountChip({ label, count }: { label: string; count: number }): React.ReactElement | null {
  if (count === 0) return null;
  return (
    <span
      style={{
        display: "inline-block",
        padding: "3px 10px",
        margin: "0 6px 6px 0",
        background: "#eef4fb",
        border: "1px solid #d4e3f5",
        borderRadius: 3,
        fontSize: 12,
      }}
    >
      <b>{count}</b> {label}
    </span>
  );
}

export function OverviewSection({
  overview,
  registryPath,
  packageName,
}: {
  overview: InspectorOverview;
  registryPath: string;
  packageName: string;
}): React.ReactElement {
  const m = overview.manifest;
  const p = overview.package;
  const totalCells = overview.sheets.reduce((a, s) => a + s.cellCount, 0);
  const totalFormulas = overview.sheets.reduce((a, s) => a + s.formulaCount, 0);

  return (
    <div>
      <h2 style={sectionTitleStyle}>
        {p.name}{" "}
        <span style={{ ...mutedStyle, fontWeight: 400 }}>v{overview.resolvedVersion}</span>
      </h2>

      <div style={cardStyle}>
        <div style={cardHeaderStyle}>Identity &amp; trust</div>
        <KV label="Application kind">{m.kind}</KV>
        {p.description && <KV label="Description">{p.description}</KV>}
        <KV label="Author">{p.author || "(not set)"}</KV>
        <KV label="Created">{p.created}</KV>
        <KV label="This version published">
          {m.publishedAt}
          {m.publishedBy ? ` by ${m.publishedBy}` : ""}
        </KV>
        <KV label="Publisher">
          {m.publisherName || "(unnamed)"}{" "}
          <span title={TRUST_BADGE[m.trustStatus]?.title}>
            <Badge color={TRUST_BADGE[m.trustStatus]?.color ?? DANGER_RED}>
              {TRUST_BADGE[m.trustStatus]?.label ?? `unrecognised trust state (${m.trustStatus})`}
            </Badge>
          </span>
          {m.isPublisher && <Badge color="#5b5fc7">you hold the signing key</Badge>}
        </KV>
        {(m.otherScopePins ?? []).length > 0 && (
          <KV label="Also trusted from">
            <div style={{ fontSize: 11.5, lineHeight: 1.6 }}>
              {(m.otherScopePins ?? []).map((p, i) => (
                <div
                  key={i}
                  style={{ color: p.sameKey ? "var(--text-secondary)" : DANGER_RED }}
                >
                  <span style={{ fontFamily: "Consolas, monospace" }}>{p.scopeLabel}</span>
                  {" — "}
                  {p.sameKey ? "same publisher key" : "DIFFERENT publisher key"}{" "}
                  <span style={{ fontFamily: "Consolas, monospace" }}>
                    {p.publisherKey.slice(0, 16)}…
                  </span>
                  {p.pinnedAt ? ` (trusted ${p.pinnedAt.slice(0, 10)})` : ""}
                </div>
              ))}
            </div>
          </KV>
        )}
        <KV label="Publisher key (Ed25519)">
          <span style={{ fontFamily: "Consolas, monospace", fontSize: 11 }}>
            {m.publisherKey || "(unsigned)"}
          </span>
        </KV>
        <KV label="Minimum app version">{m.minAppVersion || "none"}</KV>
        <KV label="Signed artifacts">{m.artifactCount}</KV>
      </div>

      <div style={cardStyle}>
        <div style={cardHeaderStyle}>Contents at a glance</div>
        <CountChip label="sheets" count={overview.sheets.length} />
        <CountChip label="cells" count={totalCells} />
        <CountChip label="formulas" count={totalFormulas} />
        <CountChip label="tables" count={overview.tables.length} />
        <CountChip label="named ranges" count={overview.namedRanges.length} />
        <CountChip label="charts" count={overview.charts.length} />
        <CountChip label="pivots" count={overview.pivots.length} />
        <CountChip label="slicers" count={overview.slicers.length} />
        <CountChip label="pane controls" count={overview.paneControls.length} />
        <CountChip label="ribbon filters" count={overview.ribbonFilters.length} />
        <CountChip label="pivot layouts" count={overview.pivotLayouts.length} />
        <CountChip label="object scripts" count={overview.objectScripts.length} />
        <CountChip label="module scripts" count={overview.moduleScripts.length} />
        <CountChip label="custom functions" count={overview.customFunctionCount} />
        <CountChip label="notebooks" count={overview.notebooks.length} />
        <CountChip label="data sources (BI models)" count={overview.dataSources.length} />
        <CountChip label="writeback regions" count={overview.writebackRegionCount} />
        <CountChip label="model writeback columns" count={overview.modelWritebackCount} />
        <CountChip label="custom objects" count={overview.customObjects.length} />
        <CountChip label="extension-data keys" count={overview.extensionDataKeys.length} />
        <CountChip label="sheets with comments" count={overview.commentSheets.length} />
        {overview.hasTheme && (
          <CountChip label={`document theme${overview.themeName ? ` (${overview.themeName})` : ""}`} count={1} />
        )}
        {overview.sheets.length === 0 && overview.dataSources.length > 0 && (
          <div style={{ ...mutedStyle, fontSize: 12, marginTop: 4 }}>
            A model-only dataset application: no sheets, just the embedded data model.
          </div>
        )}
      </div>

      <EnvironmentsCard
        registryPath={registryPath}
        packageName={packageName}
        inspected={overview.resolvedVersion}
      />

      <div style={cardStyle}>
        <div style={cardHeaderStyle}>Version history</div>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Version</th>
              <th style={thStyle}>Based on</th>
              <th style={thStyle}>Changes</th>
              <th style={thStyle}>Published</th>
              <th style={thStyle}>By</th>
            </tr>
          </thead>
          <tbody>
            {[...p.versions].reverse().map((v) => (
              <tr key={v.version}>
                <td style={tdStyle}>
                  {v.version === overview.resolvedVersion ? <b>v{v.version} (inspected)</b> : `v${v.version}`}
                </td>
                {/* Lineage and the author's own account of the change. Blank
                    for a package's first version, and for anything published
                    before a push was required to say what it did. */}
                <td style={tdStyle}>{v.baseVersion ? `v${v.baseVersion}` : "—"}</td>
                <td style={tdStyle}>{v.changeSummary || "—"}</td>
                <td style={tdStyle}>{v.publishedAt}</td>
                <td style={tdStyle}>{v.publishedBy}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={cardStyle}>
        <div style={cardHeaderStyle}>Never in an application (by policy)</div>
        <div style={{ ...mutedStyle, fontSize: 12, lineHeight: 1.6 }}>
          Credentials and connection secrets (data sources carry schema only) · the
          subscriber audit log · workbook document properties · pivot output cells
          (recalculated by subscribers) · notebook execution outputs (stripped at
          publish) · threaded comments unless the publisher opted in · script
          provenance (re-stamped at pull; distributed scripts run Restricted and
          consent-gated with the capability ceiling taken from this signed
          manifest, never from the source).
        </div>
      </div>
    </div>
  );
}


/**
 * Where each environment points, and who moved it there.
 *
 * READ THROUGH THE SIGNED LOG, not the manifest listing. The listing is a cheap
 * unverified mirror, fine for populating a picker; an inspector is the surface a
 * person opens BECAUSE they want to know whether to believe what they are
 * looking at, so the one place that must not take the mirror's word for it is
 * this one. A log that does not verify renders as a problem, never as "no
 * environments" — those two must not look alike here of all places.
 */
function EnvironmentsCard({
  registryPath,
  packageName,
  inspected,
}: {
  registryPath: string;
  packageName: string;
  inspected: string;
}): React.ReactElement | null {
  const [info, setInfo] = useState<EnvironmentsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setInfo(null);
    setError(null);
    listEnvironments({ registryPath, packageName })
      .then((r) => {
        if (!cancelled) setInfo(r);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [registryPath, packageName]);

  // An application with no pipeline gets no card. Rendering "no environments"
  // beside twenty content counts would imply something is missing.
  if (!error && (!info || (info.environments.length === 0 && !info.problem))) return null;

  const here = info ? environmentsAtVersion(info.environments, inspected) : [];

  return (
    <div style={cardStyle}>
      <div style={cardHeaderStyle}>Environments</div>
      {error && <div style={{ ...mutedStyle, color: DANGER_RED }}>{error}</div>}
      {info?.problem && (
        <div style={{ ...mutedStyle, color: DANGER_RED, lineHeight: 1.5 }}>
          {info.problem}
        </div>
      )}

      {info && info.environments.length > 0 && (
        <>
          <KV label="Development line">
            {info.headVersion ? `v${info.headVersion} (head)` : "—"}
          </KV>
          {here.length > 0 && (
            <KV label="This version is live in">
              <b>{here.join(", ")}</b>
            </KV>
          )}
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Environment</th>
                <th style={thStyle}>Version</th>
                <th style={thStyle}>Promoted</th>
                <th style={thStyle}>By</th>
              </tr>
            </thead>
            <tbody>
              {info.environments.map((e) => (
                <tr key={e.name}>
                  <td style={tdStyle}>{e.name}</td>
                  <td style={tdStyle}>
                    {e.version ? (
                      e.version === inspected ? (
                        <b>v{e.version} (inspected)</b>
                      ) : (
                        `v${e.version}`
                      )
                    ) : (
                      "nothing promoted yet"
                    )}
                  </td>
                  <td style={tdStyle}>{e.promotedAt || "—"}</td>
                  <td style={tdStyle}>
                    {e.promotedBy || "—"}
                    {e.promoterKey ? ` (${e.promoterKey.slice(0, 12)}…)` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {info && info.history.length > 0 && (
        <>
          <div style={{ ...cardHeaderStyle, marginTop: 12 }}>Promotions</div>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>#</th>
                <th style={thStyle}>What</th>
                <th style={thStyle}>When</th>
                <th style={thStyle}>Signed by</th>
              </tr>
            </thead>
            <tbody>
              {info.history.map((h) => (
                <tr key={h.sequence}>
                  <td style={tdStyle}>{h.sequence}</td>
                  <td style={tdStyle}>
                    {h.kind === "pipeline"
                      ? `pipeline = ${h.environments.join(" → ") || "(none)"}`
                      : `${h.environment}: ${h.previousVersion ? `v${h.previousVersion} → ` : ""}v${h.version}${h.isRollback ? " (rolled back)" : ""}`}
                  </td>
                  <td style={tdStyle}>{h.at}</td>
                  <td style={tdStyle}>
                    {h.by || "—"} ({h.key.slice(0, 12)}…)
                    {!h.authorized && (
                      <span
                        style={{ color: "#b45309", fontWeight: 600, marginLeft: 6 }}
                        title="This key is not in the application's root-signed publisher list, so this promotion carries no authority."
                      >
                        not an authorised publisher
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ ...mutedStyle, fontSize: 11.5, marginTop: 6, lineHeight: 1.5 }}>
            Every row above is signed by the key beside it, so no row has been edited
            since it was written. A row marked{" "}
            <span style={{ color: "#b45309", fontWeight: 600 }}>
              not an authorised publisher
            </span>{" "}
            was signed by a key that is not in the application&rsquo;s root-signed
            publisher list, and the pointer it set is refused. A promotion moves a
            pointer; it copies nothing, so the version an environment names is
            bit-for-bit the one published under that number.
          </div>
        </>
      )}
    </div>
  );
}
