//! FILENAME: app/extensions/CustomFunctions/components/DistributedFunctionsConsentDialog.tsx
// PURPOSE: Security consent prompt for FORMULA FUNCTIONS that arrived inside a
//          distributed .calp package. The backend merges a package's function
//          library into this workbook's one shared Custom Functions record; the
//          gate in @api/customFunctions withholds those functions from the
//          sandbox until the user answers this prompt.
// CONTEXT: CustomFunctions-extension code (it owns the install lifecycle). Emits
//          extension-local events keyed by package name so it never collides
//          with the ScriptableObjects object-script flow or the Charts
//          chart-library flow, all three of which share ONE consent STORE.
// SECURITY: The capability list is the reach of the SHARED realm these functions
//          would join, not what the package asked for — approving really does
//          hand this code whatever the workbook's own Custom Functions library
//          holds, and the text says so.

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
              This workbook received formula functions from an external package
            </div>
          </div>
        </div>

        <div style={body}>
          <p>
            The package <strong>&quot;{packageName}&quot;</strong> brought {count} formula{" "}
            {count === 1 ? "function" : "functions"} into this workbook. Each one is JavaScript
            written by that publisher, and it runs whenever a cell uses it:
          </p>

          <div style={list}>
            {functionNames.map((name) => (
              <div key={name} style={item}>
                ={name}(…)
              </div>
            ))}
          </div>

          {caps.length > 0 ? (
            <>
              <p>
                These functions share this workbook&apos;s <strong>one</strong> Custom Functions
                sandbox, so allowing them hands this publisher&apos;s code everything that sandbox
                already holds:
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
              The Custom Functions sandbox in this workbook currently holds no capabilities, so
              this code can only compute from the arguments it is given — no network, no disk, no
              BI access.
            </p>
          )}

          <p style={{ fontSize: 11, color: "#888" }}>
            Blocking leaves the functions in the workbook but switched off; cells that use them
            show #NAME?. Allowing is remembered with this workbook — and you are asked again if the
            publisher changes this code, or if you later widen what the Custom Functions sandbox is
            allowed to do.
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
