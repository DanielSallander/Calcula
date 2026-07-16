//! FILENAME: app/extensions/ScriptableObjects/components/ScriptConsentDialog.tsx
// PURPOSE: Security consent prompt for distributed object scripts.
// CONTEXT: When a workbook contains scripts from a .calp package, the user
//          is asked to review and approve them before they can run.

import React, { useState, useCallback, useEffect, useMemo } from "react";
import { emitAppEvent } from "@api/events";
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
  const scriptCount = (data?.scriptCount as number) ?? 0;
  const scriptNames = (data?.scriptNames as string[]) ?? [];
  const scriptIds = (data?.scriptIds as string[]) ?? [];
  const requestedCapabilities =
    (data?.requestedCapabilities as RequestedCapability[]) ?? [];
  const changedScripts = (data?.changedScripts as ChangedScriptData[]) ?? [];
  const [inspecting, setInspecting] = useState(false);

  // The dialog instance is reused when the consent queue advances to the
  // next package — reset per-package UI state.
  useEffect(() => {
    setInspecting(false);
  }, [packageName]);

  const handleAllow = useCallback(() => {
    emitAppEvent("scriptable-objects:consent-granted", { packageName });
    onClose();
  }, [packageName, onClose]);

  const handleBlock = useCallback(() => {
    emitAppEvent("scriptable-objects:consent-denied", { packageName });
    onClose();
  }, [packageName, onClose]);

  const handleInspect = useCallback(() => {
    // Open the Code Editor on the package's first distributed script.
    // Targeting by scriptId opens the existing script — never scaffolds.
    if (scriptIds.length === 0) return;
    emitAppEvent("scriptable-objects:edit-script", { scriptId: scriptIds[0] });
    setInspecting(true);
  }, [scriptIds]);

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
          <p>
            The package <strong>"{packageName}"</strong> includes {scriptCount} object
            script{scriptCount !== 1 ? "s" : ""} that can run code in your workbook:
          </p>

          <div style={scriptListStyle}>
            {scriptNames.map((name, i) => (
              <div key={i} style={scriptItemStyle}>{name}</div>
            ))}
          </div>

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

          {requestedCapabilities.length > 0 ? (
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
              <p style={{ fontSize: 11, color: "#888" }}>
                Anything not listed stays blocked — scripts can only reach the
                objects they're attached to. You can inspect the source before
                allowing. Allowing is remembered with this workbook; if the
                package changes any script's code or requests new capabilities,
                you will be asked again.
              </p>
            </>
          ) : (
            <>
              <p>
                Scripts run in <strong>restricted mode</strong> — they can only
                access the objects they're attached to and cannot read or write
                arbitrary cells, fetch from the web, or query BI connections.
              </p>
              <p style={{ fontSize: 11, color: "#888" }}>
                You can inspect the script source code before allowing execution.
                Allowing is remembered with this workbook; if the package updates
                any script's code, you will be asked again.
              </p>
            </>
          )}
        </div>

        <div style={footerStyle}>
          <button style={btnStyle} onClick={handleInspect}>
            {inspecting ? "Inspecting..." : "Inspect Scripts"}
          </button>
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
