// FILENAME: app/extensions/Distribution/components/OverridesPane.tsx
// PURPOSE: Task pane showing overrides, conflicts, and pending refresh changes.
// CONTEXT: Three tabbed views per the design doc.

import React, { useState, useEffect, useCallback } from "react";
import {
  getOverrides,
  revertOverride,
  acceptUpstream,
  keepOverride,
  type OverrideLayer,
  type CellOverride,
  type OverrideValue,
} from "@api";

type TabId = "overrides" | "conflicts" | "pending";

/** Format an OverrideValue for display */
function formatValue(val: OverrideValue | null): string {
  if (!val) return "";
  switch (val.type) {
    case "value": return val.display;
    case "formula": return `=${val.formula}`;
    case "empty": return "(empty)";
  }
}

/** Format a cell position as A1 reference */
function posToRef(pos: [number, number]): string {
  let col = "";
  let c = pos[1];
  do {
    col = String.fromCharCode(65 + (c % 26)) + col;
    c = Math.floor(c / 26) - 1;
  } while (c >= 0);
  return `${col}${pos[0] + 1}`;
}

/** Single override row in the list */
function OverrideRow({
  ovr,
  onRevert,
  onAcceptUpstream,
  onKeepOverride,
}: {
  ovr: CellOverride;
  onRevert: () => void;
  onAcceptUpstream: () => void;
  onKeepOverride: () => void;
}) {
  return (
    <div
      style={{
        padding: "6px 8px",
        borderBottom: "1px solid var(--border-color, #e0e0e0)",
        backgroundColor: ovr.conflict ? "var(--conflict-bg, #fff3cd)" : "transparent",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontWeight: 500, fontFamily: "monospace" }}>
          {posToRef(ovr.position)}
        </span>
        <span style={{ fontSize: "11px", color: "var(--text-secondary, #888)" }}>
          {ovr.conflict ? "CONFLICT" : "override"}
        </span>
      </div>
      <div style={{ fontSize: "12px", marginTop: "2px" }}>
        <span style={{ color: "var(--text-secondary, #888)" }}>Upstream: </span>
        <span>{formatValue(ovr.baseline)}</span>
        {ovr.conflict && ovr.upstreamNew && (
          <>
            <span style={{ color: "var(--text-secondary, #888)" }}>{" -> "}</span>
            <span style={{ color: "var(--conflict-text, #856404)" }}>{formatValue(ovr.upstreamNew)}</span>
          </>
        )}
      </div>
      <div style={{ fontSize: "12px" }}>
        <span style={{ color: "var(--text-secondary, #888)" }}>Local: </span>
        <span style={{ fontWeight: 500 }}>{formatValue(ovr.current)}</span>
      </div>
      <div style={{ marginTop: "4px", display: "flex", gap: "4px" }}>
        {ovr.conflict ? (
          <>
            <button onClick={onAcceptUpstream} style={{ fontSize: "11px" }}>Accept Upstream</button>
            <button onClick={onKeepOverride} style={{ fontSize: "11px" }}>Keep Mine</button>
          </>
        ) : (
          <button onClick={onRevert} style={{ fontSize: "11px" }}>Revert</button>
        )}
      </div>
    </div>
  );
}

/** Main overrides pane component */
export function OverridesPane() {
  const [activeTab, setActiveTab] = useState<TabId>("overrides");
  const [layer, setLayer] = useState<OverrideLayer | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      const data = await getOverrides();
      setLayer(data);
    } catch (err) {
      console.error("[Distribution] Failed to load overrides:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  if (loading || !layer) {
    return <div style={{ padding: "12px" }}>Loading...</div>;
  }

  const allOverrides = layer.overrides;
  const conflicts = allOverrides.filter((o) => o.conflict);
  const nonConflicts = allOverrides.filter((o) => !o.conflict);

  const handleRevert = async (ovr: CellOverride) => {
    await revertOverride(ovr.sheetId, ovr.cellId);
    refresh();
  };

  const handleAcceptUpstream = async (ovr: CellOverride) => {
    await acceptUpstream(ovr.sheetId, ovr.cellId);
    refresh();
  };

  const handleKeepOverride = async (ovr: CellOverride) => {
    await keepOverride(ovr.sheetId, ovr.cellId);
    refresh();
  };

  const renderList = (items: CellOverride[]) => {
    if (items.length === 0) {
      return (
        <div style={{ padding: "20px", textAlign: "center", color: "var(--text-secondary, #888)" }}>
          No items
        </div>
      );
    }
    return items.map((ovr) => (
      <OverrideRow
        key={`${ovr.sheetId}-${ovr.cellId}`}
        ovr={ovr}
        onRevert={() => handleRevert(ovr)}
        onAcceptUpstream={() => handleAcceptUpstream(ovr)}
        onKeepOverride={() => handleKeepOverride(ovr)}
      />
    ));
  };

  const tabs: { id: TabId; label: string; count: number }[] = [
    { id: "overrides", label: "Overrides", count: nonConflicts.length },
    { id: "conflicts", label: "Conflicts", count: conflicts.length },
    { id: "pending", label: "Pending", count: 0 },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Tab bar */}
      <div style={{ display: "flex", borderBottom: "1px solid var(--border-color, #e0e0e0)" }}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              flex: 1,
              padding: "6px 4px",
              border: "none",
              borderBottom: activeTab === tab.id ? "2px solid var(--accent-color, #0078d4)" : "2px solid transparent",
              background: "none",
              fontWeight: activeTab === tab.id ? 600 : 400,
              fontSize: "12px",
              cursor: "pointer",
            }}
          >
            {tab.label} {tab.count > 0 && `(${tab.count})`}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: "auto" }}>
        {activeTab === "overrides" && renderList(nonConflicts)}
        {activeTab === "conflicts" && renderList(conflicts)}
        {activeTab === "pending" && (
          <div style={{ padding: "20px", textAlign: "center", color: "var(--text-secondary, #888)" }}>
            {"Use Data > Refresh to check for updates"}
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={{
        padding: "4px 8px",
        borderTop: "1px solid var(--border-color, #e0e0e0)",
        fontSize: "11px",
        color: "var(--text-secondary, #888)",
        display: "flex",
        justifyContent: "space-between",
      }}>
        <span>{allOverrides.length} override(s)</span>
        {conflicts.length > 0 && (
          <span style={{ color: "var(--conflict-text, #856404)" }}>
            {conflicts.length} conflict(s)
          </span>
        )}
      </div>
    </div>
  );
}
