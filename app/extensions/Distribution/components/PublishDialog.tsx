// FILENAME: app/extensions/Distribution/components/PublishDialog.tsx
// PURPOSE: Push a new version of the package this workbook is a working copy of
// — or, for a standalone workbook, create a package from it.
// CONTEXT: Deliberately NOT a modal: there is no backdrop, so the workbook stays
// fully interactive while the window is open. Movable + resizable via the shared
// @api/dialogWindow hook; closes only via its own buttons.
//
// TWO MODES, and the difference is not cosmetic. A LINKED workbook already knows
// its registry, package and base version, so the dialog stops asking and starts
// TELLING: here is where the package stands, here is what you are based on, here
// is the next version. It was seven blank fields on every open — including a
// comma-separated list of sheet INDICES — which meant shipping v1.1 of your own
// report involved retyping its identity from memory and being wrong about it in
// silence. An UNLINKED workbook still gets the fields, because there is genuinely
// nothing to remember yet, and publishing links it for next time.

import React, { useCallback, useEffect, useState } from "react";
import type {
  DialogProps,
  MergeAnalysisResponse,
  PublishReport,
  PushGateStatus,
  VersionDiff,
  WorkspaceStatus,
} from "@api";
import {
  diffWorkingCopy,
  publishPackage,
  publishPreview,
  pushMergeAnalyze,
  pushMergeApply,
  workspaceStatus,
} from "@api";
import { VersionDiffView } from "./VersionDiffView";
import { listPackageKinds } from "@api/packageKinds";
import { listRegistries, type SavedRegistry } from "@api/distributionRegistries";
import { useDialogWindow } from "@api/dialogWindow";
import { open as openNativeDialog } from "@tauri-apps/plugin-dialog";
import { PublishReportView } from "./PackageExplorerPanel";

/** Which of the two things this dialog is doing right now. */
type Mode = "loading" | "push" | "create";

export function PublishDialog({ onClose }: DialogProps) {
  const win = useDialogWindow({ minWidth: 460, minHeight: 400 });

  const [mode, setMode] = useState<Mode>("loading");
  const [workspace, setWorkspace] = useState<WorkspaceStatus | null>(null);
  const [gates, setGates] = useState<PushGateStatus | null>(null);
  const [saved, setSaved] = useState<SavedRegistry[]>([]);

  // Fields. In push mode the target three are read-only, taken from the link.
  const [registryPath, setRegistryPath] = useState("");
  const [packageName, setPackageName] = useState("");
  const [version, setVersion] = useState("1.0.0");
  const [kind, setKind] = useState("report");
  const [changeSummary, setChangeSummary] = useState("");
  const [includeComments, setIncludeComments] = useState(false);
  /** Sheet ids picked by name; empty selection = every sheet. */
  const [sheetSelection, setSheetSelection] = useState<Set<string>>(new Set());
  const [availableSheets, setAvailableSheets] = useState<string[]>([]);

  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<PublishReport | null>(null);
  const [reportLabel, setReportLabel] = useState<string>("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [pushed, setPushed] = useState(false);
  const [diff, setDiff] = useState<VersionDiff | null>(null);
  const [diffBusy, setDiffBusy] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [merge, setMerge] = useState<MergeAnalysisResponse | null>(null);
  const [mergeBusy, setMergeBusy] = useState(false);

  // ---- Load the workbook's own answer to "what am I?" ---------------------
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [link, registries] = await Promise.all([
        workspaceStatus().catch(() => null),
        listRegistries().catch(() => [] as SavedRegistry[]),
      ]);
      if (cancelled) return;
      setSaved(registries);
      if (link) {
        setWorkspace(link);
        setRegistryPath(link.registryUrl);
        setPackageName(link.packageName);
        setKind(link.kind || "report");
        setVersion(link.suggestedNext?.patch ?? link.baseVersion);
        setSheetSelection(new Set(link.baseSheets.map((s) => s.name)));
        setMode("push");
      } else {
        setMode("create");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- Preview: the content report AND the gate status --------------------
  const runPreview = useCallback(
    async (label: string) => {
      setError(null);
      setStatus("Analyzing…");
      try {
        const target =
          registryPath.trim() && packageName.trim()
            ? { registryPath, packageName }
            : undefined;
        const result = await publishPreview(selectedIndices(), includeComments, target);
        setReport(result.report);
        setReportLabel(`${label} ${result.sheetNames.join(", ")}`);
        setWarnings(result.warnings);
        setGates(result.gates ?? null);
        setAvailableSheets(result.sheetNames);
        setStatus(null);
      } catch (err: unknown) {
        setError(String(err));
        setStatus(null);
      }
    },
    // selectedIndices reads state; the deps below are what actually change it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [registryPath, packageName, includeComments, sheetSelection],
  );

  // A preview with no sheet filter is how we learn the workbook's sheet names
  // for the checkbox list — there is no separate "list my sheets" call, and
  // inventing one would be a second source of truth for what a publish covers.
  useEffect(() => {
    if (mode === "loading") return;
    void (async () => {
      try {
        const result = await publishPreview(
          [],
          false,
          registryPath.trim() && packageName.trim() ? { registryPath, packageName } : undefined,
        );
        setAvailableSheets(result.sheetNames);
        setGates(result.gates ?? null);
      } catch {
        // A failure here costs the checkbox list, not the dialog.
      }
    })();
    // Re-run when the target changes so the gate panel stays truthful.
  }, [mode, registryPath, packageName]);

  // The changes this push would make, computed by running the real publish
  // into memory and diffing it against the base. Loaded once the workbook is
  // known to be a working copy, because that is when there is a base to compare
  // against at all.
  useEffect(() => {
    if (mode !== "push" || !workspace?.baseVersion) return;
    let cancelled = false;
    setDiffBusy(true);
    setDiffError(null);
    diffWorkingCopy()
      .then((result) => {
        if (!cancelled) setDiff(result.diff);
      })
      .catch((e: unknown) => {
        // A missing base version or an unreachable registry costs the diff
        // panel, not the dialog — the push gates still run server-side.
        if (!cancelled) setDiffError(String(e));
      })
      .finally(() => {
        if (!cancelled) setDiffBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, workspace?.baseVersion, pushed]);

  // When the base is stale, WHY it is stale matters more than the fact. Ask
  // whether the intervening work actually overlaps yours before telling the
  // user their push is refused — most of the time on a decomposed package it
  // does not, and "you two collided" would be false.
  const analyzeMerge = useCallback(async () => {
    setMergeBusy(true);
    try {
      setMerge(await pushMergeAnalyze());
    } catch {
      // No analysis is a worse-informed banner, not a broken dialog.
      setMerge(null);
    } finally {
      setMergeBusy(false);
    }
  }, []);

  useEffect(() => {
    const stale = gates?.baseStale ?? workspace?.isStale ?? false;
    if (mode === "push" && stale && !merge && !mergeBusy) {
      void analyzeMerge();
    }
  }, [mode, gates?.baseStale, workspace?.isStale, merge, mergeBusy, analyzeMerge]);

  const handleMerge = async () => {
    setError(null);
    setStatus("Merging…");
    try {
      const result = await pushMergeApply();
      setStatus(
        `Merged with v${result.mergedFromVersion}` +
          (result.cellsApplied > 0
            ? ` — ${result.cellsApplied} cell(s) from ${result.sheetsTouched.join(", ")}`
            : ""),
      );
      setMerge(null);
      // Everything downstream moved: the base, the gate statuses, the diff.
      const fresh = await workspaceStatus();
      if (fresh) {
        setWorkspace(fresh);
        setVersion(fresh.suggestedNext?.patch ?? fresh.baseVersion);
      }
      await runPreview("Preview — would publish");
    } catch (err: unknown) {
      setError(explainPushError(String(err)));
      setStatus(null);
    }
  };

  /** Selected sheet NAMES resolved to workbook indices; [] = every sheet. */
  const selectedIndices = (): number[] => {
    if (sheetSelection.size === 0 || availableSheets.length === 0) return [];
    if (sheetSelection.size === availableSheets.length) return [];
    return availableSheets
      .map((name, i) => (sheetSelection.has(name) ? i : -1))
      .filter((i) => i >= 0);
  };

  const handleBrowse = async () => {
    try {
      const selected = await openNativeDialog({
        directory: true,
        multiple: false,
        title: "Select Registry Folder",
      });
      if (selected && typeof selected === "string") setRegistryPath(selected);
    } catch {
      // user cancelled
    }
  };

  const handlePublish = async () => {
    setError(null);
    setStatus(mode === "push" ? "Pushing…" : "Publishing…");
    try {
      const result = await publishPackage({
        registryPath,
        packageName,
        version,
        kind,
        sheetIndices: selectedIndices(),
        // Stamped backend-side from the signing identity; sent for wire
        // compatibility only. A display name the caller types is a display name
        // that can disagree with the key beside it in the version list.
        publishedBy: "",
        includeComments,
        mode: mode === "push" ? "update" : "createNew",
        expectedBaseVersion: mode === "push" ? workspace?.baseVersion : undefined,
        changeSummary,
      });
      setStatus(
        `${mode === "push" ? "Pushed" : "Published"} ${result.packageName} v${result.version}: ${result.sheetsPublished} sheet(s)`,
      );
      setReport(result.report);
      setReportLabel(`Published ${result.packageName} v${result.version}`);
      setWarnings(result.warnings);
      setPushed(true);
      // The link moved; re-read so the panel shows the new base.
      workspaceStatus()
        .then((s) => {
          if (s) {
            setWorkspace(s);
            setMode("push");
          }
        })
        .catch(() => undefined);
    } catch (err: unknown) {
      setError(explainPushError(String(err)));
      setStatus(null);
    }
  };

  const canPush =
    mode !== "loading" &&
    registryPath.trim() !== "" &&
    packageName.trim() !== "" &&
    version.trim() !== "" &&
    (mode === "create" || changeSummary.trim() !== "") &&
    !pushed;

  // ---- styles -------------------------------------------------------------
  const windowStyle: React.CSSProperties = {
    position: "fixed",
    left: "50%",
    top: "8%",
    transform: "translateX(-50%)",
    width: "540px",
    maxHeight: "84vh",
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
  const fieldStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    marginBottom: "10px",
  };
  const inputStyle: React.CSSProperties = {
    padding: "4px 6px",
    border: "1px solid var(--border-default)",
    borderRadius: "3px",
    fontSize: "13px",
    background: "var(--bg-surface)",
    color: "var(--text-primary)",
  };
  const readOnlyValueStyle: React.CSSProperties = {
    padding: "4px 6px",
    background: "var(--bg-subtle, rgba(127,127,127,0.08))",
    border: "1px solid var(--border-default)",
    borderRadius: "3px",
    color: "var(--text-secondary)",
  };

  return (
    <div ref={win.ref} style={{ ...windowStyle, ...win.style }}>
      <div style={headerStyle} onMouseDown={win.onHeaderMouseDown}>
        <span style={{ fontWeight: 600 }}>
          {mode === "push" ? `Push to ${packageName}` : "Publish Package"}
        </span>
        <button style={closeButtonStyle} onClick={onClose} aria-label="Close" title="Close">
          ✕
        </button>
      </div>

      <div style={bodyStyle}>
        {mode === "loading" && (
          <div style={{ color: "var(--text-secondary)" }}>Reading workbook…</div>
        )}

        {mode === "push" && workspace && (
          <WorkspaceBanner
            workspace={workspace}
            gates={gates}
            merge={merge}
            mergeBusy={mergeBusy}
            onMerge={handleMerge}
          />
        )}

        {mode === "create" && (
          <div
            style={{
              fontSize: "12px",
              color: "var(--text-secondary)",
              marginBottom: "12px",
              lineHeight: 1.45,
            }}
          >
            This workbook is not yet a working copy of any package. Publishing it
            creates one and links this workbook to it, so later changes are
            pushed as new versions rather than re-entered by hand.
          </div>
        )}

        {mode === "create" && (
          <>
            <div style={fieldStyle}>
              <label>Registry Path</label>
              {saved.length > 0 && (
                <select
                  style={inputStyle}
                  value={saved.find((r) => r.location === registryPath)?.id ?? ""}
                  onChange={(e) => {
                    const reg = saved.find((r) => r.id === e.target.value);
                    if (reg) setRegistryPath(reg.location);
                  }}
                >
                  <option value="">Choose a saved registry…</option>
                  {saved.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} — {r.location}
                    </option>
                  ))}
                </select>
              )}
              <div style={{ display: "flex", gap: "4px" }}>
                <input
                  style={{ ...inputStyle, flex: 1 }}
                  value={registryPath}
                  onChange={(e) => setRegistryPath(e.target.value)}
                  placeholder="C:\shared\registry"
                />
                <button onClick={handleBrowse} style={{ whiteSpace: "nowrap" }}>
                  Browse…
                </button>
              </div>
            </div>
            <div style={fieldStyle}>
              <label>Package Name</label>
              <input
                style={inputStyle}
                value={packageName}
                onChange={(e) => setPackageName(e.target.value)}
                placeholder="sales-report"
              />
            </div>
            <div style={fieldStyle}>
              <label>Kind</label>
              <select style={inputStyle} value={kind} onChange={(e) => setKind(e.target.value)}>
                {listPackageKinds().map((k) => (
                  <option key={k.id} value={k.id} title={k.description}>
                    {k.label}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}

        {mode === "push" && (
          <div style={fieldStyle}>
            <label>Publishing to</label>
            <div style={readOnlyValueStyle}>
              {packageName} — {registryPath}
            </div>
          </div>
        )}

        {mode !== "loading" && (
          <div style={fieldStyle}>
            <label>Version</label>
            <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
              <input
                style={{ ...inputStyle, width: "120px" }}
                value={version}
                onChange={(e) => setVersion(e.target.value)}
              />
              {workspace?.suggestedNext && (
                <div style={{ display: "flex", gap: "4px" }}>
                  {(["patch", "minor", "major"] as const).map((bump) => (
                    <button
                      key={bump}
                      onClick={() => setVersion(workspace.suggestedNext![bump])}
                      title={`v${workspace.suggestedNext![bump]}`}
                      style={{
                        fontSize: "11px",
                        padding: "2px 8px",
                        fontWeight: version === workspace.suggestedNext![bump] ? 600 : 400,
                      }}
                    >
                      {bump}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {workspace?.suggestedNext && (
              <div style={{ fontSize: "11px", color: "var(--text-secondary)" }}>
                A major bump tells subscribers their local edits may not survive.
              </div>
            )}
          </div>
        )}

        {mode === "push" && (
          <div style={fieldStyle}>
            <label>Changes since v{workspace?.baseVersion}</label>
            <div
              style={{
                border: "1px solid var(--border-default)",
                borderRadius: 3,
                padding: "8px",
                maxHeight: "260px",
                overflowY: "auto",
              }}
            >
              {diffBusy && (
                <span style={{ color: "var(--text-secondary)", fontSize: "12px" }}>
                  Working out what you changed…
                </span>
              )}
              {diffError && !diffBusy && (
                <span style={{ color: "var(--text-secondary)", fontSize: "12px" }}>
                  Could not compare against v{workspace?.baseVersion}: {diffError}
                </span>
              )}
              {diff && !diffBusy && <VersionDiffView diff={diff} />}
            </div>
          </div>
        )}

        {mode !== "loading" && (
          <div style={fieldStyle}>
            <label>
              What changed{mode === "push" ? " (required)" : " (optional)"}
            </label>
            <textarea
              style={{ ...inputStyle, minHeight: "56px", resize: "vertical", fontFamily: "inherit" }}
              value={changeSummary}
              onChange={(e) => setChangeSummary(e.target.value)}
              placeholder="Adds the regional split to the summary sheet and a Refresh button."
            />
            <div style={{ fontSize: "11px", color: "var(--text-secondary)" }}>
              Stored inside the signed version manifest — subscribers and
              co-developers read it in the version history.
            </div>
          </div>
        )}

        {mode !== "loading" && availableSheets.length > 0 && (
          <div style={fieldStyle}>
            <label>Sheets</label>
            <div
              style={{
                border: "1px solid var(--border-default)",
                borderRadius: "3px",
                maxHeight: "140px",
                overflowY: "auto",
                padding: "4px 6px",
              }}
            >
              {availableSheets.map((name) => {
                const inBase = workspace?.baseSheets.some((s) => s.name === name) ?? false;
                return (
                  <label
                    key={name}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                      padding: "2px 0",
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={sheetSelection.size === 0 || sheetSelection.has(name)}
                      onChange={(e) => {
                        setSheetSelection((prev) => {
                          const next = new Set(
                            prev.size === 0 ? availableSheets : Array.from(prev),
                          );
                          if (e.target.checked) next.add(name);
                          else next.delete(name);
                          return next;
                        });
                      }}
                    />
                    <span>{name}</span>
                    {mode === "push" && !inBase && (
                      <span style={{ fontSize: "11px", color: "var(--text-secondary)" }}>
                        (new — not in v{workspace?.baseVersion})
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {mode !== "loading" && (
          <div
            style={{ ...fieldStyle, flexDirection: "row", alignItems: "center", gap: "6px" }}
          >
            <input
              id="publish-include-comments"
              type="checkbox"
              checked={includeComments}
              onChange={(e) => setIncludeComments(e.target.checked)}
            />
            <label htmlFor="publish-include-comments" style={{ cursor: "pointer" }}>
              Include comments (threaded discussions stay private unless checked)
            </label>
          </div>
        )}

        {error && (
          <div
            style={{
              color: "var(--text-error, #d33)",
              marginBottom: "8px",
              fontSize: "12px",
              whiteSpace: "pre-wrap",
            }}
          >
            {error}
          </div>
        )}
        {status && (
          <div style={{ color: "green", marginBottom: "8px", fontSize: "12px" }}>{status}</div>
        )}

        {warnings.length > 0 && (
          <div
            style={{
              fontSize: "12px",
              margin: "8px 0",
              padding: "6px 8px",
              backgroundColor: "#fff3cd",
              borderRadius: 4,
              color: "#664d03",
            }}
          >
            <strong>Warnings ({warnings.length})</strong> — the package publishes
            as-is; these only degrade for subscribers.
            {warnings.map((w, i) => (
              <div key={i} style={{ marginLeft: 8, marginTop: 4 }}>
                {w}
              </div>
            ))}
          </div>
        )}

        {report && (
          <div
            style={{
              margin: "8px 0",
              padding: "8px",
              border: "1px solid var(--border-default)",
              borderRadius: "3px",
              fontSize: "12px",
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: "4px" }}>{reportLabel}</div>
            <PublishReportView report={report} />
          </div>
        )}
      </div>

      <div style={footerStyle}>
        <button onClick={onClose}>{pushed ? "Close" : "Cancel"}</button>
        <button onClick={() => void runPreview("Preview — would publish")}>Preview</button>
        <button onClick={handlePublish} disabled={!canPush} style={{ fontWeight: 600 }}>
          {mode === "push" ? "Push" : "Publish"}
        </button>
      </div>

      {win.resizeHandles}
    </div>
  );
}

/**
 * Where this working copy stands: which package, which base, and whether the
 * registry has moved on since.
 */
function WorkspaceBanner({
  workspace,
  gates,
  merge,
  mergeBusy,
  onMerge,
}: {
  workspace: WorkspaceStatus;
  gates: PushGateStatus | null;
  merge: MergeAnalysisResponse | null;
  mergeBusy: boolean;
  onMerge: () => void;
}) {
  const stale = gates?.baseStale ?? workspace.isStale;
  const unreachable = !workspace.registryReachable && !gates?.registryLatest;
  const keyProblem = gates ? !gates.keyContinuityOk : !workspace.holdsPublisherKey;

  const boxStyle = (tone: "info" | "warn" | "error"): React.CSSProperties => ({
    fontSize: "12px",
    padding: "8px 10px",
    marginBottom: "12px",
    borderRadius: "4px",
    lineHeight: 1.45,
    background:
      tone === "error" ? "#fdecea" : tone === "warn" ? "#fff3cd" : "var(--bg-subtle, rgba(127,127,127,0.08))",
    color: tone === "error" ? "#842029" : tone === "warn" ? "#664d03" : "var(--text-primary)",
  });

  if (unreachable) {
    return (
      <div style={boxStyle("warn")}>
        <strong>{workspace.packageName}</strong> — you are based on v
        {workspace.baseVersion}. The registry could not be read
        {workspace.registryError ? `: ${workspace.registryError}` : ""}, so
        whether anyone has published since is unknown. A push will check before
        it writes anything.
      </div>
    );
  }

  if (stale) {
    const head = merge?.headVersion || gates?.registryLatest || workspace.headVersion;
    const who = merge?.headPublishedBy || gates?.latestPublishedBy || "";
    const landed = (
      <>
        <strong>{workspace.packageName}</strong> is now at v{head}
        {who ? `, published by ${who}` : ""} — you are working from v
        {workspace.baseVersion}.
        {merge?.headChangeSummary ? ` They wrote: “${merge.headChangeSummary}”` : ""}
      </>
    );

    if (mergeBusy || !merge) {
      return (
        <div style={boxStyle("warn")}>
          {landed}
          <div style={{ marginTop: 4 }}>
            Working out whether their changes overlap yours…
          </div>
        </div>
      );
    }

    // Disjoint work is the common case on a package made of addressable
    // pieces, and calling it a conflict would be false.
    if (merge.analysis.verdict === "canMerge") {
      return (
        <div style={boxStyle("info")}>
          {landed}
          <ChangeLists analysis={merge.analysis} />
          <div style={{ marginTop: 6 }}>
            Your changes and theirs touch different things, so both can land.
            Merging brings their work into this workbook and recalculates —
            after that, push as usual.
          </div>
          <button onClick={onMerge} style={{ marginTop: 6, fontWeight: 600 }}>
            Merge with v{head}
          </button>
        </div>
      );
    }

    if (merge.analysis.verdict === "conflict") {
      return (
        <div style={boxStyle("error")}>
          {landed}
          <div style={{ marginTop: 6 }}>
            The same thing was changed on both sides:
            <ul style={{ margin: "4px 0 0 18px", padding: 0 }}>
              {merge.analysis.collisions.map((c, i) => (
                <li key={i}>{c.description}</li>
              ))}
            </ul>
          </div>
          <div style={{ marginTop: 6 }}>
            There is no way to merge two versions of the same cell without
            discarding one of them, so this push is refused. Open v{head} for
            editing and re-apply your work.
          </div>
        </div>
      );
    }

    // cannotApply — disjoint, but out of reach for now. Worth distinguishing:
    // "you collided" and "we cannot do this yet" call for different reactions.
    return (
      <div style={boxStyle("warn")}>
        {landed}
        <ChangeLists analysis={merge.analysis} />
        <div style={{ marginTop: 6 }}>
          Your work and theirs do not overlap, but this version cannot bring
          across {merge.analysis.unmergeable.join("; ")}. Open v{head} for
          editing and re-apply your changes.
        </div>
      </div>
    );
  }

  if (keyProblem) {
    return (
      <div style={boxStyle("error")}>
        <strong>{workspace.packageName}</strong> was published with a different
        signing key than this computer holds. Pushing would break every
        subscriber&rsquo;s trust pin, so it will be refused — ask the publisher to
        push this change.
      </div>
    );
  }

  return (
    <div style={boxStyle("info")}>
      <strong>{workspace.packageName}</strong> is at v
      {gates?.registryLatest || workspace.headVersion || workspace.baseVersion} — you are based on v
      {workspace.baseVersion}. Your push will be the next version.
    </div>
  );
}

/** Side by side: what landed, and what you changed. */
function ChangeLists({ analysis }: { analysis: MergeAnalysisResponse["analysis"] }) {
  if (analysis.theirSummary.length === 0 && analysis.yourSummary.length === 0) return null;
  return (
    <div style={{ display: "flex", gap: 16, marginTop: 6, flexWrap: "wrap" }}>
      <div style={{ minWidth: 160 }}>
        <div style={{ fontWeight: 600 }}>They changed</div>
        <ul style={{ margin: "2px 0 0 16px", padding: 0 }}>
          {analysis.theirSummary.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      </div>
      <div style={{ minWidth: 160 }}>
        <div style={{ fontWeight: 600 }}>You changed</div>
        <ul style={{ margin: "2px 0 0 16px", padding: 0 }}>
          {analysis.yourSummary.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * Turn a backend gate refusal into the sentence it already contains.
 *
 * The backend prefixes gate refusals with a stable `CALP_PUSH_*` code so a UI
 * can branch; the human half is the rest of the string. Showing the code to the
 * user would be showing them our internal vocabulary.
 */
function explainPushError(raw: string): string {
  const match = raw.match(/CALP_(?:PUSH|MERGE)_[A-Z_]+:\s*(.*)$/s);
  return match ? match[1].trim() : raw;
}
