//! FILENAME: app/extensions/Slicer/components/SlicerSettingsBody.tsx
// PURPOSE: The Slicer Settings FIELDS -- selection, filtering, data display and
//          the multi-button layout -- lifted out of SlicerSettingsDialog.tsx so
//          the dialog and the object pane's Settings tab (WP-C D-PANE) render
//          the SAME controls and commit through the SAME step.
// CONTEXT: Two hosts, one body:
//            "dialog" -- the Slicer Settings dialog's two panes, edited as a
//                        draft and committed on OK (unchanged behaviour);
//            "pane"   -- the object pane's Settings tab, one column, every
//                        change committed AT ONCE as its own undo step (a
//                        number when its box is left or Enter is pressed, so
//                        typing "12" is one step, not two).
//          The commit is `commitSlicerSettings`: ONE "Slicer Settings" step for
//          the settings AND the filter a level change re-routes, asked about a
//          pivot overwrite ONCE after the step commits -- the dialog's rule,
//          now in one place.
//          The title text / visibility are not here: they are the container's
//          title, edited on the Format tab (one editor per fact).

import React, { useEffect, useState } from "react";
import { DialogBody, DialogPane, DialogFieldGrid, DialogFieldSpan } from "@api/dialogLayout";
import { LT } from "@api/layout";
import { runStepThenConfirmOverwrite } from "@api/pivotOverwrite";
import { requestOverlayRedraw } from "@api/gridOverlays";
import { getSlicerById, updateSlicerAsync } from "../lib/slicerStore";
import { applySlicerFilter } from "../lib/slicerFilterBridge";
import type { Slicer, SlicerArrangement, SlicerSelectionMode, UpdateSlicerParams } from "../lib/slicerTypes";

// ============================================================================
// The values
// ============================================================================

/** Everything the settings body edits. */
export interface SlicerSettingsValues {
  singleSelect: boolean;
  forceSelection: boolean;
  showSelectAll: boolean;
  filterLevel: number;
  hideNoData: boolean;
  indicateNoData: boolean;
  sortNoDataLast: boolean;
  arrangement: SlicerArrangement;
  rows: number;
  columns: number;
  autogrid: boolean;
  itemGap: number;
  itemPadding: number;
  buttonRadius: number;
}

/** "Reset to default". */
export const DEFAULT_SLICER_SETTINGS: Readonly<SlicerSettingsValues> = Object.freeze({
  singleSelect: false,
  forceSelection: false,
  showSelectAll: false,
  filterLevel: 1,
  hideNoData: false,
  indicateNoData: true,
  sortNoDataLast: true,
  arrangement: "vertical",
  rows: 3,
  columns: 1,
  autogrid: true,
  itemGap: 4,
  itemPadding: 0,
  buttonRadius: 2,
});

/** A slicer's current settings. */
export function slicerSettingsValuesOf(slicer: Slicer): SlicerSettingsValues {
  return {
    singleSelect: slicer.selectionMode === "single",
    forceSelection: slicer.forceSelection,
    showSelectAll: slicer.showSelectAll,
    filterLevel: slicer.filterLevel ?? 1,
    hideNoData: slicer.hideNoData,
    indicateNoData: slicer.indicateNoData,
    sortNoDataLast: slicer.sortNoDataLast,
    arrangement: slicer.arrangement,
    rows: slicer.rows || 3,
    columns: slicer.columns,
    autogrid: slicer.autogrid,
    itemGap: slicer.itemGap,
    itemPadding: slicer.itemPadding,
    buttonRadius: slicer.buttonRadius,
  };
}

/** The update params for some settings (only the keys `values` carries). */
export function slicerSettingsParams(values: Partial<SlicerSettingsValues>): UpdateSlicerParams {
  const out: UpdateSlicerParams = {};
  for (const [key, value] of Object.entries(values) as Array<[keyof SlicerSettingsValues, unknown]>) {
    if (value === undefined) continue;
    if (key === "singleSelect") {
      out.selectionMode = (value ? "single" : "standard") as SlicerSelectionMode;
    } else {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

/**
 * Commit settings as ONE "Slicer Settings" step: the update AND, when the
 * filter level changed while a selection is active, the re-routed filter
 * (moving a filter into or out of a pivot's query re-queries the pivot, which
 * records its definition -- joining this step), so one Ctrl+Z puts the slicer
 * and its pivots back together. A re-routed filter that grows a pivot over
 * the user's cells is asked about ONCE after the step commits; a decline takes
 * back the whole step (settings included). Inside someone else's open
 * transaction (a script batch) it never asks.
 */
export async function commitSlicerSettings(slicerId: string, params: UpdateSlicerParams): Promise<void> {
  if (Object.keys(params).length === 0) return;
  const levelChanged = params.filterLevel !== undefined && getSlicerById(slicerId)?.filterLevel !== params.filterLevel;
  await runStepThenConfirmOverwrite("Slicer Settings", async (overwrites) => {
    await updateSlicerAsync(slicerId, params);
    // A level change moves an ACTIVE selection between the host-side mask
    // and the engine-routed (pinned) filter -- re-apply so the connected
    // pivots pick up the new routing.
    if (levelChanged) {
      const fresh = getSlicerById(slicerId);
      if (fresh && fresh.selectedItems !== null) {
        await applySlicerFilter(fresh, { overwrites });
      }
    }
  });
  requestOverlayRedraw();
}

// ============================================================================
// The body
// ============================================================================

export type SlicerSettingsVariant = "dialog" | "pane";

export interface SlicerSettingsBodyProps {
  values: SlicerSettingsValues;
  /** One or more settings changed (the dialog keeps them; the pane commits them). */
  onChange(patch: Partial<SlicerSettingsValues>): void;
  /** Attributes driven by computed properties (disabled with a reason). */
  computedAttrs: ReadonlySet<string>;
  variant: SlicerSettingsVariant;
  /** Every control disabled (a subscribed page). */
  disabled?: boolean;
}

const COMPUTED_TITLE = "Controlled via computed properties";

const LEVEL_OPTIONS = [
  { value: "1", label: "1 — ordinary" },
  { value: "2", label: "2 — pinned" },
  { value: "3", label: "3 — pinned" },
  { value: "4", label: "4 — pinned" },
  { value: "5", label: "5 — pinned" },
  { value: "6", label: "6 — pinned" },
  { value: "7", label: "7 — pinned" },
  { value: "8", label: "8 — pinned" },
  { value: "9", label: "9 — pinned" },
];

const ARRANGEMENT_OPTIONS = [
  { value: "vertical", label: "Vertical" },
  { value: "horizontal", label: "Horizontal" },
  { value: "grid", label: "Grid" },
];

/** The settings controls, laid out for their host. */
export function SlicerSettingsBody({
  values,
  onChange,
  computedAttrs,
  variant,
  disabled = false,
}: SlicerSettingsBodyProps): React.ReactElement {
  const t = THEMES[variant];
  const isComputed = (attr: string) => computedAttrs.has(attr);
  const commitNumbersOnBlur = variant === "pane";
  const rowProps = { theme: t, disabledAll: disabled };

  const selection = (
    <Section title="Selection" theme={t}>
      <ToggleRow {...rowProps} id="singleSelect" label="Single select" checked={values.singleSelect} onChange={(v) => onChange({ singleSelect: v })} />
      <ToggleRow {...rowProps} id="forceSelection" label="Force selection" checked={values.forceSelection} onChange={(v) => onChange({ forceSelection: v })} />
      <ToggleRow
        {...rowProps}
        id="showSelectAll"
        label={'Show "Select all" option'}
        checked={values.showSelectAll}
        onChange={(v) => onChange({ showSelectAll: v })}
      />
    </Section>
  );

  const filtering = (
    <Section title="Filtering" theme={t}>
      <SelectRow
        {...rowProps}
        id="filterLevel"
        label="Filter level"
        value={String(values.filterLevel)}
        options={LEVEL_OPTIONS}
        onChange={(v) => onChange({ filterLevel: Number(v) })}
      />
      <div style={{ fontSize: 11, opacity: 0.75, padding: "2px 4px 4px", color: t.label }}>
        A pinned slicer (level 2+) keeps filtering even when a measure
        uses CLEAR or RESET — only an explicit CLEAR(…, LEVEL n) at or
        above its level removes it.
      </div>
    </Section>
  );

  const dataDisplay = (
    <Section title="Data display" theme={t}>
      <ToggleRow
        {...rowProps}
        id="hideNoData"
        label="Hide items with no data"
        checked={values.hideNoData}
        onChange={(v) => onChange({ hideNoData: v })}
        disabled={isComputed("hideNoData")}
        title={isComputed("hideNoData") ? COMPUTED_TITLE : undefined}
      />
      <ToggleRow
        {...rowProps}
        id="indicateNoData"
        label="Visually indicate items with no data"
        checked={values.indicateNoData}
        onChange={(v) => onChange({ indicateNoData: v })}
        disabled={values.hideNoData || isComputed("indicateNoData")}
        title={isComputed("indicateNoData") ? COMPUTED_TITLE : undefined}
      />
      <ToggleRow
        {...rowProps}
        id="sortNoDataLast"
        label="Show items with no data last"
        checked={values.sortNoDataLast}
        onChange={(v) => onChange({ sortNoDataLast: v })}
        disabled={values.hideNoData || isComputed("sortNoDataLast")}
        title={isComputed("sortNoDataLast") ? COMPUTED_TITLE : undefined}
      />
    </Section>
  );

  const numberProps = { ...rowProps, commitOnBlur: commitNumbersOnBlur };
  const layout = (
    <Section title="Multi-button layout" theme={t}>
      {/* Layout sub-section -- the narrow numeric fields flow into two
          columns instead of one row each; Arrangement spans both because it
          decides which of the others appear. */}
      <Section title="Layout" theme={t}>
        <DialogFieldGrid minColumnWidth={120} maxColumns={2} columnGap={16}>
          <DialogFieldSpan>
            <SelectRow
              {...rowProps}
              id="arrangement"
              label="Arrangement"
              value={values.arrangement}
              options={ARRANGEMENT_OPTIONS}
              onChange={(v) => onChange({ arrangement: v as SlicerArrangement })}
            />
          </DialogFieldSpan>
          {values.arrangement === "grid" && (
            <>
              <NumberRow {...numberProps} id="rows" label="Rows" value={values.rows} onChange={(v) => onChange({ rows: v })} min={1} max={20} disabled={values.autogrid} />
              <NumberRow
                {...numberProps}
                id="columns"
                label="Columns"
                value={values.columns}
                onChange={(v) => onChange({ columns: v })}
                min={1}
                max={10}
                disabled={values.autogrid || isComputed("columns")}
                title={isComputed("columns") ? COMPUTED_TITLE : undefined}
              />
              <ToggleRow {...rowProps} id="autogrid" label="Autogrid" checked={values.autogrid} onChange={(v) => onChange({ autogrid: v })} />
            </>
          )}
          {values.arrangement === "horizontal" && (
            <NumberRow
              {...numberProps}
              id="columns"
              label="Columns"
              value={values.columns}
              onChange={(v) => onChange({ columns: v })}
              min={1}
              max={20}
              disabled={isComputed("columns")}
              title={isComputed("columns") ? COMPUTED_TITLE : undefined}
            />
          )}
          {values.arrangement === "vertical" && (
            <NumberRow {...numberProps} id="rows" label="Rows visible" value={values.rows} onChange={(v) => onChange({ rows: v })} min={1} max={50} />
          )}
        </DialogFieldGrid>
      </Section>

      {/* Spacing sub-section */}
      <Section title="Spacing" theme={t}>
        <DialogFieldGrid minColumnWidth={120} maxColumns={2} columnGap={16}>
          <NumberRow
            {...numberProps}
            id="itemGap"
            label="Gap between items"
            value={values.itemGap}
            onChange={(v) => onChange({ itemGap: v })}
            min={0}
            max={50}
            suffix="px"
            disabled={isComputed("itemGap")}
            title={isComputed("itemGap") ? COMPUTED_TITLE : undefined}
          />
          <NumberRow
            {...numberProps}
            id="itemPadding"
            label="Inner padding"
            value={values.itemPadding}
            onChange={(v) => onChange({ itemPadding: v })}
            min={0}
            max={30}
            suffix="px"
            disabled={isComputed("itemPadding")}
            title={isComputed("itemPadding") ? COMPUTED_TITLE : undefined}
          />
        </DialogFieldGrid>
      </Section>

      {/* Appearance sub-section */}
      <Section title="Appearance" theme={t}>
        <NumberRow
          {...numberProps}
          id="buttonRadius"
          label="Button corner radius"
          value={values.buttonRadius}
          onChange={(v) => onChange({ buttonRadius: v })}
          min={0}
          max={20}
          suffix="px"
          disabled={isComputed("buttonRadius")}
          title={isComputed("buttonRadius") ? COMPUTED_TITLE : undefined}
        />
      </Section>
    </Section>
  );

  if (variant === "pane") {
    return (
      <div data-testid="slicer-settings-body" data-variant="pane">
        {selection}
        {filtering}
        {dataDisplay}
        {layout}
      </div>
    );
  }

  // Scrollable content, in TWO panes. Fourteen controls stacked in one 340px
  // column came to ~1100px of settings behind a scrollbar, so the two
  // most-used groups were off screen at open. Every dependency stays inside
  // one pane -- hideNoData with the two toggles it disables on the left,
  // arrangement with the rows/columns it chooses on the right -- so nothing
  // reads across the divider.
  return (
    <DialogBody>
      {/* padding 0: the Sections already carry their own 20px side padding */}
      <DialogPane padding="8px 0" data-testid="slicer-settings-pane-left">
        {selection}
        {filtering}
        {dataDisplay}
      </DialogPane>

      {/* The divider is hard-coded #3a3a3a, matching this dialog's own Section
          rules -- DialogSidePane paints from var(--border-default), which does
          not belong to this palette. */}
      <DialogPane padding="8px 0" style={{ borderLeft: "1px solid #3a3a3a" }} data-testid="slicer-settings-pane-right">
        {layout}
      </DialogPane>
    </DialogBody>
  );
}

// ============================================================================
// Themes (the dialog's own dark palette; the pane follows the skin, LT)
// ============================================================================

interface BodyTheme {
  sectionBorder: string;
  sectionTitle: string;
  sectionArrow: string;
  sectionPad: string;
  headerPad: string;
  label: string;
  fieldLabel: string;
  inputBg: string;
  inputBorder: string;
  inputText: string;
  toggleOn: string;
  toggleOff: string;
}

const THEMES: Record<SlicerSettingsVariant, BodyTheme> = {
  dialog: {
    sectionBorder: "#3a3a3a",
    sectionTitle: "#e0e0e0",
    sectionArrow: "#999",
    sectionPad: "0 20px 12px 20px",
    headerPad: "10px 20px",
    label: "#cccccc",
    fieldLabel: "#999999",
    inputBg: "#3a3a3a",
    inputBorder: "#555555",
    inputText: "#e0e0e0",
    toggleOn: "#0e639c",
    toggleOff: "#555555",
  },
  pane: {
    sectionBorder: LT.border,
    sectionTitle: LT.text,
    sectionArrow: LT.textSecondary,
    sectionPad: "0 12px 10px 12px",
    headerPad: "8px 12px",
    label: LT.text,
    fieldLabel: LT.textSecondary,
    inputBg: LT.inputBg,
    inputBorder: LT.controlBorder,
    inputText: LT.text,
    toggleOn: "#0e639c",
    toggleOff: "#8a8a8a",
  },
};

// ============================================================================
// Rows
// ============================================================================

function Section({
  title,
  children,
  defaultOpen = true,
  theme,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  theme: BodyTheme;
}): React.ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ borderBottom: `1px solid ${theme.sectionBorder}` }}>
      <button
        style={{
          display: "flex",
          alignItems: "center",
          gap: "6px",
          width: "100%",
          padding: theme.headerPad,
          background: "transparent",
          border: "none",
          color: theme.sectionTitle,
          fontSize: "13px",
          fontWeight: 600,
          cursor: "pointer",
          textAlign: "left",
        }}
        onClick={() => setOpen(!open)}
        type="button"
      >
        <span
          style={{
            fontSize: "8px",
            color: theme.sectionArrow,
            transition: "transform 0.15s ease",
            display: "inline-block",
            transform: open ? "rotate(90deg)" : "rotate(0deg)",
          }}
        >
          {"▶"}
        </span>
        <span>{title}</span>
      </button>
      {open && <div style={{ padding: theme.sectionPad }}>{children}</div>}
    </div>
  );
}

interface RowBase {
  id: string;
  label: string;
  theme: BodyTheme;
  /** The whole body is disabled (a subscribed page). */
  disabledAll: boolean;
  disabled?: boolean;
  title?: string;
}

const DISABLED_STYLE: React.CSSProperties = { opacity: 0.4, pointerEvents: "none" };

function Toggle({
  checked,
  onChange,
  disabled,
  theme,
  label,
  testId,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  theme: BodyTheme;
  label: string;
  testId: string;
}): React.ReactElement {
  return (
    <button
      style={{
        position: "relative",
        width: "36px",
        height: "20px",
        borderRadius: "10px",
        border: "none",
        padding: 0,
        flexShrink: 0,
        transition: "background-color 0.15s ease",
        backgroundColor: checked ? theme.toggleOn : theme.toggleOff,
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? "default" : "pointer",
      }}
      onClick={() => !disabled && onChange(!checked)}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      data-testid={testId}
    >
      <span
        style={{
          position: "absolute",
          top: "2px",
          left: "0px",
          width: "16px",
          height: "16px",
          borderRadius: "50%",
          backgroundColor: "#ffffff",
          transition: "transform 0.15s ease",
          boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
          transform: checked ? "translateX(16px)" : "translateX(2px)",
        }}
      />
    </button>
  );
}

function ToggleRow({
  id,
  label,
  checked,
  onChange,
  disabled,
  disabledAll,
  title,
  theme,
}: RowBase & { checked: boolean; onChange: (v: boolean) => void }): React.ReactElement {
  const off = disabled || disabledAll;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "12px",
        padding: "5px 0",
        ...(disabled ? DISABLED_STYLE : {}),
      }}
      title={title}
      data-setting={id}
    >
      <span style={{ fontSize: "13px", color: theme.label, flex: 1 }}>{label}</span>
      <Toggle checked={checked} onChange={onChange} disabled={off} theme={theme} label={label} testId={`slicer-setting-${id}`} />
    </div>
  );
}

function SelectRow({
  id,
  label,
  value,
  options,
  onChange,
  disabledAll,
  theme,
}: RowBase & {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}): React.ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "4px", padding: "5px 0" }} data-setting={id}>
      <span style={{ fontSize: "12px", color: theme.fieldLabel }}>{label}</span>
      <select
        style={{
          padding: "6px 8px",
          backgroundColor: theme.inputBg,
          border: `1px solid ${theme.inputBorder}`,
          borderRadius: "4px",
          color: theme.inputText,
          fontSize: "13px",
          cursor: "pointer",
        }}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabledAll}
        aria-label={label}
        data-testid={`slicer-setting-${id}`}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function clampNumber(v: number, min: number | undefined, max: number | undefined): number {
  return Math.max(min ?? 0, Math.min(max ?? 999, v));
}

function NumberRow({
  id,
  label,
  value,
  onChange,
  min,
  max,
  disabled,
  disabledAll,
  suffix,
  title,
  theme,
  commitOnBlur,
}: RowBase & {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  suffix?: string;
  /** The pane: report once the box is left or Enter is pressed, not per keystroke. */
  commitOnBlur: boolean;
}): React.ReactElement {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  const report = (text: string): void => {
    const v = parseInt(text, 10);
    if (isNaN(v)) {
      setDraft(String(value));
      return;
    }
    const clamped = clampNumber(v, min, max);
    setDraft(String(clamped));
    if (clamped !== value) onChange(clamped);
  };

  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: "4px", padding: "5px 0", ...(disabled ? DISABLED_STYLE : {}) }}
      title={title}
      data-setting={id}
    >
      <span style={{ fontSize: "12px", color: theme.fieldLabel }}>{label}</span>
      <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
        <input
          style={{
            padding: "6px 8px",
            backgroundColor: theme.inputBg,
            border: `1px solid ${theme.inputBorder}`,
            borderRadius: "4px",
            color: theme.inputText,
            fontSize: "13px",
            width: "80px",
          }}
          type="number"
          value={commitOnBlur ? draft : value}
          onChange={(e) => {
            if (commitOnBlur) {
              setDraft(e.target.value);
              return;
            }
            const v = parseInt(e.target.value, 10);
            if (!isNaN(v)) onChange(clampNumber(v, min, max));
          }}
          onBlur={commitOnBlur ? (e) => report(e.target.value) : undefined}
          onKeyDown={
            commitOnBlur
              ? (e) => {
                  if (e.key === "Enter") report((e.target as HTMLInputElement).value);
                }
              : undefined
          }
          min={min}
          max={max}
          disabled={disabled || disabledAll}
          aria-label={label}
          data-testid={`slicer-setting-${id}`}
        />
        {suffix && <span style={{ fontSize: "12px", color: theme.fieldLabel }}>{suffix}</span>}
      </div>
    </div>
  );
}
