//! FILENAME: app/extensions/ScriptableObjects/components/ScriptMarketplace.tsx
// PURPOSE: Community script template marketplace.
// CONTEXT: Browse, import, and share script templates. Currently works as a
//          local file-based exchange — templates can be exported as .calcula-template
//          files and shared via any file sharing mechanism. A future version could
//          connect to an online registry.

import React, { useState, useCallback, useRef } from "react";
import { showToast } from "@api";
import {
  saveTemplate,
  importTemplate,
  exportTemplate,
  loadTemplate,
} from "../lib/templateManager";
import type { ObjectTemplate } from "../lib/templateManager";

// ============================================================================
// Styles
// ============================================================================

const dialogOverlayStyle: React.CSSProperties = {
  position: "fixed",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: "rgba(0,0,0,0.4)",
  zIndex: 9000,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const containerStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: 550,
  maxHeight: "80vh",
  fontFamily: "'Segoe UI', Tahoma, sans-serif",
  fontSize: 12,
  backgroundColor: "#FAFAFA",
  borderRadius: 4,
  overflow: "hidden",
  boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
};

const headerStyle: React.CSSProperties = {
  padding: "12px 14px",
  borderBottom: "1px solid #E0E0E0",
  backgroundColor: "#FFF",
  flexShrink: 0,
};

const sectionStyle: React.CSSProperties = {
  padding: "14px",
  flex: 1,
  overflowY: "auto",
};

const cardStyle: React.CSSProperties = {
  border: "1px solid #E0E0E0",
  borderRadius: 6,
  padding: "14px",
  marginBottom: 12,
  backgroundColor: "#FFF",
};

const cardTitleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "#333",
  marginBottom: 6,
};

const cardDescStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#666",
  lineHeight: "1.5",
  marginBottom: 10,
};

const btnStyle: React.CSSProperties = {
  padding: "6px 14px",
  fontSize: 11,
  border: "1px solid #CCC",
  borderRadius: 3,
  backgroundColor: "#FFF",
  cursor: "pointer",
  marginRight: 6,
};

const btnPrimaryStyle: React.CSSProperties = {
  ...btnStyle,
  backgroundColor: "#0078D4",
  color: "#FFF",
  borderColor: "#0078D4",
};

const dropZoneStyle: React.CSSProperties = {
  border: "2px dashed #CCC",
  borderRadius: 8,
  padding: "30px 20px",
  textAlign: "center",
  color: "#999",
  cursor: "pointer",
  marginBottom: 14,
  transition: "border-color 0.2s, background-color 0.2s",
};

const dropZoneActiveStyle: React.CSSProperties = {
  ...dropZoneStyle,
  borderColor: "#0078D4",
  backgroundColor: "#F0F7FF",
  color: "#0078D4",
};

const previewStyle: React.CSSProperties = {
  fontFamily: "'Cascadia Code', Consolas, monospace",
  fontSize: 11,
  lineHeight: "1.4",
  backgroundColor: "#1E1E1E",
  color: "#D4D4D4",
  padding: "10px",
  borderRadius: 4,
  maxHeight: 150,
  overflow: "auto",
  whiteSpace: "pre-wrap",
};

// ============================================================================
// Component
// ============================================================================

import type { DialogProps } from "@api/uiTypes";

export default function ScriptMarketplace({ onClose }: DialogProps): React.ReactElement {
  const [isDragging, setIsDragging] = useState(false);
  const [importedTemplate, setImportedTemplate] = useState<ObjectTemplate | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const file = e.dataTransfer.files[0];
    if (!file) return;
    await processFile(file);
  }, []);

  const handleFileClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await processFile(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  async function processFile(file: File) {
    try {
      const text = await file.text();
      const template = importTemplate(text);
      setImportedTemplate(template);
    } catch (err) {
      showToast(`Failed to read template: ${err}`, { type: "error" });
    }
  }

  const handleInstall = useCallback(async () => {
    if (!importedTemplate) return;
    try {
      await saveTemplate(importedTemplate);
      showToast(`Installed "${importedTemplate.name}"`, { type: "success" });
      setImportedTemplate(null);
    } catch (err) {
      showToast(`Install failed: ${err}`, { type: "error" });
    }
  }, [importedTemplate]);

  const handleDiscard = useCallback(() => {
    setImportedTemplate(null);
  }, []);

  return (
    <div style={dialogOverlayStyle} onClick={onClose}>
    <div style={containerStyle} onClick={(e) => e.stopPropagation()}>
      <div style={headerStyle}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
          Script Marketplace
        </div>
        <div style={{ fontSize: 11, color: "#666" }}>
          Import and share script templates for your spreadsheet objects.
        </div>
      </div>

      <div style={sectionStyle}>
        {/* Drop zone for importing */}
        <div
          style={isDragging ? dropZoneActiveStyle : dropZoneStyle}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={handleFileClick}
        >
          Drop a .calcula-template file here, or click to browse
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".calcula-template,.json"
          style={{ display: "none" }}
          onChange={handleFileChange}
        />

        {/* Preview imported template */}
        {importedTemplate && (
          <div style={cardStyle}>
            <div style={cardTitleStyle}>{importedTemplate.name}</div>
            <div style={cardDescStyle}>
              Type: {importedTemplate.objectType} |
              Access: {importedTemplate.accessLevel} |
              Created: {new Date(importedTemplate.createdAt).toLocaleDateString()}
              {importedTemplate.description && <><br />{importedTemplate.description}</>}
            </div>
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 10, color: "#999", marginBottom: 4 }}>Script preview:</div>
              <div style={previewStyle}>
                {importedTemplate.scriptSource.slice(0, 500)}
                {importedTemplate.scriptSource.length > 500 ? "\n..." : ""}
              </div>
            </div>
            <button style={btnPrimaryStyle} onClick={handleInstall}>
              Install Template
            </button>
            <button style={btnStyle} onClick={handleDiscard}>
              Discard
            </button>
          </div>
        )}

        {/* Sharing instructions */}
        <div style={cardStyle}>
          <div style={cardTitleStyle}>Sharing Templates</div>
          <div style={cardDescStyle}>
            To share a script template:
            <br />1. Open Developer &gt; Script Templates
            <br />2. Click "Export" on any template
            <br />3. Share the .calcula-template file
            <br /><br />
            To install a shared template:
            <br />1. Drag & drop the file above, or click to browse
            <br />2. Review the script preview
            <br />3. Click "Install Template"
          </div>
        </div>

        {/* Future: online registry placeholder */}
        <div style={{ ...cardStyle, borderStyle: "dashed", opacity: 0.6 }}>
          <div style={cardTitleStyle}>Community Registry (Coming Soon)</div>
          <div style={cardDescStyle}>
            A centralized template registry where the community can publish, discover,
            and install script templates. Browse popular templates for slicers, charts,
            pivots, and more.
          </div>
        </div>
      </div>
    </div>
    </div>
  );
}
