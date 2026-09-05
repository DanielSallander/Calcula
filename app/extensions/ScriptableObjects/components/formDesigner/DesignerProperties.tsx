//! FILENAME: app/extensions/ScriptableObjects/components/formDesigner/DesignerProperties.tsx
// PURPOSE: Edit the selected widget's own keys — its binding, its label, its
//          choices, and whichever type-specific ones the spec allows it.
// CONTEXT: M5b of docs/design/typescript-forms.md §14.
//
//          ONE KEY PER EDIT, and the panel is where that promise is kept or
//          broken. Every control here calls `onSetKey(key, value)` and nothing
//          else; the tree operation behind it (`setWidgetKey`) copies the widget
//          and replaces exactly one member, so the spec that reaches the writer
//          differs from the one on disk in one place. A panel that rebuilt the
//          widget from its own form state would look identical and quietly
//          normalise every other key on the way past.
//
//          A VALUE THIS PANEL CANNOT EXPRESS IS SHOWN, NOT FLATTENED. `bind`
//          may be `{ cell: "B2", sheet: "Sheet1" }` and `options` may be
//          `{ range: "A1:A9" }` — both legal, neither editable by a text box.
//          Such a row is rendered DISABLED with its value quoted and a sentence
//          pointing at the code editor. Turning it into the nearest string the
//          control can hold would change what the form reads from the workbook,
//          which is the one class of silent damage this milestone must not do.
//
//          A REFUSED VALUE IS NAMED, NOT JUST REVERTED. The bounds these rows
//          carry are the spec's own — 320..1200 on the form's width, 1..6 on a
//          grid's columns — so a draft outside them is the ONE refusal this
//          panel can explain without asking anybody. Snapping the box back to
//          what the script says is right; doing it in silence tells the user
//          the edit failed and never which limit they hit, and the sentence
//          they would have got from `checkFormSpec` never arrives because the
//          bounds check short-circuits before the writer is reached.
//
//          REMOVING A KEY IS AN EDIT. Clearing an optional field deletes the key
//          rather than writing `""` or `0`, so the emitted layout stays as short
//          as the one the author would have typed — but only when the result is
//          still a layout Calcula accepts, which is asked of `checkFormSpec`
//          rather than of a second list of "required" keys kept in this file.
//
//          A DRAFT BELONGS TO THE WIDGET IT WAS TYPED FOR. The boxes here hold
//          what was typed until the field is LEFT, and the selection can move
//          while one is still holding it: a palette press does exactly that,
//          because the shared drag gesture calls `preventDefault` on the
//          button's mousedown, so the browser never moves focus off the box
//          while the press inserts and selects a widget under it. The rows are
//          therefore keyed by `selectionKey` as well as by the key they edit, so
//          a selection change REMOUNTS them and the draft dies with the widget
//          it described. Keyed by the field name alone, the same box survived
//          the change and its next blur wrote the sentence typed for a textbox
//          onto the spacer that had arrived underneath — silently, because the
//          reset below compares the rendered TEXT, and a key absent on both
//          widgets (the common case: `help`, `width`, anything unset) renders
//          "" either side of the change and looks unchanged.

import React, { useState } from "react";

import type { FormSpec, FormWidget, FormWidgetType } from "@api/scriptHost/scriptFormSpec";

import {
  editorFits,
  fieldsForType,
  specFields,
  type PropertyEditor,
  type PropertyField,
} from "./propertyFields";
import * as S from "./designerStyles";

export interface DesignerPropertiesProps {
  spec: FormSpec;
  /** The selected widget, or null when the FORM itself is selected. */
  widget: FormWidget | null;
  /**
   * WHAT is being edited — the selected widget's `pathKey`, or the form's.
   *
   * Never displayed: it is the rows' React identity, so that a selection change
   * remounts them and no draft outlives the widget it was typed for (header).
   */
  selectionKey: string;
  disabled: boolean;
  /** Set (or, with `undefined`, remove) one key on the selected widget. */
  onSetWidgetKey: (key: string, value: unknown) => void;
  /** Set (or remove) one key on the form. */
  onSetSpecKey: (key: string, value: unknown) => void;
  onDelete: () => void;
}

export function DesignerProperties({
  spec,
  widget,
  selectionKey,
  disabled,
  onSetWidgetKey,
  onSetSpecKey,
  onDelete,
}: DesignerPropertiesProps): React.ReactElement {
  const fields = widget ? fieldsForType(widget.type as FormWidgetType) : specFields();
  const source = (widget ?? spec) as unknown as Record<string, unknown>;
  const onSet = widget ? onSetWidgetKey : onSetSpecKey;
  return (
    <div
      style={{ ...S.panel, width: 220, borderRight: "none", borderLeft: `1px solid ${S.COLORS.panelBorder}` }}
      data-testid="designer-properties"
    >
      <div style={S.sectionHeading}>{widget ? widget.type : "Form"}</div>
      {fields.map((field) =>
        field.editor.kind === "structural" ? null : (
          <PropertyRow
            // The selection is half a row's identity: `help` on this widget and
            // `help` on the next one selected are different fields, and a row
            // React reuses across the change carries the first one's draft into
            // the second one's commit.
            key={`${selectionKey}:${field.key}`}
            field={field}
            value={source[field.key]}
            disabled={disabled}
            onSet={onSet}
          />
        ),
      )}
      {widget ? (
        <button
          type="button"
          className="ose-btn"
          data-testid="designer-delete"
          disabled={disabled}
          onClick={onDelete}
          style={{ marginTop: 10, width: "100%" }}
          title="Remove this widget from the form (Delete)"
        >
          Remove widget
        </button>
      ) : null}
    </div>
  );
}

interface PropertyRowProps {
  field: PropertyField;
  value: unknown;
  disabled: boolean;
  onSet: (key: string, value: unknown) => void;
}

function PropertyRow({ field, value, disabled, onSet }: PropertyRowProps): React.ReactElement {
  const fits = editorFits(field.editor, value);
  const testId = `designer-prop-${field.key}`;
  if (!fits) {
    return (
      <div style={S.fieldRow} data-testid={testId} data-unrepresentable="true">
        <span style={S.fieldLabel}>{field.label}</span>
        <span style={{ ...S.fieldInput, color: S.COLORS.muted, cursor: "default" }}>
          {summarise(value)}
        </span>
        <span style={{ fontSize: 10, color: S.COLORS.muted }}>
          Written as something this panel cannot edit — change it in the code editor.
        </span>
      </div>
    );
  }
  return (
    <div style={S.fieldRow} data-testid={testId}>
      <PropertyControl
        field={field}
        value={value}
        disabled={disabled}
        onSet={onSet}
        testId={testId}
      />
    </div>
  );
}

function PropertyControl({
  field,
  value,
  disabled,
  onSet,
  testId,
}: PropertyRowProps & { testId: string }): React.ReactElement {
  const editor: PropertyEditor = field.editor;
  const inputId = `${testId}-input`;
  const label = (
    <label htmlFor={inputId} style={S.fieldLabel}>
      {field.label}
    </label>
  );

  if (editor.kind === "boolean") {
    return (
      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <input
          id={inputId}
          type="checkbox"
          data-testid={`${testId}-input`}
          disabled={disabled}
          checked={value === true}
          // Absent, not `false`: everything here defaults to off, so writing the
          // default would add a line to the user's script that says nothing.
          onChange={(e) => onSet(field.key, e.target.checked ? true : undefined)}
        />
        {label}
      </span>
    );
  }

  if (editor.kind === "choice") {
    return (
      <>
        {label}
        <select
          id={inputId}
          data-testid={`${testId}-input`}
          disabled={disabled}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onSet(field.key, e.target.value === "" ? undefined : e.target.value)}
          style={S.fieldInput}
        >
          <option value="">(default)</option>
          {editor.values.map((entry) => (
            <option key={entry} value={entry}>
              {entry}
            </option>
          ))}
        </select>
      </>
    );
  }

  return (
    <>
      {label}
      <CommittedInput
        inputId={inputId}
        rowTestId={testId}
        label={field.label}
        editor={editor}
        disabled={disabled}
        value={value}
        onCommit={(next) => onSet(field.key, next)}
      />
    </>
  );
}

/**
 * A text-like control that writes on BLUR (and on Enter), never per keystroke.
 *
 * Every commit rewrites the layout block in the user's script, so committing
 * per keystroke would put a half-typed word — and a half-typed identifier the
 * validator refuses — into the file eight times while a name is being typed.
 * The buffer holds what was typed until the field is left, which is the same
 * moment Monaco would have marked the line finished.
 */
function CommittedInput({
  inputId,
  rowTestId,
  label,
  editor,
  value,
  disabled,
  onCommit,
}: {
  inputId: string;
  rowTestId: string;
  /** The row's own heading, so a refusal can start with the key's human name. */
  label: string;
  editor: PropertyEditor;
  value: unknown;
  disabled: boolean;
  onCommit: (next: unknown) => void;
}): React.ReactElement {
  const asText = toText(value);
  const [draft, setDraft] = useState(asText);
  /** Why the last commit was refused, in the user's words; null when none was. */
  const [refused, setRefused] = useState<string | null>(null);
  // The layout can change under the panel (an undo in the code tab, another
  // widget selected), and the box must then show what the script now says.
  //
  // Adjusted DURING RENDER rather than in an effect — React's own answer for
  // state derived from a prop. An effect would paint the stale text for a frame
  // first, and the linter refuses it for the cascading render it causes.
  const [seenValue, setSeenValue] = useState(asText);
  if (seenValue !== asText) {
    setSeenValue(asText);
    setDraft(asText);
    // The complaint was about a value that is no longer on screen.
    setRefused(null);
  }

  const commit = (): void => {
    if (draft === asText) return;
    const parsed = parseValue(editor, label, draft);
    if (!parsed.ok) {
      setDraft(asText);
      setRefused(parsed.message);
      return;
    }
    setRefused(null);
    onCommit(parsed.value);
  };

  const multiline =
    (editor.kind === "text" && editor.multiline === true) || editor.kind === "stringList";
  const common = {
    id: inputId,
    disabled,
    value: draft,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setDraft(e.target.value);
      // Typing again retracts the complaint: it was about what WAS in the box.
      setRefused(null);
    },
    onBlur: commit,
    style: S.fieldInput,
  };
  const control = multiline ? (
    <textarea
      {...common}
      data-testid={`${rowTestId}-input`}
      aria-invalid={refused !== null}
      rows={editor.kind === "stringList" ? 4 : 2}
      placeholder={editor.kind === "stringList" ? `One ${editor.itemLabel.toLowerCase()} per line` : undefined}
      // Enter is a newline here, so only blur commits.
    />
  ) : (
    <input
      {...common}
      data-testid={`${rowTestId}-input`}
      aria-invalid={refused !== null}
      type="text"
      placeholder={editor.kind === "text" ? editor.placeholder : undefined}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
      }}
    />
  );
  return (
    <>
      {control}
      {refused === null ? null : (
        // Under the row rather than in the panel's write-refusal banner: this
        // one names a FIELD, and the banner sits three components away at the
        // top of the designer where nothing points back at the box.
        <span
          data-testid={`${rowTestId}-invalid`}
          role="alert"
          style={{ fontSize: 10, color: S.COLORS.error }}
        >
          {refused}
        </span>
      )}
    </>
  );
}

/**
 * A parsed draft, or the sentence saying why this panel will not write it.
 *
 * `{ ok: true, value: undefined }` REMOVES the key — an empty optional field is
 * a deletion, never a rejection. A rejection carries WORDS rather than a bare
 * flag, because the bounds below are the spec's own and the row is the only
 * place that knows which of them the draft missed.
 */
type ParseResult = { ok: true; value: unknown } | { ok: false; message: string };

function toText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map((entry) => String(entry)).join("\n");
  return String(value);
}

function parseValue(editor: PropertyEditor, label: string, draft: string): ParseResult {
  const trimmed = draft.trim();
  switch (editor.kind) {
    case "text":
      return { ok: true, value: trimmed === "" ? undefined : draft };
    case "number": {
      if (trimmed === "") return { ok: true, value: undefined };
      const n = Number(trimmed);
      // ONE sentence for all four ways a number can miss, built from the same
      // editor the checks read: a per-check message would drift from the bound
      // the next time one of them moved.
      const no = (): ParseResult => ({ ok: false, message: numberRule(editor, label) });
      if (!Number.isFinite(n)) return no();
      if (editor.integer === true && !Number.isInteger(n)) return no();
      if (editor.min !== undefined && n < editor.min) return no();
      if (editor.max !== undefined && n > editor.max) return no();
      return { ok: true, value: n };
    }
    case "widthOrFill": {
      if (trimmed === "") return { ok: true, value: undefined };
      if (trimmed.toLowerCase() === "fill") return { ok: true, value: "fill" };
      const n = Number(trimmed);
      return Number.isFinite(n)
        ? { ok: true, value: n }
        : { ok: false, message: `${label} must be a number of pixels, or "fill".` };
    }
    case "stringList": {
      const entries = draft
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
      return { ok: true, value: entries.length === 0 ? undefined : entries };
    }
    default:
      return { ok: false, message: `${label} is not edited in this panel.` };
  }
}

/**
 * The numeric bound in words, read off the editor that enforces it.
 *
 * `Number.MIN_VALUE` as a floor is how this panel spells STRICTLY POSITIVE (a
 * progress bar's ceiling, propertyFields.ts), and "greater than 0" is how
 * `checkFormSpec` says the same thing; printing 5e-324 would be arithmetically
 * exact and useless to the person reading it.
 */
function numberRule(
  editor: { min?: number; max?: number; integer?: boolean },
  label: string,
): string {
  const noun = editor.integer === true ? "a whole number" : "a number";
  const { min, max } = editor;
  if (min === Number.MIN_VALUE) return `${label} must be ${noun} greater than 0.`;
  if (min !== undefined && max !== undefined) {
    return `${label} must be ${noun} between ${min} and ${max}.`;
  }
  if (min !== undefined) return `${label} must be ${noun} of ${min} or more.`;
  if (max !== undefined) return `${label} must be ${noun} of ${max} or less.`;
  return `${label} must be ${noun}.`;
}

/** A one-line rendering of a value the panel is not going to edit. */
function summarise(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text.length > 60 ? `${text.slice(0, 57)}…` : text;
  } catch {
    return String(value);
  }
}
