// FILENAME: app/extensions/Distribution/components/PromoteDialog.tsx
// PURPOSE: Move one environment's pointer — forward as a promotion, back to a
//          version it held before as a rollback — with the diff every subscriber
//          of that environment is about to see.
// CONTEXT: "Promote to prod" is one click that changes what an entire audience
//          receives. The only question worth answering before it is WHAT WILL
//          THEY SEE CHANGE, so this dialog answers it in cells, not in adjectives.
//
//          THE DIFF IS FROM THE TARGET'S OWN POINTER, not from the source's.
//          Promoting v1.5.0 from test into a prod sitting on v1.2.0 is a
//          v1.2.0 → v1.5.0 change for prod's subscribers, even though test only
//          ever moved by one version. Diffing source-to-target would show a
//          change nobody experiences and hide three that everybody does.
//
//          THE DIALOG OWNS THE CONFIRM. `ui.dialogs.show()` returns void, so the
//          panel that opened this cannot await an answer; the call, the refusal
//          handling and the aftermath all live here.
//
//          A ROLLBACK IS THE SAME COMMAND. Same gates, same signature, same log
//          — only the presentation differs, and it differs loudly: amber, the
//          word OLDER, and a version list restricted to what this environment
//          has actually held. Offering "any older version" would be offering an
//          untested promotion wearing a rollback's clothes.

import React, { useCallback, useEffect, useState } from "react";
import type { DialogProps } from "@api";
import {
  diffVersions,
  diffSheetCells,
  listEnvironments,
  promoteEnvironment,
  promotionImpact,
  emitAppEvent,
  ENVIRONMENTS_CHANGED_EVENT,
  type CellDiff,
  type EnvironmentPointer,
  type EnvironmentsResponse,
  type VersionDiff,
} from "@api";
import { confirmAsync } from "@api/dialogs";
import { useDialogWindow } from "@api/dialogWindow";
import { VersionDiffView } from "./VersionDiffView";
import {
  describePromotion,
  isRollback,
  promotionSource,
  rollbackCandidates,
} from "../lib/environments";
import { errorTextStyle, mutedStyle, warnBoxStyle } from "./explorerStyles";

export interface PromoteRequest {
  registryPath: string;
  packageName: string;
  environment: string;
  /**
   * `repair` re-promotes the version the environment ALREADY holds.
   *
   * That is not a no-op: it replaces a pointer whose promoter has since been
   * removed from the publisher list with one signed by somebody who may publish
   * today, which is the only way to make subscribers follow it again.
   */
  mode: "promote" | "rollback" | "repair";
}

function readRequest(data: unknown): PromoteRequest | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (
    typeof d.registryPath !== "string" ||
    typeof d.packageName !== "string" ||
    typeof d.environment !== "string"
  ) {
    return null;
  }
  return {
    registryPath: d.registryPath,
    packageName: d.packageName,
    environment: d.environment,
    mode:
      d.mode === "rollback" ? "rollback" : d.mode === "repair" ? "repair" : "promote",
  };
}

export function PromoteDialog({ onClose, data }: DialogProps) {
  const win = useDialogWindow({ minWidth: 560, minHeight: 400 });
  const req = readRequest(data);

  const [info, setInfo] = useState<EnvironmentsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [promoting, setPromoting] = useState(false);

  /** Rollback only: which held version to go back to. */
  const [chosenVersion, setChosenVersion] = useState<string>("");

  const [diff, setDiff] = useState<VersionDiff | null>(null);
  const [diffing, setDiffing] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [drilled, setDrilled] = useState<
    Record<string, { rows: CellDiff[]; total: number; truncated: boolean }>
  >({});

  /**
   * What this promotion does to data already COLLECTED in this environment.
   *
   * A promotion is a version change for everyone subscribed to it, so it
   * inherits every rule a version change has always had for writeback: a moved
   * or resized region invalidates strict submissions, a removed one orphans
   * them. The promoter is the person deciding, so the promoter is the person who
   * has to see it — the subscribers' own refresh preview says it too, but that
   * is after the fact and on somebody else's screen.
   */
  const [impact, setImpact] = useState<string>("");

  /**
   * EVERY SHOW STARTS CLEAN.
   *
   * `DialogContainer` keys by dialog id, so opening this for `prod` right after
   * `test` does not remount it. Without this the second open would render the
   * first environment's diff and, worse, carry the first environment's
   * `expectedCurrent` into a promotion of the second.
   */
  const openCount = data?.__openCount;
  useEffect(() => {
    setInfo(null);
    setImpact("");
    setResult(null);
    setError(null);
    setLoadError(null);
    setDiff(null);
    setDiffError(null);
    setDrilled({});
    setChosenVersion("");
    setLoading(true);
  }, [openCount]);

  const load = useCallback(async () => {
    if (!req) {
      setLoading(false);
      setLoadError("This window was opened without an application.");
      return;
    }
    setLoading(true);
    try {
      const next = await listEnvironments({
        registryPath: req.registryPath,
        packageName: req.packageName,
      });
      setInfo(next);
      setLoadError(null);
    } catch (e: unknown) {
      setLoadError(String(e));
      setInfo(null);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req?.registryPath, req?.packageName, openCount]);

  useEffect(() => {
    void load();
  }, [load]);

  const target: EnvironmentPointer | null =
    info?.environments.find((e) => e.name === req?.environment) ?? null;
  const currentVersion = target?.version ?? null;
  const candidates = target ? rollbackCandidates(target) : [];

  // What is being promoted. In promote mode it is the natural source's version —
  // the line's head for the first environment, the previous environment's
  // pointer otherwise — exactly what the backend would pick, computed here so
  // the dialog can NAME it before the click rather than after.
  const source =
    info && target
      ? promotionSource(info.environments, info.headVersion, target.name)
      : { label: "", version: "" };
  // A REPAIR TARGETS THE POINTER'S OWN VERSION. Nothing moves; what changes is
  // who signed the record that put it there.
  const toVersion =
    req?.mode === "rollback"
      ? chosenVersion
      : req?.mode === "repair"
        ? (currentVersion ?? "")
        : source.version;

  // Default the rollback select to the most recent held version.
  useEffect(() => {
    if (req?.mode !== "rollback") return;
    // Seed it, and RECONCILE it after a stale re-read: the candidate list is
    // rebuilt from the refreshed log, and a selection no longer in it left the
    // select displaying a version the header was not talking about.
    if (candidates.length === 0) {
      if (chosenVersion) setChosenVersion("");
      return;
    }
    if (!chosenVersion || !candidates.includes(chosenVersion)) {
      setChosenVersion(candidates[0]);
    }
  }, [req?.mode, chosenVersion, candidates]);

  // The diff every subscriber of THIS environment will experience.
  useEffect(() => {
    if (!req || !currentVersion || !toVersion || currentVersion === toVersion) {
      setDiff(null);
      setDiffError(null);
      // AND THE IMPACT BANNER. Without this a "nothing to move" state rendered
      // under a "Data already collected" warning left over from the previous
      // target, which is a warning about a promotion that is not happening.
      setImpact("");
      return;
    }
    let cancelled = false;
    setDiffing(true);
    setDiffError(null);
    setDrilled({});
    setImpact("");
    // Best effort and independent of the cell diff: an application with no
    // writeback answers empty, and a failure here must not hide the diff.
    void promotionImpact({
      registryPath: req.registryPath,
      packageName: req.packageName,
      environment: req.environment,
      version: toVersion,
    })
      .then((r) => {
        if (!cancelled) setImpact(r.writebackReport);
      })
      .catch(() => undefined);
    (async () => {
      try {
        const d = await diffVersions({
          registryPath: req.registryPath,
          packageName: req.packageName,
          fromVersion: `=${currentVersion}`,
          toVersion: `=${toVersion}`,
        });
        if (!cancelled) setDiff(d);
      } catch (e: unknown) {
        if (!cancelled) setDiffError(String(e));
      } finally {
        if (!cancelled) setDiffing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req?.registryPath, req?.packageName, currentVersion, toVersion]);

  const handleDrillDown = async (sheetId: string) => {
    if (!req || !currentVersion || !toVersion || drilled[sheetId]) return;
    try {
      const cells = await diffSheetCells({
        registryPath: req.registryPath,
        packageName: req.packageName,
        fromVersion: `=${currentVersion}`,
        toVersion: `=${toVersion}`,
        sheetId,
      });
      setDrilled((prev) => ({
        ...prev,
        [sheetId]: {
          rows: cells.changes,
          total: cells.totalChanges,
          truncated: cells.truncated,
        },
      }));
    } catch (e: unknown) {
      setDiffError(String(e));
    }
  };

  const handlePromote = async () => {
    if (!req || !target || !toVersion) return;
    // A REPAIR IS ITS OWN SENTENCE. `describePromotion` compares two versions,
    // and here they are the same one — it would say "promote prod from v1.5.0 to
    // v1.5.0", which describes nothing the user is doing.
    const confirmText = repairMode
      ? {
          title: `Re-establish ${req.packageName} ${target.name}`,
          message:
            `Re-promote v${toVersion} into "${target.name}"?\n\n` +
            `The version does not change. What changes is the signature on the ` +
            `pointer: it is currently signed by a key that is no longer allowed to ` +
            `publish this application, so subscribers refuse to follow it. Signing ` +
            `it with your key makes them follow it again.`,
          okLabel: "Re-promote",
          kind: "info" as const,
        }
      : describePromotion({
          packageName: req.packageName,
          environment: target.name,
          fromVersion: currentVersion,
          toVersion,
          // IN ROLLBACK MODE THE VERSION COMES FROM THIS ENVIRONMENT'S OWN
          // HISTORY, not from the source the pipeline would normally draw on —
          // attributing it to `test` when `test` does not hold it is false.
          sourceLabel: rollbackMode ? `${target.name}'s own history` : source.label,
          // The DIRECTION, so the confirm says OLDER exactly when the move is.
          mode: movesBackwards ? "rollback" : "promote",
        });
    // Fails CLOSED: a dialog that cannot be shown is a refusal, never consent.
    const ok = await confirmAsync(confirmText.message, {
      title: confirmText.title,
      okLabel: confirmText.okLabel,
      kind: confirmText.kind,
    });
    if (!ok) return;

    setPromoting(true);
    setError(null);
    try {
      const r = await promoteEnvironment({
        registryPath: req.registryPath,
        packageName: req.packageName,
        environment: target.name,
        // ALWAYS EXPLICIT — the version the user was shown, and the pointer the
        // dialog rendered. A colleague's promotion or a push can land between
        // the render and the click; the backend refuses on a mismatch rather
        // than promoting over a state nobody looked at.
        version: toVersion,
        expectedCurrent: currentVersion,
      });
      emitAppEvent(ENVIRONMENTS_CHANGED_EVENT, {
        registryPath: req.registryPath,
        packageName: req.packageName,
      });
      setResult(
        `${r.environment} is now at v${r.to}${r.from ? ` (was v${r.from})` : ""}. ` +
          `Subscribers of ${r.environment} will be offered it at their next refresh.` +
          (r.writebackReport ? ` Collected data: ${r.writebackReport}.` : ""),
      );
    } catch (e: unknown) {
      setError(String(e));
      // A stale refusal is not a failure the user caused — the world moved.
      // Re-read so the numbers on screen match what the workspace now holds.
      await load();
    } finally {
      setPromoting(false);
    }
  };

  const windowStyle: React.CSSProperties = {
    position: "fixed",
    left: "50%",
    top: "10%",
    transform: "translateX(-50%)",
    width: "640px",
    maxHeight: "82vh",
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

  /**
   * WHICH DIRECTION THIS ACTUALLY MOVES — computed from the versions, not from
   * the button that opened the window.
   *
   * `req.mode` is a UI intent: which picker to show. It was also driving the
   * title, the amber box, the confirm text and the footer, so the two could
   * disagree with what the backend was about to record. Both directions were
   * reachable: `heldVersions` includes the version an environment was rolled
   * back FROM, so "Roll back…" could confirm a forward move as "an OLDER
   * version"; and promoting a rolled-back `test` into a newer `prod` showed the
   * plain promote confirm although every prod subscriber saw a downgrade.
   */
  const movesBackwards = isRollback(currentVersion ?? "", toVersion);
  /** Which PICKER to show. The direction is `movesBackwards`. */
  const rollbackMode = req?.mode === "rollback";
  /**
   * Re-signing the pointer at the version it already holds. Not a move, so it is
   * neither a promotion nor a rollback, and the same-version guard below must
   * not treat it as "nothing to do".
   */
  const repairMode = req?.mode === "repair" && (target?.unauthorizedPointer ?? false);
  const title = result
    ? "Done"
    : repairMode
      ? `Re-establish ${req?.packageName ?? ""} ${req?.environment ?? ""}`
      : movesBackwards
        ? `Roll back ${req?.packageName ?? ""} ${req?.environment ?? ""}`
        : `Promote ${req?.packageName ?? ""} to ${req?.environment ?? ""}`;

  const blocked =
    !target ||
    !toVersion ||
    // A REPAIR IS THE ONE CASE WHERE SAME-VERSION IS THE POINT. Everywhere else
    // it means the pipeline has nothing to move and the button must be inert.
    (toVersion === currentVersion && !repairMode) ||
    promoting ||
    !(info?.youMayPromote ?? false) ||
    !(info?.writable ?? false);

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

        {!result && loading && <div>Reading the pipeline…</div>}

        {!result && !loading && loadError && <div style={errorTextStyle}>{loadError}</div>}

        {!result && !loading && info && !target && (
          <div style={errorTextStyle}>
            This application has no environment called &ldquo;{req?.environment}&rdquo; any
            more. Someone may have changed the pipeline since this panel was drawn.
          </div>
        )}

        {!result && !loading && target && (
          <>
            {repairMode ? (
              <div style={{ marginBottom: 10, lineHeight: 1.5 }}>
                <div>
                  <strong>{target.name}</strong>: stays at{" "}
                  {currentVersion ? `v${currentVersion}` : "—"}
                </div>
                <div style={{ ...mutedStyle, marginTop: 2 }}>
                  Nothing moves and no files are copied. The pointer is re-signed with
                  your key, so subscribers of {target.name} will follow it again.
                </div>
              </div>
            ) : (
              <div style={{ marginBottom: 10, lineHeight: 1.5 }}>
                <div>
                  <strong>{target.name}</strong>:{" "}
                  {currentVersion ? `v${currentVersion}` : "nothing promoted yet"} → {" "}
                  {toVersion ? `v${toVersion}` : "—"}
                  {!rollbackMode && source.label ? ` (from ${source.label})` : ""}
                </div>
                <div style={{ ...mutedStyle, marginTop: 2 }}>
                  No files are copied. {target.name} is a pointer to a version that
                  already exists in the workspace.
                </div>
              </div>
            )}

            {repairMode && (
              <div style={warnBoxStyle}>
                The key that last promoted {target.name} is no longer in this
                application&rsquo;s publisher list, so every subscriber refuses to follow
                the pointer. Re-promoting the same version signs it with your key and
                restores it. No subscriber sees a version change.
              </div>
            )}

            {rollbackMode && (
              <div style={{ marginBottom: 10 }}>
                <label style={{ display: "block", marginBottom: 4 }}>
                  Roll back to a version {target.name} has run before:
                </label>
                <select
                  value={chosenVersion}
                  onChange={(e) => setChosenVersion(e.target.value)}
                  style={{ minWidth: 160 }}
                >
                  {candidates.map((v) => (
                    <option key={v} value={v}>
                      v{v}
                    </option>
                  ))}
                </select>
                <div style={{ ...mutedStyle, marginTop: 4, lineHeight: 1.4 }}>
                  Only versions this environment has actually held are offered. A version
                  it never ran would be a new, untested promotion, not a rollback.
                </div>
              </div>
            )}

            {/* THE WARNING FOLLOWS THE MOVE, not the button. A "Promote →" that
                happens to go backwards is exactly as much of a downgrade for
                that environment's subscribers as one reached through the
                rollback picker. */}
            {movesBackwards && (
              <div style={warnBoxStyle}>
                Everyone subscribed to {target.name} will be offered an <strong>older</strong>{" "}
                version at their next refresh, and their preview will say so. Cells they
                have edited keep their overrides.
              </div>
            )}

            {!(info?.youMayPromote ?? false) && (
              <div style={warnBoxStyle}>
                This computer does not hold a key authorised to publish{" "}
                {req?.packageName}, so it cannot promote.
              </div>
            )}
            {(info?.youMayPromote ?? false) && !(info?.writable ?? false) && (
              <div style={warnBoxStyle}>
                This workspace is read-only here, so promotion has to happen where the
                files live.
              </div>
            )}

            {impact && (
              <div style={warnBoxStyle}>
                <strong>Data already collected in {target.name}:</strong> {impact}. Moving
                this pointer applies the same rules a version change always has — the cell
                diff below does not show it.
              </div>
            )}

            <div style={{ fontWeight: 600, marginTop: 12, marginBottom: 6 }}>
              What subscribers of {target.name} will see change
            </div>

            {!currentVersion && (
              <div style={mutedStyle}>
                {target.name} has no version yet, so subscribers will receive v{toVersion}{" "}
                in full.
              </div>
            )}
            {currentVersion && toVersion === currentVersion && (
              <div style={mutedStyle}>
                {target.name} is already at v{currentVersion}. There is nothing to move.
              </div>
            )}
            {currentVersion && toVersion && toVersion !== currentVersion && (
              <>
                {diffing && <div style={mutedStyle}>Comparing v{currentVersion} and v{toVersion}…</div>}
                {diffError && (
                  <div style={errorTextStyle}>
                    {diffError}
                    <div style={{ ...mutedStyle, marginTop: 4 }}>
                      The comparison could not be built. The promotion itself does not need
                      it, but you would be moving the pointer without seeing what changes.
                    </div>
                  </div>
                )}
                {diff && (
                  <VersionDiffView
                    diff={diff}
                    onDrillDown={(sheetId) => void handleDrillDown(sheetId)}
                    drilledCells={drilled}
                  />
                )}
              </>
            )}

            {error && <div style={{ ...errorTextStyle, marginTop: 10 }}>{error}</div>}
          </>
        )}
      </div>

      <div style={footerStyle}>
        {result ? (
          <button onClick={onClose}>Close</button>
        ) : (
          <>
            <button onClick={onClose}>Cancel</button>
            <button onClick={() => void handlePromote()} disabled={blocked}>
              {promoting
                ? "Working…"
                : repairMode
                  ? "Re-promote…"
                  : movesBackwards
                    ? "Roll back…"
                    : "Promote…"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}