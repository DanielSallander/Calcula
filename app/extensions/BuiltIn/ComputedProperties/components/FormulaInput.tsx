//! FILENAME: app/extensions/BuiltIn/ComputedProperties/components/FormulaInput.tsx
// PURPOSE: Inline formula editor with cell-click reference insertion and autocomplete.
// CONTEXT: Used inside the Computed Properties dialog. Supports collapsed-mode editing
//          where the grid is interactive and clicking a cell inserts a reference.

import React, { useRef, useCallback, useEffect, useState } from "react";
import {
  registerCellClickInterceptor,
} from "../../../../src/api/cellClickInterceptors";
import {
  isFormulaAutocompleteVisible,
  AutocompleteEvents,
} from "../../../../src/api/formulaAutocomplete";
import { dispatchGridAction } from "../../../../src/api/gridDispatch";
import {
  setFormulaReferences,
  clearFormulaReferences,
} from "../../../../src/api/grid";
import { columnToLetter } from "../../../../src/api/types";
import { parseFormulaReferences } from "../../../../src/api/index";

// ============================================================================
// Types
// ============================================================================

interface FormulaInputProps {
  value: string;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  /** Called when focus state changes — parent uses this for collapsed mode */
  onFocusChange?: (focused: boolean) => void;
  placeholder?: string;
  autoFocus?: boolean;
  /**
   * When true, the cell click interceptor is always registered (independent
   * of focus state). Use this in collapsed mode where the grid must remain
   * interactive for reference insertion even though the input may briefly
   * lose focus during a click.
   */
  cellClickEnabled?: boolean;
  /**
   * When false, blur does NOT trigger commit or onFocusChange(false).
   * Use this in collapsed mode where only Enter/OK/Escape/Cancel should
   * commit or cancel the edit.
   */
  commitOnBlur?: boolean;
}

// ============================================================================
// Component
// ============================================================================

export function FormulaInput({
  value,
  onChange,
  onCommit,
  onCancel,
  onFocusChange,
  placeholder = "=formula...",
  autoFocus = false,
  cellClickEnabled = false,
  commitOnBlur = true,
}: FormulaInputProps): React.ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isFocused, setIsFocused] = useState(false);

  // Use a ref for the latest value so the interceptor closure always sees it
  const valueRef = useRef(value);
  valueRef.current = value;

  // Use a ref for onChange so the interceptor closure doesn't go stale
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Whether the interceptor should be active
  const interceptorActive = cellClickEnabled || isFocused;

  // Whether formula features (highlighting, autocomplete) should be active
  const featuresActive = cellClickEnabled || isFocused;

  // ---------------------------------------------------
  // Cell click interceptor: insert cell reference
  // ---------------------------------------------------
  useEffect(() => {
    if (!interceptorActive) return;

    const unregister = registerCellClickInterceptor(
      async (row: number, col: number) => {
        const input = inputRef.current;
        if (!input) return false;

        // Only intercept if value looks like a formula
        const currentValue = valueRef.current;
        if (!currentValue.startsWith("=")) return false;

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

        return true; // handled — prevent default selection
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
    if (!featuresActive || !value.startsWith("=")) {
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
  // Handlers
  // ---------------------------------------------------
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value;
      onChange(newValue);
      emitAutocompleteInput(
        newValue,
        e.target.selectionStart ?? newValue.length,
      );
    },
    [onChange, emitAutocompleteInput],
  );

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
        onCommit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    },
    [onCommit, onCancel],
  );

  const handleFocus = useCallback(() => {
    setIsFocused(true);
    onFocusChange?.(true);
  }, [onFocusChange]);

  const handleBlur = useCallback(
    (e: React.FocusEvent<HTMLInputElement>) => {
      // Don't blur if clicking within the same dialog (e.g., OK/Cancel buttons)
      const related = e.relatedTarget as HTMLElement | null;
      if (related && related.closest("[data-computed-props-dialog]")) {
        return;
      }

      // In cell-click mode (collapsed), don't commit or exit on blur.
      // The user is clicking cells to insert references — the input will
      // be re-focused by the interceptor shortly.
      if (!commitOnBlur) {
        return;
      }

      // Dismiss autocomplete on blur
      window.dispatchEvent(new CustomEvent(AutocompleteEvents.DISMISS));

      setIsFocused(false);
      onFocusChange?.(false);
      onCommit();
    },
    [onFocusChange, onCommit, commitOnBlur],
  );

  // Auto-focus
  useEffect(() => {
    if (autoFocus && inputRef.current) {
      inputRef.current.focus();
    }
  }, [autoFocus]);

  return (
    <input
      ref={inputRef}
      type="text"
      value={value}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      onFocus={handleFocus}
      onBlur={handleBlur}
      placeholder={placeholder}
      style={{
        padding: "4px 6px",
        fontSize: 12,
        fontFamily: "monospace",
        border: `1px solid ${isFocused || cellClickEnabled ? "var(--accent-color, #0078d4)" : "var(--border-color, #ccc)"}`,
        borderRadius: 3,
        backgroundColor: "var(--bg-primary, #fff)",
        color: "var(--text-primary, #333)",
        outline: "none",
        width: "100%",
        boxSizing: "border-box",
      }}
    />
  );
}
