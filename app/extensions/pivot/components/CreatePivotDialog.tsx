//! FILENAME: app/extensions/pivot/components/CreatePivotDialog.tsx

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { pivot } from '../../../src/api/pivot';
import { addSheet, getSheets, setActiveSheetApi, indexToCol, colToIndex, detectDataRegion, useGridState } from '../../../src/api';
import { emitAppEvent, AppEvents } from '../../../src/api/events';

// ============================================================================
// Types
// ============================================================================

export interface CreatePivotDialogProps {
  /** Whether the dialog is open */
  isOpen: boolean;
  /** Callback when dialog is closed */
  onClose: () => void;
  /** Callback when pivot table is created successfully */
  onCreated?: (pivotId: number) => void;
  /** Current selection from grid (0-indexed) */
  selection?: {
    startRow: number;
    startCol: number;
    endRow: number;
    endCol: number;
  } | null;
  /** Current active sheet index */
  activeSheetIndex?: number;
}

type DestinationType = 'new' | 'existing';

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
 * Convert selection to range string (e.g., A1:D100)
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
  
  // Remove any quotes
  ref = ref.replace(/'/g, '').trim().toUpperCase();
  
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
 * Extract sheet name from a reference like "Sheet1!A1" or "'My Sheet'!A1"
 * Returns null if no sheet prefix.
 */
function extractSheetName(reference: string): string | null {
  const bangIndex = reference.lastIndexOf('!');
  if (bangIndex === -1) {
    return null;
  }
  
  let sheetName = reference.substring(0, bangIndex);
  // Remove surrounding quotes if present
  if (sheetName.startsWith("'") && sheetName.endsWith("'")) {
    sheetName = sheetName.substring(1, sheetName.length - 1);
  }
  
  return sheetName;
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
}: CreatePivotDialogProps): React.ReactElement | null {
  // Read current grid selection (active cell) for auto-detection
  const gridState = useGridState();

  // Form state
  const [sourceRange, setSourceRange] = useState('');
  const [destinationType, setDestinationType] = useState<DestinationType>('new');
  const [existingDestination, setExistingDestination] = useState('');
  const [newSheetName, setNewSheetName] = useState('');

  // UI state
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sheets, setSheets] = useState<{ index: number; name: string }[]>([]);
  const [currentSheetName, setCurrentSheetName] = useState('Sheet1');

  // Track if we've initialized the default sheet name for this dialog open
  const [hasInitializedSheetName, setHasInitializedSheetName] = useState(false);
  // Track if we've run auto-detection for this dialog open
  const [hasAutoDetected, setHasAutoDetected] = useState(false);

  // Cell picker mode: when true, dialog collapses so user can click a cell
  const [isPicking, setIsPicking] = useState(false);
  // Snapshot the selection at the moment picking started so we can detect changes
  const pickStartSelRef = useRef<{ endRow: number; endCol: number } | null>(null);

  // Load sheets on mount and reset initialization flags
  useEffect(() => {
    if (isOpen) {
      setHasInitializedSheetName(false);
      setHasAutoDetected(false);
      setIsPicking(false);
      loadSheets();
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

  // Auto-detect the contiguous data region around the active cell
  useEffect(() => {
    if (!isOpen || hasAutoDetected || !currentSheetName) return;

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
  }, [isOpen, hasAutoDetected, currentSheetName, selection, gridState.selection]);

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
      }
    } catch (err) {
      console.error('[CreatePivotDialog] Failed to load sheets:', err);
    }
  };

  const handleClose = useCallback(() => {
    setError(null);
    setIsLoading(false);
    setNewSheetName(''); // Reset for next open
    onClose();
  }, [onClose]);

  const handleCreate = async () => {
    setError(null);
    setIsLoading(true);

    try {
      // Validate source range
      if (!sourceRange.trim()) {
        throw new Error('Please enter a source data range.');
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
        destinationSheetName = extractSheetName(destinationCell);
        
        // If a sheet name was specified, find its index
        if (destinationSheetName) {
          const destSheet = sheets.find(s => s.name === destinationSheetName);
          if (destSheet) {
            destinationSheetIndex = destSheet.index;
          }
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

      // Create the pivot table
      const view = await pivot.create({
        sourceRange: sourceRange,
        destinationCell: destinationCell,
        destinationSheet: destinationSheetIndex,
        hasHeaders: true,
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
        style={styles.dialog}
        onClick={e => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div style={styles.header}>
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
          {/* Source Range */}
          <div style={styles.fieldGroup}>
            <label style={styles.label}>
              Select a table or range:
            </label>
            <input
              type="text"
              style={styles.input}
              value={sourceRange}
              onChange={e => setSourceRange(e.target.value)}
              placeholder="e.g., Sheet1!A1:D100"
              disabled={isLoading}
              autoFocus
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