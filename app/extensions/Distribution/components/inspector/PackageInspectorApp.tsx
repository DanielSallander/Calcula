// FILENAME: app/extensions/Distribution/components/inspector/PackageInspectorApp.tsx
// PURPOSE: Root component of the standalone Package Inspector window — browse
//          to a registry, pick a package + version, and inspect EVERYTHING it
//          contains (manifest, signature, sheet data, objects, scripts, model,
//          writeback, raw artifacts). Strictly read-only: nothing is
//          subscribed or materialized.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { open as openNativeDialog } from "@tauri-apps/plugin-dialog";
import {
  browseRegistry,
  inspectorOverview,
  type InspectorOverview,
  type PackageInfo,
} from "@api/distribution";
import { listRegistries, type SavedRegistry } from "@api/distributionRegistries";
import {
  emitInspectorReady,
  onOpenPackage,
  type InspectorOpenPayload,
} from "../../lib/inspectorWindowEvents";
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

export function PackageInspectorApp(): React.ReactElement {
  const [saved, setSaved] = useState<SavedRegistry[]>([]);
  const [registryPath, setRegistryPath] = useState("");
  const [packages, setPackages] = useState<PackageInfo[] | null>(null);
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
    listRegistries().then(setSaved).catch(() => setSaved([]));
  }, []);

  const listPackagesAt = useCallback(async (path: string): Promise<PackageInfo[]> => {
    const found = await browseRegistry(path);
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

  // Keep the latest loader reachable from the (once-registered) event
  // listener without re-subscribing per render.
  const loadRef = useRef({ listPackagesAt, loadOverview });
  loadRef.current = { listPackagesAt, loadOverview };

  // Cross-window bridge: register the listener FIRST, then announce
  // readiness so the main window can hand over the initial package.
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

  const handleBrowse = async () => {
    try {
      const selected = await openNativeDialog({
        directory: true,
        multiple: false,
        title: "Select Registry Folder",
      });
      if (selected && typeof selected === "string") {
        setRegistryPath(selected);
        setPackages(null);
        setPackageName("");
        setError(null);
        try {
          await listPackagesAt(selected);
        } catch (err: unknown) {
          setError(String(err));
        }
      }
    } catch {
      // user cancelled
    }
  };

  const handleListPackages = async () => {
    if (!registryPath.trim()) {
      setError("Choose a registry folder or URL first.");
      return;
    }
    setError(null);
    try {
      await listPackagesAt(registryPath.trim());
    } catch (err: unknown) {
      setError(String(err));
    }
  };

  const selectedPackage = packages?.find((p) => p.name === packageName) ?? null;

  return (
    <div style={appStyle}>
      <div style={topBarStyle}>
        <span style={{ fontWeight: 600 }}>Registry</span>
        {saved.length > 0 && (
          <select
            style={inputStyle}
            value=""
            onChange={(e) => {
              const reg = saved.find((r) => r.id === e.target.value);
              if (reg) {
                setRegistryPath(reg.location);
                setPackages(null);
                setPackageName("");
                void listPackagesAt(reg.location).catch((err) => setError(String(err)));
              }
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
          placeholder="Registry folder or https:// URL"
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
          List Packages
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
              <option value="">Select package…</option>
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
              {selectedPackage?.versions.map((v) => (
                <option key={v.version} value={v.version}>
                  v{v.version}
                </option>
              ))}
            </select>
            <button
              style={primaryButtonStyle}
              disabled={busy || !packageName}
              onClick={() => void loadOverview(registryPath.trim(), packageName, versionPin)}
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
                ? "Verifying signature and reading the package…"
                : "Browse to a registry, pick a published package and a version, then Inspect. " +
                  "Everything is read directly from the registry — nothing is subscribed or changed."}
            </div>
          ) : (
            <>
              {section === "overview" && <OverviewSection overview={overview} />}
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
