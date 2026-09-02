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

import React, { useState, useEffect, useMemo } from "react";
import type { DialogProps } from "@api";
import {
  refreshPreview,
  refreshApply,
  emitAppEvent,
  AppEvents,
  type ApplicationUpdatedPayload,
  type RefreshPreview,
  type CellResolution,
  type ConflictPreviewCell,
} from "@api";
import { getSubscriptions, resetSubscription, type Subscription } from "@api/distribution";
import { confirmAsync } from "@api/dialogs";
import { useDialogWindow } from "@api/dialogWindow";
import { ThreeWayRow, type RowChoice } from "./ThreeWayRow";
import { announceSubscribedContentReplaced } from "../lib/refreshAftermath";

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

  useEffect(() => {
    (async () => {
      try {
        // Both in one effect: the up-to-date state needs subscription names and
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
    })();
    // RE-READ ON EVERY SHOW. With `[]` this ran once per mount, and the dialog
    // is non-modal — so choosing "Refresh Subscriptions…" again while it was
    // still open did nothing at all: no refetch, and `result` still holding the
    // previous run's "Refresh Complete" sentence. The menu item looked broken
    // for the same reason the original Push button did.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.__openCount]);

  // Everything a fresh show must forget.
  const openCount = data?.__openCount;
  useEffect(() => {
    setResult(null);
    setError(null);
    setConfirming(false);
    setChoices({});
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
      const r = await refreshApply({ resolutions });

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
                <div style={{ fontWeight: 600 }}>{sp.packageName}</div>
                <div style={{ fontSize: "12px", ...secondary }}>
                  {sp.currentVersion} {"->"} {sp.newVersion}
                </div>
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
                disabled={applying || blocked}
                title={
                  blocked
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
