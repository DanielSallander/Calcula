//! FILENAME: app/extensions/DataValidation/components/DataValidationDialog.tsx
// PURPOSE: Main Data Validation configuration dialog with 3 tabs.
// CONTEXT: Opened from the Data menu. Configures validation criteria, input messages, and error alerts.

import React, { useState, useEffect, useCallback } from "react";
import type { DialogProps } from "@api";
import type {
  DataValidationType,
  DataValidationOperator,
  DataValidationAlertStyle,
  DataValidation,
  DataValidationRule,
} from "@api";
import {
  getDataValidation,
  getAllDataValidations,
  setDataValidation,
  clearDataValidation,
  getSheets,
  evaluateExpression,
  DEFAULT_ERROR_ALERT,
  DEFAULT_PROMPT,
  DEFAULT_VALIDATION,
  createWholeNumberRule,
  createDecimalRule,
  createListRule,
  createTextLengthRule,
  createCustomRule,
  createDateRule,
  createTimeRule,
} from "@api";
import { joinValidationRefresh, getCurrentSelection } from "../lib/validationStore";
import { formatListSourceText, moveListRange, parseListSourceText } from "../lib/listSourceRef";
import { activeCellOf } from "@api/activeCell";
import { moveRuleFormula } from "../../_shared/lib/moveRuleFormula";
import {
  operatorNeedsSecondValue,
  parseCriterionValue,
  typeNeedsCriteria,
} from "../lib/criteriaValue";
import type { ValidationDialogData } from "../types";
import { SettingsTab } from "./tabs/SettingsTab";
import { InputMessageTab } from "./tabs/InputMessageTab";
import { ErrorAlertTab } from "./tabs/ErrorAlertTab";

// ============================================================================
// Styles
// ============================================================================

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: "rgba(0, 0, 0, 0.45)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 9500,
};

const dialogStyle: React.CSSProperties = {
  backgroundColor: "#f0f0f0",
  border: "1px solid #888",
  borderRadius: 4,
  boxShadow: "0 4px 16px rgba(0, 0, 0, 0.3)",
  width: 420,
  maxHeight: "80vh",
  display: "flex",
  flexDirection: "column",
  fontFamily: "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif",
  fontSize: 13,
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "10px 16px",
  borderBottom: "1px solid #ddd",
  fontWeight: 600,
  fontSize: 13,
};

const closeButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  cursor: "pointer",
  fontSize: 16,
  color: "#666",
  padding: "2px 6px",
  lineHeight: 1,
};

const tabBarStyle: React.CSSProperties = {
  display: "flex",
  borderBottom: "1px solid #ccc",
  backgroundColor: "#e8e8e8",
};

const tabStyle: React.CSSProperties = {
  padding: "8px 16px",
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 500,
  border: "none",
  borderBottom: "2px solid transparent",
  backgroundColor: "transparent",
  color: "#555",
  fontFamily: "inherit",
};

const activeTabStyle: React.CSSProperties = {
  ...tabStyle,
  borderBottom: "2px solid #0078d4",
  color: "#0078d4",
  fontWeight: 600,
};

const bodyStyle: React.CSSProperties = {
  padding: "8px 16px",
  overflowY: "auto",
  flex: 1,
};

const errorStyle: React.CSSProperties = {
  padding: "8px 16px",
  borderTop: "1px solid #f0c0c0",
  backgroundColor: "#fdf2f2",
  color: "#a80000",
  fontSize: 12,
};

const footerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  padding: "12px 16px",
  borderTop: "1px solid #ddd",
};

const buttonStyle: React.CSSProperties = {
  padding: "4px 16px",
  minWidth: 72,
  border: "1px solid #ababab",
  borderRadius: 2,
  backgroundColor: "#e1e1e1",
  cursor: "pointer",
  fontSize: 13,
  fontFamily: "inherit",
};

const primaryButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  backgroundColor: "#0078d4",
  color: "#fff",
  borderColor: "#0078d4",
};

const clearButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  marginRight: "auto",
};

// ============================================================================
// Tab IDs
// ============================================================================

type TabId = "settings" | "inputMessage" | "errorAlert";

const TABS: { id: TabId; label: string }[] = [
  { id: "settings", label: "Settings" },
  { id: "inputMessage", label: "Input Message" },
  { id: "errorAlert", label: "Error Alert" },
];

/** What the Settings tab currently describes: a rule, or the reason it is not one. */
type BuiltRule =
  | { ok: true; rule: DataValidationRule }
  | { ok: false; message: string };

// ============================================================================
// Component
// ============================================================================

export function DataValidationDialog(props: DialogProps) {
  const { isOpen, onClose, data } = props;
  const dialogData = data as unknown as ValidationDialogData | undefined;

  // Active tab
  const [activeTab, setActiveTab] = useState<TabId>("settings");

  // Settings tab state
  const [validationType, setValidationType] = useState<DataValidationType>("none");
  const [operator, setOperator] = useState<DataValidationOperator>("between");
  const [formula1, setFormula1] = useState("");
  const [formula2, setFormula2] = useState("");
  const [listSource, setListSource] = useState("");
  const [customFormula, setCustomFormula] = useState("");
  const [ignoreBlanks, setIgnoreBlanks] = useState(true);
  const [inCellDropdown, setInCellDropdown] = useState(true);

  // Input message tab state
  const [showPrompt, setShowPrompt] = useState(true);
  const [promptTitle, setPromptTitle] = useState("");
  const [promptMessage, setPromptMessage] = useState("");

  // Error alert tab state
  const [showAlert, setShowAlert] = useState(true);
  const [alertStyle, setAlertStyle] = useState<DataValidationAlertStyle>("stop");
  const [errorTitle, setErrorTitle] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  // Cell range
  const [startRow, setStartRow] = useState(0);
  const [startCol, setStartCol] = useState(0);
  const [endRow, setEndRow] = useState(0);
  const [endCol, setEndCol] = useState(0);

  // The ACTIVE cell. Excel's dialog states a relative Source and a custom
  // formula for it, and reads what is typed relative to it (lane cfdvfix;
  // [LIVE] cfdvb/probe1.ps1 C1: `=F1:F2` on H2:H4 reads `=F2:F3` at H3).
  // The rule is stored for the range's top-left.
  const [activeCell, setActiveCell] = useState<{ row: number; col: number }>({ row: 0, col: 0 });

  // Workbook sheets, for reading and writing a range-backed list source.
  // Null means the sheet list could not be read, which is NOT the same as "the
  // first sheet" -- a range would be stored against the wrong sheet.
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [activeSheetIndex, setActiveSheetIndex] = useState<number | null>(null);

  // Why the last OK was refused ("" = nothing to say).
  const [invalidReason, setInvalidReason] = useState("");

  // Loading state
  const [loaded, setLoaded] = useState(false);

  // Load existing validation when dialog opens
  useEffect(() => {
    if (!isOpen) {
      setLoaded(false);
      return;
    }

    // Determine cell range from dialog data or current selection
    let sr = dialogData?.startRow ?? 0;
    let sc = dialogData?.startCol ?? 0;
    let er = dialogData?.endRow ?? 0;
    let ec = dialogData?.endCol ?? 0;

    // Without a selection's own active cell, the range's top-left is it.
    let active = { row: Math.min(sr, er), col: Math.min(sc, ec) };
    if (!dialogData) {
      const sel = getCurrentSelection();
      if (sel) {
        sr = sel.startRow;
        sc = sel.startCol;
        er = sel.endRow;
        ec = sel.endCol;
        active = activeCellOf(sel) ?? { row: Math.min(sr, er), col: Math.min(sc, ec) };
      }
    }

    setStartRow(sr);
    setStartCol(sc);
    setEndRow(er);
    setEndCol(ec);
    setActiveCell(active);
    setInvalidReason("");

    // Load existing validation for this range
    async function loadExisting() {
      // The sheet list comes FIRST: a range-backed list source cannot be
      // rendered as text without the names, and rendering one wrong is how the
      // rule used to get destroyed.
      let names: string[] = [];
      let sheetIndex: number | null = null;
      try {
        const sheets = await getSheets();
        names = [];
        for (const info of sheets.sheets) {
          names[info.index] = info.name;
        }
        sheetIndex = sheets.activeIndex;
      } catch (error) {
        console.error("[DataValidation] Failed to read the sheet list:", error);
      }
      setSheetNames(names);
      setActiveSheetIndex(sheetIndex);
      const cell = active;

      try {
        // The rule the ACTIVE cell has, and the cell it is written for (its
        // range's top-left), so its formulas can be stated for the active cell.
        let existing = dialogData?.existingValidation ?? null;
        let writtenFor = { row: Math.min(sr, er), col: Math.min(sc, ec) };
        if (!existing) {
          const ranges = await getAllDataValidations();
          const holder = ranges.find(
            (v) =>
              cell.row >= Math.min(v.startRow, v.endRow) &&
              cell.row <= Math.max(v.startRow, v.endRow) &&
              cell.col >= Math.min(v.startCol, v.endCol) &&
              cell.col <= Math.max(v.startCol, v.endCol)
          );
          if (holder) {
            existing = holder.validation;
            writtenFor = { row: Math.min(holder.startRow, holder.endRow), col: Math.min(holder.startCol, holder.endCol) };
          } else {
            existing = await getDataValidation(cell.row, cell.col);
          }
        }
        if (existing) {
          await populateFromValidation(existing, names, sheetIndex, {
            drow: cell.row - writtenFor.row,
            dcol: cell.col - writtenFor.col,
          });
        } else {
          resetToDefaults();
        }
      } catch (error) {
        console.error("[DataValidation] Failed to load existing validation:", error);
        resetToDefaults();
      } finally {
        setLoaded(true);
      }
    }

    loadExisting();
  }, [isOpen]);

  async function populateFromValidation(
    dv: DataValidation,
    names: readonly string[],
    active: number | null,
    offset: { drow: number; dcol: number }
  ) {
    const rule = dv.rule;

    // Determine type and populate fields
    if ("none" in rule) {
      setValidationType("none");
    } else if ("wholeNumber" in rule) {
      setValidationType("wholeNumber");
      setOperator(rule.wholeNumber.operator);
      setFormula1(String(rule.wholeNumber.formula1));
      setFormula2(rule.wholeNumber.formula2 != null ? String(rule.wholeNumber.formula2) : "");
    } else if ("decimal" in rule) {
      setValidationType("decimal");
      setOperator(rule.decimal.operator);
      setFormula1(String(rule.decimal.formula1));
      setFormula2(rule.decimal.formula2 != null ? String(rule.decimal.formula2) : "");
    } else if ("list" in rule) {
      setValidationType("list");
      // A range renders as a REFERENCE (=$A$1:$A$4), not as its coordinates:
      // the old "=1:0:4:0" was re-saved by OK as a literal one-value list.
      // -1 matches no sheet, so an unread sheet list renders the range as #REF!
      // instead of implying it is on this one -- and OK refuses to save that.
      // A relative source is stated for the active cell (`offset` from the
      // cell it is written for), as Excel's dialog shows it.
      setListSource(formatListSourceText(rule.list.source, names, active ?? -1, offset));
      setInCellDropdown(rule.list.inCellDropdown);
    } else if ("date" in rule) {
      setValidationType("date");
      setOperator(rule.date.operator);
      setFormula1(String(rule.date.formula1));
      setFormula2(rule.date.formula2 != null ? String(rule.date.formula2) : "");
    } else if ("time" in rule) {
      setValidationType("time");
      setOperator(rule.time.operator);
      setFormula1(String(rule.time.formula1));
      setFormula2(rule.time.formula2 != null ? String(rule.time.formula2) : "");
    } else if ("textLength" in rule) {
      setValidationType("textLength");
      setOperator(rule.textLength.operator);
      setFormula1(String(rule.textLength.formula1));
      setFormula2(rule.textLength.formula2 != null ? String(rule.textLength.formula2) : "");
    } else if ("custom" in rule) {
      setValidationType("custom");
      // Stated for the active cell; a formula that cannot be (a range whose
      // ends would wrap apart) is shown as stored.
      const shown = await moveRuleFormula(rule.custom.formula, offset.drow, offset.dcol).catch(() => null);
      setCustomFormula(shown ?? rule.custom.formula);
    }

    // Populate ignore blanks
    setIgnoreBlanks(dv.ignoreBlanks);

    // Populate prompt
    setShowPrompt(dv.prompt.showPrompt);
    setPromptTitle(dv.prompt.title);
    setPromptMessage(dv.prompt.message);

    // Populate error alert
    setShowAlert(dv.errorAlert.showAlert);
    setAlertStyle(dv.errorAlert.style);
    setErrorTitle(dv.errorAlert.title);
    setErrorMessage(dv.errorAlert.message);
  }

  function resetToDefaults() {
    setValidationType("none");
    setOperator("between");
    setFormula1("");
    setFormula2("");
    setListSource("");
    setCustomFormula("");
    setIgnoreBlanks(true);
    setInCellDropdown(true);
    setShowPrompt(true);
    setPromptTitle("");
    setPromptMessage("");
    setShowAlert(true);
    setAlertStyle("stop");
    setErrorTitle("");
    setErrorMessage("");
    setActiveTab("settings");
  }

  // Build the rule object from current state, or say why it is not a rule.
  // Nothing here coerces: a criterion that cannot be represented is REFUSED, so
  // that OK never writes a rule the user did not describe.
  async function buildRule(): Promise<BuiltRule> {
    // The cell the rule is written for: the range's top-left.
    const anchor = { row: Math.min(startRow, endRow), col: Math.min(startCol, endCol) };
    if (validationType === "none") {
      return { ok: true, rule: { none: true } };
    }

    if (validationType === "list") {
      if (activeSheetIndex === null) {
        return {
          ok: false,
          message: "The sheet list could not be read, so a source cannot be resolved. Close and reopen the dialog.",
        };
      }
      const parsed = parseListSourceText(listSource, sheetNames, activeSheetIndex);
      if (parsed.kind === "error") {
        return { ok: false, message: parsed.message };
      }
      if (parsed.kind === "values") {
        return { ok: true, rule: createListRule(parsed.values, inCellDropdown) };
      }
      // Typed for the active cell, stored for the range's top-left, with
      // every part's `$` (BUG-0745: the relative flags were dropped here, so
      // `=F1:F2` was saved absolute and OK on a relative rule made it so).
      const range = moveListRange(parsed.range, anchor.row - activeCell.row, anchor.col - activeCell.col);
      return { ok: true, rule: { list: { source: { range }, inCellDropdown } } };
    }

    if (validationType === "custom") {
      const formula = customFormula.trim();
      if (formula.length === 0) {
        // An empty formula evaluates to no boolean, and the backend reads that
        // as "invalid" -- an empty Custom rule rejects every entry.
        return { ok: false, message: "Enter a formula. An empty custom rule rejects every entry." };
      }
      // Typed for the active cell, stored for the range's top-left.
      const stored = await moveRuleFormula(formula, anchor.row - activeCell.row, anchor.col - activeCell.col).catch(
        () => null
      );
      if (stored === null) {
        return {
          ok: false,
          message:
            "The formula refers to a range that would wrap around the edge of the sheet from the range's first cell. " +
            "Select the range starting from its top-left cell, or change the reference.",
        };
      }
      return { ok: true, rule: createCustomRule(stored) };
    }

    if (!typeNeedsCriteria(validationType)) {
      // Unreachable while the Settings tab shows a box for every criteria type:
      // it asks typeNeedsCriteria too, so what is DISPLAYED and what is READ
      // here cannot drift apart.
      return { ok: false, message: "This validation type cannot be saved." };
    }

    const needsSecond = operatorNeedsSecondValue(operator);
    const first = await parseCriterionValue(
      formula1,
      validationType,
      needsSecond ? "Minimum" : "Value",
      evaluateExpression
    );
    if (!first.ok) {
      return { ok: false, message: first.message };
    }

    let second: number | undefined;
    if (needsSecond) {
      const maximum = await parseCriterionValue(
        formula2,
        validationType,
        "Maximum",
        evaluateExpression
      );
      if (!maximum.ok) {
        return { ok: false, message: maximum.message };
      }
      second = maximum.value;
    }

    switch (validationType) {
      case "wholeNumber":
        return { ok: true, rule: createWholeNumberRule(operator, first.value, second) };
      case "decimal":
        return { ok: true, rule: createDecimalRule(operator, first.value, second) };
      case "date":
        return { ok: true, rule: createDateRule(operator, first.value, second) };
      case "time":
        return { ok: true, rule: createTimeRule(operator, first.value, second) };
      case "textLength":
        return { ok: true, rule: createTextLengthRule(operator, first.value, second) };
    }

    return { ok: false, message: "This validation type cannot be saved." };
  }

  // Apply validation
  const handleOk = useCallback(async () => {
    try {
      const built = await buildRule();
      if (!built.ok) {
        // Refusing keeps the dialog open with the user's text intact; closing on
        // a rule we could not build is how a wrong rule got written silently.
        setInvalidReason(built.message);
        setActiveTab("settings");
        return;
      }
      const validation: DataValidation = {
        rule: built.rule,
        ignoreBlanks,
        prompt: {
          showPrompt,
          title: promptTitle,
          message: promptMessage,
        },
        errorAlert: {
          showAlert,
          style: alertStyle,
          title: errorTitle,
          message: errorMessage,
        },
      };

      await setDataValidation(startRow, startCol, endRow, endCol, validation);
      await joinValidationRefresh();
      onClose();
    } catch (error) {
      console.error("[DataValidation] Failed to set validation:", error);
      setInvalidReason("The rule could not be saved. See the console for details.");
    }
  }, [
    validationType, operator, formula1, formula2, listSource, customFormula,
    ignoreBlanks, inCellDropdown, showPrompt, promptTitle, promptMessage,
    showAlert, alertStyle, errorTitle, errorMessage,
    startRow, startCol, endRow, endCol, sheetNames, activeSheetIndex, activeCell, onClose,
  ]);

  // Clear all validation for the range
  const handleClearAll = useCallback(async () => {
    try {
      await clearDataValidation(startRow, startCol, endRow, endCol);
      await joinValidationRefresh();
      onClose();
    } catch (error) {
      console.error("[DataValidation] Failed to clear validation:", error);
    }
  }, [startRow, startCol, endRow, endCol, onClose]);

  // Handle keyboard
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleOk();
      }
    },
    [onClose, handleOk]
  );

  // Click outside to close
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  // A refusal describes the fields as they were when OK was pressed; the first
  // edit afterwards makes it stale, so it is dropped as soon as one lands.
  function edited<T>(set: (value: T) => void): (value: T) => void {
    return (value: T) => {
      setInvalidReason("");
      set(value);
    };
  }

  if (!isOpen) {
    return null;
  }

  if (!loaded) {
    return null;
  }

  return (
    <div style={overlayStyle} onKeyDown={handleKeyDown} onClick={handleBackdropClick}>
      <div style={dialogStyle} role="dialog" aria-label="Data Validation">
        {/* Header */}
        <div style={headerStyle}>
          <span>Data Validation</span>
          <button style={closeButtonStyle} onClick={onClose} title="Close">
            X
          </button>
        </div>

        {/* Tab Bar */}
        <div style={tabBarStyle}>
          {TABS.map((tab) => (
            <button
              key={tab.id}
              style={activeTab === tab.id ? activeTabStyle : tabStyle}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div style={bodyStyle}>
          {activeTab === "settings" && (
            <SettingsTab
              validationType={validationType}
              operator={operator}
              formula1={formula1}
              formula2={formula2}
              listSource={listSource}
              customFormula={customFormula}
              ignoreBlanks={ignoreBlanks}
              inCellDropdown={inCellDropdown}
              onChangeType={edited(setValidationType)}
              onChangeOperator={edited(setOperator)}
              onChangeFormula1={edited(setFormula1)}
              onChangeFormula2={edited(setFormula2)}
              onChangeListSource={edited(setListSource)}
              onChangeCustomFormula={edited(setCustomFormula)}
              onChangeIgnoreBlanks={setIgnoreBlanks}
              onChangeInCellDropdown={setInCellDropdown}
            />
          )}
          {activeTab === "inputMessage" && (
            <InputMessageTab
              showPrompt={showPrompt}
              promptTitle={promptTitle}
              promptMessage={promptMessage}
              onChangeShowPrompt={setShowPrompt}
              onChangeTitle={setPromptTitle}
              onChangeMessage={setPromptMessage}
            />
          )}
          {activeTab === "errorAlert" && (
            <ErrorAlertTab
              showAlert={showAlert}
              alertStyle={alertStyle}
              errorTitle={errorTitle}
              errorMessage={errorMessage}
              onChangeShowAlert={setShowAlert}
              onChangeStyle={setAlertStyle}
              onChangeTitle={setErrorTitle}
              onChangeMessage={setErrorMessage}
            />
          )}
        </div>

        {/* Why OK was refused */}
        {invalidReason !== "" && (
          <div style={errorStyle} role="alert">
            {invalidReason}
          </div>
        )}

        {/* Footer */}
        <div style={footerStyle}>
          <button style={clearButtonStyle} onClick={handleClearAll}>
            Clear All
          </button>
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
