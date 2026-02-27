//! FILENAME: app/extensions/BuiltIn/ComputedProperties/components/PropertyRow.tsx
// PURPOSE: A single row in the Computed Properties dialog.
// CONTEXT: Shows attribute dropdown + formula input + current value + delete button.

import React, { useState, useCallback } from "react";
import type { ComputedPropertyData } from "../../../../src/api/lib";
import { FormulaInput } from "./FormulaInput";

interface PropertyRowProps {
  property: ComputedPropertyData;
  availableAttributes: string[];
  usedAttributes: Set<string>;
  onUpdate: (propId: number, attribute: string, formula: string) => void;
  onRemove: (propId: number) => void;
  onFormulaFocusChange?: (propId: number, focused: boolean) => void;
}

export function PropertyRow({
  property,
  availableAttributes,
  usedAttributes,
  onUpdate,
  onRemove,
  onFormulaFocusChange,
}: PropertyRowProps): React.ReactElement {
  const [formula, setFormula] = useState(property.formula);
  const [pendingAttribute, setPendingAttribute] = useState<string | null>(null);

  const handleAttributeChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const newAttr = e.target.value;
      setPendingAttribute(newAttr);
      onUpdate(property.id, newAttr, property.formula);
    },
    [property.id, property.formula, onUpdate],
  );

  // Sync local formula when property changes from backend
  React.useEffect(() => {
    setFormula(property.formula);
  }, [property.formula]);

  // Sync attribute when property changes from backend
  React.useEffect(() => {
    setPendingAttribute(null);
  }, [property.attribute]);

  const handleFormulaCommit = useCallback(() => {
    if (formula !== property.formula) {
      onUpdate(property.id, property.attribute, formula);
    }
  }, [property.id, property.attribute, property.formula, formula, onUpdate]);

  const handleFormulaCancel = useCallback(() => {
    setFormula(property.formula);
  }, [property.formula]);

  const handleFocusChange = useCallback(
    (focused: boolean) => {
      onFormulaFocusChange?.(property.id, focused);
    },
    [property.id, onFormulaFocusChange],
  );

  // Attribute options: show current attribute + any unused ones
  const currentAttr = pendingAttribute ?? property.attribute;
  const attrOptions = availableAttributes.filter(
    (a) => a === currentAttr || !usedAttributes.has(a),
  );

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "140px 1fr 80px 28px",
        gap: 8,
        alignItems: "center",
        marginBottom: 6,
      }}
    >
      {/* Attribute dropdown */}
      <select
        value={currentAttr}
        onChange={handleAttributeChange}
        style={{
          padding: "4px 6px",
          fontSize: 12,
          border: "1px solid var(--border-color, #ccc)",
          borderRadius: 3,
          backgroundColor: "var(--bg-primary, #fff)",
          color: "var(--text-primary, #333)",
        }}
      >
        {attrOptions.map((attr) => (
          <option key={attr} value={attr}>
            {attr}
          </option>
        ))}
      </select>

      {/* Formula input with cell-click + autocomplete support */}
      <FormulaInput
        value={formula}
        onChange={setFormula}
        onCommit={handleFormulaCommit}
        onCancel={handleFormulaCancel}
        onFocusChange={handleFocusChange}
      />

      {/* Current value display */}
      <span
        style={{
          fontSize: 11,
          color: "var(--text-secondary, #888)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={property.currentValue ?? ""}
      >
        {property.currentValue ?? ""}
      </span>

      {/* Delete button */}
      <button
        onClick={() => onRemove(property.id)}
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          fontSize: 16,
          color: "var(--text-secondary, #999)",
          padding: 0,
          lineHeight: 1,
          width: 24,
          height: 24,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 3,
        }}
        title="Remove property"
      >
        &times;
      </button>
    </div>
  );
}
