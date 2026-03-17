//! FILENAME: app/extensions/Print/components/PageSetupDialog.tsx
// PURPOSE: Page Setup dialog for configuring print options.
// CONTEXT: Opened from File > Page Setup menu item.

import React, { useState, useEffect, useCallback } from "react";
import type { DialogProps } from "../../../src/api/uiTypes";
import {
  getPageSetup,
  setPageSetup,
} from "../../../src/api/lib";
import type { PageSetup } from "../../../src/api/lib";

// ============================================================================
// Styles
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
    width: 480,
    maxHeight: "85vh",
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
  title: { fontWeight: 600, fontSize: 14 },
  closeBtn: {
    background: "none",
    border: "none",
    color: v("--text-secondary"),
    fontSize: 18,
    cursor: "pointer",
    padding: "2px 6px",
    borderRadius: 4,
  },
  body: {
    padding: "16px",
    overflowY: "auto" as const,
    flex: 1,
  },
  section: {
    marginBottom: 16,
  },
  sectionTitle: {
    fontWeight: 600,
    fontSize: 12,
    textTransform: "uppercase" as const,
    color: v("--text-secondary"),
    marginBottom: 8,
    letterSpacing: "0.5px",
  },
  row: {
    display: "flex",
    gap: 12,
    marginBottom: 8,
    alignItems: "center",
  },
  label: {
    width: 120,
    fontSize: 13,
    flexShrink: 0,
  },
  input: {
    flex: 1,
    padding: "4px 8px",
    border: `1px solid ${v("--border-default")}`,
    borderRadius: 4,
    background: v("--input-bg"),
    color: v("--text-primary"),
    fontSize: 13,
    outline: "none",
  },
  select: {
    flex: 1,
    padding: "4px 8px",
    border: `1px solid ${v("--border-default")}`,
    borderRadius: 4,
    background: v("--input-bg"),
    color: v("--text-primary"),
    fontSize: 13,
    outline: "none",
  },
  checkbox: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 6,
    cursor: "pointer",
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
    borderRadius: 4,
    border: `1px solid ${v("--border-default")}`,
    background: v("--panel-bg"),
    color: v("--text-primary"),
    fontSize: 13,
    cursor: "pointer",
  },
  btnPrimary: {
    padding: "6px 20px",
    borderRadius: 4,
    border: "none",
    background: "#0078d4",
    color: "#fff",
    fontSize: 13,
    cursor: "pointer",
    fontWeight: 600,
  },
};

// ============================================================================
// Component
// ============================================================================

export function PageSetupDialog({ isOpen, onClose }: DialogProps) {
  const [setup, setSetupState] = useState<PageSetup | null>(null);
  const [loading, setLoading] = useState(true);

  // Load current page setup
  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    getPageSetup()
      .then((ps) => {
        setSetupState(ps);
        setLoading(false);
      })
      .catch((err) => {
        console.error("[PageSetup] Failed to load:", err);
        setLoading(false);
      });
  }, [isOpen]);

  const update = useCallback(
    <K extends keyof PageSetup>(key: K, value: PageSetup[K]) => {
      setSetupState((prev) => (prev ? { ...prev, [key]: value } : prev));
    },
    [],
  );

  const handleSave = useCallback(async () => {
    if (!setup) return;
    try {
      await setPageSetup(setup);
      onClose();
    } catch (err) {
      console.error("[PageSetup] Failed to save:", err);
      alert("Failed to save page setup: " + String(err));
    }
  }, [setup, onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Enter") handleSave();
    },
    [onClose, handleSave],
  );

  if (!isOpen) return null;

  return (
    <div style={styles.backdrop} onClick={onClose} onKeyDown={handleKeyDown}>
      <div
        style={styles.dialog}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Page Setup"
      >
        {/* Header */}
        <div style={styles.header}>
          <span style={styles.title}>Page Setup</span>
          <button style={styles.closeBtn} onClick={onClose} title="Close">
            X
          </button>
        </div>

        {/* Body */}
        <div style={styles.body}>
          {loading || !setup ? (
            <div>Loading...</div>
          ) : (
            <>
              {/* Page section */}
              <div style={styles.section}>
                <div style={styles.sectionTitle}>Page</div>
                <div style={styles.row}>
                  <span style={styles.label}>Orientation:</span>
                  <select
                    style={styles.select}
                    value={setup.orientation}
                    onChange={(e) => update("orientation", e.target.value)}
                  >
                    <option value="portrait">Portrait</option>
                    <option value="landscape">Landscape</option>
                  </select>
                </div>
                <div style={styles.row}>
                  <span style={styles.label}>Paper size:</span>
                  <select
                    style={styles.select}
                    value={setup.paperSize}
                    onChange={(e) => update("paperSize", e.target.value)}
                  >
                    <option value="a4">A4 (210 x 297 mm)</option>
                    <option value="a3">A3 (297 x 420 mm)</option>
                    <option value="letter">Letter (8.5 x 11 in)</option>
                    <option value="legal">Legal (8.5 x 14 in)</option>
                    <option value="tabloid">Tabloid (11 x 17 in)</option>
                  </select>
                </div>
                <div style={styles.row}>
                  <span style={styles.label}>Scale (%):</span>
                  <input
                    type="number"
                    style={styles.input}
                    value={setup.scale}
                    min={10}
                    max={400}
                    onChange={(e) =>
                      update("scale", Math.max(10, Math.min(400, parseInt(e.target.value) || 100)))
                    }
                  />
                </div>
              </div>

              {/* Margins section */}
              <div style={styles.section}>
                <div style={styles.sectionTitle}>Margins (inches)</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  {(
                    [
                      ["marginTop", "Top"],
                      ["marginBottom", "Bottom"],
                      ["marginLeft", "Left"],
                      ["marginRight", "Right"],
                    ] as const
                  ).map(([key, label]) => (
                    <div key={key} style={styles.row}>
                      <span style={{ ...styles.label, width: 60 }}>{label}:</span>
                      <input
                        type="number"
                        style={styles.input}
                        value={setup[key]}
                        min={0}
                        max={5}
                        step={0.05}
                        onChange={(e) =>
                          update(key, Math.max(0, parseFloat(e.target.value) || 0))
                        }
                      />
                    </div>
                  ))}
                </div>
              </div>

              {/* Sheet section */}
              <div style={styles.section}>
                <div style={styles.sectionTitle}>Sheet</div>
                <div style={styles.row}>
                  <span style={styles.label}>Print area:</span>
                  <input
                    type="text"
                    style={styles.input}
                    value={setup.printArea}
                    placeholder="e.g. A1:F20 (empty = all)"
                    onChange={(e) => update("printArea", e.target.value)}
                  />
                </div>
                <div style={styles.row}>
                  <span style={styles.label}>Rows to repeat:</span>
                  <input
                    type="text"
                    style={styles.input}
                    value={setup.printTitlesRows}
                    placeholder="e.g. 1:2"
                    onChange={(e) => update("printTitlesRows", e.target.value)}
                  />
                </div>
                <div style={styles.row}>
                  <span style={styles.label}>Cols to repeat:</span>
                  <input
                    type="text"
                    style={styles.input}
                    value={setup.printTitlesCols}
                    placeholder="e.g. A:B"
                    onChange={(e) => update("printTitlesCols", e.target.value)}
                  />
                </div>
                <label style={styles.checkbox}>
                  <input
                    type="checkbox"
                    checked={setup.printGridlines}
                    onChange={(e) => update("printGridlines", e.target.checked)}
                  />
                  Print gridlines
                </label>
                <label style={styles.checkbox}>
                  <input
                    type="checkbox"
                    checked={setup.printHeadings}
                    onChange={(e) => update("printHeadings", e.target.checked)}
                  />
                  Print row and column headings
                </label>
                <label style={styles.checkbox}>
                  <input
                    type="checkbox"
                    checked={setup.centerHorizontally}
                    onChange={(e) => update("centerHorizontally", e.target.checked)}
                  />
                  Center horizontally
                </label>
                <label style={styles.checkbox}>
                  <input
                    type="checkbox"
                    checked={setup.centerVertically}
                    onChange={(e) => update("centerVertically", e.target.checked)}
                  />
                  Center vertically
                </label>
              </div>

              {/* Header/Footer section */}
              <div style={styles.section}>
                <div style={styles.sectionTitle}>Header / Footer</div>
                <div style={styles.row}>
                  <span style={styles.label}>Header:</span>
                  <input
                    type="text"
                    style={styles.input}
                    value={setup.header}
                    placeholder="&F = filename, &D = date, &P = page"
                    onChange={(e) => update("header", e.target.value)}
                  />
                </div>
                <div style={styles.row}>
                  <span style={styles.label}>Footer:</span>
                  <input
                    type="text"
                    style={styles.input}
                    value={setup.footer}
                    placeholder="&P = page, &N = pages, &D = date"
                    onChange={(e) => update("footer", e.target.value)}
                  />
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer buttons */}
        <div style={styles.footer}>
          <button style={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button style={styles.btnPrimary} onClick={handleSave}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
