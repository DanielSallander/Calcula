// FILENAME: app/extensions/Distribution/components/WritebackPane.tsx
// PURPOSE: Task pane showing writeback regions, submission status, and submit action.
// CONTEXT: Parallel to the Overrides pane. Shows all writeback regions in the
// workbook, per-region state (empty/draft/submitted), deadlines, and submit buttons.

import React, { useState, useEffect, useCallback } from "react";
import { showDialog, onAppEvent } from "@api";
import {
  getWritebackRegions,
  reconcileWriteback,
  submitRegion,
  submitAllRegions,
  previewRegionSubmission,
  getWritebackDraftRegions,
  removeWritebackRegion,
  type WritebackRegionEntry,
  type WritebackLayer as WritebackLayerType,
  type WritebackRegionDeclaration,
  type OutboundSubmissionPreview,
} from "@api/distribution";
import { DESIGNATE_WRITEBACK_DIALOG_ID } from "../manifest";
import { WRITEBACK_REGIONS_CHANGED_EVENT } from "./DesignateWritebackDialog";
import {
  lastWritebackValidatorSync,
  approveAndMountWritebackValidators,
  WRITEBACK_VALIDATORS_CHANGED_EVENT,
  type WritebackValidatorSyncResult,
  type PendingValidatorConsent,
  type BlockedValidatorRegion,
} from "../lib/writebackValidatorSync";

/** Format an ISO deadline as a relative "Due in …" / "Overdue" chip. */
function deadlineLabel(iso?: string): { text: string; color: string } | null {
  if (!iso) return null;
  const dl = new Date(iso).getTime();
  if (isNaN(dl)) return null;
  const ms = dl - Date.now();
  if (ms <= 0) return { text: "Overdue", color: "#c5221f" };
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  return {
    text: days > 0 ? `Due in ${days}d ${hours}h` : `Due in ${hours}h`,
    color: days < 1 ? "#b06000" : "#666",
  };
}

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

/** Review-and-approve gate for a package's publisher-shipped writeback
 *  validators. The Rust submit path runs these bodies itself, out of the
 *  Ed25519-verified manifest, and REFUSES the submission until the user has
 *  approved this exact source — so without this panel a validated region is
 *  fillable but unsubmittable. The source shown here is byte-identical to what
 *  the backend will execute (same manifest, same SHA-256 consent key). */
function ValidatorConsentPanel({
  entry,
  busy,
  onApprove,
}: {
  entry: PendingValidatorConsent;
  busy: boolean;
  onApprove: () => void;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      style={{
        border: "1px solid #f0c36d",
        background: "#fffdf5",
        borderRadius: 4,
        padding: 8,
        marginBottom: 8,
        fontSize: 11,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        Review and approve this package&apos;s input checks
      </div>
      <div style={{ color: "#555", marginBottom: 6 }}>
        <strong>{entry.packageName}</strong> ships{" "}
        {entry.validators.length === 1
          ? "a check"
          : `${entry.validators.length} checks`}{" "}
        that decide whether your answers may be sent. It sees only the answers it
        checks — never the rest of your workbook, the network, or your files. But
        nothing is submitted until you have read it and approved it.
      </div>
      <button onClick={() => setExpanded((v) => !v)} style={{ fontSize: 11, marginBottom: 6 }}>
        {expanded ? "Hide code" : `Show code (${entry.validators.map((v) => v.name).join(", ")})`}
      </button>
      {expanded && (
        <div style={{ maxHeight: 180, overflow: "auto", marginBottom: 6 }}>
          {entry.validators.map((v) => (
            <div key={v.name} style={{ marginBottom: 6 }}>
              <div style={{ fontWeight: 600 }}>{v.name}</div>
              <pre
                style={{
                  margin: 0,
                  padding: 4,
                  background: "#fff",
                  border: "1px solid #eee",
                  borderRadius: 3,
                  fontFamily: "Consolas, monospace",
                  fontSize: 10,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {v.source}
              </pre>
              <div style={{ color: "#888" }}>SHA-256: {v.sourceHash}</div>
            </div>
          ))}
        </div>
      )}
      <button onClick={onApprove} disabled={busy} style={{ fontSize: 11, fontWeight: 600 }}>
        {busy ? "Approving..." : "Approve and enable"}
      </button>
    </div>
  );
}

/** A region whose declared validator cannot run at all — the publisher named a
 *  check but shipped no code for it, so the backend refuses the submission. */
function BlockedValidatorNotice({
  blocked,
}: {
  blocked: BlockedValidatorRegion;
}): React.ReactElement {
  return (
    <div style={{ fontSize: 11, color: "#c5221f", marginTop: 4 }}>
      This area cannot be submitted: {blocked.message}
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
  const [validators, setValidators] = useState<WritebackValidatorSyncResult>(() =>
    lastWritebackValidatorSync(),
  );
  const [approving, setApproving] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [regs, layer, drafts] = await Promise.all([
        getWritebackRegions(),
        // Reconcile pulls the publisher's approve/reject decisions back into the
        // local layer so this pane shows the real fate of each submission.
        reconcileWriteback(),
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
    // Refresh when a draft region is added/updated (from this pane's Edit button
    // or the Data-menu Designate dialog).
    const off = onAppEvent(WRITEBACK_REGIONS_CHANGED_EVENT, () => void refresh());
    // ...and when the extension's validator sync pass finishes, so the consent
    // prompt appears without the user having to reopen the pane.
    const offValidators = onAppEvent(WRITEBACK_VALIDATORS_CHANGED_EVENT, () => {
      setValidators(lastWritebackValidatorSync());
    });
    return () => {
      off();
      offValidators();
    };
  }, [refresh]);

  // The user reviewed a package's validator source and approved it. Approval is
  // per (package, validator body hash): a republished body asks again.
  const handleApproveValidators = useCallback(
    async (entry: PendingValidatorConsent) => {
      setApproving(entry.packageName);
      setSubmitError(null);
      try {
        await approveAndMountWritebackValidators(entry.packageName, entry.validators);
        setValidators((prev) => ({
          ...prev,
          pending: prev.pending.filter((p) => p.packageName !== entry.packageName),
          mounted: [...prev.mounted, ...entry.validators],
        }));
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : String(err));
      } finally {
        setApproving(null);
      }
    },
    [],
  );

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

  // Author-side: drop a draft writeback region designated by mistake (the
  // designate dialog only adds; this is the matching remove control).
  const handleRemoveDraft = useCallback(
    async (regionId: string) => {
      setSubmitError(null);
      try {
        await removeWritebackRegion(regionId);
        await refresh();
      } catch (err) {
        setSubmitError(String(err));
      }
    },
    [refresh],
  );

  // "I'm done": submit every region that has drafts, so the contributor doesn't
  // leave whole regions as unsent drafts believing they're finished.
  const handleSubmitAll = useCallback(async () => {
    setSubmitting("__all__");
    setSubmitError(null);
    try {
      const n = await submitAllRegions();
      console.log(`[WritebackPane] Submitted ${n} values across all regions`);
      setPreview(null);
      await refresh();
    } catch (err) {
      console.error("[WritebackPane] submit-all error:", err);
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
  const totalDrafts = writebackLayer?.drafts.filter((d) => d.state === "draft").length ?? 0;

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
          {validators.pending.map((entry) => (
            <ValidatorConsentPanel
              key={entry.packageName}
              entry={entry}
              busy={approving === entry.packageName}
              onApprove={() => void handleApproveValidators(entry)}
            />
          ))}
          {totalDrafts > 0 && (
            <button
              onClick={handleSubmitAll}
              disabled={submitting !== null || previewLoading !== null}
              style={{ fontSize: 11, fontWeight: 600, marginBottom: 8 }}
              title="Submit every region that has drafts"
            >
              {submitting === "__all__"
                ? "Submitting all..."
                : `Submit all ${totalDrafts} draft(s)`}
            </button>
          )}
          {regions.map((region, idx) => {
            // Match drafts by region id — bounds-only matching confused
            // overlapping coordinates across different sheets/regions.
            const draftsForRegion = writebackLayer?.drafts.filter(
              (d) => d.regionId === region.regionId
            ) ?? [];
            const draftCount = draftsForRegion.filter((d) => d.state === "draft").length;
            const submittedCount = draftsForRegion.filter((d) => d.state === "submitted").length;
            const approvedCount = draftsForRegion.filter((d) => d.state === "approved").length;
            const rejectedCount = draftsForRegion.filter((d) => d.state === "rejected").length;
            const isEmpty =
              draftCount === 0 && submittedCount === 0 && approvedCount === 0 && rejectedCount === 0;
            // A region whose publisher-declared check cannot run (no body) or is
            // not yet approved WILL be refused at submit by the Rust gate. Say so
            // here instead of letting the user hit the refusal after confirming.
            const blocked =
              validators.blocked.find((b) => b.regionId === region.regionId) ?? null;
            const awaitingConsent = validators.pending.some((p) =>
              p.validators.some((v) => v.regionId === region.regionId),
            );

            return (
              <div key={region.regionId || idx} style={{
                border: "1px solid #ddd", borderRadius: 4, padding: 8, marginBottom: 8,
              }}>
                <div style={{ fontSize: 12, fontWeight: 600 }}>
                  Sheet {region.sheetIndex + 1}, Rows {region.rowStart + 1}-{region.rowEnd + 1}, Cols {region.colStart + 1}-{region.colEnd + 1}
                </div>
                <div style={{ fontSize: 11, color: "#666", marginTop: 4, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  {draftCount > 0 && <span style={{ color: "#b06000" }}>{draftCount} draft</span>}
                  {submittedCount > 0 && <span style={{ color: "#1967d2" }}>{submittedCount} pending</span>}
                  {approvedCount > 0 && <span style={{ color: "#137333" }}>{approvedCount} approved</span>}
                  {rejectedCount > 0 && <span style={{ color: "#c5221f" }}>{rejectedCount} rejected</span>}
                  {isEmpty && <span>Empty</span>}
                  {(() => {
                    const dl = deadlineLabel(region.deadline);
                    return dl ? <span style={{ color: dl.color, fontWeight: 600 }}>· {dl.text}</span> : null;
                  })()}
                </div>
                {rejectedCount > 0 && (
                  <div style={{ fontSize: 11, color: "#c5221f", marginTop: 4 }}>
                    {rejectedCount} value{rejectedCount === 1 ? " was" : "s were"} rejected — re-enter
                    {rejectedCount === 1 ? " it" : " them"} in the grid and submit again.
                    {draftsForRegion
                      .filter((d) => d.state === "rejected" && d.reviewReason)
                      .map((d, i) => (
                        <div key={i} style={{ marginTop: 2 }}>
                          {a1(d.cellRow, d.cellCol)}: {d.reviewReason}
                        </div>
                      ))}
                  </div>
                )}
                {blocked && <BlockedValidatorNotice blocked={blocked} />}
                {!blocked && awaitingConsent && (
                  <div style={{ fontSize: 11, color: "#b06000", marginTop: 4 }}>
                    Waiting for you to approve this package&apos;s input checks (above)
                    — submissions are refused until then.
                  </div>
                )}
                {draftCount > 0 && preview?.regionId !== region.regionId && (
                  <button
                    onClick={() => handleReview(region.regionId)}
                    disabled={
                      submitting !== null ||
                      previewLoading !== null ||
                      blocked !== null ||
                      awaitingConsent
                    }
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
              <div style={{ marginTop: 4, display: "flex", gap: 8 }}>
                <button
                  onClick={() => showDialog(DESIGNATE_WRITEBACK_DIALOG_ID, { region })}
                  style={{ fontSize: 11 }}
                  title="Edit this draft writeback region's policies/schema"
                >
                  Edit
                </button>
                <button
                  onClick={() => handleRemoveDraft(region.id)}
                  style={{ fontSize: 11, color: "#c5221f" }}
                  title="Remove this draft writeback region (it won't be published)"
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
