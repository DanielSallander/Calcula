//! FILENAME: app/extensions/CustomFunctions/components/DistributedFunctionsConsentDialog.tsx
// PURPOSE: Security consent prompt for FORMULA FUNCTIONS that arrived inside a
//          distributed .calp application. The backend merges an application's
//          function library into this workbook's one Custom Functions RECORD;
//          the gate in @api/customFunctions withholds those functions from the
//          sandbox until the user answers this prompt.
// CONTEXT: CustomFunctions-extension code (it owns the install lifecycle). Emits
//          extension-local events keyed by package name so it never collides
//          with the ScriptableObjects object-script flow or the Charts
//          chart-library flow, all three of which share ONE consent STORE.
// SECURITY: The RECORD is shared; the REALM is not. `planCustomFunctionRealms`
//          (@api/customFunctions) mounts each application's functions in a
//          worker realm of their own under `customFunctionScriptId(package)`,
//          so their grants are their own consent record's and never the
//          subscriber's, and the sibling table `fns.OTHER()` does not cross a
//          realm. What IS shared is the library's ONE capability list:
//          `rawInstall` hands `lib.capabilities` to every realm, so the list
//          this prompt shows is exactly what approving grants this code.
//          Underneath that list sits the reach EVERY restricted realm holds
//          with no capability at all — the capability-free restricted rows of
//          scriptHost/allowlist.ts, which the broker admits on tier alone
//          (brokerPolicy.ts never looks at the object type), plus the workbook
//          typed context (worker/contextShims.ts `case "workbook"`), whose hooks
//          let a body register handlers that keep running after the cell that
//          first called it is gone. Every sentence below is pinned to those
//          sources by __tests__/distributedFunctionsConsentHonesty.test.tsx —
//          a prompt that says less than the truth is the defect that test
//          exists to catch, so a shorter sentence is not an easier one.

import React, { useCallback } from "react";
import { emitAppEvent } from "@api";
import { useDialogWindow } from "@api/dialogWindow";
import type { CapabilityId, DialogProps } from "@api";

/** Per-capability glyph (ASCII), matching the other consent dialogs. */
const CAP_ICON: Record<CapabilityId, string> = {
  "net.fetch": "@",
  "bi.query": "?",
  "bi.sql": "DB",
  storage: "#",
  "ui.html": "<>",
  "ui.htmlInput": "[<>]",
  "formula.udf": "fx",
  "bi.model": "M",
  "bi.connector": "->M",
  "ui.dialog": "[?]",
  "ui.pane": "[=]",
  "distribution.writeback": "->P",
  schedule: "->S",
  "file.picker": "[/]",
  "ui.shortcut": "[^+]",
  "grid.read": "[#]",
  "distribution.publish": "P->",
  "distribution.subscribe": "<-P",
};

const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  backgroundColor: "rgba(0,0,0,0.4)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 20000,
  fontFamily: "'Segoe UI', Tahoma, sans-serif",
};
const card: React.CSSProperties = {
  position: "relative",
  backgroundColor: "#FFF",
  borderRadius: 8,
  boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
  width: 480,
  maxHeight: "80vh",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};
const header: React.CSSProperties = {
  padding: "16px 20px",
  borderBottom: "1px solid #E0E0E0",
  display: "flex",
  alignItems: "center",
  gap: 10,
};
const shield: React.CSSProperties = {
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
const body: React.CSSProperties = {
  padding: "16px 20px",
  fontSize: 12,
  lineHeight: "1.6",
  color: "#333",
  overflowY: "auto",
  flex: 1,
};
const list: React.CSSProperties = {
  margin: "10px 0",
  padding: "8px 12px",
  backgroundColor: "#F8F8F8",
  borderRadius: 4,
  border: "1px solid #E8E8E8",
};
const item: React.CSSProperties = {
  padding: "3px 0",
  fontSize: 11,
  color: "#555",
  fontFamily: "'Cascadia Code', Consolas, monospace",
};
const capList: React.CSSProperties = { margin: "10px 0", padding: "4px 0", listStyle: "none" };
const capItem: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  padding: "6px 0",
  borderTop: "1px solid #F0F0F0",
};
const capIcon: React.CSSProperties = {
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
const footer: React.CSSProperties = {
  padding: "12px 20px",
  borderTop: "1px solid #E0E0E0",
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
};
const btn: React.CSSProperties = {
  padding: "6px 16px",
  fontSize: 12,
  border: "1px solid #CCC",
  borderRadius: 4,
  backgroundColor: "#FFF",
  cursor: "pointer",
};
const btnPrimary: React.CSSProperties = {
  ...btn,
  backgroundColor: "#0078D4",
  color: "#FFF",
  borderColor: "#0078D4",
};
const btnDanger: React.CSSProperties = { ...btn, color: "#D13438", borderColor: "#D13438" };

interface CapabilityLine {
  capability: CapabilityId;
  description: string;
}

export function DistributedFunctionsConsentDialog({
  onClose,
  data,
}: DialogProps): React.ReactElement {
  const win = useDialogWindow({ minWidth: 380, minHeight: 300 });
  const packageName = (data?.packageName as string) ?? "Unknown";
  const functionNames = (data?.functionNames as string[]) ?? [];
  const caps = (data?.requestedCapabilities as CapabilityLine[]) ?? [];
  const count = functionNames.length;

  const handleAllow = useCallback(() => {
    emitAppEvent("customfunctions:consent-granted", { packageName });
    onClose();
  }, [packageName, onClose]);

  const handleBlock = useCallback(() => {
    emitAppEvent("customfunctions:consent-denied", { packageName });
    onClose();
  }, [packageName, onClose]);

  return (
    <div style={overlay} onMouseDown={(e) => e.target === e.currentTarget && handleBlock()}>
      <div
        ref={win.ref}
        role="dialog"
        aria-modal="true"
        style={{ ...card, ...win.style }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div style={header} onMouseDown={win.onHeaderMouseDown}>
          <div style={shield}>!</div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#333" }}>
              Formula Function Security
            </div>
            <div style={{ fontSize: 11, color: "#666" }}>
              This workbook received formula functions from an external application
            </div>
          </div>
        </div>

        <div style={body}>
          <p>
            The application <strong>&quot;{packageName}&quot;</strong> brought {count} formula{" "}
            {count === 1 ? "function" : "functions"} into this workbook. Each one is JavaScript
            written by that publisher. It runs when a cell uses it — and any of its code that
            sits outside the function body runs every time this workbook&apos;s functions load,
            whether or not a cell ever calls it:
          </p>

          <div style={list}>
            {functionNames.map((name) => (
              <div key={name} style={item}>
                ={name}(…)
              </div>
            ))}
          </div>

          {/* THE REACH EVERY RESTRICTED REALM HOLDS, WITH NO CAPABILITY AT ALL.
              Shown on both branches, because a capability list adds to this; it
              never replaces it. Each clause is the prompt's word for one group of
              capability-free restricted rows in scriptHost/allowlist.ts, or for
              one hook / property of the workbook typed context, and the honesty
              test derives those groups from the source and looks each clause up
              here — a row or hook added there without a sentence here fails the
              build rather than widening the reach behind an unchanged prompt. */}
          <p>
            They run in a <strong>restricted sandbox of their own</strong> — not yours: they cannot
            call your own custom functions, and nothing you have granted your own functions carries
            over. Restricted is still more than arithmetic. With no permission at all, this code can
            read and write the cells of the sheet currently shown (values, formulas and formatting),
            show you a notification, write to the script console, read this workbook&apos;s title,
            author, sheet names and sheet count, listen for this workbook&apos;s events, offer
            methods of its own to other scripts, call methods other scripts have made public, call
            the shared code libraries this workbook&apos;s Custom Functions library declares it
            uses, and lay out a form of its own (showing it takes the dialog permission). It has no
            chart, shape or slicer of its own to act on. It can also register handlers that run
            when this workbook opens, is saved, closed or printed — a handler can block the save,
            close or print — when its theme changes, or when a sheet is switched, added, deleted or
            renamed; once registered, those keep running on their own, whether or not a cell still
            uses the function that registered them.
          </p>

          {caps.length > 0 ? (
            <>
              <p>
                This workbook&apos;s Custom Functions library declares <strong>one capability
                list</strong> for every function in it, and each application&apos;s sandbox is
                mounted with the whole list. Allowing these functions therefore also grants this
                publisher&apos;s code all of the following:
              </p>
              <ul style={capList}>
                {caps.map((cap) => (
                  <li key={cap.capability} style={capItem}>
                    <span style={capIcon} aria-hidden="true">
                      {CAP_ICON[cap.capability] ?? "*"}
                    </span>
                    <span>{cap.description}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p>
              This workbook&apos;s Custom Functions library declares no capabilities, so beyond
              that reach this code gets nothing: no network, no files, no dialogs, no BI data.
            </p>
          )}

          <p style={{ fontSize: 11, color: "#888" }}>
            Blocking leaves the functions in the workbook but switched off; cells that use them
            show #NAME?. Allowing is remembered with this workbook — and you are asked again if the
            publisher changes this code, or if the capability list of this workbook&apos;s Custom
            Functions library changes.
          </p>
        </div>

        <div style={footer}>
          <button style={btnDanger} onClick={handleBlock}>
            Block
          </button>
          <button style={btnPrimary} onClick={handleAllow}>
            Allow
          </button>
        </div>
        {win.resizeHandles}
      </div>
    </div>
  );
}
