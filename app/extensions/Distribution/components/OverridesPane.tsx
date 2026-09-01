// FILENAME: app/extensions/Distribution/components/OverridesPane.tsx
// PURPOSE: Task pane showing overrides, conflicts, and pending refresh changes.
// CONTEXT: Three tabbed views per the design doc.

import React, { useState, useEffect, useCallback } from "react";
import {
  getOverrides,
  revertOverride,
  acceptUpstream,
  keepOverride,
  calculateNow,
  getSubscriptions,
  exportOverrides,
  onAppEvent,
  AppEvents,
  type OverrideLayer,
  type CellOverride,
} from "@api";
// The three-way row lives beside the refresh resolver that also renders it.
// Two copies of a base/mine/theirs comparison is how the pane and the dialog
// come to disagree about which value is "theirs".
import { ThreeWayRow, posToRef } from "./ThreeWayRow";
import { saveJsonPatch } from "../lib/reportExport";
import { runOverrideExport } from "../lib/overrideExport";
import { promptAsync, alertAsync } from "@api/dialogs";

type TabId = "overrides" | "conflicts" | "pending";

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

  // Cell edits on subscribed sheets create/update overrides backend-side —
  // refetch (debounced) so the pane reflects them live while open.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = onAppEvent(AppEvents.CELL_VALUES_CHANGED, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { refresh(); }, 400);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsub();
    };
  }, [refresh]);

  if (loading || !layer) {
    return <div style={{ padding: "12px" }}>Loading...</div>;
  }

  const allOverrides = layer.overrides;
  const conflicts = allOverrides.filter((o) => o.conflict);
  const nonConflicts = allOverrides.filter((o) => !o.conflict);

  // Reverting / accepting writes the resolved value into the grid backend-side.
  // Recalculate dependents and refetch grid data so the change is visible.
  const refreshGridAfterResolve = async () => {
    try {
      await calculateNow();
    } catch (err) {
      console.error("[Distribution] Recalc after resolve failed:", err);
    }
    window.dispatchEvent(new CustomEvent("grid:refresh"));
  };

  const handleRevert = async (ovr: CellOverride) => {
    await revertOverride(ovr.sheetId, ovr.cellId);
    await refreshGridAfterResolve();
    refresh();
  };

  const handleAcceptUpstream = async (ovr: CellOverride) => {
    await acceptUpstream(ovr.sheetId, ovr.cellId);
    await refreshGridAfterResolve();
    refresh();
  };

  const handleKeepOverride = async (ovr: CellOverride) => {
    await keepOverride(ovr.sheetId, ovr.cellId);
    refresh();
  };

  // C2c: export this subscriber's override layer as a shareable .json patch so
  // another subscriber of the same application can import it.
  // Single-application-first; a multi-application workbook prompts for which one.
  const handleExportOverrides = async () => {
    try {
      await runOverrideExport({
        getSubscriptions,
        exportOverrides,
        saveJsonPatch,
        prompt: (message, def) => promptAsync(message, { defaultValue: def }),
        alert: (message) => alertAsync(message),
      });
    } catch (err) {
      console.error("[Distribution] Export overrides failed:", err);
      await alertAsync(`Export overrides failed: ${err}`, { kind: "error" });
    }
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
      <ThreeWayRow
        key={`${ovr.sheetId}-${ovr.cellId}`}
        mode="act"
        a1={posToRef(ovr.position)}
        baseline={ovr.baseline}
        current={ovr.current}
        upstreamNew={ovr.upstreamNew ?? null}
        conflict={ovr.conflict}
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
        <span style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          {conflicts.length > 0 && (
            <span style={{ color: "var(--conflict-text, #856404)" }}>
              {conflicts.length} conflict(s)
            </span>
          )}
          <button
            type="button"
            onClick={handleExportOverrides}
            disabled={allOverrides.length === 0}
            title="Save this workbook's overrides as a .json patch to share with another subscriber"
            style={{
              border: "1px solid var(--border-color, #e0e0e0)",
              background: "none",
              borderRadius: "3px",
              padding: "1px 6px",
              fontSize: "11px",
              cursor: allOverrides.length === 0 ? "default" : "pointer",
              opacity: allOverrides.length === 0 ? 0.5 : 1,
            }}
          >
            Export overrides…
          </button>
        </span>
      </div>
    </div>
  );
}
