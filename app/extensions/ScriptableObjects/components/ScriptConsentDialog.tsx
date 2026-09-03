//! FILENAME: app/extensions/ScriptableObjects/components/ScriptConsentDialog.tsx
// PURPOSE: Security consent prompt for distributed object scripts.
// CONTEXT: When a workbook contains scripts from a .calp package, the user
//          is asked to review and approve them before they can run.

import React, { useState, useCallback, useEffect, useMemo } from "react";
import { emitAppEvent } from "@api/events";
import { requireScriptEditorProvider } from "@api/scriptEditorService";
import type { CapabilityId } from "@api";
import { lineDiff, changedLineCount, type DiffRowType } from "../lib/lineDiff";

/** One entry in the consent prompt's requested-capabilities list. */
interface RequestedCapability {
  capability: CapabilityId;
  description: string;
  origins: string[];
}

/** A script whose source changed since the last consent (T3 re-consent diff). */
interface ChangedScriptData {
  id: string;
  name: string;
  oldSource: string;
  newSource: string;
}

const diffRowBg: Record<DiffRowType, string> = {
  same: "transparent",
  add: "#e6ffed",
  del: "#ffeef0",
};

/** Collapsible old->new line diff for one changed script. */
function ScriptChangeDiff({ name, oldSource, newSource }: ChangedScriptData): React.ReactElement {
  const [open, setOpen] = useState(false);
  const rows = useMemo(() => lineDiff(oldSource, newSource), [oldSource, newSource]);
  const changed = changedLineCount(rows);
  return (
    <div style={{ marginBottom: 6, border: "1px solid #f0c36d", borderRadius: 4 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          width: "100%",
          textAlign: "left",
          background: "#fffdf5",
          border: "none",
          padding: "4px 6px",
          cursor: "pointer",
          fontSize: 11,
          fontWeight: 600,
          color: "#7a4a00",
        }}
      >
        {open ? "[hide]" : "[show]"} {name} &mdash; {changed} line{changed === 1 ? "" : "s"} changed
      </button>
      {open && (
        <pre
          style={{
            margin: 0,
            maxHeight: 200,
            overflow: "auto",
            fontFamily: "Consolas, monospace",
            fontSize: 10.5,
            lineHeight: 1.4,
            background: "#fff",
          }}
        >
          {rows.map((r, i) => (
            <div key={i} style={{ background: diffRowBg[r.type], padding: "0 4px", whiteSpace: "pre" }}>
              <span style={{ opacity: 0.5, userSelect: "none" }}>
                {r.type === "add" ? "+" : r.type === "del" ? "-" : " "}
              </span>{" "}
              {r.text || " "}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}

// ============================================================================
// Styles
// ============================================================================

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: "rgba(0,0,0,0.4)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 20000,
  fontFamily: "'Segoe UI', Tahoma, sans-serif",
};

const dialogStyle: React.CSSProperties = {
  backgroundColor: "#FFF",
  borderRadius: 8,
  boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
  width: 460,
  maxHeight: "80vh",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const headerStyle: React.CSSProperties = {
  padding: "16px 20px",
  borderBottom: "1px solid #E0E0E0",
  display: "flex",
  alignItems: "center",
  gap: 10,
};

const shieldIcon: React.CSSProperties = {
  width: 24,
  height: 24,
  borderRadius: 12,
  backgroundColor: "#FFF4CE",
  color: "#8A6914",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 14,
  fontWeight: 700,
  flexShrink: 0,
};

const bodyStyle: React.CSSProperties = {
  padding: "16px 20px",
  fontSize: 12,
  lineHeight: "1.6",
  color: "#333",
  overflowY: "auto",
  flex: 1,
};

const scriptListStyle: React.CSSProperties = {
  margin: "10px 0",
  padding: "8px 12px",
  backgroundColor: "#F8F8F8",
  borderRadius: 4,
  border: "1px solid #E8E8E8",
};

const scriptItemStyle: React.CSSProperties = {
  padding: "3px 0",
  fontSize: 11,
  color: "#555",
  fontFamily: "'Cascadia Code', Consolas, monospace",
};

/** The "what can start a macro" list. Plain bullets — this is prose, not data. */
const triggerListStyle: React.CSSProperties = {
  margin: "6px 0 10px",
  paddingLeft: 18,
};

const capListStyle: React.CSSProperties = {
  margin: "10px 0",
  padding: "4px 0",
  listStyle: "none",
};

const capItemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  padding: "6px 0",
  borderTop: "1px solid #F0F0F0",
};

const capIconStyle: React.CSSProperties = {
  width: 18,
  height: 18,
  borderRadius: 4,
  backgroundColor: "#FDECEA",
  color: "#C0392B",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 12,
  fontWeight: 700,
  flexShrink: 0,
  marginTop: 1,
};

const capOriginStyle: React.CSSProperties = {
  display: "block",
  marginTop: 2,
  fontSize: 11,
  color: "#666",
  fontFamily: "'Cascadia Code', Consolas, monospace",
  wordBreak: "break-all",
};

/** Per-capability glyph (ASCII) for the requested-capabilities list. */
const CAP_ICON: Record<CapabilityId, string> = {
  "net.fetch": "@",
  "bi.query": "?",
  "bi.sql": "DB",
  storage: "#",
  "ui.html": "<>",
  "formula.udf": "fx",
  "bi.model": "M",
  "bi.connector": "->M",
  "ui.dialog": "[?]",
  "distribution.writeback": "->P",
  schedule: "->S",
  "file.picker": "[/]",
  "ui.shortcut": "[^+]",
  "grid.read": "[#]",
  "distribution.publish": "P->",
  "distribution.subscribe": "<-P",
};

const footerStyle: React.CSSProperties = {
  padding: "12px 20px",
  borderTop: "1px solid #E0E0E0",
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
};

const btnStyle: React.CSSProperties = {
  padding: "6px 16px",
  fontSize: 12,
  border: "1px solid #CCC",
  borderRadius: 4,
  backgroundColor: "#FFF",
  cursor: "pointer",
};

const btnPrimaryStyle: React.CSSProperties = {
  ...btnStyle,
  backgroundColor: "#0078D4",
  color: "#FFF",
  borderColor: "#0078D4",
};

const btnDangerStyle: React.CSSProperties = {
  ...btnStyle,
  color: "#D13438",
  borderColor: "#D13438",
};

// ============================================================================
// Component
// ============================================================================

import type { DialogProps } from "@api/uiTypes";

export default function ScriptConsentDialog({
  onClose,
  data,
}: DialogProps): React.ReactElement {
  const packageName = (data?.packageName as string) ?? "Unknown";
  // THE IDENTITY OF THIS SCREEN, echoed back with Allow. The grant handler
  // records the artifact set THIS prompt enumerated and refuses a grant whose
  // prompt is no longer standing — so a workbook that changed while the user was
  // reading (a Distribution ▸ Update, a gateway pull) re-asks instead of
  // recording an approval for code that was never displayed.
  const promptId = data?.promptId as string | undefined;
  const scriptCount = (data?.scriptCount as number) ?? 0;
  const scriptNames = (data?.scriptNames as string[]) ?? [];
  const scriptIds = (data?.scriptIds as string[]) ?? [];
  // The application's MACROS (module scripts). Allowing writes them into the
  // same consent record as the object scripts — the record the Rust module gate
  // reads before it will run one — so this prompt names them. Anything the
  // grant covers has to be on the screen that produces the grant.
  const moduleScriptNames = (data?.moduleScriptNames as string[]) ?? [];
  // The macro IDS, so Inspect has something to open when the application shipped
  // no object scripts at all. An application MAY ship only macros
  // (`core/calp/src/pull.rs` materializes modules independently of object
  // scripts), and this is the screen that approves them.
  const moduleScriptIds = (data?.moduleScriptIds as string[]) ?? [];
  // Macros this grant CANNOT cover: their id is already claimed by one of the
  // application's object scripts, and one consent record is a flat id-keyed
  // list. Allow will not approve them and Rust will keep refusing them at Run,
  // so the screen names them. While this was silent, the freshness check still
  // demanded their hash — the record could never satisfy it, the application
  // re-prompted on every open, and pressing Allow could not end the loop.
  const unapprovableMacroNames = (data?.unapprovableMacroNames as string[]) ?? [];
  const requestedCapabilities =
    (data?.requestedCapabilities as RequestedCapability[]) ?? [];
  const changedScripts = (data?.changedScripts as ChangedScriptData[]) ?? [];
  const [inspecting, setInspecting] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);

  // The dialog instance is reused when the consent queue advances to the
  // next package — reset per-package UI state.
  useEffect(() => {
    setInspecting(false);
    setInspectError(null);
  }, [packageName]);

  const handleAllow = useCallback(() => {
    emitAppEvent("scriptable-objects:consent-granted", { packageName, promptId });
    onClose();
  }, [packageName, promptId, onClose]);

  const handleBlock = useCallback(() => {
    emitAppEvent("scriptable-objects:consent-denied", { packageName });
    onClose();
  }, [packageName, onClose]);

  // What Inspect can actually open. An object script goes through the ordinary
  // EDIT_SCRIPT route (targeting by scriptId opens the existing script — never
  // scaffolds); with no object scripts it opens the first MACRO through the
  // `@api/scriptEditorService` seam, which is the only route to a module script's
  // source. With neither there is nothing to show, and the button is not
  // rendered at all rather than left inert.
  const canInspect = scriptIds.length > 0 || moduleScriptIds.length > 0;

  const handleInspect = useCallback(() => {
    setInspectError(null);
    if (scriptIds.length > 0) {
      emitAppEvent("scriptable-objects:edit-script", { scriptId: scriptIds[0] });
      setInspecting(true);
      return;
    }
    if (moduleScriptIds.length === 0) return;
    setInspecting(true);
    // The seam THROWS when the editor cannot be reached (and rejects for a macro
    // that is gone). Surface it on the prompt: a consent screen that promises
    // "you can inspect the source" must not swallow the failure to do so.
    void (async () => {
      try {
        await requireScriptEditorProvider().openMacroInEditor(moduleScriptIds[0]);
      } catch (e) {
        setInspecting(false);
        setInspectError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [scriptIds, moduleScriptIds]);

  return (
    <div style={overlayStyle} onClick={handleBlock}>
      <div style={dialogStyle} onClick={(e) => e.stopPropagation()}>
        <div style={headerStyle}>
          <div style={shieldIcon}>!</div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#333" }}>
              Script Security
            </div>
            <div style={{ fontSize: 11, color: "#666" }}>
              This workbook contains scripts from an external package
            </div>
          </div>
        </div>

        <div style={bodyStyle}>
          {/* An application may ship object scripts, macros, or ONLY macros —
              the pull materializes the two independently. Each list is rendered
              only when it has entries, so a macro-only application is not
              introduced as including "0 object scripts". */}
          {scriptCount > 0 && (
            <>
              <p>
                The package <strong>"{packageName}"</strong> includes {scriptCount} object
                script{scriptCount !== 1 ? "s" : ""} that can run code in your workbook:
              </p>

              <div style={scriptListStyle}>
                {scriptNames.map((name, i) => (
                  <div key={i} style={scriptItemStyle}>{name}</div>
                ))}
              </div>
            </>
          )}

          {moduleScriptNames.length > 0 && (
            <>
              <p>
                {scriptCount > 0 ? (
                  <>It also includes </>
                ) : (
                  <>The package <strong>"{packageName}"</strong> includes </>
                )}
                {moduleScriptNames.length} macro
                {moduleScriptNames.length !== 1 ? "s" : ""} (module scripts).
                Nothing puts a macro on a timer and nothing starts one when you
                open this workbook &mdash; but allowing arms every way one can be
                started here:
              </p>
              {/* CONSENT TEXT &mdash; VERIFIED AGAINST THE RUN PATHS, NOT WRITTEN
                  FROM MEMORY. This used to read "Nothing runs them on its own —
                  you run them yourself, from the macro library". The macro
                  library stopped being the only surface the moment macros were
                  folded into this one grant, and the surface that was missing
                  belongs to the PUBLISHER: a `calcula.button` cell carries
                  `action: { kind: "script", scriptId }` in its cell-type params,
                  those params publish as a `cellType` custom object and are
                  materialized on pull byte-for-byte with no sanitizing
                  (collect_cell_type_custom_objects / materialize_saved_cell_types,
                  app/src-tauri/src/calp_commands.rs), and one click resolves the
                  module by id and hands its stored source verbatim to run_script
                  (extensions/CellTypes/types/button.ts -> planStoredModuleRun,
                  extensions/_shared/lib/buttonScriptRun.ts). So a .calp ships the
                  button AND the macro, and this grant is what arms it.

                  The bullets are deliberately generous about "a button": an
                  on-grid button CONTROL does arrive disarmed (a pull strips
                  onSelect and macroRef — EXECUTABLE_CONTROL_PROPERTIES,
                  app/src-tauri/src/controls.rs), but a consent screen is the wrong
                  place to teach the cell/control distinction, and the safe error
                  is to warn about a click that cannot happen rather than to miss
                  one that can.

                  The two negatives are load-bearing and both hold: cap.schedule*
                  runs one of the SCRIPT'S OWN methods, never a stored macro
                  (allowlist.ts), and no path mounts or runs a module script at
                  open — only object scripts mount, and api.runMacro is
                  unlocked-tier, which a distributed script can never reach
                  (accessLevelForOrigin, scriptOrigin.ts). Pinned by
                  macroConsentTriggerHonesty.test.ts. */}
              <ul style={triggerListStyle}>
                <li>
                  Developer &#9656; Macros, where you pick one and press Run.
                </li>
                <li>
                  A button the publisher put on a sheet &mdash; a button's action
                  travels inside the application, so one click runs the macro it
                  names.
                </li>
                <li>
                  Anything of your own you point at one later: a button, a view
                  bookmark, the command line, or one of your own scripts.
                </li>
              </ul>
              <p>
                They will not run at all until this application&apos;s code is
                approved, and allowing approves them:
              </p>
              <div style={scriptListStyle}>
                {moduleScriptNames.map((name, i) => (
                  <div key={i} style={scriptItemStyle}>{name}</div>
                ))}
              </div>
            </>
          )}

          {unapprovableMacroNames.length > 0 && (
            <>
              {/* A prompt that Allow cannot satisfy must SAY so. This
                  application ships a macro whose id is already used by one of
                  its object scripts; one consent record is a flat list keyed by
                  id, so the record cannot hold both and the object script keeps
                  the id. Allowing therefore leaves these refused — and while
                  that was unsaid, the freshness check still required their hash,
                  so the application asked again on every single open and no
                  amount of pressing Allow could stop it. */}
              <p style={{ color: "#9a5b00", fontWeight: 600, margin: "8px 0 4px" }}>
                {unapprovableMacroNames.length} macro
                {unapprovableMacroNames.length !== 1 ? "s" : ""} in this
                application cannot be approved and will not run. Each one uses
                the same internal id as one of the application&apos;s object
                scripts, and an approval records one artifact per id &mdash; so
                allowing does not cover {unapprovableMacroNames.length !== 1 ? "them" : "it"}.
                Ask the publisher to give {unapprovableMacroNames.length !== 1 ? "them" : "it"} {" "}
                {unapprovableMacroNames.length !== 1 ? "distinct ids" : "a distinct id"}.
              </p>
              <div style={scriptListStyle}>
                {unapprovableMacroNames.map((name, i) => (
                  <div key={i} style={scriptItemStyle}>{name}</div>
                ))}
              </div>
            </>
          )}

          {changedScripts.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <p style={{ color: "#9a5b00", fontWeight: 600, margin: "0 0 4px" }}>
                {changedScripts.length} script{changedScripts.length === 1 ? "" : "s"} changed
                since you last approved this package &mdash; review what changed before allowing:
              </p>
              {changedScripts.map((cs) => (
                <ScriptChangeDiff key={cs.id} {...cs} />
              ))}
            </div>
          )}

          {requestedCapabilities.length > 0 && (
            <>
              <p>
                Allowing grants these scripts the following capabilities:
              </p>
              <ul style={capListStyle}>
                {requestedCapabilities.map((cap) => (
                  <li key={cap.capability} style={capItemStyle}>
                    <span style={capIconStyle} aria-hidden="true">
                      {CAP_ICON[cap.capability] ?? "*"}
                    </span>
                    <span>
                      {cap.description}
                      {cap.origins.map((origin) => (
                        <code key={origin} style={capOriginStyle}>{origin}</code>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {/* THE REACH PARAGRAPH IS A FUNCTION OF WHAT THIS GRANT COVERS.
              Both sentences below describe the OBJECT-SCRIPT realm — the
              worker realm, clamped by the host to the sheet currently shown —
              so neither may be rendered on a prompt that has no object scripts
              in it. A macro-only application used to end with the
              restricted-mode sentence anyway: the last screen before a
              stranger's code runs described the containment of a surface that
              application does not use, and understated the one it does. The
              macro paragraph below states the macro surface's own reach, and it
              is pinned against core/script-engine/src/manifest.rs. */}
          {scriptCount > 0 &&
            (requestedCapabilities.length > 0 ? (
              /* CONSENT TEXT — held to the same bar as the capability itself.
                 "Scripts can only reach the objects they're attached to" was
                 false: the whole `sheet.*` family in scriptHost/allowlist.ts is
                 `tier: "restricted"`, so cell reads and writes need no
                 capability at all. What a capability gates is reach BEYOND the
                 workbook. Say that, and say the grid access plainly, rather
                 than implying an isolation the sandbox does not provide.
                 Mirrors CapabilityRequestDialog.tsx, which records the same
                 correction. */
              <p style={{ fontSize: 11, color: "#888" }}>
                Anything not listed stays blocked. Even with nothing listed,
                these scripts can read and write the cells of the sheet
                currently shown — that is what an object script is for — but
                they reach nothing outside this workbook: no network, no files,
                no BI data.
              </p>
            ) : (
              /* "cannot read or write arbitrary cells" was simply not true:
                 sheet.getCellValue / sheet.setCellValue and the rest of the
                 sheet.* family are restricted-tier rows in
                 scriptHost/allowlist.ts, granted to every mounted object
                 script with no capability involved. Restricted mode limits
                 which SHEET — the host clamps to the sheet currently shown —
                 and it blocks everything outside the workbook. It does not
                 keep a script out of your cells. Wording matches the allowlist
                 rows' own `desc` on purpose. */
              <p>
                Object scripts run in <strong>restricted mode</strong> — they
                can read and write the cells of the sheet currently shown, and
                they reach nothing outside this workbook: no network, no files,
                no BI data. They have asked for no other permissions.
              </p>
            ))}

          {moduleScriptNames.length > 0 && (
            <>
              {/* THE MACRO SURFACE'S OWN REACH, DERIVED — NOT BORROWED.
                  A macro is a MODULE script: the run routes hand its source to
                  `run_script`, which is the `one-off-script` surface of the Rust
                  QuickJS interpreter. `SURFACE_PROFILES` in
                  core/script-engine/src/manifest.rs records how that realm is
                  built — no ModelDataProvider, no granted capability ids, host
                  globals left in place — and `surface_reach()` derives from it
                  exactly the six reach classes this paragraph enumerates:
                  grid, workbook, view, bookmarks, appMetadata, output. The
                  clauses below are in that order, and
                  macroSurfaceReachHonesty.test.ts fails if the manifest grows a
                  class this sentence does not name, or grants a capability this
                  sentence says cannot be granted.

                  It is deliberately WIDER than the object-script sentence in
                  two ways the user has to be told: a macro is not clamped to the
                  sheet currently shown, and there is no capability to withhold
                  because none is consulted. */}
              <p>
                A macro is not an object script and does not run in that realm.
                It runs in Calcula&apos;s isolated interpreter, on a copy of this
                workbook, and what it may touch there is fixed &mdash; there is
                no permission to grant and none to withhold: the cells of any
                sheet in this workbook; its sheets, document properties and
                calculation settings; how it is displayed; its bookmarks;
                Calcula&apos;s own version and locale settings, which it can
                read; and the results it prints back to you. It reaches nothing
                else: no network, no files, no BI data.
              </p>
            </>
          )}

          <p style={{ fontSize: 11, color: "#888" }}>
            You can inspect the source before allowing. Allowing is remembered
            with this workbook; if the application changes any script&apos;s or
            macro&apos;s code, or requests new capabilities, you will be asked
            again.
          </p>
        </div>

        <div style={footerStyle}>
          {canInspect && (
            <button style={btnStyle} onClick={handleInspect}>
              {inspecting ? "Inspecting..." : "Inspect Scripts"}
            </button>
          )}
          {inspectError !== null && (
            <span style={{ fontSize: 11, color: "#D13438", alignSelf: "center" }}>
              {inspectError}
            </span>
          )}
          <div style={{ flex: 1 }} />
          <button style={btnDangerStyle} onClick={handleBlock}>
            Block
          </button>
          <button style={btnPrimaryStyle} onClick={handleAllow}>
            Allow Scripts
          </button>
        </div>
      </div>
    </div>
  );
}
