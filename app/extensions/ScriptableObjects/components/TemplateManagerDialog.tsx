//! FILENAME: app/extensions/ScriptableObjects/components/TemplateManagerDialog.tsx
// PURPOSE: Dialog for browsing, renaming, deleting, and exporting/importing templates.

import React, { useState, useEffect, useCallback, useRef } from "react";
import { showToast } from "@api";
import {
  listTemplates,
  loadTemplate,
  saveTemplate,
  deleteTemplate,
  exportTemplate,
  importTemplate,
} from "../lib/templateManager";
import type { TemplateSummary, ObjectTemplate } from "../lib/templateManager";

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
  width: 600,
  maxHeight: "80vh",
  fontFamily: "'Segoe UI', Tahoma, sans-serif",
  fontSize: 12,
  backgroundColor: "#FAFAFA",
  borderRadius: 4,
  overflow: "hidden",
  boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "10px 14px",
  borderBottom: "1px solid #E0E0E0",
  backgroundColor: "#FFF",
  flexShrink: 0,
};

const listStyle: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "8px 0",
};

const itemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 14px",
  borderBottom: "1px solid #F0F0F0",
  cursor: "pointer",
};

const itemHoverStyle: React.CSSProperties = {
  ...itemStyle,
  backgroundColor: "#F0F7FF",
};

const nameStyle: React.CSSProperties = {
  flex: 1,
  fontSize: 12,
  color: "#333",
  fontWeight: 500,
};

const metaStyle: React.CSSProperties = {
  fontSize: 10,
  color: "#999",
};

const tagStyle: React.CSSProperties = {
  fontSize: 9,
  padding: "1px 5px",
  borderRadius: 3,
  backgroundColor: "#E8E8E8",
  color: "#666",
};

const btnStyle: React.CSSProperties = {
  padding: "4px 10px",
  fontSize: 11,
  border: "1px solid #CCC",
  borderRadius: 3,
  backgroundColor: "#FFF",
  cursor: "pointer",
};

const btnDangerStyle: React.CSSProperties = {
  ...btnStyle,
  color: "#D13438",
  borderColor: "#D13438",
};

const emptyStyle: React.CSSProperties = {
  padding: "30px 14px",
  textAlign: "center",
  color: "#999",
  fontSize: 12,
};

const footerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 14px",
  borderTop: "1px solid #E0E0E0",
  backgroundColor: "#FFF",
  flexShrink: 0,
};

// ============================================================================
// Component
// ============================================================================

import type { DialogProps } from "@api/uiTypes";

export default function TemplateManagerDialog({ onClose }: DialogProps): React.ReactElement {
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setTemplates(await listTemplates());
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleRename = useCallback(async (templateId: string) => {
    if (!editName.trim()) return;
    const template = await loadTemplate(templateId);
    if (template) {
      template.name = editName.trim();
      await saveTemplate(template);
      setEditingId(null);
      await refresh();
    }
  }, [editName, refresh]);

  const handleDelete = useCallback(async (templateId: string) => {
    await deleteTemplate(templateId);
    await refresh();
    showToast("Template deleted", { type: "info" });
  }, [refresh]);

  const handleExport = useCallback(async (templateId: string) => {
    const template = await loadTemplate(templateId);
    if (!template) return;
    const json = exportTemplate(template);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${template.name.replace(/[^a-zA-Z0-9_-]/g, "_")}.calcula-template`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Exported "${template.name}"`, { type: "success" });
  }, []);

  const handleImport = useCallback(async () => {
    fileInputRef.current?.click();
  }, []);

  const handleFileSelected = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const template = importTemplate(text);
      await saveTemplate(template);
      await refresh();
      showToast(`Imported "${template.name}"`, { type: "success" });
    } catch (err) {
      showToast(`Import failed: ${err}`, { type: "error" });
    }
    // Reset file input
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [refresh]);

  return (
    <div style={dialogOverlayStyle} onClick={onClose}>
    <div style={containerStyle} onClick={(e) => e.stopPropagation()}>
      <div style={headerStyle}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>Script Templates</span>
        <span style={{ fontSize: 11, color: "#999" }}>
          {templates.length} template(s)
        </span>
      </div>

      <div style={listStyle}>
        {templates.length === 0 && (
          <div style={emptyStyle}>
            No templates yet. Save a script as a template from the Code Editor,
            or import a .calcula-template file.
          </div>
        )}

        {templates.map((t) => {
          const isHovered = hoveredId === t.id;
          const isEditing = editingId === t.id;

          return (
            <div
              key={t.id}
              style={isHovered ? itemHoverStyle : itemStyle}
              onMouseEnter={() => setHoveredId(t.id)}
              onMouseLeave={() => setHoveredId(null)}
            >
              {isEditing ? (
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleRename(t.id);
                    if (e.key === "Escape") setEditingId(null);
                  }}
                  onBlur={() => handleRename(t.id)}
                  autoFocus
                  style={{
                    flex: 1,
                    fontSize: 12,
                    padding: "2px 4px",
                    border: "1px solid #0078D4",
                    borderRadius: 2,
                    outline: "none",
                  }}
                />
              ) : (
                <>
                  <div style={{ flex: 1 }}>
                    <div style={nameStyle}>{t.name}</div>
                    <div style={metaStyle}>
                      {t.objectType} | {new Date(t.createdAt).toLocaleDateString()}
                      {t.description && ` | ${t.description}`}
                    </div>
                  </div>
                  <span style={tagStyle}>{t.objectType}</span>
                </>
              )}

              {isHovered && !isEditing && (
                <>
                  <button
                    style={btnStyle}
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingId(t.id);
                      setEditName(t.name);
                    }}
                  >
                    Rename
                  </button>
                  <button
                    style={btnStyle}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleExport(t.id);
                    }}
                  >
                    Export
                  </button>
                  <button
                    style={btnDangerStyle}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(t.id);
                    }}
                  >
                    Delete
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>

      <div style={footerStyle}>
        <button style={btnStyle} onClick={handleImport}>
          Import Template...
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".calcula-template,.json"
          style={{ display: "none" }}
          onChange={handleFileSelected}
        />
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: "#999" }}>
          Templates are stored in %APPDATA%/Calcula/templates/
        </span>
      </div>
    </div>
    </div>
  );
}
