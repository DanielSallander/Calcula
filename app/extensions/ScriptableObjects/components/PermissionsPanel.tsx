//! FILENAME: app/extensions/ScriptableObjects/components/PermissionsPanel.tsx
// PURPOSE: Script transparency panel (design §8) — three sections: mounted
//          scripts (who is running, where, with what reach), the tier/method
//          policy table rendered directly from ALLOWLIST (the object the
//          broker executes — no hardcoded copy), and the broker audit tail.
// CONTEXT: Registered via the sections-based panel API in ../index.ts.
//          The vision's "user always knows where code resides and what it
//          can touch," made literal.

import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  ALLOWLIST,
  SCRIPT_SUBSCRIBABLE_APP_EVENTS,
  getAuditTail,
  getAuditTotal,
  onAudit,
  listMountedHandles,
  listExposed,
  ObjectScriptManager,
  getGrantedOrigins,
  revokeCapability,
} from "@api";
import type { AuditEntry, ScriptHandle, MethodPolicy, CapabilityId } from "@api";
import type { PanelSectionProps } from "@api/uiTypes";
import { emitAppEvent } from "@api/events";
import { ScriptableObjectEvents } from "../index";

// ============================================================================
// Constants
// ============================================================================

/** How many audit entries the Activity section shows (newest first). */
const ACTIVITY_LIMIT = 200;
/** Re-render throttle for the live audit stream. */
const ACTIVITY_THROTTLE_MS = 250;

// ============================================================================
// Styles (matches ObjectScriptManagerPane / ScriptConsentDialog conventions)
// ============================================================================

const sectionStyle = (placement: "sidebar" | "ribbon"): React.CSSProperties => ({
  fontFamily: "'Segoe UI', Tahoma, sans-serif",
  fontSize: 11,
  color: "#333",
  ...(placement === "ribbon"
    ? { width: 360, height: "100%", overflowY: "auto" }
    : {}),
});

const emptyStyle: React.CSSProperties = {
  padding: "10px 4px",
  color: "#999",
  fontSize: 11,
};

const tagStyle: React.CSSProperties = {
  fontSize: 9,
  padding: "1px 5px",
  borderRadius: 3,
  backgroundColor: "#E8E8E8",
  color: "#666",
  whiteSpace: "nowrap",
};

/** Restricted = own-object reach only (calm gray). */
const restrictedTagStyle: React.CSSProperties = {
  ...tagStyle,
  backgroundColor: "#E8E8E8",
  color: "#555",
};

/** Unlocked = whole-workbook reach (amber, worth noticing). */
const unlockedTagStyle: React.CSSProperties = {
  ...tagStyle,
  backgroundColor: "#FFF4CE",
  color: "#8A6914",
};

const localTagStyle: React.CSSProperties = {
  ...tagStyle,
  backgroundColor: "#DFF6DD",
  color: "#107C10",
};

const packageTagStyle: React.CSSProperties = {
  ...tagStyle,
  backgroundColor: "#E5F1FB",
  color: "#0B5394",
};

const capTagStyle: React.CSSProperties = {
  ...tagStyle,
  backgroundColor: "#EFE6FA",
  color: "#5B2D90",
  fontFamily: "'Cascadia Code', Consolas, monospace",
};

const monoStyle: React.CSSProperties = {
  fontFamily: "'Cascadia Code', Consolas, monospace",
  fontSize: 10,
};

const btnSmallStyle: React.CSSProperties = {
  padding: "2px 8px",
  fontSize: 10,
  border: "1px solid #CCC",
  borderRadius: 2,
  backgroundColor: "#FFF",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

/** The small "x" that revokes a single capability grant. */
const revokeBtnStyle: React.CSSProperties = {
  marginLeft: 2,
  border: "none",
  background: "transparent",
  color: "#C0392B",
  cursor: "pointer",
  fontSize: 12,
  lineHeight: 1,
  padding: "0 2px",
};

const cardStyle: React.CSSProperties = {
  padding: "6px 4px",
  borderBottom: "1px solid #F0F0F0",
};

const detailLineStyle: React.CSSProperties = {
  marginTop: 2,
  color: "#666",
  fontSize: 10,
};

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 10,
};

const groupHeaderCellStyle: React.CSSProperties = {
  padding: "8px 2px 3px",
  fontSize: 10,
  fontWeight: 600,
  color: "#666",
  textTransform: "uppercase",
  letterSpacing: 0.5,
  textAlign: "left",
};

const cellStyle: React.CSSProperties = {
  padding: "2px 4px 2px 2px",
  borderBottom: "1px solid #F0F0F0",
  verticalAlign: "top",
};

const classCellStyle: React.CSSProperties = {
  ...cellStyle,
  color: "#888",
  whiteSpace: "nowrap",
  width: 1, // shrink to content
};

const descCellStyle: React.CSSProperties = {
  ...cellStyle,
  color: "#555",
};

// ============================================================================
// Helpers
// ============================================================================

function formatTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

// ============================================================================
// Section 1: Mounted scripts
// ============================================================================

interface ExposedMethodInfo {
  objectType: string;
  instanceId: string | null;
  methodName: string;
  ownerScriptId: string;
  isPublic: boolean;
}

export function MountedScriptsSection({ placement }: PanelSectionProps): React.ReactElement {
  const [handles, setHandles] = useState<ScriptHandle[]>(() => listMountedHandles());
  const [exposed, setExposed] = useState<ExposedMethodInfo[]>(() => listExposed());

  const refresh = useCallback(() => {
    setHandles(listMountedHandles());
    setExposed(listExposed());
  }, []);

  useEffect(() => {
    refresh();
    return ObjectScriptManager.onScriptChange(refresh);
  }, [refresh]);

  const handleInspect = useCallback((scriptId: string) => {
    // Same affordance as ScriptConsentDialog: targeting by scriptId opens
    // the existing script in the editor — never scaffolds.
    emitAppEvent(ScriptableObjectEvents.EDIT_SCRIPT, { scriptId });
  }, []);

  // R10: grants are revocable. revokeCapability mutates the live grant set the
  // broker reads, so the next use of the cap re-prompts (local) or is denied;
  // refresh re-reads the (now smaller) grant set.
  const handleRevoke = useCallback(
    (scriptId: string, cap: CapabilityId) => {
      void revokeCapability(scriptId, cap).then(refresh);
    },
    [refresh],
  );

  return (
    <div style={sectionStyle(placement)}>
      {handles.length === 0 && (
        <div style={emptyStyle}>No scripts are currently mounted.</div>
      )}
      <div>
        {handles.map((h) => {
          const grants = [...h.grants];
          const exposes = exposed.filter((m) => m.ownerScriptId === h.scriptId);
          return (
            <div key={h.scriptId} style={cardStyle}>
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <span style={{ flex: 1, fontWeight: 600, fontSize: 11, color: "#333" }}>
                  {h.scriptName}
                </span>
                <span style={h.tier === "unlocked" ? unlockedTagStyle : restrictedTagStyle}>
                  {h.tier}
                </span>
                <span
                  style={h.origin === "local" ? localTagStyle : packageTagStyle}
                  title={h.origin === "local" ? "Authored in this workbook" : `From package "${h.origin}"`}
                >
                  {h.origin === "local" ? "local" : h.origin}
                </span>
                <button style={btnSmallStyle} onClick={() => handleInspect(h.scriptId)}>
                  Inspect
                </button>
              </div>
              <div style={detailLineStyle}>
                Target:{" "}
                <span style={monoStyle} title={h.instanceId ?? undefined}>
                  {h.objectType}
                  {h.instanceId ? ` ${shortId(h.instanceId)}` : " (type-level)"}
                </span>
              </div>
              <div style={{ ...detailLineStyle, display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
                <span>Grants:</span>
                {grants.length === 0 && <span style={{ color: "#999" }}>none</span>}
                {grants.map((g) => (
                  <span key={g} style={{ display: "inline-flex", alignItems: "center" }}>
                    <span style={capTagStyle}>{g}</span>
                    <button
                      style={revokeBtnStyle}
                      title={`Revoke ${g}`}
                      aria-label={`Revoke ${g} from ${h.scriptName}`}
                      onClick={() => handleRevoke(h.scriptId, g)}
                    >
                      &times;
                    </button>
                  </span>
                ))}
              </div>
              {grants.includes("net.fetch") &&
                (() => {
                  const origins = getGrantedOrigins(h.scriptId);
                  return origins.length > 0 ? (
                    <div style={{ ...detailLineStyle, display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
                      <span>Allowed origins:</span>
                      {origins.map((o) => (
                        <span key={o} style={monoStyle}>
                          {o}
                        </span>
                      ))}
                    </div>
                  ) : null;
                })()}
              {exposes.length > 0 && (
                <div style={detailLineStyle}>
                  Exposes:{" "}
                  <span style={monoStyle}>
                    {exposes
                      .map((m) => m.methodName + (m.isPublic ? " (public)" : ""))
                      .join(", ")}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================================
// Section 2: What scripts can do (the policy table, rendered FROM ALLOWLIST)
// ============================================================================

interface PolicyGroup {
  label: string;
  entries: Array<[string, MethodPolicy]>;
}

export function PolicyTableSection({ placement }: PanelSectionProps): React.ReactElement {
  // This table IS the policy the broker executes — grouped, never rewritten.
  const all = Object.entries(ALLOWLIST);
  const groups: PolicyGroup[] = [
    {
      label: "Every script",
      entries: all.filter(([, p]) => p.tier === "restricted" && !p.capability),
    },
    {
      label: "Unlocked only",
      entries: all.filter(([, p]) => p.tier === "unlocked" && !p.capability),
    },
    {
      label: "Requires a grant",
      entries: all.filter(([, p]) => !!p.capability),
    },
  ];

  const subscribableEvents = [...SCRIPT_SUBSCRIBABLE_APP_EVENTS].sort();

  return (
    <div style={sectionStyle(placement)}>
      <table style={tableStyle}>
        <tbody>
          {groups.map((group) => (
            <React.Fragment key={group.label}>
              <tr>
                <td colSpan={3} style={groupHeaderCellStyle}>{group.label}</td>
              </tr>
              {group.entries.map(([method, policy]) => (
                <tr key={method}>
                  <td style={{ ...cellStyle, whiteSpace: "nowrap" }}>
                    <span style={monoStyle}>{method}</span>
                    {policy.capability && (
                      <>
                        {" "}
                        <span style={capTagStyle}>{policy.capability}</span>
                      </>
                    )}
                  </td>
                  <td style={classCellStyle}>{policy.class}</td>
                  <td style={descCellStyle}>{policy.desc}</td>
                </tr>
              ))}
            </React.Fragment>
          ))}
        </tbody>
      </table>
      <div style={{ marginTop: 8, fontSize: 10, color: "#888", lineHeight: 1.5 }}>
        App events scripts may observe (read-only):{" "}
        <span style={monoStyle}>{subscribableEvents.join(", ")}</span>.
        Any other event name is namespaced to <span style={monoStyle}>userscript:*</span>.
      </div>
    </div>
  );
}

// ============================================================================
// Section 3: Activity (the broker audit tail)
// ============================================================================

export function ActivitySection({ placement }: PanelSectionProps): React.ReactElement {
  const [entries, setEntries] = useState<AuditEntry[]>(() =>
    getAuditTail(ACTIVITY_LIMIT).reverse(),
  );
  const [total, setTotal] = useState<number>(() => getAuditTotal());
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const flush = () => {
      timerRef.current = null;
      setEntries(getAuditTail(ACTIVITY_LIMIT).reverse());
      setTotal(getAuditTotal());
    };
    // Sync once on mount (calls may have landed between render and effect)
    flush();
    const unsub = onAudit(() => {
      // Throttle: at most one re-render per ACTIVITY_THROTTLE_MS
      if (timerRef.current !== null) return;
      timerRef.current = window.setTimeout(flush, ACTIVITY_THROTTLE_MS);
    });
    return () => {
      unsub();
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  return (
    <div style={sectionStyle(placement)}>
      <div style={{ padding: "2px 2px 4px", fontSize: 10, color: "#888" }}>
        {total} call{total !== 1 ? "s" : ""} total
        {total > entries.length ? ` (showing last ${entries.length})` : ""}
      </div>
      {entries.length === 0 ? (
        <div style={emptyStyle}>No script activity yet.</div>
      ) : (
        <table style={tableStyle}>
          <tbody>
            {entries.map((e, i) => (
              <tr key={`${e.ts}-${i}`}>
                <td style={{ ...cellStyle, color: "#888", whiteSpace: "nowrap", width: 1 }}>
                  {formatTime(e.ts)}
                </td>
                <td style={{ ...cellStyle, whiteSpace: "nowrap" }} title={e.scriptId}>
                  {e.scriptName}
                </td>
                <td style={{ ...cellStyle, whiteSpace: "nowrap" }}>
                  <span style={monoStyle}>{e.method}</span>
                </td>
                <td
                  style={{
                    ...cellStyle,
                    whiteSpace: "nowrap",
                    width: 1,
                    color: e.ok ? "#107C10" : "#D13438",
                    fontWeight: e.ok ? 400 : 600,
                  }}
                >
                  {e.ok ? "ok" : (e.error ?? "denied")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
