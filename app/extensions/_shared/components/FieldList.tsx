//! FILENAME: app/extensions/_shared/components/FieldList.tsx
import React, { useState, useMemo } from 'react';
import { css } from '@emotion/css';
import { styles } from './EditorStyles';
import { FieldItem } from './FieldItem';
import type { SourceField, DragField } from './types';
import { TOKENS } from '../lib/themeTokens';

// Search input styles. Tokens only (see EditorStyles.ts for the Primer
// literal -> token mapping); the light look is essentially unchanged.
const searchStyles = {
  container: css`
    padding: 6px 8px;
    border-bottom: 1px solid ${TOKENS.controlDivider};
    background: ${TOKENS.panelBg};
  `,
  input: css`
    width: 100%;
    padding: 5px 8px;
    border: 1px solid ${TOKENS.controlBorder};
    border-radius: 6px;
    font-size: 12px;
    font-family: inherit;
    outline: none;
    background: ${TOKENS.surfaceBg};
    color: ${TOKENS.textPrimary};
    transition: border-color 0.15s, box-shadow 0.15s;
    box-sizing: border-box;

    &:focus {
      border-color: ${TOKENS.accent};
      box-shadow: 0 0 0 2px color-mix(in srgb, ${TOKENS.accent} 15%, transparent);
    }

    &::placeholder {
      color: ${TOKENS.textTertiary};
    }
  `,
  noResults: css`
    padding: 12px;
    text-align: center;
    color: ${TOKENS.textSecondary};
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
    <div className={styles.section} style={{ flex: 1, overflow: 'hidden' }}>
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
