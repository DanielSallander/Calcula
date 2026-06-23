// FILENAME: app/extensions/Distribution/components/PublisherDashboardPane.tsx
// PURPOSE: Publisher data-collection dashboard (D5) — a submissions inbox +
//          respondent roster + approve/reject for each writeback region.
// CONTEXT: Wires the previously-unexposed registry primitive load_region_submissions
//          (via the new calp_load_region_submissions command) and the unwired
//          calp_set_submission_state, so a publisher can SEE who responded and
//          approve/reject — instead of GATHER formulas being the only surface.

import React, { useState, useEffect, useCallback } from "react";
import { onAppEvent, AppEvents } from "@api";
import {
  getWritebackRegions,
  loadRegionSubmissions,
  setSubmissionState,
  exportRegionSubmissionsCsv,
  regionResponseStatus,
  type WritebackRegionEntry,
  type RegionSubmission,
  type RegionResponseStatus,
} from "@api/distribution";
import { saveCsvReport } from "../lib/reportExport";

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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

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
      const [subs, st] = await Promise.all([
        loadRegionSubmissions(regionId),
        regionResponseStatus(regionId).catch(() => null),
      ]);
      setSubmissions(subs);
      setStatus(st);
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

  useEffect(() => {
    if (selected) loadSubs(selected);
    else setSubmissions([]);
  }, [selected, loadSubs]);

  const decide = useCallback(
    async (s: RegionSubmission, newState: "approved" | "rejected") => {
      let reason: string | null = null;
      if (newState === "rejected") {
        // The reason is shown back to the contributor on their read-back.
        reason = window.prompt(
          "Reason for rejecting (optional — the contributor will see this):",
          "",
        );
        if (reason === null) return; // publisher cancelled — abort the rejection
      }
      setBusy(`${s.submitterId}:${s.cellRow}:${s.cellCol}`);
      setError(null);
      try {
        await setSubmissionState(s.regionId, s.submitterId, s.cellRow, s.cellCol, newState, reason);
        if (selected) await loadSubs(selected);
      } catch (e: unknown) {
        setError(String(e));
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
      const csv = await exportRegionSubmissionsCsv(selected);
      await saveCsvReport(csv, `${selected}-submissions.csv`);
    } catch (e: unknown) {
      setError(String(e));
    }
  }, [selected]);

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
      </div>

      {selected && (
        <div style={styles.summary}>
          <span style={styles.summaryItem}>{respondents} respondent{respondents !== 1 ? "s" : ""}</span>
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
