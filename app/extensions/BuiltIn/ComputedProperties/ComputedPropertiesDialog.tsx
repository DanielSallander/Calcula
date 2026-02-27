//! FILENAME: app/extensions/BuiltIn/ComputedProperties/ComputedPropertiesDialog.tsx
// PURPOSE: Computed Properties dialog for managing formula-driven attributes.
// CONTEXT: Opened via right-click -> "Computed Properties..." on columns, rows, or cells.
//          Supports collapsed mode: when editing a formula, the dialog shrinks to a
//          narrow bar so the grid is interactive for cell-click reference insertion.

import React, { useEffect, useState, useCallback, useRef } from "react";
import type { DialogProps } from "../../../src/api/uiTypes";
import {
  getComputedProperties,
  getAvailableAttributes,
  addComputedProperty,
  updateComputedProperty,
  removeComputedProperty,
} from "../../../src/api/lib";
import type {
  ComputedPropertyData,
  ComputedPropertyResult,
} from "../../../src/api/lib";
import { columnToLetter } from "../../../src/api/types";
import { dispatchGridAction } from "../../../src/api/gridDispatch";
import { setColumnWidth, setRowHeight } from "../../../src/api/grid";
import { PropertyRow } from "./components/PropertyRow";
import { FormulaInput } from "./components/FormulaInput";

// ============================================================================
// Types
// ============================================================================

interface DialogData {
  targetType: "column" | "row" | "cell";
  index: number;
  index2?: number;
}

// ============================================================================
// Dialog Component
// ============================================================================

export function ComputedPropertiesDialog({
  isOpen,
  onClose,
  data,
}: DialogProps): React.ReactElement | null {
  const [properties, setProperties] = useState<ComputedPropertyData[]>([]);
  const [availableAttrs, setAvailableAttrs] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  // Collapsed mode state: which property is being edited
  const [editingPropId, setEditingPropId] = useState<number | null>(null);
  const [collapsedFormula, setCollapsedFormula] = useState("");
  const collapsedFormulaRef = useRef("");

  const dialogData = data as unknown as DialogData | undefined;
  const targetType = dialogData?.targetType ?? "cell";
  const index = dialogData?.index ?? 0;
  const index2 = dialogData?.index2;

  const isCollapsed = editingPropId !== null;

  // Build title
  const title = React.useMemo(() => {
    switch (targetType) {
      case "column":
        return `Computed Properties - Column ${columnToLetter(index)}`;
      case "row":
        return `Computed Properties - Row ${index + 1}`;
      case "cell":
        return `Computed Properties - Cell ${columnToLetter(index2 ?? 0)}${index + 1}`;
      default:
        return "Computed Properties";
    }
  }, [targetType, index, index2]);

  // Load existing properties + available attributes
  useEffect(() => {
    if (!isOpen) return;

    setLoading(true);
    setEditingPropId(null);
    Promise.all([
      getComputedProperties(targetType, index, index2),
      getAvailableAttributes(targetType),
    ])
      .then(([props, attrs]) => {
        setProperties(props);
        setAvailableAttrs(attrs);
      })
      .catch((err) => {
        console.error("[ComputedProperties] Failed to load:", err);
      })
      .finally(() => setLoading(false));
  }, [isOpen, targetType, index, index2]);

  // Apply backend result to grid state
  const applyResult = useCallback(
    (result: ComputedPropertyResult) => {
      setProperties(result.properties);

      for (const dim of result.dimensionChanges) {
        if (dim.dimensionType === "column") {
          dispatchGridAction(setColumnWidth(dim.index, dim.size || 100));
        } else {
          dispatchGridAction(setRowHeight(dim.index, dim.size || 24));
        }
      }

      if (result.needsStyleRefresh) {
        window.dispatchEvent(new CustomEvent("styles:refresh"));
      }
    },
    [],
  );

  // Add a new property
  const handleAdd = useCallback(async () => {
    const usedAttrs = new Set(properties.map((p) => p.attribute));
    const firstAvailable = availableAttrs.find((a) => !usedAttrs.has(a));
    if (!firstAvailable) return;

    try {
      const result = await addComputedProperty(
        targetType,
        index,
        index2 ?? null,
        firstAvailable,
        "",
      );
      applyResult(result);
    } catch (err) {
      console.error("[ComputedProperties] Failed to add:", err);
    }
  }, [targetType, index, index2, properties, availableAttrs, applyResult]);

  // Update an existing property
  const handleUpdate = useCallback(
    async (propId: number, attribute: string, formula: string) => {
      try {
        const result = await updateComputedProperty(propId, attribute, formula);
        applyResult(result);
      } catch (err) {
        console.error("[ComputedProperties] Failed to update:", err);
      }
    },
    [applyResult],
  );

  // Remove a property
  const handleRemove = useCallback(
    async (propId: number) => {
      try {
        const result = await removeComputedProperty(propId);
        applyResult(result);
      } catch (err) {
        console.error("[ComputedProperties] Failed to remove:", err);
      }
    },
    [applyResult],
  );

  // Enter/exit collapsed mode when a formula input gains/loses focus
  const handleFormulaFocusChange = useCallback(
    (propId: number, focused: boolean) => {
      if (focused) {
        const prop = properties.find((p) => p.id === propId);
        if (prop) {
          setEditingPropId(propId);
          setCollapsedFormula(prop.formula);
          collapsedFormulaRef.current = prop.formula;
        }
      } else {
        setEditingPropId(null);
      }
    },
    [properties],
  );

  // Collapsed mode: commit formula
  const handleCollapsedCommit = useCallback(() => {
    if (editingPropId === null) return;
    const prop = properties.find((p) => p.id === editingPropId);
    if (prop && collapsedFormulaRef.current !== prop.formula) {
      handleUpdate(editingPropId, prop.attribute, collapsedFormulaRef.current);
    }
    setEditingPropId(null);
  }, [editingPropId, properties, handleUpdate]);

  // Collapsed mode: cancel formula edit
  const handleCollapsedCancel = useCallback(() => {
    setEditingPropId(null);
  }, []);

  // Keep ref in sync
  const handleCollapsedFormulaChange = useCallback((val: string) => {
    setCollapsedFormula(val);
    collapsedFormulaRef.current = val;
  }, []);

  if (!isOpen) return null;

  const usedAttrs = new Set(properties.map((p) => p.attribute));
  const canAdd = availableAttrs.some((a) => !usedAttrs.has(a));
  const editingProp = editingPropId !== null
    ? properties.find((p) => p.id === editingPropId)
    : null;

  // =========================================================================
  // COLLAPSED MODE: Narrow bar at top, grid is interactive
  // =========================================================================
  if (isCollapsed && editingProp) {
    return (
      <div
        data-computed-props-dialog
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          zIndex: 10000,
          backgroundColor: "var(--bg-primary, #fff)",
          borderBottom: "2px solid var(--accent-color, #0078d4)",
          boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
          padding: "6px 12px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 13,
          color: "var(--text-primary, #1a1a1a)",
        }}
      >
        {/* Target label */}
        <span
          style={{
            fontWeight: 600,
            fontSize: 12,
            color: "var(--text-secondary, #666)",
            whiteSpace: "nowrap",
          }}
        >
          {title}
        </span>

        <span
          style={{
            fontSize: 12,
            color: "var(--text-secondary, #888)",
            whiteSpace: "nowrap",
          }}
        >
          {editingProp.attribute}:
        </span>

        {/* Formula input */}
        <div style={{ flex: 1, minWidth: 200 }}>
          <FormulaInput
            value={collapsedFormula}
            onChange={handleCollapsedFormulaChange}
            onCommit={handleCollapsedCommit}
            onCancel={handleCollapsedCancel}
            autoFocus
            cellClickEnabled
            commitOnBlur={false}
          />
        </div>

        {/* OK / Cancel buttons */}
        <button
          onClick={handleCollapsedCommit}
          style={{
            padding: "3px 12px",
            fontSize: 12,
            border: "1px solid var(--accent-color, #0078d4)",
            borderRadius: 3,
            backgroundColor: "var(--accent-color, #0078d4)",
            color: "#fff",
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          OK
        </button>
        <button
          onClick={handleCollapsedCancel}
          style={{
            padding: "3px 12px",
            fontSize: 12,
            border: "1px solid var(--border-color, #ccc)",
            borderRadius: 3,
            backgroundColor: "var(--bg-primary, #fff)",
            color: "var(--text-primary, #333)",
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          Cancel
        </button>
      </div>
    );
  }

  // =========================================================================
  // NORMAL MODE: Full dialog centered with backdrop
  // =========================================================================
  return (
    <div
      data-computed-props-dialog
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 10000,
      }}
    >
      {/* Backdrop */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundColor: "rgba(0, 0, 0, 0.3)",
        }}
        onClick={onClose}
      />

      {/* Dialog */}
      <div
        style={{
          position: "relative",
          backgroundColor: "var(--bg-primary, #fff)",
          border: "1px solid var(--border-color, #d0d0d0)",
          borderRadius: 6,
          boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
          width: 560,
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          color: "var(--text-primary, #1a1a1a)",
          fontSize: 13,
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 16px",
            borderBottom: "1px solid var(--border-color, #e0e0e0)",
          }}
        >
          <span style={{ fontWeight: 600, fontSize: 14 }}>{title}</span>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              fontSize: 18,
              color: "var(--text-secondary, #666)",
              padding: "0 4px",
              lineHeight: 1,
            }}
            title="Close"
          >
            &times;
          </button>
        </div>

        {/* Body */}
        <div
          style={{
            padding: "12px 16px",
            overflowY: "auto",
            flex: 1,
          }}
        >
          {loading ? (
            <div style={{ textAlign: "center", padding: 20, color: "#888" }}>
              Loading...
            </div>
          ) : (
            <>
              {/* Column headers */}
              {properties.length > 0 && (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "140px 1fr 80px 28px",
                    gap: 8,
                    marginBottom: 4,
                    fontSize: 11,
                    color: "var(--text-secondary, #888)",
                    fontWeight: 500,
                  }}
                >
                  <span>Attribute</span>
                  <span>Formula</span>
                  <span>Value</span>
                  <span />
                </div>
              )}

              {/* Property rows */}
              {properties.map((prop) => (
                <PropertyRow
                  key={prop.id}
                  property={prop}
                  availableAttributes={availableAttrs}
                  usedAttributes={usedAttrs}
                  onUpdate={handleUpdate}
                  onRemove={handleRemove}
                  onFormulaFocusChange={handleFormulaFocusChange}
                />
              ))}

              {/* Empty state */}
              {properties.length === 0 && (
                <div
                  style={{
                    textAlign: "center",
                    padding: "24px 16px",
                    color: "var(--text-secondary, #888)",
                  }}
                >
                  No computed properties.
                  <br />
                  Click "Add Property" to create one.
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "10px 16px",
            borderTop: "1px solid var(--border-color, #e0e0e0)",
          }}
        >
          <button
            onClick={handleAdd}
            disabled={!canAdd}
            style={{
              padding: "5px 14px",
              fontSize: 13,
              border: "1px solid var(--border-color, #ccc)",
              borderRadius: 4,
              backgroundColor: canAdd ? "var(--bg-primary, #fff)" : "#f5f5f5",
              color: canAdd ? "var(--text-primary, #333)" : "#aaa",
              cursor: canAdd ? "pointer" : "default",
            }}
          >
            + Add Property
          </button>

          <button
            onClick={onClose}
            style={{
              padding: "5px 20px",
              fontSize: 13,
              border: "1px solid var(--border-color, #ccc)",
              borderRadius: 4,
              backgroundColor: "var(--bg-primary, #fff)",
              color: "var(--text-primary, #333)",
              cursor: "pointer",
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
