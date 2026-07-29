// FILENAME: app/extensions/Distribution/components/inspector/ModelSection.tsx
// PURPOSE: Embedded BI models (package data sources): connection target
//          (schema only, never credentials), bindings, and the full model
//          summary — tables, columns, measures, relationships, snapshots.

import React, { useEffect, useState } from "react";
import {
  inspectorModel,
  type InspectorModel,
  type InspectorOverview,
} from "@api/distribution";
import type { InspectorContext } from "./PackageInspectorApp";
import {
  ACCENT,
  BORDER,
  KV,
  StatusLine,
  buttonStyle,
  cardHeaderStyle,
  cardStyle,
  formatBytes,
  mutedStyle,
  sectionTitleStyle,
  tableStyle,
  tdStyle,
  thStyle,
} from "./shared";

function CountRow({ model }: { model: InspectorModel }): React.ReactElement {
  const counts: [string, number][] = [
    ["calculated columns", model.calculatedColumnCount],
    ["hierarchies", model.hierarchyCount],
    ["calculation groups", model.calculationGroupCount],
    ["KPIs", model.kpiCount],
    ["security roles", model.securityRoleCount],
    ["calculated tables", model.globalVariableCount],
    ["script functions", model.scriptFunctionCount],
    ["contexts", model.contextCount],
  ];
  const shown = counts.filter(([, n]) => n > 0);
  if (shown.length === 0) return <></>;
  return (
    <div style={{ fontSize: 12, marginTop: 6 }}>
      {shown.map(([label, n]) => (
        <span
          key={label}
          style={{
            display: "inline-block",
            padding: "2px 8px",
            margin: "0 6px 4px 0",
            background: "#f0f2f4",
            borderRadius: 3,
          }}
        >
          <b>{n}</b> {label}
        </span>
      ))}
    </div>
  );
}

export function ModelSection({
  ctx,
  overview,
}: {
  ctx: InspectorContext;
  overview: InspectorOverview;
}): React.ReactElement {
  const [selected, setSelected] = useState<string | null>(
    overview.dataSources.length > 0 ? overview.dataSources[0].id : null,
  );
  const [model, setModel] = useState<InspectorModel | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch inside the effect with a cleanup-scoped stale flag: a slow response
  // for a previously selected source must never clobber the current one.
  useEffect(() => {
    if (!selected) return;
    let stale = false;
    setLoading(true);
    setError(null);
    setModel(null);
    inspectorModel(ctx.registryPath, ctx.packageName, ctx.version, selected)
      .then((m) => {
        if (!stale) setModel(m);
      })
      .catch((err: unknown) => {
        if (!stale) setError(String(err));
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [selected, ctx]);

  if (overview.dataSources.length === 0) {
    return (
      <div>
        <h2 style={sectionTitleStyle}>Data Model</h2>
        <StatusLine empty emptyText="This package embeds no BI data sources." />
      </div>
    );
  }

  const ds = overview.dataSources.find((d) => d.id === selected) ?? null;

  return (
    <div>
      <h2 style={sectionTitleStyle}>Data Model</h2>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 10 }}>
        {overview.dataSources.map((d) => (
          <button
            key={d.id}
            style={{
              ...buttonStyle,
              borderColor: selected === d.id ? ACCENT : BORDER,
              color: selected === d.id ? ACCENT : undefined,
              fontWeight: selected === d.id ? 600 : 400,
            }}
            onClick={() => setSelected(d.id)}
          >
            {d.name}
          </button>
        ))}
      </div>

      {ds && (
        <div style={cardStyle}>
          <div style={cardHeaderStyle}>Connection (schema only — no credentials travel)</div>
          <KV label="Type">{ds.connectionType}</KV>
          <KV label="Server">{ds.server}</KV>
          <KV label="Database">{ds.database}</KV>
          {ds.bindings.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>Model table</th>
                    <th style={thStyle}>Bound to</th>
                  </tr>
                </thead>
                <tbody>
                  {ds.bindings.map((b) => (
                    <tr key={b.modelTable}>
                      <td style={tdStyle}>{b.modelTable}</td>
                      <td style={tdStyle}>
                        {b.hasQuery ? "custom SQL query" : `${b.schema}.${b.sourceTable}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <StatusLine error={error} loading={loading} />
      {model && (
        <>
          <div style={cardStyle}>
            <div style={cardHeaderStyle}>
              Model summary{" "}
              {model.modelFormatVersion !== null && (
                <span style={{ ...mutedStyle, fontWeight: 400 }}>
                  (format v{model.modelFormatVersion})
                </span>
              )}
            </div>
            {model.dateTable && <KV label="Date table">{model.dateTable}</KV>}
            <CountRow model={model} />
          </div>

          <div style={cardStyle}>
            <div style={cardHeaderStyle}>Tables ({model.tables.length})</div>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Table</th>
                  <th style={thStyle}>Columns</th>
                </tr>
              </thead>
              <tbody>
                {model.tables.map((t) => (
                  <tr key={t.name}>
                    <td style={{ ...tdStyle, whiteSpace: "nowrap", fontWeight: 600 }}>{t.name}</td>
                    <td style={tdStyle}>
                      {t.columns.map((c) => (
                        <span key={c.name} style={{ marginRight: 10, whiteSpace: "nowrap" }}>
                          {c.name}
                          <span style={{ ...mutedStyle, fontSize: 11 }}> {c.dataType}</span>
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {model.measures.length > 0 && (
            <div style={cardStyle}>
              <div style={cardHeaderStyle}>Measures ({model.measures.length})</div>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>Name</th>
                    <th style={thStyle}>Expression</th>
                  </tr>
                </thead>
                <tbody>
                  {model.measures.map((m) => (
                    <tr key={m.name}>
                      <td style={{ ...tdStyle, whiteSpace: "nowrap", fontWeight: 600 }}>
                        {m.name}
                      </td>
                      <td
                        style={{
                          ...tdStyle,
                          fontFamily: "Consolas, monospace",
                          fontSize: 11,
                          wordBreak: "break-word",
                        }}
                      >
                        {m.expression}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {model.relationships.length > 0 && (
            <div style={cardStyle}>
              <div style={cardHeaderStyle}>Relationships ({model.relationships.length})</div>
              <table style={tableStyle}>
                <tbody>
                  {model.relationships.map((r, i) => (
                    <tr key={i}>
                      <td style={tdStyle}>
                        {r.fromTable}.{r.fromColumn} {"→"} {r.toTable}.{r.toColumn}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {(model.calculatedTableSnapshots.length > 0 || model.hasWritebackHistory) && (
            <div style={cardStyle}>
              <div style={cardHeaderStyle}>Carried data</div>
              {model.calculatedTableSnapshots.map((s) => (
                <div key={s.path} style={{ fontSize: 12 }}>
                  Calculated-table snapshot <b>{s.table}</b>{" "}
                  <span style={mutedStyle}>
                    ({formatBytes(s.sizeBytes)}, Arrow IPC — {s.path})
                  </span>
                </div>
              ))}
              {model.hasWritebackHistory && (
                <div style={{ fontSize: 12 }}>
                  Writeback-column history baseline{" "}
                  <span style={mutedStyle}>(models/{model.dataSourceId}/writeback_history.json)</span>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
