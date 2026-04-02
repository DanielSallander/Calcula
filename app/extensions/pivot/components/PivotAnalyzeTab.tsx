//! FILENAME: app/extensions/Pivot/components/PivotAnalyzeTab.tsx
// PURPOSE: Ribbon "Pivot Table" (analyze) tab for pivot table operations.
// CONTEXT: Appears alongside "Pivot Table Design" when a pivot is selected.
// Contains: Change Data Source, Refresh, Options, Delete.

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { css } from '@emotion/css';
import { onAppEvent, emitAppEvent, showDialog } from '../../../src/api';
import { PivotEvents } from '../lib/pivotEvents';
import { refreshPivotCache, getPivotTableInfo, deletePivotTable, addCalculatedField, addCalculatedItem, showReportFilterPages } from '../lib/pivot-api';
import type { PivotId } from './types';
import type { RibbonContext } from '../../../src/api/extensions';
import { ChangeDataSourceDialog } from './ChangeDataSourceDialog';
import { CalculatedFieldDialog } from './CalculatedFieldDialog';
import { PIVOT_OPTIONS_DIALOG_ID } from '../manifest';
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
  button: css`
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 4px 10px;
    border: 1px solid transparent;
    border-radius: 4px;
    background: transparent;
    cursor: pointer;
    font-family: inherit;
    font-size: 11px;
    color: #333;
    white-space: nowrap;

    &:hover {
      background: #e8e8e8;
      border-color: #d0d0d0;
    }

    &:active {
      background: #d6d6d6;
    }
  `,
  buttonIcon: css`
    font-size: 22px;
    line-height: 1;
    height: 26px;
    display: flex;
    align-items: center;
    justify-content: center;
  `,
  buttonLabel: css`
    font-size: 10px;
    line-height: 1.2;
  `,
  sourceInfo: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 11px;
    color: #333;
  `,
  sourceLabel: css`
    font-size: 10px;
    color: #666;
  `,
  sourceValue: css`
    font-size: 11px;
    color: #1a1a1a;
    font-weight: 500;
    padding: 2px 6px;
    background: #f5f5f5;
    border: 1px solid #e0e0e0;
    border-radius: 3px;
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
};

// ============================================================================
// Collapse configuration
// ============================================================================

const GROUP_DEFS = [
  { collapseOrder: 1, expandedWidth: 200 },   // PivotTable
  { collapseOrder: 3, expandedWidth: 260 },   // Data
  { collapseOrder: 2, expandedWidth: 200 },   // Actions
  { collapseOrder: 4, expandedWidth: 260 },   // Calculations
];

// ============================================================================
// Component
// ============================================================================

interface LayoutState {
  pivotId: PivotId;
}

export function PivotAnalyzeTab({
  context: _context,
}: {
  context: RibbonContext;
}): React.ReactElement {
  const [pivotId, setPivotId] = useState<PivotId | null>(null);
  const [sourceRange, setSourceRange] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showChangeSource, setShowChangeSource] = useState(false);
  const [showCalcFieldDialog, setShowCalcFieldDialog] = useState(false);
  const [showCalcItemDialog, setShowCalcItemDialog] = useState(false);
  const [sourceFieldNames, setSourceFieldNames] = useState<string[]>([]);

  const containerRef = useRef<HTMLDivElement>(null);
  const groupDefs = useMemo(() => GROUP_DEFS, []);
  const collapsed = useRibbonCollapse(containerRef, groupDefs);

  // Listen for layout state broadcasts from the PivotEditor (reuses same event)
  useEffect(() => {
    const unsub = onAppEvent<LayoutState>(
      PivotEvents.PIVOT_LAYOUT_STATE,
      (detail) => {
        setPivotId(detail.pivotId);
      }
    );
    // Request current state
    emitAppEvent(PivotEvents.PIVOT_REQUEST_LAYOUT);
    return unsub;
  }, []);

  // Fetch source range when pivotId changes
  useEffect(() => {
    if (!pivotId) return;
    let cancelled = false;
    getPivotTableInfo(pivotId).then((info) => {
      if (cancelled) return;
      setSourceRange(info.sourceRange);
    }).catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, [pivotId]);

  // Clear state when pivot is deselected
  useEffect(() => {
    const handleClear = () => {
      setPivotId(null);
      setSourceRange('');
    };
    window.addEventListener('pivot:deselected', handleClear);
    return () => window.removeEventListener('pivot:deselected', handleClear);
  }, []);

  const handleRefresh = useCallback(async () => {
    if (!pivotId || isRefreshing) return;
    setIsRefreshing(true);
    try {
      await refreshPivotCache(pivotId);
      window.dispatchEvent(new Event('pivot:refresh'));
    } catch (err) {
      console.error('[PivotAnalyzeTab] Refresh failed:', err);
    } finally {
      setIsRefreshing(false);
    }
  }, [pivotId, isRefreshing]);

  const handleChangeSourceDone = useCallback(() => {
    // Refresh source range display
    if (pivotId) {
      getPivotTableInfo(pivotId).then((info) => {
        setSourceRange(info.sourceRange);
      }).catch(() => { /* ignore */ });
    }
    window.dispatchEvent(new Event('pivot:refresh'));
  }, [pivotId]);

  const handleOptions = useCallback(() => {
    if (!pivotId) return;
    showDialog(PIVOT_OPTIONS_DIALOG_ID, { pivotId });
  }, [pivotId]);

  const handleOpenCalcField = useCallback(async () => {
    if (!pivotId) return;
    try {
      const info = await getPivotTableInfo(pivotId);
      if (info) {
        setSourceFieldNames(info.sourceFields?.map((f: { name: string }) => f.name) || []);
      }
    } catch { /* use empty list */ }
    setShowCalcFieldDialog(true);
  }, [pivotId]);

  const handleSaveCalcField = useCallback(async (name: string, formula: string, numberFormat?: string) => {
    if (!pivotId) return;
    try {
      await addCalculatedField({ pivotId, name, formula, numberFormat });
      window.dispatchEvent(new Event('pivot:refresh'));
    } catch (err) {
      console.error('[PivotAnalyzeTab] Add calculated field failed:', err);
    }
    setShowCalcFieldDialog(false);
  }, [pivotId]);

  const handleOpenCalcItem = useCallback(async () => {
    if (!pivotId) return;
    try {
      const info = await getPivotTableInfo(pivotId);
      if (info) {
        // For calculated items, we show field item names from the first row field
        const rowFields = info.rowHierarchies || [];
        if (rowFields.length > 0) {
          setSourceFieldNames(rowFields.map((f: { name: string }) => f.name));
        }
      }
    } catch { /* use empty list */ }
    setShowCalcItemDialog(true);
  }, [pivotId]);

  const handleSaveCalcItem = useCallback(async (name: string, formula: string) => {
    if (!pivotId) return;
    try {
      // Default to first row field (index 0) - user would select in a full implementation
      await addCalculatedItem({ pivotId, fieldIndex: 0, name, formula });
      window.dispatchEvent(new Event('pivot:refresh'));
    } catch (err) {
      console.error('[PivotAnalyzeTab] Add calculated item failed:', err);
    }
    setShowCalcItemDialog(false);
  }, [pivotId]);

  const handleReportFilterPages = useCallback(async () => {
    if (!pivotId) return;
    try {
      // Use filter field index 0 (first filter field) by default
      const sheets = await showReportFilterPages(pivotId, 0);
      if (sheets.length > 0) {
        window.dispatchEvent(new Event('sheets:refresh'));
      }
    } catch (err) {
      console.error('[PivotAnalyzeTab] Report filter pages failed:', err);
    }
  }, [pivotId]);

  const handleDelete = useCallback(async () => {
    if (!pivotId) return;
    try {
      await deletePivotTable(pivotId);
      window.dispatchEvent(new Event('pivot:refresh'));
    } catch (err) {
      console.error('[PivotAnalyzeTab] Delete failed:', err);
    }
  }, [pivotId]);

  if (!pivotId) {
    return (
      <div className={tabStyles.disabledMessage}>
        Select a PivotTable to see options
      </div>
    );
  }

  return (
    <div ref={containerRef} className={tabStyles.container}>
      {/* PivotTable group: name + source info */}
      <RibbonGroup label="PivotTable" icon={"\uD83D\uDCCA"} collapsed={collapsed[0]}>
        <div className={tabStyles.groupContent}>
          <div className={tabStyles.sourceInfo}>
            <span className={tabStyles.sourceLabel}>Data Source:</span>
            <span className={tabStyles.sourceValue} title={sourceRange}>
              {sourceRange || '...'}
            </span>
          </div>
        </div>
      </RibbonGroup>

      {/* Data group: Change Data Source, Refresh */}
      <RibbonGroup label="Data" icon={"\u21BB"} collapsed={collapsed[1]}>
        <div className={tabStyles.groupContent}>
          <button
            className={tabStyles.button}
            onClick={() => setShowChangeSource(true)}
            title="Change the source data range for this PivotTable"
          >
            <span className={tabStyles.buttonIcon}>
              <svg width="22" height="22" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg">
                {/* Table grid */}
                <rect x="1" y="2" width="13" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
                <line x1="1" y1="6" x2="14" y2="6" stroke="currentColor" strokeWidth="1.2" />
                <line x1="1" y1="10" x2="14" y2="10" stroke="currentColor" strokeWidth="1.2" />
                <line x1="6" y1="2" x2="6" y2="14" stroke="currentColor" strokeWidth="1.2" />
                {/* Curved arrow */}
                <path d="M13 16 C16 16, 19 14, 19 10" stroke="#217346" strokeWidth="1.6" strokeLinecap="round" fill="none" />
                <path d="M17.5 8.5 L19 10 L20.5 8.5" stroke="#217346" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
              </svg>
            </span>
            <span className={tabStyles.buttonLabel}>Change Data Source</span>
          </button>
          <button
            className={tabStyles.button}
            onClick={handleRefresh}
            disabled={isRefreshing}
            title="Refresh the PivotTable data"
          >
            <span className={tabStyles.buttonIcon}>&#x21BB;</span>
            <span className={tabStyles.buttonLabel}>
              {isRefreshing ? 'Refreshing...' : 'Refresh'}
            </span>
          </button>
        </div>
      </RibbonGroup>

      {/* Actions group: Options, Delete */}
      <RibbonGroup label="Actions" icon={"\u26A1"} collapsed={collapsed[2]}>
        <div className={tabStyles.groupContent}>
          <button
            className={tabStyles.button}
            onClick={handleOptions}
            title="PivotTable Options"
          >
            <span className={tabStyles.buttonIcon}>
              <svg width="22" height="22" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M11 14a3 3 0 100-6 3 3 0 000 6z" stroke="currentColor" strokeWidth="1.4"/>
                <path d="M9.5 2.5l-.4 1.7a7 7 0 00-1.8 1l-1.6-.6L4.2 6.8l1.2 1.2a7 7 0 000 2l-1.2 1.2 1.5 2.2 1.6-.6a7 7 0 001.8 1l.4 1.7h3l.4-1.7a7 7 0 001.8-1l1.6.6 1.5-2.2-1.2-1.2a7 7 0 000-2l1.2-1.2-1.5-2.2-1.6.6a7 7 0 00-1.8-1l-.4-1.7z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
              </svg>
            </span>
            <span className={tabStyles.buttonLabel}>Options</span>
          </button>
          <button
            className={tabStyles.button}
            onClick={() => showDialog("slicer:insertDialog", { sourceType: "pivot", sourceId: pivotId })}
            title="Insert a Slicer for this PivotTable"
          >
            <span className={tabStyles.buttonIcon}>
              <svg width="22" height="22" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="2" y="2" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="1.4"/>
                <line x1="2" y1="7" x2="20" y2="7" stroke="currentColor" strokeWidth="1.2"/>
                <line x1="2" y1="12" x2="20" y2="12" stroke="currentColor" strokeWidth="1.2"/>
                <line x1="2" y1="17" x2="20" y2="17" stroke="currentColor" strokeWidth="1.2"/>
              </svg>
            </span>
            <span className={tabStyles.buttonLabel}>Insert Slicer</span>
          </button>
          <button
            className={tabStyles.button}
            onClick={() => showDialog("timelineSlicer:insertDialog", { sourceId: pivotId })}
            title="Insert a Timeline for this PivotTable"
          >
            <span className={tabStyles.buttonIcon}>
              <svg width="22" height="22" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="2" y="5" width="18" height="12" rx="2" stroke="currentColor" strokeWidth="1.4"/>
                <line x1="2" y1="10" x2="20" y2="10" stroke="currentColor" strokeWidth="1"/>
                <line x1="7" y1="10" x2="7" y2="17" stroke="currentColor" strokeWidth="0.8" strokeDasharray="1.5 1"/>
                <line x1="12" y1="10" x2="12" y2="17" stroke="currentColor" strokeWidth="0.8" strokeDasharray="1.5 1"/>
                <line x1="17" y1="10" x2="17" y2="17" stroke="currentColor" strokeWidth="0.8" strokeDasharray="1.5 1"/>
                <rect x="8" y="12" width="3" height="3" rx="0.5" fill="currentColor" opacity="0.4"/>
              </svg>
            </span>
            <span className={tabStyles.buttonLabel}>Insert Timeline</span>
          </button>
          <button
            className={tabStyles.button}
            onClick={handleReportFilterPages}
            title="Show Report Filter Pages - generate one sheet per filter value"
          >
            <span className={tabStyles.buttonIcon}>
              <svg width="22" height="22" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="2" y="4" width="14" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.2"/>
                <rect x="4" y="2" width="14" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.2" fill="#fff"/>
                <rect x="6" y="0" width="14" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.2" fill="#fff"/>
                <line x1="6" y1="4" x2="20" y2="4" stroke="currentColor" strokeWidth="1"/>
                <line x1="6" y1="8" x2="20" y2="8" stroke="currentColor" strokeWidth="1"/>
                <line x1="12" y1="0" x2="12" y2="12" stroke="currentColor" strokeWidth="1"/>
              </svg>
            </span>
            <span className={tabStyles.buttonLabel}>Filter Pages</span>
          </button>
          <button
            className={tabStyles.button}
            onClick={handleDelete}
            title="Delete this PivotTable"
            style={{ color: "#c42b1c" }}
          >
            <span className={tabStyles.buttonIcon}>&#x2716;</span>
            <span className={tabStyles.buttonLabel}>Delete</span>
          </button>
        </div>
      </RibbonGroup>

      {/* Calculations group: Calculated Field, Calculated Item */}
      <RibbonGroup label="Calculations" icon={"fx"} collapsed={collapsed[3]}>
        <div className={tabStyles.groupContent}>
          <button
            className={tabStyles.button}
            onClick={handleOpenCalcField}
            title="Insert a Calculated Field"
          >
            <span className={tabStyles.buttonIcon}>
              <svg width="22" height="22" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg">
                <text x="3" y="16" fontSize="14" fontWeight="bold" fontFamily="serif" fill="currentColor">fx</text>
                <circle cx="16" cy="6" r="5" stroke="#217346" strokeWidth="1.4" fill="none"/>
                <line x1="16" y1="3.5" x2="16" y2="8.5" stroke="#217346" strokeWidth="1.4" strokeLinecap="round"/>
                <line x1="13.5" y1="6" x2="18.5" y2="6" stroke="#217346" strokeWidth="1.4" strokeLinecap="round"/>
              </svg>
            </span>
            <span className={tabStyles.buttonLabel}>Calculated Field</span>
          </button>
          <button
            className={tabStyles.button}
            onClick={handleOpenCalcItem}
            title="Insert a Calculated Item"
          >
            <span className={tabStyles.buttonIcon}>
              <svg width="22" height="22" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="2" y="4" width="12" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.4"/>
                <line x1="2" y1="8" x2="14" y2="8" stroke="currentColor" strokeWidth="1.2"/>
                <line x1="2" y1="12" x2="14" y2="12" stroke="currentColor" strokeWidth="1.2"/>
                <circle cx="16" cy="6" r="5" stroke="#217346" strokeWidth="1.4" fill="none"/>
                <line x1="16" y1="3.5" x2="16" y2="8.5" stroke="#217346" strokeWidth="1.4" strokeLinecap="round"/>
                <line x1="13.5" y1="6" x2="18.5" y2="6" stroke="#217346" strokeWidth="1.4" strokeLinecap="round"/>
              </svg>
            </span>
            <span className={tabStyles.buttonLabel}>Calculated Item</span>
          </button>
        </div>
      </RibbonGroup>

      {/* Change Data Source Dialog */}
      <ChangeDataSourceDialog
        isOpen={showChangeSource}
        onClose={() => setShowChangeSource(false)}
        pivotId={pivotId}
        onChanged={handleChangeSourceDone}
      />

      {/* Calculated Field Dialog */}
      <CalculatedFieldDialog
        isOpen={showCalcFieldDialog}
        fieldNames={sourceFieldNames}
        onSave={handleSaveCalcField}
        onCancel={() => setShowCalcFieldDialog(false)}
        title="Insert Calculated Field"
      />

      {/* Calculated Item Dialog */}
      <CalculatedFieldDialog
        isOpen={showCalcItemDialog}
        fieldNames={sourceFieldNames}
        onSave={handleSaveCalcItem}
        onCancel={() => setShowCalcItemDialog(false)}
        title="Insert Calculated Item"
      />
    </div>
  );
}
