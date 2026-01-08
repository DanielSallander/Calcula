// FILENAME: app/src/components/Ribbon/tabs/FormulasTab/FunctionLibraryGroup.tsx
// PURPOSE: Function Library group for the Formulas tab.
// CONTEXT: Contains category buttons for inserting spreadsheet functions.

import React, { useState, useCallback } from "react";
import type { RibbonContext } from "../../../../core/extensions/types";
import type { FunctionDefinition } from "../../../../shell/Ribbon/styles/constants";
import {
  AUTOSUM_FUNCTIONS,
  FINANCIAL_FUNCTIONS,
  LOGICAL_FUNCTIONS,
  TEXT_FUNCTIONS,
  DATETIME_FUNCTIONS,
  LOOKUP_FUNCTIONS,
  MATH_FUNCTIONS,
  INFO_FUNCTIONS,
} from "../../../../shell/Ribbon/styles/constants";
import { InsertFunctionIcon, AutoSumIcon, RecentlyUsedIcon, FinancialIcon, LogicalIcon, TextIcon, DateTimeIcon, LookupIcon, MathTrigIcon, MoreFunctionsIcon } from "../icons";

interface FunctionLibraryGroupProps {
  context: RibbonContext;
}

// Styles
const functionLibraryGroupStyles: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "2px",
  maxWidth: "400px",
};

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

const buttonContainerStyles: React.CSSProperties = {
  position: "relative",
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

// Sub-components
interface FunctionDropdownProps {
  functions: FunctionDefinition[];
  onSelect: (func: FunctionDefinition) => void;
  onClose: () => void;
}

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
            (e.currentTarget as HTMLElement).style.backgroundColor =
              "transparent";
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

interface FormulaCategoryButtonProps {
  icon: React.ReactNode;
  label: string;
  functions: FunctionDefinition[];
  isDisabled: boolean;
  onInsertFunction: (functionName: string, syntax: string) => void;
}

function FormulaCategoryButton({
  icon,
  label,
  functions,
  isDisabled,
  onInsertFunction,
}: FormulaCategoryButtonProps): React.ReactElement {
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

/**
 * Function Library group content.
 */
export function FunctionLibraryGroup({
  context,
}: FunctionLibraryGroupProps): React.ReactElement {
  const { isDisabled, onInsertFunction } = context;
  const [isHoveredInsert, setIsHoveredInsert] = useState(false);

  const handleInsertFunction = useCallback(
    (functionName: string, syntax: string) => {
      if (onInsertFunction) {
        onInsertFunction(functionName, syntax);
      }
    },
    [onInsertFunction]
  );

  const handleDefaultInsert = useCallback(() => {
    if (!isDisabled && onInsertFunction) {
      onInsertFunction("SUM", "SUM(number1, [number2], ...)");
    }
  }, [isDisabled, onInsertFunction]);

  return (
    <div style={{ display: "flex", gap: "8px" }}>
      {/* Insert Function Button */}
      <button
        style={{
          ...insertFunctionButtonStyles,
          ...(isHoveredInsert && !isDisabled ? formulaButtonHoverStyles : {}),
          ...(isDisabled ? formulaButtonDisabledStyles : {}),
        }}
        onClick={handleDefaultInsert}
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

      {/* Category Buttons */}
      <div style={functionLibraryGroupStyles}>
        <FormulaCategoryButton
          icon={<AutoSumIcon />}
          label="AutoSum"
          functions={AUTOSUM_FUNCTIONS}
          isDisabled={isDisabled}
          onInsertFunction={handleInsertFunction}
        />
        <FormulaCategoryButton
          icon={<RecentlyUsedIcon />}
          label="Recent"
          functions={AUTOSUM_FUNCTIONS}
          isDisabled={isDisabled}
          onInsertFunction={handleInsertFunction}
        />
        <FormulaCategoryButton
          icon={<FinancialIcon />}
          label="Financial"
          functions={FINANCIAL_FUNCTIONS}
          isDisabled={isDisabled}
          onInsertFunction={handleInsertFunction}
        />
        <FormulaCategoryButton
          icon={<LogicalIcon />}
          label="Logical"
          functions={LOGICAL_FUNCTIONS}
          isDisabled={isDisabled}
          onInsertFunction={handleInsertFunction}
        />
        <FormulaCategoryButton
          icon={<TextIcon />}
          label="Text"
          functions={TEXT_FUNCTIONS}
          isDisabled={isDisabled}
          onInsertFunction={handleInsertFunction}
        />
        <FormulaCategoryButton
          icon={<DateTimeIcon />}
          label="Date & Time"
          functions={DATETIME_FUNCTIONS}
          isDisabled={isDisabled}
          onInsertFunction={handleInsertFunction}
        />
        <FormulaCategoryButton
          icon={<LookupIcon />}
          label="Lookup"
          functions={LOOKUP_FUNCTIONS}
          isDisabled={isDisabled}
          onInsertFunction={handleInsertFunction}
        />
        <FormulaCategoryButton
          icon={<MathTrigIcon />}
          label="Math & Trig"
          functions={MATH_FUNCTIONS}
          isDisabled={isDisabled}
          onInsertFunction={handleInsertFunction}
        />
        <FormulaCategoryButton
          icon={<MoreFunctionsIcon />}
          label="More"
          functions={INFO_FUNCTIONS}
          isDisabled={isDisabled}
          onInsertFunction={handleInsertFunction}
        />
      </div>
    </div>
  );
}