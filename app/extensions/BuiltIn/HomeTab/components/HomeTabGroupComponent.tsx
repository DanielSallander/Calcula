//! FILENAME: app/extensions/BuiltIn/HomeTab/components/HomeTabGroupComponent.tsx
// PURPOSE: Reusable component that renders a set of Home tab items.
// CONTEXT: Hosted as a panel section (one per layout group: Clipboard, Font, etc.),
// so the same JSX renders in the ribbon band and the sidebar. Every control is an
// @api/layout primitive — IconButton/Button/CommandButton, Dropdown, ColorSwatch,
// Segmented pills through ControlGrid's segmentOf — so the Home tab follows the
// skin through tokens and paints no colour of its own. State comes from
// useHomeTabState.
//
// THE FILL RULE. A cluster's content box is 61px and is filled one of two ways:
// one tall row (a hero) or two 28px rows with a 5px gap.
//
// ORDER IS LAYOUT (Excel's Home tab, 2026-10-04). The items render IN LAYOUT
// ORDER: each hero is its own full-height control, and each RUN of consecutive
// non-hero items between heroes is one two-row ControlGrid (split at the run's
// row breaks where it has them, else halved). So Clipboard is
// [Paste][Cut Copy / Format Painter] and Editing is
// [AutoSum Fill / Clear][Sort & Filter][Find & Select] -- Excel's order -- with
// nothing group-specific here. It used to draw every hero FIRST and pack all
// the rest into one grid after them, which put Editing's menus on the wrong
// side of its stack and could never express a hero in the middle of a group.
//
// WHICH CONTROL AN ITEM IS. Excel's version-2 commands are components of their
// own under components/<group>/ (the Paste and Insert/Delete splits, the
// Borders and Underline splits, the Orientation, Fill, Clear, Sort & Filter
// and Find & Select menus, ...). Each takes HomeItemProps and is looked up by
// item id in ITEM_CONTROLS below, whether it sits in a grid or stands as a
// hero: `hero` decides WHERE an item goes, the id decides WHAT it is. What is
// left inline here is the plain command button and the three value pickers.

import React, { useEffect, useState } from "react";
import { css } from "@emotion/css";
import { CommandRegistry, CoreCommands } from "@api/commands";
import { getRibbonNumberFormats } from "@api/numberFormats";
import type { RibbonNumberFormat } from "@api/numberFormats";
import { onLocaleChanged } from "@api/locale";
import { alertAsync } from "@api/dialogs";
import {
  ControlRow,
  ControlGrid,
  ControlGridBreak,
  Button,
  IconButton,
  CommandButton,
  Dropdown,
  useSurfaceLayout,
  CONTROL_HEIGHT_MD,
  GAP_XS,
  HERO_ICON_SIZE,
  ICON_SIZE_SM,
  type DropdownOption,
} from "@api/layout";
import type { RibbonContext } from "@api/extensions";
import { useUndoAvailability } from "@api/undoState";
import { ITEMS_BY_ID, isMultiInstanceItem, type HomeTabItem } from "../homeTabConfig";
import { groupPieces } from "./groupPieces";
import { FONT_LIST, FONT_SIZES } from "../../../_shared/lib/fontList";
import { useHomeTabState } from "./useHomeTabState";
import { homeTabIcon } from "./homeTabIcons";
import { itemTooltip } from "./itemTooltip";
import type { HomeItemProps } from "./homeItemProps";
import { MergeSplitButton } from "./MergeSplitButton";
import { PasteSplitButton } from "./clipboard/PasteSplitButton";
import { FormatPainterButton } from "./clipboard/FormatPainterButton";
import { UnderlineSplitButton } from "./font/UnderlineSplitButton";
import { BordersSplitButton } from "./font/BordersSplitButton";
import { ColorSplitButton } from "./font/ColorSplitButton";
import { OrientationMenuButton } from "./alignment/OrientationMenuButton";
import { AccountingSplitButton } from "./alignment/AccountingSplitButton";
import { ConditionalFormattingButton } from "./styles/ConditionalFormattingButton";
import { FormatAsTableButton } from "./styles/FormatAsTableButton";
import { CellStylesButton } from "./styles/CellStylesButton";
import { InsertSplitButton } from "./cells/InsertSplitButton";
import { DeleteSplitButton } from "./cells/DeleteSplitButton";
import { FormatMenuButton } from "./cells/FormatMenuButton";
import {
  AutoSumSplitButton,
  FillMenuButton,
  ClearMenuButton,
  SortFilterMenuButton,
  FindSelectMenuButton,
} from "./editing";
import {
  CUSTOM_FORMAT_LABEL,
  CUSTOM_FORMAT_VALUE,
  MORE_NUMBER_FORMATS_VALUE,
  RIBBON_NUMBER_FORMATS,
  selectedPresetFor,
} from "./numberFormatOptions";

/**
 * The item ids that are a control of their own (CONTRACT section 3), each
 * rendered with HomeItemProps alone. Fill Color and Font Color share one
 * component; Format Painter and Merge & Center need one more prop each and are
 * dispatched by hand in renderItem.
 */
const ITEM_CONTROLS: Readonly<Record<string, React.ComponentType<HomeItemProps>>> = {
  // Clipboard
  paste: PasteSplitButton,
  // Font
  underline: UnderlineSplitButton,
  borders: BordersSplitButton,
  backgroundColor: ColorSplitButton,
  textColor: ColorSplitButton,
  // Alignment / Number
  orientation: OrientationMenuButton,
  accountingFormat: AccountingSplitButton,
  // Styles
  conditionalFormatting: ConditionalFormattingButton,
  formatAsTable: FormatAsTableButton,
  cellStyles: CellStylesButton,
  // Cells
  insertCells: InsertSplitButton,
  deleteCells: DeleteSplitButton,
  formatMenu: FormatMenuButton,
  // Editing
  autoSum: AutoSumSplitButton,
  fill: FillMenuButton,
  clear: ClearMenuButton,
  sortFilter: SortFilterMenuButton,
  findSelect: FindSelectMenuButton,
};

/** The value each Number row's sample formats, shown beside the row the way
 *  Excel previews a value per entry. Fixed rather than the active cell's,
 *  because the frontend holds only the cell's DISPLAY text, and asking the
 *  backend for the raw value on every open is not worth a preview. */
const NUMBER_FORMAT_SAMPLE_VALUE = 1234.5678;

/** Band widths of the three value pickers (the approved mockup's). In a panel
 *  they fill the row, as the native selects did. */
const FONT_NAME_BAND_WIDTH = 122;
const FONT_SIZE_BAND_WIDTH = 58;
const NUMBER_FORMAT_BAND_WIDTH = 122;

/** Accessible names of the Segmented pills, per catalog `segment`. */
const SEGMENT_LABELS: Readonly<Record<string, string>> = {
  emphasis: "Emphasis",
  valign: "Vertical alignment",
  halign: "Horizontal alignment",
  indent: "Indent",
  decimals: "Decimals",
};

/**
 * Which pill a rendered control joins. Every item control carries
 * `data-testid="fmt-<itemId>"`, so the catalog entry is recovered from it —
 * the element's React key cannot be used, because ControlGrid's
 * Children.toArray rewrites keys. Colour swatches and dropdowns carry no such
 * prop and so never join a pill.
 */
function segmentOf(child: React.ReactElement): string | undefined {
  const testId = (child.props as Record<string, unknown>)["data-testid"];
  if (typeof testId !== "string" || !testId.startsWith("fmt-")) return undefined;
  const segment = ITEMS_BY_ID.get(testId.slice(4))?.segment;
  return segment === undefined ? undefined : (SEGMENT_LABELS[segment] ?? segment);
}

/**
 * Excel's "More Number Formats..." row: Format Cells on the Number tab, through
 * the FORMAT_CELLS command -- the ONE door to the dialog, which refuses (one
 * toast, no dialog) while something else owns the selection. The row opened
 * the dialog directly and skipped that check, so with a floating grid's cell
 * selected Format Cells opened over Core's HIDDEN cell (review of BUG-0185).
 * (Fill's "More Fill Options..." row now lives in font/ColorSplitButton.)
 */
function openFormatCellsOn(tab: "number"): void {
  CommandRegistry.execute(CoreCommands.FORMAT_CELLS, { tab }).catch((err: unknown) => {
    // A refusal that escapes as an error reaches the user, as every other
    // Home door's does -- not only the console.
    void alertAsync(err instanceof Error ? err.message : String(err));
  });
}

/** The typographic glyphs (B, I, S, x², x₂, %, ",", ".0", "0.") are square
 *  28px controls like every IconButton beside them, set in the face that
 *  makes each one read as what it does. (Underline's "U" is drawn by its
 *  split, font/UnderlineSplitButton.) */
const GLYPH_BOX: React.CSSProperties = { width: CONTROL_HEIGHT_MD, padding: 0 };
const GLYPH_STYLE: Readonly<Record<string, React.CSSProperties>> = {
  bold: { fontWeight: 700, fontSize: 14 },
  italic: { fontStyle: "italic", fontFamily: "Georgia, 'Times New Roman', serif", fontSize: 14 },
  strikethrough: { textDecoration: "line-through", fontSize: 14 },
  superscript: { fontSize: 13 },
  subscript: { fontSize: 13 },
  percentFormat: { fontSize: 14 },
  commaFormat: { fontSize: 14, fontWeight: 600 },
  increaseDecimal: { fontSize: 12 },
  decreaseDecimal: { fontSize: 12 },
};

// ============================================================================
// Styles
// ============================================================================

/** The font picker's trigger shows the selected font IN that font. */
const fontValue = css`
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
`;

/** A short sample beside each font in the open list, set in that font. */
const fontPreview = css`
  font-size: 13px;
  line-height: 1;
  white-space: nowrap;
`;

// ============================================================================
// Group Component
// ============================================================================

interface HomeTabGroupComponentProps {
  context: RibbonContext;
  itemIds: string[];
}

/**
 * Renders a set of Home tab items (buttons, toggles, pickers, colour swatches).
 * Used by each registered ribbon group.
 */
export function HomeTabGroupComponent({ itemIds }: HomeTabGroupComponentProps): React.ReactElement {
  const state = useHomeTabState();
  const layout = useSurfaceLayout();
  const band = layout.container === "band";
  // Excel greys Undo/Redo out when the stack is empty; until this binding
  // existed the app invited the user to press an Undo it might not have. The
  // store is event-driven (see @api/undoState), so a mutation that never
  // touched the frontend moves these buttons too.
  const undoAvailability = useUndoAvailability();

  // Excel's Number dropdown resolved for the CURRENT locale: the backend
  // returns, per entry, the preset keyword to send, the display name get_style
  // will report for a cell carrying it, and a formatted sample. Re-fetched on a
  // locale change because five of the eleven entries move with the region.
  const [resolvedNumberFormats, setResolvedNumberFormats] = useState<RibbonNumberFormat[]>([]);
  useEffect(() => {
    let live = true;
    const load = () => {
      getRibbonNumberFormats(NUMBER_FORMAT_SAMPLE_VALUE)
        .then((entries) => {
          if (live) setResolvedNumberFormats(entries);
        })
        .catch(() => {
          // Keep the static rows: a backend that cannot answer must not empty
          // the dropdown, only leave it without samples and without knowing
          // which row the selection is on.
        });
    };
    load();
    const unsubscribe = onLocaleChanged(load);
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  // The three value pickers carry their tooltip on the Dropdown's OWN props,
  // so it lands on the combobox trigger: aria-describedby is on the control a
  // screen reader announces, and keyboard focus opens it. (They used to hang
  // it on a wrapper <span>, which never received focus.) With no width in a
  // panel, a Dropdown fills the row, as the native selects it replaced did.

  const renderFontName = (item: HomeTabItem) => {
    // Fallback mirrors the fontSize fallback of 11 below: the grid's default
    // cell font is Calibri (theme cellFontFamily, backend default style), so
    // a style that carries no explicit family renders in Calibri — the combo
    // must say what the renderer does, not "system-ui" (BUG-0062).
    const current = state.currentStyle?.fontFamily ?? "Calibri";
    const fonts = FONT_LIST.includes(current) ? FONT_LIST : [current, ...FONT_LIST];
    const options: DropdownOption<string>[] = fonts.map((f) => ({
      value: f,
      label: f,
      preview: (
        <span className={fontPreview} style={{ fontFamily: f }} aria-hidden>
          Abc
        </span>
      ),
    }));
    const tip = itemTooltip(item);
    return (
      <Dropdown
        key={item.id}
        ariaLabel={item.tooltip ?? item.label}
        value={current}
        options={options}
        width={band ? FONT_NAME_BAND_WIDTH : undefined}
        testId="fmt-fontName"
        tooltip={tip.tooltip}
        shortcut={tip.shortcut}
        commandId={tip.commandId}
        renderValue={(opt) => (
          <span className={fontValue} style={{ fontFamily: opt.value }}>
            {opt.label}
          </span>
        )}
        onChange={(f) => void state.handleFontFamilyChange(f)}
      />
    );
  };

  const renderFontSize = (item: HomeTabItem) => {
    const current = state.currentStyle?.fontSize ?? 11;
    const sizes = FONT_SIZES.includes(current) ? FONT_SIZES : [...FONT_SIZES, current].sort((a, b) => a - b);
    const options: DropdownOption<number>[] = sizes.map((s) => ({ value: s, label: String(s) }));
    const tip = itemTooltip(item);
    return (
      <Dropdown
        key={item.id}
        ariaLabel={item.tooltip ?? item.label}
        value={current}
        options={options}
        width={band ? FONT_SIZE_BAND_WIDTH : undefined}
        testId="fmt-fontSize"
        optionTestIdPrefix="fmt-fontSize-option-"
        tooltip={tip.tooltip}
        shortcut={tip.shortcut}
        commandId={tip.commandId}
        onChange={(s) => void state.handleFontSizeChange(s)}
      />
    );
  };

  const renderNumberFormat = (item: HomeTabItem) => {
    // get_style reports a DISPLAY NAME ("Number (2 decimals)", "@"), never a
    // preset keyword, so the selected row is resolved through the backend's
    // own preset/name pairs. A format that is not one of Excel's eleven
    // entries shows as "Custom", which is what Excel's box shows, with the
    // real format kept on the tooltip (and on the Custom row) so nothing is
    // hidden.
    const fmt = state.currentStyle?.numberFormat ?? "General";
    const selected = selectedPresetFor(fmt, resolvedNumberFormats);
    const samples = new Map(resolvedNumberFormats.map((f) => [f.preset, f.sample]));
    const custom = selected === CUSTOM_FORMAT_VALUE;
    const options: DropdownOption<string>[] = [
      ...(custom
        ? [{ value: CUSTOM_FORMAT_VALUE, label: CUSTOM_FORMAT_LABEL, hint: fmt, disabled: true }]
        : []),
      ...RIBBON_NUMBER_FORMATS.map((f) => ({
        value: f.preset,
        label: f.label,
        hint: samples.get(f.preset),
      })),
      { value: MORE_NUMBER_FORMATS_VALUE, label: "More Number Formats..." },
    ];
    const name = item.tooltip ?? item.label;
    const tip = itemTooltip(item);
    return (
      <Dropdown
        key={item.id}
        ariaLabel={name}
        value={selected}
        options={options}
        width={band ? NUMBER_FORMAT_BAND_WIDTH : undefined}
        testId="fmt-numberFormat"
        optionTestIdPrefix="fmt-numberFormat-option-"
        tooltip={custom ? `${tip.tooltip ?? name}: ${fmt}` : tip.tooltip}
        shortcut={tip.shortcut}
        commandId={tip.commandId}
        onChange={(value) => {
          if (value === MORE_NUMBER_FORMATS_VALUE) {
            // Excel's last row opens Format Cells on the Number tab. The
            // Dropdown is controlled, so the box stays on the cell's own
            // format -- the sentinel never reaches the formatter.
            openFormatCellsOn("number");
            return;
          }
          if (value === CUSTOM_FORMAT_VALUE) return;
          void state.handleNumberFormatChange(value);
        }}
      />
    );
  };

  /**
   * One command. `labelled`: beside a hero in the band, a `besideHero`
   * command shows its label next to its icon (Excel's medium button — "Cut",
   * "Copy", "Format Painter"), because the stack beside a 61px hero has the
   * room and the words are what a user scans for there.
   */
  const renderCommand = (item: HomeTabItem, labelled: boolean) => {
    const tip = itemTooltip(item);
    const toggle = item.type === "toggle";
    const active = toggle ? state.isActive(item.id) : undefined;
    // `undefined` rather than `false` for everything else: an explicit
    // `disabled={false}` would still write the attribute's absence, but leaving
    // it undefined keeps the DOM of the other 40-odd buttons byte-identical,
    // which is what the visual goldens photograph.
    const unavailable =
      item.id === "undo" ? !undoAvailability.canUndo
      : item.id === "redo" ? !undoAvailability.canRedo
      : undefined;
    const icon = homeTabIcon(item.id, ICON_SIZE_SM);

    if (icon === null) {
      // Typographic: the letter IS the control's face, so it keeps a name
      // of its own for assistive technology ("Bold", not "B").
      return (
        <Button
          key={item.id}
          aria-label={item.label}
          aria-pressed={active}
          tooltip={tip.tooltip}
          shortcut={tip.shortcut}
          commandId={tip.commandId}
          data-testid={`fmt-${item.id}`}
          data-active={active || undefined}
          disabled={unavailable}
          aria-disabled={unavailable}
          onClick={() => state.handleItemClick(item)}
          style={{ ...GLYPH_BOX, ...GLYPH_STYLE[item.id] }}
        >
          {item.icon}
        </Button>
      );
    }

    if (labelled) {
      return (
        <Button
          key={item.id}
          icon={icon}
          aria-pressed={active}
          tooltip={tip.tooltip}
          shortcut={tip.shortcut}
          commandId={tip.commandId}
          data-testid={`fmt-${item.id}`}
          data-active={active || undefined}
          disabled={unavailable}
          aria-disabled={unavailable}
          onClick={() => state.handleItemClick(item)}
        >
          {item.label}
        </Button>
      );
    }

    return (
      <IconButton
        key={item.id}
        icon={icon}
        label={item.label}
        pressed={active}
        tooltip={tip.tooltip}
        shortcut={tip.shortcut}
        commandId={tip.commandId}
        data-testid={`fmt-${item.id}`}
        data-active={active || undefined}
        disabled={unavailable}
        aria-disabled={unavailable}
        onClick={() => state.handleItemClick(item)}
      />
    );
  };

  /**
   * One item, wherever it sits. `labelled`: beside a hero in the band, a
   * `besideHero` command shows its label next to its icon (Excel's medium
   * button).
   *
   * Every component gets `data-testid="fmt-<id>"` on its ELEMENT as well as
   * drawing it on its own control: segmentOf reads the element's props (the
   * React key is rewritten by ControlGrid), and that is how Underline's split
   * joins the B | I | U pill. None of the components spreads unknown props, so
   * the attribute never lands twice in the DOM.
   */
  const renderItem = (item: HomeTabItem, index: number, labelled: boolean) => {
    if (isMultiInstanceItem(item)) return <ControlGridBreak key={`${item.id}-${index}`} />;
    if (item.id === "fontName") return renderFontName(item);
    if (item.id === "fontSize") return renderFontSize(item);
    if (item.id === "numberFormat") return renderNumberFormat(item);
    // Excel's Merge & Center split button and its Merge menu. Icon-only even
    // beside a hero: Excel's own label shows only when the window is wide.
    if (item.id === "mergeCells") {
      return (
        <MergeSplitButton
          key={item.id}
          data-testid={`fmt-${item.id}`}
          item={item}
          onRun={() => state.handleItemClick(item)}
          onCommand={(command) => void state.handleMergeCommand(command)}
        />
      );
    }
    // Click = FORMAT_PAINTER, double-click = FORMAT_PAINTER_LOCK, pressed
    // while the painter is on (CONTRACT 3.2). Labelled beside the Paste hero,
    // as Cut and Copy are.
    if (item.id === "formatPainter") {
      return (
        <FormatPainterButton
          key={item.id}
          data-testid={`fmt-${item.id}`}
          item={item}
          state={state}
          band={band}
          labelled={labelled}
        />
      );
    }
    const Control = ITEM_CONTROLS[item.id];
    if (Control) {
      return <Control key={item.id} data-testid={`fmt-${item.id}`} item={item} state={state} band={band} />;
    }
    if (item.hero) return renderHeroCommand(item);
    return renderCommand(item, labelled);
  };

  /** A hero with no control of its own: a full-height command button. 30px in
   *  the band's 34px hero slot; outside the band CommandButton is a standard
   *  28px button whose icon is the standard 20. */
  const renderHeroCommand = (item: HomeTabItem) => {
    const tip = itemTooltip(item);
    const icon = homeTabIcon(item.id, band ? HERO_ICON_SIZE : ICON_SIZE_SM) ?? item.icon;
    return (
      <CommandButton
        key={item.id}
        icon={icon}
        label={item.shortLabel ?? item.label}
        tooltip={tip.tooltip}
        shortcut={tip.shortcut}
        commandId={tip.commandId}
        data-testid={`fmt-${item.id}`}
        onClick={() => state.handleItemClick(item)}
      />
    );
  };

  // IN LAYOUT ORDER (see the file header): each hero fills the 61px box on
  // its own, and each run of the items between heroes packs into TWO 28px
  // band rows (a wrapping row in the sidebar). Inside a run, rows are chunked
  // first -- at the run's row breaks where it has them, else halved -- and
  // only then are same-segment neighbours joined into pills, so a pill never
  // moves a control between rows.
  const pieces = groupPieces(itemIds);
  // Excel's medium (labelled) face is a property of the COMMAND, not of the
  // group: in the band, beside a hero, only an item the catalog marks
  // `besideHero` (Cut, Copy, Format Painter) shows its words. Decided
  // group-wide, the heroes a version-1 layout gained on upgrade labelled every
  // small command in Editing and Cells (HomeTabItem.besideHero).
  const besideAHero = band && pieces.some((p) => p.kind === "hero");
  const labelledFor = (item: HomeTabItem | undefined): boolean => besideAHero && item?.besideHero === true;

  return (
    <ControlRow gap={GAP_XS} align="stretch">
      {pieces.map((piece) => {
        if (piece.kind === "hero") {
          return (
            <React.Fragment key={`hero-${piece.index}`}>
              {renderItem(ITEMS_BY_ID.get(piece.id)!, piece.index, labelledFor(ITEMS_BY_ID.get(piece.id)))}
            </React.Fragment>
          );
        }
        return (
          <ControlGrid key={`run-${piece.entries[0].index}`} bandRows={2} splitAt={2} segmentOf={segmentOf}>
            {piece.entries.map((e) => renderItem(ITEMS_BY_ID.get(e.id)!, e.index, labelledFor(ITEMS_BY_ID.get(e.id))))}
          </ControlGrid>
        );
      })}
    </ControlRow>
  );
}
