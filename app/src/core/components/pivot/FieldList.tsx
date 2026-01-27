//! FILENAME: app/src/core/components/pivot/FieldList.tsx
import React, { useMemo } from 'react';
import { styles } from './PivotEditor.styles';
import { FieldItem } from './FieldItem';
import type { SourceField, DragField, ZoneField } from './types';

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
  return (
    <div className={styles.section}>
      <div className={styles.sectionTitle}>Choose fields to add to report</div>
      <div className={styles.fieldList}>
        {fields.map((field) => (
          <FieldItem
            key={field.index}
            field={field}
            isChecked={usedFields.has(field.index)}
            onToggle={onFieldToggle}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
          />
        ))}
      </div>
    </div>
  );
}