//! FILENAME: app/extensions/pivot/components/CreatePivotDialog.tsx
// PURPOSE: Insert > PivotTable: pick the source and where the pivot goes.
// CONTEXT: Two modes.
//          - WORKSHEET mode (the classic dialog): a range or table source, and
//            a new or existing worksheet destination; afterwards the dialog
//            switches to the destination and navigates to the pivot.
//          - CANVAS mode, when an opener hands a `placement` (the Canvas tab's
//            Insert group) or the active sheet IS a canvas (Insert menu on a
//            canvas): the pivot is a real pivot written into the canvas's
//            hidden grid and shown inside a box (its frame). The destination
//            is fixed to "this canvas"; the source is a range WITH its
//            worksheet, a table, or a data model -- never guessed from the
//            canvas, which has no cells; the request carries `canvasFrame`,
//            an explicit non-canvas `sourceSheet` and the canvas as
//            `destinationSheet`; afterwards nothing navigates (the pivot is
//            already in view where it was inserted). The rules live in
//            ../lib/canvasPivotCreate.ts.

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useDialogWindow } from '@api/dialogWindow';
import { pivot } from '@api/pivot';
import {
  addSheet,
  getSheets,
  setActiveSheetApi,
  indexToCol,
  colToIndex,
  detectDataRegion,
  useGridState,
  getUsedRange,
  getCurrentRegion,
  getPivotStoreService,
} from '@api';
import { emitAppEvent, AppEvents } from '@api/events';
import { getTableByName, type ConnectionInfo } from '@api/backend';
import { getConnections } from '../../_shared/lib/bi-api';
import { getConnectionBiModel } from '../lib/pivot-api';
import {
  CANVAS_SOURCE_HINT,
  CANVAS_SOURCE_NO_DATA_NOTE,
  canvasFrameOf,
  defaultCanvasPivotPlacement,
  findDefaultCanvasSource,
  readCanvasPivotPlacement,
  resolveCanvasPivotSource,
  resolveWorksheetPivotDestination,
  resolveWorksheetPivotSource,
  sourceTextNamesTable,
  type CanvasPivotPlacement,
} from '../lib/canvasPivotCreate';

/** Excel-compatible grid limits (0-indexed max values). */
const MAX_ROW_INDEX = 1048576 - 1; // 1,048,575
const MAX_COL_INDEX = 16384 - 1;   // 16,383

// ============================================================================
// Types
// ============================================================================

export interface CreatePivotDialogProps {
  /** Whether the dialog is open */
  isOpen: boolean;
  /** Callback when dialog is closed */
  onClose: () => void;
  /** Callback when pivot table is created successfully */
  onCreated?: (pivotId: string) => void;
  /** Current selection from grid (0-indexed) */
  selection?: {
    startRow: number;
    startCol: number;
    endRow: number;
    endCol: number;
  } | null;
  /** Current active sheet index */
  activeSheetIndex?: number;
  /** Source table name (e.g. "Table1"). When set, the pivot source is linked
   *  to the table and auto-updates when the table expands. */
  tableName?: string;
  /** Canvas placement from the opener's dialog data, as handed over
   *  (`{ sheetIndex, x, y, width, height }`, logical page px). Validated here;
   *  a valid one puts the dialog in canvas mode with that frame. */
  placement?: unknown;
  /** The opener says the grid selection is NOT data (Insert > PivotTable
   *  while a selection owner -- a floating grid -- holds the selection, so
   *  Core's selection is a cell hidden under it): no data region is detected
   *  from it and the source starts EMPTY. A `tableName` still applies: it is
   *  the opener's explicit choice, not a guess from the selection. */
  suppressAutoRange?: boolean;
}

type DestinationType = 'new' | 'existing';

/** Where a canvas pivot's data comes from. */
type CanvasSourceKind = 'range' | 'model';

/** The message when the data-model source is chosen with nothing to choose. */
const NO_CONNECTION_MESSAGE = 'Please choose a data model connection.';

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Convert 0-indexed row/col to A1 notation (e.g., 0,0 -> A1)
 */
function toA1Notation(row: number, col: number): string {
  return `${indexToCol(col)}${row + 1}`;
}

/**
 * Convert selection to range string (e.g., A1:D100).
 * Detects full-column selections (row 0 to MAX_ROW_INDEX) and produces
 * column-only notation like "A:D" instead of "A1:D1048576".
 */
function selectionToRange(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number
): string {
  const minRow = Math.min(startRow, endRow);
  const maxRow = Math.max(startRow, endRow);
  const minCol = Math.min(startCol, endCol);
  const maxCol = Math.max(startCol, endCol);

  // Full-column selection: rows span the entire grid
  if (minRow === 0 && maxRow >= MAX_ROW_INDEX) {
    return `${indexToCol(minCol)}:${indexToCol(maxCol)}`;
  }

  // Full-row selection: cols span the entire grid
  if (minCol === 0 && maxCol >= MAX_COL_INDEX) {
    return `${minRow + 1}:${maxRow + 1}`;
  }

  return `${toA1Notation(minRow, minCol)}:${toA1Notation(maxRow, maxCol)}`;
}

/**
 * Build full range reference with sheet name (e.g., Sheet1!A1:D100)
 */
function buildSheetRange(sheetName: string, range: string): string {
  // If sheet name contains spaces or special chars, wrap in quotes
  if (/[^a-zA-Z0-9_]/.test(sheetName)) {
    return `'${sheetName}'!${range}`;
  }
  return `${sheetName}!${range}`;
}

/**
 * Parse a cell reference like "A1" or "Sheet1!G9" into { row, col } (0-indexed)
 * Returns null if parsing fails.
 */
function parseCellReference(cellRef: string): { row: number; col: number } | null {
  // Strip sheet prefix if present
  let ref = cellRef;
  const bangIndex = ref.lastIndexOf('!');
  if (bangIndex !== -1) {
    ref = ref.substring(bangIndex + 1);
  }
  
  // Remove any quotes, and the `$` of an absolute reference ($F$1)
  ref = ref.replace(/'/g, '').replace(/\$/g, '').trim().toUpperCase();
  
  // Match column letters and row number
  const match = ref.match(/^([A-Z]+)(\d+)$/);
  if (!match) {
    return null;
  }
  
  const colLetters = match[1];
  const rowNumber = parseInt(match[2], 10);
  
  if (isNaN(rowNumber) || rowNumber < 1) {
    return null;
  }
  
  const col = colToIndex(colLetters);
  const row = rowNumber - 1; // Convert to 0-indexed
  
  return { row, col };
}

/**
 * Generate a unique pivot table sheet name
 */
function generatePivotSheetName(existingSheets: { name: string }[]): string {
  const pivotSheetCount = existingSheets.filter(s => 
    s.name.toLowerCase().startsWith('pivottable')
  ).length;
  return `PivotTable${pivotSheetCount + 1}`;
}

// ============================================================================
// Component
// ============================================================================

export function CreatePivotDialog({
  isOpen,
  onClose,
  onCreated,
  selection,
  tableName,
  placement,
  suppressAutoRange = false,
}: CreatePivotDialogProps): React.ReactElement | null {
  // Read current grid selection (active cell) for auto-detection
  const gridState = useGridState();

  // Canvas mode: an opener-supplied placement, or a canvas as the active sheet
  // (the Insert menu opened on a canvas hands no placement; the frame is then
  // chosen here, centred in the view, through the layout surface).
  const canvasPlacement = readCanvasPivotPlacement(placement);
  const canvasMode = canvasPlacement !== null || gridState.surface === 'canvas';

  // Movable + resizable dialog window (shared @api hook)
  const win = useDialogWindow({ minWidth: 340, minHeight: 300 });

  // Form state
  const [pivotName, setPivotName] = useState('');
  const [sourceRange, setSourceRange] = useState('');
  const [destinationType, setDestinationType] = useState<DestinationType>('new');
  const [existingDestination, setExistingDestination] = useState('');
  const [newSheetName, setNewSheetName] = useState('');

  // UI state
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sheets, setSheets] = useState<{ index: number; name: string; kind?: string }[]>([]);
  const [currentSheetName, setCurrentSheetName] = useState('Sheet1');
  const [sourceSheetIndex, setSourceSheetIndex] = useState<number | undefined>(undefined);

  // Track if we've initialized the default sheet name for this dialog open
  const [hasInitializedSheetName, setHasInitializedSheetName] = useState(false);
  // Track if we've run auto-detection for this dialog open
  const [hasAutoDetected, setHasAutoDetected] = useState(false);

  // Cell picker mode: when true, dialog collapses so user can click a cell
  const [isPicking, setIsPicking] = useState(false);
  // Snapshot the selection at the moment picking started so we can detect changes
  const pickStartSelRef = useRef<{ endRow: number; endCol: number } | null>(null);

  // Canvas mode state: the source kind, the data-model connections, and the
  // note shown when no worksheet has data to default the source to.
  const [canvasSourceKind, setCanvasSourceKind] = useState<CanvasSourceKind>('range');
  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const [connectionId, setConnectionId] = useState('');
  const [canvasSourceNote, setCanvasSourceNote] = useState<string | null>(null);

  // Load sheets on mount and reset initialization flags
  useEffect(() => {
    if (isOpen) {
      setHasInitializedSheetName(false);
      setHasAutoDetected(false);
      setIsPicking(false);
      loadSheets();
      // Generate default pivot name based on existing pivot tables
      pivot.getAll().then((all) => {
        const count = all.length;
        setPivotName(`PivotTable${count + 1}`);
      }).catch(() => {
        setPivotName('PivotTable1');
      });
    } else {
      // Reset state when dialog closes
      setHasInitializedSheetName(false);
      setHasAutoDetected(false);
      setIsPicking(false);
    }
  }, [isOpen]);

  // Cell picker: detect when the user clicks a new cell while in picking mode
  useEffect(() => {
    if (!isPicking || !gridState.selection) return;

    const sel = gridState.selection;
    const start = pickStartSelRef.current;

    // Skip if selection hasn't actually changed from the picker start
    if (start && sel.endRow === start.endRow && sel.endCol === start.endCol) return;

    // Use the active sheet name from grid state
    const sheetName = gridState.sheetContext?.activeSheetName ?? currentSheetName;

    const cellRef = buildSheetRange(sheetName, toA1Notation(sel.endRow, sel.endCol));
    setExistingDestination(cellRef);
    setDestinationType('existing');
    setIsPicking(false);
  }, [isPicking, gridState.selection]);

  // Auto-detect the contiguous data region around the active cell. Never on a
  // canvas: it has no cells, so its "selection" is not data (the canvas
  // effect below chooses the default source instead). Never when the opener
  // says the selection is not data (`suppressAutoRange`).
  useEffect(() => {
    if (canvasMode) return;
    if (!isOpen || hasAutoDetected || !currentSheetName) return;

    // If a table name is provided, use it directly as the source reference
    if (tableName) {
      setHasAutoDetected(true);
      setSourceRange(tableName);
      return;
    }

    // The opener asked for no prefill: the source starts EMPTY -- including
    // over a range a previous open detected, which this state still holds.
    if (suppressAutoRange) {
      setHasAutoDetected(true);
      setSourceRange('');
      return;
    }

    // Use the prop selection or grid state selection for the active cell
    const sel = selection ?? gridState.selection;
    if (!sel) return;

    // The active cell is the end of the selection (where the cursor sits)
    const activeRow = sel.endRow;
    const activeCol = sel.endCol;

    setHasAutoDetected(true);

    detectDataRegion(activeRow, activeCol)
      .then((region) => {
        if (region) {
          const [startRow, startCol, endRow, endCol] = region;
          const range = selectionToRange(startRow, startCol, endRow, endCol);
          const fullRange = buildSheetRange(currentSheetName, range);
          setSourceRange(fullRange);
        } else if (sel) {
          // Fallback: use the current selection as-is
          const range = selectionToRange(
            sel.startRow,
            sel.startCol,
            sel.endRow,
            sel.endCol
          );
          const fullRange = buildSheetRange(currentSheetName, range);
          setSourceRange(fullRange);
        }
      })
      .catch((err) => {
        console.error('[CreatePivotDialog] Auto-detect failed, using selection:', err);
        if (sel) {
          const range = selectionToRange(
            sel.startRow,
            sel.startCol,
            sel.endRow,
            sel.endCol
          );
          const fullRange = buildSheetRange(currentSheetName, range);
          setSourceRange(fullRange);
        }
      });
  }, [canvasMode, isOpen, hasAutoDetected, currentSheetName, selection, tableName, suppressAutoRange, gridState.selection]);

  // Canvas mode, once per open: the default source (a table the opener named,
  // else the data on the first worksheet that has any, else a note saying
  // there is none), and the data-model connections for the model source.
  useEffect(() => {
    if (!isOpen || !canvasMode) return;
    let cancelled = false;
    setCanvasSourceKind('range');
    setCanvasSourceNote(null);
    setSourceRange(tableName ?? '');

    getConnections()
      .then((conns) => {
        if (cancelled) return;
        setConnections(conns);
        setConnectionId((prev) => (prev && conns.some((c) => c.id === prev) ? prev : (conns[0]?.id ?? '')));
      })
      .catch((err) => {
        console.warn('[CreatePivotDialog] Could not list data model connections:', err);
        if (!cancelled) setConnections([]);
      });

    if (!tableName) {
      getSheets()
        .then((result) => findDefaultCanvasSource(result.sheets, { getUsedRange, getCurrentRegion }))
        .then((found) => {
          if (cancelled) return;
          if (found) {
            // Never overwrite what the reader already typed.
            setSourceRange((prev) => (prev.trim() ? prev : found));
          } else {
            setCanvasSourceNote(CANVAS_SOURCE_NO_DATA_NOTE);
          }
        })
        .catch((err) => {
          console.warn('[CreatePivotDialog] Could not choose a default source:', err);
          if (!cancelled) setCanvasSourceNote(CANVAS_SOURCE_NO_DATA_NOTE);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [isOpen, canvasMode, tableName]);

  // Generate default new sheet name ONLY once when sheets are loaded
  useEffect(() => {
    if (isOpen && sheets.length > 0 && !hasInitializedSheetName) {
      const defaultName = generatePivotSheetName(sheets);
      console.log('[CreatePivotDialog] Setting default sheet name:', defaultName);
      setNewSheetName(defaultName);
      setHasInitializedSheetName(true);
    }
  }, [isOpen, sheets, hasInitializedSheetName]);

  const loadSheets = async () => {
    try {
      const result = await getSheets();
      setSheets(result.sheets);
      const activeSheet = result.sheets.find(s => s.index === result.activeIndex);
      if (activeSheet) {
        setCurrentSheetName(activeSheet.name);
        // Capture the source sheet index now, before addSheet potentially changes the active sheet
        setSourceSheetIndex(activeSheet.index);
      }
    } catch (err) {
      console.error('[CreatePivotDialog] Failed to load sheets:', err);
    }
  };

  const handleClose = useCallback(() => {
    setError(null);
    setIsLoading(false);
    setNewSheetName(''); // Reset for next open
    setPivotName(''); // Reset for next open
    onClose();
  }, [onClose]);

  // Canvas mode: the canvas the pivot goes on and its frame -- the opener's
  // placement, or a default centred in the current view.
  const zoom = gridState.zoom > 0 ? gridState.zoom : 1;
  const canvasTarget: CanvasPivotPlacement | null = !canvasMode
    ? null
    : canvasPlacement ??
      defaultCanvasPivotPlacement({
        sheetIndex: gridState.sheetContext?.activeSheetIndex ?? 0,
        scrollX: gridState.viewport?.scrollX ?? 0,
        scrollY: gridState.viewport?.scrollY ?? 0,
        viewWidth: Math.max(1, (gridState.viewportDimensions?.width ?? 0) / zoom),
        viewHeight: Math.max(1, (gridState.viewportDimensions?.height ?? 0) / zoom),
      });
  const canvasName =
    canvasTarget !== null
      ? (sheets.find((s) => s.index === canvasTarget.sheetIndex)?.name ?? currentSheetName)
      : '';

  const handleCreateOnCanvas = async (target: CanvasPivotPlacement) => {
    setError(null);
    setIsLoading(true);

    try {
      const canvasFrame = canvasFrameOf(target);
      const name = pivotName.trim() || undefined;

      if (canvasSourceKind === 'model') {
        if (!connectionId) {
          setError(NO_CONNECTION_MESSAGE);
          return;
        }
        const view = await pivot.createFromBiModel({
          destinationCell: 'A1',
          destinationSheet: target.sheetIndex,
          name,
          connectionId,
          canvasFrame,
        });
        handleClose();
        // The new pivot is in the canvas's hidden grid: re-read the regions so
        // its box paints where it was inserted.
        window.dispatchEvent(new Event('pivot:refresh'));
        // Open the field list on the model's fields (the BI flow's own path);
        // without them, the created-pivot handler finds the model itself.
        let biModel: Awaited<ReturnType<typeof getConnectionBiModel>> = null;
        try {
          biModel = await getConnectionBiModel(connectionId);
        } catch (err) {
          console.warn('[CreatePivotDialog] Could not read the model for the field list:', err);
        }
        const store = getPivotStoreService();
        if (biModel && store) {
          store.openBiPivotEditor(view.pivotId, biModel);
        } else if (onCreated) {
          onCreated(view.pivotId);
        }
        return;
      }

      // Resolve the source against the LIVE sheet list before anything is
      // sent: a canvas, an unknown sheet or a range without its sheet is a
      // sentence in the dialog, never a request the backend has to refuse.
      const { sheets: liveSheets } = await getSheets();
      const source = await resolveCanvasPivotSource(sourceRange, liveSheets, getTableByName);
      if (!source.ok) {
        setError(source.message);
        return;
      }

      // On a canvas the backend allocates the hidden-grid anchor itself;
      // `destinationCell` is only there because the wire requires a cell.
      const view = await pivot.create({
        sourceRange: source.sourceRange,
        destinationCell: 'A1',
        sourceSheet: source.sourceSheet,
        destinationSheet: target.sheetIndex,
        hasHeaders: true,
        name,
        sourceTableName: source.sourceTableName,
        canvasFrame,
      });

      if (onCreated) {
        onCreated(view.pivotId);
      }
      handleClose();

      // No sheet switch and no navigation: the pivot is on the canvas the
      // reader is looking at, inside the box they inserted, and scrolling to
      // its anchor would scroll the page towards the hidden grid block.
      window.dispatchEvent(new Event('pivot:refresh'));
    } catch (err) {
      console.error('[CreatePivotDialog] Error creating pivot table on the canvas:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreate = async () => {
    if (canvasTarget !== null) {
      await handleCreateOnCanvas(canvasTarget);
      return;
    }

    setError(null);
    setIsLoading(true);

    try {
      // Validate source range
      if (!sourceRange.trim()) {
        throw new Error('Please enter a source data range.');
      }
      // The source SHEET: a typed "Sheet2!A1:D9" names it (BUG-0149: the
      // sheet active when the dialog opened was sent, and the create door
      // strips the prefix, so the pivot summarised the wrong sheet). Refused
      // here, before a destination sheet is added.
      const source = resolveWorksheetPivotSource(sourceRange, sheets, sourceSheetIndex);
      if (!source.ok) {
        throw new Error(source.message);
      }

      let destinationCell: string;
      let destinationSheetIndex: number | undefined;
      let destinationSheetName: string | null = null;
      let destinationCoords: { row: number; col: number } = { row: 0, col: 0 };

      if (destinationType === 'new') {
        // Validate sheet name
        const sheetName = newSheetName.trim();
        if (!sheetName) {
          throw new Error('Please enter a name for the new worksheet.');
        }
        
        // Check for duplicate sheet names
        if (sheets.some(s => s.name.toLowerCase() === sheetName.toLowerCase())) {
          throw new Error(`A worksheet named "${sheetName}" already exists.`);
        }
        
        console.log('[CreatePivotDialog] Creating new sheet:', sheetName);
        
        const sheetsResult = await addSheet(sheetName);
        console.log('[CreatePivotDialog] Sheet created, result:', sheetsResult);
        
        // Find the newly created sheet
        const newSheet = sheetsResult.sheets.find(s => s.name === sheetName);
        if (!newSheet) {
          throw new Error('Failed to create new sheet.');
        }
        
        // Destination is A1 on the new sheet
        destinationCell = buildSheetRange(sheetName, 'A1');
        destinationSheetIndex = newSheet.index;  // <-- KEY FIX: Pass the sheet index!
        destinationSheetName = sheetName;
        destinationCoords = { row: 0, col: 0 };
        
        console.log('[CreatePivotDialog] New sheet index:', destinationSheetIndex);
      } else {
        // Use existing destination
        if (!existingDestination.trim()) {
          throw new Error('Please enter a destination cell.');
        }
        destinationCell = existingDestination.trim();
        // Its sheet, found ignoring case as the source's is. An exact-case
        // match that found nothing sent no sheet, and the create door then
        // used the active sheet: `sheet2!B3` (or a sheet that does not exist)
        // put the pivot on the sheet the dialog was opened from.
        const destination = resolveWorksheetPivotDestination(destinationCell, sheets);
        if (!destination.ok) {
          throw new Error(destination.message);
        }
        if (destination.sheet) {
          destinationSheetIndex = destination.sheet.index;
          destinationSheetName = destination.sheet.name;
        }
        
        // Parse the destination coordinates
        const parsed = parseCellReference(destinationCell);
        if (parsed) {
          destinationCoords = parsed;
        }
      }

      console.log('[CreatePivotDialog] Creating pivot table:', {
        sourceRange,
        destinationCell,
        destinationSheet: destinationSheetIndex,
      });

      // When sourced from a table, resolve the range from the table's current
      // coordinates but still send the cell range for initial cache build.
      // The sourceTableName links the pivot to the table for future refreshes.
      // Only while the text still names the table: retyped (`Sheet2!A1:D9`),
      // the text is the source and the pivot is not linked -- the table's
      // cells on this sheet with the typed sheet as `sourceSheet` named two
      // sources in one request.
      const linkedTable = sourceTextNamesTable(sourceRange, tableName) ? tableName : undefined;
      let resolvedSourceRange = source.sourceRange;
      if (linkedTable && selection) {
        // Build an A1 range from the table's coordinates so the backend can parse it
        const range = selectionToRange(
          selection.startRow,
          selection.startCol,
          selection.endRow,
          selection.endCol,
        );
        resolvedSourceRange = buildSheetRange(currentSheetName, range);
      }

      // Create the pivot table
      const view = await pivot.create({
        sourceRange: resolvedSourceRange,
        destinationCell: destinationCell,
        sourceSheet: source.sourceSheet,
        destinationSheet: destinationSheetIndex,
        hasHeaders: true,
        name: pivotName.trim() || undefined,
        sourceTableName: linkedTable,
      });

      console.log('[CreatePivotDialog] Pivot table created:', view.pivotId, 'rows:', view.rowCount, 'cols:', view.colCount);

      // Notify parent and close
      if (onCreated) {
        onCreated(view.pivotId);
      }
      handleClose();

      // Switch to destination sheet if it's different from current
      if (destinationSheetName && destinationSheetIndex !== undefined) {
        console.log('[CreatePivotDialog] Switching to sheet:', destinationSheetName, 'index:', destinationSheetIndex);
        await setActiveSheetApi(destinationSheetIndex);
        
        // Emit sheet change event so the grid reloads data for the new sheet
        emitAppEvent(AppEvents.SHEET_CHANGED, {
          sheetIndex: destinationSheetIndex,
          sheetName: destinationSheetName,
        });
      }

      // Dispatch events to scroll to pivot location and then refresh
      console.log('[CreatePivotDialog] Navigating to pivot at:', destinationCoords);
      
      // Use a single combined event that will scroll and refresh in the right order
      // Wait a bit for sheet switch to complete
      setTimeout(() => {
        // Dispatch scroll event - this should trigger selection change and scroll
        emitAppEvent(AppEvents.NAVIGATE_TO_CELL, {
          row: destinationCoords.row,
          col: destinationCoords.col,
        });
      }, 150);

    } catch (err) {
      console.error('[CreatePivotDialog] Error creating pivot table:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  };

  const startPicking = useCallback(() => {
    // Snapshot the current selection so we can detect a real change
    const sel = gridState.selection;
    pickStartSelRef.current = sel ? { endRow: sel.endRow, endCol: sel.endCol } : null;
    setIsPicking(true);
  }, [gridState.selection]);

  const cancelPicking = useCallback(() => {
    setIsPicking(false);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (isPicking) {
        cancelPicking();
      } else {
        handleClose();
      }
    } else if (e.key === 'Enter' && !isLoading) {
      handleCreate();
    }
  };

  if (!isOpen) {
    return null;
  }

  // Collapsed picker bar: shown when user is picking a cell on the grid
  if (isPicking) {
    return (
      <div style={styles.pickerBar} onKeyDown={handleKeyDown}>
        <span style={styles.pickerLabel}>
          Select a destination cell on the grid...
        </span>
        <span style={styles.pickerValue}>
          {existingDestination || '(click a cell)'}
        </span>
        <button style={styles.pickerCancelBtn} onClick={cancelPicking}>
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div style={styles.overlay} onClick={handleClose}>
      <div
        ref={win.ref}
        style={{ ...styles.dialog, position: 'relative', ...win.style }}
        onClick={e => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Header — drag handle */}
        <div style={styles.header} onMouseDown={win.onHeaderMouseDown}>
          <h2 style={styles.title}>Create PivotTable</h2>
          <button 
            style={styles.closeButton} 
            onClick={handleClose}
            aria-label="Close"
          >
            x
          </button>
        </div>

        {/* Content */}
        <div style={styles.content}>
          {/* Pivot Table Name */}
          <div style={styles.fieldGroup}>
            <label style={styles.label}>
              PivotTable Name:
            </label>
            <input
              type="text"
              style={styles.inputSmall}
              value={pivotName}
              onChange={e => setPivotName(e.target.value)}
              placeholder="e.g., PivotTable1"
              disabled={isLoading}
              autoFocus
            />
          </div>

          {canvasTarget !== null && (
            <>
              {/* Source (canvas): a worksheet range or table, or a data model */}
              <div style={styles.fieldGroup}>
                <label style={styles.label}>
                  Choose the data to analyze:
                </label>

                <div style={styles.radioGroup}>
                  <label style={styles.radioLabel}>
                    <input
                      type="radio"
                      name="canvasSource"
                      value="range"
                      checked={canvasSourceKind === 'range'}
                      onChange={() => setCanvasSourceKind('range')}
                      disabled={isLoading}
                      style={styles.radio}
                      data-testid="pivot-canvas-source-range"
                    />
                    <span>A table or range on a worksheet</span>
                  </label>

                  {canvasSourceKind === 'range' && (
                    <div style={styles.subField}>
                      <input
                        type="text"
                        style={styles.input}
                        value={sourceRange}
                        onChange={e => setSourceRange(e.target.value)}
                        placeholder="e.g., Sheet1!A1:D100 or Table1"
                        disabled={isLoading}
                        aria-label="Source table or range"
                        data-testid="pivot-canvas-source"
                      />
                      <span style={styles.hint}>
                        {canvasSourceNote ?? CANVAS_SOURCE_HINT}
                      </span>
                    </div>
                  )}
                </div>

                <div style={styles.radioGroup}>
                  <label style={styles.radioLabel}>
                    <input
                      type="radio"
                      name="canvasSource"
                      value="model"
                      checked={canvasSourceKind === 'model'}
                      onChange={() => setCanvasSourceKind('model')}
                      disabled={isLoading}
                      style={styles.radio}
                      data-testid="pivot-canvas-source-model"
                    />
                    <span>A data model connection</span>
                  </label>

                  {canvasSourceKind === 'model' && (
                    <div style={styles.subField}>
                      {connections.length > 0 ? (
                        <select
                          style={styles.select}
                          value={connectionId}
                          onChange={e => setConnectionId(e.target.value)}
                          disabled={isLoading}
                          aria-label="Data model connection"
                          data-testid="pivot-canvas-connection"
                        >
                          {connections.map(c => (
                            <option key={c.id} value={c.id}>
                              {c.name}{c.isConnected ? '' : ' (not connected)'}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span style={styles.hint}>
                          This workbook has no data model connections yet. Add one from the Model menu first.
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Destination (canvas): fixed to the canvas the box is on */}
              <div style={styles.fieldGroup}>
                <label style={styles.label}>
                  Where the PivotTable goes:
                </label>
                <div style={styles.canvasDestination} data-testid="pivot-canvas-destination">
                  This canvas ({canvasName}), {Math.round(canvasTarget.width)} x {Math.round(canvasTarget.height)} px
                </div>
                <span style={styles.hint}>
                  The PivotTable is shown in this box on the page; scroll inside the box to see the rest of it.
                </span>
              </div>
            </>
          )}

          {canvasTarget === null && (
            <>
              {/* Source Range */}
              <div style={styles.fieldGroup}>
                <label style={styles.label}>
                  Select a table or range:
                </label>
                <input
                  type="text"
                  data-testid="pivot-worksheet-source-range"
                  style={styles.input}
                  value={sourceRange}
                  onChange={e => setSourceRange(e.target.value)}
                  placeholder="e.g., Sheet1!A1:D100"
                  disabled={isLoading}
                />
                <span style={styles.hint}>
                  Include the sheet name and range (e.g., Sheet1!A1:D100)
                </span>
              </div>

              {/* Destination */}
              <div style={styles.fieldGroup}>
                <label style={styles.label}>
                  Choose where to place the PivotTable:
                </label>
                
                <div style={styles.radioGroup}>
                  <label style={styles.radioLabel}>
                    <input
                      type="radio"
                      name="destination"
                      value="new"
                      checked={destinationType === 'new'}
                      onChange={() => setDestinationType('new')}
                      disabled={isLoading}
                      style={styles.radio}
                    />
                    <span>New Worksheet</span>
                  </label>
                  
                  {destinationType === 'new' && (
                    <div style={styles.subField}>
                      <input
                        type="text"
                        style={styles.inputSmall}
                        value={newSheetName}
                        onChange={e => setNewSheetName(e.target.value)}
                        placeholder="Sheet name"
                        disabled={isLoading}
                      />
                    </div>
                  )}
                </div>

                <div style={styles.radioGroup}>
                  <label style={styles.radioLabel}>
                    <input
                      type="radio"
                      name="destination"
                      value="existing"
                      checked={destinationType === 'existing'}
                      onChange={() => setDestinationType('existing')}
                      disabled={isLoading}
                      style={styles.radio}
                    />
                    <span>Existing Worksheet</span>
                  </label>
                  
                  {destinationType === 'existing' && (
                    <div style={styles.subField}>
                      <div style={styles.inputWithPicker}>
                        <input
                          type="text"
                          style={styles.inputSmall}
                          value={existingDestination}
                          onChange={e => setExistingDestination(e.target.value)}
                          placeholder="e.g., Sheet2!F1"
                          disabled={isLoading}
                        />
                        <button
                          style={styles.pickButton}
                          onClick={startPicking}
                          disabled={isLoading}
                          title="Click to select a cell on the grid"
                        >
                          [^]
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}

          {/* Error Message */}
          {error && (
            <div style={styles.error}>
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={styles.footer}>
          <button
            style={styles.cancelButton}
            onClick={handleClose}
            disabled={isLoading}
          >
            Cancel
          </button>
          <button
            style={{
              ...styles.okButton,
              ...(isLoading ? styles.buttonDisabled : {}),
            }}
            onClick={handleCreate}
            disabled={isLoading}
          >
            {isLoading ? 'Creating...' : 'OK'}
          </button>
        </div>
        {win.resizeHandles}
      </div>
    </div>
  );
}

// ============================================================================
// Styles
// ============================================================================

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10000,
  },
  dialog: {
    backgroundColor: '#2d2d2d',
    borderRadius: '8px',
    border: '1px solid #454545',
    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
    width: '450px',
    maxWidth: '90vw',
    maxHeight: '90vh',
    display: 'flex',
    flexDirection: 'column',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '16px 20px',
    borderBottom: '1px solid #454545',
  },
  title: {
    margin: 0,
    fontSize: '16px',
    fontWeight: 600,
    color: '#ffffff',
  },
  closeButton: {
    background: 'transparent',
    border: 'none',
    color: '#888888',
    fontSize: '18px',
    cursor: 'pointer',
    padding: '4px 8px',
    borderRadius: '4px',
    lineHeight: 1,
  },
  content: {
    padding: '20px',
    overflowY: 'auto',
  },
  fieldGroup: {
    marginBottom: '20px',
  },
  label: {
    display: 'block',
    fontSize: '13px',
    fontWeight: 500,
    color: '#cccccc',
    marginBottom: '8px',
  },
  input: {
    width: '100%',
    padding: '8px 12px',
    fontSize: '13px',
    backgroundColor: '#1e1e1e',
    border: '1px solid #454545',
    borderRadius: '4px',
    color: '#ffffff',
    outline: 'none',
    boxSizing: 'border-box',
  },
  inputSmall: {
    width: '200px',
    padding: '6px 10px',
    fontSize: '13px',
    backgroundColor: '#1e1e1e',
    border: '1px solid #454545',
    borderRadius: '4px',
    color: '#ffffff',
    outline: 'none',
  },
  hint: {
    display: 'block',
    fontSize: '11px',
    color: '#888888',
    marginTop: '4px',
  },
  select: {
    width: '100%',
    padding: '6px 10px',
    fontSize: '13px',
    backgroundColor: '#1e1e1e',
    border: '1px solid #454545',
    borderRadius: '4px',
    color: '#ffffff',
    outline: 'none',
    boxSizing: 'border-box',
  },
  canvasDestination: {
    padding: '8px 12px',
    fontSize: '13px',
    backgroundColor: '#1e1e1e',
    border: '1px solid #454545',
    borderRadius: '4px',
    color: '#cccccc',
  },
  radioGroup: {
    marginBottom: '8px',
  },
  radioLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    fontSize: '13px',
    color: '#cccccc',
    cursor: 'pointer',
  },
  radio: {
    margin: 0,
    cursor: 'pointer',
  },
  subField: {
    marginLeft: '24px',
    marginTop: '8px',
  },
  error: {
    padding: '10px 12px',
    backgroundColor: 'rgba(220, 53, 69, 0.15)',
    border: '1px solid #dc3545',
    borderRadius: '4px',
    color: '#ff6b6b',
    fontSize: '13px',
  },
  footer: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '8px',
    padding: '16px 20px',
    borderTop: '1px solid #454545',
  },
  cancelButton: {
    padding: '8px 16px',
    fontSize: '13px',
    backgroundColor: 'transparent',
    border: '1px solid #454545',
    borderRadius: '4px',
    color: '#cccccc',
    cursor: 'pointer',
  },
  okButton: {
    padding: '8px 20px',
    fontSize: '13px',
    backgroundColor: '#0e639c',
    border: '1px solid #0e639c',
    borderRadius: '4px',
    color: '#ffffff',
    cursor: 'pointer',
    fontWeight: 500,
  },
  buttonDisabled: {
    opacity: 0.6,
    cursor: 'not-allowed',
  },
  inputWithPicker: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
  },
  pickButton: {
    padding: '6px 8px',
    fontSize: '13px',
    backgroundColor: '#3c3c3c',
    border: '1px solid #454545',
    borderRadius: '4px',
    color: '#cccccc',
    cursor: 'pointer',
    lineHeight: 1,
    flexShrink: 0,
  },
  pickerBar: {
    position: 'fixed',
    bottom: '40px',
    left: '50%',
    transform: 'translateX(-50%)',
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '10px 16px',
    backgroundColor: '#2d2d2d',
    border: '1px solid #0e639c',
    borderRadius: '6px',
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.4)',
    zIndex: 10000,
  },
  pickerLabel: {
    fontSize: '13px',
    color: '#cccccc',
  },
  pickerValue: {
    fontSize: '13px',
    fontWeight: 600,
    color: '#ffffff',
    padding: '4px 8px',
    backgroundColor: '#1e1e1e',
    border: '1px solid #454545',
    borderRadius: '4px',
    minWidth: '80px',
  },
  pickerCancelBtn: {
    padding: '4px 12px',
    fontSize: '12px',
    backgroundColor: 'transparent',
    border: '1px solid #454545',
    borderRadius: '4px',
    color: '#cccccc',
    cursor: 'pointer',
  },
};

export default CreatePivotDialog;