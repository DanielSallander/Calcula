// FILENAME: app/extensions/Distribution/components/EnvironmentsSection.tsx
// PURPOSE: The pipeline — where the development line ends, where each
//          environment points, and the two buttons that move a pointer.
// CONTEXT: Before environments, a push WAS a release: the head is what every
//          `latest` subscriber's next refresh offers, so unreleased work reached
//          end users the moment it landed. An environment is a named pointer to
//          an immutable version on that same line. Promotion moves the pointer
//          and copies nothing, so what was tested is bit-for-bit what ships.
//
//          THIS SECTION IS THE WHOLE RELEASE SURFACE. There is no environment
//          control in the push dialog and none in the menu, deliberately: a push
//          is a push, and deciding who sees it is a separate, signed, attributed
//          act. Keeping the two gestures in two places is what stops "I saved my
//          work" from meaning "I shipped to production".
//
//          An application with no environments renders one line and an offer to
//          set one up. That is the default and it behaves exactly as before.

import React, { useCallback, useEffect, useState } from "react";
import type { EnvironmentsResponse, WorkingCopyStatus } from "@api";
import { listEnvironments, workingCopyStatus, ENVIRONMENTS_CHANGED_EVENT } from "@api";
import { AppEvents, onAppEvent, showDialog } from "@api";
import { PROMOTE_DIALOG_ID, EDIT_PIPELINE_DIALOG_ID } from "../manifest";
import {
  ddStyle,
  dtStyle,
  errorTextStyle,
  formatWhen,
  linkButtonStyle,
  mutedStyle,
  warnBoxStyle,
} from "./explorerStyles";
import { nextEnvironment, promotionSource, rollbackCandidates } from "../lib/environments";

export function EnvironmentsSection() {
  const [link, setLink] = useState<WorkingCopyStatus | null>(null);
  const [info, setInfo] = useState<EnvironmentsResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const reload = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const status = await workingCopyStatus();
      setLink(status);
      if (!status) {
        setInfo(null);
        return;
      }
      setInfo(
        await listEnvironments({
          registryPath: status.registryUrl,
          packageName: status.packageName,
        }),
      );
    } catch (e: unknown) {
      setError(String(e));
      setInfo(null);
    } finally {
      setLoaded(true);
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    // A pointer can move from four places: this panel, the promote dialog, a
    // push (which moves the head this section reads), and a colleague's
    // promotion arriving in a workspace we re-open. The first three emit;
    // the fourth is what the Refresh button is for.
    const offs = [
      onAppEvent(AppEvents.AFTER_OPEN, () => void reload()),
      onAppEvent(AppEvents.AFTER_NEW, () => void reload()),
      onAppEvent(AppEvents.PACKAGE_UPDATED, () => void reload()),
      onAppEvent(ENVIRONMENTS_CHANGED_EVENT, () => void reload()),
    ];
    return () => offs.forEach((off) => off());
  }, [reload]);

  if (!loaded) {
    return <div style={mutedStyle}>Reading workbook…</div>;
  }

  if (!link) {
    return (
      <div style={mutedStyle}>
        Environments belong to an application. Open one with{" "}
        <strong>Distribution &gt; Open Application for Editing</strong> to see where its
        releases stand.
      </div>
    );
  }

  if (error && !info) {
    return (
      <div style={{ fontSize: "12px" }}>
        <div style={errorTextStyle}>{error}</div>
        <div style={{ marginTop: 8 }}>
          <button onClick={() => void reload()} disabled={busy}>
            {busy ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>
    );
  }

  const envs = info?.environments ?? [];
  const head = info?.headVersion ?? link.headVersion ?? "";
  const mayPromote = (info?.youMayPromote ?? false) && (info?.writable ?? false);
  const pipeline = envs.map((e) => e.name);

  const promote = (environment: string, mode: "promote" | "rollback") => {
    showDialog(PROMOTE_DIALOG_ID, {
      registryPath: link.registryUrl,
      packageName: link.packageName,
      environment,
      mode,
    });
  };

  return (
    <div style={{ fontSize: "12px" }}>
      {/* The problem case must not look like the empty case. "No environments"
          is a normal state; "the promotion log did not verify" is a workspace
          somebody may have tampered with, and reading the second as the first
          would invite an admin to blithely define a fresh pipeline over it. */}
      {info?.problem && <div style={warnBoxStyle}>{info.problem}</div>}

      {/* The line always comes first: it is what a push moves, and what the
          first environment promotes from. */}
      <div
        style={{
          padding: "6px 8px",
          borderRadius: 3,
          border: "1px solid var(--border-default)",
          marginBottom: 8,
        }}
      >
        <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
          <span style={{ fontWeight: 600 }}>Development line</span>
          <span>{head ? `v${head}` : "nothing published yet"}</span>
          {head && <span style={mutedStyle}>· head</span>}
        </div>
        <div style={{ ...mutedStyle, marginTop: 2 }}>
          Every push lands here. Nobody is moved onto it unless they deliberately
          subscribe to the line.
        </div>
        {envs.length > 0 && head && (
          <div style={{ marginTop: 6 }}>
            <button
              onClick={() => promote(envs[0].name, "promote")}
              disabled={!mayPromote || envs[0].version === head}
              title={
                !mayPromote
                  ? "Only a publisher of this application can promote."
                  : envs[0].version === head
                    ? `${envs[0].name} is already at v${head}.`
                    : undefined
              }
            >
              Promote to {envs[0].name}
            </button>
          </div>
        )}
      </div>

      {envs.length === 0 && (
        <div style={mutedStyle}>
          This application has no environments, so every subscriber follows the
          development line and sees each push at their next refresh. A pipeline lets
          you hold them on a version you have tested.
        </div>
      )}

      {envs.map((env, i) => {
        const after = nextEnvironment(pipeline, env.name);
        const source = promotionSource(envs, head, env.name);
        const candidates = rollbackCandidates(env);
        const nextEnv = after ? envs[i + 1] : null;
        const promoteOnDisabled =
          !mayPromote || !env.version || (nextEnv?.version ?? null) === env.version;
        return (
          <div
            key={env.name}
            style={{
              padding: "6px 8px",
              marginBottom: 4,
              borderRadius: 3,
              border: "1px solid var(--border-default)",
            }}
          >
            <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
              <span style={{ fontWeight: 600 }}>{env.name}</span>
              {env.version ? (
                <span>v{env.version}</span>
              ) : (
                <span style={mutedStyle}>nothing promoted yet</span>
              )}
              {env.previousVersion && (
                <span style={mutedStyle}>· was v{env.previousVersion}</span>
              )}
            </div>
            {env.version && (
              <div style={{ ...mutedStyle, marginTop: 2 }}>
                {env.promotedBy ? `${env.promotedBy} · ` : ""}
                {formatWhen(env.promotedAt)}
                {env.isYou ? " · you" : ""}
              </div>
            )}
            <div style={{ ...mutedStyle, marginTop: 2 }}>
              Promoted from {source.label}.
            </div>

            <div style={{ marginTop: 6, display: "flex", gap: 8, flexWrap: "wrap" }}>
              {after && (
                <button
                  onClick={() => promote(after, "promote")}
                  disabled={promoteOnDisabled}
                  title={
                    !mayPromote
                      ? "Only a publisher of this application can promote."
                      : !env.version
                        ? `${env.name} has nothing to promote yet.`
                        : (nextEnv?.version ?? null) === env.version
                          ? `${after} is already at v${env.version}.`
                          : undefined
                  }
                >
                  Promote → {after}
                </button>
              )}
              {candidates.length > 0 && (
                <button onClick={() => promote(env.name, "rollback")} disabled={!mayPromote}>
                  Roll back…
                </button>
              )}
            </div>
          </div>
        );
      })}

      {/* An unauthorised viewer sees the pipeline — it is not a secret, and
          knowing what prod runs is exactly what a colleague needs — with every
          action disabled and a pointer at who can change it. */}
      {info && !info.youMayPromote && (
        <div style={{ ...mutedStyle, marginTop: 6, lineHeight: 1.4 }}>
          This computer does not hold a key authorised to publish this application, so
          it cannot promote. Promotion rights are push rights — see{" "}
          <strong>Who can publish this?</strong> under Working copy.
        </div>
      )}
      {info && info.youMayPromote && !info.writable && (
        <div style={{ ...mutedStyle, marginTop: 6, lineHeight: 1.4 }}>
          This workspace is served over HTTP and is read-only here, so promotion has to
          happen wherever the files live.
        </div>
      )}

      {error && info && <div style={{ ...errorTextStyle, marginTop: 6 }}>{error}</div>}

      <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          onClick={() =>
            showDialog(EDIT_PIPELINE_DIALOG_ID, {
              registryPath: link.registryUrl,
              packageName: link.packageName,
            })
          }
          disabled={!mayPromote}
          title={
            mayPromote ? undefined : "Only a publisher of this application can change this."
          }
        >
          {envs.length === 0 ? "Set up pipeline…" : "Edit pipeline…"}
        </button>
        <button onClick={() => void reload()} disabled={busy}>
          {busy ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {(info?.history?.length ?? 0) > 0 && (
        <div style={{ marginTop: 10 }}>
          <button style={linkButtonStyle} onClick={() => setShowHistory((h) => !h)}>
            {showHistory ? "Hide promotion history" : `Promotion history (${info!.history.length})`}
          </button>
          {showHistory && (
            <div style={{ marginTop: 6 }}>
              {info!.history.map((h) => (
                <div key={h.sequence} style={{ marginTop: 4, lineHeight: 1.4 }}>
                  <div>
                    {h.kind === "pipeline" ? (
                      <>
                        Pipeline set to{" "}
                        {h.environments.length > 0 ? h.environments.join(" → ") : "(none)"}
                      </>
                    ) : (
                      <>
                        <strong>{h.environment}</strong>{" "}
                        {h.previousVersion ? `v${h.previousVersion} → ` : ""}v{h.version}
                        {h.isRollback && (
                          <span style={{ color: "#664d03", fontWeight: 600 }}> · rolled back</span>
                        )}
                      </>
                    )}
                  </div>
                  <div style={mutedStyle}>
                    {h.by ? `${h.by} · ` : ""}
                    {formatWhen(h.at)}
                    {h.isYou ? " · you" : ""} · key {h.key.slice(0, 12)}…
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <dl
        style={{
          margin: "10px 0 0",
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          gap: "2px 10px",
        }}
      >
        <dt style={dtStyle}>Your base</dt>
        <dd style={ddStyle}>
          v{link.baseVersion}
          {link.baseIsPromoted && (
            <span style={mutedStyle}> · what {link.baseIsPromoted} runs</span>
          )}
        </dd>
      </dl>
    </div>
  );
}
