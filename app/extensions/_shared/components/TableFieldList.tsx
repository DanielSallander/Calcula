//! FILENAME: app/extensions/_shared/components/TableFieldList.tsx
// PURPOSE: Hierarchical field list for BI pivots — tables as folders, measures folder.
// CONTEXT: Replaces FieldList when a BI model is present.

import React, { useState, useMemo, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { css } from '@emotion/css';
import { styles } from './EditorStyles';
import { useDraggable } from './useDragDrop';
import type { DragField, MeasureField } from './types';

// --- Types ---

export interface BiModelColumn {
  name: string;
  dataType: string;
  isNumeric: boolean;
  /** Custom lookup resolution expression (e.g., "MAX(category_name)"). */
  lookupResolution?: string;
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
  /** Set of "TableName.ColumnName" keys for columns marked as LOOKUP */
  lookupColumns?: Set<string>;
  onColumnToggle: (table: string, column: string, isNumeric: boolean, checked: boolean) => void;
  onMeasureToggle: (measure: MeasureField, checked: boolean) => void;
  /** Called when user toggles a column between GROUP and LOOKUP mode */
  onLookupToggle?: (table: string, column: string) => void;
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
  lookupBadge: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 16px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 700;
    cursor: pointer;
    user-select: none;
    flex-shrink: 0;
    transition: background 0.12s, color 0.12s;
  `,
  lookupBadgeGroup: css`
    background: #ddf4ff;
    color: #0969da;
    &:hover { background: #b6e3ff; }
  `,
  lookupBadgeLookup: css`
    background: #fff8c5;
    color: #9a6700;
    &:hover { background: #fae17d; }
  `,
};

const folderMenuStyles = {
  container: css`
    position: fixed;
    background: #fff;
    border: 1px solid #d0d7de;
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(140, 149, 159, 0.2);
    z-index: 10000;
    min-width: 150px;
    padding: 4px 0;
    font-family: 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif;
    font-size: 12px;
  `,
  item: css`
    display: block;
    width: 100%;
    padding: 6px 12px;
    text-align: left;
    background: none;
    border: none;
    cursor: pointer;
    color: #24292f;
    font-size: 12px;
    font-family: inherit;
    transition: background 0.08s;

    &:hover {
      background: #f6f8fa;
    }
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
  isLookup,
  lookupResolution,
  onToggle,
  onLookupToggle,
}: {
  fieldKey: string;
  name: string;
  isNumeric: boolean;
  isChecked: boolean;
  isMeasure: boolean;
  isLookup?: boolean;
  lookupResolution?: string;
  onToggle: (checked: boolean) => void;
  onLookupToggle?: () => void;
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

  const handleLookupClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (onLookupToggle) onLookupToggle();
    },
    [onLookupToggle]
  );

  // Build tooltip for lookup badge
  const lookupTooltip = isLookup
    ? `Lookup${lookupResolution ? ` (${lookupResolution})` : ' (MIN)'} — click to set as Group`
    : 'Group — click to set as Lookup';

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
      {/* G/L toggle badge — only for dimension columns, not measures */}
      {!isMeasure && onLookupToggle && (
        <span
          className={`${treeStyles.lookupBadge} ${
            isLookup ? treeStyles.lookupBadgeLookup : treeStyles.lookupBadgeGroup
          }`}
          title={lookupTooltip}
          onClick={handleLookupClick}
        >
          {isLookup ? 'L' : 'G'}
        </span>
      )}
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
  onExpandAll,
  onCollapseAll,
  children,
}: {
  name: string;
  icon: string;
  childCount: number;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  children: React.ReactNode;
}) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  return (
    <div>
      <div
        className={treeStyles.folderHeader}
        onClick={onToggleExpand}
        onContextMenu={handleContextMenu}
      >
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
      {contextMenu && (
        <FolderContextMenu
          position={contextMenu}
          onExpandAll={() => { onExpandAll(); setContextMenu(null); }}
          onCollapseAll={() => { onCollapseAll(); setContextMenu(null); }}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

/** Context menu for folder nodes (Expand All / Collapse All). */
function FolderContextMenu({
  position,
  onExpandAll,
  onCollapseAll,
  onClose,
}: {
  position: { x: number; y: number };
  onExpandAll: () => void;
  onCollapseAll: () => void;
  onClose: () => void;
}) {
  const menuRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    const timeoutId = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleKeyDown);
    }, 0);
    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  const adjustedX = Math.min(position.x, window.innerWidth - 180);
  const adjustedY = Math.min(position.y, window.innerHeight - 80);

  return ReactDOM.createPortal(
    <div
      ref={menuRef}
      className={folderMenuStyles.container}
      style={{ left: adjustedX, top: adjustedY }}
    >
      <button className={folderMenuStyles.item} onClick={onExpandAll}>
        Expand All
      </button>
      <button className={folderMenuStyles.item} onClick={onCollapseAll}>
        Collapse All
      </button>
    </div>,
    document.body
  );
}

// --- Main Component ---

export function TableFieldList({
  biModel,
  usedColumns,
  usedMeasures,
  lookupColumns,
  onColumnToggle,
  onMeasureToggle,
  onLookupToggle,
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

  const expandAll = useCallback(() => {
    const set = new Set<string>();
    set.add('__measures__');
    for (const t of biModel.tables) {
      set.add(t.name);
    }
    setExpandedFolders(set);
  }, [biModel.tables]);

  const collapseAll = useCallback(() => {
    setExpandedFolders(new Set<string>());
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
                onExpandAll={expandAll}
                onCollapseAll={collapseAll}
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
                onExpandAll={expandAll}
                onCollapseAll={collapseAll}
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
                      isLookup={lookupColumns?.has(colKey)}
                      lookupResolution={col.lookupResolution}
                      onToggle={(checked) =>
                        onColumnToggle(table.name, col.name, col.isNumeric, checked)
                      }
                      onLookupToggle={
                        onLookupToggle
                          ? () => onLookupToggle(table.name, col.name)
                          : undefined
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
