//! FILENAME: app/extensions/CanvasSheet/components/CanvasArrangeSection.tsx
// PURPOSE: The Canvas tab's ARRANGE section: stacking order (Bring Forward /
//          to Front, Send Backward / to Back), Align and Distribute, and Lock
//          -- acting on the canvas-wide selection, across families.
// CONTEXT: One tall row of heroes (the ribbon grammar's first sanctioned way
//          to fill the 61px box). Three are menus -- the most-used command is
//          the menu's FIRST item, so it is one click and Enter away -- and Lock
//          is a toggle that reads "Unlock" when every selected object is
//          locked.
//
//          Disabled, with the reason as the tooltip:
//            - on a SUBSCRIBED canvas (the layout is the publisher's), with the
//              same note every other Canvas section shows;
//            - with nothing selected;
//            - Distribute, below three objects (two objects have no gap to
//              even out).
//
//          The section follows the selection (@api/objectSelection) and the
//          canvas store (the lock state lives in the layout), so a selection
//          made by a click, the marquee or Tab is reflected at once.

import React, { useEffect, useState, useSyncExternalStore } from "react";
import type { PanelSectionProps } from "@api/uiTypes";
import {
  ActionRow,
  CommandButton,
  GAP_XS,
  HERO_ICON_SIZE,
  ICON_SIZE_SM,
  MenuButton,
  MenuItem,
  MenuSeparator,
} from "@api/layout";
import { RibbonIcon } from "@api/ribbonIcons";
import { getSelectedObjectRegions, onObjectSelectionChanged } from "@api/objectSelection";
import { getCanvasSheetSnapshot, subscribeCanvasSheets } from "../lib/canvasSheetStore";
import {
  ALIGN_LABELS,
  DISTRIBUTE_LABELS,
  DISTRIBUTE_MIN_OBJECTS,
  alignSelectedObjects,
  distributeSelectedObjects,
  type AlignEdge,
  type DistributeAxis,
} from "../lib/arrange";
import { STACKING_LABELS, allLocked, restackObjects, setObjectsLocked } from "../lib/zOrderStore";
import { NOTHING_SELECTED_NOTE, SUBSCRIBED_NOTE } from "../lib/canvasNotes";

/** Re-render on every selection change (a family's own, or the set's). */
function useSelectionTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => onObjectSelectionChanged(() => setTick((t) => t + 1)), []);
  return tick;
}

const ALIGN_ITEMS: ReadonlyArray<{ edge: AlignEdge; icon: React.ReactNode }> = [
  { edge: "left", icon: <RibbonIcon.AlignLeft size={ICON_SIZE_SM} /> },
  { edge: "center", icon: <RibbonIcon.AlignCenter size={ICON_SIZE_SM} /> },
  { edge: "right", icon: <RibbonIcon.AlignRight size={ICON_SIZE_SM} /> },
];

const ALIGN_ITEMS_VERTICAL: ReadonlyArray<{ edge: AlignEdge; icon: React.ReactNode }> = [
  { edge: "top", icon: <RibbonIcon.AlignTop size={ICON_SIZE_SM} /> },
  { edge: "middle", icon: <RibbonIcon.AlignMiddle size={ICON_SIZE_SM} /> },
  { edge: "bottom", icon: <RibbonIcon.AlignBottom size={ICON_SIZE_SM} /> },
];

const DISTRIBUTE_ITEMS: ReadonlyArray<{ axis: DistributeAxis; icon: React.ReactNode }> = [
  { axis: "horizontal", icon: <RibbonIcon.DistributeHorizontal size={ICON_SIZE_SM} /> },
  { axis: "vertical", icon: <RibbonIcon.DistributeVertical size={ICON_SIZE_SM} /> },
];

export function CanvasArrangeSection(_props: PanelSectionProps): React.ReactElement | null {
  const snapshot = useSyncExternalStore(subscribeCanvasSheets, getCanvasSheetSnapshot, getCanvasSheetSnapshot);
  useSelectionTick();
  const { active, activeSubscribed } = snapshot;
  if (!active) return null;

  const selected = getSelectedObjectRegions();
  const count = selected.length;
  const none = count === 0;
  const disabled = activeSubscribed || none;
  const why = activeSubscribed ? SUBSCRIBED_NOTE : none ? NOTHING_SELECTED_NOTE : null;
  const locked = !none && allLocked(selected);
  const canDistribute = count >= DISTRIBUTE_MIN_OBJECTS;

  return (
    <ActionRow gap={GAP_XS}>
      <MenuButton
        ariaLabel="Bring forward"
        trigger={
          <CommandButton
            icon={<RibbonIcon.BringForward size={HERO_ICON_SIZE} />}
            label="Bring Forward"
            chevron
            disabled={disabled}
            tooltip={why ?? "Bring the selected objects forward, or all the way to the front"}
            data-testid="canvas-arrange-forward"
          />
        }
      >
        <MenuItem
          icon={<RibbonIcon.BringForward size={ICON_SIZE_SM} />}
          testId="canvas-arrange-bring-forward"
          onSelect={() => void restackObjects("bringForward")}
        >
          {STACKING_LABELS.bringForward}
        </MenuItem>
        <MenuItem
          icon={<RibbonIcon.BringToFront size={ICON_SIZE_SM} />}
          testId="canvas-arrange-bring-to-front"
          onSelect={() => void restackObjects("bringToFront")}
        >
          {STACKING_LABELS.bringToFront}
        </MenuItem>
      </MenuButton>

      <MenuButton
        ariaLabel="Send backward"
        trigger={
          <CommandButton
            icon={<RibbonIcon.SendBackward size={HERO_ICON_SIZE} />}
            label="Send Backward"
            chevron
            disabled={disabled}
            tooltip={why ?? "Send the selected objects backward, or all the way to the back"}
            data-testid="canvas-arrange-backward"
          />
        }
      >
        <MenuItem
          icon={<RibbonIcon.SendBackward size={ICON_SIZE_SM} />}
          testId="canvas-arrange-send-backward"
          onSelect={() => void restackObjects("sendBackward")}
        >
          {STACKING_LABELS.sendBackward}
        </MenuItem>
        <MenuItem
          icon={<RibbonIcon.SendToBack size={ICON_SIZE_SM} />}
          testId="canvas-arrange-send-to-back"
          onSelect={() => void restackObjects("sendToBack")}
        >
          {STACKING_LABELS.sendToBack}
        </MenuItem>
      </MenuButton>

      <MenuButton
        ariaLabel="Align"
        trigger={
          <CommandButton
            icon={<RibbonIcon.AlignObjects size={HERO_ICON_SIZE} />}
            label="Align"
            chevron
            disabled={disabled}
            tooltip={
              why ??
              (count === 1
                ? "Align the selected object to the page, or distribute three or more"
                : "Line the selected objects up on an edge or centre, or space them evenly")
            }
            data-testid="canvas-arrange-align"
          />
        }
      >
        {[...ALIGN_ITEMS, ...ALIGN_ITEMS_VERTICAL].map((item, i) => (
          <React.Fragment key={item.edge}>
            {i === ALIGN_ITEMS.length && <MenuSeparator />}
            <MenuItem
              icon={item.icon}
              hint={count === 1 ? "to page" : undefined}
              testId={`canvas-arrange-align-${item.edge}`}
              onSelect={() => void alignSelectedObjects(item.edge)}
            >
              {ALIGN_LABELS[item.edge]}
            </MenuItem>
          </React.Fragment>
        ))}
        <MenuSeparator />
        {DISTRIBUTE_ITEMS.map((item) => (
          <MenuItem
            key={item.axis}
            icon={item.icon}
            disabled={!canDistribute}
            hint={canDistribute ? undefined : `${DISTRIBUTE_MIN_OBJECTS}+ objects`}
            testId={`canvas-arrange-distribute-${item.axis}`}
            onSelect={() => void distributeSelectedObjects(item.axis)}
          >
            {DISTRIBUTE_LABELS[item.axis]}
          </MenuItem>
        ))}
      </MenuButton>

      <CommandButton
        icon={<RibbonIcon.Lock size={HERO_ICON_SIZE} />}
        label={locked ? "Unlock" : "Lock"}
        active={locked}
        disabled={disabled}
        tooltip={
          why ??
          (locked
            ? "Unlock the selected objects so they can be moved and resized again"
            : "Lock the selected objects: they stay selectable but cannot be moved or resized")
        }
        data-testid="canvas-arrange-lock"
        onClick={() => void setObjectsLocked(!locked)}
      />
    </ActionRow>
  );
}
