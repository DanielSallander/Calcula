//! FILENAME: app/extensions/Charts/components/ChartLibraryConsentDialog.tsx
// PURPOSE: Security consent prompt for a SANDBOXED chart library (transforms /
//          marks) that arrived inside a distributed .calp package. Mirrors the
//          object-script ScriptConsentDialog but is Charts-owned and emits
//          Charts-local events ('charts:library-consent-granted'/'denied' keyed by
//          consentKey) so it never collides with the ScriptableObjects consent
//          flow. Until the user approves, the library stays UNMOUNTED.

import React, { useCallback } from "react";
import { emitAppEvent } from "@api/events";
import type { CapabilityId } from "@api";
import type { DialogProps } from "@api/uiTypes";

interface RequestedCapability {
  capability: CapabilityId;
  description: string;
  origins: string[];
}

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

const overlay: React.CSSProperties = {
  position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.4)",
  display: "flex", alignItems: "center", justifyContent: "center",
  zIndex: 20000, fontFamily: "'Segoe UI', Tahoma, sans-serif",
};
const dialog: React.CSSProperties = {
  backgroundColor: "#FFF", borderRadius: 8, boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
  width: 460, maxHeight: "80vh", display: "flex", flexDirection: "column", overflow: "hidden",
};
const header: React.CSSProperties = { padding: "16px 20px", borderBottom: "1px solid #E0E0E0", display: "flex", alignItems: "center", gap: 10 };
const shield: React.CSSProperties = { width: 24, height: 24, borderRadius: 12, backgroundColor: "#FFF4CE", color: "#8A6914", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 700, flexShrink: 0 };
const body: React.CSSProperties = { padding: "16px 20px", fontSize: 12, lineHeight: "1.6", color: "#333", overflowY: "auto", flex: 1 };
const list: React.CSSProperties = { margin: "10px 0", padding: "8px 12px", backgroundColor: "#F8F8F8", borderRadius: 4, border: "1px solid #E8E8E8" };
const item: React.CSSProperties = { padding: "3px 0", fontSize: 11, color: "#555", fontFamily: "'Cascadia Code', Consolas, monospace" };
const capList: React.CSSProperties = { margin: "10px 0", padding: "4px 0", listStyle: "none" };
const capItem: React.CSSProperties = { display: "flex", alignItems: "flex-start", gap: 8, padding: "6px 0", borderTop: "1px solid #F0F0F0" };
const capIcon: React.CSSProperties = { width: 18, height: 18, borderRadius: 4, backgroundColor: "#FDECEA", color: "#C0392B", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, flexShrink: 0, marginTop: 1 };
const footer: React.CSSProperties = { padding: "12px 20px", borderTop: "1px solid #E0E0E0", display: "flex", justifyContent: "flex-end", gap: 8 };
const btn: React.CSSProperties = { padding: "6px 16px", fontSize: 12, border: "1px solid #CCC", borderRadius: 4, backgroundColor: "#FFF", cursor: "pointer" };
const btnPrimary: React.CSSProperties = { ...btn, backgroundColor: "#0078D4", color: "#FFF", borderColor: "#0078D4" };
const btnDanger: React.CSSProperties = { ...btn, color: "#D13438", borderColor: "#D13438" };

export function ChartLibraryConsentDialog({ onClose, data }: DialogProps): React.ReactElement {
  const consentKey = (data?.consentKey as string) ?? "";
  const displayPackage = (data?.displayPackage as string) ?? "Unknown";
  const artifactLabel = (data?.artifactLabel as string) ?? "chart library";
  const itemNames = (data?.itemNames as string[]) ?? [];
  const caps = (data?.requestedCapabilities as RequestedCapability[]) ?? [];
  const count = itemNames.length;

  const handleAllow = useCallback(() => {
    emitAppEvent("charts:library-consent-granted", { consentKey });
    onClose();
  }, [consentKey, onClose]);

  const handleBlock = useCallback(() => {
    emitAppEvent("charts:library-consent-denied", { consentKey });
    onClose();
  }, [consentKey, onClose]);

  return (
    <div style={overlay} onClick={handleBlock}>
      <div style={dialog} onClick={(e) => e.stopPropagation()}>
        <div style={header}>
          <div style={shield}>!</div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#333" }}>Chart Code Security</div>
            <div style={{ fontSize: 11, color: "#666" }}>This workbook contains chart code from an external package</div>
          </div>
        </div>

        <div style={body}>
          <p>
            The package <strong>"{displayPackage}"</strong> includes {count} sandboxed{" "}
            {artifactLabel}{count !== 1 ? "s" : ""} that run code when charts render:
          </p>

          <div style={list}>
            {itemNames.map((name, i) => (
              <div key={i} style={item}>{name}</div>
            ))}
          </div>

          {caps.length > 0 ? (
            <>
              <p>Allowing grants this code the following capabilities:</p>
              <ul style={capList}>
                {caps.map((cap) => (
                  <li key={cap.capability} style={capItem}>
                    <span style={capIcon} aria-hidden="true">{CAP_ICON[cap.capability] ?? "*"}</span>
                    <span>{cap.description}</span>
                  </li>
                ))}
              </ul>
              <p style={{ fontSize: 11, color: "#888" }}>
                Anything not listed stays blocked. Allowing is remembered with this
                workbook; if the package changes this code or requests new
                capabilities, you will be asked again.
              </p>
            </>
          ) : (
            <>
              <p>
                This code runs in <strong>paint/transform-only mode</strong> — it can
                only shape chart data or draw inside a chart's plot area, with no
                network, disk, or BI access.
              </p>
              <p style={{ fontSize: 11, color: "#888" }}>
                Allowing is remembered with this workbook; if the package updates this
                code, you will be asked again.
              </p>
            </>
          )}
        </div>

        <div style={footer}>
          <button style={btnDanger} onClick={handleBlock}>Block</button>
          <button style={btnPrimary} onClick={handleAllow}>Allow</button>
        </div>
      </div>
    </div>
  );
}
