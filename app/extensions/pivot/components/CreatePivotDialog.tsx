//! FILENAME: app/src/core/components/pivot/CreatePivotDialog.tsx

import React, { useState, useEffect, useCallback } from 'react';
import { pivot } from '../../../src/api/pivot';
import { addSheet, getSheets, setActiveSheet, indexToCol, colToIndex } from '../../../src/api';

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

  // Load sheets on mount and reset initialization flag
  useEffect(() => {
    if (isOpen) {
      setHasInitializedSheetName(false);
      loadSheets();
    } else {
      // Reset state when dialog closes
      setHasInitializedSheetName(false);
    }
  }, [isOpen]);

  // Initialize source range from selection
  useEffect(() => {
    if (isOpen && selection) {
      const range = selectionToRange(
        selection.startRow,
        selection.startCol,
        selection.endRow,
        selection.endCol
      );
      const fullRange = buildSheetRange(currentSheetName, range);
      setSourceRange(fullRange);
    }
  }, [isOpen, selection, currentSheetName]);

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
        source_range: sourceRange,
        destination_cell: destinationCell,
        destination_sheet: destinationSheetIndex,
      });

      // Create the pivot table - NOW WITH destination_sheet!
      const view = await pivot.create({
        source_range: sourceRange,
        destination_cell: destinationCell,
        destination_sheet: destinationSheetIndex,  // <-- KEY FIX!
        has_headers: true,
      });

      console.log('[CreatePivotDialog] Pivot table created:', view.pivot_id, 'rows:', view.row_count, 'cols:', view.col_count);

      // Notify parent and close
      if (onCreated) {
        onCreated(view.pivot_id);
      }
      handleClose();

      // Switch to destination sheet if it's different from current
      if (destinationSheetName && destinationSheetIndex !== undefined) {
        console.log('[CreatePivotDialog] Switching to sheet:', destinationSheetName, 'index:', destinationSheetIndex);
        await setActiveSheet(destinationSheetIndex);
        
        // Emit sheet change event so the grid reloads data for the new sheet
        window.dispatchEvent(new CustomEvent('sheet:changed', {
          detail: { sheetIndex: destinationSheetIndex, sheetName: destinationSheetName }
        }));
      }

      // Dispatch events to scroll to pivot location and then refresh
      console.log('[CreatePivotDialog] Navigating to pivot at:', destinationCoords);
      
      // Use a single combined event that will scroll and refresh in the right order
      // Wait a bit for sheet switch to complete
      setTimeout(() => {
        // Dispatch scroll event - this should trigger selection change and scroll
        window.dispatchEvent(new CustomEvent('grid:navigateToCell', {
          detail: {
            row: destinationCoords.row,
            col: destinationCoords.col,
          }
        }));
      }, 150);

    } catch (err) {
      console.error('[CreatePivotDialog] Error creating pivot table:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      handleClose();
    } else if (e.key === 'Enter' && !isLoading) {
      handleCreate();
    }
  };

  if (!isOpen) {
    return null;
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
                  <input
                    type="text"
                    style={styles.inputSmall}
                    value={existingDestination}
                    onChange={e => setExistingDestination(e.target.value)}
                    placeholder="e.g., Sheet2!F1"
                    disabled={isLoading}
                  />
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
};

export default CreatePivotDialog;