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
// one tall row (a hero) or two 28px rows with a 5px gap. So a group with a hero
// renders the hero(es) and then its other items as a two-row grid beside it —
// Clipboard is Paste beside "Cut, Copy / Format Painter" — and a group without
// one packs into two rows (curated by the layout's row breaks where it has
// them). Nothing here is Clipboard-specific: the arrangement is derived from
// the layout, so a user's own group with a hero gets the same shape.

import React, { useEffect, useState } from "react";
import { css } from "@emotion/css";
import { CommandRegistry, CoreCommands } from "@api/commands";
import { getRibbonNumberFormats } from "@api/numberFormats";
import type { RibbonNumberFormat } from "@api/numberFormats";
import { onLocaleChanged } from "@api/locale";
import {
  ControlRow,
  ControlGrid,
  ControlGridBreak,
  Button,
  IconButton,
  CommandButton,
  Dropdown,
  ColorSwatch,
  Popover,
  useSurfaceLayout,
  CONTROL_HEIGHT_MD,
  GAP_XS,
  HERO_ICON_SIZE,
  ICON_SIZE_SM,
  type DropdownOption,
} from "@api/layout";
import type { RibbonContext } from "@api/extensions";
import { useUndoAvailability } from "@api/undoState";
import { ITEMS_BY_ID, type HomeTabItem } from "../homeTabConfig";
import { CellStylesGallery } from "../../../_shared/components/CellStylesGallery";
import { FONT_LIST, FONT_SIZES } from "../../../_shared/lib/fontList";
import { useHomeTabState } from "./useHomeTabState";
import { homeTabIcon } from "./homeTabIcons";
import { itemTooltip } from "./itemTooltip";
import { MergeSplitButton } from "./MergeSplitButton";
import {
  CUSTOM_FORMAT_LABEL,
  CUSTOM_FORMAT_VALUE,
  MORE_NUMBER_FORMATS_VALUE,
  RIBBON_NUMBER_FORMATS,
  selectedPresetFor,
} from "./numberFormatOptions";

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
 * Excel's "More Number Formats..." and "More Fill Options..." rows: Format
 * Cells on that tab, through the FORMAT_CELLS command -- the ONE door to the
 * dialog, which refuses (one toast, no dialog) while something else owns the
 * selection. Both rows opened the dialog directly and skipped that check, so
 * with a floating grid's cell selected Format Cells opened over Core's HIDDEN
 * cell (review of BUG-0185).
 */
function openFormatCellsOn(tab: "number" | "fill"): void {
  CommandRegistry.execute(CoreCommands.FORMAT_CELLS, { tab }).catch((err) => {
    console.error("[HomeTab] Format Cells failed to open:", err);
  });
}

/** The typographic glyphs (B, I, U, S, x², x₂, %, ",", ".0", "0.") are square
 *  28px controls like every IconButton beside them, set in the face that
 *  makes each one read as what it does. */
const GLYPH_BOX: React.CSSProperties = { width: CONTROL_HEIGHT_MD, padding: 0 };
const GLYPH_STYLE: Readonly<Record<string, React.CSSProperties>> = {
  bold: { fontWeight: 700, fontSize: 14 },
  italic: { fontStyle: "italic", fontFamily: "Georgia, 'Times New Roman', serif", fontSize: 14 },
  underline: { textDecoration: "underline", fontSize: 14 },
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

/** A text glyph standing in for an icon inside a ColorSwatch face. */
const swatchGlyph = css`
  font-weight: 700;
  font-size: 13px;
  line-height: 1;
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
  const [cellStylesOpen, setCellStylesOpen] = useState(false);
  // Popover anchor: the gallery portals to <body> (the band clips overflow).
  // A callback ref into state, so the anchor is never read from a ref during
  // render.
  const [cellStylesAnchor, setCellStylesAnchor] = useState<HTMLDivElement | null>(null);

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

  const renderColor = (item: HomeTabItem) => {
    const style = state.currentStyle;
    const isText = item.id === "textColor";
    return (
      <ColorSwatch
        key={item.id}
        variant="bar"
        icon={homeTabIcon(item.id, ICON_SIZE_SM) ?? <span className={swatchGlyph}>{item.icon}</span>}
        color={state.getCurrentColor(item.id)}
        label={item.tooltip ?? item.label}
        testId={`fmt-${item.id}`}
        // Highlights the theme swatch a theme-coloured cell carries.
        themeSlot={isText ? style?.textColorTheme : style?.bgColorTheme}
        themeTint={isText ? style?.textColorTint : style?.bgColorTint}
        onChange={(hex) => void state.handleColorSelect(item.id, hex)}
        // A theme pick goes down the one colour path this button has ever
        // had: the resolved hex through handleColorSelect, the same thing the
        // Format Cells picker does with a theme colour.
        onThemeColorChange={(_slot, _tint, hex) => void state.handleColorSelect(item.id, hex)}
        moreAction={
          item.id === "backgroundColor"
            ? {
                label: "More Fill Options...",
                onSelect: () => openFormatCellsOn("fill"),
              }
            : undefined
        }
      />
    );
  };

  /**
   * One command. `labelled`: beside a hero in the band, a command shows its
   * label next to its icon (Excel's medium button — "Cut", "Copy", "Format
   * Painter"), because the stack beside a 61px hero has the room and the
   * words are what a user scans for there.
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

  const renderItem = (itemId: string, idx: number, labelled: boolean) => {
    const item = ITEMS_BY_ID.get(itemId);
    if (!item) return null;

    if (item.id === "rowBreak") return <ControlGridBreak key={`rowBreak-${idx}`} />;
    if (item.id === "fontName") return renderFontName(item);
    if (item.id === "fontSize") return renderFontSize(item);
    if (item.id === "numberFormat") return renderNumberFormat(item);
    if (item.type === "color") return renderColor(item);
    // Excel's Merge & Center split button and its Merge menu. Icon-only even
    // beside a hero: @api/layout has no labelled split, and Excel's own label
    // shows only when the window is wide. `data-testid` lets segmentOf see
    // the item (it joins no pill).
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
    return renderCommand(item, labelled);
  };

  const renderHero = (id: string) => {
    const item = ITEMS_BY_ID.get(id);
    if (!item) return null;
    const tip = itemTooltip(item);
    // 30px in the band's 34px hero slot; outside the band CommandButton is a
    // standard 28px button whose icon is the standard 20.
    const icon = homeTabIcon(item.id, band ? HERO_ICON_SIZE : ICON_SIZE_SM) ?? item.icon;

    if (item.id === "cellStyles") {
      return (
        <div key={item.id} ref={setCellStylesAnchor} style={{ display: "flex" }}>
          <CommandButton
            icon={icon}
            label={item.shortLabel ?? item.label}
            chevron
            tooltip={tip.tooltip}
            shortcut={tip.shortcut}
            commandId={tip.commandId}
            data-testid={`fmt-${item.id}`}
            aria-haspopup="dialog"
            aria-expanded={cellStylesOpen}
            onClick={() => setCellStylesOpen(!cellStylesOpen)}
          />
          <Popover
            anchorEl={cellStylesAnchor}
            open={cellStylesOpen}
            onClose={() => setCellStylesOpen(false)}
          >
            <CellStylesGallery
              onApplyStyle={state.handleCellStyleApply}
              onClose={() => setCellStylesOpen(false)}
            />
          </Popover>
        </div>
      );
    }

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

  // Heroes (Excel-style big Paste / Cell Styles) fill the 61px box on their
  // own; the rest pack into TWO 28px band rows beside them (a wrapping row in
  // the sidebar). Rows are chunked first — at the layout's row breaks where
  // it has them, else halved — and only then are same-segment runs within a
  // row joined into pills, so a pill never moves a control between rows.
  const heroIds = itemIds.filter((id) => ITEMS_BY_ID.get(id)?.hero);
  const regularIds = itemIds.filter((id) => !ITEMS_BY_ID.get(id)?.hero);
  const labelled = band && heroIds.length > 0;

  return (
    <ControlRow gap={GAP_XS} align="stretch">
      {heroIds.map(renderHero)}
      {regularIds.length > 0 && (
        <ControlGrid bandRows={2} splitAt={2} segmentOf={segmentOf}>
          {regularIds.map((id, idx) => renderItem(id, idx, labelled))}
        </ControlGrid>
      )}
    </ControlRow>
  );
}
