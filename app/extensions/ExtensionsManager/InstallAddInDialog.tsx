//! FILENAME: app/extensions/ExtensionsManager/InstallAddInDialog.tsx
// PURPOSE: The install on-ramp for third-party add-ins — pick a folder, SEE who
//          signed it and what it will install, then decide.
// CONTEXT: Before this, installing an add-in meant hand-copying files into
//          %APPDATA% — which skips every trust decision and leaves the only
//          publisher pin happening silently inside the disk scan.
//
//          THE DISCLOSURE CONTRACT (this dialog is the consent surface, so its
//          text must match the real reach, exactly):
//            * Nothing in this dialog runs the add-in's code. Everything shown
//              is read out of the SIGNED sidecar manifest by Rust.
//            * The preview call copies nothing and pins nothing. Trust is
//              recorded only when the user presses Install.
//            * A first-contact publisher key is stated as a pin the user is
//              about to create, not as a fact about the world.
//            * A publisher CHANGE is a second, differently-worded question with
//              its own checkbox — never a silent update.
//            * "Signed" is only ever claimed when the signature also covers the
//              program file (codeHash). Otherwise the dialog says so.
//
//          The folder path reaches the backend from a native picker the USER
//          drove. No path string is ever synthesized by extension or script
//          code, and the backend only ever READS the source.

import React, { useCallback, useState } from "react";
import { open as openNativeDialog } from "@tauri-apps/plugin-dialog";
import { useDialogWindow } from "@api/dialogWindow";
import { CAPABILITY_ID_SET, describeCapability, showToast } from "@api";
import type { CapabilityId } from "@api";
import { installAddIn, previewAddIn, type InstallExtensionReport } from "./backendChannel";

/** Human labels for the sidecar's contribution keys. */
export const CONTRIBUTION_LABEL: Record<string, string> = {
  formulas: "Worksheet functions",
  commands: "Commands",
  menuItems: "Menu items",
  ribbonButtons: "Ribbon buttons",
  keybindings: "Keyboard shortcuts",
  cellStyles: "Cell styling",
  fileFormats: "File importers",
};

/**
 * The sentence that says what a contribution kind can REACH — naming the
 * surface is not the same as naming the reach, and two of these kinds hand the
 * add-in workbook data with no capability behind them.
 */
const CONTRIBUTION_REACH: Record<string, string> = {
  formulas:
    "Formulas in your sheets can call them, and the add-in's code runs against your data every time those cells recalculate.",
  cellStyles:
    "The add-in is shown the displayed value of every visible cell it styles. That needs the 'grid.read' permission, so an add-in without it is refused rather than shown blanks.",
  fileFormats:
    "The add-in is given the contents of files you choose to import (Calcula opens them; the add-in never picks a file).",
};

/**
 * How each trust status is presented, and whether it may be installed at all.
 *
 * Exported so it can be tested against the vocabulary Rust actually emits: a
 * status with no row here would render as an unlabelled box, which for a
 * security state is the worst possible failure — it would look benign.
 */
export const TRUST_PRESENTATION: Record<
  string,
  { title: string; tone: "good" | "info" | "warn" | "bad"; blurb: string; installable: boolean }
> = {
  verified: {
    title: "Signed by a publisher you already trust",
    tone: "good",
    blurb:
      "The signature matches the key you pinned for this add-in the first time you installed it.",
    installable: true,
  },
  firstUse: {
    title: "Signed — publisher seen for the first time",
    tone: "info",
    blurb:
      "The signature is valid, but Calcula has never seen this publisher. Installing pins this key: a future release signed by anyone else will be flagged.",
    installable: true,
  },
  unsigned: {
    title: "Not signed",
    tone: "warn",
    blurb:
      "Calcula cannot tell you who wrote this. Every capability it declares will be refused — including worksheet functions, and including being shown the contents of your cells, so its cell styling will not run either. Only what it adds to menus and the ribbon will work.",
    installable: true,
  },
  publisherChanged: {
    title: "Signed by a DIFFERENT publisher than before",
    tone: "bad",
    blurb:
      "The signing key changed since you first trusted this add-in. That is either a new release key from the same author, or someone else publishing under their name.",
    installable: true,
  },
  invalid: {
    title: "Broken signature — refusing to install",
    tone: "bad",
    blurb:
      "The files do not match the key they claim to be signed by. Either they were modified after signing, or they were never signed by that key.",
    installable: false,
  },
  codeUnverified: {
    title: "The signature does not cover the program file — refusing to install",
    tone: "bad",
    blurb:
      "The description is signed, but it makes no claim about the code, so Calcula cannot tell you whether this is the program the publisher signed. Ask the author to re-sign it with calcula-sign, which records the program file's fingerprint before signing.",
    installable: false,
  },
  // SCAN-ONLY: the preview never reports this (an installer preview of first
  // contact is `firstUse` — a promise the installer can keep because a human is
  // answering). It has a row here because this map is the app's single
  // vocabulary for trust states, and a state with no row renders as an
  // unlabelled box — which for a security badge reads as benign.
  notInstalled: {
    title: "Present on this computer, but never installed through Calcula",
    tone: "warn",
    blurb:
      "The signature is valid and it covers the program file, but nobody here has ever agreed to trust this publisher: the files were placed in the extensions folder rather than installed. Calcula refuses every capability it declares — including worksheet functions — until you install it from this dialog, which is the only thing that records your trust in the key.",
    installable: false,
  },
  trustUnavailable: {
    title: "Cannot check the publisher — refusing to install",
    tone: "bad",
    blurb:
      "The signature is valid, but Calcula could not read its own record of which publisher signed this add-in before, so it cannot tell you whether the publisher changed. That record is at %LOCALAPPDATA%\\Calcula; installing resumes once it can be read.",
    installable: false,
  },
};

const TONE_COLORS: Record<string, { bg: string; fg: string; border: string }> = {
  good: { bg: "#e6f4ea", fg: "#137333", border: "#a8d5b5" },
  info: { bg: "#e8f0fe", fg: "#1967d2", border: "#a9c4f5" },
  warn: { bg: "#fef7e0", fg: "#a05a00", border: "#e8cf94" },
  bad: { bg: "#fce8e6", fg: "#a50e0a", border: "#eeb0ac" },
};

function shortKey(key: string): string {
  if (!key) return "(none)";
  return `${key.slice(0, 16)}…${key.slice(-8)}`;
}

export interface InstallAddInDialogProps {
  onClose: () => void;
  /** Called after a successful install so the panel can show the reload hint. */
  onInstalled: (report: InstallExtensionReport) => void;
}

export function InstallAddInDialog({
  onClose,
  onInstalled,
}: InstallAddInDialogProps): React.ReactElement {
  const win = useDialogWindow({ minWidth: 460, minHeight: 400 });

  const [sourcePath, setSourcePath] = useState<string>("");
  const [report, setReport] = useState<InstallExtensionReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [acceptChange, setAcceptChange] = useState(false);
  const [done, setDone] = useState<InstallExtensionReport | null>(null);

  const choose = useCallback(async () => {
    setError(null);
    let picked: string | string[] | null = null;
    try {
      // USER-DRIVEN PICKER. The human chooses the folder; the host does the I/O.
      picked = await openNativeDialog({
        title: "Choose the add-in folder",
        directory: true,
        multiple: false,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    if (typeof picked !== "string") return;

    setSourcePath(picked);
    setReport(null);
    setDone(null);
    setAcceptChange(false);
    setBusy(true);
    try {
      setReport(await previewAddIn(picked));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const install = useCallback(async () => {
    if (!report || !sourcePath) return;
    setBusy(true);
    setError(null);
    try {
      const result = await installAddIn(sourcePath, acceptChange);
      setDone(result);
      setReport(result);
      onInstalled(result);
      showToast(
        `Installed "${result.name}" v${result.version}. Reload Calcula to load it.`,
        { variant: "success" },
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [report, sourcePath, acceptChange, onInstalled]);

  const trust = report ? TRUST_PRESENTATION[report.trustStatus] : undefined;
  const tone = TONE_COLORS[trust?.tone ?? "info"];
  const needsChangeAck = report?.trustStatus === "publisherChanged";
  const canInstall =
    !!report &&
    !done &&
    !busy &&
    report.workerSupport &&
    (trust?.installable ?? false) &&
    (!needsChangeAck || acceptChange);

  return (
    <div ref={win.ref} style={{ ...styles.window, ...win.style }}>
      <div style={styles.header} onMouseDown={win.onHeaderMouseDown}>
        <span style={{ fontWeight: 600 }}>Install add-in</span>
        <button type="button" style={styles.close} onClick={onClose} aria-label="Close" title="Close">
          ✕
        </button>
      </div>

      <div style={styles.body}>
        <p style={styles.intro}>
          Choose the folder containing the add-in&apos;s bundle and its
          <code style={styles.code}>.manifest.json</code>. Calcula reads the manifest
          <strong> without running any of the add-in&apos;s code</strong> and shows you what it
          would install.
        </p>

        <div style={styles.pickRow}>
          <button type="button" style={styles.primaryButton} onClick={choose} disabled={busy}>
            Choose folder…
          </button>
          <span style={styles.pathText} title={sourcePath}>
            {sourcePath || "No folder chosen"}
          </span>
        </div>

        {error && <div style={styles.error}>{error}</div>}

        {report && (
          <>
            <div style={styles.identity}>
              <div style={styles.identityName}>
                {report.name} <span style={styles.identityVersion}>v{report.version}</span>
              </div>
              <div style={styles.identityId}>{report.id}</div>
            </div>

            {trust && (
              <div
                style={{
                  ...styles.trustBox,
                  background: tone.bg,
                  color: tone.fg,
                  borderColor: tone.border,
                }}
              >
                <div style={styles.trustTitle}>{trust.title}</div>
                <div>{trust.blurb}</div>
                {report.publisherKey && (
                  <div style={styles.keyLine}>
                    Publisher key: <code style={styles.code}>{shortKey(report.publisherKey)}</code>
                  </div>
                )}
                {report.trustStatus === "publisherChanged" && (
                  <div style={styles.keyLine}>
                    Previously trusted:{" "}
                    <code style={styles.code}>{shortKey(report.pinnedPublisherKey)}</code>
                  </div>
                )}
                {report.trustStatus !== "unsigned" && (
                  <div style={styles.keyLine}>
                    {report.codeCoveredBySignature
                      ? "The signature covers the program file as well as the description."
                      : "The signature does NOT cover the program file — it authenticates only the description."}
                  </div>
                )}
              </div>
            )}

            <Section title="Capabilities it asks for">
              {report.declaredCapabilities.length === 0 ? (
                <div style={styles.muted}>
                  None. It cannot reach the network, storage, BI data or your attention.
                </div>
              ) : (
                <>
                  <ul style={styles.list}>
                    {report.declaredCapabilities.map((c) => {
                      const known = CAPABILITY_ID_SET.has(c as CapabilityId);
                      return (
                        <li key={c} style={styles.listItem}>
                          <code style={styles.code}>{c}</code>
                          {known ? (
                            <span style={styles.capDesc}>
                              {" "}
                              — {describeCapability(c as CapabilityId)}
                            </span>
                          ) : (
                            <span style={styles.capDesc}> — not a capability Calcula knows; ignored.</span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  {/* "Each one is still asked for separately the first time it
                      is actually used" was false for two of them. The JIT
                      prompt (maybeRequestCapabilityGrant in
                      scriptHost/extensionWorkerHost.ts) only fires on `cap.*`
                      broker calls; `grid.read` and `formula.udf` are granted by
                      recordCapabilityGrant at registration, with no prompt,
                      because they are consumed by contributions the host calls
                      INTO the add-in rather than calls the add-in makes out.
                      Install IS the consent for those two, so this screen has
                      to say so — it is the last screen before it happens. */}
                  <div style={report.capabilitiesHonored ? styles.muted : styles.deniedNote}>
                    {report.capabilitiesHonored ? (
                      <>
                        Network, storage, BI and dialog access are asked for separately the first
                        time they are actually used. Being shown your cells (
                        <code style={styles.code}>grid.read</code>) and running as a worksheet
                        function (<code style={styles.code}>formula.udf</code>) are granted by
                        installing — they take effect as soon as the add-in loads, with no further
                        prompt.
                      </>
                    ) : (
                      "All of these will be REFUSED, because the manifest declaring them is not trustworthy. Worksheet functions need one of them, so they will not appear."
                    )}
                  </div>
                </>
              )}
            </Section>

            <Section title="What it will add to Calcula">
              {report.contributions.length === 0 ? (
                <div style={styles.muted}>
                  Nothing in your menus, ribbon, shortcuts or formulas.
                </div>
              ) : (
                <ul style={styles.list}>
                  {report.contributions.map((c) => (
                    <li key={c.kind} style={styles.listItem}>
                      <span style={styles.contribKind}>
                        {CONTRIBUTION_LABEL[c.kind] ?? c.kind}:
                      </span>{" "}
                      {c.ids.join(", ")}
                      {CONTRIBUTION_REACH[c.kind] && (
                        <div style={styles.reach}>{CONTRIBUTION_REACH[c.kind]}</div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title="Files that will be installed">
              <ul style={styles.list}>
                {report.files.map((f) => (
                  <li key={f} style={styles.listItem}>
                    <code style={styles.code}>{f}</code>
                  </li>
                ))}
              </ul>
            </Section>

            {report.warnings.map((w) => (
              <div key={w} style={styles.warning}>
                {w}
              </div>
            ))}

            {needsChangeAck && !done && (
              <label style={styles.ackRow}>
                <input
                  type="checkbox"
                  checked={acceptChange}
                  onChange={(e) => setAcceptChange(e.target.checked)}
                />
                <span>
                  I expected this add-in to be signed by a new key, and I want Calcula to trust{" "}
                  <code style={styles.code}>{shortKey(report.publisherKey)}</code> for{" "}
                  <code style={styles.code}>{report.id}</code> from now on.
                </span>
              </label>
            )}

            {done && (
              <div style={styles.successBox}>
                Installed. {done.pinned ? "This publisher key is now trusted for this add-in. " : ""}
                It loads the next time Calcula starts — and will ask for your permission to run
                before any of its code executes.
              </div>
            )}
          </>
        )}
      </div>

      <div style={styles.footer}>
        <span style={styles.footerNote}>
          Installing copies files. It does not run the add-in: it still asks before its first run.
        </span>
        <button type="button" style={styles.secondaryButton} onClick={onClose}>
          {done ? "Close" : "Cancel"}
        </button>
        {!done && (
          <button
            type="button"
            style={{ ...styles.primaryButton, ...(canInstall ? {} : styles.disabledButton) }}
            onClick={install}
            disabled={!canInstall}
          >
            {busy ? "Working…" : "Install"}
          </button>
        )}
      </div>

      {win.resizeHandles}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div style={styles.section}>
      <div style={styles.sectionTitle}>{title}</div>
      {children}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  window: {
    position: "fixed",
    left: "50%",
    top: "8%",
    transform: "translateX(-50%)",
    width: "540px",
    maxHeight: "84vh",
    zIndex: 1050,
    display: "flex",
    flexDirection: "column",
    background: "var(--panel-bg, #fff)",
    color: "var(--text-primary, #202124)",
    border: "1px solid var(--border-default, #d0d0d0)",
    borderRadius: 8,
    boxShadow: "0 12px 40px rgba(0,0,0,0.35)",
    fontFamily: '"Segoe UI", system-ui, sans-serif',
    fontSize: 13,
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "10px 14px",
    borderBottom: "1px solid var(--border-default, #e0e0e0)",
    cursor: "move",
    flexShrink: 0,
  },
  close: {
    background: "transparent",
    border: "none",
    cursor: "pointer",
    fontSize: 14,
    color: "inherit",
    lineHeight: 1,
  },
  body: {
    padding: "12px 14px",
    overflowY: "auto",
    flex: 1,
  },
  intro: {
    margin: "0 0 10px 0",
    lineHeight: 1.5,
    color: "var(--text-secondary, #5f6368)",
  },
  pickRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginBottom: 10,
  },
  pathText: {
    fontSize: 11,
    color: "var(--text-secondary, #5f6368)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    flex: 1,
    direction: "rtl",
    textAlign: "left",
  },
  identity: {
    marginBottom: 8,
  },
  identityName: {
    fontSize: 15,
    fontWeight: 600,
  },
  identityVersion: {
    fontSize: 12,
    fontWeight: 400,
    color: "var(--text-secondary, #5f6368)",
  },
  identityId: {
    fontSize: 11,
    color: "var(--text-secondary, #9aa0a6)",
    fontFamily: "monospace",
  },
  trustBox: {
    border: "1px solid",
    borderRadius: 6,
    padding: "8px 10px",
    marginBottom: 10,
    lineHeight: 1.45,
  },
  trustTitle: {
    fontWeight: 600,
    marginBottom: 3,
  },
  keyLine: {
    marginTop: 4,
    fontSize: 11.5,
  },
  section: {
    marginTop: 10,
    paddingTop: 8,
    borderTop: "1px dashed var(--border-default, #eaeaea)",
  },
  sectionTitle: {
    fontWeight: 600,
    marginBottom: 4,
  },
  list: {
    margin: 0,
    paddingLeft: 18,
  },
  listItem: {
    marginBottom: 3,
    lineHeight: 1.45,
  },
  contribKind: {
    fontWeight: 500,
  },
  reach: {
    fontSize: 11.5,
    color: "var(--text-secondary, #5f6368)",
    marginTop: 1,
  },
  capDesc: {
    color: "var(--text-secondary, #5f6368)",
  },
  muted: {
    color: "var(--text-secondary, #5f6368)",
    fontSize: 12,
    marginTop: 4,
  },
  deniedNote: {
    color: "#a05a00",
    fontSize: 12,
    marginTop: 4,
    fontWeight: 500,
  },
  code: {
    fontFamily: "monospace",
    fontSize: 11.5,
    background: "rgba(128,128,128,0.12)",
    padding: "0 3px",
    borderRadius: 3,
  },
  warning: {
    marginTop: 8,
    padding: "6px 9px",
    background: "#fef7e0",
    color: "#a05a00",
    border: "1px solid #e8cf94",
    borderRadius: 5,
    lineHeight: 1.45,
  },
  error: {
    marginTop: 8,
    padding: "6px 9px",
    background: "#fce8e6",
    color: "#a50e0a",
    border: "1px solid #eeb0ac",
    borderRadius: 5,
    lineHeight: 1.45,
  },
  successBox: {
    marginTop: 10,
    padding: "6px 9px",
    background: "#e6f4ea",
    color: "#137333",
    border: "1px solid #a8d5b5",
    borderRadius: 5,
    lineHeight: 1.45,
  },
  ackRow: {
    display: "flex",
    gap: 8,
    alignItems: "flex-start",
    marginTop: 10,
    padding: "6px 9px",
    background: "rgba(128,128,128,0.08)",
    borderRadius: 5,
    lineHeight: 1.45,
    cursor: "pointer",
  },
  footer: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "10px 14px",
    borderTop: "1px solid var(--border-default, #e0e0e0)",
    flexShrink: 0,
  },
  footerNote: {
    flex: 1,
    fontSize: 11,
    color: "var(--text-secondary, #9aa0a6)",
    lineHeight: 1.35,
  },
  primaryButton: {
    fontSize: 12,
    padding: "5px 14px",
    borderRadius: 4,
    border: "1px solid transparent",
    background: "#1967d2",
    color: "#fff",
    cursor: "pointer",
  },
  secondaryButton: {
    fontSize: 12,
    padding: "5px 14px",
    borderRadius: 4,
    border: "1px solid var(--border-default, #d0d0d0)",
    background: "var(--panel-bg, #fff)",
    color: "var(--text-primary, #5f6368)",
    cursor: "pointer",
  },
  disabledButton: {
    opacity: 0.5,
    cursor: "not-allowed",
  },
};
