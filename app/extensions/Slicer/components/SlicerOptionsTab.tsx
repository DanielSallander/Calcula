//! FILENAME: app/extensions/Slicer/components/SlicerOptionsTab.tsx
// PURPOSE: Contextual ribbon tab shown when a slicer is selected.
// CONTEXT: Provides controls for slicer name, column count, style, and delete.

import React, { useState, useEffect, useRef } from "react";
import { css } from "@emotion/css";
import type { RibbonContext } from "../../../src/api/extensions";
import { useRibbonCollapse, RibbonGroup } from "../../../src/api/ribbonCollapse";
import {
  getSlicerById,
  updateSlicerAsync,
  deleteSlicerAsync,
} from "../lib/slicerStore";
import { SlicerEvents } from "../lib/slicerEvents";
import type { Slicer } from "../lib/slicerTypes";

// ============================================================================
// Style Presets
// ============================================================================

const STYLE_PRESETS = [
  { id: "SlicerStyleLight1", label: "Light 1", bg: "#f0f4f8", fg: "#2c5282" },
  { id: "SlicerStyleLight2", label: "Light 2", bg: "#f0fff4", fg: "#276749" },
  { id: "SlicerStyleDark1", label: "Dark 1", bg: "#2d3748", fg: "#e2e8f0" },
];

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
  styleButton: css`
    padding: 4px 8px;
    border: 1px solid #d0d0d0;
    border-radius: 4px;
    font-size: 11px;
    cursor: pointer;
    white-space: nowrap;
    &:hover {
      border-color: #888;
    }
  `,
  styleButtonActive: css`
    border-color: #4472c4;
    border-width: 2px;
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
};

// Group definitions for ribbon collapse (collapseOrder: lower = collapses first)
const SLICER_GROUPS = [
  { collapseOrder: 3, expandedWidth: 200 }, // Properties
  { collapseOrder: 2, expandedWidth: 180 }, // Slicer Styles
  { collapseOrder: 1, expandedWidth: 80 },  // Actions
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
  const [slicer, setSlicer] = useState<Slicer | null>(null);
  const [slicerName, setSlicerName] = useState("");
  const collapsedGroups = useRibbonCollapse(containerRef, SLICER_GROUPS);

  // Listen for slicer selection/deselection events
  useEffect(() => {
    const handleUpdated = (e: Event) => {
      const detail = (e as CustomEvent).detail as Slicer;
      if (detail) {
        setSlicer(detail);
        setSlicerName(detail.name);
      }
    };

    const handleDeselected = () => {
      setSlicer(null);
    };

    window.addEventListener(SlicerEvents.SLICER_UPDATED, handleUpdated);
    window.addEventListener("slicer:deselected", handleDeselected);
    return () => {
      window.removeEventListener(SlicerEvents.SLICER_UPDATED, handleUpdated);
      window.removeEventListener("slicer:deselected", handleDeselected);
    };
  }, []);

  if (!slicer) {
    return (
      <div className={tabStyles.disabledMessage}>
        Select a slicer to configure it.
      </div>
    );
  }

  const handleNameBlur = async () => {
    const trimmed = slicerName.trim();
    if (trimmed && trimmed !== slicer.name) {
      const updated = await updateSlicerAsync(slicer.id, { name: trimmed });
      if (updated) setSlicer(updated);
    } else {
      setSlicerName(slicer.name);
    }
  };

  const handleNameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      (e.target as HTMLInputElement).blur();
    }
  };

  const handleColumnsChange = async (value: number) => {
    const updated = await updateSlicerAsync(slicer.id, { columns: value });
    if (updated) setSlicer(updated);
  };

  const handleShowHeaderChange = async (checked: boolean) => {
    const updated = await updateSlicerAsync(slicer.id, { showHeader: checked });
    if (updated) setSlicer(updated);
  };

  const handleStyleChange = async (stylePreset: string) => {
    const updated = await updateSlicerAsync(slicer.id, { stylePreset });
    if (updated) setSlicer(updated);
  };

  const handleDelete = async () => {
    await deleteSlicerAsync(slicer.id);
    setSlicer(null);
  };

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
              value={slicerName}
              onChange={(e) => setSlicerName(e.target.value)}
              onBlur={handleNameBlur}
              onKeyDown={handleNameKeyDown}
            />
          </div>
          <div className={tabStyles.groupContent}>
            <span className={tabStyles.label}>Columns:</span>
            <select
              className={tabStyles.columnSelect}
              value={slicer.columns}
              onChange={(e) => handleColumnsChange(Number(e.target.value))}
            >
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <label className={tabStyles.checkboxLabel}>
            <input
              type="checkbox"
              checked={slicer.showHeader}
              onChange={(e) => handleShowHeaderChange(e.target.checked)}
            />
            Show Header
          </label>
        </div>
      </RibbonGroup>

      {/* Styles Group */}
      <RibbonGroup
        label="Slicer Styles"
        icon="S"
        collapsed={collapsedGroups[1]}
      >
        <div className={tabStyles.groupContent}>
          {STYLE_PRESETS.map((preset) => (
            <button
              key={preset.id}
              className={`${tabStyles.styleButton} ${
                slicer.stylePreset === preset.id ? tabStyles.styleButtonActive : ""
              }`}
              style={{
                backgroundColor: preset.bg,
                color: preset.fg,
              }}
              onClick={() => handleStyleChange(preset.id)}
              title={preset.label}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </RibbonGroup>

      {/* Actions Group */}
      <RibbonGroup
        label="Actions"
        icon="A"
        collapsed={collapsedGroups[2]}
      >
        <div className={tabStyles.groupContent}>
          <button
            className={tabStyles.deleteButton}
            onClick={handleDelete}
            title="Delete this slicer"
          >
            Delete
          </button>
        </div>
      </RibbonGroup>
    </div>
  );
}

export default SlicerOptionsTab;
