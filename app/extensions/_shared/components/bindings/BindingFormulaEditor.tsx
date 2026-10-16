//! FILENAME: app/extensions/_shared/components/bindings/BindingFormulaEditor.tsx
// PURPOSE: The formula editor of a property BINDING (D-BIND, WP-D S8a): the
//          text of `=...` that an object property follows, with formula
//          autocomplete, point mode (click a worksheet cell to insert its
//          reference), reference highlighting, an "Insert measure" menu fed by
//          the models of the object's page, and an inline line that says why
//          Rust would refuse the formula -- the sentence, never a toast.
// CONTEXT: LIFTED from Controls/PropertiesPane/FormulaPropertyInput.tsx (moved,
//          not copied: the Controls Properties pane imports it from here, and
//          so does every other pane that offers an fx button -- the shared
//          `BindableField`). It edits TEXT only: it never writes a binding
//          itself. The caller commits `(formula, model)` through
//          `@api/objectBindings.setBinding`.
//
//          LOCALE: the text is in the USER's locale (it is seeded from the
//          binding's `displayFormula`), and `analyzeBindingFormula` is asked
//          without `invariant`, exactly as the commit will be: Rust delocalises.
//
//          POINT MODE inserts the picked cell QUALIFIED with the sheet it was
//          picked on (`Data!B3`). The editor does not know which sheet the
//          object's unqualified references default to (Rust decides that at
//          bind time, and on a canvas page it is not the active sheet), so an
//          unqualified pick made on another sheet would silently read the
//          wrong cell. A qualified one reads exactly what the user pointed at.
//
//          Only WORKSHEET cells can be picked (`registerCellClickInterceptor`).
//          A floating grid's or a canvas pivot's cells are not offered in v1
//          (docs/design/canvas-sheets.md §15, open item).

import React, { useCallback, useEffect, useRef, useState } from "react";
import { registerCellClickInterceptor } from "@api/cellClickInterceptors";
import { isFormulaAutocompleteVisible, AutocompleteEvents } from "@api/formulaAutocomplete";
import { dispatchGridAction } from "@api/gridDispatch";
import { setFormulaReferences, clearFormulaReferences } from "@api/grid";
import { columnToLetter, parseFormulaReferences } from "@api/index";
import { getSheets } from "@api/lib";
import { quoteSheetNameForFormula } from "@api/externalEdit";
import {
  analyzeBindingFormula,
  listBindingMeasures,
  type BindingModelMeasures,
  type ObjectBindingRef,
} from "@api/objectBindings";

// ============================================================================
// Styles (theme-aware via CSS variables)
// ============================================================================

const v = (token: string) => `var(${token})`;

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "4px 7px",
  border: `1px solid ${v("--border-default")}`,
  borderRadius: 3,
  fontSize: 12,
  fontFamily: "Consolas, 'Courier New', monospace",
  outline: "none",
  boxSizing: "border-box",
  backgroundColor: v("--bg-surface"),
  color: v("--text-primary"),
};

const focusedStyle: React.CSSProperties = {
  borderColor: v("--accent-color"),
  boxShadow: `0 0 0 1px ${v("--accent-color")}`,
};

const measureSelectStyle: React.CSSProperties = {
  marginTop: 3,
  width: "100%",
  padding: "2px 4px",
  fontSize: 11,
  border: `1px solid ${v("--border-default")}`,
  borderRadius: 3,
  backgroundColor: v("--bg-surface"),
  color: v("--text-primary"),
  fontFamily: v("--font-family-sans"),
};

const refusalStyle: React.CSSProperties = {
  marginTop: 3,
  fontSize: 10,
  lineHeight: 1.35,
  color: v("--text-error, #a4262c"),
};

const warningStyle: React.CSSProperties = {
  marginTop: 3,
  fontSize: 10,
  lineHeight: 1.35,
  color: v("--text-secondary"),
};

/** How long the editor waits after the last keystroke before asking Rust. */
export const BINDING_ANALYSIS_DEBOUNCE_MS = 300;

/** How long a blur waits for a point-mode cell click before it commits. */
const BLUR_COMMIT_DELAY_MS = 200;

// ============================================================================
// Pure helpers (exported for the unit tier)
// ============================================================================

/** `text` with `insert` replacing the selection [start, end). */
export function spliceAt(
  text: string,
  start: number,
  end: number,
  insert: string,
): { value: string; cursor: number } {
  const s = Math.max(0, Math.min(start, text.length));
  const e = Math.max(s, Math.min(end, text.length));
  return { value: text.slice(0, s) + insert + text.slice(e), cursor: s + insert.length };
}

/** How a measure is spelled inside a binding formula: `[Name]`, with `]` doubled. */
export function measureToken(name: string): string {
  return `[${name.replace(/\]/g, "]]")}]`;
}

/** The value of a `<select>` option for one measure of one model. */
function measureOptionValue(modelKey: string, measure: string): string {
  return JSON.stringify([modelKey, measure]);
}

// ============================================================================
// Props
// ============================================================================

export interface BindingFormulaEditorProps {
  /** The bound object (the measure list and the analysis are asked about it). */
  object: ObjectBindingRef;
  /** The formula text, in the user's locale. */
  value: string;
  onChange: (value: string) => void;
  /** Enter, or a blur that no point-mode pick claimed. `model` is null for the page default. */
  onCommit: (value: string, model: string | null) => void;
  /** Escape. Absent: Escape commits, like Enter. */
  onCancel?: () => void;
  /** The binding's model key when it names one explicitly (null: the page default). */
  model?: string | null;
  placeholder?: string;
  /** A sentence: the editor is shown but cannot be edited. */
  disabledReason?: string;
  /** For tests and the E2E tier. */
  testId?: string;
}

// ============================================================================
// Component
// ============================================================================

export const BindingFormulaEditor: React.FC<BindingFormulaEditorProps> = ({
  object,
  value,
  onChange,
  onCommit,
  onCancel,
  model: initialModel = null,
  placeholder = "=",
  disabledReason,
  testId,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const measureSelectRef = useRef<HTMLSelectElement>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  const [model, setModel] = useState<string | null>(initialModel);
  const modelRef = useRef(model);
  modelRef.current = model;
  useEffect(() => {
    setModel(initialModel);
  }, [initialModel]);

  const [isFocused, setIsFocused] = useState(false);
  // An editing session survives the blur a cell click causes, so the cell
  // click interceptor can still insert the reference before the commit.
  const [isEditing, setIsEditing] = useState(false);
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The user typed (or picked, or inserted) something since the editor was
  // seeded. Only then is the formula worth analysing: the seeded text is the
  // stored binding, which Rust already accepted.
  const [dirty, setDirty] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const [models, setModels] = useState<BindingModelMeasures[]>([]);

  const disabled = disabledReason !== undefined && disabledReason !== "";
  const isFormulaValue = value.startsWith("=");
  const featuresActive = isEditing && isFormulaValue && !disabled;

  // ---------------------------------------------------
  // The models (and measures) a binding on this object's page may read.
  // ---------------------------------------------------
  useEffect(() => {
    let live = true;
    listBindingMeasures(object)
      .then((list) => {
        if (live) setModels(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        // No model on the page (or the object vanished): no measure menu.
        if (live) setModels([]);
      });
    return () => {
      live = false;
    };
  }, [object.kind, object.id]);

  // ---------------------------------------------------
  // The inline refusal line: Rust's own sentence, debounced.
  // ---------------------------------------------------
  useEffect(() => {
    if (!dirty || disabled) return;
    const text = value.trim();
    if (text === "" || text === "=") {
      setRefusal(null);
      setWarning(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      analyzeBindingFormula(object, text.startsWith("=") ? text : `=${text}`)
        .then((analysis) => {
          if (!live) return;
          setRefusal(analysis.error ?? null);
          setWarning(analysis.error ? null : (analysis.warning ?? null));
        })
        .catch((err: unknown) => {
          if (!live) return;
          const sentence =
            err && typeof err === "object" && "sentence" in err
              ? String((err as { sentence: unknown }).sentence)
              : String(err);
          setRefusal(sentence);
          setWarning(null);
        });
    }, BINDING_ANALYSIS_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [value, dirty, disabled, object.kind, object.id]);

  // ---------------------------------------------------
  // Point mode: a worksheet cell click inserts its qualified reference.
  // Registered while editing -- it survives the input's blur.
  // ---------------------------------------------------
  useEffect(() => {
    if (!featuresActive) return;
    const unregister = registerCellClickInterceptor(async (row: number, col: number) => {
      const input = inputRef.current;
      if (!input) return false;
      if (!valueRef.current.startsWith("=")) return false;

      // Synchronously, before any await: the click blurred the input, and
      // the blur's deferred commit must not win the race with this pick.
      if (blurTimerRef.current) {
        clearTimeout(blurTimerRef.current);
        blurTimerRef.current = null;
      }
      const focused = document.activeElement === input;
      const start = focused ? (input.selectionStart ?? valueRef.current.length) : valueRef.current.length;
      const end = focused ? (input.selectionEnd ?? start) : valueRef.current.length;

      let prefix = "";
      try {
        const sheets = await getSheets();
        const active = sheets.sheets.find((s) => s.index === sheets.activeIndex) ?? sheets.sheets[sheets.activeIndex];
        if (active?.name) prefix = `${quoteSheetNameForFormula(active.name)}!`;
      } catch {
        // No sheet list: insert the bare reference (Rust qualifies it with
        // the object's default sheet, and the analysis line says which).
      }
      const ref = `${prefix}${columnToLetter(col)}${row + 1}`;
      const next = spliceAt(valueRef.current, start, end, ref);
      setDirty(true);
      onChangeRef.current(next.value);
      requestAnimationFrame(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          inputRef.current.setSelectionRange(next.cursor, next.cursor);
        }
      });
      return true; // handled: the grid selection does not move
    });
    return () => {
      unregister();
    };
  }, [featuresActive]);

  // ---------------------------------------------------
  // Reference highlighting on the grid while editing.
  // ---------------------------------------------------
  useEffect(() => {
    if (!featuresActive) {
      dispatchGridAction(clearFormulaReferences());
      return;
    }
    dispatchGridAction(setFormulaReferences(parseFormulaReferences(value, false)));
    return () => {
      dispatchGridAction(clearFormulaReferences());
    };
  }, [featuresActive, value]);

  // ---------------------------------------------------
  // Autocomplete.
  // ---------------------------------------------------
  const emitAutocompleteInput = useCallback((newValue: string, cursorPos: number) => {
    if (!newValue.startsWith("=")) return;
    const input = inputRef.current;
    if (!input) return;
    const rect = input.getBoundingClientRect();
    window.dispatchEvent(
      new CustomEvent(AutocompleteEvents.INPUT, {
        detail: {
          value: newValue,
          cursorPosition: cursorPos,
          anchorRect: { x: rect.left, y: rect.bottom, width: rect.width, height: rect.height },
          source: "formulaBar" as const,
        },
      }),
    );
  }, []);

  useEffect(() => {
    if (!featuresActive) return;
    const handleAccepted = (e: Event) => {
      const { newValue, newCursorPosition } = (e as CustomEvent).detail;
      setDirty(true);
      onChangeRef.current(newValue);
      requestAnimationFrame(() => {
        if (inputRef.current) inputRef.current.setSelectionRange(newCursorPosition, newCursorPosition);
      });
    };
    window.addEventListener(AutocompleteEvents.ACCEPTED, handleAccepted);
    return () => window.removeEventListener(AutocompleteEvents.ACCEPTED, handleAccepted);
  }, [featuresActive]);

  useEffect(() => {
    return () => {
      if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
    };
  }, []);

  // ---------------------------------------------------
  // Handlers
  // ---------------------------------------------------
  const endEditing = useCallback(() => {
    setIsEditing(false);
    setIsFocused(false);
    window.dispatchEvent(new CustomEvent(AutocompleteEvents.DISMISS));
    dispatchGridAction(clearFormulaReferences());
  }, []);

  const commitAndEndEditing = useCallback(() => {
    endEditing();
    onCommitRef.current(valueRef.current, modelRef.current);
  }, [endEditing]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value;
      setDirty(true);
      onChange(newValue);
      if (newValue.startsWith("=") && !isEditing) setIsEditing(true);
      emitAutocompleteInput(newValue, e.target.selectionStart ?? newValue.length);
    },
    [onChange, emitAutocompleteInput, isEditing],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (isFormulaAutocompleteVisible()) {
        if (["ArrowUp", "ArrowDown", "Tab", "Enter", "Escape"].includes(e.key)) {
          e.preventDefault();
          e.stopPropagation();
          window.dispatchEvent(new CustomEvent(AutocompleteEvents.KEY, { detail: { key: e.key } }));
          return;
        }
      }
      if (e.key === "Enter") {
        e.preventDefault();
        commitAndEndEditing();
      } else if (e.key === "Escape") {
        e.preventDefault();
        if (onCancelRef.current) {
          endEditing();
          setDirty(false);
          setRefusal(null);
          setWarning(null);
          onCancelRef.current();
        } else {
          commitAndEndEditing();
        }
      }
    },
    [commitAndEndEditing, endEditing],
  );

  const handleFocus = useCallback(() => {
    if (blurTimerRef.current) {
      clearTimeout(blurTimerRef.current);
      blurTimerRef.current = null;
    }
    setIsFocused(true);
    if (valueRef.current.startsWith("=")) setIsEditing(true);
  }, []);

  const handleBlur = useCallback((e: React.FocusEvent<HTMLInputElement>) => {
    setIsFocused(false);
    // Focus moving to the "Insert measure" menu is part of this edit: the
    // menu's own blur (or its choice) decides what happens next.
    if (e.relatedTarget && e.relatedTarget === measureSelectRef.current) return;
    // A click on a cell blurs the input first; wait for the interceptor to
    // claim it (it cancels this timer and re-focuses) before committing.
    if (valueRef.current.startsWith("=") && isEditing) {
      blurTimerRef.current = setTimeout(() => {
        blurTimerRef.current = null;
        if (inputRef.current && document.activeElement !== inputRef.current) commitAndEndEditing();
      }, BLUR_COMMIT_DELAY_MS);
    } else {
      commitAndEndEditing();
    }
  }, [isEditing, commitAndEndEditing]);

  const handleInsertMeasure = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const raw = e.target.value;
      e.target.value = "";
      if (!raw) return;
      let modelKey: string;
      let measure: string;
      try {
        [modelKey, measure] = JSON.parse(raw) as [string, string];
      } catch {
        return;
      }
      const owner = models.find((m) => m.modelKey === modelKey);
      if (!owner) return;
      // The page default needs no model; any other model is named.
      setModel(owner.isDefault ? null : owner.modelKey);
      const input = inputRef.current;
      const empty = valueRef.current === "";
      const base = empty ? "=" : valueRef.current;
      const start = empty ? 1 : (input?.selectionStart ?? base.length);
      const end = empty ? 1 : (input?.selectionEnd ?? start);
      const next = spliceAt(base, start, end, measureToken(measure));
      setIsEditing(true);
      setDirty(true);
      onChangeRef.current(next.value);
      requestAnimationFrame(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          inputRef.current.setSelectionRange(next.cursor, next.cursor);
        }
      });
    },
    [models],
  );

  const style: React.CSSProperties = isFocused ? { ...inputStyle, ...focusedStyle } : inputStyle;
  const measureCount = models.reduce((n, m) => n + m.measures.length, 0);

  return (
    <div data-binding-formula-editor={testId ?? ""}>
      <input
        ref={inputRef}
        type="text"
        spellCheck={false}
        style={disabled ? { ...style, color: v("--text-secondary") } : style}
        value={value}
        readOnly={disabled}
        title={disabled ? disabledReason : undefined}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onFocus={handleFocus}
        onBlur={handleBlur}
        placeholder={placeholder}
        data-binding-formula-input=""
      />
      {measureCount > 0 && !disabled ? (
        <select
          style={measureSelectStyle}
          value=""
          aria-label="Insert measure"
          data-binding-insert-measure=""
          ref={measureSelectRef}
          onChange={handleInsertMeasure}
          // Leaving the menu for anywhere but the formula ends the edit, as
          // leaving the formula itself would have.
          onBlur={(e) => {
            if (e.relatedTarget !== inputRef.current) commitAndEndEditing();
          }}
        >
          <option value="">Insert measure...</option>
          {models.map((m) => (
            <optgroup key={m.modelKey} label={m.isDefault ? `${m.name} (this page)` : m.name}>
              {m.measures.map((name) => (
                <option key={name} value={measureOptionValue(m.modelKey, name)}>
                  {name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      ) : null}
      {refusal ? (
        <div style={refusalStyle} role="alert" data-binding-refusal="">
          {refusal}
        </div>
      ) : warning ? (
        <div style={warningStyle} data-binding-warning="">
          {warning}
        </div>
      ) : null}
    </div>
  );
};
