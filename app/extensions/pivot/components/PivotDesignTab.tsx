//! FILENAME: app/extensions/Pivot/components/PivotDesignTab.tsx
// PURPOSE: Ribbon "Design" tab for pivot table layout options.
// CONTEXT: Appears in the ribbon when a pivot table is selected. Communicates
// with the PivotEditor via custom events (PIVOT_LAYOUT_STATE / PIVOT_LAYOUT_CHANGED).

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { css } from '@emotion/css';
import { onAppEvent, emitAppEvent } from '../../../src/api';
import { PivotEvents } from '../lib/pivotEvents';
import { getPivotTableInfo, updatePivotProperties } from '../lib/pivot-api';
import type { LayoutConfig, ReportLayout, ValuesPosition, PivotId } from './types';
import type { RibbonContext } from '../../../src/api/extensions';
import { PivotTableStylesGallery, DEFAULT_PIVOT_STYLE_ID } from './PivotTableStylesGallery';
import { useRibbonCollapse, RibbonGroup } from '../../../src/api/ribbonCollapse';

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
  nameInput: css`
    padding: 3px 6px;
    border: 1px solid #d0d0d0;
    border-radius: 4px;
    font-size: 11px;
    font-family: inherit;
    background: #fff;
    color: #1a1a1a;
    min-width: 120px;
    max-width: 180px;

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
// Collapse configuration
// ============================================================================

// Gallery is NOT included — it uses flex: 1 1 0 and its own ResizeObserver
// to progressively show fewer thumbnails as the ribbon narrows.
const GROUP_DEFS = [
  { collapseOrder: 1, expandedWidth: 180 },   // PivotTable Name
  { collapseOrder: 2, expandedWidth: 140 },   // Grand Totals
  { collapseOrder: 3, expandedWidth: 300 },   // Report Layout
  { collapseOrder: 4, expandedWidth: 280 },   // Display
];

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
  const [pivotName, setPivotName] = useState('');
  const [savedName, setSavedName] = useState('');
  const nameInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const groupDefs = useMemo(() => GROUP_DEFS, []);
  const collapsed = useRibbonCollapse(containerRef, groupDefs, 0, 470);

  // Listen for layout state broadcasts from the PivotEditor
  useEffect(() => {
    const unsub = onAppEvent<LayoutState>(
      PivotEvents.PIVOT_LAYOUT_STATE,
      (detail) => {
        setLayoutState((prev) => ({
          ...detail,
          layout: {
            ...detail.layout,
            // Preserve styleId if the broadcast doesn't include it
            // (backend doesn't know about this frontend-only property)
            styleId: detail.layout.styleId ?? prev?.layout.styleId,
          },
        }));
      }
    );
    // Request current state in case we missed the initial broadcast
    // (e.g. user switched to Home tab and back to Design)
    emitAppEvent(PivotEvents.PIVOT_REQUEST_LAYOUT);
    return unsub;
  }, []);

  // Fetch pivot name whenever pivotId changes
  useEffect(() => {
    if (!layoutState) return;
    const { pivotId } = layoutState;
    let cancelled = false;
    getPivotTableInfo(pivotId).then((info) => {
      if (cancelled) return;
      setPivotName(info.name);
      setSavedName(info.name);
    }).catch(() => { /* ignore fetch errors */ });
    return () => { cancelled = true; };
  }, [layoutState?.pivotId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clear state when pivot is deselected (no layout state for 500ms)
  useEffect(() => {
    const handleClear = () => {
      setLayoutState(null);
      setPivotName('');
      setSavedName('');
    };

    window.addEventListener('pivot:deselected', handleClear);
    return () => window.removeEventListener('pivot:deselected', handleClear);
  }, []);

  const savePivotName = useCallback(() => {
    if (!layoutState || pivotName === savedName) return;
    const trimmed = pivotName.trim();
    if (trimmed === '') {
      // Revert to saved name if empty
      setPivotName(savedName);
      return;
    }
    setSavedName(trimmed);
    setPivotName(trimmed);
    updatePivotProperties({ pivotId: layoutState.pivotId, name: trimmed }).then(() => {
      window.dispatchEvent(new Event('pivot:refresh'));
    }).catch(() => { /* ignore save errors */ });
  }, [layoutState, pivotName, savedName]);

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
    <div ref={containerRef} className={tabStyles.container}>
      {/* PivotTable Name Group */}
      <RibbonGroup label="PivotTable Name" icon={"\u2699"} collapsed={collapsed[0]}>
        <div className={tabStyles.groupContent}>
          <div className={tabStyles.selectLabel}>
            <input
              ref={nameInputRef}
              type="text"
              className={tabStyles.nameInput}
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
          </div>
        </div>
      </RibbonGroup>

      {/* Grand Totals Group */}
      <RibbonGroup label="Grand Totals" icon={"\u03A3"} collapsed={collapsed[1]}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
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
      </RibbonGroup>

      <PivotTableStylesGallery
        selectedStyleId={layout.styleId ?? DEFAULT_PIVOT_STYLE_ID}
        onStyleSelect={(styleId) => updateLayout({ styleId })}
        onStyleClear={() => updateLayout({ styleId: '' })}
      />

      {/* Report Layout Group */}
      <RibbonGroup label="Report Layout" icon={"\u2630"} collapsed={collapsed[2]}>
        <div className={tabStyles.groupContent} style={{ gap: 12 }}>
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
      </RibbonGroup>

      {/* Display Group */}
      <RibbonGroup label="Display" icon={"\u25A3"} collapsed={collapsed[3]}>
        <div className={tabStyles.groupContent} style={{ gap: 12 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
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
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
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
            <label className={tabStyles.checkboxLabel}>
              <input
                type="checkbox"
                checked={layout.autoFitColumnWidths ?? true}
                onChange={(e) =>
                  updateLayout({ autoFitColumnWidths: e.target.checked })
                }
              />
              Autofit Columns
            </label>
          </div>
        </div>
      </RibbonGroup>
    </div>
  );
}
