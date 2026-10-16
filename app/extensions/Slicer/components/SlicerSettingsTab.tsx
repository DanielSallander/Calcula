//! FILENAME: app/extensions/Slicer/components/SlicerSettingsTab.tsx
// PURPOSE: The slicer's SETTINGS tab in the object pane (WP-C D-PANE: a
//          slicer's tab set is Settings | Format): the Slicer Settings body,
//          one column, each change committed at once.
// CONTEXT: The body is SlicerSettingsBody.tsx -- the dialog's own fields --
//          so the pane and "Slicer Settings..." cannot drift apart. Every change
//          is ONE "Slicer Settings" undo step through `commitSlicerSettings`
//          (with the dialog's level-change re-route and overwrite question),
//          sending only what changed. The tab re-reads the slicer whenever the
//          store says what it holds changed (an undo, a ribbon edit, a script),
//          so it never shows a value the slicer no longer has. On a subscribed
//          page every control is disabled with the pane's reason.

import React, { useCallback, useEffect, useState } from "react";
import { getSlicerById } from "../lib/slicerStore";
import { getSlicerComputedAttributes } from "../lib/slicer-api";
import { SlicerEvents } from "../lib/slicerEvents";
import {
  SlicerSettingsBody,
  commitSlicerSettings,
  slicerSettingsParams,
  slicerSettingsValuesOf,
  type SlicerSettingsValues,
} from "./SlicerSettingsBody";

export interface SlicerSettingsTabProps {
  slicerId: string;
  readOnly: boolean;
  readOnlyReason: string | null;
}

/** What the tab says when its slicer is gone. */
export const SLICER_SETTINGS_GONE = "This slicer no longer exists.";

export function SlicerSettingsTab({ slicerId, readOnly, readOnlyReason }: SlicerSettingsTabProps): React.ReactElement {
  const read = useCallback((): SlicerSettingsValues | null => {
    const slicer = getSlicerById(slicerId);
    return slicer ? slicerSettingsValuesOf(slicer) : null;
  }, [slicerId]);

  const [values, setValues] = useState<SlicerSettingsValues | null>(read);
  const [computedAttrs, setComputedAttrs] = useState<ReadonlySet<string>>(new Set());

  // Follow the store: whatever changed the slicer, the tab shows it.
  useEffect(() => {
    setValues(read());
    const refresh = (): void => setValues(read());
    window.addEventListener(SlicerEvents.SLICER_DATA_CHANGED, refresh);
    window.addEventListener(SlicerEvents.SLICER_UPDATED, refresh);
    return () => {
      window.removeEventListener(SlicerEvents.SLICER_DATA_CHANGED, refresh);
      window.removeEventListener(SlicerEvents.SLICER_UPDATED, refresh);
    };
  }, [read]);

  useEffect(() => {
    let live = true;
    getSlicerComputedAttributes(slicerId)
      .then((attrs) => {
        if (live) setComputedAttrs(new Set(attrs));
      })
      .catch((err) => console.warn("[Slicer] could not read the computed attributes:", err));
    return () => {
      live = false;
    };
  }, [slicerId]);

  const onChange = useCallback(
    (patch: Partial<SlicerSettingsValues>) => {
      if (readOnly) return;
      setValues((v) => (v ? { ...v, ...patch } : v));
      void commitSlicerSettings(slicerId, slicerSettingsParams(patch)).catch((err) =>
        console.error("[Slicer] the settings could not be saved:", err),
      );
    },
    [slicerId, readOnly],
  );

  if (!values) {
    return (
      <div data-testid="slicer-settings-tab" style={{ padding: "16px 12px", fontSize: 12 }}>
        {SLICER_SETTINGS_GONE}
      </div>
    );
  }

  return (
    <div data-testid="slicer-settings-tab" title={readOnly && readOnlyReason ? readOnlyReason : undefined}>
      <SlicerSettingsBody
        variant="pane"
        values={values}
        onChange={onChange}
        computedAttrs={computedAttrs}
        disabled={readOnly}
      />
    </div>
  );
}
