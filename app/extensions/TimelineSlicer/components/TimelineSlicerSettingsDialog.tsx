//! FILENAME: app/extensions/TimelineSlicer/components/TimelineSlicerSettingsDialog.tsx
// PURPOSE: Settings dialog for configuring timeline slicer properties.
// CONTEXT: The fields are TimelineSettingsBody.tsx's -- the object pane's
//          Settings tab renders the same body (WP-C D-PANE).

import React, { useState, useEffect } from "react";
import { css } from "@emotion/css";
import type { DialogProps } from "@api";
import { useDialogWindow } from "@api/dialogWindow";
import {
  getTimelineById,
  updateTimelineAsync,
} from "../lib/timelineSlicerStore";
import { requestOverlayRedraw } from "@api/gridOverlays";
import {
  TimelineSettingsBody,
  timelineSettingsParams,
  timelineSettingsValuesOf,
  type TimelineSettingsValues,
} from "./TimelineSettingsBody";

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
  const timelineId = data?.timelineId as string | undefined;

  // Movable + resizable dialog window (shared @api hook)
  const win = useDialogWindow({ minWidth: 320, minHeight: 280 });

  const [values, setValues] = useState<TimelineSettingsValues>({
    name: "",
    headerText: "",
    showHeader: true,
    showLevelSelector: true,
    showScrollbar: true,
    stylePreset: "TimelineStyleLight1",
  });

  useEffect(() => {
    if (isOpen && timelineId != null) {
      const tl = getTimelineById(timelineId);
      if (tl) setValues(timelineSettingsValuesOf(tl));
    }
  }, [isOpen, timelineId]);

  const handleSave = async () => {
    if (timelineId == null) return;

    // Every field, as the dialog always sent them (an empty name is not sent;
    // an empty header text clears it back to the name).
    await updateTimelineAsync(timelineId, timelineSettingsParams(values));

    requestOverlayRedraw();
    onClose();
  };

  if (!isOpen || timelineId == null) return null;

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div
        ref={win.ref}
        className={styles.dialog}
        onClick={(e) => e.stopPropagation()}
        style={{ position: "relative", ...win.style }}
      >
        <div className={styles.header} onMouseDown={win.onHeaderMouseDown}>Timeline Settings</div>

        <div className={styles.body}>
          <TimelineSettingsBody
            variant="dialog"
            values={values}
            onChange={(patch) => setValues((v) => ({ ...v, ...patch }))}
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
        {win.resizeHandles}
      </div>
    </div>
  );
}
