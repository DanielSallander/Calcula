//! FILENAME: app/extensions/pivot/components/FieldList.tsx
import React, { useState, useMemo } from 'react';
import { css } from '@emotion/css';
import { styles } from './PivotEditor.styles';
import { FieldItem } from './FieldItem';
import type { SourceField, DragField } from './types';

// Search input styles
const searchStyles = {
  container: css`
    padding: 6px 8px;
    border-bottom: 1px solid #e0e0e0;
    background: #fafafa;
  `,
  input: css`
    width: 100%;
    padding: 6px 8px;
    border: 1px solid #d4d4d4;
    border-radius: 3px;
    font-size: 12px;
    font-family: inherit;
    outline: none;
    background: #fff;
    transition: border-color 0.15s;

    &:focus {
      border-color: #0078d4;
    }

    &::placeholder {
      color: #999;
    }
  `,
  noResults: css`
    padding: 12px;
    text-align: center;
    color: #666;
    font-size: 11px;
    font-style: italic;
  `,
};

interface FieldListProps {
  fields: SourceField[];
  usedFields: Set<number>;
  onFieldToggle: (field: SourceField, checked: boolean) => void;
  onDragStart: (field: DragField) => void;
  onDragEnd: () => void;
}

export function FieldList({
  fields,
  usedFields,
  onFieldToggle,
  onDragStart,
  onDragEnd,
}: FieldListProps): React.ReactElement {
  const [searchQuery, setSearchQuery] = useState('');

  // Filter fields based on search query
  const filteredFields = useMemo(() => {
    if (!searchQuery.trim()) {
      return fields;
    }
    const query = searchQuery.toLowerCase();
    return fields.filter((field) =>
      field.name.toLowerCase().includes(query)
    );
  }, [fields, searchQuery]);

  return (
    <div className={styles.section}>
      <div className={styles.sectionTitle}>Choose fields to add to report</div>
      <div className={styles.fieldList}>
        {/* Search input */}
        <div className={searchStyles.container}>
          <input
            type="text"
            className={searchStyles.input}
            placeholder="Search fields..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        {/* Field list */}
        {filteredFields.length === 0 ? (
          <div className={searchStyles.noResults}>
            No fields match "{searchQuery}"
          </div>
        ) : (
          filteredFields.map((field) => (
            <FieldItem
              key={field.index}
              field={field}
              isChecked={usedFields.has(field.index)}
              onToggle={onFieldToggle}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
            />
          ))
        )}
      </div>
    </div>
  );
}
