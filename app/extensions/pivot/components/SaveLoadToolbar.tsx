//! FILENAME: app/extensions/Pivot/components/SaveLoadToolbar.tsx
// PURPOSE: Toolbar for saving, loading, and applying pivot layout templates in the Design tab.
// CONTEXT: Rendered above the Monaco editor. Persists layouts via Tauri backend.

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { css } from '@emotion/css';
import type { SourceField, BiPivotModelInfo } from './types';
import {
  savePivotLayout,
  getPivotLayouts,
  deletePivotLayout,
} from '@api/pivot';
import type { SavePivotLayoutRequest, PivotLayoutResponse } from '@api/pivot';
import {
  buildSourceSignature,
  validateLayoutCompatibility,
  PIVOT_TEMPLATES,
} from '../lib/namedConfigs';

export interface SaveLoadToolbarProps {
  sourceFields: SourceField[];
  biModel?: BiPivotModelInfo;
  sourceTableName?: string;
  currentDslText: string;
  currentSaveAsName?: string;
  pivotId?: number;
  onLoadDsl: (dslText: string) => void;
}

export function SaveLoadToolbar({
  sourceFields,
  biModel,
  sourceTableName,
  currentDslText,
  currentSaveAsName,
  pivotId,
  onLoadDsl,
}: SaveLoadToolbarProps): React.ReactElement | null {
  const [activeMenu, setActiveMenu] = useState<'save' | 'load' | 'templates' | null>(null);
  const [saveAsMode, setSaveAsMode] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveDescription, setSaveDescription] = useState('');
  const [manageMode, setManageMode] = useState(false);
  const [layouts, setLayouts] = useState<PivotLayoutResponse[]>([]);
  const [mismatchDialog, setMismatchDialog] = useState<{ config: PivotLayoutResponse; missing: string[] } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Load layouts from backend on mount
  const refreshLayouts = useCallback(async () => {
    try {
      const result = await getPivotLayouts();
      setLayouts(result.sort((a, b) => b.updatedAt - a.updatedAt));
    } catch (err) {
      console.error('Failed to load pivot layouts:', err);
    }
  }, []);

  useEffect(() => {
    refreshLayouts();
  }, [refreshLayouts]);

  // Close menu on outside click
  useEffect(() => {
    if (!activeMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setActiveMenu(null);
        setSaveAsMode(false);
        setManageMode(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [activeMenu]);

  const buildRequest = useCallback((name: string, description?: string): SavePivotLayoutRequest | null => {
    const sig = buildSourceSignature(sourceFields, biModel, sourceTableName);
    if (!sig) return null;
    return {
      name,
      dslText: currentDslText,
      description,
      sourceType: sig.type,
      sourceTableName: sig.tableName,
      sourceBiTables: sig.tables?.map(t => t.name) ?? [],
      sourceBiMeasures: sig.measures ?? [],
    };
  }, [sourceFields, biModel, sourceTableName, currentDslText]);

  const handleSave = useCallback(async () => {
    const name = currentSaveAsName;
    if (!name) {
      setSaveAsMode(true);
      setSaveName('');
      setSaveDescription('');
      return;
    }
    const request = buildRequest(name);
    if (!request) return;
    // Find existing layout ID to update
    const existing = layouts.find(l => l.name === name);
    if (existing) request.id = existing.id;
    try {
      await savePivotLayout(request);
      await refreshLayouts();
    } catch (err) {
      console.error('Failed to save pivot layout:', err);
    }
    setActiveMenu(null);
  }, [currentSaveAsName, buildRequest, layouts, refreshLayouts]);

  const handleSaveAs = useCallback(async () => {
    if (!saveName.trim()) return;
    const request = buildRequest(saveName.trim(), saveDescription.trim() || undefined);
    if (!request) return;
    try {
      await savePivotLayout(request);
      await refreshLayouts();
    } catch (err) {
      console.error('Failed to save pivot layout:', err);
    }
    setSaveAsMode(false);
    setActiveMenu(null);
  }, [saveName, saveDescription, buildRequest, refreshLayouts]);

  const handleLoad = useCallback((config: PivotLayoutResponse) => {
    const result = validateLayoutCompatibility(config.dslText, sourceFields, biModel);
    if (result.compatible) {
      onLoadDsl(config.dslText);
      setActiveMenu(null);
    } else {
      setMismatchDialog({ config, missing: result.missingFields });
    }
  }, [sourceFields, biModel, onLoadDsl]);

  const handleLoadAnyway = useCallback(() => {
    if (mismatchDialog) {
      onLoadDsl(mismatchDialog.config.dslText);
      setMismatchDialog(null);
      setActiveMenu(null);
    }
  }, [mismatchDialog, onLoadDsl]);

  const handleDelete = useCallback(async (id: number) => {
    try {
      await deletePivotLayout(id);
      await refreshLayouts();
    } catch (err) {
      console.error('Failed to delete pivot layout:', err);
    }
  }, [refreshLayouts]);

  const handleLoadTemplate = useCallback((dslText: string) => {
    onLoadDsl(dslText);
    setActiveMenu(null);
  }, [onLoadDsl]);

  // Gate: only render for Table or BI source pivots
  if (!sourceTableName && !biModel) {
    return null;
  }

  return (
    <div className={toolbarStyles.container} ref={menuRef}>
      {/* Save button */}
      <div className={toolbarStyles.buttonGroup}>
        <button
          className={toolbarStyles.button}
          onClick={() => {
            if (activeMenu === 'save') {
              setActiveMenu(null);
              setSaveAsMode(false);
            } else {
              setActiveMenu('save');
              setSaveAsMode(false);
            }
          }}
        >
          Save Layout
        </button>

        {activeMenu === 'save' && !saveAsMode && (
          <div className={toolbarStyles.menu}>
            <button
              className={toolbarStyles.menuItem}
              onClick={handleSave}
              disabled={!currentSaveAsName && !currentDslText.trim()}
            >
              {currentSaveAsName ? `Save "${currentSaveAsName}"` : 'Save...'}
            </button>
            <button
              className={toolbarStyles.menuItem}
              onClick={() => {
                setSaveAsMode(true);
                setSaveName(currentSaveAsName || '');
                setSaveDescription('');
              }}
            >
              Save As...
            </button>
          </div>
        )}

        {activeMenu === 'save' && saveAsMode && (
          <div className={toolbarStyles.menu}>
            <div className={toolbarStyles.saveForm}>
              <input
                className={toolbarStyles.input}
                type="text"
                placeholder="Layout name"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSaveAs(); }}
                autoFocus
              />
              <input
                className={toolbarStyles.input}
                type="text"
                placeholder="Description (optional)"
                value={saveDescription}
                onChange={(e) => setSaveDescription(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSaveAs(); }}
              />
              <div className={toolbarStyles.saveFormButtons}>
                <button className={toolbarStyles.primaryButton} onClick={handleSaveAs} disabled={!saveName.trim()}>
                  Save
                </button>
                <button className={toolbarStyles.secondaryButton} onClick={() => setSaveAsMode(false)}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Load button */}
      <div className={toolbarStyles.buttonGroup}>
        <button
          className={toolbarStyles.button}
          onClick={() => {
            if (activeMenu === 'load') {
              setActiveMenu(null);
              setManageMode(false);
            } else {
              setActiveMenu('load');
              setManageMode(false);
            }
          }}
        >
          Load Layout
        </button>

        {activeMenu === 'load' && (
          <div className={toolbarStyles.menu}>
            {!manageMode && layouts.length === 0 && (
              <div className={toolbarStyles.emptyState}>No saved layouts</div>
            )}
            {!manageMode && layouts.map(c => (
              <button
                key={c.id}
                className={toolbarStyles.menuItem}
                onClick={() => handleLoad(c)}
                title={c.description || undefined}
              >
                <div className={toolbarStyles.configItem}>
                  <span className={toolbarStyles.configName}>{c.name}</span>
                  {c.description && <span className={toolbarStyles.configDesc}>{c.description}</span>}
                  <span className={toolbarStyles.configTime}>{formatRelativeTime(c.updatedAt)}</span>
                </div>
              </button>
            ))}
            {!manageMode && layouts.length > 0 && (
              <>
                <div className={toolbarStyles.separator} />
                <button className={toolbarStyles.menuItem} onClick={() => setManageMode(true)}>
                  Manage...
                </button>
              </>
            )}
            {manageMode && (
              <div className={toolbarStyles.manageList}>
                <div className={toolbarStyles.manageHeader}>
                  <span>Manage Saved Layouts</span>
                  <button className={toolbarStyles.closeBtn} onClick={() => setManageMode(false)}>Back</button>
                </div>
                {layouts.map(c => (
                  <div key={c.id} className={toolbarStyles.manageItem}>
                    <span className={toolbarStyles.configName}>{c.name}</span>
                    <button
                      className={toolbarStyles.deleteBtn}
                      onClick={() => handleDelete(c.id)}
                    >
                      Delete
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Templates button */}
      <div className={toolbarStyles.buttonGroup}>
        <button
          className={toolbarStyles.button}
          onClick={() => setActiveMenu(activeMenu === 'templates' ? null : 'templates')}
        >
          Templates
        </button>

        {activeMenu === 'templates' && (
          <div className={toolbarStyles.menu}>
            {PIVOT_TEMPLATES.map(t => (
              <button
                key={t.name}
                className={toolbarStyles.menuItem}
                onClick={() => handleLoadTemplate(t.dslText)}
                title={t.description}
              >
                <div className={toolbarStyles.configItem}>
                  <span className={toolbarStyles.configName}>{t.name}</span>
                  <span className={toolbarStyles.configDesc}>{t.description}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Field mismatch dialog */}
      {mismatchDialog && (
        <div className={toolbarStyles.dialogOverlay}>
          <div className={toolbarStyles.dialog}>
            <div className={toolbarStyles.dialogTitle}>Field Mismatch</div>
            <div className={toolbarStyles.dialogBody}>
              <p>The layout "{mismatchDialog.config.name}" references fields not available in this pivot:</p>
              <ul className={toolbarStyles.missingList}>
                {mismatchDialog.missing.map(f => <li key={f}>{f}</li>)}
              </ul>
              <p>Loading anyway will show errors for missing fields.</p>
            </div>
            <div className={toolbarStyles.dialogButtons}>
              <button className={toolbarStyles.primaryButton} onClick={handleLoadAnyway}>Load Anyway</button>
              <button className={toolbarStyles.secondaryButton} onClick={() => setMismatchDialog(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

const toolbarStyles = {
  container: css`
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    background: #f6f8fa;
    border-bottom: 1px solid #e1e4e8;
    flex-shrink: 0;
    position: relative;
  `,
  buttonGroup: css`
    position: relative;
  `,
  button: css`
    padding: 4px 10px;
    font-size: 11px;
    font-family: 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif;
    background: #fff;
    border: 1px solid #d0d7de;
    border-radius: 4px;
    cursor: pointer;
    color: #24292f;
    transition: background 0.1s, border-color 0.1s;

    &:hover {
      background: #f3f4f6;
      border-color: #bbc0c6;
    }
  `,
  menu: css`
    position: absolute;
    top: 100%;
    left: 0;
    margin-top: 2px;
    background: #fff;
    border: 1px solid #d0d7de;
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
    min-width: 220px;
    max-height: 320px;
    overflow-y: auto;
    z-index: 10000;
    padding: 4px 0;
  `,
  menuItem: css`
    display: block;
    width: 100%;
    padding: 6px 12px;
    text-align: left;
    background: none;
    border: none;
    cursor: pointer;
    font-size: 12px;
    font-family: 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif;
    color: #24292f;

    &:hover {
      background: #f3f4f6;
    }

    &:disabled {
      color: #8c959f;
      cursor: default;
      &:hover { background: none; }
    }
  `,
  configItem: css`
    display: flex;
    flex-direction: column;
    gap: 1px;
  `,
  configName: css`
    font-weight: 500;
    font-size: 12px;
  `,
  configDesc: css`
    font-size: 11px;
    color: #656d76;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 200px;
  `,
  configTime: css`
    font-size: 10px;
    color: #8c959f;
  `,
  separator: css`
    height: 1px;
    background: #e1e4e8;
    margin: 4px 0;
  `,
  emptyState: css`
    padding: 12px;
    text-align: center;
    color: #8c959f;
    font-size: 12px;
  `,
  saveForm: css`
    padding: 8px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  `,
  input: css`
    width: 100%;
    padding: 5px 8px;
    font-size: 12px;
    font-family: 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif;
    border: 1px solid #d0d7de;
    border-radius: 4px;
    outline: none;
    box-sizing: border-box;

    &:focus {
      border-color: #0969da;
      box-shadow: 0 0 0 2px rgba(9, 105, 218, 0.15);
    }
  `,
  saveFormButtons: css`
    display: flex;
    gap: 6px;
    justify-content: flex-end;
    margin-top: 2px;
  `,
  primaryButton: css`
    padding: 4px 12px;
    font-size: 11px;
    font-family: 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif;
    background: #0969da;
    color: #fff;
    border: none;
    border-radius: 4px;
    cursor: pointer;

    &:hover { background: #0860c4; }
    &:disabled { background: #8c959f; cursor: default; }
  `,
  secondaryButton: css`
    padding: 4px 12px;
    font-size: 11px;
    font-family: 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif;
    background: #fff;
    color: #24292f;
    border: 1px solid #d0d7de;
    border-radius: 4px;
    cursor: pointer;

    &:hover { background: #f3f4f6; }
  `,
  manageList: css`
    padding: 4px 0;
  `,
  manageHeader: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    font-size: 12px;
    font-weight: 600;
    color: #24292f;
    border-bottom: 1px solid #e1e4e8;
    margin-bottom: 4px;
  `,
  manageItem: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;

    &:hover {
      background: #f3f4f6;
    }
  `,
  closeBtn: css`
    font-size: 11px;
    background: none;
    border: none;
    cursor: pointer;
    color: #0969da;
    padding: 2px 6px;

    &:hover { text-decoration: underline; }
  `,
  deleteBtn: css`
    font-size: 11px;
    background: none;
    border: none;
    cursor: pointer;
    color: #cf222e;
    padding: 2px 6px;

    &:hover { text-decoration: underline; }
  `,
  dialogOverlay: css`
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.3);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 20000;
  `,
  dialog: css`
    background: #fff;
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
    width: 360px;
    max-width: 90vw;
    padding: 20px;
    font-family: 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif;
  `,
  dialogTitle: css`
    font-size: 14px;
    font-weight: 600;
    color: #24292f;
    margin-bottom: 12px;
  `,
  dialogBody: css`
    font-size: 12px;
    color: #57606a;
    line-height: 1.5;

    p { margin: 0 0 8px; }
  `,
  missingList: css`
    margin: 4px 0 8px;
    padding-left: 16px;
    font-family: 'Cascadia Code', 'Consolas', monospace;
    font-size: 11px;
    color: #cf222e;

    li { margin: 2px 0; }
  `,
  dialogButtons: css`
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 16px;
  `,
};
