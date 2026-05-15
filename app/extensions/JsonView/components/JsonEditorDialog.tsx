//! FILENAME: app/extensions/JsonView/components/JsonEditorDialog.tsx
// PURPOSE: Dialog wrapper for the JSON editor — provides a larger editing surface.
// CONTEXT: Opened via command "jsonView.openDialog". Wraps JsonEditorPane in a modal.

import React from "react";
import type { DialogProps } from "@api/ui";
import { JsonEditorPane } from "./JsonEditorPane";

// ============================================================================
// Styles
// ============================================================================

const styles = {
  overlay: {
    position: "fixed" as const,
    inset: 0,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
  },
  dialog: {
    width: "80vw",
    height: "80vh",
    backgroundColor: "#1e1e1e",
    border: "1px solid #555",
    borderRadius: "6px",
    display: "flex",
    flexDirection: "column" as const,
    overflow: "hidden",
    boxShadow: "0 8px 32px rgba(0, 0, 0, 0.5)",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 12px",
    borderBottom: "1px solid #333",
    backgroundColor: "#252526",
    flexShrink: 0,
  },
  title: {
    fontSize: "13px",
    fontWeight: 600,
    color: "#cccccc",
    fontFamily: "'Segoe UI', sans-serif",
  },
  closeButton: {
    background: "none",
    border: "none",
    color: "#cccccc",
    fontSize: "16px",
    cursor: "pointer",
    padding: "2px 6px",
    borderRadius: "3px",
  },
  body: {
    flex: 1,
    minHeight: 0,
  },
};

// ============================================================================
// Component
// ============================================================================

export function JsonEditorDialog({
  isOpen,
  onClose,
}: DialogProps): React.ReactElement | null {
  if (!isOpen) return null;

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <span style={styles.title}>JSON View</span>
          <button style={styles.closeButton} onClick={onClose} title="Close">
            X
          </button>
        </div>
        <div style={styles.body}>
          <JsonEditorPane />
        </div>
      </div>
    </div>
  );
}
