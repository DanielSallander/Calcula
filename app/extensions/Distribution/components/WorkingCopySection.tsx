// FILENAME: app/extensions/Distribution/components/WorkingCopySection.tsx
// PURPOSE: What application this workbook is a working copy of, and its
// published history.
// CONTEXT: The workspace has always retained every version — signed manifests
// and a content-addressed blob store, kept forever — but an author had no way
// to SEE that history without pointing the Application Inspector at their own
// application by name, the same as a stranger would. This section is the author
// looking at their own work: which application, which base version, what has
// been pushed, and by whom.

import React, { useCallback, useEffect, useState } from "react";
import type { CoPublishersResponse, WorkingCopyStatus } from "@api";
import {
  listCoPublishers,
  myPublisherKey,
  setCoPublishers,
  workingCopyStatus,
} from "@api";
import { AppEvents, onAppEvent } from "@api";
import { promptAsync, confirmAsync } from "@api/dialogs";
import {
  ddStyle,
  dtStyle,
  formatWhen,
  linkButtonStyle,
  mutedStyle,
  warnBoxStyle,
} from "./explorerStyles";

export function WorkingCopySection() {
  const [status, setStatus] = useState<WorkingCopyStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setBusy(true);
    try {
      setStatus(await workingCopyStatus());
    } catch {
      setStatus(null);
    } finally {
      setLoaded(true);
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    // The link changes when a document is replaced (open / new / checkout) and
    // when a push lands. Re-read rather than showing the previous document's
    // application, which is the specific failure the persistence restore guards
    // against on its side.
    const off = onAppEvent(AppEvents.AFTER_OPEN, () => void reload());
    return () => off();
  }, [reload]);

  if (!loaded) {
    return <div style={mutedStyle}>Reading workbook…</div>;
  }

  if (!status) {
    return (
      <div style={mutedStyle}>
        This workbook is not a working copy of any application.
        <div style={{ marginTop: 6 }}>
          Use <strong>Distribution &gt; Open Application for Editing</strong> to
          work on a published application, or <strong>Publish Application</strong>{" "}
          to create one from this workbook.
        </div>
      </div>
    );
  }

  // Newest first: the current state of the application is what a developer looks
  // for, and history reads backwards from it.
  const versionsNewestFirst = [...status.versions].reverse();

  return (
    <div style={{ fontSize: "12px" }}>
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontWeight: 600, fontSize: "13px" }}>{status.packageName}</div>
        <div style={mutedStyle}>{status.registryUrl}</div>
      </div>

      <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 10px" }}>
        <dt style={dtStyle}>Based on</dt>
        <dd style={ddStyle}>v{status.baseVersion}</dd>

        <dt style={dtStyle}>Application is at</dt>
        <dd style={ddStyle}>
          {status.registryReachable ? (
            <>
              v{status.headVersion || "—"}
              {status.isStale && (
                <span style={{ color: "#b02a37", fontWeight: 600, marginLeft: 6 }}>
                  (you are behind)
                </span>
              )}
            </>
          ) : (
            <span style={mutedStyle}>workspace unreachable</span>
          )}
        </dd>

        {status.lastPushedVersion && (
          <>
            <dt style={dtStyle}>You pushed</dt>
            <dd style={ddStyle}>
              v{status.lastPushedVersion}
              {status.lastPushedAt ? ` · ${formatWhen(status.lastPushedAt)}` : ""}
            </dd>
          </>
        )}

        <dt style={dtStyle}>Checked out</dt>
        <dd style={ddStyle}>{formatWhen(status.checkedOutAt)}</dd>
      </dl>

      {status.registryReachable && !status.holdsPublisherKey && (
        <div style={warnBoxStyle}>
          This computer does not hold the key that signed the current version, so
          a push would be refused — it would break every subscriber&rsquo;s trust
          pin.
        </div>
      )}

      {!status.registryReachable && status.registryError && (
        <div style={warnBoxStyle}>Workspace could not be read: {status.registryError}</div>
      )}

      <div style={{ marginTop: 12 }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>
          Version history{versionsNewestFirst.length ? ` (${versionsNewestFirst.length})` : ""}
        </div>
        {versionsNewestFirst.length === 0 && (
          <div style={mutedStyle}>
            {status.registryReachable ? "No versions published yet." : "Unavailable offline."}
          </div>
        )}
        {versionsNewestFirst.map((v) => {
          const isBase = v.version === status.baseVersion;
          return (
            <div
              key={v.version}
              style={{
                padding: "6px 8px",
                marginBottom: 4,
                borderRadius: 3,
                border: "1px solid var(--border-default)",
                background: isBase ? "var(--bg-selected, rgba(66,133,244,0.10))" : "transparent",
              }}
            >
              <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
                <span style={{ fontWeight: 600 }}>v{v.version}</span>
                {isBase && <span style={mutedStyle}>· your base</span>}
                {v.baseVersion && <span style={mutedStyle}>· from v{v.baseVersion}</span>}
              </div>
              {v.changeSummary && (
                <div style={{ marginTop: 2, lineHeight: 1.4 }}>{v.changeSummary}</div>
              )}
              <div style={{ ...mutedStyle, marginTop: 2 }}>
                {v.publishedBy ? `${v.publishedBy} · ` : ""}
                {formatWhen(v.publishedAt)}
              </div>
            </div>
          );
        })}
      </div>

      <CoPublishers
        registryPath={status.registryUrl}
        packageName={status.packageName}
        enabled={status.registryReachable}
      />

      <div style={{ marginTop: 10 }}>
        <button onClick={() => void reload()} disabled={busy}>
          {busy ? "Refreshing…" : "Refresh"}
        </button>
      </div>
    </div>
  );
}

/**
 * Who else may push to this application.
 *
 * Delegation rather than key sharing, and the reason is worth stating in the
 * UI: a profile holds ONE keypair, used for every application that user publishes
 * and for reviewing writeback, so handing a colleague "the team key" overwrites
 * their own identity machine-wide.
 */
function CoPublishers({
  registryPath,
  packageName,
  enabled,
}: {
  registryPath: string;
  packageName: string;
  enabled: boolean;
}) {
  const [info, setInfo] = useState<CoPublishersResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    if (!enabled) return;
    setBusy(true);
    setError(null);
    try {
      setInfo(await listCoPublishers({ registryPath, packageName }));
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [registryPath, packageName, enabled]);

  useEffect(() => {
    if (expanded) void load();
  }, [expanded, load]);

  const handleAdd = async () => {
    const key = await promptAsync(
      "Paste the colleague's publisher key (they can copy it from the Working copy " +
        "section of their own Application Explorer panel). It is a public key — it " +
        "identifies them, it does not give anyone access to their machine.",
      { title: "Add a co-publisher", okLabel: "Add" },
    );
    if (!key || !key.trim()) return;
    const name =
      (await promptAsync("A name for them (display only):", { title: "Add a co-publisher" })) ??
      "";
    setBusy(true);
    setError(null);
    try {
      const next = [
        ...(info?.coPublishers ?? []).map((c) => ({ key: c.key, name: c.name })),
        { key: key.trim(), name: name.trim() },
      ];
      setInfo(await setCoPublishers({ registryPath, packageName, coPublishers: next }));
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (key: string, name: string) => {
    const ok = await confirmAsync(
      `Remove ${name || "this co-publisher"} from '${packageName}'? They will no longer ` +
        `be able to push new versions.`,
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const next = (info?.coPublishers ?? [])
        .filter((c) => c.key !== key)
        .map((c) => ({ key: c.key, name: c.name }));
      setInfo(await setCoPublishers({ registryPath, packageName, coPublishers: next }));
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleCopyMyKey = async () => {
    try {
      const me = await myPublisherKey();
      await navigator.clipboard.writeText(me.key);
      setError(null);
      setInfo((prev) => prev);
      // A tiny confirmation beats a silent success for something the user has
      // to paste into a chat window.
      setCopied(me.key);
      window.setTimeout(() => setCopied(null), 4000);
    } catch (e: unknown) {
      setError(String(e));
    }
  };
  const [copied, setCopied] = useState<string | null>(null);

  return (
    <div style={{ marginTop: 12 }}>
      <button style={linkButtonStyle} onClick={() => setExpanded((e) => !e)}>
        {expanded ? "Hide who can publish" : "Who can publish this?"}
      </button>

      {expanded && (
        <div
          style={{
            marginTop: 6,
            padding: "6px 8px",
            border: "1px solid var(--border-default)",
            borderRadius: 3,
          }}
        >
          {!enabled && <div style={mutedStyle}>Unavailable while the workspace is offline.</div>}
          {busy && <div style={mutedStyle}>Loading…</div>}
          {error && (
            <div style={{ color: "var(--text-error, #d33)", fontSize: "11px" }}>{error}</div>
          )}

          {info && (
            <>
              {info.problem && <div style={warnBoxStyle}>{info.problem}</div>}
              <div style={mutedStyle}>
                Publisher key {info.rootKey.slice(0, 16)}…{" "}
                {info.youAreTheRoot ? "(this computer)" : ""}
              </div>

              {info.coPublishers.length === 0 && (
                <div style={{ marginTop: 4 }}>
                  Only the original publisher can push to this application.
                </div>
              )}
              {info.coPublishers.map((c) => (
                <div
                  key={c.key}
                  style={{ display: "flex", gap: 6, alignItems: "baseline", marginTop: 4 }}
                >
                  <span>{c.name || "(unnamed)"}</span>
                  <span style={mutedStyle}>{c.key.slice(0, 12)}…</span>
                  {c.isYou && <span style={mutedStyle}>· this computer</span>}
                  {info.youAreTheRoot && (
                    <button
                      style={linkButtonStyle}
                      onClick={() => void handleRemove(c.key, c.name)}
                    >
                      remove
                    </button>
                  )}
                </div>
              ))}

              <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
                {info.youAreTheRoot && (
                  <button onClick={() => void handleAdd()} disabled={busy}>
                    Add a co-publisher…
                  </button>
                )}
                <button onClick={() => void handleCopyMyKey()}>Copy my publisher key</button>
              </div>
              {copied && (
                <div style={{ ...mutedStyle, marginTop: 4 }}>
                  Copied {copied.slice(0, 12)}… — send it to whoever owns the application.
                </div>
              )}

              {!info.youAreTheRoot && (
                <div style={{ ...mutedStyle, marginTop: 6, lineHeight: 1.4 }}>
                  Only the publisher who created this application can change this
                  list. Send them your key and ask to be added — never swap key
                  files: this computer holds one publisher identity, used for every
                  application you publish.
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// The styles and `formatWhen` now live in ./explorerStyles so the Environments
// section beside this one renders identically rather than from a second copy.
