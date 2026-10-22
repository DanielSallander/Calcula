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
//
//          THE HEADER IS THREE ROWS (owner, 2026-10-22: "the sheet selector and
//          the environment filter seem a bit squeezed"). It used to be ONE flex
//          row holding the region select, the Collect From hero (outside the
//          band a 28px icon button, whose funnel overlapped the select and whose
//          label was cut to "Collect Fr"), Refresh and both exports. Now, from
//          @api/layout's panel primitives: (1) "Region" over the region select
//          at full width; (2) "Collect from" over a field-height dropdown that
//          names the current choice (CollectFromMenuButton presentation
//          "dropdown"; author regions only); (3) Refresh / Export CSV / Export
//          Parquet as a toolbar that wraps. Everything is painted with LT tokens,
//          so the pane follows the skin (Dark included); the chromeColorConfigs
//          hex ban in app/eslint.boundaries.js covers this file.

import React, { useState, useEffect, useCallback, useId, useRef, useSyncExternalStore } from "react";
import { css } from "@emotion/css";
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
import {
  ActionRow,
  Button,
  Checkbox,
  Field,
  Select,
  Stack,
  LT,
  FONT_FAMILY,
  FONT_MONO,
  GAP_MD,
  GAP_SM,
  LABEL_FONT_SIZE,
} from "@api/layout";
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
import { menuOrder, notCollectedText } from "../lib/collectStreamsModel";
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
 * the development line. `collecting` null = every stream, said as the Collect
 * from dropdown above it says it ("all streams", never a second wording).
 */
export function collectingLabel(collecting: string[] | null): string {
  if (collecting === null) return "all streams";
  return collecting.map(streamName).join(", ");
}

/** Whether rows must name their stream: more than one stream can appear. */
export function rowsShowStream(collecting: string[] | null): boolean {
  return collecting === null || collecting.length > 1;
}

/**
 * `collecting` in the PIPELINE's order -- the development line, then the
 * streams as `order` lists them, then any other name -- the order the Collect
 * From menu, its dropdown and its tooltip use. Rust hands the set over in name
 * order ("prod, test"), and the strip under a dropdown that says "test, prod"
 * must not say it the other way round. For an author's region `order` is the
 * menu's own (collectStreamsModel.ts `menuOrder`: every DEFINED environment,
 * also one not promoted yet -- a region's `environments` lists only those with
 * a version, so a chosen "staging" would rank last there).
 */
export function inPipelineOrder(collecting: string[], order: string[]): string[] {
  const rank = (stream: string): number => {
    if (stream === "") return -1;
    const at = order.indexOf(stream);
    return at === -1 ? order.length : at;
  };
  return [...collecting].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/** The header's rows, top to bottom (each a `publisher-dashboard-header-row`
 *  whose `data-row` is one of these). "collectFrom" is an AUTHOR region's
 *  only: a subscribed region's stream is fixed and its strip says which. */
export type HeaderRowName = "region" | "collectFrom" | "actions";

// ============================================================================
// Tones (LT tokens only: the pane follows the skin)
// ============================================================================

/** The status pills' tones: a foreground/background pair from the skin, so
 *  each reads on the light and the dark ground alike. */
type PillTone = "neutral" | "info" | "warn" | "ok" | "danger";

const PILL_TONE: Record<PillTone, React.CSSProperties> = {
  neutral: { background: LT.chipBg, color: LT.textSecondary, boxShadow: `inset 0 0 0 1px ${LT.chipBorder}` },
  info: { background: LT.infoBg, color: LT.infoFg },
  warn: { background: LT.warnBg, color: LT.warnFg },
  ok: { background: LT.okBg, color: LT.okFg },
  danger: { background: LT.dangerBg, color: LT.dangerFg },
};

const STATE_BADGE: Record<RegionSubmission["state"], { label: string; tone: PillTone }> = {
  draft: { label: "Draft", tone: "neutral" },
  submitted: { label: "Pending", tone: "warn" },
  approved: { label: "Approved", tone: "ok" },
  rejected: { label: "Rejected", tone: "danger" },
};

const SENDER_TONE: Record<SenderTone, string> = { ok: LT.okFg, warn: LT.warnFg, muted: LT.textSecondary };

const IDENTITY_TONE: Record<IdentityTone, string> = {
  ok: LT.okFg,
  warn: LT.warnFg,
  danger: LT.dangerFg,
  muted: LT.textSecondary,
};

/** Approve: the ok tone's pair on an outlined @api Button. `&&` out-ranks the
 *  Button's own outlined rule (the paneChrome primaryButtonClass idiom); the
 *  hover tint is LAYERED over the tone, which a bare translucent fill would
 *  drop. */
const approveClass = css`
  && {
    color: ${LT.okFg};
    background: ${LT.okBg};
    border-color: ${LT.okFg};
  }

  &&:hover:not(:disabled) {
    background: linear-gradient(${LT.hover}, ${LT.hover}), ${LT.okBg};
  }

  &&:active:not(:disabled) {
    background: linear-gradient(${LT.active}, ${LT.active}), ${LT.okBg};
  }
`;

// ============================================================================
// Small parts
// ============================================================================

/** A status pill in the summary strips and on each row. */
function Pill({
  tone,
  testId,
  title,
  children,
}: {
  tone: PillTone;
  testId?: string;
  title?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <span style={{ ...styles.pill, ...PILL_TONE[tone] }} data-testid={testId} data-tone={tone} title={title}>
      {children}
    </span>
  );
}

/** One row of the header: a named slot the tests and E2E can find. */
function HeaderRow({ name, children }: { name: HeaderRowName; children: React.ReactNode }): React.ReactElement {
  return (
    <div data-testid="publisher-dashboard-header-row" data-row={name} style={styles.headerRow}>
      {children}
    </div>
  );
}

// ============================================================================
// The pane
// ============================================================================

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
  const regionSelectId = useId();
  const collectFromId = useId();
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
   * subscription follows. The pane shows the same control as the tab (as a
   * dropdown that names the choice), and the strip names the streams, because
   * "3 responses" without them is how a test count gets read as a production
   * one.
   */
  useSyncExternalStore(subscribeCollectStreams, getCollectStreamsVersion, getCollectStreamsVersion);
  const streamsView = getCollectStreamsView();

  const current = regions.find((r) => r.regionId === selected) ?? null;
  const ready = current?.status === "ready";
  // ONE order with the dropdown and its tooltip: the menu's, for an author's
  // region (the workbook's own choice); a subscribed region collects one stream.
  const streamOrder =
    current?.role === "author" && streamsView?.linked ? menuOrder(streamsView) : current?.environments ?? [];
  const collecting: string[] | null =
    ready && current && current.collecting ? inPipelineOrder(current.collecting, streamOrder) : null;

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
  const canExport = Boolean(selected) && ready && submissions.length > 0;

  return (
    <div style={styles.container} data-testid="publisher-dashboard">
      <div style={styles.header} data-testid="publisher-dashboard-header">
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
          <Stack gap={GAP_MD}>
            <HeaderRow name="region">
              <Field label="Region" htmlFor={regionSelectId}>
                <Select
                  id={regionSelectId}
                  value={selected ?? ""}
                  onChange={(e) => setSelected(e.target.value)}
                  title={current ? collectionRegionLabel(current) : undefined}
                  data-testid="publisher-dashboard-region"
                >
                  {regions.map((r) => (
                    <option key={r.regionId} value={r.regionId}>
                      {collectionRegionLabel(r)}
                    </option>
                  ))}
                </Select>
              </Field>
            </HeaderRow>
            {current && isAuthor && (
              <HeaderRow name="collectFrom">
                <Field label="Collect from" htmlFor={collectFromId}>
                  <CollectFromMenuButton
                    presentation="dropdown"
                    id={collectFromId}
                    testId="publisher-dashboard-collect-from"
                  />
                </Field>
              </HeaderRow>
            )}
            <HeaderRow name="actions">
              <ActionRow gap={GAP_SM}>
                <Button
                  variant="outlined"
                  onClick={() => selected && loadSubs(selected)}
                  disabled={loading || !selected || !ready}
                  aria-busy={loading || undefined}
                  title="Read this region's answers again"
                  data-testid="publisher-dashboard-refresh"
                >
                  Refresh
                </Button>
                <Button
                  variant="outlined"
                  onClick={exportCsv}
                  disabled={!canExport}
                  title="Export this region's submissions as CSV"
                  data-testid="publisher-dashboard-export-csv"
                >
                  Export CSV
                </Button>
                <Button
                  variant="outlined"
                  onClick={exportParquet}
                  disabled={!canExport}
                  title="Export this region's submissions as Parquet (typed, for databases)"
                  data-testid="publisher-dashboard-export-parquet"
                >
                  Export Parquet
                </Button>
              </ActionRow>
            </HeaderRow>
          </Stack>
        )}
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
        <div style={{ ...styles.notReady, color: LT.warnFg }} data-testid="publisher-dashboard-not-collected">
          {notCollected}
        </div>
      )}

      {current && ready && (
        <div style={styles.summary}>
          <span style={styles.summaryItem} data-testid="publisher-dashboard-respondents">
            {respondents} respondent{respondents !== 1 ? "s" : ""}
          </span>
          {current.packageName && (
            <Pill tone="neutral" title={current.registryUrl ?? ""}>
              {current.packageName}
              {current.version ? ` v${current.version}` : ""}
            </Pill>
          )}
          <Pill
            tone="info"
            testId="publisher-dashboard-streams"
            title={
              isAuthor
                ? "The streams this workbook collects (Writeback > Collect From)."
                : "This workbook's stream: a subscribed region shows the stream its subscription follows."
            }
          >
            {isAuthor ? `from ${collectingLabel(collecting)}` : `in ${collectingLabel(collecting)} (this workbook's stream)`}
          </Pill>
          {pending > 0 && <Pill tone="warn">{pending} pending</Pill>}
          {approved > 0 && <Pill tone="ok">{approved} approved</Pill>}
          {rejected > 0 && <Pill tone="danger">{rejected} rejected</Pill>}
          {notCounted > 0 && (
            <Pill
              tone="danger"
              testId="publisher-dashboard-not-counted"
              title="This application counts only answers from verified senders. These answers are shown here and counted nowhere else."
            >
              {notCounted} not counted (sender not verified)
            </Pill>
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
          {status.missing.length > 0 && <Pill tone="warn">waiting on: {status.missing.join(", ")}</Pill>}
          {(status.notCounted ?? []).length > 0 && (
            <Pill tone="danger" testId="publisher-dashboard-roster-not-counted">
              not counted (not verified): {(status.notCounted ?? []).join(", ")}
            </Pill>
          )}
        </div>
      )}

      {ready && (
        <div style={styles.rollupRow}>
          <Checkbox
            checked={rollup}
            onChange={(next) => void toggleRollup(next)}
            testId="publisher-dashboard-rollup"
            tooltip="Publisher only — keeps a typed Parquet of all submissions next to the data so a database can read it without parsing JSON"
            label={
              <span style={styles.rollupLabel}>
                Auto-export submissions to Parquet (this machine refreshes{" "}
                <code style={styles.code}>submissions/_rollup.parquet</code> on review actions and dashboard loads)
              </span>
            }
          />
        </div>
      )}

      {error && (
        <div style={styles.error} role="alert">
          {error}
        </div>
      )}

      <div style={styles.list} data-testid="publisher-dashboard-list">
        {!selected || !ready ? null : submissions.length === 0 ? (
          <div style={styles.empty}>{loading ? "Loading…" : "No submissions yet for this region."}</div>
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
                  <Pill tone={badge.tone}>{badge.label}</Pill>
                </div>
                <SenderRow row={s} />
                <IdentityRow row={s} />
                <div style={styles.rowValue}>{s.valueDisplay || <em style={styles.emptyValue}>(empty)</em>}</div>
                {s.state === "rejected" && s.reviewReason && (
                  <div style={styles.reason}>Reason: {s.reviewReason}</div>
                )}
                <div style={styles.rowActions}>
                  {s.state !== "approved" && (
                    <Button
                      size="sm"
                      variant="outlined"
                      className={approveClass}
                      disabled={isBusy}
                      onClick={() => decide(s, "approved")}
                    >
                      Approve
                    </Button>
                  )}
                  {s.state !== "rejected" && (
                    <Button
                      size="sm"
                      variant="outlined"
                      tone="danger"
                      disabled={isBusy}
                      onClick={() => decide(s, "rejected")}
                    >
                      Reject
                    </Button>
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

const divider = `1px solid ${LT.controlDivider}`;

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    overflow: "hidden",
    fontFamily: FONT_FAMILY,
    fontSize: 13,
    color: LT.text,
  },
  header: { padding: "10px 12px", borderBottom: divider, flexShrink: 0, minWidth: 0 },
  headerRow: { minWidth: 0 },
  headerText: { display: "block", fontSize: 12, lineHeight: 1.4, color: LT.textSecondary },
  summary: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 6,
    padding: "6px 12px",
    borderBottom: divider,
    flexShrink: 0,
  },
  notReady: {
    fontSize: 12,
    color: LT.textSecondary,
    padding: "8px 12px",
    borderBottom: divider,
    flexShrink: 0,
    lineHeight: 1.4,
  },
  rollupRow: { padding: "2px 12px", borderBottom: divider, flexShrink: 0 },
  rollupLabel: { fontSize: LABEL_FONT_SIZE, color: LT.textSecondary },
  code: { fontFamily: FONT_MONO, fontSize: LABEL_FONT_SIZE },
  summaryItem: { fontSize: 12, color: LT.text, fontWeight: 500 },
  pill: {
    display: "inline-flex",
    alignItems: "center",
    flexShrink: 0,
    maxWidth: "100%",
    fontSize: LABEL_FONT_SIZE,
    fontWeight: 500,
    lineHeight: "16px",
    padding: "0 7px",
    borderRadius: LT.radiusPill,
    whiteSpace: "normal",
    overflowWrap: "anywhere",
  },
  error: { color: LT.dangerFg, fontSize: 12, padding: "6px 12px", lineHeight: 1.4 },
  list: { flex: 1, overflowY: "auto", padding: "4px 0" },
  row: { padding: "8px 12px", borderBottom: divider },
  rowMain: { display: "flex", alignItems: "center", gap: 8 },
  submitter: {
    fontWeight: 600,
    color: LT.text,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    flex: 1,
    minWidth: 0,
  },
  cellRef: { fontSize: LABEL_FONT_SIZE, color: LT.textSecondary, fontFamily: FONT_MONO },
  sender: { fontSize: LABEL_FONT_SIZE, marginTop: 2 },
  rowValue: { fontSize: 13, color: LT.text, marginTop: 2, wordBreak: "break-word" },
  emptyValue: { color: LT.textTertiary },
  reason: { fontSize: LABEL_FONT_SIZE, color: LT.dangerFg, marginTop: 2 },
  rowActions: { display: "flex", gap: GAP_SM, marginTop: 6, justifyContent: "flex-end" },
  empty: { padding: "24px 12px", textAlign: "center", color: LT.textSecondary, fontSize: 12 },
};
