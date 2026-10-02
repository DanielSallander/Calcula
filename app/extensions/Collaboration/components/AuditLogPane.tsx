// FILENAME: app/extensions/Collaboration/components/AuditLogPane.tsx
// PURPOSE: Audit log viewer (T5) — a chronological, filterable view of every
//          collaboration action recorded in this workbook (subscribe / refresh /
//          override / writeback / publish), plus enable/disable + clear.
// CONTEXT: The audit BACKEND already records these events and the @api bindings
//          (getAuditLog / setAuditEnabled / clearAuditLog) exist; the design-gap
//          was that nothing surfaced them ("review it via the API"). This is the
//          transparency pillar's audit-trail UI, paired with the Code-in-This-File
//          inspector.

import React, { useState, useEffect, useCallback } from "react";
import { onAppEvent, AppEvents } from "@api";
import {
  getAuditLog,
  setAuditEnabled,
  clearAuditLog,
  type AuditLog,
  type AuditEntry,
} from "@api/collaboration";
import { confirmAsync } from "@api/dialogs";

type Category = "subscription" | "override" | "writeback" | "publish" | "script" | "capability" | "protection" | "ai" | "other";

/** Event id (snake_case, mirrors Rust AuditEvent) -> label + category. */
const EVENT_META: Record<string, { label: string; category: Category }> = {
  subscribe: { label: "Subscribed", category: "subscription" },
  refresh: { label: "Refreshed", category: "subscription" },
  detach: { label: "Detached", category: "subscription" },
  subscription_environment_changed: {
    label: "Environment changed",
    category: "subscription",
  },
  override_created: { label: "Override created", category: "override" },
  override_reverted: { label: "Override reverted", category: "override" },
  conflict_resolved: { label: "Conflict resolved", category: "override" },
  override_exported: { label: "Overrides exported", category: "override" },
  override_imported: { label: "Overrides imported", category: "override" },
  writeback_submitted: { label: "Writeback submitted", category: "writeback" },
  writeback_invalidated: { label: "Writeback invalidated", category: "writeback" },
  writeback_reviewed: { label: "Writeback reviewed", category: "writeback" },
  published: { label: "Published", category: "publish" },
  checked_out: { label: "Opened for editing", category: "publish" },
  // Always recorded: the refusal names ids somebody else shipped, and a
  // colleague's module id that blocks every developer who owns the same one is
  // only visible if the refusals are kept (BUG-0264; the ids are in `extra`).
  checkout_refused: { label: "Checkout refused", category: "publish" },
  // Always recorded (the BUG-0257 guardrail: every refusal of application code
  // leaves a trail). A version refused for WHO SIGNED IT -- at checkout, the
  // push merge or the hold-back -- names the signer and key fingerprint.
  signer_refused: { label: "Signer refused", category: "publish" },
  // A push refused over held or unacknowledged button code, and a click on a
  // button cell whose action is not its application's to run.
  button_code_refused: { label: "Button code refused", category: "script" },
  // Always recorded: this computer was told to forget who created an
  // application it develops (the developer anchor) -- the one guard a
  // share-writer cannot forge, dropped on purpose.
  developer_anchor_forgotten: { label: "Remembered creator forgotten", category: "publish" },
  // Always recorded (phase 3 of BUG-0257): an application's macro ran, or was
  // refused before it ran (not approved, the developer's own sheets beside a
  // working copy, a button the store does not back). `extra` names the
  // application, the macro and -- when a button asked -- the button.
  application_code_run: { label: "Application code ran", category: "script" },
  application_code_refused: { label: "Application code refused", category: "script" },
  // Always recorded (phase 4): "Make this my own" moved an application's button
  // code into the user's own slots, where it runs with no approval.
  button_code_adopted: { label: "Button code made your own", category: "script" },
  // Sandboxed script grid mutations (run_script / notebook / MCP) — always
  // recorded (unified Rust-QuickJS audit trail), so scripts are never invisible.
  script_executed: { label: "Script ran", category: "script" },
  // Broker-mediated capability use (net.fetch / bi.query / bi.sql / storage / …),
  // success or denial — always recorded; the capability + outcome are in `extra`.
  capability_call: { label: "Capability call", category: "capability" },
  // Sheet/workbook protection turned on, off, or reconfigured — always
  // recorded. A security boundary moving is exactly what a user needs to be
  // able to find later.
  protection_changed: { label: "Protection changed", category: "protection" },
  // A model proposed it and the user accepted it. Always recorded, because the
  // question "who wrote this formula" is asked long after the fact and usually
  // in a workbook that never turned collaboration auditing on. `extra` says
  // whether the engine verified the result before it was offered.
  ai_assisted_edit: { label: "AI-assisted edit", category: "ai" },
};

const CATEGORY_COLOR: Record<Category, { bg: string; fg: string }> = {
  subscription: { bg: "#e8f0fe", fg: "#1967d2" },
  override: { bg: "#fef7e0", fg: "#b06000" },
  writeback: { bg: "#e6f4ea", fg: "#137333" },
  publish: { bg: "#f3e8fd", fg: "#8430ce" },
  protection: { bg: "#fce8e6", fg: "#c5221f" },
  script: { bg: "#fce8e6", fg: "#c5221f" },
  capability: { bg: "#e8eaed", fg: "#3c4043" },
  ai: { bg: "#e0f2f1", fg: "#00695c" },
  other: { bg: "#f1f3f4", fg: "#5f6368" },
};

const FILTERS: { id: Category | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "subscription", label: "Subscriptions" },
  { id: "override", label: "Overrides" },
  { id: "writeback", label: "Writeback" },
  { id: "publish", label: "Publishing" },
  { id: "script", label: "Scripts" },
  { id: "capability", label: "Capabilities" },
  { id: "ai", label: "AI" },
];

const DEFAULT_MAX_ENTRIES = 1000;

function eventMeta(event: string): { label: string; category: Category } {
  return EVENT_META[event] ?? { label: event, category: "other" };
}

/** Format an ISO timestamp for display; fall back to the raw string. */
function fmtTime(ts: string): string {
  const d = new Date(ts);
  return isNaN(d.getTime()) ? ts : d.toLocaleString();
}

// --- styles (match the other Collaboration panes) ---------------------------
const root: React.CSSProperties = {
  fontFamily: "'Segoe UI', Tahoma, sans-serif",
  fontSize: 12,
  color: "#333",
  padding: 8,
  display: "flex",
  flexDirection: "column",
  height: "100%",
};
const intro: React.CSSProperties = { color: "#666", lineHeight: 1.4, marginBottom: 8 };
const toolbar: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8, alignItems: "center" };
const chip = (active: boolean): React.CSSProperties => ({
  fontSize: 11,
  padding: "2px 8px",
  borderRadius: 12,
  cursor: "pointer",
  border: "1px solid",
  borderColor: active ? "#1967d2" : "#dadce0",
  backgroundColor: active ? "#e8f0fe" : "#fff",
  color: active ? "#1967d2" : "#5f6368",
});
const linkBtn: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#1967d2",
  cursor: "pointer",
  fontSize: 11,
  padding: 0,
  textDecoration: "underline",
};
const entryRow: React.CSSProperties = { padding: "6px 4px", borderBottom: "1px solid #f0f0f0" };
const entryTop: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, justifyContent: "space-between" };
const eventBadge = (cat: Category): React.CSSProperties => ({
  fontSize: 10,
  fontWeight: 600,
  padding: "1px 6px",
  borderRadius: 3,
  whiteSpace: "nowrap",
  backgroundColor: CATEGORY_COLOR[cat].bg,
  color: CATEGORY_COLOR[cat].fg,
});
const empty: React.CSSProperties = { padding: "16px 4px", color: "#999", textAlign: "center" };

export function AuditLogPane(): React.ReactElement {
  const [log, setLog] = useState<AuditLog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Category | "all">("all");
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setLog(await getAuditLog());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    const off = onAppEvent(AppEvents.SHEET_CHANGED, () => void reload());
    return off;
  }, [reload]);

  const enable = useCallback(async () => {
    setBusy(true);
    try {
      await setAuditEnabled(true, DEFAULT_MAX_ENTRIES);
      await reload();
    } finally {
      setBusy(false);
    }
  }, [reload]);

  const disable = useCallback(async () => {
    setBusy(true);
    try {
      await setAuditEnabled(false, log?.maxEntries ?? DEFAULT_MAX_ENTRIES);
      await reload();
    } finally {
      setBusy(false);
    }
  }, [reload, log]);

  const clear = useCallback(async () => {
    // AWAITED. This wipes the workbook's whole transparency record — the
    // always-on script + capability entries the audit trail exists to keep.
    // With the guard dead, Cancel cleared it just as OK did, irreversibly.
    if (
      !(await confirmAsync(
        "Discard ALL audit entries, including the always-on script and capability records? This cannot be undone.",
        { title: "Clear audit log", kind: "warning" },
      ))
    )
      return;
    setBusy(true);
    try {
      await clearAuditLog();
      await reload();
    } finally {
      setBusy(false);
    }
  }, [reload]);

  if (error) {
    return (
      <div style={root}>
        <div style={{ ...empty, color: "#c5221f" }}>Could not read the audit log: {error}</div>
        <button style={linkBtn} onClick={() => void reload()}>Retry</button>
      </div>
    );
  }

  if (loading && !log) {
    return <div style={root}><div style={empty}>Loading audit log...</div></div>;
  }

  const entries: AuditEntry[] = log?.entries ?? [];
  // Newest first; apply the category filter.
  const shown = entries
    .slice()
    .reverse()
    .filter((e) => filter === "all" || eventMeta(e.event).category === filter);

  return (
    <div style={root}>
      <div style={intro}>
        Script grid-mutations, capability use, writeback (submit, review, invalidation),
        publishing, protection changes and AI-assisted edits are <b>always</b> recorded here.
        Subscribe, refresh and override events are recorded only while audit logging is
        enabled. Newest first.
      </div>
      {log && !log.enabled && (
        <div style={{ ...empty, color: "#9a6700", textAlign: "left", padding: "6px 8px", marginBottom: 4 }}>
          Collaboration logging is <b>off</b> — subscribe, refresh and override events are not
          being recorded. Everything listed as always recorded above still is.
        </div>
      )}

      <div style={toolbar}>
        {FILTERS.map((f) => (
          <span key={f.id} style={chip(filter === f.id)} onClick={() => setFilter(f.id)}>
            {f.label}
          </span>
        ))}
        <span style={{ flex: 1 }} />
        <button style={linkBtn} onClick={() => void reload()} disabled={loading}>
          {loading ? "..." : "Refresh"}
        </button>
        {log?.enabled ? (
          <button style={linkBtn} onClick={() => void disable()} disabled={busy}>Turn off</button>
        ) : (
          <button style={linkBtn} onClick={() => void enable()} disabled={busy}>
            {busy ? "..." : "Enable"}
          </button>
        )}
        <button style={{ ...linkBtn, color: "#c5221f" }} onClick={() => void clear()} disabled={busy || entries.length === 0}>
          Clear
        </button>
      </div>

      <div style={{ color: "#999", fontSize: 11, marginBottom: 4 }}>
        {shown.length} of {entries.length} event{entries.length === 1 ? "" : "s"}
        {log && log.maxEntries > 0 ? ` (keeping the most recent ${log.maxEntries})` : ""}
      </div>

      <div style={{ flex: 1, overflowY: "auto" }}>
        {shown.length === 0 ? (
          <div style={empty}>
            {entries.length === 0
              ? (log?.enabled ? "No actions recorded yet." : "No script or capability activity recorded yet.")
              : "No events match this filter."}
          </div>
        ) : (
          shown.map((e, i) => {
            const meta = eventMeta(e.event);
            return (
              <div key={`${e.timestamp}-${i}`} style={entryRow}>
                <div style={entryTop}>
                  <span style={eventBadge(meta.category)}>{meta.label}</span>
                  <span style={{ fontSize: 10, color: "#999", whiteSpace: "nowrap" }}>
                    {fmtTime(e.timestamp)}
                  </span>
                </div>
                <div style={{ marginTop: 2, color: "#444" }}>{e.description}</div>
                {e.user && (
                  <div style={{ marginTop: 1, fontSize: 10, color: "#999" }}>by {e.user}</div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
