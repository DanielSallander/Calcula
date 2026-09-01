// FILENAME: app/extensions/Distribution/components/VersionDiffView.tsx
// PURPOSE: Render a VersionDiff — shared by the Application Inspector's Compare
// view and the push dialog's "changes since your base" panel.
// CONTEXT: One component because the two answer the same question from
// different vantage points ("what changed between these versions" and "what
// would my push change"), and a second copy would drift the first time a
// domain was added to the engine.
//
// Presentation rules that are not cosmetic:
//   * A truncated list SAYS it is truncated. The engine reports exact counts
//     alongside capped samples, and dropping that distinction would recreate
//     the defect this whole feature replaced — a diff that looked complete and
//     was not.
//   * Script and measure changes show their BEFORE and AFTER text. "The script
//     changed" is not something anyone can act on.
//   * A capability a script GAINED is called out on its own, because it is the
//     one change to a distributed script a consumer must not miss.

import React, { useState } from "react";
import type { CellDiff, ObjectChange, SheetDiffSummary, VersionDiff } from "@api";

/**
 * A cell the caller is letting the user opt OUT of, identified the way both the
 * diff and the backend name one.
 */
export interface DiffCellKey {
  sheetId: string;
  row: number;
  col: number;
}

export const cellKeyOf = (sheetId: string, c: CellDiff): string =>
  `${sheetId}:${c.row}:${c.col}`;

/**
 * Makes the cell rows checkable.
 *
 * OPTIONAL, so the read-only caller (the inspector's Compare view, which diffs
 * two PUBLISHED versions and has nothing to act on) is unchanged and cannot grow
 * a checkbox that would mean nothing.
 *
 * AN EXCLUSION SET, never an inclusion set. The row list is a bounded sample —
 * 50 changed cells per sheet — so a changed cell may have no row at all. Storing
 * what the user OPTED OUT of means everything unseen keeps the default, and an
 * empty set is bit-identical to the behaviour before any of this existed.
 */
export interface DiffSelection {
  /** `cellKeyOf` strings the user unticked. */
  excluded: ReadonlySet<string>;
  onToggle: (sheetId: string, cell: CellDiff, include: boolean) => void;
  /** Column header for the checkbox, e.g. "Reset". */
  label: string;
}

export interface VersionDiffViewProps {
  diff: VersionDiff;
  /** Fetch every changed cell of one sheet, when the caller can. */
  onDrillDown?: (sheetId: string) => void;
  /** Rows already fetched by `onDrillDown`, keyed by sheet id. */
  drilledCells?: Record<string, { rows: CellDiff[]; total: number; truncated: boolean }>;
  /** Omit for a read-only diff. */
  selection?: DiffSelection;
}

export function VersionDiffView({
  diff,
  onDrillDown,
  drilledCells,
  selection,
}: VersionDiffViewProps) {
  const nothing =
    diff.totals.cellsChanged === 0 &&
    diff.totals.objectsAdded === 0 &&
    diff.totals.objectsRemoved === 0 &&
    diff.totals.objectsModified === 0 &&
    diff.sheets.every((s) => s.change === "modified" && cellTotal(s) === 0) &&
    diff.manifestChanges.length === 0;

  if (nothing) {
    return (
      <div style={mutedStyle}>
        No differences between {label(diff.fromVersion)} and {label(diff.toVersion)}.
      </div>
    );
  }

  return (
    <div style={{ fontSize: "12px" }}>
      <TotalsStrip diff={diff} />

      {diff.sheets.filter((s) => s.change !== "modified" || cellTotal(s) > 0 || presentationChanged(s)).length > 0 && (
        <Section title="Sheets">
          {diff.sheets
            .filter((s) => s.change !== "modified" || cellTotal(s) > 0 || presentationChanged(s))
            .map((s) => (
              <SheetRow
                key={s.sheetId}
                sheet={s}
                onDrillDown={onDrillDown}
                drilled={drilledCells?.[s.sheetId]}
                selection={selection}
              />
            ))}
        </Section>
      )}

      {diff.objects.length > 0 && (
        <Section title="Objects">
          {groupByDomain(diff.objects).map(([domain, items]) => (
            <div key={domain} style={{ marginBottom: 8 }}>
              <div style={{ fontWeight: 600, marginBottom: 2 }}>
                {domainLabel(domain)} ({items.length})
              </div>
              {items.map((o, i) => (
                <ObjectRow key={`${o.domain}:${o.id}:${i}`} object={o} />
              ))}
            </div>
          ))}
        </Section>
      )}

      {diff.manifestChanges.length > 0 && (
        <Section title="Application metadata">
          {diff.manifestChanges.map((m) => (
            <div key={m.field} style={{ marginBottom: 4 }}>
              <span style={{ fontWeight: 600 }}>{m.field}</span>{" "}
              <span style={mutedStyle}>{m.before || "—"}</span>
              {" → "}
              <span>{m.after || "—"}</span>
              {m.field === "publisherKey" && (
                <div style={warnBoxStyle}>
                  A different key signed this version. Under one trust pin that
                  should be impossible — subscribers will refuse the update
                  rather than accept it silently.
                </div>
              )}
            </div>
          ))}
        </Section>
      )}

      {diff.artifacts.spuriousHashChanges > 0 && (
        <div style={warnBoxStyle}>
          {diff.artifacts.spuriousHashChanges} artifact(s) hashed differently but
          contain the same thing. That is a packaging bug, not a change you made
          — application serialization has become order-dependent.
        </div>
      )}
    </div>
  );
}

function TotalsStrip({ diff }: { diff: VersionDiff }) {
  const t = diff.totals;
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: "10px",
        padding: "6px 8px",
        marginBottom: 10,
        borderRadius: 4,
        background: "var(--bg-subtle, rgba(127,127,127,0.08))",
      }}
    >
      <Stat
        label="cells"
        value={`${t.cellsChangedExact ? "" : "at least "}${t.cellsChanged}`}
      />
      <Stat label="sheets" value={String(t.sheetsChanged)} />
      <Stat label="added" value={String(t.objectsAdded)} />
      <Stat label="changed" value={String(t.objectsModified)} />
      <Stat label="removed" value={String(t.objectsRemoved)} />
      <span style={{ marginLeft: "auto", ...mutedStyle }}>
        {label(diff.fromVersion)} → {label(diff.toVersion)}
      </span>
    </div>
  );
}

function Stat({ label: l, value }: { label: string; value: string }) {
  return (
    <span>
      <strong>{value}</strong> <span style={mutedStyle}>{l}</span>
    </span>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{title}</div>
      {children}
    </div>
  );
}

function SheetRow({
  sheet,
  onDrillDown,
  drilled,
  selection,
}: {
  sheet: SheetDiffSummary;
  onDrillDown?: (sheetId: string) => void;
  drilled?: { rows: CellDiff[]; total: number; truncated: boolean };
  selection?: DiffSelection;
}) {
  // OPEN BY DEFAULT when the rows are actionable. A checkbox behind a "show
  // cells" link is a decision most people will never find they had.
  const [expanded, setExpanded] = useState(!!selection);
  const rows = drilled?.rows ?? sheet.sample;
  const showingAll = drilled !== undefined;

  return (
    <div
      style={{
        border: "1px solid var(--border-default)",
        borderRadius: 3,
        marginBottom: 4,
        padding: "6px 8px",
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <ChangeChip change={sheet.change} />
        <span style={{ fontWeight: 600 }}>{sheet.name}</span>
        {sheet.renamedFrom && <span style={mutedStyle}>was “{sheet.renamedFrom}”</span>}
        {cellTotal(sheet) > 0 && (
          <span style={mutedStyle}>
            {!sheet.countsExact && "at least "}
            {sheet.cellsAdded > 0 && `+${sheet.cellsAdded} `}
            {sheet.cellsRemoved > 0 && `−${sheet.cellsRemoved} `}
            {sheet.cellsModified > 0 && `~${sheet.cellsModified} `}
            cells
            {sheet.formulaChanges > 0 && `, ${sheet.formulaChanges} formula`}
          </span>
        )}
        {presentationChanged(sheet) && (
          <span style={mutedStyle}>
            {[
              sheet.stylesTableChanged && "styles",
              sheet.styleChangedCells > 0 && "cell formatting",
              sheet.layoutChanged && "layout",
              sheet.metadataChanged && "sheet settings",
            ]
              .filter(Boolean)
              .join(", ")}
          </span>
        )}
        {rows.length > 0 && (
          <button
            style={linkButtonStyle}
            onClick={() => setExpanded((e) => !e)}
          >
            {expanded ? "hide cells" : "show cells"}
          </button>
        )}
      </div>

      {expanded && rows.length > 0 && (
        <div style={{ marginTop: 6, overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "11px" }}>
            <thead>
              <tr>
                {selection && <th style={thStyle}>{selection.label}</th>}
                <th style={thStyle}>Cell</th>
                <th style={thStyle}>Before</th>
                <th style={thStyle}>After</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const key = cellKeyOf(sheet.sheetId, c);
                const included = !selection?.excluded.has(key);
                return (
                  <tr key={c.a1}>
                    {selection && (
                      <td style={tdStyle}>
                        <input
                          type="checkbox"
                          checked={included}
                          aria-label={`${selection.label} ${sheet.name}!${c.a1}`}
                          onChange={(e) =>
                            selection.onToggle(sheet.sheetId, c, e.target.checked)
                          }
                        />
                      </td>
                    )}
                    <td style={{ ...tdStyle, opacity: included ? 1 : 0.45 }}>
                      <ChangeChip change={c.change} /> {c.a1}
                    </td>
                    <td
                      style={{ ...tdStyle, ...cellTextStyle, opacity: included ? 1 : 0.45 }}
                    >
                      {renderCell(c.before)}
                    </td>
                    <td
                      style={{ ...tdStyle, ...cellTextStyle, opacity: included ? 1 : 0.45 }}
                    >
                      {renderCell(c.after)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!showingAll && sheet.sampleTruncated && (
            <div style={{ ...mutedStyle, marginTop: 4 }}>
              Showing {rows.length} of {cellTotal(sheet)}.
              {/* NO SILENT CAP. With checkboxes on screen the unlisted cells are
                  not merely unseen — they are undecided, and they will be acted
                  on. Say so where the list ends. */}
              {selection && (
                <>
                  {" "}
                  The {cellTotal(sheet) - rows.length} not listed will be{" "}
                  {selection.label.toLowerCase()} — there is no row to untick.
                </>
              )}
              {onDrillDown && (
                <button style={linkButtonStyle} onClick={() => onDrillDown(sheet.sheetId)}>
                  Show all
                </button>
              )}
            </div>
          )}
          {showingAll && drilled?.truncated && (
            <div style={{ ...mutedStyle, marginTop: 4 }}>
              Showing {rows.length} of {drilled.total} — the rest is beyond what
              this view will list.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ObjectRow({ object: o }: { object: ObjectChange }) {
  const [expanded, setExpanded] = useState(false);
  const hasSource = Boolean(o.before || o.after);
  return (
    <div style={{ marginLeft: 8, marginBottom: 3 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
        <ChangeChip change={o.change} />
        <span>{o.name}</span>
        {o.detail && <span style={mutedStyle}>{o.detail}</span>}
        {hasSource && (
          <button style={linkButtonStyle} onClick={() => setExpanded((e) => !e)}>
            {expanded ? "hide" : "view"}
          </button>
        )}
      </div>

      {(o.addedCapabilities?.length ?? 0) > 0 && (
        <div style={warnBoxStyle}>
          Gains permission to: {o.addedCapabilities!.join(", ")}. A distributed
          script that can reach further than it could before is a change a
          subscriber has to agree to.
        </div>
      )}

      {expanded && (
        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <SourcePane label="Before" text={o.before} truncated={o.beforeTruncated} />
          <SourcePane label="After" text={o.after} truncated={o.afterTruncated} />
        </div>
      )}
    </div>
  );
}

function SourcePane({
  label: l,
  text,
  truncated,
}: {
  label: string;
  text?: string;
  truncated?: boolean;
}) {
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={mutedStyle}>{l}</div>
      <pre
        style={{
          margin: 0,
          padding: "4px 6px",
          background: "var(--bg-subtle, rgba(127,127,127,0.08))",
          border: "1px solid var(--border-default)",
          borderRadius: 3,
          fontSize: "11px",
          maxHeight: 220,
          overflow: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {text ?? "(none)"}
      </pre>
      {truncated && <div style={mutedStyle}>…truncated</div>}
    </div>
  );
}

function ChangeChip({ change }: { change: string }) {
  const color =
    change === "added"
      ? "#0a7d32"
      : change === "removed"
        ? "#b02a37"
        : change === "renamed"
          ? "#8a6d00"
          : "#0b5cad";
  const glyph =
    change === "added" ? "+" : change === "removed" ? "−" : change === "renamed" ? "→" : "~";
  return (
    <span
      title={change}
      style={{
        display: "inline-block",
        minWidth: 14,
        textAlign: "center",
        fontWeight: 700,
        color,
      }}
    >
      {glyph}
    </span>
  );
}

function renderCell(snapshot?: { display: string; formula?: string }) {
  if (!snapshot) return <span style={mutedStyle}>(empty)</span>;
  if (snapshot.formula) {
    return <code style={{ fontSize: "11px" }}>={snapshot.formula}</code>;
  }
  return snapshot.display || <span style={mutedStyle}>(empty)</span>;
}

function cellTotal(s: SheetDiffSummary): number {
  return s.cellsAdded + s.cellsRemoved + s.cellsModified;
}

function presentationChanged(s: SheetDiffSummary): boolean {
  return s.stylesTableChanged || s.layoutChanged || s.metadataChanged || s.styleChangedCells > 0;
}

function groupByDomain(objects: ObjectChange[]): Array<[string, ObjectChange[]]> {
  const map = new Map<string, ObjectChange[]>();
  for (const o of objects) {
    const list = map.get(o.domain) ?? [];
    list.push(o);
    map.set(o.domain, list);
  }
  return Array.from(map.entries());
}

/** Domain ids are code vocabulary; these are what a person calls them. */
const DOMAIN_LABELS: Record<string, string> = {
  chart: "Charts",
  table: "Tables",
  objectScript: "Object scripts",
  moduleScript: "Module scripts",
  notebook: "Notebooks",
  namedRange: "Named ranges",
  modelMeasure: "Model measures",
  modelTable: "Model tables",
  control: "Controls",
  paneControl: "Pane controls",
  slicer: "Slicers",
  ribbonFilter: "Ribbon filters",
  pivot: "Pivots",
  pivotLayout: "Pivot layouts",
  customObject: "Custom objects",
  media: "Images and media",
  conditionalFormat: "Conditional formatting",
  dataValidation: "Data validation",
  comment: "Comments",
  scenario: "Scenarios",
  outline: "Outlines",
  cellBehavior: "Cell behaviors",
  sparkline: "Sparklines",
  theme: "Theme",
  extensionData: "Extension data",
  writebackRegion: "Writeback regions",
  modelWriteback: "Writeback columns",
  artifact: "Other application files",
};

function domainLabel(domain: string): string {
  return DOMAIN_LABELS[domain] ?? domain;
}

function label(version: string): string {
  return version === "working copy" ? "your working copy" : `v${version}`;
}

const mutedStyle: React.CSSProperties = {
  color: "var(--text-secondary)",
  fontSize: "11px",
};
const warnBoxStyle: React.CSSProperties = {
  marginTop: 4,
  padding: "4px 6px",
  borderRadius: 3,
  background: "#fff3cd",
  color: "#664d03",
  fontSize: "11px",
  lineHeight: 1.4,
};
const linkButtonStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--link-color, #0b5cad)",
  cursor: "pointer",
  padding: 0,
  fontSize: "11px",
  textDecoration: "underline",
};
const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "2px 6px",
  borderBottom: "1px solid var(--border-default)",
  color: "var(--text-secondary)",
  fontWeight: 600,
};
const tdStyle: React.CSSProperties = {
  padding: "2px 6px",
  borderBottom: "1px solid var(--border-default)",
  verticalAlign: "top",
};
const cellTextStyle: React.CSSProperties = {
  maxWidth: 260,
  overflowWrap: "anywhere",
};
