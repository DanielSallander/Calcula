//! FILENAME: app/src/api/layout/primitives/PaletteStrip.tsx
// PURPOSE: PaletteStrip — pick a categorical colour palette (Office, Tableau,
//          Viridis...) from a strip of four-bar previews, with "More palettes"
//          opening every palette by name.
// CONTEXT: The Chart Design band's Style cluster in the approved mockup: row
//          one is four 44x28 palette buttons and a 28px "More palettes" icon
//          button, which with the Series row under it fills the 61px content
//          box as TWO ROWS (28 + 5 + 28). The strip is the same in the sidebar.
//
//          The four bars in each button are the palette's first four colours,
//          and they are DATA: they stay literal and carry `data-colour-data`.
//          Everything around them — the button chrome, the selection ring, the
//          popover — paints with LT tokens.
//
//          The strip is a radiogroup and behaves like one: arrow keys move AND
//          choose (a palette change is cheap and immediately visible, like a
//          native radio), with a roving tabindex so the strip is one Tab stop.
//          The popover is a listbox instead: arrows move, Enter chooses and
//          closes — the familiar menu contract for a longer list.
//
//          The strip shows the first `visible` palettes. When the selected one
//          is not among them it takes the LAST slot, so the current choice is
//          always visible without reshuffling the familiar ones.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { css } from "@emotion/css";
import { LT } from "../theme";
import { FONT_FAMILY, GAP_XS, ICON_SIZE_SM } from "../tokens";
import { RibbonIcon } from "../../ribbonIcons";
import { IconButton } from "./Button";
import { Popover, firstFocusable } from "./Popover";
import { Tooltip } from "./Tooltip";
import { focusWhenShown, gridKeyTarget, gridRows } from "./Tile";

// ============================================================================
// Types
// ============================================================================

export interface PaletteOption {
  id: string;
  /** Display name ("Office"); the radio's accessible name and tooltip. */
  name: string;
  /** The palette's colours in series order. The strip shows the first four. */
  colors: readonly string[];
}

export interface PaletteStripProps {
  palettes: readonly PaletteOption[];
  /** The selected palette id. */
  value: string;
  onChange: (id: string) => void;
  /** How many palettes the strip shows before "More palettes". Default 4. */
  visible?: number;
  /** Radios get `<prefix>-<id>`, the button `<prefix>-more`, popover options
   *  `<prefix>-option-<id>`, the popover list `<prefix>-list`. */
  testIdPrefix?: string;
  /** The radiogroup's accessible name. Default "Colour palette". */
  ariaLabel?: string;
  /** Name of the overflow button. Default "More palettes". A strip of
   *  STYLES (the Sparkline tab) says "More styles". */
  moreLabel?: string;
  /** Heading of the overflow popover. Default "Colour palettes". */
  popoverHeading?: string;
}

// ============================================================================
// Geometry + styles
// ============================================================================

/** Bars the strip button shows (44x28: padding 3, bars 6x18, gap 2). */
const STRIP_BARS = 4;
/** Bars a popover row shows — enough to tell two similar palettes apart. */
const LIST_BARS = 8;
/** Popover list columns. */
const LIST_COLUMNS = 2;

const strip = css`
  display: inline-flex;
  align-items: center;
  gap: ${GAP_XS}px;
  flex-wrap: nowrap;
`;

const radioGroup = css`
  display: inline-flex;
  align-items: center;
  gap: ${GAP_XS}px;
`;

/** The mockup's `.cal-pal`: a surface chip with an inset hairline; selected
 *  is a 2px state-accent ring. Rings are inset so selecting never changes the
 *  button's outer size. */
const paletteButton = css`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  flex: none;
  box-sizing: border-box;
  width: 44px;
  height: 28px;
  padding: 3px;
  border: none;
  border-radius: 6px;
  background: ${LT.surface};
  box-shadow: inset 0 0 0 1px ${LT.controlBorder};
  cursor: pointer;
  transition:
    background-color ${LT.motionHover},
    box-shadow ${LT.motionHover};

  &:hover:not(:disabled) {
    background: linear-gradient(${LT.hover}, ${LT.hover}), ${LT.surface};
  }

  &[aria-checked="true"] {
    box-shadow: inset 0 0 0 2px ${LT.stateAccent};
  }

  &:focus-visible {
    outline: none;
    box-shadow:
      inset 0 0 0 1px ${LT.controlBorder},
      ${LT.focusRing};
  }

  &[aria-checked="true"]:focus-visible {
    box-shadow:
      inset 0 0 0 2px ${LT.stateAccent},
      ${LT.focusRing};
  }
`;

const bar = css`
  display: block;
  flex: none;
  width: 6px;
  height: 18px;
  border-radius: 2px;
`;

/** The same four-bar chip, not a button: the popover row's preview. */
const miniStrip = css`
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex: none;
  box-sizing: border-box;
  height: 28px;
  padding: 3px;
  border-radius: 6px;
  background: ${LT.surface};
  box-shadow: inset 0 0 0 1px ${LT.controlBorder};
`;

const list = css`
  display: grid;
  grid-template-columns: repeat(${LIST_COLUMNS}, minmax(150px, 1fr));
  gap: ${GAP_XS}px;
`;

const listOption = css`
  display: flex;
  align-items: center;
  gap: 8px;
  box-sizing: border-box;
  min-width: 0;
  height: 36px;
  padding: 0 8px 0 4px;
  border: 1px solid transparent;
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

  &:focus-visible {
    outline: none;
    box-shadow: ${LT.focusRing};
  }

  &[aria-selected="true"] {
    background: ${LT.pressed};
    border-color: ${LT.pressedBorder};
  }

  &[aria-selected="true"] > span:first-child {
    box-shadow: inset 0 0 0 2px ${LT.stateAccent};
  }
`;

const optionName = css`
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

// ============================================================================
// Helpers
// ============================================================================

/**
 * The palettes the strip shows: the first `visible`, with the selected one in
 * the last slot when it is not already among them. Exported for tests.
 */
export function stripPalettes<T extends { id: string }>(
  palettes: readonly T[],
  value: string,
  visible: number,
): T[] {
  const n = Math.max(1, Math.floor(visible));
  const head = palettes.slice(0, n);
  if (head.some((p) => p.id === value)) return head;
  const selected = palettes.find((p) => p.id === value);
  if (!selected) return head;
  return [...head.slice(0, n - 1), selected];
}

function Bars({ colors, count }: { colors: readonly string[]; count: number }): React.ReactElement {
  return (
    <>
      {colors.slice(0, count).map((c, i) => (
        <span key={i} className={bar} style={{ background: c }} data-colour-data="" />
      ))}
    </>
  );
}

// ============================================================================
// Component
// ============================================================================

/**
 * A strip of palette radios plus "More palettes". Renders the same in the
 * band and the panel; it is one 28px row either way.
 */
export function PaletteStrip({
  palettes,
  value,
  onChange,
  visible = 4,
  testIdPrefix,
  ariaLabel,
  moreLabel = "More palettes",
  popoverHeading = "Colour palettes",
}: PaletteStripProps): React.ReactElement {
  const shown = stripPalettes(palettes, value, visible);
  const hasMore = palettes.length > shown.length;
  const radioRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const [moreEl, setMoreEl] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  /** The list's roving tab stop once the user has moved; -1 = the selection. */
  const [listFocused, setListFocused] = useState(-1);
  const tid = (suffix: string): string | undefined =>
    testIdPrefix ? `${testIdPrefix}-${suffix}` : undefined;

  const checkedIndex = shown.findIndex((p) => p.id === value);
  const rovingRadio = checkedIndex >= 0 ? checkedIndex : 0;

  /** Radiogroup keys: move AND choose, wrapping like native radios. */
  const handleRadioKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const current = radioRefs.current.indexOf(e.target as HTMLButtonElement);
    if (current < 0 || shown.length === 0) return;
    let next: number;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = (current + 1) % shown.length;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = (current - 1 + shown.length) % shown.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = shown.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    radioRefs.current[next]?.focus();
    if (shown[next].id !== value) onChange(shown[next].id);
  };

  const listRows = gridRows([palettes.length], LIST_COLUMNS);
  const selectedListIndex = palettes.findIndex((p) => p.id === value);
  const listEntry =
    listFocused >= 0 && listFocused < palettes.length
      ? listFocused
      : selectedListIndex >= 0
        ? selectedListIndex
        : 0;

  const handleListKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const current = optionRefs.current.indexOf(e.target as HTMLButtonElement);
    if (current < 0) return;
    const next = gridKeyTarget(listRows, current, e.key);
    if (next === null) return;
    e.preventDefault();
    optionRefs.current[next]?.focus();
  };

  const closeList = useCallback(() => setOpen(false), []);

  /** Choosing in the popover closes it and returns focus to "More palettes". */
  const chooseFromList = (id: string): void => {
    const restoreTo =
      moreEl && listRef.current?.contains(document.activeElement) ? firstFocusable(moreEl) : null;
    setOpen(false);
    restoreTo?.focus();
    if (id !== value) onChange(id);
  };

  useEffect(() => {
    if (!open) return;
    return focusWhenShown(
      () => listRef.current,
      () => listRef.current?.querySelector<HTMLElement>('[role="option"][tabindex="0"]') ?? null,
    );
  }, [open]);

  return (
    <div className={strip}>
      <div
        role="radiogroup"
        aria-label={ariaLabel ?? "Colour palette"}
        className={radioGroup}
        onKeyDown={handleRadioKey}
      >
        {shown.map((p, i) => (
          <Tooltip key={p.id} content={p.name}>
            <button
              type="button"
              role="radio"
              aria-checked={p.id === value}
              aria-label={p.name}
              tabIndex={i === rovingRadio ? 0 : -1}
              className={paletteButton}
              ref={(el) => {
                radioRefs.current[i] = el;
              }}
              data-testid={tid(p.id)}
              onClick={() => {
                if (p.id !== value) onChange(p.id);
              }}
            >
              <Bars colors={p.colors} count={STRIP_BARS} />
            </button>
          </Tooltip>
        ))}
      </div>

      {hasMore && (
        <IconButton
          ref={setMoreEl}
          icon={<RibbonIcon.Palette size={ICON_SIZE_SM} />}
          label={moreLabel}
          aria-haspopup="dialog"
          aria-expanded={open}
          data-testid={tid("more")}
          onClick={() => {
            // Every open starts on the selected palette, not where focus was
            // when the list last closed.
            if (!open) setListFocused(-1);
            setOpen(!open);
          }}
        />
      )}

      {hasMore && (
        <Popover
          card
          anchorEl={moreEl}
          open={open}
          onClose={closeList}
          placement="bottom-end"
          heading={popoverHeading}
        >
          <div
            ref={listRef}
            role="listbox"
            aria-label={ariaLabel ?? "Colour palette"}
            className={list}
            onKeyDown={handleListKey}
            data-testid={tid("list")}
          >
            {palettes.map((p, i) => (
              <button
                key={p.id}
                type="button"
                role="option"
                aria-selected={p.id === value}
                tabIndex={i === listEntry ? 0 : -1}
                className={listOption}
                ref={(el) => {
                  optionRefs.current[i] = el;
                }}
                data-testid={tid(`option-${p.id}`)}
                onFocus={() => setListFocused(i)}
                onClick={() => chooseFromList(p.id)}
              >
                <span className={miniStrip} aria-hidden>
                  <Bars colors={p.colors} count={LIST_BARS} />
                </span>
                <span className={optionName}>{p.name}</span>
              </button>
            ))}
          </div>
        </Popover>
      )}
    </div>
  );
}
