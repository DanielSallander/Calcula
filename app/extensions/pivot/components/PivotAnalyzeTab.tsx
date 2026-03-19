//! FILENAME: app/extensions/Pivot/components/PivotAnalyzeTab.tsx
// PURPOSE: Ribbon "Pivot Table" (analyze) tab for pivot table operations.
// CONTEXT: Appears alongside "Pivot Table Design" when a pivot is selected.
// Contains: Change Data Source, Refresh, Options, Delete.

import React, { useState, useEffect, useCallback } from 'react';
import { css } from '@emotion/css';
import { onAppEvent, emitAppEvent, showDialog } from '../../../src/api';
import { PivotEvents } from '../lib/pivotEvents';
import { refreshPivotCache, getPivotTableInfo, deletePivotTable } from '../lib/pivot-api';
import type { PivotId } from './types';
import type { RibbonContext } from '../../../src/api/extensions';
import { ChangeDataSourceDialog } from './ChangeDataSourceDialog';
import { PIVOT_OPTIONS_DIALOG_ID } from '../manifest';

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
    font-size: 24px;
    line-height: 1;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
  `,
  buttonLabel: css`
    font-size: 10px;
    line-height: 1;
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
    <div className={tabStyles.container}>
      {/* PivotTable group: name + source info */}
      <div className={tabStyles.group}>
        <div className={tabStyles.groupContent}>
          <div className={tabStyles.sourceInfo}>
            <span className={tabStyles.sourceLabel}>Data Source:</span>
            <span className={tabStyles.sourceValue} title={sourceRange}>
              {sourceRange || '...'}
            </span>
          </div>
        </div>
        <div className={tabStyles.groupLabel}>PivotTable</div>
      </div>

      {/* Data group: Change Data Source, Refresh */}
      <div className={tabStyles.group}>
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
        <div className={tabStyles.groupLabel}>Data</div>
      </div>

      {/* Actions group: Options, Delete */}
      <div className={tabStyles.group}>
        <div className={tabStyles.groupContent}>
          <button
            className={tabStyles.button}
            onClick={handleOptions}
            title="PivotTable Options"
          >
            <span className={tabStyles.buttonIcon}>&#x2699;</span>
            <span className={tabStyles.buttonLabel}>Options</span>
          </button>
          <button
            className={tabStyles.button}
            onClick={handleDelete}
            title="Delete this PivotTable"
          >
            <span className={tabStyles.buttonIcon}>&#x2716;</span>
            <span className={tabStyles.buttonLabel}>Delete</span>
          </button>
        </div>
        <div className={tabStyles.groupLabel}>Actions</div>
      </div>

      {/* Change Data Source Dialog */}
      <ChangeDataSourceDialog
        isOpen={showChangeSource}
        onClose={() => setShowChangeSource(false)}
        pivotId={pivotId}
        onChanged={handleChangeSourceDone}
      />
    </div>
  );
}
