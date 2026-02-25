//! FILENAME: app/extensions/Pivot/components/PivotOptionsDialog.tsx
// PURPOSE: Dialog for configuring global pivot table options.
// CONTEXT: Opened from the pivot context menu "PivotTable Options..." action.
//          Has 3 tabs: Totals & Filters, Display, Layout & Format.

import React, { useState, useEffect, useCallback } from "react";
import { css } from "@emotion/css";
import {
  getPivotTableInfo,
  updatePivotProperties,
  updatePivotLayout,
  type PivotTableInfo,
  type ExtendedLayoutConfig,
  type ReportLayout,
  type SubtotalLocationType,
} from "../lib/pivot-api";

// ============================================================================
// Types
// ============================================================================

export interface PivotOptionsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  data?: Record<string, unknown>;
}

type TabId = "totals" | "display" | "layout";

interface TabDef {
  id: TabId;
  label: string;
}

const TABS: TabDef[] = [
  { id: "totals", label: "Totals & Filters" },
  { id: "display", label: "Display" },
  { id: "layout", label: "Layout & Format" },
];

// ============================================================================
// Styles
// ============================================================================

const styles = {
  overlay: css`
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
  `,
  modal: css`
    background: #fff;
    border-radius: 8px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
    min-width: 440px;
    max-width: 520px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 13px;
  `,
  header: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid #e0e0e0;
  `,
  title: css`
    font-size: 16px;
    font-weight: 600;
    color: #333;
    margin: 0;
  `,
  closeButton: css`
    background: none;
    border: none;
    font-size: 20px;
    color: #666;
    cursor: pointer;
    padding: 4px;
    line-height: 1;
    &:hover {
      color: #333;
    }
  `,
  tabs: css`
    display: flex;
    gap: 0;
    border-bottom: 1px solid #e0e0e0;
    padding: 0 20px;
  `,
  tab: css`
    padding: 10px 16px;
    border: none;
    background: none;
    cursor: pointer;
    font-size: 13px;
    color: #666;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    &:hover {
      color: #333;
    }
  `,
  tabActive: css`
    color: #0078d4;
    border-bottom-color: #0078d4;
    font-weight: 500;
  `,
  content: css`
    padding: 20px;
    min-height: 200px;
  `,
  section: css`
    margin-bottom: 16px;
  `,
  sectionTitle: css`
    font-weight: 600;
    color: #333;
    margin-bottom: 8px;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  `,
  checkboxItem: css`
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    padding: 4px 0;
    & input {
      margin: 0;
    }
    & span {
      color: #333;
    }
  `,
  radioGroup: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 4px 0;
  `,
  radioItem: css`
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    & input {
      margin: 0;
    }
    & span {
      color: #333;
      font-size: 13px;
    }
  `,
  inputRow: css`
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 0 4px 24px;
  `,
  inputSmall: css`
    flex: 1;
    padding: 6px 8px;
    border: 1px solid #ccc;
    border-radius: 4px;
    font-size: 13px;
    &:focus {
      outline: none;
      border-color: #0078d4;
    }
  `,
  label: css`
    color: #555;
    font-size: 12px;
    min-width: 70px;
  `,
  footer: css`
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 20px;
    border-top: 1px solid #e0e0e0;
    background: #f9f9f9;
    border-radius: 0 0 8px 8px;
  `,
  button: css`
    padding: 6px 20px;
    border-radius: 4px;
    font-size: 13px;
    cursor: pointer;
    border: 1px solid #ccc;
    background: #fff;
    color: #333;
    &:hover {
      background: #f5f5f5;
    }
  `,
  primaryButton: css`
    padding: 6px 20px;
    border-radius: 4px;
    font-size: 13px;
    cursor: pointer;
    border: 1px solid #0078d4;
    background: #0078d4;
    color: #fff;
    &:hover {
      background: #006cbd;
    }
    &:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  `,
};

// ============================================================================
// Component
// ============================================================================

export function PivotOptionsDialog({
  isOpen,
  onClose,
  data,
}: PivotOptionsDialogProps): React.ReactElement | null {
  const pivotId = data?.pivotId as number | undefined;

  const [activeTab, setActiveTab] = useState<TabId>("totals");
  const [loading, setLoading] = useState(false);

  // Totals & Filters state
  const [showRowGrandTotals, setShowRowGrandTotals] = useState(true);
  const [showColumnGrandTotals, setShowColumnGrandTotals] = useState(true);
  const [allowMultipleFilters, setAllowMultipleFilters] = useState(false);

  // Display state
  const [showFieldHeaders, setShowFieldHeaders] = useState(true);
  const [fillEmptyCells, setFillEmptyCells] = useState(false);
  const [emptyCellText, setEmptyCellText] = useState("");
  const [refreshOnOpen, setRefreshOnOpen] = useState(false);

  // Layout & Format state
  const [reportLayout, setReportLayout] = useState<ReportLayout>("compact");
  const [subtotalLocation, setSubtotalLocation] = useState<SubtotalLocationType>("atBottom");
  const [repeatRowLabels, setRepeatRowLabels] = useState(false);

  // Load pivot info when dialog opens
  useEffect(() => {
    if (!isOpen || pivotId === undefined) return;

    setLoading(true);
    setActiveTab("totals");

    getPivotTableInfo(pivotId)
      .then((info: PivotTableInfo) => {
        setAllowMultipleFilters(info.allowMultipleFiltersPerField);
        setRefreshOnOpen(info.refreshOnOpen);
        setLoading(false);
      })
      .catch((err) => {
        console.error("[PivotOptionsDialog] Failed to load pivot info:", err);
        setLoading(false);
      });

    // Layout defaults are loaded from cached view or default values.
    // For now, we use reasonable defaults. The actual values would come from
    // getPivotHierarchies or the layout config stored in the backend.
    setShowRowGrandTotals(true);
    setShowColumnGrandTotals(true);
    setShowFieldHeaders(true);
    setFillEmptyCells(false);
    setEmptyCellText("");
    setReportLayout("compact");
    setSubtotalLocation("atBottom");
    setRepeatRowLabels(false);
  }, [isOpen, pivotId]);

  const handleSave = useCallback(async () => {
    if (pivotId === undefined) return;

    try {
      // Update properties (name, multiple filters, etc.)
      await updatePivotProperties({
        pivotId,
        allowMultipleFiltersPerField: allowMultipleFilters,
        refreshOnOpen,
      });

      // Update layout
      const layoutConfig: ExtendedLayoutConfig = {
        showRowGrandTotals,
        showColumnGrandTotals,
        reportLayout,
        repeatRowLabels,
        showFieldHeaders,
        fillEmptyCells,
        emptyCellText: fillEmptyCells ? emptyCellText : undefined,
        subtotalLocation,
      };

      await updatePivotLayout({ pivotId, layout: layoutConfig });

      window.dispatchEvent(new Event("pivot:refresh"));
      onClose();
    } catch (err) {
      console.error("[PivotOptionsDialog] Failed to save options:", err);
    }
  }, [
    pivotId, onClose,
    showRowGrandTotals, showColumnGrandTotals, allowMultipleFilters,
    showFieldHeaders, fillEmptyCells, emptyCellText, refreshOnOpen,
    reportLayout, subtotalLocation, repeatRowLabels,
  ]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose],
  );

  if (!isOpen) return null;

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div
        className={styles.modal}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className={styles.header}>
          <h3 className={styles.title}>PivotTable Options</h3>
          <button className={styles.closeButton} onClick={onClose}>
            x
          </button>
        </div>

        {/* Tabs */}
        <div className={styles.tabs}>
          {TABS.map((tab) => (
            <button
              key={tab.id}
              className={`${styles.tab} ${activeTab === tab.id ? styles.tabActive : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className={styles.content}>
          {loading ? (
            <div style={{ padding: "20px 0", textAlign: "center", color: "#888" }}>
              Loading...
            </div>
          ) : (
            <>
              {/* Tab 1: Totals & Filters */}
              {activeTab === "totals" && (
                <>
                  <div className={styles.section}>
                    <div className={styles.sectionTitle}>Grand Totals</div>
                    <label className={styles.checkboxItem}>
                      <input
                        type="checkbox"
                        checked={showRowGrandTotals}
                        onChange={(e) => setShowRowGrandTotals(e.target.checked)}
                      />
                      <span>Show grand totals for rows</span>
                    </label>
                    <label className={styles.checkboxItem}>
                      <input
                        type="checkbox"
                        checked={showColumnGrandTotals}
                        onChange={(e) => setShowColumnGrandTotals(e.target.checked)}
                      />
                      <span>Show grand totals for columns</span>
                    </label>
                  </div>
                  <div className={styles.section}>
                    <div className={styles.sectionTitle}>Filters</div>
                    <label className={styles.checkboxItem}>
                      <input
                        type="checkbox"
                        checked={allowMultipleFilters}
                        onChange={(e) => setAllowMultipleFilters(e.target.checked)}
                      />
                      <span>Allow multiple filters per field</span>
                    </label>
                  </div>
                </>
              )}

              {/* Tab 2: Display */}
              {activeTab === "display" && (
                <>
                  <div className={styles.section}>
                    <div className={styles.sectionTitle}>Show</div>
                    <label className={styles.checkboxItem}>
                      <input
                        type="checkbox"
                        checked={showFieldHeaders}
                        onChange={(e) => setShowFieldHeaders(e.target.checked)}
                      />
                      <span>Show field headers</span>
                    </label>
                  </div>
                  <div className={styles.section}>
                    <div className={styles.sectionTitle}>Empty Cells</div>
                    <label className={styles.checkboxItem}>
                      <input
                        type="checkbox"
                        checked={fillEmptyCells}
                        onChange={(e) => setFillEmptyCells(e.target.checked)}
                      />
                      <span>For empty cells show:</span>
                    </label>
                    {fillEmptyCells && (
                      <div className={styles.inputRow}>
                        <input
                          type="text"
                          className={styles.inputSmall}
                          value={emptyCellText}
                          onChange={(e) => setEmptyCellText(e.target.value)}
                          placeholder="(empty)"
                        />
                      </div>
                    )}
                  </div>
                  <div className={styles.section}>
                    <div className={styles.sectionTitle}>Data</div>
                    <label className={styles.checkboxItem}>
                      <input
                        type="checkbox"
                        checked={refreshOnOpen}
                        onChange={(e) => setRefreshOnOpen(e.target.checked)}
                      />
                      <span>Refresh data when opening the file</span>
                    </label>
                  </div>
                </>
              )}

              {/* Tab 3: Layout & Format */}
              {activeTab === "layout" && (
                <>
                  <div className={styles.section}>
                    <div className={styles.sectionTitle}>Report Layout</div>
                    <div className={styles.radioGroup}>
                      <label className={styles.radioItem}>
                        <input
                          type="radio"
                          name="reportLayout"
                          checked={reportLayout === "compact"}
                          onChange={() => setReportLayout("compact")}
                        />
                        <span>Show in Compact Form</span>
                      </label>
                      <label className={styles.radioItem}>
                        <input
                          type="radio"
                          name="reportLayout"
                          checked={reportLayout === "outline"}
                          onChange={() => setReportLayout("outline")}
                        />
                        <span>Show in Outline Form</span>
                      </label>
                      <label className={styles.radioItem}>
                        <input
                          type="radio"
                          name="reportLayout"
                          checked={reportLayout === "tabular"}
                          onChange={() => setReportLayout("tabular")}
                        />
                        <span>Show in Tabular Form</span>
                      </label>
                    </div>
                  </div>
                  <div className={styles.section}>
                    <div className={styles.sectionTitle}>Subtotal Location</div>
                    <div className={styles.radioGroup}>
                      <label className={styles.radioItem}>
                        <input
                          type="radio"
                          name="subtotalLocation"
                          checked={subtotalLocation === "atTop"}
                          onChange={() => setSubtotalLocation("atTop")}
                        />
                        <span>Show all subtotals at top of group</span>
                      </label>
                      <label className={styles.radioItem}>
                        <input
                          type="radio"
                          name="subtotalLocation"
                          checked={subtotalLocation === "atBottom"}
                          onChange={() => setSubtotalLocation("atBottom")}
                        />
                        <span>Show all subtotals at bottom of group</span>
                      </label>
                      <label className={styles.radioItem}>
                        <input
                          type="radio"
                          name="subtotalLocation"
                          checked={subtotalLocation === "off"}
                          onChange={() => setSubtotalLocation("off")}
                        />
                        <span>Do not show subtotals</span>
                      </label>
                    </div>
                  </div>
                  <div className={styles.section}>
                    <label className={styles.checkboxItem}>
                      <input
                        type="checkbox"
                        checked={repeatRowLabels}
                        onChange={(e) => setRepeatRowLabels(e.target.checked)}
                      />
                      <span>Repeat all item labels</span>
                    </label>
                  </div>
                </>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className={styles.footer}>
          <button className={styles.button} onClick={onClose}>
            Cancel
          </button>
          <button
            className={styles.primaryButton}
            onClick={handleSave}
            disabled={loading}
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
