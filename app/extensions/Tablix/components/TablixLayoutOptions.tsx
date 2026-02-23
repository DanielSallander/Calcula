//! FILENAME: app/extensions/Tablix/components/TablixLayoutOptions.tsx
// PURPOSE: Layout options panel for the Tablix editor.
// CONTEXT: Controls group layout, grand totals, repeat labels, etc.

import React, { useCallback } from 'react';
import { styles } from '../../_shared/components/EditorStyles';
import type { TablixLayoutConfig, GroupLayout } from '../types';

interface TablixLayoutOptionsProps {
  layout: Partial<TablixLayoutConfig>;
  onChange: (layout: Partial<TablixLayoutConfig>) => void;
}

export function TablixLayoutOptions({
  layout,
  onChange,
}: TablixLayoutOptionsProps): React.ReactElement {
  const handleCheckboxChange = useCallback(
    (key: keyof TablixLayoutConfig) => (e: React.ChangeEvent<HTMLInputElement>) => {
      onChange({
        ...layout,
        [key]: e.target.checked,
      });
    },
    [layout, onChange]
  );

  const handleGroupLayoutChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      onChange({
        ...layout,
        groupLayout: e.target.value as GroupLayout,
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
          checked={layout.repeatGroupLabels ?? false}
          onChange={handleCheckboxChange('repeatGroupLabels')}
        />
        Repeat group labels
      </label>

      <label className={styles.layoutOption}>
        <input
          type="checkbox"
          checked={layout.showEmptyGroups ?? false}
          onChange={handleCheckboxChange('showEmptyGroups')}
        />
        Show empty groups
      </label>

      <div className={styles.layoutOption}>
        Group layout:
        <select
          value={layout.groupLayout ?? 'stepped'}
          onChange={handleGroupLayoutChange}
        >
          <option value="stepped">Stepped</option>
          <option value="block">Block</option>
        </select>
      </div>
    </div>
  );
}
