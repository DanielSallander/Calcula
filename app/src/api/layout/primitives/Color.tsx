//! FILENAME: app/src/api/layout/primitives/Color.tsx
// PURPOSE: The colour controls of the Calcula Clusters grammar: ColorSwatch
//          (the trigger in a ribbon row or a pane), ColorPopover (the
//          palette it opens: theme grid with tints, standard row, automatic,
//          and "More Colors..." with a hex field) and ColorPalette (that same
//          palette BODY with no popover of its own, for a MenuSub flyout --
//          Excel's Format > Tab Color > and Borders > Line Color >).
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
//          SPLIT (`split` + `onApply`) is Excel's Font Color / Fill Color: the
//          face half APPLIES the colour shown on its bar, a separate 16px
//          chevron half opens the palette. The bar shows `color`, and in this
//          mode the caller passes the LAST colour applied from the button
//          (Excel's memory), not the active cell's -- a pick from the palette
//          reports onChange / onThemeColorChange / onAutomatic exactly as
//          before, and the caller records it. The split is IconButton's own
//          `split` form, so the two halves look and size like every other
//          split in the ribbon, and it follows SplitMenuButton's rules
//          (./Menu.tsx) wherever the two could disagree:
//
//          - the palette drops under the WHOLE control (the split wrapper is
//            the anchor), so a press on either half while it is open is not an
//            outside press: the chevron toggles it shut, the face closes it and
//            applies;
//          - keyboard: both halves are native buttons (tab stops; Enter/Space
//            on the face applies); ArrowDown/ArrowUp on either half open the
//            palette; Escape or a pick hand focus back to the HALF THAT OPENED
//            it (ColorPopover `returnFocusTo`), never to whichever half
//            happens to come first;
//          - DISABLED IS aria-disabled, NOT the native attribute: a natively
//            disabled button shows no tooltip and takes no focus, so a control
//            greyed out FOR A REASON could never say why. Both halves stay
//            reachable, look disabled (DISABLED_LOOK, no hover tint), and do
//            nothing. The bar is data and keeps its hue.
//
//          Without `split` nothing above applies and the DOM is the one this
//          file rendered before split existed (one button that opens the
//          palette) -- the mini toolbar, Format Cells and the chart panes
//          depend on that.
//
//          The palette's words are Excel's: "Theme Colors", "Standard Colors",
//          "More Colors..." (Excel's own spelling, since they are the names of
//          things users already know from Excel; the rest of this file's
//          comments keep the repo's "colour"). The automatic row is Excel's
//          "Automatic" (font: chip in the text colour) or "No Fill" (fill:
//          `automaticLabel="No Fill"`, `automaticChip="none"`), with its own
//          test id (`<testId>-automatic`). It is first by default; live Excel
//          365 (probed 2026-10-04) puts Font Color's "Automatic" first but
//          Fill Color's "No Fill" AFTER Standard Colors, just above "More
//          Colors...", which `automaticPlacement="afterColors"` reproduces.
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
import { DISABLED_LOOK, softDisabled } from "./disabled";
import { useFlyoutFocus, useMenuClose } from "./Menu";

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

  /* The colour bar/chip is a <span> with a background, so it fades with the
     face but keeps its hue: it is the colour that WOULD be applied. Only the
     icon above it loses its colour (DISABLED_LOOK greys svg/img). */
  &[data-disabled] {
    ${DISABLED_LOOK}
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

// A disabled SPLIT half is aria-disabled rather than natively disabled (see
// the header), so Button's `:disabled` rule never reaches it: it takes the kit's
// ONE aria-disabled rule, `softDisabled` (./disabled.ts), the same class
// SplitMenuButton's halves carry. DISABLED_LOOK greys svg/img only, so the bar
// (a <span>, and marked data-colour-data besides) fades but keeps its hue; a
// colour half is never a toggle, so the rule's pressed line never matches it.

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

/** A 28px menu-style row (Automatic / No Fill, More Colors..., an extra action). */
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

/**
 * The palette's own props: what ColorPalette takes, and what ColorPopover
 * takes besides its anchoring (ColorPopoverProps extends this).
 */
export interface ColorPaletteContentProps {
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
  /** Offer an "Automatic" row (value null), placed by automaticPlacement:
   *  Excel's "Automatic" (Font Color) or, renamed by automaticLabel, "No
   *  Fill" / "No Color". */
  allowAutomatic?: boolean;
  onAutomatic?: () => void;
  /** Label of the custom-colour row. Default "More Colors...". */
  customLabel?: string;
  /** The current theme slot, when the value is a theme colour. */
  themeSlot?: string;
  /** The current theme tint (permille, 0 = base) with themeSlot. */
  themeTint?: number;
  /** Heading of the fixed colours. Default "Standard Colors". */
  colorsHeading?: string;
  /** Label of the automatic row ("No Fill" for a fill). Default "Automatic". */
  automaticLabel?: string;
  /** An extra action row at the bottom; the palette finishes (the popover or
   *  the menu chain closes) before it runs. */
  moreAction?: ColorPopoverAction;
  /** data-testid of the palette body; `-automatic` / `-custom` / `-hex`
   *  suffix its rows and fields. */
  testId?: string;
  /** Stacking layer of the surface the palette sits on; its swatch tooltips
   *  sit one above. */
  zIndex?: number;
  /** What the automatic row's chip shows. "text" (default): a chip painted
   *  in the text colour, for "Automatic" meaning the default ink. "none": an
   *  empty outline, for "No fill" / "None" meaning no colour at all. */
  automaticChip?: "text" | "none";
  /** Where the automatic row sits. "first" (default): above the theme grid,
   *  where Excel's Font Color puts "Automatic". "afterColors": below the
   *  fixed colours and above "More Colors...", where Excel's Fill Color puts
   *  "No Fill" (measured in live Excel 365, 2026-10-04). */
  automaticPlacement?: "first" | "afterColors";
}

/** ColorPalette alone (the body without a popover of its own). */
export interface ColorPaletteProps extends ColorPaletteContentProps {
  /** Called after a pick (a swatch, the automatic row, the hex field's Enter,
   *  the extra action) -- BEFORE the enclosing menu chain closes, when the
   *  palette sits in one (a MenuSub flyout): useMenuClose() then closes it,
   *  so a pick finishes like choosing a MenuItem. Outside any menu that close
   *  is a no-op and onDone is the whole of "finished". */
  onDone?: () => void;
  /** Escape inside the palette, after a half-typed hex draft has been dropped
   *  (Escape CANCELS; it never applies the draft). Inside a MenuSub the
   *  flyout closes one level on its own; elsewhere the host closes. */
  onEscape?: () => void;
  /** Focus the selected swatch (else the first) once the theme grid has
   *  loaded. Default: when the enclosing MenuSub flyout was opened from the
   *  keyboard -- never when the pointer opened it, never outside a flyout. */
  autoFocus?: boolean;
}

export interface ColorPopoverProps extends ColorPaletteContentProps {
  anchorEl: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  /** Accessible name of the popover. Default "Colors". */
  ariaLabel?: string;
  /** Where focus goes when a pick or Escape closes the popover (only when
   *  focus was inside it). Default: the anchor, or its first focusable
   *  descendant. A split trigger anchors the popover on its whole wrapper but
   *  passes the HALF that opened it here, so a keyboard user lands back where
   *  they started rather than on whichever half comes first. */
  returnFocusTo?: HTMLElement | null;
  /** Default "bottom-start". */
  placement?: PopoverPlacement;
  /** Stacking layer (see Popover `zIndex`); swatch tooltips sit one above. */
  zIndex?: number;
}

type SwatchEntry =
  | { kind: "theme"; info: ThemeColorInfo }
  | { kind: "fixed"; hex: string };

// ---- One body, two hosts ----------------------------------------------------
//
// The palette is drawn by ONE function (renderPaletteBody) for two hosts:
// ColorPopover (the anchored popover a ColorSwatch opens) and ColorPalette (the
// same body with no popover of its own -- the content of a MenuSub flyout, so
// Excel's Format > Tab Color > and Borders > Line Color > are this palette and
// not a copy of it). Two things decided the shape:
//
// - The STATE stays where it lived. ColorPopover is mounted for as long as its
//   trigger is, and its palette state (the loaded theme, "settled") outlives a
//   close -- reopening shows the last theme at once while the fresh one loads.
//   The body itself is mounted only while open. So the state is a hook
//   (usePaletteState) that each host calls at its own top level, in the order
//   ColorPopover always called these hooks -- the heading ids come from ITS
//   useId, as they always did -- and the body is a plain render function the
//   host calls during its own render, NOT a component. That is measured, not
//   style: ColorPopover renders byte for byte what it rendered before
//   ColorPalette existed (a DOM dump of seventeen states -- closed, open,
//   settling, typed, escaped, reopened -- before and after), and a
//   <PaletteBody> component layer was tried and failed that dump: the extra
//   fiber moved when the initial focus landed while the palette settled. (The
//   React-compiler lint reports "refs during render" for handing the state to
//   a function; the refs in it are only read in handlers and ref callbacks.)
// - What differs is how a pick FINISHES and where focus goes. ColorPopover
//   closes itself and hands focus back to its anchor (or `returnFocusTo`).
//   ColorPalette calls `onDone` and then closes the enclosing menu chain
//   (useMenuClose, a no-op outside a menu) -- a pick from a flyout finishes
//   like choosing a MenuItem. Escape is "cancel" in both: the half-typed hex
//   draft is dropped before anything can blur-commit it.

/** The per-palette state both hosts keep (see "One body, two hosts"). */
interface PaletteState {
  idBase: string;
  bodyRef: React.RefObject<HTMLDivElement>;
  swatchRefs: React.MutableRefObject<Array<HTMLButtonElement | null>>;
  palette: ThemeColorInfo[];
  paletteSettled: boolean;
  focused: number;
  setFocused: (index: number) => void;
  hexDraft: string | null;
  hexDraftRef: React.MutableRefObject<string | null>;
  setHexDraft: (next: string | null) => void;
}

/**
 * The palette's state: the theme grid (reloaded on every open), whether it
 * has settled, the roving swatch, the hex draft. `open` is the host's open
 * state; ColorPalette, mounted only while shown, passes true.
 */
function usePaletteState(open: boolean, showTheme: boolean): PaletteState {
  const idBase = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const swatchRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [palette, setPalette] = useState<ThemeColorInfo[]>([]);
  // Focus-on-open waits for the first palette answer, so it lands on a
  // selected THEME swatch rather than on a standard one the grid then pushes
  // down. Without the theme grid there is nothing to wait for.
  const [paletteSettled, setPaletteSettled] = useState(!showTheme);
  const [focused, setFocused] = useState(-1);
  const [hexDraft, setHexDraftState] = useState<string | null>(null);
  // The draft is ALSO kept in a ref, cleared synchronously when it is committed:
  // Enter commits and closes, the close blurs the field, and the blur's commit
  // runs in the same render -- reading STATE it would still see the draft and
  // apply the colour a second time (two applies, two undo steps).
  const hexDraftRef = useRef<string | null>(null);
  const setHexDraft = (next: string | null): void => {
    hexDraftRef.current = next;
    setHexDraftState(next);
  };

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

  return {
    idBase,
    bodyRef,
    swatchRefs,
    palette,
    paletteSettled,
    focused,
    setFocused,
    hexDraft,
    hexDraftRef,
    setHexDraft,
  };
}

/** Where focus lands in a palette: the roving swatch (the selected one, else
 *  the first), else the first focusable (a palette with no swatches). */
function paletteFocusTarget(body: HTMLElement | null): HTMLElement | null {
  if (!body) return null;
  return body.querySelector<HTMLElement>('[data-colour-swatch][tabindex="0"]') ?? firstFocusable(body);
}

/** Focus the selected swatch once the palette has settled, while `focusNow`.
 *  Deferred a task (focusWhenShown): a popover renders hidden for the pass
 *  that measures it, and a hidden element cannot take focus. */
function usePaletteFocus(state: PaletteState, focusNow: boolean): void {
  const { bodyRef, paletteSettled } = state;
  useEffect(() => {
    if (!focusNow || !paletteSettled) return;
    return focusWhenShown(
      () => bodyRef.current,
      () => paletteFocusTarget(bodyRef.current),
    );
  }, [focusNow, paletteSettled, bodyRef]);
}

/** What renderPaletteBody draws from: the content props with their defaults
 *  resolved, and the host's two ways of finishing. */
interface PaletteBodyOptions
  extends Required<
    Pick<
      ColorPaletteContentProps,
      | "showTheme"
      | "colors"
      | "customLabel"
      | "colorsHeading"
      | "automaticLabel"
      | "automaticChip"
      | "automaticPlacement"
    >
  > {
  value: string | null;
  onChange: (hex: string) => void;
  onThemeColorChange?: (slot: string, tint: number, hex: string) => void;
  allowAutomatic?: boolean;
  onAutomatic?: () => void;
  themeSlot?: string;
  themeTint?: number;
  moreAction?: ColorPopoverAction;
  testId?: string;
  zIndex?: number;
  /** A pick is finished: the host closes (and places focus). */
  done: () => void;
  /** Escape, after the draft has been dropped. */
  onEscape?: () => void;
}

/**
 * The palette body: theme grid with tints, the fixed colours, the automatic
 * row, "More Colors..." with its hex field, the extra action. Stateless: the
 * state is the host's (see "One body, two hosts").
 */
function renderPaletteBody(o: PaletteBodyOptions, s: PaletteState): React.ReactElement {
  const { value, onChange, onThemeColorChange, showTheme, colors, themeSlot, themeTint, testId, zIndex, done } = o;
  const { palette, focused, setFocused, hexDraft, hexDraftRef, setHexDraft, swatchRefs } = s;

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
    done();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "Escape") {
      // The host closes on Escape itself -- ColorPopover's Popover at its own
      // root (which also stops the key there, so a collapsed group's flyout
      // around the palette stays open: Popover's ESCAPE NESTS), a MenuSub
      // flyout through its group's handler (which stops it too) -- and both
      // hear the key AFTER this body, which therefore must not stop it.
      // Escape CANCELS: closing moves
      // focus off a focused hex field, its blur commits whatever draft it
      // holds, and so Escape used to APPLY a half-typed colour (found
      // 2026-10-04). Dropping the draft from the ref -- which is what
      // commitHex reads -- makes that blur a no-op. Then the host's own step
      // (ColorPopover: focus to `returnFocusTo`, while the content is still
      // mounted).
      hexDraftRef.current = null;
      o.onEscape?.();
      return;
    }
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
    const draft = hexDraftRef.current;
    if (draft === null) {
      if (andClose) done();
      return;
    }
    const hex = normalizeHex(draft);
    if (hex === null) return;
    setHexDraft(null);
    if (!sameColor(hex, value)) onChange(hex);
    if (andClose) done();
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

  /** "Automatic" / "No Fill": one element, placed by automaticPlacement. */
  const automaticRow = o.allowAutomatic ? (
    <button
      type="button"
      className={actionRow}
      aria-pressed={value === null}
      data-testid={testId ? `${testId}-automatic` : undefined}
      onClick={() => {
        o.onAutomatic?.();
        done();
      }}
    >
      <span
        className={o.automaticChip === "none" ? `${rowChip} ${emptyPaint}` : `${rowChip} ${automaticChip}`}
        aria-hidden
      />
      <span>{o.automaticLabel}</span>
    </button>
  ) : null;

  const themeHeadingId = `${s.idBase}-theme`;
  const fixedHeadingId = `${s.idBase}-fixed`;
  const tintOffset = themeBase.length;
  const fixedOffset = themeBase.length + themeTints.length;
  const moreAction = o.moreAction;

  return (
    <div ref={s.bodyRef} className={popoverBody} onKeyDown={handleKeyDown} data-testid={testId}>
      {o.automaticPlacement === "first" && automaticRow}

      {themeBase.length > 0 && (
        <div role="group" aria-labelledby={themeHeadingId}>
          <div id={themeHeadingId} className={sectionLabel}>
            Theme Colors
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
            {o.colorsHeading}
          </div>
          <div className={paletteGrid}>
            {colors.map((hex, i) => renderSwatch({ kind: "fixed", hex }, fixedOffset + i))}
          </div>
        </div>
      )}

      {o.automaticPlacement === "afterColors" && automaticRow && (
        <>
          <div className={divider} />
          {automaticRow}
        </>
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
          <span>{o.customLabel}</span>
          <input
            type="color"
            className={overlayInput}
            aria-label={o.customLabel}
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
              done();
              moreAction.onSelect();
            }}
          >
            {moreAction.label}
          </button>
        </>
      )}
    </div>
  );
}

/**
 * The colour palette popover (card chrome). Opens with focus on the selected
 * swatch (else the first); arrow keys walk the swatches as one ten-wide grid
 * (theme base row, tint rows, standard rows), Home/End jump to the ends,
 * Enter/Space pick. Picking closes it and returns focus to the anchor. The
 * body is ColorPalette's (renderPaletteBody); this adds the anchored card.
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
  customLabel = "More Colors...",
  themeSlot,
  themeTint,
  colorsHeading = "Standard Colors",
  automaticLabel = "Automatic",
  moreAction,
  ariaLabel,
  testId,
  placement = "bottom-start",
  zIndex,
  automaticChip: automaticChipKind = "text",
  automaticPlacement = "first",
  returnFocusTo,
}: ColorPopoverProps): React.ReactElement | null {
  const state = usePaletteState(open, showTheme);
  const { bodyRef } = state;

  /** Close after a pick and hand focus back to the anchor (or to
   *  `returnFocusTo`), when focus was in here — the popover is about to
   *  unmount, which would drop it on <body>. */
  const finish = useCallback(() => {
    const body = bodyRef.current;
    const focusInside = body !== null && body.contains(document.activeElement);
    const restore = !focusInside
      ? null
      : returnFocusTo ?? (anchorEl ? firstFocusable(anchorEl) : null);
    onClose();
    restore?.focus();
  }, [anchorEl, onClose, returnFocusTo, bodyRef]);

  usePaletteFocus(state, open);

  const body: PaletteBodyOptions = {
    value,
    onChange,
    onThemeColorChange,
    showTheme,
    colors,
    allowAutomatic,
    onAutomatic,
    customLabel,
    themeSlot,
    themeTint,
    colorsHeading,
    automaticLabel,
    moreAction,
    testId,
    zIndex,
    automaticChip: automaticChipKind,
    automaticPlacement,
    done: finish,
    // With `returnFocusTo`, focus goes there while the content is still
    // mounted, and the Popover is told not to restore focus itself
    // (returnFocus below), so the half that opened the palette gets it back,
    // not the anchor's first focusable.
    onEscape: returnFocusTo ? () => returnFocusTo.focus() : undefined,
  };

  return (
    <Popover
      card
      anchorEl={anchorEl}
      open={open}
      onClose={onClose}
      placement={placement}
      ariaLabel={ariaLabel ?? "Colors"}
      zIndex={zIndex}
      returnFocus={returnFocusTo ? false : undefined}
    >
      {/* eslint-disable-next-line react-hooks/refs -- the body only reads the state's refs in handlers and ref callbacks, never while rendering; it is a plain function on purpose (see "One body, two hosts") */}
      {renderPaletteBody(body, state)}
    </Popover>
  );
}

/**
 * The palette BODY on its own, with no popover around it: the same theme grid,
 * fixed colours, automatic row, "More Colors..." and extra action ColorPopover
 * shows (they are one render), for a surface that already IS the overlay -- a
 * MenuSub flyout, Excel's Format > Tab Color > and Borders > Line Color >:
 *
 * ```tsx
 * <MenuSub label="Tab Color" icon={MENU_ICON_BLANK}>
 *   <ColorPalette value={tab} onChange={setTab} allowAutomatic automaticLabel="No Color"
 *     automaticChip="none" onAutomatic={() => setTab(null)} />
 * </MenuSub>
 * ```
 *
 * A pick reports (onChange / onThemeColorChange / onAutomatic, exactly as in
 * ColorPopover), calls `onDone`, and closes the enclosing menu chain the way a
 * MenuItem does (useMenuClose; outside a menu, nothing to close). Escape drops
 * a half-typed hex draft and, in a flyout, closes that one level. Opened from
 * the keyboard, a flyout's palette takes focus on its SELECTED swatch once the
 * theme has loaded, and ArrowRight on its row steps in to the same swatch;
 * opened by the pointer it leaves focus on the row (`autoFocus` overrides).
 */
export function ColorPalette({
  value,
  onChange,
  onThemeColorChange,
  showTheme = true,
  colors = STANDARD_COLORS,
  allowAutomatic,
  onAutomatic,
  customLabel = "More Colors...",
  themeSlot,
  themeTint,
  colorsHeading = "Standard Colors",
  automaticLabel = "Automatic",
  moreAction,
  testId,
  zIndex,
  automaticChip: automaticChipKind = "text",
  automaticPlacement = "first",
  onDone,
  onEscape,
  autoFocus,
}: ColorPaletteProps): React.ReactElement {
  // Mounted only while shown, so "open" is simply true for this host.
  const state = usePaletteState(true, showTheme);
  const { bodyRef } = state;
  const closeChain = useMenuClose();
  const fromFlyout = useFlyoutFocus(() => paletteFocusTarget(bodyRef.current)?.focus());
  usePaletteFocus(state, autoFocus ?? fromFlyout !== null);

  const done = (): void => {
    onDone?.();
    closeChain();
  };

  return renderPaletteBody(
    {
      value,
      onChange,
      onThemeColorChange,
      showTheme,
      colors,
      allowAutomatic,
      onAutomatic,
      customLabel,
      themeSlot,
      themeTint,
      colorsHeading,
      automaticLabel,
      moreAction,
      testId,
      zIndex,
      automaticChip: automaticChipKind,
      automaticPlacement,
      done,
      onEscape,
    },
    state,
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
  /** A dropdown chevron beside the face. Ignored with `split`, which has a
   *  chevron half of its own. */
  chevron?: boolean;
  /** Open the OS colour picker directly instead of the palette popover.
   *  Wins over `split`. */
  native?: boolean;
  /** Excel's split colour button (Font Color / Fill Color): the face half
   *  runs `onApply`, a separate 16px chevron half opens the palette. Pass the
   *  LAST colour applied from the button as `color`, so the bar shows what a
   *  press on the face will apply. See the header for the keyboard and the
   *  disabled rules. */
  split?: boolean;
  /** Split only: the face half was pressed -- apply the colour on the bar.
   *  Without it the face is aria-disabled rather than a live button that does
   *  nothing (IconButton's rule for a chevron half without a handler). */
  onApply?: () => void;
  /** Split only: data-testid of the chevron half. */
  chevronTestId?: string;
  /** Split only: aria-label (and tooltip) of the chevron half; default
   *  `${label} options`. */
  chevronLabel?: string;
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
  automaticPlacement?: "first" | "afterColors";
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
 * `native`, the OS picker; with `split`, the face applies and only the chevron
 * half opens the palette). The current colour is shown as data: the bar or the
 * chip carries `data-colour-data`.
 */
export function ColorSwatch({
  color,
  onChange,
  label,
  variant = "swatch",
  icon,
  chevron,
  native,
  split,
  onApply,
  chevronTestId,
  chevronLabel,
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
  automaticPlacement,
  open: openProp,
  onOpenChange,
  tooltipPlacement,
  zIndex,
  className,
  style,
  disabled,
  onClick,
  onKeyDown,
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
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  // Split only: the chevron half (where focus returns by default), and the
  // half that opened the palette this time, when one of them did. Both are
  // STATE rather than refs because they are handed to the popover at render.
  const [chevronHalf, setChevronHalf] = useState<HTMLElement | null>(null);
  const [openedFrom, setOpenedFrom] = useState<HTMLElement | null>(null);
  const g = SWATCH_GEOMETRY[size];
  const width = variant === "bar" ? g.barWidth : g.box;
  const paint = color ?? "transparent";
  const closePopover = useCallback(() => {
    setOpenedFrom(null);
    setOpen(false);
  }, [setOpen]);

  // DISABLED WHILE OPEN CLOSES (SplitMenuButton's rule). The palette is gated
  // by `!disabled` at render, but `open` used to stay true underneath, so the
  // palette popped back by itself on re-enable. An effect rather than a
  // render-time adjustment: closing may call the caller's onOpenChange, a
  // parent update React refuses during this component's render.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- closing may notify the caller (onOpenChange), which React refuses during render; the guard makes it run once
    if (disabled && open) closePopover();
  }, [disabled, open, closePopover]);

  /** Split only: the face button's ref. The anchor is its WRAPPER, so the
   *  palette drops under the whole control and a press on either half is not
   *  an outside press; the chevron half is found here, once per mount, rather
   *  than queried on every render. Stable, so React attaches it once. */
  const setSplitParts = useCallback((faceEl: HTMLButtonElement | null) => {
    const wrapper = faceEl?.parentElement ?? null;
    setAnchor(wrapper ?? faceEl);
    setChevronHalf(wrapper?.querySelector<HTMLElement>(".split-chevron") ?? null);
  }, []);

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
      onKeyDown,
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

  /** The palette, the same for both forms; only where focus returns differs
   *  (the default anchor for the one-button form, the opening half for split). */
  const palette = (returnFocusTo?: HTMLElement | null): React.ReactElement => (
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
      automaticPlacement={automaticPlacement}
      ariaLabel={label}
      testId={testId ? `${testId}-popover` : undefined}
      zIndex={zIndex}
      returnFocusTo={returnFocusTo}
    />
  );

  if (split) {
    const halfLabel = chevronLabel ?? `${label} options`;
    // The face is live only when there is something to apply.
    const faceDisabled = disabled || !onApply;
    const openFrom = (half: HTMLElement): void => {
      setOpenedFrom(half);
      setOpen(true);
    };
    /** ArrowDown/ArrowUp on either half open the palette, which takes focus
     *  (its selected swatch, else the first) -- the kit's trigger rule
     *  (Menu, Dropdown, SplitMenuButton). A palette has no "last item", so
     *  both arrows open it the same way. Already open: nothing more to do,
     *  but the arrow is still consumed so the page does not scroll. */
    const arrowOpens = (e: React.KeyboardEvent<HTMLButtonElement>): void => {
      if (disabled || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
      e.preventDefault();
      if (!open) openFrom(e.currentTarget);
    };
    const chevronProps = {
      // eslint-disable-next-line @typescript-eslint/naming-convention -- a DOM attribute name
      "data-testid": chevronTestId,
      // eslint-disable-next-line @typescript-eslint/naming-convention -- a DOM attribute name
      "aria-haspopup": "dialog",
      // eslint-disable-next-line @typescript-eslint/naming-convention -- a DOM attribute name
      "aria-expanded": open && !disabled,
      // eslint-disable-next-line @typescript-eslint/naming-convention -- a DOM attribute name
      "aria-disabled": disabled ? true : undefined,
      className: disabled ? softDisabled : undefined,
      onKeyDown: arrowOpens,
    } as React.ButtonHTMLAttributes<HTMLButtonElement>;

    return (
      <>
        <IconButton
          {...rest}
          ref={setSplitParts}
          split
          icon={face}
          label={label}
          size={size}
          tooltip={tooltip}
          tooltipPlacement={tooltipPlacement}
          tooltipZIndex={zIndex !== undefined ? zIndex + 2 : undefined}
          className={[className, faceDisabled ? softDisabled : undefined].filter(Boolean).join(" ") || undefined}
          // IconButton sizes a split's face as a square; the bar face keeps
          // its own 32px (28px sm) width, exactly as in the one-button form.
          style={{ width, minWidth: width, ...style }}
          aria-disabled={faceDisabled ? true : undefined}
          data-testid={testId}
          chevronLabel={halfLabel}
          chevronProps={chevronProps}
          onClick={(e) => {
            if (faceDisabled) {
              e.preventDefault();
              return;
            }
            onClick?.(e);
            if (e.defaultPrevented) return;
            if (open) closePopover();
            onApply?.();
          }}
          onKeyDown={(e) => {
            onKeyDown?.(e);
            if (e.defaultPrevented) return;
            arrowOpens(e);
          }}
          onChevronClick={(e) => {
            if (disabled) {
              e.preventDefault();
              return;
            }
            if (open) {
              closePopover();
              return;
            }
            openFrom(e.currentTarget);
          }}
        />
        {palette(openedFrom ?? chevronHalf)}
      </>
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
        aria-expanded={open && !disabled}
        data-testid={testId}
        onClick={(e) => {
          onClick?.(e);
          if (!e.defaultPrevented) setOpen((o) => !o);
        }}
        onKeyDown={onKeyDown}
      />
      {palette()}
    </>
  );
}
