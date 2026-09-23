//! FILENAME: app/src/api/layout/primitives/Segmented.tsx
// PURPOSE: The pill of the Calcula Clusters grammar — Segmented (a joined run
//          of controls: Bold | Italic | Underline) and SegmentedChoice (the
//          same pill as a radio group: Grouped | Stacked | 100%).
// CONTEXT: Before the redesign every tab drew its own button row with its own
//          gaps and borders, so related toggles read as loose icons. A
//          Segmented joins them into one control-height pill:
//
//          - The border is an INSET box-shadow, not a border, so the pill's
//            outer height is exactly its children's (28, or 61 for a tall
//            pill) and it lines up with unsegmented neighbours in a band row.
//            A real 1px border would make it 30px and break 28 + 5 + 28 = 61.
//          - Children lose their own radius except on the outer corners, and
//            every child after the first gets a 1px inset divider.
//          - A split IconButton (span.split > button.split-main +
//            button.split-chevron) is handled through the plain class hooks
//            Button.tsx renders beside its emotion classes, so a pill of split
//            toggles (the Chart Design "Elements" cluster) rounds and divides
//            correctly without reaching for hashed class names.
//
//          SPECIFICITY. Button's base rules are one class (0,1,0) and its
//          pseudo-state rules two or three (hover is `:hover:not(:disabled)`,
//          0,3,0). The child rules here are written with `&&` (the container
//          class twice) so they out-rank the base rules by specificity rather
//          than by stylesheet order: a Tile or ColorSwatch module that loads
//          AFTER this one must still lose its own radius inside a pill. The
//          divider rule ties with Button's :focus-visible ring at (0,2,0), so
//          the ring is restated at (0,3,0) below it — otherwise focusing any
//          child but the first would show a divider instead of a ring.
//
//          Colours come only from LT (../theme).

import React, { forwardRef, useRef } from "react";
import { css } from "@emotion/css";
import { LT } from "../theme";
import { CONTROL_HEIGHT_MD, CONTROL_HEIGHT_SM, TALL_CONTROL_HEIGHT } from "../tokens";
import { Button, IconButton, type IconButtonSize } from "./Button";
import { moveForKey, stepIndex } from "./roving";

// ============================================================================
// Segmented
// ============================================================================

/** "sm" 24, "md" 28, "tall" 61 (a pill that IS the cluster's one tall row);
 *  "auto" lets the children decide. */
export type SegmentedSize = "sm" | "md" | "tall" | "auto";

const SEGMENTED_HEIGHT: Record<Exclude<SegmentedSize, "auto">, number> = {
  sm: CONTROL_HEIGHT_SM,
  md: CONTROL_HEIGHT_MD,
  tall: TALL_CONTROL_HEIGHT,
};

const chrome = css`
  display: inline-flex;
  align-items: stretch;
  flex: none;
  box-sizing: border-box;
  vertical-align: middle;
  border-radius: ${LT.radiusControl};
  background: ${LT.surface};
  box-shadow: inset 0 0 0 1px ${LT.controlBorder};

  && > * {
    border-radius: 0;
  }

  && > *:first-child {
    border-top-left-radius: ${LT.radiusControl};
    border-bottom-left-radius: ${LT.radiusControl};
  }

  && > *:last-child {
    border-top-right-radius: ${LT.radiusControl};
    border-bottom-right-radius: ${LT.radiusControl};
  }

  && > * + * {
    box-shadow: inset 1px 0 0 ${LT.controlDivider};
  }

  /* The ring sits above the neighbours, which paint later in DOM order. */
  && > *:focus-visible {
    position: relative;
    z-index: 1;
    outline: none;
    box-shadow: ${LT.focusRing};
  }

  && > [aria-pressed="true"],
  && > [aria-checked="true"],
  && > [aria-selected="true"] {
    background: ${LT.pressed};
    border-color: ${LT.pressedBorder};
  }

  /* Split toggles: square every inner corner, round only the pill's ends. */
  && > .split > .split-main,
  && > .split > .split-chevron {
    border-radius: 0;
  }

  && > .split:first-child > .split-main {
    border-top-left-radius: ${LT.radiusControl};
    border-bottom-left-radius: ${LT.radiusControl};
  }

  && > .split:last-child > .split-chevron {
    border-top-right-radius: ${LT.radiusControl};
    border-bottom-right-radius: ${LT.radiusControl};
  }

  && > .split > button:focus-visible {
    position: relative;
    z-index: 1;
  }
`;

export interface SegmentedProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "role" | "aria-label"> {
  /** Accessible name of the run ("Emphasis", "Vertical alignment"). */
  ariaLabel: string;
  /** Pill height. Default "auto": the children's own height. */
  size?: SegmentedSize;
  /** ARIA role. Default "group"; SegmentedChoice passes "radiogroup",
   *  SegmentedTabs "tablist". */
  role?: string;
  children: React.ReactNode;
}

/**
 * A joined run of controls. Pass Buttons/IconButtons/ToggleButtons (or any
 * button-shaped primitive) of one size as direct children; the pill draws the
 * border, the dividers and the outer radius.
 */
export const Segmented = forwardRef<HTMLDivElement, SegmentedProps>(function Segmented(
  { ariaLabel, size = "auto", role = "group", className, style, children, ...rest },
  ref,
) {
  return (
    <div
      {...rest}
      ref={ref}
      role={role}
      aria-label={ariaLabel}
      data-size={size}
      className={[chrome, className].filter(Boolean).join(" ")}
      style={size === "auto" ? style : { height: SEGMENTED_HEIGHT[size], ...style }}
    >
      {children}
    </div>
  );
});

// ============================================================================
// SegmentedChoice — the pill as a radio group
// ============================================================================

export interface SegmentedChoiceOption<T> {
  value: T;
  /** Visible text, or (iconOnly) the accessible name and tooltip. */
  label: string;
  icon?: React.ReactNode;
  /** Tooltip content; icon-only options fall back to the label. */
  tooltip?: string;
  testId?: string;
  disabled?: boolean;
}

export interface SegmentedChoiceProps<T> {
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<SegmentedChoiceOption<T>>;
  /** Default "md". "auto" renders md children. */
  size?: SegmentedSize;
  /** Accessible name of the radio group. */
  ariaLabel: string;
  /** Render icons only (label becomes aria-label + tooltip). */
  iconOnly?: boolean;
  /** Rendered as data-testid on the radiogroup. */
  testId?: string;
  className?: string;
}

function iconButtonSize(size: SegmentedSize): IconButtonSize {
  return size === "auto" ? "md" : size;
}

/** A tall text option stacks its icon over its label, like a tile. */
const TALL_TEXT_STYLE: React.CSSProperties = {
  height: TALL_CONTROL_HEIGHT,
  flexDirection: "column",
  gap: 2,
};

/**
 * One value out of a few, as a pill. `role="radiogroup"` of
 * `role="radio"` buttons with a roving tab stop: exactly one option (the
 * checked one, else the first enabled) is in the tab order, and the arrow
 * keys, Home and End move focus AND select, skipping disabled options and
 * wrapping at the ends — the WAI-ARIA radio group pattern, so a keyboard user
 * crosses the whole control with one Tab.
 */
export function SegmentedChoice<T>({
  value,
  onChange,
  options,
  size = "md",
  ariaLabel,
  iconOnly = false,
  testId,
  className,
}: SegmentedChoiceProps<T>): React.ReactElement {
  const buttonsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const checkedIndex = options.findIndex((o) => Object.is(o.value, value));
  const disabled = options.map((o) => Boolean(o.disabled));
  const tabStop =
    checkedIndex >= 0 && !disabled[checkedIndex]
      ? checkedIndex
      : stepIndex("first", -1, disabled, false);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const move = moveForKey(e.key, "both");
    if (!move) return;
    const current = buttonsRef.current.findIndex((b) => b !== null && b === e.target);
    if (current < 0) return;
    e.preventDefault();
    const next = stepIndex(move, current, disabled, true);
    if (next < 0 || next === current) return;
    buttonsRef.current[next]?.focus();
    onChange(options[next].value);
  };

  const iconSize = iconButtonSize(size);
  const buttonSize = size === "sm" ? "sm" : "md";

  return (
    <Segmented
      role="radiogroup"
      ariaLabel={ariaLabel}
      size={size}
      className={className}
      data-testid={testId}
      onKeyDown={handleKeyDown}
    >
      {options.map((opt, i) => {
        const checked = i === checkedIndex;
        const setRef = (el: HTMLButtonElement | null) => {
          buttonsRef.current[i] = el;
        };
        const select = () => {
          if (!checked) onChange(opt.value);
        };
        const tabIndex = i === tabStop ? 0 : -1;

        if (iconOnly && opt.icon !== undefined && opt.icon !== null) {
          return (
            <IconButton
              key={i}
              ref={setRef}
              icon={opt.icon}
              label={opt.label}
              size={iconSize}
              tooltip={opt.tooltip}
              role="radio"
              aria-checked={checked}
              tabIndex={tabIndex}
              disabled={opt.disabled}
              data-testid={opt.testId}
              onClick={select}
            />
          );
        }

        return (
          <Button
            key={i}
            ref={setRef}
            size={buttonSize}
            icon={opt.icon}
            tooltip={opt.tooltip}
            role="radio"
            aria-checked={checked}
            tabIndex={tabIndex}
            disabled={opt.disabled}
            data-testid={opt.testId}
            onClick={select}
            style={size === "tall" ? TALL_TEXT_STYLE : undefined}
          >
            {opt.label}
          </Button>
        );
      })}
    </Segmented>
  );
}
