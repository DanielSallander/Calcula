//! FILENAME: app/extensions/BuiltIn/ObjectPane/components/cards/PropertiesCard.tsx
// PURPOSE: The Format tab's Properties card: Size (Width, Height, Lock aspect
//          ratio), Position (X, Y) and Padding (top, right, bottom, left).
// CONTEXT: Size and position are GEOMETRY, not format: they commit through
//          @api/objectGeometry (`commitObjectGeometry`, one "Size and Position"
//          undo step) and are DISABLED, with the reason shown under them,
//          wherever Core's own drag would refuse (`sizeAndPositionAvailability`:
//          Lock Objects, a locked object, a subscribed page, a run-mode
//          button). Lock aspect ratio and padding are container FORMAT: they
//          commit through @api/objectFormat and stay editable under Lock
//          Objects (the lock is about where objects ARE). Power BI's
//          "Responsive" and "Maintain layer order" are omitted on purpose
//          (selection never restacks objects here).

import React from "react";
import { commitObjectGeometry } from "@api/objectGeometry";
import { SIZE_AND_POSITION_UNDO_LABEL, sizeAndPositionAvailability } from "@api/objectPosition";
import { getGridRegions } from "@api/gridOverlays";
import { useFormatContext } from "../formatContext";
import { geometryChangeFor, type GeometryKey } from "../../lib/geometryRows";
import { fieldOffered } from "../../lib/formatValues";
import { NumberBox, NumberField } from "../fields/NumberField";
import { ToggleField } from "../fields/ToggleField";
import { PlainRow } from "../fields/FormatRow";
import { CardGroup, FormatCard } from "./FormatCard";
import { paneStyles } from "../paneStyles";

const GEOMETRY_ROWS: ReadonlyArray<{ key: GeometryKey; label: string; size: boolean }> = [
  { key: "width", label: "Width", size: true },
  { key: "height", label: "Height", size: true },
  { key: "x", label: "X position", size: false },
  { key: "y", label: "Y position", size: false },
];

export function PropertiesCard(): React.ReactElement {
  const ctx = useFormatContext();
  const { region, snapshot } = ctx;
  const availability = sizeAndPositionAvailability(region);
  const f = region.floating;
  const lockAspect = snapshot?.resolved.lockAspect === true;
  const caps = snapshot?.capabilities ?? null;
  const reason = availability.reason ?? (availability.move ? availability.sizeReason : null);

  const commitGeometry = (key: GeometryKey, value: number | null): void => {
    // Re-read the object and its rules at commit time: a lock, a detach or a
    // drag can land while the box has focus.
    const fresh = getGridRegions().find((r) => r.id === region.id) ?? region;
    const now = sizeAndPositionAvailability(fresh);
    const change = geometryChangeFor(fresh, key, value, lockAspect, now);
    if (!change) return;
    void commitObjectGeometry([change], SIZE_AND_POSITION_UNDO_LABEL);
  };

  const rowDisabled = (size: boolean): boolean => !availability.move || (size && !availability.resize);

  return (
    <FormatCard id="properties" title="Properties">
      <CardGroup title="Size" />
      {GEOMETRY_ROWS.filter((r) => r.size).map((r) => (
        <PlainRow key={r.key} fieldId={`geometry.${r.key}`} label={r.label}>
          <NumberBox
            value={f ? f[r.key] : null}
            onCommit={(n) => commitGeometry(r.key, n)}
            min={0}
            suffix="px"
            disabled={rowDisabled(r.size)}
            ariaLabel={r.label}
            testId={`format-geometry-${r.key}`}
            width={72}
          />
        </PlainRow>
      ))}
      {caps && fieldOffered(caps, "lockAspect") && <ToggleField fieldId="lockAspect" label="Lock aspect ratio" />}
      <CardGroup title="Position" />
      {GEOMETRY_ROWS.filter((r) => !r.size).map((r) => (
        <PlainRow key={r.key} fieldId={`geometry.${r.key}`} label={r.label}>
          <NumberBox
            value={f ? f[r.key] : null}
            onCommit={(n) => commitGeometry(r.key, n)}
            min={0}
            suffix="px"
            disabled={rowDisabled(r.size)}
            ariaLabel={r.label}
            testId={`format-geometry-${r.key}`}
            width={72}
          />
        </PlainRow>
      ))}
      {reason && (
        <div style={paneStyles.reason} role="note" data-testid="object-pane-geometry-reason">
          {reason}
        </div>
      )}
      {caps && fieldOffered(caps, "padding.top") && (
        <>
          <CardGroup title="Padding" />
          <NumberField fieldId="padding.top" label="Top" suffix="px" />
          <NumberField fieldId="padding.right" label="Right" suffix="px" />
          <NumberField fieldId="padding.bottom" label="Bottom" suffix="px" />
          <NumberField fieldId="padding.left" label="Left" suffix="px" />
        </>
      )}
    </FormatCard>
  );
}
