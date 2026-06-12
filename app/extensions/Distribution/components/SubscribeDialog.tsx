// FILENAME: app/extensions/Distribution/components/SubscribeDialog.tsx
// PURPOSE: Dialog for subscribing to (pulling) a .calp package.

import React, { useState } from "react";
import type { DialogProps } from "@api";
import { pullPackage, emitAppEvent, AppEvents } from "@api";
import { inspectPackage, type PackageInspection } from "@api/distribution";
import { open } from "@tauri-apps/plugin-dialog";
import { getConnections, connect, updateConnection } from "../../BusinessIntelligence/lib/bi-api";
import { pivot } from "@api/pivot";

export function SubscribeDialog({ onClose }: DialogProps) {
  const [registryPath, setRegistryPath] = useState("");
  const [packageName, setPackageName] = useState("");
  const [versionPin, setVersionPin] = useState("latest");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inspection, setInspection] = useState<PackageInspection | null>(null);

  const handleBrowse = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Select Registry Folder",
      });
      if (selected && typeof selected === "string") {
        setRegistryPath(selected);
      }
    } catch {
      // user cancelled
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
      <div style={{ padding: "16px", width: "420px" }}>
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
          {inspection.tableCount > 0 && <div>{inspection.tableCount} table(s)</div>}
          {inspection.namedRangeCount > 0 && <div>{inspection.namedRangeCount} named range(s)</div>}
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
        <label>Registry Path</label>
        <div style={{ display: "flex", gap: "4px" }}>
          <input style={{ ...inputStyle, flex: 1 }} value={registryPath} onChange={(e) => setRegistryPath(e.target.value)}
            placeholder="C:\shared\registry" />
          <button onClick={handleBrowse} style={{ whiteSpace: "nowrap" }}>Browse...</button>
        </div>
      </div>
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
