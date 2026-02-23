//! FILENAME: app/extensions/Tablix/components/CreateTablixDialog.tsx

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createTablix } from '../lib/tablix-api';
import { addSheet, getSheets, setActiveSheetApi, indexToCol, colToIndex, detectDataRegion, useGridState } from '../../../src/api';
import { emitAppEvent, AppEvents } from '../../../src/api/events';

// ============================================================================
// Types
// ============================================================================

export interface CreateTablixDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated?: (tablixId: number) => void;
  selection?: {
    startRow: number;
    startCol: number;
    endRow: number;
    endCol: number;
  } | null;
}

type DestinationType = 'new' | 'existing';

// ============================================================================
// Utility Functions
// ============================================================================

function toA1Notation(row: number, col: number): string {
  return `${indexToCol(col)}${row + 1}`;
}

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

function buildSheetRange(sheetName: string, range: string): string {
  if (/[^a-zA-Z0-9_]/.test(sheetName)) {
    return `'${sheetName}'!${range}`;
  }
  return `${sheetName}!${range}`;
}

function parseCellReference(cellRef: string): { row: number; col: number } | null {
  let ref = cellRef;
  const bangIndex = ref.lastIndexOf('!');
  if (bangIndex !== -1) {
    ref = ref.substring(bangIndex + 1);
  }
  ref = ref.replace(/'/g, '').trim().toUpperCase();
  const match = ref.match(/^([A-Z]+)(\d+)$/);
  if (!match) return null;
  const colLetters = match[1];
  const rowNumber = parseInt(match[2], 10);
  if (isNaN(rowNumber) || rowNumber < 1) return null;
  const col = colToIndex(colLetters);
  const row = rowNumber - 1;
  return { row, col };
}

function extractSheetName(reference: string): string | null {
  const bangIndex = reference.lastIndexOf('!');
  if (bangIndex === -1) return null;
  let sheetName = reference.substring(0, bangIndex);
  if (sheetName.startsWith("'") && sheetName.endsWith("'")) {
    sheetName = sheetName.substring(1, sheetName.length - 1);
  }
  return sheetName;
}

function generateTablixSheetName(existingSheets: { name: string }[]): string {
  const tablixSheetCount = existingSheets.filter(s =>
    s.name.toLowerCase().startsWith('tablix')
  ).length;
  return `Tablix${tablixSheetCount + 1}`;
}

// ============================================================================
// Component
// ============================================================================

export function CreateTablixDialog({
  isOpen,
  onClose,
  onCreated,
  selection,
}: CreateTablixDialogProps): React.ReactElement | null {
  const gridState = useGridState();

  const [sourceRange, setSourceRange] = useState('');
  const [destinationType, setDestinationType] = useState<DestinationType>('new');
  const [existingDestination, setExistingDestination] = useState('');
  const [newSheetName, setNewSheetName] = useState('');

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sheets, setSheets] = useState<{ index: number; name: string }[]>([]);
  const [currentSheetName, setCurrentSheetName] = useState('Sheet1');

  const [hasInitializedSheetName, setHasInitializedSheetName] = useState(false);
  const [hasAutoDetected, setHasAutoDetected] = useState(false);
  const [isPicking, setIsPicking] = useState(false);
  const pickStartSelRef = useRef<{ endRow: number; endCol: number } | null>(null);

  useEffect(() => {
    if (isOpen) {
      setHasInitializedSheetName(false);
      setHasAutoDetected(false);
      setIsPicking(false);
      loadSheets();
    } else {
      setHasInitializedSheetName(false);
      setHasAutoDetected(false);
      setIsPicking(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isPicking || !gridState.selection) return;
    const sel = gridState.selection;
    const start = pickStartSelRef.current;
    if (start && sel.endRow === start.endRow && sel.endCol === start.endCol) return;
    const sheetName = gridState.sheetContext?.activeSheetName ?? currentSheetName;
    const cellRef = buildSheetRange(sheetName, toA1Notation(sel.endRow, sel.endCol));
    setExistingDestination(cellRef);
    setDestinationType('existing');
    setIsPicking(false);
  }, [isPicking, gridState.selection]);

  useEffect(() => {
    if (!isOpen || hasAutoDetected || !currentSheetName) return;
    const sel = selection ?? gridState.selection;
    if (!sel) return;
    const activeRow = sel.endRow;
    const activeCol = sel.endCol;
    setHasAutoDetected(true);
    detectDataRegion(activeRow, activeCol)
      .then((region) => {
        if (region) {
          const [startRow, startCol, endRow, endCol] = region;
          const range = selectionToRange(startRow, startCol, endRow, endCol);
          setSourceRange(buildSheetRange(currentSheetName, range));
        } else if (sel) {
          const range = selectionToRange(sel.startRow, sel.startCol, sel.endRow, sel.endCol);
          setSourceRange(buildSheetRange(currentSheetName, range));
        }
      })
      .catch(() => {
        if (sel) {
          const range = selectionToRange(sel.startRow, sel.startCol, sel.endRow, sel.endCol);
          setSourceRange(buildSheetRange(currentSheetName, range));
        }
      });
  }, [isOpen, hasAutoDetected, currentSheetName, selection, gridState.selection]);

  useEffect(() => {
    if (isOpen && sheets.length > 0 && !hasInitializedSheetName) {
      setNewSheetName(generateTablixSheetName(sheets));
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
      console.error('[CreateTablixDialog] Failed to load sheets:', err);
    }
  };

  const handleClose = useCallback(() => {
    setError(null);
    setIsLoading(false);
    setNewSheetName('');
    onClose();
  }, [onClose]);

  const handleCreate = async () => {
    setError(null);
    setIsLoading(true);

    try {
      if (!sourceRange.trim()) {
        throw new Error('Please enter a source data range.');
      }

      let destinationCell: string;
      let destinationSheetIndex: number | undefined;
      let destinationSheetName: string | null = null;
      let destinationCoords: { row: number; col: number } = { row: 0, col: 0 };

      if (destinationType === 'new') {
        const sheetName = newSheetName.trim();
        if (!sheetName) {
          throw new Error('Please enter a name for the new worksheet.');
        }
        if (sheets.some(s => s.name.toLowerCase() === sheetName.toLowerCase())) {
          throw new Error(`A worksheet named "${sheetName}" already exists.`);
        }

        const sheetsResult = await addSheet(sheetName);
        const newSheet = sheetsResult.sheets.find(s => s.name === sheetName);
        if (!newSheet) {
          throw new Error('Failed to create new sheet.');
        }

        destinationCell = buildSheetRange(sheetName, 'A1');
        destinationSheetIndex = newSheet.index;
        destinationSheetName = sheetName;
        destinationCoords = { row: 0, col: 0 };
      } else {
        if (!existingDestination.trim()) {
          throw new Error('Please enter a destination cell.');
        }
        destinationCell = existingDestination.trim();
        destinationSheetName = extractSheetName(destinationCell);

        if (destinationSheetName) {
          const destSheet = sheets.find(s => s.name === destinationSheetName);
          if (destSheet) {
            destinationSheetIndex = destSheet.index;
          }
        }

        const parsed = parseCellReference(destinationCell);
        if (parsed) {
          destinationCoords = parsed;
        }
      }

      const view = await createTablix({
        sourceRange,
        destinationCell,
        destinationSheet: destinationSheetIndex,
        hasHeaders: true,
      });

      if (onCreated) {
        onCreated(view.tablixId);
      }
      handleClose();

      if (destinationSheetName && destinationSheetIndex !== undefined) {
        await setActiveSheetApi(destinationSheetIndex);
        emitAppEvent(AppEvents.SHEET_CHANGED, {
          sheetIndex: destinationSheetIndex,
          sheetName: destinationSheetName,
        });
      }

      setTimeout(() => {
        emitAppEvent(AppEvents.NAVIGATE_TO_CELL, {
          row: destinationCoords.row,
          col: destinationCoords.col,
        });
      }, 150);

    } catch (err) {
      console.error('[CreateTablixDialog] Error creating tablix:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  };

  const startPicking = useCallback(() => {
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

  if (!isOpen) return null;

  if (isPicking) {
    return (
      <div style={dialogStyles.pickerBar} onKeyDown={handleKeyDown}>
        <span style={dialogStyles.pickerLabel}>
          Select a destination cell on the grid...
        </span>
        <span style={dialogStyles.pickerValue}>
          {existingDestination || '(click a cell)'}
        </span>
        <button style={dialogStyles.pickerCancelBtn} onClick={cancelPicking}>
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div style={dialogStyles.overlay} onClick={handleClose}>
      <div
        style={dialogStyles.dialog}
        onClick={e => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div style={dialogStyles.header}>
          <h2 style={dialogStyles.title}>Create Tablix</h2>
          <button
            style={dialogStyles.closeButton}
            onClick={handleClose}
            aria-label="Close"
          >
            x
          </button>
        </div>

        <div style={dialogStyles.content}>
          <div style={dialogStyles.fieldGroup}>
            <label style={dialogStyles.label}>
              Select a table or range:
            </label>
            <input
              type="text"
              style={dialogStyles.input}
              value={sourceRange}
              onChange={e => setSourceRange(e.target.value)}
              placeholder="e.g., Sheet1!A1:D100"
              disabled={isLoading}
              autoFocus
            />
            <span style={dialogStyles.hint}>
              Include the sheet name and range (e.g., Sheet1!A1:D100)
            </span>
          </div>

          <div style={dialogStyles.fieldGroup}>
            <label style={dialogStyles.label}>
              Choose where to place the Tablix:
            </label>

            <div style={dialogStyles.radioGroup}>
              <label style={dialogStyles.radioLabel}>
                <input
                  type="radio"
                  name="destination"
                  value="new"
                  checked={destinationType === 'new'}
                  onChange={() => setDestinationType('new')}
                  disabled={isLoading}
                  style={dialogStyles.radio}
                />
                <span>New Worksheet</span>
              </label>

              {destinationType === 'new' && (
                <div style={dialogStyles.subField}>
                  <input
                    type="text"
                    style={dialogStyles.inputSmall}
                    value={newSheetName}
                    onChange={e => setNewSheetName(e.target.value)}
                    placeholder="Sheet name"
                    disabled={isLoading}
                  />
                </div>
              )}
            </div>

            <div style={dialogStyles.radioGroup}>
              <label style={dialogStyles.radioLabel}>
                <input
                  type="radio"
                  name="destination"
                  value="existing"
                  checked={destinationType === 'existing'}
                  onChange={() => setDestinationType('existing')}
                  disabled={isLoading}
                  style={dialogStyles.radio}
                />
                <span>Existing Worksheet</span>
              </label>

              {destinationType === 'existing' && (
                <div style={dialogStyles.subField}>
                  <div style={dialogStyles.inputWithPicker}>
                    <input
                      type="text"
                      style={dialogStyles.inputSmall}
                      value={existingDestination}
                      onChange={e => setExistingDestination(e.target.value)}
                      placeholder="e.g., Sheet2!F1"
                      disabled={isLoading}
                    />
                    <button
                      style={dialogStyles.pickButton}
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

          {error && (
            <div style={dialogStyles.error}>
              {error}
            </div>
          )}
        </div>

        <div style={dialogStyles.footer}>
          <button
            style={dialogStyles.cancelButton}
            onClick={handleClose}
            disabled={isLoading}
          >
            Cancel
          </button>
          <button
            style={{
              ...dialogStyles.okButton,
              ...(isLoading ? dialogStyles.buttonDisabled : {}),
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

const dialogStyles: Record<string, React.CSSProperties> = {
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

export default CreateTablixDialog;
