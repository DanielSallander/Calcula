// FILENAME: app/extensions/Distribution/components/SubscribeDialog.tsx
// PURPOSE: Dialog for subscribing to (pulling) a .calp package.

import React, { useState, useEffect } from "react";
import type { DialogProps } from "@api";
import { pullPackage, emitAppEvent, AppEvents } from "@api";
import { inspectPackage, browseRegistry, type PackageInspection, type PackageInfo } from "@api/distribution";
import {
  listRegistries,
  addRegistry,
  isHttpRegistry,
  type SavedRegistry,
} from "@api/distributionRegistries";
import { open } from "@tauri-apps/plugin-dialog";
import { getConnections, connect, updateConnection } from "../../_shared/lib/bi-api";
import { pivot } from "@api/pivot";

/** Short human phrase for a declared capability id (R19), for the review box. */
const CAPABILITY_PHRASE: Record<string, string> = {
  "net.fetch": "fetch data from the web",
  "bi.query": "run read-only BI queries",
  storage: "store data on this device",
  "ui.html": "render custom HTML UI",
};

function capabilityPhrase(id: string): string {
  return CAPABILITY_PHRASE[id] ?? id;
}

export function SubscribeDialog({ onClose }: DialogProps) {
  const [registryPath, setRegistryPath] = useState("");
  const [packageName, setPackageName] = useState("");
  const [versionPin, setVersionPin] = useState("latest");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inspection, setInspection] = useState<PackageInspection | null>(null);

  // The packages found in the chosen registry (D6 — no more blind text entry).
  const [packages, setPackages] = useState<PackageInfo[] | null>(null);
  const [browsing, setBrowsing] = useState(false);

  // Saved-registry catalog (distribution brick 1): pick a known local OR http
  // registry instead of typing a path/URL blind.
  const [saved, setSaved] = useState<SavedRegistry[]>([]);
  useEffect(() => {
    listRegistries().then(setSaved).catch(() => setSaved([]));
  }, []);

  const handleSaveRegistry = async () => {
    const location = registryPath.trim();
    if (!location) return;
    const name = window.prompt("Name this registry", location) ?? location;
    try {
      const id = crypto.randomUUID();
      setSaved(await addRegistry({ id, name, location }));
    } catch {
      // ignore persistence failures — the path still works ad-hoc
    }
  };

  const handleBrowse = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Select Registry Folder",
      });
      if (selected && typeof selected === "string") {
        setRegistryPath(selected);
        setPackages(null);
      }
    } catch {
      // user cancelled
    }
  };

  // List the packages in the registry so the user can pick one instead of
  // typing its name + version blind.
  const handleListPackages = async () => {
    if (!registryPath.trim()) {
      setError("Choose a registry folder first.");
      return;
    }
    setError(null);
    setStatus(null);
    setBrowsing(true);
    try {
      const found = await browseRegistry(registryPath);
      setPackages(found);
      if (found.length === 0) setStatus("No packages found in this registry.");
    } catch (err: unknown) {
      setError(String(err));
    } finally {
      setBrowsing(false);
    }
  };

  // Step 1: inspect the package and show its contents for review.
  // Nothing is materialized until the user explicitly accepts.
  const handleReview = async () => {
    setError(null);
    setStatus("Inspecting package...");
    try {
      const result = await inspectPackage(registryPath, packageName, versionPin);
      setInspection(result);
      setStatus(null);
    } catch (err: unknown) {
      setError(String(err));
      setStatus(null);
    }
  };

  // Step 2: the user reviewed the contents and accepted — pull for real.
  const handlePull = async () => {
    setError(null);
    setStatus("Pulling...");

    try {
      const result = await pullPackage({
        registryPath,
        packageName,
        versionPin,
      });

      // Notify the app that sheets have changed so UI refreshes
      emitAppEvent(AppEvents.SHEET_CHANGED, {});

      // The pull may have materialized pane controls — tell the Controls pane
      // to reload (cross-extension window event; same name the shell fans the
      // paneControl mutation domain out as).
      window.dispatchEvent(new CustomEvent("controlspane:controls-refreshed"));

      // Let the ScriptableObjects extension register the pulled scripts and
      // run the consent flow in this session (not only after save/reopen).
      if (result.scriptsPulled > 0) {
        emitAppEvent("calp:scripts-pulled", { packageName: result.packageName });
      }

      setStatus(
        `Pulled ${result.packageName} v${result.resolvedVersion}: ` +
        `${result.sheetsPulled} sheet(s)` +
        (result.scriptsPulled > 0
          ? `, ${result.scriptsPulled} script(s) (restricted, consent required)`
          : "")
      );

      // Check for disconnected BI connections — try cached credentials first,
      // then prompt if no cached credentials exist
      try {
        const conns = await getConnections();
        const disconnected = conns.filter(c => !c.isConnected && c.server);
        if (disconnected.length > 0) {
          const conn = disconnected[0];
          const server = conn.server || "localhost";
          const db = conn.database || "";

          // Try auto-connect first (backend uses cached credentials if available)
          let connected = false;
          try {
            setStatus("Connecting to data source...");
            await connect(conn.id);
            connected = true;
          } catch {
            // Auto-connect failed (no cached credentials or wrong ones) — prompt
            const password = window.prompt(
              `Connect to ${conn.name}?\n` +
              `Server: ${server}\n` +
              `Database: ${db}\n\n` +
              `Enter password:`,
            );
            if (password !== null) {
              try {
                await updateConnection({ id: conn.id, connectionString: `__PASSWORD_ONLY__:${password}` });
                await connect(conn.id);
                connected = true;
              } catch (connectErr) {
                await updateConnection({ id: conn.id, connectionString: "" }).catch(() => {});
                setError(`Connection failed: ${connectErr}`);
                setStatus(null);
              }
            }
          }

          if (connected) {
            // Refresh all pivots with live data
            setStatus("Refreshing pivot tables...");
            const allPivots = await pivot.getAll();
            for (const p of allPivots) {
              try { await pivot.refreshCache(p.id); } catch { /* non-fatal */ }
            }
            window.dispatchEvent(new Event("pivot:refresh"));
            setStatus(
              `Connected to ${conn.name} and refreshed ${allPivots.length} pivot table(s)`
            );
          }
        }
      } catch (err2) {
        // Connection check itself failed — don't fail the pull
        console.warn("[Subscribe] Post-pull connect check failed:", err2);
      }

      // Close the dialog after a brief moment so the user sees the result
      setTimeout(() => onClose(), 1200);
    } catch (err: unknown) {
      setError(String(err));
      setStatus(null);
    }
  };

  const fieldStyle: React.CSSProperties = {
    display: "flex", flexDirection: "column", gap: "4px", marginBottom: "8px",
  };
  const inputStyle: React.CSSProperties = {
    padding: "4px 6px", border: "1px solid #ccc", borderRadius: "3px", fontSize: "13px",
  };

  // Review step: show what the package contains before anything lands.
  if (inspection) {
    return (
      <div style={{ padding: "16px", width: "420px", maxHeight: "80vh", overflowY: "auto" }}>
        <h3 style={{ margin: "0 0 12px 0" }}>
          Review: {inspection.packageName} v{inspection.resolvedVersion}
        </h3>

        <div style={{ fontSize: "12px", marginBottom: "8px" }}>
          <strong>Sheets ({inspection.sheets.length})</strong>
          {inspection.sheets.map((s, i) => (
            <div key={i} style={{ marginLeft: 8 }}>
              {s.name}{s.description ? ` — ${s.description}` : ""}
            </div>
          ))}
        </div>

        {inspection.scripts.length > 0 && (
          <div style={{
            fontSize: "12px", marginBottom: "8px", padding: "6px 8px",
            backgroundColor: "#fff3cd", borderRadius: 4,
          }}>
            <strong>Scripts ({inspection.scripts.length})</strong> — executable code.
            Scripts arrive in restricted mode and ask for consent before running.
            {inspection.scripts.map((s, i) => (
              <div key={i} style={{ marginLeft: 8 }}>
                {s.name} ({s.objectType}){s.description ? ` — ${s.description}` : ""}
                {s.requestedCapabilities.length > 0 && (
                  <div style={{ marginLeft: 8, color: "#664d03" }}>
                    wants: {s.requestedCapabilities.map(capabilityPhrase).join(", ")}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {inspection.dataSources.length > 0 && (
          <div style={{ fontSize: "12px", marginBottom: "8px" }}>
            <strong>Data sources ({inspection.dataSources.length})</strong>
            {inspection.dataSources.map((d, i) => (
              <div key={i} style={{ marginLeft: 8 }}>
                {d.name} ({d.connectionType}: {d.server}/{d.database})
              </div>
            ))}
          </div>
        )}

        <div style={{ fontSize: "12px", marginBottom: "12px", color: "#666" }}>
          {inspection.writebackRegionCount > 0 && (
            <div>{inspection.writebackRegionCount} writeback region(s) — cells you can fill in and submit back</div>
          )}
          {inspection.tableCount > 0 && (
            <div>
              {inspection.tableCount} table(s)
              {inspection.tableNames.length > 0 ? `: ${inspection.tableNames.join(", ")}` : ""}
            </div>
          )}
          {inspection.namedRangeCount > 0 && (
            <div>
              {inspection.namedRangeCount} named range(s)
              {inspection.namedRangeNames.length > 0
                ? `: ${inspection.namedRangeNames.join(", ")}`
                : ""}
            </div>
          )}
          {inspection.chartCount > 0 && <div>{inspection.chartCount} chart(s)</div>}
          {inspection.sparklineCount > 0 && (
            <div>{inspection.sparklineCount} sparkline group set(s)</div>
          )}
          {inspection.pivotCount > 0 && <div>{inspection.pivotCount} pivot table(s)</div>}
          {inspection.controlSheetCount > 0 && (
            <div>
              {inspection.controlSheetCount} sheet(s) with buttons/checkboxes — they
              arrive with their click actions disarmed; any package scripts are
              listed above and require consent
            </div>
          )}
          {inspection.paneControlCount > 0 && (
            <div>
              {inspection.paneControlCount} pane control(s)
              {inspection.paneControlNames.length > 0
                ? `: ${inspection.paneControlNames.join(", ")}`
                : ""}
            </div>
          )}
          {inspection.slicerCount > 0 && <div>{inspection.slicerCount} slicer(s)</div>}
          {inspection.ribbonFilterCount > 0 && (
            <div>{inspection.ribbonFilterCount} ribbon filter(s)</div>
          )}
          {inspection.pivotLayoutCount > 0 && (
            <div>{inspection.pivotLayoutCount} saved pivot layout(s)</div>
          )}
          {inspection.hasDocumentTheme && (
            <div>document theme — applied unless you customized yours</div>
          )}
          {inspection.commentSheetCount > 0 && (
            <div>
              includes comments on {inspection.commentSheetCount} sheet(s) —
              discussion threads the publisher chose to share
            </div>
          )}
          {inspection.extensionDataCount > 0 && (
            <div>
              {inspection.extensionDataCount} extension state key(s)
              {inspection.extensionDataKeys.length > 0
                ? `: ${inspection.extensionDataKeys.join(", ")}`
                : ""}{" "}
              — only keys you don't already have will apply
            </div>
          )}
        </div>

        {error && <div style={{ color: "red", marginBottom: "8px", fontSize: "12px" }}>{error}</div>}
        {status && <div style={{ color: "green", marginBottom: "8px", fontSize: "12px" }}>{status}</div>}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
          <button onClick={() => { setInspection(null); setStatus(null); setError(null); }}>
            Back
          </button>
          <button onClick={onClose}>Cancel</button>
          <button onClick={handlePull} style={{ fontWeight: 600 }}>
            Accept and Subscribe
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: "16px", width: "400px" }}>
      <h3 style={{ margin: "0 0 12px 0" }}>Subscribe to Package</h3>

      <div style={fieldStyle}>
        <label>Registry</label>
        {saved.length > 0 && (
          <select
            style={{ ...inputStyle, marginBottom: 4 }}
            value=""
            onChange={(e) => {
              if (e.target.value) { setRegistryPath(e.target.value); setPackages(null); }
            }}
          >
            <option value="">Saved registries…</option>
            {saved.map((r) => (
              <option key={r.id} value={r.location}>
                {r.name}{isHttpRegistry(r.location) ? "  (web)" : ""}
              </option>
            ))}
          </select>
        )}
        <div style={{ display: "flex", gap: "4px" }}>
          <input style={{ ...inputStyle, flex: 1 }} value={registryPath} onChange={(e) => { setRegistryPath(e.target.value); setPackages(null); }}
            placeholder="C:\shared\registry  or  https://host/registry" />
          <button onClick={handleBrowse} style={{ whiteSpace: "nowrap" }}>Browse...</button>
          <button onClick={handleListPackages} disabled={browsing} style={{ whiteSpace: "nowrap" }}>
            {browsing ? "..." : "List Packages"}
          </button>
        </div>
        {registryPath.trim() && (
          <button onClick={handleSaveRegistry} style={{ marginTop: 4, fontSize: 12, alignSelf: "flex-start" }}>
            ★ Save this registry
          </button>
        )}
      </div>

      {packages && packages.length > 0 && (
        <div style={{ marginBottom: 12, maxHeight: 168, overflowY: "auto", border: "1px solid #e0e0e0", borderRadius: 4 }}>
          {packages.map((pkg) => {
            const selected = packageName === pkg.name;
            return (
              <div
                key={pkg.name}
                onClick={() => { setPackageName(pkg.name); setVersionPin("latest"); }}
                style={{ padding: "6px 8px", borderBottom: "1px solid #f0f0f0", cursor: "pointer", background: selected ? "#eef5ff" : "transparent" }}
              >
                <div style={{ fontWeight: 600, fontSize: 13 }}>{pkg.name}</div>
                <div style={{ fontSize: 11, color: "#888" }}>
                  {pkg.description || pkg.kind}
                  {` · ${pkg.versions.length} version${pkg.versions.length !== 1 ? "s" : ""}`}
                  {pkg.author ? ` · ${pkg.author}` : ""}
                </div>
                {selected && pkg.versions.length > 0 && (
                  <div style={{ marginTop: 4, display: "flex", flexWrap: "wrap", gap: 4 }} onClick={(e) => e.stopPropagation()}>
                    <button
                      onClick={() => setVersionPin("latest")}
                      style={{ fontSize: 11, padding: "1px 6px", border: "none", borderRadius: 3, cursor: "pointer", background: versionPin === "latest" ? "#1967d2" : "#f1f3f4", color: versionPin === "latest" ? "#fff" : "#333" }}
                    >
                      latest
                    </button>
                    {[...pkg.versions].reverse().map((v) => {
                      const pin = `=${v.version}`;
                      return (
                        <button
                          key={v.version}
                          onClick={() => setVersionPin(pin)}
                          title={`Published ${v.publishedAt}${v.publishedBy ? ` by ${v.publishedBy}` : ""}`}
                          style={{ fontSize: 11, padding: "1px 6px", border: "none", borderRadius: 3, cursor: "pointer", background: versionPin === pin ? "#1967d2" : "#f1f3f4", color: versionPin === pin ? "#fff" : "#333" }}
                        >
                          {v.version}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div style={fieldStyle}>
        <label>Package Name</label>
        <input style={inputStyle} value={packageName} onChange={(e) => setPackageName(e.target.value)}
          placeholder="sales-report" />
      </div>
      <div style={fieldStyle}>
        <label>Version Pin</label>
        <input style={inputStyle} value={versionPin} onChange={(e) => setVersionPin(e.target.value)} />
        <span style={{ fontSize: "11px", color: "#888" }}>
          Examples: =1.2.3, ^1.0, ~1.2, latest
        </span>
      </div>

      {error && <div style={{ color: "red", marginBottom: "8px", fontSize: "12px" }}>{error}</div>}
      {status && <div style={{ color: "green", marginBottom: "8px", fontSize: "12px" }}>{status}</div>}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
        <button onClick={onClose}>Cancel</button>
        <button onClick={handleReview} style={{ fontWeight: 600 }}>Review Contents...</button>
      </div>
    </div>
  );
}
