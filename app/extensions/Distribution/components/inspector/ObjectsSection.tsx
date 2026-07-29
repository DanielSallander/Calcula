// FILENAME: app/extensions/Distribution/components/inspector/ObjectsSection.tsx
// PURPOSE: Every object the package carries, grouped by kind, with the
//          identifying fields that matter per kind. Deeper (raw) views live
//          under Artifacts & Integrity.

import React from "react";
import type { InspectorOverview } from "@api/distribution";
import {
  StatusLine,
  cardHeaderStyle,
  cardStyle,
  mutedStyle,
  sectionTitleStyle,
  tableStyle,
  tdStyle,
  thStyle,
} from "./shared";

function Group({
  title,
  empty,
  children,
}: {
  title: string;
  empty: boolean;
  children?: React.ReactNode;
}): React.ReactElement | null {
  if (empty) return null;
  return (
    <div style={cardStyle}>
      <div style={cardHeaderStyle}>{title}</div>
      {children}
    </div>
  );
}

function SheetList({ sheets }: { sheets: string[] }): React.ReactElement {
  return <span>{sheets.join(", ")}</span>;
}

export function ObjectsSection({
  overview,
}: {
  overview: InspectorOverview;
}): React.ReactElement {
  const perSheetFeatures: { label: string; sheets: string[] }[] = [
    { label: "Conditional formatting", sheets: overview.conditionalFormatSheets },
    { label: "Data validation", sheets: overview.dataValidationSheets },
    { label: "Cell-anchored controls (disarmed at pull)", sheets: overview.controlSheets },
    { label: "Comments (publisher opted in)", sheets: overview.commentSheets },
    { label: "Scenarios", sheets: overview.scenarioSheets },
    { label: "Outlines (row/column groups)", sheets: overview.outlineSheets },
    { label: "Sparklines", sheets: overview.sparklineSheets },
  ];

  const anything =
    overview.tables.length +
      overview.namedRanges.length +
      overview.charts.length +
      overview.pivots.length +
      overview.slicers.length +
      overview.paneControls.length +
      overview.ribbonFilters.length +
      overview.pivotLayouts.length +
      overview.customObjects.length +
      overview.extensionDataKeys.length >
      0 ||
    perSheetFeatures.some((f) => f.sheets.length > 0) ||
    overview.hasTheme;

  return (
    <div>
      <h2 style={sectionTitleStyle}>Objects</h2>
      {!anything && <StatusLine empty emptyText="This package carries no objects beyond its sheets." />}

      <Group title={`Tables (${overview.tables.length})`} empty={overview.tables.length === 0}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Name</th>
              <th style={thStyle}>Sheet</th>
              <th style={thStyle}>Range</th>
              <th style={thStyle}>Columns</th>
            </tr>
          </thead>
          <tbody>
            {overview.tables.map((t) => (
              <tr key={t.id} title={t.id}>
                <td style={tdStyle}>{t.name}</td>
                <td style={tdStyle}>{t.sheetName}</td>
                <td style={tdStyle}>{t.range}</td>
                <td style={tdStyle}>{t.columns.join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Group>

      <Group
        title={`Named ranges (${overview.namedRanges.length})`}
        empty={overview.namedRanges.length === 0}
      >
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Name</th>
              <th style={thStyle}>Refers to</th>
              <th style={thStyle}>Scope</th>
            </tr>
          </thead>
          <tbody>
            {overview.namedRanges.map((nr) => (
              <tr key={nr.name}>
                <td style={tdStyle}>{nr.name}</td>
                <td style={{ ...tdStyle, fontFamily: "Consolas, monospace", fontSize: 11 }}>
                  {nr.refersTo}
                </td>
                <td style={tdStyle}>{nr.sheetName ?? "Workbook"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Group>

      <Group title={`Charts (${overview.charts.length})`} empty={overview.charts.length === 0}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Title</th>
              <th style={thStyle}>Sheet</th>
              <th style={thStyle}>Id</th>
            </tr>
          </thead>
          <tbody>
            {overview.charts.map((c) => (
              <tr key={c.id}>
                <td style={tdStyle}>{c.title ?? <span style={mutedStyle}>(untitled)</span>}</td>
                <td style={tdStyle}>{c.sheetName}</td>
                <td style={{ ...tdStyle, ...mutedStyle, fontSize: 11 }}>{c.id}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Group>

      <Group title={`Pivot tables (${overview.pivots.length})`} empty={overview.pivots.length === 0}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Name</th>
              <th style={thStyle}>Source</th>
              <th style={thStyle}>Id</th>
            </tr>
          </thead>
          <tbody>
            {overview.pivots.map((pv) => (
              <tr key={pv.id}>
                <td style={tdStyle}>{pv.name ?? <span style={mutedStyle}>(unnamed)</span>}</td>
                <td style={tdStyle}>{pv.sourceType}</td>
                <td style={{ ...tdStyle, ...mutedStyle, fontSize: 11 }}>{pv.id}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ ...mutedStyle, fontSize: 11, marginTop: 6 }}>
          Pivot output cells never travel — subscribers recalculate them locally.
        </div>
      </Group>

      <Group title={`Slicers (${overview.slicers.length})`} empty={overview.slicers.length === 0}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Name</th>
              <th style={thStyle}>Sheet</th>
              <th style={thStyle}>Field</th>
            </tr>
          </thead>
          <tbody>
            {overview.slicers.map((s, i) => (
              <tr key={`${s.name}-${i}`}>
                <td style={tdStyle}>{s.name}</td>
                <td style={tdStyle}>{s.sheetName}</td>
                <td style={tdStyle}>{s.fieldName}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Group>

      <Group
        title={`Pane controls (${overview.paneControls.length})`}
        empty={overview.paneControls.length === 0}
      >
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Name</th>
              <th style={thStyle}>Type</th>
            </tr>
          </thead>
          <tbody>
            {overview.paneControls.map((c) => (
              <tr key={c.id} title={c.id}>
                <td style={tdStyle}>{c.name}</td>
                <td style={tdStyle}>{c.controlType}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ ...mutedStyle, fontSize: 11, marginTop: 6 }}>
          Pane-control configs are code-free by design; custom-control scripts ship as
          object scripts (see Scripts &amp; Code).
        </div>
      </Group>

      <Group
        title={`Ribbon filters (${overview.ribbonFilters.length})`}
        empty={overview.ribbonFilters.length === 0}
      >
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Name</th>
              <th style={thStyle}>Field</th>
            </tr>
          </thead>
          <tbody>
            {overview.ribbonFilters.map((f, i) => (
              <tr key={`${f.name}-${i}`}>
                <td style={tdStyle}>{f.name}</td>
                <td style={tdStyle}>{f.fieldName}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Group>

      <Group
        title={`Saved pivot layouts (${overview.pivotLayouts.length})`}
        empty={overview.pivotLayouts.length === 0}
      >
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Name</th>
              <th style={thStyle}>Source</th>
              <th style={thStyle}>Description</th>
            </tr>
          </thead>
          <tbody>
            {overview.pivotLayouts.map((l, i) => (
              <tr key={`${l.name}-${i}`}>
                <td style={tdStyle}>{l.name}</td>
                <td style={tdStyle}>{l.sourceType}</td>
                <td style={tdStyle}>{l.description ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Group>

      <Group
        title={`Custom objects (${overview.customObjects.length})`}
        empty={overview.customObjects.length === 0}
      >
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Kind</th>
              <th style={thStyle}>Name</th>
              <th style={thStyle}>Sheet</th>
              <th style={thStyle}>Payload</th>
            </tr>
          </thead>
          <tbody>
            {overview.customObjects.map((c) => (
              <tr key={`${c.kind}-${c.id}`} title={c.id}>
                <td style={tdStyle}>{c.kind}</td>
                <td style={tdStyle}>{c.name || c.id}</td>
                <td style={tdStyle}>{c.sheetName ?? "Workbook"}</td>
                <td style={{ ...tdStyle, ...mutedStyle, fontSize: 11 }}>{c.payloadPath}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Group>

      {perSheetFeatures.some((f) => f.sheets.length > 0) && (
        <div style={cardStyle}>
          <div style={cardHeaderStyle}>Per-sheet features</div>
          <table style={tableStyle}>
            <tbody>
              {perSheetFeatures
                .filter((f) => f.sheets.length > 0)
                .map((f) => (
                  <tr key={f.label}>
                    <td style={{ ...tdStyle, ...mutedStyle, whiteSpace: "nowrap" }}>{f.label}</td>
                    <td style={tdStyle}>
                      <SheetList sheets={f.sheets} />
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}

      <Group
        title="Document theme & extension data"
        empty={!overview.hasTheme && overview.extensionDataKeys.length === 0}
      >
        {overview.hasTheme && (
          <div style={{ fontSize: 12, marginBottom: 4 }}>
            Document theme: <b>{overview.themeName ?? "(unnamed)"}</b>{" "}
            <span style={mutedStyle}>
              (applied at pull only if the subscriber&apos;s theme is still default)
            </span>
          </div>
        )}
        {overview.extensionDataKeys.length > 0 && (
          <div style={{ fontSize: 12 }}>
            Extension-data keys:{" "}
            <span style={{ fontFamily: "Consolas, monospace", fontSize: 11 }}>
              {overview.extensionDataKeys.join(", ")}
            </span>{" "}
            <span style={mutedStyle}>(merged additively at pull — never overwrites)</span>
          </div>
        )}
      </Group>
    </div>
  );
}
