// FILENAME: app/src/components/Ribbon/FormulasTab.tsx
// PURPOSE: Formulas tab content for the Ribbon toolbar.
// CONTEXT: Provides quick access to spreadsheet functions organized by category,
// similar to Microsoft Excel's Formulas ribbon tab. Also includes Calculation options.

import React, { useState, useCallback, useEffect } from "react";
import {
  InsertFunctionIcon,
  AutoSumIcon,
  RecentlyUsedIcon,
  FinancialIcon,
  LogicalIcon,
  TextIcon,
  DateTimeIcon,
  LookupIcon,
  MathTrigIcon,
  MoreFunctionsIcon,
} from "./FormulaIcons";
// Constants - define locally or import from shell
import { FUNCTION_CATEGORIES } from "../../../shell/Ribbon/styles/constants";

// Styles - import from shell
import { getFormatButtonStyle } from "../../../shell/Ribbon/styles";

// Tauri API - correct path from addins/_disabled/functions/
import { calculateNow, calculateSheet, getCalculationMode, setCalculationMode } from "../../../core/lib/tauri-api";

// ============================================================================
// Types
// ============================================================================

interface FormulasTabContentProps {
  isDisabled: boolean;
  onInsertFunction: (functionName: string, syntax: string) => void;
  onCellsUpdated?: () => void | Promise<void>;  // Changed from () => Promise<void>
}

interface FunctionDropdownProps {
  functions: FunctionDefinition[];
  onSelect: (func: FunctionDefinition) => void;
  onClose: () => void;
}

interface CalculationDropdownProps {
  currentMode: string;
  onSelect: (mode: "automatic" | "manual") => void;
  onClose: () => void;
}

// ============================================================================
// Styles
// ============================================================================

const formulaButtonStyles: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  padding: "4px 8px",
  border: "1px solid transparent",
  borderRadius: "3px",
  backgroundColor: "transparent",
  cursor: "pointer",
  minWidth: "54px",
  height: "54px",
  gap: "2px",
  transition: "all 0.15s ease",
};

const formulaButtonHoverStyles: React.CSSProperties = {
  backgroundColor: "#e5e5e5",
  borderColor: "#ccc",
};

const formulaButtonDisabledStyles: React.CSSProperties = {
  opacity: 0.5,
  cursor: "not-allowed",
};

const formulaLabelStyles: React.CSSProperties = {
  fontSize: "10px",
  color: "#333",
  textAlign: "center",
  lineHeight: "1.2",
  maxWidth: "60px",
};

const dropdownArrowSmallStyles: React.CSSProperties = {
  fontSize: "8px",
  color: "#666",
  marginLeft: "2px",
};

const functionDropdownStyles: React.CSSProperties = {
  position: "absolute",
  top: "100%",
  left: "0",
  backgroundColor: "#fff",
  border: "1px solid #ccc",
  borderRadius: "4px",
  boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
  zIndex: 1000,
  minWidth: "280px",
  maxHeight: "300px",
  overflowY: "auto",
};

const functionItemStyles: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "100%",
  padding: "8px 12px",
  border: "none",
  backgroundColor: "transparent",
  cursor: "pointer",
  textAlign: "left",
  borderBottom: "1px solid #eee",
};

const functionNameStyles: React.CSSProperties = {
  fontSize: "12px",
  fontWeight: 600,
  color: "#333",
};

const functionSyntaxStyles: React.CSSProperties = {
  fontSize: "10px",
  color: "#666",
  fontFamily: "monospace",
  marginTop: "2px",
};

const functionDescStyles: React.CSSProperties = {
  fontSize: "10px",
  color: "#888",
  marginTop: "2px",
};

const buttonContainerStyles: React.CSSProperties = {
  position: "relative",
};

const insertFunctionButtonStyles: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  padding: "4px 12px",
  border: "1px solid #ccc",
  borderRadius: "3px",
  backgroundColor: "#fff",
  cursor: "pointer",
  minWidth: "60px",
  height: "54px",
  gap: "2px",
};

const functionLibraryGroupStyles: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "2px",
  maxWidth: "400px",
};

const calculationDropdownStyles: React.CSSProperties = {
  position: "absolute",
  top: "100%",
  left: "0",
  backgroundColor: "#fff",
  border: "1px solid #ccc",
  borderRadius: "4px",
  boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
  zIndex: 1000,
  minWidth: "200px",
};

const calculationItemStyles: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  width: "100%",
  padding: "8px 12px",
  border: "none",
  backgroundColor: "transparent",
  cursor: "pointer",
  textAlign: "left",
  fontSize: "12px",
  color: "#333",
};

const calculatorIconStyles: React.CSSProperties = {
  width: "24px",
  height: "24px",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

// ============================================================================
// Icons
// ============================================================================

function CalculatorIcon(): React.ReactElement {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="4" y="2" width="16" height="20" rx="2" />
      <line x1="8" y1="6" x2="16" y2="6" />
      <line x1="16" y1="10" x2="16" y2="10" />
      <line x1="12" y1="10" x2="12" y2="10" />
      <line x1="8" y1="10" x2="8" y2="10" />
      <line x1="16" y1="14" x2="16" y2="14" />
      <line x1="12" y1="14" x2="12" y2="14" />
      <line x1="8" y1="14" x2="8" y2="14" />
      <line x1="16" y1="18" x2="16" y2="18" />
      <line x1="12" y1="18" x2="12" y2="18" />
      <line x1="8" y1="18" x2="8" y2="18" />
    </svg>
  );
}

// ============================================================================
// Sub-Components
// ============================================================================

/**
 * Dropdown showing available functions in a category.
 */
function FunctionDropdown({
  functions,
  onSelect,
  onClose,
}: FunctionDropdownProps): React.ReactElement {
  return (
    <div
      style={functionDropdownStyles}
      className="function-dropdown"
      onClick={(e) => e.stopPropagation()}
    >
      {functions.map((func) => (
        <button
          key={func.name}
          style={functionItemStyles}
          onClick={() => {
            onSelect(func);
            onClose();
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.backgroundColor = "#f0f0f0";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.backgroundColor = "transparent";
          }}
          type="button"
        >
          <span style={functionNameStyles}>{func.name}</span>
          <span style={functionSyntaxStyles}>{func.syntax}</span>
          <span style={functionDescStyles}>{func.description}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Dropdown for calculation mode selection.
 */
function CalculationDropdown({
  currentMode,
  onSelect,
  onClose,
}: CalculationDropdownProps): React.ReactElement {
  return (
    <div
      style={calculationDropdownStyles}
      className="calculation-dropdown"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        style={{
          ...calculationItemStyles,
          fontWeight: currentMode === "automatic" ? 600 : 400,
        }}
        onClick={() => {
          onSelect("automatic");
          onClose();
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLElement).style.backgroundColor = "#f0f0f0";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.backgroundColor = "transparent";
        }}
        type="button"
      >
        {currentMode === "automatic" ? "[OK] " : ""}Automatic
      </button>
      <button
        style={{
          ...calculationItemStyles,
          fontWeight: currentMode === "manual" ? 600 : 400,
        }}
        onClick={() => {
          onSelect("manual");
          onClose();
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLElement).style.backgroundColor = "#f0f0f0";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.backgroundColor = "transparent";
        }}
        type="button"
      >
        {currentMode === "manual" ? "[OK] " : ""}Manual
      </button>
    </div>
  );
}

/**
 * Formula category button with optional dropdown.
 */
function FormulaCategoryButton({
  icon,
  label,
  functions,
  isDisabled,
  onInsertFunction,
}: {
  icon: React.ReactNode;
  label: string;
  functions: FunctionDefinition[];
  isDisabled: boolean;
  onInsertFunction: (functionName: string, syntax: string) => void;
}): React.ReactElement {
  const [isOpen, setIsOpen] = useState(false);
  const [isHovered, setIsHovered] = useState(false);

  const handleSelect = useCallback(
    (func: FunctionDefinition) => {
      console.log("[FormulasTab] Selected function:", func.name);
      onInsertFunction(func.name, func.syntax);
      setIsOpen(false);
    },
    [onInsertFunction]
  );

  const buttonStyle: React.CSSProperties = {
    ...formulaButtonStyles,
    ...(isHovered && !isDisabled ? formulaButtonHoverStyles : {}),
    ...(isDisabled ? formulaButtonDisabledStyles : {}),
  };

  return (
    <div style={buttonContainerStyles}>
      <button
        style={buttonStyle}
        onClick={(e) => {
          e.stopPropagation();
          if (!isDisabled) {
            setIsOpen(!isOpen);
          }
        }}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        disabled={isDisabled}
        title={`${label} functions`}
        type="button"
      >
        {icon}
        <span style={formulaLabelStyles}>
          {label}
          <span style={dropdownArrowSmallStyles}> v</span>
        </span>
      </button>
      {isOpen && (
        <FunctionDropdown
          functions={functions}
          onSelect={handleSelect}
          onClose={() => setIsOpen(false)}
        />
      )}
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

/**
 * Formulas tab content with function library and calculation buttons.
 */
export function FormulasTabContent({
  isDisabled,
  onInsertFunction,
  onCellsUpdated,
}: FormulasTabContentProps): React.ReactElement {
  const [isHoveredInsert, setIsHoveredInsert] = useState(false);
  const [isHoveredCalcOptions, setIsHoveredCalcOptions] = useState(false);
  const [isHoveredCalcNow, setIsHoveredCalcNow] = useState(false);
  const [isHoveredCalcSheet, setIsHoveredCalcSheet] = useState(false);
  const [showCalculationDropdown, setShowCalculationDropdown] = useState(false);
  const [calculationMode, setCalculationModeState] = useState<string>("automatic");
  const [isCalculating, setIsCalculating] = useState(false);

  // Load calculation mode on mount
  useEffect(() => {
    const loadMode = async () => {
      try {
        const mode = await getCalculationMode();
        setCalculationModeState(mode);
      } catch (error) {
        console.error("[FormulasTab] Failed to load calculation mode:", error);
      }
    };
    loadMode();
  }, []);

  // Close all dropdowns when clicking on the container
  const handleContainerClick = useCallback(() => {
    setShowCalculationDropdown(false);
  }, []);

  const handleInsertFunction = useCallback(() => {
    if (!isDisabled) {
      // Default to SUM when clicking Insert Function
      onInsertFunction("SUM", "SUM(number1, [number2], ...)");
    }
  }, [isDisabled, onInsertFunction]);

  const handleCalculationModeChange = useCallback(
    async (mode: "automatic" | "manual") => {
      console.log("[FormulasTab] Setting calculation mode to:", mode);
      try {
        await setCalculationMode(mode);
        setCalculationModeState(mode);
        setShowCalculationDropdown(false);
      } catch (error) {
        console.error("[FormulasTab] Failed to set calculation mode:", error);
      }
    },
    []
  );

  const handleCalculateNow = useCallback(async () => {
    if (isDisabled || isCalculating) return;

    console.log("[FormulasTab] Calculate Now clicked");
    setIsCalculating(true);
    try {
      const updatedCells = await calculateNow();
      console.log(`[FormulasTab] Recalculated ${updatedCells.length} cells`);
      if (onCellsUpdated) {
        await onCellsUpdated();
      }
    } catch (error) {
      console.error("[FormulasTab] Calculate Now failed:", error);
    } finally {
      setIsCalculating(false);
    }
  }, [isDisabled, isCalculating, onCellsUpdated]);

  const handleCalculateSheet = useCallback(async () => {
    if (isDisabled || isCalculating) return;

    console.log("[FormulasTab] Calculate Sheet clicked");
    setIsCalculating(true);
    try {
      const updatedCells = await calculateSheet();
      console.log(`[FormulasTab] Recalculated ${updatedCells.length} cells`);
      if (onCellsUpdated) {
        await onCellsUpdated();
      }
    } catch (error) {
      console.error("[FormulasTab] Calculate Sheet failed:", error);
    } finally {
      setIsCalculating(false);
    }
  }, [isDisabled, isCalculating, onCellsUpdated]);

  return (
    <div style={groupContainerStyles} onClick={handleContainerClick}>
      {/* Insert Function */}
      <div style={groupStyles}>
        <button
          style={{
            ...insertFunctionButtonStyles,
            ...(isHoveredInsert && !isDisabled ? formulaButtonHoverStyles : {}),
            ...(isDisabled ? formulaButtonDisabledStyles : {}),
          }}
          onClick={handleInsertFunction}
          onMouseEnter={() => setIsHoveredInsert(true)}
          onMouseLeave={() => setIsHoveredInsert(false)}
          disabled={isDisabled}
          title="Insert Function"
          type="button"
        >
          <InsertFunctionIcon />
          <span style={{ fontSize: "10px", color: "#333" }}>Insert</span>
          <span style={{ fontSize: "10px", color: "#333" }}>Function</span>
        </button>
        <div style={groupTitleStyles}>Function</div>
      </div>

      <div style={groupSeparatorStyles} />

      {/* Function Library */}
      <div style={{ ...groupStyles, minWidth: "420px" }}>
        <div style={functionLibraryGroupStyles}>
          <FormulaCategoryButton
            icon={<AutoSumIcon />}
            label="AutoSum"
            functions={AUTOSUM_FUNCTIONS}
            isDisabled={isDisabled}
            onInsertFunction={onInsertFunction}
          />
          <FormulaCategoryButton
            icon={<RecentlyUsedIcon />}
            label="Recent"
            functions={AUTOSUM_FUNCTIONS}
            isDisabled={isDisabled}
            onInsertFunction={onInsertFunction}
          />
          <FormulaCategoryButton
            icon={<FinancialIcon />}
            label="Financial"
            functions={FINANCIAL_FUNCTIONS}
            isDisabled={isDisabled}
            onInsertFunction={onInsertFunction}
          />
          <FormulaCategoryButton
            icon={<LogicalIcon />}
            label="Logical"
            functions={LOGICAL_FUNCTIONS}
            isDisabled={isDisabled}
            onInsertFunction={onInsertFunction}
          />
          <FormulaCategoryButton
            icon={<TextIcon />}
            label="Text"
            functions={TEXT_FUNCTIONS}
            isDisabled={isDisabled}
            onInsertFunction={onInsertFunction}
          />
          <FormulaCategoryButton
            icon={<DateTimeIcon />}
            label="Date & Time"
            functions={DATETIME_FUNCTIONS}
            isDisabled={isDisabled}
            onInsertFunction={onInsertFunction}
          />
          <FormulaCategoryButton
            icon={<LookupIcon />}
            label="Lookup"
            functions={LOOKUP_FUNCTIONS}
            isDisabled={isDisabled}
            onInsertFunction={onInsertFunction}
          />
          <FormulaCategoryButton
            icon={<MathTrigIcon />}
            label="Math & Trig"
            functions={MATH_FUNCTIONS}
            isDisabled={isDisabled}
            onInsertFunction={onInsertFunction}
          />
          <FormulaCategoryButton
            icon={<MoreFunctionsIcon />}
            label="More"
            functions={INFO_FUNCTIONS}
            isDisabled={isDisabled}
            onInsertFunction={onInsertFunction}
          />
        </div>
        <div style={groupTitleStyles}>Function Library</div>
      </div>

      <div style={groupSeparatorStyles} />

      {/* Calculation */}
      <div style={groupStyles}>
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          {/* Calculation Options */}
          <div style={buttonContainerStyles}>
            <button
              style={{
                ...formulaButtonStyles,
                minWidth: "120px",
                height: "auto",
                padding: "6px 12px",
                ...(isHoveredCalcOptions && !isDisabled ? formulaButtonHoverStyles : {}),
                ...(isDisabled ? formulaButtonDisabledStyles : {}),
              }}
              onClick={(e) => {
                e.stopPropagation();
                if (!isDisabled) {
                  setShowCalculationDropdown(!showCalculationDropdown);
                }
              }}
              onMouseEnter={() => setIsHoveredCalcOptions(true)}
              onMouseLeave={() => setIsHoveredCalcOptions(false)}
              disabled={isDisabled}
              title="Calculation Options"
              type="button"
            >
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <div style={calculatorIconStyles}>
                  <CalculatorIcon />
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
                  <span style={{ fontSize: "11px", color: "#333" }}>Calculation</span>
                  <span style={{ fontSize: "11px", color: "#333" }}>Options</span>
                </div>
                <span style={dropdownArrowSmallStyles}>v</span>
              </div>
            </button>
            {showCalculationDropdown && (
              <CalculationDropdown
                currentMode={calculationMode}
                onSelect={handleCalculationModeChange}
                onClose={() => setShowCalculationDropdown(false)}
              />
            )}
          </div>

          {/* Calculate Now & Calculate Sheet */}
          <div style={{ display: "flex", gap: "4px" }}>
            <button
              style={{
                ...formulaButtonStyles,
                minWidth: "60px",
                height: "40px",
                flexDirection: "row",
                gap: "4px",
                ...(isHoveredCalcNow && !isDisabled && !isCalculating ? formulaButtonHoverStyles : {}),
                ...(isDisabled || isCalculating ? formulaButtonDisabledStyles : {}),
              }}
              onClick={handleCalculateNow}
              onMouseEnter={() => setIsHoveredCalcNow(true)}
              onMouseLeave={() => setIsHoveredCalcNow(false)}
              disabled={isDisabled || isCalculating}
              title="Calculate Now (F9)"
              type="button"
            >
              <span style={{ fontSize: "10px", color: "#333" }}>Calculate</span>
              <span style={{ fontSize: "10px", color: "#333" }}>Now</span>
            </button>

            <button
              style={{
                ...formulaButtonStyles,
                minWidth: "60px",
                height: "40px",
                flexDirection: "row",
                gap: "4px",
                ...(isHoveredCalcSheet && !isDisabled && !isCalculating
                  ? formulaButtonHoverStyles
                  : {}),
                ...(isDisabled || isCalculating ? formulaButtonDisabledStyles : {}),
              }}
              onClick={handleCalculateSheet}
              onMouseEnter={() => setIsHoveredCalcSheet(true)}
              onMouseLeave={() => setIsHoveredCalcSheet(false)}
              disabled={isDisabled || isCalculating}
              title="Calculate Sheet (Shift+F9)"
              type="button"
            >
              <span style={{ fontSize: "10px", color: "#333" }}>Calculate</span>
              <span style={{ fontSize: "10px", color: "#333" }}>Sheet</span>
            </button>
          </div>
        </div>
        <div style={groupTitleStyles}>Calculation</div>
      </div>
    </div>
  );
}