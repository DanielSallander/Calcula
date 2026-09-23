//! FILENAME: app/extensions/Pivot/components/PivotAnalyzeSections.tsx
// PURPOSE: Panel sections for the contextual "Pivot Table" (analyze) panel:
//          PivotTable info, Data, Actions, Calculations.
// CONTEXT: Appears alongside "Pivot Table Design" when a pivot is selected.
//          One section per former ribbon group; the shell owns group chrome,
//          labels and width-collapse. Sections share pivot state through
//          lib/pivotPanelStore (replaces the monolithic PivotAnalyzeTab).
//
//          Built from the @api/layout control grammar: the big buttons are
//          CommandButton heroes (61px in the band, 28px inline buttons in a
//          sidebar or flyout) carrying duotone RibbonIcons, so they follow the
//          skin — the old hand-drawn SVGs painted a fixed Excel green and a
//          white page fill that glared in Dark. Every section follows THE FILL
//          RULE: one tall 61px row of heroes, or two 28px rows with a 5px gap
//          (the data-source readout; the Filter Pages / Delete pair).
//
//          This file is chrome: colours come only from LT tokens.

import React, { useState, useCallback } from 'react';
import { css, cx } from '@emotion/css';
import { showDialog, openTaskPane } from '@api';
import type { PanelSectionProps } from '@api/uiTypes';
import {
  ActionRow,
  Button,
  CommandButton,
  LT,
  CONTROL_HEIGHT_MD,
  FIELD_HEIGHT,
  FONT_FAMILY,
  GAP_XS,
  HERO_ICON_SIZE,
  ICON_SIZE_SM,
  LABEL_FONT_SIZE,
  ROW_GAP,
  useSurfaceLayout,
} from '@api/layout';
import { RibbonIcon } from '@api/ribbonIcons';
import {
  refreshPivotCache,
  getPivotTableInfo,
  deletePivotTable,
  addCalculatedField,
  addCalculatedItem,
  showReportFilterPages,
} from '../lib/pivot-api';
import { usePivotPanelState, refreshSourceRange } from '../lib/pivotPanelStore';
import { ChangeDataSourceDialog } from './ChangeDataSourceDialog';
import { CalculatedFieldDialog } from './CalculatedFieldDialog';
import { PIVOT_OPTIONS_DIALOG_ID } from '../manifest';
import { confirmAsync } from "@api/dialogs";

// ============================================================================
// Styles (tokens only)
// ============================================================================

const sectionStyles = {
  /** "Select a PivotTable..." — fills the content box, centred. */
  disabledMessage: css`
    display: flex;
    align-items: center;
    height: 100%;
    color: ${LT.textTertiary};
    font-style: italic;
    font-size: 12px;
    white-space: nowrap;
    font-family: ${FONT_FAMILY};
  `,
  /** Two stacked rows (28 + 5 + 28 in the band). */
  twoRows: css`
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: flex-start;
    gap: ${ROW_GAP}px;
    min-width: 0;
  `,
  caption: css`
    font-family: ${FONT_FAMILY};
    font-size: ${LABEL_FONT_SIZE}px;
    line-height: 13px;
    color: ${LT.textSecondary};
    white-space: nowrap;
  `,
  /** In the band the caption is a full 28px row. */
  captionBand: css`
    display: flex;
    align-items: center;
    height: ${CONTROL_HEIGHT_MD}px;
  `,
  /** The read-only source range: a field-shaped box, not an editable one. */
  sourceValue: css`
    display: flex;
    align-items: center;
    box-sizing: border-box;
    height: ${FIELD_HEIGHT}px;
    max-width: 200px;
    padding: 0 8px;
    font-family: ${FONT_FAMILY};
    font-size: 12px;
    font-weight: 500;
    color: ${LT.text};
    background: ${LT.panel};
    border: 1px solid ${LT.controlBorder};
    border-radius: ${LT.radiusControl};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  sourceValueText: css`
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  `,
};

// ============================================================================
// PivotTable section — data source info
// ============================================================================

export function AnalyzePivotTableSection(_props: PanelSectionProps): React.ReactElement {
  const { pivotId, sourceRange } = usePivotPanelState();
  const layout = useSurfaceLayout();
  const band = layout.container === 'band';

  if (!pivotId) {
    return (
      <div className={sectionStyles.disabledMessage}>
        Select a PivotTable to see options
      </div>
    );
  }

  return (
    <div className={sectionStyles.twoRows}>
      <span className={cx(sectionStyles.caption, band && sectionStyles.captionBand)}>
        Data Source:
      </span>
      <span
        className={sectionStyles.sourceValue}
        title={sourceRange}
        data-testid="pivot-analyze-source-range"
      >
        <span className={sectionStyles.sourceValueText}>{sourceRange || '...'}</span>
      </span>
    </div>
  );
}

// ============================================================================
// Data section — Change Data Source, Refresh
// ============================================================================

export function AnalyzeDataSection(_props: PanelSectionProps): React.ReactElement | null {
  const { pivotId } = usePivotPanelState();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showChangeSource, setShowChangeSource] = useState(false);

  const handleRefresh = useCallback(async () => {
    if (!pivotId || isRefreshing) return;
    setIsRefreshing(true);
    try {
      await refreshPivotCache(pivotId);
      window.dispatchEvent(new Event('pivot:refresh'));
    } catch (err) {
      const errStr = String(err);
      if (errStr.includes('Not connected') || errStr.includes('No connection')) {
        // BI pivot not connected — offer to open Connections pane
        const shouldConnect = await confirmAsync(
          'This pivot table is not connected to a data source.\n\n' +
          'Open the Connections panel to connect?'
        );
        if (shouldConnect) {
          openTaskPane("connections-pane");
        }
      } else {
        console.error('[PivotAnalyzeSections] Refresh failed:', err);
      }
    } finally {
      setIsRefreshing(false);
    }
  }, [pivotId, isRefreshing]);

  const handleChangeSourceDone = useCallback(() => {
    // Refresh source range display in the PivotTable section
    refreshSourceRange();
    window.dispatchEvent(new Event('pivot:refresh'));
  }, []);

  if (!pivotId) {
    return null;
  }

  return (
    <>
      <ActionRow gap={GAP_XS}>
        <CommandButton
          icon={<RibbonIcon.ChangeSource size={HERO_ICON_SIZE} />}
          label="Change Source"
          tooltip="Change Data Source: change the source data range for this PivotTable"
          onClick={() => setShowChangeSource(true)}
          data-testid="pivot-analyze-change-source"
        />
        <CommandButton
          icon={<RibbonIcon.Refresh size={HERO_ICON_SIZE} />}
          label={isRefreshing ? 'Refreshing...' : 'Refresh'}
          tooltip="Refresh the PivotTable data"
          onClick={handleRefresh}
          disabled={isRefreshing}
          aria-busy={isRefreshing || undefined}
          data-testid="pivot-analyze-refresh"
        />
      </ActionRow>

      {/* Change Data Source Dialog */}
      <ChangeDataSourceDialog
        isOpen={showChangeSource}
        onClose={() => setShowChangeSource(false)}
        pivotId={pivotId}
        onChanged={handleChangeSourceDone}
      />
    </>
  );
}

// ============================================================================
// Actions section — Options, Insert Slicer, Insert Timeline, Filter Pages, Delete
// ============================================================================

export function AnalyzeActionsSection(_props: PanelSectionProps): React.ReactElement | null {
  const { pivotId } = usePivotPanelState();
  const layout = useSurfaceLayout();
  const band = layout.container === 'band';

  const handleOptions = useCallback(() => {
    if (!pivotId) return;
    showDialog(PIVOT_OPTIONS_DIALOG_ID, { pivotId });
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
      console.error('[PivotAnalyzeSections] Report filter pages failed:', err);
    }
  }, [pivotId]);

  const handleDelete = useCallback(async () => {
    if (!pivotId) return;
    try {
      await deletePivotTable(pivotId);
      window.dispatchEvent(new Event('pivot:refresh'));
    } catch (err) {
      console.error('[PivotAnalyzeSections] Delete failed:', err);
    }
  }, [pivotId]);

  if (!pivotId) {
    return null;
  }

  // The two lighter commands stack as 28 + 5 + 28 beside the heroes in the
  // band (Excel's own Actions group is a stacked column); elsewhere they
  // simply continue the row of buttons.
  const stacked = (
    <>
      <Button
        icon={<RibbonIcon.FilterPages size={ICON_SIZE_SM} />}
        tooltip="Show Report Filter Pages - generate one sheet per filter value"
        onClick={handleReportFilterPages}
        data-testid="pivot-analyze-filter-pages"
      >
        Filter Pages
      </Button>
      <Button
        tone="danger"
        icon={<RibbonIcon.Delete size={ICON_SIZE_SM} />}
        tooltip="Delete this PivotTable"
        onClick={handleDelete}
        data-testid="pivot-analyze-delete"
      >
        Delete
      </Button>
    </>
  );

  return (
    <ActionRow gap={GAP_XS}>
      <CommandButton
        icon={<RibbonIcon.Settings size={HERO_ICON_SIZE} />}
        label="Options"
        tooltip="PivotTable Options"
        onClick={handleOptions}
        data-testid="pivot-analyze-options"
      />
      <CommandButton
        icon={<RibbonIcon.Slicer size={HERO_ICON_SIZE} />}
        label="Insert Slicer"
        tooltip="Insert a Slicer for this PivotTable"
        onClick={() => showDialog("slicer:insertDialog", { sourceType: "pivot", sourceId: pivotId })}
        data-testid="pivot-analyze-insert-slicer"
      />
      <CommandButton
        icon={<RibbonIcon.Timeline size={HERO_ICON_SIZE} />}
        label="Insert Timeline"
        tooltip="Insert a Timeline for this PivotTable"
        onClick={() => showDialog("timelineSlicer:insertDialog", { sourceId: pivotId })}
        data-testid="pivot-analyze-insert-timeline"
      />
      {band ? <div className={sectionStyles.twoRows}>{stacked}</div> : stacked}
    </ActionRow>
  );
}

// ============================================================================
// Calculations section — Calculated Field, Calculated Item
// ============================================================================

export function AnalyzeCalculationsSection(_props: PanelSectionProps): React.ReactElement | null {
  const { pivotId } = usePivotPanelState();
  const [showCalcFieldDialog, setShowCalcFieldDialog] = useState(false);
  const [showCalcItemDialog, setShowCalcItemDialog] = useState(false);
  const [sourceFieldNames, setSourceFieldNames] = useState<string[]>([]);

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
      console.error('[PivotAnalyzeSections] Add calculated field failed:', err);
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
      console.error('[PivotAnalyzeSections] Add calculated item failed:', err);
    }
    setShowCalcItemDialog(false);
  }, [pivotId]);

  if (!pivotId) {
    return null;
  }

  return (
    <>
      <ActionRow gap={GAP_XS}>
        <CommandButton
          icon={<RibbonIcon.CalcField size={HERO_ICON_SIZE} />}
          label="Calculated Field"
          tooltip="Insert a Calculated Field"
          onClick={handleOpenCalcField}
          data-testid="pivot-analyze-calculated-field"
        />
        <CommandButton
          icon={<RibbonIcon.Fx size={HERO_ICON_SIZE} />}
          label="Calculated Item"
          tooltip="Insert a Calculated Item"
          onClick={handleOpenCalcItem}
          data-testid="pivot-analyze-calculated-item"
        />
      </ActionRow>

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
    </>
  );
}
