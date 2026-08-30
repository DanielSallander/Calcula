// FILENAME: app/extensions/Distribution/components/CheckoutDialog.tsx
// PURPOSE: Open a published package version as a WORKING COPY — the author-side
// counterpart of Subscribe.
// CONTEXT: Subscribing gets you a COPY of a package to use; checking out gets
// you the package itself to change. The difference that matters is identity:
// a checked-out workbook keeps the package's sheet ids, so pushing it produces
// the next version rather than something that merely shares the name. Publishing
// from a subscribed copy would orphan every other subscriber's local edits,
// which is why the push gate refuses it and points here.

import React, { useEffect, useMemo, useState } from "react";
import type { DialogProps, PackageInfo } from "@api";
import { browseRegistry, checkoutPackage } from "@api";
import { confirmAsync } from "@api/dialogs";
import { isFileModified } from "@api/filesystem";
import { listRegistries, type SavedRegistry, isHttpRegistry } from "@api/distributionRegistries";
import { useDialogWindow } from "@api/dialogWindow";
import { open as openNativeDialog } from "@tauri-apps/plugin-dialog";

export function CheckoutDialog({ onClose }: DialogProps) {
  const win = useDialogWindow({ minWidth: 460, minHeight: 380 });

  const [saved, setSaved] = useState<SavedRegistry[]>([]);
  const [registryPath, setRegistryPath] = useState("");
  const [packages, setPackages] = useState<PackageInfo[] | null>(null);
  const [selectedPackage, setSelectedPackage] = useState<string>("");
  const [selectedVersion, setSelectedVersion] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listRegistries()
      .then(setSaved)
      .catch(() => setSaved([]));
  }, []);

  const pkg = useMemo(
    () => packages?.find((p) => p.name === selectedPackage) ?? null,
    [packages, selectedPackage],
  );

  // Newest first: a developer almost always wants the current version, and
  // making them scroll past the history to reach it is backwards.
  const versionsNewestFirst = useMemo(
    () => (pkg ? [...pkg.versions].reverse() : []),
    [pkg],
  );

  const handleBrowseFolder = async () => {
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

  const loadPackages = async (location: string) => {
    setError(null);
    setBusy("Reading registry…");
    setPackages(null);
    setSelectedPackage("");
    setSelectedVersion("");
    try {
      const list = await browseRegistry(location);
      setPackages(list);
      if (list.length === 1) selectPackage(list[0]);
    } catch (err: unknown) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  };

  const selectPackage = (p: PackageInfo) => {
    setSelectedPackage(p.name);
    // Default to the newest version — the one a push would be based on.
    setSelectedVersion(p.versions.length ? p.versions[p.versions.length - 1].version : "");
  };

  const handleCheckout = async () => {
    setError(null);
    // Opening a package REPLACES the document, exactly as File > Open does.
    // `confirmAsync` (never window.confirm — that returns a Promise under Tauri
    // and a bare `if (!confirm(...))` never fires) and it fails CLOSED, so a
    // dialog that cannot be shown means "do not discard".
    if (await isFileModified()) {
      const ok = await confirmAsync(
        `Discard unsaved changes and open ${selectedPackage} v${selectedVersion} for editing?`,
      );
      if (!ok) return;
    }
    setBusy("Opening…");
    try {
      const result = await checkoutPackage({
        registryPath,
        packageName: selectedPackage,
        version: selectedVersion || undefined,
      });
      setBusy(null);
      onClose();
      void result;
    } catch (err: unknown) {
      setError(String(err));
      setBusy(null);
    }
  };

  const httpRegistry = registryPath.trim() !== "" && isHttpRegistry(registryPath);

  const windowStyle: React.CSSProperties = {
    position: "fixed",
    left: "50%",
    top: "10%",
    transform: "translateX(-50%)",
    width: "520px",
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

  return (
    <div ref={win.ref} style={{ ...windowStyle, ...win.style }}>
      <div style={headerStyle} onMouseDown={win.onHeaderMouseDown}>
        <span style={{ fontWeight: 600 }}>Open Package for Editing</span>
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
        <div
          style={{
            fontSize: "12px",
            color: "var(--text-secondary)",
            marginBottom: "12px",
            lineHeight: 1.45,
          }}
        >
          Opens the package as a working copy you can edit and push back. This
          replaces the current workbook, and the copy keeps the package&rsquo;s own
          identity — so subscribers see your next version as an update, not as a
          new report.
        </div>

        <div style={fieldStyle}>
          <label>Registry</label>
          {saved.length > 0 && (
            <select
              style={inputStyle}
              value={saved.find((r) => r.location === registryPath)?.id ?? ""}
              onChange={(e) => {
                const reg = saved.find((r) => r.id === e.target.value);
                if (reg) {
                  setRegistryPath(reg.location);
                  void loadPackages(reg.location);
                }
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
            <button onClick={handleBrowseFolder} style={{ whiteSpace: "nowrap" }}>
              Browse…
            </button>
            <button
              onClick={() => void loadPackages(registryPath)}
              disabled={!registryPath.trim()}
              style={{ whiteSpace: "nowrap" }}
            >
              List packages
            </button>
          </div>
          {httpRegistry && (
            <div style={{ fontSize: "11px", color: "var(--text-secondary)" }}>
              This is a read-only HTTP registry: you can open a package from it,
              but you will not be able to push back to it.
            </div>
          )}
        </div>

        {packages && packages.length === 0 && (
          <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
            No packages in this registry.
          </div>
        )}

        {packages && packages.length > 0 && (
          <div style={fieldStyle}>
            <label>Package</label>
            <select
              style={inputStyle}
              value={selectedPackage}
              onChange={(e) => {
                const p = packages.find((x) => x.name === e.target.value);
                if (p) selectPackage(p);
              }}
            >
              <option value="">Choose a package…</option>
              {packages.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                  {p.kind && p.kind !== "report" ? ` (${p.kind})` : ""}
                </option>
              ))}
            </select>
          </div>
        )}

        {pkg && (
          <div style={fieldStyle}>
            <label>Version</label>
            <div
              style={{
                border: "1px solid var(--border-default)",
                borderRadius: "3px",
                maxHeight: "180px",
                overflowY: "auto",
              }}
            >
              {versionsNewestFirst.map((v, i) => (
                <label
                  key={v.version}
                  style={{
                    display: "flex",
                    gap: "8px",
                    alignItems: "flex-start",
                    padding: "6px 8px",
                    cursor: "pointer",
                    borderBottom:
                      i < versionsNewestFirst.length - 1
                        ? "1px solid var(--border-default)"
                        : "none",
                    background:
                      selectedVersion === v.version ? "var(--bg-selected, #e8f0fe)" : "transparent",
                  }}
                >
                  <input
                    type="radio"
                    name="checkout-version"
                    checked={selectedVersion === v.version}
                    onChange={() => setSelectedVersion(v.version)}
                    style={{ marginTop: "2px" }}
                  />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontWeight: 600 }}>v{v.version}</span>
                    {i === 0 && (
                      <span
                        style={{
                          marginLeft: 6,
                          fontSize: "11px",
                          color: "var(--text-secondary)",
                        }}
                      >
                        (current)
                      </span>
                    )}
                    <span
                      style={{
                        display: "block",
                        fontSize: "11px",
                        color: "var(--text-secondary)",
                      }}
                    >
                      {v.publishedBy ? `${v.publishedBy} · ` : ""}
                      {v.publishedAt}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}

        {error && (
          <div style={{ color: "var(--text-error, #d33)", fontSize: "12px", marginTop: "8px" }}>
            {error}
          </div>
        )}
        {busy && (
          <div style={{ color: "var(--text-secondary)", fontSize: "12px", marginTop: "8px" }}>
            {busy}
          </div>
        )}
      </div>

      <div style={footerStyle}>
        <button onClick={onClose}>Cancel</button>
        <button
          onClick={handleCheckout}
          disabled={!registryPath.trim() || !selectedPackage || busy !== null}
          style={{ fontWeight: 600 }}
        >
          Open for Editing
        </button>
      </div>

      {win.resizeHandles}
    </div>
  );
}
