//! FILENAME: app/src/api/layout/primitives/Color.tsx
// PURPOSE: The colour controls of the Calcula Clusters grammar: ColorSwatch
//          (the trigger in a ribbon row or a pane) and ColorPopover (the
//          palette it opens: theme grid with tints, standard row, automatic,
//          and "More colours..." with a hex field).
// CONTEXT: Before this, every surface that picked a colour drew its own: the
//          Format Cells ColorPicker (theme grid + standard row + custom), the
//          Home tab's ColorDropdown (twenty quick colours), the mini toolbar's
//          InlineColorPicker, and the chart panes' bare <input type="color">.
//          They disagreed on names, on selection marks, and on whether a theme
//          colour is remembered as a theme SLOT or flattened to its hex.
//          ColorPopover is written to be able to REPLACE the Format Cells
//          ColorPicker without a behaviour change:
//
//          - The theme palette comes from getThemeColorPalette() (../../theme),
//            reloaded on every open because a theme change invalidates it; the
//            first ten entries are the base row, the rest are tint rows of ten.
//          - A theme pick calls onThemeColorChange(slot, tint, resolvedHex)
//            when given, so the document stores the SLOT and the cell recolours
//            with the theme; without it, onChange(resolvedHex).
//          - A theme swatch is selected when themeSlot/themeTint match; a
//            standard swatch when no theme slot is set and the hex matches.
//          - The custom <input type="color"> reports live (the OS picker's
//            drag), exactly as the dialog's did.
//
//          ColorSwatch has two faces: `bar` (Font colour / Fill colour: an icon
//          over a 4px bar of the current colour — the mockup's 32x28 control)
//          and `swatch` (a 16px rounded chip in a 28px button, for panes). With
//          `native` it opens the OS picker directly: a real <input type=color>
//          lies transparent over the face, so the click that opens the picker is
//          a real click on a real input — which is also what the existing
//          chart-pane tests drive (`input[type="color"]` + a change event).
//
//          Chrome paints only with LT tokens. The rendered COLOURS — the bar,
//          the chip, every swatch — are data and carry `data-colour-data`, the
//          attribute findHardcodedColours (../testing.ts) skips.

import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { css } from "@emotion/css";
import type { ThemeColorInfo } from "../../../core/types/types";
import { getThemeColorPalette } from "../../theme";
import { LT } from "../theme";
import { FONT_FAMILY, FONT_MONO, GAP_SM } from "../tokens";
import { DEFAULT_PICKER_COLOR, STANDARD_COLORS, colorLabel, normalizeHex, sameColor } from "../colors";
import { DropdownChevron, IconButton } from "./Button";
import { Popover, firstFocusable, type PopoverPlacement } from "./Popover";
import { Tooltip } from "./Tooltip";
import type { TooltipPlacement } from "./Tooltip";
import { focusWhenShown, gridKeyTarget, gridRows } from "./Tile";

// ============================================================================
// Geometry
// ============================================================================

/** Swatches per palette row — Office's ten-wide theme grid. */
const PALETTE_COLUMNS = 10;
/** One palette swatch: 18px, gap 2 -> a 198px grid. */
const PALETTE_SWATCH = 18;
const PALETTE_GAP = 2;
const PALETTE_WIDTH = PALETTE_COLUMNS * PALETTE_SWATCH + (PALETTE_COLUMNS - 1) * PALETTE_GAP;

/**
 * Trigger geometry per row size. `barBottom` is measured from the button's
 * CONTENT box (inside its 1px transparent border), so the bar sits 4px (md)
 * / 3px (sm) above the outer edge — the mockup's `bottom: 4px` on a
 * borderless 28px button.
 */
const SWATCH_GEOMETRY = {
  md: { box: 28, barWidth: 32, icon: 20, chip: 16, barHeight: 4, barBottom: 3, lift: 5, chevron: 9 },
  sm: { box: 24, barWidth: 28, icon: 16, chip: 14, barHeight: 3, barBottom: 2, lift: 4, chevron: 7 },
} as const;

// ============================================================================
// Styles
// ============================================================================

/** Icon + bar stack of the `bar` face; the bar is positioned against it, so
 *  it always sits exactly under the icon whatever padding a chevron adds. */
const barGlyph = css`
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  height: 100%;
`;

const barIcon20 = css`
  display: inline-flex;
  flex: none;

  & > svg {
    width: 20px;
    height: 20px;
  }
`;

const barIcon16 = css`
  display: inline-flex;
  flex: none;

  & > svg {
    width: 16px;
    height: 16px;
  }
`;

const colourBar = css`
  position: absolute;
  left: 0;
  right: 0;
  border-radius: 2px;
`;

const colourChip = css`
  display: block;
  flex: none;
  border-radius: 4px;
  box-shadow: inset 0 0 0 1px ${LT.controlBorder};
`;

/** "No colour" (null): an empty outline instead of a guessed paint. */
const emptyPaint = css`
  box-shadow: inset 0 0 0 1px ${LT.controlBorder};
`;

/** Native mode: the face is a span (an <input> may not sit inside a
 *  <button>), so the wrapper carries the hover and the focus ring the button
 *  recipe would have given it. */
const nativeWrap = css`
  position: relative;
  display: inline-flex;
  flex: none;
  box-sizing: border-box;
  border-radius: ${LT.radiusControl};
  background: ${LT.buttonBg};
  color: ${LT.text};
  transition:
    background-color ${LT.motionHover},
    box-shadow ${LT.motionHover};

  &:hover:not([data-disabled]) {
    background: ${LT.hover};
  }

  &:has(> input:focus-visible) {
    box-shadow: ${LT.focusRing};
  }

  &[data-disabled] {
    opacity: 0.5;
  }
`;

const nativeFace = css`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  box-sizing: border-box;
  border: 1px solid transparent;
  pointer-events: none;
`;

const chevronGlyph = css`
  display: inline-flex;
  align-items: center;
  flex: none;
  color: ${LT.textSecondary};
`;

/** A transparent input laid over its visible face: it takes the click (and
 *  the keyboard focus) and opens the OS picker. */
const overlayInput = css`
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 0;
  border: 0;
  opacity: 0;
  cursor: pointer;

  &:disabled {
    cursor: default;
  }
`;

// ---- popover -----------------------------------------------------------------

const popoverBody = css`
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: ${PALETTE_WIDTH}px;
  font-family: ${FONT_FAMILY};
  color: ${LT.text};
`;

const sectionLabel = css`
  padding: 6px 2px 4px;
  font-family: ${FONT_FAMILY};
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  color: ${LT.textSecondary};
`;

const paletteGrid = css`
  display: grid;
  grid-template-columns: repeat(${PALETTE_COLUMNS}, ${PALETTE_SWATCH}px);
  gap: ${PALETTE_GAP}px;
`;

/** Office separates the theme's base row from its tints. */
const baseRowGap = css`
  margin-bottom: 4px;
`;

/**
 * One palette swatch. Rings are INSET so a 2px ring never paints over the
 * 2px gap onto a neighbour; the 1px surface-coloured inner ring keeps the
 * ring legible on a swatch of the same hue as the accent. The hairline at
 * rest is what makes white visible on a white popover.
 */
const paletteSwatch = css`
  width: ${PALETTE_SWATCH}px;
  height: ${PALETTE_SWATCH}px;
  padding: 0;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  box-shadow: inset 0 0 0 1px ${LT.controlDivider};
  transition: box-shadow ${LT.motionHover};

  &:hover {
    box-shadow:
      inset 0 0 0 2px ${LT.text},
      inset 0 0 0 3px ${LT.surface};
  }

  &[aria-pressed="true"] {
    box-shadow:
      inset 0 0 0 2px ${LT.stateAccent},
      inset 0 0 0 3px ${LT.surface};
  }

  &:focus-visible {
    outline: none;
    box-shadow: ${LT.focusRing};
  }
`;

/** A 28px menu-style row (Automatic, More colours..., an extra action). */
const actionRow = css`
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  box-sizing: border-box;
  height: 28px;
  padding: 0 6px;
  border: none;
  border-radius: ${LT.radiusControl};
  background: ${LT.buttonBg};
  color: ${LT.text};
  cursor: pointer;
  font-family: ${FONT_FAMILY};
  font-size: 12px;
  line-height: 1;
  text-align: left;
  transition: background-color ${LT.motionHover};

  &:hover {
    background: ${LT.hover};
  }

  &:focus-visible,
  &:has(> input:focus-visible) {
    outline: none;
    box-shadow: ${LT.focusRing};
  }

  &[aria-pressed="true"] {
    background: ${LT.pressed};
  }
`;

const rowChip = css`
  display: block;
  flex: none;
  width: 16px;
  height: 16px;
  border-radius: 4px;
  box-shadow: inset 0 0 0 1px ${LT.controlBorder};
`;

/** "Automatic" means the text colour, so its chip is painted with it. */
const automaticChip = css`
  background: currentColor;
`;

const customLine = css`
  display: flex;
  align-items: center;
  gap: ${GAP_SM}px;
`;

const hexField = css`
  flex: none;
  width: 76px;
  height: 24px;
  box-sizing: border-box;
  padding: 0 6px;
  border: 1px solid ${LT.controlBorder};
  border-radius: 6px;
  background: ${LT.inputBg};
  color: ${LT.text};
  font-family: ${FONT_MONO};
  font-size: 11px;
  outline: none;

  &:focus-visible {
    border-color: ${LT.stateAccent};
    box-shadow: ${LT.focusRing};
  }

  &[aria-invalid="true"] {
    border-color: ${LT.dangerFg};
  }
`;

const divider = css`
  height: 1px;
  margin: 6px 2px;
  background: ${LT.controlDivider};
`;

// ============================================================================
// ColorPopover
// ============================================================================

/** An extra row at the bottom of the popover ("More fill options..."). */
export interface ColorPopoverAction {
  label: string;
  onSelect: () => void;
  testId?: string;
}

export interface ColorPopoverProps {
  anchorEl: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  /** Current colour (any CSS colour; hex compares shorthand-insensitively),
   *  or null for "automatic"/none. */
  value: string | null;
  /** An absolute colour was picked (standard, custom, hex, or a theme colour
   *  when onThemeColorChange is not given). */
  onChange: (hex: string) => void;
  /** A THEME colour was picked: slot ("accent1"), tint (permille), and the
   *  resolved hex for display. Given, the popover never flattens a theme pick
   *  to onChange. */
  onThemeColorChange?: (slot: string, tint: number, hex: string) => void;
  /** Show the document theme grid. Default true. */
  showTheme?: boolean;
  /** The fixed colours row(s), ten per row. Default STANDARD_COLORS. */
  colors?: readonly string[];
  /** Offer an "Automatic" row (value null). */
  allowAutomatic?: boolean;
  onAutomatic?: () => void;
  /** Label of the custom-colour row. Default "More colours...". */
  customLabel?: string;
  /** The current theme slot, when the value is a theme colour. */
  themeSlot?: string;
  /** The current theme tint (permille, 0 = base) with themeSlot. */
  themeTint?: number;
  /** Heading of the fixed colours. Default "Standard colours". */
  colorsHeading?: string;
  /** Label of the automatic row ("No fill" for a fill). Default "Automatic". */
  automaticLabel?: string;
  /** An extra action row at the bottom; the popover closes before it runs. */
  moreAction?: ColorPopoverAction;
  /** Accessible name of the popover. Default "Colours". */
  ariaLabel?: string;
  /** data-testid of the popover body; `-custom` / `-hex` suffix its fields. */
  testId?: string;
  /** Default "bottom-start". */
  placement?: PopoverPlacement;
  /** Stacking layer (see Popover `zIndex`); swatch tooltips sit one above. */
  zIndex?: number;
  /** What the automatic row's chip shows. "text" (default): a chip painted
   *  in the text colour, for "Automatic" meaning the default ink. "none": an
   *  empty outline, for "No fill" / "None" meaning no colour at all. */
  automaticChip?: "text" | "none";
}

type SwatchEntry =
  | { kind: "theme"; info: ThemeColorInfo }
  | { kind: "fixed"; hex: string };

/**
 * The colour palette popover (card chrome). Opens with focus on the selected
 * swatch (else the first); arrow keys walk the swatches as one ten-wide grid
 * (theme base row, tint rows, standard rows), Home/End jump to the ends,
 * Enter/Space pick. Picking closes it and returns focus to the anchor.
 */
export function ColorPopover({
  anchorEl,
  open,
  onClose,
  value,
  onChange,
  onThemeColorChange,
  showTheme = true,
  colors = STANDARD_COLORS,
  allowAutomatic,
  onAutomatic,
  customLabel = "More colours...",
  themeSlot,
  themeTint,
  colorsHeading = "Standard colours",
  automaticLabel = "Automatic",
  moreAction,
  ariaLabel,
  testId,
  placement = "bottom-start",
  zIndex,
  automaticChip: automaticChipKind = "text",
}: ColorPopoverProps): React.ReactElement | null {
  const idBase = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const swatchRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [palette, setPalette] = useState<ThemeColorInfo[]>([]);
  // Focus-on-open waits for the first palette answer, so it lands on a
  // selected THEME swatch rather than on a standard one the grid then pushes
  // down. Without the theme grid there is nothing to wait for.
  const [paletteSettled, setPaletteSettled] = useState(!showTheme);
  const [focused, setFocused] = useState(-1);
  const [hexDraft, setHexDraft] = useState<string | null>(null);

  // Per-open state resets whenever the popover closes, by whichever path —
  // our own pick, Escape, an outside press, or the caller toggling `open` —
  // so the next open starts on the selected swatch with a fresh hex field.
  // Adjusted during render (React's "previous props" pattern), not in an
  // effect, so no frame ever shows the stale roving position.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open) {
      setFocused(-1);
      setHexDraft(null);
    }
  }

  // Reloaded on every open: setDocumentTheme invalidates the cache, and a
  // popover mounted before a theme change must not keep the old colours.
  useEffect(() => {
    if (!open || !showTheme) return;
    let cancelled = false;
    getThemeColorPalette().then(
      (loaded) => {
        if (cancelled) return;
        setPalette(loaded);
        setPaletteSettled(true);
      },
      (err: unknown) => {
        if (cancelled) return;
        // Not silent: a picker that quietly lost its theme grid looks like a
        // document with no theme. The standard colours still work.
        console.warn("[ColorPopover] theme palette unavailable:", err);
        setPalette([]);
        setPaletteSettled(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, showTheme]);

  const themeBase = showTheme ? palette.slice(0, PALETTE_COLUMNS) : [];
  const themeTints = showTheme ? palette.slice(PALETTE_COLUMNS) : [];
  const entries: SwatchEntry[] = [
    ...themeBase.map((info): SwatchEntry => ({ kind: "theme", info })),
    ...themeTints.map((info): SwatchEntry => ({ kind: "theme", info })),
    ...colors.map((hex): SwatchEntry => ({ kind: "fixed", hex })),
  ];
  const rows = gridRows([themeBase.length, themeTints.length, colors.length], PALETTE_COLUMNS);

  const isSelected = (entry: SwatchEntry): boolean =>
    entry.kind === "theme"
      ? themeSlot !== undefined &&
        themeSlot === entry.info.slot &&
        (themeTint ?? 0) === entry.info.tint
      : !themeSlot && sameColor(value, entry.hex);
  const selectedIndex = entries.findIndex(isSelected);
  const rovingIndex =
    focused >= 0 && focused < entries.length ? focused : selectedIndex >= 0 ? selectedIndex : 0;

  /** Close after a pick and hand focus back to the anchor, when focus was in
   *  here — the popover is about to unmount, which would drop it on <body>. */
  const finish = useCallback(() => {
    const body = bodyRef.current;
    const restore =
      anchorEl && body && body.contains(document.activeElement) ? firstFocusable(anchorEl) : null;
    onClose();
    restore?.focus();
  }, [anchorEl, onClose]);

  useEffect(() => {
    if (!open || !paletteSettled) return;
    return focusWhenShown(
      () => bodyRef.current,
      () => {
        const body = bodyRef.current;
        if (!body) return null;
        return (
          body.querySelector<HTMLElement>('[data-colour-swatch][tabindex="0"]') ??
          firstFocusable(body)
        );
      },
    );
  }, [open, paletteSettled]);

  const pick = (entry: SwatchEntry): void => {
    if (entry.kind === "theme") {
      if (onThemeColorChange) {
        onThemeColorChange(entry.info.slot, entry.info.tint, entry.info.resolvedColor);
      } else {
        onChange(entry.info.resolvedColor);
      }
    } else {
      onChange(entry.hex);
    }
    finish();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const raw = (e.target as HTMLElement).dataset?.colourSwatch;
    if (raw === undefined) return;
    const next = gridKeyTarget(rows, Number(raw), e.key);
    if (next === null) return;
    e.preventDefault();
    swatchRefs.current[next]?.focus();
  };

  const currentHex = normalizeHex(value);
  const shownHex = hexDraft ?? currentHex ?? "";
  const hexInvalid = hexDraft !== null && hexDraft.trim() !== "" && normalizeHex(hexDraft) === null;

  const commitHex = (andClose: boolean): void => {
    if (hexDraft === null) {
      if (andClose) finish();
      return;
    }
    const hex = normalizeHex(hexDraft);
    if (hex === null) return;
    if (!sameColor(hex, value)) onChange(hex);
    setHexDraft(null);
    if (andClose) finish();
  };

  const renderSwatch = (entry: SwatchEntry, index: number): React.ReactElement => {
    const hex = entry.kind === "theme" ? entry.info.resolvedColor : entry.hex;
    const label = entry.kind === "theme" ? entry.info.label : colorLabel(entry.hex);
    return (
      <Tooltip
        key={entry.kind === "theme" ? `${entry.info.slot}-${entry.info.tint}` : `fixed-${index}`}
        content={label}
        zIndex={zIndex !== undefined ? zIndex + 1 : undefined}
      >
        <button
          type="button"
          ref={(el) => {
            swatchRefs.current[index] = el;
          }}
          className={paletteSwatch}
          style={{ background: hex }}
          data-colour-data=""
          data-colour-swatch={index}
          aria-label={label}
          aria-pressed={isSelected(entry)}
          tabIndex={index === rovingIndex ? 0 : -1}
          onFocus={() => setFocused(index)}
          onClick={() => pick(entry)}
        />
      </Tooltip>
    );
  };

  const themeHeadingId = `${idBase}-theme`;
  const fixedHeadingId = `${idBase}-fixed`;
  const tintOffset = themeBase.length;
  const fixedOffset = themeBase.length + themeTints.length;

  return (
    <Popover
      card
      anchorEl={anchorEl}
      open={open}
      onClose={onClose}
      placement={placement}
      ariaLabel={ariaLabel ?? "Colours"}
      zIndex={zIndex}
    >
      <div ref={bodyRef} className={popoverBody} onKeyDown={handleKeyDown} data-testid={testId}>
        {allowAutomatic && (
          <button
            type="button"
            className={actionRow}
            aria-pressed={value === null}
            onClick={() => {
              onAutomatic?.();
              finish();
            }}
          >
            <span
              className={automaticChipKind === "none" ? `${rowChip} ${emptyPaint}` : `${rowChip} ${automaticChip}`}
              aria-hidden
            />
            <span>{automaticLabel}</span>
          </button>
        )}

        {themeBase.length > 0 && (
          <div role="group" aria-labelledby={themeHeadingId}>
            <div id={themeHeadingId} className={sectionLabel}>
              Theme colours
            </div>
            <div className={`${paletteGrid} ${baseRowGap}`}>
              {themeBase.map((info, i) => renderSwatch({ kind: "theme", info }, i))}
            </div>
            {themeTints.length > 0 && (
              <div className={paletteGrid}>
                {themeTints.map((info, i) => renderSwatch({ kind: "theme", info }, tintOffset + i))}
              </div>
            )}
          </div>
        )}

        {colors.length > 0 && (
          <div role="group" aria-labelledby={fixedHeadingId}>
            <div id={fixedHeadingId} className={sectionLabel}>
              {colorsHeading}
            </div>
            <div className={paletteGrid}>
              {colors.map((hex, i) => renderSwatch({ kind: "fixed", hex }, fixedOffset + i))}
            </div>
          </div>
        )}

        <div className={divider} />

        <div className={customLine}>
          <span className={actionRow} style={{ flex: 1, minWidth: 0 }}>
            <span
              className={currentHex ? rowChip : `${rowChip} ${emptyPaint}`}
              style={{ background: currentHex ?? "transparent" }}
              data-colour-data=""
              aria-hidden
            />
            <span>{customLabel}</span>
            <input
              type="color"
              className={overlayInput}
              aria-label={customLabel}
              value={currentHex ?? DEFAULT_PICKER_COLOR}
              onChange={(e) => onChange(e.target.value)}
              data-testid={testId ? `${testId}-custom` : undefined}
            />
          </span>
          <input
            type="text"
            className={hexField}
            aria-label="Hex colour"
            aria-invalid={hexInvalid || undefined}
            placeholder="#RRGGBB"
            maxLength={7}
            spellCheck={false}
            autoComplete="off"
            value={shownHex}
            onChange={(e) => setHexDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitHex(true);
              }
            }}
            onBlur={() => commitHex(false)}
            data-testid={testId ? `${testId}-hex` : undefined}
          />
        </div>

        {moreAction && (
          <>
            <div className={divider} />
            <button
              type="button"
              className={actionRow}
              data-testid={moreAction.testId}
              onClick={() => {
                finish();
                moreAction.onSelect();
              }}
            >
              {moreAction.label}
            </button>
          </>
        )}
      </div>
    </Popover>
  );
}

// ============================================================================
// ColorSwatch
// ============================================================================

export type ColorSwatchVariant = "swatch" | "bar";
export type ColorSwatchSize = "sm" | "md";

export interface ColorSwatchProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "color" | "children"> {
  /** The current colour, or null for automatic / none. */
  color: string | null;
  /** A colour was picked (see ColorPopover.onChange). */
  onChange: (hex: string) => void;
  /** The control's name: aria-label, tooltip, and the popover's name. */
  label: string;
  /** "swatch" (default): a 16px chip in a 28px button. "bar": the icon over a
   *  4px bar of the colour (Font colour / Fill colour), 32x28. */
  variant?: ColorSwatchVariant;
  /** The bar variant's icon (20px in md, 16px in sm; fitted). */
  icon?: React.ReactNode;
  /** A dropdown chevron beside the face. */
  chevron?: boolean;
  /** Open the OS colour picker directly instead of the palette popover. */
  native?: boolean;
  onThemeColorChange?: (slot: string, tint: number, hex: string) => void;
  allowAutomatic?: boolean;
  onAutomatic?: () => void;
  /** data-testid of the interactive element (the button, or the native input). */
  testId?: string;
  /** "md" (default) 28px row; "sm" 24px row. */
  size?: ColorSwatchSize;
  /** Tooltip override; `false` suppresses it. Default: the label. */
  tooltip?: React.ReactNode | false;
  // ---- passed through to the ColorPopover ----------------------------------
  themeSlot?: string;
  themeTint?: number;
  showTheme?: boolean;
  colors?: readonly string[];
  colorsHeading?: string;
  automaticLabel?: string;
  customLabel?: string;
  moreAction?: ColorPopoverAction;
  automaticChip?: "text" | "none";
  // ---- control + layering ----------------------------------------------------
  /** Controlled open state of the palette. With it, the caller owns open/close
   *  (a toolbar closing one palette when another opens) instead of
   *  remounting the swatch to reset it. Omit for the uncontrolled default. */
  open?: boolean;
  /** Called with the next open state whenever the swatch wants to open or
   *  close its palette (click, Escape, outside press, a pick). */
  onOpenChange?: (open: boolean) => void;
  /** Which side the trigger's tooltip prefers. */
  tooltipPlacement?: TooltipPlacement;
  /** Stacking layer of the palette (its tooltips sit one above, and the
   *  trigger's tooltip two above). */
  zIndex?: number;
}

/**
 * A colour picker trigger. Click opens the ColorPopover below it (or, with
 * `native`, the OS picker). The current colour is shown as data: the bar or
 * the chip carries `data-colour-data`.
 */
export function ColorSwatch({
  color,
  onChange,
  label,
  variant = "swatch",
  icon,
  chevron,
  native,
  onThemeColorChange,
  allowAutomatic,
  onAutomatic,
  testId,
  size = "md",
  tooltip,
  themeSlot,
  themeTint,
  showTheme,
  colors,
  colorsHeading,
  automaticLabel,
  customLabel,
  moreAction,
  automaticChip,
  open: openProp,
  onOpenChange,
  tooltipPlacement,
  zIndex,
  className,
  style,
  disabled,
  onClick,
  ...rest
}: ColorSwatchProps): React.ReactElement {
  const [openState, setOpenState] = useState(false);
  const controlled = openProp !== undefined;
  const open = controlled ? openProp : openState;
  const setOpen = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      const value = typeof next === "function" ? next(open) : next;
      if (!controlled) setOpenState(value);
      if (value !== open) onOpenChange?.(value);
    },
    [controlled, open, onOpenChange],
  );
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const g = SWATCH_GEOMETRY[size];
  const width = variant === "bar" ? g.barWidth : g.box;
  const paint = color ?? "transparent";
  const closePopover = useCallback(() => setOpen(false), [setOpen]);

  const face =
    variant === "bar" ? (
      <span className={barGlyph} style={{ width: g.icon }}>
        {icon !== undefined && icon !== null && (
          <span className={size === "sm" ? barIcon16 : barIcon20} style={{ marginBottom: g.lift }}>
            {icon}
          </span>
        )}
        <span
          className={color === null ? `${colourBar} ${emptyPaint}` : colourBar}
          style={{ height: g.barHeight, bottom: g.barBottom, background: paint }}
          data-colour-data=""
        />
      </span>
    ) : (
      <span
        className={color === null ? `${colourChip} ${emptyPaint}` : colourChip}
        style={{ width: g.chip, height: g.chip, background: paint }}
        data-colour-data=""
      />
    );

  if (native) {
    // Button-only attributes (form*, type) are meaningless on the input but
    // harmless; the ones that matter here — title, aria-*, data-*, handlers —
    // apply to it as they would to the button.
    const inputRest = {
      ...rest,
      onClick,
    } as unknown as React.InputHTMLAttributes<HTMLInputElement>;
    return (
      <span
        className={className ? `${nativeWrap} ${className}` : nativeWrap}
        style={style}
        data-disabled={disabled || undefined}
      >
        <span
          className={nativeFace}
          style={{
            minWidth: width,
            height: g.box,
            padding: chevron ? "0 4px" : 0,
            width: chevron ? undefined : width,
          }}
          aria-hidden
        >
          {face}
          {chevron && (
            <span className={chevronGlyph}>
              <DropdownChevron size={g.chevron} />
            </span>
          )}
        </span>
        <Tooltip
          content={tooltip === false ? null : tooltip ?? label}
          placement={tooltipPlacement}
          zIndex={zIndex !== undefined ? zIndex + 2 : undefined}
        >
          <input
            {...inputRest}
            type="color"
            className={overlayInput}
            aria-label={label}
            value={normalizeHex(color) ?? DEFAULT_PICKER_COLOR}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            data-testid={testId}
          />
        </Tooltip>
      </span>
    );
  }

  return (
    <>
      <IconButton
        {...rest}
        ref={setAnchor}
        icon={face}
        label={label}
        size={size}
        chevron={chevron}
        tooltip={tooltip}
        tooltipPlacement={tooltipPlacement}
        tooltipZIndex={zIndex !== undefined ? zIndex + 2 : undefined}
        disabled={disabled}
        className={className}
        style={chevron ? { minWidth: width, ...style } : { width, minWidth: width, ...style }}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid={testId}
        onClick={(e) => {
          onClick?.(e);
          if (!e.defaultPrevented) setOpen((o) => !o);
        }}
      />
      <ColorPopover
        anchorEl={anchor}
        open={open && !disabled}
        onClose={closePopover}
        value={color}
        onChange={onChange}
        onThemeColorChange={onThemeColorChange}
        allowAutomatic={allowAutomatic}
        onAutomatic={onAutomatic}
        themeSlot={themeSlot}
        themeTint={themeTint}
        showTheme={showTheme}
        colors={colors}
        colorsHeading={colorsHeading}
        automaticLabel={automaticLabel}
        customLabel={customLabel}
        moreAction={moreAction}
        automaticChip={automaticChip}
        ariaLabel={label}
        testId={testId ? `${testId}-popover` : undefined}
        zIndex={zIndex}
      />
    </>
  );
}
