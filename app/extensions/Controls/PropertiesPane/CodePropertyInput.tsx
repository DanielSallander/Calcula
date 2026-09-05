//! FILENAME: app/extensions/Controls/PropertiesPane/CodePropertyInput.tsx
// PURPOSE: Inline code editor for control action properties (e.g., OnSelect).
// CONTEXT: Provides a textarea with autocomplete for Calcula script API functions
//          and custom script modules from the Script Editor.
//          Supports chaining commands with semicolons, like PowerApps.
//          A module that arrived in a .calp is suggested WITH its application:
//          the `Name()` this inserts runs the publisher's code as published, and
//          the suggestion says so before it is picked.

import React, { useState, useRef, useCallback, useEffect, useMemo } from "react";
import {
  describeScriptSuggestion,
  scriptEntryApplication,
  type ScriptPickerEntry,
} from "../../_shared/lib/scriptModuleProvenance";

// ============================================================================
// Types
// ============================================================================

export interface AutocompleteSuggestion {
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
  /** The application a script module arrived in; null for API entries and
   *  for the user's own modules. Rendered as a tag beside the signature. */
  application: string | null;
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
    application: null,
  },
  {
    label: "getCellValue",
    signature: "Calcula.getCellValue(row, col, sheetIndex?)",
    description: "Get the display value of a cell",
    kind: "api",
    insertText: "getCellValue(",
    application: null,
  },
  {
    label: "getRange",
    signature: "Calcula.getRange(startRow, startCol, endRow, endCol, sheetIndex?)",
    description: "Get a range of cell values (returns JSON)",
    kind: "api",
    insertText: "getRange(",
    application: null,
  },
  {
    label: "setRange",
    signature: "Calcula.setRange(startRow, startCol, valuesJson, sheetIndex?)",
    description: "Set a range of cell values",
    kind: "api",
    insertText: "setRange(",
    application: null,
  },
  {
    label: "getCellFormula",
    signature: "Calcula.getCellFormula(row, col, sheetIndex?)",
    description: "Get the formula of a cell",
    kind: "api",
    insertText: "getCellFormula(",
    application: null,
  },
  {
    label: "getActiveSheet",
    signature: "Calcula.getActiveSheet()",
    description: "Get active sheet info (returns JSON)",
    kind: "api",
    insertText: "getActiveSheet(",
    application: null,
  },
  {
    label: "getSheetNames",
    signature: "Calcula.getSheetNames()",
    description: "Get all sheet names (returns JSON)",
    kind: "api",
    insertText: "getSheetNames(",
    application: null,
  },
  {
    label: "setActiveSheet",
    signature: "Calcula.setActiveSheet(index)",
    description: "Switch the active sheet",
    kind: "api",
    insertText: "setActiveSheet(",
    application: null,
  },
  {
    label: "getSheetCount",
    signature: "Calcula.getSheetCount()",
    description: "Get the total number of sheets",
    kind: "api",
    insertText: "getSheetCount(",
    application: null,
  },
  {
    label: "log",
    signature: "Calcula.log(...args)",
    description: "Log a message to the script console",
    kind: "api",
    insertText: "log(",
    application: null,
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

/**
 * The autocomplete rows for the workbook's script modules.
 *
 * Pure, so the provenance a row shows can be pinned without driving the
 * textarea: a distributed module's row names its application and describes the
 * terms (published code, unchanged, only once approved) that the `Name()` it
 * inserts will run under — `planInlineButtonRun` runs exactly that stored
 * source and refuses everything else.
 */
export function buildScriptSuggestions(scripts: ScriptPickerEntry[]): AutocompleteSuggestion[] {
  // The rows must describe what the inserted `Name()` will DO, and the planner
  // (`planInlineButtonRun`) resolves a bare `Name()` by name with local-wins and
  // refuses a name two applications answer to. So: a distributed row whose
  // identifier a local module also answers to is NOT offered — inserting it
  // would run the user's own module while the row promised the publisher's —
  // and two same-named distributed rows collapse into ONE that says the name is
  // claimed by several applications and cannot be called by name at all.
  const localNames = new Set(
    scripts.filter((s) => !scriptEntryApplication(s)).map((s) => sanitizeScriptName(s.name)),
  );
  const rows: AutocompleteSuggestion[] = [];
  const distributedByName = new Map<string, ScriptPickerEntry[]>();
  for (const s of scripts) {
    const fnName = sanitizeScriptName(s.name);
    if (!scriptEntryApplication(s)) {
      rows.push({
        label: fnName,
        signature: `${fnName}()`,
        description: describeScriptSuggestion(s),
        kind: "script" as const,
        insertText: `${fnName}()`,
        application: null,
      });
      continue;
    }
    if (localNames.has(fnName)) continue;
    const group = distributedByName.get(fnName);
    if (group) group.push(s);
    else distributedByName.set(fnName, [s]);
  }
  for (const [fnName, group] of distributedByName) {
    if (group.length === 1) {
      rows.push({
        label: fnName,
        signature: `${fnName}()`,
        description: describeScriptSuggestion(group[0]),
        kind: "script" as const,
        insertText: `${fnName}()`,
        application: scriptEntryApplication(group[0]),
      });
      continue;
    }
    const apps = [...new Set(group.map((s) => scriptEntryApplication(s) ?? "")).values()]
      .filter((a) => a !== "")
      .sort();
    rows.push({
      label: fnName,
      signature: `${fnName}()`,
      description:
        `${group.length} script modules answer to ${fnName}() — from ` +
        apps.map((a) => `"${a}"`).join(" and ") +
        ". A button cannot call it by name: bind the button to one module directly, or rename one.",
      kind: "script" as const,
      insertText: `${fnName}()`,
      application: apps.join(" / "),
    });
  }
  return rows;
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

const applicationTagStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  fontFamily: "Segoe UI, Tahoma, sans-serif",
  color: "#5a4a00",
  background: "#fff8dc",
  border: "1px solid #e6d78a",
  borderRadius: 3,
  padding: "0 5px",
  whiteSpace: "nowrap",
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
  /** Every module the workbook lists, WITH its `sourcePackage` stamp. */
  scripts: ScriptPickerEntry[];
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
  const scriptSuggestions = useMemo<AutocompleteSuggestion[]>(
    () => buildScriptSuggestions(scripts),
    [scripts],
  );

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
              key={suggestion.label + suggestion.kind + (suggestion.application ?? "")}
              style={idx === selectedIndex ? autocompleteItemHighlightStyle : autocompleteItemStyle}
              data-script-suggestion={suggestion.kind === "script" ? suggestion.label : undefined}
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
                {suggestion.application !== null ? (
                  <span
                    style={applicationTagStyle}
                    data-script-suggestion-application={suggestion.application}
                  >
                    from application &quot;{suggestion.application}&quot;
                  </span>
                ) : null}
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
