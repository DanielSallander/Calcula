//! FILENAME: app/extensions/BuiltIn/BoundProperties/BoundPropertiesDialog.tsx
// PURPOSE: The "Bound Properties" view (D §3.21): a modeless dialog listing
//          EVERY property of every object in the workbook that follows a
//          formula -- Object, Property, Formula, Value -- with Go to, Edit and
//          Remove on each row.
// CONTEXT: Formulas > Bound Properties... (command
//          `objectBindings.showBoundProperties`). Movable and resizable like
//          Code in This File; the grid stays usable behind it, so Go to can
//          take the user to the object while the list stays open. Every write
//          goes through `@api/objectBindings` as a USER edit: Rust applies the
//          family's gates and records one undo step per change.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { css } from "@emotion/css";
import type { DialogProps } from "@api";
import { useDialogWindow } from "@api/dialogWindow";
import { FONT_FAMILY, IconButton, LT } from "@api/layout";
import { RibbonIcon } from "@api/ribbonIcons";
import {
  BindingRefusal,
  clearBinding,
  listBindings,
  locateBoundObjects,
  onBindingsChanged,
  setBinding,
  type ObjectBindingInfo,
  type ObjectBindingPlace,
} from "@api/objectBindings";
import { BindingFormulaEditor, formulaToCommit, isUnchangedBinding } from "../../_shared/components/bindings";
import {
  buildBoundPropertyRows,
  distinctObjects,
  goToBoundObject,
  valueText,
  type BoundPropertyRow,
} from "./lib/boundPropertyRows";

// ============================================================================
// Styles (the theme tokens; Code in This File's frame)
// ============================================================================

const containerClass = css`
  position: fixed;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  z-index: 1051;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  max-width: 95vw;
  max-height: 88vh;
  background: ${LT.panel};
  border: 1px solid ${LT.border};
  border-radius: 8px;
  box-shadow: ${LT.shadowPopover};
  color: ${LT.text};
  font-family: ${FONT_FAMILY};
`;

const headerClass = css`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 10px 10px 16px;
  flex-shrink: 0;
  cursor: grab;
  user-select: none;
  border-bottom: 1px solid ${LT.border};

  &:active {
    cursor: grabbing;
  }
`;

const titleClass = css`
  flex: 1;
  min-width: 0;
  font-size: 15px;
  font-weight: 600;
`;

const introClass = css`
  padding: 8px 16px 0;
  font-size: 12px;
  color: ${LT.textSecondary};
  flex-shrink: 0;
`;

const bodyClass = css`
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px 12px 12px;
`;

const tableClass = css`
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;

  & th {
    text-align: left;
    font-weight: 600;
    padding: 4px 6px;
    border-bottom: 1px solid ${LT.border};
    position: sticky;
    top: 0;
    background: ${LT.panel};
  }

  & td {
    padding: 4px 6px;
    border-bottom: 1px solid ${LT.border};
    vertical-align: top;
  }
`;

const formulaClass = css`
  font-family: Consolas, "Courier New", monospace;
  word-break: break-all;
`;

const errorClass = css`
  color: var(--text-error, #a4262c);
`;

const actionsClass = css`
  white-space: nowrap;

  & button {
    font: inherit;
    font-size: 12px;
    margin-right: 4px;
    padding: 2px 8px;
    border: 1px solid ${LT.border};
    border-radius: 3px;
    background: ${LT.panel};
    color: ${LT.text};
    cursor: pointer;
  }

  & button:disabled {
    opacity: 0.4;
    cursor: default;
  }
`;

const emptyClass = css`
  padding: 24px 8px;
  font-size: 12px;
  color: ${LT.textSecondary};
`;

// ============================================================================
// Data
// ============================================================================

/** The bindings the seam holds, plus where their objects are (asked of Rust). */
function useBoundPropertyRows(): { rows: BoundPropertyRow[]; refresh: () => void } {
  const [bindings, setBindings] = useState<ObjectBindingInfo[]>(() => listBindings());
  const [places, setPlaces] = useState<ObjectBindingPlace[]>([]);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => onBindingsChanged(() => setTick((t) => t + 1)), []);

  useEffect(() => {
    let live = true;
    const current = listBindings();
    setBindings(current);
    if (current.length === 0) {
      setPlaces([]);
      return;
    }
    locateBoundObjects(distinctObjects(current))
      .then((found) => {
        if (live) setPlaces(found);
      })
      .catch((err) => {
        // A failed read is not "every object is gone": keep what was known.
        console.warn("[BoundProperties] Could not locate the bound objects:", err);
      });
    return () => {
      live = false;
    };
  }, [tick]);

  const rows = useMemo(() => buildBoundPropertyRows(bindings, places), [bindings, places]);
  return { rows, refresh };
}

function sentenceOf(err: unknown): string {
  if (err instanceof BindingRefusal) return err.sentence;
  if (err instanceof Error) return err.message;
  return String(err);
}

// ============================================================================
// One row
// ============================================================================

interface RowProps {
  row: BoundPropertyRow;
  onError: (sentence: string | null) => void;
  onChanged: () => void;
}

function BoundPropertyRowView({ row, onError, onChanged }: RowProps): React.ReactElement {
  const { binding, place } = row;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(binding.displayFormula);
  const [busy, setBusy] = useState(false);
  const value = valueText(binding);

  useEffect(() => {
    if (!editing) setText(binding.displayFormula);
  }, [binding.displayFormula, editing]);

  const commit = useCallback(
    async (next: string, model: string | null) => {
      const formula = formulaToCommit(next);
      if (formula === null || isUnchangedBinding(next, model, binding)) {
        setEditing(false);
        setText(binding.displayFormula);
        return;
      }
      setBusy(true);
      try {
        await setBinding(binding.object, binding.path, formula, {
          model: model ?? undefined,
          source: { kind: "user" },
        });
        onError(null);
        setEditing(false);
        onChanged();
      } catch (err) {
        onError(sentenceOf(err));
      } finally {
        setBusy(false);
      }
    },
    [binding, onError, onChanged],
  );

  const remove = useCallback(async () => {
    setBusy(true);
    try {
      await clearBinding(binding.object, binding.path, { source: { kind: "user" } });
      onError(null);
      onChanged();
    } catch (err) {
      onError(sentenceOf(err));
    } finally {
      setBusy(false);
    }
  }, [binding, onError, onChanged]);

  const goTo = useCallback(async () => {
    if (!place) return;
    try {
      const reached = await goToBoundObject(place);
      onError(reached ? null : `${row.objectText} could not be selected on '${place.sheetName}'.`);
    } catch (err) {
      onError(sentenceOf(err));
    }
  }, [place, row.objectText, onError]);

  return (
    <tr data-testid="bound-property-row" data-binding-key={row.key}>
      <td data-col="object">{row.objectText}</td>
      <td data-col="property" title={binding.path}>
        {row.propertyText}
      </td>
      <td data-col="formula" className={formulaClass}>
        {editing ? (
          <BindingFormulaEditor
            object={binding.object}
            value={text}
            onChange={setText}
            model={binding.model}
            onCommit={(v, m) => void commit(v, m)}
            onCancel={() => {
              setEditing(false);
              setText(binding.displayFormula);
            }}
            testId="bound-property-editor"
          />
        ) : (
          binding.displayFormula
        )}
      </td>
      <td data-col="value" className={value.isError ? errorClass : undefined}>
        {value.text}
      </td>
      <td className={actionsClass}>
        <button type="button" data-action="goto" disabled={!place || busy} onClick={() => void goTo()}>
          Go to
        </button>
        <button type="button" data-action="edit" disabled={busy || editing} onClick={() => setEditing(true)}>
          Edit
        </button>
        <button type="button" data-action="remove" disabled={busy} onClick={() => void remove()}>
          Remove
        </button>
      </td>
    </tr>
  );
}

// ============================================================================
// The dialog
// ============================================================================

export function BoundPropertiesDialog({ isOpen, onClose }: DialogProps): React.ReactElement | null {
  if (!isOpen) return null;
  return <BoundPropertiesWindow onClose={onClose} />;
}

function BoundPropertiesWindow({ onClose }: { onClose: () => void }): React.ReactElement {
  const win = useDialogWindow({ minWidth: 520, minHeight: 260 });
  const { rows, refresh } = useBoundPropertyRows();
  const [error, setError] = useState<string | null>(null);

  return (
    <div
      ref={win.ref}
      className={containerClass}
      role="dialog"
      aria-modal="false"
      aria-label="Bound Properties"
      data-testid="bound-properties-dialog"
      style={{ width: "min(860px, 95vw)", height: "min(520px, 88vh)", ...win.style }}
    >
      <div className={headerClass} onMouseDown={win.onHeaderMouseDown}>
        <span className={titleClass}>Bound Properties</span>
        <IconButton
          size="md"
          label="Close"
          icon={<RibbonIcon.Close size={18} />}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={onClose}
        />
      </div>
      <div className={introClass}>
        Every object property in this workbook that follows a formula. A bound property shows the formula&apos;s
        value instead of its own setting; Remove gives it back its setting.
      </div>
      {error && (
        <div className={introClass} role="alert" data-testid="bound-properties-error">
          <span className={errorClass}>{error}</span>
        </div>
      )}
      <div className={bodyClass}>
        {rows.length === 0 ? (
          <div className={emptyClass} data-testid="bound-properties-empty">
            No object property in this workbook is bound to a formula. Bind one with the fx button beside a
            property in its Properties or Format pane.
          </div>
        ) : (
          <table className={tableClass}>
            <thead>
              <tr>
                <th>Object</th>
                <th>Property</th>
                <th>Formula</th>
                <th>Value</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <BoundPropertyRowView key={row.key} row={row} onError={setError} onChanged={refresh} />
              ))}
            </tbody>
          </table>
        )}
      </div>
      {win.resizeHandles}
    </div>
  );
}
