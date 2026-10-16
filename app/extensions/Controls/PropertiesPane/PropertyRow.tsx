//! FILENAME: app/extensions/Controls/PropertiesPane/PropertyRow.tsx
// PURPOSE: A single property editor row in the Properties Pane.
// CONTEXT: A row edits the property's LITERAL, always as static text: since
//          D-BIND (WP-D S8a) a property that follows a formula is a BINDING
//          (`@api/objectBindings`), not a formula-typed value, and the backend
//          refuses `valueType: "formula"` for every non-code key. A row whose
//          property the catalog lets you bind (`supportsFormula`, or already
//          bound by a script or the AI) is wrapped in the shared
//          `BindableField`: its fx switch writes the binding, the literal
//          editor below it stays the literal's one door.
//
//          Typing `=...` into a LITERAL editor stores that text. The "'"
//          escape stays for display parity with Excel only: a stored "=x"
//          shows as "'=x", and committing that display stores "=x".

import React, { useState, useEffect, useCallback } from "react";
import type { ControlPropertyValue, PropertyDefinition } from "../lib/types";
import { CodePropertyInput } from "./CodePropertyInput";
import { ToggleSwitch } from "./ToggleSwitch";
import { SliderInput } from "./SliderInput";
import {
  describeDistributedScriptChoice,
  scriptEntryApplication,
  scriptPickerLabel,
  type ScriptPickerEntry,
} from "../../_shared/lib/scriptModuleProvenance";
import { BindableField } from "../../_shared/components/bindings";
import { getBinding, isBindablePath, type ObjectBindingRef } from "@api/objectBindings";
import { controlPropertyPointer } from "../lib/controlBindings";

// ============================================================================
// Styles (theme-aware via CSS variables)
// ============================================================================

const v = (token: string) => `var(${token})`;

const rowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  padding: "5px 12px",
  gap: 3,
  transition: "background-color 0.1s",
};

const rowHoverStyle: React.CSSProperties = {
  backgroundColor: v("--panel-bg"),
};

const labelRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  fontSize: 11,
  color: v("--text-secondary"),
};

const labelStyle: React.CSSProperties = {
  fontWeight: 600,
  fontSize: 11,
  color: v("--text-secondary"),
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "4px 7px",
  border: `1px solid ${v("--border-default")}`,
  borderRadius: 3,
  fontSize: 12,
  fontFamily: v("--font-family-sans"),
  outline: "none",
  boxSizing: "border-box",
  backgroundColor: v("--bg-surface"),
  color: v("--text-primary"),
  transition: "border-color 0.15s, box-shadow 0.15s",
};

const inputFocusStyle: React.CSSProperties = {
  borderColor: v("--accent-color"),
  boxShadow: `0 0 0 1px ${v("--accent-color")}`,
};

const colorInputContainerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
};

const colorSwatchStyle: React.CSSProperties = {
  width: 24,
  height: 24,
  border: `1px solid ${v("--border-default")}`,
  borderRadius: 4,
  cursor: "pointer",
  flexShrink: 0,
  padding: 0,
};

const hintStyle: React.CSSProperties = {
  fontSize: 10,
  lineHeight: 1.35,
  color: v("--text-secondary"),
};

const scriptSelectStyle: React.CSSProperties = {
  ...inputStyle,
  cursor: "pointer",
};

const provenanceNoteStyle: React.CSSProperties = {
  ...hintStyle,
  color: "#5a4a00",
  background: "#fff8dc",
  border: "1px solid #e6d78a",
  borderRadius: 3,
  padding: "4px 6px",
  marginTop: 3,
};

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build the display value from stored property data.
 * If the stored value is static but starts with "=", prefix with "'" so
 * the user sees the escape character (mirroring Excel behaviour).
 */
function toDisplayValue(val: ControlPropertyValue | undefined, defaultValue: string): string {
  const v = val?.value ?? defaultValue;
  if (val?.valueType === "static" && v.startsWith("=")) {
    return "'" + v;
  }
  return v;
}

/**
 * The STATIC value to store for the user's display input. Always text: a
 * leading "'" is the display escape and is dropped; `=...` is stored as typed
 * (a formula is a binding now, written through the row's fx switch).
 * Exported for the unit tier.
 */
export function fromDisplayValue(displayValue: string): string {
  return displayValue.startsWith("'") ? displayValue.slice(1) : displayValue;
}

/**
 * Would committing `displayValue` change nothing? True when it is exactly what
 * the row already shows for the stored value (or for its default, when nothing
 * is stored), or when it would store exactly the static value already there.
 * Exported for the unit tier.
 */
export function isUnchangedCommit(
  displayValue: string,
  stored: ControlPropertyValue | undefined,
  defaultValue: string,
): boolean {
  if (displayValue === toDisplayValue(stored, defaultValue)) return true;
  const next = fromDisplayValue(displayValue);
  return stored ? stored.valueType === "static" && stored.value === next : next === defaultValue;
}

/**
 * Does this row offer the fx switch? Only for a control the backend has given
 * a uid, never for a read-only (handle-valued) row, only for a key the
 * bindable-path catalog accepts -- and then when the row supports formulas, or
 * when the property is ALREADY bound (a script or the AI may bind a property
 * whose row does not offer fx; the pane must show that binding, not hide it).
 */
export function rowOffersBinding(definition: PropertyDefinition, bindingRef: ObjectBindingRef | null | undefined): boolean {
  if (!bindingRef || definition.readOnly) return false;
  const pointer = controlPropertyPointer(definition.key);
  if (!isBindablePath("control", pointer)) return false;
  return definition.supportsFormula || getBinding(bindingRef, pointer) !== null;
}

// ============================================================================
// Props
// ============================================================================

interface PropertyRowProps {
  definition: PropertyDefinition;
  value: ControlPropertyValue | undefined;
  /** Every module the workbook lists, WITH its `sourcePackage` stamp. */
  scripts: ScriptPickerEntry[];
  /** Write the property's LITERAL (always stored as static text). */
  onChange: (key: string, value: string) => void;
  /**
   * The control's binding ref (`{ kind: "control", id: uid }`, the uid read
   * from the BACKEND's metadata), or null when it has none yet: the row then
   * offers no fx switch.
   */
  bindingRef?: ObjectBindingRef | null;
}

// ============================================================================
// Component
// ============================================================================

export const PropertyRow: React.FC<PropertyRowProps> = ({
  definition,
  value,
  scripts,
  onChange,
  bindingRef = null,
}) => {
  const displayValue = toDisplayValue(value, definition.defaultValue);
  const [localValue, setLocalValue] = useState(displayValue);
  const [hovered, setHovered] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);

  // Sync local state when external value changes
  useEffect(() => {
    setLocalValue(toDisplayValue(value, definition.defaultValue));
  }, [value, definition.defaultValue]);

  // Commit the literal (static text; the "'" display escape dropped).
  //
  // AN UNCHANGED VALUE IS NOT A WRITE (BUG-0257). The code field commits on
  // blur, so tabbing THROUGH a row wrote it back -- and on a working copy's
  // button whose code is held for publishing, the empty OnSelect field wrote
  // "" over nothing, an author edit that replaced the application's code with
  // none. The backend refuses that one too; this keeps every row's focus/blur
  // from writing (and dirtying the document) when the author changed nothing.
  const handleCommit = useCallback(
    (newValue: string) => {
      if (isUnchangedCommit(newValue, value, definition.defaultValue)) return;
      onChange(definition.key, fromDisplayValue(newValue));
    },
    [onChange, value, definition.key, definition.defaultValue],
  );

  // Plain input handlers
  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      setLocalValue(e.target.value);
    },
    [],
  );

  const handleInputBlur = useCallback(() => {
    setInputFocused(false);
    handleCommit(localValue);
  }, [localValue, handleCommit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        handleCommit(localValue);
      }
    },
    [localValue, handleCommit],
  );

  // A fixed menu of choices (definition.options). A choice is committed the
  // moment it is picked, through the same unchanged-is-not-a-write rule.
  const renderSelect = () => (
    <select
      style={scriptSelectStyle}
      value={localValue}
      data-control-prop-select={definition.key}
      onChange={(e) => {
        const newVal = e.target.value;
        setLocalValue(newVal);
        handleCommit(newVal);
      }}
    >
      {(definition.options ?? []).map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );

  // ---------------------------------------------------------------
  // Render the appropriate input widget
  // ---------------------------------------------------------------
  const renderInput = () => {
    // Handle-valued properties are DISPLAYED, never edited here. The value is
    // still selectable so it can be copied — read-only is about who may WRITE
    // it, not about hiding it.
    if (definition.readOnly) {
      return (
        <input
          type="text"
          readOnly
          spellCheck={false}
          title={definition.readOnlyHint ?? "This value is set by the application."}
          style={{ ...inputStyle, color: v("--text-secondary"), cursor: "default" }}
          value={localValue}
          onFocus={(e) => e.currentTarget.select()}
        />
      );
    }

    // The LITERAL editor, by input type.
    switch (definition.inputType) {
      case "color":
        return (
          <div style={colorInputContainerStyle}>
            <input
              type="color"
              style={colorSwatchStyle}
              value={localValue || "#000000"}
              onChange={(e) => {
                setLocalValue(e.target.value);
                handleCommit(e.target.value);
              }}
            />
            <input
              type="text"
              style={{
                ...inputStyle,
                flex: 1,
                ...(inputFocused ? inputFocusStyle : {}),
              }}
              value={localValue}
              onChange={handleInputChange}
              onBlur={handleInputBlur}
              onFocus={() => setInputFocused(true)}
              onKeyDown={handleKeyDown}
              placeholder="#000000"
            />
          </div>
        );

      case "number":
        // Use slider when min/max are defined
        if (definition.min !== undefined && definition.max !== undefined) {
          return (
            <SliderInput
              value={parseFloat(localValue) || 0}
              min={definition.min}
              max={definition.max}
              step={definition.step ?? 1}
              onChange={(v) => setLocalValue(String(v))}
              onCommit={(v) => {
                const s = String(v);
                setLocalValue(s);
                handleCommit(s);
              }}
            />
          );
        }
        return (
          <input
            type="number"
            style={{
              ...inputStyle,
              ...(inputFocused ? inputFocusStyle : {}),
            }}
            value={localValue}
            onChange={handleInputChange}
            onBlur={handleInputBlur}
            onFocus={() => setInputFocused(true)}
            onKeyDown={handleKeyDown}
          />
        );

      case "select":
        return renderSelect();

      case "boolean":
        return (
          <ToggleSwitch
            checked={localValue === "true"}
            onChange={(checked) => {
              const newVal = checked ? "true" : "false";
              setLocalValue(newVal);
              onChange(definition.key, newVal);
            }}
            label={localValue === "true" ? "Yes" : "No"}
          />
        );

      case "code":
        return (
          <CodePropertyInput
            value={localValue}
            onChange={(newVal) => setLocalValue(newVal)}
            onCommit={(newVal) => {
              setLocalValue(newVal);
              handleCommit(newVal);
            }}
            scripts={scripts}
          />
        );

      case "script": {
        // The chosen module's provenance, from the LISTED row's stamp: a
        // publisher's module is named as such before the control is bound to it.
        const chosen = scripts.find((s) => s.id === localValue) ?? null;
        const provenanceNote = chosen ? describeDistributedScriptChoice(chosen) : null;
        return (
          <>
            <select
              style={scriptSelectStyle}
              value={localValue}
              data-control-script-select={definition.key}
              onChange={(e) => {
                const newVal = e.target.value;
                setLocalValue(newVal);
                onChange(definition.key, newVal);
              }}
            >
              <option value="">(None)</option>
              {scripts.map((s) => (
                <option key={s.id} value={s.id}>
                  {scriptPickerLabel(s)}
                </option>
              ))}
            </select>
            {provenanceNote && chosen ? (
              <span
                style={provenanceNoteStyle}
                data-control-script-provenance={scriptEntryApplication(chosen) ?? ""}
              >
                {provenanceNote}
              </span>
            ) : null}
          </>
        );
      }

      default:
        return (
          <input
            type="text"
            style={{
              ...inputStyle,
              ...(inputFocused ? inputFocusStyle : {}),
            }}
            value={localValue}
            onChange={handleInputChange}
            onBlur={handleInputBlur}
            onFocus={() => setInputFocused(true)}
            onKeyDown={handleKeyDown}
          />
        );
    }
  };

  return (
    <div
      data-testid={"control-prop-" + definition.key}
      style={{ ...rowStyle, ...(hovered ? rowHoverStyle : {}) }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={labelRowStyle}>
        <span style={labelStyle}>{definition.label}</span>
      </div>
      {bindingRef && rowOffersBinding(definition, bindingRef) ? (
        <BindableField
          object={bindingRef}
          path={controlPropertyPointer(definition.key)}
          label={definition.label}
          literal={renderInput()}
        />
      ) : (
        renderInput()
      )}
      {definition.readOnly && definition.readOnlyHint ? (
        <span style={hintStyle}>{definition.readOnlyHint}</span>
      ) : null}
    </div>
  );
};
