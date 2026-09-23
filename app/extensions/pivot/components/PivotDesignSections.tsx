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
//
//          Built from the @api/layout control grammar only (Input, Checkbox,
//          Dropdown, Field, StyleGallery), and every section follows THE FILL
//          RULE of the Clusters redesign: in the band its content is either
//          one tall 61px row (the styles gallery) or two 28px rows with a 5px
//          gap (every other section), so no cluster is a short row floating in
//          a tall card. In a sidebar or flyout the same JSX flows vertically.
//
//          This file is chrome: colours come only from LT tokens.

import React, { useState, useEffect, useCallback, useId, useRef } from 'react';
import { css, cx } from '@emotion/css';
import type { PanelSectionProps } from '@api/uiTypes';
import {
  Checkbox,
  ControlRow,
  Dropdown,
  Field,
  FieldGrid,
  Input,
  LT,
  Stack,
  CONTROL_HEIGHT_MD,
  FONT_FAMILY,
  LABEL_FONT_SIZE,
  ROW_GAP,
  useSurfaceLayout,
  type DropdownOption,
} from '@api/layout';
import { getPivotTableInfo, updatePivotProperties } from '../lib/pivot-api';
import { usePivotPanelState, updateSharedLayout } from '../lib/pivotPanelStore';
import { setPivotStylePreview } from '../lib/pivotStyles';
import type { ReportLayout, ValuesPosition } from './types';
import { PivotTableStylesGallery, DEFAULT_PIVOT_STYLE_ID } from './PivotTableStylesGallery';

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
  /** Caption row above a field: two rows of 28 fill the band's 61px box. */
  twoRows: css`
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: ${ROW_GAP}px;
    min-width: 0;
  `,
  caption: css`
    font-family: ${FONT_FAMILY};
    font-size: ${LABEL_FONT_SIZE}px;
    font-weight: 400;
    line-height: 13px;
    color: ${LT.textSecondary};
    white-space: nowrap;
  `,
  /** In the band the caption is a full 28px row, so the pair is 28 + 5 + 28. */
  captionBand: css`
    display: flex;
    align-items: center;
    height: ${CONTROL_HEIGHT_MD}px;
  `,
};

/** Width of the name box in the band (fits "PivotTable12"). */
const NAME_INPUT_BAND_WIDTH = 140;

const REPORT_LAYOUT_OPTIONS: ReadonlyArray<DropdownOption<ReportLayout>> = [
  { value: 'compact', label: 'Compact' },
  { value: 'outline', label: 'Outline' },
  { value: 'tabular', label: 'Tabular' },
];

const VALUES_POSITION_OPTIONS: ReadonlyArray<DropdownOption<ValuesPosition>> = [
  { value: 'columns', label: 'Columns' },
  { value: 'rows', label: 'Rows' },
];

// ============================================================================
// PivotTable Name section
// ============================================================================

export function DesignNameSection(_props: PanelSectionProps): React.ReactElement {
  const { layoutState } = usePivotPanelState();
  const layout = useSurfaceLayout();
  const band = layout.container === 'band';
  const inputId = useId();
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
    <div className={sectionStyles.twoRows}>
      <label
        htmlFor={inputId}
        className={cx(sectionStyles.caption, band && sectionStyles.captionBand)}
      >
        PivotTable Name:
      </label>
      <Input
        id={inputId}
        ref={nameInputRef}
        type="text"
        width={band ? NAME_INPUT_BAND_WIDTH : undefined}
        value={pivotName}
        data-testid="pivot-design-name"
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
    <Stack gap={ROW_GAP}>
      <Checkbox
        label="Row Totals"
        checked={layout.showRowGrandTotals ?? true}
        onChange={(checked) => updateSharedLayout({ showRowGrandTotals: checked })}
        testId="pivot-design-row-totals"
      />
      <Checkbox
        label="Column Totals"
        checked={layout.showColumnGrandTotals ?? true}
        onChange={(checked) => updateSharedLayout({ showColumnGrandTotals: checked })}
        testId="pivot-design-column-totals"
      />
    </Stack>
  );
}

// ============================================================================
// PivotTable Styles section — hosts the styles gallery widget
// ============================================================================

export function DesignStylesSection(_props: PanelSectionProps): React.ReactElement | null {
  const { layoutState } = usePivotPanelState();
  const pivotId = layoutState?.pivotId ?? null;

  // The preview is transient: it paints the pivot in the hovered style and
  // touches nothing persisted, so it must never outlive the pivot it was
  // started on. The gallery ends it on every exit of its own; this ends it if
  // the active pivot changes underneath a standing preview.
  useEffect(() => {
    return () => setPivotStylePreview(null, null);
  }, [pivotId]);

  const handlePreview = useCallback(
    (styleId: string | null) => setPivotStylePreview(pivotId, styleId),
    [pivotId],
  );

  if (!layoutState) {
    return null;
  }
  const { layout } = layoutState;

  return (
    <PivotTableStylesGallery
      selectedStyleId={layout.styleId ?? DEFAULT_PIVOT_STYLE_ID}
      onStyleSelect={(styleId) => updateSharedLayout({ styleId })}
      onStyleClear={() => updateSharedLayout({ styleId: '' })}
      onStylePreview={handlePreview}
    />
  );
}

// ============================================================================
// Report Layout section
// ============================================================================

export function DesignReportLayoutSection(_props: PanelSectionProps): React.ReactElement | null {
  const { layoutState } = usePivotPanelState();
  const surface = useSurfaceLayout();

  if (!layoutState) {
    return null;
  }
  const { layout } = layoutState;

  const fields = (
    <>
      <Field label="Layout:">
        <Dropdown<ReportLayout>
          ariaLabel="Report layout"
          value={layout.reportLayout ?? 'compact'}
          options={REPORT_LAYOUT_OPTIONS}
          onChange={(value) => updateSharedLayout({ reportLayout: value })}
          testId="pivot-design-report-layout"
          optionTestIdPrefix="pivot-design-report-layout-"
        />
      </Field>
      <Field label="Values:">
        <Dropdown<ValuesPosition>
          ariaLabel="Values position"
          value={layout.valuesPosition ?? 'columns'}
          options={VALUES_POSITION_OPTIONS}
          onChange={(value) => updateSharedLayout({ valuesPosition: value })}
          testId="pivot-design-values-position"
          optionTestIdPrefix="pivot-design-values-position-"
        />
      </Field>
    </>
  );

  // Band: the two fields stack as 28 + 5 + 28. Panel: label-above fields,
  // two columns when the panel is wide enough.
  return surface.container === 'band'
    ? <Stack gap={ROW_GAP}>{fields}</Stack>
    : <FieldGrid>{fields}</FieldGrid>;
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
      <Stack gap={ROW_GAP}>
        <Checkbox
          label="Repeat Labels"
          checked={layout.repeatRowLabels ?? false}
          onChange={(checked) => updateSharedLayout({ repeatRowLabels: checked })}
          testId="pivot-design-repeat-labels"
        />
        <Checkbox
          label="Empty Rows"
          checked={layout.showEmptyRows ?? false}
          onChange={(checked) => updateSharedLayout({ showEmptyRows: checked })}
          testId="pivot-design-empty-rows"
        />
      </Stack>
      <Stack gap={ROW_GAP}>
        <Checkbox
          label="Empty Cols"
          checked={layout.showEmptyCols ?? false}
          onChange={(checked) => updateSharedLayout({ showEmptyCols: checked })}
          testId="pivot-design-empty-cols"
        />
        <Checkbox
          label="Autofit Columns"
          checked={layout.autoFitColumnWidths ?? true}
          onChange={(checked) => updateSharedLayout({ autoFitColumnWidths: checked })}
          testId="pivot-design-autofit-columns"
        />
      </Stack>
    </ControlRow>
  );
}
