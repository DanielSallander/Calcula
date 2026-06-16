// FILENAME: app/extensions/Distribution/components/WritebackPane.tsx
// PURPOSE: Task pane showing writeback regions, submission status, and submit action.
// CONTEXT: Parallel to the Overrides pane. Shows all writeback regions in the
// workbook, per-region state (empty/draft/submitted), deadlines, and submit buttons.

import React, { useState, useEffect, useCallback } from "react";
import {
  getWritebackRegions,
  getWritebackLayer,
  submitRegion,
  previewRegionSubmission,
  getWritebackDraftRegions,
  type WritebackRegionEntry,
  type WritebackLayer as WritebackLayerType,
  type WritebackRegionDeclaration,
  type OutboundSubmissionPreview,
} from "@api/distribution";

function colLetter(c: number): string {
  let s = "";
  let n = c;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}
const a1 = (row: number, col: number): string => `${colLetter(col)}${row + 1}`;

/** The outbound-data preview: exactly what leaves the machine, to whom, as whom,
 *  shown for explicit confirmation before a writeback submission is sent. */
function OutboundPreviewPanel({
  preview,
  submitting,
  onConfirm,
  onCancel,
}: {
  preview: OutboundSubmissionPreview;
  submitting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): React.ReactElement {
  return (
    <div
      style={{
        marginTop: 6,
        padding: 8,
        border: "1px solid #f0c36d",
        background: "#fffdf5",
        borderRadius: 4,
        fontSize: 11,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        Review before sending — {preview.values.length} value
        {preview.values.length === 1 ? "" : "s"} will leave this machine:
      </div>
      <div style={{ color: "#555", marginBottom: 4 }}>
        <div>
          To: <strong>{preview.packageName}</strong> v{preview.resolvedVersion}
        </div>
        <div style={{ wordBreak: "break-all" }}>Registry: {preview.registryPath}</div>
        <div>
          As: <strong>{preview.submitterName || "(unknown)"}</strong>
          {preview.submitterId ? ` (${preview.submitterId})` : ""}
        </div>
      </div>
      <div
        style={{
          maxHeight: 120,
          overflowY: "auto",
          background: "#fff",
          border: "1px solid #eee",
          borderRadius: 3,
          padding: "2px 4px",
          marginBottom: 6,
        }}
      >
        {preview.values.length === 0 ? (
          <span style={{ color: "#999" }}>(nothing to submit)</span>
        ) : (
          preview.values.map((v, i) => (
            <div key={i} style={{ fontFamily: "Consolas, monospace" }}>
              {a1(v.cellRow, v.cellCol)} = {v.valueDisplay || "(empty)"}
            </div>
          ))
        )}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <button
          onClick={onConfirm}
          disabled={submitting || preview.values.length === 0}
          style={{ fontSize: 11, fontWeight: 600 }}
        >
          {submitting ? "Sending..." : "Confirm & send"}
        </button>
        <button onClick={onCancel} disabled={submitting} style={{ fontSize: 11 }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function WritebackPane() {
  const [regions, setRegions] = useState<WritebackRegionEntry[]>([]);
  const [draftRegions, setDraftRegions] = useState<WritebackRegionDeclaration[]>([]);
  const [writebackLayer, setWritebackLayer] = useState<WritebackLayerType | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [preview, setPreview] = useState<OutboundSubmissionPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState<string | null>(null);

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

  // Step 1: load a read-only preview of exactly what would be sent (no send yet).
  const handleReview = useCallback(async (regionId: string) => {
    setPreviewLoading(regionId);
    setSubmitError(null);
    try {
      setPreview(await previewRegionSubmission(regionId));
    } catch (err) {
      console.error("[WritebackPane] preview error:", err);
      setSubmitError(String(err));
    } finally {
      setPreviewLoading(null);
    }
  }, []);

  // Step 2: the user reviewed the outbound data and confirmed — send for real.
  const handleConfirmSubmit = useCallback(async () => {
    if (!preview) return;
    const regionId = preview.regionId;
    setSubmitting(regionId);
    setSubmitError(null);
    try {
      // The backend resolves the owning subscription's registry from the
      // region id — no registry path needed here.
      const count = await submitRegion(regionId);
      console.log(`[WritebackPane] Submitted ${count} values for region ${regionId}`);
      setPreview(null);
      await refresh();
    } catch (err) {
      console.error("[WritebackPane] submit error:", err);
      setSubmitError(String(err));
    } finally {
      setSubmitting(null);
    }
  }, [preview, refresh]);

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
                {draftCount > 0 && preview?.regionId !== region.regionId && (
                  <button
                    onClick={() => handleReview(region.regionId)}
                    disabled={submitting !== null || previewLoading !== null}
                    style={{ marginTop: 4, fontSize: 11 }}
                  >
                    {previewLoading === region.regionId
                      ? "Preparing..."
                      : `Review & submit ${draftCount} draft(s)...`}
                  </button>
                )}
                {preview?.regionId === region.regionId && (
                  <OutboundPreviewPanel
                    preview={preview}
                    submitting={submitting !== null}
                    onConfirm={handleConfirmSubmit}
                    onCancel={() => setPreview(null)}
                  />
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
