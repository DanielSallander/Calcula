//! FILENAME: app/extensions/pivot/components/PivotEditorPanel.tsx
import React from 'react';
import { css } from '@emotion/css';
import { PivotEditor } from './PivotEditor';
import type { PivotId, SourceField, ZoneField, LayoutConfig } from './types';

const panelStyles = {
  container: css`
    width: 320px;
    height: 100%;
    flex-shrink: 0;
    border-left: 1px solid #e0e0e0;
    background: #f8f9fa;
    display: flex;
    flex-direction: column;
  `,
};

interface PivotEditorPanelProps {
  pivotId: PivotId;
  sourceFields: SourceField[];
  initialRows?: ZoneField[];
  initialColumns?: ZoneField[];
  initialValues?: ZoneField[];
  initialFilters?: ZoneField[];
  initialLayout?: LayoutConfig;
  onClose: () => void;
  onViewUpdate?: () => void;
}

export function PivotEditorPanel({
  pivotId,
  sourceFields,
  initialRows,
  initialColumns,
  initialValues,
  initialFilters,
  initialLayout,
  onClose,
  onViewUpdate,
}: PivotEditorPanelProps): React.ReactElement {
  return (
    <div className={panelStyles.container}>
      <PivotEditor
        pivotId={pivotId}
        sourceFields={sourceFields}
        initialRows={initialRows}
        initialColumns={initialColumns}
        initialValues={initialValues}
        initialFilters={initialFilters}
        initialLayout={initialLayout}
        onClose={onClose}
        onViewUpdate={onViewUpdate}
      />
    </div>
  );
}