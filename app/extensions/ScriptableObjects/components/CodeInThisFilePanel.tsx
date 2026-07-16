//! FILENAME: app/extensions/ScriptableObjects/components/CodeInThisFilePanel.tsx
// PURPOSE: The "Code in This File" transparency inspector (T1) — a single, per-
//          workbook inventory of EVERY piece of executable code in the open
//          file: where it resides, where it came from, what it is allowed to
//          touch, and (inline) its actual source. The vision made literal:
//          "the user must always know where code resides and what it can touch
//          -- never hidden inside a binary file."
// CONTEXT: Registered via the sections-based panel API in ../index.ts. Reads the
//          unified inventory from @api/codeInventory (getWorkbookCodeUnits),
//          which joins object scripts (worker-realm, real capability ceiling)
//          with module scripts and notebooks (isolated Rust QuickJS, grid-only).
//          Surface headers come straight from the SCRIPT_SURFACES taxonomy, so
//          that governance spine finally has a per-file UI consumer.

import React, { useState, useEffect, useCallback } from "react";
import {
  getWorkbookCodeUnits,
  summarizeCodeInventory,
  getScriptSurface,
} from "@api";
import type {
  CodeUnit,
  CodeInventorySummary,
  CapabilityId,
} from "@api";
import type { PanelSectionProps } from "@api/uiTypes";
import { emitAppEvent, onAppEvent } from "@api/events";
import { ScriptableObjectEvents } from "../index";

// ============================================================================
// Capability labels (short, human; the ids are the single vocabulary source)
// ============================================================================

const CAP_LABEL: Record<CapabilityId, string> = {
  "net.fetch": "Network",
  "bi.query": "BI query",
  "bi.sql": "BI SQL",
  storage: "Storage",
  "ui.html": "Host HTML",
  "formula.udf": "Worksheet fn",
  "bi.model": "BI model edit",
  "bi.connector": "BI connector",
};

const capLabel = (c: CapabilityId): string => CAP_LABEL[c] ?? c;

// ============================================================================
// Styles (match PermissionsPanel / ObjectScriptManagerPane conventions)
// ============================================================================

const rootStyle = (placement: "sidebar" | "ribbon"): React.CSSProperties => ({
  fontFamily: "'Segoe UI', Tahoma, sans-serif",
  fontSize: 11,
  color: "#333",
  ...(placement === "ribbon" ? { width: 380, height: "100%", overflowY: "auto" } : {}),
});

const introStyle: React.CSSProperties = {
  padding: "6px 4px 8px",
  color: "#666",
  lineHeight: 1.4,
};

const summaryRowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 4,
  padding: "0 4px 6px",
};

const chipStyle: React.CSSProperties = {
  fontSize: 10,
  padding: "1px 6px",
  borderRadius: 3,
  backgroundColor: "#EEF1F4",
  color: "#555",
  whiteSpace: "nowrap",
};

const warnChipStyle: React.CSSProperties = {
  ...chipStyle,
  backgroundColor: "#FCEEDB",
  color: "#9A5B00",
};

const reachCalloutStyle: React.CSSProperties = {
  margin: "0 4px 8px",
  padding: "6px 8px",
  borderRadius: 4,
  backgroundColor: "#FCEEDB",
  color: "#7A4A00",
  fontSize: 10.5,
  lineHeight: 1.4,
};

const groupHeaderStyle: React.CSSProperties = {
  marginTop: 10,
  padding: "4px 4px 2px",
  borderBottom: "1px solid #E0E0E0",
};

const groupTitleStyle: React.CSSProperties = {
  fontWeight: 600,
  fontSize: 11.5,
  color: "#2A2A2A",
};

const groupContainmentStyle: React.CSSProperties = {
  fontSize: 9.5,
  color: "#999",
  marginTop: 1,
};

const unitStyle: React.CSSProperties = {
  padding: "6px 4px",
  borderBottom: "1px solid #F0F0F0",
};

const unitHeaderRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 6,
};

const unitNameStyle: React.CSSProperties = { fontWeight: 600, color: "#1A1A1A" };
const residenceStyle: React.CSSProperties = { fontSize: 10, color: "#777", marginTop: 1 };

const badgeRowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 4,
  marginTop: 4,
  alignItems: "center",
};

const localBadge: React.CSSProperties = {
  ...chipStyle,
  backgroundColor: "#E6F0E6",
  color: "#3A6B3A",
};
const pkgBadge: React.CSSProperties = {
  ...chipStyle,
  backgroundColor: "#E6ECF6",
  color: "#33558A",
};
const tierBadge: React.CSSProperties = { ...chipStyle, backgroundColor: "#E8E8E8", color: "#555" };
const gridOnlyBadge: React.CSSProperties = {
  ...chipStyle,
  backgroundColor: "#EAF4EA",
  color: "#3A6B3A",
};
const capCeilingBadge: React.CSSProperties = {
  ...chipStyle,
  backgroundColor: "#FCEEDB",
  color: "#9A5B00",
};
const capGrantedBadge: React.CSSProperties = {
  ...chipStyle,
  backgroundColor: "#F4D6A6",
  color: "#7A4A00",
  fontWeight: 600,
};

const linkBtnStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#2A6FB0",
  cursor: "pointer",
  fontSize: 10,
  padding: 0,
  textDecoration: "underline",
};

const codeBlockStyle: React.CSSProperties = {
  marginTop: 6,
  padding: 8,
  backgroundColor: "#1E1E1E",
  color: "#D4D4D4",
  fontFamily: "'Cascadia Code', Consolas, monospace",
  fontSize: 10.5,
  lineHeight: 1.45,
  borderRadius: 4,
  maxHeight: 280,
  overflow: "auto",
  whiteSpace: "pre",
};

const emptyStyle: React.CSSProperties = { padding: "12px 6px", color: "#999" };

// ============================================================================
// Unit row
// ============================================================================

function CodeUnitRow({ unit }: { unit: CodeUnit }): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const granted = new Set(unit.liveGrants ?? []);

  const openInEditor = useCallback(() => {
    // The EDIT_SCRIPT handler resolves an existing script by id (object scripts
    // only) and opens it in the code editor without scaffolding.
    emitAppEvent(ScriptableObjectEvents.EDIT_SCRIPT, { scriptId: unit.id });
  }, [unit.id]);

  return (
    <div style={unitStyle}>
      <div style={unitHeaderRowStyle}>
        <span style={unitNameStyle}>{unit.name}</span>
        <span style={{ fontSize: 9.5, color: "#AAA", whiteSpace: "nowrap" }}>
          {unit.lineCount} {unit.lineCount === 1 ? "line" : "lines"}
        </span>
      </div>
      <div style={residenceStyle}>{unit.residence}</div>

      <div style={badgeRowStyle}>
        {unit.provenance === "distributed" ? (
          <span style={pkgBadge} title="Arrived in a distributed package">
            Package: {unit.sourcePackage ?? "unknown"}
          </span>
        ) : (
          <span style={localBadge} title="Authored in this workbook">
            Local
          </span>
        )}
        {unit.tier && (
          <span style={tierBadge} title="Reach tier">
            {unit.tier === "unlocked" ? "Unlocked" : "Restricted"}
          </span>
        )}
        {unit.mounted && (
          <span style={{ ...chipStyle, backgroundColor: "#E6F0E6", color: "#3A6B3A" }}>
            Active
          </span>
        )}

        {/* What it can touch */}
        {unit.declaredCapabilities.length === 0 ? (
          <span style={gridOnlyBadge} title="Sandboxed to grid data only">
            Grid-only
          </span>
        ) : (
          unit.declaredCapabilities.map((c) => {
            const isGranted = granted.has(c);
            return (
              <span
                key={c}
                style={isGranted ? capGrantedBadge : capCeilingBadge}
                title={
                  isGranted
                    ? `${capLabel(c)} — granted now`
                    : `${capLabel(c)} — in the declared ceiling (not currently granted)`
                }
              >
                {capLabel(c)}
                {isGranted ? " *" : ""}
              </span>
            );
          })
        )}
      </div>

      <div style={{ marginTop: 4, display: "flex", gap: 10 }}>
        <button style={linkBtnStyle} onClick={() => setExpanded((e) => !e)}>
          {expanded ? "Hide code" : "View code"}
        </button>
        {unit.surfaceId === "object-script" && (
          <button style={linkBtnStyle} onClick={openInEditor}>
            Open in editor
          </button>
        )}
      </div>

      {expanded && (
        <pre style={codeBlockStyle}>{unit.source || "(no source)"}</pre>
      )}
    </div>
  );
}

// ============================================================================
// Panel section
// ============================================================================

export function CodeInThisFileSection({ placement }: PanelSectionProps): React.ReactElement {
  const [summary, setSummary] = useState<CodeInventorySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const units = await getWorkbookCodeUnits();
      setSummary(summarizeCodeInventory(units));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    // The set of scripts changes when a workbook loads or scripts are
    // (un)registered; SCRIPTS_LOADED is emitted on the app-event bus after each
    // (re)load. onAppEvent returns its own unsubscribe.
    const off = onAppEvent(ScriptableObjectEvents.SCRIPTS_LOADED, () => void reload());
    return off;
  }, [reload]);

  return (
    <div style={rootStyle(placement)}>
      <div style={introStyle}>
        Every piece of code that lives in this workbook — where it resides, where
        it came from, and what it is allowed to touch. Nothing here is hidden
        inside the file.
      </div>

      {summary && (
        <>
          <div style={summaryRowStyle}>
            <span style={chipStyle}>{summary.total} code units</span>
            <span style={chipStyle}>{summary.local} local</span>
            <span style={chipStyle}>{summary.distributed} from packages</span>
            {summary.mounted > 0 && <span style={chipStyle}>{summary.mounted} active</span>}
            {summary.beyondGrid > 0 && (
              <span style={warnChipStyle}>{summary.beyondGrid} reach beyond the grid</span>
            )}
          </div>
          {summary.beyondGrid > 0 && (
            <div style={reachCalloutStyle}>
              {summary.beyondGrid} script{summary.beyondGrid === 1 ? "" : "s"} may reach
              outside the grid (network, BI, storage, or host HTML) up to their declared
              ceiling. Every other unit is sandboxed to grid data only.
            </div>
          )}
        </>
      )}

      <div style={{ padding: "0 4px 6px" }}>
        <button style={linkBtnStyle} onClick={() => void reload()} disabled={loading}>
          {loading ? "Scanning..." : "Refresh"}
        </button>
      </div>

      {error && (
        <div style={{ ...emptyStyle, color: "#B00020" }}>
          Could not read the code inventory: {error}
        </div>
      )}

      {!error && summary && summary.total === 0 && (
        <div style={emptyStyle}>This workbook contains no code.</div>
      )}

      {!error &&
        summary &&
        summary.bySurface.map((group) => {
          const surface = getScriptSurface(group.surfaceId);
          return (
            <div key={group.surfaceId}>
              <div style={groupHeaderStyle}>
                <div style={groupTitleStyle}>
                  {surface?.label ?? group.surfaceId} ({group.units.length})
                </div>
                {surface && (
                  <div style={groupContainmentStyle}>{surface.containment}</div>
                )}
              </div>
              {group.units.map((u) => (
                <CodeUnitRow key={`${u.surfaceId}:${u.id}`} unit={u} />
              ))}
            </div>
          );
        })}
    </div>
  );
}
