//! FILENAME: app/src/api/layout/primitives/Chip.tsx
// PURPOSE: The 24px pill that shows a short piece of STATE — "Loop: On",
//          "3 of 12", an active filter with a remove button.
// CONTEXT: A chip reports; a button acts. Before the Clusters redesign the
//          ribbon mixed the two, so a status read like a command and a filter
//          pill looked like neither. This is the one recipe, taken from the
//          mockup's `.cal-chip`:
//
//            neutral  LT.chipBg + inset 1px LT.chipBorder, LT.textSecondary text
//            tones    LT.<tone>Bg with LT.<tone>Fg text, no border (info/ok/warn/danger)
//            <b>      600 weight in the primary colour (the tone colour on a tone)
//
//          so `<Chip value="On">Loop</Chip>` renders "Loop: **On**" and
//          `<Chip tone="info"><b>3</b> of 12</Chip>` renders "**3** of 12".
//
//          It becomes interactive only when asked to:
//          - `onClick` renders the pill AS a <button> (with aria-pressed when
//            `active` is given), so a chip can open a menu or toggle a filter.
//          - `onRemove` adds a trailing 16px close button. A button cannot
//            contain another button, so a chip that is BOTH clickable and
//            removable renders a <span> pill holding two sibling buttons; the
//            pill chrome stays on the span and the hover tint of whichever
//            half is under the pointer layers over it.
//
//          Hover and press tint with `background-image` over the tone's
//          `background-color`, never by replacing it: the tints are
//          translucent, and a bare translucent fill would drop the tone colour.
//
//          Colours come only from LT (../theme); the layout tests scan what
//          this file renders for colour literals.

import React, { forwardRef } from "react";
import { css } from "@emotion/css";
import { LT } from "../theme";
import { CONTROL_HEIGHT_SM, FONT_FAMILY, LABEL_FONT_SIZE } from "../tokens";
import { DropdownChevron } from "./Button";
import { Tooltip } from "./Tooltip";

// ============================================================================
// Types
// ============================================================================

export type ChipTone = "neutral" | "info" | "ok" | "warn" | "danger";

export interface ChipProps
  extends Omit<React.HTMLAttributes<HTMLElement>, "children" | "onClick" | "title"> {
  /** The chip's text (or the name half of a name/value pair). */
  children: React.ReactNode;
  /** A value shown after the children in bold: "Loop: **On**". */
  value?: React.ReactNode;
  /** neutral (default) = plain state; info/ok/warn/danger = a toned status. */
  tone?: ChipTone;
  /** Leading icon, sized by the caller (14 fits the 24px pill). */
  icon?: React.ReactNode;
  /** Selected/on look (a filter chip that is applied). Announced through
   *  aria-pressed when the chip is clickable. */
  active?: boolean;
  /** Makes the chip a <button>. */
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  /** Adds a trailing close button that calls this. */
  onRemove?: () => void;
  /** aria-label and tooltip of the close button. Default "Remove". */
  removeLabel?: string;
  /** Show a dropdown chevron (the chip opens a menu or a list). */
  chevron?: boolean;
  /** Native title on the pill. */
  title?: string;
  /** data-testid on the pill; the close button gets `${testId}-remove`. */
  testId?: string;
  /** Disable the clickable and removable parts (the one disabled idiom). */
  disabled?: boolean;
}

// ============================================================================
// Styles
// ============================================================================

const pill = css`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  box-sizing: border-box;
  flex: none;
  height: ${CONTROL_HEIGHT_SM}px;
  max-width: 100%;
  margin: 0;
  padding: 0 9px;
  border: none;
  border-radius: ${LT.radiusPill};
  font-family: ${FONT_FAMILY};
  font-size: ${LABEL_FONT_SIZE}px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  vertical-align: middle;
  transition:
    background-color ${LT.motionHover},
    box-shadow ${LT.motionHover};

  & b {
    font-weight: 600;
  }

  &[data-disabled="true"] {
    opacity: 0.5;
    cursor: default;
  }
`;

const tones: Record<ChipTone, string> = {
  neutral: css`
    background-color: ${LT.chipBg};
    color: ${LT.textSecondary};
    box-shadow: inset 0 0 0 1px ${LT.chipBorder};

    & b {
      color: ${LT.text};
    }
  `,
  info: css`
    background-color: ${LT.infoBg};
    color: ${LT.infoFg};
    box-shadow: none;

    & b {
      color: ${LT.infoFg};
    }
  `,
  ok: css`
    background-color: ${LT.okBg};
    color: ${LT.okFg};
    box-shadow: none;

    & b {
      color: ${LT.okFg};
    }
  `,
  warn: css`
    background-color: ${LT.warnBg};
    color: ${LT.warnFg};
    box-shadow: none;

    & b {
      color: ${LT.warnFg};
    }
  `,
  danger: css`
    background-color: ${LT.dangerBg};
    color: ${LT.dangerFg};
    box-shadow: none;

    & b {
      color: ${LT.dangerFg};
    }
  `,
};

/** The on look, above any tone (two-part selector out-ranks a tone class). */
const activeLook = css`
  &[data-active="true"] {
    background-color: ${LT.pressed};
    box-shadow: inset 0 0 0 1px ${LT.pressedBorder};
    color: ${LT.text};
  }
`;

/** The states of whichever element is the click target. Declared after the
 *  tone and active rules so the focus ring wins over the chip's own inset
 *  border while focused. */
const clickable = css`
  cursor: pointer;

  &:hover:not(:disabled) {
    background-image: linear-gradient(${LT.hover}, ${LT.hover});
  }

  &:active:not(:disabled) {
    background-image: linear-gradient(${LT.active}, ${LT.active});
  }

  &:focus-visible {
    outline: none;
    box-shadow: ${LT.focusRing};
  }

  /* Never dimmed here: the PILL carries the one disabled idiom
     (data-disabled -> opacity .5), and dimming the half inside it as well
     would compound to .25. */
  &:disabled {
    cursor: default;
  }
`;

/** A pill that holds a close button: 4px from the right edge, so the 16px
 *  button sits in the 24px pill with equal space around it. */
const removablePill = css`
  padding-right: 4px;
`;

/** Clickable AND removable: the main half fills the pill's left side. */
const splitPill = css`
  gap: 0;
  padding-left: 0;
`;

/** The main half of a clickable+removable chip. Transparent, so the pill's
 *  tone shows through and its own hover tint layers over it. */
const mainHalf = css`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  align-self: stretch;
  min-width: 0;
  margin: 0;
  padding: 0 4px 0 9px;
  border: none;
  border-radius: ${LT.radiusPill};
  background-color: transparent;
  color: inherit;
  font: inherit;
`;

const removeButton = css`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  box-sizing: border-box;
  width: 16px;
  height: 16px;
  margin: 0;
  padding: 0;
  border: none;
  border-radius: 50%;
  background-color: transparent;
  color: inherit;
  cursor: pointer;
  transition: background-color ${LT.motionHover};

  &:hover:not(:disabled) {
    background-color: ${LT.hover};
  }

  &:active:not(:disabled) {
    background-color: ${LT.active};
  }

  &:focus-visible {
    outline: none;
    box-shadow: ${LT.focusRing};
  }

  &:disabled {
    cursor: default;
  }
`;

const slot = css`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
`;

/** The text needs its own box to truncate: a flex container cannot ellipsis
 *  the anonymous text inside it. */
const text = css`
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
`;

// ============================================================================
// Helpers
// ============================================================================

function classNames(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function hasNode(node: React.ReactNode): boolean {
  return node !== null && node !== undefined && node !== false && node !== "";
}

/** "Loop" + "On" reads "Loop: On"; a name that already ends in a colon does
 *  not get a second one. */
function nameValueSeparator(name: React.ReactNode): string {
  return typeof name === "string" && name.trimEnd().endsWith(":") ? " " : ": ";
}

/** A 10px close glyph on the 24-unit grid; strokes 3 units, round caps. */
function CloseGlyph(): React.ReactElement {
  return (
    <svg width={10} height={10} viewBox="0 0 24 24" fill="none" aria-hidden style={{ display: "block" }}>
      <path
        d="M6.5 6.5l11 11M17.5 6.5l-11 11"
        stroke="currentColor"
        strokeWidth={3.2}
        strokeLinecap="round"
      />
    </svg>
  );
}

// ============================================================================
// Component
// ============================================================================

/**
 * A status pill. Static by default; `onClick` makes it a button, `onRemove`
 * adds a close button. HTML props (aria-*, data-*, handlers) go to the pill;
 * in the clickable+removable form the popup attributes a MenuButton adds
 * (aria-expanded / aria-haspopup / aria-controls) go to the clickable half.
 * The forwarded ref always reaches the pill.
 */
export const Chip = forwardRef<HTMLElement, ChipProps>(function Chip(
  {
    children,
    value,
    tone = "neutral",
    icon,
    active,
    onClick,
    onRemove,
    removeLabel,
    chevron,
    title,
    testId,
    disabled,
    className,
    ...rest
  },
  ref,
) {
  const clickableChip = onClick !== undefined;
  const removable = onRemove !== undefined;
  const closeLabel = removeLabel ?? "Remove";

  const body = (
    <>
      {hasNode(icon) && (
        <span className={slot} aria-hidden>
          {icon}
        </span>
      )}
      <span className={text}>
        {children}
        {hasNode(value) && (
          <>
            {nameValueSeparator(children)}
            <b>{value}</b>
          </>
        )}
      </span>
      {chevron && (
        <span className={slot} aria-hidden>
          <DropdownChevron size={7} />
        </span>
      )}
    </>
  );

  const pillClass = classNames(pill, tones[tone], activeLook, className);
  const activeAttr = active ? "true" : undefined;

  // ---- A clickable chip with no remove button: the pill IS the button. ----
  if (clickableChip && !removable) {
    return (
      <button
        type="button"
        data-testid={testId}
        {...rest}
        ref={ref as React.Ref<HTMLButtonElement>}
        className={classNames(pillClass, clickable)}
        title={title}
        disabled={disabled}
        data-active={activeAttr}
        data-disabled={disabled ? "true" : undefined}
        aria-pressed={active ?? rest["aria-pressed"]}
        onClick={onClick}
      >
        {body}
      </button>
    );
  }

  // ---- A static chip: a plain span. ----
  if (!removable) {
    return (
      <span
        data-testid={testId}
        {...rest}
        ref={ref as React.Ref<HTMLSpanElement>}
        className={pillClass}
        title={title}
        data-active={activeAttr}
        data-disabled={disabled ? "true" : undefined}
      >
        {body}
      </span>
    );
  }

  // ---- Removable: a span pill with a trailing close button, and (when
  //      clickable) a main half as a sibling button. ----
  const {
    "aria-expanded": ariaExpanded,
    "aria-haspopup": ariaHasPopup,
    "aria-controls": ariaControls,
    "aria-pressed": ariaPressed,
    ...pillRest
  } = rest;

  return (
    <span
      data-testid={testId}
      {...pillRest}
      ref={ref as React.Ref<HTMLSpanElement>}
      className={classNames(pillClass, removablePill, clickableChip && splitPill)}
      title={title}
      data-active={activeAttr}
      data-disabled={disabled ? "true" : undefined}
    >
      {clickableChip ? (
        <button
          type="button"
          className={classNames(mainHalf, clickable)}
          disabled={disabled}
          aria-pressed={active ?? ariaPressed}
          aria-expanded={ariaExpanded}
          aria-haspopup={ariaHasPopup}
          aria-controls={ariaControls}
          onClick={onClick}
        >
          {body}
        </button>
      ) : (
        body
      )}
      <Tooltip content={closeLabel}>
        <button
          type="button"
          className={removeButton}
          aria-label={closeLabel}
          data-testid={testId ? `${testId}-remove` : undefined}
          disabled={disabled}
          onClick={() => onRemove()}
        >
          <CloseGlyph />
        </button>
      </Tooltip>
    </span>
  );
});
