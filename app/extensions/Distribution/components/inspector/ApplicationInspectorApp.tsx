// FILENAME: app/extensions/Distribution/components/inspector/ApplicationInspectorApp.tsx
// PURPOSE: Root component of the standalone Application Inspector window —
//          browse to a workspace, pick an application + version, and inspect
//          EVERYTHING it contains (manifest, signature, sheet data, objects,
//          scripts, model, writeback, raw artifacts). Strictly read-only:
//          nothing is subscribed or materialized.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { open as openNativeDialog } from "@tauri-apps/plugin-dialog";
import {
  listApplicationsInWorkspace,
  inspectorOverview,
  inspectorResolveLocation,
  type InspectorOverview,
  type ApplicationInfo,
} from "@api/distribution";
import { listWorkspaces, type SavedWorkspace } from "@api/distributionWorkspaces";
import {
  emitInspectorReady,
  onOpenPackage,
  type InspectorOpenPayload,
} from "../../lib/inspectorWindowEvents";
import { installInspectorFormPreviewClient } from "../../lib/inspectorFormPreview";
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

  const listPackagesAt = useCallback(async (path: string): Promise<ApplicationInfo[]> => {
    const found = await listApplicationsInWorkspace(path);
    setPackages(found);
    return found;
  }, []);

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

  // One entry point for every user-typed/browsed location: users naturally
  // pick the application or version FOLDER itself, not the workspace root — the
  // backend walks up and tells us what was actually picked, so we can list
  // the workspace AND jump straight to the picked application/version. An empty
  // workspace must say so — silently rendering nothing reads as a dead button.
  const resolveAndLoad = useCallback(
    async (rawPath: string) => {
      setError(null);
      setPackages(null);
      setPackageName("");
      try {
        const resolved = await inspectorResolveLocation(rawPath);
        setRegistryPath(resolved.registryPath);
        const found = await listPackagesAt(resolved.registryPath);
        if (found.length === 0) {
          setError(
            "No applications found here. Pick the workspace folder — the one that contains " +
              "the application folders — or any application/version folder inside it.",
          );
          return;
        }
        if (
          resolved.packageName &&
          found.some((p) => p.name === resolved.packageName)
        ) {
          setPackageName(resolved.packageName);
          const pin = resolved.version ?? "latest";
          setVersionPin(pin);
          void loadOverview(resolved.registryPath, resolved.packageName, pin);
        }
      } catch (err: unknown) {
        setError(String(err));
      }
    },
    [listPackagesAt, loadOverview],
  );

  // Keep the latest loader reachable from the (once-registered) event
  // listener without re-subscribing per render.
  const loadRef = useRef({ listPackagesAt, loadOverview });
  loadRef.current = { listPackagesAt, loadOverview };

  // Cross-window bridge: register the listener FIRST, then announce
  // readiness so the main window can hand over the initial application.
  useEffect(() => {
    const openPromise = onOpenPackage((payload: InspectorOpenPayload) => {
      if (!payload.registryPath) return; // empty payload = just focus
      setRegistryPath(payload.registryPath);
      void loadRef.current.listPackagesAt(payload.registryPath).catch(() => setPackages(null));
      if (payload.packageName) {
        setPackageName(payload.packageName);
        const pin = payload.versionPin || "latest";
        setVersionPin(pin);
        void loadRef.current.loadOverview(payload.registryPath, payload.packageName, pin);
      }
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

  const handleBrowse = async () => {
    try {
      const selected = await openNativeDialog({
        directory: true,
        multiple: false,
        title: "Select Workspace, Application, or Version Folder",
      });
      if (selected && typeof selected === "string") {
        await resolveAndLoad(selected);
      }
    } catch {
      // user cancelled
    }
  };

  const handleListPackages = async () => {
    if (!registryPath.trim()) {
      setError("Choose a workspace folder or URL first.");
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
        <button style={buttonStyle} onClick={() => void handleBrowse()}>
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
                setPackageName(e.target.value);
                setVersionPin("latest");
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
            <div style={{ ...mutedStyle, padding: 24, fontSize: 13 }}>
              {busy
                ? "Verifying signature and reading the application…"
                : "Browse to a workspace — or directly to an application or version folder " +
                  "inside one — then Inspect. Everything is read directly from the workspace; " +
                  "nothing is subscribed or changed."}
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
