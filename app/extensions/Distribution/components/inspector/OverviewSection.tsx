// FILENAME: app/extensions/Distribution/components/inspector/OverviewSection.tsx
// PURPOSE: Landing view — package identity, verified publisher + trust state,
//          version history, a content census, and the policy-exclusion
//          disclosure (what a .calp can NEVER carry).

import React from "react";
import type { CalpTrustStatus, InspectorOverview } from "@api/distribution";
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
 * newly pinned"`. Inspecting a package no longer pins anything, so that else
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
      "Signed by the same publisher key you pinned when you subscribed to this package.",
  },
  firstUse: {
    label: "trusted just now — key pinned",
    color: WARN_AMBER,
    title:
      "This publisher key was recorded as trusted by this operation (trust-on-first-use).",
  },
  firstUseKnownPublisher: {
    label: "trusted just now — same publisher as another registry",
    color: WARN_AMBER,
    title:
      "This registry was not trusted for this package before, but the SAME publisher key is " +
      "already trusted for this package name from another registry — a move, a mirror, or the " +
      "same folder reached by a different path. The key was recorded for this registry too.",
  },
  firstUseAcceptedNameConflict: {
    label: "trusted DESPITE a name conflict — you accepted a second publisher",
    color: DANGER_RED,
    title:
      "Another registry already holds this package name under a DIFFERENT publisher key, and " +
      "this key was recorded anyway because you accepted the conflict. Two registries claiming " +
      "one name is what a package hijack looks like. Check the other registry below.",
  },
  notPinned: {
    label: "signature valid — publisher NOT trusted yet",
    color: DANGER_RED,
    title:
      "The package is intact and correctly signed, but nobody on this computer has ever agreed " +
      "to trust this publisher for this package name from this registry. Anyone can generate a " +
      "signing key, so a valid signature only proves the files were not altered after signing — " +
      "it does not tell you who signed them. Compare the key below against the one the publisher " +
      "gave you, then subscribe to record it as trusted. Inspecting a package deliberately does not.",
  },
  notPinnedNameConflict: {
    label: "NAME CONFLICT — another registry holds this name under a different key",
    color: DANGER_RED,
    title:
      "This package name is already trusted on this computer from a DIFFERENT registry, under a " +
      "DIFFERENT publisher key. The signature here is valid, but a valid signature says nothing " +
      "about who signed it. Two registries claiming one name is exactly what a package hijack " +
      "looks like — compare both registries and both keys before trusting this one.",
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
}: {
  overview: InspectorOverview;
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
        <KV label="Package kind">{m.kind}</KV>
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
            A model-only dataset package: no sheets, just the embedded data model.
          </div>
        )}
      </div>

      <div style={cardStyle}>
        <div style={cardHeaderStyle}>Version history</div>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Version</th>
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
                <td style={tdStyle}>{v.publishedAt}</td>
                <td style={tdStyle}>{v.publishedBy}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={cardStyle}>
        <div style={cardHeaderStyle}>Never in a package (by policy)</div>
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
