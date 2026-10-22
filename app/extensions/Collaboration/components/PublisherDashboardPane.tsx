// FILENAME: app/extensions/Collaboration/components/PublisherDashboardPane.tsx
// PURPOSE: Publisher data-collection dashboard (D5) — a submissions inbox +
//          respondent roster + approve/reject for each writeback region.
// CONTEXT: Wires the workspace primitive load_region_submissions (via the
//          calp_load_region_submissions command) and calp_set_submission_state,
//          so a publisher can SEE who responded and approve/reject — instead of
//          GATHER formulas being the only surface.
//
//          THE REGION LIST IS THE PUBLISHER-SIDE ONE (listCollectionRegions),
//          never the subscriber index. It used to be getWritebackRegions(), which
//          holds only SUBSCRIBED regions, so the person who designated B3:B5 and
//          published it read "No writeback regions in this workbook." with
//          answers waiting in the workspace (BUG-0553). The workbook's own
//          designated regions now come first, each resolved by Rust through the
//          application the workbook published or was opened for editing from;
//          a region that cannot be read yet says why (publish first, push first,
//          not the publisher, workspace unreachable) instead of an empty inbox.

import React, { useState, useEffect, useCallback, useRef, useSyncExternalStore } from "react";
import { onAppEvent, AppEvents } from "@api";
import type { WritebackSubmissionReceivedPayload } from "@api/events";
import { acquireSubmissionWatch } from "@api/collaboration";
import {
  listCollectionRegions,
  loadRegionSubmissions,
  setSubmissionState,
  exportRegionSubmissionsCsv,
  exportRegionSubmissionsParquet,
  getWritebackRollup,
  setWritebackRollup,
  regionResponseStatus,
  type CollectionRegion,
  type RegionSubmission,
  type RegionResponseStatus,
} from "@api/collaboration";
import { saveCsvReport, saveParquetReport } from "../lib/reportExport";
import { WRITEBACK_REGIONS_CHANGED_EVENT, WRITEBACK_COLLECTION_STREAMS_CHANGED_EVENT } from "../lib/writebackIds";
import { ENVIRONMENTS_CHANGED_EVENT } from "@api/collaboration";
import { takeCollectedResponsesFocus, onCollectedResponsesFocus } from "../lib/collectedResponsesFocus";
import {
  subscribeCollectStreams,
  getCollectStreamsVersion,
  getCollectStreamsView,
  refreshCollectStreams,
} from "../lib/collectStreamsStore";
import { notCollectedText } from "../lib/collectStreamsModel";
import { CollectFromMenuButton } from "./CollectFromMenuButton";
import { promptAsync } from "@api/dialogs";
import { senderLine, identityLine, notCountedCount, headerRows, type SenderTone, type IdentityTone } from "../lib/senderLabel";

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

/** "Report!B3:B5" (or "B3" for one cell); the sheet is omitted when unknown. */
export function collectionRegionLabel(r: CollectionRegion): string {
  const tl = a1(r.rowStart, r.colStart);
  const br = a1(r.rowEnd, r.colEnd);
  const range = tl === br ? tl : `${tl}:${br}`;
  return r.sheetName ? `${r.sheetName}!${range}` : range;
}

/** The stream name a row or a chip shows ("" is the development line). */
export function streamName(environment: string): string {
  return environment === "" ? "development line" : environment;
}

/** The empty-pane sentence: what to do, not just what is missing. */
export const NO_REGIONS_TEXT =
  "This workbook has no writeback regions. Designate one (Writeback > Designate Writeback Region) and publish to start collecting.";

/** The sentence when the region list itself could not be read -- NEVER the
 *  "no writeback regions" text: a workbook that has regions must not be told
 *  it has none (the owner's original symptom). */
export function regionsReadFailedText(error: string): string {
  return `Could not read this workbook's writeback regions: ${error}`;
}

/**
 * The streams a region's rows come from, as the summary chip says it: "" for
 * the development line. `collecting` null = every stream.
 */
export function collectingLabel(collecting: string[] | null): string {
  if (collecting === null) return "every stream";
  return collecting.map(streamName).join(", ");
}

/** Whether rows must name their stream: more than one stream can appear. */
export function rowsShowStream(collecting: string[] | null): boolean {
  return collecting === null || collecting.length > 1;
}

const STATE_BADGE: Record<RegionSubmission["state"], { label: string; bg: string; fg: string }> = {
  draft: { label: "Draft", bg: "#f1f3f4", fg: "#5f6368" },
  submitted: { label: "Pending", bg: "#fef7e0", fg: "#b06000" },
  approved: { label: "Approved", bg: "#e6f4ea", fg: "#137333" },
  rejected: { label: "Rejected", bg: "#fce8e6", fg: "#c5221f" },
};

export function PublisherDashboardPane(): React.ReactElement {
  const [regions, setRegions] = useState<CollectionRegion[]>([]);
  const [regionsLoaded, setRegionsLoaded] = useState(false);
  /** Why the region LIST could not be read (kept apart from an inbox error). */
  const [regionsError, setRegionsError] = useState<string | null>(null);
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
  const regionsRef = useRef<CollectionRegion[]>([]);
  regionsRef.current = regions;

  /**
   * WHICH STREAMS THE INBOX SHOWS is not this pane's to decide (owner decision
   * 2026-10-22): it is the workbook's ONE choice, Writeback > Collect From --
   * for its own region the streams the publisher chose (default: the
   * pipeline's last environment), for a subscribed region the stream the
   * subscription follows. The pane shows the same control as the tab, and the
   * strip names the streams, because "3 responses" without them is how a test
   * count gets read as a production one.
   */
  useSyncExternalStore(subscribeCollectStreams, getCollectStreamsVersion, getCollectStreamsVersion);
  const streamsView = getCollectStreamsView();

  const current = regions.find((r) => r.regionId === selected) ?? null;
  const ready = current?.status === "ready";
  const collecting: string[] | null = ready && current ? current.collecting : null;

  const loadRegions = useCallback(async () => {
    try {
      const r = await listCollectionRegions();
      setRegions(r);
      setRegionsError(null);
      // Opened FOR a region (Writeback > Collected Responses with the cursor
      // in it): show that one when it is listed.
      const asked = takeCollectedResponsesFocus();
      setSelected((cur) =>
        asked && r.some((x) => x.regionId === asked)
          ? asked
          : cur && r.some((x) => x.regionId === cur)
            ? cur
            : r.length > 0
              ? r[0].regionId
              : null,
      );
    } catch (e: unknown) {
      // The previous list (if any) stays; the failure is said as what it is.
      setRegionsError(String(e));
    } finally {
      setRegionsLoaded(true);
    }
  }, []);

  // Asked for a region while already open: switch to it when it is listed.
  useEffect(
    () =>
      onCollectedResponsesFocus((regionId) => {
        if (regionsRef.current.some((r) => r.regionId === regionId)) {
          takeCollectedResponsesFocus();
          setSelected(regionId);
        }
      }),
    [],
  );

  const loadSubs = useCallback(async (regionId: string) => {
    // A region that cannot be read here shows WHY (its detail), not an empty
    // inbox under an error the publisher cannot act on.
    const row = regionsRef.current.find((r) => r.regionId === regionId);
    if (!row || row.status !== "ready") {
      setSubmissions([]);
      setStatus(null);
      setRollup(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [subs, st, rp] = await Promise.all([
        // No stream: Rust reads the workbook's ONE choice for both, so the
        // roster always counts the streams the list shows.
        loadRegionSubmissions(regionId),
        regionResponseStatus(regionId).catch(() => null),
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
    void loadRegions();
    void refreshCollectStreams();
    const offSheet = onAppEvent(AppEvents.SHEET_CHANGED, loadRegions);
    // Designating, editing or removing one of this workbook's own regions
    // changes the list too.
    const offRegions = onAppEvent(WRITEBACK_REGIONS_CHANGED_EVENT, loadRegions);
    // Collect From changed (here or on the Writeback tab): the list's
    // `collecting` and the inbox both follow.
    const reloadAll = () => {
      void loadRegions().then(() => {
        if (selectedRef.current) void loadSubs(selectedRef.current);
      });
    };
    const offStreams = onAppEvent(WRITEBACK_COLLECTION_STREAMS_CHANGED_EVENT, reloadAll);
    // A publish (the first one links the workbook), a pipeline edit or a
    // promotion: the regions' status and their `collecting` (the default is
    // the last environment) can have changed.
    const offEnvironments = onAppEvent(ENVIRONMENTS_CHANGED_EVENT, reloadAll);
    return () => {
      offSheet();
      offRegions();
      offStreams();
      offEnvironments();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadRegions]);

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

  // Re-read the inbox when the selection changes AND when the selected row's
  // readiness arrives or changes (the list loads asynchronously).
  const currentStatus = current?.status ?? null;
  useEffect(() => {
    if (selected) void loadSubs(selected);
    else setSubmissions([]);
  }, [selected, currentStatus, loadSubs]);

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
      setBusy(`${s.environment}:${s.submitterId}:${s.cellRow}:${s.cellCol}`);
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
          // THE STREAM THE ROW CAME FROM: when several streams are collected
          // one person can hold a row per environment, and only the row's own
          // stream names the record being decided.
          s.environment,
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
      const csv = await exportRegionSubmissionsCsv(selected);
      await saveCsvReport(csv, `${selected}-submissions.csv`);
    } catch (e: unknown) {
      setError(String(e));
    }
  }, [selected]);

  const exportParquet = useCallback(async () => {
    if (!selected) return;
    setError(null);
    try {
      const bytes = await exportRegionSubmissionsParquet(selected);
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

  // THE HEADER COUNTS WHAT THE RULE COUNTS. Under "count only verified
  // senders" the rows the rule leaves out are listed below and marked, but the
  // totals beside the strip that says "left out of every total" never include
  // them (counted rows only; the "N not counted" chip names the rest).
  const countedRows = headerRows(submissions, status?.requireVerified === true);
  const respondents = new Set(countedRows.map((s) => s.submitterId)).size;
  const pending = countedRows.filter((s) => s.state === "submitted").length;
  const approved = countedRows.filter((s) => s.state === "approved").length;
  const rejected = countedRows.filter((s) => s.state === "rejected").length;
  // WHAT THE APPLICATION'S IDENTITY RULE LEAVES OUT (identity phase 1): shown
  // here, counted nowhere -- not in a total, the roster, a BI table or a script.
  const notCounted = notCountedCount(submissions);
  // Rows carry their stream whenever more than one stream can appear.
  const showRowStream = ready && rowsShowStream(collecting);
  const isAuthor = current?.role === "author";
  const notCollected = isAuthor && ready ? notCollectedText(streamsView) : null;

  return (
    <div style={styles.container} data-testid="publisher-dashboard">
      <div style={styles.header}>
        {regions.length === 0 ? (
          regionsError ? (
            <span style={styles.headerText} data-testid="publisher-dashboard-regions-error">
              {regionsReadFailedText(regionsError)}
            </span>
          ) : (
            <span style={styles.headerText} data-testid="publisher-dashboard-empty">
              {regionsLoaded ? NO_REGIONS_TEXT : "Loading…"}
            </span>
          )
        ) : (
          <select
            value={selected ?? ""}
            onChange={(e) => setSelected(e.target.value)}
            style={styles.select}
            data-testid="publisher-dashboard-region"
          >
            {regions.map((r) => (
              <option key={r.regionId} value={r.regionId}>
                {collectionRegionLabel(r)}
              </option>
            ))}
          </select>
        )}
        {current && isAuthor && <CollectFromMenuButton testId="publisher-dashboard-collect-from" />}
        <button onClick={() => selected && loadSubs(selected)} disabled={loading || !selected || !ready} style={styles.smallBtn}>
          {loading ? "..." : "Refresh"}
        </button>
        <button
          onClick={exportCsv}
          disabled={!selected || !ready || submissions.length === 0}
          style={styles.smallBtn}
          title="Export this region's submissions as CSV"
        >
          Export CSV
        </button>
        <button
          onClick={exportParquet}
          disabled={!selected || !ready || submissions.length === 0}
          style={styles.smallBtn}
          title="Export this region's submissions as Parquet (typed, for databases)"
        >
          Export Parquet
        </button>
      </div>

      {regions.length > 0 && regionsError && (
        <div style={styles.error} data-testid="publisher-dashboard-regions-error">
          {regionsReadFailedText(regionsError)}
        </div>
      )}

      {current && !ready && (
        <div style={styles.notReady} data-testid="publisher-dashboard-not-ready" data-status={current.status}>
          {current.detail}
        </div>
      )}

      {current && ready && current.note && (
        <div style={styles.notReady} data-testid="publisher-dashboard-note">
          {current.note}
        </div>
      )}

      {notCollected && (
        <div style={styles.notReady} data-testid="publisher-dashboard-not-collected">
          {notCollected}
        </div>
      )}

      {current && ready && (
        <div style={styles.summary}>
          <span style={styles.summaryItem} data-testid="publisher-dashboard-respondents">
            {respondents} respondent{respondents !== 1 ? "s" : ""}
          </span>
          {current.packageName && (
            <span style={{ ...styles.chip, background: "#f1f3f4", color: "#5f6368" }} title={current.registryUrl ?? ""}>
              {current.packageName}
              {current.version ? ` v${current.version}` : ""}
            </span>
          )}
          <span
            style={{ ...styles.chip, background: "#e8f0fe", color: "#1a5fb4" }}
            data-testid="publisher-dashboard-streams"
            title={
              isAuthor
                ? "The streams this workbook collects (Writeback > Collect From)."
                : "This workbook's stream: a subscribed region shows the stream its subscription follows."
            }
          >
            {isAuthor ? `from ${collectingLabel(collecting)}` : `in ${collectingLabel(collecting)} (this workbook's stream)`}
          </span>
          {pending > 0 && <span style={{ ...styles.chip, ...styles.chipPending }}>{pending} pending</span>}
          {approved > 0 && <span style={{ ...styles.chip, ...styles.chipApproved }}>{approved} approved</span>}
          {rejected > 0 && <span style={{ ...styles.chip, ...styles.chipRejected }}>{rejected} rejected</span>}
          {notCounted > 0 && (
            <span
              style={{ ...styles.chip, ...styles.chipRejected }}
              data-testid="publisher-dashboard-not-counted"
              title="This application counts only answers from verified senders. These answers are shown here and counted nowhere else."
            >
              {notCounted} not counted (sender not verified)
            </span>
          )}
        </div>
      )}

      {ready && status?.requireVerified && (
        <div style={styles.notReady} data-testid="publisher-dashboard-rule">
          This application counts only answers from verified senders. Answers whose sender could not be verified
          are listed below, marked, and left out of every total.
        </div>
      )}

      {ready && status && status.expected.length > 0 && (
        <div style={styles.summary}>
          <span style={styles.summaryItem}>
            {status.responded.length} of {status.expected.length} expected responded
          </span>
          {status.missing.length > 0 && (
            <span style={{ ...styles.chip, ...styles.chipPending }}>
              waiting on: {status.missing.join(", ")}
            </span>
          )}
          {(status.notCounted ?? []).length > 0 && (
            <span style={{ ...styles.chip, ...styles.chipRejected }} data-testid="publisher-dashboard-roster-not-counted">
              not counted (not verified): {(status.notCounted ?? []).join(", ")}
            </span>
          )}
        </div>
      )}

      {ready && (
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

      <div style={styles.list} data-testid="publisher-dashboard-list">
        {!selected || !ready ? null : submissions.length === 0 ? (
          <div style={styles.empty}>No submissions yet for this region.</div>
        ) : (
          submissions.map((s) => {
            const key = `${s.environment}:${s.submitterId}:${s.cellRow}:${s.cellCol}`;
            const badge = STATE_BADGE[s.state];
            const isBusy = busy === key;
            return (
              <div key={key} style={styles.row} data-testid="publisher-dashboard-row" data-stream={s.environment}>
                <div style={styles.rowMain}>
                  <span style={styles.submitter} title={s.submitterId}>{s.submitterName || s.submitterId}</span>
                  {showRowStream && <span style={styles.cellRef}>{streamName(s.environment)}</span>}
                  <span style={styles.cellRef}>{a1(s.cellRow, s.cellCol)}</span>
                  <span style={{ ...styles.badge, backgroundColor: badge.bg, color: badge.fg }}>{badge.label}</span>
                </div>
                <SenderRow row={s} />
                <IdentityRow row={s} />
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

/** WHO SENT IT (identity phase 1): signed by the key its sender id names, or
 *  sent before sign-in. Rust decides; forged answers never reach this list. */
function SenderRow({ row }: { row: Parameters<typeof senderLine>[0] }) {
  const line = senderLine(row);
  return (
    <div style={{ ...styles.sender, color: SENDER_TONE[line.tone] }} data-testid="publisher-dashboard-sender" data-sender={row.sender}>
      {line.text}
    </div>
  );
}

const SENDER_TONE: Record<SenderTone, string> = { ok: "#137333", warn: "#b06000", muted: "#888" };

/** THE IDENTITY COLUMN (identity phase 1, read side): this computer's verdict
 *  on who sent the answer -- verified, signed but not confirmed (and why),
 *  not verified ("written by ..."), or sent before sign-in -- and whether the
 *  application's rule counts it. Rust decides and words it. */
function IdentityRow({ row }: { row: RegionSubmission }) {
  const line = identityLine(row);
  return (
    <div
      style={{ ...styles.sender, color: IDENTITY_TONE[line.tone] }}
      data-testid="publisher-dashboard-identity"
      data-identity={row.identity?.status ?? "notChecked"}
      data-counted={row.counted ? "true" : "false"}
      title={row.identity?.writtenBy ? `Windows recorded ${row.identity.writtenBy} as the writer of this answer.` : undefined}
    >
      Identity: {line.text}
    </div>
  );
}

const IDENTITY_TONE: Record<IdentityTone, string> = { ok: "#137333", warn: "#b06000", danger: "#c5221f", muted: "#888" };

const styles: Record<string, React.CSSProperties> = {
  container: { display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", fontSize: 13 },
  header: { display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid #e0e0e0", flexShrink: 0 },
  headerText: { fontSize: 12, color: "#888", flex: 1 },
  select: { flex: 1, fontSize: 12, padding: "3px 4px" },
  smallBtn: { fontSize: 12, padding: "3px 10px", borderRadius: 4, border: "1px solid #d0d0d0", background: "#fff", cursor: "pointer" },
  approve: { background: "#137333", color: "#fff", borderColor: "#137333" },
  reject: { background: "#fff", color: "#c5221f", borderColor: "#e0a0a0" },
  summary: { display: "flex", alignItems: "center", flexWrap: "wrap" as const, gap: 6, padding: "6px 12px", borderBottom: "1px solid #f0f0f0", flexShrink: 0 },
  notReady: { fontSize: 12, color: "#5f6368", background: "#f8f9fa", padding: "8px 12px", borderBottom: "1px solid #f0f0f0", flexShrink: 0, lineHeight: 1.4 },
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
  sender: { fontSize: 11, marginTop: 2 },
  rowValue: { fontSize: 13, color: "#222", marginTop: 2, wordBreak: "break-word" as const },
  rowActions: { display: "flex", gap: 6, marginTop: 6, justifyContent: "flex-end" },
  empty: { padding: "24px 12px", textAlign: "center" as const, color: "#999", fontSize: 12 },
};
