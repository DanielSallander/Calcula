//! FILENAME: app/extensions/CanvasSheet/components/InteractionIcons.tsx
// PURPOSE: Edit interactions' on-page chrome (P4 S10): a 2px outline round the
//          SOURCE visual and, on every other visual, a strip of Power BI's
//          interaction buttons -- Filter, Highlight (only where the visual can
//          paint one), None. The current mode is aria-pressed and bold.
// CONTEXT: Presentational only: lib/interactionOverlay.tsx computes the model
//          (positions in CSS px of the grid's canvas layer, the buttons, the
//          current mode, the reasons) and owns the mount. Each strip is DOM
//          stacked over the grid, so it carries the POINTER CLAIM
//          (@api/pointerClaims): without it Core takes the press and selects
//          the visual underneath (core/lib/pointerClaims.ts).
//
//          A visual that cannot follow the source (it reads cells, or another
//          model) shows ONE disabled None whose title says why.

import React from "react";
import { POINTER_CLAIM_ATTR } from "@api/pointerClaims";
import { RibbonIcon } from "@api/ribbonIcons";
import { ICON_SIZE_SM, LT } from "@api/layout";
import type { InteractionMode, VisualRef } from "@api/reportFilters";
import type { InteractionOverlayModel } from "../lib/interactionOverlay";

/** The claim's label (Core reads presence only; the value traces the owner). */
export const INTERACTION_POINTER_CLAIM = "canvas-edit-interactions";

const ICONS: Readonly<Record<InteractionMode, React.ReactNode>> = {
  filter: <RibbonIcon.InteractionFilter size={ICON_SIZE_SM} />,
  highlight: <RibbonIcon.InteractionHighlight size={ICON_SIZE_SM} />,
  none: <RibbonIcon.InteractionNone size={ICON_SIZE_SM} />,
};

const STRIP_STYLE: React.CSSProperties = {
  position: "absolute",
  transform: "translate(-100%, 0)",
  display: "flex",
  gap: 2,
  padding: 2,
  margin: "4px 0 0 -4px",
  background: LT.surface,
  border: `1px solid ${LT.border}`,
  borderRadius: 6,
  boxShadow: "0 1px 3px var(--shadow-color, rgba(0, 0, 0, 0.18))",
  pointerEvents: "auto",
};

function buttonStyle(pressed: boolean, disabled: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 26,
    height: 26,
    padding: 0,
    border: `${pressed ? 2 : 1}px solid ${pressed ? LT.pressedBorder : "transparent"}`,
    borderRadius: 4,
    background: pressed ? LT.pressed : LT.buttonBg,
    color: LT.text,
    fontWeight: pressed ? 700 : 400,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.45 : 1,
  };
}

export interface InteractionIconsProps {
  model: InteractionOverlayModel | null;
  onPick: (pageSheetId: string, source: VisualRef, target: VisualRef, mode: InteractionMode) => void;
}

export function InteractionIcons({ model, onPick }: InteractionIconsProps): React.ReactElement | null {
  if (!model) return null;
  const { sourceOutline } = model;
  return (
    <>
      {sourceOutline && (
        <div
          data-testid="canvas-interaction-source-outline"
          style={{
            position: "absolute",
            left: sourceOutline.left - 2,
            top: sourceOutline.top - 2,
            width: sourceOutline.width,
            height: sourceOutline.height,
            border: `2px solid ${LT.stateAccent}`,
            borderRadius: 2,
            pointerEvents: "none",
          }}
        />
      )}
      {model.strips.map((strip) => (
        <div
          key={strip.key}
          role="toolbar"
          aria-label={`Interaction of ${strip.target.kind} ${strip.target.id}`}
          data-testid={`canvas-interaction-${strip.target.kind}-${strip.target.id}`}
          {...{ [POINTER_CLAIM_ATTR]: INTERACTION_POINTER_CLAIM }}
          style={{ ...STRIP_STYLE, left: strip.right, top: strip.top }}
        >
          {strip.buttons.map((b) => (
            <button
              key={b.mode}
              type="button"
              data-testid={b.testId}
              aria-label={b.label}
              aria-pressed={b.pressed}
              title={b.title}
              disabled={b.disabled}
              style={buttonStyle(b.pressed, b.disabled)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                if (!b.disabled && !b.pressed) onPick(model.pageSheetId, model.source, strip.target, b.mode);
              }}
            >
              {ICONS[b.mode]}
            </button>
          ))}
        </div>
      ))}
    </>
  );
}
