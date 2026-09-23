//! FILENAME: app/src/api/layout/primitives/Button.tsx
// PURPOSE: The button atoms of the Calcula Clusters control grammar — Button,
//          ToggleButton, IconButton, CommandButton (the hero) and the
//          DropdownChevron glyph they share.
// CONTEXT: Gives extensions the standard control look without hand-rolled CSS
//          (and without importing shell internals). Every other @api/layout
//          primitive — Segmented, Menu, Dropdown, Tile — is built from these,
//          so the interactive states are written exactly once, here:
//
//            rest    LT.buttonBg
//            hover   LT.hover
//            :active LT.active
//            pressed aria-pressed="true" OR aria-checked="true" -> LT.pressed
//                    background + 1px LT.pressedBorder border
//            focus   :focus-visible -> LT.focusRing (never on a mouse click)
//            disabled opacity .5, cursor default — the ONLY disabled idiom
//
//          Pressed is driven by the ARIA attribute, not by a class, so the
//          state a screen reader announces and the state the user sees cannot
//          disagree: a control that forgets aria-pressed also looks unpressed.
//
//          Sizes follow the fill rule in ../tokens.ts: a standard row is 28px
//          (CONTROL_HEIGHT_MD) with a 20px icon, a compact row 24px, and a tall
//          control fills a cluster's whole 61px content box on its own.
//
//          Class names are JOINED, not cx-merged. cx() mints a new merged class
//          at render time, which lands AFTER every module-level rule in the
//          stylesheet and so silently out-ranks a Segmented's `> *` override of
//          equal specificity. Joined classes keep the cascade in module order:
//          these base rules first, any container that styles its children later.
//
//          Colours come only from LT (../theme). This file must never carry a
//          colour literal; the layout tests scan what it renders.

import React, { forwardRef } from "react";
import { css } from "@emotion/css";
import { useSurfaceLayout } from "../context";
import { LT } from "../theme";
import {
  CONTROL_HEIGHT_MD,
  CONTROL_HEIGHT_SM,
  FONT_FAMILY,
  HERO_ICON_SLOT,
  ICON_SIZE_SM,
  LABEL_FONT_SIZE,
  LAUNCHER_MIN_WIDTH,
  TALL_CONTROL_HEIGHT,
  TILE_WIDTH,
} from "../tokens";
import { Tooltip } from "./Tooltip";
import type { TooltipPlacement } from "./Tooltip";
import { Badge } from "./Badge";

// ============================================================================
// Shared styles
// ============================================================================

/** Join class names, skipping falsy parts (see the header on why not cx). */
function classNames(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** The interactive recipe every button-shaped primitive starts from. */
const control = css`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  box-sizing: border-box;
  border: 1px solid transparent;
  border-radius: ${LT.radiusControl};
  background: ${LT.buttonBg};
  color: ${LT.text};
  cursor: pointer;
  font-family: ${FONT_FAMILY};
  font-size: 12px;
  font-weight: 400;
  line-height: 1;
  white-space: nowrap;
  transition:
    background-color ${LT.motionHover},
    border-color ${LT.motionHover},
    box-shadow ${LT.motionHover};

  &:hover:not(:disabled) {
    background: ${LT.hover};
  }

  &:active:not(:disabled) {
    background: ${LT.active};
  }

  &:focus-visible {
    outline: none;
    box-shadow: ${LT.focusRing};
  }

  &[aria-pressed="true"],
  &[aria-checked="true"] {
    background: ${LT.pressed};
    border-color: ${LT.pressedBorder};
  }

  &[aria-pressed="true"]:hover:not(:disabled),
  &[aria-checked="true"]:hover:not(:disabled) {
    background: ${LT.pressed};
  }

  &:disabled {
    opacity: 0.5;
    cursor: default;
  }
`;

/** Visible boundary at rest — for buttons that stand alone on a surface
 *  (pane control cards, dialogs) rather than in ribbon/toolbar rows, where
 *  the flat look would read as plain text. Hover LAYERS the hover tint over
 *  the surface instead of replacing it: the tint is translucent, and a bare
 *  translucent fill would let the card behind show through the button. */
const outlined = css`
  border-color: ${LT.controlBorder};
  background: ${LT.surface};

  &:hover:not(:disabled) {
    background: linear-gradient(${LT.hover}, ${LT.hover}), ${LT.surface};
  }

  &:active:not(:disabled) {
    background: linear-gradient(${LT.active}, ${LT.active}), ${LT.surface};
  }
`;

/** Destructive action (Delete, Remove, Clear). */
const danger = css`
  color: ${LT.dangerFg};

  &:hover:not(:disabled) {
    background: ${LT.dangerBg};
  }
`;

/** Leading icon slot: never shrinks, never inherits a text baseline. */
const leadingIcon = css`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  line-height: 1;
`;

/** Chevron glyph colour — secondary, so the affordance never outweighs the
 *  label or icon it belongs to. */
const chevronGlyph = css`
  display: inline-flex;
  align-items: center;
  flex: none;
  color: ${LT.textSecondary};
`;

// ============================================================================
// Shared helpers
// ============================================================================

function hasNode(node: React.ReactNode): boolean {
  return node !== null && node !== undefined && node !== false && node !== "";
}

/**
 * What a named control's tooltip shows. `false` opts out; an explicit value
 * wins; otherwise a control whose name is already VISIBLE shows a tooltip only
 * when there is a shortcut to teach — repeating a visible label on hover is
 * noise, repeating it next to "Ctrl+B" is the point.
 */
function visibleNameTooltip(
  tooltip: React.ReactNode | false | undefined,
  shortcut: string | undefined,
  commandId: string | undefined,
  name: React.ReactNode,
): React.ReactNode {
  if (tooltip === false) return null;
  if (hasNode(tooltip)) return tooltip;
  if (shortcut || commandId) return name;
  return null;
}

/** Small SVG dropdown chevron — the duotone set's filled chevron on the
 *  24-unit grid, so menu affordances match the ribbon icon language. Sized
 *  9 in a 28px control (the default) and 7 in a 24px one. */
export function DropdownChevron({ size = 9 }: { size?: number }): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      style={{ display: "block", flex: "none" }}
      aria-hidden
    >
      <path
        d="M4.9 8.3a1.8 1.8 0 0 1 2.55 0L12 12.85l4.55-4.55a1.8 1.8 0 1 1 2.55 2.55l-5.83 5.83a1.8 1.8 0 0 1-2.54 0L4.9 10.85a1.8 1.8 0 0 1 0-2.55z"
        fill="currentColor"
      />
    </svg>
  );
}

function Chevron({ size }: { size: number }): React.ReactElement {
  return (
    <span className={chevronGlyph} aria-hidden>
      <DropdownChevron size={size} />
    </span>
  );
}

// ============================================================================
// Button / ToggleButton
// ============================================================================

export interface LayoutButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** "sm" = compact 24px row button; "md" = standard 28px control. */
  size?: "sm" | "md";
  /** Stretch to fill the row. */
  grow?: boolean;
  /** "flat" (default) = transparent at rest, ribbon/toolbar idiom;
   *  "outlined" = visible border + surface background at rest. */
  variant?: "flat" | "outlined";
  /** Leading icon, sized by the caller: 16 in "sm", 20 (ICON_SIZE_SM) in "md". */
  icon?: React.ReactNode;
  /** "danger" paints a destructive action (text in the danger tone, a danger
   *  wash on hover). Default "neutral". */
  tone?: "neutral" | "danger";
  /** Tooltip content; `false` suppresses it. With no tooltip, one is shown
   *  only when a shortcut/commandId gives it something to teach. */
  tooltip?: React.ReactNode | false;
  /** Literal shortcut for the tooltip chip ("Ctrl+B"). */
  shortcut?: string;
  /** Resolve the tooltip chip from the live keybinding registry. */
  commandId?: string;
}

/** A standard button at the shared control height for the current density. */
export const Button = forwardRef<HTMLButtonElement, LayoutButtonProps>(function Button(
  {
    size = "md",
    grow,
    variant = "flat",
    icon,
    tone = "neutral",
    tooltip,
    shortcut,
    commandId,
    style,
    className,
    children,
    ...rest
  },
  ref,
) {
  const compact = size === "sm";
  const height = compact ? CONTROL_HEIGHT_SM : CONTROL_HEIGHT_MD;
  const name = rest["aria-label"] ?? (typeof children === "string" ? children : null);

  return (
    <Tooltip
      content={visibleNameTooltip(tooltip, shortcut, commandId, name)}
      shortcut={shortcut}
      commandId={commandId}
    >
      <button
        ref={ref}
        className={classNames(
          control,
          variant === "outlined" && outlined,
          tone === "danger" && danger,
          className,
        )}
        style={{
          height,
          minWidth: height,
          padding: compact ? "0 6px" : "0 9px",
          ...(grow ? { flex: 1 } : {}),
          ...style,
        }}
        {...rest}
      >
        {hasNode(icon) && (
          <span className={leadingIcon} aria-hidden>
            {icon}
          </span>
        )}
        {children}
      </button>
    </Tooltip>
  );
});

export interface ToggleButtonProps extends LayoutButtonProps {
  /** Whether the toggle is currently on (bold/italic/loop-style state). */
  active: boolean;
}

/** A Button with a pressed state for on/off controls (drives aria-pressed). */
export const ToggleButton = forwardRef<HTMLButtonElement, ToggleButtonProps>(
  function ToggleButton({ active, ...rest }, ref) {
    return <Button ref={ref} {...rest} aria-pressed={active} />;
  },
);

// ============================================================================
// IconButton — an icon-only control, named for assistive tech and tooltips
// ============================================================================

export type IconButtonSize = "sm" | "md" | "tall";

/** Outer box per size: 24x24, 28x28, and 44x61 (a tile-width control that
 *  fills a cluster's content box on its own). */
const ICON_BUTTON_BOX: Record<IconButtonSize, { width: number; height: number }> = {
  sm: { width: CONTROL_HEIGHT_SM, height: CONTROL_HEIGHT_SM },
  md: { width: CONTROL_HEIGHT_MD, height: CONTROL_HEIGHT_MD },
  tall: { width: TILE_WIDTH, height: TALL_CONTROL_HEIGHT },
};

/** Width of a split button's chevron half, at every height. */
const SPLIT_CHEVRON_WIDTH = 16;

const iconColumn = css`
  flex-direction: column;
  gap: 2px;
`;

const splitWrap = css`
  display: inline-flex;
  align-items: stretch;
  flex: none;
`;

const splitMain = css`
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
`;

/** The hairline between the halves is an inset shadow, not a border, so the
 *  chevron's outer width stays exactly SPLIT_CHEVRON_WIDTH; :focus-visible's
 *  ring (higher specificity, in `control`) replaces it while focused. */
const splitChevron = css`
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
  box-shadow: inset 1px 0 0 ${LT.controlDivider};
`;

export interface IconButtonProps extends Omit<LayoutButtonProps, "size" | "icon" | "children"> {
  /** The icon, sized by the caller: 16 in "sm", 20 in "md", 28-30 in "tall". */
  icon: React.ReactNode;
  /** The control's name: its aria-label and (by default) its tooltip. */
  label: string;
  /** Toggle state. Only when defined does the button carry aria-pressed, so a
   *  plain action never announces itself as a toggle. */
  pressed?: boolean;
  /** "sm" 24x24, "md" 28x28 (default), "tall" 44x61. */
  size?: IconButtonSize;
  /** Show a chevron inside the button (the whole button opens something). */
  chevron?: boolean;
  /** Render as a split button: the icon half runs the action (onClick), a
   *  separate 16px chevron half runs onChevronClick. */
  split?: boolean;
  /** Click handler of the split chevron half. Without it the half is disabled
   *  rather than a live button that does nothing. */
  onChevronClick?: React.MouseEventHandler<HTMLButtonElement>;
  /** aria-label (and tooltip) of the split chevron; default `${label} options`. */
  chevronLabel?: string;
  /** Extra attributes for the split chevron half (data-testid, aria-expanded,
   *  aria-haspopup). Cannot override its aria-label, onClick or disabled —
   *  use chevronLabel / onChevronClick / disabled for those. */
  chevronProps?: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children">;
  /** Which side the tooltip prefers (default "bottom"). A control on a
   *  surface with something below it — the mini toolbar pill above its context
   *  menu — asks for "top". */
  tooltipPlacement?: TooltipPlacement;
  /** Stacking layer of the tooltip (see Tooltip `zIndex`). */
  tooltipZIndex?: number;
}

/**
 * An icon-only button. Always named (`aria-label={label}`), always explained
 * on hover/keyboard focus by a Tooltip (content = `tooltip ?? label`) unless
 * `tooltip === false`. No automatic `title`: the Tooltip replaces it, and a
 * caller that still needs one (an E2E selector) passes it explicitly.
 *
 * HTML props (onClick, data-testid, title, className, style, the ref) go to
 * the main button; in split form they never reach the chevron half.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    icon,
    label,
    pressed,
    size = "md",
    chevron,
    split,
    onChevronClick,
    chevronLabel,
    chevronProps,
    tooltip,
    shortcut,
    commandId,
    tooltipPlacement,
    tooltipZIndex,
    variant = "flat",
    tone = "neutral",
    grow,
    disabled,
    className,
    style,
    ...rest
  },
  ref,
) {
  const box = ICON_BUTTON_BOX[size];
  const tall = size === "tall";
  const chevronSize = size === "sm" ? 7 : 9;
  const mainTip = tooltip === false ? null : hasNode(tooltip) ? tooltip : label;
  // Only a DEFINED `pressed` makes the button a toggle; otherwise whatever the
  // caller passed (usually nothing) stands, so a plain action never announces
  // itself as one.
  const ariaPressed = pressed ?? rest["aria-pressed"];
  const variantClass = variant === "outlined" && outlined;
  const toneClass = tone === "danger" && danger;

  if (split) {
    // Plain class names `split` / `split-main` / `split-chevron` (beside the
    // emotion ones) give a containing Segmented stable hooks for its
    // first/last radius and divider rules without reaching for hashed names.
    const halfLabel = chevronLabel ?? `${label} options`;
    return (
      <span className={classNames("split", splitWrap)} style={grow ? { flex: 1 } : undefined}>
        <Tooltip
          content={mainTip}
          shortcut={shortcut}
          commandId={commandId}
          placement={tooltipPlacement}
          zIndex={tooltipZIndex}
        >
          <button
            ref={ref}
            className={classNames("split-main", control, variantClass, toneClass, splitMain, className)}
            style={{
              width: box.width,
              minWidth: box.width,
              height: box.height,
              padding: 0,
              ...(grow ? { flex: 1 } : {}),
              ...style,
            }}
            disabled={disabled}
            {...rest}
            aria-label={label}
            aria-pressed={ariaPressed}
          >
            {icon}
          </button>
        </Tooltip>
        <Tooltip content={tooltip === false ? null : halfLabel} placement={tooltipPlacement} zIndex={tooltipZIndex}>
          <button
            {...chevronProps}
            className={classNames(
              "split-chevron",
              control,
              variantClass,
              toneClass,
              splitChevron,
              chevronProps?.className,
            )}
            style={{
              width: SPLIT_CHEVRON_WIDTH,
              minWidth: SPLIT_CHEVRON_WIDTH,
              height: box.height,
              padding: 0,
              ...chevronProps?.style,
            }}
            aria-label={halfLabel}
            disabled={disabled || !onChevronClick}
            onClick={onChevronClick}
          >
            <Chevron size={chevronSize} />
          </button>
        </Tooltip>
      </span>
    );
  }

  // With an inline chevron the button needs room for two glyphs: a short
  // button grows sideways from its square minimum, a tall one stacks them.
  const geometry: React.CSSProperties = chevron
    ? tall
      ? { width: box.width, minWidth: box.width, height: box.height, padding: 0 }
      : { minWidth: box.width, height: box.height, padding: "0 4px", gap: 2 }
    : { width: box.width, minWidth: box.width, height: box.height, padding: 0 };

  return (
    <Tooltip
      content={mainTip}
      shortcut={shortcut}
      commandId={commandId}
      placement={tooltipPlacement}
      zIndex={tooltipZIndex}
    >
      <button
        ref={ref}
        className={classNames(control, variantClass, toneClass, chevron && tall && iconColumn, className)}
        style={{ ...geometry, ...(grow ? { flex: 1 } : {}), ...style }}
        disabled={disabled}
        {...rest}
        aria-label={label}
        aria-pressed={ariaPressed}
      >
        {icon}
        {chevron && <Chevron size={chevronSize} />}
      </button>
    </Tooltip>
  );
});

// ============================================================================
// CommandButton — the hero (big icon over label in the band)
// ============================================================================

/** A hero is the same footprint as a Launcher, so a cluster demoting to a
 *  launcher does not shift its neighbours sideways. */
const HERO_MIN_WIDTH = LAUNCHER_MIN_WIDTH;
/** Longest label a hero shows before ellipsis. */
const HERO_LABEL_MAX_WIDTH = 92;

const hero = css`
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  height: ${TALL_CONTROL_HEIGHT}px;
  min-width: ${HERO_MIN_WIDTH}px;
  padding: 6px 10px;
`;

const heroSlot = css`
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: ${HERO_ICON_SLOT}px;
  height: ${HERO_ICON_SLOT}px;
`;

const heroBadge = css`
  position: absolute;
  top: -3px;
  right: -5px;
`;

const heroLabel = css`
  display: flex;
  align-items: center;
  gap: 3px;
  max-width: ${HERO_LABEL_MAX_WIDTH}px;
  font-size: ${LABEL_FONT_SIZE}px;
  font-weight: 500;
  line-height: 13px;
`;

/** Ellipsis needs its own box: a flex container cannot truncate the
 *  anonymous text item inside it. */
const heroLabelText = css`
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

/** Outside the band a hero is a standard 28px button, whose icon is 20px —
 *  whatever size the caller drew for the band. One icon prop, two surfaces. */
const panelIconFit = css`
  display: inline-flex;
  align-items: center;
  justify-content: center;

  & > svg {
    width: ${ICON_SIZE_SM}px;
    height: ${ICON_SIZE_SM}px;
  }
`;

export interface CommandButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** Icon shown above the label in the band (pass HERO_ICON_SIZE), inline
   *  before it elsewhere (fitted to 20px there). */
  icon: React.ReactNode;
  /** Short label under/next to the icon. */
  label: string;
  /** Show a dropdown chevron after the label (menu/gallery affordance). */
  chevron?: boolean;
  /** Toggle state: aria-pressed + the pressed look. */
  active?: boolean;
  /** Count pill at the top-right of the icon slot ("3" active filters). */
  badge?: string | number;
  /** Tooltip content; `false` suppresses it. By default a hero (whose label
   *  is visible) shows one only when a shortcut/commandId is given. */
  tooltip?: React.ReactNode | false;
  /** Literal shortcut for the tooltip chip. */
  shortcut?: string;
  /** Resolve the tooltip chip from the live keybinding registry. */
  commandId?: string;
}

/**
 * A prominent command (Paste, Refresh, Insert Slicer...): in the ribbon band
 * it renders as the full-height (61px) icon-over-label hero; in the
 * panel/popover it is a standard 28px Button with the icon inline.
 *
 * The icon and the label are the button's ONLY text: the badge is aria-hidden
 * and every glyph is an SVG, so `button.textContent` stays icon + label.
 */
export const CommandButton = forwardRef<HTMLButtonElement, CommandButtonProps>(
  function CommandButton(
    { icon, label, chevron, active, badge, tooltip, shortcut, commandId, className, ...rest },
    ref,
  ) {
    const layout = useSurfaceLayout();
    const tip = visibleNameTooltip(tooltip, shortcut, commandId, label);
    const ariaPressed = active ?? rest["aria-pressed"];
    const hasBadge = badge !== undefined && badge !== null && badge !== "";

    if (layout.container === "band") {
      return (
        <Tooltip content={tip} shortcut={shortcut} commandId={commandId}>
          <button ref={ref} className={classNames(control, hero, className)} {...rest} aria-pressed={ariaPressed}>
            <span className={heroSlot} aria-hidden>
              {icon}
              {hasBadge && (
                <Badge className={heroBadge} aria-hidden>
                  {badge}
                </Badge>
              )}
            </span>
            <span className={heroLabel}>
              <span className={heroLabelText}>{label}</span>
              {chevron && <Chevron size={9} />}
            </span>
          </button>
        </Tooltip>
      );
    }

    return (
      <Button
        ref={ref}
        className={className}
        icon={<span className={panelIconFit}>{icon}</span>}
        tooltip={tip === null ? false : tip}
        shortcut={shortcut}
        commandId={commandId}
        {...rest}
        aria-pressed={ariaPressed}
      >
        <span>{label}</span>
        {hasBadge && <Badge aria-hidden>{badge}</Badge>}
        {chevron && <Chevron size={9} />}
      </Button>
    );
  },
);
