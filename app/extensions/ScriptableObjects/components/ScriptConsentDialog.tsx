//! FILENAME: app/extensions/ScriptableObjects/components/ScriptConsentDialog.tsx
// PURPOSE: Security consent prompt for distributed object scripts.
// CONTEXT: When a workbook contains scripts from a .calp package, the user
//          is asked to review and approve them before they can run.

import React, { useState, useCallback, useEffect } from "react";
import { emitAppEvent } from "@api/events";
import type { CapabilityId } from "@api";

/** One entry in the consent prompt's requested-capabilities list. */
interface RequestedCapability {
  capability: CapabilityId;
  description: string;
  origins: string[];
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
  storage: "#",
  "ui.html": "<>",
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
