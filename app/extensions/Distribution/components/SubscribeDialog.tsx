// FILENAME: app/extensions/Distribution/components/SubscribeDialog.tsx
// PURPOSE: Floating window for subscribing to (pulling) a .calp package.
// CONTEXT: Non-modal like PublishDialog — no backdrop, the workbook stays
// interactive; movable + resizable via @api/dialogWindow. After a pull with a
// disconnected model source, tries saved sign-in silently and only then opens
// the shared ConnectSourceDialog credentials window (no window.prompt).

import React, { useState, useEffect } from "react";
import type { DialogProps, ConnectionInfo, CapabilityId } from "@api";
import {
  pullPackage,
  emitAppEvent,
  AppEvents,
  getSheets,
  setActiveSheetApi,
  type PackageUpdatedPayload,
} from "@api";
import {
  inspectPackage,
  browseRegistry,
  type CalpTrustStatus,
  type PackageInspection,
  type PackageInfo,
} from "@api/distribution";
import {
  listRegistries,
  addRegistry,
  isHttpRegistry,
  type SavedRegistry,
} from "@api/distributionRegistries";
import { open } from "@tauri-apps/plugin-dialog";
import { useDialogWindow } from "@api/dialogWindow";
import { openPackageInspectorWindow } from "../lib/openPackageInspectorWindow";
import { getConnections, connect, updateConnection } from "../../_shared/lib/bi-api";
import { ConnectSourceDialog, type ConnectSourceFields } from "../../_shared/components/ConnectSourceDialog";
import { pivot } from "@api/pivot";

/**
 * Short human phrase for a declared capability id (R19), for the review box —
 * the LAST screen before the user agrees to run somebody else's code.
 *
 * Typed `Record<CapabilityId, string>` on purpose: adding a capability to
 * ALL_CAPABILITY_IDS without writing its consent phrase must fail the BUILD,
 * not silently fall back to the raw id here. (It did exactly that until this
 * map went stale by five ids.)
 */
const CAPABILITY_PHRASE: Record<CapabilityId, string> = {
  "net.fetch": "fetch data from the web",
  "bi.query": "run read-only BI queries",
  "bi.sql": "run raw read-only SQL against your BI database",
  storage: "store data on this device",
  "ui.html": "render custom HTML UI",
  "formula.udf": "define formula functions you can use in cells",
  "bi.model": "change your BI model definitions (measures, relationships, ...)",
  "bi.connector": "feed external data into your BI model",
  "ui.dialog": "interrupt you with a dialog and read your answer",
  "distribution.writeback":
    "fill in and send the input cells of a subscribed package — and, for a package it can sign, read and approve everyone else's answers",
  // Subscribing is the moment somebody else's code enters this workbook, so
  // this phrase carries the part that survives the session: the schedule is
  // saved in YOUR workbook and starts itself again every time you open it.
  schedule:
    "run itself on a schedule while Calcula is open, without you starting it — saved in your workbook, so it resumes after a reload",
  // The last screen before somebody else's code enters this workbook, so the
  // phrase carries both what it can do AND the bound that makes it safe.
  "file.picker":
    "ask you to pick a file to save data into or to read — one file per ask, chosen by you in the usual Windows dialog, and it is never told where your files are",
  // Last screen before somebody else's code enters this workbook: say that a
  // key on YOUR keyboard is about to run THEIR code, and say in the same breath
  // what it cannot reach — otherwise "keyboard" reads as "keylogger".
  "ui.shortcut":
    "take over one Ctrl+Shift+letter keyboard shortcut so pressing it runs its code — never a shortcut Calcula needs or something else already uses, it appears in your shortcut list, and it never sees anything else you type",
  // Last screen before somebody else's code enters this workbook. Written in
  // the passive-with-a-subject form ("be shown") because there is no call to
  // point at: the host hands the values over. "Read your data" would be shorter
  // and would let a reader picture a file being opened; this is the workbook in
  // front of them, as they look at it.
  "grid.read":
    "be shown what is in your cells — the value of every cell on screen while it decides how to colour them, and the old value, new value and formula of every cell that changes while it is running",
  // These two can only be REQUESTED here, never exercised: a script that
  // arrives in a package is forced to the restricted tier, and every cap.pkg*
  // row is unlocked-tier. A package declaring them is asking for something this
  // surface will refuse — so say what it asked for, plainly, and let the reader
  // draw their own conclusion about a report that wants to publish.
  "distribution.publish":
    "publish workbooks to your package registries under your own publisher key (a script that arrived in a package cannot actually do this — Calcula refuses it — but it asked)",
  "distribution.subscribe":
    "pull further packages into this workbook and refresh them (a script that arrived in a package cannot actually do this — Calcula refuses it — but it asked)",
};

function capabilityPhrase(id: string): string {
  return CAPABILITY_PHRASE[id as CapabilityId] ?? id;
}

/**
 * How each publisher-trust state reads in the REVIEW step.
 *
 * A table with a row per `CalpTrustStatus`, typed so a new backend state fails
 * to type-check here rather than falling through to a friendlier neighbour's
 * label. (Wave I found both failure modes in the wild: an unknown status that
 * rendered as a green "verified" pill, and one that rendered as no badge at
 * all — which reads as "nothing to worry about".)
 *
 * `notPinned` is the normal answer here, and the copy has to carry the whole
 * point: the package is intact and signed, but *signed by whom* is a question
 * only the user can answer, and clicking Subscribe is the answer.
 */
const TRUST_REVIEW: Record<
  CalpTrustStatus,
  { label: string; blurb: string; color: string; box: React.CSSProperties }
> = {
  verified: {
    label: "trusted publisher",
    color: "#137333",
    box: { background: "#e8f5e9", border: "1px solid #b7dfbb" },
    blurb:
      "Signed by the same key you already trusted for this package. Nothing about the publisher's identity has changed.",
  },
  firstUse: {
    label: "trusted just now",
    color: "#a05a00",
    box: { background: "#fef7e0", border: "1px solid #f2dcae" },
    blurb: "This publisher key has just been recorded as trusted for this package name.",
  },
  firstUseKnownPublisher: {
    label: "trusted just now — publisher already known",
    color: "#a05a00",
    box: { background: "#fef7e0", border: "1px solid #f2dcae" },
    blurb:
      "This registry was not trusted for this package before, but the same publisher key is " +
      "already trusted for this package name from another registry — a move, a mirror, or the " +
      "same location spelled differently. It has now been recorded for this registry too.",
  },
  firstUseAcceptedNameConflict: {
    label: "trusted despite a name conflict",
    color: "#c5221f",
    box: { background: "#fdeceb", border: "1px solid #f3c4c2" },
    blurb:
      "Another registry already holds this package name under a DIFFERENT publisher key, and " +
      "you accepted that. Both are now trusted, each for its own registry.",
  },
  notPinned: {
    label: "not yet trusted on this computer",
    color: "#a05a00",
    box: { background: "#fef7e0", border: "1px solid #f2dcae" },
    blurb:
      "The package is intact and correctly signed, but nobody on this computer has agreed to " +
      "trust this publisher yet — reviewing a package deliberately does not do that. Anyone can " +
      "create a signing key, so check the key above against the one the publisher gave you. " +
      "Subscribing records it, and every later version of this package must be signed by the " +
      "same key or Calcula will refuse it.",
  },
  notPinnedNameConflict: {
    label: "NAME CONFLICT — a different publisher already owns this name here",
    color: "#c5221f",
    box: { background: "#fdeceb", border: "1px solid #f3c4c2" },
    blurb:
      "This package name is already trusted on this computer from a DIFFERENT registry, under a " +
      "DIFFERENT publisher key. The signature here is valid, but a valid signature only proves " +
      "the bytes were not altered — it does not say who signed them. Two registries claiming one " +
      "name is exactly what a package hijack looks like. Compare both registries and both keys " +
      "below; subscribing anyway needs a second, explicit confirmation.",
  },
};

const TRUST_REVIEW_FALLBACK = {
  label: "unrecognised trust state",
  color: "#c5221f",
  box: { background: "#fdeceb", border: "1px solid #f3c4c2" } as React.CSSProperties,
  blurb:
    "Calcula does not recognise the trust state reported for this package. Do not subscribe " +
    "until you know why.",
};

export function SubscribeDialog({ onClose }: DialogProps) {
  const win = useDialogWindow({ minWidth: 440, minHeight: 380 });

  const [registryPath, setRegistryPath] = useState("");
  const [packageName, setPackageName] = useState("");
  const [versionPin, setVersionPin] = useState("latest");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inspection, setInspection] = useState<PackageInspection | null>(null);

  // The packages found in the chosen registry (D6 — no more blind text entry).
  const [packages, setPackages] = useState<PackageInfo[] | null>(null);
  const [browsing, setBrowsing] = useState(false);

  // A pulled model source that saved sign-in could not connect — the
  // ConnectSourceDialog credentials window is open for it.
  const [pendingConn, setPendingConn] = useState<ConnectionInfo | null>(null);

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

  // List the packages in a registry so the user can pick one instead of
  // typing its name + version blind.
  const listPackagesAt = async (path: string) => {
    if (!path.trim()) {
      setError("Choose a registry folder first.");
      return;
    }
    setError(null);
    setStatus(null);
    setBrowsing(true);
    try {
      const found = await browseRegistry(path);
      setPackages(found);
      if (found.length === 0) setStatus("No packages found in this registry.");
    } catch (err: unknown) {
      setError(String(err));
    } finally {
      setBrowsing(false);
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
        // Discovery: immediately show what the chosen registry offers.
        await listPackagesAt(selected);
      }
    } catch {
      // user cancelled
    }
  };

  const handleListPackages = () => listPackagesAt(registryPath);

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

  // After a data source is live: refresh all pivots so the report shows data,
  // then close shortly so the user sees the result. Failures are surfaced —
  // "Refreshed N" must not paper over pivots whose query actually failed.
  const refreshPivotsAfterConnect = async (connName: string) => {
    setStatus("Refreshing pivot tables...");
    const allPivots = await pivot.getAll();
    let refreshed = 0;
    let firstError: string | null = null;
    for (const p of allPivots) {
      try {
        await pivot.refreshCache(p.id);
        refreshed++;
      } catch (err: unknown) {
        if (!firstError) firstError = String(err);
      }
    }
    window.dispatchEvent(new Event("pivot:refresh"));
    if (firstError) {
      setStatus(null);
      setError(
        `Connected to ${connName}, but ${allPivots.length - refreshed} of ` +
        `${allPivots.length} pivot table(s) failed to refresh: ${firstError}`
      );
      return;
    }
    setStatus(
      `Connected to ${connName} and refreshed ${refreshed} pivot table(s)`
    );
    setTimeout(() => onClose(), 1200);
  };

  // Explicit fields from the ConnectSourceDialog. Throws to keep that
  // window open with the error displayed inline.
  const handleCredentialsConnect = async (fields: ConnectSourceFields) => {
    if (!pendingConn) return;
    const server = fields.server || "localhost";
    const db = fields.database;
    if (!db) throw new Error("Enter the database name.");
    const user = fields.username || "postgres";
    await updateConnection({
      id: pendingConn.id,
      connectionString: `host=${server} dbname=${db} user=${user} password=${fields.password} sslmode=prefer`,
    });
    try {
      await connect(pendingConn.id, fields.remember);
    } catch (err) {
      // Don't leave a known-bad connection string behind — the next silent
      // attempt would reuse it and fail without ever asking again.
      await updateConnection({ id: pendingConn.id, connectionString: "" }).catch(() => {});
      throw err;
    }
    const connName = pendingConn.name;
    setPendingConn(null);
    try {
      await refreshPivotsAfterConnect(connName);
    } catch {
      // Refresh is best-effort; the connection itself succeeded.
      setStatus(`Connected to ${connName}`);
      setTimeout(() => onClose(), 1200);
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
        // Only set when the Review step SHOWED the cross-registry name conflict
        // and the user answered the second, differently-worded question. The
        // backend refuses a conflicting subscribe without it, so a UI that
        // forgets to ask cannot pin past a conflict.
        acceptNameConflict: inspection?.trustStatus === "notPinnedNameConflict",
      });

      // Notify the app that sheets have changed so UI refreshes
      emitAppEvent(AppEvents.SHEET_CHANGED, {});

      // Land the user on the report: activate the FIRST pulled sheet (pulled
      // sheets are appended at the end of the workbook).
      if (result.sheetsPulled > 0) {
        try {
          const sheetsResult = await getSheets();
          const firstPulled = sheetsResult.sheets.length - result.sheetsPulled;
          if (firstPulled >= 0 && firstPulled < sheetsResult.sheets.length) {
            await setActiveSheetApi(firstPulled);
            emitAppEvent(AppEvents.SHEET_CHANGED, {
              sheetIndex: firstPulled,
              sheetName: sheetsResult.sheets[firstPulled]?.name ?? "",
            });
          }
        } catch (err) {
          console.warn("[Subscribe] Could not activate pulled sheet:", err);
        }
      }

      // The pull may have materialized pane controls — tell the Controls pane
      // to reload (cross-extension window event; same name the shell fans the
      // paneControl mutation domain out as).
      window.dispatchEvent(new CustomEvent("controlspane:controls-refreshed"));

      // Announce the distribution lifecycle. This is what makes the
      // ScriptableObjects extension register the pulled scripts and run the
      // consent flow in this session (not only after save/reopen), reloads
      // chart libraries, and refreshes the Package Explorer. Fired even when the
      // package carried no scripts — sheets/objects changed either way — and
      // reachable by user scripts as a THINNED { packageName, version }.
      emitAppEvent(AppEvents.PACKAGE_UPDATED, {
        packageName: result.packageName,
        version: result.resolvedVersion,
        kind: "subscribe",
        sheetsPulled: result.sheetsPulled,
        scriptsPulled: result.scriptsPulled,
      } satisfies PackageUpdatedPayload);

      setStatus(
        `Pulled ${result.packageName} v${result.resolvedVersion}: ` +
        `${result.sheetsPulled} sheet(s)` +
        (result.scriptsPulled > 0
          ? `, ${result.scriptsPulled} script(s) (restricted, consent required)`
          : "")
      );

      // Bring the package's model source(s) live: silent saved-sign-in first
      // (Windows Credential Manager, keyed by server+database); only when
      // that fails ask for credentials in the ConnectSourceDialog window.
      try {
        const conns = await getConnections();
        const disconnected = conns.filter(c => !c.isConnected && c.server);
        if (disconnected.length > 0) {
          const conn = disconnected[0];
          try {
            setStatus("Connecting to data source...");
            await connect(conn.id);
            await refreshPivotsAfterConnect(conn.name);
          } catch {
            setStatus(
              `Pulled ${result.packageName} v${result.resolvedVersion}. ` +
              `The model source needs credentials to go live.`
            );
            setPendingConn(conn);
          }
        } else {
          // Nothing to connect — close after a brief moment.
          setTimeout(() => onClose(), 1200);
        }
      } catch (err2) {
        // Connection check itself failed — don't fail the pull
        console.warn("[Subscribe] Post-pull connect check failed:", err2);
        setTimeout(() => onClose(), 1200);
      }
    } catch (err: unknown) {
      setError(String(err));
      setStatus(null);
    }
  };

  const windowStyle: React.CSSProperties = {
    position: "fixed",
    left: "50%",
    top: "10%",
    transform: "translateX(-50%)",
    width: "460px",
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
  const closeButtonStyle: React.CSSProperties = {
    background: "transparent",
    border: "none",
    color: "var(--text-secondary)",
    cursor: "pointer",
    padding: "2px 8px",
    borderRadius: "4px",
    fontSize: "14px",
    lineHeight: 1,
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
    display: "flex", flexDirection: "column", gap: "4px", marginBottom: "8px",
  };
  const inputStyle: React.CSSProperties = {
    padding: "4px 6px",
    border: "1px solid var(--border-default)",
    borderRadius: "3px",
    fontSize: "13px",
    background: "var(--bg-surface)",
    color: "var(--text-primary)",
  };

  const messages = (
    <>
      {error && <div style={{ color: "var(--text-error, #d33)", marginBottom: "8px", fontSize: "12px" }}>{error}</div>}
      {status && <div style={{ color: "green", marginBottom: "8px", fontSize: "12px" }}>{status}</div>}
    </>
  );

  // Review step: show what the package contains before anything lands.
  const reviewBody = inspection && (
    <>
      {(() => {
        // WHO signed this, shown FIRST — before the contents.
        //
        // Reviewing a package is passive: the backend verifies the signature and
        // reports the trust state but never writes a TOFU pin, because merely
        // looking at a package is not a decision to trust its publisher. That
        // makes this panel the moment the identity has to be legible. A valid
        // signature only proves the bytes were not altered after signing —
        // anyone can generate a key and sign — so the reviewer needs the KEY,
        // not just a name, and needs to be told that Subscribe is what records
        // it as trusted.
        const t = TRUST_REVIEW[inspection.trustStatus] ?? TRUST_REVIEW_FALLBACK;
        return (
          <div style={{ ...t.box, fontSize: 12, marginBottom: 10, padding: "8px 10px", borderRadius: 4, lineHeight: 1.5 }}>
            <div>
              <strong>Publisher:</strong> {inspection.publisherName || "(unnamed)"}{" "}
              <span style={{ color: t.color, fontWeight: 600 }}>{t.label}</span>
            </div>
            {inspection.publisherKey && (
              <div style={{ fontFamily: "Consolas, monospace", fontSize: 10.5, wordBreak: "break-all", marginTop: 3 }}>
                {inspection.publisherKey}
              </div>
            )}
            <div style={{ marginTop: 4 }}>{t.blurb}</div>
            {(inspection.otherScopePins ?? []).length > 0 && (
              <div style={{ marginTop: 6 }}>
                <strong>Already trusted for this name:</strong>
                {(inspection.otherScopePins ?? []).map((p, i) => (
                  <div key={i} style={{ marginTop: 2 }}>
                    <span style={{ fontFamily: "Consolas, monospace", fontSize: 10.5 }}>
                      {p.scopeLabel}
                    </span>
                    {" — "}
                    {p.sameKey ? "same key" : "DIFFERENT key"}{" "}
                    <span style={{ fontFamily: "Consolas, monospace", fontSize: 10.5 }}>
                      {p.publisherKey.slice(0, 24)}…
                    </span>
                    {p.pinnedAt ? ` (trusted ${p.pinnedAt.slice(0, 10)})` : ""}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}
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
          backgroundColor: "#fff3cd", borderRadius: 4, color: "#664d03",
        }}>
          <strong>Scripts ({inspection.scripts.length})</strong> — executable code.
          Scripts arrive in restricted mode and ask for consent before running.
          {inspection.scripts.map((s, i) => (
            <div key={i} style={{ marginLeft: 8 }}>
              {s.name} ({s.objectType}){s.description ? ` — ${s.description}` : ""}
              {s.requestedCapabilities.length > 0 && (
                <div style={{ marginLeft: 8 }}>
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

      <div style={{ fontSize: "12px", marginBottom: "12px", color: "var(--text-secondary)" }}>
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

      {messages}
    </>
  );

  const formBody = (
    <>
      <div style={fieldStyle}>
        <label>Registry</label>
        {saved.length > 0 && (
          <select
            style={{ ...inputStyle, marginBottom: 4 }}
            value=""
            onChange={(e) => {
              if (e.target.value) {
                setRegistryPath(e.target.value);
                setPackages(null);
                // Discovery: picking a saved registry lists its packages too.
                void listPackagesAt(e.target.value);
              }
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
        <div style={{ marginBottom: 12, maxHeight: 168, overflowY: "auto", border: "1px solid var(--border-default)", borderRadius: 4 }}>
          {packages.map((pkg) => {
            const selected = packageName === pkg.name;
            return (
              <div
                key={pkg.name}
                onClick={() => { setPackageName(pkg.name); setVersionPin("latest"); }}
                style={{ padding: "6px 8px", borderBottom: "1px solid var(--border-default)", cursor: "pointer", background: selected ? "#eef5ff" : "transparent", color: selected ? "#1a1a1a" : "inherit" }}
              >
                <div style={{ fontWeight: 600, fontSize: 13 }}>{pkg.name}</div>
                <div style={{ fontSize: 11, color: selected ? "#555" : "var(--text-secondary)" }}>
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
        <span style={{ fontSize: "11px", color: "var(--text-secondary)" }}>
          Examples: =1.2.3, ^1.0, ~1.2, latest
        </span>
      </div>

      {messages}
    </>
  );

  return (
    <div ref={win.ref} style={{ ...windowStyle, ...win.style }}>
      <div style={headerStyle} onMouseDown={win.onHeaderMouseDown}>
        <span style={{ fontWeight: 600 }}>
          {inspection
            ? `Review: ${inspection.packageName} v${inspection.resolvedVersion}`
            : "Subscribe to Package"}
        </span>
        <button style={closeButtonStyle} onClick={onClose} aria-label="Close" title="Close">
          ✕
        </button>
      </div>

      <div style={bodyStyle}>
        {inspection ? reviewBody : formBody}
      </div>

      <div style={footerStyle}>
        {inspection ? (
          <>
            <button onClick={() => { setInspection(null); setStatus(null); setError(null); }}>
              Back
            </button>
            <button onClick={onClose}>Cancel</button>
            {/*
              A NAME CONFLICT gets a second, differently-worded question. The
              first question is "do you want this package"; this one is "do you
              accept that two registries claim this name under different keys".
              Same two-step shape as `acceptPublisherChange` on add-in installs —
              and the reason the Review step needs its own conflict status:
              Review must never say nothing and then have Subscribe fail.
            */}
            <button
              onClick={handlePull}
              style={{
                fontWeight: 600,
                ...(inspection.trustStatus === "notPinnedNameConflict"
                  ? { background: "#fdeceb", border: "1px solid #f3c4c2", color: "#c5221f" }
                  : {}),
              }}
              title={
                inspection.trustStatus === "notPinnedNameConflict"
                  ? "Another registry already holds this package name under a different " +
                    "publisher key. Subscribing records THIS key for THIS registry as well."
                  : undefined
              }
            >
              {inspection.trustStatus === "notPinnedNameConflict"
                ? "Trust this publisher anyway"
                : "Accept and Subscribe"}
            </button>
          </>
        ) : (
          <>
            <button onClick={onClose}>Cancel</button>
            <button
              title="Deep-inspect this package in the standalone Package Inspector window"
              disabled={!registryPath.trim() || !packageName.trim()}
              onClick={() =>
                void openPackageInspectorWindow({
                  registryPath: registryPath.trim(),
                  packageName: packageName.trim(),
                  versionPin: versionPin.trim() || "latest",
                })
              }
            >
              Open in Inspector
            </button>
            <button onClick={handleReview} style={{ fontWeight: 600 }}>Review Contents...</button>
          </>
        )}
      </div>

      {pendingConn && (
        <ConnectSourceDialog
          connectionName={pendingConn.name}
          server={pendingConn.server ?? ""}
          database={pendingConn.database ?? ""}
          onCancel={() => setPendingConn(null)}
          onConnect={handleCredentialsConnect}
        />
      )}

      {win.resizeHandles}
    </div>
  );
}
