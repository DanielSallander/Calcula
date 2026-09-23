//! FILENAME: app/src/api/layout/primitives/toggles.tsx
// PURPOSE: Checkbox and Switch — the two on/off controls of the Calcula
//          Clusters control grammar.
// CONTEXT: Before the redesign every panel drew its own checkbox: a bare OS
//          <input> in one pane, a hand-rolled div with a CSS tick in another,
//          and none of them followed the skin (the OS box stays white in Dark).
//          These two are the one recipe, and both keep a REAL
//          <input type="checkbox"> underneath:
//
//          - The browser owns the semantics. Space toggles it, a wrapping
//            <label> makes the whole row clickable, a screen reader announces
//            "checkbox, checked" (or "switch, on" through role="switch") and
//            `indeterminate` is announced as "mixed" — none of it re-implemented.
//          - E2E journeys keep working. Playwright's check()/isChecked() and a
//            unit test's `input.checked` read the control that holds the state;
//            a div-based toggle would need a bespoke selector per surface.
//
//          Checkbox: the input itself is restyled (`appearance: none`, 16x16,
//          radius 4) and the tick is its ::after, drawn with two borders in
//          LT.onAccent. Chromium paints ::after on an appearance:none checkbox,
//          and WebView2 is Chromium, so no extra element is needed.
//
//          Switch: the input is visually hidden but NOT removed — it is an
//          opacity-0 layer over the whole row, so it stays the element every
//          click lands on (and stays visible to Playwright, which refuses to
//          click a zero-size box). The 30x16 track is a sibling span that reads
//          the input's state through `:checked + track`.
//
//          Row height follows the fill rule (../tokens.ts): exactly 28px in the
//          band, so two toggles stack into the 61px cluster box as 28 + 5 + 28;
//          at least 28px elsewhere, where a long label may wrap instead of
//          being cut off. Text is 11px in the band and 12px elsewhere.
//
//          Colours come only from LT (../theme). The layout tests scan what
//          this file renders for colour literals.

import React, { forwardRef, useCallback, useId, useLayoutEffect, useRef } from "react";
import { css } from "@emotion/css";
import { useSurfaceLayout } from "../context";
import { LT } from "../theme";
import { CONTROL_HEIGHT_MD, FONT_FAMILY, LABEL_FONT_SIZE } from "../tokens";
import { Tooltip } from "./Tooltip";

// ============================================================================
// Shared helpers
// ============================================================================

/** Join class names, skipping falsy parts. Joined rather than cx-merged so the
 *  cascade stays in module order, the same rule Button.tsx follows. */
function classNames(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function hasNode(node: React.ReactNode): boolean {
  return node !== null && node !== undefined && node !== false && node !== "";
}

/** Point a forwarded ref at a DOM node (the component also keeps its own). */
function assignRef<T>(ref: React.ForwardedRef<T>, value: T | null): void {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

/** Space above/below a 16px control inside a 28px row: (28 - 16) / 2. */
const CONTROL_INSET = (CONTROL_HEIGHT_MD - 16) / 2;

// ============================================================================
// Shared row styles
// ============================================================================

/** The <label> row both toggles render as. `position: relative` anchors the
 *  Switch's invisible input layer. */
const row = css`
  position: relative;
  display: inline-flex;
  gap: 7px;
  box-sizing: border-box;
  max-width: 100%;
  min-width: 0;
  font-family: ${FONT_FAMILY};
  font-weight: 400;
  line-height: 1;
  color: ${LT.text};
  cursor: pointer;
  user-select: none;
  vertical-align: middle;

  &[data-disabled="true"] {
    opacity: 0.5;
    cursor: default;
  }
`;

/** Band: exactly one 28px row, centred, 11px text. */
const rowBand = css`
  align-items: center;
  height: ${CONTROL_HEIGHT_MD}px;
  font-size: ${LABEL_FONT_SIZE}px;
`;

/** Panel/popover: at least one 28px row. The control is top-aligned with a
 *  fixed inset so it stays level with the FIRST line when the label wraps;
 *  on a single line the inset centres it exactly (6 + 16 + 6 = 28). */
const rowPanel = css`
  align-items: flex-start;
  min-height: ${CONTROL_HEIGHT_MD}px;
  font-size: 12px;
`;

const labelText = css`
  min-width: 0;
`;

/** Band text never wraps: a second line would break the 28px row. */
const labelTextBand = css`
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

/** Panel text wraps; 16px lines + 6px padding = one 28px row. */
const labelTextPanel = css`
  padding: ${CONTROL_INSET}px 0;
  line-height: 16px;
`;

/** Top inset for the 16px box / track in a panel row (see rowPanel). */
const controlPanelInset = css`
  margin-top: ${CONTROL_INSET}px;
`;

// ============================================================================
// Checkbox
// ============================================================================

/** The 16x16 box: the real input, restyled. The tick and the indeterminate
 *  bar are its ::after, painted in LT.onAccent on the accent fill. */
const box = css`
  appearance: none;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: 16px;
  height: 16px;
  margin: 0;
  border: 1px solid ${LT.controlBorder};
  border-radius: 4px;
  background: ${LT.surface};
  cursor: inherit;
  transition:
    background-color ${LT.motionHover},
    border-color ${LT.motionHover},
    box-shadow ${LT.motionHover};

  &:focus-visible {
    outline: none;
    box-shadow: ${LT.focusRing};
  }

  &:checked,
  &:indeterminate {
    background: ${LT.stateAccent};
    border-color: ${LT.stateAccent};
  }

  &:checked::after {
    content: "";
    box-sizing: border-box;
    width: 8px;
    height: 4px;
    margin-top: -2px;
    border-left: 2px solid ${LT.onAccent};
    border-bottom: 2px solid ${LT.onAccent};
    transform: rotate(-45deg);
  }

  /* After :checked, so a box that is both shows the bar, which is what the
     DOM reports (indeterminate wins over checked for display). */
  &:indeterminate::after {
    content: "";
    box-sizing: border-box;
    width: 8px;
    height: 2px;
    margin-top: 0;
    border: 0;
    border-radius: 1px;
    background: ${LT.onAccent};
    transform: none;
  }
`;

/** Hovering anywhere on the row (the whole row toggles) firms up an unchecked
 *  box's border, so the hit area announces itself.
 *
 *  Structural selectors, never `.${box}`: @emotion/css treats an interpolated
 *  class name as COMPOSITION and splices that class's declarations into the
 *  selector, producing a rule the browser discards. The row renders exactly
 *  one input, so `> input` is unambiguous. */
const checkboxRow = css`
  &:hover:not([data-disabled="true"]) > input:not(:checked):not(:indeterminate) {
    border-color: ${LT.textTertiary};
  }
`;

export interface CheckboxProps
  extends Omit<
    React.InputHTMLAttributes<HTMLInputElement>,
    "type" | "checked" | "defaultChecked" | "onChange" | "children"
  > {
  /** Whether the box is ticked. Controlled: the caller owns the state. */
  checked: boolean;
  /** Called with the new state when the user toggles the box. */
  onChange: (checked: boolean) => void;
  /** The visible label; clicking it toggles the box. */
  label: React.ReactNode;
  /** Show the "mixed" bar (some but not all of a set). A click still reports
   *  `!checked`; the caller decides what mixed resolves to. */
  indeterminate?: boolean;
  /** Extra explanation shown on hover, and given to assistive tech as the
   *  input's description (a hover tooltip alone never reaches the keyboard). */
  tooltip?: React.ReactNode;
  /** data-testid for the <input> — the element that holds the state. */
  testId?: string;
}

/**
 * A labelled checkbox. HTML props (id, name, aria-*, onFocus...) and the
 * forwarded ref go to the <input>; `className` and `style` go to the <label>
 * row, which is the box a layout positions.
 */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  {
    checked,
    onChange,
    label,
    indeterminate = false,
    tooltip,
    testId,
    disabled,
    className,
    style,
    ...rest
  },
  ref,
) {
  const layout = useSurfaceLayout();
  const band = layout.container === "band";
  const descriptionId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const setInput = useCallback(
    (el: HTMLInputElement | null) => {
      inputRef.current = el;
      assignRef(ref, el);
    },
    [ref],
  );

  // `indeterminate` is a DOM property with no HTML attribute, so React cannot
  // render it. It is written after EVERY commit (no dependency list) because a
  // click clears it natively; a caller that keeps passing `indeterminate`
  // gets it back on the next render.
  useLayoutEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate;
  });

  const describe = hasNode(tooltip);
  const describedBy = describe
    ? [rest["aria-describedby"], descriptionId].filter(Boolean).join(" ")
    : rest["aria-describedby"];

  return (
    <Tooltip content={tooltip}>
      <label
        className={classNames(row, band ? rowBand : rowPanel, checkboxRow, className)}
        style={style}
        data-disabled={disabled ? "true" : undefined}
      >
        <input
          data-testid={testId}
          {...rest}
          ref={setInput}
          type="checkbox"
          className={classNames(box, !band && controlPanelInset)}
          checked={checked}
          disabled={disabled}
          aria-describedby={describedBy}
          onChange={(e) => {
            onChange(e.target.checked);
            // Re-assert at once so a caller that does not re-render (it keeps
            // the mixed state) never shows a stale tick.
            e.currentTarget.indeterminate = indeterminate;
          }}
        />
        {hasNode(label) && (
          <span className={classNames(labelText, band ? labelTextBand : labelTextPanel)}>
            {label}
          </span>
        )}
        {describe && (
          <span id={descriptionId} hidden>
            {tooltip}
          </span>
        )}
      </label>
    </Tooltip>
  );
});

// ============================================================================
// Switch
// ============================================================================

/** Width and height of the track; the thumb travels TRACK_W - TRACK_H. */
const TRACK_W = 30;
const TRACK_H = 16;
const THUMB = 12;
const THUMB_INSET = (TRACK_H - THUMB) / 2;

/** The 30x16 pill; its ::after is the 12px thumb. */
const track = css`
  position: relative;
  flex: none;
  box-sizing: border-box;
  width: ${TRACK_W}px;
  height: ${TRACK_H}px;
  border-radius: ${TRACK_H / 2}px;
  background: ${LT.controlTrack};
  transition:
    background-color ${LT.motionHover},
    box-shadow ${LT.motionHover};

  &::after {
    content: "";
    position: absolute;
    top: ${THUMB_INSET}px;
    left: ${THUMB_INSET}px;
    width: ${THUMB}px;
    height: ${THUMB}px;
    border-radius: 50%;
    background: ${LT.onAccent};
    box-shadow: ${LT.shadowClusterHover};
    transition: transform ${LT.motionHover};
  }
`;

/** The real input, as an invisible layer over the whole row: every click on
 *  the row lands on it, and it keeps its focus and checked semantics.
 *
 *  The track is reached as `+ span` (the element rendered right after the
 *  input), not `+ .${track}`: @emotion/css treats an interpolated class name
 *  as composition and would splice the track's declarations into the
 *  selector. See checkboxRow above. */
const switchInput = css`
  position: absolute;
  inset: 0;
  z-index: 1;
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 0;
  opacity: 0;
  cursor: inherit;

  &:checked + span {
    background: ${LT.stateAccent};
  }

  &:checked + span::after {
    transform: translateX(${TRACK_W - TRACK_H}px);
  }

  &:focus-visible + span {
    box-shadow: ${LT.focusRing};
  }
`;

export interface SwitchProps
  extends Omit<
    React.InputHTMLAttributes<HTMLInputElement>,
    "type" | "checked" | "defaultChecked" | "onChange" | "children" | "role"
  > {
  /** On (true) or off. Controlled: the caller owns the state. */
  checked: boolean;
  /** Called with the new state when the user flips the switch. */
  onChange: (checked: boolean) => void;
  /** The visible label, after the track. */
  label: React.ReactNode;
  /** Extra explanation shown on hover. */
  tooltip?: React.ReactNode;
  /** data-testid for the <input role="switch"> — the element holding state. */
  testId?: string;
}

/**
 * An on/off switch for a setting that takes effect at once ("2nd axis").
 * Use a Checkbox for a choice that is part of a larger form or a list.
 * HTML props and the ref go to the <input>; className/style to the row.
 */
export const Switch = forwardRef<HTMLInputElement, SwitchProps>(function Switch(
  { checked, onChange, label, tooltip, testId, disabled, className, style, ...rest },
  ref,
) {
  const layout = useSurfaceLayout();
  const band = layout.container === "band";

  return (
    <Tooltip content={tooltip}>
      <label
        className={classNames(row, band ? rowBand : rowPanel, className)}
        style={style}
        data-disabled={disabled ? "true" : undefined}
      >
        <input
          data-testid={testId}
          {...rest}
          ref={ref}
          type="checkbox"
          role="switch"
          className={switchInput}
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className={classNames(track, !band && controlPanelInset)} aria-hidden />
        {hasNode(label) && (
          <span className={classNames(labelText, band ? labelTextBand : labelTextPanel)}>
            {label}
          </span>
        )}
      </label>
    </Tooltip>
  );
});
