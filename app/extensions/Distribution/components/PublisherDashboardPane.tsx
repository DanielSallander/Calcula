// FILENAME: app/extensions/Distribution/components/PublisherDashboardPane.tsx
// PURPOSE: Publisher data-collection dashboard (D5) — a submissions inbox +
//          respondent roster + approve/reject for each writeback region.
// CONTEXT: Wires the previously-unexposed workspace primitive load_region_submissions
//          (via the new calp_load_region_submissions command) and the unwired
//          calp_set_submission_state, so a publisher can SEE who responded and
//          approve/reject — instead of GATHER formulas being the only surface.

import React, { useState, useEffect, useCallback, useRef } from "react";
import { onAppEvent, AppEvents } from "@api";
import type { WritebackSubmissionReceivedPayload } from "@api/events";
import { acquireSubmissionWatch } from "@api/distribution";
import {
  getWritebackRegions,
  loadRegionSubmissions,
  getSubscriptionTrust,
  setSubmissionState,
  exportRegionSubmissionsCsv,
  exportRegionSubmissionsParquet,
  getWritebackRollup,
  setWritebackRollup,
  regionResponseStatus,
  type WritebackRegionEntry,
  type RegionSubmission,
  type RegionResponseStatus,
} from "@api/distribution";
import { saveCsvReport, saveParquetReport } from "../lib/reportExport";
import { promptAsync } from "@api/dialogs";

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

const STATE_BADGE: Record<RegionSubmission["state"], { label: string; bg: string; fg: string }> = {
  draft: { label: "Draft", bg: "#f1f3f4", fg: "#5f6368" },
  submitted: { label: "Pending", bg: "#fef7e0", fg: "#b06000" },
  approved: { label: "Approved", bg: "#e6f4ea", fg: "#137333" },
  rejected: { label: "Rejected", bg: "#fce8e6", fg: "#c5221f" },
};

export function PublisherDashboardPane(): React.ReactElement {
  const [regions, setRegions] = useState<WritebackRegionEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [submissions, setSubmissions] = useState<RegionSubmission[]>([]);
  const [status, setStatus] = useState<RegionResponseStatus | null>(null);
  const [rollup, setRollup] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // The watch subscription must not be torn down and re-created every time the
  // publisher picks a different region, so the handler reads the selection
  // through a ref instead of closing over it.
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;

  /**
   * Which stream the inbox is showing.
   *
   * `null` is this workbook's own — the default, and the only one that matches
   * what a GATHER on these sheets computes. A publisher who wants to see what
   * testers submitted picks the environment explicitly, and the strip below
   * names whichever is being shown, because "3 responses" without the stream is
   * how a test count gets read as a production one.
   */
  const [viewing, setViewing] = useState<string | null>(null);
  const [environments, setEnvironments] = useState<string[]>([]);
  const viewingRef = useRef<string | null>(null);
  viewingRef.current = viewing;

  const loadRegions = useCallback(async () => {
    try {
      const r = await getWritebackRegions();
      setRegions(r);
      setSelected((cur) => cur ?? (r.length > 0 ? r[0].regionId : null));
    } catch (e: unknown) {
      setError(String(e));
    }
  }, []);

  const loadSubs = useCallback(async (regionId: string) => {
    setLoading(true);
    setError(null);
    try {
      const [subs, st, rp] = await Promise.all([
        loadRegionSubmissions(regionId, viewingRef.current),
        // THE SAME STREAM THE LIST IS SHOWING. Unscoped, a publisher following
        // prod who viewed test read "5 respondents · in test" directly above
        // "0 of 5 expected responded".
        regionResponseStatus(regionId, viewingRef.current).catch(() => null),
        getWritebackRollup(regionId).catch(() => false),
      ]);
      setSubmissions(subs);
      setStatus(st);
      setRollup(rp);
    } catch (e: unknown) {
      setError(String(e));
      setSubmissions([]);
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRegions();
    const unsub = onAppEvent(AppEvents.SHEET_CHANGED, loadRegions);
    return unsub;
  }, [loadRegions]);

  // Which streams this workbook's subscriptions know about, so the picker
  // offers real ones. Best effort — an application without environments simply
  // gets no picker.
  useEffect(() => {
    let cancelled = false;
    // THE SELECTED REGION'S OWN APPLICATION, not every subscription's. The
    // union offered streams the region's application does not have, and picking
    // one produced an empty inbox with no explanation.
    getSubscriptionTrust()
      .then((rows) => {
        if (cancelled) return;
        // Matched on application AND workspace: two teams may each publish
        // `sales` to their own share, and their environments are unrelated.
        const owner = regions.find((r) => r.regionId === selected);
        const mine = owner
          ? rows.filter(
              (r) =>
                r.packageName === owner.packageName &&
                (!owner.registryUrl || r.registryUrl === owner.registryUrl),
            )
          : [];
        const names = new Set<string>();
        for (const r of mine) {
          for (const e of r.availableEnvironments ?? []) names.add(e);
        }
        setEnvironments([...names]);
      })
      .catch(() => {
        if (!cancelled) setEnvironments([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, regions]);

  useEffect(() => {
    if (selected) void loadSubs(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewing]);

  // A REGION FROM ANOTHER APPLICATION RESETS THE STREAM. `viewing` survived a
  // region switch, so a picker scoped to the new region's application no longer
  // offered the old value — the control vanished while the filter it set stayed
  // on, and the inbox silently showed nothing with no way to say why.
  useEffect(() => {
    setViewing(null);
  }, [selected]);

  // Hold a submission watch while this pane is open, and refresh when it says
  // answers arrived. The watch is refcounted and demand-driven: opening this
  // pane is one of the two things that make the publisher-inbox poll run at all
  // (the other is a script subscribing to the event), and closing the pane gives
  // it back — an inbox nobody is looking at costs nothing.
  useEffect(() => {
    const release = acquireSubmissionWatch();
    const unsub = onAppEvent<WritebackSubmissionReceivedPayload>(
      AppEvents.WRITEBACK_SUBMISSION_RECEIVED,
      (payload) => {
        // Only reload the list the publisher is actually looking at. The event
        // carries no values by design, so the authoritative read is still the
        // publisher-gated one below.
        if (payload?.regionId && payload.regionId === selectedRef.current) {
          void loadSubs(payload.regionId);
        }
      },
    );
    return () => {
      unsub();
      release();
    };
  }, [loadSubs]);

  useEffect(() => {
    if (selected) loadSubs(selected);
    else setSubmissions([]);
  }, [selected, loadSubs]);

  const decide = useCallback(
    async (s: RegionSubmission, newState: "approved" | "rejected") => {
      let reason: string | null = null;
      if (newState === "rejected") {
        // The reason is shown back to the contributor on their read-back.
        reason = await promptAsync(
          "Reason for rejecting (optional — the contributor will see this):",
          { title: "Reject submission", defaultValue: "" },
        );
        if (reason === null) return; // publisher cancelled — abort the rejection
      }
      setBusy(`${s.submitterId}:${s.cellRow}:${s.cellCol}`);
      setError(null);
      try {
        // Pass the displayed submission id: if the contributor re-submitted
        // since this list loaded, the backend refuses ("superseded") instead
        // of approving a value the publisher never saw.
        await setSubmissionState(
          s.regionId,
          s.submitterId,
          s.cellRow,
          s.cellCol,
          newState,
          reason,
          s.submissionId,
          // THE STREAM THE ROW CAME FROM. Reviewing a row shown under another
          // environment used to fail closed with "No submission found", because
          // the command filtered by the workbook's own while the list did not.
          viewingRef.current,
        );
        if (selected) await loadSubs(selected);
      } catch (e: unknown) {
        setError(String(e));
        // A superseded decision means the list is stale — reload so the
        // publisher reviews the current value.
        if (String(e).includes("superseded") && selected) await loadSubs(selected);
      } finally {
        setBusy(null);
      }
    },
    [selected, loadSubs],
  );

  const exportCsv = useCallback(async () => {
    if (!selected) return;
    setError(null);
    try {
      const csv = await exportRegionSubmissionsCsv(selected, viewingRef.current);
      await saveCsvReport(csv, `${selected}-submissions.csv`);
    } catch (e: unknown) {
      setError(String(e));
    }
  }, [selected]);

  const exportParquet = useCallback(async () => {
    if (!selected) return;
    setError(null);
    try {
      const bytes = await exportRegionSubmissionsParquet(selected, viewingRef.current);
      await saveParquetReport(bytes, `${selected}-submissions.parquet`);
    } catch (e: unknown) {
      setError(String(e));
    }
  }, [selected]);

  const toggleRollup = useCallback(
    async (next: boolean) => {
      if (!selected) return;
      setError(null);
      try {
        await setWritebackRollup(selected, next);
        setRollup(next);
      } catch (e: unknown) {
        setError(String(e)); // e.g. "Only the publisher of ... can ..."
      }
    },
    [selected],
  );

  const respondents = new Set(submissions.map((s) => s.submitterId)).size;
  const pending = submissions.filter((s) => s.state === "submitted").length;
  const approved = submissions.filter((s) => s.state === "approved").length;
  const rejected = submissions.filter((s) => s.state === "rejected").length;

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        {regions.length === 0 ? (
          <span style={styles.headerText}>No writeback regions in this workbook.</span>
        ) : (
          <select
            value={selected ?? ""}
            onChange={(e) => setSelected(e.target.value)}
            style={styles.select}
          >
            {regions.map((r) => (
              <option key={r.regionId} value={r.regionId}>
                {`Region ${a1(r.rowStart, r.colStart)}:${a1(r.rowEnd, r.colEnd)}`}
              </option>
            ))}
          </select>
        )}
        {environments.length > 0 && (
          <select
            value={viewing ?? ""}
            onChange={(e) => setViewing(e.target.value || null)}
            style={styles.select}
            title="Which environment's submissions to show. Your own is what a GATHER on these sheets computes."
          >
            <option value="">this workbook&rsquo;s stream</option>
            {environments.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        )}
        <button onClick={() => selected && loadSubs(selected)} disabled={loading || !selected} style={styles.smallBtn}>
          {loading ? "..." : "Refresh"}
        </button>
        <button
          onClick={exportCsv}
          disabled={!selected || submissions.length === 0}
          style={styles.smallBtn}
          title="Export this region's submissions as CSV"
        >
          Export CSV
        </button>
        <button
          onClick={exportParquet}
          disabled={!selected || submissions.length === 0}
          style={styles.smallBtn}
          title="Export this region's submissions as Parquet (typed, for databases)"
        >
          Export Parquet
        </button>
      </div>

      {selected && (
        <div style={styles.summary}>
          <span style={styles.summaryItem}>{respondents} respondent{respondents !== 1 ? "s" : ""}</span>
          {viewing && (
            <span
              style={{ ...styles.chip, background: "#e8f0fe", color: "#1a5fb4" }}
              title="These rows are from another environment, not the one this workbook follows."
            >
              in {viewing}
            </span>
          )}
          {pending > 0 && <span style={{ ...styles.chip, ...styles.chipPending }}>{pending} pending</span>}
          {approved > 0 && <span style={{ ...styles.chip, ...styles.chipApproved }}>{approved} approved</span>}
          {rejected > 0 && <span style={{ ...styles.chip, ...styles.chipRejected }}>{rejected} rejected</span>}
        </div>
      )}

      {status && status.expected.length > 0 && (
        <div style={styles.summary}>
          <span style={styles.summaryItem}>
            {status.responded.length} of {status.expected.length} expected responded
          </span>
          {status.missing.length > 0 && (
            <span style={{ ...styles.chip, ...styles.chipPending }}>
              waiting on: {status.missing.join(", ")}
            </span>
          )}
        </div>
      )}

      {selected && (
        <label style={styles.rollupRow} title="Publisher only — keeps a typed Parquet of all submissions next to the data so a database can read it without parsing JSON">
          <input
            type="checkbox"
            checked={rollup}
            onChange={(e) => toggleRollup(e.target.checked)}
            style={{ marginRight: 6 }}
          />
          Auto-export submissions to Parquet (this machine refreshes <code>submissions/_rollup.parquet</code> on review actions and dashboard loads)
        </label>
      )}

      {error && <div style={styles.error}>{error}</div>}

      <div style={styles.list}>
        {!selected ? null : submissions.length === 0 ? (
          <div style={styles.empty}>No submissions yet for this region.</div>
        ) : (
          submissions.map((s) => {
            const key = `${s.submitterId}:${s.cellRow}:${s.cellCol}`;
            const badge = STATE_BADGE[s.state];
            const isBusy = busy === key;
            return (
              <div key={key} style={styles.row}>
                <div style={styles.rowMain}>
                  <span style={styles.submitter} title={s.submitterId}>{s.submitterName || s.submitterId}</span>
                  <span style={styles.cellRef}>{a1(s.cellRow, s.cellCol)}</span>
                  <span style={{ ...styles.badge, backgroundColor: badge.bg, color: badge.fg }}>{badge.label}</span>
                </div>
                <div style={styles.rowValue}>{s.valueDisplay || <em style={{ color: "#aaa" }}>(empty)</em>}</div>
                {s.state === "rejected" && s.reviewReason && (
                  <div style={{ fontSize: 11, color: "#c5221f", marginTop: 2 }}>
                    Reason: {s.reviewReason}
                  </div>
                )}
                <div style={styles.rowActions}>
                  {s.state !== "approved" && (
                    <button disabled={isBusy} onClick={() => decide(s, "approved")} style={{ ...styles.smallBtn, ...styles.approve }}>
                      Approve
                    </button>
                  )}
                  {s.state !== "rejected" && (
                    <button disabled={isBusy} onClick={() => decide(s, "rejected")} style={{ ...styles.smallBtn, ...styles.reject }}>
                      Reject
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", fontSize: 13 },
  header: { display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid #e0e0e0", flexShrink: 0 },
  headerText: { fontSize: 12, color: "#888", flex: 1 },
  select: { flex: 1, fontSize: 12, padding: "3px 4px" },
  smallBtn: { fontSize: 12, padding: "3px 10px", borderRadius: 4, border: "1px solid #d0d0d0", background: "#fff", cursor: "pointer" },
  approve: { background: "#137333", color: "#fff", borderColor: "#137333" },
  reject: { background: "#fff", color: "#c5221f", borderColor: "#e0a0a0" },
  summary: { display: "flex", alignItems: "center", flexWrap: "wrap" as const, gap: 6, padding: "6px 12px", borderBottom: "1px solid #f0f0f0", flexShrink: 0 },
  rollupRow: { display: "flex", alignItems: "center", fontSize: 11, color: "#555", padding: "6px 12px", borderBottom: "1px solid #f0f0f0", flexShrink: 0, cursor: "pointer" },
  summaryItem: { fontSize: 12, color: "#444", fontWeight: 500 },
  chip: { fontSize: 10, padding: "1px 6px", borderRadius: 8 },
  chipPending: { background: "#fef7e0", color: "#b06000" },
  chipApproved: { background: "#e6f4ea", color: "#137333" },
  chipRejected: { background: "#fce8e6", color: "#c5221f" },
  error: { color: "#c5221f", fontSize: 12, padding: "6px 12px" },
  list: { flex: 1, overflowY: "auto", padding: "4px 0" },
  row: { padding: "8px 12px", borderBottom: "1px solid #f0f0f0" },
  rowMain: { display: "flex", alignItems: "center", gap: 8 },
  submitter: { fontWeight: 600, color: "#333", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, flex: 1 },
  cellRef: { fontSize: 11, color: "#888", fontFamily: "monospace" },
  badge: { fontSize: 10, padding: "1px 6px", borderRadius: 8, flexShrink: 0 },
  rowValue: { fontSize: 13, color: "#222", marginTop: 2, wordBreak: "break-word" as const },
  rowActions: { display: "flex", gap: 6, marginTop: 6, justifyContent: "flex-end" },
  empty: { padding: "24px 12px", textAlign: "center" as const, color: "#999", fontSize: 12 },
};
