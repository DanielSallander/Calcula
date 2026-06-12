//! FILENAME: app/extensions/ScriptableObjects/components/ScriptConsentDialog.tsx
// PURPOSE: Security consent prompt for distributed object scripts.
// CONTEXT: When a workbook contains scripts from a .calp package, the user
//          is asked to review and approve them before they can run.

import React, { useState, useCallback } from "react";
import { emitAppEvent } from "@api/events";

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
  const [inspecting, setInspecting] = useState(false);

  const handleAllow = useCallback(() => {
    emitAppEvent("scriptable-objects:consent-granted", { packageName });
    onClose();
  }, [packageName, onClose]);

  const handleBlock = useCallback(() => {
    emitAppEvent("scriptable-objects:consent-denied", { packageName });
    onClose();
  }, [packageName, onClose]);

  const handleInspect = useCallback(() => {
    // Open the Code Editor to let user inspect distributed scripts (read-only)
    emitAppEvent("scriptable-objects:edit-script", {
      objectType: "workbook",
      instanceId: null,
    });
    setInspecting(true);
  }, []);

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

          <p>
            Scripts run in <strong>restricted mode</strong> — they can only access
            the objects they're attached to and cannot read or write arbitrary cells
            unless you explicitly change their access level.
          </p>

          <p style={{ fontSize: 11, color: "#888" }}>
            You can inspect the script source code before allowing execution.
            Allowing is remembered with this workbook; if the package updates
            any script's code, you will be asked again.
          </p>
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
