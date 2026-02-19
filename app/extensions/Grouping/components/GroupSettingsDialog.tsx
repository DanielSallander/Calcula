//! FILENAME: app/extensions/Grouping/components/GroupSettingsDialog.tsx
// PURPOSE: Dialog for configuring outline/grouping settings.
// CONTEXT: Allows users to set summary row/column direction (below/right vs above/left).

import React, { useState, useEffect, useCallback, useRef } from "react";
import type { DialogProps } from "../../../src/api/uiTypes";
import { getOutlineSettings } from "../../../src/api";
import type { OutlineSettings, SummaryPosition } from "../../../src/api";
import { performSetOutlineSettings } from "../lib/groupingStore";

// ============================================================================
// Styles (using CSS variables from the app theme)
// ============================================================================

const v = (name: string) => `var(${name})`;

const styles = {
  backdrop: {
    position: "fixed" as const,
    inset: 0,
    zIndex: 1050,
    background: "rgba(0, 0, 0, 0.45)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  dialog: {
    background: v("--panel-bg"),
    border: `1px solid ${v("--border-default")}`,
    borderRadius: 8,
    boxShadow: "0 12px 40px rgba(0, 0, 0, 0.5)",
    width: 340,
    display: "flex",
    flexDirection: "column" as const,
    color: v("--text-primary"),
    fontFamily: '"Segoe UI", system-ui, sans-serif',
    fontSize: 13,
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "12px 16px",
    borderBottom: `1px solid ${v("--border-default")}`,
  },
  title: {
    fontWeight: 600,
    fontSize: 15,
  },
  closeBtn: {
    background: "transparent",
    border: "none",
    color: v("--text-secondary"),
    cursor: "pointer",
    padding: "4px 8px",
    borderRadius: 4,
    fontSize: 14,
    lineHeight: 1,
  },
  body: {
    padding: "16px",
    display: "flex",
    flexDirection: "column" as const,
    gap: 14,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: 600,
    color: v("--text-secondary"),
    marginBottom: 4,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
  },
  checkboxRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    cursor: "pointer",
    fontSize: 13,
  },
  checkbox: {
    width: 16,
    height: 16,
    cursor: "pointer",
    accentColor: v("--accent-primary"),
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
    padding: "12px 16px",
    borderTop: `1px solid ${v("--border-default")}`,
  },
  btn: {
    padding: "6px 20px",
    fontSize: 13,
    borderRadius: 4,
    cursor: "pointer",
    minWidth: 80,
    background: v("--grid-bg"),
    color: v("--text-primary"),
    border: `1px solid ${v("--border-default")}`,
  },
  btnPrimary: {
    padding: "6px 20px",
    fontSize: 13,
    borderRadius: 4,
    cursor: "pointer",
    minWidth: 80,
    background: v("--accent-primary"),
    color: "#ffffff",
    border: `1px solid ${v("--accent-primary")}`,
  },
};

// ============================================================================
// Component
// ============================================================================

export function GroupSettingsDialog(props: DialogProps): React.ReactElement | null {
  const { onClose } = props;
  const dialogRef = useRef<HTMLDivElement>(null);

  const [summaryRowBelow, setSummaryRowBelow] = useState(true);
  const [summaryColRight, setSummaryColRight] = useState(true);
  const [loaded, setLoaded] = useState(false);

  // Load current settings on mount
  useEffect(() => {
    getOutlineSettings().then((settings) => {
      setSummaryRowBelow(settings.summaryRowPosition === "belowRight");
      setSummaryColRight(settings.summaryColPosition === "belowRight");
      setLoaded(true);
    });
  }, []);

  // Close on Escape
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
      if (e.key === "Enter") {
        e.stopPropagation();
        handleOk();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [summaryRowBelow, summaryColRight]);

  // Click outside to close
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) {
        onClose();
      }
    },
    [onClose],
  );

  const handleOk = useCallback(async () => {
    const settings: OutlineSettings = {
      summaryRowPosition: summaryRowBelow ? "belowRight" : "aboveLeft",
      summaryColPosition: summaryColRight ? "belowRight" : "aboveLeft",
      showOutlineSymbols: true,
      autoStyles: false,
    };
    await performSetOutlineSettings(settings);
    onClose();
  }, [summaryRowBelow, summaryColRight, onClose]);

  if (!loaded) return null;

  return (
    <div style={styles.backdrop} onMouseDown={handleBackdropClick}>
      <div ref={dialogRef} style={styles.dialog}>
        {/* Header */}
        <div style={styles.header}>
          <span style={styles.title}>Group Settings</span>
          <button style={styles.closeBtn} onClick={onClose}>
            X
          </button>
        </div>

        {/* Body */}
        <div style={styles.body}>
          <div style={styles.sectionLabel}>Direction</div>

          <label style={styles.checkboxRow}>
            <input
              type="checkbox"
              style={styles.checkbox}
              checked={summaryRowBelow}
              onChange={(e) => setSummaryRowBelow(e.target.checked)}
            />
            Summary rows below detail
          </label>

          <label style={styles.checkboxRow}>
            <input
              type="checkbox"
              style={styles.checkbox}
              checked={summaryColRight}
              onChange={(e) => setSummaryColRight(e.target.checked)}
            />
            Summary columns to right of detail
          </label>
        </div>

        {/* Footer */}
        <div style={styles.footer}>
          <button style={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button style={styles.btnPrimary} onClick={handleOk}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
