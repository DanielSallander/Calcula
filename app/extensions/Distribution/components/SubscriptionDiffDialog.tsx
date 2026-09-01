// FILENAME: app/extensions/Distribution/components/SubscriptionDiffDialog.tsx
// PURPOSE: Show a subscriber what they have changed relative to the published
//          application — read-only, or as the gate in front of a reset.
// CONTEXT: "Reset to published" discards every local edit on an application's
//          sheets. It used to confirm with a sentence. A sentence is a poor
//          basis for a decision about work you may not remember making, so the
//          same dialog now shows the actual cell-level differences first.
//
//          ONE DIALOG, TWO MODES. The read-only entry ("View changes vs …") and
//          the destructive one ("Reset … to published…") show the identical
//          comparison; only the footer differs. Two dialogs would be two answers
//          to "what have I changed", and they would drift.
//
//          THE DIALOG OWNS THE CONFIRM, and that is not a style choice:
//          `ui.dialogs.show()` returns void, so a menu item cannot await a
//          dialog and then act on the answer. The reset call and its aftermath
//          live here.
//
//   WHAT THIS DIFF CAN AND CANNOT SAY — the honesty contract:
//
//   * Cell VALUES and FORMULAS are compared exactly, per cell, and that is what
//     the list shows.
//   * Formatting, column widths, row heights, merges and pivot definitions are
//     ALSO restored by a reset and are NOT itemised. The diff engine collapses
//     them into per-sheet booleans, and those booleans are not trustworthy at
//     sheet granularity: every published sheet carries the WHOLE workbook style
//     registry (`persistence::Sheet::from_grid` takes `styles.all_styles()`),
//     and registries only ever append — so "styles table changed" is true
//     between essentially any publisher and any subscriber who ever formatted
//     anything, on every sheet. Surfacing that flag would print a warning
//     against sheets nobody touched.
//
//     So the dialog does not surface it, and says the honest thing instead:
//     the cell list is complete, and formatting/layout is restored too but not
//     listed. Understating a destructive act is the failure mode here, and a
//     sentence that always applies beats a flag that is always on.

import React, { useEffect, useState } from "react";
import type { DialogProps } from "@api";
import {
  diffWorkingCopy,
  resetSubscription,
  getSheetProvenance,
  type WorkingCopyDiff,
} from "@api/distribution";
import { useDialogWindow } from "@api/dialogWindow";
import { VersionDiffView } from "./VersionDiffView";
import { announceSubscribedContentReplaced } from "../lib/refreshAftermath";

/** What the caller asked for. `mode` is the only difference between the two. */
export interface SubscriptionDiffRequest {
  registryUrl: string;
  packageName: string;
  resolvedVersion: string;
  mode: "view" | "reset";
}

function readRequest(data: unknown): SubscriptionDiffRequest | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (
    typeof d.registryUrl !== "string" ||
    typeof d.packageName !== "string" ||
    typeof d.resolvedVersion !== "string"
  ) {
    return null;
  }
  return {
    registryUrl: d.registryUrl,
    packageName: d.packageName,
    resolvedVersion: d.resolvedVersion,
    mode: d.mode === "reset" ? "reset" : "view",
  };
}

export function SubscriptionDiffDialog({ onClose, data }: DialogProps) {
  const win = useDialogWindow({ minWidth: 520, minHeight: 360 });
  const req = readRequest(data);

  const [diff, setDiff] = useState<WorkingCopyDiff | null>(null);
  const [sheetCount, setSheetCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    if (!req) {
      setLoading(false);
      setDiffError("This dialog was opened without an application to compare against.");
      return;
    }
    (async () => {
      try {
        // RE-READ THE PROVENANCE, never the module cache: its index map is
        // documented as stale after an insert or a move until the next refresh,
        // and the indices decide which sheets the comparison covers.
        const rows = await getSheetProvenance();
        const mine = rows.filter(
          (r) =>
            r.role === "subscribed" &&
            r.packageName === req.packageName &&
            r.registryUrl === req.registryUrl,
        );
        setSheetCount(mine.length);
        if (mine.length === 0) {
          setDiffError("No sheets in this workbook are tracked by that application any more.");
          return;
        }
        const d = await diffWorkingCopy({
          registryPath: req.registryUrl,
          packageName: req.packageName,
          // A subscriber has no working-copy link, so the base version must be
          // stated: it is the version the subscription resolved to.
          baseVersion: req.resolvedVersion,
          // REQUIRED for a subscriber. An empty list means "the publish
          // default", which for a subscribing workbook is every sheet EXCEPT
          // these — the backend refuses it rather than answering the inverse
          // question.
          sheetIndices: mine.map((r) => r.sheetIndex),
          // Cancels a false "every comment removed": the publish assembly writes
          // comments.json only when this is set, and a reset never touches a
          // comment.
          includeComments: true,
          // Drops a DETACHED sheet (still in the published manifest, gone from
          // the ledger, and skipped by the reset) and any locally-added floating
          // range's backing sheet.
          // The PUBLISHER's ids: a diff row is named by the application's sheet
          // id, not the subscriber's local one.
          scopeSheetIds: mine.map((r) => r.packageSheetId),
        });
        setDiff(d);
      } catch (err: unknown) {
        setDiffError(String(err));
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req?.packageName, req?.registryUrl, req?.resolvedVersion]);

  const handleReset = async () => {
    if (!req) return;
    setResetting(true);
    setError(null);
    try {
      const r = await resetSubscription(req.registryUrl, req.packageName);
      await announceSubscribedContentReplaced();
      setResult(
        `Reset ${req.packageName} to v${r.resolvedVersion}: ${r.sheetsReset} sheet(s), ` +
          `${r.pivotsReset} pivot(s), ${r.overridesCleared} override(s) cleared. ` +
          `Press Ctrl+Z to undo.`,
      );
      setConfirming(false);
    } catch (err: unknown) {
      setError(String(err));
    } finally {
      setResetting(false);
    }
  };

  const windowStyle: React.CSSProperties = {
    position: "fixed",
    left: "50%",
    top: "12%",
    transform: "translateX(-50%)",
    width: "620px",
    maxHeight: "80vh",
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
  const secondary: React.CSSProperties = { color: "var(--text-secondary)" };

  const isReset = req?.mode === "reset";
  const title = result
    ? "Reset Complete"
    : isReset
      ? `Reset to published — ${req?.packageName ?? ""}`
      : `Changes vs ${req?.packageName ?? "application"}`;

  return (
    <div ref={win.ref} style={{ ...windowStyle, ...win.style }}>
      <div style={headerStyle} onMouseDown={win.onHeaderMouseDown}>
        <span style={{ fontWeight: 600 }}>{title}</span>
        <button
          style={{
            background: "transparent",
            border: "none",
            color: "var(--text-secondary)",
            cursor: "pointer",
            padding: "2px 8px",
            fontSize: "14px",
          }}
          onClick={onClose}
          aria-label="Close"
          title="Close"
        >
          ✕
        </button>
      </div>

      <div style={bodyStyle}>
        {result && <p style={{ margin: 0 }}>{result}</p>}

        {!result && (
          <>
            <div style={{ fontSize: "12px", marginBottom: "10px", ...secondary }}>
              Comparing {sheetCount || "your"} sheet(s) from{" "}
              <strong>{req?.packageName}</strong> against the published v
              {req?.resolvedVersion}. Anything listed below is a change{" "}
              <em>you</em> made locally.
            </div>

            {loading && <div>Comparing against the published version…</div>}

            {!loading && diffError && (
              <div
                style={{
                  color: "var(--text-error, #d33)",
                  fontSize: "12px",
                  marginBottom: "10px",
                }}
              >
                {diffError}
                {isReset && (
                  <div style={{ marginTop: 6, ...secondary }}>
                    The comparison could not be built, but the reset itself does not need
                    it. You can still proceed — you just will not see the list first.
                  </div>
                )}
              </div>
            )}

            {!loading && diff && <VersionDiffView diff={diff.diff} />}

            {/* THE GAP, STATED. Cell values are exact; the rest is restored and
                not itemised. See the file header for why the engine's
                formatting flags are not surfaced instead. */}
            {!loading && (
              <div
                style={{
                  fontSize: "11px",
                  marginTop: "12px",
                  padding: "8px",
                  border: "1px solid var(--border-default)",
                  borderRadius: "4px",
                  ...secondary,
                }}
              >
                Cell values and formulas are listed in full above.{" "}
                {isReset ? "A reset also restores" : "A reset would also restore"} cell
                formatting, column widths, row heights, merged regions and the
                application&rsquo;s pivot definitions on these sheets, and clears your
                overrides — none of which is itemised here. An empty list above does not
                mean nothing would change.
              </div>
            )}

            {error && (
              <div
                style={{ color: "var(--text-error, #d33)", fontSize: "12px", marginTop: 8 }}
              >
                {error}
              </div>
            )}
          </>
        )}
      </div>

      {confirming && !result && (
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
          Everything listed above, and the formatting and layout that is not listed, goes
          back to the published v{req?.resolvedVersion} on all {sheetCount} sheet(s) from{" "}
          <strong>{req?.packageName}</strong>. Sheets you created yourself are untouched.
          This is one undo step — Ctrl+Z brings your work back.
        </div>
      )}

      <div style={footerStyle}>
        {result ? (
          <button onClick={onClose}>Close</button>
        ) : isReset ? (
          confirming ? (
            <>
              <button onClick={() => setConfirming(false)} disabled={resetting}>
                Back
              </button>
              <button
                onClick={() => void handleReset()}
                disabled={resetting}
                style={{ fontWeight: 600 }}
              >
                {resetting ? "Resetting…" : "Yes, reset to published"}
              </button>
            </>
          ) : (
            <>
              <button onClick={onClose}>Cancel</button>
              <button
                onClick={() => setConfirming(true)}
                disabled={loading}
                style={{ fontWeight: 600 }}
              >
                Reset to published…
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
