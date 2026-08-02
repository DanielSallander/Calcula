// FILENAME: app/extensions/Distribution/components/SubscriptionManagerPane.tsx
// PURPOSE: Task pane listing all .calp subscriptions with management actions (D6).
// CONTEXT: Wires the previously caller-less calp_get_subscriptions + calp_detach
//          so the user can see what they're subscribed to (package, pinned vs
//          resolved version, registry, sheet count) and detach — instead of
//          subscriptions being invisible in-memory state.
//          It also surfaces PUBLISHER TRUST (calp_subscription_trust). A .cala
//          restores its subscription list on open WITHOUT pulling, so a workbook
//          received from someone else can name packages this computer never
//          subscribed to. Those packages' writeback regions / GATHER / model
//          writeback columns are deliberately INERT: the code paths that read
//          their declarations require an existing TOFU pin instead of creating
//          one, because a file that merely arrives must not be able to squat a
//          publisher identity. Without this pane saying so, that correct
//          fail-closed behaviour would look like a broken report.

import React, { useState, useEffect, useCallback } from "react";
import {
  getSubscriptions,
  getSubscriptionTrust,
  detach,
  emitAppEvent,
  onAppEvent,
  AppEvents,
  calculateNow,
} from "@api";
import {
  exportPackageHtml,
  resetSubscription,
  getWritebackRebuildSkips,
  WRITEBACK_INDEX_CHANGED_EVENT,
  type Subscription,
  type SubscriptionTrustInfo,
  type WritebackRebuildSkip,
} from "@api/distribution";
import { pivot } from "@api/pivot";
import { saveHtmlReport, printHtmlReport } from "../lib/reportExport";

const subKey = (s: Subscription) => `${s.packageName}@${s.registryUrl}`;
const trustKey = (t: SubscriptionTrustInfo) => `${t.packageName}@${t.registryUrl}`;

/**
 * How each publisher-trust state reads in this pane. A TABLE with a row for
 * every state the backend can return, including the "unavailable" transport
 * failure — a security state that renders as nothing looks benign, which is the
 * failure mode this whole shape exists to avoid.
 *
 * `verified` intentionally renders NOTHING: the normal, expected case should not
 * add noise. Everything else is called out.
 */
/** The other registries holding this package name, in the user's own spelling. */
function otherScopeLabels(t: SubscriptionTrustInfo): string {
  return (t.otherScopePins ?? [])
    .filter((p) => !p.sameKey)
    .map((p) => p.scopeLabel)
    .join(", ");
}

/**
 * How each `WritebackRebuildSkip.reason` reads.
 *
 * The point of this table is a distinction the pane could not previously draw:
 * "this package declares no writeback" and "this package's writeback regions
 * could not be read, so its form protections are NOT in force" both produced an
 * empty index and therefore an identical, silent screen. A subscriber typing
 * into a form whose deadline, value types and required-field rules were never
 * loaded deserves to be told.
 *
 * Same shape as TRUST_NOTICE, for the same reason: a reason string this build
 * has no row for must render as a warning, never as nothing.
 */
const WRITEBACK_SKIP_NOTICE: Record<string, { tone: "warn" | "danger"; text: string }> = {
  // Not a failure: the workbook-open rebuild walks local registries inline and
  // hands HTTP ones to a worker, so this is the normal state for a second or two.
  deferred: {
    tone: "warn",
    text: "Loading this package's form rules from its registry...",
  },
  unreachable: {
    tone: "danger",
    text:
      "Registry unreachable, so this package's form rules could not be read. " +
      "Its deadlines, required fields and value checks are NOT in force.",
  },
  notPinned: {
    tone: "danger",
    text:
      "This computer has never agreed to trust this package's publisher, so its " +
      "form rules are not loaded. Subscribe to it once to activate them.",
  },
  publisherChanged: {
    tone: "danger",
    text:
      "The publisher's signing key does not match the one this computer trusted. " +
      "Calcula is refusing to load this package's form rules.",
  },
  badManifest: {
    tone: "danger",
    text: "This package's manifest is damaged, so its form rules could not be read.",
  },
  appTooOld: {
    tone: "danger",
    text: "This package needs a newer version of Calcula; its form rules were not loaded.",
  },
};

const skipKey = (s: WritebackRebuildSkip) => `${s.packageName}@${s.registryUrl}`;

const TRUST_NOTICE: Record<
  SubscriptionTrustInfo["trustStatus"],
  { tone: "ok" | "warn" | "danger"; text: (t: SubscriptionTrustInfo) => string } | null
> = {
  verified: null,
  firstUse: {
    tone: "warn",
    text: (t) => `Publisher ${t.publisherName || "(unnamed)"} was trusted just now.`,
  },
  firstUseKnownPublisher: {
    tone: "warn",
    text: (t) =>
      `Publisher ${t.publisherName || "(unnamed)"} was trusted for ${t.registryUrl || "this registry"} ` +
      `just now. The same publisher key was already trusted for this package from ` +
      `${otherScopeLabels(t) || "another registry"} — a move, a mirror, or the same location ` +
      `spelled differently.`,
  },
  firstUseAcceptedNameConflict: {
    tone: "danger",
    text: (t) =>
      `Publisher ${t.publisherName || "(unnamed)"} was trusted for ${t.registryUrl || "this registry"} ` +
      `even though ${otherScopeLabels(t) || "another registry"} holds this package name under a ` +
      `DIFFERENT publisher key. You accepted that conflict. Two registries claiming one name is ` +
      `what a package hijack looks like — re-check both publishers if you did not expect this.`,
  },
  notPinned: {
    tone: "danger",
    text: (t) =>
      `Publisher ${t.publisherName || "(unnamed)"} is not trusted on this computer. ` +
      `This workbook references the package, but nobody here ever subscribed to it, so its ` +
      (t.declaresWriteback
        ? "writeback regions and GATHER formulas stay inactive. "
        : "published declarations are ignored. ") +
      `Use Data \u2192 Subscribe to Package to review the publisher and activate it.`,
  },
  notPinnedNameConflict: {
    tone: "danger",
    text: (t) =>
      `NAME CONFLICT: this workbook references '${t.packageName}' from ` +
      `${t.registryUrl || "a registry"}, but ${otherScopeLabels(t) || "another registry"} is ` +
      `already trusted for that same package name under a DIFFERENT publisher key. The ` +
      `signature is valid, which only proves the bytes were not altered \u2014 it does not say ` +
      `who signed them. ` +
      (t.declaresWriteback
        ? "Writeback regions and GATHER formulas stay inactive. "
        : "Published declarations are ignored. ") +
      `Use Data \u2192 Subscribe to Package to compare both publishers before trusting either.`,
  },
  unavailable: {
    tone: "warn",
    text: (t) =>
      `Could not verify this package at ${t.registryUrl || "its registry"}: ${t.error || "unknown error"}`,
  },
};

export function SubscriptionManagerPane(): React.ReactElement {
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [trust, setTrust] = useState<Record<string, SubscriptionTrustInfo>>({});
  const [skips, setSkips] = useState<Record<string, WritebackRebuildSkip>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDetach, setConfirmingDetach] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);
  // Two-step confirm + progress for "Reset to published" (keyed per subscription).
  const [confirmingReset, setConfirmingReset] = useState<string | null>(null);
  const [resetting, setResetting] = useState<string | null>(null);
  const [resetStatus, setResetStatus] = useState<string | null>(null);

  // Recipient reach: render this received report to a self-contained HTML the
  // recipient can open without Calcula — save as .html (static report or
  // multi-sheet viewer) or open the print dialog to Save as PDF.
  const handleExport = useCallback(
    async (s: Subscription, mode: "static" | "viewer", asPdf: boolean) => {
      const key = `${s.packageName}:${asPdf ? "pdf" : mode}`;
      setExporting(key);
      setError(null);
      try {
        // The backend strips a file:// prefix from registryUrl.
        const html = await exportPackageHtml(
          s.registryUrl,
          s.packageName,
          s.resolvedVersion,
          mode,
        );
        if (asPdf) {
          printHtmlReport(html);
        } else {
          const suffix = mode === "viewer" ? "-viewer" : "";
          await saveHtmlReport(html, `${s.packageName}-${s.resolvedVersion}${suffix}.html`);
        }
      } catch (e: unknown) {
        setError(`Export failed: ${String(e)}`);
      } finally {
        setExporting(null);
      }
    },
    [],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const manifest = await getSubscriptions();
      setSubs(manifest.subscriptions);
      // Trust is reported separately (and passively — asking never pins).
      // A failure here must not hide the subscription list itself.
      try {
        const rows = await getSubscriptionTrust();
        setTrust(Object.fromEntries(rows.map((r) => [trustKey(r), r])));
      } catch {
        setTrust({});
      }
      // Which subscriptions' writeback regions the last index rebuild could NOT
      // install. Reported separately and non-fatally for the same reason trust
      // is: a failure here must not hide the subscription list itself.
      try {
        const rows = await getWritebackRebuildSkips();
        setSkips(Object.fromEntries(rows.map((r) => [skipKey(r), r])));
      } catch {
        setSkips({});
      }
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    // Re-list when the workbook changes (pull / refresh / detach touch subscriptions).
    const unsub = onAppEvent(AppEvents.SHEET_CHANGED, refresh);
    // ...and when the writeback index is rebuilt. Workbook open defers HTTP
    // registries to a worker, so the first paint of this pane legitimately shows
    // `deferred`; this is how those rows resolve to their real state.
    const unsubIndex = onAppEvent(WRITEBACK_INDEX_CHANGED_EVENT, refresh);
    return () => {
      unsub();
      unsubIndex();
    };
  }, [refresh]);

  // Reset a subscription's sheets to the pristine published content. The
  // backend records it as ONE undo transaction, so Ctrl+Z restores every
  // local change (cells, formatting, sizes, merges, override edits).
  const handleReset = useCallback(async (s: Subscription) => {
    const key = subKey(s);
    setError(null);
    setResetStatus(null);
    setResetting(key);
    try {
      const r = await resetSubscription(s.registryUrl, s.packageName);
      setConfirmingReset(null);
      // Re-render pivot output: the published content ships with pivot output
      // cells STRIPPED (subscribers recalculate them), so after the sheet
      // content is reset the pivots must redraw onto the pristine sheet.
      try {
        const allPivots = await pivot.getAll();
        for (const p of allPivots) {
          try { await pivot.refreshCache(p.id); } catch { /* non-fatal */ }
        }
        window.dispatchEvent(new Event("pivot:refresh"));
      } catch (err) {
        console.error("[Distribution] Pivot re-render after reset failed:", err);
      }
      // Recalculate (cross-sheet formulas referencing the reset sheets) and
      // refetch grid data so the restored content shows.
      try {
        await calculateNow();
      } catch (err) {
        console.error("[Distribution] Recalc after reset failed:", err);
      }
      emitAppEvent(AppEvents.SHEET_CHANGED, {});
      window.dispatchEvent(new CustomEvent("grid:refresh"));
      setResetStatus(
        `Reset ${s.packageName} to v${r.resolvedVersion}: ${r.sheetsReset} sheet(s), ` +
        `${r.pivotsReset} pivot(s), ${r.overridesCleared} override(s) cleared. ` +
        `Press Ctrl+Z to undo.`
      );
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setResetting(null);
    }
  }, []);

  const handleDetachAll = useCallback(async () => {
    setError(null);
    try {
      await detach();
      setConfirmingDetach(false);
      emitAppEvent(AppEvents.SHEET_CHANGED, {});
      await refresh();
    } catch (e: unknown) {
      setError(String(e));
    }
  }, [refresh]);

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.headerText}>
          {subs.length} subscription{subs.length !== 1 ? "s" : ""}
        </span>
        <button onClick={refresh} disabled={loading} style={styles.smallBtn}>
          {loading ? "..." : "Refresh list"}
        </button>
      </div>

      {error && <div style={styles.error}>{error}</div>}

      <div style={styles.list}>
        {subs.length === 0 ? (
          <div style={styles.empty}>
            Not subscribed to any package. Use <strong>Data &rarr; Subscribe to Package</strong>.
          </div>
        ) : (
          subs.map((s) => {
            const stale = s.versionPin !== s.resolvedVersion && s.versionPin !== `=${s.resolvedVersion}`;
            return (
              <div key={`${s.packageName}@${s.registryUrl}`} style={styles.item}>
                <div style={styles.itemHeader}>
                  <span style={styles.pkgName}>{s.packageName}</span>
                  <span style={styles.version}>
                    {s.resolvedVersion}
                    {stale && <span style={styles.pinHint}> (pin {s.versionPin})</span>}
                  </span>
                </div>
                <div style={styles.meta}>{s.registryUrl}</div>
                <div style={styles.meta}>
                  {s.sheets.length} sheet{s.sheets.length !== 1 ? "s" : ""} · resolved {s.resolvedAt}
                </div>
                {(() => {
                  const t = trust[subKey(s)];
                  if (!t) return null;
                  // `undefined` (a status this build has no row for) and `null`
                  // (`verified`, deliberately silent) are NOT the same thing, and
                  // `if (!notice)` used to collapse them — so a backend status
                  // this frontend had never heard of rendered exactly like the
                  // reassuring case. An unrecognised trust state is the one that
                  // most deserves to be shown.
                  const notice = TRUST_NOTICE[t.trustStatus];
                  if (notice === undefined) {
                    return (
                      <div style={styles.trustDanger}>
                        {`Unrecognised publisher-trust state '${String(t.trustStatus)}' for ` +
                          `${t.packageName || "this package"}. This build of Calcula cannot ` +
                          `interpret it, so do not treat the package as trusted.`}
                      </div>
                    );
                  }
                  if (notice === null) return null;
                  return (
                    <div style={notice.tone === "danger" ? styles.trustDanger : styles.trustWarn}>
                      {notice.text(t)}
                    </div>
                  );
                })()}
                {(() => {
                  const skip = skips[subKey(s)];
                  if (!skip) return null;
                  const notice = WRITEBACK_SKIP_NOTICE[skip.reason];
                  // Unknown reason: warn rather than render nothing. Silence here
                  // means "your form rules are loaded", which is the one thing a
                  // skip record proves is not true.
                  const text =
                    notice?.text ??
                    `This package's writeback form rules were not loaded ('${skip.reason}'), ` +
                      `so its deadlines and value checks are not in force.`;
                  const tone = notice?.tone ?? "danger";
                  return (
                    <div
                      style={tone === "danger" ? styles.trustDanger : styles.trustWarn}
                      title={skip.detail || undefined}
                    >
                      {text}
                    </div>
                  );
                })()}
                <div style={styles.exportRow}>
                  <span style={styles.exportLabel} title="Open this report without Calcula">
                    Share as:
                  </span>
                  <button
                    onClick={() => handleExport(s, "static", false)}
                    disabled={exporting !== null}
                    style={styles.smallBtn}
                    title="Self-contained HTML report"
                  >
                    {exporting === `${s.packageName}:static` ? "..." : "HTML"}
                  </button>
                  <button
                    onClick={() => handleExport(s, "viewer", false)}
                    disabled={exporting !== null}
                    style={styles.smallBtn}
                    title="Multi-sheet HTML viewer (tabs)"
                  >
                    {exporting === `${s.packageName}:viewer` ? "..." : "Viewer"}
                  </button>
                  <button
                    onClick={() => handleExport(s, "static", true)}
                    disabled={exporting !== null}
                    style={styles.smallBtn}
                    title="Open the print dialog to Save as PDF"
                  >
                    {exporting === `${s.packageName}:pdf` ? "..." : "PDF"}
                  </button>
                </div>
                <div style={{ ...styles.exportRow, flexWrap: "wrap" }}>
                  {confirmingReset === subKey(s) ? (
                    <>
                      <span style={styles.resetWarning}>
                        Discards your changes to this package&apos;s{" "}
                        {s.sheets.length} sheet{s.sheets.length !== 1 ? "s" : ""} (cell
                        edits, formatting, sizes, merges, overrides, pivot layouts) and
                        restores the published v{s.resolvedVersion}. You can undo with
                        Ctrl+Z.
                      </span>
                      <button
                        onClick={() => setConfirmingReset(null)}
                        disabled={resetting !== null}
                        style={styles.smallBtn}
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => handleReset(s)}
                        disabled={resetting !== null}
                        style={{ ...styles.smallBtn, ...styles.danger }}
                      >
                        {resetting === subKey(s) ? "Resetting..." : "Reset"}
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => { setConfirmingReset(subKey(s)); setResetStatus(null); }}
                      disabled={resetting !== null}
                      style={styles.smallBtn}
                      title="Restore this package's sheets to the published content (undoable)"
                    >
                      Reset to published...
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {resetStatus && <div style={styles.resetStatus}>{resetStatus}</div>}

      {subs.length > 0 && (
        <div style={styles.footer}>
          {confirmingDetach ? (
            <>
              <span style={styles.confirmHint}>Detach from all packages?</span>
              <button onClick={() => setConfirmingDetach(false)} style={styles.smallBtn}>Cancel</button>
              <button onClick={handleDetachAll} style={{ ...styles.smallBtn, ...styles.danger }}>Detach all</button>
            </>
          ) : (
            <button onClick={() => setConfirmingDetach(true)} style={styles.smallBtn}>
              Detach all subscriptions
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", fontSize: 13 },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "8px 12px", borderBottom: "1px solid #e0e0e0", flexShrink: 0 },
  headerText: { fontSize: 12, color: "#444", fontWeight: 500 },
  list: { flex: 1, overflowY: "auto", padding: "4px 0" },
  item: { padding: "8px 12px", borderBottom: "1px solid #f0f0f0" },
  itemHeader: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 },
  pkgName: { fontWeight: 600, color: "#333", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const },
  version: { fontSize: 12, color: "#1967d2", flexShrink: 0 },
  pinHint: { color: "#b06000", fontStyle: "italic" as const },
  meta: { fontSize: 11, color: "#888", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const },
  exportRow: { display: "flex", alignItems: "center", gap: 4, marginTop: 6 },
  exportLabel: { fontSize: 11, color: "#666", marginRight: 2 },
  footer: { padding: "8px 12px", borderTop: "1px solid #e0e0e0", display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8, flexShrink: 0 },
  confirmHint: { fontSize: 12, color: "#c5221f", marginRight: "auto" },
  smallBtn: { fontSize: 12, padding: "3px 10px", borderRadius: 4, border: "1px solid #d0d0d0", background: "#fff", cursor: "pointer" },
  danger: { background: "#c5221f", color: "#fff", borderColor: "#c5221f" },
  error: { color: "#c5221f", fontSize: 12, padding: "6px 12px" },
  empty: { padding: "24px 12px", textAlign: "center" as const, color: "#999", fontSize: 12, lineHeight: 1.5 },
  resetWarning: { fontSize: 11, color: "#c5221f", lineHeight: 1.4, flex: 1 },
  resetStatus: { fontSize: 12, color: "green", padding: "6px 12px", borderTop: "1px solid #e0e0e0", flexShrink: 0 },
  trustWarn: { fontSize: 11, color: "#a05a00", background: "#fef7e0", border: "1px solid #f2dcae", borderRadius: 3, padding: "5px 7px", marginTop: 5, lineHeight: 1.45 },
  trustDanger: { fontSize: 11, color: "#c5221f", background: "#fdeceb", border: "1px solid #f3c4c2", borderRadius: 3, padding: "5px 7px", marginTop: 5, lineHeight: 1.45 },
};
