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
//
//          THREE MORE THINGS LIVE HERE for the same reason ("Held by scripts
//          right now"): a keyboard shortcut a script has taken, cells sitting
//          in a script's private clipboard, and a background registry poll a
//          script caused. All three were already refused/bounded/consented
//          correctly and all three were INVISIBLE to the person they belong to,
//          which is precisely VBA's Application.OnKey failure. Each row carries
//          its control (revoke / clear), because showing a hold the user cannot
//          release is half a promise.
//
//          And ONE section here is deliberately NOT about this workbook: the
//          machine-scoped add-in trail. Installing an add-in puts code in
//          %APPDATA% that loads into EVERY workbook afterwards, so it is the
//          widest consent Calcula asks for — and it left no record at all until
//          app/src-tauri/src/extension_audit.rs. It is rendered last, visually
//          separated and labelled "this computer", so it can never be mistaken
//          for something the open file carries. The trusted-publisher list is
//          the second such section, and the reason it exists here rather than in
//          a dialog: a publisher pin is a durable machine-wide decision, and
//          until now there was nowhere to see the whole set. It is also the ONLY
//          place an ACCEPTED cross-registry name conflict stays visible after
//          the dialog that accepted it is gone.

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
  codeUnitMayReachBeyondGrid,
  describeInterpreterReach,
  getWorkbookScheduledJobs,
  summarizeScheduledJobs,
  describeJobTime,
  cancelScheduledJob,
  setScheduledJobEnabled,
  getScriptHeldState,
  summarizeScriptHeldState,
  revokeScriptKeybinding,
  clearScriptClipboard,
  getExtensionAuditTrail,
  EXTENSION_AUDIT_ACTION_LABELS,
  type ScheduledJobEntry,
  type ScheduledJobSummary,
  type ScriptHeldState,
  type ExtensionAuditTrail,
  type ExtensionAuditEntry,
} from "@api/codeInventory";
import {
  listTrustedPublishers,
  type TrustedPublisherReport,
} from "@api/distribution";
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
  "file.picker": "Files you pick",
  "ui.shortcut": "Keyboard shortcut",
  "grid.read": "Shown your cells",
  "distribution.publish": "Publish packages",
  "distribution.subscribe": "Subscribe to packages",
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

// ---- Held by scripts right now ("state I did not put there") --------------

const heldSectionStyle: React.CSSProperties = {
  margin: "0 4px 10px",
  border: "1px solid #D8DEE8",
  borderRadius: 4,
  backgroundColor: "#F7F9FC",
};

const heldHeaderStyle: React.CSSProperties = {
  padding: "5px 8px",
  borderBottom: "1px solid #E4E9F0",
  fontWeight: 600,
  fontSize: 11.5,
  color: "#33558A",
};

const heldIntroStyle: React.CSSProperties = {
  padding: "6px 8px 0",
  fontSize: 10,
  color: "#5A6B85",
  lineHeight: 1.4,
};

const heldEmptyStyle: React.CSSProperties = {
  padding: "8px",
  fontSize: 10.5,
  color: "#6B7A90",
  lineHeight: 1.4,
};

const heldRowStyle: React.CSSProperties = {
  padding: "6px 8px",
  borderTop: "1px solid #E4E9F0",
};

const comboBadge: React.CSSProperties = {
  ...chipStyle,
  backgroundColor: "#DCE6F7",
  color: "#26467E",
  fontWeight: 600,
  fontFamily: "'Cascadia Code', Consolas, monospace",
};

// ---- Machine-scoped add-in trail ------------------------------------------

const machineSectionStyle: React.CSSProperties = {
  margin: "14px 4px 10px",
  border: "1px solid #DDD",
  borderRadius: 4,
  backgroundColor: "#FAFAFA",
};

const machineHeaderStyle: React.CSSProperties = {
  padding: "5px 8px",
  borderBottom: "1px solid #E6E6E6",
  fontWeight: 600,
  fontSize: 11.5,
  color: "#444",
};

const machineScopeNoteStyle: React.CSSProperties = {
  padding: "6px 8px 0",
  fontSize: 10,
  color: "#7A7A7A",
  lineHeight: 1.4,
};

const auditActionBadge = (action: string): React.CSSProperties => {
  if (action === "publisherChangeAccepted") {
    return { ...chipStyle, backgroundColor: "#F3E2E2", color: "#8A3A3A", fontWeight: 600 };
  }
  if (action === "removed") {
    return { ...chipStyle, backgroundColor: "#E8E8E8", color: "#555" };
  }
  if (action === "publisherPinned") {
    return { ...chipStyle, backgroundColor: "#E6ECF6", color: "#33558A" };
  }
  return { ...chipStyle, backgroundColor: "#E6F0E6", color: "#3A6B3A" };
};

// ============================================================================
// Held-by-scripts section — visibility AND control
// ============================================================================

function HeldByScriptsSection({
  state,
  onChanged,
}: {
  state: ScriptHeldState;
  onChanged: () => void;
}): React.ReactElement {
  const summary = summarizeScriptHeldState(state);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const revokeShortcut = useCallback(
    (id: string, combo: string, ownerName: string) => {
      const ok = window.confirm(
        `Take ${combo} back from "${ownerName}"?\n\n` +
          "The script keeps running; it just stops receiving those keys. It can ask for the " +
          "shortcut again the next time it runs.",
      );
      if (!ok) return;
      setBusy(id);
      setError(null);
      try {
        revokeScriptKeybinding(id);
        onChanged();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [onChanged],
  );

  const clearClipboard = useCallback(
    (scriptId: string, ownerName: string, cells: number) => {
      const ok = window.confirm(
        `Empty the private clipboard held by "${ownerName}"?\n\n` +
          `${cells} cell${cells === 1 ? "" : "s"} copied from this workbook are being held by ` +
          "that script. Emptying it changes nothing in the grid — the script simply finds its " +
          "buffer empty, exactly as it does when it starts.",
      );
      if (!ok) return;
      setBusy(scriptId);
      setError(null);
      void clearScriptClipboard(scriptId)
        .then(onChanged)
        .catch((e) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setBusy(null));
    },
    [onChanged],
  );

  return (
    <div style={heldSectionStyle}>
      <div style={heldHeaderStyle}>
        Held by scripts right now (
        {summary.shortcuts + summary.clipboards + state.watches.length})
      </div>

      {!summary.any && (
        <div style={heldEmptyStyle}>
          No script is holding a keyboard shortcut, a copy of your cells, or a
          background check.
        </div>
      )}

      {summary.any && (
        <div style={heldIntroStyle}>
          Things scripts are holding on your behalf. None of it is hidden from
          you, and none of it survives the script: everything here is taken back
          automatically when the script stops. You can take it back sooner.
        </div>
      )}

      {state.shortcuts.map((s) => (
        <div key={s.id} style={heldRowStyle} data-script-shortcut-id={s.id}>
          <div style={unitHeaderRowStyle}>
            <span style={jobTargetStyle}>Calls {s.handler}()</span>
            <span style={comboBadge}>{s.combo}</span>
          </div>
          <div style={jobMetaStyle}>
            Keyboard shortcut held by{" "}
            <strong style={{ fontWeight: 600 }}>{s.ownerName}</strong>. Pressing
            these keys runs that script's code. Your own shortcuts always win
            over a script's.
          </div>
          <div style={badgeRowStyle}>
            {s.ownerProvenance === "distributed" && (
              <span style={pkgBadge} title="The owning code arrived in a distributed package">
                Package: {s.ownerPackage ?? "unknown"}
              </span>
            )}
            {s.ownerMissing && (
              <span
                style={orphanBadge}
                title="No code in this workbook and no live mount owns this shortcut."
              >
                Owner missing
              </span>
            )}
          </div>
          <div style={{ marginTop: 4 }}>
            <button
              style={dangerLinkBtnStyle}
              disabled={busy === s.id}
              onClick={() => revokeShortcut(s.id, s.combo, s.ownerName)}
            >
              Take back {s.combo}
            </button>
          </div>
        </div>
      ))}

      {state.clipboards.map((c) => (
        <div key={c.scriptId} style={heldRowStyle} data-script-clipboard-id={c.scriptId}>
          <div style={unitHeaderRowStyle}>
            <span style={jobTargetStyle}>
              {c.cells} cell{c.cells === 1 ? "" : "s"} copied ({c.rows} &times; {c.cols})
            </span>
          </div>
          <div style={jobMetaStyle}>
            In the private clipboard of{" "}
            <strong style={{ fontWeight: 600 }}>{c.ownerName}</strong>. This is
            the script's own buffer — it is not your clipboard, nothing was taken
            from it, and nothing left Calcula.
          </div>
          <div style={badgeRowStyle}>
            {c.ownerProvenance === "distributed" && (
              <span style={pkgBadge} title="The owning code arrived in a distributed package">
                Package: {c.ownerPackage ?? "unknown"}
              </span>
            )}
          </div>
          <div style={{ marginTop: 4 }}>
            <button
              style={dangerLinkBtnStyle}
              disabled={busy === c.scriptId}
              onClick={() => clearClipboard(c.scriptId, c.ownerName, c.cells)}
            >
              Empty it
            </button>
          </div>
        </div>
      ))}

      {state.watches.map((w) => (
        <div key={w.id} style={heldRowStyle} data-background-watch-id={w.id}>
          <div style={unitHeaderRowStyle}>
            <span style={jobTargetStyle}>{w.what}</span>
            <span style={cadenceBadge}>{w.cadence}</span>
          </div>
          <div style={jobMetaStyle}>
            {w.running ? "Running" : "Idle"} &middot; {w.refCount} thing
            {w.refCount === 1 ? "" : "s"} asked for it &middot; last check{" "}
            {w.lastPollAt ? new Date(w.lastPollAt).toLocaleTimeString() : "never"}{" "}
            ({w.lastPollCalls} call{w.lastPollCalls === 1 ? "" : "s"})
          </div>
          <div style={jobMetaStyle}>
            {w.watchedRegionIds.length > 0
              ? `Watching: ${w.watchedRegionIds.join(", ")}`
              : "Watching nothing yet."}
            {w.skippedRegionIds.length > 0 &&
              ` Skipped (not published by you): ${w.skippedRegionIds.join(", ")}.`}
          </div>
          {w.lastError && <div style={jobErrorStyle}>Last check failed: {w.lastError}</div>}
          <div style={jobMetaStyle}>
            It stops on its own when nothing needs it — close the Responses pane
            or stop the script that subscribed.
          </div>
        </div>
      ))}

      {error && <div style={jobErrorStyle}>{error}</div>}
    </div>
  );
}

// ============================================================================
// Machine-scoped add-in trail — NOT this workbook, and it says so
// ============================================================================

function AddInTrailRow({ entry }: { entry: ExtensionAuditEntry }): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const when = entry.at ? new Date(entry.at) : null;
  const label = EXTENSION_AUDIT_ACTION_LABELS[entry.action] ?? entry.action;
  return (
    <div style={heldRowStyle} data-addin-audit-action={entry.action}>
      <div style={unitHeaderRowStyle}>
        <span style={unitNameStyle}>{entry.name || entry.id || entry.bundleFileName}</span>
        <span style={{ fontSize: 9.5, color: "#AAA", whiteSpace: "nowrap" }}>
          {when && !Number.isNaN(when.getTime()) ? when.toLocaleString() : entry.at}
        </span>
      </div>
      <div style={residenceStyle}>{entry.detail}</div>
      <div style={badgeRowStyle}>
        <span style={auditActionBadge(entry.action)}>{label}</span>
        {entry.version && <span style={chipStyle}>v{entry.version}</span>}
        {entry.trustStatus && (
          <span
            style={entry.capabilitiesHonored ? capGrantedBadge : chipStyle}
            title="The trust status Calcula could prove at the moment you decided — not re-checked now."
          >
            {entry.trustStatus}
          </span>
        )}
        {entry.declaredCapabilities.map((c) => (
          <span
            key={c}
            style={entry.capabilitiesHonored ? capCeilingBadge : chipStyle}
            title={
              entry.capabilitiesHonored
                ? "Declared and honored at install time"
                : "Declared but REFUSED — this add-in was not trusted enough"
            }
          >
            {c}
            {entry.capabilitiesHonored ? "" : " (refused)"}
          </span>
        ))}
      </div>
      <div style={{ marginTop: 4 }}>
        <button style={linkBtnStyle} onClick={() => setExpanded((e) => !e)}>
          {expanded ? "Hide details" : "Details"}
        </button>
      </div>
      {expanded && (
        <div style={{ ...jobMetaStyle, wordBreak: "break-all" }}>
          <div>Add-in id: {entry.id || "(unknown)"}</div>
          <div>File: {entry.bundleFileName || "(unknown)"}</div>
          <div>Publisher key: {entry.publisherKey || "(unsigned)"}</div>
          {entry.previousPublisherKey && (
            <div>Previously trusted key: {entry.previousPublisherKey}</div>
          )}
          {entry.sourcePath && <div>Installed from: {entry.sourcePath}</div>}
          <div>
            Declared contributions:{" "}
            {entry.contributions.length > 0 ? entry.contributions.join(", ") : "none"}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * What does this computer trust, and from where?
 *
 * Pins are keyed by (namespace, registry, package). Two registries serving the
 * same package name therefore hold INDEPENDENT pins — which is the whole point,
 * because keying on the name alone let whoever reached a name first own it
 * machine-wide. The cost of that is a state worth showing: one name resolving to
 * two DIFFERENT publisher keys. That is flagged here, and nowhere else once the
 * subscribe dialog is closed.
 */
function TrustedPublishersSection({
  report,
}: {
  report: TrustedPublisherReport | null;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  if (!report) {
    return (
      <div style={machineSectionStyle}>
        <div style={machineHeaderStyle}>Trusted publishers</div>
        <div style={heldEmptyStyle}>Reading the trusted-publisher record...</div>
      </div>
    );
  }

  // Conflicts first: the one row a user opens this section to find.
  const ordered = [...report.names].sort((a, b) =>
    a.hasKeyConflict === b.hasKeyConflict
      ? a.name.localeCompare(b.name)
      : a.hasKeyConflict
        ? -1
        : 1,
  );
  const shown = expanded ? ordered : ordered.slice(0, 5);

  return (
    <div style={machineSectionStyle}>
      <div style={machineHeaderStyle}>
        Trusted publishers ({report.totalPins})
      </div>

      <div style={machineScopeNoteStyle}>
        NOT part of this workbook. These are the publisher keys this COMPUTER has
        agreed to trust. A package pin belongs to the registry it came from, so
        the same package name from two registries is two separate decisions —
        that is what stops whoever reaches a name first from owning it
        everywhere. Add-ins have no registry and are trusted by id alone.
      </div>

      {report.error !== "" && (
        <div style={{ ...heldEmptyStyle, color: "#B00020" }}>
          The trusted-publisher record could not be read: {report.error}. This is
          NOT the same as "nothing is trusted" — Calcula refuses to use a pin
          store it cannot read, so package and add-in trust will fail closed
          until this is fixed.
        </div>
      )}

      {report.error === "" && report.totalPins === 0 && (
        <div style={heldEmptyStyle}>
          Nothing is trusted on this computer yet. Subscribing to a package or
          installing an add-in is what records a publisher key here.
        </div>
      )}

      {report.conflictCount > 0 && (
        <div style={{ ...heldEmptyStyle, color: "#B00020" }}>
          {report.conflictCount} name
          {report.conflictCount === 1 ? " is" : "s are"} trusted under MORE THAN
          ONE publisher key. Two sources claiming one name is what a package
          hijack looks like — check that you meant to trust both.
        </div>
      )}

      {shown.map((n) => (
        <div
          key={`${n.namespace}:${n.name}`}
          style={{
            padding: "5px 8px",
            borderTop: "1px solid #EEE",
            fontSize: 11,
            color: n.hasKeyConflict ? "#B00020" : "#444",
          }}
        >
          <div style={{ fontWeight: 600 }}>
            {n.name}{" "}
            <span style={{ ...chipStyle, backgroundColor: "#ECECEC", color: "#555" }}>
              {n.namespace === "ext" ? "add-in" : "package"}
            </span>
            {n.hasKeyConflict && (
              <span
                style={{ ...chipStyle, backgroundColor: "#F3E2E2", color: "#8A3A3A", fontWeight: 600 }}
              >
                two publishers
              </span>
            )}
          </div>
          {n.pins.map((p, i) => (
            <div key={i} style={{ marginLeft: 8, marginTop: 2, lineHeight: 1.4 }}>
              <span style={{ fontFamily: "Consolas, monospace", fontSize: 10 }}>
                {p.publisherKey.slice(0, 16)}…
              </span>
              {p.scopeLabel !== "" ? ` from ${p.scopeLabel}` : " (this computer, any source)"}
              {p.pinnedAt !== "" ? ` · trusted ${p.pinnedAt.slice(0, 10)}` : ""}
            </div>
          ))}
        </div>
      ))}

      {ordered.length > 5 && (
        <div style={{ padding: "4px 8px 6px" }}>
          <button style={linkBtnStyle} onClick={() => setExpanded((v) => !v)}>
            {expanded ? "Show fewer" : `Show all ${ordered.length}`}
          </button>
        </div>
      )}
    </div>
  );
}

function AddInTrailSection({ trail }: { trail: ExtensionAuditTrail | null }): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  if (!trail) {
    return (
      <div style={machineSectionStyle}>
        <div style={machineHeaderStyle}>Add-ins on this computer</div>
        <div style={heldEmptyStyle}>Reading the add-in record...</div>
      </div>
    );
  }

  const readFailed = trail.lastWriteError !== "" && trail.total === 0 && !trail.missing;
  const shown = expanded ? trail.entries : trail.entries.slice(0, 5);

  return (
    <div style={machineSectionStyle}>
      <div style={machineHeaderStyle}>Add-ins on this computer ({trail.total})</div>

      <div style={machineScopeNoteStyle}>
        NOT part of this workbook. Add-ins are installed once and load into every
        file you open afterwards, so this is the record of what you have let onto
        this machine — what was installed or removed, who signed it, and what
        Calcula could prove at the moment you said yes. The record is
        append-only; Calcula never rewrites it.
      </div>

      {readFailed && (
        <div style={{ ...heldEmptyStyle, color: "#B00020" }}>
          The add-in record could not be read: {trail.lastWriteError}. This is not
          the same as "nothing was ever installed" — check the Extensions panel
          for what is actually loaded.
        </div>
      )}

      {!readFailed && trail.missing && (
        <div style={heldEmptyStyle}>
          No add-in has ever been installed or removed on this computer.
        </div>
      )}

      {!readFailed && !trail.missing && trail.unreadableLines > 0 && (
        <div style={{ ...heldEmptyStyle, color: "#B00020" }}>
          {trail.unreadableLines} line{trail.unreadableLines === 1 ? " was" : "s were"}{" "}
          damaged and could not be read. Something other than Calcula has written
          to this file.
        </div>
      )}

      {trail.lastWriteError !== "" && !readFailed && (
        <div style={{ ...heldEmptyStyle, color: "#B00020" }}>
          The most recent decision may not have been recorded: {trail.lastWriteError}
        </div>
      )}

      {shown.map((e, i) => (
        <AddInTrailRow key={`${e.at}:${e.action}:${e.id}:${i}`} entry={e} />
      ))}

      {trail.entries.length > 5 && (
        <div style={{ padding: "6px 8px" }}>
          <button style={linkBtnStyle} onClick={() => setExpanded((v) => !v)}>
            {expanded ? "Show fewer" : `Show all ${trail.entries.length}`}
          </button>
        </div>
      )}

      {trail.path && (
        <div style={{ ...machineScopeNoteStyle, paddingBottom: 8, wordBreak: "break-all" }}>
          The file itself: {trail.path}
        </div>
      )}
    </div>
  );
}

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

        {/* What it can touch.
            The "Grid-only" badge used to be driven by declaredCapabilities alone,
            which OVERSTATED the sandbox for the Rust-QuickJS surfaces: a notebook
            declares no ceiling and acquires bi.query / bi.sql through a JIT
            consent at run time, so it read "Sandboxed to grid data only" while it
            was one click from the BI model. The reach is now DERIVED from the
            interpreter's own op manifest (core/script-engine/src/manifest.rs,
            mirrored by @api/codeInventory) instead of asserted, and a surface that
            CAN be granted more says so. */}
        {unit.declaredCapabilities.length === 0 ? (
          codeUnitMayReachBeyondGrid(unit) ? (
            <span
              style={capCeilingBadge}
              title={
                `${describeInterpreterReach(unit.interpreterReach ?? [])} ` +
                `It holds no capability until you grant one, and it can be granted: ` +
                `${(unit.interpreterCapabilities ?? []).join(", ")}.`
              }
            >
              Grid + on request
            </span>
          ) : (
            <span
              style={gridOnlyBadge}
              title={
                unit.interpreterReach
                  ? `${describeInterpreterReach(unit.interpreterReach)} No capability can be granted to this surface.`
                  : "Sandboxed to grid data only"
              }
            >
              Grid-only
            </span>
          )
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
  const [held, setHeld] = useState<ScriptHeldState>({
    shortcuts: [],
    clipboards: [],
    watches: [],
  });
  const [trail, setTrail] = useState<ExtensionAuditTrail | null>(null);
  const [pins, setPins] = useState<TrustedPublisherReport | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Last inventory read, so a schedule refresh can reuse the owner join
   *  instead of rescanning every script on every poll. */
  const unitsRef = useRef<CodeUnit[] | null>(null);

  /** Held state changes without any workbook event — a script can bind a
   *  shortcut or fill its clipboard at any moment — so it rides the same poll as
   *  the schedule. Never throws: a held item that cannot be read must not blank
   *  the section, because "nothing held" is the one answer that must never be
   *  wrong in the reassuring direction. */
  const reloadHeld = useCallback(async () => {
    try {
      setHeld(await getScriptHeldState(unitsRef.current ?? undefined));
    } catch (e) {
      console.warn("[CodeInThisFile] held state unavailable:", e);
    }
  }, []);

  const reloadJobs = useCallback(async () => {
    try {
      const next = await getWorkbookScheduledJobs(unitsRef.current ?? undefined);
      setJobs(next);
      setNow(Date.now());
      setJobsError(null);
    } catch (e) {
      setJobsError(e instanceof Error ? e.message : String(e));
    }
    await reloadHeld();
  }, [reloadHeld]);

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
    // The machine trail is not workbook state, so it is read on an explicit
    // reload only — never on the 15s poll, which would turn a rare, deliberate
    // record into per-panel background IPC.
    setTrail(await getExtensionAuditTrail());
    // Same rule as the trail: machine-scoped, explicit reload only. A failure to
    // read is reported by the command as `error`, never as an empty list.
    try {
      setPins(await listTrustedPublishers());
    } catch (e) {
      setPins({
        names: [],
        totalPins: 0,
        conflictCount: 0,
        error: e instanceof Error ? e.message : String(e),
      });
    }
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
  const heldSummary = summarizeScriptHeldState(held);
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
            {heldSummary.shortcuts > 0 && (
              <span style={warnChipStyle}>
                {heldSummary.shortcuts} keyboard shortcut
                {heldSummary.shortcuts === 1 ? "" : "s"} held
              </span>
            )}
            {heldSummary.clipboardCells > 0 && (
              <span style={warnChipStyle}>
                {heldSummary.clipboardCells} cell
                {heldSummary.clipboardCells === 1 ? "" : "s"} in script clipboards
              </span>
            )}
            {heldSummary.runningWatches > 0 && (
              <span style={warnChipStyle}>
                {heldSummary.runningWatches} background check
                {heldSummary.runningWatches === 1 ? "" : "s"}
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

      {/* ...and immediately after it, what scripts are HOLDING. Same family of
          question ("what is happening that I did not just ask for?"), same rule
          (every row carries its own way to say no). */}
      <HeldByScriptsSection state={held} onChanged={() => void reloadHeld()} />

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

      {/* LAST, and visually separated: the only section here that is not about
          the open workbook. It answers "what else did I let onto this machine?"
          — the widest consent Calcula asks for, and the one that used to leave
          no record anywhere. */}
      <AddInTrailSection trail={trail} />
      <TrustedPublishersSection report={pins} />
    </div>
  );
}
