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

import React, { useEffect, useState } from "react";
import { css } from "@emotion/css";
import type { PanelSectionProps } from "@api/uiTypes";
import { ActionRow, Button, Field, Input, Stack } from "@api/layout";
import { showDialog } from "@api";
import { requestOverlayRedraw } from "@api/gridOverlays";
import {
  getSlicerById,
  updateSlicerAsync,
  updateSlicerPositionAsync,
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
// SVG Icons
// ============================================================================

const SettingsIcon = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M10 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" stroke="currentColor" strokeWidth="1.3" />
    <path d="M16.2 12.2a1.3 1.3 0 00.26 1.43l.05.05a1.58 1.58 0 01-1.12 2.69 1.58 1.58 0 01-1.12-.46l-.05-.05a1.3 1.3 0 00-1.43-.26 1.3 1.3 0 00-.79 1.19v.14a1.58 1.58 0 01-3.16 0v-.07a1.3 1.3 0 00-.85-1.19 1.3 1.3 0 00-1.43.26l-.05.05a1.58 1.58 0 11-2.23-2.23l.05-.05a1.3 1.3 0 00.26-1.43 1.3 1.3 0 00-1.19-.79h-.14a1.58 1.58 0 010-3.16h.07a1.3 1.3 0 001.19-.85 1.3 1.3 0 00-.26-1.43l-.05-.05a1.58 1.58 0 112.23-2.23l.05.05a1.3 1.3 0 001.43.26h.06a1.3 1.3 0 00.79-1.19v-.14a1.58 1.58 0 013.16 0v.07a1.3 1.3 0 00.79 1.19 1.3 1.3 0 001.43-.26l.05-.05a1.58 1.58 0 112.23 2.23l-.05.05a1.3 1.3 0 00-.26 1.43v.06a1.3 1.3 0 001.19.79h.14a1.58 1.58 0 010 3.16h-.07a1.3 1.3 0 00-1.19.79z" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const ComputedIcon = () => (
  <svg width="20" height="20" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M3 5h10M3 9h8M3 13h9M3 17h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
    <path d="M15.5 10.5c.8-2 1.4-3.2 2-3.2s1 .5 1.2.8" stroke="#217346" strokeWidth="1.3" strokeLinecap="round" fill="none"/>
    <path d="M14 15.5l4-4" stroke="#217346" strokeWidth="1.3" strokeLinecap="round"/>
  </svg>
);

const ConnectionsIcon = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="2" y="3" width="6" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
    <rect x="12" y="3" width="6" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
    <rect x="7" y="12" width="6" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
    <path d="M5 8v2.5a1.5 1.5 0 001.5 1.5H7M15 8v2.5a1.5 1.5 0 01-1.5 1.5H13" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
);

const DeleteIcon = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

// ============================================================================
// Styles (only the bits @api/layout has no primitive for)
// ============================================================================

const styles = {
  disabledMessage: css`
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    color: #999;
    font-style: italic;
    font-size: 12px;
  `,
  checkboxLabel: css`
    display: flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
    white-space: nowrap;
    font-size: 11px;
    color: #444;
    input {
      cursor: pointer;
    }
  `,
  columnSelect: css`
    padding: 3px 6px;
    border: 1px solid #d0d0d0;
    border-radius: 3px;
    font-size: 11px;
    background: #fff;
    color: #1a1a1a;
    width: 50px;
    transition: border-color 0.15s;
    &:focus {
      border-color: #4472c4;
      outline: none;
      box-shadow: 0 0 0 1px rgba(68, 114, 196, 0.2);
    }
  `,
  computedOverlay: css`
    opacity: 0.4;
    pointer-events: none;
    position: relative;
  `,
  deleteButton: css`
    color: #c42b1c;
    &:hover:not(:disabled) {
      background: #fde7e7;
      border-color: #e8c4c4;
    }
    &:active:not(:disabled) {
      background: #fbd0d0;
    }
  `,
};

/** Dims + inert-locks a control whose attribute is computed-property driven. */
function ComputedGate({
  computed,
  children,
}: {
  computed: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div
      className={computed ? styles.computedOverlay : undefined}
      title={computed ? computedTitle : undefined}
    >
      {children}
    </div>
  );
}

// ============================================================================
// Properties section — name, header text, show-header toggle
// ============================================================================

export function SlicerPropertiesSection(_props: PanelSectionProps): React.ReactElement {
  const { slicers, computedAttrs } = useSelectedSlicers();
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

  return (
    <Stack>
      <Field label="Name:">
        <Input
          width={120}
          value={isMulti ? `(${slicers.length} slicers)` : slicerName}
          onChange={(e) => setSlicerName(e.target.value)}
          onBlur={handleNameBlur}
          onKeyDown={handleEnterBlur}
          disabled={isMulti}
          title={isMulti ? "Name editing not available for multiple slicers" : undefined}
        />
      </Field>
      <ComputedGate computed={isComputed("headerText")}>
        <Field label="Header:">
          <Input
            width={120}
            value={isMulti ? "" : headerText}
            onChange={(e) => setHeaderText(e.target.value)}
            onBlur={handleHeaderTextBlur}
            onKeyDown={handleEnterBlur}
            disabled={isMulti || isComputed("headerText")}
            title={isComputed("headerText") ? computedTitle : isMulti ? "Header editing not available for multiple slicers" : "Header display text (shown in the header bar)"}
            placeholder={isMulti ? "(multiple)" : undefined}
          />
        </Field>
      </ComputedGate>
      <ComputedGate computed={isComputed("showHeader")}>
        <label className={styles.checkboxLabel}>
          <input
            type="checkbox"
            checked={commonShowHeader === MIXED ? false : commonShowHeader}
            ref={(el) => {
              if (el) el.indeterminate = commonShowHeader === MIXED;
            }}
            onChange={(e) => handleShowHeaderChange(e.target.checked)}
            disabled={isComputed("showHeader")}
          />
          Show Header
        </label>
      </ComputedGate>
    </Stack>
  );
}

// ============================================================================
// Buttons section — column count
// ============================================================================

export function SlicerButtonsSection(_props: PanelSectionProps): React.ReactElement {
  const { slicers, computedAttrs } = useSelectedSlicers();

  if (slicers.length === 0) return <></>;

  const isComputed = (attr: string) => computedAttrs.has(attr);
  const commonColumns = commonValue(slicers, (s) => s.columns);

  const handleColumnsChange = async (value: number) => {
    await updateAllSlicers(slicers, { columns: value });
  };

  return (
    <Stack>
      <ComputedGate computed={isComputed("columns")}>
        <Field label="Columns:">
          <select
            className={styles.columnSelect}
            value={commonColumns === MIXED ? "" : commonColumns}
            onChange={(e) => handleColumnsChange(Number(e.target.value))}
            disabled={isComputed("columns")}
          >
            {commonColumns === MIXED && (
              <option value="" disabled>-</option>
            )}
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>
      </ComputedGate>
    </Stack>
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
      const posUpdates = slicers
        .filter((s) => val !== Math.round(s.width))
        .map((s) => updateSlicerPositionAsync(s.id, s.x, s.y, val, s.height));
      await Promise.all(posUpdates);
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
      const posUpdates = slicers
        .filter((s) => val !== Math.round(s.height))
        .map((s) => updateSlicerPositionAsync(s.id, s.x, s.y, s.width, val));
      await Promise.all(posUpdates);
      broadcastSelectedSlicers();
      requestOverlayRedraw();
    } else {
      const ch = commonValue(slicers, (s) => Math.round(s.height));
      setHeightStr(ch === MIXED ? "" : ch.toString());
    }
  };

  return (
    <Stack>
      <ComputedGate computed={isComputed("width")}>
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
          />
        </Field>
      </ComputedGate>
      <ComputedGate computed={isComputed("height")}>
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
          />
        </Field>
      </ComputedGate>
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

  return (
    <ActionRow>
      <Button
        onClick={() => showDialog(SLICER_SETTINGS_DIALOG_ID, { slicerId: primary.id })}
        title={isMulti ? "Open settings for the last selected slicer" : "Open slicer settings (layout, selection behavior, data display)"}
        disabled={isMulti}
      >
        <SettingsIcon />
        Settings
      </Button>
      <Button
        onClick={() => showDialog(SLICER_CONNECTIONS_DIALOG_ID, { slicerId: primary.id })}
        title={isMulti ? "Manage report connections for the last selected slicer" : "Choose which PivotTables this slicer filters"}
        disabled={isMulti}
      >
        <ConnectionsIcon />
        Report Connections
      </Button>
      <Button
        onClick={() => showDialog(SLICER_COMPUTED_PROPS_DIALOG_ID, { slicerId: primary.id })}
        title={isMulti ? "Open computed properties for the last selected slicer" : "Formula-driven attributes for this slicer"}
        disabled={isMulti}
      >
        <ComputedIcon />
        Computed
      </Button>
      <Button
        className={styles.deleteButton}
        onClick={handleDelete}
        title={isMulti ? `Delete ${slicers.length} selected slicers` : "Delete this slicer"}
      >
        <DeleteIcon />
        Delete{isMulti ? ` (${slicers.length})` : ""}
      </Button>
    </ActionRow>
  );
}
