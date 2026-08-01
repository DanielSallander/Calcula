//! FILENAME: app/extensions/ScriptableObjects/components/ScriptMarketplace.tsx
// PURPOSE: The Script Libraries browser — search a .calp registry for library
//          packages, review the WHOLE dependency closure, install against the
//          workbook lockfile, check for updates, and uninstall.
// CONTEXT: This replaces the former "Script Marketplace", which was a local
//          file-exchange placebo: a drag-and-drop for `.calcula-template` JSON
//          plus a hard-coded "Community Registry (Coming Soon)" card. That path
//          had no versioning, no signature check and — the reason it is DELETED
//          rather than kept — no consent gate: it wrote a dropped file's
//          `scriptSource` into the template store after showing a 500-character
//          preview. Template export/import still exists in the Template Manager;
//          what is gone is the unconsented install side door.
// SECURITY: This component decides nothing. Every trust decision is made by
//          @api/scriptLibraries and, beneath it, the existing .calp trust root:
//            * resolution verifies the publisher's Ed25519 signature + TOFU pin
//              and every module artifact's SHA-256 (an unsigned package cannot
//              be resolved at all, so there is no "install anyway" affordance);
//            * the whole transitive closure is listed NODE BY NODE with its own
//              publisher and capabilities — never "and 7 more", which is how
//              supply-chain attacks get approved;
//            * the capability lines are what the library DECLARES; what a given
//              script actually gets is that set intersected with the script's
//              own declaration, and the panel says so instead of implying the
//              library gets what it asked for;
//            * presence in a registry means "published", not "reviewed" — no
//              copy here may imply curation.

import React, { useState, useCallback, useEffect, useMemo } from "react";
import { showToast } from "@api";
import { useDialogWindow } from "@api/dialogWindow";
import { listRegistries, type SavedRegistry } from "@api/distributionRegistries";
import {
  searchLibraries,
  planInstall,
  applyInstall,
  checkUpdates,
  uninstallLibrary,
  listInstalledLibraries,
  type RegistryPackageInfo,
  type InstallPlan,
  type LockedLibrary,
  type LibraryUpdateStatus,
} from "@api/scriptLibraries";
import type { DialogProps } from "@api/uiTypes";

// ============================================================================
// Styles
// ============================================================================

const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  backgroundColor: "rgba(0,0,0,0.4)",
  zIndex: 9000,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const container: React.CSSProperties = {
  position: "relative",
  display: "flex",
  flexDirection: "column",
  width: 720,
  height: "80vh",
  maxHeight: "80vh",
  fontFamily: "'Segoe UI', Tahoma, sans-serif",
  fontSize: 12,
  backgroundColor: "var(--panel-bg, #FAFAFA)",
  color: "var(--panel-fg, #202020)",
  borderRadius: 4,
  overflow: "hidden",
  boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
};

const header: React.CSSProperties = {
  padding: "10px 14px",
  borderBottom: "1px solid var(--panel-border, #E0E0E0)",
  backgroundColor: "var(--panel-header-bg, #FFF)",
  flexShrink: 0,
  cursor: "move",
  userSelect: "none",
};

const body: React.CSSProperties = { flex: 1, overflowY: "auto", padding: 14 };

const footer: React.CSSProperties = {
  padding: "8px 14px",
  borderTop: "1px solid var(--panel-border, #E0E0E0)",
  display: "flex",
  gap: 8,
  justifyContent: "flex-end",
  flexShrink: 0,
};

const card: React.CSSProperties = {
  border: "1px solid var(--panel-border, #E0E0E0)",
  borderRadius: 4,
  padding: 10,
  marginBottom: 8,
  backgroundColor: "var(--panel-header-bg, #FFF)",
};

const btn: React.CSSProperties = {
  padding: "5px 12px",
  fontSize: 12,
  border: "1px solid var(--panel-border, #CCC)",
  borderRadius: 3,
  backgroundColor: "transparent",
  color: "inherit",
  cursor: "pointer",
};

const btnPrimary: React.CSSProperties = {
  ...btn,
  backgroundColor: "var(--accent, #0078D4)",
  borderColor: "var(--accent, #0078D4)",
  color: "#FFF",
};

const input: React.CSSProperties = {
  padding: "5px 8px",
  fontSize: 12,
  border: "1px solid var(--panel-border, #CCC)",
  borderRadius: 3,
  backgroundColor: "var(--input-bg, #FFF)",
  color: "inherit",
};

const codeBox: React.CSSProperties = {
  fontFamily: "'Cascadia Code', Consolas, monospace",
  fontSize: 11,
  lineHeight: "1.4",
  backgroundColor: "#1E1E1E",
  color: "#D4D4D4",
  padding: 10,
  borderRadius: 4,
  maxHeight: 240,
  overflow: "auto",
  whiteSpace: "pre-wrap",
};

const tag = (bg: string, fg: string): React.CSSProperties => ({
  display: "inline-block",
  padding: "1px 6px",
  borderRadius: 8,
  fontSize: 10,
  backgroundColor: bg,
  color: fg,
  marginLeft: 6,
});

// ============================================================================
// Component
// ============================================================================

type Tab = "browse" | "installed";

export default function ScriptMarketplace({ onClose }: DialogProps): React.ReactElement {
  const win = useDialogWindow({ minWidth: 520, minHeight: 380 });
  const winReset = win.reset;
  useEffect(() => winReset(), [winReset]); // open centered at its natural size

  const [tab, setTab] = useState<Tab>("browse");
  const [registries, setRegistries] = useState<SavedRegistry[]>([]);
  const [location, setLocation] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RegistryPackageInfo[] | null>(null);
  const [pins, setPins] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [plan, setPlan] = useState<InstallPlan | null>(null);
  const [showCode, setShowCode] = useState<string | null>(null);

  const [installed, setInstalled] = useState<LockedLibrary[]>([]);
  const [updates, setUpdates] = useState<LibraryUpdateStatus[] | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const saved = await listRegistries();
        setRegistries(saved);
        if (saved.length > 0) setLocation(saved[0].location);
      } catch {
        /* no saved registries is fine — the user can paste a location */
      }
      try {
        setInstalled(await listInstalledLibraries());
      } catch {
        /* no lockfile yet */
      }
    })();
  }, []);

  const refreshInstalled = useCallback(async () => {
    setInstalled(await listInstalledLibraries());
  }, []);

  const runSearch = useCallback(async () => {
    if (!location.trim()) {
      setError("Choose or type a registry location first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setResults(await searchLibraries(location.trim(), query));
    } catch (e) {
      setResults(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [location, query]);

  const review = useCallback(
    async (pkg: string, pin: string, registryLocation: string) => {
      setBusy(true);
      setError(null);
      try {
        setPlan(await planInstall(registryLocation.trim(), [{ package: pkg, pin }]));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        showToast(`Could not resolve ${pkg}: ${e instanceof Error ? e.message : String(e)}`, {
          type: "error",
        });
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const confirmInstall = useCallback(async () => {
    if (!plan) return;
    setBusy(true);
    try {
      await applyInstall(plan);
      showToast(`Installed ${plan.roots.join(", ")}`, { type: "success" });
      setPlan(null);
      await refreshInstalled();
      setUpdates(null);
      setTab("installed");
    } catch (e) {
      showToast(`Install failed: ${e instanceof Error ? e.message : String(e)}`, { type: "error" });
    } finally {
      setBusy(false);
    }
  }, [plan, refreshInstalled]);

  const runUpdateCheck = useCallback(async () => {
    setBusy(true);
    try {
      setUpdates(await checkUpdates());
    } catch (e) {
      showToast(`Update check failed: ${e instanceof Error ? e.message : String(e)}`, {
        type: "error",
      });
    } finally {
      setBusy(false);
    }
  }, []);

  const remove = useCallback(
    async (pkg: string) => {
      try {
        await uninstallLibrary(pkg);
        showToast(`Removed ${pkg}`, { type: "success" });
        await refreshInstalled();
      } catch (e) {
        showToast(`Remove failed: ${e instanceof Error ? e.message : String(e)}`, { type: "error" });
      }
    },
    [refreshInstalled],
  );

  const updateFor = useMemo(() => {
    const map = new Map<string, LibraryUpdateStatus>();
    for (const u of updates ?? []) map.set(u.package, u);
    return map;
  }, [updates]);

  // --------------------------------------------------------------------------
  // The consent gate. ONE decision covers the whole resolved graph; any later
  // change to any node re-prompts with a diff (distributedConsent's per-source-
  // hash rule), which is why nothing here offers a per-node approval.
  // --------------------------------------------------------------------------
  const renderPlan = (p: InstallPlan): React.ReactElement => (
    <div>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
        Install {p.roots.join(", ")}
      </div>
      {p.upToDate && (
        <div style={{ ...card, borderStyle: "dashed" }}>
          Every package in this closure is already installed and approved in this workbook.
        </div>
      )}
      {p.nodes.map((n) => (
        <div key={n.package} style={card}>
          <div style={{ fontWeight: 600 }}>
            {n.package} {n.version}
            <span style={tag("#E8F4EA", "#1B6B2C")}>
              signed · {n.publisherName || "unnamed publisher"} ·{" "}
              {n.trustStatus === "firstUse" ? "first use" : "verified"}
            </span>
            {n.transitive && (
              <span style={tag("#FFF4E5", "#8A5300")}>
                required by {n.requiredBy.join(", ") || "another package"}
              </span>
            )}
            {n.changed.length > 0 && (
              <span style={tag("#FDE7E9", "#A80000")}>{n.changed.length} module(s) changed</span>
            )}
          </div>
          {n.description && (
            <div style={{ color: "var(--panel-muted, #666)", marginTop: 2 }}>{n.description}</div>
          )}
          <div style={{ marginTop: 6 }}>
            <b>This library declares:</b>{" "}
            {n.declaredCapabilities.length === 0 ? (
              <span style={{ color: "var(--panel-muted, #666)" }}>no capabilities</span>
            ) : (
              n.declaredCapabilities.join(", ")
            )}
          </div>
          <div style={{ marginTop: 2 }}>
            <b>Exports:</b> {n.exports.length ? n.exports.join(", ") : "(none)"}
          </div>
          <div style={{ marginTop: 6 }}>
            <button
              style={btn}
              onClick={() => setShowCode(showCode === n.package ? null : n.package)}
            >
              {showCode === n.package ? "Hide code" : "Review code"}
            </button>
          </div>
          {showCode === n.package && (
            <div style={{ marginTop: 8 }}>
              {n.modules.map((m) => (
                <div key={m.id} style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 11, color: "var(--panel-muted, #666)", marginBottom: 2 }}>
                    {m.name} ({m.id}) · sha256 {m.sourceHash.slice(0, 12)}
                  </div>
                  <div style={codeBox}>{m.source}</div>
                </div>
              ))}
              {n.changed.map((c) => (
                <div key={`diff-${c.id}`} style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 11, color: "#A80000", marginBottom: 2 }}>
                    Previously approved source for {c.id}:
                  </div>
                  <div style={codeBox}>{c.oldSource}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
      <div style={{ ...card, backgroundColor: "var(--panel-bg, #F3F3F3)" }}>
        A script only gets what it declares for itself. When a script imports one of these
        libraries, the library runs with{" "}
        <b>the capabilities above intersected with that script&apos;s own declaration</b> — never
        more. Presence in a registry means the package was published, not that it was reviewed.
      </div>
    </div>
  );

  const renderBrowse = (): React.ReactElement => (
    <div>
      <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
        <select
          style={{ ...input, minWidth: 150 }}
          value={registries.some((r) => r.location === location) ? location : ""}
          onChange={(e) => setLocation(e.target.value)}
        >
          <option value="">(saved registries)</option>
          {registries.map((r) => (
            <option key={r.id} value={r.location}>
              {r.name}
            </option>
          ))}
        </select>
        <input
          style={{ ...input, flex: 1, minWidth: 180 }}
          placeholder="Registry path or https:// URL"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
        />
        <input
          style={{ ...input, width: 140 }}
          placeholder="Search…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void runSearch();
          }}
        />
        <button style={btnPrimary} onClick={() => void runSearch()} disabled={busy}>
          Search
        </button>
      </div>

      {error && <div style={{ ...card, color: "#A80000" }}>{error}</div>}

      {results && results.length === 0 && (
        <div style={{ ...card, borderStyle: "dashed" }}>
          No library packages in this registry match. Only packages published with
          kind=&quot;library&quot; can be imported by a script.
        </div>
      )}

      {(results ?? []).map((p) => {
        const latest = p.versions[p.versions.length - 1]?.version ?? "";
        const pin = pins[p.name] ?? (latest ? `^${latest}` : "latest");
        return (
          <div key={p.name} style={card}>
            <div style={{ fontWeight: 600 }}>
              {p.name}
              <span style={{ color: "var(--panel-muted, #666)", fontWeight: 400 }}>
                {" "}
                {p.versions.length} version{p.versions.length === 1 ? "" : "s"}
                {p.author ? ` · ${p.author}` : ""}
              </span>
            </div>
            {p.description && (
              <div style={{ color: "var(--panel-muted, #666)", marginTop: 2 }}>{p.description}</div>
            )}
            <div style={{ marginTop: 6, display: "flex", gap: 6, alignItems: "center" }}>
              <select
                style={{ ...input, width: 170 }}
                value={pin}
                onChange={(e) => setPins((prev) => ({ ...prev, [p.name]: e.target.value }))}
              >
                {latest && <option value={`^${latest}`}>^{latest} (compatible)</option>}
                {p.versions
                  .slice()
                  .reverse()
                  .map((v) => (
                    <option key={v.version} value={v.version}>
                      {v.version} (exact)
                    </option>
                  ))}
              </select>
              <button
                style={btn}
                disabled={busy}
                onClick={() => void review(p.name, pin, location)}
              >
                Review &amp; install…
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );

  const renderInstalled = (): React.ReactElement => (
    <div>
      <div style={{ marginBottom: 10 }}>
        <button style={btn} onClick={() => void runUpdateCheck()} disabled={busy}>
          Check for updates
        </button>
        <span style={{ marginLeft: 8, color: "var(--panel-muted, #666)" }}>
          Updates are never applied automatically — a version bump that changes executed code is
          reviewed like any other source change.
        </span>
      </div>
      {installed.length === 0 && (
        <div style={{ ...card, borderStyle: "dashed" }}>
          This workbook has no script libraries. A script declares one with a{" "}
          <code>// @uses alias package@^1.0.0</code> pragma and calls it as{" "}
          <code>await imports.alias.fn(...)</code>.
        </div>
      )}
      {installed.map((l) => {
        const u = updateFor.get(l.package);
        return (
          <div key={l.package} style={card}>
            <div style={{ fontWeight: 600 }}>
              {l.package} {l.resolved}
              <span style={{ color: "var(--panel-muted, #666)", fontWeight: 400 }}>
                {" "}
                pinned {l.pin} · {l.publisherName || "unnamed publisher"}
              </span>
              {l.requiredBy.length > 0 && (
                <span style={tag("#FFF4E5", "#8A5300")}>required by {l.requiredBy.join(", ")}</span>
              )}
            </div>
            <div style={{ marginTop: 4, color: "var(--panel-muted, #666)" }}>
              {l.modules.length} module(s) ·{" "}
              {[...new Set(l.modules.flatMap((m) => m.exports))].join(", ") || "no exports"}
              {l.modules.some((m) => m.capabilities.length > 0) && (
                <>
                  {" · declares "}
                  {[...new Set(l.modules.flatMap((m) => m.capabilities))].join(", ")}
                </>
              )}
            </div>
            {u && (
              <div style={{ marginTop: 6 }}>
                {u.error ? (
                  <span style={{ color: "#A80000" }}>Update check failed: {u.error}</span>
                ) : u.available && (u.available !== l.resolved || u.sourceChanged) ? (
                  <>
                    <span>
                      {u.available} available
                      {u.sourceChanged ? " · source changed" : ""}
                      {u.capabilityChanged
                        ? ` · capabilities changed${
                            u.addedCapabilities.length ? `: +${u.addedCapabilities.join(", ")}` : ""
                          }`
                        : ""}
                      {u.newDependencies.length > 0
                        ? ` · would also install: ${u.newDependencies.join(", ")}`
                        : ""}
                      {u.publisherKeyChanged ? " · PUBLISHER KEY CHANGED" : ""}
                    </span>
                    <button
                      style={{ ...btn, marginLeft: 8 }}
                      disabled={busy}
                      onClick={() => void review(l.package, l.pin, l.registry)}
                    >
                      Review update…
                    </button>
                  </>
                ) : (
                  <span style={{ color: "var(--panel-muted, #666)" }}>Up to date.</span>
                )}
              </div>
            )}
            <div style={{ marginTop: 6 }}>
              <button style={btn} onClick={() => void remove(l.package)}>
                Remove
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );

  return (
    <div style={overlay} onClick={onClose}>
      <div
        ref={win.ref}
        style={{ ...container, ...win.style }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={header} onMouseDown={win.onHeaderMouseDown}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Script Libraries</div>
          <div style={{ fontSize: 11, color: "var(--panel-muted, #666)" }}>
            Install signed, versioned libraries from a package registry and import them from your
            scripts.
          </div>
          <div style={{ marginTop: 6, display: "flex", gap: 6 }}>
            <button
              style={tab === "browse" ? btnPrimary : btn}
              onClick={() => {
                setTab("browse");
                setPlan(null);
              }}
            >
              Browse
            </button>
            <button
              style={tab === "installed" ? btnPrimary : btn}
              onClick={() => {
                setTab("installed");
                setPlan(null);
              }}
            >
              Installed ({installed.length})
            </button>
          </div>
        </div>

        <div style={body}>
          {plan ? renderPlan(plan) : tab === "browse" ? renderBrowse() : renderInstalled()}
        </div>

        <div style={footer}>
          {plan ? (
            <>
              <button style={btn} onClick={() => setPlan(null)} disabled={busy}>
                Cancel
              </button>
              <button style={btnPrimary} onClick={() => void confirmInstall()} disabled={busy}>
                Install
              </button>
            </>
          ) : (
            <button style={btn} onClick={onClose}>
              Close
            </button>
          )}
        </div>

        {win.resizeHandles}
      </div>
    </div>
  );
}
