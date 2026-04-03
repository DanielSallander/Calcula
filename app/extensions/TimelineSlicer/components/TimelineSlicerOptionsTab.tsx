//! FILENAME: app/extensions/TimelineSlicer/components/TimelineSlicerOptionsTab.tsx
// PURPOSE: Contextual ribbon tab for timeline slicer options.
// CONTEXT: Appears when a timeline slicer is selected on the grid.

import React, { useState, useEffect } from "react";
import { css } from "@emotion/css";
import { showDialog } from "@api";
import { useRibbonCollapse, RibbonGroup } from "@api/ribbonCollapse";
import { requestOverlayRedraw } from "@api/gridOverlays";
import { TimelineSlicerEvents } from "../lib/timelineSlicerEvents";
import {
  getTimelineById,
  updateTimelineAsync,
  deleteTimelineAsync,
  updateTimelineSelectionAsync,
} from "../lib/timelineSlicerStore";
import { getSelectedTimelineId } from "../handlers/selectionHandler";
import { TIMELINE_SETTINGS_DIALOG_ID } from "../manifest";
import type { TimelineSlicer, TimelineLevel } from "../lib/timelineSlicerTypes";

// ============================================================================
// Styles
// ============================================================================

const tabStyles = {
  container: css`
    display: flex;
    gap: 0;
    align-items: flex-start;
    height: 100%;
    width: 100%;
    min-width: 0;
    overflow: hidden;
    font-family: "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
    font-size: 12px;
  `,
  groupContent: css`
    display: flex;
    gap: 8px;
    align-items: center;
  `,
  button: css`
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 4px 10px;
    border: 1px solid transparent;
    border-radius: 4px;
    background: transparent;
    cursor: pointer;
    font-family: inherit;
    font-size: 11px;
    color: #333;
    white-space: nowrap;

    &:hover {
      background: #e8e8e8;
      border-color: #d0d0d0;
    }

    &:active {
      background: #d6d6d6;
    }
  `,
  buttonActive: css`
    background: #d6e4f0;
    border-color: #9fbfdf;

    &:hover {
      background: #c4d8ec;
    }
  `,
  buttonIcon: css`
    font-size: 22px;
    line-height: 1;
    height: 26px;
    display: flex;
    align-items: center;
    justify-content: center;
  `,
  buttonLabel: css`
    font-size: 10px;
    line-height: 1.2;
  `,
  levelButtons: css`
    display: flex;
    gap: 2px;
  `,
  levelBtn: css`
    padding: 4px 10px;
    border: 1px solid #ccc;
    border-radius: 3px;
    background: #f5f5f5;
    cursor: pointer;
    font-size: 10px;
    font-family: inherit;

    &:hover {
      background: #e8e8e8;
    }
  `,
  levelBtnActive: css`
    background: #4472c4;
    color: #fff;
    border-color: #4472c4;

    &:hover {
      background: #3a63a8;
    }
  `,
};

// ============================================================================
// Component
// ============================================================================

export function TimelineSlicerOptionsTab(): React.ReactElement {
  const [timeline, setTimeline] = useState<TimelineSlicer | null>(null);
  const collapsed = useRibbonCollapse(3);

  useEffect(() => {
    const handleUpdate = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (Array.isArray(detail) && detail.length > 0) {
        setTimeline(detail[0]);
      } else if (detail && !Array.isArray(detail)) {
        setTimeline(detail);
      }
    };

    const handleDeselect = () => setTimeline(null);

    window.addEventListener(TimelineSlicerEvents.TIMELINE_UPDATED, handleUpdate);
    window.addEventListener("timelineSlicer:deselected", handleDeselect);

    // Initialize from current selection
    const id = getSelectedTimelineId();
    if (id != null) {
      const tl = getTimelineById(id);
      if (tl) setTimeline(tl);
    }

    return () => {
      window.removeEventListener(TimelineSlicerEvents.TIMELINE_UPDATED, handleUpdate);
      window.removeEventListener("timelineSlicer:deselected", handleDeselect);
    };
  }, []);

  const handleLevelChange = async (level: TimelineLevel) => {
    if (!timeline) return;
    const updated = await updateTimelineAsync(timeline.id, { level });
    if (updated) setTimeline(updated);
    requestOverlayRedraw();
  };

  const handleClearFilter = async () => {
    if (!timeline) return;
    await updateTimelineSelectionAsync(timeline.id, null, null);
    const tl = getTimelineById(timeline.id);
    if (tl) setTimeline(tl);
  };

  const handleSettings = () => {
    if (!timeline) return;
    showDialog(TIMELINE_SETTINGS_DIALOG_ID, { timelineId: timeline.id });
  };

  const handleDelete = async () => {
    if (!timeline) return;
    await deleteTimelineAsync(timeline.id);
  };

  if (!timeline) {
    return <div className={tabStyles.container} />;
  }

  const levels: TimelineLevel[] = ["years", "quarters", "months", "days"];
  const levelLabels = ["Years", "Quarters", "Months", "Days"];

  return (
    <div className={tabStyles.container}>
      <RibbonGroup label="Level" icon="L" collapsed={collapsed[0]}>
        <div className={tabStyles.levelButtons}>
          {levels.map((level, i) => (
            <button
              key={level}
              className={`${tabStyles.levelBtn} ${
                timeline.level === level ? tabStyles.levelBtnActive : ""
              }`}
              onClick={() => handleLevelChange(level)}
              title={`Show ${levelLabels[i]}`}
            >
              {levelLabels[i]}
            </button>
          ))}
        </div>
      </RibbonGroup>

      <RibbonGroup label="Filter" icon="F" collapsed={collapsed[1]}>
        <div className={tabStyles.groupContent}>
          <button
            className={tabStyles.button}
            onClick={handleClearFilter}
            title="Clear the timeline filter"
            style={{
              opacity: timeline.selectionStart !== null ? 1 : 0.5,
            }}
          >
            <span className={tabStyles.buttonIcon}>
              <svg width="22" height="22" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M3 4h16l-5 6v5l-4 2V10z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/>
                <line x1="15" y1="15" x2="19" y2="19" stroke="#c42b1c" strokeWidth="2"/>
                <line x1="19" y1="15" x2="15" y2="19" stroke="#c42b1c" strokeWidth="2"/>
              </svg>
            </span>
            <span className={tabStyles.buttonLabel}>Clear Filter</span>
          </button>
        </div>
      </RibbonGroup>

      <RibbonGroup label="Timeline" icon="T" collapsed={collapsed[2]}>
        <div className={tabStyles.groupContent}>
          <button
            className={tabStyles.button}
            onClick={handleSettings}
            title="Timeline Settings"
          >
            <span className={tabStyles.buttonIcon}>
              <svg width="22" height="22" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M11 14a3 3 0 100-6 3 3 0 000 6z" stroke="currentColor" strokeWidth="1.4"/>
                <path d="M9.5 2.5l-.4 1.7a7 7 0 00-1.8 1l-1.6-.6L4.2 6.8l1.2 1.2a7 7 0 000 2l-1.2 1.2 1.5 2.2 1.6-.6a7 7 0 001.8 1l.4 1.7h3l.4-1.7a7 7 0 001.8-1l1.6.6 1.5-2.2-1.2-1.2a7 7 0 000-2l1.2-1.2-1.5-2.2-1.6.6a7 7 0 00-1.8-1l-.4-1.7z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
              </svg>
            </span>
            <span className={tabStyles.buttonLabel}>Settings</span>
          </button>
          <button
            className={tabStyles.button}
            onClick={handleDelete}
            title="Delete this Timeline"
            style={{ color: "#c42b1c" }}
          >
            <span className={tabStyles.buttonIcon}>&#x2716;</span>
            <span className={tabStyles.buttonLabel}>Delete</span>
          </button>
        </div>
      </RibbonGroup>
    </div>
  );
}
