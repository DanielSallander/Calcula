//! FILENAME: app/extensions/Pivot/components/PivotDesignSections.tsx
// PURPOSE: Panel sections for the contextual "Pivot Table Design" panel:
//          PivotTable Name, Grand Totals, PivotTable Styles, Report Layout,
//          Display.
// CONTEXT: Appears in the ribbon when a pivot table is selected. Communicates
//          with the PivotEditor via custom events (PIVOT_LAYOUT_STATE /
//          PIVOT_LAYOUT_CHANGED), shared across sections through
//          lib/pivotPanelStore. One section per former ribbon group; the shell
//          owns group chrome, labels and width-collapse (replaces the
//          monolithic PivotDesignTab).

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { css } from '@emotion/css';
import type { PanelSectionProps } from '@api/uiTypes';
import { ControlRow, Field, FieldGrid, Input, Stack } from '@api/layout';
import { getPivotTableInfo, updatePivotProperties } from '../lib/pivot-api';
import { usePivotPanelState, updateSharedLayout } from '../lib/pivotPanelStore';
import type { ReportLayout, ValuesPosition } from './types';
import { PivotTableStylesGallery, DEFAULT_PIVOT_STYLE_ID } from './PivotTableStylesGallery';

// ============================================================================
// Styles
// ============================================================================

const sectionStyles = {
  disabledMessage: css`
    display: flex;
    align-items: center;
    height: 100%;
    color: var(--text-tertiary, #999);
    font-style: italic;
    font-size: 12px;
    white-space: nowrap;
    font-family: 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif;
  `,
  checkboxLabel: css`
    display: flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
    white-space: nowrap;
    font-size: 11px;
    color: var(--text-primary, #333);
    font-family: 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif;

    input {
      cursor: pointer;
    }
  `,
  select: css`
    padding: 3px 6px;
    border: 1px solid var(--border-default, #d0d0d0);
    border-radius: 4px;
    font-size: 11px;
    font-family: 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif;
    background: var(--bg-surface, #fff);
    color: var(--text-primary, #1a1a1a);
    cursor: pointer;
    min-width: 80px;

    &:hover {
      border-color: var(--text-tertiary, #999);
    }

    &:focus {
      outline: none;
      border-color: var(--accent-primary, #005fb8);
    }
  `,
};

// ============================================================================
// PivotTable Name section
// ============================================================================

export function DesignNameSection(_props: PanelSectionProps): React.ReactElement {
  const { layoutState } = usePivotPanelState();
  const [pivotName, setPivotName] = useState('');
  const [savedName, setSavedName] = useState('');
  const nameInputRef = useRef<HTMLInputElement>(null);
  const pivotId = layoutState?.pivotId ?? null;

  // Fetch pivot name whenever pivotId changes
  useEffect(() => {
    if (!pivotId) {
      setPivotName('');
      setSavedName('');
      return;
    }
    let cancelled = false;
    getPivotTableInfo(pivotId).then((info) => {
      if (cancelled) return;
      setPivotName(info.name);
      setSavedName(info.name);
    }).catch(() => { /* ignore fetch errors */ });
    return () => { cancelled = true; };
  }, [pivotId]);

  const savePivotName = useCallback(() => {
    if (!pivotId || pivotName === savedName) return;
    const trimmed = pivotName.trim();
    if (trimmed === '') {
      // Revert to saved name if empty
      setPivotName(savedName);
      return;
    }
    setSavedName(trimmed);
    setPivotName(trimmed);
    updatePivotProperties({ pivotId, name: trimmed }).then(() => {
      window.dispatchEvent(new Event('pivot:refresh'));
    }).catch(() => { /* ignore save errors */ });
  }, [pivotId, pivotName, savedName]);

  if (!layoutState) {
    return (
      <div className={sectionStyles.disabledMessage}>
        Select a PivotTable to see design options
      </div>
    );
  }

  return (
    <ControlRow>
      <Input
        ref={nameInputRef}
        type="text"
        width={140}
        value={pivotName}
        onChange={(e) => setPivotName(e.target.value)}
        onBlur={savePivotName}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            savePivotName();
            nameInputRef.current?.blur();
          }
        }}
      />
    </ControlRow>
  );
}

// ============================================================================
// Grand Totals section
// ============================================================================

export function DesignGrandTotalsSection(_props: PanelSectionProps): React.ReactElement | null {
  const { layoutState } = usePivotPanelState();

  if (!layoutState) {
    return null;
  }
  const { layout } = layoutState;

  return (
    <Stack gap={4}>
      <label className={sectionStyles.checkboxLabel}>
        <input
          type="checkbox"
          checked={layout.showRowGrandTotals ?? true}
          onChange={(e) =>
            updateSharedLayout({ showRowGrandTotals: e.target.checked })
          }
        />
        Row Totals
      </label>
      <label className={sectionStyles.checkboxLabel}>
        <input
          type="checkbox"
          checked={layout.showColumnGrandTotals ?? true}
          onChange={(e) =>
            updateSharedLayout({ showColumnGrandTotals: e.target.checked })
          }
        />
        Column Totals
      </label>
    </Stack>
  );
}

// ============================================================================
// PivotTable Styles section — hosts the styles gallery widget
// ============================================================================

export function DesignStylesSection(_props: PanelSectionProps): React.ReactElement | null {
  const { layoutState } = usePivotPanelState();

  if (!layoutState) {
    return null;
  }
  const { layout } = layoutState;

  return (
    <PivotTableStylesGallery
      selectedStyleId={layout.styleId ?? DEFAULT_PIVOT_STYLE_ID}
      onStyleSelect={(styleId) => updateSharedLayout({ styleId })}
      onStyleClear={() => updateSharedLayout({ styleId: '' })}
    />
  );
}

// ============================================================================
// Report Layout section
// ============================================================================

export function DesignReportLayoutSection(_props: PanelSectionProps): React.ReactElement | null {
  const { layoutState } = usePivotPanelState();

  if (!layoutState) {
    return null;
  }
  const { layout } = layoutState;

  return (
    <FieldGrid>
      <Field label="Layout:">
        <select
          className={sectionStyles.select}
          value={layout.reportLayout ?? 'compact'}
          onChange={(e) =>
            updateSharedLayout({ reportLayout: e.target.value as ReportLayout })
          }
        >
          <option value="compact">Compact</option>
          <option value="outline">Outline</option>
          <option value="tabular">Tabular</option>
        </select>
      </Field>
      <Field label="Values:">
        <select
          className={sectionStyles.select}
          value={layout.valuesPosition ?? 'columns'}
          onChange={(e) =>
            updateSharedLayout({
              valuesPosition: e.target.value as ValuesPosition,
            })
          }
        >
          <option value="columns">Columns</option>
          <option value="rows">Rows</option>
        </select>
      </Field>
    </FieldGrid>
  );
}

// ============================================================================
// Display section
// ============================================================================

export function DesignDisplaySection(_props: PanelSectionProps): React.ReactElement | null {
  const { layoutState } = usePivotPanelState();

  if (!layoutState) {
    return null;
  }
  const { layout } = layoutState;

  return (
    <ControlRow gap={12}>
      <Stack gap={4}>
        <label className={sectionStyles.checkboxLabel}>
          <input
            type="checkbox"
            checked={layout.repeatRowLabels ?? false}
            onChange={(e) =>
              updateSharedLayout({ repeatRowLabels: e.target.checked })
            }
          />
          Repeat Labels
        </label>
        <label className={sectionStyles.checkboxLabel}>
          <input
            type="checkbox"
            checked={layout.showEmptyRows ?? false}
            onChange={(e) =>
              updateSharedLayout({ showEmptyRows: e.target.checked })
            }
          />
          Empty Rows
        </label>
      </Stack>
      <Stack gap={4}>
        <label className={sectionStyles.checkboxLabel}>
          <input
            type="checkbox"
            checked={layout.showEmptyCols ?? false}
            onChange={(e) =>
              updateSharedLayout({ showEmptyCols: e.target.checked })
            }
          />
          Empty Cols
        </label>
        <label className={sectionStyles.checkboxLabel}>
          <input
            type="checkbox"
            checked={layout.autoFitColumnWidths ?? true}
            onChange={(e) =>
              updateSharedLayout({ autoFitColumnWidths: e.target.checked })
            }
          />
          Autofit Columns
        </label>
      </Stack>
    </ControlRow>
  );
}
