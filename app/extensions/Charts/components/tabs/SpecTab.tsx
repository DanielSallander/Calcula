//! FILENAME: app/extensions/Charts/components/tabs/SpecTab.tsx
// PURPOSE: Spec editor tab for the chart dialog. Exposes ChartSpec as editable JSON.
// CONTEXT: Enables power users to tweak chart properties beyond what the UI exposes.
//          Bidirectional sync: UI changes update the JSON, JSON edits update the preview.
//          Uses Monaco editor for IntelliSense, autocomplete, and validation.

import React, { useState, useEffect, useRef, useCallback } from "react";
import type { ChartSpec, ParsedChartData } from "../../types";
import {
  FieldGroup,
  Label,
} from "../CreateChartDialog.styles";
import { MonacoSpecEditor } from "../MonacoSpecEditor";
import { openSpecEditorWindow } from "../../lib/openSpecEditorWindow";

interface SpecTabProps {
  spec: ChartSpec;
  onSpecChange: (updates: Partial<ChartSpec>) => void;
  isFullView?: boolean;
  onToggleFullView?: () => void;
  /** In full view, the preview is rendered inside the split pane. */
  previewPanel?: React.ReactNode;
  /** Current preview data, passed to the pop-out window. */
  previewData?: ParsedChartData | null;
}

// ============================================================================
// Styles
// ============================================================================

const editorContainerStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "4px",
  flex: 1,
};

const errorStyle: React.CSSProperties = {
  color: "#e15759",
  fontSize: "11px",
  padding: "2px 0",
  minHeight: "16px",
};

const hintStyle: React.CSSProperties = {
  color: "var(--text-secondary, #999)",
  fontSize: "11px",
  padding: "2px 0",
};

const buttonRowStyle: React.CSSProperties = {
  display: "flex",
  gap: "8px",
  marginTop: "4px",
};

const miniButtonStyle: React.CSSProperties = {
  fontSize: "11px",
  padding: "2px 8px",
  backgroundColor: "transparent",
  color: "var(--text-secondary, #999)",
  border: "1px solid var(--border-color, #3c3c3c)",
  borderRadius: "3px",
  cursor: "pointer",
};

const resizeHandleStyle: React.CSSProperties = {
  width: "6px",
  cursor: "col-resize",
  backgroundColor: "transparent",
  flexShrink: 0,
  position: "relative",
  zIndex: 1,
};

const resizeHandleLineStyle: React.CSSProperties = {
  position: "absolute",
  top: "50%",
  left: "50%",
  transform: "translate(-50%, -50%)",
  width: "2px",
  height: "40px",
  backgroundColor: "var(--border-default, #3c3c3c)",
  borderRadius: "1px",
};

// ============================================================================
// Resize Handle
// ============================================================================

function ResizeHandle({ onDragStart, onDrag }: { onDragStart: () => void; onDrag: (deltaX: number) => void }): React.ReactElement {
  const handleRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    onDragStart();
    const startX = e.clientX;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      onDrag(moveEvent.clientX - startX);
    };

    const handleMouseUp = () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  }, [onDragStart, onDrag]);

  return (
    <div
      ref={handleRef}
      style={resizeHandleStyle}
      onMouseDown={handleMouseDown}
    >
      <div style={resizeHandleLineStyle} />
    </div>
  );
}

// ============================================================================
// Component
// ============================================================================

export function SpecTab({ spec, onSpecChange, isFullView, onToggleFullView, previewPanel, previewData }: SpecTabProps): React.ReactElement {
  const [jsonText, setJsonText] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const [splitRatio, setSplitRatio] = useState(0.55);

  // Sync spec -> JSON text (only when not actively editing)
  useEffect(() => {
    if (!isEditing) {
      setJsonText(JSON.stringify(spec, null, 2));
      setParseError(null);
    }
  }, [spec, isEditing]);

  // Handle Monaco text changes
  const handleChange = useCallback((text: string) => {
    setJsonText(text);
    setIsEditing(true);

    try {
      const parsed = JSON.parse(text);

      if (!parsed || typeof parsed !== "object") {
        setParseError("Spec must be a JSON object");
        return;
      }
      if (!parsed.mark || typeof parsed.mark !== "string") {
        setParseError("Missing or invalid 'mark' field");
        return;
      }

      setParseError(null);
      onSpecChange(parsed);
    } catch (err) {
      if (err instanceof SyntaxError) {
        setParseError(`JSON syntax error: ${err.message}`);
      } else {
        setParseError(String(err));
      }
    }
  }, [onSpecChange]);

  const handleBlur = useCallback(() => {
    setIsEditing(false);
  }, []);

  // Format
  const handleFormat = useCallback(() => {
    try {
      const parsed = JSON.parse(jsonText);
      setJsonText(JSON.stringify(parsed, null, 2));
      setParseError(null);
    } catch {
      // Keep as-is
    }
  }, [jsonText]);

  // Reset
  const handleReset = useCallback(() => {
    setJsonText(JSON.stringify(spec, null, 2));
    setParseError(null);
    setIsEditing(false);
  }, [spec]);

  // Resize handler
  const baseSplitRatio = useRef(splitRatio);

  const handleResizeDragStart = useCallback(() => {
    baseSplitRatio.current = splitRatio;
  }, [splitRatio]);

  const handleResizeDrag = useCallback((deltaX: number) => {
    const container = splitContainerRef.current;
    if (!container) return;
    const totalWidth = container.clientWidth;
    if (totalWidth === 0) return;
    const newRatio = baseSplitRatio.current + deltaX / totalWidth;
    setSplitRatio(Math.max(0.25, Math.min(0.75, newRatio)));
  }, []);

  // Pop out to separate window
  const handlePopOut = useCallback(() => {
    openSpecEditorWindow(spec, previewData ?? null);
  }, [spec, previewData]);

  // ---- Full-view layout: header + split pane + buttons ----
  if (isFullView && previewPanel) {
    return (
      <div style={{ ...editorContainerStyle, flex: 1, minHeight: 0 }}>
        {/* Header spans full width */}
        <FieldGroup style={{ flexShrink: 0 }}>
          <Label>Chart Specification (JSON)</Label>
          <div style={hintStyle}>
            Edit the JSON below. IntelliSense provides autocomplete and documentation.
          </div>
        </FieldGroup>

        {/* Split pane: editor | handle | preview */}
        <div
          ref={splitContainerRef}
          style={{
            display: "flex",
            flexDirection: "row",
            flex: 1,
            minHeight: 0,
            gap: 0,
          }}
        >
          {/* Editor pane */}
          <div style={{ flex: `0 0 ${splitRatio * 100}%`, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
            <div style={{ flex: 1, minHeight: 0, border: parseError ? "1px solid #e15759" : "1px solid #3c3c3c", borderRadius: "4px", overflow: "hidden" }}>
              <MonacoSpecEditor
                value={jsonText}
                onChange={handleChange}
                onBlur={handleBlur}
              />
            </div>
            <div style={errorStyle}>
              {parseError ?? ""}
            </div>
          </div>

          {/* Resize handle */}
          <ResizeHandle onDragStart={handleResizeDragStart} onDrag={handleResizeDrag} />

          {/* Preview pane */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
            {previewPanel}
          </div>
        </div>

        {/* Buttons span full width */}
        <div style={{ ...buttonRowStyle, flexShrink: 0 }}>
          <button style={miniButtonStyle} onClick={handleFormat} title="Format JSON">
            Format
          </button>
          <button style={miniButtonStyle} onClick={handleReset} title="Reset to current spec">
            Reset
          </button>
          <button style={miniButtonStyle} onClick={handlePopOut} title="Open in separate window">
            Pop Out
          </button>
          {onToggleFullView && (
            <button
              style={{ ...miniButtonStyle, marginLeft: "auto" }}
              onClick={onToggleFullView}
              title="Exit full view"
            >
              Collapse
            </button>
          )}
        </div>
      </div>
    );
  }

  // ---- Normal (compact) layout ----
  return (
    <div style={editorContainerStyle}>
      <FieldGroup>
        <Label>Chart Specification (JSON)</Label>
        <div style={hintStyle}>
          Edit the JSON below. IntelliSense provides autocomplete and documentation.
        </div>
      </FieldGroup>

      <div style={{ height: "300px", border: parseError ? "1px solid #e15759" : "1px solid #3c3c3c", borderRadius: "4px", overflow: "hidden" }}>
        <MonacoSpecEditor
          value={jsonText}
          onChange={handleChange}
          onBlur={handleBlur}
        />
      </div>

      <div style={errorStyle}>
        {parseError ?? ""}
      </div>

      <div style={buttonRowStyle}>
        <button style={miniButtonStyle} onClick={handleFormat} title="Format JSON">
          Format
        </button>
        <button style={miniButtonStyle} onClick={handleReset} title="Reset to current spec">
          Reset
        </button>
        <button style={miniButtonStyle} onClick={handlePopOut} title="Open in separate window">
          Pop Out
        </button>
        {onToggleFullView && (
          <button
            style={{ ...miniButtonStyle, marginLeft: "auto" }}
            onClick={onToggleFullView}
            title="Expand to full view"
          >
            Full View
          </button>
        )}
      </div>
    </div>
  );
}
