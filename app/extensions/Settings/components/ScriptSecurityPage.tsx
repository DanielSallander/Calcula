//! FILENAME: app/extensions/Settings/components/ScriptSecurityPage.tsx
// PURPOSE: The Script Security settings page — the level picker
//          (disabled / ask / enabled) with honest descriptions, plus the
//          transparency + revoke surface for persistent per-workbook trust and
//          persisted notebook capability grants.
// CONTEXT: Extension UI — imports ONLY from @api (facade rule). Every script
//          prompt in the app tells the user to "change it in Settings > Script
//          Security"; before this page existed, that instruction pointed at
//          nothing, and the only escape from per-session re-prompting was to
//          flip the global setting to "enabled" — which defeats the whole tier
//          model. This page is that missing destination AND the place where the
//          user can see and undo every trust decision they have made.
//
//          What is deliberately NOT here: consent for code that arrived in a
//          .calp package. That consent is stored INSIDE the workbook (it must
//          survive a copy) and is managed per package; workbook trust never
//          covers it. See @api/distributedConsent.
//
//          Scheduled jobs (the `schedule` capability) are SHOWN here but not
//          managed here, and that split is deliberate: everything else on this
//          page is machine-scoped state stored on this computer, while a
//          schedule lives inside the workbook. Duplicating the management UI
//          would give the user two places to disagree about one workbook, so
//          this section reports what is armed and links to the per-workbook
//          "Code in This File" panel, which owns pause/cancel.

import React, { useCallback, useEffect, useState } from "react";
import {
  SCRIPT_SECURITY_LEVELS,
  SCRIPT_SECURITY_LEVEL_INFO,
  SCRIPT_TRUST_CHANGED,
  getScriptSecurityLevel,
  setScriptSecurityLevel,
  listWorkbookTrust,
  revokeWorkbookRunTrust,
  revokeWorkbookTrustEntirely,
  revokeNotebookCapabilityGrants,
  revokeAllWorkbookTrust,
  currentWorkbookTrustKey,
  type ScriptSecurityLevel,
  type WorkbookTrustRecord,
} from "@api/scriptSecurity";
import { onAppEvent } from "@api/events";
import {
  getWorkbookScheduledJobs,
  describeJobTime,
  type ScheduledJobEntry,
} from "@api/codeInventory";
import { openPanel } from "@api/ui";
import type { CapabilityId } from "@api";

// ============================================================================
// Helpers
// ============================================================================

/** Short, human capability labels. Kept local (and small) on purpose: this page
 *  must never imply that a listed capability is GRANTED — these are the
 *  capabilities the trusted code DECLARES, i.e. the most it could ever ask for.
 *
 *  Typed `Record<CapabilityId, string>`, NOT `Record<string, string>`: every
 *  other consent/label map in the app carries that type so a new capability
 *  fails the build until it is phrased for the user, and this one silently did
 *  not — it would have degraded to the raw id ("distribution.writeback") in a
 *  security page, which is exactly the drift this program shipped twice. */
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

/** Label for a capability id that arrives as an untrusted string (a persisted
 *  trust record can name an id this build no longer knows). Unknown ids show
 *  raw rather than being hidden. */
const capLabel = (id: string): string => CAP_LABEL[id as CapabilityId] ?? id;

function formatWhen(iso: string): string {
  if (!iso) return "unknown";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "unknown" : d.toLocaleString();
}

/** Show the file name prominently and the folder quietly. */
function splitPath(displayPath: string): { name: string; folder: string } {
  const normalized = displayPath.replace(/\\/g, "/");
  const cut = normalized.lastIndexOf("/");
  return cut < 0
    ? { name: normalized, folder: "" }
    : { name: normalized.slice(cut + 1), folder: normalized.slice(0, cut) };
}

// ============================================================================
// Styles (match the other Settings pages)
// ============================================================================

const styles: Record<string, React.CSSProperties> = {
  content: { flex: 1, overflow: "auto", padding: "14px 16px" },
  section: { marginBottom: 24 },
  sectionTitle: {
    fontSize: 11,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "var(--text-secondary)",
    marginBottom: 12,
    paddingBottom: 6,
    borderBottom: "1px solid var(--border-default)",
  },
  intro: {
    fontSize: 11,
    color: "var(--text-tertiary)",
    lineHeight: 1.5,
    marginBottom: 14,
  },
  levelOption: {
    display: "flex",
    gap: 8,
    padding: "8px 10px",
    borderRadius: 4,
    border: "1px solid var(--border-default)",
    marginBottom: 8,
    cursor: "pointer",
    alignItems: "flex-start",
    backgroundColor: "var(--bg-surface)",
  },
  levelOptionActive: {
    borderColor: "var(--accent-primary)",
    boxShadow: "0 0 0 1px var(--accent-primary) inset",
  },
  levelLabel: { fontSize: 12, fontWeight: 600, color: "var(--text-primary)" },
  levelSummary: { fontSize: 11, color: "var(--text-secondary)", marginTop: 2 },
  levelDetail: { fontSize: 11, color: "var(--text-tertiary)", marginTop: 6, lineHeight: 1.5 },
  radioInput: { marginTop: 3, accentColor: "var(--accent-primary)", cursor: "pointer" },
  card: {
    border: "1px solid var(--border-default)",
    borderRadius: 4,
    padding: "10px 12px",
    marginBottom: 8,
    backgroundColor: "var(--bg-surface)",
  },
  cardHeader: { display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" },
  wbName: { fontSize: 12, fontWeight: 600, color: "var(--text-primary)", wordBreak: "break-all" },
  wbFolder: { fontSize: 10, color: "var(--text-tertiary)", wordBreak: "break-all" },
  meta: { fontSize: 11, color: "var(--text-secondary)", marginTop: 6, lineHeight: 1.5 },
  chipRow: { display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 },
  chip: {
    fontSize: 10,
    padding: "1px 6px",
    borderRadius: 3,
    backgroundColor: "var(--bg-subtle, #EEF1F4)",
    color: "var(--text-secondary)",
    whiteSpace: "nowrap",
  },
  button: {
    fontSize: 11,
    padding: "3px 10px",
    borderRadius: 3,
    border: "1px solid var(--border-default)",
    backgroundColor: "transparent",
    color: "var(--text-primary)",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  dangerButton: {
    fontSize: 11,
    padding: "3px 10px",
    borderRadius: 3,
    border: "1px solid var(--border-default)",
    backgroundColor: "transparent",
    color: "var(--text-danger, #B3261E)",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  empty: {
    fontSize: 11,
    color: "var(--text-tertiary)",
    fontStyle: "italic",
    padding: "8px 2px",
    lineHeight: 1.5,
  },
  currentBadge: {
    fontSize: 9,
    fontWeight: 600,
    padding: "1px 5px",
    borderRadius: 3,
    backgroundColor: "var(--accent-primary)",
    color: "#fff",
    marginLeft: 6,
    verticalAlign: "middle",
  },
  jobRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 8,
    fontSize: 11,
    color: "var(--text-primary)",
    padding: "6px 0",
    borderTop: "1px solid var(--border-default)",
    lineHeight: 1.5,
  },
  notebookRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
    fontSize: 11,
    padding: "4px 0",
    borderTop: "1px solid var(--border-default)",
  },
};

// ============================================================================
// Page
// ============================================================================

/** The "Code in This File" panel registered by the ScriptableObjects extension.
 *  Referenced by id, never imported: extensions must not reach into a sibling's
 *  internals (Facade Rule), and openPanel takes a plain id. */
const CODE_IN_THIS_FILE_PANEL_ID = "scriptable-objects.codeInThisFile";

/** How often the open page re-reads the schedule, so a count that says "2 jobs"
 *  is still true a minute later. */
const JOB_POLL_MS = 15_000;

export function ScriptSecurityPage(): React.ReactElement {
  const [level, setLevel] = useState<ScriptSecurityLevel | null>(null);
  const [records, setRecords] = useState<WorkbookTrustRecord[]>(() => listWorkbookTrust());
  const [currentKey, setCurrentKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<ScheduledJobEntry[]>([]);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(() => {
    setRecords(listWorkbookTrust());
  }, []);

  useEffect(() => {
    let cancelled = false;
    getScriptSecurityLevel()
      .then((l) => {
        if (!cancelled) setLevel(l);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    currentWorkbookTrustKey()
      .then((id) => {
        if (!cancelled) setCurrentKey(id?.key ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => onAppEvent(SCRIPT_TRUST_CHANGED, refresh), [refresh]);

  // The schedule of the OPEN workbook. Read-only here (see the header note);
  // a failure is swallowed to [] rather than breaking the security page.
  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      getWorkbookScheduledJobs()
        .then((next) => {
          if (cancelled) return;
          setJobs(next);
          setNow(Date.now());
        })
        .catch(() => undefined);
    };
    load();
    const timer = setInterval(load, JOB_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const chooseLevel = useCallback((next: ScriptSecurityLevel) => {
    setLevel(next);
    setError(null);
    setScriptSecurityLevel(next).catch((e) => setError(String(e)));
  }, []);

  const trusted = records.filter((r) => r.runTrust !== null);
  const withNotebookGrants = records.filter((r) => r.notebookGrants.length > 0);

  return (
    <div style={styles.content}>
      {error && (
        <div style={{ ...styles.intro, color: "var(--text-danger, #B3261E)" }}>{error}</div>
      )}

      {/* ---------------------------------------------------------------- */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Script Security</div>
        <div style={styles.intro}>
          Controls whether user-authored code — object scripts, chart marks and
          transforms, worksheet-function libraries, notebooks, one-off scripts,
          AI tool calls and installed extensions — is allowed to run. Code always
          runs sandboxed; this setting decides whether it runs at all.
        </div>
        {SCRIPT_SECURITY_LEVELS.map((id) => {
          const info = SCRIPT_SECURITY_LEVEL_INFO[id];
          const active = level === id;
          return (
            <label
              key={id}
              style={active ? { ...styles.levelOption, ...styles.levelOptionActive } : styles.levelOption}
            >
              <input
                type="radio"
                name="scriptSecurityLevel"
                value={id}
                checked={active}
                onChange={() => chooseLevel(id)}
                style={styles.radioInput}
              />
              <span>
                <div style={styles.levelLabel}>{info.label}</div>
                <div style={styles.levelSummary}>{info.summary}</div>
                {active && <div style={styles.levelDetail}>{info.detail}</div>}
              </span>
            </label>
          );
        })}
      </div>

      {/* ---------------------------------------------------------------- */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Scheduled Jobs</div>
        <div style={styles.intro}>
          Code in the open workbook that runs on a timer, without you starting
          it. Every firing re-checks the script's capabilities, and nothing runs
          while Calcula is closed. The schedule is stored in the workbook, so it
          is reviewed and stopped there: open <strong>Code in This File</strong>{" "}
          to pause or cancel a job.
        </div>
        {jobs.length === 0 ? (
          <div style={styles.empty}>
            No scripts are scheduled to run in this workbook.
          </div>
        ) : (
          <>
            {jobs.map((job) => (
              <div key={job.id} style={styles.jobRow}>
                <span>
                  <strong style={{ fontWeight: 600 }}>{job.ownerName}</strong>
                  <span style={{ color: "var(--text-tertiary)" }}> &middot; {job.target}</span>
                  <div style={{ color: "var(--text-secondary)", marginTop: 2 }}>
                    {job.cadence}
                    {job.enabled
                      ? ` · next run ${describeJobTime(job.nextRunMs, now)}`
                      : " · paused"}
                    {job.ownerMissing ? " · owner missing" : ""}
                  </div>
                </span>
              </div>
            ))}
          </>
        )}
        <button
          type="button"
          style={{ ...styles.button, marginTop: 10 }}
          onClick={() => openPanel(CODE_IN_THIS_FILE_PANEL_ID)}
        >
          Review scheduled jobs
        </button>
      </div>

      {/* ---------------------------------------------------------------- */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Trusted Workbooks</div>
        <div style={styles.intro}>
          Workbooks whose OWN scripts you allowed to run without asking again.
          Trust is stored on this computer only — it is never written into the
          file, so a copy you send to someone else is not trusted. It lapses
          automatically if the code changes, and it grants no capabilities:
          network access, BI queries and package writeback are always asked for
          separately.
        </div>
        {trusted.length === 0 && (
          <div style={styles.empty}>
            No workbook is trusted. When a workbook asks to run its scripts, you
            can choose to trust it there.
          </div>
        )}
        {trusted.map((record) => {
          const { name, folder } = splitPath(record.displayPath);
          const runTrust = record.runTrust!;
          return (
            <div key={record.workbookKey} style={styles.card}>
              <div style={styles.cardHeader}>
                <div>
                  <div style={styles.wbName}>
                    {name}
                    {record.workbookKey === currentKey && (
                      <span style={styles.currentBadge}>OPEN</span>
                    )}
                  </div>
                  {folder && <div style={styles.wbFolder}>{folder}</div>}
                </div>
                <button
                  type="button"
                  style={styles.dangerButton}
                  onClick={() => {
                    revokeWorkbookRunTrust(record.workbookKey);
                    refresh();
                  }}
                >
                  Revoke trust
                </button>
              </div>
              <div style={styles.meta}>
                Trusted {formatWhen(runTrust.trustedAt)} &middot;{" "}
                {runTrust.scripts.length} script
                {runTrust.scripts.length === 1 ? "" : "s"} covered
              </div>
              {runTrust.declaredCapabilities.length > 0 ? (
                <>
                  <div style={styles.meta}>
                    This code declares (but is NOT granted) the capabilities below.
                    If it ever declares another one, trust lapses and you are asked
                    again.
                  </div>
                  <div style={styles.chipRow}>
                    {runTrust.declaredCapabilities.map((c) => (
                      <span key={c} style={styles.chip}>
                        {capLabel(c)}
                      </span>
                    ))}
                  </div>
                </>
              ) : (
                <div style={styles.meta}>
                  This code declares no capabilities — grid access only.
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ---------------------------------------------------------------- */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Notebook Capability Grants</div>
        <div style={styles.intro}>
          Capabilities you approved for a specific notebook, remembered so that
          re-running it does not ask again. Revoking takes effect immediately —
          the running notebook loses the capability, not just the next launch.
        </div>
        {withNotebookGrants.length === 0 && (
          <div style={styles.empty}>No notebook capability grants are remembered.</div>
        )}
        {withNotebookGrants.map((record) => {
          const { name, folder } = splitPath(record.displayPath);
          return (
            <div key={record.workbookKey} style={styles.card}>
              <div style={styles.cardHeader}>
                <div>
                  <div style={styles.wbName}>
                    {name}
                    {record.workbookKey === currentKey && (
                      <span style={styles.currentBadge}>OPEN</span>
                    )}
                  </div>
                  {folder && <div style={styles.wbFolder}>{folder}</div>}
                </div>
                <button
                  type="button"
                  style={styles.dangerButton}
                  onClick={() => {
                    revokeWorkbookTrustEntirely(record.workbookKey);
                    refresh();
                  }}
                >
                  Forget workbook
                </button>
              </div>
              {record.notebookGrants.map((grant) => (
                <div key={grant.notebookId} style={styles.notebookRow}>
                  <span>
                    <strong style={{ fontWeight: 600 }}>{grant.notebookId}</strong>
                    <span style={{ color: "var(--text-tertiary)" }}>
                      {" "}
                      &middot; {formatWhen(grant.grantedAt)}
                    </span>
                    <span style={styles.chipRow}>
                      {grant.capabilities.map((c) => (
                        <span key={c} style={styles.chip}>
                          {capLabel(c)}
                        </span>
                      ))}
                    </span>
                  </span>
                  <button
                    type="button"
                    style={styles.button}
                    onClick={() => {
                      void revokeNotebookCapabilityGrants(record.workbookKey, grant.notebookId).then(
                        refresh,
                      );
                    }}
                  >
                    Revoke
                  </button>
                </div>
              ))}
            </div>
          );
        })}
      </div>

      {/* ---------------------------------------------------------------- */}
      {records.length > 0 && (
        <div style={styles.section}>
          <button
            type="button"
            style={styles.dangerButton}
            onClick={() => {
              if (
                window.confirm(
                  "Forget every trusted workbook and every remembered notebook capability grant?\n\n" +
                    "You will be asked again the next time any workbook wants to run its scripts.",
                )
              ) {
                revokeAllWorkbookTrust();
                refresh();
              }
            }}
          >
            Clear all trust decisions
          </button>
          <div style={{ ...styles.intro, marginTop: 8, marginBottom: 0 }}>
            Consent for code that arrived in a .calp package is separate: it is
            stored inside the workbook (so it survives a copy) and is managed per
            package, not here.
          </div>
        </div>
      )}
    </div>
  );
}
