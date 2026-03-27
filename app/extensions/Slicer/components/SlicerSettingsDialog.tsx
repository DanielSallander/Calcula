//! FILENAME: app/extensions/Slicer/components/SlicerSettingsDialog.tsx
// PURPOSE: Settings dialog for slicer selection and layout options.
// CONTEXT: Opened from the slicer right-click context menu "Slicer Settings..."
//          Inspired by Power BI's slicer settings panel.

import React, { useState, useEffect } from "react";
import type { DialogProps } from "../../../src/api";
import { getSlicerById, updateSlicerAsync } from "../lib/slicerStore";
import { requestOverlayRedraw } from "../../../src/api/gridOverlays";
import type { SlicerSelectionMode, SlicerArrangement } from "../lib/slicerTypes";

// ============================================================================
// Toggle Switch Component
// ============================================================================

function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      style={{
        ...s.toggle,
        backgroundColor: checked ? "#0e639c" : "#555555",
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? "default" : "pointer",
      }}
      onClick={() => !disabled && onChange(!checked)}
      type="button"
    >
      <span
        style={{
          ...s.toggleThumb,
          transform: checked ? "translateX(16px)" : "translateX(2px)",
        }}
      />
    </button>
  );
}

// ============================================================================
// Collapsible Section Component
// ============================================================================

function Section({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div style={s.section}>
      <button style={s.sectionHeader} onClick={() => setOpen(!open)} type="button">
        <span style={{ ...s.sectionArrow, transform: open ? "rotate(90deg)" : "rotate(0deg)" }}>
          {"\u25B6"}
        </span>
        <span style={s.sectionTitle}>{title}</span>
      </button>
      {open && <div style={s.sectionContent}>{children}</div>}
    </div>
  );
}

// ============================================================================
// Component
// ============================================================================

export function SlicerSettingsDialog({
  isOpen,
  onClose,
  data,
}: DialogProps): React.ReactElement | null {
  const slicerId = data?.slicerId as number | undefined;

  // Selection settings
  const [singleSelect, setSingleSelect] = useState(false);
  const [forceSelection, setForceSelection] = useState(false);
  const [showSelectAll, setShowSelectAll] = useState(false);

  // Data display settings
  const [hideNoData, setHideNoData] = useState(false);
  const [indicateNoData, setIndicateNoData] = useState(true);
  const [sortNoDataLast, setSortNoDataLast] = useState(true);

  // Layout settings
  const [arrangement, setArrangement] = useState<SlicerArrangement>("vertical");
  const [rows, setRows] = useState(3);
  const [columns, setColumns] = useState(1);
  const [autogrid, setAutogrid] = useState(true);
  const [itemGap, setItemGap] = useState(4);
  const [itemPadding, setItemPadding] = useState(0);
  const [buttonRadius, setButtonRadius] = useState(2);

  // Load current settings when dialog opens
  useEffect(() => {
    if (isOpen && slicerId != null) {
      const slicer = getSlicerById(slicerId);
      if (slicer) {
        setSingleSelect(slicer.selectionMode === "single");
        setForceSelection(slicer.forceSelection);
        setShowSelectAll(slicer.showSelectAll);
        setHideNoData(slicer.hideNoData);
        setIndicateNoData(slicer.indicateNoData);
        setSortNoDataLast(slicer.sortNoDataLast);
        setArrangement(slicer.arrangement);
        setRows(slicer.rows || 3);
        setColumns(slicer.columns);
        setAutogrid(slicer.autogrid);
        setItemGap(slicer.itemGap);
        setItemPadding(slicer.itemPadding);
        setButtonRadius(slicer.buttonRadius);
      }
    }
  }, [isOpen, slicerId]);

  const handleClose = () => {
    onClose();
  };

  const handleOk = async () => {
    if (slicerId == null) return;

    const selectionMode: SlicerSelectionMode = singleSelect ? "single" : "standard";

    await updateSlicerAsync(slicerId, {
      selectionMode,
      forceSelection,
      showSelectAll,
      hideNoData,
      indicateNoData,
      sortNoDataLast,
      arrangement,
      rows,
      columns,
      autogrid,
      itemGap,
      itemPadding,
      buttonRadius,
    });
    requestOverlayRedraw();
    handleClose();
  };

  const handleReset = async () => {
    if (slicerId == null) return;

    setSingleSelect(false);
    setForceSelection(false);
    setShowSelectAll(false);
    setHideNoData(false);
    setIndicateNoData(true);
    setSortNoDataLast(true);
    setArrangement("vertical");
    setRows(3);
    setColumns(1);
    setAutogrid(true);
    setItemGap(4);
    setItemPadding(0);
    setButtonRadius(2);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      handleClose();
    } else if (e.key === "Enter") {
      handleOk();
    }
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div style={s.overlay} onClick={handleClose}>
      <div
        style={s.dialog}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div style={s.header}>
          <h2 style={s.title}>Slicer Settings</h2>
          <button style={s.closeButton} onClick={handleClose} aria-label="Close">
            x
          </button>
        </div>

        {/* Scrollable Content */}
        <div style={s.scrollContent}>
          {/* Selection Section */}
          <Section title="Selection">
            <ToggleRow label="Single select" checked={singleSelect} onChange={setSingleSelect} />
            <ToggleRow label="Force selection" checked={forceSelection} onChange={setForceSelection} />
            <ToggleRow
              label={'Show "Select all" option'}
              checked={showSelectAll}
              onChange={setShowSelectAll}
            />
          </Section>

          {/* Data Display Section */}
          <Section title="Data display">
            <ToggleRow label="Hide items with no data" checked={hideNoData} onChange={setHideNoData} />
            <ToggleRow
              label="Visually indicate items with no data"
              checked={indicateNoData}
              onChange={setIndicateNoData}
              disabled={hideNoData}
            />
            <ToggleRow
              label="Show items with no data last"
              checked={sortNoDataLast}
              onChange={setSortNoDataLast}
              disabled={hideNoData}
            />
          </Section>

          {/* Multi-button Layout Section */}
          <Section title="Multi-button layout">
            {/* Layout sub-section */}
            <Section title="Layout">
              <SelectRow
                label="Arrangement"
                value={arrangement}
                options={[
                  { value: "vertical", label: "Vertical" },
                  { value: "horizontal", label: "Horizontal" },
                  { value: "grid", label: "Grid" },
                ]}
                onChange={(v) => setArrangement(v as SlicerArrangement)}
              />
              {arrangement === "grid" && (
                <>
                  <NumberRow
                    label="Rows"
                    value={rows}
                    onChange={setRows}
                    min={1}
                    max={20}
                    disabled={autogrid}
                  />
                  <NumberRow
                    label="Columns"
                    value={columns}
                    onChange={setColumns}
                    min={1}
                    max={10}
                    disabled={autogrid}
                  />
                  <ToggleRow label="Autogrid" checked={autogrid} onChange={setAutogrid} />
                </>
              )}
              {arrangement === "horizontal" && (
                <NumberRow
                  label="Columns"
                  value={columns}
                  onChange={setColumns}
                  min={1}
                  max={20}
                />
              )}
              {arrangement === "vertical" && (
                <NumberRow
                  label="Rows visible"
                  value={rows}
                  onChange={setRows}
                  min={1}
                  max={50}
                />
              )}
            </Section>

            {/* Spacing sub-section */}
            <Section title="Spacing">
              <NumberRow
                label="Gap between items"
                value={itemGap}
                onChange={setItemGap}
                min={0}
                max={50}
                suffix="px"
              />
              <NumberRow
                label="Inner padding"
                value={itemPadding}
                onChange={setItemPadding}
                min={0}
                max={30}
                suffix="px"
              />
            </Section>

            {/* Appearance sub-section */}
            <Section title="Appearance">
              <NumberRow
                label="Button corner radius"
                value={buttonRadius}
                onChange={setButtonRadius}
                min={0}
                max={20}
                suffix="px"
              />
            </Section>
          </Section>

          {/* Reset to default */}
          <button style={s.resetButton} onClick={handleReset} type="button">
            Reset to default
          </button>
        </div>

        {/* Footer */}
        <div style={s.footer}>
          <button style={s.cancelButton} onClick={handleClose}>
            Cancel
          </button>
          <button style={s.okButton} onClick={handleOk}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Row Components
// ============================================================================

function ToggleRow({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div style={{ ...s.row, ...(disabled ? s.disabled : {}) }}>
      <span style={s.rowLabel}>{label}</span>
      <Toggle checked={checked} onChange={onChange} disabled={disabled} />
    </div>
  );
}

function SelectRow({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div style={s.fieldGroup}>
      <span style={s.fieldLabel}>{label}</span>
      <select style={s.select} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function NumberRow({
  label,
  value,
  onChange,
  min,
  max,
  disabled,
  suffix,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  disabled?: boolean;
  suffix?: string;
}) {
  return (
    <div style={{ ...s.fieldGroup, ...(disabled ? s.disabled : {}) }}>
      <span style={s.fieldLabel}>{label}</span>
      <div style={s.numberInputWrapper}>
        <input
          style={s.numberInput}
          type="number"
          value={value}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10);
            if (!isNaN(v)) onChange(Math.max(min ?? 0, Math.min(max ?? 999, v)));
          }}
          min={min}
          max={max}
          disabled={disabled}
        />
        {suffix && <span style={s.suffix}>{suffix}</span>}
      </div>
    </div>
  );
}

// ============================================================================
// Styles
// ============================================================================

const s: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 10000,
  },
  dialog: {
    backgroundColor: "#2d2d2d",
    borderRadius: "8px",
    border: "1px solid #454545",
    boxShadow: "0 8px 32px rgba(0, 0, 0, 0.4)",
    width: "340px",
    maxWidth: "90vw",
    maxHeight: "85vh",
    display: "flex",
    flexDirection: "column",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "14px 20px",
    borderBottom: "1px solid #454545",
    flexShrink: 0,
  },
  title: {
    margin: 0,
    fontSize: "15px",
    fontWeight: 600,
    color: "#ffffff",
  },
  closeButton: {
    background: "transparent",
    border: "none",
    color: "#888888",
    fontSize: "18px",
    cursor: "pointer",
    padding: "4px 8px",
    borderRadius: "4px",
    lineHeight: 1,
  },
  scrollContent: {
    padding: "8px 0",
    overflowY: "auto",
    flex: 1,
  },
  section: {
    borderBottom: "1px solid #3a3a3a",
  },
  sectionHeader: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    width: "100%",
    padding: "10px 20px",
    background: "transparent",
    border: "none",
    color: "#e0e0e0",
    fontSize: "13px",
    fontWeight: 600,
    cursor: "pointer",
    textAlign: "left",
  },
  sectionArrow: {
    fontSize: "8px",
    color: "#999",
    transition: "transform 0.15s ease",
    display: "inline-block",
  },
  sectionTitle: {},
  sectionContent: {
    padding: "0 20px 12px 20px",
  },
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    padding: "5px 0",
  },
  rowLabel: {
    fontSize: "13px",
    color: "#cccccc",
    flex: 1,
  },
  toggle: {
    position: "relative" as const,
    width: "36px",
    height: "20px",
    borderRadius: "10px",
    border: "none",
    padding: 0,
    flexShrink: 0,
    transition: "background-color 0.15s ease",
  },
  toggleThumb: {
    position: "absolute" as const,
    top: "2px",
    left: "0px",
    width: "16px",
    height: "16px",
    borderRadius: "50%",
    backgroundColor: "#ffffff",
    transition: "transform 0.15s ease",
    boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
  },
  fieldGroup: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "4px",
    padding: "5px 0",
  },
  fieldLabel: {
    fontSize: "12px",
    color: "#999999",
  },
  select: {
    padding: "6px 8px",
    backgroundColor: "#3a3a3a",
    border: "1px solid #555555",
    borderRadius: "4px",
    color: "#e0e0e0",
    fontSize: "13px",
    cursor: "pointer",
  },
  numberInputWrapper: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
  },
  numberInput: {
    padding: "6px 8px",
    backgroundColor: "#3a3a3a",
    border: "1px solid #555555",
    borderRadius: "4px",
    color: "#e0e0e0",
    fontSize: "13px",
    width: "80px",
  },
  suffix: {
    fontSize: "12px",
    color: "#999999",
  },
  disabled: {
    opacity: 0.4,
    pointerEvents: "none" as const,
  },
  resetButton: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "10px 20px",
    background: "transparent",
    border: "none",
    color: "#999999",
    fontSize: "12px",
    cursor: "pointer",
    width: "100%",
    textAlign: "left",
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: "8px",
    padding: "14px 20px",
    borderTop: "1px solid #454545",
    flexShrink: 0,
  },
  cancelButton: {
    padding: "8px 16px",
    fontSize: "13px",
    backgroundColor: "transparent",
    border: "1px solid #454545",
    borderRadius: "4px",
    color: "#cccccc",
    cursor: "pointer",
  },
  okButton: {
    padding: "8px 20px",
    fontSize: "13px",
    backgroundColor: "#0e639c",
    border: "1px solid #0e639c",
    borderRadius: "4px",
    color: "#ffffff",
    cursor: "pointer",
    fontWeight: 500,
  },
};

export default SlicerSettingsDialog;
