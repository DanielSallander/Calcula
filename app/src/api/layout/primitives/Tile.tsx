//! FILENAME: app/src/api/layout/primitives/Tile.tsx
// PURPOSE: Tile — the big pictured choice (a chart type, a layout, a mark
//          style) — and TileGallery, the grouped grid of captioned tiles that
//          shows every choice when the band's row of tiles shows only some.
//          Also home of the keyboard-grid helpers the other gallery primitives
//          (StyleGallery, PaletteStrip, ColorPopover) share.
// CONTEXT: In the approved mockup the Chart Design band opens with one tall row
//          of 44x61 tiles, the cluster's whole content box (the fill rule in
//          ../tokens.ts), and "More chart types" opens a popover of 64x60 tiles
//          with captions. Both are the same control at two sizes, so they are
//          one primitive:
//
//            tall     44x61, 30px icon, name in aria-label + Tooltip
//            popover  64x60, 24px icon over a two-line caption (44x44 and a
//                     Tooltip when the caption is switched off)
//
//          A tall Tile IS an IconButton of size "tall" (and a popover Tile is a
//          Button), not a look-alike: the interactive states — hover, :active,
//          pressed via aria-pressed / aria-checked, the focus ring, disabled —
//          are written once in Button.tsx, and a Segmented that restyles its
//          children (first/last radius, the divider) reaches a Tile exactly as
//          it reaches an IconButton. A hand-rolled tile would be a second copy
//          of those states that drifts on the first change to either.
//
//          The icon is FITTED (30px tall, 24px in a popover) whatever size the
//          caller drew it at, so one icon element serves the band tile and the
//          gallery tile for the same choice.
//
//          Selection semantics follow the container: a tile in a radiogroup is
//          role="radio" + aria-checked, in a listbox role="option" +
//          aria-selected, and a free-standing toggle tile uses aria-pressed.
//          The pressed look keys off all three attributes, so what a screen
//          reader announces and what the user sees cannot disagree.

import React, { forwardRef, useCallback, useId, useMemo, useRef, useState } from "react";
import { css } from "@emotion/css";
import { LT } from "../theme";
import { FONT_FAMILY, GAP_XS, ICON_SIZE_LG, ICON_SIZE_MD } from "../tokens";
import { Button, IconButton } from "./Button";

// ============================================================================
// Shared keyboard-grid helpers (exported for the sibling gallery primitives)
// ============================================================================

/**
 * The rows of a grouped grid, as flat item indices: each group is chunked into
 * rows of `columns`, and a group always starts a new row (its heading sits
 * between). `gridRows([6, 3], 4)` is `[[0,1,2,3],[4,5],[6,7,8]]`.
 */
export function gridRows(groupSizes: readonly number[], columns: number): number[][] {
  const cols = Math.max(1, Math.floor(columns));
  const rows: number[][] = [];
  let start = 0;
  for (const size of groupSizes) {
    for (let i = 0; i < size; i += cols) {
      const row: number[] = [];
      for (let j = i; j < Math.min(i + cols, size); j++) row.push(start + j);
      rows.push(row);
    }
    start += size;
  }
  return rows;
}

/**
 * Where a navigation key moves focus in a grid of `rows`, or null when `key`
 * is not a grid key. Left/Right step through the reading order (crossing row
 * and group boundaries, never wrapping past the ends); Up/Down keep the column
 * and clamp it into a shorter row — the last row of a group is usually short,
 * and landing on nothing would strand the user; Home/End go to the ends.
 */
export function gridKeyTarget(
  rows: readonly (readonly number[])[],
  current: number,
  key: string,
): number | null {
  const flat = rows.flat();
  if (flat.length === 0) return null;
  const first = flat[0];
  const last = flat[flat.length - 1];
  if (key === "Home") return first;
  if (key === "End") return last;

  const r = rows.findIndex((row) => row.includes(current));
  if (r < 0) {
    return key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown"
      ? first
      : null;
  }
  const c = rows[r].indexOf(current);
  const at = flat.indexOf(current);

  switch (key) {
    case "ArrowLeft":
      return at > 0 ? flat[at - 1] : current;
    case "ArrowRight":
      return at < flat.length - 1 ? flat[at + 1] : current;
    case "ArrowUp": {
      if (r === 0) return current;
      const up = rows[r - 1];
      return up[Math.min(c, up.length - 1)];
    }
    case "ArrowDown": {
      if (r === rows.length - 1) return current;
      const down = rows[r + 1];
      return down[Math.min(c, down.length - 1)];
    }
    default:
      return null;
  }
}

/**
 * Focus an element inside a just-opened popover. Deferred one task on purpose:
 * Popover renders hidden (visibility: hidden) for the layout pass that measures
 * it, and a hidden element cannot take focus — a synchronous focus() in an
 * effect lands in that pass and silently does nothing. Skipped when focus is
 * already inside `container` (the user got there first). Returns a canceller
 * for the effect cleanup.
 */
export function focusWhenShown(
  container: () => HTMLElement | null,
  target: () => HTMLElement | null,
): () => void {
  const timer = setTimeout(() => {
    const box = container();
    if (box && box.contains(document.activeElement)) return;
    target()?.focus();
  }, 0);
  return () => clearTimeout(timer);
}

/** Join class names, skipping falsy parts. Joined rather than cx-merged so the
 *  cascade stays in module order (see Button.tsx's header). */
function classNames(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** Which ARIA state attribute a selectable control carries for its role:
 *  aria-checked (radio family), aria-selected (listbox/tab family), or
 *  aria-pressed (a free-standing toggle). */
export type SelectionAttribute = "checked" | "selected" | "pressed";

export function selectionAttribute(role: string | undefined): SelectionAttribute {
  if (role === "radio" || role === "menuitemradio" || role === "checkbox" || role === "switch") {
    return "checked";
  }
  if (role === "option" || role === "tab" || role === "gridcell") return "selected";
  return "pressed";
}

// ============================================================================
// Tile
// ============================================================================

export type TileSize = "tall" | "popover";

/** Popover tile geometry: 64x60 with a caption, 44x44 without. */
const POPOVER_TILE = { width: 64, height: 60 };
const POPOVER_TILE_BARE = 44;

/** aria-selected gets the same pressed look Button gives aria-pressed and
 *  aria-checked (Button's recipe does not know listbox options). The hover
 *  rule is 0,4,0 so it out-ranks Button's 0,3,0 hover and a selected option
 *  stays visibly selected under the pointer. */
const selectedOption = css`
  &[aria-selected="true"] {
    background: ${LT.pressed};
    border-color: ${LT.pressedBorder};
  }

  &[aria-selected="true"]:hover:not(:disabled) {
    background: ${LT.pressed};
  }
`;

/** Fit a direct <svg> child to the tile's icon size. */
const fitTall = css`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;

  & > svg {
    width: ${ICON_SIZE_LG}px;
    height: ${ICON_SIZE_LG}px;
  }
`;

const fitPopover = css`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;

  & > svg {
    width: ${ICON_SIZE_MD}px;
    height: ${ICON_SIZE_MD}px;
  }
`;

/** The captioned popover tile: icon over up to two lines of 11px caption.
 *  6 + 24 icon + 3 gap + 2x12 caption + 3 = 60. */
const popoverTile = css`
  flex-direction: column;
  justify-content: flex-start;
  gap: 3px;
  white-space: normal;
`;

const popoverTileBare = css`
  flex-direction: column;
  justify-content: center;
`;

const caption = css`
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  max-width: 100%;
  overflow: hidden;
  font-family: ${FONT_FAMILY};
  font-size: 11px;
  font-weight: 400;
  line-height: 12px;
  text-align: center;
  overflow-wrap: anywhere;
`;

export interface TileProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children" | "role" | "onClick"> {
  /** The picture. Fitted to 30px (tall) or 24px (popover) whatever its size. */
  icon: React.ReactNode;
  /** The choice's name: aria-label always; the caption in a popover tile; the
   *  tooltip wherever the name is not already visible. */
  label: string;
  /** Selected state; announced as aria-checked / aria-selected / aria-pressed
   *  according to `role`. Leave undefined for a plain action tile. */
  selected?: boolean;
  onClick: React.MouseEventHandler<HTMLButtonElement>;
  /** A chevron under the icon: the tile opens something (tall size only). */
  chevron?: boolean;
  /** "tall" (default) 44x61 band tile; "popover" 64x60 captioned tile. */
  size?: TileSize;
  /** "radio" in a radiogroup, "option" in a listbox; omitted = a toggle. */
  role?: string;
  testId?: string;
  /** Tooltip override; `false` suppresses it. By default a tile whose name is
   *  not visible (tall, or captionless popover) shows its label. */
  tooltip?: React.ReactNode | false;
  /** Popover size only: show the caption (default true). Without it the tile
   *  is a 44x44 icon square that names itself in a tooltip. */
  caption?: boolean;
}

/**
 * A pictured choice. Tall in the band (one of the tiles that fills a cluster's
 * 61px box), captioned in a popover gallery. The ref reaches the <button>.
 */
export const Tile = forwardRef<HTMLButtonElement, TileProps>(function Tile(
  {
    icon,
    label,
    selected,
    onClick,
    chevron,
    size = "tall",
    role,
    testId,
    tooltip,
    caption: showCaption = true,
    className,
    style,
    ...rest
  },
  ref,
) {
  // The state attribute follows the role; a caller's own aria-* in `rest`
  // still wins because it is spread after these.
  const kind = selectionAttribute(role);
  const ariaChecked = kind === "checked" ? Boolean(selected) : undefined;
  const ariaSelected = kind === "selected" ? Boolean(selected) : undefined;
  const pressed = kind === "pressed" ? selected : undefined;

  if (size === "tall") {
    return (
      <IconButton
        ref={ref}
        size="tall"
        icon={<span className={fitTall}>{icon}</span>}
        label={label}
        pressed={pressed}
        chevron={chevron}
        tooltip={tooltip}
        className={classNames(selectedOption, className)}
        style={style}
        role={role}
        aria-checked={ariaChecked}
        aria-selected={ariaSelected}
        data-testid={testId}
        onClick={onClick}
        {...rest}
      />
    );
  }

  const bare = !showCaption;
  // A visible caption already names the tile; only a bare one needs a tooltip.
  const tip: React.ReactNode | false =
    tooltip === false ? false : tooltip !== undefined ? tooltip : bare ? label : false;
  const geometry: React.CSSProperties = bare
    ? { width: POPOVER_TILE_BARE, minWidth: POPOVER_TILE_BARE, height: POPOVER_TILE_BARE, padding: 0 }
    : {
        width: POPOVER_TILE.width,
        minWidth: POPOVER_TILE.width,
        height: POPOVER_TILE.height,
        padding: "6px 4px 3px",
      };

  return (
    <Button
      ref={ref}
      icon={<span className={fitPopover}>{icon}</span>}
      aria-label={label}
      aria-pressed={pressed}
      aria-checked={ariaChecked}
      aria-selected={ariaSelected}
      tooltip={tip}
      className={classNames(bare ? popoverTileBare : popoverTile, selectedOption, className)}
      style={{ ...geometry, ...style }}
      role={role}
      data-testid={testId}
      onClick={onClick}
      {...rest}
    >
      {!bare && <span className={caption}>{label}</span>}
    </Button>
  );
});

// ============================================================================
// TileGallery
// ============================================================================

export interface TileGalleryItem<T extends string = string> {
  value: T;
  label: string;
  icon: React.ReactNode;
  /** Group heading the tile is listed under; groups keep first-seen order. */
  group?: string;
}

export interface TileGalleryProps<T extends string = string> {
  items: readonly TileGalleryItem<T>[];
  /** The selected value, or null for none. */
  value: T | null;
  onChange: (value: T) => void;
  /** Tiles per row. Default 4. */
  columns?: number;
  /** Captions under the icons (default true); false = 44x44 tiles + tooltips. */
  showLabels?: boolean;
  /** Each tile gets `data-testid="<prefix>-<value>"`, the list `<prefix>`. */
  testIdPrefix?: string;
  /** The listbox's accessible name. Default "Gallery". */
  ariaLabel?: string;
}

const galleryRoot = css`
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-family: ${FONT_FAMILY};
`;

/** Group heading — the MenuHeading recipe, so a gallery's groups read like a
 *  menu's in the same popover chrome. */
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

const galleryGrid = css`
  display: grid;
  gap: ${GAP_XS}px;
`;

interface GalleryGroup<T extends string> {
  name: string | undefined;
  entries: Array<{ item: TileGalleryItem<T>; index: number }>;
}

/** Items grouped by `group` in first-seen order, each carrying its index in
 *  RENDERED order (group-major), which is the order keyboard focus walks. */
function groupItems<T extends string>(items: readonly TileGalleryItem<T>[]): GalleryGroup<T>[] {
  const groups: GalleryGroup<T>[] = [];
  const byName = new Map<string | undefined, GalleryGroup<T>>();
  for (const item of items) {
    let g = byName.get(item.group);
    if (!g) {
      g = { name: item.group, entries: [] };
      byName.set(item.group, g);
      groups.push(g);
    }
    g.entries.push({ item, index: -1 });
  }
  let n = 0;
  for (const g of groups) for (const e of g.entries) e.index = n++;
  return groups;
}

/**
 * Every choice as a grouped grid of popover-size tiles — "More chart types".
 * A single-select listbox: arrow keys (2-D, across groups), Home and End move
 * focus with a roving tabindex, Enter/Space/click choose. Arrows move without
 * choosing on purpose: a gallery choice is usually expensive (the chart
 * re-renders as a new type), and choosing on every keystroke would apply each
 * type on the way to the one the user wanted.
 */
export function TileGallery<T extends string = string>({
  items,
  value,
  onChange,
  columns = 4,
  showLabels = true,
  testIdPrefix,
  ariaLabel,
}: TileGalleryProps<T>): React.ReactElement {
  const idBase = useId();
  const groups = useMemo(() => groupItems(items), [items]);
  const rows = useMemo(
    () => gridRows(groups.map((g) => g.entries.length), columns),
    [groups, columns],
  );
  const ordered = useMemo(() => groups.flatMap((g) => g.entries.map((e) => e.item)), [groups]);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const [focused, setFocused] = useState(-1);

  const selectedIndex = ordered.findIndex((it) => it.value === value);
  const entry =
    focused >= 0 && focused < ordered.length ? focused : selectedIndex >= 0 ? selectedIndex : 0;
  const cell = showLabels ? POPOVER_TILE.width : POPOVER_TILE_BARE;

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const current = refs.current.indexOf(e.target as HTMLButtonElement);
      if (current < 0) return;
      const next = gridKeyTarget(rows, current, e.key);
      if (next === null) return;
      e.preventDefault();
      refs.current[next]?.focus();
    },
    [rows],
  );

  return (
    <div
      role="listbox"
      aria-label={ariaLabel ?? "Gallery"}
      className={galleryRoot}
      data-testid={testIdPrefix}
      onKeyDown={handleKeyDown}
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
              className={galleryGrid}
              style={{ gridTemplateColumns: `repeat(${Math.max(1, columns)}, ${cell}px)` }}
            >
              {group.entries.map(({ item, index }) => (
                <Tile
                  key={item.value}
                  ref={(el) => {
                    refs.current[index] = el;
                  }}
                  size="popover"
                  caption={showLabels}
                  role="option"
                  icon={item.icon}
                  label={item.label}
                  selected={item.value === value}
                  tabIndex={index === entry ? 0 : -1}
                  testId={testIdPrefix ? `${testIdPrefix}-${item.value}` : undefined}
                  onFocus={() => setFocused(index)}
                  onClick={() => onChange(item.value)}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
