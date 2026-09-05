// FILENAME: app/extensions/Distribution/components/CheckoutDialog.tsx
// PURPOSE: Open a published application version as a WORKING COPY — the author-side
// counterpart of Subscribe.
// CONTEXT: Subscribing gets you a COPY of an application to use; opening one
// for editing gets you the application itself to change. The difference that
// matters is identity: a checked-out workbook keeps the application's sheet
// ids, so pushing it produces the next version rather than something that
// merely shares the name. Publishing from a subscribed copy would orphan every
// other subscriber's local edits, which is why the push gate refuses it and
// points here.

import React, { useEffect, useMemo, useState } from "react";
import type { DialogProps, ApplicationInfo } from "@api";
import { listApplicationsInWorkspace, checkoutApplication } from "@api";
import { listWorkspaces, type SavedWorkspace, isHttpWorkspace } from "@api/distributionWorkspaces";
import { useDialogWindow } from "@api/dialogWindow";
import { pickWorkspaceFile } from "../lib/pickWorkspace";
import { environmentsAtVersion } from "../lib/environments";

export function CheckoutDialog({ onClose, data }: DialogProps) {
  const win = useDialogWindow({ minWidth: 460, minHeight: 380 });

  // Opened from somewhere that already knows the answer — today the Publish
  // dialog, when the name you typed turns out to be an application that already
  // exists. Narrowed with typeof guards rather than cast: `data` is
  // `Record<string, unknown>` from a caller this component does not control.
  const preRegistry = typeof data?.registryPath === "string" ? data.registryPath : "";
  const prePackage = typeof data?.packageName === "string" ? data.packageName : "";

  const [saved, setSaved] = useState<SavedWorkspace[]>([]);
  const [registryPath, setRegistryPath] = useState(preRegistry);
  const [packages, setPackages] = useState<ApplicationInfo[] | null>(null);
  const [selectedPackage, setSelectedPackage] = useState<string>("");
  const [selectedVersion, setSelectedVersion] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listWorkspaces()
      .then(setSaved)
      .catch(() => setSaved([]));
    // Pre-pointed: load the workspace straight away and pre-select the
    // application, so arriving here from "this name already exists" lands on the
    // thing that already exists rather than on an empty form.
    if (preRegistry) void loadPackages(preRegistry, prePackage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preRegistry, prePackage]);

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

  // Opening for editing always targets a workspace somebody already published
  // into, and the pointer file is written by
  // `LocalWorkspace::write_application_manifest` — the one write every publish
  // route makes — so there is exactly one gesture here and no folder fallback.
  // A location with no `workspace.calcula` has no applications in it either.
  // The text field still takes a typed or pasted path, which is how an
  // `https://` workspace is reached.
  const handleBrowseFolder = async () => {
    const selected = await pickWorkspaceFile();
    if (selected) {
      setRegistryPath(selected);
      void loadPackages(selected);
    }
  };

  const loadPackages = async (location: string, preferName?: string) => {
    setError(null);
    setBusy("Reading workspace…");
    setPackages(null);
    setSelectedPackage("");
    setSelectedVersion("");
    try {
      const list = await listApplicationsInWorkspace(location);
      setPackages(list);
      // Case-insensitively, matching how the workspace resolves a name to a
      // directory on the platform this ships on.
      const preferred = preferName
        ? list.find((p) => p.name.toLowerCase() === preferName.toLowerCase())
        : undefined;
      if (preferred) selectPackage(preferred);
      else if (list.length === 1) selectPackage(list[0]);
    } catch (err: unknown) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  };

  const selectPackage = (p: ApplicationInfo) => {
    setSelectedPackage(p.name);
    // Default to the newest version — the one a push would be based on.
    setSelectedVersion(p.versions.length ? p.versions[p.versions.length - 1].version : "");
  };

  const handleCheckout = async () => {
    setError(null);
    // NO DIRTY-CHECK CONFIRM ANY MORE, because there is nothing to discard:
    // opening an application for editing ADDS its sheets to the workbook you
    // already have open. It used to replace the document the way File > Open
    // does, which meant the price of looking at an application was the sheet you
    // were working on.
    setBusy("Opening…");
    try {
      const result = await checkoutApplication({
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

  const httpRegistry = registryPath.trim() !== "" && isHttpWorkspace(registryPath);

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
        <span style={{ fontWeight: 600 }}>Open Application for Editing</span>
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
          Adds the application&rsquo;s sheets to this workbook as a working copy
          you can edit and push back. Your own sheets stay where they are, and a
          push carries the application&rsquo;s sheets only. The copy keeps the
          application&rsquo;s own identity — so subscribers see your next version
          as an update, not as a new report.
        </div>

        <div style={fieldStyle}>
          <label>Workspace</label>
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
              <option value="">Choose a saved workspace…</option>
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
              placeholder="C:\shared\workspace"
            />
            <button
              onClick={handleBrowseFolder}
              style={{ whiteSpace: "nowrap" }}
              title="Pick a workspace by its workspace.calcula file"
            >
              Browse…
            </button>
            <button
              onClick={() => void loadPackages(registryPath)}
              disabled={!registryPath.trim()}
              style={{ whiteSpace: "nowrap" }}
            >
              List applications
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
            <label>Application</label>
            <select
              style={inputStyle}
              value={selectedPackage}
              onChange={(e) => {
                const p = packages.find((x) => x.name === e.target.value);
                if (p) selectPackage(p);
              }}
            >
              <option value="">Choose an application…</option>
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
                    {/* WHICH ONE IS LIVE. A developer opening an application to
                        fix something needs to know whether the version they are
                        about to base on is the one an audience is running —
                        that is the hotfix shape, and the push dialog warns about
                        it, but it is cheaper to see it here first. */}
                    {environmentsAtVersion(pkg?.environments ?? [], v.version).map((name) => (
                      <span
                        key={name}
                        style={{
                          marginLeft: 6,
                          fontSize: "11px",
                          padding: "0 5px",
                          borderRadius: 8,
                          background: "#e8f0fe",
                          color: "#1a5fb4",
                        }}
                      >
                        {name}
                      </span>
                    ))}
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
