//! FILENAME: app/extensions/Pivot/components/PivotDesignTab.tsx
// PURPOSE: Ribbon "Design" tab for pivot table layout options.
// CONTEXT: Appears in the ribbon when a pivot table is selected. Communicates
// with the PivotEditor via custom events (PIVOT_LAYOUT_STATE / PIVOT_LAYOUT_CHANGED).

import React, { useState, useEffect, useCallback } from 'react';
import { css } from '@emotion/css';
import { onAppEvent, emitAppEvent } from '../../../src/api';
import { PivotEvents } from '../lib/pivotEvents';
import type { LayoutConfig, ReportLayout, ValuesPosition, PivotId } from './types';
import type { RibbonContext } from '../../../src/api/extensions';

// ============================================================================
// Styles
// ============================================================================

const tabStyles = {
  container: css`
    display: flex;
    gap: 24px;
    align-items: flex-start;
    height: 100%;
    font-family: 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif;
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
  group: css`
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding-right: 24px;
    border-right: 1px solid #e0e0e0;

    &:last-child {
      border-right: none;
      padding-right: 0;
    }
  `,
  groupLabel: css`
    font-size: 10px;
    color: #666;
    text-align: center;
    margin-top: 4px;
    text-transform: uppercase;
    letter-spacing: 0.3px;
  `,
  groupContent: css`
    display: flex;
    gap: 8px;
    align-items: center;
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
  selectLabel: css`
    display: flex;
    align-items: center;
    gap: 4px;
    white-space: nowrap;
    font-size: 11px;
    color: #333;
  `,
  select: css`
    padding: 3px 6px;
    border: 1px solid #d0d0d0;
    border-radius: 4px;
    font-size: 11px;
    font-family: inherit;
    background: #fff;
    color: #1a1a1a;
    cursor: pointer;
    min-width: 80px;

    &:hover {
      border-color: #999;
    }

    &:focus {
      outline: none;
      border-color: #005fb8;
    }
  `,
};

// ============================================================================
// Component
// ============================================================================

interface LayoutState {
  pivotId: PivotId;
  layout: LayoutConfig;
}

export function PivotDesignTab({
  context: _context,
}: {
  context: RibbonContext;
}): React.ReactElement {
  const [layoutState, setLayoutState] = useState<LayoutState | null>(null);

  // Listen for layout state broadcasts from the PivotEditor
  useEffect(() => {
    return onAppEvent<LayoutState>(
      PivotEvents.PIVOT_LAYOUT_STATE,
      (detail) => {
        setLayoutState(detail);
      }
    );
  }, []);

  // Clear state when pivot is deselected (no layout state for 500ms)
  useEffect(() => {
    const handleClear = () => {
      setLayoutState(null);
    };

    window.addEventListener('pivot:deselected', handleClear);
    return () => window.removeEventListener('pivot:deselected', handleClear);
  }, []);

  const updateLayout = useCallback(
    (updates: Partial<LayoutConfig>) => {
      if (!layoutState) return;
      const newLayout = { ...layoutState.layout, ...updates };
      setLayoutState({ ...layoutState, layout: newLayout });
      emitAppEvent(PivotEvents.PIVOT_LAYOUT_CHANGED, {
        pivotId: layoutState.pivotId,
        layout: newLayout,
      });
    },
    [layoutState]
  );

  if (!layoutState) {
    return (
      <div className={tabStyles.disabledMessage}>
        Select a PivotTable to see design options
      </div>
    );
  }

  const { layout } = layoutState;

  return (
    <div className={tabStyles.container}>
      {/* Grand Totals Group */}
      <div className={tabStyles.group}>
        <div className={tabStyles.groupContent}>
          <label className={tabStyles.checkboxLabel}>
            <input
              type="checkbox"
              checked={layout.showRowGrandTotals ?? true}
              onChange={(e) =>
                updateLayout({ showRowGrandTotals: e.target.checked })
              }
            />
            Row Totals
          </label>
          <label className={tabStyles.checkboxLabel}>
            <input
              type="checkbox"
              checked={layout.showColumnGrandTotals ?? true}
              onChange={(e) =>
                updateLayout({ showColumnGrandTotals: e.target.checked })
              }
            />
            Column Totals
          </label>
        </div>
        <div className={tabStyles.groupLabel}>Grand Totals</div>
      </div>

      {/* Report Layout Group */}
      <div className={tabStyles.group}>
        <div className={tabStyles.groupContent}>
          <div className={tabStyles.selectLabel}>
            Layout:
            <select
              className={tabStyles.select}
              value={layout.reportLayout ?? 'compact'}
              onChange={(e) =>
                updateLayout({ reportLayout: e.target.value as ReportLayout })
              }
            >
              <option value="compact">Compact</option>
              <option value="outline">Outline</option>
              <option value="tabular">Tabular</option>
            </select>
          </div>
          <div className={tabStyles.selectLabel}>
            Values:
            <select
              className={tabStyles.select}
              value={layout.valuesPosition ?? 'columns'}
              onChange={(e) =>
                updateLayout({
                  valuesPosition: e.target.value as ValuesPosition,
                })
              }
            >
              <option value="columns">Columns</option>
              <option value="rows">Rows</option>
            </select>
          </div>
        </div>
        <div className={tabStyles.groupLabel}>Report Layout</div>
      </div>

      {/* Display Group */}
      <div className={tabStyles.group}>
        <div className={tabStyles.groupContent}>
          <label className={tabStyles.checkboxLabel}>
            <input
              type="checkbox"
              checked={layout.repeatRowLabels ?? false}
              onChange={(e) =>
                updateLayout({ repeatRowLabels: e.target.checked })
              }
            />
            Repeat Labels
          </label>
          <label className={tabStyles.checkboxLabel}>
            <input
              type="checkbox"
              checked={layout.showEmptyRows ?? false}
              onChange={(e) =>
                updateLayout({ showEmptyRows: e.target.checked })
              }
            />
            Empty Rows
          </label>
          <label className={tabStyles.checkboxLabel}>
            <input
              type="checkbox"
              checked={layout.showEmptyCols ?? false}
              onChange={(e) =>
                updateLayout({ showEmptyCols: e.target.checked })
              }
            />
            Empty Cols
          </label>
        </div>
        <div className={tabStyles.groupLabel}>Display</div>
      </div>
    </div>
  );
}
