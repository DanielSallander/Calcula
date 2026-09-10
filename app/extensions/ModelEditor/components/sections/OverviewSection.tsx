// FILENAME: app/extensions/ModelEditor/components/sections/OverviewSection.tsx
// PURPOSE: The model's landing page: entity counts as NAVIGABLE tiles, the
//          two model-wide defaults, and a pointer at the Problems drawer.
// CONTEXT: This page used to end in a "Validate model" button that ran
//          `bi_model_validate` on demand and rendered its answer inline. Two
//          things were wrong with that and both are now gone.
//
//          It was the ONLY place the model was ever checked, on a page most
//          people visit once — so in practice nothing was checked. Checking now
//          runs continuously in the top-bar chip, the rail dots and the
//          Problems drawer, none of which you have to remember.
//
//          And it rendered `level === "error"` with `tone="warn"` — yellow —
//          which was not an edge case: `bi_model_validate` can ONLY emit
//          `error`, so the one tone it could produce was the one tone that was
//          wrong, 100% of the time. `Badge` has an `error` tone now, and the
//          drawer uses it.
//
//          The count tiles were also dead ends: twelve numbers that linked
//          nowhere, on a page whose whole job is orientation. They navigate.

import React from "react";
import { Badge, styles } from "../editorShared";
import type { SectionCtx, SectionId } from "../editorShared";
import { FONT, ME, RADIUS, SHADOW, SPACE, TABULAR } from "../theme";

interface Stat {
  label: string;
  count: number;
  section: SectionId;
}

export function OverviewSection({ ctx }: { ctx: SectionCtx }): React.ReactElement {
  const { overview, navigate } = ctx;

  const stats: Stat[] = [
    { label: "Tables", count: overview.tables.length, section: "tables" },
    { label: "Measures", count: overview.measures.length, section: "measures" },
    { label: "Relationships", count: overview.relationships.length, section: "relationships" },
    { label: "Hierarchies", count: overview.hierarchies.length, section: "hierarchies" },
    { label: "KPIs", count: overview.kpis.length, section: "kpis" },
    { label: "Security Roles", count: overview.securityRoles.length, section: "roles" },
    {
      label: "Calculation Groups",
      count: overview.calculationGroups.length,
      section: "calcGroups",
    },
    { label: "Contexts", count: overview.contexts.length, section: "contexts" },
    { label: "Table Variables", count: overview.tableVariables.length, section: "tableVariables" },
    { label: "Calculated Tables", count: overview.globalVariables.length, section: "globals" },
    { label: "Script Functions", count: overview.scriptFunctions.length, section: "scriptFunctions" },
    { label: "Sources", count: overview.sources.length, section: "connections" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: SPACE.lg, flex: 1, minHeight: 0 }}>
      <div style={styles.sectionHeader}>
        <span style={styles.sectionTitle}>{overview.modelName ?? "Overview"}</span>
      </div>

      {overview.readOnlyReason && (
        <div>
          <Badge tone="warn">{overview.readOnlyReason}</Badge>
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
          gap: SPACE.md,
        }}
      >
        {stats.map((s) => (
          <button
            key={s.label}
            type="button"
            data-testid={`overview-tile-${s.section}`}
            onClick={() => navigate(s.section)}
            style={{
              ...styles.card,
              boxShadow: SHADOW.card,
              borderRadius: RADIUS.control,
              textAlign: "left",
              border: "none",
              cursor: "pointer",
              font: "inherit",
              color: ME.text,
            }}
          >
            <div
              style={{
                fontSize: 22,
                fontWeight: 700,
                color: s.count === 0 ? ME.text3 : ME.accent,
                ...TABULAR,
              }}
            >
              {s.count}
            </div>
            <div style={{ color: ME.text2, fontSize: FONT.sm }}>{s.label}</div>
          </button>
        ))}
      </div>

      <div style={{ ...styles.card, display: "flex", flexDirection: "column", gap: SPACE.sm }}>
        <div style={{ display: "flex", gap: SPACE.sm }}>
          <span style={{ color: ME.text2, minWidth: 190 }}>Date table</span>
          <span>{overview.dateTable ?? "(none)"}</span>
        </div>
        <div style={{ display: "flex", gap: SPACE.sm }}>
          <span style={{ color: ME.text2, minWidth: 190 }}>Default lookup resolution</span>
          <span>{overview.defaultLookupResolution ?? "(default MIN)"}</span>
        </div>
        <div style={styles.hint}>
          Both are edited under{" "}
          <button
            type="button"
            data-testid="overview-to-settings"
            onClick={() => navigate("settings")}
            style={{
              background: "none",
              border: "none",
              padding: 0,
              font: "inherit",
              color: ME.accent,
              cursor: "pointer",
              textDecoration: "underline",
            }}
          >
            Settings
          </button>
          .
        </div>
      </div>
    </div>
  );
}
