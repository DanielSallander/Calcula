//! FILENAME: app/extensions/ScriptableObjects/components/scriptForm/FormWidgetTree.tsx
// PURPOSE: Paints a script-declared widget tree with TRUSTED host code. Every
//          one of the nineteen widget types is a switch arm here; a script
//          supplies data (labels, options, seeds) and never markup, so nothing
//          in this file renders a string as anything but text — there is no
//          dangerouslySetInnerHTML and no script-supplied URL: an image draws
//          only from the host-resolved `seed.imageUrl`.
// CONTEXT: Controls come from @api/layout under a panel SurfaceLayoutProvider,
//          so a form inherits the app skin; what the layout kit lacks (a
//          textarea, radios, a listbox, tabs, progress) is a small native
//          element styled with the same theme tokens. State lives in the
//          dialog (ScriptFormDialog.tsx) and reaches the widgets through
//          FormRenderContext — the tree itself holds nothing but focus state.

import React, { useState } from "react";
import type { FormSeed, FormValue, FormWidget } from "@api/scriptHost/scriptFormSpec";
import { MAX_FORM_GRID_COLUMNS } from "@api/scriptHost/scriptFormSpec";
import {
  Button,
  ControlRow,
  Field,
  Group,
  Input,
  Select,
  Stack,
  SurfaceLayoutProvider,
  ToggleButton,
  panelLayout,
} from "@api/layout";
import { ResultTable } from "../../../_shared/components/ResultTable";
import {
  asBool,
  asText,
  effectiveOptions,
  inputNamesUnder,
  type FormControlOverride,
  type FormInputWidget,
  type ScriptFormValue,
  type ScriptFormValues,
  type WidgetOf,
} from "../../lib/scriptFormState";
import { RadioGroup } from "./widgets/RadioGroup";
import { ListBox } from "./widgets/ListBox";
import { TabStrip } from "./widgets/TabStrip";
import { Progress } from "./widgets/Progress";
import * as S from "./ScriptFormDialog.styles";

// ============================================================================
// Context the dialog hands the tree
// ============================================================================

export interface FormRenderContext {
  showId: string;
  values: ScriptFormValues;
  controls: Record<string, FormControlOverride>;
  seeds: Record<string, FormSeed>;
  errors: Record<string, string>;
  /** Names whose value differs from the seed (typed by the user). */
  dirty: ReadonlySet<string>;
  /** Dirty names whose bound cell changed underneath (re-seeded while edited). */
  stale: ReadonlySet<string>;
  /** The widget that takes focus when the form opens. */
  autoFocusName: string | null;
  /** A pending focus request (script patch or first error); tabs switch to its
   *  page. `seq` rises per request so the same name twice is two requests. */
  focusRequest: { name: string; seq: number } | null;
  /** True while the host decides on a submit: every control is inert. */
  locked: boolean;
  /**
   * A CONTAINER above these widgets is disabled, so everything inside it is
   * too. Containers accept `disabled` (and a script can set it through
   * `form.control("advanced").enable(false)`), and without this the section
   * looked disabled while every control in it still took input and still
   * submitted its value.
   */
  inheritedDisabled?: boolean;
  onValueChange: (name: string, value: ScriptFormValue) => void;
  onButton: (widget: WidgetOf<"button">) => void;
  /** A focus/keystroke that changes nothing; re-arms the host's idle deadline. */
  onInteraction: () => void;
}

// ============================================================================
// Shared pieces
// ============================================================================

function widthStyle(width: number | "fill" | undefined): React.CSSProperties {
  if (width === "fill") return { flex: "1 1 0", minWidth: 0 };
  if (typeof width === "number") return { width, flex: "0 0 auto", maxWidth: "100%" };
  return {};
}

interface FrameProps {
  widget: FormWidget;
  ctx: FormRenderContext;
  children: React.ReactNode;
}

/**
 * The widget types that carry a `label` but have nowhere of their own to put
 * it: an input's label goes on its Field, a group's is its title, a progress
 * bar draws its own. For these, the base `label` used to be accepted and then
 * silently dropped — so it renders as a caption above the widget instead.
 */
const CAPTION_TYPES = new Set<FormWidget["type"]>([
  "label", "button", "image", "table", "tabs", "row", "column", "grid", "spacer",
]);

/** The id of a widget's help / error text, for `aria-describedby`. */
function describedById(showId: string, name: string | undefined, kind: "help" | "error"): string | undefined {
  return name ? `${showId}-${name}-${kind}` : undefined;
}

/** hidden / width / caption / help / stale marker / error — the same for every widget. */
function Frame({ widget, ctx, children }: FrameProps): React.ReactElement | null {
  const name = widget.name;
  const override = name ? ctx.controls[name] : undefined;
  if (widget.hidden || override?.hidden) return null;
  const error = name ? ctx.errors[name] ?? override?.error : undefined;
  const seed = name ? ctx.seeds[name] : undefined;
  const stale = name ? ctx.stale.has(name) : false;
  const caption = CAPTION_TYPES.has(widget.type) ? override?.label ?? widget.label : undefined;
  // Help and error carry ids so the INPUT can point at them with
  // aria-describedby: rendered as loose siblings they were invisible to a
  // screen reader, which is the one audience that cannot see the red text.
  const helpId = describedById(ctx.showId, name, "help");
  const errorId = describedById(ctx.showId, name, "error");
  return (
    <S.WidgetFrame style={widthStyle(widget.width)} data-form-frame={name}>
      {caption ? <S.LabelText>{caption}</S.LabelText> : null}
      {children}
      {widget.help ? <S.Help id={helpId}>{widget.help}</S.Help> : null}
      {seed?.readOnly && seed.reason ? <S.Help>{seed.reason}</S.Help> : null}
      {stale ? <S.StaleMarker data-form-stale={name}>The cell changed while you were editing</S.StaleMarker> : null}
      {error ? <S.ErrorText id={errorId} role="alert">{error}</S.ErrorText> : null}
    </S.WidgetFrame>
  );
}

interface InputMeta {
  id: string;
  label: string;
  /** The Field label: the label plus a trailing asterisk when required. */
  fieldLabel: string;
  required: boolean;
  readOnly: boolean;
  disabled: boolean;
  autoFocus: boolean;
  invalid: boolean;
  seed: FormSeed | undefined;
  value: ScriptFormValue | undefined;
  dirty: boolean;
  /** ids of this widget's help and error text, for aria-describedby. */
  describedBy: string | undefined;
}

function inputMeta(widget: FormInputWidget, ctx: FormRenderContext): InputMeta {
  const override = ctx.controls[widget.name];
  const seed = ctx.seeds[widget.name];
  const label = override?.label ?? widget.label ?? "";
  const required = widget.required === true;
  return {
    id: `${ctx.showId}-${widget.name}`,
    label,
    fieldLabel: required && label ? `${label} *` : label,
    required,
    readOnly: seed?.readOnly === true || seed?.formula !== undefined,
    disabled:
      ctx.locked || ctx.inheritedDisabled === true || widget.disabled === true || override?.disabled === true,
    autoFocus: ctx.autoFocusName === widget.name,
    invalid: ctx.errors[widget.name] !== undefined || override?.error !== undefined,
    seed,
    value: ctx.values[widget.name],
    dirty: ctx.dirty.has(widget.name),
    describedBy:
      [
        widget.help ? describedById(ctx.showId, widget.name, "help") : undefined,
        ctx.errors[widget.name] !== undefined || override?.error !== undefined
          ? describedById(ctx.showId, widget.name, "error")
          : undefined,
      ]
        .filter(Boolean)
        .join(" ") || undefined,
  };
}

/**
 * What a seeded text-like control SHOWS. Unfocused and untouched: the grid's
 * formatted display ("£1,234.50"). Focused on a formula-backed cell: the
 * formula text. Otherwise the typed value — which is what the host writes.
 */
function useShownText(
  meta: InputMeta,
  typed: string,
  ctx: FormRenderContext,
): { shown: string; textMode: boolean; onFocus: () => void; onBlur: () => void } {
  const [focused, setFocused] = useState(false);
  const formula = meta.seed?.formula;
  const display = meta.seed?.display;
  let shown = typed;
  let textMode = false;
  if (focused) {
    if (formula !== undefined) {
      shown = formula;
      textMode = true;
    }
  } else if (!meta.dirty && display !== undefined) {
    shown = display;
    textMode = true;
  }
  return {
    shown,
    textMode,
    onFocus: () => {
      setFocused(true);
      ctx.onInteraction();
    },
    onBlur: () => setFocused(false),
  };
}

function cellText(value: FormValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value);
}

// ============================================================================
// Inputs
// ============================================================================

function TextboxWidget({ widget, ctx }: { widget: WidgetOf<"textbox">; ctx: FormRenderContext }): React.ReactElement | null {
  const meta = inputMeta(widget, ctx);
  const typed = asText(meta.value);
  const view = useShownText(meta, typed, ctx);
  const onChange = (next: string): void => {
    if (meta.readOnly) return;
    ctx.onValueChange(widget.name, next);
  };
  return (
    <Frame widget={widget} ctx={ctx}>
      <Field label={meta.fieldLabel} htmlFor={meta.id}>
        {widget.multiline ? (
          <S.TextArea
            id={meta.id}
            data-form-widget={widget.name}
            value={view.shown}
            placeholder={widget.placeholder}
            maxLength={widget.maxLength}
            disabled={meta.disabled}
            readOnly={meta.readOnly}
            autoFocus={meta.autoFocus}
            aria-required={meta.required || undefined}
            aria-invalid={meta.invalid || undefined}
          aria-describedby={meta.describedBy}
            rows={4}
            onFocus={view.onFocus}
            onBlur={view.onBlur}
            onChange={(e) => onChange(e.target.value)}
          />
        ) : (
          <Input
            id={meta.id}
            data-form-widget={widget.name}
            type="text"
            value={view.shown}
            placeholder={widget.placeholder}
            maxLength={widget.maxLength}
            disabled={meta.disabled}
            readOnly={meta.readOnly}
            autoFocus={meta.autoFocus}
            aria-required={meta.required || undefined}
            aria-invalid={meta.invalid || undefined}
          aria-describedby={meta.describedBy}
            onFocus={view.onFocus}
            onBlur={view.onBlur}
            onChange={(e) => onChange(e.target.value)}
          />
        )}
      </Field>
    </Frame>
  );
}

/** "" -> null (blank), numeric -> number, anything else kept as text for the validator to name. */
function parseNumberInput(raw: string): ScriptFormValue {
  const t = raw.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : raw;
}

function NumberWidget({ widget, ctx }: { widget: WidgetOf<"number">; ctx: FormRenderContext }): React.ReactElement | null {
  const meta = inputMeta(widget, ctx);
  const typed =
    meta.value === null || meta.value === undefined
      ? ""
      : typeof meta.value === "number"
        ? String(meta.value)
        : asText(meta.value);
  const view = useShownText(meta, typed, ctx);
  return (
    <Frame widget={widget} ctx={ctx}>
      <Field label={meta.fieldLabel} htmlFor={meta.id}>
        <Input
          id={meta.id}
          data-form-widget={widget.name}
          type={view.textMode ? "text" : "number"}
          inputMode="decimal"
          value={view.shown}
          min={widget.min}
          max={widget.max}
          step={widget.step ?? "any"}
          disabled={meta.disabled}
          readOnly={meta.readOnly}
          autoFocus={meta.autoFocus}
          aria-required={meta.required || undefined}
          aria-invalid={meta.invalid || undefined}
          aria-describedby={meta.describedBy}
          onFocus={view.onFocus}
          onBlur={view.onBlur}
          onChange={(e) => {
            if (meta.readOnly) return;
            ctx.onValueChange(widget.name, parseNumberInput(e.target.value));
          }}
        />
      </Field>
    </Frame>
  );
}

function DateWidget({ widget, ctx }: { widget: WidgetOf<"date">; ctx: FormRenderContext }): React.ReactElement | null {
  const meta = inputMeta(widget, ctx);
  const typed = typeof meta.value === "string" ? meta.value : "";
  const view = useShownText(meta, typed, ctx);
  return (
    <Frame widget={widget} ctx={ctx}>
      <Field label={meta.fieldLabel} htmlFor={meta.id}>
        <Input
          id={meta.id}
          data-form-widget={widget.name}
          type={view.textMode ? "text" : "date"}
          value={view.shown}
          min={widget.min}
          max={widget.max}
          disabled={meta.disabled}
          readOnly={meta.readOnly}
          autoFocus={meta.autoFocus}
          aria-required={meta.required || undefined}
          aria-invalid={meta.invalid || undefined}
          aria-describedby={meta.describedBy}
          onFocus={view.onFocus}
          onBlur={view.onBlur}
          onChange={(e) => {
            if (meta.readOnly) return;
            ctx.onValueChange(widget.name, e.target.value);
          }}
        />
      </Field>
    </Frame>
  );
}

function CheckboxWidget({ widget, ctx }: { widget: WidgetOf<"checkbox">; ctx: FormRenderContext }): React.ReactElement | null {
  const meta = inputMeta(widget, ctx);
  return (
    <Frame widget={widget} ctx={ctx}>
      <S.CheckboxRow htmlFor={meta.id}>
        <input
          id={meta.id}
          data-form-widget={widget.name}
          type="checkbox"
          checked={asBool(meta.value)}
          disabled={meta.disabled || meta.readOnly}
          autoFocus={meta.autoFocus}
          aria-required={meta.required || undefined}
          aria-invalid={meta.invalid || undefined}
          aria-describedby={meta.describedBy}
          onFocus={ctx.onInteraction}
          onChange={(e) => ctx.onValueChange(widget.name, e.target.checked)}
        />
        <span>
          {meta.label}
          {meta.required ? <S.Required>*</S.Required> : null}
        </span>
      </S.CheckboxRow>
    </Frame>
  );
}

function ToggleWidget({ widget, ctx }: { widget: WidgetOf<"toggle">; ctx: FormRenderContext }): React.ReactElement | null {
  const meta = inputMeta(widget, ctx);
  const on = asBool(meta.value);
  return (
    <Frame widget={widget} ctx={ctx}>
      <ToggleButton
        id={meta.id}
        data-form-widget={widget.name}
        type="button"
        variant="outlined"
        active={on}
        disabled={meta.disabled || meta.readOnly}
        autoFocus={meta.autoFocus}
        aria-required={meta.required || undefined}
        aria-invalid={meta.invalid || undefined}
          aria-describedby={meta.describedBy}
        style={{ alignSelf: "flex-start" }}
        onFocus={ctx.onInteraction}
        onClick={() => ctx.onValueChange(widget.name, !on)}
      >
        {meta.label || widget.name}
        {meta.required ? <S.Required>*</S.Required> : null}
      </ToggleButton>
    </Frame>
  );
}

function RadioWidget({ widget, ctx }: { widget: WidgetOf<"radio">; ctx: FormRenderContext }): React.ReactElement | null {
  const meta = inputMeta(widget, ctx);
  const options = effectiveOptions(widget, ctx.seeds, ctx.controls);
  return (
    <Frame widget={widget} ctx={ctx}>
      <RadioGroup
        groupName={`${ctx.showId}:${widget.name}`}
        widgetName={widget.name}
        label={meta.label}
        required={meta.required}
        options={options}
        value={asText(meta.value)}
        layout={widget.layout ?? "column"}
        disabled={meta.disabled || meta.readOnly}
        autoFocus={meta.autoFocus}
        invalid={meta.invalid}
        describedBy={meta.describedBy}
        onChange={(v) => ctx.onValueChange(widget.name, v)}
      />
    </Frame>
  );
}

function DropdownWidget({ widget, ctx }: { widget: WidgetOf<"dropdown">; ctx: FormRenderContext }): React.ReactElement | null {
  const meta = inputMeta(widget, ctx);
  const options = effectiveOptions(widget, ctx.seeds, ctx.controls);
  const current = asText(meta.value);
  // A seeded value the list does not offer still has to be SHOWN (and kept),
  // or the select would silently display the first option while the state
  // says otherwise. It is listed, disabled, and the validator names it.
  const orphan = current !== "" && !options.some((o) => o.value === current);
  // ...and an EMPTY value has the same problem from the other end: with no
  // `<option value="">` to land on, the select displays its first option while
  // the state holds "". A dropdown BOUND to an empty cell hits this every time
  // (the seed wins over the declared default), so the user reads "EMEA",
  // submits, and nothing is written because nothing was touched. An explicit
  // empty row keeps what is on screen equal to what will be submitted.
  const emptyRow = widget.allowEmpty || current === "";
  return (
    <Frame widget={widget} ctx={ctx}>
      <Field label={meta.fieldLabel} htmlFor={meta.id}>
        <Select
          id={meta.id}
          data-form-widget={widget.name}
          value={current}
          disabled={meta.disabled || meta.readOnly}
          autoFocus={meta.autoFocus}
          aria-required={meta.required || undefined}
          aria-invalid={meta.invalid || undefined}
          aria-describedby={meta.describedBy}
          onFocus={ctx.onInteraction}
          onChange={(e) => ctx.onValueChange(widget.name, e.target.value)}
        >
          {emptyRow ? <option value="">{widget.allowEmpty ? "" : "—"}</option> : null}
          {orphan ? (
            <option value={current} disabled>
              {current}
            </option>
          ) : null}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label ?? o.value}
            </option>
          ))}
        </Select>
      </Field>
    </Frame>
  );
}

function ListboxWidget({ widget, ctx }: { widget: WidgetOf<"listbox">; ctx: FormRenderContext }): React.ReactElement | null {
  const meta = inputMeta(widget, ctx);
  const options = effectiveOptions(widget, ctx.seeds, ctx.controls);
  const multi = widget.multi === true;
  const value: string | string[] = multi
    ? Array.isArray(meta.value)
      ? meta.value
      : asText(meta.value) === ""
        ? []
        : [asText(meta.value)]
    : Array.isArray(meta.value)
      ? meta.value[0] ?? ""
      : asText(meta.value);
  return (
    <Frame widget={widget} ctx={ctx}>
      <Field label={meta.fieldLabel} htmlFor={meta.id}>
        <ListBox
          id={meta.id}
          widgetName={widget.name}
          options={options}
          multi={multi}
          value={value}
          rows={widget.rows ?? 5}
          disabled={meta.disabled || meta.readOnly}
          required={meta.required}
          autoFocus={meta.autoFocus}
          invalid={meta.invalid}
          describedBy={meta.describedBy}
          onChange={(v) => ctx.onValueChange(widget.name, v)}
        />
      </Field>
    </Frame>
  );
}

// ============================================================================
// Non-input widgets
// ============================================================================

function LabelWidget({ widget, ctx }: { widget: WidgetOf<"label">; ctx: FormRenderContext }): React.ReactElement | null {
  const override = widget.name ? ctx.controls[widget.name] : undefined;
  const text = override?.text ?? widget.text;
  const style = widget.style ?? "normal";
  return (
    <Frame widget={widget} ctx={ctx}>
      {style === "heading" ? (
        <S.Heading data-form-widget={widget.name}>{text}</S.Heading>
      ) : style === "muted" ? (
        <S.Muted data-form-widget={widget.name}>{text}</S.Muted>
      ) : (
        <S.LabelText data-form-widget={widget.name}>{text}</S.LabelText>
      )}
    </Frame>
  );
}

function ButtonWidget({ widget, ctx }: { widget: WidgetOf<"button">; ctx: FormRenderContext }): React.ReactElement | null {
  const override = ctx.controls[widget.name];
  const text = override?.text ?? widget.text;
  const disabled =
    ctx.locked || ctx.inheritedDisabled === true || widget.disabled === true || override?.disabled === true;
  const role = widget.role ?? "default";
  const autoFocus = ctx.autoFocusName === widget.name;
  const onClick = (): void => ctx.onButton(widget);

  if (role === "submit") {
    return (
      <Frame widget={widget} ctx={ctx}>
        <S.PrimaryButton
          type="button"
          $danger={widget.danger === true}
          data-form-widget={widget.name}
          data-script-form-submit=""
          disabled={disabled}
          autoFocus={autoFocus}
          onClick={onClick}
        >
          {text}
        </S.PrimaryButton>
      </Frame>
    );
  }
  if (role === "cancel") {
    return (
      <Frame widget={widget} ctx={ctx}>
        <S.Button
          type="button"
          data-form-widget={widget.name}
          data-script-form-cancel=""
          disabled={disabled}
          autoFocus={autoFocus}
          // `danger` is about what the button DOES, not where it sits: a
          // "Discard all" cancel is the destructive one on the form. It was
          // honoured on the other two branches and dropped here.
          style={widget.danger ? { color: "var(--text-error)", borderColor: "var(--text-error)" } : undefined}
          onClick={onClick}
        >
          {text}
        </S.Button>
      </Frame>
    );
  }
  return (
    <Frame widget={widget} ctx={ctx}>
      <Button
        type="button"
        variant="outlined"
        data-form-widget={widget.name}
        disabled={disabled}
        autoFocus={autoFocus}
        style={
          widget.danger
            ? { color: "var(--text-error)", borderColor: "var(--text-error)", alignSelf: "flex-start" }
            : { alignSelf: "flex-start" }
        }
        onFocus={ctx.onInteraction}
        onClick={onClick}
      >
        {text}
      </Button>
    </Frame>
  );
}

function ImageWidget({ widget, ctx }: { widget: WidgetOf<"image">; ctx: FormRenderContext }): React.ReactElement | null {
  // ONLY the host-resolved URL is ever painted. `widget.src` is a media handle
  // the host looked up; when it resolved to nothing there is no picture, and
  // the alt text stands in — a string is never turned into a request.
  const url = widget.name ? ctx.seeds[widget.name]?.imageUrl : undefined;
  return (
    <Frame widget={widget} ctx={ctx}>
      <S.ImageFrame data-form-widget={widget.name}>
        {url ? (
          <img src={url} alt={widget.alt ?? ""} style={widget.height !== undefined ? { height: widget.height } : undefined} />
        ) : widget.alt ? (
          <S.Muted>{widget.alt}</S.Muted>
        ) : null}
      </S.ImageFrame>
    </Frame>
  );
}

function TableWidget({ widget, ctx }: { widget: WidgetOf<"table">; ctx: FormRenderContext }): React.ReactElement | null {
  const rows: FormValue[][] = Array.isArray(widget.rows)
    ? widget.rows
    : (widget.name ? ctx.seeds[widget.name]?.rows : undefined) ?? [];
  const clipped = widget.maxRows !== undefined ? rows.slice(0, Math.max(0, widget.maxRows)) : rows;
  const hidden = rows.length - clipped.length;
  const text = clipped.map((row) => row.map(cellText));
  return (
    <Frame widget={widget} ctx={ctx}>
      <div data-form-widget={widget.name} style={{ minWidth: 0 }}>
        <ResultTable columns={widget.columns} rows={text} totalRows={rows.length} truncated={hidden > 0} />
        {hidden > 0 ? <S.MoreRows>… {hidden} more</S.MoreRows> : null}
      </div>
    </Frame>
  );
}

function ProgressWidget({ widget, ctx }: { widget: WidgetOf<"progress">; ctx: FormRenderContext }): React.ReactElement | null {
  const override = ctx.controls[widget.name];
  return (
    <Frame widget={widget} ctx={ctx}>
      <Progress
        widgetName={widget.name}
        value={override?.value ?? widget.value}
        max={override?.max ?? widget.max ?? 100}
        text={override?.text ?? widget.text}
        label={override?.label ?? widget.label}
      />
    </Frame>
  );
}

/**
 * The context children of a container render under: a disabled container
 * disables everything inside it. `hidden` needs no equivalent — `Frame`
 * returns null for a hidden container, so its children never render at all.
 */
function childContext(
  widget: FormWidget,
  ctx: FormRenderContext,
): FormRenderContext {
  const override = widget.name ? ctx.controls[widget.name] : undefined;
  const off = widget.disabled === true || override?.disabled === true;
  if (!off || ctx.inheritedDisabled === true) return ctx;
  return { ...ctx, inheritedDisabled: true };
}

// ============================================================================
// Containers
// ============================================================================

function GroupWidget({ widget, ctx, keyPath }: { widget: WidgetOf<"group">; ctx: FormRenderContext; keyPath: string }): React.ReactElement | null {
  const override = widget.name ? ctx.controls[widget.name] : undefined;
  const title = override?.label ?? widget.title ?? widget.label ?? "";
  const inner = childContext(widget, ctx);
  const body = (
    <Stack gap={10}>
      <Widgets widgets={widget.children} ctx={inner} keyPath={keyPath} />
    </Stack>
  );
  return (
    <Frame widget={widget} ctx={ctx}>
      <div data-form-widget={widget.name}>{title ? <Group label={title}>{body}</Group> : body}</div>
    </Frame>
  );
}

function TabsWidget({ widget, ctx, keyPath }: { widget: WidgetOf<"tabs">; ctx: FormRenderContext; keyPath: string }): React.ReactElement | null {
  const errorNames = new Set<string>(Object.keys(ctx.errors));
  for (const [name, override] of Object.entries(ctx.controls)) {
    if (override.error !== undefined) errorNames.add(name);
  }
  const inner = childContext(widget, ctx);
  const pages = widget.pages.map((page, p) => ({
    title: page.title,
    inputNames: inputNamesUnder(page.children),
    render: () => (
      <Stack gap={10}>
        <Widgets widgets={page.children} ctx={inner} keyPath={`${keyPath}/${p}`} />
      </Stack>
    ),
  }));
  return (
    <Frame widget={widget} ctx={ctx}>
      <TabStrip
        idBase={`${ctx.showId}-${keyPath.replace(/[^A-Za-z0-9_-]/g, "-")}`}
        widgetName={widget.name}
        pages={pages}
        errorNames={errorNames}
        focusRequest={ctx.focusRequest}
        onInteraction={ctx.onInteraction}
      />
    </Frame>
  );
}

function RowWidget({ widget, ctx, keyPath }: { widget: WidgetOf<"row">; ctx: FormRenderContext; keyPath: string }): React.ReactElement | null {
  return (
    <Frame widget={widget} ctx={ctx}>
      <div data-form-widget={widget.name}>
        <ControlRow gap={widget.gap ?? 8}>
          <Widgets widgets={widget.children} ctx={childContext(widget, ctx)} keyPath={keyPath} />
        </ControlRow>
      </div>
    </Frame>
  );
}

function ColumnWidget({ widget, ctx, keyPath }: { widget: WidgetOf<"column">; ctx: FormRenderContext; keyPath: string }): React.ReactElement | null {
  return (
    <Frame widget={widget} ctx={ctx}>
      <div data-form-widget={widget.name}>
        <Stack gap={widget.gap ?? 10}>
          <Widgets widgets={widget.children} ctx={childContext(widget, ctx)} keyPath={keyPath} />
        </Stack>
      </div>
    </Frame>
  );
}

function GridWidget({ widget, ctx, keyPath }: { widget: WidgetOf<"grid">; ctx: FormRenderContext; keyPath: string }): React.ReactElement | null {
  const columns = Math.max(1, Math.min(MAX_FORM_GRID_COLUMNS, Math.floor(widget.columns) || 1));
  return (
    <Frame widget={widget} ctx={ctx}>
      <div
        data-form-widget={widget.name}
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          gap: 8,
          minWidth: 0,
        }}
      >
        <Widgets widgets={widget.children} ctx={childContext(widget, ctx)} keyPath={keyPath} />
      </div>
    </Frame>
  );
}

function SpacerWidget({ widget, ctx }: { widget: WidgetOf<"spacer">; ctx: FormRenderContext }): React.ReactElement | null {
  // Through the shared Frame like every other widget. Returning a bare element
  // meant the base options were accepted and ignored on a spacer alone: a
  // script calling `form.control("gap1").show(false)` still had its gap, and
  // `width` did nothing — because the runtime `hidden` override and the width
  // style both live in Frame.
  return (
    <Frame widget={widget} ctx={ctx}>
      <div data-form-widget={widget.name} aria-hidden style={{ height: widget.size ?? 8, flex: "0 0 auto" }} />
    </Frame>
  );
}

// ============================================================================
// The switch
// ============================================================================

function renderWidget(widget: FormWidget, ctx: FormRenderContext, key: string): React.ReactNode {
  switch (widget.type) {
    case "label":
      return <LabelWidget key={key} widget={widget} ctx={ctx} />;
    case "textbox":
      return <TextboxWidget key={key} widget={widget} ctx={ctx} />;
    case "number":
      return <NumberWidget key={key} widget={widget} ctx={ctx} />;
    case "date":
      return <DateWidget key={key} widget={widget} ctx={ctx} />;
    case "checkbox":
      return <CheckboxWidget key={key} widget={widget} ctx={ctx} />;
    case "toggle":
      return <ToggleWidget key={key} widget={widget} ctx={ctx} />;
    case "radio":
      return <RadioWidget key={key} widget={widget} ctx={ctx} />;
    case "dropdown":
      return <DropdownWidget key={key} widget={widget} ctx={ctx} />;
    case "listbox":
      return <ListboxWidget key={key} widget={widget} ctx={ctx} />;
    case "button":
      return <ButtonWidget key={key} widget={widget} ctx={ctx} />;
    case "group":
      return <GroupWidget key={key} widget={widget} ctx={ctx} keyPath={key} />;
    case "tabs":
      return <TabsWidget key={key} widget={widget} ctx={ctx} keyPath={key} />;
    case "row":
      return <RowWidget key={key} widget={widget} ctx={ctx} keyPath={key} />;
    case "column":
      return <ColumnWidget key={key} widget={widget} ctx={ctx} keyPath={key} />;
    case "grid":
      return <GridWidget key={key} widget={widget} ctx={ctx} keyPath={key} />;
    case "spacer":
      return <SpacerWidget key={key} widget={widget} ctx={ctx} />;
    case "image":
      return <ImageWidget key={key} widget={widget} ctx={ctx} />;
    case "table":
      return <TableWidget key={key} widget={widget} ctx={ctx} />;
    case "progress":
      return <ProgressWidget key={key} widget={widget} ctx={ctx} />;
  }
}

/** A sibling list; the CONTAINER decides the layout, so this is a fragment. */
function Widgets({ widgets, ctx, keyPath }: { widgets: FormWidget[]; ctx: FormRenderContext; keyPath: string }): React.ReactElement {
  return (
    <>
      {widgets.map((widget, i) =>
        renderWidget(widget, ctx, widget.name ? `${keyPath}/${widget.name}` : `${keyPath}/${widget.type}${i}`),
      )}
    </>
  );
}

// ============================================================================
// Root
// ============================================================================

export interface FormWidgetTreeProps {
  widgets: FormWidget[];
  ctx: FormRenderContext;
  /** Dialog content width in px — the panel layout the primitives lay out against. */
  width: number;
}

/** The root of a form's widget tree, painted as a sidebar-style panel column. */
export function FormWidgetTree({ widgets, ctx, width }: FormWidgetTreeProps): React.ReactElement {
  return (
    <SurfaceLayoutProvider value={panelLayout(width)}>
      <S.WidgetList data-script-form-widgets="">
        <Widgets widgets={widgets} ctx={ctx} keyPath="root" />
      </S.WidgetList>
    </SurfaceLayoutProvider>
  );
}
