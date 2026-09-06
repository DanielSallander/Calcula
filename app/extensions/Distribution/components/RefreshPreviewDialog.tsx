// FILENAME: app/extensions/Distribution/components/RefreshPreviewDialog.tsx
// PURPOSE: Preview a refresh, resolve its conflicts cell by cell, confirm, apply.
// CONTEXT: Non-modal like Publish/Subscribe — no backdrop, the workbook stays
// interactive (inspect sheets while deciding); movable + resizable via
// @api/dialogWindow; closes via its own buttons (dismissOnEscape false).
//
// THREE THINGS THIS DIALOG DID WRONG, all reported from live testing:
//
// 1. "I clicked refresh and nothing happened." The versions matched, so the
//    preview was empty and this said "All subscriptions are up to date" with no
//    Apply button — a true sentence that answers a question the user was not
//    asking. They had edited a subscribed sheet and wanted the published values
//    back. That is `calp_reset_subscription`, and it was reachable only from a
//    task pane you had to know about. The up-to-date state now offers it.
//
// 2. "Apply Refresh" was ONE UNCONFIRMED CLICK that replaced whole grids. There
//    is now a confirm strip that names what will be lost, INLINE rather than via
//    confirmAsync, because the whole point of the gate is that the conflict list
//    stays on screen while the user decides.
//
// 3. The conflicts were a number with no way to act on it — and a WRONG number:
//    the backend counted every override on a changed sheet. It now reports the
//    real per-cell conflicts, and each one gets base/mine/theirs and a choice.
//    Default is "keep mine", which is exactly what a refresh has always done, so
//    a user who ignores the list gets the old behaviour.

import React, { useState, useEffect, useMemo, useCallback } from "react";
import type { DialogProps } from "@api";
import {
  refreshPreview,
  refreshApply,
  emitAppEvent,
  ENVIRONMENTS_CHANGED_EVENT,
  AppEvents,
  type ApplicationUpdatedPayload,
  type RefreshPreview,
  type CellResolution,
  type ConflictPreviewCell,
} from "@api";
import {
  getSubscriptions,
  resetSubscription,
  setSubscriptionEnvironment,
  listApplicationsInWorkspace,
  type Subscription,
} from "@api/distribution";
import { confirmAsync } from "@api/dialogs";
import { useDialogWindow } from "@api/dialogWindow";
import { ThreeWayRow, type RowChoice } from "./ThreeWayRow";
import { announceSubscribedContentReplaced } from "../lib/refreshAftermath";
import { describeRefreshCard, formatSubscriptionTarget } from "../lib/environments";

/** Stable key for one conflicted cell. */
const cellKey = (c: ConflictPreviewCell) => `${c.localSheetId}:${c.cellId}`;

export function RefreshPreviewDialog({ onClose, data }: DialogProps) {
  const win = useDialogWindow({ minWidth: 460, minHeight: 320 });
  const [preview, setPreview] = useState<RefreshPreview | null>(null);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [resetting, setResetting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  /** cellKey -> choice. Absent means "keep mine", the default. */
  const [choices, setChoices] = useState<Record<string, RowChoice>>({});

  /**
   * Recompute the preview.
   *
   * Also the aftermath of switching an environment: switching PULLS NOTHING, so
   * the only honest thing to do is re-run the preview and let the user look at
   * what the new target would bring before applying it. Anything else would
   * turn a two-word choice into an unreviewed content change.
   */
  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Both in one call site: the up-to-date state needs subscription names and
      // versions to offer a reset, and a second round trip could disagree
      // with the preview about which subscriptions exist.
      const [p, manifest] = await Promise.all([
        refreshPreview(),
        getSubscriptions().catch(() => null),
      ]);
      setPreview(p);
      setSubscriptions(manifest?.subscriptions ?? []);
    } catch (err: unknown) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    // RE-READ ON EVERY SHOW. With `[]` this ran once per mount, and the dialog
    // is non-modal — so choosing "Refresh Subscriptions…" again while it was
    // still open did nothing at all: no refetch, and `result` still holding the
    // previous run's "Refresh Complete" sentence. The menu item looked broken
    // for the same reason the original Push button did.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.__openCount]);

  /** Notices the user answered "Not now" to, for this showing only. */
  const [dismissedNotices, setDismissedNotices] = useState<Set<string>>(new Set());
  const [switching, setSwitching] = useState<string | null>(null);

  // Everything a fresh show must forget.
  const openCount = data?.__openCount;
  useEffect(() => {
    setResult(null);
    setError(null);
    setConfirming(false);
    setChoices({});
    setDismissedNotices(new Set());
    setLoading(true);
  }, [openCount]);

  const conflicts: ConflictPreviewCell[] = useMemo(
    () => (preview?.subscriptionPreviews ?? []).flatMap((sp) => sp.conflicts ?? []),
    [preview],
  );
  const unexamined = useMemo(
    () => (preview?.subscriptionPreviews ?? []).flatMap((sp) => sp.unexaminedSheets ?? []),
    [preview],
  );
  const takingTheirs = conflicts.filter((c) => choices[cellKey(c)] === "takeTheirs").length;

  const hasUpdates = !!preview && preview.subscriptionPreviews.length > 0;
  // A PARTIAL LIST MAY NOT BE PRESENTED AS A COMPLETE SET OF DECISIONS. If a
  // sheet could not be read, some conflicts are unknown, and applying would
  // silently resolve them as "keep mine" without ever showing them.
  const blocked = !!preview && !preview.conflictsExact;

  /**
   * Subscriptions whose target could not be resolved at all — the environment
   * was removed from the pipeline, or is empty, or the promotion log did not
   * verify.
   *
   * These BLOCK Apply. A refresh is one gesture over every subscription in the
   * workbook, and applying while one of them silently sat out would leave that
   * report on an old version with nothing on screen having said so. One
   * degraded row, one blocked button, and the row says which and why.
   */
  const unavailable = preview?.unavailable ?? [];
  /**
   * Line subscriptions on applications that have since grown a pipeline.
   *
   * NOT auto-switched. Moving somebody's subscription because their publisher
   * added environments would change what they receive without their asking; the
   * notice offers the switch and takes "Not now" for an answer.
   */
  const notices = (preview?.environmentNotices ?? []).filter(
    (n) => !dismissedNotices.has(`${n.packageName}@${n.registryUrl}`),
  );

  const handleApply = async () => {
    setApplying(true);
    setConfirming(false);
    setError(null);
    try {
      const resolutions: CellResolution[] = conflicts.map((c) => ({
        sheetId: c.localSheetId,
        cellId: c.cellId,
        choice: choices[cellKey(c)] ?? "keepMine",
      }));
      // EXACTLY WHAT THIS DIALOG SHOWED. The preview is computed once, on
      // mount, and the dialog is deliberately non-modal so the user can inspect
      // sheets while deciding — so the workspace can move under them. Echoing
      // the versions back lets the backend refuse rather than apply their
      // decisions to values they were never shown.
      const previewedVersions = (preview?.subscriptionPreviews ?? []).map((sp) => ({
        registryUrl: sp.registryUrl,
        packageName: sp.packageName,
        newVersion: sp.newVersion,
      }));
      const r = await refreshApply({ resolutions, previewedVersions });

      // Pivots, recalc, sheet list, grid, controls — in the one order that
      // works. This used to be three of those five, and the two it was missing
      // were the pivot redraw (a refreshed sheet's pivot region went BLANK,
      // because published content ships with pivot output stripped) and the
      // sheet-list announcement.
      await announceSubscribedContentReplaced();

      // Announce the distribution lifecycle: the refresh may have replaced
      // distributed scripts with new application versions (reload them so changed
      // sources re-prompt for consent — ScriptableObjects de-dupes unchanged
      // ones by source hash), swapped chart libraries, or moved sheets. One
      // event PER refreshed subscription, so a subscriber that only cares about
      // its own application can filter; scripts see a thinned {packageName, version}.
      for (const sub of preview?.subscriptionPreviews ?? []) {
        emitAppEvent(AppEvents.PACKAGE_UPDATED, {
          packageName: sub.packageName,
          version: sub.newVersion,
          kind: "refresh",
          sheetsPulled: sub.sheetsAdded.length,
          // A refresh replaces script SOURCES in place and the backend reports
          // only totals, so there is no honest per-subscription count here.
          scriptsPulled: null,
        } satisfies ApplicationUpdatedPayload);
      }

      const took = resolutions.filter((x) => x.choice === "takeTheirs").length;
      setResult(
        `Refreshed ${r.subscriptionsRefreshed} subscription(s). ` +
          `${r.sheetsAdded} added, ${r.sheetsUpdated} updated, ${r.sheetsRemoved} removed. ` +
          (took > 0 ? `${took} cell(s) took the published value. ` : "") +
          `${r.conflictsCreated} unresolved conflict(s).`,
      );
    } catch (err: unknown) {
      setError(String(err));
    } finally {
      setApplying(false);
    }
  };

  const handleReset = async (s: Subscription) => {
    // confirmAsync IS right here, unlike the Apply gate: there is no list on
    // screen to keep visible, and this discards work with no per-cell choice.
    // Never the `confirm` global — under Tauri that returns a Promise, so the
    // guard would never fire. Fails CLOSED.
    const ok = await confirmAsync(
      `Discard your local changes to the sheets from "${s.packageName}" and restore ` +
        `the published v${s.resolvedVersion}?\n\n` +
        `Every cell, format, size and merge on those sheets goes back to what the ` +
        `publisher shipped, and your overrides on them are cleared. This is one ` +
        `undo step — Ctrl+Z brings it back.`,
      { title: "Reset to published" },
    );
    if (!ok) return;
    setResetting(s.packageName);
    setError(null);
    try {
      const r = await resetSubscription(s.registryUrl, s.packageName);
      await announceSubscribedContentReplaced();
      setResult(
        `Reset ${s.packageName} to v${r.resolvedVersion}: ${r.sheetsReset} sheet(s), ` +
          `${r.pivotsReset} pivot(s), ${r.overridesCleared} override(s) cleared. ` +
          `Press Ctrl+Z to undo.`,
      );
    } catch (err: unknown) {
      setError(String(err));
    } finally {
      setResetting(null);
    }
  };

  const windowStyle: React.CSSProperties = {
    position: "fixed",
    left: "50%",
    top: "14%",
    transform: "translateX(-50%)",
    width: "520px",
    maxHeight: "78vh",
    zIndex: 1050,
    display: "flex",
    flexDirection: "column",
    background: "var(--panel-bg)",
    color: "var(--text-primary)",
    border: "1px solid var(--border-default)",
    borderRadius: "8px",
    boxShadow: "0 12px 40px rgba(0, 0, 0, 0.5)",
    fontFamily: '"Segoe UI", system-ui, sans-serif',
    fontSize: "13px",
  };
  const headerStyle: React.CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "8px 12px",
    flexShrink: 0,
    cursor: "grab",
    userSelect: "none",
    borderBottom: "1px solid var(--border-default)",
  };
  const closeButtonStyle: React.CSSProperties = {
    background: "transparent",
    border: "none",
    color: "var(--text-secondary)",
    cursor: "pointer",
    padding: "2px 8px",
    borderRadius: "4px",
    fontSize: "14px",
    lineHeight: 1,
  };
  const bodyStyle: React.CSSProperties = {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    padding: "12px 16px",
  };
  const footerStyle: React.CSSProperties = {
    display: "flex",
    justifyContent: "flex-end",
    gap: "8px",
    padding: "10px 16px",
    flexShrink: 0,
    borderTop: "1px solid var(--border-default)",
  };
  const listBoxStyle: React.CSSProperties = {
    border: "1px solid var(--border-default)",
    borderRadius: "3px",
    maxHeight: "240px",
    overflowY: "auto",
  };
  const secondary: React.CSSProperties = { color: "var(--text-secondary)" };

  const title = result
    ? "Refresh Complete"
    : error && !preview
      ? "Refresh Failed"
      : !loading && !hasUpdates
        ? "No Updates Available"
        : "Refresh Preview";

  const showApply = !loading && !result && !(error && !preview) && hasUpdates;

  return (
    <div ref={win.ref} style={{ ...windowStyle, ...win.style }}>
      <div style={headerStyle} onMouseDown={win.onHeaderMouseDown}>
        <span style={{ fontWeight: 600 }}>{title}</span>
        <button style={closeButtonStyle} onClick={onClose} aria-label="Close" title="Close">
          ✕
        </button>
      </div>

      <div style={bodyStyle}>
        {loading && <div>Computing refresh preview...</div>}

        {!loading && result && <p style={{ margin: 0 }}>{result}</p>}

        {!loading && !result && error && !preview && (
          <div style={{ color: "var(--text-error, #d33)", fontSize: "12px" }}>{error}</div>
        )}

        {/* THE FRONT DOOR. "Up to date" used to be the end of the conversation.
            It is now the place where the other verb lives, because this is
            exactly where a user who wanted it ends up. */}
        {!loading && !result && !(error && !preview) && !hasUpdates && (
          <>
            <p style={{ margin: "0 0 8px 0" }}>
              All subscriptions are on the latest published version.
            </p>
            <p style={{ margin: "0 0 12px 0", fontSize: "12px", ...secondary }}>
              Refresh brings in a <strong>newer version</strong> from the workspace. It does
              not undo your own edits — if you changed cells on a subscribed sheet and want
              the published values back, reset the subscription instead.
            </p>
            {subscriptions.length === 0 && (
              <div style={{ fontSize: "12px", ...secondary }}>
                This workbook has no subscriptions.
              </div>
            )}
            {subscriptions.map((s) => (
              <div
                key={`${s.packageName}@${s.registryUrl}`}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "8px",
                  padding: "6px 8px",
                  marginBottom: "6px",
                  border: "1px solid var(--border-default)",
                  borderRadius: "4px",
                }}
              >
                <span style={{ minWidth: 0 }}>
                  <span style={{ fontWeight: 600 }}>{s.packageName}</span>
                  <span style={{ fontSize: "11px", marginLeft: 6, ...secondary }}>
                    v{s.resolvedVersion}
                  </span>
                </span>
                <button
                  onClick={() => void handleReset(s)}
                  disabled={resetting !== null}
                  style={{ whiteSpace: "nowrap" }}
                >
                  {resetting === s.packageName ? "Resetting..." : "Reset to published..."}
                </button>
              </div>
            ))}
            {error && (
              <div style={{ color: "var(--text-error, #d33)", fontSize: "12px", marginTop: 8 }}>
                {error}
              </div>
            )}
          </>
        )}

        {/* CANNOT BE RESOLVED AT ALL. Rendered before anything else and
            outside the `hasUpdates` branch, because a workbook whose only
            subscription is stranded has no updates to show and would otherwise
            read as "all up to date". */}
        {!loading && !result && unavailable.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            {unavailable.map((u) => (
              <div
                key={`${u.packageName}@${u.registryUrl}`}
                style={{
                  padding: "8px",
                  marginBottom: "8px",
                  borderRadius: 4,
                  background: "#fdeceb",
                  color: "#c5221f",
                  lineHeight: 1.4,
                  fontSize: "12px",
                }}
              >
                <div style={{ fontWeight: 600 }}>
                  {formatSubscriptionTarget(u.packageName, u.environment)} cannot be
                  refreshed
                </div>
                <div style={{ marginTop: 2 }}>{u.reason}</div>
                <div style={{ marginTop: 6 }}>
                  <EnvironmentSwitcher
                    registryUrl={u.registryUrl}
                    packageName={u.packageName}
                    current={u.environment ?? null}
                    busy={switching}
                    setBusy={setSwitching}
                    onSwitched={reload}
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* A PIPELINE APPEARED. The subscription still works — it follows the
            line — so this is a notice, not a block, and "Not now" is a real
            answer that lasts the rest of this showing. */}
        {!loading && !result && notices.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            {notices.map((n) => (
              <div
                key={`${n.packageName}@${n.registryUrl}`}
                style={{
                  padding: "8px",
                  marginBottom: "8px",
                  borderRadius: 4,
                  background: "#fff3cd",
                  color: "#664d03",
                  lineHeight: 1.4,
                  fontSize: "12px",
                }}
              >
                <div>
                  <strong>{n.packageName}</strong> follows the development line, but the
                  application now has environments ({n.environments.join(", ")}). The
                  development line receives every push the moment it lands, including work
                  that has not been released.
                </div>
                <div style={{ marginTop: 6, display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <EnvironmentSwitcher
                    registryUrl={n.registryUrl}
                    packageName={n.packageName}
                    current={null}
                    environments={n.environments}
                    busy={switching}
                    setBusy={setSwitching}
                    onSwitched={reload}
                  />
                  <button
                    onClick={() =>
                      setDismissedNotices((prev) =>
                        new Set(prev).add(`${n.packageName}@${n.registryUrl}`),
                      )
                    }
                  >
                    Not now
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {!loading && !result && hasUpdates && preview && (
          <>
            {preview.subscriptionPreviews.map((sp) => (
              <div
                key={sp.packageName}
                style={{
                  marginBottom: "12px",
                  padding: "8px",
                  border: "1px solid var(--border-default)",
                  borderRadius: "4px",
                }}
              >
                <div style={{ fontWeight: 600 }}>
                  {formatSubscriptionTarget(sp.packageName, sp.environment)}
                </div>
                {/* THE DIRECTION IS IN THE WORDS. A subscriber who reads a
                    downgrade as an update concludes the publisher changed those
                    cells; what actually happened is that a known-good version
                    was restored, and the conflicts below are against the OLDER
                    content. */}
                <div
                  style={{
                    fontSize: "12px",
                    ...(sp.isRollback
                      ? { color: "#664d03", fontWeight: 600 }
                      : secondary),
                  }}
                >
                  {
                    describeRefreshCard({
                      packageName: sp.packageName,
                      environment: sp.environment,
                      currentVersion: sp.currentVersion,
                      newVersion: sp.newVersion,
                    }).versions
                  }
                </div>
                {sp.isRollback && (
                  <div
                    style={{
                      fontSize: "12px",
                      background: "#fff3cd",
                      color: "#664d03",
                      padding: "4px 6px",
                      borderRadius: 3,
                      margin: "4px 0",
                      lineHeight: 1.4,
                    }}
                  >
                    {sp.environment ?? "This application"} was rolled back to a version
                    published earlier. Cells you edited keep their overrides.
                  </div>
                )}
                {sp.sheetsAdded.length > 0 && (
                  <div style={{ fontSize: "12px", color: "green" }}>
                    + {sp.sheetsAdded.length} sheet(s) added:{" "}
                    {sp.sheetsAdded.map((s) => s.name).join(", ")}
                  </div>
                )}
                {sp.sheetsRemoved.length > 0 && (
                  <div style={{ fontSize: "12px", color: "var(--text-error, #d33)" }}>
                    - {sp.sheetsRemoved.length} sheet(s) removed:{" "}
                    {sp.sheetsRemoved.map((s) => s.name).join(", ")}
                  </div>
                )}
                {sp.sheetsUpdated.length > 0 && (
                  <div style={{ fontSize: "12px" }}>
                    ~ {sp.sheetsUpdated.length} sheet(s) updated
                    {sp.cellsChanged > 0 && (
                      <>
                        {", "}
                        {sp.cellsChangedExact ? "" : "at least "}
                        {sp.cellsChanged} cell(s) changed
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}

            {/* WHAT A REFRESH DESTROYS, said out loud. The grid is replaced
                wholesale; only recorded cell overrides are put back. */}
            <div style={{ fontSize: "12px", marginBottom: "10px", ...secondary }}>
              Updated sheets are replaced with the published content. Your edited cell
              values are kept; formatting, conditional formats, validations, comments and
              notes on those sheets are not.
            </div>

            {blocked && (
              <div
                style={{
                  fontSize: "12px",
                  color: "var(--text-error, #d33)",
                  border: "1px solid var(--text-error, #d33)",
                  borderRadius: "4px",
                  padding: "8px",
                  marginBottom: "10px",
                }}
              >
                {unexamined.length} sheet(s) could not be read, so this list may be missing
                conflicts:{" "}
                {unexamined.map((u) => u.sheetName).join(", ")}. Applying now would resolve
                the ones you cannot see without asking. Check the workspace is reachable and
                reopen this dialog.
              </div>
            )}

            {conflicts.length > 0 && (
              <>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: "4px",
                  }}
                >
                  <span style={{ fontWeight: 600 }}>
                    {conflicts.length} cell(s) changed on both sides
                  </span>
                  <span style={{ display: "flex", gap: "4px" }}>
                    <button
                      style={{ fontSize: "11px" }}
                      onClick={() => setChoices({})}
                      title="Every conflicted cell keeps your value"
                    >
                      Keep all mine
                    </button>
                    <button
                      style={{ fontSize: "11px" }}
                      onClick={() =>
                        setChoices(
                          Object.fromEntries(
                            conflicts.map((c) => [cellKey(c), "takeTheirs" as RowChoice]),
                          ),
                        )
                      }
                      title="Every conflicted cell takes the published value"
                    >
                      Take all theirs
                    </button>
                  </span>
                </div>
                <div style={{ fontSize: "11px", marginBottom: "6px", ...secondary }}>
                  You edited these cells and so did the publisher. Anything you leave on
                  &ldquo;keep mine&rdquo; stays yours and stays flagged in the Overrides pane.
                </div>
                <div style={listBoxStyle}>
                  {conflicts.map((c) => (
                    <ThreeWayRow
                      key={cellKey(c)}
                      mode="choose"
                      a1={c.a1}
                      sheetName={c.sheetName}
                      baseline={c.baseline}
                      current={c.current}
                      upstreamNew={c.upstreamNew}
                      conflict
                      choice={choices[cellKey(c)] ?? "keepMine"}
                      onChoose={(ch) =>
                        setChoices((prev) => ({ ...prev, [cellKey(c)]: ch }))
                      }
                    />
                  ))}
                </div>
              </>
            )}

            {error && (
              <div
                style={{
                  color: "var(--text-error, #d33)",
                  marginTop: "8px",
                  fontSize: "12px",
                }}
              >
                {error}
              </div>
            )}
          </>
        )}
      </div>

      {/* THE CONFIRM IS INLINE, not confirmAsync. The whole value of the gate is
          that the conflict list stays on screen while the user reads what they
          are about to lose. */}
      {confirming && (
        <div
          style={{
            padding: "10px 16px",
            borderTop: "1px solid var(--border-default)",
            background: "var(--conflict-bg, #fff3cd)",
            color: "var(--conflict-text, #856404)",
            fontSize: "12px",
            flexShrink: 0,
          }}
        >
          Applying replaces {preview?.totalSheetsAdded ?? 0} added and{" "}
          {preview?.subscriptionPreviews.reduce((n, s) => n + s.sheetsUpdated.length, 0) ?? 0}{" "}
          updated sheet(s) with the published content.
          {takingTheirs > 0 && (
            <>
              {" "}
              <strong>{takingTheirs} of your edited cell(s) will be discarded</strong> in
              favour of the published value.
            </>
          )}{" "}
          This is not undoable.
        </div>
      )}

      <div style={footerStyle}>
        {showApply ? (
          confirming ? (
            <>
              <button onClick={() => setConfirming(false)}>Back</button>
              <button
                onClick={() => void handleApply()}
                disabled={applying}
                style={{ fontWeight: 600 }}
              >
                {applying ? "Applying..." : "Yes, apply"}
              </button>
            </>
          ) : (
            <>
              <button onClick={onClose}>Cancel</button>
              <button
                onClick={() => setConfirming(true)}
                disabled={applying || blocked || unavailable.length > 0}
                title={
                  unavailable.length > 0
                    ? "One or more subscriptions point at an environment that cannot be resolved — pick another first"
                    : blocked
                      ? "Some sheets could not be read, so the conflict list is incomplete"
                      : undefined
                }
                style={{ fontWeight: 600 }}
              >
                Apply Refresh...
              </button>
            </>
          )
        ) : (
          <button onClick={onClose}>Close</button>
        )}
      </div>

      {win.resizeHandles}
    </div>
  );
}


/**
 * Move one subscription onto a different environment (or back to the line).
 *
 * PULLS NOTHING — `calp_set_subscription_environment` records intent and stops.
 * The caller re-runs the preview, so the content change is still reviewed and
 * still applied by the user's own hand.
 *
 * The environment list is read from the WORKSPACE rather than passed in, except
 * where the caller already has it: a stranded subscription's whole problem is
 * that the name it holds is not in the pipeline any more, so the list it needs
 * is the one that exists now.
 */
function EnvironmentSwitcher({
  registryUrl,
  packageName,
  current,
  environments,
  busy,
  setBusy,
  onSwitched,
}: {
  registryUrl: string;
  packageName: string;
  current: string | null;
  environments?: string[];
  busy: string | null;
  setBusy: (v: string | null) => void;
  onSwitched: () => void | Promise<void>;
}): React.ReactElement {
  const key = `${packageName}@${registryUrl}`;
  const [options, setOptions] = useState<string[]>(environments ?? []);
  const [choice, setChoice] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (environments) {
      setOptions(environments);
      return;
    }
    let cancelled = false;
    listApplicationsInWorkspace(registryUrl)
      .then((apps) => {
        if (cancelled) return;
        const app = apps.find((a) => a.name === packageName);
        setOptions((app?.environments ?? []).filter((e) => e.version).map((e) => e.name));
      })
      .catch(() => {
        if (!cancelled) setOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [registryUrl, packageName, environments]);

  // Default to the LAST — production by convention.
  useEffect(() => {
    if (!choice && options.length > 0) setChoice(options[options.length - 1]);
  }, [choice, options]);

  const apply = async (target: string | null) => {
    setBusy(key);
    setErr(null);
    try {
      await setSubscriptionEnvironment({
        registryUrl,
        packageName,
        environment: target,
        // Returning to the LINE needs a pin, because the line has no pointer to
        // follow. "latest" is what a line subscription meant before
        // environments existed.
        versionPin: target === null ? "latest" : "",
      });
      // See the Subscriptions pane: the status chip and tab tooltips follow
      // this event, not the preview reload.
      emitAppEvent(ENVIRONMENTS_CHANGED_EVENT, { registryPath: registryUrl, packageName });
      await onSwitched();
    } catch (e: unknown) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      {options.length > 0 ? (
        <>
          <select
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
            disabled={busy !== null}
          >
            {options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
          <button onClick={() => void apply(choice)} disabled={busy !== null || !choice}>
            {busy === key ? "Switching…" : `Use ${choice}`}
          </button>
        </>
      ) : (
        <span>This application has no environment with a version in it.</span>
      )}
      {current !== null && (
        <button onClick={() => void apply(null)} disabled={busy !== null}>
          Follow the development line
        </button>
      )}
      {err && <span style={{ color: "#c5221f" }}>{err}</span>}
    </span>
  );
}
