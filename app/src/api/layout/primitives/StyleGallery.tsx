//! FILENAME: app/src/api/layout/primitives/StyleGallery.tsx
// PURPOSE: StyleGallery — choose a visual style (chart style, table style,
//          pivot style, cell style) from rendered thumbnails, with live
//          preview while the pointer or keyboard rests on one.
// CONTEXT: Excel's in-ribbon gallery, redrawn in the Clusters grammar:
//
//          BAND   one outlined strip that FILLS the cluster's 61px content box
//                 (the fill rule, ../tokens.ts): `visible` 56x40 thumbnails and
//                 a full-height expand button. The expand button opens a card
//                 popover with every style as a grouped grid.
//          PANEL  the grouped grid inline, as many columns as the panel is wide.
//
//          Every grid — the strip, the popover, the panel — is a single-select
//          listbox with a roving tabindex. Arrow keys MOVE (2-D in the grids,
//          across groups), Enter/Space/click CHOOSE. Moving never chooses,
//          because a style change re-renders the chart/table; the user sees
//          the style through `onHover` preview instead and commits once.
//
//          onHover(id | null) is the preview seam: it fires with an id when a
//          thumbnail is hovered or focused and with null when the pointer
//          leaves, focus leaves, a choice is made (null FIRST, then onChange,
//          so a caller whose preview-end restores a snapshot cannot undo the
//          commit), the popover closes, or the gallery unmounts mid-preview.
//          No gesture can leave a preview standing.
//
//          The thumbnails are caller-rendered (renderThumb) and are DATA: each
//          thumbnail container carries `data-colour-data`. The strip, the
//          selection ring and the popover paint with LT tokens only.

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { css } from "@emotion/css";
import { useSurfaceLayout } from "../context";
import { LT } from "../theme";
import { FONT_FAMILY, GAP_XS, TALL_CONTROL_HEIGHT } from "../tokens";
import { RibbonIcon } from "../../ribbonIcons";
import { IconButton } from "./Button";
import { Popover, firstFocusable } from "./Popover";
import { Tooltip } from "./Tooltip";
import { focusWhenShown, gridKeyTarget, gridRows } from "./Tile";

// ============================================================================
// Types
// ============================================================================

export interface StyleThumbSize {
  w: number;
  h: number;
}

export interface StyleGalleryItem {
  id: string;
  /** Accessible name and tooltip ("Style 3", "Medium 2"). */
  name: string;
  /** Group heading in the popover/panel grid ("Light", "Medium", "Dark"). */
  group?: string;
  /** Draw the thumbnail at exactly this size. */
  renderThumb: (size: StyleThumbSize) => React.ReactNode;
}

export interface StyleGalleryProps {
  items: readonly StyleGalleryItem[];
  /** The applied style, or null for none. */
  value: string | null;
  onChange: (id: string) => void;
  /** Live preview: an id while one is hovered/focused, null when it ends. */
  onHover?: (id: string | null) => void;
  /** Thumbnail size. Default 56x40 (fits the band's 61px strip). */
  thumbSize?: StyleThumbSize;
  /** The gallery's accessible name ("Chart styles"). */
  label: string;
  /** Thumbnails in the band strip. Default 3. */
  visible?: number;
  /** Which items the band strip starts from, in order (default: the first
   *  `visible` items). Table styles list None and the Light family first, but
   *  the familiar strip is Medium 1-7. Unknown ids are skipped; the selected
   *  item still takes the last slot when it is not among them. */
  stripIds?: readonly string[];
  /** Strip thumbs `<prefix>-<id>`, expand `<prefix>-expand`, popover options
   *  `<prefix>-option-<id>`; panel options `<prefix>-<id>`. */
  testIdPrefix?: string;
  /** Popover grid columns. Default 5. */
  columns?: number;
  /** Name of the expand button. Default `More ${label}`. */
  expandLabel?: string;
}

// ============================================================================
// Geometry + styles
// ============================================================================

const DEFAULT_THUMB: StyleThumbSize = { w: 56, h: 40 };
/** Padding around a thumbnail inside its option button (the ring lives here). */
const THUMB_PAD = 3;
/** Width of the band strip's expand column. */
const EXPAND_WIDTH = 20;
/** Horizontal padding inside the band strip. */
const STRIP_PAD_X = 4;

/** The band strip: one outlined box, exactly the content box's height. The
 *  border is an inset shadow, so the outer height is exactly 61. */
const bandStrip = css`
  display: inline-flex;
  align-items: stretch;
  flex: none;
  box-sizing: border-box;
  height: ${TALL_CONTROL_HEIGHT}px;
  border-radius: ${LT.radiusControl};
  background: ${LT.surface};
  box-shadow: inset 0 0 0 1px ${LT.controlBorder};
`;

const bandRow = css`
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 ${STRIP_PAD_X}px;
`;

/** The expand column: square left edge and a hairline divider, like a split
 *  button's chevron half; the focus ring (higher specificity, in Button's
 *  recipe) replaces the divider while focused. */
const expandButton = css`
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
  box-shadow: inset 1px 0 0 ${LT.controlDivider};
`;

const thumbOption = css`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  box-sizing: border-box;
  padding: ${THUMB_PAD}px;
  border: none;
  border-radius: 6px;
  background: ${LT.buttonBg};
  cursor: pointer;
  transition:
    background-color ${LT.motionHover},
    box-shadow ${LT.motionHover};

  &:hover {
    background: ${LT.hover};
  }

  &[aria-selected="true"] {
    box-shadow: inset 0 0 0 2px ${LT.stateAccent};
  }

  &:focus-visible {
    outline: none;
    box-shadow: ${LT.focusRing};
  }

  &[aria-selected="true"]:focus-visible {
    box-shadow:
      inset 0 0 0 2px ${LT.stateAccent},
      ${LT.focusRing};
  }
`;

/** The thumbnail box: clips the caller's drawing to the promised size. */
const thumbBox = css`
  display: block;
  flex: none;
  overflow: hidden;
  border-radius: 3px;
  pointer-events: none;
`;

const gridRoot = css`
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-family: ${FONT_FAMILY};
`;

const groupHeading = css`
  padding: 6px 8px 4px;
  font-family: ${FONT_FAMILY};
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  color: ${LT.textSecondary};
`;

const grid = css`
  display: grid;
  gap: ${GAP_XS}px;
`;

// ============================================================================
// Helpers
// ============================================================================

/**
 * The items the band strip shows: the first `visible`, with the selected one
 * in the last slot when it is not already among them. Exported for tests.
 */
export function stripItems<T extends { id: string }>(
  items: readonly T[],
  value: string | null,
  visible: number,
  stripIds?: readonly string[],
): T[] {
  const n = Math.max(1, Math.floor(visible));
  const preferred = stripIds
    ? stripIds
        .map((id) => items.find((it) => it.id === id))
        .filter((it): it is T => it !== undefined)
    : [];
  const head = (preferred.length > 0 ? preferred : items).slice(0, n);
  if (value === null || head.some((it) => it.id === value)) return head;
  const selected = items.find((it) => it.id === value);
  if (!selected) return head;
  return [...head.slice(0, n - 1), selected];
}

interface ItemGroup {
  name: string | undefined;
  items: StyleGalleryItem[];
}

function groupItems(items: readonly StyleGalleryItem[]): ItemGroup[] {
  const groups: ItemGroup[] = [];
  const byName = new Map<string | undefined, ItemGroup>();
  for (const item of items) {
    let g = byName.get(item.group);
    if (!g) {
      g = { name: item.group, items: [] };
      byName.set(item.group, g);
      groups.push(g);
    }
    g.items.push(item);
  }
  return groups;
}

/**
 * Preview bookkeeping shared by every grid of one gallery: remembers whether a
 * preview is standing so the unmount path can end it, and funnels every
 * start/end through one place.
 */
function usePreview(onHover: ((id: string | null) => void) | undefined): {
  start: (id: string) => void;
  end: () => void;
} {
  const standing = useRef(false);
  const handler = useRef(onHover);
  useEffect(() => {
    handler.current = onHover;
  }, [onHover]);

  const start = useCallback((id: string) => {
    if (!handler.current) return;
    standing.current = true;
    handler.current(id);
  }, []);

  const end = useCallback(() => {
    if (!handler.current || !standing.current) return;
    standing.current = false;
    handler.current(null);
  }, []);

  // A gallery that unmounts mid-preview (band re-layout, tab switch) must not
  // leave the document showing a style the user never chose.
  useEffect(() => end, [end]);

  // Stable identity, so handlers built on it (the popover's onClose) do not
  // re-subscribe the popover's document listeners on every render.
  return useMemo(() => ({ start, end }), [start, end]);
}

// ============================================================================
// ThumbOption — one thumbnail as a listbox option
// ============================================================================

interface ThumbOptionProps {
  item: StyleGalleryItem;
  selected: boolean;
  thumb: StyleThumbSize;
  tabIndex: number;
  testId?: string;
  onChoose: (id: string) => void;
  preview: { start: (id: string) => void; end: () => void };
  onFocusIndex: () => void;
  buttonRef: (el: HTMLButtonElement | null) => void;
}

function ThumbOption({
  item,
  selected,
  thumb,
  tabIndex,
  testId,
  onChoose,
  preview,
  onFocusIndex,
  buttonRef,
}: ThumbOptionProps): React.ReactElement {
  return (
    <Tooltip content={item.name}>
      <button
        ref={buttonRef}
        type="button"
        role="option"
        aria-selected={selected}
        aria-label={item.name}
        tabIndex={tabIndex}
        className={thumbOption}
        style={{ width: thumb.w + 2 * THUMB_PAD, height: thumb.h + 2 * THUMB_PAD }}
        data-testid={testId}
        onMouseEnter={() => preview.start(item.id)}
        onMouseLeave={() => preview.end()}
        onFocus={() => {
          onFocusIndex();
          preview.start(item.id);
        }}
        onBlur={() => preview.end()}
        onClick={() => {
          preview.end();
          onChoose(item.id);
        }}
      >
        <span
          className={thumbBox}
          style={{ width: thumb.w, height: thumb.h }}
          data-colour-data=""
        >
          {item.renderThumb(thumb)}
        </span>
      </button>
    </Tooltip>
  );
}

// ============================================================================
// StyleGrid — the grouped grid (popover and panel)
// ============================================================================

interface StyleGridProps {
  items: readonly StyleGalleryItem[];
  value: string | null;
  onChoose: (id: string) => void;
  preview: { start: (id: string) => void; end: () => void };
  thumb: StyleThumbSize;
  columns: number;
  label: string;
  testIdFor: (id: string) => string | undefined;
  gridRef?: React.Ref<HTMLDivElement>;
}

function StyleGrid({
  items,
  value,
  onChoose,
  preview,
  thumb,
  columns,
  label,
  testIdFor,
  gridRef,
}: StyleGridProps): React.ReactElement {
  const idBase = useId();
  const groups = useMemo(() => groupItems(items), [items]);
  const ordered = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const rows = useMemo(
    () => gridRows(groups.map((g) => g.items.length), columns),
    [groups, columns],
  );
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const [focused, setFocused] = useState(-1);

  const selectedIndex = ordered.findIndex((it) => it.id === value);
  const entry =
    focused >= 0 && focused < ordered.length ? focused : selectedIndex >= 0 ? selectedIndex : 0;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const current = refs.current.indexOf(e.target as HTMLButtonElement);
    if (current < 0) return;
    const next = gridKeyTarget(rows, current, e.key);
    if (next === null) return;
    e.preventDefault();
    refs.current[next]?.focus();
  };

  let flatIndex = 0;
  return (
    <div
      ref={gridRef}
      role="listbox"
      aria-label={label}
      className={gridRoot}
      onKeyDown={handleKeyDown}
      onMouseLeave={() => preview.end()}
    >
      {groups.map((group, gi) => {
        const headingId = `${idBase}-g${gi}`;
        return (
          <div
            key={group.name ?? `__ungrouped_${gi}`}
            role="group"
            aria-labelledby={group.name ? headingId : undefined}
          >
            {group.name && (
              <div id={headingId} className={groupHeading}>
                {group.name}
              </div>
            )}
            <div
              className={grid}
              style={{
                gridTemplateColumns: `repeat(${columns}, ${thumb.w + 2 * THUMB_PAD}px)`,
              }}
            >
              {group.items.map((item) => {
                const index = flatIndex++;
                return (
                  <ThumbOption
                    key={item.id}
                    item={item}
                    selected={item.id === value}
                    thumb={thumb}
                    tabIndex={index === entry ? 0 : -1}
                    testId={testIdFor(item.id)}
                    onChoose={onChoose}
                    preview={preview}
                    onFocusIndex={() => setFocused(index)}
                    buttonRef={(el) => {
                      refs.current[index] = el;
                    }}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ============================================================================
// StyleGallery
// ============================================================================

/**
 * A style gallery: a 61px thumbnail strip + expand popover in the band, the
 * grouped grid inline in a panel or flyout.
 */
export function StyleGallery({
  items,
  value,
  onChange,
  onHover,
  thumbSize = DEFAULT_THUMB,
  label,
  visible = 3,
  stripIds,
  testIdPrefix,
  columns = 5,
  expandLabel,
}: StyleGalleryProps): React.ReactElement {
  const layout = useSurfaceLayout();
  const preview = usePreview(onHover);
  const [open, setOpen] = useState(false);
  const [expandEl, setExpandEl] = useState<HTMLButtonElement | null>(null);
  const [stripFocused, setStripFocused] = useState(-1);
  const popoverGridRef = useRef<HTMLDivElement>(null);
  const stripRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const tid = (suffix: string): string | undefined =>
    testIdPrefix ? `${testIdPrefix}-${suffix}` : undefined;

  const closePopover = useCallback(() => {
    preview.end();
    setOpen(false);
  }, [preview]);

  // Focus the selected (else first) style when the popover opens, so the
  // grid is immediately keyboard-operable.
  useEffect(() => {
    if (!open) return;
    return focusWhenShown(
      () => popoverGridRef.current,
      () =>
        popoverGridRef.current?.querySelector<HTMLElement>('[role="option"][tabindex="0"]') ??
        null,
    );
  }, [open]);

  if (layout.container !== "band") {
    // Panel / flyout: the whole gallery inline. Columns follow the measured
    // width when there is one, so the grid never overflows the panel.
    const cell = thumbSize.w + 2 * THUMB_PAD;
    const fit =
      layout.width > 0 ? Math.floor((layout.width + GAP_XS) / (cell + GAP_XS)) : columns;
    const panelColumns = Math.max(1, Math.min(fit, Math.max(1, items.length)));
    return (
      <div data-testid={testIdPrefix}>
        <StyleGrid
          items={items}
          value={value}
          onChoose={onChange}
          preview={preview}
          thumb={thumbSize}
          columns={panelColumns}
          label={label}
          testIdFor={(id) => tid(id)}
        />
      </div>
    );
  }

  const shown = stripItems(items, value, visible, stripIds);
  const hasMore = items.length > shown.length;
  const selectedStrip = shown.findIndex((it) => it.id === value);
  const stripEntry =
    stripFocused >= 0 && stripFocused < shown.length
      ? stripFocused
      : selectedStrip >= 0
        ? selectedStrip
        : 0;

  /** The strip is one row: Left/Right step, Home/End jump. */
  const handleStripKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const current = stripRefs.current.indexOf(e.target as HTMLButtonElement);
    if (current < 0) return;
    const next = gridKeyTarget([shown.map((_, i) => i)], current, e.key);
    if (next === null) return;
    e.preventDefault();
    stripRefs.current[next]?.focus();
  };

  /** A choice in the popover closes it and hands focus back to the expand
   *  button (the popover is about to unmount with focus inside it). */
  const chooseFromPopover = (id: string): void => {
    const restoreTo =
      expandEl && popoverGridRef.current?.contains(document.activeElement)
        ? firstFocusable(expandEl)
        : null;
    preview.end();
    setOpen(false);
    restoreTo?.focus();
    onChange(id);
  };

  return (
    <div className={bandStrip} data-testid={testIdPrefix}>
      <div
        role="listbox"
        aria-label={label}
        aria-orientation="horizontal"
        className={bandRow}
        style={hasMore ? undefined : { paddingRight: STRIP_PAD_X }}
        onKeyDown={handleStripKey}
        onMouseLeave={() => preview.end()}
      >
        {shown.map((item, i) => (
          <ThumbOption
            key={item.id}
            item={item}
            selected={item.id === value}
            thumb={thumbSize}
            tabIndex={i === stripEntry ? 0 : -1}
            testId={tid(item.id)}
            onChoose={onChange}
            preview={preview}
            onFocusIndex={() => setStripFocused(i)}
            buttonRef={(el) => {
              stripRefs.current[i] = el;
            }}
          />
        ))}
      </div>

      {hasMore && (
        <IconButton
          ref={setExpandEl}
          size="tall"
          icon={<RibbonIcon.ChevronDown size={16} />}
          label={expandLabel ?? `More ${label}`}
          className={expandButton}
          style={{ width: EXPAND_WIDTH, minWidth: EXPAND_WIDTH }}
          aria-haspopup="dialog"
          aria-expanded={open}
          data-testid={tid("expand")}
          onClick={() => {
            if (open) closePopover();
            else setOpen(true);
          }}
        />
      )}

      {hasMore && (
        <Popover
          card
          anchorEl={expandEl}
          open={open}
          onClose={closePopover}
          placement="bottom-end"
          ariaLabel={label}
        >
          <StyleGrid
            items={items}
            value={value}
            onChoose={chooseFromPopover}
            preview={preview}
            thumb={thumbSize}
            columns={Math.max(1, columns)}
            label={label}
            testIdFor={(id) => tid(`option-${id}`)}
            gridRef={popoverGridRef}
          />
        </Popover>
      )}
    </div>
  );
}
