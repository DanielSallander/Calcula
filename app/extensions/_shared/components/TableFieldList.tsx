//! FILENAME: app/extensions/_shared/components/TableFieldList.tsx
// PURPOSE: Hierarchical field list for BI pivots — tables as folders, measures folder.
// CONTEXT: Replaces FieldList when a BI model is present.

import React, { useState, useMemo, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { css } from '@emotion/css';
import { styles } from './EditorStyles';
import { useDraggable } from './useDragDrop';
import type { DragField, MeasureField } from './types';
import { applyPerspective, type BiPerspectiveInfo } from './perspectiveFilter';
import { resolveCulture, buildCultureLookup, type BiCultureInfo } from './cultureLookup';

// --- Types ---

export interface BiModelColumn {
  name: string;
  dataType: string;
  isNumeric: boolean;
  /** Custom lookup resolution expression (e.g., "MAX(category_name)"). */
  lookupResolution?: string;
  /** Sort-by column name: sort this column's pivot items by another column's values. */
  sortByColumn?: string;
  /** True for a Studio-authored CONTEXT column (dynamic segmentation). Not a
   *  physical column, but groupable like an ordinary dimension. */
  isContextColumn?: boolean;
  /** True for a WRITEBACK column: end users type its values in pivot cells
   *  when it is placed as a lookup on leaf rows. */
  isWritebackColumn?: boolean;
  /** Model-authored description (shown as a field-list tooltip). */
  description?: string;
}

export interface BiModelTable {
  name: string;
  columns: BiModelColumn[];
}

export interface BiHierarchyLevel {
  column: string;
  displayName?: string;
  optional?: boolean;
}

export interface BiHierarchyMeta {
  name: string;
  table: string;
  levels: BiHierarchyLevel[];
  raggedBehavior?: 'ShowBlanks' | 'HideMembers' | 'RepeatParent' | 'ShowAsLeaf';
}

export interface BiCalcGroupItem {
  name: string;
  /** Source text of the item's template expression (display/diagnostic). */
  source?: string;
}

export interface BiCalcGroup {
  name: string;
  items: BiCalcGroupItem[];
}

export interface BiPivotModelInfo {
  tables: BiModelTable[];
  measures: MeasureField[];
  hierarchies?: BiHierarchyMeta[];
  /** Calculation groups defined in the BI model. Items are measure templates
   *  applied on the Values axis, not groupable dimensions. Read-only in v1. */
  calculationGroups?: BiCalcGroup[];
  /** Perspectives defined in the BI model (display subsets for this list). */
  perspectives?: BiPerspectiveInfo[];
}

interface TableFieldListProps {
  biModel: BiPivotModelInfo;
  usedColumns: Set<string>;    // "TableName.ColumnName" keys
  usedMeasures: Set<string>;   // Measure names
  /** Set of "Table.HierarchyName" keys for hierarchies currently placed in a zone */
  usedHierarchies?: Set<string>;
  /** Set of "TableName.ColumnName" keys for columns marked as LOOKUP */
  lookupColumns?: Set<string>;
  onColumnToggle: (table: string, column: string, isNumeric: boolean, checked: boolean) => void;
  onMeasureToggle: (measure: MeasureField, checked: boolean) => void;
  /** Called when user toggles a hierarchy in/out of the row axis */
  onHierarchyToggle?: (table: string, hierarchyName: string, checked: boolean) => void;
  /** Called when user toggles a column between GROUP and LOOKUP mode */
  onLookupToggle?: (table: string, column: string) => void;
  /** The calculation group currently applied (null = none). `items: []` means
   *  ALL items. Enables the Power BI-style checkboxes on calculation-group
   *  nodes; when the callbacks below are absent, groups render read-only. */
  appliedCalcGroup?: { group: string; items: string[] } | null;
  /** Check/uncheck a whole calculation group (checked = apply, all items). */
  onCalcGroupToggle?: (group: BiCalcGroup, checked: boolean) => void;
  /** Toggle a single calculation item of a group. */
  onCalcItemToggle?: (group: BiCalcGroup, itemName: string, checked: boolean) => void;
  /** When set, calc-group checkboxes on NON-applied groups are disabled and
   *  this text explains why (e.g. the lookup-column conflict). */
  calcGroupsDisabledReason?: string | null;
  onDragStart?: (field: DragField) => void;
  onDragEnd?: () => void;
  /** The perspective currently filtering the list (null = all fields). */
  selectedPerspective?: string | null;
  /** Called when the user picks a perspective (null = "(All fields)"). */
  onPerspectiveChange?: (name: string | null) => void;
  /** Cultures defined in the BI model (per-locale metadata translations).
   *  Display-only: labels/tooltips swap; every key stays the raw name. */
  cultures?: BiCultureInfo[];
  /** The active UI locale the culture is resolved against (null = raw names). */
  locale?: string | null;
}

// --- Styles ---

const treeStyles = {
  searchContainer: css`
    padding: 6px 8px;
    border-bottom: 1px solid #eaeef2;
    background: #f6f8fa;
  `,
  perspectiveSelect: css`
    width: 100%;
    padding: 4px 6px;
    margin-bottom: 6px;
    border: 1px solid #d0d7de;
    border-radius: 6px;
    font-size: 12px;
    font-family: inherit;
    outline: none;
    background: #fff;
    color: #24292f;
    cursor: pointer;
    &:focus {
      border-color: #0969da;
      box-shadow: 0 0 0 2px rgba(9, 105, 218, 0.15);
    }
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
  contextBadge: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 16px;
    padding: 0 5px;
    border-radius: 3px;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.3px;
    background: #e7defc;
    color: #6639ba;
    user-select: none;
    flex-shrink: 0;
  `,
  writebackBadge: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 16px;
    padding: 0 5px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 700;
    background: #dafbe1;
    color: #1a7f37;
    user-select: none;
    flex-shrink: 0;
  `,
  hierarchyItem: css`
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 8px 3px 12px;
    cursor: grab;
    user-select: none;
    border-radius: 4px;
    font-size: 12px;
    transition: background 0.1s;
    &:hover { background: #f0f7ff; }
    &.dragging { opacity: 0.4; }
  `,
  hierarchyIcon: css`
    font-size: 11px;
    color: #0969da;
    min-width: 16px;
    text-align: center;
  `,
  hierarchyLevelList: css`
    padding-left: 20px;
    font-size: 11px;
    color: #656d76;
  `,
  hierarchyLevel: css`
    padding: 1px 0;
    display: flex;
    align-items: center;
    gap: 4px;
  `,
  hierarchyLevelDot: css`
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: #8b949e;
    flex-shrink: 0;
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
  isContextColumn,
  isWritebackColumn,
  description,
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
  isContextColumn?: boolean;
  isWritebackColumn?: boolean;
  description?: string;
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
      <span className={treeStyles.fieldName} title={description || undefined}>{name}</span>
      {/* Context-column badge — Studio-authored dynamic segmentation */}
      {isContextColumn && (
        <span
          className={treeStyles.contextBadge}
          title="Context column — dynamic segmentation computed by the model"
        >
          CTX
        </span>
      )}
      {/* Writeback-column badge — user-entered values */}
      {isWritebackColumn && (
        <span
          className={treeStyles.writebackBadge}
          title="Writeback column — users can type values when placed as a lookup on leaf rows"
        >
          {'✎'}
        </span>
      )}
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

/** A hierarchy item with checkbox, tree icon, and expandable level list. */
function HierarchyFieldItem({
  hierarchy,
  isChecked,
  onToggle,
}: {
  hierarchy: BiHierarchyMeta;
  isChecked: boolean;
  onToggle: (checked: boolean) => void;
}) {
  const [showLevels, setShowLevels] = useState(false);

  const fieldKey = `${hierarchy.table}.__hierarchy__.${hierarchy.name}`;
  const dragData: DragField = useMemo(
    () => ({
      sourceIndex: -3, // Special marker for hierarchy fields
      name: fieldKey,
      isNumeric: false,
    }),
    [fieldKey]
  );

  const { isDragging, dragHandleProps } = useDraggable(dragData, hierarchy.name);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => onToggle(e.target.checked),
    [onToggle]
  );

  const handleNameClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowLevels((prev) => !prev);
  }, []);

  return (
    <div>
      <div
        {...dragHandleProps}
        className={`${treeStyles.hierarchyItem} ${isDragging ? 'dragging' : ''}`}
      >
        <input
          type="checkbox"
          className={treeStyles.fieldCheckbox}
          checked={isChecked}
          onChange={handleChange}
        />
        <span
          className={treeStyles.fieldName}
          onClick={handleNameClick}
          title={`Hierarchy: ${hierarchy.levels.map(l => l.displayName || l.column).join(' > ')}`}
        >
          {hierarchy.name}
        </span>
        <span className={treeStyles.hierarchyIcon} title="Hierarchy (drill-down path)">
          {'\u2261'}
        </span>
      </div>
      {showLevels && (
        <div className={treeStyles.hierarchyLevelList}>
          {hierarchy.levels.map((level, i) => (
            <div key={i} className={treeStyles.hierarchyLevel}>
              <span className={treeStyles.hierarchyLevelDot} />
              <span>{level.displayName || level.column}</span>
              {level.optional && <span style={{ opacity: 0.6 }}>(optional)</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** "Group of items" glyph (2x2 tile grid) for calculation groups — mirrors the
 *  Model Editor's calc-group tree icon so the object reads the same everywhere. */
function CalcGroupGlyph(): React.ReactElement {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 16 16"
      fill="none"
      style={{ display: 'inline-block', verticalAlign: '-2px' }}
      aria-hidden
    >
      <rect x="2" y="2" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.3" />
      <rect x="9" y="2" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.3" />
      <rect x="2" y="9" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.3" />
      <rect x="9" y="9" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

/** A checkbox that can render the indeterminate (tri-state) look — used on a
 *  calculation-group header when only a subset of its items is applied. */
function TriStateCheckbox({
  checked,
  indeterminate,
  disabled,
  title,
  onChange,
}: {
  checked: boolean;
  indeterminate: boolean;
  disabled?: boolean;
  title?: string;
  onChange: (checked: boolean) => void;
}) {
  const ref = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className={treeStyles.fieldCheckbox}
      checked={checked}
      disabled={disabled}
      title={title}
      onChange={(e) => onChange(e.target.checked)}
    />
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
  headerCheckbox,
  dragData,
  children,
}: {
  name: string;
  icon: React.ReactNode;
  childCount: number;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  /** Optional checkbox rendered in the header (calculation groups). Clicks on
   *  it must not toggle expansion. */
  headerCheckbox?: React.ReactNode;
  /** When set, the header row is draggable into the drop zones with this
   *  payload (calculation groups — the whole node IS the field). */
  dragData?: DragField;
  children: React.ReactNode;
}) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  // The hook must run unconditionally — fall back to inert data when the
  // folder isn't draggable; the handlers only attach when dragData is set.
  // Memoized by value so re-renders during a drag keep the same identity
  // (the drag state matches its payload by reference).
  const effectiveDrag = useMemo<DragField>(
    () => dragData ?? { sourceIndex: -999, name, isNumeric: false },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dragData?.sourceIndex, dragData?.name, dragData?.isNumeric, name],
  );
  const { isDragging, dragHandleProps } = useDraggable(effectiveDrag, name);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  return (
    <div>
      <div
        className={treeStyles.folderHeader}
        {...(dragData ? dragHandleProps : {})}
        style={{
          ...(dragData ? dragHandleProps.style : undefined),
          ...(dragData && isDragging ? { opacity: 0.4 } : undefined),
        }}
        onClick={onToggleExpand}
        onContextMenu={handleContextMenu}
      >
        <span
          className={`${treeStyles.folderArrow} ${!isExpanded ? treeStyles.folderArrowCollapsed : ''}`}
        >
          &#9660;
        </span>
        {headerCheckbox && (
          <span
            style={{ display: 'flex', alignItems: 'center' }}
            onClick={(e) => e.stopPropagation()}
          >
            {headerCheckbox}
          </span>
        )}
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
  usedHierarchies,
  lookupColumns,
  onColumnToggle,
  onMeasureToggle,
  onHierarchyToggle,
  onLookupToggle,
  appliedCalcGroup,
  onCalcGroupToggle,
  onCalcItemToggle,
  calcGroupsDisabledReason,
  selectedPerspective,
  onPerspectiveChange,
  cultures,
  locale,
}: TableFieldListProps): React.ReactElement {
  const [searchQuery, setSearchQuery] = useState('');

  // Perspective display filter: a selected perspective narrows the tables /
  // columns / measures / hierarchies this list SHOWS (never the query).
  const perspectiveModel = useMemo(
    () => applyPerspective(biModel, biModel.perspectives, selectedPerspective),
    [biModel, selectedPerspective],
  );

  // Culture display translation: swap table/column/measure LABELS (and column
  // description tooltips) for the active locale. Display-only — expand keys,
  // colKeys, fieldKeys, drag names, and toggle callbacks all stay RAW.
  const cultureLookup = useMemo(
    () => buildCultureLookup(resolveCulture(cultures, locale)),
    [cultures, locale],
  );
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => {
    // Start with all folders expanded
    const set = new Set<string>();
    set.add('__measures__');
    for (const t of biModel.tables) {
      set.add(t.name);
    }
    for (const g of biModel.calculationGroups ?? []) {
      set.add(`__calcgroup__:${g.name}`);
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
    for (const g of biModel.calculationGroups ?? []) {
      set.add(`__calcgroup__:${g.name}`);
    }
    setExpandedFolders(set);
  }, [biModel.tables, biModel.calculationGroups]);

  const collapseAll = useCallback(() => {
    setExpandedFolders(new Set<string>());
  }, []);

  const query = searchQuery.toLowerCase().trim();

  // Search matches the RAW name and, when a culture is active, the translated
  // display name (users see the translation, so it must be searchable too).
  const matchesQuery = useCallback(
    (raw: string, translated: string | null) =>
      raw.toLowerCase().includes(query) ||
      (translated !== null && translated.toLowerCase().includes(query)),
    [query],
  );

  // Filter measures by search
  const filteredMeasures = useMemo(() => {
    if (!query) return perspectiveModel.measures;
    return perspectiveModel.measures.filter((m) =>
      matchesQuery(m.name, cultureLookup.measure(m.name)),
    );
  }, [perspectiveModel.measures, query, matchesQuery, cultureLookup]);

  // Filter tables/columns by search — auto-expand matching tables
  const filteredTables = useMemo(() => {
    if (!query) return perspectiveModel.tables;
    return perspectiveModel.tables
      .map((t) => ({
        ...t,
        columns: t.columns.filter(
          (c) =>
            matchesQuery(c.name, cultureLookup.column(t.name, c.name)) ||
            matchesQuery(t.name, cultureLookup.table(t.name))
        ),
      }))
      .filter((t) => t.columns.length > 0);
  }, [perspectiveModel.tables, query, matchesQuery, cultureLookup]);

  // Filter hierarchies by search and group by table
  const hierarchiesByTable = useMemo(() => {
    const map = new Map<string, BiHierarchyMeta[]>();
    if (!perspectiveModel.hierarchies) return map;
    for (const h of perspectiveModel.hierarchies) {
      if (
        query &&
        !h.name.toLowerCase().includes(query) &&
        !matchesQuery(h.table, cultureLookup.table(h.table))
      ) {
        continue;
      }
      const existing = map.get(h.table) || [];
      existing.push(h);
      map.set(h.table, existing);
    }
    return map;
  }, [perspectiveModel.hierarchies, query, matchesQuery, cultureLookup]);

  // Filter calculation groups + items by search
  const filteredCalcGroups = useMemo(() => {
    const groups = biModel.calculationGroups ?? [];
    if (!query) return groups;
    return groups
      .map((g) => ({
        ...g,
        items: g.items.filter(
          (it) =>
            it.name.toLowerCase().includes(query) ||
            g.name.toLowerCase().includes(query)
        ),
      }))
      .filter((g) => g.items.length > 0);
  }, [biModel.calculationGroups, query]);

  const hasResults = filteredMeasures.length > 0 || filteredTables.some((t) => t.columns.length > 0) || hierarchiesByTable.size > 0 || filteredCalcGroups.length > 0;

  return (
    <div className={styles.section} style={{ flex: 1, overflow: 'hidden' }}>
      <div className={styles.sectionTitle}>Choose fields to add to report</div>
      <div className={styles.fieldList}>
        {/* Perspective picker + search input */}
        <div className={treeStyles.searchContainer}>
          {(biModel.perspectives?.length ?? 0) > 0 && onPerspectiveChange && (
            <select
              className={treeStyles.perspectiveSelect}
              value={selectedPerspective ?? ''}
              onChange={(e) => onPerspectiveChange(e.target.value || null)}
              title={
                'Perspective: show only a named subset of the model in this list. ' +
                'Display-only — fields already in the pivot are unaffected.'
              }
            >
              <option value="">(All fields)</option>
              {selectedPerspective &&
                !biModel.perspectives!.some((p) => p.name === selectedPerspective) && (
                  <option value={selectedPerspective} disabled>
                    {selectedPerspective} (no longer in the model)
                  </option>
                )}
              {biModel.perspectives!.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
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
                    name={cultureLookup.measure(m.name) ?? m.name}
                    isNumeric={true}
                    isChecked={usedMeasures.has(m.name)}
                    isMeasure={true}
                    onToggle={(checked) => onMeasureToggle(m, checked)}
                  />
                ))}
              </FolderNode>
            )}

            {/* Calculation groups — Power BI-style dimension fields. Checking
                the group places it as a zone chip (Rows by default; drag it to
                Columns or Filters): its items become the field's members and
                every measure is evaluated under the item governing each cell.
                Item checkboxes narrow the visible subset. */}
            {filteredCalcGroups.map((g) => {
              const interactive = !!onCalcGroupToggle;
              const isApplied = appliedCalcGroup?.group === g.name;
              const appliedAll = isApplied && appliedCalcGroup.items.length === 0;
              const isItemOn = (name: string) =>
                isApplied &&
                (appliedCalcGroup.items.length === 0 || appliedCalcGroup.items.includes(name));
              // A conflict (e.g. active lookup columns) disables applying; an
              // already-applied group stays enabled so it can be switched off.
              const disabled = !!calcGroupsDisabledReason && !isApplied;
              const groupTooltip = disabled
                ? calcGroupsDisabledReason!
                : 'Place this calculation group as a field (Rows by default — drag its ' +
                  'chip to Columns or Filters): each measure is shown once per ' +
                  'calculation item (e.g. Current, YTD, PY). Totals are off while placed.';
              return (
                <FolderNode
                  key={`calcgroup:${g.name}`}
                  name={g.name}
                  icon={<CalcGroupGlyph />}
                  childCount={g.items.length}
                  isExpanded={!!query || expandedFolders.has(`__calcgroup__:${g.name}`)}
                  onToggleExpand={() => toggleFolder(`__calcgroup__:${g.name}`)}
                  onExpandAll={expandAll}
                  onCollapseAll={collapseAll}
                  headerCheckbox={
                    interactive ? (
                      <TriStateCheckbox
                        checked={appliedAll}
                        indeterminate={isApplied && !appliedAll}
                        disabled={disabled}
                        title={groupTooltip}
                        onChange={(checked) => onCalcGroupToggle!(g, checked)}
                      />
                    ) : undefined
                  }
                  dragData={
                    interactive && !disabled
                      ? { sourceIndex: -1, name: g.name, isNumeric: false }
                      : undefined
                  }
                >
                  {g.items.map((it) => (
                    <div
                      key={`calcitem:${g.name}.${it.name}`}
                      className={treeStyles.fieldItem}
                      style={{ cursor: 'default' }}
                      title={it.source ? `${it.name} = ${it.source}` : it.name}
                    >
                      {interactive && onCalcItemToggle && (
                        <input
                          type="checkbox"
                          className={treeStyles.fieldCheckbox}
                          checked={isItemOn(it.name)}
                          disabled={disabled}
                          onChange={(e) => onCalcItemToggle(g, it.name, e.target.checked)}
                        />
                      )}
                      <span className={treeStyles.fieldName}>{it.name}</span>
                      <span className={treeStyles.fieldTypeIcon}>{'ƒ'}</span>
                    </div>
                  ))}
                  {isApplied && (
                    <div style={{ padding: '2px 8px 4px 12px', fontSize: '11px', color: '#6639ba' }}>
                      Placed as a field — totals off while placed
                    </div>
                  )}
                </FolderNode>
              );
            })}

            {/* Table folders */}
            {filteredTables.map((table) => {
              const tableHierarchies = hierarchiesByTable.get(table.name) || [];
              return (
                <FolderNode
                  key={`table:${table.name}`}
                  name={cultureLookup.table(table.name) ?? table.name}
                  icon={'\uD83D\uDCC1'}
                  childCount={table.columns.length + tableHierarchies.length}
                  isExpanded={!!query || expandedFolders.has(table.name)}
                  onToggleExpand={() => toggleFolder(table.name)}
                  onExpandAll={expandAll}
                  onCollapseAll={collapseAll}
                >
                  {/* Hierarchies shown first within the table */}
                  {tableHierarchies.map((h) => {
                    const hKey = `${h.table}.${h.name}`;
                    return (
                      <HierarchyFieldItem
                        key={`hierarchy:${hKey}`}
                        hierarchy={h}
                        isChecked={usedHierarchies?.has(hKey) ?? false}
                        onToggle={(checked) => {
                          if (onHierarchyToggle) onHierarchyToggle(h.table, h.name, checked);
                        }}
                      />
                    );
                  })}
                  {/* Individual columns */}
                  {table.columns.map((col) => {
                    const colKey = `${table.name}.${col.name}`;
                    return (
                      <TreeFieldItem
                        key={colKey}
                        fieldKey={colKey}
                        name={cultureLookup.column(table.name, col.name) ?? col.name}
                        isNumeric={col.isNumeric}
                        isChecked={usedColumns.has(colKey)}
                        isMeasure={false}
                        isLookup={lookupColumns?.has(colKey)}
                        lookupResolution={col.lookupResolution}
                        isContextColumn={col.isContextColumn}
                        isWritebackColumn={col.isWritebackColumn}
                        description={
                          cultureLookup.columnDescription(table.name, col.name) ?? col.description
                        }
                        onToggle={(checked) =>
                          onColumnToggle(table.name, col.name, col.isNumeric, checked)
                        }
                        onLookupToggle={
                          // Context columns are computed per query, not physical
                          // columns, so they can't be resolved as a LOOKUP — hide
                          // the G/L toggle for them.
                          onLookupToggle && !col.isContextColumn
                            ? () => onLookupToggle(table.name, col.name)
                            : undefined
                        }
                      />
                    );
                  })}
                </FolderNode>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
