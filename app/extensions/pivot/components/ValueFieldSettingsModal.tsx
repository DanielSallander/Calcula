//! FILENAME: app/extensions/pivot/components/ValueFieldSettingsModal.tsx
// PURPOSE: Modal dialog for configuring value field settings
// CONTEXT: Allows changing aggregation type, custom name, and show values as

import React, { useState, useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { css } from "@emotion/css";
import {
  type AggregationType,
  type ShowValuesAs,
  type ZoneField,
  AGGREGATION_OPTIONS,
  getValueFieldDisplayName,
} from "./types";
import { NumberFormatModal } from "../../_shared/components/NumberFormatModal";

export interface ValueFieldSettings {
  customName: string;
  aggregation: AggregationType;
  showValuesAs: ShowValuesAs;
  numberFormat?: string;
}

export interface ValueFieldSettingsModalProps {
  isOpen: boolean;
  field: ZoneField;
  onSave: (settings: ValueFieldSettings) => void;
  onCancel: () => void;
}

const SHOW_VALUES_AS_OPTIONS: { value: ShowValuesAs; label: string }[] = [
  { value: "normal", label: "No Calculation" },
  { value: "percent_of_total", label: "% of Grand Total" },
  { value: "percent_of_row", label: "% of Row Total" },
  { value: "percent_of_column", label: "% of Column Total" },
  { value: "percent_of_parent_row", label: "% of Parent Row Total" },
  { value: "percent_of_parent_column", label: "% of Parent Column Total" },
  { value: "difference", label: "Difference From" },
  { value: "percent_difference", label: "% Difference From" },
  { value: "running_total", label: "Running Total In" },
  { value: "index", label: "Index" },
];

const modalStyles = {
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
    min-width: 380px;
    max-width: 480px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
      sans-serif;
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
  content: css`
    padding: 20px;
  `,
  field: css`
    margin-bottom: 16px;
  `,
  label: css`
    display: block;
    font-weight: 500;
    color: #555;
    margin-bottom: 6px;
    font-size: 12px;
  `,
  input: css`
    width: 100%;
    padding: 8px 12px;
    border: 1px solid #d0d0d0;
    border-radius: 4px;
    font-size: 13px;
    box-sizing: border-box;

    &:focus {
      outline: none;
      border-color: #0078d4;
      box-shadow: 0 0 0 2px rgba(0, 120, 212, 0.2);
    }
  `,
  select: css`
    width: 100%;
    padding: 8px 12px;
    border: 1px solid #d0d0d0;
    border-radius: 4px;
    font-size: 13px;
    background: #fff;
    cursor: pointer;
    box-sizing: border-box;

    &:focus {
      outline: none;
      border-color: #0078d4;
    }
  `,
  footer: css`
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 16px 20px;
    border-top: 1px solid #e0e0e0;
    background: #f9f9f9;
    border-radius: 0 0 8px 8px;
  `,
  button: css`
    padding: 8px 16px;
    border-radius: 4px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
  `,
  cancelButton: css`
    background: #fff;
    border: 1px solid #d0d0d0;
    color: #333;

    &:hover {
      background: #f5f5f5;
    }
  `,
  saveButton: css`
    background: #0078d4;
    border: 1px solid #0078d4;
    color: #fff;

    &:hover {
      background: #106ebe;
    }
  `,
  sourceInfo: css`
    color: #888;
    font-size: 11px;
    margin-top: 4px;
  `,
  formatButton: css`
    padding: 8px 12px;
    border: 1px solid #d0d0d0;
    border-radius: 4px;
    font-size: 13px;
    background: #fff;
    cursor: pointer;
    transition: all 0.15s;
    width: 100%;
    text-align: left;

    &:hover {
      background: #f5f5f5;
      border-color: #b0b0b0;
    }

    &:focus {
      outline: none;
      border-color: #0078d4;
    }
  `,
  formatDisplay: css`
    color: #888;
    font-size: 11px;
    margin-top: 4px;
    font-family: "SF Mono", Consolas, monospace;
  `,
};

export function ValueFieldSettingsModal({
  isOpen,
  field,
  onSave,
  onCancel,
}: ValueFieldSettingsModalProps): React.ReactElement | null {
  const modalRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const defaultName = getValueFieldDisplayName(
    field.name,
    field.aggregation || "sum"
  );

  const [customName, setCustomName] = useState(defaultName);
  const [aggregation, setAggregation] = useState<AggregationType>(
    field.aggregation || "sum"
  );
  const [showValuesAs, setShowValuesAs] = useState<ShowValuesAs>("normal");
  const [numberFormat, setNumberFormat] = useState<string>(field.numberFormat || "");
  const [isNumberFormatOpen, setIsNumberFormatOpen] = useState(false);

  // Reset local state when the modal opens or when the field changes.
  // Uses render-time derived state pattern (prev-prop comparison) instead of
  // useEffect to avoid the react-hooks/set-state-in-effect lint error.
  const [prevIsOpen, setPrevIsOpen] = React.useState(isOpen);
  const [prevFieldKey, setPrevFieldKey] = React.useState(`${field.sourceIndex}-${field.aggregation}`);

  const fieldKey = `${field.sourceIndex}-${field.aggregation}`;
  if (isOpen && (!prevIsOpen || fieldKey !== prevFieldKey)) {
    const name = getValueFieldDisplayName(
      field.name,
      field.aggregation || "sum"
    );
    setCustomName(name);
    setAggregation(field.aggregation || "sum");
    setShowValuesAs("normal");
    setNumberFormat(field.numberFormat || "");
    setPrevIsOpen(isOpen);
    setPrevFieldKey(fieldKey);
  } else if (!isOpen && prevIsOpen) {
    setPrevIsOpen(false);
  }

  // Focus input when modal opens
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.select(), 50);
    }
  }, [isOpen]);

  // Track previous aggregation to update the custom name when aggregation changes.
  // Uses render-time derived state pattern instead of useEffect.
  const [prevAggregation, setPrevAggregation] = React.useState(aggregation);
  if (aggregation !== prevAggregation) {
    const newDefaultName = getValueFieldDisplayName(field.name, aggregation);
    // Only update if the name matches the auto-generated pattern
    if (customName.includes(" of " + field.name)) {
      setCustomName(newDefaultName);
    }
    setPrevAggregation(aggregation);
  }

  const handleOpenNumberFormat = useCallback(() => {
    setIsNumberFormatOpen(true);
  }, []);

  const handleSaveNumberFormat = useCallback((format: string) => {
    setNumberFormat(format);
    setIsNumberFormatOpen(false);
  }, []);

  const handleCancelNumberFormat = useCallback(() => {
    setIsNumberFormatOpen(false);
  }, []);

  const handleSave = useCallback(() => {
    onSave({
      customName,
      aggregation,
      showValuesAs,
      numberFormat,
    });
  }, [customName, aggregation, showValuesAs, numberFormat, onSave]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Escape") {
        onCancel();
      } else if (event.key === "Enter" && !event.shiftKey) {
        handleSave();
      }
    },
    [onCancel, handleSave]
  );

  if (!isOpen) return null;

  return createPortal(
    <div className={modalStyles.overlay} onClick={onCancel}>
      <div
        ref={modalRef}
        className={modalStyles.modal}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className={modalStyles.header}>
          <h2 className={modalStyles.title}>Value Field Settings</h2>
          <button className={modalStyles.closeButton} onClick={onCancel}>
            &times;
          </button>
        </div>

        <div className={modalStyles.content}>
          <div className={modalStyles.field}>
            <label className={modalStyles.label}>Source Name</label>
            <div className={modalStyles.sourceInfo}>{field.name}</div>
          </div>

          <div className={modalStyles.field}>
            <label className={modalStyles.label}>Custom Name</label>
            <input
              ref={inputRef}
              type="text"
              className={modalStyles.input}
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              placeholder={defaultName}
            />
          </div>

          <div className={modalStyles.field}>
            <label className={modalStyles.label}>Summarize value field by</label>
            <select
              className={modalStyles.select}
              value={aggregation}
              onChange={(e) =>
                setAggregation(e.target.value as AggregationType)
              }
            >
              {AGGREGATION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className={modalStyles.field}>
            <label className={modalStyles.label}>Show Values As</label>
            <select
              className={modalStyles.select}
              value={showValuesAs}
              onChange={(e) => setShowValuesAs(e.target.value as ShowValuesAs)}
            >
              {SHOW_VALUES_AS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className={modalStyles.field}>
            <label className={modalStyles.label}>Number Format</label>
            {numberFormat && (
              <div className={modalStyles.formatDisplay}>
                Current: {numberFormat || "General"}
              </div>
            )}
            <button
              type="button"
              className={modalStyles.formatButton}
              onClick={handleOpenNumberFormat}
            >
              Number Format...
            </button>
          </div>
        </div>

        <div className={modalStyles.footer}>
          <button
            className={`${modalStyles.button} ${modalStyles.cancelButton}`}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className={`${modalStyles.button} ${modalStyles.saveButton}`}
            onClick={handleSave}
          >
            OK
          </button>
        </div>
      </div>

      {/* Number Format Modal (nested) */}
      <NumberFormatModal
        isOpen={isNumberFormatOpen}
        currentFormat={numberFormat}
        onSave={handleSaveNumberFormat}
        onCancel={handleCancelNumberFormat}
      />
    </div>,
    document.body
  );
}
