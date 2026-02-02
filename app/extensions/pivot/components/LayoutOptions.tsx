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
        report_layout: e.target.value as ReportLayout,
      });
    },
    [layout, onChange]
  );

  const handleValuesPositionChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      onChange({
        ...layout,
        values_position: e.target.value as ValuesPosition,
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
          checked={layout.show_row_grand_totals ?? true}
          onChange={handleCheckboxChange('show_row_grand_totals')}
        />
        Show row grand totals
      </label>

      <label className={styles.layoutOption}>
        <input
          type="checkbox"
          checked={layout.show_column_grand_totals ?? true}
          onChange={handleCheckboxChange('show_column_grand_totals')}
        />
        Show column grand totals
      </label>

      <label className={styles.layoutOption}>
        <input
          type="checkbox"
          checked={layout.repeat_row_labels ?? false}
          onChange={handleCheckboxChange('repeat_row_labels')}
        />
        Repeat row labels
      </label>

      <label className={styles.layoutOption}>
        <input
          type="checkbox"
          checked={layout.show_empty_rows ?? false}
          onChange={handleCheckboxChange('show_empty_rows')}
        />
        Show empty rows
      </label>

      <label className={styles.layoutOption}>
        <input
          type="checkbox"
          checked={layout.show_empty_cols ?? false}
          onChange={handleCheckboxChange('show_empty_cols')}
        />
        Show empty columns
      </label>

      <div className={styles.layoutOption}>
        Report layout:
        <select
          value={layout.report_layout ?? 'compact'}
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
          value={layout.values_position ?? 'columns'}
          onChange={handleValuesPositionChange}
        >
          <option value="columns">Columns</option>
          <option value="rows">Rows</option>
        </select>
      </div>
    </div>
  );
}