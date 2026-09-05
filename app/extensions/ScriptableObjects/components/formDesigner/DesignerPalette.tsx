//! FILENAME: app/extensions/ScriptableObjects/components/formDesigner/DesignerPalette.tsx
// PURPOSE: The list of widget kinds, draggable onto the canvas and — the part
//          that decides whether this designer is usable at all — ADDABLE FROM
//          THE KEYBOARD.
// CONTEXT: M5b of docs/design/typescript-forms.md §14.
//
//          EVERY ENTRY IS A REAL `<button>`. It is in the tab order, Enter and
//          Space activate it without a line of code from us, and a screen reader
//          announces it as a button — none of which is true of a `<div>` with an
//          onClick, which is what a palette built around dragging tends to
//          become. The drag is added ON TOP of that button, not instead of it:
//          a user who cannot drag adds a widget by pressing it, and it lands
//          exactly where a drop at the end of the open container would.

import React from "react";

import { useDragPayload } from "../../../_shared/components/useDragDrop";
import type { FormWidgetType } from "@api/scriptHost/scriptFormSpec";

import { DESIGNER_DRAG_CHANNEL, type DesignerDrag } from "./designerDrag";
import { WIDGET_PALETTE, type PaletteEntry } from "./widgetPalette";
import * as S from "./designerStyles";

interface PaletteItemProps {
  entry: PaletteEntry;
  disabled: boolean;
  onAdd: (type: FormWidgetType) => void;
}

function PaletteItem({ entry, disabled, onAdd }: PaletteItemProps): React.ReactElement {
  const drag: DesignerDrag = { kind: "palette", widgetType: entry.type };
  const { isDragging, dragHandleProps } = useDragPayload<DesignerDrag, HTMLButtonElement>(
    DESIGNER_DRAG_CHANNEL,
    drag,
    entry.label,
  );
  return (
    <button
      {...dragHandleProps}
      type="button"
      className="ose-btn"
      data-testid={`designer-palette-${entry.type}`}
      data-widget-type={entry.type}
      disabled={disabled}
      // The press is the keyboard route AND the click route: dragging is
      // prevented by `useDragPayload` before the click ever fires, so a real
      // drag never also adds a widget at the end.
      onClick={() => onAdd(entry.type)}
      title={`${entry.hint}. Drag onto the form, or press to add it at the end.`}
      style={{ ...S.paletteButton, opacity: isDragging ? 0.5 : 1 }}
    >
      {entry.label}
    </button>
  );
}

export interface DesignerPaletteProps {
  disabled: boolean;
  onAdd: (type: FormWidgetType) => void;
}

export function DesignerPalette({ disabled, onAdd }: DesignerPaletteProps): React.ReactElement {
  const groups: Array<PaletteEntry["group"]> = ["Input", "Choice", "Layout", "Display"];
  return (
    <div style={{ ...S.panel, width: 150 }} data-testid="designer-palette" aria-label="Widgets">
      {groups.map((group) => (
        <div key={group}>
          <div style={S.sectionHeading}>{group}</div>
          {WIDGET_PALETTE.filter((entry) => entry.group === group).map((entry) => (
            <PaletteItem key={entry.type} entry={entry} disabled={disabled} onAdd={onAdd} />
          ))}
        </div>
      ))}
    </div>
  );
}
