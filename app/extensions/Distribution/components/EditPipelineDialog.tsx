// FILENAME: app/extensions/Distribution/components/EditPipelineDialog.tsx
// PURPOSE: Define the ordered pipeline an application promotes through.
// CONTEXT: The pipeline is a list of names, and the order is the meaning:
//          environment N+1 promotes from environment N, and the last one is
//          what a new subscriber is offered by default. Reordering therefore
//          changes where promotions come from, not just how the panel reads.
//
//          NO RENAME CONTROL, deliberately. The name IS the identity —
//          subscriptions record it as a string, and there is no id behind it. A
//          rename would silently strand every subscriber of the old name with no
//          error anywhere. Remove and add says the same thing out loud: their
//          next refresh names the missing environment and blocks Apply until
//          they choose another.
//
//          THE EDIT CARRIES A REVISION. Two admins with the panel open would
//          otherwise both save, and the second would silently erase the first's
//          pipeline — the workspace lock serializes the writes but cannot see
//          that the second one's READ was stale.

import React, { useCallback, useEffect, useState } from "react";
import type { DialogProps } from "@api";
import {
  listEnvironments,
  setEnvironments,
  emitAppEvent,
  ENVIRONMENTS_CHANGED_EVENT,
  type EnvironmentsResponse,
} from "@api";
import { confirmAsync } from "@api/dialogs";
import { useDialogWindow } from "@api/dialogWindow";
import { pipelineEditValidation } from "../lib/environments";
import { errorTextStyle, linkButtonStyle, mutedStyle, warnBoxStyle } from "./explorerStyles";

export interface EditPipelineRequest {
  registryPath: string;
  packageName: string;
}

function readRequest(data: unknown): EditPipelineRequest | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.registryPath !== "string" || typeof d.packageName !== "string") return null;
  return { registryPath: d.registryPath, packageName: d.packageName };
}

export function EditPipelineDialog({ onClose, data }: DialogProps) {
  const win = useDialogWindow({ minWidth: 460, minHeight: 320 });
  const req = readRequest(data);

  const [info, setInfo] = useState<EnvironmentsResponse | null>(null);
  const [names, setNames] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  /** EVERY SHOW STARTS CLEAN — see `openDialog`'s `__openCount`. */
  const openCount = data?.__openCount;

  const load = useCallback(async () => {
    if (!req) {
      setLoading(false);
      setLoadError("This window was opened without an application.");
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const next = await listEnvironments({
        registryPath: req.registryPath,
        packageName: req.packageName,
      });
      setInfo(next);
      setNames(next.environments.map((e) => e.name));
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

  // NORMALISE ONCE, for every use. Validation and the request already trimmed
  // while the unchanged check, the removal set and the per-row lookup did not —
  // so a trailing space enabled Save, showed the destructive "Remove prod
  // (v1.2.0)" confirm, and then sent an identical list that `set_pipeline`
  // signed as a no-op record, advancing the sequence and making a colleague's
  // open dialog stale.
  const trimmed = names.map((n) => n.trim());
  const validation = pipelineEditValidation(trimmed);
  const original = info?.environments.map((e) => e.name) ?? [];
  const unchanged =
    trimmed.length === original.length && trimmed.every((n, i) => n === original[i]);

  const setAt = (i: number, value: string) =>
    setNames((prev) => prev.map((n, j) => (j === i ? value : n)));

  const move = (i: number, delta: number) =>
    setNames((prev) => {
      const j = i + delta;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const removeAt = (i: number) => setNames((prev) => prev.filter((_, j) => j !== i));

  const handleSave = async () => {
    if (!req || !info || validation) return;

    // Removing an environment that HOLDS a version is the one destructive shape
    // here: its subscribers are pinned to a name that will stop resolving, and
    // they find out at their next refresh rather than now.
    const removed = info.environments.filter(
      (e) => !trimmed.includes(e.name) && e.version,
    );
    if (removed.length > 0) {
      const list = removed.map((e) => `${e.name} (v${e.version})`).join(", ");
      const ok = await confirmAsync(
        `Remove ${list} from "${req.packageName}"?\n\n` +
          `Anyone subscribed to ${removed.length === 1 ? "it" : "them"} will be told at ` +
          `their next refresh that the environment no longer exists, and cannot refresh ` +
          `until they pick another. Nothing is deleted — every version stays in the ` +
          `workspace, and re-adding the name starts it empty.`,
        { title: "Remove an environment", okLabel: "Remove", kind: "warning" },
      );
      if (!ok) return;
    }

    setSaving(true);
    setError(null);
    try {
      const next = await setEnvironments({
        registryPath: req.registryPath,
        packageName: req.packageName,
        environments: trimmed,
        // The revision this edit was built on: the number of signed records the
        // load saw. A colleague's promotion or pipeline change since then makes
        // it stale, and the backend refuses rather than overwriting them.
        //
        // Zero when the log did not verify (`problem` is set and the history is
        // empty), which the backend also refuses — the safe direction.
        expectedSequence: info.history.length,
      });
      setInfo(next);
      setNames(next.environments.map((e) => e.name));
      emitAppEvent(ENVIRONMENTS_CHANGED_EVENT, {
        registryPath: req.registryPath,
        packageName: req.packageName,
      });
      setResult(
        next.environments.length === 0
          ? `"${req.packageName}" has no environments. Every subscriber follows the ` +
              `development line again.`
          : `Pipeline is now ${next.environments.map((e) => e.name).join(" → ")}. ` +
              `Promote from the Application Explorer.`,
      );
    } catch (e: unknown) {
      setError(String(e));
      await load();
    } finally {
      setSaving(false);
    }
  };

  const windowStyle: React.CSSProperties = {
    position: "fixed",
    left: "50%",
    top: "14%",
    transform: "translateX(-50%)",
    width: "480px",
    maxHeight: "76vh",
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

  return (
    <div ref={win.ref} style={{ ...windowStyle, ...win.style }}>
      <div style={headerStyle} onMouseDown={win.onHeaderMouseDown}>
        <span style={{ fontWeight: 600 }}>
          {result ? "Done" : `Pipeline — ${req?.packageName ?? ""}`}
        </span>
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

        {!result && !loading && info && (
          <>
            <div style={{ ...mutedStyle, marginBottom: 10, lineHeight: 1.4 }}>
              Environments are promoted in order: each one takes the version the one
              before it holds, and the first takes the head of the development line. The
              last is what a new subscriber is offered.
            </div>

            {names.length === 0 && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ marginBottom: 6 }}>
                  No environments. Every subscriber follows the development line and sees
                  each push at their next refresh.
                </div>
                <button onClick={() => setNames(["test", "prod"])}>Use test → prod</button>
              </div>
            )}

            {names.map((name, i) => {
              const held = info.environments.find((e) => e.name === name.trim());
              return (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    gap: 6,
                    alignItems: "center",
                    marginBottom: 6,
                  }}
                >
                  <span style={{ ...mutedStyle, width: 16 }}>{i + 1}.</span>
                  <input
                    value={name}
                    onChange={(e) => setAt(i, e.target.value)}
                    style={{ flex: 1, minWidth: 0 }}
                    aria-label={`Environment ${i + 1}`}
                  />
                  <span style={{ ...mutedStyle, width: 92 }}>
                    {held?.version ? `v${held.version}` : held ? "empty" : "new"}
                  </span>
                  <button onClick={() => move(i, -1)} disabled={i === 0} title="Move up">
                    ↑
                  </button>
                  <button
                    onClick={() => move(i, 1)}
                    disabled={i === names.length - 1}
                    title="Move down"
                  >
                    ↓
                  </button>
                  <button onClick={() => removeAt(i)} title="Remove">
                    Remove
                  </button>
                </div>
              );
            })}

            <div style={{ marginTop: 8 }}>
              <button style={linkButtonStyle} onClick={() => setNames((p) => [...p, ""])}>
                Add environment
              </button>
            </div>

            {/* No rename control, and the reason belongs on screen: a user who
                cannot find one will otherwise assume it is an oversight and
                achieve the rename by hand, one letter at a time. */}
            <div style={{ ...mutedStyle, marginTop: 10, lineHeight: 1.4 }}>
              An environment&rsquo;s name is how subscribers refer to it, so there is no
              rename: editing a name here removes one environment and adds another, and
              subscribers of the old name are told it is gone.
            </div>

            {validation && <div style={warnBoxStyle}>{validation}</div>}
            {error && <div style={{ ...errorTextStyle, marginTop: 8 }}>{error}</div>}
          </>
        )}
      </div>

      <div style={footerStyle}>
        {result ? (
          <button onClick={onClose}>Close</button>
        ) : (
          <>
            <button onClick={onClose}>Cancel</button>
            <button
              onClick={() => void handleSave()}
              disabled={
                saving ||
                loading ||
                !info ||
                validation !== null ||
                unchanged ||
                !info.youMayPromote ||
                !info.writable
              }
            >
              {saving ? "Saving…" : "Save pipeline"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
