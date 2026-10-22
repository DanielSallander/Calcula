// FILENAME: app/extensions/Collaboration/components/inspector/ApplicationInspectorApp.tsx
// PURPOSE: Root component of the standalone Application Inspector window —
//          browse to a workspace, pick an application + version, and inspect
//          EVERYTHING it contains (manifest, signature, sheet data, objects,
//          scripts, model, writeback, raw artifacts). Strictly read-only:
//          nothing is subscribed or materialized.

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  listApplicationsInWorkspace,
  inspectorOverview,
  inspectorResolveLocation,
  type InspectorOverview,
  type ApplicationInfo,
} from "@api/collaboration";
import { listWorkspaces, type SavedWorkspace } from "@api/collaborationWorkspaces";
import {
  emitInspectorReady,
  onOpenPackage,
  type InspectorOpenPayload,
} from "../../lib/inspectorWindowEvents";
import { installInspectorFormPreviewClient } from "../../lib/inspectorFormPreview";
import { pickWorkspaceFile } from "../../lib/pickWorkspace";
import { resolveVersionChoice, versionLabel } from "../../lib/environments";
import {
  ACCENT,
  BORDER,
  ERR_RED,
  buttonStyle,
  inputStyle,
  mutedStyle,
  primaryButtonStyle,
} from "./shared";
import { OverviewSection } from "./OverviewSection";
import { CompareSection } from "./CompareSection";
import { SheetsSection } from "./SheetsSection";
import { ObjectsSection } from "./ObjectsSection";
import { ScriptsSection } from "./ScriptsSection";
import { ModelSection } from "./ModelSection";
import { WritebackSection } from "./WritebackSection";
import { ArtifactsSection } from "./ArtifactsSection";

/** What every section needs to fetch deeper data for the inspected version. */
export interface InspectorContext {
  registryPath: string;
  packageName: string;
  /** The RESOLVED version (exact pin) of the loaded overview. */
  version: string;
}

const SECTIONS: { id: string; label: string }[] = [
  { id: "overview", label: "Overview" },
  // Second, right after the version list it answers a question about.
  { id: "compare", label: "Compare Versions" },
  { id: "sheets", label: "Sheets & Data" },
  { id: "objects", label: "Objects" },
  { id: "scripts", label: "Scripts & Code" },
  { id: "model", label: "Data Model" },
  { id: "writeback", label: "Writeback" },
  { id: "artifacts", label: "Artifacts & Integrity" },
];

const appStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "100%",
  height: "100%",
  background: "#f4f5f7",
  color: "#222",
  fontFamily: "'Segoe UI', system-ui, sans-serif",
  fontSize: 13,
  overflow: "hidden",
};

const topBarStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "8px 12px",
  background: "#fff",
  borderBottom: `1px solid ${BORDER}`,
  flexShrink: 0,
  flexWrap: "wrap",
};

const navStyle: React.CSSProperties = {
  width: 170,
  flexShrink: 0,
  borderRight: `1px solid ${BORDER}`,
  background: "#eef0f2",
  paddingTop: 8,
  overflowY: "auto",
};

const navItemStyle = (active: boolean): React.CSSProperties => ({
  padding: "7px 14px",
  fontSize: 12,
  cursor: "pointer",
  userSelect: "none",
  color: active ? ACCENT : "#333",
  fontWeight: active ? 600 : 400,
  background: active ? "#fff" : "transparent",
  borderLeft: active ? `3px solid ${ACCENT}` : "3px solid transparent",
});

const contentStyle: React.CSSProperties = {
  flex: 1,
  overflow: "auto",
  padding: 16,
};

/**
 * What the content area says while no application is loaded. It names the
 * NEXT step for the state the window is actually in: the fixed "Browse … then
 * Inspect" line was shown even after the user had browsed, so it read as if
 * the workspace were empty (BUG-0552).
 */
function placeholderText(s: {
  busy: boolean;
  packages: ApplicationInfo[] | null;
  packageName: string;
}): string {
  if (s.busy) return "Verifying signature and reading the application…";
  if (s.packages && s.packages.length > 0) {
    if (!s.packageName) {
      const count =
        s.packages.length === 1
          ? "One application is"
          : `${s.packages.length} applications are`;
      return `${count} in this workspace. Choose one in the application list above to inspect it.`;
    }
    return `Press Inspect to read ${s.packageName}.`;
  }
  return (
    "Browse to a workspace's workspace.calcula file — or type the path of an " +
    "application or version folder inside one. Everything is read directly from " +
    "the workspace; nothing is subscribed or changed."
  );
}

/** What every way of picking a workspace says when it holds no application. */
export const NO_APPLICATIONS_TEXT =
  "No applications found here. If this is the right workspace, nothing has been " +
  "published to it yet. Otherwise use Browse to pick its workspace.calcula file.";

export function ApplicationInspectorApp(): React.ReactElement {
  const [saved, setSaved] = useState<SavedWorkspace[]>([]);
  const [registryPath, setRegistryPath] = useState("");
  const [packages, setPackages] = useState<ApplicationInfo[] | null>(null);
  const [packageName, setPackageName] = useState("");
  const [versionPin, setVersionPin] = useState("latest");
  const [overview, setOverview] = useState<InspectorOverview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState("overview");

  // The loaded context: pinned to the RESOLVED version so section fetches
  // stay on the version the overview showed even if "latest" moves.
  const [ctx, setCtx] = useState<InspectorContext | null>(null);

  useEffect(() => {
    listWorkspaces().then(setSaved).catch(() => setSaved([]));
  }, []);

  // The listing does NOT set state itself: the caller does, after checking
  // that its pick is still the latest one (see `pickSeq`).
  const listPackagesAt = useCallback(
    (path: string): Promise<ApplicationInfo[]> => listApplicationsInWorkspace(path),
    [],
  );

  // PICK token. Choosing a workspace (Browse, a typed path, a Saved one, a
  // handover from the main window) runs a resolve and a listing before any
  // overview load, and `loadSeq` guards only that last step: a slow share
  // picked first and a fast one picked second could finish in the wrong
  // order, and the slow one then overwrote the path field and the application
  // list -- and, starting its own load, dropped the fast one's -- leaving the
  // fast workspace's overview on screen under the slow one's listing. Every
  // pick takes a token, and every await checks it before touching state.
  const pickSeq = useRef(0);

  // Staleness token: two loads can be in flight at once (Inspect click +
  // cross-window handover) — only the LATEST may commit state.
  const loadSeq = useRef(0);
  const loadOverview = useCallback(
    async (path: string, pkg: string, pin: string) => {
      const seq = ++loadSeq.current;
      setBusy(true);
      setError(null);
      try {
        const o = await inspectorOverview(path, pkg, pin);
        if (loadSeq.current !== seq) return;
        setOverview(o);
        setCtx({ registryPath: path, packageName: pkg, version: o.resolvedVersion });
        setSection("overview");
      } catch (err: unknown) {
        if (loadSeq.current !== seq) return;
        setOverview(null);
        setCtx(null);
        setError(String(err));
      } finally {
        if (loadSeq.current === seq) setBusy(false);
      }
    },
    [],
  );

  // A newly chosen workspace must not keep showing the PREVIOUS workspace's
  // application underneath its own listing, and a load still in flight for
  // that previous one must not land after the switch (bumping the token makes
  // it stale).
  const clearLoaded = useCallback(() => {
    loadSeq.current++;
    setBusy(false);
    setOverview(null);
    setCtx(null);
  }, []);

  // WHICH APPLICATION TO OPEN once a workspace has been listed, and opening it.
  //
  // The application the location itself named (an application or version
  // folder, or a handover from the main window) wins when it is listed;
  // otherwise a workspace holding exactly ONE application opens that one.
  // Picking a workspace is the whole gesture: the pointer file — the only thing
  // Browse can return, and the common case — names no application, and a
  // listing that stopped there left every section on the "Browse … then
  // Inspect" hint the user had just followed, so each tab read as empty
  // (BUG-0552). With two or more applications nothing is guessed; the content
  // area says to choose one in the list.
  const selectAndLoad = useCallback(
    (
      path: string,
      found: readonly { name: string }[],
      preferred: string | null,
      preferredPin: string | null,
    ): boolean => {
      const named = preferred && found.some((p) => p.name === preferred) ? preferred : null;
      const name = named ?? (found.length === 1 ? found[0].name : null);
      if (!name) return false;
      const pin = named && preferredPin ? preferredPin : "latest";
      setPackageName(name);
      setVersionPin(pin);
      void loadOverview(path, name, pin);
      return true;
    },
    [loadOverview],
  );

  // One entry point for every user-typed/browsed location: users naturally
  // pick the application or version FOLDER itself, not the workspace root — the
  // backend walks up and tells us what was actually picked, so we can list
  // the workspace AND jump straight to the picked application/version. An empty
  // workspace must say so — silently rendering nothing reads as a dead button.
  const resolveAndLoad = useCallback(
    async (rawPath: string) => {
      const seq = ++pickSeq.current;
      setError(null);
      setPackages(null);
      setPackageName("");
      clearLoaded();
      try {
        const resolved = await inspectorResolveLocation(rawPath);
        if (pickSeq.current !== seq) return;
        setRegistryPath(resolved.registryPath);
        const found = await listPackagesAt(resolved.registryPath);
        if (pickSeq.current !== seq) return;
        setPackages(found);
        if (found.length === 0) {
          // Two different situations end here, and the message has to serve
          // both: a real workspace nothing has been published to yet (often
          // reached through Browse, so "pick the pointer file" would send the
          // user round in a circle), and a typed path that is not a workspace.
          setError(NO_APPLICATIONS_TEXT);
          return;
        }
        selectAndLoad(resolved.registryPath, found, resolved.packageName, resolved.version);
      } catch (err: unknown) {
        if (pickSeq.current !== seq) return;
        setError(String(err));
      }
    },
    [listPackagesAt, selectAndLoad, clearLoaded],
  );

  // Keep the latest loader reachable from the (once-registered) event
  // listener without re-subscribing per render.
  const loadRef = useRef({ listPackagesAt, selectAndLoad, clearLoaded });
  loadRef.current = { listPackagesAt, selectAndLoad, clearLoaded };

  // Cross-window bridge: register the listener FIRST, then announce
  // readiness so the main window can hand over the initial application.
  useEffect(() => {
    const openPromise = onOpenPackage((payload: InspectorOpenPayload) => {
      if (!payload.registryPath) return; // empty payload = just focus
      const path = payload.registryPath;
      // A handover is a pick like any other: it takes the token, so a pick
      // still resolving in this window cannot land after it.
      const seq = ++pickSeq.current;
      setRegistryPath(path);
      setError(null);
      setPackages(null);
      setPackageName("");
      loadRef.current.clearLoaded();
      if (payload.packageName) {
        // The sender named the application: open it at once; the listing only
        // fills the pickers, so it runs alongside. Its failure does not block
        // the overview, but it is SAID: without the listing the application
        // and version pickers are not shown, and another version cannot be
        // chosen.
        void loadRef.current
          .listPackagesAt(path)
          .then((found) => {
            if (pickSeq.current === seq) setPackages(found);
          })
          .catch((err: unknown) => {
            if (pickSeq.current !== seq) return;
            setPackages(null);
            setError(`Could not list the workspace's applications: ${String(err)}`);
          });
        loadRef.current.selectAndLoad(
          path,
          [{ name: payload.packageName }],
          payload.packageName,
          payload.versionPin || null,
        );
        return;
      }
      // A workspace and no application: the listing is AWAITED, because the
      // only application it holds can be known only once the listing is in.
      void (async () => {
        let found: ApplicationInfo[];
        try {
          found = await loadRef.current.listPackagesAt(path);
        } catch (err: unknown) {
          if (pickSeq.current !== seq) return;
          setPackages(null);
          setError(String(err));
          return;
        }
        if (pickSeq.current !== seq) return;
        setPackages(found);
        // The same sentence a Browse to an empty workspace gives, not the
        // generic Browse hint.
        if (found.length === 0) {
          setError(NO_APPLICATIONS_TEXT);
          return;
        }
        loadRef.current.selectAndLoad(path, found, null, null);
      })();
    });
    void openPromise.then(() => emitInspectorReady());
    return () => {
      void openPromise.then((unlisten) => unlisten());
    };
  }, []);

  // The other half of the cross-window wire: this window ASKS the main one to
  // preview a form's layout (it has no Shell, so no renderer of its own), and
  // the answer arrives here. Subscribed once for the window's lifetime, before
  // any section can render a Preview layout button.
  useEffect(() => installInspectorFormPreviewClient(), []);

  // THROUGH THE SEAM, like every other dialog that points at a workspace.
  //
  // This was the one selector that opened a raw FOLDER picker, so the user
  // aimed at `workspace.calcula` everywhere except here. It was not a deliberate
  // exemption: the seam's own rule listed the four dialogs it knew about and
  // never mentioned this window. What the folder picker offered beyond a
  // workspace — jumping straight to an application or version folder — is still
  // reachable by typing or pasting that path, because the field and this button
  // both go through `resolveAndLoad`.
  const handleBrowse = async () => {
    const selected = await pickWorkspaceFile();
    if (selected) await resolveAndLoad(selected);
  };

  const handleListPackages = async () => {
    if (!registryPath.trim()) {
      setError("Choose a workspace or type its location first.");
      return;
    }
    await resolveAndLoad(registryPath.trim());
  };

  const selectedPackage = packages?.find((p) => p.name === packageName) ?? null;
  // The line's head: the LAST entry, because the listing is published in
  // ascending version order and the head is what a push moves.
  const head = selectedPackage?.versions.length
    ? selectedPackage.versions[selectedPackage.versions.length - 1].version
    : "";

  return (
    <div style={appStyle}>
      <div style={topBarStyle}>
        <span style={{ fontWeight: 600 }}>Workspace</span>
        {saved.length > 0 && (
          <select
            style={inputStyle}
            value=""
            onChange={(e) => {
              const reg = saved.find((r) => r.id === e.target.value);
              if (reg) void resolveAndLoad(reg.location);
            }}
          >
            <option value="">Saved…</option>
            {saved.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        )}
        <input
          style={{ ...inputStyle, flex: 1, minWidth: 180 }}
          placeholder="Workspace, application, or version folder — or https:// URL"
          value={registryPath}
          onChange={(e) => setRegistryPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleListPackages();
          }}
        />
        <button
          style={buttonStyle}
          onClick={() => void handleBrowse()}
          title="Pick a workspace by its workspace.calcula file"
        >
          Browse…
        </button>
        <button style={buttonStyle} onClick={() => void handleListPackages()}>
          List Applications
        </button>

        {packages && packages.length > 0 && (
          <>
            <select
              style={inputStyle}
              value={packageName}
              onChange={(e) => {
                // Choosing an application OPENS it (at its latest version), the
                // way a workspace browser does; Inspect stays for reading a
                // different version of the one already chosen. The read is
                // verify-and-read only, so opening on choice changes nothing.
                const name = e.target.value;
                setPackageName(name);
                setVersionPin("latest");
                setError(null);
                if (!name) {
                  clearLoaded();
                  return;
                }
                void loadOverview(registryPath.trim(), name, "latest");
              }}
            >
              <option value="">Select application…</option>
              {packages.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name} ({p.kind})
                </option>
              ))}
            </select>
            <select
              style={inputStyle}
              value={versionPin}
              onChange={(e) => setVersionPin(e.target.value)}
              disabled={!selectedPackage}
            >
              <option value="latest">latest</option>
              {/* "What is prod running?" is the question an inspector is opened
                  with more often than any version number. The optgroup answers
                  it without the reader having to cross-reference a pointer
                  against a list of versions. */}
              {(selectedPackage?.environments.length ?? 0) > 0 && (
                <optgroup label="Environments">
                  {selectedPackage!.environments.map((e) => (
                    <option key={`env:${e.name}`} value={`env:${e.name}`} disabled={!e.version}>
                      {e.name} {e.version ? `→ v${e.version}` : "— nothing promoted yet"}
                    </option>
                  ))}
                </optgroup>
              )}
              {selectedPackage?.versions.map((v) => (
                <option key={v.version} value={v.version}>
                  {versionLabel(v.version, selectedPackage?.environments ?? [], head)}
                </option>
              ))}
            </select>
            <button
              style={primaryButtonStyle}
              disabled={busy || !packageName}
              onClick={() => {
                // `env:prod` is UI-LOCAL and never travels. A prefix inside a pin
                // string is the dead `channel:` convention — a magic form every
                // parser has to special-case — and `VersionPin::parse` refuses
                // it by name. Resolve here, before any backend call.
                const choice = resolveVersionChoice(
                  versionPin,
                  selectedPackage?.environments ?? [],
                );
                if ("error" in choice) {
                  setError(choice.error);
                  return;
                }
                void loadOverview(registryPath.trim(), packageName, choice.version);
              }}
            >
              {busy ? "Inspecting…" : "Inspect"}
            </button>
          </>
        )}
      </div>

      {error && (
        <div
          style={{
            padding: "6px 12px",
            background: "#fdecea",
            color: ERR_RED,
            fontSize: 12,
            borderBottom: "1px solid #f5c6cb",
            flexShrink: 0,
          }}
        >
          {error}
        </div>
      )}

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <div style={navStyle}>
          {SECTIONS.map((s) => (
            <div
              key={s.id}
              style={navItemStyle(section === s.id)}
              onClick={() => setSection(s.id)}
            >
              {s.label}
            </div>
          ))}
        </div>
        <div style={contentStyle}>
          {!overview || !ctx ? (
            <div
              data-testid="inspector-placeholder"
              style={{ ...mutedStyle, padding: 24, fontSize: 13 }}
            >
              {placeholderText({ busy, packages, packageName })}
            </div>
          ) : (
            <>
              {section === "overview" && (
                <OverviewSection
                  overview={overview}
                  registryPath={ctx?.registryPath ?? registryPath}
                  packageName={ctx?.packageName ?? packageName}
                />
              )}
              {section === "compare" && <CompareSection ctx={ctx} overview={overview} />}
              {section === "sheets" && <SheetsSection ctx={ctx} overview={overview} />}
              {section === "objects" && <ObjectsSection overview={overview} />}
              {section === "scripts" && <ScriptsSection ctx={ctx} overview={overview} />}
              {section === "model" && <ModelSection ctx={ctx} overview={overview} />}
              {section === "writeback" && <WritebackSection ctx={ctx} overview={overview} />}
              {section === "artifacts" && <ArtifactsSection ctx={ctx} overview={overview} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
