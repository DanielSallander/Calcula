//! FILENAME: app/extensions/Controls/PropertiesPane/FormulaPropertyInput.tsx
// PURPOSE: Smart input for control properties. Auto-activates formula features
//          (autocomplete, Point mode, reference highlighting) when value starts with "=".
// CONTEXT: Used by PropertyRow for all properties that support formulas.

import React, { useRef, useCallback, useEffect, useState } from "react";
import {
  registerCellClickInterceptor,
} from "../../../src/api/cellClickInterceptors";
import {
  isFormulaAutocompleteVisible,
  AutocompleteEvents,
} from "../../../src/api/formulaAutocomplete";
import { dispatchGridAction } from "../../../src/api/gridDispatch";
import {
  setFormulaReferences,
  clearFormulaReferences,
} from "../../../src/api/grid";
import {
  columnToLetter,
  parseFormulaReferences,
} from "../../../src/api/index";

// ============================================================================
// Styles
// ============================================================================

const baseInputStyle: React.CSSProperties = {
  width: "100%",
  padding: "3px 6px",
  border: "1px solid #D0D0D0",
  borderRadius: 2,
  fontSize: 12,
  fontFamily: "Segoe UI, Tahoma, sans-serif",
  backgroundColor: "#FFFFFF",
  color: "#000000",
  outline: "none",
  boxSizing: "border-box",
};

const formulaInputStyle: React.CSSProperties = {
  ...baseInputStyle,
  fontFamily: "Consolas, 'Courier New', monospace",
};

const focusedStyle: React.CSSProperties = {
  borderColor: "#0078d4",
  boxShadow: "0 0 0 1px #0078d4",
};

// ============================================================================
// Props
// ============================================================================

interface FormulaPropertyInputProps {
  value: string;
  onChange: (value: string) => void;
  onCommit: (value: string) => void;
  /** The property's base input type (text, number, color). Used for styling. */
  inputType?: string;
  placeholder?: string;
}

// ============================================================================
// Component
// ============================================================================

export const FormulaPropertyInput: React.FC<FormulaPropertyInputProps> = ({
  value,
  onChange,
  onCommit,
  inputType,
  placeholder = "",
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  const [isFocused, setIsFocused] = useState(false);

  // Track active formula editing session. Survives blur so that clicking
  // a cell (which blurs the input) can still insert a reference via the
  // cell click interceptor before we commit.
  const [isEditing, setIsEditing] = useState(false);

  // Timer for deferred commit on blur
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Determine if formula features should be active
  const isFormulaValue = value.startsWith("=");
  const interceptorActive = isEditing && isFormulaValue;
  const featuresActive = isEditing && isFormulaValue;

  // ---------------------------------------------------
  // Cell click interceptor: insert cell reference (Point mode)
  // Registered while isEditing is true — survives input blur.
  // ---------------------------------------------------
  useEffect(() => {
    if (!interceptorActive) return;

    const unregister = registerCellClickInterceptor(
      async (row: number, col: number) => {
        const input = inputRef.current;
        if (!input) return false;

        const currentValue = valueRef.current;
        if (!currentValue.startsWith("=")) return false;

        // Cancel any pending blur-commit since we're inserting a reference
        if (blurTimerRef.current) {
          clearTimeout(blurTimerRef.current);
          blurTimerRef.current = null;
        }

        // Build reference string
        const cellRef = `${columnToLetter(col)}${row + 1}`;

        // Insert at cursor position (use end of string if input isn't focused)
        const cursor = document.activeElement === input
          ? (input.selectionStart ?? currentValue.length)
          : currentValue.length;
        const selEnd = document.activeElement === input
          ? (input.selectionEnd ?? cursor)
          : currentValue.length;
        const before = currentValue.substring(0, cursor);
        const after = currentValue.substring(selEnd);
        const newValue = before + cellRef + after;
        const newCursor = cursor + cellRef.length;

        onChangeRef.current(newValue);

        // Re-focus the input and restore cursor position
        requestAnimationFrame(() => {
          if (inputRef.current) {
            inputRef.current.focus();
            inputRef.current.setSelectionRange(newCursor, newCursor);
          }
        });

        return true; // handled - prevent default selection
      },
    );

    return () => {
      unregister();
    };
  }, [interceptorActive]);

  // ---------------------------------------------------
  // Formula reference highlighting
  // ---------------------------------------------------
  useEffect(() => {
    if (!featuresActive) {
      dispatchGridAction(clearFormulaReferences());
      return;
    }

    const refs = parseFormulaReferences(value, false);
    dispatchGridAction(setFormulaReferences(refs));

    return () => {
      dispatchGridAction(clearFormulaReferences());
    };
  }, [featuresActive, value]);

  // ---------------------------------------------------
  // Autocomplete: emit input event on change
  // ---------------------------------------------------
  const emitAutocompleteInput = useCallback(
    (newValue: string, cursorPos: number) => {
      if (!newValue.startsWith("=")) return;

      const input = inputRef.current;
      if (!input) return;

      const rect = input.getBoundingClientRect();
      window.dispatchEvent(
        new CustomEvent(AutocompleteEvents.INPUT, {
          detail: {
            value: newValue,
            cursorPosition: cursorPos,
            anchorRect: {
              x: rect.left,
              y: rect.bottom,
              width: rect.width,
              height: rect.height,
            },
            source: "formulaBar" as const,
          },
        }),
      );
    },
    [],
  );

  // ---------------------------------------------------
  // Autocomplete: listen for acceptance
  // ---------------------------------------------------
  useEffect(() => {
    if (!featuresActive) return;

    const handleAccepted = (e: Event) => {
      const { newValue, newCursorPosition } = (e as CustomEvent).detail;
      onChangeRef.current(newValue);
      requestAnimationFrame(() => {
        if (inputRef.current) {
          inputRef.current.setSelectionRange(
            newCursorPosition,
            newCursorPosition,
          );
        }
      });
    };

    window.addEventListener(AutocompleteEvents.ACCEPTED, handleAccepted);
    return () =>
      window.removeEventListener(AutocompleteEvents.ACCEPTED, handleAccepted);
  }, [featuresActive]);

  // ---------------------------------------------------
  // Cleanup blur timer on unmount
  // ---------------------------------------------------
  useEffect(() => {
    return () => {
      if (blurTimerRef.current) {
        clearTimeout(blurTimerRef.current);
      }
    };
  }, []);

  // ---------------------------------------------------
  // Handlers
  // ---------------------------------------------------
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value;
      onChange(newValue);

      // Start editing session if user types "=" at the beginning
      if (newValue.startsWith("=") && !isEditing) {
        setIsEditing(true);
      }

      emitAutocompleteInput(
        newValue,
        e.target.selectionStart ?? newValue.length,
      );
    },
    [onChange, emitAutocompleteInput, isEditing],
  );

  const commitAndEndEditing = useCallback(() => {
    setIsEditing(false);
    setIsFocused(false);
    window.dispatchEvent(new CustomEvent(AutocompleteEvents.DISMISS));
    dispatchGridAction(clearFormulaReferences());
    onCommitRef.current(valueRef.current);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // Intercept autocomplete keys when dropdown is visible
      if (isFormulaAutocompleteVisible()) {
        const autocompleteKeys = [
          "ArrowUp",
          "ArrowDown",
          "Tab",
          "Enter",
          "Escape",
        ];
        if (autocompleteKeys.includes(e.key)) {
          e.preventDefault();
          e.stopPropagation();
          window.dispatchEvent(
            new CustomEvent(AutocompleteEvents.KEY, {
              detail: { key: e.key },
            }),
          );
          return;
        }
      }

      if (e.key === "Enter") {
        e.preventDefault();
        commitAndEndEditing();
      } else if (e.key === "Escape") {
        e.preventDefault();
        commitAndEndEditing();
      }
    },
    [commitAndEndEditing],
  );

  const handleFocus = useCallback(() => {
    // Cancel any pending blur-commit (user clicked back into the input)
    if (blurTimerRef.current) {
      clearTimeout(blurTimerRef.current);
      blurTimerRef.current = null;
    }
    setIsFocused(true);
    // If value already starts with "=", start editing session immediately
    if (valueRef.current.startsWith("=")) {
      setIsEditing(true);
    }
  }, []);

  const handleBlur = useCallback(() => {
    setIsFocused(false);

    // If the value is a formula and we're editing, the user might be clicking
    // a cell to insert a reference. Use a short delay to let the cell click
    // interceptor fire first. If the interceptor fires, it cancels this timer
    // and re-focuses the input.
    if (valueRef.current.startsWith("=") && isEditing) {
      blurTimerRef.current = setTimeout(() => {
        blurTimerRef.current = null;
        // If we weren't re-focused by the interceptor, commit
        if (inputRef.current && document.activeElement !== inputRef.current) {
          commitAndEndEditing();
        }
      }, 200);
    } else {
      // Not a formula — commit immediately
      commitAndEndEditing();
    }
  }, [isEditing, commitAndEndEditing]);

  // ---------------------------------------------------
  // Styling: monospace for formulas, normal for static values
  // ---------------------------------------------------
  const baseStyle = isFormulaValue ? formulaInputStyle : baseInputStyle;
  const style: React.CSSProperties = isFocused
    ? { ...baseStyle, ...focusedStyle }
    : baseStyle;

  return (
    <input
      ref={inputRef}
      type="text"
      style={style}
      value={value}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      onFocus={handleFocus}
      onBlur={handleBlur}
      placeholder={placeholder}
    />
  );
};
