// FILENAME: app/extensions/Collaboration/components/WritebackPane.tsx
// PURPOSE: Task pane showing writeback regions, submission status, and submit action.
// CONTEXT: Parallel to the Overrides pane. Shows all writeback regions in the
// workbook, per-region state (empty/draft/submitted), deadlines, and submit buttons.
//
// It reads the SHARED writeback snapshot (lib/writebackStore) -- the same one
// the grid's guards, outline and markers and the Writeback ribbon tab read --
// and re-renders whenever it changes, so a value typed in the grid, a submit
// from the ribbon or a late-loading region shows up here without reopening the
// pane. Its own submit paths refresh that shared snapshot too, which repaints
// the grid: the cells stop looking unsent the moment they are sent.
//
// A failed read is shown as the error it is. It used to fall through to
// "No writeback regions in this workbook" -- the one message that tells a
// subscriber there is nothing to do.

import React, { useState, useEffect, useCallback, useSyncExternalStore } from "react";
import { showDialog, onAppEvent } from "@api";
import {
  submitRegion,
  previewRegionSubmission,
  getWritebackDraftRegions,
  removeWritebackRegion,
  type WritebackRegionDeclaration,
  type OutboundSubmissionPreview,
} from "@api/collaboration";
import { DESIGNATE_WRITEBACK_DIALOG_ID } from "../manifest";
import { WRITEBACK_REGIONS_CHANGED_EVENT } from "./DesignateWritebackDialog";
import { sentAsText, whoAmIText } from "../lib/senderLabel";
import { subscribeWhoAmI, getWhoAmIVersion, getWhoAmI } from "../lib/whoAmIStore";
import {
  lastWritebackValidatorSync,
  approveAndMountWritebackValidators,
  WRITEBACK_VALIDATORS_CHANGED_EVENT,
  type WritebackValidatorSyncResult,
  type PendingValidatorConsent,
  type BlockedValidatorRegion,
} from "../lib/writebackValidatorSync";
import {
  subscribeWritebackSnapshot,
  getWritebackSnapshotVersion,
  getWritebackLayerEntries,
  getWritebackRefreshError,
  isWritebackSnapshotLoaded,
  listRegionSummaries,
  refreshWriteback,
  totalUnsentDrafts,
  type WritebackRegionSummary,
} from "../lib/writebackStore";
import {
  submitAllWriteback,
  visibilitySentence,
  valuesText,
  countText,
  outboundValueText,
} from "../lib/writebackTabModel";

/** Format an ISO deadline as a relative "Due in ..." / "Overdue" chip. */
function deadlineLabel(iso?: string): { text: string; color: string } | null {
  if (!iso) return null;
  const dl = new Date(iso).getTime();
  if (isNaN(dl)) return null;
  const ms = dl - Date.now();
  if (ms <= 0) return { text: "Overdue", color: "var(--tone-danger-fg)" };
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  return {
    text: days > 0 ? `Due in ${days}d ${hours}h` : `Due in ${hours}h`,
    color: days < 1 ? "var(--tone-warn-fg)" : "var(--text-secondary)",
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

/** Who sees what the subscriber enters, in the subscriber's words -- the SAME
 *  sentence the Writeback tab's Status shows (one wording, matching what the
 *  read side actually does). */
function visibilityText(v: WritebackRegionSummary["visibility"]): string | null {
  return v ? `${visibilitySentence(v)}.` : null;
}

/** WHO YOU SEND AS (identity phase 1): the same sentence the Writeback tab's
 *  Status shows, read once from Rust (lib/whoAmIStore). */
function WhoAmINote(): React.ReactElement {
  useSyncExternalStore(subscribeWhoAmI, getWhoAmIVersion, getWhoAmIVersion);
  const { identity, error } = getWhoAmI();
  const view = whoAmIText(identity, error);
  return (
    <div
      data-testid="writeback-pane-who-am-i"
      title={view.detail}
      style={{ fontSize: 11, color: error ? "var(--tone-warn-fg)" : "var(--text-secondary)", marginBottom: 8 }}
    >
      {view.text}
      {view.account && <div style={{ color: "var(--text-tertiary)" }}>{view.account}</div>}
    </div>
  );
}

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
        border: "1px solid var(--tone-warn-fg)",
        background: "var(--tone-warn-bg)",
        color: "var(--text-primary)",
        borderRadius: 4,
        fontSize: 11,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        Review before sending — {valuesText(preview.values.length)} will leave this machine:
      </div>
      <div style={{ color: "var(--text-secondary)", marginBottom: 4 }}>
        <div>
          To: <strong>{preview.packageName}</strong> v{preview.resolvedVersion}
        </div>
        <div style={{ wordBreak: "break-all" }}>Workspace: {preview.registryPath}</div>
        <div>
          As: <strong>{sentAsText(preview) || "(unknown)"}</strong>
        </div>
      </div>
      <div
        style={{
          maxHeight: 120,
          overflowY: "auto",
          background: "var(--bg-surface)",
          border: "1px solid var(--border-default)",
          borderRadius: 3,
          padding: "2px 4px",
          marginBottom: 6,
        }}
      >
        {preview.values.length === 0 ? (
          <span style={{ color: "var(--text-tertiary)" }}>(nothing to submit)</span>
        ) : (
          preview.values.map((v, i) => (
            <div key={i} style={{ fontFamily: "Consolas, monospace" }}>
              {a1(v.cellRow, v.cellCol)} = {outboundValueText(v) || "(empty)"}
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

/** Review-and-approve gate for an application's publisher-shipped writeback
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
        border: "1px solid var(--tone-warn-fg)",
        background: "var(--tone-warn-bg)",
        color: "var(--text-primary)",
        borderRadius: 4,
        padding: 8,
        marginBottom: 8,
        fontSize: 11,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        Review and approve this application&apos;s input checks
      </div>
      <div style={{ color: "var(--text-secondary)", marginBottom: 6 }}>
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
                  background: "var(--bg-surface)",
                  border: "1px solid var(--border-default)",
                  borderRadius: 3,
                  fontFamily: "Consolas, monospace",
                  fontSize: 10,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {v.source}
              </pre>
              <div style={{ color: "var(--text-tertiary)" }}>SHA-256: {v.sourceHash}</div>
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
    <div style={{ fontSize: 11, color: "var(--tone-danger-fg)", marginTop: 4 }}>
      This area cannot be submitted: {blocked.message}
    </div>
  );
}

/** "Sheet!B3:B5" -- the sheet's current name when the backend reports it. */
function regionTitle(s: WritebackRegionSummary): string {
  const sheet = s.sheetName ? `${s.sheetName}!` : "";
  return `${sheet}${s.rangeA1}`;
}

export function WritebackPane() {
  // The shared snapshot: re-render on every change, wherever it came from.
  useSyncExternalStore(subscribeWritebackSnapshot, getWritebackSnapshotVersion);
  const summaries = listRegionSummaries();
  const layerEntries = getWritebackLayerEntries();
  const snapshotLoaded = isWritebackSnapshotLoaded();
  const snapshotError = getWritebackRefreshError();
  const totalDrafts = totalUnsentDrafts();

  const [draftRegions, setDraftRegions] = useState<WritebackRegionDeclaration[]>([]);
  const [draftRegionsError, setDraftRegionsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<OutboundSubmissionPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState<string | null>(null);
  const [validators, setValidators] = useState<WritebackValidatorSyncResult>(() =>
    lastWritebackValidatorSync(),
  );
  const [approving, setApproving] = useState<string | null>(null);

  /** The author-side regions this workbook will publish (not in the index). */
  const loadDraftRegions = useCallback(async () => {
    try {
      setDraftRegions(await getWritebackDraftRegions());
      setDraftRegionsError(null);
    } catch (err) {
      console.error("[WritebackPane] draft-region read failed:", err);
      setDraftRegionsError(
        `Could not read this workbook's own writeback regions: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      // refreshWriteback never rejects; its failure is the snapshot's error.
      await Promise.all([refreshWriteback(), loadDraftRegions()]);
    } finally {
      setLoading(false);
    }
  }, [loadDraftRegions]);

  useEffect(() => {
    void refresh();
    // Refresh when a draft region is added/updated (from this pane's Edit button
    // or the Data-menu Designate dialog).
    const off = onAppEvent(WRITEBACK_REGIONS_CHANGED_EVENT, () => void loadDraftRegions());
    // ...and when the extension's validator sync pass finishes, so the consent
    // prompt appears without the user having to reopen the pane.
    const offValidators = onAppEvent(WRITEBACK_VALIDATORS_CHANGED_EVENT, () => {
      setValidators(lastWritebackValidatorSync());
    });
    return () => {
      off();
      offValidators();
    };
  }, [refresh, loadDraftRegions]);

  // The user reviewed an application's validator source and approved it. Approval
  // is per (application, validator body hash): a republished body asks again.
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
    setNotice(null);
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
    const application = preview.packageName;
    setSubmitting(regionId);
    setSubmitError(null);
    setNotice(null);
    try {
      // The backend resolves the owning subscription's workspace from the
      // region id — no workspace path needed here.
      const count = await submitRegion(regionId);
      setPreview(null);
      setNotice(`${valuesText(count)} sent to ${application}. The publisher can now see them.`);
    } catch (err) {
      console.error("[WritebackPane] submit error:", err);
      setSubmitError(String(err));
    } finally {
      setSubmitting(null);
      // Whatever happened, re-read the SHARED snapshot: the grid's markers,
      // the ribbon tab and this pane all follow it.
      await refreshWriteback();
    }
  }, [preview]);

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
  // leave whole regions as unsent drafts believing they're finished. THROUGH
  // THE ONE SUBMIT-ALL DOOR the Writeback tab uses: it previews every region,
  // refuses a send that is certain to fail, and asks with `confirmAsync` (fail
  // closed) listing exactly which values leave the machine and where -- then
  // says what happened and re-reads the shared snapshot. It used to send on one
  // click with no preview at all.
  const handleSubmitAll = useCallback(async () => {
    setSubmitting("__all__");
    setSubmitError(null);
    setNotice(null);
    try {
      await submitAllWriteback();
      setPreview(null);
    } finally {
      setSubmitting(null);
    }
  }, []);

  if (loading && !snapshotLoaded) {
    return <div style={{ padding: 16 }}>Loading...</div>;
  }

  const hasSubscriberRegions = summaries.length > 0;
  const hasAuthorRegions = draftRegions.length > 0;

  if (!hasSubscriberRegions && !hasAuthorRegions) {
    // A failed read is NOT "no regions": say what failed.
    if (snapshotError || draftRegionsError) {
      return (
        <div style={{ padding: 16, fontSize: 12 }}>
          <div style={{ color: "var(--text-error)", marginBottom: 8 }}>
            {snapshotError ?? draftRegionsError}
          </div>
          <button onClick={() => void refresh()} style={{ fontSize: 11 }}>
            Try again
          </button>
        </div>
      );
    }
    return (
      <div style={{ padding: 16, color: "var(--text-secondary)", fontSize: 13 }}>
        No writeback regions in this workbook.
      </div>
    );
  }

  return (
    <div style={{ padding: 16 }}>
      {snapshotError && (
        <div style={{ color: "var(--text-error)", fontSize: 11, marginBottom: 8 }}>
          {snapshotError} (showing the last values read)
        </div>
      )}
      {hasSubscriberRegions && (
        <>
          <h4 style={{ marginTop: 0 }}>Subscribed Writeback Regions</h4>
          <WhoAmINote />
          {submitError && (
            <div style={{ color: "var(--text-error)", fontSize: 11, marginBottom: 8 }}>
              {submitError}
            </div>
          )}
          {notice && (
            <div style={{ color: "var(--tone-ok-fg)", fontSize: 11, marginBottom: 8 }}>
              {notice}
            </div>
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
              title="Review and send every value not yet sent, in every region"
            >
              {submitting === "__all__"
                ? "Submitting all..."
                : `Review & submit all ${valuesText(totalDrafts)}`}
            </button>
          )}
          {summaries.map((s, idx) => {
            const { draftCount, submittedCount, approvedCount, rejectedCount } = s;
            const isEmpty =
              draftCount === 0 && submittedCount === 0 && approvedCount === 0 && rejectedCount === 0;
            // A region whose publisher-declared check cannot run (no body) or is
            // not yet approved WILL be refused at submit by the Rust gate. Say so
            // here instead of letting the user hit the refusal after confirming.
            const blocked =
              validators.blocked.find((b) => b.regionId === s.regionId) ?? null;
            const awaitingConsent = validators.pending.some((p) =>
              p.validators.some((v) => v.regionId === s.regionId),
            );
            const rejectedEntries = layerEntries.filter(
              (d) => d.regionId === s.regionId && d.state === "rejected" && d.reviewReason,
            );
            const who = visibilityText(s.visibility);

            return (
              <div
                key={s.regionId || idx}
                style={{
                  border: "1px solid var(--border-default)",
                  borderRadius: 4,
                  padding: 8,
                  marginBottom: 8,
                }}
              >
                <div style={{ fontSize: 12, fontWeight: 600 }}>{regionTitle(s)}</div>
                {s.applicationName && (
                  <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                    For {s.applicationName}
                  </div>
                )}
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--text-secondary)",
                    marginTop: 4,
                    display: "flex",
                    gap: 8,
                    flexWrap: "wrap",
                    alignItems: "center",
                  }}
                >
                  {draftCount > 0 && (
                    <span style={{ color: "var(--tone-warn-fg)" }}>{countText(draftCount)} not sent</span>
                  )}
                  {submittedCount > 0 && (
                    <span style={{ color: "var(--tone-info-fg)" }}>
                      {countText(submittedCount)}{" "}
                      {s.submissionPolicy === "on_approval" ? "awaiting approval" : "sent"}
                    </span>
                  )}
                  {approvedCount > 0 && (
                    <span style={{ color: "var(--tone-ok-fg)" }}>{countText(approvedCount)} approved</span>
                  )}
                  {rejectedCount > 0 && (
                    <span style={{ color: "var(--tone-danger-fg)" }}>{countText(rejectedCount)} rejected</span>
                  )}
                  {isEmpty && <span>Empty</span>}
                  {(() => {
                    const dl = deadlineLabel(s.deadline);
                    return dl ? <span style={{ color: dl.color, fontWeight: 600 }}>· {dl.text}</span> : null;
                  })()}
                </div>
                {who && (
                  <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>{who}</div>
                )}
                {rejectedCount > 0 && (
                  <div style={{ fontSize: 11, color: "var(--tone-danger-fg)", marginTop: 4 }}>
                    {countText(rejectedCount)} value{rejectedCount === 1 ? " was" : "s were"} rejected — re-enter
                    {rejectedCount === 1 ? " it" : " them"} in the grid and submit again.
                    {rejectedEntries.map((d, i) => (
                      <div key={i} style={{ marginTop: 2 }}>
                        {a1(d.cellRow, d.cellCol)}: {d.reviewReason}
                      </div>
                    ))}
                  </div>
                )}
                {blocked && <BlockedValidatorNotice blocked={blocked} />}
                {!blocked && awaitingConsent && (
                  <div style={{ fontSize: 11, color: "var(--tone-warn-fg)", marginTop: 4 }}>
                    Waiting for you to approve this application&apos;s input checks (above)
                    — submissions are refused until then.
                  </div>
                )}
                {draftCount > 0 && preview?.regionId !== s.regionId && (
                  <button
                    onClick={() => handleReview(s.regionId)}
                    disabled={
                      submitting !== null ||
                      previewLoading !== null ||
                      blocked !== null ||
                      awaitingConsent
                    }
                    style={{ marginTop: 4, fontSize: 11 }}
                  >
                    {previewLoading === s.regionId
                      ? "Preparing..."
                      : `Review & submit ${valuesText(draftCount)}...`}
                  </button>
                )}
                {preview?.regionId === s.regionId && (
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

      {draftRegionsError && (
        <div style={{ color: "var(--text-error)", fontSize: 11, marginBottom: 8 }}>
          {draftRegionsError}
        </div>
      )}
      {hasAuthorRegions && (
        <>
          <h4>Author Draft Regions</h4>
          <p style={{ fontSize: 11, color: "var(--text-secondary)" }}>
            These regions will be included in the next published version.
          </p>
          {draftRegions.map((region, idx) => (
            <div
              key={idx}
              style={{
                border: "1px solid var(--border-default)",
                borderRadius: 4,
                padding: 8,
                marginBottom: 8,
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 600 }}>
                {a1(region.selector.rowStart, region.selector.colStart)}
                {region.selector.rowEnd !== region.selector.rowStart ||
                region.selector.colEnd !== region.selector.colStart
                  ? `:${a1(region.selector.rowEnd, region.selector.colEnd)}`
                  : ""}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>
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
                  style={{ fontSize: 11, color: "var(--tone-danger-fg)" }}
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
