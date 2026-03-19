//! FILENAME: app/extensions/Pivot/components/ChangeDataSourceDialog.tsx
// PURPOSE: Dialog for changing a pivot table's source data range.
// CONTEXT: Opened from the "Pivot Table" (analyze) ribbon tab.

import React, { useState, useEffect, useCallback } from 'react';
import { changePivotDataSource, getPivotTableInfo } from '../lib/pivot-api';
import type { PivotId } from './types';

// ============================================================================
// Types
// ============================================================================

export interface ChangeDataSourceDialogProps {
  isOpen: boolean;
  onClose: () => void;
  pivotId: PivotId;
  onChanged?: () => void;
}

// ============================================================================
// Component
// ============================================================================

export function ChangeDataSourceDialog({
  isOpen,
  onClose,
  pivotId,
  onChanged,
}: ChangeDataSourceDialogProps): React.ReactElement | null {
  const [sourceRange, setSourceRange] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load current source range when dialog opens
  useEffect(() => {
    if (!isOpen || !pivotId) return;
    setError(null);
    setIsLoading(false);
    getPivotTableInfo(pivotId)
      .then((info) => {
        setSourceRange(info.sourceRange);
      })
      .catch((err) => {
        console.error('[ChangeDataSourceDialog] Failed to load pivot info:', err);
        setSourceRange('');
      });
  }, [isOpen, pivotId]);

  const handleApply = useCallback(async () => {
    setError(null);

    const trimmed = sourceRange.trim();
    if (!trimmed) {
      setError('Please enter a source data range.');
      return;
    }

    setIsLoading(true);
    try {
      await changePivotDataSource({
        pivotId,
        sourceRange: trimmed,
      });

      if (onChanged) {
        onChanged();
      }
      onClose();
    } catch (err) {
      console.error('[ChangeDataSourceDialog] Error:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, [pivotId, sourceRange, onChanged, onClose]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'Enter' && !isLoading) {
      handleApply();
    }
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div
        style={styles.dialog}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div style={styles.header}>
          <h2 style={styles.title}>Change PivotTable Data Source</h2>
          <button
            style={styles.closeButton}
            onClick={onClose}
            aria-label="Close"
          >
            x
          </button>
        </div>

        {/* Content */}
        <div style={styles.content}>
          <div style={styles.fieldGroup}>
            <label style={styles.label}>
              Table/Range:
            </label>
            <input
              type="text"
              style={styles.input}
              value={sourceRange}
              onChange={(e) => setSourceRange(e.target.value)}
              placeholder="e.g., Sheet1!A1:D100"
              disabled={isLoading}
              autoFocus
            />
            <span style={styles.hint}>
              Enter the new data range including the sheet name (e.g., Sheet1!A1:D100).
              You can use full-column references like Sheet1!A:D.
            </span>
          </div>

          {/* Error */}
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
            onClick={onClose}
            disabled={isLoading}
          >
            Cancel
          </button>
          <button
            style={{
              ...styles.okButton,
              ...(isLoading ? styles.buttonDisabled : {}),
            }}
            onClick={handleApply}
            disabled={isLoading}
          >
            {isLoading ? 'Applying...' : 'OK'}
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
    width: '420px',
    maxWidth: '90vw',
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
  },
  fieldGroup: {
    marginBottom: '16px',
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
    boxSizing: 'border-box' as const,
  },
  hint: {
    display: 'block',
    fontSize: '11px',
    color: '#888888',
    marginTop: '4px',
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

export default ChangeDataSourceDialog;
