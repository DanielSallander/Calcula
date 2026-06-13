//! FILENAME: app/extensions/ScriptableObjects/components/CapabilityRequestDialog.tsx
// PURPOSE: Just-in-time (JIT) capability-grant prompt for local object scripts.
// CONTEXT: When a LOCAL script first calls an ungranted capability (e.g.
//          net.fetch), the host emits "scriptable-objects:capability-request"
//          and awaits the user's decision. This dialog lets the user answer
//          Allow once / Allow always / Deny. A dismissed prompt fails closed
//          (deny) — see index.ts which resolves the request on any close.

import React, { useCallback } from "react";
import { emitAppEvent } from "@api/events";
import type { DialogProps } from "@api/uiTypes";
import type { CapabilityDecision } from "@api";

// ============================================================================
// Styles (mirrors ScriptConsentDialog.tsx)
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

const keyIcon: React.CSSProperties = {
  width: 24,
  height: 24,
  borderRadius: 12,
  backgroundColor: "#E5F1FB",
  color: "#0078D4",
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

const originStyle: React.CSSProperties = {
  margin: "10px 0",
  padding: "8px 12px",
  backgroundColor: "#F8F8F8",
  borderRadius: 4,
  border: "1px solid #E8E8E8",
  fontSize: 11,
  color: "#555",
  fontFamily: "'Cascadia Code', Consolas, monospace",
  wordBreak: "break-all",
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

// Deny is the safe/cancel default — styled like the consent dialog's neutral
// (not danger) so it reads as the safe choice rather than a destructive action.
const btnDefaultStyle: React.CSSProperties = {
  ...btnStyle,
  fontWeight: 600,
};

// ============================================================================
// SVG key icon
// ============================================================================

const KeyGlyph = React.createElement(
  "svg",
  {
    width: 14,
    height: 14,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  },
  React.createElement("circle", { cx: 8, cy: 15, r: 4 }),
  React.createElement("path", { d: "M10.85 12.15 L19 4" }),
  React.createElement("path", { d: "M18 5 L20 7" }),
  React.createElement("path", { d: "M15 8 L17 10" }),
);

// ============================================================================
// Component
// ============================================================================

export default function CapabilityRequestDialog({
  onClose,
  data,
}: DialogProps): React.ReactElement {
  const requestId = (data?.requestId as string) ?? "";
  const scriptName = (data?.scriptName as string) ?? "A script";
  const capability = (data?.capability as string) ?? "";
  const description = (data?.description as string) ?? "use a restricted capability";
  const origin = (data?.origin as string | null) ?? null;

  const decide = useCallback(
    (decision: CapabilityDecision) => {
      // Signal the decision back to index.ts, which calls
      // resolveCapabilityRequest(requestId, decision). A close WITHOUT a
      // decision (Escape / overlay click) is resolved as "deny" by index.ts.
      emitAppEvent("scriptable-objects:capability-decided", { requestId, decision });
      onClose();
    },
    [requestId, onClose],
  );

  const handleAllowOnce = useCallback(() => decide("once"), [decide]);
  const handleAllowAlways = useCallback(() => decide("always"), [decide]);
  const handleDeny = useCallback(() => decide("deny"), [decide]);

  return (
    <div style={overlayStyle} onClick={handleDeny}>
      <div style={dialogStyle} onClick={(e) => e.stopPropagation()}>
        <div style={headerStyle}>
          <div style={keyIcon}>{KeyGlyph}</div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#333" }}>
              Permission request
            </div>
            <div style={{ fontSize: 11, color: "#666" }}>
              A script is asking for access it does not yet have
            </div>
          </div>
        </div>

        <div style={bodyStyle}>
          <p>
            <strong>"{scriptName}"</strong> wants to <strong>{description}</strong>.
          </p>

          {capability === "net.fetch" && origin && (
            <div style={originStyle}>{origin}</div>
          )}

          <p style={{ fontSize: 11, color: "#888" }}>
            The script runs sandboxed and cannot read or write your cells or files
            unless you separately grant it. Granting this only permits the action
            described above. Choose <strong>Allow once</strong> for a single use, or
            <strong> Allow always</strong> to remember this for this script.
          </p>
        </div>

        <div style={footerStyle}>
          <button style={btnDefaultStyle} onClick={handleDeny}>
            Deny
          </button>
          <div style={{ flex: 1 }} />
          <button style={btnStyle} onClick={handleAllowOnce}>
            Allow once
          </button>
          <button style={btnPrimaryStyle} onClick={handleAllowAlways}>
            Allow always
          </button>
        </div>
      </div>
    </div>
  );
}
