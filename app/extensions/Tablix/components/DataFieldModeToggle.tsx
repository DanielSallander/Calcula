//! FILENAME: app/extensions/Tablix/components/DataFieldModeToggle.tsx
// PURPOSE: Toggle button for switching data fields between Aggregated and Detail modes.
// CONTEXT: Displayed on each data field in the Tablix drop zone.

import React, { useCallback } from 'react';
import { css } from '@emotion/css';
import type { DataFieldMode } from '../types';

interface DataFieldModeToggleProps {
  mode: DataFieldMode;
  onChange: (mode: DataFieldMode) => void;
}

const toggleStyles = {
  container: css`
    display: inline-flex;
    border: 1px solid #d0d0d0;
    border-radius: 3px;
    overflow: hidden;
    margin-left: 4px;
    flex-shrink: 0;
  `,
  button: css`
    padding: 1px 5px;
    border: none;
    background: #fff;
    font-size: 9px;
    cursor: pointer;
    color: #666;
    line-height: 1.4;
    transition: all 0.15s;

    &:first-child {
      border-right: 1px solid #d0d0d0;
    }

    &:hover {
      background: #f0f0f0;
    }

    &.active {
      background: #0078d4;
      color: #fff;
    }
  `,
};

export function DataFieldModeToggle({
  mode,
  onChange,
}: DataFieldModeToggleProps): React.ReactElement {
  const handleAggregated = useCallback(() => {
    if (mode !== 'aggregated') onChange('aggregated');
  }, [mode, onChange]);

  const handleDetail = useCallback(() => {
    if (mode !== 'detail') onChange('detail');
  }, [mode, onChange]);

  return (
    <span className={toggleStyles.container}>
      <button
        className={`${toggleStyles.button}${mode === 'aggregated' ? ' active' : ''}`}
        onClick={handleAggregated}
        title="Aggregated: Summarize values using an aggregation function"
      >
        Agg
      </button>
      <button
        className={`${toggleStyles.button}${mode === 'detail' ? ' active' : ''}`}
        onClick={handleDetail}
        title="Detail: Show raw source data rows"
      >
        Det
      </button>
    </span>
  );
}
