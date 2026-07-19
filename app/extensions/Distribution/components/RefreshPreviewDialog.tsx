// FILENAME: app/extensions/Distribution/components/RefreshPreviewDialog.tsx
// PURPOSE: Floating window showing a preview of what a refresh would change,
// with confirm/cancel.
// CONTEXT: Non-modal like Publish/Subscribe — no backdrop, the workbook stays
// interactive (inspect sheets while deciding); movable + resizable via
// @api/dialogWindow; closes via its own buttons (dismissOnEscape false).

import React, { useState, useEffect } from "react";
import type { DialogProps } from "@api";
import { refreshPreview, refreshApply, calculateNow, emitAppEvent, type RefreshPreview } from "@api";
import { useDialogWindow } from "@api/dialogWindow";

export function RefreshPreviewDialog({ onClose }: DialogProps) {
  const win = useDialogWindow({ minWidth: 420, minHeight: 280 });
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

  const windowStyle: React.CSSProperties = {
    position: "fixed",
    left: "50%",
    top: "14%",
    transform: "translateX(-50%)",
    width: "500px",
    maxHeight: "78vh",
    zIndex: 1050,
    display: "flex",
    flexDirection: "column",
    background: "var(--panel-bg)",
    color: "var(--text-primary)",
    border: "1px solid var(--border-default)",
    borderRadius: "8px",
    boxShadow: "0 12px 40px rgba(0, 0, 0, 0.5)",
    fontFamily: '"Segoe UI", system-ui, sans-serif',
    fontSize: "13px",
  };
  const headerStyle: React.CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "8px 12px",
    flexShrink: 0,
    cursor: "grab",
    userSelect: "none",
    borderBottom: "1px solid var(--border-default)",
  };
  const closeButtonStyle: React.CSSProperties = {
    background: "transparent",
    border: "none",
    color: "var(--text-secondary)",
    cursor: "pointer",
    padding: "2px 8px",
    borderRadius: "4px",
    fontSize: "14px",
    lineHeight: 1,
  };
  const bodyStyle: React.CSSProperties = {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    padding: "12px 16px",
  };
  const footerStyle: React.CSSProperties = {
    display: "flex",
    justifyContent: "flex-end",
    gap: "8px",
    padding: "10px 16px",
    flexShrink: 0,
    borderTop: "1px solid var(--border-default)",
  };

  const title = result
    ? "Refresh Complete"
    : error && !preview
      ? "Refresh Failed"
      : !loading && (!preview || preview.subscriptionPreviews.length === 0)
        ? "No Updates Available"
        : "Refresh Preview";

  const showApply =
    !loading && !result && !(error && !preview) &&
    !!preview && preview.subscriptionPreviews.length > 0;

  return (
    <div ref={win.ref} style={{ ...windowStyle, ...win.style }}>
      <div style={headerStyle} onMouseDown={win.onHeaderMouseDown}>
        <span style={{ fontWeight: 600 }}>{title}</span>
        <button style={closeButtonStyle} onClick={onClose} aria-label="Close" title="Close">
          ✕
        </button>
      </div>

      <div style={bodyStyle}>
        {loading && <div>Computing refresh preview...</div>}

        {!loading && result && <p style={{ margin: 0 }}>{result}</p>}

        {!loading && !result && error && !preview && (
          <div style={{ color: "var(--text-error, #d33)", fontSize: "12px" }}>{error}</div>
        )}

        {!loading && !result && !(error && !preview) &&
          (!preview || preview.subscriptionPreviews.length === 0) && (
          <p style={{ margin: 0 }}>All subscriptions are up to date.</p>
        )}

        {!loading && !result && preview && preview.subscriptionPreviews.length > 0 && (
          <>
            {preview.subscriptionPreviews.map((sp) => (
              <div key={sp.packageName} style={{
                marginBottom: "12px",
                padding: "8px",
                border: "1px solid var(--border-default)",
                borderRadius: "4px",
              }}>
                <div style={{ fontWeight: 600 }}>{sp.packageName}</div>
                <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                  {sp.currentVersion} {"->"}  {sp.newVersion}
                </div>
                {sp.sheetsAdded.length > 0 && (
                  <div style={{ fontSize: "12px", color: "green" }}>
                    + {sp.sheetsAdded.length} sheet(s) added: {sp.sheetsAdded.map((s) => s.name).join(", ")}
                  </div>
                )}
                {sp.sheetsRemoved.length > 0 && (
                  <div style={{ fontSize: "12px", color: "var(--text-error, #d33)" }}>
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

            <div style={{ fontSize: "12px", marginBottom: "8px", color: "var(--text-secondary)" }}>
              Total: {preview.totalSheetsAdded} added, {preview.totalSheetsRemoved} removed,
              {preview.totalOverridesConflicted} potential conflict(s)
            </div>

            {error && (
              <div style={{ color: "var(--text-error, #d33)", marginBottom: "8px", fontSize: "12px" }}>{error}</div>
            )}
          </>
        )}
      </div>

      <div style={footerStyle}>
        {showApply ? (
          <>
            <button onClick={onClose}>Cancel</button>
            <button onClick={handleApply} disabled={applying} style={{ fontWeight: 600 }}>
              {applying ? "Applying..." : "Apply Refresh"}
            </button>
          </>
        ) : (
          <button onClick={onClose}>Close</button>
        )}
      </div>

      {win.resizeHandles}
    </div>
  );
}
