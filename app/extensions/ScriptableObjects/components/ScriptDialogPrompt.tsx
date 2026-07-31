//! FILENAME: app/extensions/ScriptableObjects/components/ScriptDialogPrompt.tsx
// PURPOSE: The TRUSTED renderer for the ui.dialog capability — the modal a
//          script uses to ask the user something (alert / confirm / prompt /
//          declarative form) and branch on the answer.
// CONTEXT: The script sends DATA only (@api ScriptDialogRequestPayload); this
//          component paints it with app tokens and the standard movable/
//          resizable dialog behavior (useDialogWindow, like every other dialog
//          in the app). It emits the answer on "scriptable-objects:script-
//          dialog-answered"; index.ts resolves the awaiting host call, and
//          resolves it as DISMISSED if the dialog closes without one.
//
// SECURITY: the header band is chrome the script cannot address — it always
// states which script is asking and where that script came from. A script-
// supplied title is rendered as body content, below that band, so a dialog can
// never present itself as the application (or as another script).

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { emitAppEvent, onAppEvent } from "@api/events";
import { useDialogWindow } from "@api/dialogWindow";
import type { DialogProps } from "@api/uiTypes";
import type {
  ScriptDialogAnswer,
  ScriptDialogField,
  ScriptDialogFormSpec,
  ScriptDialogRequestPayload,
} from "@api";
import { normalizeDialogOption, SCRIPT_DIALOG_CANCELLED_EVENT } from "@api";
import {
  buildFormResult,
  initialFormValues,
  validateFormValues,
  type ScriptDialogFormValues,
} from "../lib/scriptDialogForm";
import * as S from "./ScriptDialogPrompt.styles";

/** The answer channel back to index.ts (which owns the host request). */
export const SCRIPT_DIALOG_ANSWERED_EVENT = "scriptable-objects:script-dialog-answered";

// ============================================================================
// Glyph
// ============================================================================

const ScriptGlyphSvg = React.createElement(
  "svg",
  {
    width: 15,
    height: 15,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  },
  React.createElement("path", { d: "M8 8 L4 12 L8 16" }),
  React.createElement("path", { d: "M16 8 L20 12 L16 16" }),
  React.createElement("path", { d: "M13.5 6 L10.5 18" }),
);

// ============================================================================
// Field rendering
// ============================================================================

interface FieldRowProps {
  field: ScriptDialogField;
  value: string | boolean;
  error?: string;
  autoFocus: boolean;
  onChange: (value: string | boolean) => void;
}

function FieldRow({ field, value, error, autoFocus, onChange }: FieldRowProps): React.ReactElement {
  const label = (
    <S.FieldLabel>
      {field.label}
      {field.required ? <S.Required>*</S.Required> : null}
    </S.FieldLabel>
  );

  if (field.type === "checkbox") {
    return (
      <S.Field as="div">
        <S.CheckboxRow>
          <input
            type="checkbox"
            checked={value === true}
            autoFocus={autoFocus}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span>
            {field.label}
            {field.required ? <S.Required>*</S.Required> : null}
          </span>
        </S.CheckboxRow>
        {field.help ? <S.Help>{field.help}</S.Help> : null}
        {error ? <S.ErrorText>{error}</S.ErrorText> : null}
      </S.Field>
    );
  }

  const text = typeof value === "string" ? value : "";

  if (field.type === "select") {
    const options = (field.options ?? []).map(normalizeDialogOption);
    return (
      <S.Field>
        {label}
        <S.Select value={text} autoFocus={autoFocus} onChange={(e) => onChange(e.target.value)}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </S.Select>
        {field.help ? <S.Help>{field.help}</S.Help> : null}
        {error ? <S.ErrorText>{error}</S.ErrorText> : null}
      </S.Field>
    );
  }

  if (field.type === "text" && field.multiline) {
    return (
      <S.Field>
        {label}
        <S.TextArea
          value={text}
          placeholder={field.placeholder}
          maxLength={field.maxLength}
          autoFocus={autoFocus}
          onChange={(e) => onChange(e.target.value)}
        />
        {field.help ? <S.Help>{field.help}</S.Help> : null}
        {error ? <S.ErrorText>{error}</S.ErrorText> : null}
      </S.Field>
    );
  }

  return (
    <S.Field>
      {label}
      <S.TextInput
        type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"}
        value={text}
        placeholder={field.placeholder}
        maxLength={field.type === "text" ? field.maxLength : undefined}
        min={field.type === "number" ? field.min : undefined}
        max={field.type === "number" ? field.max : undefined}
        step={field.type === "number" ? field.step : undefined}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
      />
      {field.help ? <S.Help>{field.help}</S.Help> : null}
      {error ? <S.ErrorText>{error}</S.ErrorText> : null}
    </S.Field>
  );
}

// ============================================================================
// Component
// ============================================================================

export default function ScriptDialogPrompt({ onClose, data }: DialogProps): React.ReactElement | null {
  const request = data as unknown as ScriptDialogRequestPayload | undefined;
  const win = useDialogWindow({ minWidth: 360, minHeight: 200 });

  const kind = request?.kind ?? "alert";
  const form: ScriptDialogFormSpec | null = kind === "form" ? request?.form ?? null : null;

  const [promptValue, setPromptValue] = useState<string>(request?.promptOptions?.defaultValue ?? "");
  const [values, setValues] = useState<ScriptDialogFormValues>(() =>
    form ? initialFormValues(form) : {},
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Exactly one answer may be emitted; the close handler must not double-fire.
  const answered = useRef(false);

  const answer = useCallback(
    (result: ScriptDialogAnswer) => {
      if (answered.current) return;
      answered.current = true;
      emitAppEvent(SCRIPT_DIALOG_ANSWERED_EVENT, { requestId: request?.requestId ?? "", answer: result });
      onClose();
    },
    [request?.requestId, onClose],
  );

  // Cancel / Escape / overlay / close button all take THIS path. index.ts also
  // resolves a close that emitted nothing, so a dismissal can never be lost.
  const dismiss = useCallback(() => answer({ dismissed: true }), [answer]);

  const submit = useCallback(() => {
    if (kind === "alert") {
      answer({ dismissed: false, value: null });
      return;
    }
    if (kind === "confirm") {
      answer({ dismissed: false, value: null });
      return;
    }
    if (kind === "prompt") {
      answer({ dismissed: false, value: promptValue });
      return;
    }
    if (!form) {
      answer({ dismissed: true });
      return;
    }
    const found = validateFormValues(form, values);
    if (Object.keys(found).length > 0) {
      setErrors(found);
      return;
    }
    answer({ dismissed: false, value: buildFormResult(form, values) });
  }, [kind, answer, promptValue, form, values]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        dismiss();
        return;
      }
      // Enter submits — except inside a textarea, where it is a newline.
      if (e.key === "Enter" && !e.shiftKey) {
        const target = e.target as HTMLElement;
        if (target.tagName === "TEXTAREA") return;
        e.preventDefault();
        submit();
      }
    },
    [dismiss, submit],
  );

  // The host withdrew the request (deadline elapsed, script unmounted, workbook
  // reset): close without answering — there is nothing left to answer.
  useEffect(() => {
    if (!request) return undefined;
    return onAppEvent(SCRIPT_DIALOG_CANCELLED_EVENT, (detail) => {
      if ((detail as { requestId?: string } | undefined)?.requestId !== request.requestId) return;
      answered.current = true;
      onClose();
    });
  }, [request, onClose]);

  const setFieldValue = useCallback((name: string, value: string | boolean) => {
    setValues((prev) => ({ ...prev, [name]: value }));
    setErrors((prev) => {
      if (prev[name] === undefined) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  }, []);

  const provenance = useMemo(() => {
    if (!request) return "";
    return request.scriptOrigin === "local"
      ? "A script in this workbook is asking you a question"
      : `A script from the package "${request.scriptOrigin}" is asking you a question`;
  }, [request]);

  if (!request) return null;

  const showCancel = kind !== "alert";
  const okLabel =
    kind === "form"
      ? form?.submitLabel ?? "OK"
      : kind === "prompt"
        ? request.promptOptions?.okLabel ?? "OK"
        : request.textOptions?.okLabel ?? "OK";
  const cancelLabel =
    kind === "form"
      ? form?.cancelLabel ?? "Cancel"
      : kind === "prompt"
        ? request.promptOptions?.cancelLabel ?? "Cancel"
        : request.textOptions?.cancelLabel ?? "Cancel";
  const scriptTitle =
    kind === "form" ? form?.title : kind === "prompt" ? request.promptOptions?.title : request.textOptions?.title;
  const danger = kind === "confirm" && request.textOptions?.danger === true;

  return (
    <S.Backdrop onMouseDown={dismiss}>
      <S.DialogContainer
        ref={win.ref}
        role="dialog"
        aria-modal="true"
        data-script-dialog={kind}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        style={{ position: "relative", ...win.style }}
      >
        {/* Attribution band — chrome, drag handle, and the one thing a script
            cannot influence. */}
        <S.Header onMouseDown={win.onHeaderMouseDown}>
          <S.ScriptGlyph>{ScriptGlyphSvg}</S.ScriptGlyph>
          <S.HeaderText>
            <S.AskedBy>{request.scriptName}</S.AskedBy>
            <S.Provenance>{provenance}</S.Provenance>
          </S.HeaderText>
          <S.CloseButton onClick={dismiss} title="Close (Esc)">
            X
          </S.CloseButton>
        </S.Header>

        <S.Body>
          {scriptTitle ? <S.ScriptTitle>{scriptTitle}</S.ScriptTitle> : null}
          {kind === "form" ? (
            form?.description ? <S.Message>{form.description}</S.Message> : null
          ) : (
            <S.Message>{request.message}</S.Message>
          )}

          {kind === "prompt" ? (
            request.promptOptions?.multiline ? (
              <S.TextArea
                value={promptValue}
                placeholder={request.promptOptions?.placeholder}
                maxLength={request.promptOptions?.maxLength}
                autoFocus
                onChange={(e) => setPromptValue(e.target.value)}
              />
            ) : (
              <S.TextInput
                type="text"
                value={promptValue}
                placeholder={request.promptOptions?.placeholder}
                maxLength={request.promptOptions?.maxLength}
                autoFocus
                onChange={(e) => setPromptValue(e.target.value)}
              />
            )
          ) : null}

          {form ? (
            <S.FieldList>
              {form.fields.map((field, i) => (
                <FieldRow
                  key={field.name}
                  field={field}
                  value={values[field.name] ?? ""}
                  error={errors[field.name]}
                  autoFocus={i === 0}
                  onChange={(v) => setFieldValue(field.name, v)}
                />
              ))}
            </S.FieldList>
          ) : null}
        </S.Body>

        <S.Footer>
          {showCancel ? (
            <S.Button onClick={dismiss} data-script-dialog-cancel>
              {cancelLabel}
            </S.Button>
          ) : null}
          <S.PrimaryButton $danger={danger} onClick={submit} autoFocus={kind === "alert"} data-script-dialog-ok>
            {okLabel}
          </S.PrimaryButton>
        </S.Footer>

        {win.resizeHandles}
      </S.DialogContainer>
    </S.Backdrop>
  );
}
