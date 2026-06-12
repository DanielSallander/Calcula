// FILENAME: app/extensions/Distribution/components/WritebackPane.tsx
// PURPOSE: Task pane showing writeback regions, submission status, and submit action.
// CONTEXT: Parallel to the Overrides pane. Shows all writeback regions in the
// workbook, per-region state (empty/draft/submitted), deadlines, and submit buttons.

import React, { useState, useEffect, useCallback } from "react";
import {
  getWritebackRegions,
  getWritebackLayer,
  submitRegion,
  getWritebackDraftRegions,
  type WritebackRegionEntry,
  type WritebackLayer as WritebackLayerType,
  type WritebackRegionDeclaration,
} from "@api/distribution";

export function WritebackPane() {
  const [regions, setRegions] = useState<WritebackRegionEntry[]>([]);
  const [draftRegions, setDraftRegions] = useState<WritebackRegionDeclaration[]>([]);
  const [writebackLayer, setWritebackLayer] = useState<WritebackLayerType | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [regs, layer, drafts] = await Promise.all([
        getWritebackRegions(),
        getWritebackLayer(),
        getWritebackDraftRegions(),
      ]);
      setRegions(regs);
      setWritebackLayer(layer);
      setDraftRegions(drafts);
    } catch (err) {
      console.error("[WritebackPane] refresh error:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleSubmit = useCallback(async (regionId: string) => {
    setSubmitting(regionId);
    setSubmitError(null);
    try {
      // The backend resolves the owning subscription's registry from the
      // region id — no registry path needed here.
      const count = await submitRegion(regionId);
      console.log(`[WritebackPane] Submitted ${count} values for region ${regionId}`);
      await refresh();
    } catch (err) {
      console.error("[WritebackPane] submit error:", err);
      setSubmitError(String(err));
    } finally {
      setSubmitting(null);
    }
  }, [refresh]);

  if (loading) {
    return <div style={{ padding: 16 }}>Loading...</div>;
  }

  const hasSubscriberRegions = regions.length > 0;
  const hasAuthorRegions = draftRegions.length > 0;

  if (!hasSubscriberRegions && !hasAuthorRegions) {
    return (
      <div style={{ padding: 16, color: "#888", fontSize: 13 }}>
        No writeback regions in this workbook.
      </div>
    );
  }

  return (
    <div style={{ padding: 16 }}>
      {hasSubscriberRegions && (
        <>
          <h4 style={{ marginTop: 0 }}>Subscribed Writeback Regions</h4>
          {submitError && (
            <div style={{ color: "red", fontSize: 11, marginBottom: 8 }}>{submitError}</div>
          )}
          {regions.map((region, idx) => {
            // Match drafts by region id — bounds-only matching confused
            // overlapping coordinates across different sheets/regions.
            const draftsForRegion = writebackLayer?.drafts.filter(
              (d) => d.regionId === region.regionId
            ) ?? [];
            const draftCount = draftsForRegion.filter((d) => d.state === "draft").length;
            const submittedCount = draftsForRegion.filter(
              (d) => d.state === "submitted" || d.state === "approved"
            ).length;

            return (
              <div key={region.regionId || idx} style={{
                border: "1px solid #ddd", borderRadius: 4, padding: 8, marginBottom: 8,
              }}>
                <div style={{ fontSize: 12, fontWeight: 600 }}>
                  Sheet {region.sheetIndex + 1}, Rows {region.rowStart + 1}-{region.rowEnd + 1}, Cols {region.colStart + 1}-{region.colEnd + 1}
                </div>
                <div style={{ fontSize: 11, color: "#666", marginTop: 4 }}>
                  {draftCount > 0 && <span>{draftCount} draft(s) </span>}
                  {submittedCount > 0 && <span>{submittedCount} submitted </span>}
                  {draftCount === 0 && submittedCount === 0 && <span>Empty</span>}
                </div>
                {draftCount > 0 && (
                  <button
                    onClick={() => handleSubmit(region.regionId)}
                    disabled={submitting !== null}
                    style={{ marginTop: 4, fontSize: 11 }}
                  >
                    {submitting ? "Submitting..." : `Submit ${draftCount} Draft(s)`}
                  </button>
                )}
              </div>
            );
          })}
        </>
      )}

      {hasAuthorRegions && (
        <>
          <h4>Author Draft Regions</h4>
          <p style={{ fontSize: 11, color: "#888" }}>
            These regions will be included in the next published version.
          </p>
          {draftRegions.map((region, idx) => (
            <div key={idx} style={{
              border: "1px solid #ddd", borderRadius: 4, padding: 8, marginBottom: 8,
            }}>
              <div style={{ fontSize: 12, fontWeight: 600 }}>
                Rows {region.selector.rowStart + 1}-{region.selector.rowEnd + 1},
                Cols {region.selector.colStart + 1}-{region.selector.colEnd + 1}
              </div>
              <div style={{ fontSize: 11, color: "#666", marginTop: 2 }}>
                Mode: {region.mode ?? "not set"} | Visibility: {region.visibility ?? "not set"}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
