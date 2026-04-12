//! FILENAME: app/extensions/BuiltIn/CellBookmarks/components/ViewBookmarkEditOverlay.tsx
// PURPOSE: Overlay for editing an existing view bookmark.
// CONTEXT: Edit metadata, recapture state, change linked script.

import React, { useState, useEffect, useRef } from "react";
import type { OverlayProps } from "@api";
import { invokeBackend } from "@api/backend";
import { BOOKMARK_DOT_COLORS, BOOKMARK_COLORS } from "../lib/bookmarkTypes";
import type { BookmarkColor } from "../lib/bookmarkTypes";
import { DIMENSION_LABELS } from "../lib/viewBookmarkTypes";
import type { ViewStateDimensions } from "../lib/viewBookmarkTypes";
import {
  getViewBookmark,
  updateViewBookmark,
  recaptureViewBookmark,
} from "../lib/viewBookmarkStore";
import { showToast } from "@api";

// ============================================================================
// Types
// ============================================================================

interface ScriptSummary {
  id: string;
  name: string;
}

// ============================================================================
// Styles
// ============================================================================

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  backgroundColor: "#FFF",
  border: "1px solid #D0D0D0",
  borderRadius: 6,
  boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
  padding: 16,
  width: 300,
  maxHeight: "80vh",
  overflowY: "auto",
  fontFamily: "Segoe UI, Tahoma, sans-serif",
  fontSize: 12,
  zIndex: 10000,
};

const titleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  marginBottom: 12,
  color: "#333",
};

const fieldLabelStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#666",
  marginBottom: 4,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "5px 8px",
  fontSize: 12,
  border: "1px solid #CCC",
  borderRadius: 3,
  outline: "none",
  boxSizing: "border-box",
  marginBottom: 10,
};

const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  resize: "vertical",
  minHeight: 40,
};

const colorRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 6,
  marginBottom: 12,
};

const colorDotStyle: React.CSSProperties = {
  width: 20,
  height: 20,
  borderRadius: "50%",
  cursor: "pointer",
  border: "2px solid transparent",
  transition: "border-color 0.15s",
};

const sectionStyle: React.CSSProperties = {
  marginBottom: 12,
};

const checkboxRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "3px 0",
  cursor: "pointer",
  fontSize: 11,
  color: "#444",
};

const selectStyle: React.CSSProperties = {
  width: "100%",
  padding: "4px 8px",
  fontSize: 11,
  border: "1px solid #CCC",
  borderRadius: 3,
  outline: "none",
  boxSizing: "border-box",
  marginBottom: 10,
  backgroundColor: "#FFF",
};

const btnRowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 6,
  marginTop: 4,
};

const btnStyle: React.CSSProperties = {
  padding: "5px 14px",
  fontSize: 11,
  border: "1px solid #CCC",
  borderRadius: 3,
  cursor: "pointer",
  backgroundColor: "#FFF",
};

const btnPrimaryStyle: React.CSSProperties = {
  ...btnStyle,
  backgroundColor: "#4A86C8",
  borderColor: "#4A86C8",
  color: "#FFF",
};

const btnWarningStyle: React.CSSProperties = {
  ...btnStyle,
  backgroundColor: "#F59E0B",
  borderColor: "#F59E0B",
  color: "#FFF",
};

const separatorStyle: React.CSSProperties = {
  borderTop: "1px solid #F0F0F0",
  margin: "10px 0",
};

// ============================================================================
// Dimension keys in display order
// ============================================================================

const DIMENSION_KEYS: (keyof ViewStateDimensions)[] = [
  "activeSheet",
  "selection",
  "viewport",
  "zoom",
  "viewMode",
  "showFormulas",
  "autoFilter",
  "hiddenRows",
  "hiddenCols",
  "freezeConfig",
  "splitConfig",
  "columnWidths",
  "rowHeights",
];

// ============================================================================
// Component
// ============================================================================

export const ViewBookmarkEditOverlay: React.FC<OverlayProps> = ({ onClose, data, anchorRect }) => {
  const viewBookmarkId = data?.viewBookmarkId as string | undefined;
  const bookmark = viewBookmarkId ? getViewBookmark(viewBookmarkId) : undefined;

  const [label, setLabel] = useState(bookmark?.label ?? "");
  const [description, setDescription] = useState(bookmark?.description ?? "");
  const [color, setColor] = useState<BookmarkColor>(bookmark?.color ?? "blue");
  const [dimensions, setDimensions] = useState<ViewStateDimensions>(
    bookmark?.dimensions ?? {}
  );
  const [scriptId, setScriptId] = useState<string>(bookmark?.onActivateScriptId ?? "");
  const [scripts, setScripts] = useState<ScriptSummary[]>([]);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 50);
  }, []);

  useEffect(() => {
    invokeBackend<ScriptSummary[]>("list_scripts")
      .then(setScripts)
      .catch(() => setScripts([]));
  }, []);

  if (!bookmark) {
    return null;
  }

  const toggleDimension = (key: keyof ViewStateDimensions) => {
    setDimensions((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleSave = () => {
    const trimmedLabel = label.trim();
    if (!trimmedLabel) {
      showToast("Please enter a name", { variant: "warning" });
      return;
    }
    updateViewBookmark(bookmark.id, {
      label: trimmedLabel,
      description: description.trim() || undefined,
      color,
      onActivateScriptId: scriptId || null,
    });
    showToast(`View "${trimmedLabel}" updated`, { variant: "success" });
    onClose();
  };

  const handleRecapture = async () => {
    setSaving(true);
    try {
      await recaptureViewBookmark(bookmark.id, dimensions);
      showToast(`View "${label.trim() || bookmark.label}" recaptured`, { variant: "success" });
      onClose();
    } catch (error) {
      console.error("[ViewBookmarks] Failed to recapture:", error);
      showToast("Failed to recapture view", { variant: "error" });
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSave();
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  const posStyle: React.CSSProperties = anchorRect
    ? { top: anchorRect.y + anchorRect.height + 4, left: anchorRect.x }
    : { top: "50%", left: "50%", transform: "translate(-50%, -50%)" };

  return (
    <div style={{ ...overlayStyle, ...posStyle }} onKeyDown={handleKeyDown}>
      <div style={titleStyle}>Edit View Bookmark</div>

      <div style={fieldLabelStyle}>Name</div>
      <input
        ref={inputRef}
        type="text"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        style={inputStyle}
      />

      <div style={fieldLabelStyle}>Description (optional)</div>
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        style={textareaStyle}
        rows={2}
      />

      <div style={fieldLabelStyle}>Color</div>
      <div style={colorRowStyle}>
        {BOOKMARK_COLORS.map((c) => (
          <div
            key={c}
            style={{
              ...colorDotStyle,
              backgroundColor: BOOKMARK_DOT_COLORS[c],
              borderColor: color === c ? "#333" : "transparent",
            }}
            onClick={() => setColor(c)}
            title={c}
          />
        ))}
      </div>

      <div style={separatorStyle} />

      <div style={sectionStyle}>
        <div style={fieldLabelStyle}>Captured dimensions</div>
        {DIMENSION_KEYS.map((key) => (
          <label key={key} style={checkboxRowStyle}>
            <input
              type="checkbox"
              checked={!!dimensions[key]}
              onChange={() => toggleDimension(key)}
            />
            {DIMENSION_LABELS[key]}
          </label>
        ))}
      </div>

      {scripts.length > 0 && (
        <>
          <div style={separatorStyle} />
          <div style={sectionStyle}>
            <div style={fieldLabelStyle}>Run script on activate (optional)</div>
            <select
              value={scriptId}
              onChange={(e) => setScriptId(e.target.value)}
              style={selectStyle}
            >
              <option value="">None</option>
              {scripts.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        </>
      )}

      <div style={btnRowStyle}>
        <button style={btnWarningStyle} onClick={handleRecapture} disabled={saving}>
          {saving ? "Capturing..." : "Recapture"}
        </button>
        <button style={btnStyle} onClick={onClose}>
          Cancel
        </button>
        <button style={btnPrimaryStyle} onClick={handleSave}>
          Save
        </button>
      </div>
    </div>
  );
};
