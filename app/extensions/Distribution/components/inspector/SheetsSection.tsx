// FILENAME: app/extensions/Distribution/components/inspector/SheetsSection.tsx
// PURPOSE: Per-sheet deep view: the actual published cell data (values,
//          formulas, types) rendered as a read-only grid or a flat cell list,
//          plus layout + presentation metadata disclosure.

import React, { useEffect, useMemo, useState } from "react";
import {
  inspectorSheet,
  type InspectorOverview,
  type InspectorSheetDetail,
  type InspectorSheetSummary,
} from "@api/distribution";
import type { InspectorContext } from "./PackageInspectorApp";
import {
  ACCENT,
  BORDER,
  StatusLine,
  buttonStyle,
  cardHeaderStyle,
  cardStyle,
  mutedStyle,
  sectionTitleStyle,
  tableStyle,
  tdStyle,
  thStyle,
} from "./shared";

const GRID_MAX_ROWS = 300;
const GRID_MAX_COLS = 60;

function colLetters(col: number): string {
  let s = "";
  let c = col;
  for (;;) {
    s = String.fromCharCode(65 + (c % 26)) + s;
    if (c < 26) break;
    c = Math.floor(c / 26) - 1;
  }
  return s;
}

function SheetPicker({
  sheets,
  selected,
  onSelect,
}: {
  sheets: InspectorSheetSummary[];
  selected: string | null;
  onSelect: (sheetId: string) => void;
}): React.ReactElement {
  return (
    <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 10 }}>
      {sheets.map((s) => (
        <button
          key={s.sheetId}
          style={{
            ...buttonStyle,
            borderColor: selected === s.sheetId ? ACCENT : BORDER,
            color: selected === s.sheetId ? ACCENT : undefined,
            fontWeight: selected === s.sheetId ? 600 : 400,
          }}
          onClick={() => onSelect(s.sheetId)}
        >
          {s.name} <span style={mutedStyle}>({s.cellCount})</span>
        </button>
      ))}
    </div>
  );
}

function MetadataChips({ detail }: { detail: InspectorSheetDetail }): React.ReactElement {
  const m = detail.metadata;
  const chips: string[] = [];
  if (m.mergedRegions.length) chips.push(`${m.mergedRegions.length} merged regions`);
  if (m.freezeRow !== null || m.freezeCol !== null)
    chips.push(
      `freeze at ${m.freezeRow !== null ? `row ${m.freezeRow + 1}` : ""}${
        m.freezeRow !== null && m.freezeCol !== null ? ", " : ""
      }${m.freezeCol !== null ? `col ${colLetters(m.freezeCol)}` : ""}`,
    );
  if (m.hiddenRowCount) chips.push(`${m.hiddenRowCount} hidden rows`);
  if (m.hiddenColCount) chips.push(`${m.hiddenColCount} hidden columns`);
  if (m.noteCount) chips.push(`${m.noteCount} notes`);
  if (m.hyperlinkCount) chips.push(`${m.hyperlinkCount} hyperlinks`);
  if (m.tabColor) chips.push(`tab color ${m.tabColor}`);
  if (m.visibility !== "visible") chips.push(`visibility: ${m.visibility}`);
  if (m.hasPageSetup) chips.push("custom page setup");
  if (!m.showGridlines) chips.push("gridlines hidden");
  if (detail.styleCount) chips.push(`${detail.styleCount} styles / ${detail.styledCellCount} styled cells`);
  if (Object.keys(detail.columnWidths).length)
    chips.push(`${Object.keys(detail.columnWidths).length} custom column widths`);
  if (Object.keys(detail.rowHeights).length)
    chips.push(`${Object.keys(detail.rowHeights).length} custom row heights`);
  if (chips.length === 0)
    return <div style={{ ...mutedStyle, fontSize: 12 }}>No presentation metadata.</div>;
  return (
    <div style={{ fontSize: 12 }}>
      {chips.map((c) => (
        <span
          key={c}
          style={{
            display: "inline-block",
            padding: "2px 8px",
            margin: "0 6px 4px 0",
            background: "#f0f2f4",
            borderRadius: 3,
          }}
        >
          {c}
        </span>
      ))}
    </div>
  );
}

function DataGrid({ detail }: { detail: InspectorSheetDetail }): React.ReactElement {
  const range = detail.usedRange;
  const cellMap = useMemo(() => {
    const map = new Map<string, (typeof detail.cells)[number]>();
    for (const c of detail.cells) map.set(`${c.row}:${c.col}`, c);
    return map;
  }, [detail]);

  if (!range) return <div style={{ ...mutedStyle, fontSize: 12 }}>The sheet has no cells.</div>;

  const rowEnd = Math.min(range.maxRow, range.minRow + GRID_MAX_ROWS - 1);
  const colEnd = Math.min(range.maxCol, range.minCol + GRID_MAX_COLS - 1);
  const rows: number[] = [];
  for (let r = range.minRow; r <= rowEnd; r++) rows.push(r);
  const cols: number[] = [];
  for (let c = range.minCol; c <= colEnd; c++) cols.push(c);
  const clipped = rowEnd < range.maxRow || colEnd < range.maxCol;

  const cellTd: React.CSSProperties = {
    border: "1px solid #e3e5e8",
    padding: "1px 6px",
    fontSize: 11,
    maxWidth: 180,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    background: "#fff",
  };
  const headTd: React.CSSProperties = {
    ...cellTd,
    background: "#f0f2f4",
    color: "#555",
    fontWeight: 600,
    textAlign: "center",
  };

  return (
    <div style={{ overflow: "auto", maxHeight: 460, border: `1px solid ${BORDER}` }}>
      <table style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={headTd}></th>
            {cols.map((c) => (
              <th key={c} style={headTd}>
                {colLetters(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r}>
              <td style={headTd}>{r + 1}</td>
              {cols.map((c) => {
                const cell = cellMap.get(`${r}:${c}`);
                const isFormula = !!cell?.formula;
                const isNumber = cell?.cellType === "n";
                return (
                  <td
                    key={c}
                    style={{
                      ...cellTd,
                      background: isFormula ? "#f2f8ff" : cellTd.background,
                      textAlign: isNumber ? "right" : "left",
                    }}
                    title={
                      cell
                        ? `${cell.a1}${cell.formula ? `  =${cell.formula}` : ""}`
                        : undefined
                    }
                  >
                    {cell?.cellType === "e" ? (
                      <span style={{ color: "#c0392b" }}>{cell.display}</span>
                    ) : (
                      cell?.display ?? ""
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {clipped && (
        <div style={{ ...mutedStyle, fontSize: 11, padding: 6 }}>
          Showing the first {GRID_MAX_ROWS} rows × {GRID_MAX_COLS} columns of the used range —
          switch to the cell list for everything.
        </div>
      )}
    </div>
  );
}

const CELL_LIST_CHUNK = 500;

function CellList({ detail }: { detail: InspectorSheetDetail }): React.ReactElement {
  // Chunked render: the backend serves up to 20,000 cells — committing them
  // all as DOM rows in one go freezes the window.
  const [visibleCount, setVisibleCount] = useState(CELL_LIST_CHUNK);
  useEffect(() => {
    setVisibleCount(CELL_LIST_CHUNK);
  }, [detail]);
  const shown = detail.cells.slice(0, visibleCount);
  const remaining = detail.cells.length - shown.length;

  return (
    <div style={{ overflow: "auto", maxHeight: 460, border: `1px solid ${BORDER}` }}>
      <table style={{ ...tableStyle, width: "auto", minWidth: "100%" }}>
        <thead>
          <tr>
            <th style={{ ...thStyle, paddingLeft: 8 }}>Cell</th>
            <th style={thStyle}>Type</th>
            <th style={thStyle}>Value</th>
            <th style={thStyle}>Formula</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((c) => (
            <tr key={c.a1}>
              <td style={{ ...tdStyle, paddingLeft: 8, fontWeight: 600 }}>{c.a1}</td>
              <td style={{ ...tdStyle, ...mutedStyle }}>{c.cellType}</td>
              <td style={{ ...tdStyle, maxWidth: 320, wordBreak: "break-word" }}>{c.display}</td>
              <td style={{ ...tdStyle, fontFamily: "Consolas, monospace", fontSize: 11 }}>
                {c.formula ? `=${c.formula}` : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {remaining > 0 && (
        <div style={{ padding: 6 }}>
          <button
            style={buttonStyle}
            onClick={() => setVisibleCount((n) => n + CELL_LIST_CHUNK * 4)}
          >
            Show {Math.min(remaining, CELL_LIST_CHUNK * 4)} more ({remaining} remaining)
          </button>
        </div>
      )}
    </div>
  );
}

export function SheetsSection({
  ctx,
  overview,
}: {
  ctx: InspectorContext;
  overview: InspectorOverview;
}): React.ReactElement {
  const [selected, setSelected] = useState<string | null>(
    overview.sheets.length > 0 ? overview.sheets[0].sheetId : null,
  );
  const [detail, setDetail] = useState<InspectorSheetDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"grid" | "list">("grid");

  // Fetch inside the effect with a cleanup-scoped stale flag: a slow response
  // for a previously selected sheet must never clobber the current one.
  useEffect(() => {
    if (!selected) return;
    let stale = false;
    setLoading(true);
    setError(null);
    setDetail(null);
    inspectorSheet(ctx.registryPath, ctx.packageName, ctx.version, selected)
      .then((d) => {
        if (!stale) setDetail(d);
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

  if (overview.sheets.length === 0) {
    return (
      <div>
        <h2 style={sectionTitleStyle}>Sheets &amp; Data</h2>
        <StatusLine empty emptyText="This package carries no sheets (model-only dataset)." />
      </div>
    );
  }

  return (
    <div>
      <h2 style={sectionTitleStyle}>Sheets &amp; Data</h2>
      <SheetPicker sheets={overview.sheets} selected={selected} onSelect={setSelected} />
      <StatusLine error={error} loading={loading} />
      {detail && (
        <>
          <div style={cardStyle}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
              <div style={{ ...cardHeaderStyle, marginBottom: 0 }}>{detail.name}</div>
              <span style={{ ...mutedStyle, fontSize: 12 }}>
                {detail.totalCellCount} cells · {detail.formulaCount} formulas
                {detail.truncated ? " · truncated view" : ""}
              </span>
              <span style={{ flex: 1 }} />
              <button
                style={{ ...buttonStyle, fontWeight: view === "grid" ? 600 : 400 }}
                onClick={() => setView("grid")}
              >
                Grid
              </button>
              <button
                style={{ ...buttonStyle, fontWeight: view === "list" ? 600 : 400 }}
                onClick={() => setView("list")}
              >
                Cell list
              </button>
            </div>
            {view === "grid" ? <DataGrid detail={detail} /> : <CellList detail={detail} />}
          </div>
          <div style={cardStyle}>
            <div style={cardHeaderStyle}>Presentation &amp; layout</div>
            <MetadataChips detail={detail} />
          </div>
        </>
      )}
    </div>
  );
}
