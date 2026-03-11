//! FILENAME: app/extensions/_shared/components/TableFieldList.tsx
// PURPOSE: Hierarchical field list for BI pivots — tables as folders, measures folder.
// CONTEXT: Replaces FieldList when a BI model is present.

import React, { useState, useMemo, useCallback } from 'react';
import { css } from '@emotion/css';
import { styles } from './EditorStyles';
import { useDraggable } from './useDragDrop';
import type { DragField, MeasureField } from './types';

// --- Types ---

export interface BiModelColumn {
  name: string;
  dataType: string;
  isNumeric: boolean;
}

export interface BiModelTable {
  name: string;
  columns: BiModelColumn[];
}

export interface BiPivotModelInfo {
  tables: BiModelTable[];
  measures: MeasureField[];
}

interface TableFieldListProps {
  biModel: BiPivotModelInfo;
  usedColumns: Set<string>;    // "TableName.ColumnName" keys
  usedMeasures: Set<string>;   // Measure names
  onColumnToggle: (table: string, column: string, isNumeric: boolean, checked: boolean) => void;
  onMeasureToggle: (measure: MeasureField, checked: boolean) => void;
  onDragStart?: (field: DragField) => void;
  onDragEnd?: () => void;
}

// --- Styles ---

const treeStyles = {
  searchContainer: css`
    padding: 6px 8px;
    border-bottom: 1px solid #eaeef2;
    background: #f6f8fa;
  `,
  searchInput: css`
    width: 100%;
    padding: 5px 8px;
    border: 1px solid #d0d7de;
    border-radius: 6px;
    font-size: 12px;
    font-family: inherit;
    outline: none;
    background: #fff;
    transition: border-color 0.15s, box-shadow 0.15s;
    box-sizing: border-box;
    &:focus {
      border-color: #0969da;
      box-shadow: 0 0 0 2px rgba(9, 105, 218, 0.15);
    }
    &::placeholder { color: #8b949e; }
  `,
  noResults: css`
    padding: 12px;
    text-align: center;
    color: #656d76;
    font-size: 11px;
    font-style: italic;
  `,
  folderHeader: css`
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 5px 8px;
    cursor: pointer;
    user-select: none;
    font-weight: 600;
    font-size: 12px;
    color: #24292f;
    border-radius: 4px;
    transition: background 0.1s;
    &:hover { background: #f6f8fa; }
  `,
  folderArrow: css`
    font-size: 10px;
    width: 14px;
    text-align: center;
    color: #656d76;
    transition: transform 0.15s;
  `,
  folderArrowCollapsed: css`
    transform: rotate(-90deg);
  `,
  folderIcon: css`
    font-size: 13px;
    width: 18px;
    text-align: center;
  `,
  folderName: css`
    flex: 1;
  `,
  folderCount: css`
    font-size: 10px;
    color: #8b949e;
    font-weight: 400;
  `,
  folderChildren: css`
    padding-left: 14px;
  `,
  fieldItem: css`
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 8px 3px 12px;
    cursor: grab;
    user-select: none;
    border-radius: 4px;
    font-size: 12px;
    transition: background 0.1s;
    &:hover { background: #f6f8fa; }
    &.dragging { opacity: 0.4; }
  `,
  fieldCheckbox: css`
    width: 14px;
    height: 14px;
    cursor: pointer;
    accent-color: #0969da;
  `,
  fieldName: css`
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #24292f;
  `,
  fieldTypeIcon: css`
    font-size: 10px;
    color: #8b949e;
    min-width: 16px;
    text-align: center;
  `,
};

// --- Sub-components ---

/** A single field item (column or measure) with checkbox and drag support. */
function TreeFieldItem({
  fieldKey,
  name,
  isNumeric,
  isChecked,
  isMeasure,
  onToggle,
}: {
  fieldKey: string;
  name: string;
  isNumeric: boolean;
  isChecked: boolean;
  isMeasure: boolean;
  onToggle: (checked: boolean) => void;
}) {
  const dragData: DragField = useMemo(
    () => ({
      sourceIndex: -1, // Not used for BI fields — name-based references
      name: fieldKey,
      isNumeric,
    }),
    [fieldKey, isNumeric]
  );

  const { isDragging, dragHandleProps } = useDraggable(dragData, name);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => onToggle(e.target.checked),
    [onToggle]
  );

  return (
    <div
      {...dragHandleProps}
      className={`${treeStyles.fieldItem} ${isDragging ? 'dragging' : ''}`}
    >
      <input
        type="checkbox"
        className={treeStyles.fieldCheckbox}
        checked={isChecked}
        onChange={handleChange}
      />
      <span className={treeStyles.fieldName}>{name}</span>
      <span className={treeStyles.fieldTypeIcon}>
        {isMeasure ? '\u03A3' : isNumeric ? '#' : 'Aa'}
      </span>
    </div>
  );
}

/** A collapsible folder node (table or measures). */
function FolderNode({
  name,
  icon,
  childCount,
  isExpanded,
  onToggleExpand,
  children,
}: {
  name: string;
  icon: string;
  childCount: number;
  isExpanded: boolean;
  onToggleExpand: () => void;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className={treeStyles.folderHeader} onClick={onToggleExpand}>
        <span
          className={`${treeStyles.folderArrow} ${!isExpanded ? treeStyles.folderArrowCollapsed : ''}`}
        >
          &#9660;
        </span>
        <span className={treeStyles.folderIcon}>{icon}</span>
        <span className={treeStyles.folderName}>{name}</span>
        <span className={treeStyles.folderCount}>{childCount}</span>
      </div>
      {isExpanded && (
        <div className={treeStyles.folderChildren}>{children}</div>
      )}
    </div>
  );
}

// --- Main Component ---

export function TableFieldList({
  biModel,
  usedColumns,
  usedMeasures,
  onColumnToggle,
  onMeasureToggle,
}: TableFieldListProps): React.ReactElement {
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => {
    // Start with all folders expanded
    const set = new Set<string>();
    set.add('__measures__');
    for (const t of biModel.tables) {
      set.add(t.name);
    }
    return set;
  });

  const toggleFolder = useCallback((folderKey: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderKey)) {
        next.delete(folderKey);
      } else {
        next.add(folderKey);
      }
      return next;
    });
  }, []);

  const query = searchQuery.toLowerCase().trim();

  // Filter measures by search
  const filteredMeasures = useMemo(() => {
    if (!query) return biModel.measures;
    return biModel.measures.filter((m) => m.name.toLowerCase().includes(query));
  }, [biModel.measures, query]);

  // Filter tables/columns by search — auto-expand matching tables
  const filteredTables = useMemo(() => {
    if (!query) return biModel.tables;
    return biModel.tables
      .map((t) => ({
        ...t,
        columns: t.columns.filter(
          (c) =>
            c.name.toLowerCase().includes(query) ||
            t.name.toLowerCase().includes(query)
        ),
      }))
      .filter((t) => t.columns.length > 0);
  }, [biModel.tables, query]);

  const hasResults = filteredMeasures.length > 0 || filteredTables.some((t) => t.columns.length > 0);

  return (
    <div className={styles.section}>
      <div className={styles.sectionTitle}>Choose fields to add to report</div>
      <div className={styles.fieldList}>
        {/* Search input */}
        <div className={treeStyles.searchContainer}>
          <input
            type="text"
            className={treeStyles.searchInput}
            placeholder="Search fields..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        {!hasResults ? (
          <div className={treeStyles.noResults}>
            No fields match "{searchQuery}"
          </div>
        ) : (
          <>
            {/* Measures folder */}
            {filteredMeasures.length > 0 && (
              <FolderNode
                name="Measures"
                icon={'\u03A3'}
                childCount={filteredMeasures.length}
                isExpanded={!!query || expandedFolders.has('__measures__')}
                onToggleExpand={() => toggleFolder('__measures__')}
              >
                {filteredMeasures.map((m) => (
                  <TreeFieldItem
                    key={`measure:${m.name}`}
                    fieldKey={`[${m.name}]`}
                    name={m.name}
                    isNumeric={true}
                    isChecked={usedMeasures.has(m.name)}
                    isMeasure={true}
                    onToggle={(checked) => onMeasureToggle(m, checked)}
                  />
                ))}
              </FolderNode>
            )}

            {/* Table folders */}
            {filteredTables.map((table) => (
              <FolderNode
                key={`table:${table.name}`}
                name={table.name}
                icon={'\uD83D\uDCC1'}
                childCount={table.columns.length}
                isExpanded={!!query || expandedFolders.has(table.name)}
                onToggleExpand={() => toggleFolder(table.name)}
              >
                {table.columns.map((col) => {
                  const colKey = `${table.name}.${col.name}`;
                  return (
                    <TreeFieldItem
                      key={colKey}
                      fieldKey={colKey}
                      name={col.name}
                      isNumeric={col.isNumeric}
                      isChecked={usedColumns.has(colKey)}
                      isMeasure={false}
                      onToggle={(checked) =>
                        onColumnToggle(table.name, col.name, col.isNumeric, checked)
                      }
                    />
                  );
                })}
              </FolderNode>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
