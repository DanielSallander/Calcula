//! FILENAME: app/extensions/Slicer/components/SlicerOptionsTab.tsx
// PURPOSE: Contextual ribbon tab shown when a slicer is selected.
// CONTEXT: Provides controls for slicer name, columns, button size, style gallery,
//          slicer dimensions, and delete action.
//          Supports multi-select: shows common values, empty for mixed.

import React, { useState, useEffect, useRef } from "react";
import { css } from "@emotion/css";
import type { RibbonContext } from "../../../src/api/extensions";
import { useRibbonCollapse, RibbonGroup } from "../../../src/api/ribbonCollapse";
import {
  getSlicerById,
  updateSlicerAsync,
  updateSlicerPositionAsync,
  deleteSlicerAsync,
} from "../lib/slicerStore";
import { requestOverlayRedraw } from "../../../src/api/gridOverlays";
import { showDialog } from "../../../src/api";
import { SLICER_SETTINGS_DIALOG_ID, SLICER_COMPUTED_PROPS_DIALOG_ID } from "../manifest";
import { SlicerEvents } from "../lib/slicerEvents";
import type { Slicer } from "../lib/slicerTypes";
import { SlicerStylesGallery } from "./SlicerStylesGallery";
import { broadcastSelectedSlicers } from "../handlers/selectionHandler";
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

// ============================================================================
// Styles
// ============================================================================

const tabStyles = {
  container: css`
    display: flex;
    gap: 0;
    align-items: flex-start;
    height: 100%;
    width: 100%;
    min-width: 0;
    overflow: hidden;
    font-family: "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
    font-size: 12px;
  `,
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
  groupContent: css`
    display: flex;
    gap: 8px;
    align-items: center;
  `,
  groupContentVertical: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
  `,
  nameInput: css`
    padding: 3px 6px;
    border: 1px solid #d0d0d0;
    border-radius: 4px;
    font-size: 11px;
    font-family: inherit;
    background: #fff;
    color: #1a1a1a;
    min-width: 100px;
    max-width: 160px;
    &:focus {
      border-color: #4472c4;
      outline: none;
    }
    &:disabled {
      background: #f5f5f5;
      color: #999;
    }
  `,
  label: css`
    font-size: 11px;
    color: #333;
    white-space: nowrap;
  `,
  columnSelect: css`
    padding: 3px 6px;
    border: 1px solid #d0d0d0;
    border-radius: 4px;
    font-size: 11px;
    background: #fff;
    color: #1a1a1a;
    width: 50px;
    &:focus {
      border-color: #4472c4;
      outline: none;
    }
  `,
  sizeInput: css`
    padding: 3px 6px;
    border: 1px solid #d0d0d0;
    border-radius: 4px;
    font-size: 11px;
    background: #fff;
    color: #1a1a1a;
    width: 60px;
    &:focus {
      border-color: #4472c4;
      outline: none;
    }
  `,
  checkboxLabel: css`
    display: flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
    white-space: nowrap;
    font-size: 11px;
    color: #333;
    input {
      cursor: pointer;
    }
  `,
  settingsButton: css`
    padding: 4px 12px;
    border: 1px solid #d0d0d0;
    border-radius: 4px;
    font-size: 11px;
    cursor: pointer;
    background: #fff;
    color: #1a1a1a;
    white-space: nowrap;
    &:hover {
      background: #e8f0fe;
      border-color: #4472c4;
    }
  `,
  deleteButton: css`
    padding: 4px 12px;
    border: 1px solid #d0d0d0;
    border-radius: 4px;
    font-size: 11px;
    cursor: pointer;
    background: #fff;
    color: #c0392b;
    white-space: nowrap;
    &:hover {
      background: #fdecea;
      border-color: #c0392b;
    }
  `,
  computedOverlay: css`
    opacity: 0.4;
    pointer-events: none;
    position: relative;
  `,
};

// Group definitions for ribbon collapse (collapseOrder: lower = collapses first).
const SLICER_GROUPS = [
  { collapseOrder: 4, expandedWidth: 220 }, // Properties
  { collapseOrder: 3, expandedWidth: 100 }, // Buttons
  { collapseOrder: 2, expandedWidth: 140 }, // Size
  { collapseOrder: 1, expandedWidth: 160 }, // Actions
];

// ============================================================================
// Component
// ============================================================================

export function SlicerOptionsTab({
  context: _context,
}: {
  context: RibbonContext;
}): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const [slicers, setSlicers] = useState<Slicer[]>([]);
  const [slicerName, setSlicerName] = useState("");
  const [headerText, setHeaderText] = useState("");
  const [widthStr, setWidthStr] = useState("");
  const [heightStr, setHeightStr] = useState("");
  const [computedAttrs, setComputedAttrs] = useState<Set<string>>(new Set());
  const collapsedGroups = useRibbonCollapse(containerRef, SLICER_GROUPS);

  const isMulti = slicers.length > 1;

  /** Helper: is an attribute controlled by a computed property? */
  const isComputed = (attr: string) => computedAttrs.has(attr);
  const computedTitle = "This attribute is controlled via computed properties";

  // Listen for slicer selection/deselection events
  useEffect(() => {
    const handleUpdated = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      // The event now sends an array of Slicer objects
      const arr = Array.isArray(detail) ? detail as Slicer[] : detail ? [detail as Slicer] : [];
      if (arr.length > 0) {
        setSlicers(arr);

        if (arr.length === 1) {
          const s = arr[0];
          setSlicerName(s.name);
          setHeaderText(s.headerText ?? s.name);
          setWidthStr(Math.round(s.width).toString());
          setHeightStr(Math.round(s.height).toString());
          // Fetch computed attributes for this slicer
          getSlicerComputedAttributes(s.id).then((attrs) => {
            setComputedAttrs(new Set(attrs));
          });
        } else {
          // Multi-select: show common values or empty
          setSlicerName("");
          setHeaderText("");
          const cw = commonValue(arr, (s) => Math.round(s.width));
          setWidthStr(cw === MIXED ? "" : cw.toString());
          const ch = commonValue(arr, (s) => Math.round(s.height));
          setHeightStr(ch === MIXED ? "" : ch.toString());
          setComputedAttrs(new Set());
        }
      }
    };

    const handleDeselected = () => {
      setSlicers([]);
      setComputedAttrs(new Set());
    };

    window.addEventListener(SlicerEvents.SLICER_UPDATED, handleUpdated);
    window.addEventListener("slicer:deselected", handleDeselected);
    return () => {
      window.removeEventListener(SlicerEvents.SLICER_UPDATED, handleUpdated);
      window.removeEventListener("slicer:deselected", handleDeselected);
    };
  }, []);

  if (slicers.length === 0) {
    return (
      <div className={tabStyles.disabledMessage}>
        Select a slicer to configure it.
      </div>
    );
  }

  // Primary slicer (last selected, used for single-slicer-only operations)
  const primary = slicers[slicers.length - 1];

  // --- Apply to all selected ---
  const updateAll = async (params: Parameters<typeof updateSlicerAsync>[1]) => {
    const updates = slicers.map((s) => updateSlicerAsync(s.id, params));
    await Promise.all(updates);
    broadcastSelectedSlicers();
    requestOverlayRedraw();
  };

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

  const handleNameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      (e.target as HTMLInputElement).blur();
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

  // --- Columns ---
  const handleColumnsChange = async (value: number) => {
    await updateAll({ columns: value });
  };

  // --- Show Header ---
  const handleShowHeaderChange = async (checked: boolean) => {
    await updateAll({ showHeader: checked });
  };

  // --- Style ---
  const handleStyleChange = async (stylePreset: string) => {
    await updateAll({ stylePreset });
  };

  // --- Size (width / height) ---
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

  const handleSizeKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      (e.target as HTMLInputElement).blur();
    }
  };

  // --- Delete ---
  const handleDelete = async () => {
    await Promise.all(slicers.map((s) => deleteSlicerAsync(s.id)));
    setSlicers([]);
  };

  // --- Computed common values for multi-select ---
  const commonColumns = commonValue(slicers, (s) => s.columns);
  const commonShowHeader = commonValue(slicers, (s) => s.showHeader);
  const commonStyle = commonValue(slicers, (s) => s.stylePreset);

  return (
    <div ref={containerRef} className={tabStyles.container}>
      {/* Properties Group */}
      <RibbonGroup
        label="Properties"
        icon="P"
        collapsed={collapsedGroups[0]}
      >
        <div className={tabStyles.groupContentVertical}>
          <div className={tabStyles.groupContent}>
            <span className={tabStyles.label}>Name:</span>
            <input
              className={tabStyles.nameInput}
              value={isMulti ? `(${slicers.length} slicers)` : slicerName}
              onChange={(e) => setSlicerName(e.target.value)}
              onBlur={handleNameBlur}
              onKeyDown={handleNameKeyDown}
              disabled={isMulti}
              title={isMulti ? "Name editing not available for multiple slicers" : undefined}
            />
          </div>
          <div
            className={`${tabStyles.groupContent} ${isComputed("headerText") ? tabStyles.computedOverlay : ""}`}
            title={isComputed("headerText") ? computedTitle : undefined}
          >
            <span className={tabStyles.label}>Header:</span>
            <input
              className={tabStyles.nameInput}
              value={isMulti ? "" : headerText}
              onChange={(e) => setHeaderText(e.target.value)}
              onBlur={handleHeaderTextBlur}
              onKeyDown={handleNameKeyDown}
              disabled={isMulti || isComputed("headerText")}
              title={isComputed("headerText") ? computedTitle : isMulti ? "Header editing not available for multiple slicers" : "Header display text (shown in the header bar)"}
              placeholder={isMulti ? "(multiple)" : undefined}
            />
          </div>
          <label
            className={`${tabStyles.checkboxLabel} ${isComputed("showHeader") ? tabStyles.computedOverlay : ""}`}
            title={isComputed("showHeader") ? computedTitle : undefined}
          >
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
        </div>
      </RibbonGroup>

      {/* Buttons Group (columns) */}
      <RibbonGroup
        label="Buttons"
        icon="B"
        collapsed={collapsedGroups[1]}
      >
        <div className={tabStyles.groupContentVertical}>
          <div
            className={`${tabStyles.groupContent} ${isComputed("columns") ? tabStyles.computedOverlay : ""}`}
            title={isComputed("columns") ? computedTitle : undefined}
          >
            <span className={tabStyles.label}>Columns:</span>
            <select
              className={tabStyles.columnSelect}
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
          </div>
        </div>
      </RibbonGroup>

      {/* Slicer Styles Gallery (self-managing responsive collapse) */}
      <SlicerStylesGallery
        selectedStyleId={commonStyle === MIXED ? null : commonStyle}
        onStyleSelect={handleStyleChange}
      />

      {/* Size Group */}
      <RibbonGroup
        label="Size"
        icon="Z"
        collapsed={collapsedGroups[2]}
      >
        <div className={tabStyles.groupContentVertical}>
          <div
            className={`${tabStyles.groupContent} ${isComputed("width") ? tabStyles.computedOverlay : ""}`}
            title={isComputed("width") ? computedTitle : undefined}
          >
            <span className={tabStyles.label}>Width:</span>
            <input
              className={tabStyles.sizeInput}
              value={widthStr}
              onChange={(e) => setWidthStr(e.target.value)}
              onBlur={handleWidthBlur}
              onKeyDown={handleSizeKeyDown}
              type="number"
              min={60}
              placeholder={isMulti ? "-" : undefined}
              disabled={isComputed("width")}
            />
          </div>
          <div
            className={`${tabStyles.groupContent} ${isComputed("height") ? tabStyles.computedOverlay : ""}`}
            title={isComputed("height") ? computedTitle : undefined}
          >
            <span className={tabStyles.label}>Height:</span>
            <input
              className={tabStyles.sizeInput}
              value={heightStr}
              onChange={(e) => setHeightStr(e.target.value)}
              onBlur={handleHeightBlur}
              onKeyDown={handleSizeKeyDown}
              type="number"
              min={60}
              placeholder={isMulti ? "-" : undefined}
              disabled={isComputed("height")}
            />
          </div>
        </div>
      </RibbonGroup>

      {/* Actions Group */}
      <RibbonGroup
        label="Actions"
        icon="A"
        collapsed={collapsedGroups[3]}
      >
        <div className={tabStyles.groupContentVertical}>
          <button
            className={tabStyles.settingsButton}
            onClick={() => showDialog(SLICER_SETTINGS_DIALOG_ID, { slicerId: primary.id })}
            title={isMulti ? "Open settings for the last selected slicer" : "Open slicer settings (layout, selection behavior, data display)"}
            disabled={isMulti}
          >
            Settings...
          </button>
          <button
            className={tabStyles.settingsButton}
            onClick={() => showDialog(SLICER_COMPUTED_PROPS_DIALOG_ID, { slicerId: primary.id })}
            title={isMulti ? "Open computed properties for the last selected slicer" : "Formula-driven attributes for this slicer"}
            disabled={isMulti}
          >
            Computed...
          </button>
          <button
            className={tabStyles.deleteButton}
            onClick={handleDelete}
            title={isMulti ? `Delete ${slicers.length} selected slicers` : "Delete this slicer"}
          >
            Delete{isMulti ? ` (${slicers.length})` : ""}
          </button>
        </div>
      </RibbonGroup>
    </div>
  );
}

export default SlicerOptionsTab;
