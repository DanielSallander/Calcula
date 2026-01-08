// FILENAME: app/src/components/Ribbon/tabs/FormulasTab/CalculationGroup.tsx
// PURPOSE: Calculation group for the Formulas tab.
// CONTEXT: Contains calculation mode options and manual calculation triggers.

import React, { useState, useCallback, useEffect } from "react";
import type { RibbonContext } from "../../../../core/extensions/types";
import {
  setCalculationMode,
  getCalculationMode,
  calculateNow,
  calculateSheet,
} from "../../../../core/lib/tauri-api";
import { CalculatorIcon } from "../icons";

interface CalculationGroupProps {
  context: RibbonContext;
}

// Styles
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

const dropdownArrowSmallStyles: React.CSSProperties = {
  fontSize: "8px",
  color: "#666",
  marginLeft: "2px",
};

const buttonContainerStyles: React.CSSProperties = {
  position: "relative",
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

// Sub-components
interface CalculationDropdownProps {
  currentMode: string;
  onSelect: (mode: "automatic" | "manual") => void;
  onClose: () => void;
}

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
 * Calculation group content.
 */
export function CalculationGroup({
  context,
}: CalculationGroupProps): React.ReactElement {
  const { isDisabled, onCellsUpdated } = context;
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
        console.error("[CalculationGroup] Failed to load calculation mode:", error);
      }
    };
    loadMode();
  }, []);

  const handleCalculationModeChange = useCallback(
    async (mode: "automatic" | "manual") => {
      console.log("[CalculationGroup] Setting calculation mode to:", mode);
      try {
        await setCalculationMode(mode);
        setCalculationModeState(mode);
        setShowCalculationDropdown(false);
      } catch (error) {
        console.error("[CalculationGroup] Failed to set calculation mode:", error);
      }
    },
    []
  );

  const handleCalculateNow = useCallback(async () => {
    if (isDisabled || isCalculating) return;

    console.log("[CalculationGroup] Calculate Now clicked");
    setIsCalculating(true);
    try {
      const updatedCells = await calculateNow();
      console.log(`[CalculationGroup] Recalculated ${updatedCells.length} cells`);
      if (onCellsUpdated) {
        await onCellsUpdated();
      }
    } catch (error) {
      console.error("[CalculationGroup] Calculate Now failed:", error);
    } finally {
      setIsCalculating(false);
    }
  }, [isDisabled, isCalculating, onCellsUpdated]);

  const handleCalculateSheet = useCallback(async () => {
    if (isDisabled || isCalculating) return;

    console.log("[CalculationGroup] Calculate Sheet clicked");
    setIsCalculating(true);
    try {
      const updatedCells = await calculateSheet();
      console.log(`[CalculationGroup] Recalculated ${updatedCells.length} cells`);
      if (onCellsUpdated) {
        await onCellsUpdated();
      }
    } catch (error) {
      console.error("[CalculationGroup] Calculate Sheet failed:", error);
    } finally {
      setIsCalculating(false);
    }
  }, [isDisabled, isCalculating, onCellsUpdated]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
      {/* Calculation Options */}
      <div style={buttonContainerStyles}>
        <button
          style={{
            ...formulaButtonStyles,
            minWidth: "120px",
            height: "auto",
            padding: "6px 12px",
            ...(isHoveredCalcOptions && !isDisabled
              ? formulaButtonHoverStyles
              : {}),
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
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-start",
              }}
            >
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
            ...(isHoveredCalcNow && !isDisabled && !isCalculating
              ? formulaButtonHoverStyles
              : {}),
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
  );
}