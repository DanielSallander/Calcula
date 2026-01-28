//! FILENAME: app/src/core/components/pivot/NumberFormatModal.tsx
// PURPOSE: Modal dialog for selecting number format for value fields
// CONTEXT: Provides preset formats for currency, percentage, and general numbers

import React, { useState, useCallback, useEffect, useRef } from "react";
import { css } from "@emotion/css";

export interface NumberFormatOption {
  value: string;
  label: string;
  example: string;
}

export const NUMBER_FORMAT_PRESETS: NumberFormatOption[] = [
  { value: "", label: "General", example: "1234.5" },
  { value: "0", label: "Number (no decimals)", example: "1235" },
  { value: "0.00", label: "Number (2 decimals)", example: "1234.50" },
  { value: "#,##0", label: "Number with 1000 separator", example: "1,235" },
  { value: "#,##0.00", label: "Number with 1000 separator (2 decimals)", example: "1,234.50" },
  { value: "$#,##0.00", label: "Currency (USD)", example: "$1,234.50" },
  { value: "[$EUR] #,##0.00", label: "Currency (EUR)", example: "EUR 1,234.50" },
  { value: "[$SEK] #,##0.00", label: "Currency (SEK)", example: "SEK 1,234.50" },
  { value: "0%", label: "Percentage (no decimals)", example: "12%" },
  { value: "0.00%", label: "Percentage (2 decimals)", example: "12.35%" },
  { value: "0.0%", label: "Percentage (1 decimal)", example: "12.3%" },
];

export interface NumberFormatModalProps {
  isOpen: boolean;
  currentFormat: string;
  onSave: (format: string) => void;
  onCancel: () => void;
}

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
    min-width: 340px;
    max-width: 420px;
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
    padding: 12px 0;
    max-height: 400px;
    overflow-y: auto;
  `,
  formatItem: css`
    display: flex;
    align-items: center;
    padding: 10px 20px;
    cursor: pointer;
    transition: background 0.15s;

    &:hover {
      background: #f5f5f5;
    }

    &.selected {
      background: #e8f4fc;
    }
  `,
  radio: css`
    margin-right: 12px;
    accent-color: #0078d4;
  `,
  formatInfo: css`
    flex: 1;
  `,
  formatLabel: css`
    color: #333;
    font-size: 13px;
    margin-bottom: 2px;
  `,
  formatExample: css`
    color: #888;
    font-size: 11px;
    font-family: "SF Mono", Consolas, monospace;
  `,
  customSection: css`
    padding: 12px 20px;
    border-top: 1px solid #e0e0e0;
    margin-top: 8px;
  `,
  customLabel: css`
    display: block;
    font-weight: 500;
    color: #555;
    margin-bottom: 6px;
    font-size: 12px;
  `,
  customInput: css`
    width: 100%;
    padding: 8px 12px;
    border: 1px solid #d0d0d0;
    border-radius: 4px;
    font-size: 13px;
    font-family: "SF Mono", Consolas, monospace;
    box-sizing: border-box;

    &:focus {
      outline: none;
      border-color: #0078d4;
      box-shadow: 0 0 0 2px rgba(0, 120, 212, 0.2);
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
};

export function NumberFormatModal({
  isOpen,
  currentFormat,
  onSave,
  onCancel,
}: NumberFormatModalProps): React.ReactElement | null {
  const modalRef = useRef<HTMLDivElement>(null);
  const [selectedFormat, setSelectedFormat] = useState(currentFormat);
  const [customFormat, setCustomFormat] = useState("");
  const [isCustom, setIsCustom] = useState(false);

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      const preset = NUMBER_FORMAT_PRESETS.find((p) => p.value === currentFormat);
      if (preset) {
        setSelectedFormat(currentFormat);
        setIsCustom(false);
        setCustomFormat("");
      } else if (currentFormat) {
        setIsCustom(true);
        setCustomFormat(currentFormat);
        setSelectedFormat("");
      } else {
        setSelectedFormat("");
        setIsCustom(false);
        setCustomFormat("");
      }
    }
  }, [isOpen, currentFormat]);

  const handlePresetSelect = useCallback((format: string) => {
    setSelectedFormat(format);
    setIsCustom(false);
  }, []);

  const handleCustomChange = useCallback((value: string) => {
    setCustomFormat(value);
    setIsCustom(true);
    setSelectedFormat("");
  }, []);

  const handleSave = useCallback(() => {
    onSave(isCustom ? customFormat : selectedFormat);
  }, [isCustom, customFormat, selectedFormat, onSave]);

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

  return (
    <div className={modalStyles.overlay} onClick={onCancel}>
      <div
        ref={modalRef}
        className={modalStyles.modal}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className={modalStyles.header}>
          <h2 className={modalStyles.title}>Number Format</h2>
          <button className={modalStyles.closeButton} onClick={onCancel}>
            &times;
          </button>
        </div>

        <div className={modalStyles.content}>
          {NUMBER_FORMAT_PRESETS.map((preset) => (
            <div
              key={preset.value || "general"}
              className={`${modalStyles.formatItem} ${
                !isCustom && selectedFormat === preset.value ? "selected" : ""
              }`}
              onClick={() => handlePresetSelect(preset.value)}
            >
              <input
                type="radio"
                className={modalStyles.radio}
                checked={!isCustom && selectedFormat === preset.value}
                onChange={() => handlePresetSelect(preset.value)}
              />
              <div className={modalStyles.formatInfo}>
                <div className={modalStyles.formatLabel}>{preset.label}</div>
                <div className={modalStyles.formatExample}>{preset.example}</div>
              </div>
            </div>
          ))}
        </div>

        <div className={modalStyles.customSection}>
          <label className={modalStyles.customLabel}>Custom Format Code</label>
          <input
            type="text"
            className={modalStyles.customInput}
            value={customFormat}
            onChange={(e) => handleCustomChange(e.target.value)}
            placeholder="e.g., #,##0.00"
          />
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
    </div>
  );
}
