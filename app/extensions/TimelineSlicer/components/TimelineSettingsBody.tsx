//! FILENAME: app/extensions/TimelineSlicer/components/TimelineSettingsBody.tsx
// PURPOSE: The Timeline Settings FIELDS -- name, header text, show header,
//          show level selector, show scrollbar and style -- lifted out of
//          TimelineSlicerSettingsDialog.tsx so the dialog and the object
//          pane's Settings tab (WP-C D-PANE) render the SAME controls.
// CONTEXT: Two hosts, one body:
//            "dialog" -- every field, edited as a draft and saved on OK
//                        (unchanged behaviour);
//            "pane"   -- the object pane's Settings tab: the name and the two
//                        "show" toggles, each change saved AT ONCE (a name
//                        when its box is left or Enter is pressed). The header
//                        text / show header are the container's TITLE there,
//                        edited on the Format tab, and the style is the Format
//                        tab's Style card -- one editor per fact in the pane.

import React, { useEffect, useState } from "react";
import { css } from "@emotion/css";
import { LT } from "@api/layout";
import { TimelineStylesGallery } from "./TimelineSlicerStylesGallery";
import type { TimelineSlicer, UpdateTimelineParams } from "../lib/timelineSlicerTypes";

// ============================================================================
// The values
// ============================================================================

/** Everything the settings body edits. */
export interface TimelineSettingsValues {
  name: string;
  /** "" = the timeline's name. */
  headerText: string;
  showHeader: boolean;
  showLevelSelector: boolean;
  showScrollbar: boolean;
  stylePreset: string;
}

/** A timeline's current settings. */
export function timelineSettingsValuesOf(tl: TimelineSlicer): TimelineSettingsValues {
  return {
    name: tl.name,
    headerText: tl.headerText ?? "",
    showHeader: tl.showHeader,
    showLevelSelector: tl.showLevelSelector,
    showScrollbar: tl.showScrollbar,
    stylePreset: tl.stylePreset,
  };
}

/** The update params for some settings (only the keys `values` carries; an empty name is not sent). */
export function timelineSettingsParams(values: Partial<TimelineSettingsValues>): UpdateTimelineParams {
  const out: UpdateTimelineParams = {};
  if (values.name !== undefined && values.name !== "") out.name = values.name;
  if (values.headerText !== undefined) out.headerText = values.headerText ? values.headerText : null;
  if (values.showHeader !== undefined) out.showHeader = values.showHeader;
  if (values.showLevelSelector !== undefined) out.showLevelSelector = values.showLevelSelector;
  if (values.showScrollbar !== undefined) out.showScrollbar = values.showScrollbar;
  if (values.stylePreset !== undefined) out.stylePreset = values.stylePreset;
  return out;
}

// ============================================================================
// The body
// ============================================================================

export type TimelineSettingsVariant = "dialog" | "pane";

export interface TimelineSettingsBodyProps {
  values: TimelineSettingsValues;
  onChange(patch: Partial<TimelineSettingsValues>): void;
  variant: TimelineSettingsVariant;
  /** Every control disabled (a subscribed page). */
  disabled?: boolean;
}

const styles = {
  body: css`
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
};

/** The pane's colours follow the skin (LT); the dialog keeps its own light palette. */
const paneStyles = {
  body: css`
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 8px 12px 12px;
    font-size: 12px;
    color: ${LT.text};
  `,
  fieldLabel: css`
    min-width: 96px;
    color: ${LT.textSecondary};
    font-size: 12px;
  `,
  fieldInput: css`
    flex: 1;
    min-width: 0;
    height: 24px;
    padding: 0 6px;
    border: 1px solid ${LT.controlBorder};
    border-radius: 4px;
    background: ${LT.inputBg};
    color: ${LT.text};
    font-size: 12px;
  `,
};

/** The settings controls, laid out for their host. */
export function TimelineSettingsBody({
  values,
  onChange,
  variant,
  disabled = false,
}: TimelineSettingsBodyProps): React.ReactElement {
  const pane = variant === "pane";
  const idPrefix = pane ? "tl-pane" : "tl";

  // The pane commits a typed name once (blur / Enter), never per keystroke.
  const [nameDraft, setNameDraft] = useState(values.name);
  useEffect(() => setNameDraft(values.name), [values.name]);
  const commitName = (text: string): void => {
    const next = text.trim();
    if (next === "" || next === values.name) {
      setNameDraft(values.name);
      return;
    }
    onChange({ name: next });
  };

  const checkbox = (key: "showHeader" | "showLevelSelector" | "showScrollbar", label: string) => (
    <div className={styles.checkboxRow} data-setting={key}>
      <input
        type="checkbox"
        id={`${idPrefix}-${key}`}
        checked={values[key]}
        disabled={disabled}
        onChange={(e) => onChange({ [key]: e.target.checked } as Partial<TimelineSettingsValues>)}
        data-testid={`timeline-setting-${key}`}
      />
      <label htmlFor={`${idPrefix}-${key}`}>{label}</label>
    </div>
  );

  if (pane) {
    return (
      <div className={paneStyles.body} data-testid="timeline-settings-body" data-variant="pane">
        <div className={styles.fieldRow} data-setting="name">
          <span className={paneStyles.fieldLabel}>Name</span>
          <input
            className={paneStyles.fieldInput}
            value={nameDraft}
            disabled={disabled}
            aria-label="Name"
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={(e) => commitName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitName((e.target as HTMLInputElement).value);
            }}
            data-testid="timeline-setting-name"
          />
        </div>
        {checkbox("showLevelSelector", "Show level selector")}
        {checkbox("showScrollbar", "Show scrollbar")}
      </div>
    );
  }

  return (
    <div className={styles.body} data-testid="timeline-settings-body" data-variant="dialog">
      <div className={styles.fieldRow}>
        <span className={styles.fieldLabel}>Name:</span>
        <input
          className={styles.fieldInput}
          value={values.name}
          disabled={disabled}
          onChange={(e) => onChange({ name: e.target.value })}
        />
      </div>

      <div className={styles.fieldRow}>
        <span className={styles.fieldLabel}>Header Text:</span>
        <input
          className={styles.fieldInput}
          value={values.headerText}
          disabled={disabled}
          onChange={(e) => onChange({ headerText: e.target.value })}
          placeholder="(uses name if empty)"
        />
      </div>

      {checkbox("showHeader", "Show Header")}
      {checkbox("showLevelSelector", "Show Level Selector")}
      {checkbox("showScrollbar", "Show Scrollbar")}

      <div className={styles.sectionLabel}>Style:</div>
      <TimelineStylesGallery selected={values.stylePreset} onSelect={(stylePreset) => onChange({ stylePreset })} />
    </div>
  );
}
