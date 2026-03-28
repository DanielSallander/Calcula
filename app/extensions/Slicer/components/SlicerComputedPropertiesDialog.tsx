//! FILENAME: app/extensions/Slicer/components/SlicerComputedPropertiesDialog.tsx
// PURPOSE: Dialog for managing formula-driven computed attributes on a slicer.
// CONTEXT: Allows users to dynamically control slicer attributes (width, height,
//          columns, etc.) via formulas that reference cell values.

import React, { useState, useEffect, useCallback } from "react";
import type { DialogProps } from "../../../src/api";
import { getSlicerById } from "../lib/slicerStore";
import {
  getSlicerComputedProperties,
  getSlicerAvailableAttributes,
  addSlicerComputedProperty,
  updateSlicerComputedProperty,
  removeSlicerComputedProperty,
} from "../lib/slicer-api";
import { requestOverlayRedraw } from "../../../src/api/gridOverlays";
import { broadcastSelectedSlicers } from "../handlers/selectionHandler";
import { refreshCache } from "../lib/slicerStore";
import type { SlicerComputedPropertyData } from "../lib/slicerTypes";

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
    width: "520px",
    maxWidth: "90vw",
    maxHeight: "80vh",
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
  subtitle: {
    fontSize: "12px",
    color: "#999",
    fontWeight: 400,
    marginLeft: "8px",
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
  content: {
    padding: "12px 20px",
    overflowY: "auto",
    flex: 1,
  },
  emptyMessage: {
    color: "#999",
    fontSize: "13px",
    fontStyle: "italic",
    padding: "20px 0",
    textAlign: "center",
  },
  gridHeader: {
    display: "grid",
    gridTemplateColumns: "140px 1fr 80px 28px",
    gap: "8px",
    padding: "4px 0",
    borderBottom: "1px solid #3a3a3a",
    marginBottom: "4px",
  },
  gridHeaderLabel: {
    fontSize: "11px",
    color: "#888",
    fontWeight: 600,
    textTransform: "uppercase" as const,
    letterSpacing: "0.5px",
  },
  propertyRow: {
    display: "grid",
    gridTemplateColumns: "140px 1fr 80px 28px",
    gap: "8px",
    alignItems: "center",
    padding: "4px 0",
  },
  formulaCell: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
  },
  applyButton: {
    width: "22px",
    height: "22px",
    padding: 0,
    border: "none",
    borderRadius: "3px",
    backgroundColor: "#2ea04380",
    color: "#4ade80",
    cursor: "pointer",
    fontSize: "13px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    lineHeight: 1,
  },
  cancelButton: {
    width: "22px",
    height: "22px",
    padding: 0,
    border: "none",
    borderRadius: "3px",
    backgroundColor: "#d9534f40",
    color: "#f87171",
    cursor: "pointer",
    fontSize: "13px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    lineHeight: 1,
  },
  select: {
    padding: "4px 6px",
    backgroundColor: "#3a3a3a",
    border: "1px solid #555555",
    borderRadius: "4px",
    color: "#e0e0e0",
    fontSize: "12px",
    cursor: "pointer",
    width: "100%",
  },
  formulaInput: {
    padding: "4px 6px",
    backgroundColor: "#3a3a3a",
    border: "1px solid #555555",
    borderRadius: "4px",
    color: "#e0e0e0",
    fontSize: "12px",
    fontFamily: "Consolas, monospace",
    width: "100%",
    boxSizing: "border-box" as const,
  },
  valueDisplay: {
    fontSize: "11px",
    color: "#999",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  deleteButton: {
    width: "24px",
    height: "24px",
    padding: 0,
    border: "none",
    borderRadius: "4px",
    backgroundColor: "transparent",
    color: "#888",
    cursor: "pointer",
    fontSize: "14px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  footer: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "14px 20px",
    borderTop: "1px solid #454545",
    flexShrink: 0,
  },
  addButton: {
    padding: "6px 14px",
    fontSize: "12px",
    backgroundColor: "transparent",
    border: "1px solid #555",
    borderRadius: "4px",
    color: "#cccccc",
    cursor: "pointer",
  },
  closeBtn: {
    padding: "6px 16px",
    fontSize: "12px",
    backgroundColor: "#0e639c",
    border: "1px solid #0e639c",
    borderRadius: "4px",
    color: "#ffffff",
    cursor: "pointer",
    fontWeight: 500,
  },
};

// ============================================================================
// Component
// ============================================================================

export function SlicerComputedPropertiesDialog({
  isOpen,
  onClose,
  data,
}: DialogProps): React.ReactElement | null {
  const slicerId = data?.slicerId as number | undefined;

  const [properties, setProperties] = useState<SlicerComputedPropertyData[]>([]);
  const [availableAttrs, setAvailableAttrs] = useState<string[]>([]);
  const [slicerName, setSlicerName] = useState("");

  // Load data when dialog opens
  useEffect(() => {
    if (!isOpen || slicerId == null) return;

    const slicer = getSlicerById(slicerId);
    if (slicer) {
      setSlicerName(slicer.name);
    }

    (async () => {
      const [propsResult, attrs] = await Promise.all([
        getSlicerComputedProperties(slicerId),
        getSlicerAvailableAttributes(),
      ]);
      setProperties(propsResult.properties);
      setAvailableAttrs(attrs);
    })();
  }, [isOpen, slicerId]);

  const handleSlicerChanged = useCallback(async () => {
    // Refresh the frontend slicer cache so the overlay renders updated values
    await refreshCache();
    broadcastSelectedSlicers();
    requestOverlayRedraw();
  }, []);

  const handleAdd = useCallback(async () => {
    if (slicerId == null) return;

    // Find first unused attribute
    const usedAttrs = new Set(properties.map((p) => p.attribute));
    const firstUnused = availableAttrs.find((a) => !usedAttrs.has(a));
    if (!firstUnused) return;

    const result = await addSlicerComputedProperty(slicerId, firstUnused, "");
    setProperties(result.properties);
    if (result.slicerChanged) handleSlicerChanged();
  }, [slicerId, properties, availableAttrs, handleSlicerChanged]);

  const handleAttributeChange = useCallback(
    async (propId: number, newAttribute: string) => {
      const result = await updateSlicerComputedProperty(propId, newAttribute, undefined);
      setProperties(result.properties);
      if (result.slicerChanged) handleSlicerChanged();
    },
    [handleSlicerChanged],
  );

  const handleFormulaCommit = useCallback(
    async (propId: number, newFormula: string) => {
      const result = await updateSlicerComputedProperty(propId, undefined, newFormula);
      setProperties(result.properties);
      if (result.slicerChanged) handleSlicerChanged();
    },
    [handleSlicerChanged],
  );

  const handleRemove = useCallback(
    async (propId: number) => {
      const result = await removeSlicerComputedProperty(propId);
      setProperties(result.properties);
    },
    [],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
    }
  };

  if (!isOpen) return null;

  // Compute used attributes for the dropdown
  const usedAttrs = new Set(properties.map((p) => p.attribute));
  const canAdd = availableAttrs.some((a) => !usedAttrs.has(a));

  return (
    <div style={s.overlay} onClick={onClose}>
      <div
        style={s.dialog}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div style={s.header}>
          <h2 style={s.title}>
            Computed Properties
            <span style={s.subtitle}>{slicerName}</span>
          </h2>
          <button style={s.closeButton} onClick={onClose} aria-label="Close">
            x
          </button>
        </div>

        {/* Content */}
        <div style={s.content}>
          {properties.length > 0 && (
            <div style={s.gridHeader}>
              <span style={s.gridHeaderLabel}>Attribute</span>
              <span style={s.gridHeaderLabel}>Formula</span>
              <span style={s.gridHeaderLabel}>Value</span>
              <span />
            </div>
          )}

          {properties.length === 0 ? (
            <div style={s.emptyMessage}>
              No computed properties. Click &quot;+ Add Property&quot; to create one.
            </div>
          ) : (
            properties.map((prop) => (
              <PropertyRow
                key={prop.id}
                prop={prop}
                availableAttrs={availableAttrs}
                usedAttrs={usedAttrs}
                onAttributeChange={handleAttributeChange}
                onFormulaCommit={handleFormulaCommit}
                onRemove={handleRemove}
              />
            ))
          )}
        </div>

        {/* Footer */}
        <div style={s.footer}>
          <button
            style={{
              ...s.addButton,
              opacity: canAdd ? 1 : 0.4,
              pointerEvents: canAdd ? "auto" : "none",
            }}
            onClick={handleAdd}
            disabled={!canAdd}
          >
            + Add Property
          </button>
          <button style={s.closeBtn} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// PropertyRow Component
// ============================================================================

function PropertyRow({
  prop,
  availableAttrs,
  usedAttrs,
  onAttributeChange,
  onFormulaCommit,
  onRemove,
}: {
  prop: SlicerComputedPropertyData;
  availableAttrs: string[];
  usedAttrs: Set<string>;
  onAttributeChange: (propId: number, attr: string) => void;
  onFormulaCommit: (propId: number, formula: string) => void;
  onRemove: (propId: number) => void;
}) {
  const [formula, setFormula] = useState(prop.formula);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Sync formula when prop changes externally
  useEffect(() => {
    setFormula(prop.formula);
  }, [prop.formula]);

  const isDirty = formula !== prop.formula;

  const applyFormula = () => {
    if (isDirty) {
      onFormulaCommit(prop.id, formula);
    }
  };

  const cancelEdit = () => {
    setFormula(prop.formula);
  };

  const handleFormulaKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      applyFormula();
      // Don't blur — keep focus so user can continue editing
    } else if (e.key === "Escape") {
      cancelEdit();
    }
  };

  // For the attribute dropdown: show current + other unused
  const attrOptions = availableAttrs.filter(
    (a) => a === prop.attribute || !usedAttrs.has(a),
  );

  return (
    <div style={s.propertyRow}>
      <select
        style={s.select}
        value={prop.attribute}
        onChange={(e) => onAttributeChange(prop.id, e.target.value)}
      >
        {attrOptions.map((attr) => (
          <option key={attr} value={attr}>
            {attr}
          </option>
        ))}
      </select>
      <div style={s.formulaCell}>
        <input
          ref={inputRef}
          style={s.formulaInput}
          value={formula}
          onChange={(e) => setFormula(e.target.value)}
          onKeyDown={handleFormulaKeyDown}
          placeholder="Enter formula..."
          spellCheck={false}
        />
        {isDirty && (
          <>
            <button
              style={s.applyButton}
              onClick={applyFormula}
              title="Apply formula (Enter)"
            >
              {"\u2713"}
            </button>
            <button
              style={s.cancelButton}
              onClick={cancelEdit}
              title="Cancel edit (Escape)"
            >
              {"\u2717"}
            </button>
          </>
        )}
      </div>
      <span style={s.valueDisplay} title={prop.currentValue ?? ""}>
        {prop.currentValue ?? ""}
      </span>
      <button
        style={s.deleteButton}
        onClick={() => onRemove(prop.id)}
        title="Remove this computed property"
      >
        x
      </button>
    </div>
  );
}

export default SlicerComputedPropertiesDialog;
