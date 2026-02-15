//! FILENAME: app/extensions/pivot/components/LayoutOptions.tsx
import React, { useCallback } from 'react';
import { styles } from './PivotEditor.styles';
import type { LayoutConfig, ReportLayout, ValuesPosition } from './types';

interface LayoutOptionsProps {
  layout: LayoutConfig;
  onChange: (layout: LayoutConfig) => void;
}

export function LayoutOptions({
  layout,
  onChange,
}: LayoutOptionsProps): React.ReactElement {
  const handleCheckboxChange = useCallback(
    (key: keyof LayoutConfig) => (e: React.ChangeEvent<HTMLInputElement>) => {
      onChange({
        ...layout,
        [key]: e.target.checked,
      });
    },
    [layout, onChange]
  );

  const handleReportLayoutChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      onChange({
        ...layout,
        reportLayout: e.target.value as ReportLayout,
      });
    },
    [layout, onChange]
  );

  const handleValuesPositionChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      onChange({
        ...layout,
        valuesPosition: e.target.value as ValuesPosition,
      });
    },
    [layout, onChange]
  );

  return (
    <div className={styles.layoutSection}>
      <div className={styles.sectionTitle}>Layout Options</div>

      <label className={styles.layoutOption}>
        <input
          type="checkbox"
          checked={layout.showRowGrandTotals ?? true}
          onChange={handleCheckboxChange('showRowGrandTotals')}
        />
        Show row grand totals
      </label>

      <label className={styles.layoutOption}>
        <input
          type="checkbox"
          checked={layout.showColumnGrandTotals ?? true}
          onChange={handleCheckboxChange('showColumnGrandTotals')}
        />
        Show column grand totals
      </label>

      <label className={styles.layoutOption}>
        <input
          type="checkbox"
          checked={layout.repeatRowLabels ?? false}
          onChange={handleCheckboxChange('repeatRowLabels')}
        />
        Repeat row labels
      </label>

      <label className={styles.layoutOption}>
        <input
          type="checkbox"
          checked={layout.showEmptyRows ?? false}
          onChange={handleCheckboxChange('showEmptyRows')}
        />
        Show empty rows
      </label>

      <label className={styles.layoutOption}>
        <input
          type="checkbox"
          checked={layout.showEmptyCols ?? false}
          onChange={handleCheckboxChange('showEmptyCols')}
        />
        Show empty columns
      </label>

      <div className={styles.layoutOption}>
        Report layout:
        <select
          value={layout.reportLayout ?? 'compact'}
          onChange={handleReportLayoutChange}
        >
          <option value="compact">Compact</option>
          <option value="outline">Outline</option>
          <option value="tabular">Tabular</option>
        </select>
      </div>

      <div className={styles.layoutOption}>
        Values position:
        <select
          value={layout.valuesPosition ?? 'columns'}
          onChange={handleValuesPositionChange}
        >
          <option value="columns">Columns</option>
          <option value="rows">Rows</option>
        </select>
      </div>
    </div>
  );
}