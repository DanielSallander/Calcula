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
  getSubscriptions,
  type WritebackRegionEntry,
  type WritebackLayer as WritebackLayerType,
  type WritebackRegionDeclaration,
} from "@api/distribution";

export function WritebackPane() {
  const [regions, setRegions] = useState<WritebackRegionEntry[]>([]);
  const [draftRegions, setDraftRegions] = useState<WritebackRegionDeclaration[]>([]);
  const [writebackLayer, setWritebackLayer] = useState<WritebackLayerType | null>(null);
  const [registryPath, setRegistryPath] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [regs, layer, drafts, subs] = await Promise.all([
        getWritebackRegions(),
        getWritebackLayer(),
        getWritebackDraftRegions(),
        getSubscriptions(),
      ]);
      setRegions(regs);
      setWritebackLayer(layer);
      setDraftRegions(drafts);

      // Extract registry path from first subscription
      if (subs.subscriptions.length > 0) {
        const url = subs.subscriptions[0].registryUrl;
        setRegistryPath(url.replace("file://", ""));
      }
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
    if (!registryPath) {
      console.warn("[WritebackPane] No registry path available");
      return;
    }
    setSubmitting(regionId);
    try {
      const count = await submitRegion(regionId, registryPath);
      console.log(`[WritebackPane] Submitted ${count} values for region ${regionId}`);
      await refresh();
    } catch (err) {
      console.error("[WritebackPane] submit error:", err);
    } finally {
      setSubmitting(null);
    }
  }, [registryPath, refresh]);

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
          {regions.map((region, idx) => {
            const draftsForRegion = writebackLayer?.drafts.filter(
              (d) => d.cellRow >= region.rowStart && d.cellRow <= region.rowEnd
                  && d.cellCol >= region.colStart && d.cellCol <= region.colEnd
            ) ?? [];
            const draftCount = draftsForRegion.filter((d) => d.state === "draft").length;
            const submittedCount = draftsForRegion.filter((d) => d.state === "submitted").length;

            return (
              <div key={idx} style={{
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
                    onClick={() => {
                      // Find the region_id — we need to match by position
                      // For now, use the first draft's region_id
                      const firstDraft = draftsForRegion.find((d) => d.state === "draft");
                      if (firstDraft) handleSubmit(firstDraft.regionId);
                    }}
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
