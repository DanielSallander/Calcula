//! FILENAME: app/extensions/_shared/components/bindings/BindableField.tsx
// PURPOSE: A property field with an "fx" switch (D-BIND, WP-D S8a). Off: the
//          caller's own LITERAL editor. On: the property follows a formula --
//          the `BindingFormulaEditor`, seeded with the binding's localised
//          formula, and under it what the binding resolves to right now (or
//          why it cannot).
// CONTEXT: The ONE fx widget every pane uses: the Controls Properties pane
//          today, WP-C's Format pane next. It writes through
//          `@api/objectBindings` only -- `setBinding` on commit, `clearBinding`
//          when fx is switched off or "Remove binding" is pressed -- and NEVER
//          writes the literal (that is the caller's `literal` editor, which
//          stays the literal's one door).
//
//          Rules it keeps:
//            * An unchanged commit is not a write (the BUG-0257 tab-through
//              rule): leaving the editor with the stored formula sends nothing.
//            * A refusal is shown INLINE as Rust's own sentence, never a toast.
//            * It never takes focus on mount (a pane opening must not steal
//              the grid's keyboard).
//            * Delete / Backspace typed inside it never reach a global key
//              listener: a Delete in the field deletes text, never the object
//              (the BUG-0125 precedent: the object's own Delete binding also
//              asks `isGridFocused()`, and this stops the bubble besides).
//            * The resolved value and the binding come from the seam's cache
//              and follow `onBindingsChanged`, so a script or the AI binding
//              the same property shows here at once.

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  BindingRefusal,
  clearBinding,
  getBinding,
  onBindingsChanged,
  setBinding,
  type ObjectBindingInfo,
  type ObjectBindingRef,
} from "@api/objectBindings";
import { BindingFormulaEditor } from "./BindingFormulaEditor";

// ============================================================================
// Styles (theme-aware via CSS variables)
// ============================================================================

const v = (token: string) => `var(${token})`;

const fieldRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 4,
};

const bodyStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
};

const fxButtonBase: React.CSSProperties = {
  flexShrink: 0,
  minWidth: 26,
  height: 24,
  padding: "0 4px",
  border: `1px solid ${v("--border-default")}`,
  borderRadius: 3,
  fontSize: 11,
  fontStyle: "italic",
  fontWeight: 600,
  fontFamily: "Cambria, Georgia, serif",
  cursor: "pointer",
  backgroundColor: v("--bg-surface"),
  color: v("--text-secondary"),
};

const fxButtonOn: React.CSSProperties = {
  borderColor: v("--accent-color"),
  color: v("--accent-color"),
  backgroundColor: v("--panel-bg"),
};

const resolvedStyle: React.CSSProperties = {
  marginTop: 3,
  fontSize: 10,
  lineHeight: 1.35,
  color: v("--text-secondary"),
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const errorStyle: React.CSSProperties = {
  ...resolvedStyle,
  whiteSpace: "normal",
  color: v("--text-error, #a4262c"),
};

const removeLinkStyle: React.CSSProperties = {
  marginTop: 2,
  padding: 0,
  border: "none",
  background: "transparent",
  fontSize: 10,
  color: v("--accent-color"),
  cursor: "pointer",
  textDecoration: "underline",
  fontFamily: v("--font-family-sans"),
};

// ============================================================================
// Pure helpers (exported for the unit tier)
// ============================================================================

/** The formula text to send for what the user committed, or null for "nothing to write". */
export function formulaToCommit(text: string): string | null {
  const t = text.trim();
  if (t === "" || t === "=") return null;
  return t.startsWith("=") ? t : `=${t}`;
}

/** Would committing (`text`, `model`) change nothing about `binding`? */
export function isUnchangedBinding(
  text: string,
  model: string | null,
  binding: ObjectBindingInfo | null,
): boolean {
  if (!binding) return false;
  const formula = formulaToCommit(text);
  return formula === binding.displayFormula && (model ?? null) === (binding.model ?? null);
}

/** What the line under a bound field says about its current value. */
export function describeResolved(binding: ObjectBindingInfo | null): { text: string; isError: boolean } | null {
  const r = binding?.resolved;
  if (!binding || !r) return binding ? { text: "Not calculated yet", isError: false } : null;
  if (r.pending) return { text: "Calculating...", isError: false };
  if (r.error) return { text: r.display ? `${r.display} - ${r.error}` : r.error, isError: true };
  return { text: `= ${r.display}`, isError: false };
}

function refusalText(err: unknown): string {
  if (err instanceof BindingRefusal) return err.sentence;
  if (err && typeof err === "object" && "sentence" in err) return String((err as { sentence: unknown }).sentence);
  if (err instanceof Error) return err.message;
  return String(err);
}

// ============================================================================
// Props
// ============================================================================

export interface BindableFieldProps {
  /** The object whose property this is (`bindingRefForRegion`, or the family's own lookup). */
  object: ObjectBindingRef;
  /** The JSON Pointer of the property (a catalog row, e.g. "/properties/text"). */
  path: string;
  /** What the pane calls it (used for the fx button's accessible name). */
  label: string;
  /** The caller's editor for the LITERAL value, shown while fx is off. */
  literal: React.ReactNode;
  /** A sentence: binding is not available here now (protection, Lock Objects...). */
  disabledReason?: string;
}

// ============================================================================
// Component
// ============================================================================

export const BindableField: React.FC<BindableFieldProps> = ({ object, path, label, literal, disabledReason }) => {
  const [binding, setBindingState] = useState<ObjectBindingInfo | null>(() => getBinding(object, path));
  // fx switched on by the user before any binding exists (nothing written yet).
  const [fxRequested, setFxRequested] = useState(false);
  const [text, setText] = useState<string>(() => getBinding(object, path)?.displayFormula ?? "=");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inflightRef = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const disabled = disabledReason !== undefined && disabledReason !== "";

  // Follow the seam's cache: this object's bindings or values changed, or the
  // whole set was reloaded (undo, File > Open, a script, the AI).
  useEffect(() => {
    const reread = () => {
      const next = getBinding(object, path);
      setBindingState(next);
      return next;
    };
    const seeded = reread();
    setText(seeded?.displayFormula ?? "=");
    setFxRequested(false);
    setRefusal(null);
    return onBindingsChanged((change) => {
      if (
        change.reload ||
        change.objects.some((o) => o.kind === object.kind && o.id === object.id)
      ) {
        const next = reread();
        // A formula changed elsewhere re-seeds an editor the user is not in.
        setText((current) => {
          const root = rootRef.current;
          const editing = root !== null && root.contains(document.activeElement);
          return editing ? current : (next?.displayFormula ?? current);
        });
      }
    });
  }, [object.kind, object.id, path]);

  const fxOn = binding !== null || fxRequested;

  const commit = useCallback(
    async (value: string, model: string | null) => {
      const formula = formulaToCommit(value);
      if (formula === null) {
        // An empty formula is not a binding; the stored one (if any) stays.
        setText(binding?.displayFormula ?? "=");
        return;
      }
      if (isUnchangedBinding(value, model, binding)) return;
      // Enter commits and the blur that follows commits again: the same
      // request already on its way is not a second write.
      const signature = JSON.stringify([formula, model ?? null]);
      if (inflightRef.current === signature) return;
      inflightRef.current = signature;
      setBusy(true);
      try {
        const stored = await setBinding(object, path, formula, {
          model: model ?? undefined,
          source: { kind: "user" },
        });
        setBindingState(stored);
        setText(stored.displayFormula);
        setFxRequested(false);
        setRefusal(null);
      } catch (err) {
        setRefusal(refusalText(err));
      } finally {
        inflightRef.current = null;
        setBusy(false);
      }
    },
    [object, path, binding],
  );

  const removeBinding = useCallback(async () => {
    setFxRequested(false);
    setRefusal(null);
    if (!binding) {
      setText("=");
      return;
    }
    setBusy(true);
    try {
      await clearBinding(object, path, { source: { kind: "user" } });
      setBindingState(getBinding(object, path));
      setText("=");
    } catch (err) {
      setRefusal(refusalText(err));
    } finally {
      setBusy(false);
    }
  }, [object, path, binding]);

  const toggleFx = useCallback(() => {
    if (disabled || busy) return;
    if (fxOn) {
      void removeBinding();
    } else {
      setFxRequested(true);
      setText("=");
      setRefusal(null);
    }
  }, [disabled, busy, fxOn, removeBinding]);

  const cancel = useCallback(() => {
    setRefusal(null);
    if (binding) {
      setText(binding.displayFormula);
    } else {
      setText("=");
      setFxRequested(false);
    }
  }, [binding]);

  // A Delete / Backspace inside the field edits text; it must never reach a
  // global key listener that would act on the selected OBJECT.
  const stopObjectKeys = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Delete" || e.key === "Backspace") e.stopPropagation();
  }, []);

  const resolved = fxOn && binding ? describeResolved(binding) : null;

  return (
    <div ref={rootRef} data-bindable-field={path} data-bound={binding ? "true" : "false"} onKeyDown={stopObjectKeys}>
      <div style={fieldRowStyle}>
        <div style={bodyStyle}>
          {fxOn ? (
            <BindingFormulaEditor
              object={object}
              value={text}
              model={binding?.model ?? null}
              onChange={(next) => {
                setText(next);
                if (refusal) setRefusal(null);
              }}
              onCommit={(value, model) => void commit(value, model)}
              onCancel={cancel}
              disabledReason={disabledReason}
              testId={path}
            />
          ) : (
            literal
          )}
        </div>
        <button
          type="button"
          style={fxOn ? { ...fxButtonBase, ...fxButtonOn } : fxButtonBase}
          aria-pressed={fxOn}
          aria-label={fxOn ? `Stop binding ${label} to a formula` : `Bind ${label} to a formula`}
          title={
            disabled
              ? disabledReason
              : fxOn
                ? "Follows a formula. Click to remove the binding and keep the value typed here."
                : "Bind to a formula (cells, names, measures)"
          }
          disabled={disabled || busy}
          data-bindable-fx=""
          onClick={toggleFx}
        >
          fx
        </button>
      </div>
      {refusal ? (
        <div style={errorStyle} role="alert" data-bindable-refusal="">
          {refusal}
        </div>
      ) : null}
      {resolved ? (
        <div
          style={resolved.isError ? errorStyle : resolvedStyle}
          title={resolved.text}
          data-bindable-resolved={resolved.isError ? "error" : "value"}
        >
          {resolved.text}
        </div>
      ) : null}
      {binding && !disabled ? (
        <button type="button" style={removeLinkStyle} data-bindable-remove="" disabled={busy} onClick={() => void removeBinding()}>
          Remove binding
        </button>
      ) : null}
    </div>
  );
};
