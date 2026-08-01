//! FILENAME: app/extensions/ScriptableObjects/components/CodeInThisFilePanel.tsx
// PURPOSE: The "Code in This File" transparency inspector (T1) — a single, per-
//          workbook inventory of EVERY piece of executable code in the open
//          file: where it resides, where it came from, what it is allowed to
//          touch, and (inline) its actual source. The vision made literal:
//          "the user must always know where code resides and what it can touch
//          -- never hidden inside a binary file."
// CONTEXT: Registered via the sections-based panel API in ../index.ts. Reads the
//          unified inventory from @api/codeInventory (getWorkbookCodeUnits),
//          which joins object scripts (worker-realm, real capability ceiling)
//          with module scripts and notebooks (isolated Rust QuickJS, grid-only).
//          Surface headers come straight from the SCRIPT_SURFACES taxonomy, so
//          that governance spine finally has a per-file UI consumer.
//
//          It is ALSO the home of scheduled jobs (the `schedule` capability —
//          Calcula's Application.OnTime replacement). A recurring job that
//          starts itself is code the user did not ask for at the moment it
//          runs, so it must be visible where they look for "what code is in
//          this file", and it must be stoppable from there: every job row can
//          be paused or cancelled outright. Settings > Script Security carries
//          only a live count and a link here — the schedule lives in the
//          workbook, so the per-workbook panel is its home, not the machine-
//          scoped trust page.

import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  getWorkbookCodeUnits,
  summarizeCodeInventory,
  getScriptSurface,
} from "@api";
import type {
  CodeUnit,
  CodeInventorySummary,
  CapabilityId,
} from "@api";
import {
  getWorkbookScheduledJobs,
  summarizeScheduledJobs,
  describeJobTime,
  cancelScheduledJob,
  setScheduledJobEnabled,
  type ScheduledJobEntry,
  type ScheduledJobSummary,
} from "@api/codeInventory";
import type { PanelSectionProps } from "@api/uiTypes";
import { emitAppEvent, onAppEvent } from "@api/events";
import { ScriptableObjectEvents } from "../index";

// ============================================================================
// Capability labels (short, human; the ids are the single vocabulary source)
// ============================================================================

const CAP_LABEL: Record<CapabilityId, string> = {
  "net.fetch": "Network",
  "bi.query": "BI query",
  "bi.sql": "BI SQL",
  storage: "Storage",
  "ui.html": "Host HTML",
  "formula.udf": "Worksheet fn",
  "bi.model": "BI model edit",
  "bi.connector": "BI connector",
  "ui.dialog": "Ask you",
  "distribution.writeback": "Package writeback",
  schedule: "Scheduled jobs",
};

const capLabel = (c: CapabilityId): string => CAP_LABEL[c] ?? c;

// ============================================================================
// Styles (match PermissionsPanel / ObjectScriptManagerPane conventions)
// ============================================================================

const rootStyle = (placement: "sidebar" | "ribbon"): React.CSSProperties => ({
  fontFamily: "'Segoe UI', Tahoma, sans-serif",
  fontSize: 11,
  color: "#333",
  ...(placement === "ribbon" ? { width: 380, height: "100%", overflowY: "auto" } : {}),
});

const introStyle: React.CSSProperties = {
  padding: "6px 4px 8px",
  color: "#666",
  lineHeight: 1.4,
};

const summaryRowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 4,
  padding: "0 4px 6px",
};

const chipStyle: React.CSSProperties = {
  fontSize: 10,
  padding: "1px 6px",
  borderRadius: 3,
  backgroundColor: "#EEF1F4",
  color: "#555",
  whiteSpace: "nowrap",
};

const warnChipStyle: React.CSSProperties = {
  ...chipStyle,
  backgroundColor: "#FCEEDB",
  color: "#9A5B00",
};

const reachCalloutStyle: React.CSSProperties = {
  margin: "0 4px 8px",
  padding: "6px 8px",
  borderRadius: 4,
  backgroundColor: "#FCEEDB",
  color: "#7A4A00",
  fontSize: 10.5,
  lineHeight: 1.4,
};

const groupHeaderStyle: React.CSSProperties = {
  marginTop: 10,
  padding: "4px 4px 2px",
  borderBottom: "1px solid #E0E0E0",
};

const groupTitleStyle: React.CSSProperties = {
  fontWeight: 600,
  fontSize: 11.5,
  color: "#2A2A2A",
};

const groupContainmentStyle: React.CSSProperties = {
  fontSize: 9.5,
  color: "#999",
  marginTop: 1,
};

const unitStyle: React.CSSProperties = {
  padding: "6px 4px",
  borderBottom: "1px solid #F0F0F0",
};

const unitHeaderRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 6,
};

const unitNameStyle: React.CSSProperties = { fontWeight: 600, color: "#1A1A1A" };
const residenceStyle: React.CSSProperties = { fontSize: 10, color: "#777", marginTop: 1 };

const badgeRowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 4,
  marginTop: 4,
  alignItems: "center",
};

const localBadge: React.CSSProperties = {
  ...chipStyle,
  backgroundColor: "#E6F0E6",
  color: "#3A6B3A",
};
const pkgBadge: React.CSSProperties = {
  ...chipStyle,
  backgroundColor: "#E6ECF6",
  color: "#33558A",
};
const tierBadge: React.CSSProperties = { ...chipStyle, backgroundColor: "#E8E8E8", color: "#555" };
const gridOnlyBadge: React.CSSProperties = {
  ...chipStyle,
  backgroundColor: "#EAF4EA",
  color: "#3A6B3A",
};
const capCeilingBadge: React.CSSProperties = {
  ...chipStyle,
  backgroundColor: "#FCEEDB",
  color: "#9A5B00",
};
const capGrantedBadge: React.CSSProperties = {
  ...chipStyle,
  backgroundColor: "#F4D6A6",
  color: "#7A4A00",
  fontWeight: 600,
};

const linkBtnStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#2A6FB0",
  cursor: "pointer",
  fontSize: 10,
  padding: 0,
  textDecoration: "underline",
};

const codeBlockStyle: React.CSSProperties = {
  marginTop: 6,
  padding: 8,
  backgroundColor: "#1E1E1E",
  color: "#D4D4D4",
  fontFamily: "'Cascadia Code', Consolas, monospace",
  fontSize: 10.5,
  lineHeight: 1.45,
  borderRadius: 4,
  maxHeight: 280,
  overflow: "auto",
  whiteSpace: "pre",
};

const emptyStyle: React.CSSProperties = { padding: "12px 6px", color: "#999" };

// ---- Scheduled jobs ("runs automatically") --------------------------------

const scheduleSectionStyle: React.CSSProperties = {
  margin: "0 4px 10px",
  border: "1px solid #E3D6BE",
  borderRadius: 4,
  backgroundColor: "#FFFBF3",
};

const scheduleHeaderStyle: React.CSSProperties = {
  padding: "5px 8px",
  borderBottom: "1px solid #EFE4D2",
  fontWeight: 600,
  fontSize: 11.5,
  color: "#7A4A00",
};

const scheduleIntroStyle: React.CSSProperties = {
  padding: "6px 8px 0",
  fontSize: 10,
  color: "#8A6A3A",
  lineHeight: 1.4,
};

const scheduleEmptyStyle: React.CSSProperties = {
  padding: "8px",
  fontSize: 10.5,
  color: "#8A7A62",
  lineHeight: 1.4,
};

const jobRowStyle: React.CSSProperties = {
  padding: "6px 8px",
  borderTop: "1px solid #EFE4D2",
};

const jobDisabledRowStyle: React.CSSProperties = { ...jobRowStyle, opacity: 0.62 };

const jobTargetStyle: React.CSSProperties = {
  fontWeight: 600,
  color: "#1A1A1A",
  fontFamily: "'Cascadia Code', Consolas, monospace",
  fontSize: 10.5,
};

const jobMetaStyle: React.CSSProperties = {
  fontSize: 10,
  color: "#777",
  marginTop: 2,
  lineHeight: 1.45,
};

const jobErrorStyle: React.CSSProperties = {
  fontSize: 10,
  color: "#B00020",
  marginTop: 2,
  lineHeight: 1.4,
  wordBreak: "break-word",
};

const cadenceBadge: React.CSSProperties = {
  ...chipStyle,
  backgroundColor: "#F4D6A6",
  color: "#7A4A00",
  fontWeight: 600,
};

const pausedBadge: React.CSSProperties = {
  ...chipStyle,
  backgroundColor: "#E4E4E4",
  color: "#666",
};

const orphanBadge: React.CSSProperties = {
  ...chipStyle,
  backgroundColor: "#F3E2E2",
  color: "#8A3A3A",
};

const dangerLinkBtnStyle: React.CSSProperties = { ...linkBtnStyle, color: "#B00020" };

// ============================================================================
// Scheduled job row — visibility AND control (pause / cancel)
// ============================================================================

function ScheduledJobRow({
  job,
  now,
  onChanged,
}: {
  job: ScheduledJobEntry;
  now: number;
  onChanged: () => void;
}): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await action();
        onChanged();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [onChanged],
  );

  const toggle = useCallback(
    () => void run(() => setScheduledJobEnabled(job.id, !job.enabled)),
    [run, job.id, job.enabled],
  );

  const cancel = useCallback(() => {
    const ok = window.confirm(
      `Stop this scheduled job for good?\n\n${job.target}\n${job.cadence}\nOwner: ${job.ownerName}\n\n` +
        "The schedule is deleted from this workbook. The script can create it again the next time it runs.",
    );
    if (!ok) return;
    void run(() => cancelScheduledJob(job.id));
  }, [run, job.id, job.target, job.cadence, job.ownerName]);

  return (
    <div style={job.enabled ? jobRowStyle : jobDisabledRowStyle} data-scheduled-job-id={job.id}>
      <div style={unitHeaderRowStyle}>
        <span style={jobTargetStyle}>{job.target}</span>
        <span style={{ fontSize: 9.5, color: "#AAA", whiteSpace: "nowrap" }}>
          {job.runCount} run{job.runCount === 1 ? "" : "s"}
        </span>
      </div>

      <div style={jobMetaStyle}>
        Owned by <strong style={{ fontWeight: 600 }}>{job.ownerName}</strong>
        {job.label ? ` — ${job.label}` : ""}
      </div>
      <div style={jobMetaStyle}>
        Last run {describeJobTime(job.lastRunMs, now)} &middot;{" "}
        {job.enabled
          ? `next run ${describeJobTime(job.nextRunMs, now)}`
          : "not scheduled to run again while paused"}
      </div>
      {job.lastRunMs > 0 && !job.lastOk && (
        <div style={jobErrorStyle}>
          Last run failed: {job.lastError ?? "unknown error"}
        </div>
      )}

      <div style={badgeRowStyle}>
        <span style={cadenceBadge}>{job.cadence}</span>
        {!job.enabled && <span style={pausedBadge}>Paused</span>}
        {job.running && (
          <span style={{ ...chipStyle, backgroundColor: "#E6F0E6", color: "#3A6B3A" }}>
            Running now
          </span>
        )}
        {job.ownerProvenance === "distributed" && (
          <span style={pkgBadge} title="The owning code arrived in a distributed package">
            Package: {job.ownerPackage ?? "unknown"}
          </span>
        )}
        {job.ownerMissing && (
          <span
            style={orphanBadge}
            title="No code in this workbook owns this job any more, so it cannot fire — but the schedule is still stored."
          >
            Owner missing
          </span>
        )}
      </div>

      <div style={{ marginTop: 4, display: "flex", gap: 10 }}>
        <button style={linkBtnStyle} onClick={toggle} disabled={busy}>
          {job.enabled ? "Pause" : "Resume"}
        </button>
        <button style={dangerLinkBtnStyle} onClick={cancel} disabled={busy}>
          Cancel job
        </button>
      </div>

      {error && <div style={jobErrorStyle}>{error}</div>}
    </div>
  );
}

// ============================================================================
// Scheduled jobs section
// ============================================================================

function ScheduledJobsSection({
  jobs,
  summary,
  now,
  error,
  onChanged,
}: {
  jobs: ScheduledJobEntry[];
  summary: ScheduledJobSummary;
  now: number;
  error: string | null;
  onChanged: () => void;
}): React.ReactElement {
  return (
    <div style={scheduleSectionStyle}>
      <div style={scheduleHeaderStyle}>
        Runs automatically ({summary.total})
      </div>

      {error && (
        <div style={{ ...scheduleEmptyStyle, color: "#B00020" }}>
          Could not read the schedule: {error}
        </div>
      )}

      {!error && jobs.length === 0 && (
        <div style={scheduleEmptyStyle}>
          No scripts are scheduled to run in this workbook.
        </div>
      )}

      {!error && jobs.length > 0 && (
        <>
          <div style={scheduleIntroStyle}>
            These jobs start themselves while this workbook is open — nobody
            clicks anything. Each one still runs sandboxed, under its script's
            granted capabilities, which are re-checked every time it fires. Pause
            one to stop it for now; cancel to delete the schedule.
          </div>
          {jobs.map((job) => (
            <ScheduledJobRow key={job.id} job={job} now={now} onChanged={onChanged} />
          ))}
        </>
      )}
    </div>
  );
}

// ============================================================================
// Unit row
// ============================================================================

function CodeUnitRow({
  unit,
  scheduledCount,
}: {
  unit: CodeUnit;
  /** How many scheduled jobs this unit owns — so the schedule is visible on the
   *  code itself, not only in the schedule section. */
  scheduledCount: number;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const granted = new Set(unit.liveGrants ?? []);

  const openInEditor = useCallback(() => {
    // The EDIT_SCRIPT handler resolves an existing script by id (object scripts
    // only) and opens it in the code editor without scaffolding.
    emitAppEvent(ScriptableObjectEvents.EDIT_SCRIPT, { scriptId: unit.id });
  }, [unit.id]);

  return (
    <div style={unitStyle}>
      <div style={unitHeaderRowStyle}>
        <span style={unitNameStyle}>{unit.name}</span>
        <span style={{ fontSize: 9.5, color: "#AAA", whiteSpace: "nowrap" }}>
          {unit.lineCount} {unit.lineCount === 1 ? "line" : "lines"}
        </span>
      </div>
      <div style={residenceStyle}>{unit.residence}</div>

      <div style={badgeRowStyle}>
        {unit.provenance === "distributed" ? (
          <span style={pkgBadge} title="Arrived in a distributed package">
            Package: {unit.sourcePackage ?? "unknown"}
          </span>
        ) : (
          <span style={localBadge} title="Authored in this workbook">
            Local
          </span>
        )}
        {unit.tier && (
          <span style={tierBadge} title="Reach tier">
            {unit.tier === "unlocked" ? "Unlocked" : "Restricted"}
          </span>
        )}
        {unit.mounted && (
          <span style={{ ...chipStyle, backgroundColor: "#E6F0E6", color: "#3A6B3A" }}>
            Active
          </span>
        )}
        {scheduledCount > 0 && (
          <span
            style={capGrantedBadge}
            title="This code runs itself on a schedule — see 'Runs automatically' above"
          >
            Scheduled &times;{scheduledCount}
          </span>
        )}

        {/* What it can touch */}
        {unit.declaredCapabilities.length === 0 ? (
          <span style={gridOnlyBadge} title="Sandboxed to grid data only">
            Grid-only
          </span>
        ) : (
          unit.declaredCapabilities.map((c) => {
            const isGranted = granted.has(c);
            return (
              <span
                key={c}
                style={isGranted ? capGrantedBadge : capCeilingBadge}
                title={
                  isGranted
                    ? `${capLabel(c)} — granted now`
                    : `${capLabel(c)} — in the declared ceiling (not currently granted)`
                }
              >
                {capLabel(c)}
                {isGranted ? " *" : ""}
              </span>
            );
          })
        )}
      </div>

      <div style={{ marginTop: 4, display: "flex", gap: 10 }}>
        <button style={linkBtnStyle} onClick={() => setExpanded((e) => !e)}>
          {expanded ? "Hide code" : "View code"}
        </button>
        {unit.surfaceId === "object-script" && (
          <button style={linkBtnStyle} onClick={openInEditor}>
            Open in editor
          </button>
        )}
      </div>

      {expanded && (
        <pre style={codeBlockStyle}>{unit.source || "(no source)"}</pre>
      )}
    </div>
  );
}

// ============================================================================
// Panel section
// ============================================================================

/** How often the open panel re-reads the schedule. Jobs fire on their own, so a
 *  static list would quietly go stale ("next run in 4 minutes" forever); the
 *  read is one backend call over state Rust already holds. */
const JOB_POLL_MS = 15_000;

export function CodeInThisFileSection({ placement }: PanelSectionProps): React.ReactElement {
  const [summary, setSummary] = useState<CodeInventorySummary | null>(null);
  const [jobs, setJobs] = useState<ScheduledJobEntry[]>([]);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Last inventory read, so a schedule refresh can reuse the owner join
   *  instead of rescanning every script on every poll. */
  const unitsRef = useRef<CodeUnit[] | null>(null);

  const reloadJobs = useCallback(async () => {
    try {
      const next = await getWorkbookScheduledJobs(unitsRef.current ?? undefined);
      setJobs(next);
      setNow(Date.now());
      setJobsError(null);
    } catch (e) {
      setJobsError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const units = await getWorkbookCodeUnits();
      unitsRef.current = units;
      setSummary(summarizeCodeInventory(units));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
    await reloadJobs();
  }, [reloadJobs]);

  useEffect(() => {
    void reload();
    // The set of scripts changes when a workbook loads or scripts are
    // (un)registered; SCRIPTS_LOADED is emitted on the app-event bus after each
    // (re)load. onAppEvent returns its own unsubscribe.
    const off = onAppEvent(ScriptableObjectEvents.SCRIPTS_LOADED, () => void reload());
    return off;
  }, [reload]);

  useEffect(() => {
    const timer = setInterval(() => void reloadJobs(), JOB_POLL_MS);
    return () => clearInterval(timer);
  }, [reloadJobs]);

  const jobSummary = summarizeScheduledJobs(jobs);
  const jobsByScriptId = new Map<string, number>();
  for (const job of jobs) {
    jobsByScriptId.set(job.scriptId, (jobsByScriptId.get(job.scriptId) ?? 0) + 1);
  }

  return (
    <div style={rootStyle(placement)}>
      <div style={introStyle}>
        Every piece of code that lives in this workbook — where it resides, where
        it came from, and what it is allowed to touch. Nothing here is hidden
        inside the file.
      </div>

      {summary && (
        <>
          <div style={summaryRowStyle}>
            <span style={chipStyle}>{summary.total} code units</span>
            <span style={chipStyle}>{summary.local} local</span>
            <span style={chipStyle}>{summary.distributed} from packages</span>
            {summary.mounted > 0 && <span style={chipStyle}>{summary.mounted} active</span>}
            {summary.beyondGrid > 0 && (
              <span style={warnChipStyle}>{summary.beyondGrid} reach beyond the grid</span>
            )}
            {jobSummary.total > 0 && (
              <span style={warnChipStyle}>
                {jobSummary.total} scheduled
                {jobSummary.disabled > 0 ? ` (${jobSummary.disabled} paused)` : ""}
              </span>
            )}
          </div>
          {summary.beyondGrid > 0 && (
            <div style={reachCalloutStyle}>
              {summary.beyondGrid} script{summary.beyondGrid === 1 ? "" : "s"} may reach
              outside the grid (network, BI, storage, or host HTML) up to their declared
              ceiling. Every other unit is sandboxed to grid data only.
            </div>
          )}
        </>
      )}

      {/* The schedule comes FIRST: it is the only code here that runs without
          the user doing anything, so it is the thing they most need to see. */}
      <ScheduledJobsSection
        jobs={jobs}
        summary={jobSummary}
        now={now}
        error={jobsError}
        onChanged={() => void reloadJobs()}
      />

      <div style={{ padding: "0 4px 6px" }}>
        <button style={linkBtnStyle} onClick={() => void reload()} disabled={loading}>
          {loading ? "Scanning..." : "Refresh"}
        </button>
      </div>

      {error && (
        <div style={{ ...emptyStyle, color: "#B00020" }}>
          Could not read the code inventory: {error}
        </div>
      )}

      {!error && summary && summary.total === 0 && (
        <div style={emptyStyle}>This workbook contains no code.</div>
      )}

      {!error &&
        summary &&
        summary.bySurface.map((group) => {
          const surface = getScriptSurface(group.surfaceId);
          return (
            <div key={group.surfaceId}>
              <div style={groupHeaderStyle}>
                <div style={groupTitleStyle}>
                  {surface?.label ?? group.surfaceId} ({group.units.length})
                </div>
                {surface && (
                  <div style={groupContainmentStyle}>{surface.containment}</div>
                )}
              </div>
              {group.units.map((u) => (
                <CodeUnitRow
                  key={`${u.surfaceId}:${u.id}`}
                  unit={u}
                  scheduledCount={jobsByScriptId.get(u.id) ?? 0}
                />
              ))}
            </div>
          );
        })}
    </div>
  );
}
