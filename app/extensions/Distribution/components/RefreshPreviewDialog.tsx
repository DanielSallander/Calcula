// FILENAME: app/extensions/Distribution/components/RefreshPreviewDialog.tsx
// PURPOSE: Dialog showing a preview of what a refresh would change, with confirm/cancel.

import React, { useState, useEffect } from "react";
import type { DialogProps } from "@api";
import { refreshPreview, refreshApply, calculateNow, emitAppEvent, type RefreshPreview } from "@api";

export function RefreshPreviewDialog({ onClose }: DialogProps) {
  const [preview, setPreview] = useState<RefreshPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const p = await refreshPreview();
        setPreview(p);
      } catch (err: unknown) {
        setError(String(err));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleApply = async () => {
    setApplying(true);
    setError(null);
    try {
      const r = await refreshApply();
      // Recalculate (re-overlaid formula overrides have empty values until
      // evaluated) and refetch grid data so the refreshed content shows.
      try {
        await calculateNow();
      } catch (err) {
        console.error("[Distribution] Recalc after refresh failed:", err);
      }
      window.dispatchEvent(new CustomEvent("grid:refresh"));
      // The refresh may have replaced distributed scripts with the new
      // package versions — reload them so changed sources re-prompt for
      // consent (ScriptableObjects de-dupes unchanged ones by source hash).
      emitAppEvent("calp:scripts-pulled", {});
      // Pane controls may also have changed — tell the Controls pane to
      // reload (cross-extension window event; same name the shell fans the
      // paneControl mutation domain out as).
      window.dispatchEvent(new CustomEvent("controlspane:controls-refreshed"));
      setResult(
        `Refreshed ${r.subscriptionsRefreshed} subscription(s). ` +
        `${r.sheetsAdded} added, ${r.sheetsUpdated} updated, ${r.sheetsRemoved} removed. ` +
        `${r.conflictsCreated} conflict(s).`
      );
    } catch (err: unknown) {
      setError(String(err));
    } finally {
      setApplying(false);
    }
  };

  if (loading) {
    return <div style={{ padding: "20px" }}>Computing refresh preview...</div>;
  }

  if (result) {
    return (
      <div style={{ padding: "16px", width: "450px" }}>
        <h3 style={{ margin: "0 0 12px 0" }}>Refresh Complete</h3>
        <p>{result}</p>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    );
  }

  // Show preview errors before the no-updates state — a failed preview must
  // not render as "all up to date".
  if (error && !preview) {
    return (
      <div style={{ padding: "16px", width: "450px" }}>
        <h3 style={{ margin: "0 0 12px 0" }}>Refresh Failed</h3>
        <div style={{ color: "red", marginBottom: "12px", fontSize: "12px" }}>{error}</div>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    );
  }

  if (!preview || preview.subscriptionPreviews.length === 0) {
    return (
      <div style={{ padding: "16px", width: "400px" }}>
        <h3 style={{ margin: "0 0 12px 0" }}>No Updates Available</h3>
        <p>All subscriptions are up to date.</p>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: "16px", width: "500px" }}>
      <h3 style={{ margin: "0 0 12px 0" }}>Refresh Preview</h3>

      {preview.subscriptionPreviews.map((sp) => (
        <div key={sp.packageName} style={{
          marginBottom: "12px",
          padding: "8px",
          border: "1px solid var(--border-color, #e0e0e0)",
          borderRadius: "4px",
        }}>
          <div style={{ fontWeight: 600 }}>{sp.packageName}</div>
          <div style={{ fontSize: "12px", color: "#666" }}>
            {sp.currentVersion} {"->"}  {sp.newVersion}
          </div>
          {sp.sheetsAdded.length > 0 && (
            <div style={{ fontSize: "12px", color: "green" }}>
              + {sp.sheetsAdded.length} sheet(s) added: {sp.sheetsAdded.map((s) => s.name).join(", ")}
            </div>
          )}
          {sp.sheetsRemoved.length > 0 && (
            <div style={{ fontSize: "12px", color: "red" }}>
              - {sp.sheetsRemoved.length} sheet(s) removed: {sp.sheetsRemoved.map((s) => s.name).join(", ")}
            </div>
          )}
          {sp.sheetsUpdated.length > 0 && (
            <div style={{ fontSize: "12px" }}>
              ~ {sp.sheetsUpdated.length} sheet(s) updated
            </div>
          )}
          {sp.overridesConflicted > 0 && (
            <div style={{ fontSize: "12px", color: "var(--conflict-text, #856404)" }}>
              {sp.overridesConflicted} override(s) may conflict
            </div>
          )}
        </div>
      ))}

      <div style={{ fontSize: "12px", marginBottom: "12px", color: "#666" }}>
        Total: {preview.totalSheetsAdded} added, {preview.totalSheetsRemoved} removed,
        {preview.totalOverridesConflicted} potential conflict(s)
      </div>

      {error && <div style={{ color: "red", marginBottom: "8px", fontSize: "12px" }}>{error}</div>}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
        <button onClick={onClose}>Cancel</button>
        <button onClick={handleApply} disabled={applying} style={{ fontWeight: 600 }}>
          {applying ? "Applying..." : "Apply Refresh"}
        </button>
      </div>
    </div>
  );
}
