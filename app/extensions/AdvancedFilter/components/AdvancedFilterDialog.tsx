//! FILENAME: app/extensions/AdvancedFilter/components/AdvancedFilterDialog.tsx
// PURPOSE: Dialog for Excel-style Advanced Filter configuration.
// CONTEXT: User specifies list range, criteria range, action (filter in place / copy to), unique records.

import React, { useState, useEffect, useCallback } from "react";
import type { DialogProps } from "@api";
import type { AdvancedFilterDialogData, AdvancedFilterAction } from "../types";
import {
  executeAdvancedFilter,
  clearAdvancedFilter,
  parseRangeRef,
  formatRangeRef,
} from "../lib/advancedFilterEngine";
import {
  overlayStyle,
  dialogStyle,
  headerStyle,
  closeButtonStyle,
  bodyStyle,
  sectionStyle,
  labelStyle,
  inputStyle,
  inputErrorStyle,
  radioGroupStyle,
  radioLabelStyle,
  checkboxLabelStyle,
  footerStyle,
  buttonStyle,
  primaryButtonStyle,
  errorTextStyle,
} from "./AdvancedFilterDialog.styles";

// ============================================================================
// Component
// ============================================================================

export function AdvancedFilterDialog(props: DialogProps) {
  const { isOpen, onClose, data } = props;
  const dialogData = data as unknown as AdvancedFilterDialogData | undefined;

  // Form state
  const [listRange, setListRange] = useState("");
  const [criteriaRange, setCriteriaRange] = useState("");
  const [action, setAction] = useState<AdvancedFilterAction>("filterInPlace");
  const [copyTo, setCopyTo] = useState("");
  const [uniqueRecordsOnly, setUniqueRecordsOnly] = useState(false);

  // Validation errors
  const [listRangeError, setListRangeError] = useState("");
  const [criteriaRangeError, setCriteriaRangeError] = useState("");
  const [copyToError, setCopyToError] = useState("");
  const [generalError, setGeneralError] = useState("");

  // Reset form when dialog opens
  useEffect(() => {
    if (!isOpen) return;
    setListRange(dialogData?.listRange ?? "");
    setCriteriaRange(dialogData?.criteriaRange ?? "");
    setAction("filterInPlace");
    setCopyTo("");
    setUniqueRecordsOnly(false);
    setListRangeError("");
    setCriteriaRangeError("");
    setCopyToError("");
    setGeneralError("");
  }, [isOpen, dialogData]);

  // Validate inputs
  const validate = useCallback((): boolean => {
    let valid = true;

    const lr = parseRangeRef(listRange);
    if (!lr) {
      setListRangeError("Enter a valid range (e.g., A1:D10).");
      valid = false;
    } else {
      setListRangeError("");
    }

    const cr = parseRangeRef(criteriaRange);
    if (!cr) {
      setCriteriaRangeError("Enter a valid range (e.g., F1:G3).");
      valid = false;
    } else {
      setCriteriaRangeError("");
    }

    if (action === "copyToLocation") {
      const ct = parseRangeRef(copyTo);
      if (!ct) {
        setCopyToError("Enter a valid cell reference (e.g., H1).");
        valid = false;
      } else {
        setCopyToError("");
      }
    } else {
      setCopyToError("");
    }

    setGeneralError("");
    return valid;
  }, [listRange, criteriaRange, action, copyTo]);

  // Handle OK
  const handleOk = useCallback(async () => {
    if (!validate()) return;

    const lr = parseRangeRef(listRange)!;
    const cr = parseRangeRef(criteriaRange)!;
    const ct = action === "copyToLocation" ? parseRangeRef(copyTo) : undefined;

    const result = await executeAdvancedFilter({
      listRange: lr,
      criteriaRange: cr,
      action,
      copyTo: ct ? [ct[0], ct[1]] : undefined,
      uniqueRecordsOnly,
    });

    if (!result.success) {
      setGeneralError(result.error ?? "Advanced Filter failed.");
      return;
    }

    onClose();
  }, [listRange, criteriaRange, action, copyTo, uniqueRecordsOnly, validate, onClose]);

  // Handle backdrop click
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  // Handle Enter key
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleOk();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [handleOk, onClose],
  );

  if (!isOpen) return null;

  return (
    <div style={overlayStyle} onClick={handleBackdropClick}>
      <div style={dialogStyle} role="dialog" onKeyDown={handleKeyDown}>
        {/* Header */}
        <div style={headerStyle}>
          <span>Advanced Filter</span>
          <button style={closeButtonStyle} onClick={onClose} title="Close">
            X
          </button>
        </div>

        {/* Body */}
        <div style={bodyStyle}>
          {/* Action radio group */}
          <div style={sectionStyle}>
            <div style={labelStyle}>Action</div>
            <div style={radioGroupStyle}>
              <label style={radioLabelStyle}>
                <input
                  type="radio"
                  name="advFilter-action"
                  checked={action === "filterInPlace"}
                  onChange={() => setAction("filterInPlace")}
                />
                Filter the list, in-place
              </label>
              <label style={radioLabelStyle}>
                <input
                  type="radio"
                  name="advFilter-action"
                  checked={action === "copyToLocation"}
                  onChange={() => setAction("copyToLocation")}
                />
                Copy to another location
              </label>
            </div>
          </div>

          {/* List range */}
          <div style={sectionStyle}>
            <label style={labelStyle}>List range:</label>
            <input
              style={listRangeError ? inputErrorStyle : inputStyle}
              value={listRange}
              onChange={(e) => setListRange(e.target.value)}
              placeholder="e.g., $A$1:$D$20"
              autoFocus
            />
            {listRangeError && <div style={errorTextStyle}>{listRangeError}</div>}
          </div>

          {/* Criteria range */}
          <div style={sectionStyle}>
            <label style={labelStyle}>Criteria range:</label>
            <input
              style={criteriaRangeError ? inputErrorStyle : inputStyle}
              value={criteriaRange}
              onChange={(e) => setCriteriaRange(e.target.value)}
              placeholder="e.g., $F$1:$G$3"
            />
            {criteriaRangeError && <div style={errorTextStyle}>{criteriaRangeError}</div>}
          </div>

          {/* Copy to (only if action is copyToLocation) */}
          {action === "copyToLocation" && (
            <div style={sectionStyle}>
              <label style={labelStyle}>Copy to:</label>
              <input
                style={copyToError ? inputErrorStyle : inputStyle}
                value={copyTo}
                onChange={(e) => setCopyTo(e.target.value)}
                placeholder="e.g., $H$1"
              />
              {copyToError && <div style={errorTextStyle}>{copyToError}</div>}
            </div>
          )}

          {/* Unique records only */}
          <div style={sectionStyle}>
            <label style={checkboxLabelStyle}>
              <input
                type="checkbox"
                checked={uniqueRecordsOnly}
                onChange={(e) => setUniqueRecordsOnly(e.target.checked)}
              />
              Unique records only
            </label>
          </div>

          {/* General error */}
          {generalError && <div style={errorTextStyle}>{generalError}</div>}
        </div>

        {/* Footer */}
        <div style={footerStyle}>
          <button style={primaryButtonStyle} onClick={handleOk}>
            OK
          </button>
          <button style={buttonStyle} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
