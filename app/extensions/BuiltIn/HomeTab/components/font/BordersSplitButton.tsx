//! FILENAME: app/extensions/BuiltIn/HomeTab/components/font/BordersSplitButton.tsx
// PURPOSE: Excel's Borders split button for the Home tab's Font group
//          (CONTRACT 3.4): the face shows the border used LAST (Bottom Border
//          in a fresh session) and re-applies it; the chevron opens Excel's
//          Borders menu -- four edges, four range presets, five combinations,
//          Line Color >, Line Style >, More Borders....
// CONTEXT: Rendered for the catalog item "borders" (HomeItemProps; the
//          dispatcher in HomeTabGroupComponent looks it up by id). What every
//          preset writes -- measured in live Excel, including the shared edge a
//          neighbour owns -- and the ONE undo step it makes are borders.ts.
//
//          The rows run the presets themselves rather than the group's
//          `applyFormat` door: a preset is several backend calls (a range
//          preset, edge writes, the neighbours' coincident sides) that must be
//          one undo step, and `applyFormat` is one `applyFormatting` call. The
//          runner asks the selection owner and refreshes exactly as that door
//          does, so `state` is not read here.
//
//          Line Color > and Line Style > set the PEN the presets draw with
//          (session-long, like the face). Excel also enters Draw Border mode
//          when a pen is picked; the draw modes are deferred (owner decision
//          1(3)), so here a pen pick changes what the next preset draws and
//          applies nothing by itself. The Draw Borders heading Excel puts over
//          these rows is left out with the draw rows it names.
//
//          Same 28px control in the band and in a panel (Excel's Borders is a
//          small split in the band too, never a hero), so `band` changes
//          nothing here.

import React from "react";
import { RibbonIcon, type RibbonIconKey } from "@api";
import {
  ColorPalette,
  ICON_SIZE_SM,
  MENU_ICON_BLANK,
  MenuHeading,
  MenuItem,
  MenuSeparator,
  MenuSub,
  SplitMenuButton,
} from "@api/layout";
import type { HomeItemProps } from "../homeItemProps";
import {
  BORDER_PRESETS,
  LINE_STYLES,
  MORE_BORDERS,
  applyBorderChoice,
  borderPen,
  borderPresetRow,
  chooseBorder,
  lastBorderPreset,
  openMoreBorders,
  type BorderPresetRow,
  type LineStyleId,
} from "./borders";
import { useSessionValue } from "./sessionStore";

/** The button's name when the catalog entry carries none (Excel's). */
export const BORDERS_LABEL = "Borders";

/** Menu row pictures are drawn on the 20px grid. */
const MENU_ICON_SIZE = 20;

function rowIcon(key: RibbonIconKey): React.ReactNode {
  return React.createElement(RibbonIcon[key], { size: MENU_ICON_SIZE });
}

/** The y of a line sample's stroke(s) and its weight, per line style. */
const LINE_SAMPLE: Readonly<Record<LineStyleId, { width: number; dash?: string; double?: boolean }>> = {
  thin: { width: 1 },
  dotted: { width: 1, dash: "1 2" },
  dashed: { width: 1, dash: "4 2" },
  double: { width: 1, double: true },
  medium: { width: 2 },
  thick: { width: 3 },
};

/** A sample of a line style in the row's icon column, as Excel's Line Style
 *  list draws its rows: painted in the text colour (currentColor), never a
 *  literal, so it follows the theme like the row's words. */
function LineSample({ style }: { style: LineStyleId }): React.ReactElement {
  const s = LINE_SAMPLE[style];
  const y = 10;
  return (
    <svg
      width={MENU_ICON_SIZE}
      height={MENU_ICON_SIZE}
      viewBox="0 0 20 20"
      aria-hidden="true"
      focusable="false"
      data-line-sample={style}
    >
      {s.double ? (
        <>
          <line x1="2" x2="18" y1={y - 1.5} y2={y - 1.5} stroke="currentColor" strokeWidth={1} />
          <line x1="2" x2="18" y1={y + 1.5} y2={y + 1.5} stroke="currentColor" strokeWidth={1} />
        </>
      ) : (
        <line x1="2" x2="18" y1={y} y2={y} stroke="currentColor" strokeWidth={s.width} strokeDasharray={s.dash} />
      )}
    </svg>
  );
}

/**
 * Excel's Borders split button. No pressed state (Excel's has none) and no
 * checked rows (Excel checks none): the face says what it will do.
 */
export function BordersSplitButton({ item }: HomeItemProps): React.ReactElement {
  const lastId = useSessionValue(lastBorderPreset);
  const pen = useSessionValue(borderPen);
  const face = borderPresetRow(lastId);
  const name = item.label || BORDERS_LABEL;

  const presetRow = (row: BorderPresetRow): React.ReactElement => (
    <MenuItem
      key={row.id}
      icon={rowIcon(row.icon)}
      testId={`fmt-${item.id}-${row.id}`}
      onSelect={() => void chooseBorder(row.id)}
    >
      {row.label}
    </MenuItem>
  );
  const section = (n: 0 | 1 | 2) => BORDER_PRESETS.filter((p) => p.section === n).map(presetRow);

  return (
    <SplitMenuButton
      face="icon"
      icon={React.createElement(RibbonIcon[face.icon], { size: ICON_SIZE_SM })}
      // The face is named for what it applies ("Bottom Border"), as Excel's
      // tooltip is; the chevron and the menu carry the button's own name.
      label={face.label}
      tooltip={face.label}
      data-testid={`fmt-${item.id}`}
      chevronTestId={`fmt-${item.id}-options`}
      chevronLabel={`${name} options`}
      menuLabel={name}
      onClick={() => void applyBorderChoice(lastId)}
    >
      <MenuHeading>{name}</MenuHeading>
      {section(0)}
      <MenuSeparator />
      {section(1)}
      <MenuSeparator />
      {section(2)}
      <MenuSeparator />
      <MenuSub label="Line Color" icon={rowIcon("LineColor")} testId={`fmt-${item.id}-lineColor`}>
        <ColorPalette
          value={pen.color}
          testId={`fmt-${item.id}-lineColor-palette`}
          allowAutomatic
          automaticLabel="Automatic"
          onAutomatic={() => borderPen.set({ ...borderPen.get(), color: null })}
          onChange={(hex) => borderPen.set({ ...borderPen.get(), color: hex })}
          // A border's colour is ABSOLUTE in the backend (BorderStyle holds
          // ThemeColor::Absolute; apply_border_preset takes a hex), so a theme
          // pick is kept as the colour it resolves to.
          onThemeColorChange={(_slot, _tint, hex) => borderPen.set({ ...borderPen.get(), color: hex })}
        />
      </MenuSub>
      <MenuSub label="Line Style" icon={MENU_ICON_BLANK} testId={`fmt-${item.id}-lineStyle`}>
        {LINE_STYLES.map((s) => (
          <MenuItem
            key={s.id}
            role="menuitemradio"
            checked={pen.style === s.id}
            icon={<LineSample style={s.id} />}
            testId={`fmt-${item.id}-lineStyle-${s.id}`}
            onSelect={() => borderPen.set({ ...borderPen.get(), style: s.id })}
          >
            {s.label}
          </MenuItem>
        ))}
      </MenuSub>
      <MenuSeparator />
      <MenuItem
        icon={rowIcon(MORE_BORDERS.icon)}
        testId={`fmt-${item.id}-${MORE_BORDERS.slug}`}
        onSelect={() => void openMoreBorders()}
      >
        {MORE_BORDERS.label}
      </MenuItem>
    </SplitMenuButton>
  );
}
