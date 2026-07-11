// FILENAME: app/extensions/ModelEditor/components/sections/OverviewSection.tsx
// PURPOSE: Overview section of the Model Editor window: a read-only summary of
//          the model (entity counts as stat cards, date table + default lookup
//          resolution) plus an on-demand "Validate model" run that lists any
//          validation issues. No mutations.

import React, { useState } from "react";
import { biModelValidate } from "@api";
import type { ValidationIssueDto } from "@api";
import { ACCENT, Badge, styles } from "../editorShared";
import type { SectionCtx } from "../editorShared";

export function OverviewSection({ ctx }: { ctx: SectionCtx }): React.ReactElement {
  const { connectionId, overview, reportError } = ctx;
  const [issues, setIssues] = useState<ValidationIssueDto[] | null>(null);
  const [busy, setBusy] = useState(false);

  const stats: { label: string; count: number }[] = [
    { label: "Tables", count: overview.tables.length },
    { label: "Measures", count: overview.measures.length },
    { label: "Relationships", count: overview.relationships.length },
    { label: "Hierarchies", count: overview.hierarchies.length },
    { label: "KPIs", count: overview.kpis.length },
    { label: "Security Roles", count: overview.securityRoles.length },
    { label: "Calculation Groups", count: overview.calculationGroups.length },
    { label: "Contexts", count: overview.contexts.length },
    { label: "Context Columns", count: overview.contextColumns.length },
    { label: "Table Variables", count: overview.tableVariables.length },
    { label: "Calculated Tables", count: overview.globalVariables.length },
    { label: "Script Functions", count: overview.scriptFunctions.length },
  ];

  const validate = async () => {
    setBusy(true);
    try {
      setIssues(await biModelValidate(connectionId));
    } catch (err: unknown) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: 1, minHeight: 0 }}>
      <div style={styles.sectionHeader}>
        <span style={styles.sectionTitle}>Overview</span>
      </div>

      {overview.readOnlyReason && (
        <div>
          <Badge tone="warn">{overview.readOnlyReason}</Badge>
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
          gap: 10,
        }}
      >
        {stats.map((s) => (
          <div key={s.label} style={styles.card}>
            <div style={{ fontSize: 22, fontWeight: 700, color: ACCENT }}>{s.count}</div>
            <div style={styles.muted}>{s.label}</div>
          </div>
        ))}
      </div>

      <div style={styles.muted}>Date table: {overview.dateTable ?? "(none)"}</div>
      <div style={styles.muted}>
        Default lookup resolution: {overview.defaultLookupResolution ?? "(default MIN)"}
      </div>

      <div style={styles.sectionHeader}>
        <span style={styles.sectionTitle}>Validation</span>
        <button style={styles.btn} disabled={busy} onClick={() => void validate()}>
          {busy ? "Validating…" : "Validate model"}
        </button>
      </div>

      {issues !== null &&
        (issues.length === 0 ? (
          <div>
            <Badge tone="ok">Model is valid</Badge>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {issues.map((issue, i) => (
              <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                <Badge tone={issue.level === "error" ? "warn" : "neutral"}>{issue.level}</Badge>
                <span style={{ fontSize: 12 }}>{issue.message}</span>
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}
