//! FILENAME: app/extensions/Controls/PropertiesPane/CodePropertyInput.tsx
// PURPOSE: Inline code editor for control action properties (e.g., OnSelect).
// CONTEXT: Provides a textarea with autocomplete for Calcula script API functions
//          and custom script modules from the Script Editor.
//          Supports chaining commands with semicolons, like PowerApps.

import React, { useState, useRef, useCallback, useEffect, useMemo } from "react";

// ============================================================================
// Types
// ============================================================================

interface AutocompleteSuggestion {
  /** Display label (what gets inserted) */
  label: string;
  /** Full signature shown in the autocomplete list */
  signature: string;
  /** Brief description */
  description: string;
  /** "api" for Calcula.* functions, "script" for custom script modules */
  kind: "api" | "script";
  /** Text to insert when selected */
  insertText: string;
}

// ============================================================================
// Calcula API Definitions (for autocomplete)
// ============================================================================

const CALCULA_API_SUGGESTIONS: AutocompleteSuggestion[] = [
  {
    label: "setCellValue",
    signature: "Calcula.setCellValue(row, col, value, sheetIndex?)",
    description: "Set the value of a cell",
    kind: "api",
    insertText: "setCellValue(",
  },
  {
    label: "getCellValue",
    signature: "Calcula.getCellValue(row, col, sheetIndex?)",
    description: "Get the display value of a cell",
    kind: "api",
    insertText: "getCellValue(",
  },
  {
    label: "getRange",
    signature: "Calcula.getRange(startRow, startCol, endRow, endCol, sheetIndex?)",
    description: "Get a range of cell values (returns JSON)",
    kind: "api",
    insertText: "getRange(",
  },
  {
    label: "setRange",
    signature: "Calcula.setRange(startRow, startCol, valuesJson, sheetIndex?)",
    description: "Set a range of cell values",
    kind: "api",
    insertText: "setRange(",
  },
  {
    label: "getCellFormula",
    signature: "Calcula.getCellFormula(row, col, sheetIndex?)",
    description: "Get the formula of a cell",
    kind: "api",
    insertText: "getCellFormula(",
  },
  {
    label: "getActiveSheet",
    signature: "Calcula.getActiveSheet()",
    description: "Get active sheet info (returns JSON)",
    kind: "api",
    insertText: "getActiveSheet(",
  },
  {
    label: "getSheetNames",
    signature: "Calcula.getSheetNames()",
    description: "Get all sheet names (returns JSON)",
    kind: "api",
    insertText: "getSheetNames(",
  },
  {
    label: "setActiveSheet",
    signature: "Calcula.setActiveSheet(index)",
    description: "Switch the active sheet",
    kind: "api",
    insertText: "setActiveSheet(",
  },
  {
    label: "getSheetCount",
    signature: "Calcula.getSheetCount()",
    description: "Get the total number of sheets",
    kind: "api",
    insertText: "getSheetCount(",
  },
  {
    label: "log",
    signature: "Calcula.log(...args)",
    description: "Log a message to the script console",
    kind: "api",
    insertText: "log(",
  },
];

// ============================================================================
// Helpers
// ============================================================================

/**
 * Sanitize a script module name into a valid JavaScript identifier.
 * Replaces spaces and special chars with underscores, ensures it starts
 * with a letter or underscore.
 */
export function sanitizeScriptName(name: string): string {
  let sanitized = name.replace(/[^a-zA-Z0-9_]/g, "_");
  if (sanitized && /^[0-9]/.test(sanitized)) {
    sanitized = "_" + sanitized;
  }
  return sanitized || "_unnamed";
}

// ============================================================================
// Styles
// ============================================================================

const containerStyle: React.CSSProperties = {
  position: "relative",
  width: "100%",
};

const textareaStyle: React.CSSProperties = {
  width: "100%",
  minHeight: 60,
  maxHeight: 200,
  padding: "6px 8px",
  border: "1px solid #D0D0D0",
  borderRadius: 2,
  fontSize: 12,
  fontFamily: "Consolas, 'Courier New', monospace",
  lineHeight: "18px",
  resize: "vertical",
  outline: "none",
  boxSizing: "border-box",
  backgroundColor: "#FEFEFE",
  color: "#333",
  tabSize: 2,
};

const textareaFocusedStyle: React.CSSProperties = {
  ...textareaStyle,
  borderColor: "#0078D4",
  boxShadow: "0 0 0 1px #0078D4",
};

const autocompleteListStyle: React.CSSProperties = {
  position: "absolute",
  left: 0,
  right: 0,
  zIndex: 1000,
  backgroundColor: "#FFF",
  border: "1px solid #D0D0D0",
  borderRadius: 3,
  boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
  maxHeight: 200,
  overflowY: "auto",
  fontSize: 12,
  fontFamily: "Consolas, 'Courier New', monospace",
};

const autocompleteItemStyle: React.CSSProperties = {
  padding: "5px 8px",
  cursor: "pointer",
  display: "flex",
  flexDirection: "column",
  gap: 1,
  borderBottom: "1px solid #F0F0F0",
};

const autocompleteItemHighlightStyle: React.CSSProperties = {
  ...autocompleteItemStyle,
  backgroundColor: "#E8F0FE",
};

const signatureStyle: React.CSSProperties = {
  color: "#0078D4",
  fontWeight: 600,
  fontSize: 11,
};

const scriptSignatureStyle: React.CSSProperties = {
  color: "#7B3FA0",
  fontWeight: 600,
  fontSize: 11,
};

const descriptionStyle: React.CSSProperties = {
  color: "#888",
  fontSize: 10,
  fontFamily: "Segoe UI, Tahoma, sans-serif",
};

const kindBadgeStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
};

const hintStyle: React.CSSProperties = {
  fontSize: 10,
  color: "#999",
  fontFamily: "Segoe UI, Tahoma, sans-serif",
  padding: "2px 0",
  lineHeight: "14px",
};

// ============================================================================
// Props
// ============================================================================

interface CodePropertyInputProps {
  value: string;
  onChange: (value: string) => void;
  onCommit: (value: string) => void;
  scripts: Array<{ id: string; name: string }>;
  placeholder?: string;
}

// ============================================================================
// Component
// ============================================================================

export const CodePropertyInput: React.FC<CodePropertyInputProps> = ({
  value,
  onChange,
  onCommit,
  scripts,
  placeholder,
}) => {
  const [focused, setFocused] = useState(false);
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [filteredSuggestions, setFilteredSuggestions] = useState<AutocompleteSuggestion[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const autocompleteRef = useRef<HTMLDivElement>(null);

  // Build script suggestions from the scripts prop
  const scriptSuggestions = useMemo<AutocompleteSuggestion[]>(() => {
    return scripts.map((s) => {
      const fnName = sanitizeScriptName(s.name);
      return {
        label: fnName,
        signature: `${fnName}()`,
        description: `Run script module "${s.name}"`,
        kind: "script" as const,
        insertText: `${fnName}()`,
      };
    });
  }, [scripts]);

  // Determine autocomplete context based on cursor position
  const getAutocompleteContext = useCallback((): {
    mode: "api" | "toplevel" | "none";
    filter: string;
    replaceStart: number;
    replaceEnd: number;
  } => {
    const el = textareaRef.current;
    if (!el) return { mode: "none", filter: "", replaceStart: 0, replaceEnd: 0 };

    const cursorPos = el.selectionStart;
    const textBeforeCursor = value.slice(0, cursorPos);

    // Mode 1: After "Calcula." → show API functions
    const apiMatch = textBeforeCursor.match(/Calcula\.(\w*)$/);
    if (apiMatch) {
      return {
        mode: "api",
        filter: apiMatch[1].toLowerCase(),
        replaceStart: cursorPos - apiMatch[1].length,
        replaceEnd: cursorPos,
      };
    }

    // Mode 2: At a word boundary (start of line, after ;, after space/newline)
    // → show custom script functions
    const wordMatch = textBeforeCursor.match(/(?:^|[;\s\n])(\w+)$/);
    if (wordMatch && wordMatch[1].length >= 1) {
      const partial = wordMatch[1];
      return {
        mode: "toplevel",
        filter: partial.toLowerCase(),
        replaceStart: cursorPos - partial.length,
        replaceEnd: cursorPos,
      };
    }

    return { mode: "none", filter: "", replaceStart: 0, replaceEnd: 0 };
  }, [value]);

  // Update autocomplete on value or cursor change
  const updateAutocomplete = useCallback(() => {
    const ctx = getAutocompleteContext();

    if (ctx.mode === "api") {
      // Show Calcula API functions
      const filtered = CALCULA_API_SUGGESTIONS.filter(
        (fn) => fn.label.toLowerCase().startsWith(ctx.filter),
      );
      setFilteredSuggestions(filtered);
      setShowAutocomplete(filtered.length > 0);
      setSelectedIndex(0);
    } else if (ctx.mode === "toplevel" && scriptSuggestions.length > 0) {
      // Show custom script modules (match by partial name)
      const filtered = scriptSuggestions.filter(
        (fn) => fn.label.toLowerCase().startsWith(ctx.filter),
      );
      setFilteredSuggestions(filtered);
      setShowAutocomplete(filtered.length > 0);
      setSelectedIndex(0);
    } else {
      setShowAutocomplete(false);
    }
  }, [getAutocompleteContext, scriptSuggestions]);

  // Insert a selected autocomplete suggestion
  const insertSuggestion = useCallback(
    (suggestion: AutocompleteSuggestion) => {
      const el = textareaRef.current;
      if (!el) return;

      const ctx = getAutocompleteContext();
      if (ctx.mode === "none") return;

      const textAfterCursor = value.slice(ctx.replaceEnd);
      let newValue: string;
      let newCursorPos: number;

      if (ctx.mode === "api") {
        // Insert API function name after "Calcula."
        const insertion = suggestion.insertText;
        newValue = value.slice(0, ctx.replaceStart) + insertion + textAfterCursor;
        newCursorPos = ctx.replaceStart + insertion.length;
      } else {
        // Insert script function call, replacing the partial word
        const insertion = suggestion.insertText;
        newValue = value.slice(0, ctx.replaceStart) + insertion + textAfterCursor;
        // Place cursor at end of insertion (after the "()")
        newCursorPos = ctx.replaceStart + insertion.length;
      }

      onChange(newValue);
      setShowAutocomplete(false);

      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(newCursorPos, newCursorPos);
      });
    },
    [value, onChange, getAutocompleteContext],
  );

  // Handle textarea input changes
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onChange(e.target.value);
    },
    [onChange],
  );

  // Update autocomplete whenever value changes while focused
  useEffect(() => {
    if (focused) {
      const timer = setTimeout(updateAutocomplete, 30);
      return () => clearTimeout(timer);
    }
  }, [value, focused, updateAutocomplete]);

  // Handle keyboard navigation in autocomplete
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (showAutocomplete && filteredSuggestions.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSelectedIndex((prev) => Math.min(prev + 1, filteredSuggestions.length - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSelectedIndex((prev) => Math.max(prev - 1, 0));
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          insertSuggestion(filteredSuggestions[selectedIndex]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setShowAutocomplete(false);
          return;
        }
      }

      // Tab inserts 2 spaces when autocomplete is not shown
      if (e.key === "Tab" && !showAutocomplete) {
        e.preventDefault();
        const el = textareaRef.current;
        if (el) {
          const start = el.selectionStart;
          const end = el.selectionEnd;
          const newValue = value.slice(0, start) + "  " + value.slice(end);
          onChange(newValue);
          requestAnimationFrame(() => {
            el.setSelectionRange(start + 2, start + 2);
          });
        }
      }
    },
    [showAutocomplete, filteredSuggestions, selectedIndex, insertSuggestion, value, onChange],
  );

  const handleFocus = useCallback(() => {
    setFocused(true);
  }, []);

  const handleBlur = useCallback(() => {
    // Delay to allow clicks on the autocomplete list
    setTimeout(() => {
      setFocused(false);
      setShowAutocomplete(false);
      onCommit(value);
    }, 150);
  }, [value, onCommit]);

  // Handle cursor position changes (click, arrow keys)
  const handleSelect = useCallback(() => {
    if (focused) {
      updateAutocomplete();
    }
  }, [focused, updateAutocomplete]);

  return (
    <div style={containerStyle}>
      <textarea
        ref={textareaRef}
        style={focused ? textareaFocusedStyle : textareaStyle}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onSelect={handleSelect}
        placeholder={placeholder || 'Calcula.setCellValue(0, 0, "Hello")'}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
      />

      {/* Autocomplete dropdown */}
      {showAutocomplete && filteredSuggestions.length > 0 && (
        <div ref={autocompleteRef} style={autocompleteListStyle}>
          {filteredSuggestions.map((suggestion, idx) => (
            <div
              key={suggestion.label + suggestion.kind}
              style={idx === selectedIndex ? autocompleteItemHighlightStyle : autocompleteItemStyle}
              onMouseDown={(e) => {
                e.preventDefault();
                insertSuggestion(suggestion);
              }}
              onMouseEnter={() => setSelectedIndex(idx)}
            >
              <span style={kindBadgeStyle}>
                <span style={suggestion.kind === "api" ? signatureStyle : scriptSignatureStyle}>
                  {suggestion.signature}
                </span>
              </span>
              <span style={descriptionStyle}>{suggestion.description}</span>
            </div>
          ))}
        </div>
      )}

      {/* Hint text */}
      {!value && !focused && (
        <div style={hintStyle}>
          Type Calcula. for API functions{scripts.length > 0 ? " or script names" : ""}. Chain with semicolons.
        </div>
      )}
    </div>
  );
};
