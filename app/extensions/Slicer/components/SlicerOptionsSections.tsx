//! FILENAME: app/extensions/Slicer/components/SlicerOptionsSections.tsx
// PURPOSE: Panel sections for the contextual "Slicer" ribbon panel shown when
//          a slicer is selected: Properties, Buttons, Slicer Styles, Size and
//          Actions. Supports multi-select: shows common values, empty for mixed.
// CONTEXT: Replaces the former SlicerOptionsTab monolith (useRibbonCollapse +
//          RibbonGroup). The Shell now owns all group chrome and collapse —
//          each section renders only its controls via @api/layout primitives,
//          and the panel definition in ../manifest.ts carries the collapse
//          priorities. Selection state is shared across sections through a
//          module-level snapshot fed by SLICER_UPDATED / "slicer:deselected"
//          window events (one listener set + one computed-attrs fetch total,
//          ref-counted by mounted sections).
//
//          Calcula Clusters: every section fills the band's 61px content box
//          one of the two sanctioned ways (@api/layout tokens.ts, "the fill
//          rule") — Properties, Buttons and Size as TWO 28px ROWS (28 + 5 +
//          28), Slicer Styles and Actions as ONE TALL ROW (the StyleGallery
//          strip; four CommandButton heroes). An attribute driven by computed
//          properties is a genuinely DISABLED control carrying the explanation
//          as its title — not a dimmed, pointer-events:none wrapper, which left
//          the control focusable and operable from the keyboard.
//
//          Colours come only from LT (@api/layout); style thumbnails are data.

import React, { useEffect, useState } from "react";
import { css } from "@emotion/css";
import type { PanelSectionProps } from "@api/uiTypes";
import {
  ActionRow,
  Checkbox,
  CommandButton,
  ControlGrid,
  ControlGridBreak,
  Dropdown,
  Field,
  FIELD_HEIGHT,
  FONT_FAMILY,
  GAP_XS,
  HERO_ICON_SIZE,
  Input,
  LABEL_FONT_SIZE,
  LT,
  ROW_GAP,
  Stack,
  useSurfaceLayout,
  type DropdownOption,
} from "@api/layout";
import { RibbonIcon } from "@api/ribbonIcons";
import { showDialog } from "@api";
import { requestOverlayRedraw } from "@api/gridOverlays";
import {
  getSlicerById,
  updateSlicerAsync,
  commitSlicerGeometryAsync,
  deleteSlicerAsync,
} from "../lib/slicerStore";
import {
  SLICER_SETTINGS_DIALOG_ID,
  SLICER_COMPUTED_PROPS_DIALOG_ID,
  SLICER_CONNECTIONS_DIALOG_ID,
} from "../manifest";
import { SlicerEvents } from "../lib/slicerEvents";
import type { Slicer } from "../lib/slicerTypes";
import { SlicerStylesGallery } from "./SlicerStylesGallery";
import { broadcastSelectedSlicers, getSelectedSlicerIds } from "../handlers/selectionHandler";
import { getSlicerComputedAttributes } from "../lib/slicer-api";

// ============================================================================
// Helpers
// ============================================================================

/** Sentinel for mixed/indeterminate values across multi-selected slicers. */
const MIXED = Symbol("mixed");
type MaybeValue<T> = T | typeof MIXED;

/** Get a common value from all slicers, or MIXED if they differ. */
function commonValue<T>(slicers: Slicer[], getter: (s: Slicer) => T): MaybeValue<T> {
  if (slicers.length === 0) return MIXED;
  const first = getter(slicers[0]);
  for (let i = 1; i < slicers.length; i++) {
    if (getter(slicers[i]) !== first) return MIXED;
  }
  return first;
}

/** Tooltip shown on attributes controlled by computed properties. */
const computedTitle = "This attribute is controlled via computed properties";

/** Commit text inputs on Enter (blur triggers the save handler). */
const handleEnterBlur = (e: React.KeyboardEvent): void => {
  if (e.key === "Enter") {
    (e.target as HTMLInputElement).blur();
  }
};

// ============================================================================
// Shared selection snapshot (module singleton)
// ============================================================================
// All five sections render the SAME selection, so the window-event
// subscription and the computed-attributes fetch live here once instead of
// per-section. Listeners are ref-counted: attached when the first section
// mounts, detached when the last unmounts (re-reading the live selection on
// re-attach, since panel registration events fire before sections mount).

interface SlicerSelectionSnapshot {
  /** Currently selected slicers (last entry = primary/last-clicked). */
  slicers: Slicer[];
  /** Attribute names controlled by computed properties (single-select only). */
  computedAttrs: Set<string>;
}

let snapshot: SlicerSelectionSnapshot = { slicers: [], computedAttrs: new Set() };
const snapshotListeners = new Set<() => void>();

function setSnapshot(next: SlicerSelectionSnapshot): void {
  snapshot = next;
  for (const listener of Array.from(snapshotListeners)) {
    listener();
  }
}

/** Clear the selection snapshot (delete action / deselect event). */
function clearSnapshot(): void {
  setSnapshot({ slicers: [], computedAttrs: new Set() });
}

/** Apply a slicer array to the snapshot (ignores empty broadcasts). */
function applySlicerSelection(arr: Slicer[]): void {
  if (arr.length === 0) return;

  if (arr.length === 1) {
    // Keep previous computedAttrs until the fetch resolves (matches the old
    // tab, which only replaced them asynchronously).
    setSnapshot({ slicers: arr, computedAttrs: snapshot.computedAttrs });
    getSlicerComputedAttributes(arr[0].id).then((attrs) => {
      setSnapshot({ slicers: snapshot.slicers, computedAttrs: new Set(attrs) });
    });
  } else {
    setSnapshot({ slicers: arr, computedAttrs: new Set() });
  }
}

function handleUpdatedEvent(e: Event): void {
  const detail = (e as CustomEvent).detail;
  const arr = Array.isArray(detail) ? (detail as Slicer[]) : detail ? [detail as Slicer] : [];
  applySlicerSelection(arr);
}

function handleDeselectedEvent(): void {
  clearSnapshot();
}

function attachSelectionListeners(): void {
  // Populate initial state from the current selection (the SLICER_UPDATED
  // event that triggered panel registration fires before sections mount,
  // so we read the current selection directly on attach).
  const selectedIds = getSelectedSlicerIds();
  if (selectedIds.size > 0) {
    const initial: Slicer[] = [];
    for (const id of selectedIds) {
      const s = getSlicerById(id);
      if (s) initial.push(s);
    }
    applySlicerSelection(initial);
  }

  window.addEventListener(SlicerEvents.SLICER_UPDATED, handleUpdatedEvent);
  window.addEventListener("slicer:deselected", handleDeselectedEvent);
}

function detachSelectionListeners(): void {
  window.removeEventListener(SlicerEvents.SLICER_UPDATED, handleUpdatedEvent);
  window.removeEventListener("slicer:deselected", handleDeselectedEvent);
}

/** Subscribe a section to the shared selection snapshot. */
function useSelectedSlicers(): SlicerSelectionSnapshot {
  const [state, setState] = useState(snapshot);

  useEffect(() => {
    const listener = () => setState(snapshot);
    if (snapshotListeners.size === 0) {
      attachSelectionListeners();
    }
    snapshotListeners.add(listener);
    // Sync in case the snapshot changed between render and mount.
    listener();
    return () => {
      snapshotListeners.delete(listener);
      if (snapshotListeners.size === 0) {
        detachSelectionListeners();
      }
    };
  }, []);

  return state;
}

/** Apply an update to all selected slicers, then rebroadcast + repaint. */
async function updateAllSlicers(
  slicers: Slicer[],
  params: Parameters<typeof updateSlicerAsync>[1],
): Promise<void> {
  const updates = slicers.map((s) => updateSlicerAsync(s.id, params));
  await Promise.all(updates);
  broadcastSelectedSlicers();
  requestOverlayRedraw();
}

// ============================================================================
// Styles (only the bits @api/layout has no primitive for)
// ============================================================================

const styles = {
  /** Empty state: shown in the Properties cluster when nothing is selected. */
  disabledMessage: css`
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    color: ${LT.textTertiary};
    font-family: ${FONT_FAMILY};
    font-style: italic;
    font-size: 12px;
  `,
  /** A band label that owns a whole 28px row (see StackedField). */
  stackedLabel: css`
    display: flex;
    align-items: center;
    height: ${FIELD_HEIGHT}px;
    font-family: ${FONT_FAMILY};
    font-size: ${LABEL_FONT_SIZE}px;
    line-height: 13px;
    color: ${LT.textSecondary};
    white-space: nowrap;
  `,
};

/** Width of the Name / Header inputs in the band (panel: full width). */
const TEXT_INPUT_BAND_WIDTH = 120;
/** Width of the Columns dropdown: one digit, or the mixed dash. */
const COLUMNS_DROPDOWN_WIDTH = 64;

/** True when the section is rendering into the ribbon band. */
function useIsBand(): boolean {
  return useSurfaceLayout().container === "band";
}

/**
 * A single labelled control that must still fill the band's content box.
 * Inline (label beside control) it would be ONE short row floating in a
 * 61px card, which the fill rule forbids; so in the band the label takes the
 * first 28px row and the control the second (28 + 5 + 28). Elsewhere it is
 * the ordinary label-above Field.
 */
function StackedField({
  label,
  title,
  children,
}: {
  label: string;
  title?: string;
  children: React.ReactNode;
}): React.ReactElement {
  const band = useIsBand();
  if (!band) {
    return (
      <div title={title}>
        <Field label={label}>{children}</Field>
      </div>
    );
  }
  return (
    <div
      title={title}
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: ROW_GAP,
        height: "100%",
      }}
    >
      <span className={styles.stackedLabel}>{label}</span>
      <div style={{ display: "flex", alignItems: "center", height: FIELD_HEIGHT }}>{children}</div>
    </div>
  );
}

// ============================================================================
// Properties section — name, header text, show-header toggle
// ============================================================================

export function SlicerPropertiesSection(_props: PanelSectionProps): React.ReactElement {
  const { slicers, computedAttrs } = useSelectedSlicers();
  const band = useIsBand();
  const [slicerName, setSlicerName] = useState("");
  const [headerText, setHeaderText] = useState("");

  // Re-derive the editable drafts whenever the selection broadcasts.
  useEffect(() => {
    if (slicers.length === 1) {
      const s = slicers[0];
      setSlicerName(s.name);
      setHeaderText(s.headerText ?? s.name);
    } else {
      setSlicerName("");
      setHeaderText("");
    }
  }, [slicers]);

  if (slicers.length === 0) {
    return (
      <div className={styles.disabledMessage}>
        Select a slicer to configure it.
      </div>
    );
  }

  const isMulti = slicers.length > 1;
  const primary = slicers[slicers.length - 1];
  const isComputed = (attr: string) => computedAttrs.has(attr);
  const commonShowHeader = commonValue(slicers, (s) => s.showHeader);

  // --- Name (single-select only) ---
  const handleNameBlur = async () => {
    if (isMulti) return;
    const trimmed = slicerName.trim();
    if (trimmed && trimmed !== primary.name) {
      await updateSlicerAsync(primary.id, { name: trimmed });
      broadcastSelectedSlicers();
    } else {
      setSlicerName(primary.name);
    }
  };

  // --- Header Text (single-select only) ---
  const handleHeaderTextBlur = async () => {
    if (isMulti) return;
    const trimmed = headerText.trim();
    const currentHeader = primary.headerText ?? primary.name;
    if (trimmed !== currentHeader) {
      const newHeaderText = trimmed === primary.name ? null : (trimmed || null);
      await updateSlicerAsync(primary.id, { headerText: newHeaderText });
      broadcastSelectedSlicers();
      requestOverlayRedraw();
    }
  };

  // --- Show Header ---
  const handleShowHeaderChange = async (checked: boolean) => {
    await updateAllSlicers(slicers, { showHeader: checked });
  };

  const inputWidth = band ? TEXT_INPUT_BAND_WIDTH : undefined;
  const headerComputed = isComputed("headerText");
  const showHeaderComputed = isComputed("showHeader");

  const nameField = (
    <Field label="Name:">
      <Input
        width={inputWidth}
        value={isMulti ? `(${slicers.length} slicers)` : slicerName}
        onChange={(e) => setSlicerName(e.target.value)}
        onBlur={handleNameBlur}
        onKeyDown={handleEnterBlur}
        disabled={isMulti}
        title={isMulti ? "Name editing not available for multiple slicers" : undefined}
      />
    </Field>
  );

  const headerField = (
    <Field label="Header:">
      <Input
        width={inputWidth}
        value={isMulti ? "" : headerText}
        onChange={(e) => setHeaderText(e.target.value)}
        onBlur={handleHeaderTextBlur}
        onKeyDown={handleEnterBlur}
        disabled={isMulti || headerComputed}
        title={
          headerComputed
            ? computedTitle
            : isMulti
              ? "Header editing not available for multiple slicers"
              : "Header display text (shown in the header bar)"
        }
        placeholder={isMulti ? "(multiple)" : undefined}
      />
    </Field>
  );

  const showHeaderToggle = (
    <Checkbox
      label="Show Header"
      checked={commonShowHeader === MIXED ? false : commonShowHeader}
      indeterminate={commonShowHeader === MIXED}
      onChange={(checked) => handleShowHeaderChange(checked)}
      disabled={showHeaderComputed}
      // On the whole row (the label is not disabled, so it still hovers) and
      // given to assistive tech as the input's description.
      tooltip={showHeaderComputed ? computedTitle : undefined}
    />
  );

  // Band: two rows — the name, then the header text beside its show/hide
  // toggle. Panel: one labelled field per line.
  if (band) {
    return (
      <ControlGrid gap={GAP_XS * 2}>
        {nameField}
        <ControlGridBreak />
        {headerField}
        {showHeaderToggle}
      </ControlGrid>
    );
  }

  return (
    <Stack gap={ROW_GAP}>
      {nameField}
      {headerField}
      {showHeaderToggle}
    </Stack>
  );
}

// ============================================================================
// Buttons section — column count
// ============================================================================

/** The column counts a slicer's button grid offers. */
const COLUMN_OPTIONS: ReadonlyArray<DropdownOption<number | null>> = [1, 2, 3, 4, 5].map((n) => ({
  value: n,
  label: String(n),
}));

export function SlicerButtonsSection(_props: PanelSectionProps): React.ReactElement {
  const { slicers, computedAttrs } = useSelectedSlicers();

  if (slicers.length === 0) return <></>;

  const columnsComputed = computedAttrs.has("columns");
  const commonColumns = commonValue(slicers, (s) => s.columns);

  const handleColumnsChange = async (value: number | null) => {
    if (value === null) return;
    await updateAllSlicers(slicers, { columns: value });
  };

  return (
    <StackedField label="Columns:" title={columnsComputed ? computedTitle : undefined}>
      <Dropdown<number | null>
        ariaLabel="Columns"
        value={commonColumns === MIXED ? null : commonColumns}
        options={COLUMN_OPTIONS}
        // A mixed multi-selection matches no option and shows the dash.
        placeholder="-"
        onChange={handleColumnsChange}
        disabled={columnsComputed}
        width={COLUMNS_DROPDOWN_WIDTH}
      />
    </StackedField>
  );
}

// ============================================================================
// Slicer Styles section — hosts the self-managing gallery widget
// ============================================================================

export function SlicerStylesSection(_props: PanelSectionProps): React.ReactElement {
  const { slicers } = useSelectedSlicers();

  if (slicers.length === 0) return <></>;

  const commonStyle = commonValue(slicers, (s) => s.stylePreset);

  const handleStyleChange = async (stylePreset: string) => {
    await updateAllSlicers(slicers, { stylePreset });
  };

  return (
    <SlicerStylesGallery
      selectedStyleId={commonStyle === MIXED ? null : commonStyle}
      onStyleSelect={handleStyleChange}
    />
  );
}

// ============================================================================
// Size section — width / height
// ============================================================================

export function SlicerSizeSection(_props: PanelSectionProps): React.ReactElement {
  const { slicers, computedAttrs } = useSelectedSlicers();
  const band = useIsBand();
  const [widthStr, setWidthStr] = useState("");
  const [heightStr, setHeightStr] = useState("");

  // Re-derive the editable drafts whenever the selection broadcasts.
  useEffect(() => {
    const cw = commonValue(slicers, (s) => Math.round(s.width));
    setWidthStr(cw === MIXED ? "" : cw.toString());
    const ch = commonValue(slicers, (s) => Math.round(s.height));
    setHeightStr(ch === MIXED ? "" : ch.toString());
  }, [slicers]);

  if (slicers.length === 0) return <></>;

  const isMulti = slicers.length > 1;
  const isComputed = (attr: string) => computedAttrs.has(attr);

  const handleWidthBlur = async () => {
    const val = parseInt(widthStr, 10);
    if (!isNaN(val) && val >= 60) {
      // Every selected slicer resized as ONE undo step; a refusal (a
      // protected sheet) reverts them all and is told once.
      const writes = slicers
        .filter((s) => val !== Math.round(s.width))
        .map((s) => ({ slicerId: s.id, x: s.x, y: s.y, width: val, height: s.height }));
      await commitSlicerGeometryAsync(writes, writes.length > 1 ? "Resize Slicers" : "Resize Slicer");
      broadcastSelectedSlicers();
      requestOverlayRedraw();
    } else {
      // Reset to common value or empty
      const cw = commonValue(slicers, (s) => Math.round(s.width));
      setWidthStr(cw === MIXED ? "" : cw.toString());
    }
  };

  const handleHeightBlur = async () => {
    const val = parseInt(heightStr, 10);
    if (!isNaN(val) && val >= 60) {
      const writes = slicers
        .filter((s) => val !== Math.round(s.height))
        .map((s) => ({ slicerId: s.id, x: s.x, y: s.y, width: s.width, height: val }));
      await commitSlicerGeometryAsync(writes, writes.length > 1 ? "Resize Slicers" : "Resize Slicer");
      broadcastSelectedSlicers();
      requestOverlayRedraw();
    } else {
      const ch = commonValue(slicers, (s) => Math.round(s.height));
      setHeightStr(ch === MIXED ? "" : ch.toString());
    }
  };

  const widthField = (
    <Field label="Width:">
      <Input
        value={widthStr}
        onChange={(e) => setWidthStr(e.target.value)}
        onBlur={handleWidthBlur}
        onKeyDown={handleEnterBlur}
        type="number"
        min={60}
        placeholder={isMulti ? "-" : undefined}
        disabled={isComputed("width")}
        title={isComputed("width") ? computedTitle : undefined}
      />
    </Field>
  );

  const heightField = (
    <Field label="Height:">
      <Input
        value={heightStr}
        onChange={(e) => setHeightStr(e.target.value)}
        onBlur={handleHeightBlur}
        onKeyDown={handleEnterBlur}
        type="number"
        min={60}
        placeholder={isMulti ? "-" : undefined}
        disabled={isComputed("height")}
        title={isComputed("height") ? computedTitle : undefined}
      />
    </Field>
  );

  // Band: two rows (28 + 5 + 28). The explicit break is needed because a
  // two-child grid is below ControlGrid's split threshold and would otherwise
  // stay one short row. Panel: one field per line.
  if (band) {
    return (
      <ControlGrid>
        {widthField}
        <ControlGridBreak />
        {heightField}
      </ControlGrid>
    );
  }

  return (
    <Stack gap={ROW_GAP}>
      {widthField}
      {heightField}
    </Stack>
  );
}

// ============================================================================
// Actions section — settings / connections / computed / delete
// ============================================================================

export function SlicerActionsSection(_props: PanelSectionProps): React.ReactElement {
  const { slicers } = useSelectedSlicers();

  if (slicers.length === 0) return <></>;

  const isMulti = slicers.length > 1;
  const primary = slicers[slicers.length - 1];

  const handleDelete = async () => {
    await Promise.all(slicers.map((s) => deleteSlicerAsync(s.id)));
    clearSnapshot();
  };

  // Four heroes: one tall row. The dialog commands act on ONE slicer, so they
  // are disabled while several are selected; Delete acts on all of them.
  return (
    <ActionRow gap={GAP_XS}>
      <CommandButton
        icon={<RibbonIcon.Settings size={HERO_ICON_SIZE} />}
        label="Settings"
        onClick={() => showDialog(SLICER_SETTINGS_DIALOG_ID, { slicerId: primary.id })}
        tooltip={
          isMulti
            ? "Open settings for the last selected slicer"
            : "Open slicer settings (layout, selection behavior, data display)"
        }
        disabled={isMulti}
      />
      <CommandButton
        icon={<RibbonIcon.Connection size={HERO_ICON_SIZE} />}
        // "Report Connections" overflows a hero's 92px label; the full name
        // stays the accessible name (and contains the visible text).
        label="Connections"
        aria-label="Report Connections"
        onClick={() => showDialog(SLICER_CONNECTIONS_DIALOG_ID, { slicerId: primary.id })}
        tooltip={
          isMulti
            ? "Manage report connections for the last selected slicer"
            : "Report Connections: choose which PivotTables this slicer filters"
        }
        disabled={isMulti}
      />
      <CommandButton
        icon={<RibbonIcon.Fx size={HERO_ICON_SIZE} />}
        label="Computed"
        onClick={() => showDialog(SLICER_COMPUTED_PROPS_DIALOG_ID, { slicerId: primary.id })}
        tooltip={
          isMulti
            ? "Open computed properties for the last selected slicer"
            : "Formula-driven attributes for this slicer"
        }
        disabled={isMulti}
      />
      <CommandButton
        icon={<RibbonIcon.Delete size={HERO_ICON_SIZE} />}
        label={`Delete${isMulti ? ` (${slicers.length})` : ""}`}
        onClick={handleDelete}
        tooltip={isMulti ? `Delete ${slicers.length} selected slicers` : "Delete this slicer"}
      />
    </ActionRow>
  );
}
