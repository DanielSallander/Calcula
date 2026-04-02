//! FILENAME: app/extensions/TimelineSlicer/components/TimelineSlicerSettingsDialog.tsx
// PURPOSE: Settings dialog for configuring timeline slicer properties.

import React, { useState, useEffect } from "react";
import { css } from "@emotion/css";
import type { DialogProps } from "../../../src/api";
import {
  getTimelineById,
  updateTimelineAsync,
} from "../lib/timelineSlicerStore";
import { requestOverlayRedraw } from "../../../src/api/gridOverlays";
import { TimelineStylesGallery } from "./TimelineSlicerStylesGallery";

// ============================================================================
// Styles
// ============================================================================

const styles = {
  overlay: css`
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
  `,
  dialog: css`
    background: #fff;
    border-radius: 8px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
    width: 400px;
    max-height: 520px;
    display: flex;
    flex-direction: column;
    font-family: "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
    font-size: 13px;
  `,
  header: css`
    padding: 16px 20px 12px;
    font-size: 15px;
    font-weight: 600;
    border-bottom: 1px solid #e8e8e8;
  `,
  body: css`
    flex: 1;
    overflow-y: auto;
    padding: 16px 20px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  `,
  fieldRow: css`
    display: flex;
    align-items: center;
    gap: 10px;
  `,
  fieldLabel: css`
    min-width: 100px;
    font-weight: 500;
    color: #333;
    font-size: 12px;
  `,
  fieldInput: css`
    flex: 1;
    padding: 5px 8px;
    border: 1px solid #ccc;
    border-radius: 4px;
    font-size: 13px;
  `,
  checkboxRow: css`
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 2px 0;
    label {
      cursor: pointer;
      user-select: none;
      font-size: 12px;
    }
  `,
  sectionLabel: css`
    font-weight: 600;
    color: #333;
    margin-top: 4px;
    margin-bottom: 4px;
  `,
  footer: css`
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 20px;
    border-top: 1px solid #e8e8e8;
  `,
  button: css`
    padding: 6px 20px;
    border: 1px solid #ccc;
    border-radius: 4px;
    background: #f5f5f5;
    font-size: 13px;
    cursor: pointer;
    &:hover {
      background: #e8e8e8;
    }
  `,
  buttonPrimary: css`
    padding: 6px 20px;
    border: 1px solid #4472c4;
    border-radius: 4px;
    background: #4472c4;
    color: #fff;
    font-size: 13px;
    cursor: pointer;
    &:hover {
      background: #3a63a8;
    }
  `,
};

// ============================================================================
// Component
// ============================================================================

export function TimelineSlicerSettingsDialog({
  isOpen,
  onClose,
  data,
}: DialogProps): React.ReactElement | null {
  const timelineId = data?.timelineId as number | undefined;

  const [name, setName] = useState("");
  const [headerText, setHeaderText] = useState("");
  const [showHeader, setShowHeader] = useState(true);
  const [showLevelSelector, setShowLevelSelector] = useState(true);
  const [showScrollbar, setShowScrollbar] = useState(true);
  const [stylePreset, setStylePreset] = useState("TimelineStyleLight1");

  useEffect(() => {
    if (isOpen && timelineId != null) {
      const tl = getTimelineById(timelineId);
      if (tl) {
        setName(tl.name);
        setHeaderText(tl.headerText ?? "");
        setShowHeader(tl.showHeader);
        setShowLevelSelector(tl.showLevelSelector);
        setShowScrollbar(tl.showScrollbar);
        setStylePreset(tl.stylePreset);
      }
    }
  }, [isOpen, timelineId]);

  const handleSave = async () => {
    if (timelineId == null) return;

    await updateTimelineAsync(timelineId, {
      name: name || undefined,
      headerText: headerText ? headerText : null,
      showHeader,
      showLevelSelector,
      showScrollbar,
      stylePreset,
    });

    requestOverlayRedraw();
    onClose();
  };

  if (!isOpen || timelineId == null) return null;

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>Timeline Settings</div>

        <div className={styles.body}>
          <div className={styles.fieldRow}>
            <span className={styles.fieldLabel}>Name:</span>
            <input
              className={styles.fieldInput}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className={styles.fieldRow}>
            <span className={styles.fieldLabel}>Header Text:</span>
            <input
              className={styles.fieldInput}
              value={headerText}
              onChange={(e) => setHeaderText(e.target.value)}
              placeholder="(uses name if empty)"
            />
          </div>

          <div className={styles.checkboxRow}>
            <input
              type="checkbox"
              id="tl-show-header"
              checked={showHeader}
              onChange={(e) => setShowHeader(e.target.checked)}
            />
            <label htmlFor="tl-show-header">Show Header</label>
          </div>

          <div className={styles.checkboxRow}>
            <input
              type="checkbox"
              id="tl-show-level"
              checked={showLevelSelector}
              onChange={(e) => setShowLevelSelector(e.target.checked)}
            />
            <label htmlFor="tl-show-level">Show Level Selector</label>
          </div>

          <div className={styles.checkboxRow}>
            <input
              type="checkbox"
              id="tl-show-scrollbar"
              checked={showScrollbar}
              onChange={(e) => setShowScrollbar(e.target.checked)}
            />
            <label htmlFor="tl-show-scrollbar">Show Scrollbar</label>
          </div>

          <div className={styles.sectionLabel}>Style:</div>
          <TimelineStylesGallery
            selected={stylePreset}
            onSelect={setStylePreset}
          />
        </div>

        <div className={styles.footer}>
          <button className={styles.button} onClick={onClose}>
            Cancel
          </button>
          <button className={styles.buttonPrimary} onClick={handleSave}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
