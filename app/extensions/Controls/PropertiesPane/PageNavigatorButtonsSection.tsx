//! FILENAME: app/extensions/Controls/PropertiesPane/PageNavigatorButtonsSection.tsx
// PURPOSE: The Properties pane's "Buttons" section for a PAGE NAVIGATOR (WP-B,
//          D-NAV, S7): one row per page button -- its caption, whether it is
//          shown, and its own face / caption / border colours -- written as the
//          navigator's per-page overrides (`pageOverrides`).
// CONTEXT: A navigator's buttons are DERIVED from the live page list
//          (@api/reportPages); nothing about a page is stored except what the
//          author changed here. So a row is a PAGE, never a stored entry: the
//          rows are the pages the navigator lists under its own Show hidden /
//          Show tooltip settings, in tab order -- including the pages an
//          override hides, so a hidden button can be shown again. Each row's
//          override is found by the seam's ONE matching rule
//          (`matchPageNavigatorOverride`: id first, name only for an override
//          whose id names no live page).
//
//          A WRITE names the page twice (id and current name), re-keys a
//          name-matched override to the page's id, drops a field that was
//          cleared, and REMOVES an override whose every field is cleared -- so
//          "back to the default" leaves no entry behind. The whole list is
//          serialised canonically (`serializePageNavigatorOverrides`), an
//          unchanged list is not a write, and the strict check
//          (`checkPageNavigatorOverrides`) runs before anything is sent: a
//          refusal is the user's answer (a toast), never a backend error.
//
//          The row of the item selected on the canvas (Design Mode's second
//          press, PageNavigator/navigatorItemSelection.ts) is expanded and
//          scrolled into view.
//
//          Self-contained (its props are the control's properties, a read-only
//          flag and a writer), so the object pane (D-PANE) can re-home it.
//
//          PER-BUTTON BINDINGS (WP-D S8d, D §3.18a): given the navigator's
//          binding ref, each caption and colour input sits in a `BindableField`
//          whose pointer names the PAGE (`/properties/pageOverrides/<sheetId>/
//          text`), never an array index -- so a binding keeps aiming at its page
//          when entries are added or removed. The inputs here keep showing the
//          STORED literal; the bound value is painted by Rust
//          (`resolve_control_properties`) and shown under the fx editor.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { showToast } from "@api/notifications";
import {
  checkPageNavigatorOverrides,
  matchPageNavigatorOverride,
  serializePageNavigatorOverrides,
  type PageNavigatorOverride,
} from "@api/buttonControlService";
import {
  getReportPagesSnapshot,
  onReportPagesChanged,
  selectReportPages,
  type ReportPage,
  type ReportPagesSnapshot,
} from "@api/reportPages";
import { pageButtonPointer, type ObjectBindingRef } from "@api/objectBindings";
import { BindableField } from "../../_shared/components/bindings";
import type { ControlPropertyValue } from "../lib/types";
import { navigatorItemKey, readPageNavigatorProps } from "../PageNavigator/navigatorModel";
import {
  getSelectedNavigatorItem,
  onSelectedNavigatorItemChange,
  type SelectedNavigatorItem,
} from "../PageNavigator/navigatorItemSelection";

// ============================================================================
// Styles (theme-aware via CSS variables)
// ============================================================================

const v = (token: string) => `var(${token})`;

const emptyStyle: React.CSSProperties = {
  padding: "8px 12px",
  fontSize: 11,
  color: v("--text-secondary"),
};

const rowHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  width: "100%",
  padding: "5px 12px",
  border: "none",
  background: "transparent",
  textAlign: "left",
  cursor: "pointer",
  fontFamily: v("--font-family-sans"),
  fontSize: 12,
  color: v("--text-primary"),
};

const rowHeaderSelectedStyle: React.CSSProperties = {
  backgroundColor: v("--panel-bg"),
  boxShadow: `inset 2px 0 0 ${v("--accent-color")}`,
};

const chevronStyle: React.CSSProperties = {
  width: 10,
  flexShrink: 0,
  fontSize: 9,
  color: v("--text-secondary"),
};

const captionLabelStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const badgeStyle: React.CSSProperties = {
  fontSize: 10,
  color: v("--text-secondary"),
  flexShrink: 0,
};

const bodyStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  padding: "4px 12px 10px 28px",
};

const fieldStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 3,
};

const labelStyle: React.CSSProperties = {
  fontWeight: 600,
  fontSize: 11,
  color: v("--text-secondary"),
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "4px 7px",
  border: `1px solid ${v("--border-default")}`,
  borderRadius: 3,
  fontSize: 12,
  fontFamily: v("--font-family-sans"),
  outline: "none",
  boxSizing: "border-box",
  backgroundColor: v("--bg-surface"),
  color: v("--text-primary"),
};

const colourRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
};

const swatchStyle: React.CSSProperties = {
  width: 24,
  height: 24,
  border: `1px solid ${v("--border-default")}`,
  borderRadius: 4,
  cursor: "pointer",
  flexShrink: 0,
  padding: 0,
};

const colourTextStyle: React.CSSProperties = {
  flex: 1,
  fontSize: 11,
  color: v("--text-secondary"),
};

const clearButtonStyle: React.CSSProperties = {
  padding: "2px 8px",
  fontSize: 11,
  border: `1px solid ${v("--border-default")}`,
  borderRadius: 3,
  background: v("--bg-surface"),
  color: v("--text-primary"),
  cursor: "pointer",
  fontFamily: v("--font-family-sans"),
};

const checkboxRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: 12,
  color: v("--text-primary"),
};

// ============================================================================
// Pure helpers (exported for the unit tier)
// ============================================================================

/** An edit to one page's override. A field present with `undefined` / "" / false CLEARS it. */
export interface PageOverrideEdit {
  text?: string;
  hidden?: boolean;
  fill?: string;
  color?: string;
  borderColor?: string;
}

const EDITABLE_FIELDS = ["text", "hidden", "fill", "color", "borderColor"] as const;

/**
 * The override list after `edit` is applied to `page`'s override. The page's
 * override is found by the ONE matching rule over the WHOLE page list; the
 * result names the page by its id AND current name; a cleared field is
 * dropped (`hidden` is kept only when true, a caption only when non-empty);
 * an override left with no field is REMOVED. Other entries keep their order.
 */
export function applyPageOverrideEdit(
  list: readonly PageNavigatorOverride[],
  pages: readonly ReportPage[],
  page: ReportPage,
  edit: PageOverrideEdit,
): PageNavigatorOverride[] {
  const existing = matchPageNavigatorOverride(list, page, pages);
  const next: PageNavigatorOverride = { sheetId: page.sheetId, sheetName: page.name };
  for (const field of EDITABLE_FIELDS) {
    const value = Object.prototype.hasOwnProperty.call(edit, field) ? edit[field] : existing?.[field];
    if (field === "hidden") {
      if (value === true) next.hidden = true;
    } else if (typeof value === "string" && value !== "") {
      next[field] = value;
    }
  }
  const hasAny = EDITABLE_FIELDS.some((field) => next[field] !== undefined);
  const out = [...list];
  const at = existing ? out.indexOf(existing) : -1;
  if (at >= 0) {
    if (hasAny) out[at] = next;
    else out.splice(at, 1);
  } else if (hasAny) {
    out.push(next);
  }
  return out;
}

/** A colour spelled #rrggbb (what `<input type="color">` shows), or null. */
function sixDigitColour(colour: string | undefined): string | null {
  const c = (colour ?? "").trim();
  if (/^#[0-9a-f]{6}$/i.test(c)) return c.toLowerCase();
  if (/^#[0-9a-f]{8}$/i.test(c)) return c.slice(0, 7).toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(c)) return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`.toLowerCase();
  return null;
}

/** A stored colour as a colour swatch can show it: the override's, else the navigator's, else black. */
export function swatchValue(colour: string | undefined, fallback: string): string {
  return sixDigitColour(colour) ?? sixDigitColour(fallback) ?? "#000000";
}

/** The key of the item selected in navigator `controlId`, or null. */
function selectedKeyFor(sel: SelectedNavigatorItem | null, controlId: string): string | null {
  return sel !== null && sel.controlId === controlId ? sel.itemKey : null;
}

/** The static values of a control's properties (a formula value is not a setting here). */
function staticValues(
  properties: Record<string, ControlPropertyValue> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, p] of Object.entries(properties ?? {})) {
    if (p && p.valueType === "static") out[key] = p.value;
  }
  return out;
}

// ============================================================================
// Component
// ============================================================================

export interface PageNavigatorButtonsSectionProps {
  /** The navigator's control id: its selected item (if any) is expanded. */
  controlId: string;
  /** The navigator's properties as the pane holds them. */
  properties: Record<string, ControlPropertyValue> | undefined;
  /** Nothing can be changed (rows still show what is set). */
  readOnly: boolean;
  /** Write this override list (already checked); rejects on a refusal. */
  onWrite: (list: PageNavigatorOverride[]) => Promise<void>;
  /**
   * The navigator's binding ref (`controlBindingRefOf`, from the uid the
   * backend returned). With it, each caption and colour offers fx; without it
   * (a control no door has given a uid) they are plain inputs.
   */
  bindingRef?: ObjectBindingRef | null;
}

/** A caption field: a draft while typing, committed on blur or Enter, Escape reverts. */
function CaptionInput(props: {
  testId: string;
  value: string;
  placeholder: string;
  disabled: boolean;
  onCommit: (value: string) => void;
}): React.ReactElement {
  const { testId, value, placeholder, disabled, onCommit } = props;
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);
  return (
    <input
      type="text"
      data-testid={testId}
      aria-label="Caption"
      style={inputStyle}
      value={draft}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== value) onCommit(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          if (draft !== value) onCommit(draft);
        } else if (e.key === "Escape") {
          setDraft(value);
        }
      }}
    />
  );
}

/**
 * The "Show this page's button" box. It shows the click AT ONCE: the stored
 * value only changes when the backend write answers, and a box bound to it
 * alone snapped back to its old tick for that round trip (BUG-0468; the
 * pane's own boolean rows, PropertyRow's ToggleSwitch, already show their
 * new value locally). The local value is dropped when the stored value
 * changes or the write settles, so a refused write puts the old tick back.
 */
function ShowCheckbox(props: {
  testId: string;
  shown: boolean;
  disabled: boolean;
  onCommit: (shown: boolean) => Promise<void>;
}): React.ReactElement {
  const { testId, shown, disabled, onCommit } = props;
  const [pending, setPending] = useState<boolean | null>(null);
  useEffect(() => {
    setPending(null);
  }, [shown]);
  return (
    <input
      type="checkbox"
      data-testid={testId}
      checked={pending ?? shown}
      disabled={disabled}
      onChange={(e) => {
        const next = e.target.checked;
        setPending(next);
        void onCommit(next).finally(() => setPending(null));
      }}
    />
  );
}

/** Where one page button's setting binds: the navigator and the per-page pointer. */
interface PageButtonBinding {
  object: ObjectBindingRef;
  path: string;
}

/** `literal`, or -- with a binding target -- `literal` inside a BindableField (fx). */
function withFx(binding: PageButtonBinding | null, label: string, literal: React.ReactElement): React.ReactElement {
  if (!binding) return literal;
  return <BindableField object={binding.object} path={binding.path} label={label} literal={literal} />;
}

/** A colour field with a Clear button (back to the navigator's own colour). */
function ColourField(props: {
  label: string;
  testId: string;
  value: string | undefined;
  inherited: string;
  disabled: boolean;
  onChange: (value: string | undefined) => void;
  binding: PageButtonBinding | null;
}): React.ReactElement {
  const { label, testId, value, inherited, disabled, onChange, binding } = props;
  return (
    <div style={fieldStyle}>
      <span style={labelStyle}>{label}</span>
      {withFx(
        binding,
        label,
        <div style={colourRowStyle}>
          <input
            type="color"
            data-testid={testId}
            aria-label={label}
            style={swatchStyle}
            value={swatchValue(value, inherited)}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          />
          <span style={colourTextStyle}>{value ?? `Navigator's (${inherited})`}</span>
          <button
            type="button"
            data-testid={`${testId}-clear`}
            style={clearButtonStyle}
            disabled={disabled || value === undefined}
            onClick={() => onChange(undefined)}
          >
            Clear
          </button>
        </div>,
      )}
    </div>
  );
}

export function PageNavigatorButtonsSection({
  controlId,
  properties,
  readOnly,
  onWrite,
  bindingRef = null,
}: PageNavigatorButtonsSectionProps): React.ReactElement {
  const [snapshot, setSnapshot] = useState<ReportPagesSnapshot>(() => getReportPagesSnapshot());
  useEffect(() => {
    setSnapshot(getReportPagesSnapshot());
    return onReportPagesChanged((next) => setSnapshot(next));
  }, []);

  const [selectedKey, setSelectedKey] = useState<string | null>(() =>
    selectedKeyFor(getSelectedNavigatorItem(), controlId),
  );
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => {
    const key = selectedKeyFor(getSelectedNavigatorItem(), controlId);
    return new Set(key ? [key] : []);
  });
  useEffect(() => {
    const apply = (sel: SelectedNavigatorItem | null): void => {
      const key = selectedKeyFor(sel, controlId);
      setSelectedKey(key);
      if (key) setExpanded((prev) => (prev.has(key) ? prev : new Set([...prev, key])));
    };
    apply(getSelectedNavigatorItem());
    return onSelectedNavigatorItemChange(apply);
  }, [controlId]);

  // The selected item's row is scrolled into view (jsdom has no scrollIntoView).
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  useEffect(() => {
    if (!selectedKey) return;
    const el = rowRefs.current.get(selectedKey);
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
  }, [selectedKey]);

  const props = readPageNavigatorProps(staticValues(properties));
  const pages = snapshot.pages;
  const listed = selectReportPages(pages, {
    showHiddenPages: props.showHiddenPages,
    showTooltipPages: props.showTooltipPages,
  });

  const commit = useCallback(
    async (page: ReportPage, edit: PageOverrideEdit): Promise<void> => {
      if (readOnly) return;
      const before = serializePageNavigatorOverrides(props.overrides);
      const nextList = applyPageOverrideEdit(props.overrides, pages, page, edit);
      const after = serializePageNavigatorOverrides(nextList);
      // An unchanged list is not a write.
      if (after === before) return;
      const why = checkPageNavigatorOverrides(after);
      if (why) {
        showToast(why, { type: "error" });
        return;
      }
      try {
        await onWrite(nextList);
      } catch (err) {
        console.error("[Controls] Could not change the page buttons:", err);
      }
    },
    [readOnly, props.overrides, pages, onWrite],
  );

  const toggle = (key: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (listed.length === 0) {
    return (
      <div style={emptyStyle} data-testid="nav-buttons-empty">
        This workbook has no report pages to list yet. Each canvas page you add gets a button here.
      </div>
    );
  }

  return (
    <div>
      {listed.map((page) => {
        const key = navigatorItemKey(page);
        const override = matchPageNavigatorOverride(props.overrides, page, pages);
        const isOpen = expanded.has(key);
        const isSelected = selectedKey === key;
        const hidden = override?.hidden === true;
        const caption = override?.text ? override.text : page.name;
        // A binding target per field, keyed by the PAGE (never an index).
        const bindingFor = (field: string): PageButtonBinding | null =>
          bindingRef && !readOnly ? { object: bindingRef, path: pageButtonPointer(key, field) } : null;
        return (
          <div
            key={key}
            ref={(el) => {
              if (el) rowRefs.current.set(key, el);
              else rowRefs.current.delete(key);
            }}
          >
            <button
              type="button"
              data-testid={`nav-buttons-row-${key}`}
              aria-expanded={isOpen}
              style={{ ...rowHeaderStyle, ...(isSelected ? rowHeaderSelectedStyle : {}) }}
              onClick={() => toggle(key)}
            >
              <span style={chevronStyle}>{isOpen ? "▾" : "▸"}</span>
              <span style={{ ...captionLabelStyle, ...(hidden ? { color: v("--text-disabled") } : {}) }}>
                {caption}
              </span>
              {hidden && <span style={badgeStyle}>not shown</span>}
              {!hidden && page.visibility !== "visible" && <span style={badgeStyle}>hidden page</span>}
              {page.isTooltipPage && <span style={badgeStyle}>tooltip</span>}
            </button>
            {isOpen && (
              <div style={bodyStyle}>
                <div style={fieldStyle}>
                  <span style={labelStyle}>Caption</span>
                  {withFx(
                    bindingFor("text"),
                    "Caption",
                    <CaptionInput
                      testId={`nav-buttons-caption-${key}`}
                      value={override?.text ?? ""}
                      placeholder={page.name}
                      disabled={readOnly}
                      onCommit={(text) => void commit(page, { text })}
                    />,
                  )}
                </div>
                <label style={checkboxRowStyle}>
                  <ShowCheckbox
                    testId={`nav-buttons-show-${key}`}
                    shown={!hidden}
                    disabled={readOnly}
                    onCommit={(shown) => commit(page, { hidden: !shown })}
                  />
                  Show this page&apos;s button
                </label>
                <ColourField
                  label="Fill"
                  testId={`nav-buttons-fill-${key}`}
                  value={override?.fill}
                  inherited={props.fill}
                  disabled={readOnly}
                  onChange={(fill) => void commit(page, { fill })}
                  binding={bindingFor("fill")}
                />
                <ColourField
                  label="Text colour"
                  testId={`nav-buttons-color-${key}`}
                  value={override?.color}
                  inherited={props.color}
                  disabled={readOnly}
                  onChange={(color) => void commit(page, { color })}
                  binding={bindingFor("color")}
                />
                <ColourField
                  label="Border colour"
                  testId={`nav-buttons-border-${key}`}
                  value={override?.borderColor}
                  inherited={props.borderColor}
                  disabled={readOnly}
                  onChange={(borderColor) => void commit(page, { borderColor })}
                  binding={bindingFor("borderColor")}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
